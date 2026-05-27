const express = require('express');
const logger = require('../utils/logger');
const botHandler = require('./bot_handler');

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const payload = req.body;

        // Validar que sea un evento de creación de mensaje
        if (payload.event !== 'message_created') {
            return res.status(200).send('EVENT_IGNORED');
        }

        // Ignorar mensajes enviados por la IA o agentes (para evitar bucles infinitos)
        // Chatwoot puede enviar "incoming" (string) o 0 (integer)
        if (payload.message_type !== 'incoming' && payload.message_type !== 0) {
            return res.status(200).send('MESSAGE_TYPE_IGNORED');
        }

        // Obtener credenciales desde query parameters
        const baseUrl = req.query.url;
        const apiToken = req.query.token;

        if (!baseUrl || !apiToken) {
            logger.warn('[CHATWOOT_WEBHOOK] Faltan parámetros "url" y/o "token" en la query de la petición.');
            return res.status(400).send('MISSING_CREDENTIALS_IN_QUERY');
        }

        // Extraer datos relevantes
        const accountId = String(payload.account?.id || '');
        const conversationId = String(payload.conversation?.id || '');
        const messageText = payload.content;
        const messageId = String(payload.id || '');
        
        // El id de quien envía el mensaje se puede usar como "userPhone" para la sesión
        const senderId = payload.sender?.id ? `cw_${payload.sender.id}` : `cw_${conversationId}`;
        const senderName = payload.sender?.name || 'Usuario de Chatwoot';

        if (!accountId || !conversationId || !messageId) {
            logger.warn('[CHATWOOT_WEBHOOK] Payload sin identificadores clave', payload);
            return res.status(400).send('INVALID_PAYLOAD');
        }

        if (!messageText || messageText.trim() === '') {
            logger.info(`[CHATWOOT_WEBHOOK] Mensaje vacío o archivo sin texto en conversacion ${conversationId}. Ignorando.`);
            return res.status(200).send('EMPTY_MESSAGE_IGNORED');
        }

        logger.info(`[CHATWOOT_WEBHOOK] Recibido mensaje de ${senderName} en conversacion ${conversationId}`);

        // Enviar al bot handler para procesar y responder vía chatwoot
        // Usamos una función paralela para que responda a Chatwoot y no a WhatsApp
        botHandler.handleChatwootMessage(senderId, messageText, messageId, senderName, accountId, conversationId, baseUrl, apiToken)
            .catch(err => {
                logger.error(`[CHATWOOT_WEBHOOK] Error procesando mensaje de Chatwoot: ${err.message}`);
            });

        return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        logger.error(`[CHATWOOT_WEBHOOK] Error general en el webhook: ${error.message}`);
        return res.status(500).send('INTERNAL_SERVER_ERROR');
    }
});

module.exports = router;
