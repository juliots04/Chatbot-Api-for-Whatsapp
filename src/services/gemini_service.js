const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { ChatPromptTemplate, MessagesPlaceholder } = require("@langchain/core/prompts");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const knowledgeLoader = require('./knowledge_loader');
const { GeminiAPIError } = require('../utils/error_handler');

class GeminiService {
    constructor() {
        this.apiKeys = config.gemini.apiKeys;
        this.defaultGenerationConfig = config.gemini.generationConfig;
        this.defaultTimeout = config.gemini.timeout;
        this.totalTimeoutMs = Math.max(Number(config.gemini.totalTimeoutMs || 70000), 60000);
        this.maxAttemptsPerMessage = Math.max(Number(config.gemini.maxAttemptsPerMessage || 2), 1);
        this.maxKnowledgePromptChars = Number.isFinite(config.gemini.maxKnowledgePromptChars)
            ? config.gemini.maxKnowledgePromptChars
            : 0;
        this.initialKnowledgePromptChars = Math.max(Number(config.gemini.initialKnowledgePromptChars || 8000), 3000);
        this.retryKnowledgePromptChars = Math.max(Number(config.gemini.retryKnowledgePromptChars || 5000), 2000);
        this.initialHistoryWindow = Math.min(Math.max(Number(config.gemini.initialHistoryWindow || 10), 6), 30);
        this.retryHistoryWindow = Math.min(Math.max(Number(config.gemini.retryHistoryWindow || 4), 4), 20);
        this.maxMessageCharsInHistory = Math.max(Number(config.gemini.maxMessageCharsInHistory || 900), 300);
        this.defaultCircuitBreakerConfig = config.gemini.circuitBreaker;
        this._warnedKnowledgeTruncation = false;

        if (this.apiKeys.length === 0) {
            logger.warn('[GEMINI] No hay API keys configuradas en las variables de entorno (.env). La IA no podrá responder.');
        }

        this.currentKeyIndex = 0;

        // Inicializar modelos LangChain y estado de circuit breaker por key
        this.keys = this.apiKeys.map((key, index) => {
            const label = this.maskKey(key);
            return {
                index,
                apiKey: key,
                label,
                failures: 0,
                disabledUntil: 0, // Timestamp cuando se reactiva
                totalCalls: 0,
                totalErrors: 0,
                lastError: null,
                lastErrorAt: 0,
                lastUsedAt: 0
            };
        });

        this.lastCutoff = null;
        this.lastRequestDebug = null;

        // Token usage tracking (last N messages)
        this.tokenHistory = [];
        this.maxTokenHistory = 50;
    }

    maskKey(apiKey = '') {
        const key = String(apiKey || '');
        if (key.length <= 10) return key ? `${key.slice(0, 4)}***` : 'N/A';
        return `${key.slice(0, 6)}...${key.slice(-4)}`;
    }

    _resolveRuntimeConfig(userGeminiConfig = null) {
        const baseTimeout = userGeminiConfig?.timeout ?? this.defaultTimeout;
        const requestedMaxTokens = Number(
            userGeminiConfig?.maxOutputTokens ?? this.defaultGenerationConfig.maxOutputTokens
        );
        const safeMaxOutputTokens = Number.isFinite(requestedMaxTokens)
            ? Math.max(800, Math.min(requestedMaxTokens, 2500))
            : 2000;

        return {
            generation: {
                temperature: userGeminiConfig?.temperature ?? this.defaultGenerationConfig.temperature,
                maxOutputTokens: safeMaxOutputTokens,
                topP: this.defaultGenerationConfig.topP
            },
            timeout: Math.max(Number(baseTimeout || 0), 18000),
            circuitBreaker: {
                failureThreshold: userGeminiConfig?.failureThreshold ?? this.defaultCircuitBreakerConfig.failureThreshold,
                recoveryTimeMs: userGeminiConfig?.recoveryTimeMs ?? this.defaultCircuitBreakerConfig.recoveryTimeMs
            }
        };
    }

    _buildModel(keyData, runtimeConfig) {
        return new ChatGoogleGenerativeAI({
            model: config.gemini.model || 'gemini-1.5-flash',
            apiKey: keyData.apiKey,
            maxOutputTokens: runtimeConfig.generation.maxOutputTokens,
            temperature: runtimeConfig.generation.temperature,
            topP: runtimeConfig.generation.topP
        });
    }


    async _buildScopedKnowledge(userMessage = '', maxProducts = 3, options = {}) {
        const matches = await knowledgeLoader.findProductsByQuery(userMessage, maxProducts);
        if (!matches.length) return '';
        const includeContact = options?.includeContact !== false;

        const blocks = [];
        for (const item of matches.slice(0, maxProducts)) {
            const data = item?.data || {};
            const lines = [];
            lines.push(`PRODUCTO: ${item.sitio}`);
            if (data.url) lines.push(`URL: ${data.url}`);
            if (data.descripcion_general) lines.push(`Descripción: ${data.descripcion_general}`);

            if (Array.isArray(data.planes) && data.planes.length > 0) {
                lines.push('');
                lines.push('PLANES DISPONIBLES:');
                for (const plan of data.planes) {
                    const nombre = plan?.nombre || 'Sin nombre';
                    lines.push(`\n*${nombre}*`);

                    if (Array.isArray(plan?.ciclos_facturacion) && plan.ciclos_facturacion.length > 0) {
                        for (const ciclo of plan.ciclos_facturacion) {
                            const c = ciclo?.ciclo || '';
                            const precio = ciclo?.precio || '';
                            const descuento = ciclo?.descuento ? ` (${ciclo.descuento} desc)` : '';
                            const original = ciclo?.precio_original ? ` antes ${ciclo.precio_original}` : '';
                            lines.push(`- ${c}: ${precio}${original}${descuento}`);
                        }
                    } else if (plan?.precio) {
                        const ciclo = plan?.ciclo || 'Mensual';
                        lines.push(`- ${ciclo}: ${plan.precio}`);
                    }

                    if (Array.isArray(plan?.incluye) && plan.incluye.length > 0) {
                        lines.push(`  Incluye: ${plan.incluye.slice(0, 4).join(', ')}`);
                    }

                    if (plan?.condicion) {
                        lines.push(`  Condición: ${plan.condicion}`);
                    }
                }
            }

            if (data.comparativa_versiones) {
                lines.push(`\nComparativa: ${typeof data.comparativa_versiones === 'string' ? data.comparativa_versiones : JSON.stringify(data.comparativa_versiones)}`);
            }

            if (data.pagos) {
                lines.push(`\nMétodos de pago: ${typeof data.pagos === 'string' ? data.pagos : JSON.stringify(data.pagos)}`);
            }

            if (Array.isArray(data.requisitos_documentales) && data.requisitos_documentales.length > 0) {
                lines.push(`\nRequisitos documentales: ${data.requisitos_documentales.slice(0, 6).join(', ')}`);
            }

            if (Array.isArray(data.datos_registro_cliente) && data.datos_registro_cliente.length > 0) {
                lines.push(`Datos registro cliente: ${data.datos_registro_cliente.slice(0, 6).join(', ')}`);
            }

            if (data.migraciones) {
                lines.push(`\nMigraciones: ${typeof data.migraciones === 'string' ? data.migraciones : JSON.stringify(data.migraciones)}`);
            }

            if (data.bloques) {
                lines.push(`Bloques migración: ${typeof data.bloques === 'string' ? data.bloques : JSON.stringify(data.bloques)}`);
            }

            if (includeContact && data.contacto) {
                const c = data.contacto;
                const contactParts = [];
                if (c.whatsapp) contactParts.push(`WhatsApp: ${c.whatsapp}`);
                if (c.web) contactParts.push(`Web: ${c.web}`);
                if (c.empresa) contactParts.push(`Empresa: ${c.empresa}`);
                if (contactParts.length > 0) lines.push(`\nContacto: ${contactParts.join(' | ')}`);
            }

            const nota = data.nota || data.nota_precios || '';
            if (nota) lines.push(`\nNota: ${nota}`);

            blocks.push(lines.join('\n'));
        }

        return [
            'CONTEXTO DE CONOCIMIENTO ACOTADO (PRIORITARIO):',
            ...blocks
        ].join('\n\n---\n\n');
    }

    async _buildFallbackKnowledgeSummary() {
        const catalog = await knowledgeLoader.getCatalogDigest();
        const lines = [
            'RESUMEN GENERAL DE TODOS LOS PRODUCTOS (SUPER CATÁLOGO):'
        ];

        for (const item of (catalog.items || [])) {
            lines.push(`- ${item.name}${item.summary ? `: ${item.summary}` : ''}`);
        }

        return lines.join('\n');
    }

    _escapePromptBraces(text = '') {
        return String(text || '').replace(/\{/g, '{{').replace(/\}/g, '}}');
    }


    _finalizeReplyQuality(text = '') {
        let out = String(text || '').trim();
        if (!out) return out;

        // Optimización: Si la respuesta es demasiado larga para WhatsApp, recortar y cerrar.
        if (out.length > 4500) {
            out = out.slice(0, 4400) + '... (Mensaje simplificado por longitud)';
        }

        // Elimina fuga de razonamiento interno del modelo.
        out = out.replace(/\bWait,\s*I\s*need\s*to\s*make\s*sure[\s\S]*$/i, '').trim();
        out = out.replace(/^\s*Revised\s*$/i, '').trim();

        out = out
            .replace(/,{2,}/g, ',')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        // Normaliza negrita al formato de WhatsApp: *texto* (evita **texto** estilo Markdown).
        out = out
            .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
            .replace(/\*\*([^*\n]+)\*/g, '*$1*')
            .replace(/\*([^*\n]+)\*\*/g, '*$1*');

        // Evita mensajes inventados sobre fallos internos o duplicados si no hubo evidencia real.
        const hallucinatedOpsPatterns = [
            /hubo un error/i,
            /hubo una confusi[oó]n/i,
            /parece que hubo una confusi[oó]n/i,
            /se repiti[oó] el mensaje/i,
            /ya estamos de vuelta/i,
            /disculpa[^\n]{0,80}error/i,
            /mensaje anterior/i,
            /uso los saltos de l[ií]nea/i,
            /m[aá]s f[aá]ciles de leer en el celular/i,
            /evito bloques de texto/i
        ];
        const rawLines = out
            .split(/\r?\n/)
            .map((line) => line.trimEnd());
        const filtered = rawLines.filter((line) => {
            const compact = line.trim();
            if (!compact) return true;
            return !hallucinatedOpsPatterns.some((rx) => rx.test(compact));
        });
        if (filtered.length > 0) {
            out = filtered.join('\n');

            // Elimina lineas separadoras artificiales (ej: "__", "---", "***").
            out = out
                .split(/\r?\n/)
                .filter((line) => !/^\s*[_\-*=~]{2,}\s*$/.test(line))
                .join('\n');

            // Compacta exceso de espacios manteniendo legibilidad en WhatsApp.
            out = out
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        return out;
    }

    _looksTruncatedReply(text = '') {
        const out = String(text || '').trim();
        if (out.length < 55) return false;

        // Si cierra con puntuación fuerte, asumimos mensaje completo.
        if (/[.!?…)]$/.test(out)) return false;
        if (/[✅❌😊🙂😉😄😁🙌👍💰⚡📌📄🧾]$/.test(out)) return false;

        // Señales frecuentes de corte: termina en conector/preposición o separador.
        if (/[,;:]$/.test(out)) return true;
        if (/(?:\bS\/|\bUS\$|\$)\s*$/i.test(out)) return true;
        if (/\/$/.test(out)) return true;

        const opens = (out.match(/[\(\[\{]/g) || []).length;
        const closes = (out.match(/[\)\]\}]/g) || []).length;
        if (opens > closes) return true;

        const lastLine = out.split(/\r?\n/).filter(Boolean).pop() || out;
        const lastWords = lastLine.toLowerCase().trim();
        if (/(\bde\b|\bdel\b|\bla\b|\blas\b|\bel\b|\blos\b|\by\b|\bo\b|\bque\b|\bpara\b|\bcon\b|\bpor\b|\ben\b|\ba\b|\bal\b|\bun\b|\buna\b|\balguna\b|\balgun\b|\balgún\b|\bnuestro\b|\bnuestra\b|\bnuestros\b|\bnuestras\b|\bestro\b|\best\b)$/.test(lastWords)) {
            return true;
        }

        // Si el mensaje queda sin cierre y parece una introduccion abierta, suele estar cortado.
        if (out.length >= 70 && !/[.!?…)]$/.test(out) && /\b(ahora\s+si|te\s+cuento|vamos\s+con|informacion\s+sobre|nuestro\s+sistema)\b/i.test(out)) {
            return true;
        }

        // Respuestas largas sin cierre de frase suelen indicar corte por límite de salida.
        if (out.length > 180 && /[a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]$/.test(out)) {
            return true;
        }

        // Si la ultima linea es muy corta y sin cierre de idea, probable corte.
        return lastLine.length <= 28 && !/[.!?…)]$/.test(lastLine);
    }

    _needsContinuationGuard(text = '') {
        const out = String(text || '').trim();
        if (out.length < 45) return false;
        if (/[.!?…)]$/.test(out)) return false;
        if (/[✅❌😊🙂😉😄😁🙌👍💰⚡📌📄🧾]$/.test(out)) return false;
        return true;
    }

    _ensureTerminalClosure(text = '') {
        const out = String(text || '').trim();
        if (!out) return out;
        if (/[.!?…)]$/.test(out)) return out;
        if (/[✅❌😊🙂😉😄😁🙌👍💰⚡📌📄🧾]$/.test(out)) return out;
        return `${out}.`;
    }

    async _continueTruncatedReply(chain, historyMessages, partialReply, timeoutMs) {
        const continuationPrompt = [
            'Tu respuesta anterior quedó incompleta.',
            'Continúa desde el último punto sin repetir lo ya dicho.',
            'No agregues saludos ni reinicios, solo la continuación.',
            `Texto previo:\n${String(partialReply || '').slice(-900)}`
        ].join('\n\n');

        const continuationResponse = await this._generateWithTimeout(
            chain,
            {
                input: continuationPrompt,
                history: historyMessages
            },
            timeoutMs
        );

        const continuationText = this._finalizeReplyQuality(continuationResponse?.content || '');
        if (!continuationText) return String(partialReply || '');

        return `${String(partialReply || '').trim()} ${continuationText}`.trim();
    }

    _normalizeFlowText(text = '') {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _extractProductIdentifiers(product = null) {
        if (!product) return [];

        const base = [
            product?.sitio || '',
            product?.alias || '',
            product?.data?.url || ''
        ].join(' ');

        const normalized = this._normalizeFlowText(base)
            .replace(/[^a-z0-9\s./-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalized) return [];

        const tokens = normalized
            .split(/[\s/.-]+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .filter((t) => t.length >= 3)
            .filter((t) => /\d/.test(t) || t.length >= 5);

        return Array.from(new Set(tokens));
    }

    _escapeRegex(text = '') {
        return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _selectExplicitCurrentProduct(text = '', matches = []) {
        const normalizedText = this._normalizeFlowText(text);
        if (!normalizedText || !Array.isArray(matches) || matches.length === 0) return null;

        const mentions = [];
        for (const item of matches) {
            const ids = this._extractProductIdentifiers(item);
            if (ids.length === 0) continue;

            let bestPos = -1;
            let isNegated = false;

            for (const id of ids) {
                const escaped = this._escapeRegex(id);
                const rx = new RegExp(`\\b${escaped}\\b`, 'i');
                const pos = normalizedText.search(rx);
                if (pos === -1) continue;

                if (bestPos === -1 || pos < bestPos) {
                    bestPos = pos;
                }

                const negRx = new RegExp(`\\bno\\s+${escaped}\\b`, 'i');
                if (negRx.test(normalizedText)) {
                    isNegated = true;
                }
            }

            if (bestPos >= 0) {
                mentions.push({ item, pos: bestPos, negated: isNegated });
            }
        }

        if (mentions.length === 0) return null;

        const positiveMentions = mentions.filter((m) => !m.negated);
        if (positiveMentions.length > 0) {
            positiveMentions.sort((a, b) => a.pos - b.pos);
            return positiveMentions[0].item;
        }

        return null;
    }

    _hasExplicitProductMention(text = '', product = null) {
        const normalizedText = this._normalizeFlowText(text);
        if (!normalizedText || !product) return false;

        const sitio = this._normalizeFlowText(product?.sitio || '');
        const alias = this._normalizeFlowText(product?.alias || '');
        if (sitio && normalizedText.includes(sitio)) return true;
        if (alias && normalizedText.includes(alias)) return true;

        const identifiers = this._extractProductIdentifiers(product);
        if (identifiers.some((id) => new RegExp(`\\b${id}\\b`, 'i').test(normalizedText))) {
            return true;
        }

        return false;
    }

    async _inferCommercialFlowState(userMessage = '', chatHistory = null, activeProduct = '') {
        const current = this._normalizeFlowText(userMessage);
        const productName = String(activeProduct || '').trim();

        let historyText = '';
        try {
            if (chatHistory && typeof chatHistory.getMessages === 'function') {
                const history = await chatHistory.getMessages();
                const recent = Array.isArray(history) ? history.slice(-12) : [];
                historyText = recent
                    .map((m) => this._normalizeFlowText(m?.content || ''))
                    .filter(Boolean)
                    .join(' \n ');
            }
        } catch (_) {
            historyText = '';
        }

        const userWantsToStop = /(no gracias|gracias|eso seria todo|eso es todo|no deseo|no quiero continuar|luego te escribo)/.test(current);
        const asksForPlans = /(plan|planes|mensual|trimestral|semestral|semi anual|semanal|anual|precio|precios|costo|cuanto)/.test(current);
        const selectsPlan = /(me quedo|quiero el plan|elijo|escogo|escojo|tomo el|vamos con|ese plan|opcion\s*[0-9]|plan\s+(mensual|trimestral|semestral|anual|pro|essential|priority)|lo quiero|activar)/i.test(current);
        const asksHowToPay = /(como pago|donde pago|formas de pago|medio de pago|metodo de pago|cuenta|transferencia|deposito|yape|plin|bancolombia|pse|pagar|comprar)/.test(current);
        const reportsPaidOrVoucher = /(ya pague|ya pagué|realice el pago|realic[eé] el pago|adjunto comprobante|te envio comprobante|te envío comprobante|voucher|comprobante|captura|foto del pago|listo el pago)/.test(current);

        const aiAskedPlanRecently = /(que plan prefieres|cual plan prefieres|que ciclo prefieres|cual ciclo prefieres|que opcion te interesa)/.test(historyText);
        const aiAskedPaymentRecently = /(como prefieres pagar|como deseas pagar|metodo de pago|medio de pago|te comparto los datos de pago|datos de pago)/.test(historyText);
        const aiAskedVoucherRecently = /(envia|env[ií]a|comparte).*?(comprobante|voucher|captura|constancia)/.test(historyText);

        let stage = 'DISCOVERY';
        let nextAction = 'ASK_PRODUCT';

        if (userWantsToStop) {
            stage = 'CLOSING';
            nextAction = 'CLOSE_RESPECTFULLY';
        } else if (reportsPaidOrVoucher || aiAskedVoucherRecently) {
            stage = 'PAYMENT_PROOF';
            nextAction = 'REQUEST_PROOF_CHANNEL';
        } else if (asksHowToPay || aiAskedPaymentRecently) {
            stage = 'PAYMENT_METHOD';
            nextAction = 'PROVIDE_PAYMENT_OPTIONS';
        } else if (selectsPlan || aiAskedPlanRecently) {
            stage = 'PLAN_SELECTION';
            nextAction = 'CONFIRM_PLAN_AND_ADVANCE_TO_PAYMENT';
        } else if (productName || asksForPlans) {
            stage = 'PRODUCT_INTEREST';
            nextAction = 'SHOW_PLANS_AND_ASK_CHOICE';
        }

        return {
            stage,
            nextAction,
            activeProduct: productName || 'NINGUNO',
            hasHistory: Boolean(historyText),
            signals: {
                asksForPlans,
                selectsPlan,
                asksHowToPay,
                reportsPaidOrVoucher,
                userWantsToStop
            }
        };
    }

    _getAttemptWindow(attemptIndex = 0) {
        return attemptIndex === 0 ? this.initialHistoryWindow : this.retryHistoryWindow;
    }

    _recordCutoff(reason, details = {}) {
        this.lastCutoff = {
            timestamp: Date.now(),
            reason,
            details
        };
    }

    _extractErrorText(error) {
        const parts = [
            error?.message,
            error?.response?.data?.error?.message,
            error?.cause?.message,
            error?.details
        ];

        const text = parts
            .filter(Boolean)
            .map(v => String(v).trim())
            .join(' | ');

        return text || 'Error desconocido';
    }

    _classifyError(error) {
        const technicalMessage = this._extractErrorText(error);
        const txt = technicalMessage.toLowerCase();

        if (/api key not valid|invalid api key|unauthorized|forbidden|permission denied|authentication|401|403/.test(txt)) {
            return {
                code: 'TOKEN_INVALID_OR_NO_PERMISSION',
                probableCause: 'Token invalido, sin permisos o app/proyecto sin acceso al recurso.',
                technicalMessage
            };
        }

        if (/quota|insufficient quota|resource exhausted|billing|limit reached|exceeded your current quota/.test(txt)) {
            return {
                code: 'QUOTA_EXHAUSTED',
                probableCause: 'Se agoto la cuota del proyecto/API key.',
                technicalMessage
            };
        }

        if (/rate limit|too many requests|429/.test(txt)) {
            return {
                code: 'RATE_LIMITED',
                probableCause: 'Demasiadas solicitudes en poco tiempo (rate limit).',
                technicalMessage
            };
        }

        if (/token limit|context length|prompt too long|input too long|request too large|maximum context|too many tokens/.test(txt)) {
            return {
                code: 'CONTEXT_TOO_LARGE',
                probableCause: 'El contexto/prompt enviado fue demasiado grande.',
                technicalMessage
            };
        }

        if (/safety|blocked|policy|harmful|prohibited/.test(txt)) {
            return {
                code: 'SAFETY_BLOCKED',
                probableCause: 'La respuesta o solicitud fue bloqueada por politicas de seguridad.',
                technicalMessage
            };
        }

        if (/timeout|deadline exceeded|timed out/.test(txt)) {
            return {
                code: 'TIMEOUT',
                probableCause: 'El modelo no respondio dentro del tiempo limite.',
                technicalMessage
            };
        }

        if (/unavailable|overloaded|internal error|503|500/.test(txt)) {
            return {
                code: 'MODEL_TEMPORARILY_UNAVAILABLE',
                probableCause: 'Servicio del modelo temporalmente no disponible o saturado.',
                technicalMessage
            };
        }

        return {
            code: 'UNKNOWN_RUNTIME_ERROR',
            probableCause: 'Fallo no clasificado; revisar detalle tecnico y logs.',
            technicalMessage
        };
    }

    _summarizeAttemptFailures(attemptFailures = []) {
        if (!Array.isArray(attemptFailures) || attemptFailures.length === 0) {
            return {
                rootErrorCode: 'NO_ATTEMPT_ERRORS',
                rootProbableCause: 'No se registraron errores de intento para este corte.'
            };
        }

        const counts = {};
        for (const item of attemptFailures) {
            const code = item?.errorCode || 'UNKNOWN_RUNTIME_ERROR';
            counts[code] = (counts[code] || 0) + 1;
        }

        let rootErrorCode = null;
        let maxCount = -1;
        for (const [code, count] of Object.entries(counts)) {
            if (count > maxCount) {
                rootErrorCode = code;
                maxCount = count;
            }
        }

        const root = attemptFailures.find(item => item.errorCode === rootErrorCode);
        return {
            rootErrorCode,
            rootProbableCause: root?.probableCause || 'No disponible'
        };
    }

    _withFailureDiagnostics(baseDetails = {}, attemptFailures = []) {
        const recentAttemptErrors = Array.isArray(attemptFailures)
            ? attemptFailures.slice(-4)
            : [];
        const summary = this._summarizeAttemptFailures(recentAttemptErrors);

        return {
            ...baseDetails,
            ...summary,
            recentAttemptErrors
        };
    }

    _buildWindowedHistory(chatHistory, maxMessages) {
        if (!chatHistory || typeof chatHistory.getMessages !== 'function' || typeof chatHistory.addMessage !== 'function') {
            return chatHistory;
        }

        const maxChars = this.maxMessageCharsInHistory;
        return {
            getMessages: async () => {
                const messages = await chatHistory.getMessages();
                if (!Array.isArray(messages)) return [];
                const windowed = messages.slice(Math.max(0, messages.length - maxMessages));
                return windowed.map((msg) => {
                    if (!msg || typeof msg.content !== 'string' || msg.content.length <= maxChars) {
                        return msg;
                    }

                    const cloned = Object.assign(
                        Object.create(Object.getPrototypeOf(msg)),
                        msg
                    );
                    cloned.content = `${msg.content.slice(0, maxChars)}\n[Mensaje recortado por rendimiento]`;
                    return cloned;
                });
            },
            addMessage: async (msg) => chatHistory.addMessage(msg),
            clear: async () => Promise.resolve()
        };
    }

    async _resolveKnowledgeContextQuery(userMessage, chatHistory) {
        const current = String(userMessage || '').trim();
        const currentNorm = this._normalizeFlowText(current);
        const migrationIntent = /(migr\w+)/i.test(currentNorm)
            && /(pro\s*5|pro\s*6|pro\s*7|pro\s*8|pro8)/i.test(currentNorm);

        if (migrationIntent) {
            return {
                query: 'Migrar a Pro8',
                inferredFromHistory: false,
                activeProduct: 'Migrar a Pro8',
                resolutionMode: 'MIGRATION_INTENT_PRO8',
                trace: {
                    messageChars: current.length,
                    intentNeedsProductLock: true,
                    explicitCurrentProduct: 'Migrar a Pro8',
                    migrationIntent: true
                }
            };
        }

        const currentMatches = await knowledgeLoader.findProductsByQuery(current, 3);
        const intentNeedsProductLock = /\b(plan|planes|mes|meses|mensual|trimestral|semestral|semi[-\s]?anual|anual|precio|costo|cu[aá]nto|priority|essential|pro\d+)\b/i.test(current);
        const explicitCurrentProduct = this._selectExplicitCurrentProduct(current, currentMatches)
            || currentMatches.find((item) => this._hasExplicitProductMention(current, item));
        const buildResult = ({ query, inferredFromHistory, activeProduct, resolutionMode, trace = {} }) => ({
            query,
            inferredFromHistory,
            activeProduct,
            resolutionMode,
            trace: {
                messageChars: current.length,
                intentNeedsProductLock,
                explicitCurrentProduct: explicitCurrentProduct?.sitio || null,
                ...trace
            }
        });

        // Solo fijar por mensaje actual si el usuario nombra explícitamente el producto.
        if (explicitCurrentProduct) {
            return buildResult({
                query: current,
                inferredFromHistory: false,
                activeProduct: explicitCurrentProduct?.sitio || null,
                resolutionMode: 'EXPLICIT_CURRENT_MESSAGE'
            });
        }

        // Follow-up corto/ambiguo: usar contexto reciente del chat para mantener el producto activo.
        const isShortFollowUp = current.length <= 24 || /^(fuente|precio|planes?|detalles?|info|mas info|m[aá]s info|link)\??$/i.test(current);
        const shouldInferFromHistory = isShortFollowUp || intentNeedsProductLock;
        if (!shouldInferFromHistory || !chatHistory || typeof chatHistory.getMessages !== 'function') {
            return buildResult({
                query: current,
                inferredFromHistory: false,
                activeProduct: null,
                resolutionMode: 'NO_HISTORY_INFERENCE',
                trace: {
                    isShortFollowUp,
                    shouldInferFromHistory
                }
            });
        }

        try {
            const history = await chatHistory.getMessages();
            const recent = Array.isArray(history) ? history.slice(-8) : [];
            const recentHumans = recent.filter((m) => {
                const t = String(
                    m?.type ||
                    (typeof m?._getType === 'function' ? m._getType() : '') ||
                    (typeof m?.getType === 'function' ? m.getType() : '')
                ).toLowerCase();
                return t === 'human' || t === 'user';
            });

            // En follow-up ambiguo, heredar del ultimo producto mencionado por el usuario.
            for (let i = recentHumans.length - 1; i >= 0; i--) {
                const msgText = String(recentHumans[i]?.content || '').trim();
                if (!msgText) continue;
                const matches = await knowledgeLoader.findProductsByQuery(msgText, 3);
                const explicit = matches.find((item) => this._hasExplicitProductMention(msgText, item));
                if (explicit?.sitio) {
                    const inferredQuery = `${explicit.sitio} ${current}`.trim();
                    return buildResult({
                        query: inferredQuery,
                        inferredFromHistory: true,
                        activeProduct: explicit.sitio,
                        resolutionMode: 'INHERITED_FROM_HUMAN_HISTORY',
                        trace: {
                            isShortFollowUp,
                            shouldInferFromHistory,
                            scannedHumanMessages: recentHumans.length,
                            inheritedFromMessageIndex: i
                        }
                    });
                }
            }

        } catch (_) {
            // Silencioso: si no se puede leer historial, seguimos con query actual.
        }

        return buildResult({
            query: current,
            inferredFromHistory: false,
            activeProduct: null,
            resolutionMode: 'NO_EXPLICIT_PRODUCT'
        });
    }

    _estimateMessageChars(messages = []) {
        if (!Array.isArray(messages)) return 0;
        return messages.reduce((acc, msg) => {
            if (msg && typeof msg.content === 'string') {
                return acc + msg.content.length;
            }
            return acc;
        }, 0);
    }

    async _appendFallbackToHistory(chatHistory, userMessage, fallbackText) {
        if (!chatHistory || typeof chatHistory.getMessages !== 'function' || typeof chatHistory.addMessage !== 'function') {
            return;
        }

        try {
            const messages = await chatHistory.getMessages();
            const list = Array.isArray(messages) ? messages : [];
            const last = list[list.length - 1];
            const lastContent = String(last?.content || '');

            if (lastContent !== String(userMessage || '')) {
                await chatHistory.addMessage(new HumanMessage(String(userMessage || '')));
            }

            await chatHistory.addMessage(new AIMessage(String(fallbackText || '')));
        } catch (error) {
            logger.warn(`[GEMINI] No se pudo persistir fallback en historial: ${error.message}`);
        }
    }

    _modelContentToText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (part && typeof part.text === 'string') return part.text;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        return String(content || '');
    }

    _extractFirstJsonObject(text = '') {
        const raw = String(text || '').trim();
        const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
        const candidate = fenced?.[1] || raw;
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;

        const maybeJson = candidate.slice(start, end + 1);
        try {
            return JSON.parse(maybeJson);
        } catch (_) {
            return null;
        }
    }

    _parseDateCandidate(raw = '') {
        const txt = String(raw || '').trim();
        if (!txt) return null;

        const isoMatch = txt.match(/\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/);
        if (isoMatch) {
            const y = Number(isoMatch[1]);
            const m = Number(isoMatch[2]);
            const d = Number(isoMatch[3]);
            return new Date(Date.UTC(y, m - 1, d));
        }

        const latamMatch = txt.match(/\b(0?[1-9]|[12]\d|3[01])[-\/](0?[1-9]|1[0-2])[-\/](20\d{2})\b/);
        if (latamMatch) {
            const d = Number(latamMatch[1]);
            const m = Number(latamMatch[2]);
            const y = Number(latamMatch[3]);
            return new Date(Date.UTC(y, m - 1, d));
        }

        return null;
    }

    _computeDateRecency(dateCandidate, todayIso, maxAgeDays) {
        const parsed = this._parseDateCandidate(dateCandidate);
        if (!parsed || Number.isNaN(parsed.getTime())) {
            return {
                isRecent: false,
                daysOld: null,
                reason: 'No se detecto una fecha valida en el comprobante.'
            };
        }

        const ref = this._parseDateCandidate(todayIso) || new Date();
        const diffMs = ref.getTime() - parsed.getTime();
        const daysOld = Math.floor(diffMs / 86400000);

        if (daysOld < 0) {
            return {
                isRecent: false,
                daysOld,
                reason: 'La fecha del comprobante parece futura.'
            };
        }

        if (daysOld > maxAgeDays) {
            return {
                isRecent: false,
                daysOld,
                reason: `La fecha excede la antiguedad maxima permitida (${maxAgeDays} dias).`
            };
        }

        return {
            isRecent: true,
            daysOld,
            reason: `Fecha dentro del rango permitido (${daysOld} dias).`
        };
    }

    _applyDeterministicPaymentValidation(parsed = {}, options = {}) {
        const todayIso = String(options.todayIso || new Date().toISOString().slice(0, 10));
        const maxAgeDays = Math.max(Number(options.maxAgeDays || 2), 1);

        const dateIso = String(parsed.date_iso || '').trim();
        const dateText = String(parsed.date_text || '').trim();
        const amountText = String(parsed.amount_text || '').trim();
        const operationNumber = String(parsed.operation_number || '').trim();
        const statusText = this._normalizeFlowText(parsed.payment_status || parsed.status_text || '');
        const matchedDestination = Boolean(parsed.matched_destination);

        const dateRecency = this._computeDateRecency(dateIso || dateText, todayIso, maxAgeDays);
        const amountDetected = /\d/.test(amountText);
        const operationDetected = /[a-z0-9]{4,}/i.test(operationNumber.replace(/\s+/g, ''));
        const statusApproved = /(aprobad|exitos|completad|ok|success)/.test(statusText);

        const checks = [
            {
                name: 'fecha_reciente',
                passed: dateRecency.isRecent,
                reason: dateRecency.reason
            },
            {
                name: 'monto_detectado',
                passed: amountDetected,
                reason: amountDetected ? 'Se detecto monto en la imagen.' : 'No se detecto monto confiable.'
            },
            {
                name: 'operacion_detectada',
                passed: operationDetected,
                reason: operationDetected ? 'Se detecto numero/codigo de operacion.' : 'Falta numero de operacion legible.'
            },
            {
                name: 'destino_coincidente',
                passed: matchedDestination,
                reason: matchedDestination
                    ? 'El destino coincide con cuentas/medios permitidos.'
                    : 'El destino no coincide con datos de pago permitidos.'
            },
            {
                name: 'estado_pago',
                passed: statusApproved,
                reason: statusApproved
                    ? 'El comprobante muestra estado exitoso/aprobado.'
                    : 'No se pudo confirmar estado de pago aprobado.'
            }
        ];

        const failed = checks.filter((c) => !c.passed);
        const passed = checks.length - failed.length;
        const confidence = Number((passed / checks.length).toFixed(2));
        const hardFail = !dateRecency.isRecent || !matchedDestination || !amountDetected || !operationDetected;
        const status = !hardFail && statusApproved ? 'VALIDADO' : 'NO VALIDADO';

        const reasons = failed.map((c) => c.reason);
        const summary = status === 'VALIDADO'
            ? 'Comprobante consistente con las validaciones requeridas.'
            : 'Comprobante con observaciones; requiere correccion o revision manual.';

        return {
            ...parsed,
            status,
            confidence,
            checks,
            reasons,
            summary,
            is_recent_date: dateRecency.isRecent,
            days_old: dateRecency.daysOld
        };
    }

    _formatPaymentValidationReply(result = {}) {
        const status = String(result?.status || '').toUpperCase() === 'VALIDADO' ? 'VALIDADO' : 'NO VALIDADO';
        const icon = status === 'VALIDADO' ? '✅' : '❌';
        const confidence = Number(result?.confidence);
        const confidenceText = Number.isFinite(confidence)
            ? `${Math.max(0, Math.min(100, Math.round(confidence * 100)))}%`
            : 'No disponible';

        const reasons = Array.isArray(result?.reasons)
            ? result.reasons.filter(Boolean).slice(0, 4)
            : [];
        const checks = Array.isArray(result?.checks)
            ? result.checks.slice(0, 5)
            : [];

        const lines = [`${status} ${icon}`];
        lines.push(`Confianza: ${confidenceText}`);

        if (result?.date_text) lines.push(`Fecha detectada: ${result.date_text}`);
        if (result?.amount_text) lines.push(`Monto detectado: ${result.amount_text}`);
        if (result?.operation_number) lines.push(`Operacion: ${result.operation_number}`);
        lines.push(`Coincidencia de destino: ${result?.matched_destination ? 'SI' : 'NO'}`);

        if (reasons.length) {
            lines.push('Motivos:');
            for (const reason of reasons) {
                lines.push(`- ${reason}`);
            }
        }

        if (checks.length) {
            lines.push('Validaciones:');
            for (const check of checks) {
                const label = check?.name ? String(check.name) : 'check';
                const mark = check?.passed ? 'OK' : 'FALLA';
                const detail = check?.reason ? ` - ${check.reason}` : '';
                lines.push(`- ${label}: ${mark}${detail}`);
            }
        }

        if (result?.summary) {
            lines.push(`Resumen: ${String(result.summary).trim()}`);
        }

        return lines.join('\n');
    }

    async validatePaymentProof(imageInput = {}, options = {}) {
        const imageBase64 = String(imageInput?.base64 || '').trim();
        const mimeType = String(imageInput?.mimeType || 'image/jpeg').trim();
        const caption = String(imageInput?.caption || '').trim();
        const chatHistory = options?.chatHistory || null;

        if (!imageBase64) {
            return 'NO VALIDADO ❌\nMotivo: No se pudo leer la imagen del comprobante.';
        }

        const fileSizeBytes = Number(imageInput?.fileSizeBytes || 0);
        if (fileSizeBytes > 8 * 1024 * 1024) {
            return 'NO VALIDADO ❌\nMotivo: La imagen supera el tamano maximo permitido (8MB).';
        }

        const keyData = this._getNextAvailableKey();
        if (!keyData) {
            return 'NO VALIDADO ❌\nMotivo: No hay capacidad temporal para validar el comprobante.';
        }

        const runtimeConfig = this._resolveRuntimeConfig(null);
        const model = this._buildModel(keyData, runtimeConfig);
        const maxAgeDays = Math.max(Number(config.gemini?.paymentValidationMaxAgeDays || 2), 1);
        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);

        const paymentProfiles = await knowledgeLoader.getPaymentValidationProfiles();
        const validationContext = JSON.stringify({
            fecha_hoy: todayIso,
            max_antiguedad_dias: maxAgeDays,
            perfiles_pago: paymentProfiles
        });

        const instruction = [
            'Eres un validador de comprobantes de pago.',
            `Fecha actual de referencia: ${todayIso}.`,
            `La fecha del comprobante debe ser reciente (<= ${maxAgeDays} dias).`,
            'Analiza la imagen y determina si es un comprobante de pago valido.',
            'Si la imagen NO es un comprobante/boleta/factura de pago, marca NO VALIDADO y explica que no corresponde a un comprobante.',
            'Valida como minimo: legibilidad, fecha, monto, numero de operacion, estado exitoso/aprobado, y coincidencia de destino (cuenta/CCI/Yape/PLIN/NIT/titular) con los perfiles permitidos.',
            'Si falta evidencia clave o hay duda razonable, marca NO VALIDADO.',
            `Contexto de pagos permitidos: ${validationContext}`,
            caption ? `Texto adjunto por usuario: ${caption}` : '',
            'Responde SOLO JSON estricto con este esquema:',
            '{"status":"VALIDADO|NO VALIDADO","confidence":0.0,"is_recent_date":true,"date_text":"","date_iso":"","amount_text":"","currency":"PEN|COP|USD|UNKNOWN","operation_number":"","payment_status":"","matched_destination":true,"matched_fields":[],"checks":[{"name":"","passed":true,"reason":""}],"reasons":[],"summary":""}'
        ].filter(Boolean).join('\n');

        try {
            const response = await model.invoke([
                new HumanMessage({
                    content: [
                        { type: 'text', text: instruction },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
                    ]
                })
            ]);

            const raw = this._modelContentToText(response?.content);
            const parsed = this._extractFirstJsonObject(raw);
            if (!parsed) {
                logger.warn('[GEMINI] Validacion de comprobante sin JSON parseable.');
                return 'NO VALIDADO ❌\nMotivo: No se pudo estructurar la validacion del comprobante.';
            }

            const finalResult = this._applyDeterministicPaymentValidation(parsed, {
                todayIso,
                maxAgeDays
            });
            const output = this._formatPaymentValidationReply(finalResult);

            if (chatHistory && typeof chatHistory.addMessage === 'function') {
                const userEvidenceText = caption
                    ? `[Imagen de comprobante enviada] ${caption}`
                    : '[Imagen de comprobante enviada]';
                await chatHistory.addMessage(new HumanMessage(userEvidenceText));
                await chatHistory.addMessage(new AIMessage(output));
            }

            return output;
        } catch (error) {
            const info = this._classifyError(error);
            logger.error(`[GEMINI] Error validando comprobante: ${info.code} - ${info.technicalMessage}`);
            return 'NO VALIDADO ❌\nMotivo: No se pudo completar la validacion automatica de la imagen.';
        }
    }

    async describeImage(imageInput = {}, options = {}) {
        const imageBase64 = String(imageInput?.base64 || '').trim();
        const mimeType = String(imageInput?.mimeType || 'image/jpeg').trim();
        const caption = String(imageInput?.caption || '').trim();
        const userPhone = String(options?.userPhone || '').trim();

        if (!imageBase64) {
            throw new GeminiAPIError('No se recibio contenido de imagen para describir');
        }

        const fileSizeBytes = Number(imageInput?.fileSizeBytes || 0);
        if (fileSizeBytes > 10 * 1024 * 1024) {
            throw new GeminiAPIError('La imagen supera el limite de 10MB para analisis general');
        }

        const keyData = this._getNextAvailableKey();
        if (!keyData) {
            throw new GeminiAPIError('No hay API keys disponibles temporalmente para analizar imagen');
        }

        const runtimeConfig = this._resolveRuntimeConfig(null);

        try {
            keyData.totalCalls += 1;
            keyData.lastUsedAt = Date.now();
            metrics.increment('geminiCalls');
            this._persistKeyCall(keyData);

            const genAI = new GoogleGenerativeAI(keyData.apiKey);
            const model = genAI.getGenerativeModel({
                model: config.gemini.model || 'gemini-2.5-flash',
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: Math.max(500, Math.min(runtimeConfig.generation.maxOutputTokens, 900)),
                    topP: runtimeConfig.generation.topP
                }
            });

            const prompt = [
                'Describe brevemente lo que se ve en la imagen en espanol.',
                'Si se aprecia una marca, objeto o estado visible, mencionarlo con cautela sin inventar detalles.',
                'No hables de comprobantes ni pagos salvo que la imagen claramente sea uno.',
                caption ? `Contexto del usuario: ${caption}` : ''
            ].filter(Boolean).join(' ');

            const timeoutMs = Math.max(20000, runtimeConfig.timeout);
            const result = await Promise.race([
                model.generateContent([
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType,
                            data: imageBase64
                        }
                    }
                ]),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new GeminiAPIError('Timeout describiendo imagen con Gemini')), timeoutMs);
                })
            ]);

            const text = String(result?.response?.text?.() || '').trim();
            if (!text) {
                throw new GeminiAPIError('Gemini devolvio descripcion vacia para la imagen');
            }

            keyData.failures = 0;
            keyData.lastError = null;
            keyData.lastErrorAt = 0;

            logger.info(`[GEMINI] ✓ Imagen descrita (${mimeType}, ${Math.round(fileSizeBytes / 1024)}KB) para ${userPhone || 'usuario_sin_telefono'}`);
            return this._finalizeReplyQuality(text);
        } catch (error) {
            const info = this._classifyError(error);
            keyData.failures += 1;
            keyData.totalErrors += 1;
            keyData.lastError = info.code;
            keyData.lastErrorAt = Date.now();
            metrics.increment('geminiErrors');
            this._persistKeyError(keyData, info.technicalMessage || info.code);

            if (keyData.failures >= runtimeConfig.circuitBreaker.failureThreshold) {
                keyData.disabledUntil = Date.now() + runtimeConfig.circuitBreaker.recoveryTimeMs;
                metrics.increment('geminiKeyRotations');
            }

            this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
            throw new GeminiAPIError(`No se pudo describir la imagen: ${info.code}`, error);
        }
    }

    async transcribeAudio(audioInput = {}, options = {}) {
        const audioBase64 = String(audioInput?.base64 || '').trim();
        const mimeType = String(audioInput?.mimeType || 'audio/ogg').trim().toLowerCase();
        const mimeNormalized = mimeType.replace(/\s+/g, '').replace(/;codecs=/g, ';codecs=').trim();
        const fileSizeBytes = Number(audioInput?.fileSizeBytes || 0);
        const userPhone = String(options?.userPhone || '').trim();

        if (!audioBase64) {
            throw new GeminiAPIError('No se recibio contenido de audio para transcribir');
        }

        const isAllowedMime =
            mimeNormalized === 'audio/ogg' ||
            mimeNormalized.startsWith('audio/ogg;codecs=opus') ||
            mimeNormalized === 'audio/mpeg' ||
            mimeNormalized === 'audio/mp3' ||
            mimeNormalized === 'audio/wav' ||
            mimeNormalized === 'audio/x-wav' ||
            mimeNormalized === 'audio/webm' ||
            mimeNormalized === 'audio/mp4' ||
            mimeNormalized === 'audio/aac';

        if (!isAllowedMime) {
            throw new GeminiAPIError(`Formato de audio no soportado para transcripcion: ${mimeType}`);
        }

        if (fileSizeBytes > 20 * 1024 * 1024) {
            throw new GeminiAPIError('Audio supera el limite de 20MB para transcripcion');
        }

        const keyData = this._getNextAvailableKey();
        if (!keyData) {
            throw new GeminiAPIError('No hay API keys disponibles temporalmente para transcripcion');
        }

        const runtimeConfig = this._resolveRuntimeConfig(null);
        const prompt = [
            'Transcribe este audio en espanol de manera literal.',
            'No resumas.',
            'No traduzcas.',
            'No agregues analisis.',
            'Devuelve solo el texto transcrito limpio.'
        ].join(' ');

        try {
            keyData.totalCalls += 1;
            keyData.lastUsedAt = Date.now();
            metrics.increment('geminiCalls');
            this._persistKeyCall(keyData);

            const genAI = new GoogleGenerativeAI(keyData.apiKey);
            const model = genAI.getGenerativeModel({
                model: config.gemini.model || 'gemini-2.5-flash',
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: Math.max(700, Math.min(runtimeConfig.generation.maxOutputTokens, 1200)),
                    topP: runtimeConfig.generation.topP
                }
            });

            const timeoutMs = Math.max(25000, runtimeConfig.timeout);
            const result = await Promise.race([
                model.generateContent([
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType,
                            data: audioBase64
                        }
                    }
                ]),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new GeminiAPIError('Timeout transcribiendo audio con Gemini')), timeoutMs);
                })
            ]);

            const text = String(result?.response?.text?.() || '').trim();
            if (!text) {
                throw new GeminiAPIError('Gemini devolvio transcripcion vacia');
            }

            const normalized = text
                .replace(/^transcripci[oó]n\s*[:\-]\s*/i, '')
                .replace(/^texto\s*[:\-]\s*/i, '')
                .trim();

            keyData.failures = 0;
            keyData.lastError = null;
            keyData.lastErrorAt = 0;

            logger.info(`[GEMINI] ✓ Audio transcrito (${mimeType}, ${Math.round(fileSizeBytes / 1024)}KB) para ${userPhone || 'usuario_sin_telefono'}`);

            return {
                text: normalized,
                mimeType,
                fileSizeBytes
            };
        } catch (error) {
            const info = this._classifyError(error);
            keyData.failures += 1;
            keyData.totalErrors += 1;
            keyData.lastError = info.code;
            keyData.lastErrorAt = Date.now();
            metrics.increment('geminiErrors');
            this._persistKeyError(keyData, info.technicalMessage || info.code);

            if (keyData.failures >= runtimeConfig.circuitBreaker.failureThreshold) {
                keyData.disabledUntil = Date.now() + runtimeConfig.circuitBreaker.recoveryTimeMs;
                metrics.increment('geminiKeyRotations');
                logger.warn(`[GEMINI] ⚡ Circuit breaker activado por transcripcion en key #${keyData.index + 1}`);
            }

            this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
            logger.error(`[GEMINI] Error transcribiendo audio: ${info.code} - ${info.technicalMessage}`);
            throw new GeminiAPIError(`No se pudo transcribir el audio: ${info.code}`, error);
        }
    }

    /**
     * Genera una respuesta de la IA con circuit breaker y LangChain Memory
     */
    async generateResponse(userMessage, chatHistory, userName = '', userGeminiConfig = null, userPhone = '') {
        if (this.keys.length === 0) {
            this._recordCutoff('NO_KEYS_CONFIGURED', {
                phone: userPhone || null
            });
            const fallback = 'Tengo un problema temporal para responder en este momento. Intenta nuevamente en un instante.';
            await this._appendFallbackToHistory(chatHistory, userMessage, fallback);
            return fallback;
        }

        const runtimeConfig = this._resolveRuntimeConfig(userGeminiConfig);

        const userNamePrompt = userName
            ? `\n\nNombre del usuario: "${userName}". Puedes mencionarlo de forma ocasional y natural, sin repetirlo en cada mensaje.`
            : '';
        let attempts = 0;
        const maxAttempts = this.keys.length; // Probar todas las keys disponibles antes de rendirse
        const requestStart = Date.now();
        const attemptFailures = [];
        const initialMessages = (chatHistory && typeof chatHistory.getMessages === 'function')
            ? await chatHistory.getMessages()
            : [];
        const isFirstTurn = !Array.isArray(initialMessages) || initialMessages.length === 0;
        const requestTimeoutBudgetMs = isFirstTurn
            ? Math.max(this.totalTimeoutMs, 32000)
            : this.totalTimeoutMs;
        const requestDebug = {
            requestId: `greq_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            startedAt: requestStart,
            finishedAt: null,
            status: 'IN_PROGRESS',
            phone: userPhone || null,
            userMessageChars: String(userMessage || '').length,
            runtime: {
                timeoutMs: runtimeConfig.timeout,
                totalTimeoutMs: requestTimeoutBudgetMs,
                isFirstTurn,
                maxAttempts,
                generation: {
                    temperature: runtimeConfig.generation.temperature,
                    maxOutputTokens: runtimeConfig.generation.maxOutputTokens,
                    topP: runtimeConfig.generation.topP
                }
            },
            attempts: [],
            final: null
        };
        this.lastRequestDebug = requestDebug;

        while (attempts < maxAttempts) {
            const elapsed = Date.now() - requestStart;
            const remainingBudgetMs = requestTimeoutBudgetMs - elapsed;
            if (remainingBudgetMs <= 1000) {
                logger.warn('[GEMINI] Presupuesto total de tiempo agotado para este mensaje.');
                this._recordCutoff('TOTAL_BUDGET_EXHAUSTED', this._withFailureDiagnostics({
                    attempts,
                    maxAttempts,
                    remainingBudgetMs,
                    phone: userPhone || null
                }, attemptFailures));
                requestDebug.status = 'FAILED';
                requestDebug.finishedAt = Date.now();
                requestDebug.final = {
                    reason: 'TOTAL_BUDGET_EXHAUSTED',
                    remainingBudgetMs,
                    attempts,
                    maxAttempts
                };
                break;
            }

            const isRetry = attempts > 0;
            const contextQueryResult = await this._resolveKnowledgeContextQuery(userMessage, chatHistory);
            const activeProduct = String(contextQueryResult.activeProduct || '').trim();
            const knowledgeQuery = activeProduct || contextQueryResult.query;
            const hasProductMatch = (await knowledgeLoader.findProductsByQuery(knowledgeQuery, 1)).length > 0;
            const commercialFlow = await this._inferCommercialFlowState(userMessage, chatHistory, activeProduct);
            requestDebug.commercialFlow = commercialFlow;
            requestDebug.activeProduct = activeProduct || null;

            const historyWindow = this._getAttemptWindow(attempts);
            const scopedProducts = activeProduct ? 1 : (isRetry ? 1 : 3);
            const scopedHistory = this._buildWindowedHistory(chatHistory, historyWindow);
            const scopedHistoryMessages = await scopedHistory.getMessages();
            const scopedHistoryCount = scopedHistoryMessages.length;
            const scopedHistoryChars = this._estimateMessageChars(scopedHistoryMessages);

            let knowledge = await this._buildScopedKnowledge(knowledgeQuery, scopedProducts, {
                includeContact: !hasProductMatch
            });
            
            // Siempre inyectar el catálogo ligero general
            const superCatalog = await this._buildFallbackKnowledgeSummary();
            knowledge = superCatalog + "\n\n" + (knowledge ? `INFO DETALLADA DEL PRODUCTO ESPECÍFICO CONSULTADO:\n${knowledge}` : "");

            const maxCharsThisAttempt = this.maxKnowledgePromptChars > 0
                ? (isRetry ? Math.min(this.maxKnowledgePromptChars, this.retryKnowledgePromptChars) : this.maxKnowledgePromptChars)
                : (isRetry ? this.retryKnowledgePromptChars : this.initialKnowledgePromptChars);

            if (maxCharsThisAttempt > 0 && knowledge.length > maxCharsThisAttempt) {
                knowledge = `${knowledge.slice(0, maxCharsThisAttempt)}\n\n[Contexto resumido automáticamente por rendimiento.]`;
                if (!this._warnedKnowledgeTruncation) {
                    logger.warn(`[GEMINI] Prompt de conocimiento recortado para rendimiento: ${maxCharsThisAttempt} caracteres.`);
                    this._warnedKnowledgeTruncation = true;
                }
            }

            const behaviorPrompt = [
                "Eres el asesor comercial oficial de Buho Digital por WhatsApp. Usa un lenguaje corporativo, claro y directo.",
                "Tienes acceso a un 'SUPER CATÁLOGO' general y, a veces, a 'INFO DETALLADA' del producto consultado.",
                "Si el usuario SOLO saluda (ej: 'hola', 'buenos días', 'buenas tardes'), responde ÚNICAMENTE con un saludo cordial y pregúntale en qué le puedes ayudar. NO envíes listas de productos ni el catálogo en un simple saludo.",
                "Si el usuario hace una pregunta general pidiendo opciones (ej: '¿qué vendes?', 'qué servicios ofrecen'), revisa el SUPER CATÁLOGO y ofrécele un resumen útil y categorizado de las opciones.",
                "REGLA CLAVE DE INFORMACIÓN COMPLETA: Cuando el usuario pregunta por un producto específico, SIEMPRE entrega la información COMPLETA de todos los planes disponibles. Para CADA plan, lista TODOS los ciclos de facturación (1 mes, 3 meses, 6 meses, 12 meses, etc.) con su precio real, descuento si aplica y precio original tachado. Organiza la información de forma clara con viñetas. NO omitas planes ni ciclos.",
                "FORMATO DE PLANES: Usa este formato para cada producto:\n*[Nombre del Plan]*\n- 1 Mes: precio\n- 3 Meses: precio (X% desc)\n- 6 Meses: precio (antes precio_original, X% desc)\n- 12 Meses: precio (antes precio_original, X% desc)\nIncluye: [resumen breve de lo que incluye en 1 línea]",
                "BREVEDAD SITUACIONAL: Sé conciso en saludos y respuestas generales (2-3 líneas). Pero cuando el usuario pide info de un producto, extiéndete lo necesario para mostrar TODOS los planes y ciclos completos. La información comercial completa es PRIORITARIA sobre la brevedad.",
                "Los usuarios a menudo se refieren a los 'ciclos de facturación' como 'planes'. Si preguntan 'qué planes hay', muestra todos los ciclos con precios.",
                "REGLA DE CONTENIDO: No describas todas las características o 'incluye' detallado de cada plan a menos que el usuario lo pida. Enfócate en: nombre del plan, ciclos, precios y un resumen breve de diferencias entre planes.",
                "Si el usuario no quiere continuar, cierra con respeto y sin insistencia comercial.",
                "REGLA DE PRECIOS OBLIGATORIA: cuando exista 'precio' y 'precio_original', el monto real a pagar SIEMPRE es 'precio'. El 'precio_original' es referencial (precio sin descuento)."
            ].join(' ');

            // Inyectar contexto de producto activo para coherencia en follow-ups
            let stickyContext = '';
            if (activeProduct) {
                stickyContext = `\n\nPRODUCTO ACTIVO EN ESTA CONVERSACIÓN: ${activeProduct}. El usuario está consultando sobre este producto. Mantén el foco en él salvo que cambie de tema explícitamente.`;
            }

            // Inyectar directriz de flujo comercial para guiar la respuesta
            let flowDirective = '';
            if (commercialFlow && commercialFlow.stage !== 'DISCOVERY') {
                const flowMap = {
                    'PRODUCT_INTEREST': 'Muestra TODOS los planes del producto con sus ciclos y precios completos.',
                    'PLAN_SELECTION': 'El usuario está eligiendo plan. Confirma su elección y avanza hacia el pago.',
                    'PAYMENT_METHOD': 'El usuario quiere pagar. Proporciona los datos de pago correspondientes.',
                    'PAYMENT_PROOF': 'El usuario reporta que pagó. Indícale cómo enviar su comprobante.',
                    'CLOSING': 'El usuario quiere cerrar la conversación. Despídete cordialmente sin insistir.'
                };
                const directive = flowMap[commercialFlow.stage] || '';
                if (directive) {
                    flowDirective = `\n\nCONTEXTO DE FLUJO: Etapa actual = ${commercialFlow.stage}. Directriz: ${directive}`;
                }
            }

            const systemText = this._escapePromptBraces(
                `${knowledge}${userNamePrompt}${stickyContext}${flowDirective}\n\n${behaviorPrompt}`
            );

            const prompt = ChatPromptTemplate.fromMessages([
                ["system", systemText],
                new MessagesPlaceholder("history"),
                ["human", "{input}"]
            ]);

            const keyData = this._getNextAvailableKey();
            
            if (!keyData) {
                logger.warn('[GEMINI] Todas las keys están desactivadas por el Circuit Breaker.');
                this._recordCutoff('NO_AVAILABLE_KEYS', this._withFailureDiagnostics({
                    attempts,
                    maxAttempts,
                    phone: userPhone || null
                }, attemptFailures));
                requestDebug.status = 'FAILED';
                requestDebug.finishedAt = Date.now();
                requestDebug.final = {
                    reason: 'NO_AVAILABLE_KEYS',
                    attempts,
                    maxAttempts
                };
                const fallback = 'Estoy con alta demanda y no pude responder bien en este intento. ¿Lo intentamos de nuevo?';
                await this._appendFallbackToHistory(chatHistory, userMessage, fallback);
                return fallback;
            }

            const configuredTimeout = Math.max(runtimeConfig.timeout || 0, 20000);
            const firstTurnBoostMs = (isFirstTurn && !isRetry) ? 5000 : 0;
            const retryTimeoutCeiling = isRetry
                ? Math.min(Math.max(configuredTimeout + 6000, 24000), 32000)
                : Math.min(Math.max(configuredTimeout + firstTurnBoostMs, 20000), 26000);
            const attemptTimeout = Math.max(6000, Math.min(retryTimeoutCeiling, Math.max(5000, remainingBudgetMs - 800)));
            const attemptIndex = attempts + 1;
            const attemptDebug = {
                attempt: attemptIndex,
                isRetry,
                keyIndex: keyData.index + 1,
                keyLabel: keyData.label,
                timeoutMs: attemptTimeout,
                remainingBudgetMs,
                scopedProducts,
                historyWindow,
                historyMessages: scopedHistoryCount,
                historyChars: scopedHistoryChars,
                knowledgeChars: knowledge.length,
                systemPromptChars: systemText.length,
                context: {
                    resolutionMode: contextQueryResult?.resolutionMode || 'UNKNOWN',
                    inferredFromHistory: Boolean(contextQueryResult?.inferredFromHistory),
                    activeProduct: activeProduct || null,
                    knowledgeQuery,
                    trace: contextQueryResult?.trace || {}
                },
                startedAt: Date.now(),
                finishedAt: null,
                status: 'IN_PROGRESS',
                errorCode: null,
                errorMessage: null
            };
            requestDebug.attempts.push(attemptDebug);

            try {
                const startTime = Date.now();
                keyData.totalCalls++;
                keyData.lastUsedAt = Date.now();
                metrics.increment('geminiCalls');
                this._persistKeyCall(keyData);
                logger.debug(`[GEMINI] Procesando con key #${keyData.index + 1}/${this.keys.length}`);

                // Crear cadena con el modelo de esta iteración
                const attemptRuntimeConfig = {
                    ...runtimeConfig,
                    generation: {
                        ...runtimeConfig.generation,
                        maxOutputTokens: isRetry
                            ? Math.max(700, Math.min(runtimeConfig.generation.maxOutputTokens, 1800))
                            : runtimeConfig.generation.maxOutputTokens
                    }
                };
                const model = this._buildModel(keyData, attemptRuntimeConfig);
                const chain = prompt.pipe(model);

                // Ejecutar con timeout pasando historial explícito para evitar pérdida de contexto.
                const response = await this._generateWithTimeout(
                    chain,
                    {
                        input: userMessage,
                        history: scopedHistoryMessages
                    },
                    attemptTimeout
                );
                
                // Éxito: resetear fallos del circuit breaker
                keyData.failures = 0;
                keyData.lastError = null;
                keyData.lastErrorAt = 0;

                const latency = Date.now() - startTime;
                metrics.recordLatency(latency);

                // Track token usage
                const usageMeta = response.usage_metadata
                    || response.response_metadata?.tokenUsage
                    || response.response_metadata?.usage
                    || null;
                let tokenEntry;
                if (usageMeta) {
                    tokenEntry = {
                        timestamp: Date.now(),
                        inputTokens: usageMeta.input_tokens || usageMeta.promptTokenCount || usageMeta.promptTokens || 0,
                        outputTokens: usageMeta.output_tokens || usageMeta.candidatesTokenCount || usageMeta.completionTokens || 0,
                        totalTokens: usageMeta.total_tokens || usageMeta.totalTokenCount || usageMeta.totalTokens || 0
                    };
                    logger.info(`[GEMINI] Tokens: in=${tokenEntry.inputTokens} out=${tokenEntry.outputTokens} total=${tokenEntry.totalTokens}`);
                } else {
                    const estInput = Math.ceil(String(userMessage || '').length / 4);
                    const estOutput = Math.ceil(String(response.content || '').length / 4);
                    tokenEntry = {
                        timestamp: Date.now(),
                        inputTokens: estInput,
                        outputTokens: estOutput,
                        totalTokens: estInput + estOutput
                    };
                    logger.info(`[GEMINI] Tokens (estimado): in≈${estInput} out≈${estOutput}`);
                }
                this.tokenHistory.push(tokenEntry);
                if (this.tokenHistory.length > this.maxTokenHistory) {
                    this.tokenHistory.shift();
                }
                // Persist tokens to MySQL
                this._persistTokenUsage(keyData.index, userPhone, tokenEntry, latency);

                logger.info(`[GEMINI] ✓ Respuesta generada con key #${keyData.index + 1} en ${latency}ms`);

                attemptDebug.finishedAt = Date.now();
                attemptDebug.status = 'SUCCESS';
                attemptDebug.latencyMs = latency;

                const finalReply = this._finalizeReplyQuality(response.content);
                const hardTruncated = this._looksTruncatedReply(finalReply);
                const shouldAttemptContinuation = hardTruncated || this._needsContinuationGuard(finalReply);

                if (shouldAttemptContinuation) {
                    logger.warn('[GEMINI] Respuesta parcial detectada. Intentando continuación automática...');
                    const continuationTimeoutMs = Math.max(5000, Math.min(12000, attemptTimeout - 1200));
                    const recoveredReply = await this._continueTruncatedReply(
                        chain,
                        scopedHistoryMessages,
                        finalReply,
                        continuationTimeoutMs
                    );

                    if (hardTruncated && this._looksTruncatedReply(recoveredReply)) {
                        throw new GeminiAPIError('Model output appears truncated/incomplete');
                    }

                    const safeRecoveredReply = this._ensureTerminalClosure(recoveredReply);

                    attemptDebug.recoveredFromTruncation = true;
                    attemptDebug.finalReplyChars = String(safeRecoveredReply || '').length;

                    // Persistencia explícita de memoria conversacional para el siguiente turno.
                    if (chatHistory && typeof chatHistory.addMessage === 'function') {
                        await chatHistory.addMessage(new HumanMessage(String(userMessage || '')));
                        await chatHistory.addMessage(new AIMessage(String(safeRecoveredReply || '')));
                    }

                    requestDebug.status = 'SUCCESS';
                    requestDebug.finishedAt = Date.now();
                    requestDebug.final = {
                        reason: 'SUCCESS_RECOVERED_TRUNCATION',
                        attempt: attemptIndex,
                        keyIndex: keyData.index + 1,
                        latencyMs: Date.now() - startTime,
                        finalReplyChars: String(safeRecoveredReply || '').length
                    };

                    return safeRecoveredReply;
                }

                const safeFinalReply = this._ensureTerminalClosure(finalReply);

                // Persistencia explícita de memoria conversacional para el siguiente turno.
                if (chatHistory && typeof chatHistory.addMessage === 'function') {
                    await chatHistory.addMessage(new HumanMessage(String(userMessage || '')));
                    await chatHistory.addMessage(new AIMessage(String(safeFinalReply || '')));
                }

                requestDebug.status = 'SUCCESS';
                requestDebug.finishedAt = Date.now();
                requestDebug.final = {
                    reason: 'SUCCESS',
                    attempt: attemptIndex,
                    keyIndex: keyData.index + 1,
                    latencyMs: latency,
                    finalReplyChars: String(safeFinalReply || '').length
                };

                return safeFinalReply;

            } catch (error) {
                const errorInfo = this._classifyError(error);
                const isTimeoutError = errorInfo.code === 'TIMEOUT';

                keyData.totalErrors++;
                if (!isTimeoutError) {
                    keyData.failures++;
                }
                keyData.lastError = errorInfo.technicalMessage;
                keyData.lastErrorAt = Date.now();
                metrics.increment('geminiErrors');
                this._persistError(errorInfo, keyData, userPhone);
                this._persistKeyError(keyData, errorInfo.technicalMessage);
                metrics.recordError('gemini', keyData.lastError, {
                    keyIndex: keyData.index + 1,
                    keyLabel: keyData.label,
                    errorCode: errorInfo.code,
                    probableCause: errorInfo.probableCause,
                    phone: userPhone || null
                });

                attemptFailures.push({
                    attempt: attemptIndex,
                    keyIndex: keyData.index + 1,
                    keyLabel: keyData.label,
                    errorCode: errorInfo.code,
                    probableCause: errorInfo.probableCause,
                    technicalMessage: String(errorInfo.technicalMessage || '').slice(0, 320),
                    attemptTimeoutMs: attemptTimeout,
                    knowledgeChars: knowledge.length,
                    historyMessages: scopedHistoryCount,
                    historyChars: scopedHistoryChars,
                    userMessageChars: String(userMessage || '').length,
                    timestamp: Date.now()
                });

                attemptDebug.finishedAt = Date.now();
                attemptDebug.status = 'ERROR';
                attemptDebug.errorCode = errorInfo.code;
                attemptDebug.errorMessage = String(errorInfo.technicalMessage || '').slice(0, 320);

                logger.warn(`[GEMINI] Error con key #${keyData.index + 1} (fallo ${keyData.failures}/${runtimeConfig.circuitBreaker.failureThreshold}): ${errorInfo.code} - ${errorInfo.technicalMessage}`);

                // Circuit breaker: desactivar key si supera el umbral
                if (!isTimeoutError && keyData.failures >= runtimeConfig.circuitBreaker.failureThreshold) {
                    keyData.disabledUntil = Date.now() + runtimeConfig.circuitBreaker.recoveryTimeMs;
                    logger.warn(`[GEMINI] ⚡ Circuit breaker activado para key #${keyData.index + 1}. Reactivación en ${runtimeConfig.circuitBreaker.recoveryTimeMs / 1000}s`);
                    metrics.increment('geminiKeyRotations');
                }

                // Rotar al siguiente
                this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
                attempts++;
            }
        }

        logger.error('[GEMINI] No se pudo completar la respuesta dentro del presupuesto de tiempo.');
        this._recordCutoff('RESPONSE_TRUNCATED_TIMEOUT', this._withFailureDiagnostics({
            attempts,
            maxAttempts,
            totalTimeoutMs: requestTimeoutBudgetMs,
            phone: userPhone || null
        }, attemptFailures));
        requestDebug.status = 'FAILED';
        requestDebug.finishedAt = Date.now();
        requestDebug.final = {
            reason: 'RESPONSE_TRUNCATED_TIMEOUT',
            attempts,
            maxAttempts
        };
        const fallback = 'Se cortó mi respuesta. Escríbeme de nuevo y te respondo enseguida.';
        await this._appendFallbackToHistory(chatHistory, userMessage, fallback);
        return fallback;
    }

    /**
     * Obtiene la siguiente key disponible (no desactivada por circuit breaker)
     */
    _getNextAvailableKey() {
        const now = Date.now();

        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentKeyIndex + i) % this.keys.length;
            const keyData = this.keys[idx];

            if (keyData.disabledUntil < now) {
                // Key disponible
                this.currentKeyIndex = idx;
                return keyData;
            }
        }

        return null; // Todas desactivadas
    }

    /**
     * Envoltura de promesa con Timeout puro para abortar el request a LangChain
     */
    async _generateWithTimeout(chain, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new GeminiAPIError('Timeout - El modelo tardó demasiado en responder'));
            }, timeoutMs);

            chain.invoke(payload)
            .then(result => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    _persistTokenUsage(keyIndex, userPhone, tokenEntry, latencyMs) {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;
            mysqlService.execute(
                `INSERT INTO gemini_token_usage (key_slot, user_phone, input_tokens, output_tokens, total_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`,
                [keyIndex + 1, userPhone || null, tokenEntry.inputTokens, tokenEntry.outputTokens, tokenEntry.totalTokens, latencyMs || 0]
            ).catch(err => logger.error(`[GEMINI] Error persistiendo tokens: ${err.message}`));
        } catch (e) { /* silencioso */ }
    }

    _persistError(errorInfo, keyData, userPhone) {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;
            mysqlService.execute(
                `INSERT INTO system_events (level, component, event_code, user_phone, message, context_json) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    'error',
                    'gemini',
                    errorInfo.code || 'UNKNOWN',
                    userPhone || null,
                    String(errorInfo.technicalMessage || errorInfo.probableCause || 'Error desconocido').slice(0, 500),
                    JSON.stringify({ keyIndex: keyData.index + 1, keyLabel: keyData.label, probableCause: errorInfo.probableCause })
                ]
            ).catch(err => logger.error(`[GEMINI] Error persistiendo evento: ${err.message}`));
        } catch (e) { /* silencioso */ }
    }

    _getCurrentMonthYear() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    _persistKeyCall(keyData) {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;
            const monthYear = this._getCurrentMonthYear();
            mysqlService.execute(
                `INSERT INTO gemini_key_stats (key_slot, key_label, total_calls, total_errors, month_year)
                 VALUES (?, ?, 1, 0, ?)
                 ON DUPLICATE KEY UPDATE total_calls = total_calls + 1, updated_at = NOW()`,
                [keyData.index + 1, keyData.label, monthYear]
            ).catch(err => logger.error(`[GEMINI] Error persistiendo key call: ${err.message}`));
        } catch (e) { /* silencioso */ }
    }

    _persistKeyError(keyData, errorMessage) {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;
            const monthYear = this._getCurrentMonthYear();
            mysqlService.execute(
                `INSERT INTO gemini_key_stats (key_slot, key_label, total_calls, total_errors, last_error, last_error_at, month_year)
                 VALUES (?, ?, 0, 1, ?, NOW(), ?)
                 ON DUPLICATE KEY UPDATE total_errors = total_errors + 1, last_error = VALUES(last_error), last_error_at = NOW(), updated_at = NOW()`,
                [keyData.index + 1, keyData.label, String(errorMessage || '').slice(0, 500), monthYear]
            ).catch(err => logger.error(`[GEMINI] Error persistiendo key error: ${err.message}`));
        } catch (e) { /* silencioso */ }
    }

    async hydrateKeyStatsFromDB() {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;
            const monthYear = this._getCurrentMonthYear();
            const rows = await mysqlService.query(
                `SELECT key_slot, total_calls, total_errors, last_error, last_error_at FROM gemini_key_stats WHERE month_year = ?`,
                [monthYear]
            );
            for (const row of rows) {
                const keyData = this.keys.find(k => k.index === (row.key_slot - 1));
                if (keyData) {
                    keyData.totalCalls = parseInt(row.total_calls) || 0;
                    keyData.totalErrors = parseInt(row.total_errors) || 0;
                    if (row.last_error) keyData.lastError = row.last_error;
                    if (row.last_error_at) keyData.lastErrorAt = new Date(row.last_error_at).getTime();
                }
            }
            logger.info(`[GEMINI] Key stats hidratados desde MySQL (${monthYear}): ${rows.length} registros.`);
        } catch (err) {
            logger.warn(`[GEMINI] No se pudieron hidratar key stats: ${err.message}`);
        }
    }

    getStats() {
        const now = Date.now();
        return {
            totalKeys: this.keys.length,
            activeKeys: this.keys.filter(k => k.disabledUntil < now).length,
            lastCutoff: this.lastCutoff,
            lastRequestDebug: this.lastRequestDebug,
            tokenHistory: this.tokenHistory.slice(-30),
            keys: this.keys.map(k => ({
                index: k.index + 1,
                label: k.label,
                fullKey: k.apiKey,
                active: k.disabledUntil < now,
                totalCalls: k.totalCalls,
                totalErrors: k.totalErrors,
                failures: k.failures,
                failureThreshold: this.defaultCircuitBreakerConfig?.failureThreshold || 3,
                lastError: k.lastError,
                lastErrorAt: k.lastErrorAt || null,
                lastUsedAt: k.lastUsedAt || null,
                disabledUntil: k.disabledUntil || null
            }))
        };
    }
}

module.exports = new GeminiService();
