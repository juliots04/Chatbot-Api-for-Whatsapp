const geminiService = require('../services/gemini_service');
const whatsappService = require('../services/whatsapp_service');
const chatwootService = require('../services/chatwoot_service');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const rateLimiter = require('../utils/rate_limiter');
const messageQueue = require('../utils/message_queue');
const config = require('../../config');
const userSettingsService = require('../services/user_settings_service');
const conversationStoreService = require('../services/conversation_store_service');
const insightClassifier = require('../services/insight_classifier_service');
const { InMemoryChatMessageHistory: ChatMessageHistory } = require("@langchain/core/chat_history");

// Historial en memoria (En producción: usar DB como Redis/Mongo)
const userConversations = new Map();

class BotHandler {
    constructor() {
        // Ejecutar limpiador de memoria periódicamente
        this.cleanupInterval = setInterval(
            () => {
                this.cleanupConversations().catch((error) => {
                    logger.warn(`[BOT] Error en limpieza de conversaciones: ${error.message}`);
                });
            },
            config.conversation.inactivityTimeoutMs / 2
        );
    }

    async _getOrCreateConversation(userPhone) {
        let history = userConversations.get(userPhone);
        if (history) return history;

        const chatHistory = new ChatMessageHistory();
        const persisted = await conversationStoreService.hydrateChatHistory(userPhone, chatHistory);
        history = {
            chatHistory,
            lastActivity: persisted.lastActivity || Date.now(),
            messageCount: persisted.messageCount || 0
        };
        userConversations.set(userPhone, history);
        return history;
    }

    async _trimHistoryWindow(history, userPhone) {
        const maxMessages = config.conversation.maxHistoryMessages;
        const currentMessages = await history.chatHistory.getMessages();
        logger.info(`[BOT] Contexto de memoria para ${userPhone}: ${currentMessages.length} mensajes cargados.`);
        if (currentMessages.length <= maxMessages) return;

        await history.chatHistory.clear();
        const subset = currentMessages.slice(currentMessages.length - maxMessages);
        for (const msg of subset) {
            await history.chatHistory.addMessage(msg);
        }
    }

    async _persistConversationState(userPhone, history) {
        await conversationStoreService.persistChatHistory(userPhone, history.chatHistory, {
            lastActivity: history.lastActivity,
            messageCount: history.messageCount
        });
    }

    /**
     * Procesa un mensaje entrante con todas las optimizaciones:
     * - Deduplicación de mensajes
     * - Rate limiting por usuario
     * - Cola secuencial por usuario
        * - markAsRead temprano
     */
    async handleIncomingMessage(userPhone, messageText, messageId, userName = '') {
        userSettingsService.touchUser(userPhone, userName);

        // 1. Deduplicación — ignorar mensajes que ya procesamos
        if (messageQueue.isDuplicate(messageId)) {
            metrics.increment('duplicateMessages');
            logger.debug(`[BOT] Mensaje duplicado ignorado: ${messageId} de ${userPhone}`);
            return;
        }

        metrics.increment('messagesReceived');
        metrics.trackUserReceived(userPhone, userName);
        userSettingsService.markMessageReceived(userPhone);

        // 2. Rate limiting — verificar límite de mensajes por usuario
        const userConfig = userSettingsService.getUserSettings(userPhone);
        const rateCheck = rateLimiter.check(userPhone, userConfig.rateLimiting);
        if (!rateCheck.allowed) {
            metrics.increment('rateLimitHits');
            logger.warn(`[BOT] Rate limit para ${userPhone}. Reintento en ${rateCheck.retryAfterMs}ms`);
            await whatsappService.sendMessage(
                userPhone,
                `Estás enviando mensajes muy rápido. Por favor espera unos segundos antes de volver a escribir.`
            );
            return;
        }

        // 3. Encolar para procesamiento secuencial por usuario
        messageQueue.enqueue(userPhone, () =>
            this._processMessage(userPhone, messageText, messageId, userName)
        ).catch(err => {
            logger.error(`[BOT] Error en cola para ${userPhone}: ${err.message}`);
        });
    }

    async handleIncomingImage(userPhone, imagePayload, messageId, userName = '') {
        userSettingsService.touchUser(userPhone, userName);

        if (messageQueue.isDuplicate(messageId)) {
            metrics.increment('duplicateMessages');
            logger.debug(`[BOT] Imagen duplicada ignorada: ${messageId} de ${userPhone}`);
            return;
        }

        metrics.increment('messagesReceived');
        metrics.trackUserReceived(userPhone, userName);
        userSettingsService.markMessageReceived(userPhone);

        const userConfig = userSettingsService.getUserSettings(userPhone);
        const rateCheck = rateLimiter.check(userPhone, userConfig.rateLimiting);
        if (!rateCheck.allowed) {
            metrics.increment('rateLimitHits');
            logger.warn(`[BOT] Rate limit para imagen de ${userPhone}. Reintento en ${rateCheck.retryAfterMs}ms`);
            await whatsappService.sendMessage(
                userPhone,
                'Estas enviando mensajes muy rapido. Espera unos segundos y vuelve a enviar la imagen por favor.'
            );
            return;
        }

        messageQueue.enqueue(userPhone, () =>
            this._processImageMessage(userPhone, imagePayload, messageId, userName)
        ).catch(err => {
            logger.error(`[BOT] Error en cola de imagen para ${userPhone}: ${err.message}`);
        });
    }

    async handleIncomingAudio(userPhone, audioPayload, messageId, userName = '') {
        userSettingsService.touchUser(userPhone, userName);

        if (messageQueue.isDuplicate(messageId)) {
            metrics.increment('duplicateMessages');
            logger.debug(`[BOT] Audio duplicado ignorado: ${messageId} de ${userPhone}`);
            return;
        }

        metrics.increment('messagesReceived');
        metrics.trackUserReceived(userPhone, userName);
        userSettingsService.markMessageReceived(userPhone);

        const userConfig = userSettingsService.getUserSettings(userPhone);
        const rateCheck = rateLimiter.check(userPhone, userConfig.rateLimiting);
        if (!rateCheck.allowed) {
            metrics.increment('rateLimitHits');
            logger.warn(`[BOT] Rate limit para audio de ${userPhone}. Reintento en ${rateCheck.retryAfterMs}ms`);
            await whatsappService.sendMessage(
                userPhone,
                'Estas enviando mensajes muy rapido. Espera unos segundos y vuelve a enviar el audio por favor.'
            );
            return;
        }

        messageQueue.enqueue(userPhone, () =>
            this._processAudioMessage(userPhone, audioPayload, messageId, userName)
        ).catch(err => {
            logger.error(`[BOT] Error en cola de audio para ${userPhone}: ${err.message}`);
        });
    }

    /**
     * Procesamiento real del mensaje (ejecutado secuencialmente por la cola)
     */
    async _processMessage(userPhone, messageText, messageId, userName = '') {
        const startTime = Date.now();

        try {
            logger.debug(`[BOT] Procesando mensaje de ${userPhone}...`);

            // Marcar lectura temprano para confirmar recepcion al usuario.
            await whatsappService.markAsRead(messageId);

            // Log de entrada para el Chat Mirror (MySQL)
            conversationStoreService.appendAuditMessage(userPhone, 'inbound', 'user', messageText, messageId)
                .catch(err => logger.error(`[BOT] Error logging inbound to MySQL: ${err.message}`));

            // Extraer historial del usuario para contexto
            const history = await this._getOrCreateConversation(userPhone);

            const normalizedMessage = String(messageText || '').trim().toLowerCase();
            if (normalizedMessage === 'newchatgg') {
                await history.chatHistory.clear();
                history.lastActivity = Date.now();
                history.messageCount = 0;
                await conversationStoreService.clearUserHistory(userPhone);

                const resetReply = 'Listo, reinicie esta conversacion desde cero. Empezamos nuevamente 😊';
                await whatsappService.sendMessage(userPhone, resetReply);
                metrics.increment('whatsappMessagesSent');

                const latency = Date.now() - startTime;
                metrics.increment('messagesProcessed');
                metrics.trackUserProcessed(userPhone, latency, userName);
                userSettingsService.markMessageProcessed(userPhone, latency);
                logger.info(`[BOT] Historial reiniciado para ${userPhone} via comando newchatgg`);
                return;
            }

            // Generar respuesta con Gemini y memoria LangChain
            const userConfig = userSettingsService.getUserSettings(userPhone);
            const responseText = await geminiService.generateResponse(
                messageText,
                history.chatHistory,
                userName,
                userConfig.gemini,
                userPhone
            );

            // Gestionar límite de historial (mantener solo los últimos N mensajes, equivalente a BufferWindowMemory)
            await this._trimHistoryWindow(history, userPhone);

            history.lastActivity = Date.now();
            history.messageCount++;

            await this._persistConversationState(userPhone, history);

            await whatsappService.sendMessage(userPhone, responseText);
            metrics.increment('whatsappMessagesSent');

            const latency = Date.now() - startTime;
            metrics.increment('messagesProcessed');
            metrics.trackUserProcessed(userPhone, latency, userName);
            userSettingsService.markMessageProcessed(userPhone, latency);

            // Log de salida para el Chat Mirror (MySQL)
            conversationStoreService.appendAuditMessage(userPhone, 'outbound', 'bot', responseText, null, latency)
                .catch(err => logger.error(`[BOT] Error logging outbound to MySQL: ${err.message}`));

            // Classify interaction for Reports module (async, fire-and-forget)
            const reqDebug = geminiService.lastRequestDebug;
            insightClassifier.classifyMessage(
                userPhone, messageText, responseText,
                reqDebug?.commercialFlow || null,
                reqDebug?.activeProduct || null,
                userName
            ).catch(err => logger.error(`[BOT] Error en insight classifier: ${err.message}`));

            logger.info(`[BOT] ✓ Flujo completado para ${userPhone} en ${latency}ms`);

        } catch (error) {
            const errorText = [
                String(error?.message || ''),
                String(error?.cause?.message || ''),
                String(error?.response?.data?.error?.message || '')
            ].join(' | ').toLowerCase();
            let userFacingMessage = 'Tuve un problema al procesar tu mensaje en este momento. Intenta nuevamente en unos segundos, por favor.';
            let reasonCode = 'msg_unknown_error';

            if (errorText.includes('timeout') || errorText.includes('timed out') || errorText.includes('deadline exceeded')) {
                reasonCode = 'msg_timeout';
                userFacingMessage = 'Tu mensaje tardo demasiado en procesarse por alta demanda. Reenvialo en unos segundos, por favor.';
            } else if (errorText.includes('no_available_keys') || errorText.includes('no hay api keys disponibles') || errorText.includes('token_invalid_or_no_permission') || errorText.includes('api_key_invalid')) {
                reasonCode = 'msg_gemini_auth_or_keys';
                userFacingMessage = 'Tengo una intermitencia temporal del motor de IA. Intenta nuevamente en un momento.';
            } else if (errorText.includes('quota_exhausted') || errorText.includes('rate_limited') || errorText.includes('resource exhausted') || errorText.includes('429')) {
                reasonCode = 'msg_gemini_quota_or_rate';
                userFacingMessage = 'Estoy con limite temporal de IA. Intenta nuevamente en 1 minuto, por favor.';
            } else if (errorText.includes('service unavailable') || errorText.includes('overloaded') || errorText.includes('503') || errorText.includes('model_temporarily_unavailable')) {
                reasonCode = 'msg_gemini_temporarily_unavailable';
                userFacingMessage = 'La IA esta temporalmente no disponible. Reintenta en unos segundos, por favor.';
            } else if (errorText.includes('econnreset') || errorText.includes('socket hang up') || errorText.includes('fetch failed') || errorText.includes('network')) {
                reasonCode = 'msg_network_error';
                userFacingMessage = 'Hubo una falla de red procesando tu mensaje. Reintenta en unos segundos, por favor.';
            }

            metrics.increment('messagesFailed');
            metrics.trackUserFailed(userPhone, userName);
            metrics.recordError('bot_handler', error.message, { phone: userPhone, reasonCode });
            userSettingsService.markMessageFailed(userPhone);
            logger.error(`[BOT] Error procesando mensaje de ${userPhone}. reason=${reasonCode}. Detalles: ${error.stack}`);

            // Respuesta de emergencia
            try {
                await whatsappService.sendMessage(
                    userPhone,
                    `${userFacingMessage}\n\nRef: ${reasonCode}`
                );
            } catch (waError) {
                logger.error(`[BOT] Ni la respuesta de emergencia pudo enviarse a ${userPhone}. ${waError.message}`);
            }
        }
    }

    /**
     * Procesa un mensaje entrante desde Chatwoot y responde usando Chatwoot API.
     */
    async handleChatwootMessage(userPhone, messageText, messageId, userName, accountId, conversationId, baseUrl, apiToken) {
        userSettingsService.touchUser(userPhone, userName);

        if (messageQueue.isDuplicate(messageId)) {
            metrics.increment('duplicateMessages');
            logger.debug(`[BOT_CHATWOOT] Mensaje duplicado ignorado: ${messageId} de ${userPhone}`);
            return;
        }

        metrics.increment('messagesReceived');
        metrics.trackUserReceived(userPhone, userName);
        userSettingsService.markMessageReceived(userPhone);

        const userConfig = userSettingsService.getUserSettings(userPhone);
        const rateCheck = rateLimiter.check(userPhone, userConfig.rateLimiting);
        if (!rateCheck.allowed) {
            metrics.increment('rateLimitHits');
            logger.warn(`[BOT_CHATWOOT] Rate limit para ${userPhone}.`);
            await chatwootService.sendMessage(
                baseUrl,
                apiToken,
                accountId,
                conversationId,
                `Estás enviando mensajes muy rápido. Por favor espera unos segundos antes de volver a escribir.`
            );
            return;
        }

        messageQueue.enqueue(userPhone, () =>
            this._processChatwootMessage(userPhone, messageText, messageId, userName, accountId, conversationId, baseUrl, apiToken)
        ).catch(err => {
            logger.error(`[BOT_CHATWOOT] Error en cola para ${userPhone}: ${err.message}`);
        });
    }

    async _processChatwootMessage(userPhone, messageText, messageId, userName, accountId, conversationId, baseUrl, apiToken) {
        const startTime = Date.now();

        try {
            logger.debug(`[BOT_CHATWOOT] Procesando mensaje de ${userPhone}...`);

            conversationStoreService.appendAuditMessage(userPhone, 'inbound', 'user', messageText, messageId)
                .catch(err => logger.error(`[BOT_CHATWOOT] Error logging inbound to MySQL: ${err.message}`));

            const history = await this._getOrCreateConversation(userPhone);

            const normalizedMessage = String(messageText || '').trim().toLowerCase();
            if (normalizedMessage === 'newchatgg') {
                await history.chatHistory.clear();
                history.lastActivity = Date.now();
                history.messageCount = 0;
                await conversationStoreService.clearUserHistory(userPhone);

                const resetReply = 'Listo, reinicie esta conversacion desde cero. Empezamos nuevamente 😊';
                await chatwootService.sendMessage(baseUrl, apiToken, accountId, conversationId, resetReply);
                
                const latency = Date.now() - startTime;
                metrics.increment('messagesProcessed');
                metrics.trackUserProcessed(userPhone, latency, userName);
                userSettingsService.markMessageProcessed(userPhone, latency);
                logger.info(`[BOT_CHATWOOT] Historial reiniciado para ${userPhone} via comando newchatgg`);
                return;
            }

            const userConfig = userSettingsService.getUserSettings(userPhone);
            const responseText = await geminiService.generateResponse(
                messageText,
                history.chatHistory,
                userName,
                userConfig.gemini,
                userPhone
            );

            await this._trimHistoryWindow(history, userPhone);

            history.lastActivity = Date.now();
            history.messageCount++;

            await this._persistConversationState(userPhone, history);

            await chatwootService.sendMessage(baseUrl, apiToken, accountId, conversationId, responseText);

            const latency = Date.now() - startTime;
            metrics.increment('messagesProcessed');
            metrics.trackUserProcessed(userPhone, latency, userName);
            userSettingsService.markMessageProcessed(userPhone, latency);

            conversationStoreService.appendAuditMessage(userPhone, 'outbound', 'bot', responseText, null, latency)
                .catch(err => logger.error(`[BOT_CHATWOOT] Error logging outbound to MySQL: ${err.message}`));

            // Classify interaction for Reports module (async, fire-and-forget)
            const reqDebugCw = geminiService.lastRequestDebug;
            insightClassifier.classifyMessage(
                userPhone, messageText, responseText,
                reqDebugCw?.commercialFlow || null,
                reqDebugCw?.activeProduct || null,
                userName
            ).catch(err => logger.error(`[BOT_CHATWOOT] Error en insight classifier: ${err.message}`));

            logger.info(`[BOT_CHATWOOT] ✓ Flujo completado para ${userPhone} en ${latency}ms`);

        } catch (error) {
            const errorText = [
                String(error?.message || ''),
                String(error?.cause?.message || ''),
                String(error?.response?.data?.error?.message || '')
            ].join(' | ').toLowerCase();
            let userFacingMessage = 'Tuve un problema al procesar tu mensaje en este momento. Intenta nuevamente en unos segundos, por favor.';
            let reasonCode = 'msg_unknown_error';

            if (errorText.includes('timeout') || errorText.includes('timed out') || errorText.includes('deadline exceeded')) {
                reasonCode = 'msg_timeout';
                userFacingMessage = 'Tu mensaje tardo demasiado en procesarse por alta demanda. Reenvialo en unos segundos, por favor.';
            } else if (errorText.includes('no_available_keys') || errorText.includes('no hay api keys disponibles') || errorText.includes('token_invalid_or_no_permission') || errorText.includes('api_key_invalid')) {
                reasonCode = 'msg_gemini_auth_or_keys';
                userFacingMessage = 'Tengo una intermitencia temporal del motor de IA. Intenta nuevamente en un momento.';
            } else if (errorText.includes('quota_exhausted') || errorText.includes('rate_limited') || errorText.includes('resource exhausted') || errorText.includes('429')) {
                reasonCode = 'msg_gemini_quota_or_rate';
                userFacingMessage = 'Estoy con limite temporal de IA. Intenta nuevamente en 1 minuto, por favor.';
            } else if (errorText.includes('service unavailable') || errorText.includes('overloaded') || errorText.includes('503') || errorText.includes('model_temporarily_unavailable')) {
                reasonCode = 'msg_gemini_temporarily_unavailable';
                userFacingMessage = 'La IA esta temporalmente no disponible. Reintenta en unos segundos, por favor.';
            } else if (errorText.includes('econnreset') || errorText.includes('socket hang up') || errorText.includes('fetch failed') || errorText.includes('network')) {
                reasonCode = 'msg_network_error';
                userFacingMessage = 'Hubo una falla de red procesando tu mensaje. Reintenta en unos segundos, por favor.';
            }

            metrics.increment('messagesFailed');
            metrics.trackUserFailed(userPhone, userName);
            metrics.recordError('bot_handler_chatwoot', error.message, { phone: userPhone, reasonCode });
            userSettingsService.markMessageFailed(userPhone);
            logger.error(`[BOT_CHATWOOT] Error procesando mensaje de ${userPhone}. reason=${reasonCode}. Detalles: ${error.stack}`);

            try {
                await chatwootService.sendMessage(
                    baseUrl,
                    apiToken,
                    accountId,
                    conversationId,
                    `${userFacingMessage}\n\nRef: ${reasonCode}`
                );
            } catch (cwError) {
                logger.error(`[BOT_CHATWOOT] Ni la respuesta de emergencia pudo enviarse a ${userPhone}. ${cwError.message}`);
            }
        }
    }

    async _processImageMessage(userPhone, imagePayload, messageId, userName = '') {
        const startTime = Date.now();

        try {
            logger.debug(`[BOT] Procesando imagen de ${userPhone}...`);
            await whatsappService.markAsRead(messageId);

            const history = await this._getOrCreateConversation(userPhone);

            const mediaId = String(imagePayload?.id || '').trim();
            const caption = String(imagePayload?.caption || '').trim();
            if (!mediaId) {
                await whatsappService.sendMessage(userPhone, 'NO VALIDADO ❌\nMotivo: No se recibio un archivo de imagen valido.');
                return;
            }

            const media = await whatsappService.downloadMediaAsBase64(mediaId);
            const imageReply = await geminiService.validatePaymentProof(
                {
                    base64: media.base64,
                    mimeType: media.mimeType,
                    fileSizeBytes: media.fileSizeBytes,
                    caption
                },
                {
                    chatHistory: history.chatHistory,
                    userPhone
                }
            );

            history.lastActivity = Date.now();
            history.messageCount++;

            await this._persistConversationState(userPhone, history);

            await whatsappService.sendMessage(userPhone, imageReply);
            metrics.increment('whatsappMessagesSent');

            const latency = Date.now() - startTime;
            metrics.increment('messagesProcessed');
            metrics.trackUserProcessed(userPhone, latency, userName);
            userSettingsService.markMessageProcessed(userPhone, latency);
            logger.info(`[BOT] ✓ Imagen procesada (validacion_por_contenido) para ${userPhone} en ${latency}ms`);
        } catch (error) {
            const errorText = [
                String(error?.message || ''),
                String(error?.cause?.message || ''),
                String(error?.response?.data?.error?.message || '')
            ].join(' | ').toLowerCase();
            let reasonCode = 'image_validation_runtime_error';
            let userFacingMessage = 'NO VALIDADO ❌\nMotivo: No se pudo completar la revision del comprobante. Envia una foto mas clara y centrada, por favor.';

            if (errorText.includes('no se pudo obtener metadata de media') || errorText.includes('no se pudo descargar media')) {
                reasonCode = 'image_media_download_error';
                userFacingMessage = 'NO VALIDADO ❌\nMotivo: No pude descargar la imagen desde WhatsApp en este momento. Reenviala, por favor.';
            } else if (errorText.includes('timeout') || errorText.includes('timed out') || errorText.includes('deadline exceeded')) {
                reasonCode = 'image_validation_timeout';
                userFacingMessage = 'NO VALIDADO ❌\nMotivo: La validacion de imagen tardo demasiado. Reenvia una foto mas clara, por favor.';
            } else if (errorText.includes('token_invalid_or_no_permission') || errorText.includes('api_key_invalid') || errorText.includes('no hay api keys disponibles')) {
                reasonCode = 'image_gemini_auth_or_keys';
                userFacingMessage = 'NO VALIDADO ❌\nMotivo: Tengo una intermitencia temporal del motor de validacion. Intenta nuevamente en unos minutos.';
            }

            metrics.increment('messagesFailed');
            metrics.trackUserFailed(userPhone, userName);
            metrics.recordError('bot_handler_image', error.message, { phone: userPhone, reasonCode });
            userSettingsService.markMessageFailed(userPhone);
            logger.error(`[BOT] Error procesando imagen de ${userPhone}. reason=${reasonCode}. Detalles: ${error.stack}`);

            try {
                await whatsappService.sendMessage(
                    userPhone,
                    `${userFacingMessage}\n\nRef: ${reasonCode}`
                );
            } catch (waError) {
                logger.error(`[BOT] No se pudo enviar error de validacion de imagen a ${userPhone}. ${waError.message}`);
            }
        }
    }

    async _processAudioMessage(userPhone, audioPayload, messageId, userName = '') {
        const startTime = Date.now();

        try {
            logger.debug(`[BOT] Procesando audio de ${userPhone}...`);
            await whatsappService.markAsRead(messageId);

            const history = await this._getOrCreateConversation(userPhone);

            const mediaId = String(audioPayload?.id || '').trim();
            if (!mediaId) {
                await whatsappService.sendMessage(
                    userPhone,
                    'No pude procesar ese audio porque llego sin identificador de archivo. Intenta reenviarlo, por favor.'
                );
                return;
            }

            const media = await whatsappService.downloadMediaAsBase64(mediaId);
            const transcript = await geminiService.transcribeAudio(
                {
                    base64: media.base64,
                    mimeType: media.mimeType,
                    fileSizeBytes: media.fileSizeBytes
                },
                {
                    userPhone
                }
            );

            const transcribedText = String(transcript?.text || '').trim();
            if (!transcribedText) {
                await whatsappService.sendMessage(
                    userPhone,
                    'No pude transcribir el audio con suficiente claridad. Intenta enviar una nota de voz mas clara o en un lugar con menos ruido.'
                );
                return;
            }

            conversationStoreService.appendAuditMessage(
                userPhone,
                'inbound',
                'user',
                `[Audio transcrito] ${transcribedText}`,
                messageId
            ).catch(err => logger.error(`[BOT] Error logging inbound audio to MySQL: ${err.message}`));

            const userConfig = userSettingsService.getUserSettings(userPhone);
            const responseText = await geminiService.generateResponse(
                transcribedText,
                history.chatHistory,
                userName,
                userConfig.gemini,
                userPhone
            );

            await this._trimHistoryWindow(history, userPhone);

            history.lastActivity = Date.now();
            history.messageCount++;

            await this._persistConversationState(userPhone, history);

            await whatsappService.sendMessage(userPhone, responseText);
            metrics.increment('whatsappMessagesSent');

            const latency = Date.now() - startTime;
            metrics.increment('messagesProcessed');
            metrics.trackUserProcessed(userPhone, latency, userName);
            userSettingsService.markMessageProcessed(userPhone, latency);

            conversationStoreService.appendAuditMessage(userPhone, 'outbound', 'bot', responseText, null, latency)
                .catch(err => logger.error(`[BOT] Error logging outbound audio response to MySQL: ${err.message}`));

            logger.info(`[BOT] ✓ Audio transcrito y respondido para ${userPhone} en ${latency}ms`);
        } catch (error) {
            const errorText = [
                String(error?.message || ''),
                String(error?.cause?.message || ''),
                String(error?.response?.data?.error?.message || '')
            ].join(' | ').toLowerCase();
            let userFacingMessage = 'Tuve un problema al procesar ese audio. Si deseas, vuelve a enviarlo o escribeme en texto y te ayudo al instante.';
            let reasonCode = 'audio_unknown_error';

            if (errorText.includes('formato de audio no soportado')) {
                reasonCode = 'audio_unsupported_format';
                userFacingMessage = 'No pude procesar ese formato de audio. Intenta reenviarlo como nota de voz de WhatsApp o escribeme en texto.';
            } else if (errorText.includes('no se pudo obtener metadata de media') || errorText.includes('no se pudo descargar media')) {
                reasonCode = 'audio_media_download_error';
                userFacingMessage = 'No pude descargar tu audio desde WhatsApp en este momento. Reenvialo por favor en unos segundos.';
            } else if (errorText.includes('audio supera el limite')) {
                reasonCode = 'audio_too_large';
                userFacingMessage = 'Tu audio es muy pesado para procesarlo. Envialo mas corto o en texto, por favor.';
            } else if (errorText.includes('no se pudo transcribir el audio: timeout') || errorText.includes('timeout transcribiendo audio')) {
                reasonCode = 'audio_transcription_timeout';
                userFacingMessage = 'Tu audio tardo demasiado en procesarse. Reenvialo, idealmente mas corto, y te respondo.';
            } else if (errorText.includes('token_invalid_or_no_permission') || errorText.includes('api_key_invalid') || errorText.includes('no hay api keys disponibles')) {
                reasonCode = 'audio_gemini_auth_or_keys';
                userFacingMessage = 'Estoy con una intermitencia de IA para procesar audios. Puedes reenviar en un momento o escribirme en texto.';
            } else if (errorText.includes('quota_exhausted') || errorText.includes('rate_limited') || errorText.includes('resource exhausted') || errorText.includes('429')) {
                reasonCode = 'audio_gemini_quota_or_rate';
                userFacingMessage = 'Estoy con limite temporal de IA para audios. Intenta de nuevo en 1 minuto o escribeme en texto.';
            } else if (errorText.includes('model_temporarily_unavailable') || errorText.includes('503') || errorText.includes('overloaded') || errorText.includes('service unavailable')) {
                reasonCode = 'audio_gemini_temporarily_unavailable';
                userFacingMessage = 'La IA para audio esta temporalmente no disponible. Reenvia en unos segundos, por favor.';
            } else if (errorText.includes('unknown_runtime_error') || errorText.includes('no se pudo transcribir el audio')) {
                reasonCode = 'audio_transcription_runtime_error';
                userFacingMessage = 'No pude interpretar ese audio esta vez. Reenvialo en una nota mas corta y clara, o escribeme en texto.';
            } else if (errorText.includes('econnreset') || errorText.includes('socket hang up') || errorText.includes('fetch failed') || errorText.includes('network')) {
                reasonCode = 'audio_network_error';
                userFacingMessage = 'Hubo una falla de red al procesar tu audio. Reenvialo en unos segundos, por favor.';
            }

            metrics.increment('messagesFailed');
            metrics.trackUserFailed(userPhone, userName);
            metrics.recordError('bot_handler_audio', error.message, { phone: userPhone, reasonCode });
            userSettingsService.markMessageFailed(userPhone);
            logger.error(`[BOT] Error procesando audio de ${userPhone}. reason=${reasonCode}. Detalles: ${error.stack}`);

            try {
                await whatsappService.sendMessage(
                    userPhone,
                    `${userFacingMessage}\n\nRef: ${reasonCode}`
                );
            } catch (waError) {
                logger.error(`[BOT] No se pudo enviar error de audio a ${userPhone}. ${waError.message}`);
            }
        }
    }

    /**
     * Maneja tipos de mensaje no soportados (imagen, audio, sticker, etc.)
     */
    async handleUnsupportedMessage(userPhone, messageType, messageId) {
        if (messageQueue.isDuplicate(messageId)) return;

        userSettingsService.touchUser(userPhone);
        userSettingsService.markMessageReceived(userPhone);
        metrics.increment('messagesReceived');
        metrics.trackUserReceived(userPhone);
        await whatsappService.markAsRead(messageId);

        const typeNames = {
            image: 'imágenes 📷',
            audio: 'audios 🎙️',
            video: 'videos 🎬',
            sticker: 'stickers 🎨',
            document: 'documentos 📄',
            location: 'ubicaciones 📍',
            contacts: 'contactos 👤'
        };

        const typeName = typeNames[messageType] || `mensajes de tipo "${messageType}"`;
        await whatsappService.sendMessage(
            userPhone,
            `Por el momento no puedo procesar ${typeName}. Escribeme tu consulta en texto y con gusto te ayudo. 😊`
        );
    }

    /**
     * Limpia historial de conversaciones inactivas
     */
    async cleanupConversations() {
        const now = Date.now();
        const timeout = config.conversation.inactivityTimeoutMs;
        let deleted = 0;

        for (const [phone, data] of userConversations.entries()) {
            if (now - data.lastActivity > timeout) {
                userConversations.delete(phone);
                deleted++;
            }
        }

        if (deleted > 0) {
            logger.debug(`[BOT] Tarea de fondo: Se limpió el contexto de ${deleted} chats inactivos.`);
        }

        await conversationStoreService.pruneExpired(timeout);
    }

    /**
     * Obtiene estadísticas del bot handler
     */
    getStats() {
        return {
            activeConversations: userConversations.size,
            totalMessages: Array.from(userConversations.values())
                .reduce((acc, v) => acc + v.messageCount, 0),
            users: userSettingsService.listUsers()
        };
    }

    getUsers() {
        return userSettingsService.listUsers();
    }

    async destroy() {
        clearInterval(this.cleanupInterval);
        await conversationStoreService.destroy();
    }
}

module.exports = new BotHandler();
