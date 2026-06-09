/**
 * insight_classifier_service.js — Automatic conversation insight classifier
 * Uses Gemini AI for intelligent classification with regex fallback.
 * Runs post-response (async, fire-and-forget) to classify each interaction
 * without adding latency to the user experience.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const logger = require('../utils/logger');

const VALID_INTENTS = ['greeting','question','purchase_interest','complaint','support','farewell','info_request','price_inquiry','other'];
const VALID_SENTIMENTS = ['positive','neutral','negative'];
const VALID_OUTCOMES = ['purchased','just_asked','problem_reported','unresolved','redirected','ongoing','resolved'];

class InsightClassifierService {
    constructor() {
        this._initialized = false;
        this._classifyKeyIndex = 0; // Rotates through available keys
    }

    // =============================================
    // AI CLASSIFICATION — Primary method
    // =============================================
    async _classifyWithAI(userMessage, responseText, commercialStage, activeProduct) {
        const apiKeys = config.gemini?.apiKeys || [];
        if (apiKeys.length === 0) return null;

        const knownProducts = 'Pro 8, Pro 7, ProX, Factura Fácil, Fastura, Fastura Colombia, Hosting, VPS, Correos Corporativos, Zoho Mail, BuhoChat, Certificados DIAN, Certificado SUNAT, VendeYa, App31, QR Buho, Mozo, Waya Empresa, Waya Reseller, Validación';

        const prompt = `Eres un clasificador de mensajes para un chatbot comercial de WhatsApp. Tu trabajo es clasificar CADA mensaje del usuario en las categorías correctas.

MENSAJE DEL USUARIO: "${String(userMessage || '').substring(0, 500)}"
RESPUESTA DEL BOT: "${String(responseText || '').substring(0, 300)}"
ETAPA COMERCIAL: ${commercialStage || 'DISCOVERY'}
PRODUCTO ACTIVO: ${activeProduct || 'ninguno'}

Responde SOLO con un JSON válido (sin markdown, sin backticks, sin texto extra):
{"intent":"...","sentiment":"...","outcome":"...","topic_summary":"...","product_consulted":null,"confidence":0.9}

INTENT — clasifica la INTENCIÓN del mensaje del usuario:
- "greeting" → saludos: hola, hi, hello, hey, buenas, buenos días, buenas tardes, buenas noches, qué tal, saludos, ey, ola, wena
- "farewell" → despedidas: adiós, chao, chau, bye, hasta luego, nos vemos, gracias por todo, eso sería todo, ok gracias, muchas gracias (cuando es cierre de conversación)
- "purchase_interest" → quiere comprar: comprar, adquirir, lo quiero, me quedo con, contratar, activar, tomar el plan, me interesa comprar, vamos con
- "price_inquiry" → pregunta precios: cuánto cuesta, precio, costo, tarifa, valor, cuánto sale, cuánto vale, precios
- "complaint" → queja/reclamo: no funciona, problema, error, falla, pésimo, malo, reclamo, no sirve, estafa, llevo días sin
- "support" → pide ayuda técnica: ayuda, no puedo, cómo hago, cómo configuro, necesito asistencia, soporte, no puedo ingresar
- "info_request" → pide información sobre productos/servicios: qué es, qué ofrece, qué incluye, información, detalles, catálogo, productos, servicios, qué tienen, cuáles son
- "question" → pregunta general que no encaja en las anteriores categorías
- "other" → mensajes sin sentido claro, emojis solos, risas (jajaja), letras random (aaaaa), confirmaciones mínimas (ok, sí, dale), o cualquier cosa que NO sea una intención real

SENTIMENT:
- "positive" → agradecimiento, satisfacción, entusiasmo, interés de compra: gracias, genial, perfecto, excelente, me encanta, quiero comprar, me interesa
- "negative" → frustración, molestia, queja: problema, horrible, no sirve, estafa, molesto, pésimo
- "neutral" → sin emoción clara, saludos simples, preguntas informativas, mensajes cortos

OUTCOME:
- "purchased" → confirmó compra o envió comprobante de pago
- "resolved" → el bot resolvió su duda/problema satisfactoriamente
- "just_asked" → pidió información específica sin intención de comprar aún
- "problem_reported" → reportó un problema técnico o queja formal
- "unresolved" → el bot no pudo resolver su problema
- "redirected" → se redirigió a otro canal (humano, WhatsApp, web)
- "ongoing" → conversación en curso sin resolución clara aún (saludos, mensajes cortos, confirmaciones)

TOPIC_SUMMARY — Un resumen corto y GENÉRICO (máximo 5 palabras). PROHIBIDO copiar el mensaje del usuario:
- Saludos → "Saludo inicial"
- Despedidas → "Cierre de conversación"
- Precios de producto → "Consulta precio [producto]"
- Info sobre producto específico → "Consulta sobre [producto]"
- Info catálogo/productos en general → "Consulta catálogo de productos"
- Quejas → "Problema con [tema corto]"
- Soporte técnico → "Soporte técnico"
- Mensajes basura → "Mensaje no clasificable"
- Confirmaciones (ok, sí, dale) → "Confirmación"
- REGLA ABSOLUTA: topic_summary NO puede contener palabras del mensaje original reorganizadas. Debe ser una ETIQUETA descriptiva genérica.

PRODUCT_CONSULTED — Solo si el usuario menciona explícitamente uno de estos productos:
${knownProducts}
Si no menciona ningún producto específico, pon null.

EJEMPLOS:
- "hola" → {"intent":"greeting","sentiment":"neutral","outcome":"ongoing","topic_summary":"Saludo inicial","product_consulted":null,"confidence":0.95}
- "qué productos tiene" → {"intent":"info_request","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta catálogo de productos","product_consulted":null,"confidence":0.9}
- "cuánto cuesta el Pro 8" → {"intent":"price_inquiry","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta precio Pro 8","product_consulted":"Pro 8","confidence":0.95}
- "no me sirve esta porquería" → {"intent":"complaint","sentiment":"negative","outcome":"problem_reported","topic_summary":"Queja por mal funcionamiento","product_consulted":null,"confidence":0.9}
- "quiero comprarlo" → {"intent":"purchase_interest","sentiment":"positive","outcome":"ongoing","topic_summary":"Interés de compra","product_consulted":null,"confidence":0.9}
- "gracias, eso era todo" → {"intent":"farewell","sentiment":"positive","outcome":"resolved","topic_summary":"Cierre de conversación","product_consulted":null,"confidence":0.95}
- "aaaaa" → {"intent":"other","sentiment":"neutral","outcome":"ongoing","topic_summary":"Mensaje no clasificable","product_consulted":null,"confidence":0.8}
- "jajaja" → {"intent":"other","sentiment":"positive","outcome":"ongoing","topic_summary":"Mensaje no clasificable","product_consulted":null,"confidence":0.8}
- "ok" → {"intent":"other","sentiment":"neutral","outcome":"ongoing","topic_summary":"Confirmación","product_consulted":null,"confidence":0.8}
- "el pro8 que tal es" → {"intent":"info_request","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta sobre Pro 8","product_consulted":"Pro 8","confidence":0.9}
- "y el hosting sirve?" → {"intent":"info_request","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta sobre Hosting","product_consulted":"Hosting","confidence":0.9}
- "en tus productos en que mas" → {"intent":"info_request","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta catálogo de productos","product_consulted":null,"confidence":0.85}
- "que mas ofrecen" → {"intent":"info_request","sentiment":"neutral","outcome":"just_asked","topic_summary":"Consulta catálogo de productos","product_consulted":null,"confidence":0.85}

REGLAS:
1. "hola", "hi", "hey", "buenas" SIEMPRE son "greeting", NUNCA "other"
2. "ok gracias", "muchas gracias", "gracias eso es todo" son "farewell" (cierre), no "greeting"
3. Mensajes sin sentido (aaaaa, jjj, emojis solos) SIEMPRE son "other"
4. topic_summary PROHIBIDO copiar el mensaje del usuario. Usa SOLO estas etiquetas: "Saludo inicial", "Cierre de conversación", "Consulta catálogo de productos", "Consulta sobre [producto]", "Consulta precio [producto]", "Interés de compra", "Problema con [tema]", "Soporte técnico", "Mensaje no clasificable", "Confirmación"
5. Solo pon un product_consulted si el usuario menciona EXPLÍCITAMENTE un producto de la lista
6. Prioriza la categoría más ESPECÍFICA sobre la genérica
7. Si el mensaje menciona un PRODUCTO (de la lista), NUNCA puede ser "other" — clasifícalo como "info_request", "price_inquiry" o "purchase_interest" según el contexto
8. Preguntas informales como "qué tal es", "cómo es", "es bueno", "sirve", "funciona", "qué onda con" sobre un producto = "info_request"`;

        // Try up to 3 different keys (rotating) to handle rate limiting
        const maxRetries = Math.min(3, apiKeys.length);
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const keyIndex = this._classifyKeyIndex % apiKeys.length;
            this._classifyKeyIndex = (this._classifyKeyIndex + 1) % apiKeys.length;
            const classifyKey = apiKeys[keyIndex];

            try {
                const genAI = new GoogleGenerativeAI(classifyKey);
                const model = genAI.getGenerativeModel({
                    model: config.gemini.model || 'gemini-2.5-flash',
                    generationConfig: { temperature: 0.1, maxOutputTokens: 1024, topP: 0.8 }
                });

                const result = await Promise.race([
                    model.generateContent([{ text: prompt }]),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('AI classify timeout')), 12000))
                ]);

                const raw = String(result?.response?.text?.() || '').trim();
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    logger.debug(`[INSIGHT] No JSON from key #${keyIndex + 1}, trying next...`);
                    continue;
                }

                const parsed = JSON.parse(jsonMatch[0]);

                // Validate and sanitize
                const intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : null;
                const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : null;
                const outcome = VALID_OUTCOMES.includes(parsed.outcome) ? parsed.outcome : null;
                const topicSummary = parsed.topic_summary ? String(parsed.topic_summary).substring(0, 255) : null;
                
                // Fix parsing for product, allowing actual values but ignoring nulls and literal "null"
                let product = null;
                if (parsed.product_consulted && String(parsed.product_consulted).toLowerCase() !== 'null' && String(parsed.product_consulted).trim() !== '') {
                    product = String(parsed.product_consulted).substring(0, 120);
                }

                const confidence = (typeof parsed.confidence === 'number' && parsed.confidence >= 0.5 && parsed.confidence <= 1.0)
                    ? parsed.confidence : 0.75;

                if (!intent || !sentiment || !outcome) {
                    logger.warn(`[INSIGHT] Invalid JSON structure from AI key #${keyIndex + 1}: ${raw}`);
                    continue;
                }

                logger.debug(`[INSIGHT] AI classified with key #${keyIndex + 1}`);
                return { intent, sentiment, outcome, topicSummary, product, confidence };
            } catch (err) {
                const isRateLimit = /429|resource.*(exhausted|has been)|rate.?limit|quota/i.test(err.message || '');
                const isSuspended = /403|suspended|forbidden|permission denied/i.test(err.message || '');
                if (isRateLimit || isSuspended) {
                    logger.debug(`[INSIGHT] Key #${keyIndex + 1} ${isRateLimit ? 'rate-limited' : 'suspended'}, trying next...`);
                    continue;
                }
                logger.debug(`[INSIGHT] AI classification failed on key #${keyIndex + 1}: ${err.message}`);
                continue;
            }
        }
        
        logger.debug('[INSIGHT] All classification keys exhausted, using regex fallback');
        return null;
    }

    // =============================================
    // REGEX FALLBACK — Used when AI is unavailable
    // =============================================

    _detectProductRegex(userMessage) {
        const msg = String(userMessage || '').trim().toLowerCase();
        const products = [
            { pattern: /\bpro\s*8\b/i, name: 'Pro 8' },
            { pattern: /\bpro\s*7\b/i, name: 'Pro 7' },
            { pattern: /\bprox\b/i, name: 'ProX' },
            { pattern: /\bfastura\b/i, name: 'Fastura' },
            { pattern: /\bfactura\s*f[aá]cil\b/i, name: 'Factura Fácil' },
            { pattern: /\bhosting\b/i, name: 'Hosting' },
            { pattern: /\bvps\b/i, name: 'VPS' },
            { pattern: /\bcorreos?\s*(corporativ|empresarial)/i, name: 'Correos Corporativos' },
            { pattern: /\bzoho\s*mail\b/i, name: 'Zoho Mail' },
            { pattern: /\bbuho\s*chat\b/i, name: 'BuhoChat' },
            { pattern: /\bbuhochat\b/i, name: 'BuhoChat' },
            { pattern: /\bcertificad[oa]s?\s*dian\b/i, name: 'Certificados DIAN' },
            { pattern: /\bcertificad[oa]s?\s*sunat\b/i, name: 'Certificado SUNAT' },
            { pattern: /\bvendeya\b/i, name: 'VendeYa' },
            { pattern: /\bvende\s*ya\b/i, name: 'VendeYa' },
            { pattern: /\bapp\s*31\b/i, name: 'App31' },
            { pattern: /\bapp31\b/i, name: 'App31' },
            { pattern: /\bqr\s*buho\b/i, name: 'QR Buho' },
            { pattern: /\bmozo\b/i, name: 'Mozo' },
            { pattern: /\bwaya\b/i, name: 'Waya Empresa' },
            { pattern: /\bvalidaci[oó]n\b/i, name: 'Validación' },
        ];
        for (const p of products) {
            if (p.pattern.test(msg)) return p.name;
        }
        return null;
    }

    _classifyIntentRegex(userMessage) {
        const msg = String(userMessage || '').trim().toLowerCase();
        if (/^(hola|buenas?\s*(d[ií]as?|tardes?|noches?)?|buenos?\s*(d[ií]as?|tardes?|noches?)|hey|saludos|qu[eé]\s*tal|hi|hello)\b/.test(msg) && msg.length < 40) return { intent: 'greeting', confidence: 0.90 };
        if (/\b(adi[oó]s|hasta\s*luego|chao|chau|bye|nos\s*vemos|gracias\s*por\s*todo|eso\s*(ser[ií]a|es)\s*todo|ok\s*gracias|muchas\s*gracias)\b/.test(msg)) return { intent: 'farewell', confidence: 0.85 };
        if (/\b(comprar|adquirir|quiero\s*el|me\s*quedo\s*con|lo\s*quiero|activar|contratar|tomar\s*el|vamos\s*con|me\s*interesa\s*comprar|vendeme|v[eé]ndeme)\b/.test(msg)) return { intent: 'purchase_interest', confidence: 0.85 };
        if (/\b(precio|precios|cu[aá]nto\s*(cuesta|vale|est[aá]|sale)|costo|costos|tarifa|valor|mensual|trimestral|semestral|anual)\b/.test(msg)) return { intent: 'price_inquiry', confidence: 0.80 };
        if (/\b(problema|no\s*funciona|error|falla|malo|p[eé]simo|queja|reclamo|insatisf|molest|no\s*sirve|lento|ca[ií]do|no\s*responde|deficiente)\b/.test(msg)) return { intent: 'complaint', confidence: 0.80 };
        if (/\b(ayuda|soporte|asistencia|no\s*puedo|c[oó]mo\s*(hago|puedo|configuro|instalo|activo)|necesito\s*ayuda|tengo\s*(un|una)\s*(duda|problema|consulta))\b/.test(msg)) return { intent: 'support', confidence: 0.75 };
        // If a product is mentioned but no other intent matched, it's an info_request
        if (this._detectProductRegex(msg)) return { intent: 'info_request', confidence: 0.80 };
        if (/\b(informaci[oó]n|info|detalles|caracter[ií]sticas|incluye|qu[eé]\s*(es|ofrece|tiene|incluye|vende)|cu[aá]les?\s*(son|hay)|opciones|cat[aá]logo|servicios|productos|ofrecen|que\s*mas)\b/.test(msg)) return { intent: 'info_request', confidence: 0.75 };
        if (/\?$/.test(msg.trim()) || /^(cu[aá]l|qu[eé]|c[oó]mo|d[oó]nde|cu[aá]ndo|por\s*qu[eé]|para\s*qu[eé]|tienen|hay|existe|es\s*posible)\b/.test(msg)) return { intent: 'question', confidence: 0.70 };
        return { intent: 'other', confidence: 0.40 };
    }

    _classifySentimentRegex(userMessage) {
        const msg = String(userMessage || '').trim().toLowerCase();
        const neg = (msg.match(/\b(problema|error|falla|no\s*funciona|malo|p[eé]simo|queja|molest|frustr|insatisf|no\s*sirve|lento|horrible|terrible|decepcion|enojad|furioso|estafa)\b/) || []).length;
        const pos = (msg.match(/\b(gracias|excelente|genial|perfecto|incre[ií]ble|bueno|bien|encant|feliz|satisf|contento|me\s*gust[aó]|super|estupendo|maravill)\b/) || []).length;
        if (neg > pos) return 'negative';
        if (pos > neg) return 'positive';
        return 'neutral';
    }

    _inferOutcomeRegex(commercialStage, intent, userMessage) {
        const msg = String(userMessage || '').trim().toLowerCase();
        if (commercialStage === 'PAYMENT_PROOF') return 'purchased';
        if (commercialStage === 'PAYMENT_METHOD') return 'ongoing';
        if (commercialStage === 'CLOSING') return 'just_asked';
        if (intent === 'complaint') return 'problem_reported';
        if (intent === 'support' && /\b(no\s*puedo|no\s*funciona|error)\b/.test(msg)) return 'unresolved';
        if (commercialStage === 'PLAN_SELECTION') return 'ongoing';
        if (commercialStage === 'PRODUCT_INTEREST') return 'just_asked';
        return 'ongoing';
    }

    _extractTopicRegex(userMessage, productConsulted, intent) {
        // Use generic labels (same style as AI classification) — NEVER copy the user's message
        if (productConsulted && productConsulted !== 'NINGUNO') {
            const labelMap = {
                'purchase_interest': 'Interés de compra',
                'price_inquiry': 'Consulta precio',
                'complaint': 'Problema con',
                'support': 'Soporte técnico',
                'info_request': 'Consulta sobre',
                'question': 'Consulta sobre'
            };
            const label = labelMap[intent] || 'Consulta sobre';
            return `${label} ${productConsulted}`.substring(0, 255);
        }
        const topicMap = {
            'greeting': 'Saludo inicial',
            'farewell': 'Cierre de conversación',
            'purchase_interest': 'Interés de compra',
            'price_inquiry': 'Consulta de precios',
            'complaint': 'Reporte de problema',
            'support': 'Soporte técnico',
            'info_request': 'Consulta catálogo de productos',
            'question': 'Consulta general',
            'other': 'Mensaje no clasificable'
        };
        return topicMap[intent] || 'Consulta general';
    }

    // =============================================
    // MAIN CLASSIFIER — Called post-response
    // =============================================
    async classifyMessage(userPhone, userMessage, responseText, commercialFlow, activeProduct, userName = '') {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;

            const commercialStage = commercialFlow?.stage || 'DISCOVERY';
            const productFromFlow = (activeProduct && activeProduct !== 'NINGUNO') ? activeProduct : null;
            const preview = String(userMessage || '').substring(0, 255);

            // Try AI classification first
            const aiResult = await this._classifyWithAI(userMessage, responseText, commercialStage, productFromFlow);

            let intent, sentiment, outcome, topicSummary, productConsulted, confidence;

            if (aiResult) {
                intent = aiResult.intent;
                sentiment = aiResult.sentiment;
                outcome = aiResult.outcome;
                topicSummary = aiResult.topicSummary;
                productConsulted = aiResult.product || productFromFlow;
                confidence = aiResult.confidence;
                logger.debug(`[INSIGHT] AI classified ${userPhone}: intent=${intent} outcome=${outcome} sentiment=${sentiment}`);
            } else {
                // Regex fallback
                const intentResult = this._classifyIntentRegex(userMessage);
                intent = intentResult.intent;
                confidence = intentResult.confidence;
                sentiment = this._classifySentimentRegex(userMessage);
                outcome = this._inferOutcomeRegex(commercialStage, intent, userMessage);
                // Detect product from message text if not provided by flow
                productConsulted = productFromFlow || this._detectProductRegex(userMessage);
                topicSummary = this._extractTopicRegex(userMessage, productConsulted, intent);
                logger.debug(`[INSIGHT] Regex fallback ${userPhone}: intent=${intent} outcome=${outcome} sentiment=${sentiment} product=${productConsulted || '-'}`);
            }

            await mysqlService.execute(
                `INSERT INTO conversation_insights 
                    (user_phone, user_name, intent, commercial_stage, product_consulted, outcome, sentiment, topic_summary, user_message_preview, confidence, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    userPhone,
                    userName || null,
                    intent,
                    commercialStage,
                    productConsulted,
                    outcome,
                    sentiment,
                    topicSummary,
                    preview,
                    confidence
                ]
            );

            logger.debug(`[INSIGHT] Classified ${userPhone}: intent=${intent} stage=${commercialStage} sentiment=${sentiment} product=${productConsulted || '-'}`);
        } catch (error) {
            logger.error(`[INSIGHT] Error classifying message for ${userPhone}: ${error.message}`);
        }
    }

    // =============================================
    // SESSION SUMMARIZER — Called periodically or on session close
    // =============================================
    async summarizeRecentSessions() {
        try {
            const mysqlService = require('./mysql_service');
            if (!mysqlService.isConfigured()) return;

            // Find phones with insights not yet summarized (insights newer than last report)
            const phones = await mysqlService.query(
                `SELECT DISTINCT ci.user_phone, ci.user_name
                 FROM conversation_insights ci
                 LEFT JOIN conversation_reports cr ON ci.user_phone = cr.user_phone
                    AND cr.updated_at >= ci.created_at
                 WHERE cr.id IS NULL
                   AND ci.created_at >= NOW() - INTERVAL 24 HOUR
                 LIMIT 50`
            );

            for (const { user_phone, user_name } of phones) {
                await this._summarizePhone(user_phone, user_name);
            }
        } catch (error) {
            logger.error(`[INSIGHT] Error summarizing sessions: ${error.message}`);
        }
    }

    async _summarizePhone(userPhone, userName) {
        try {
            const mysqlService = require('./mysql_service');

            const insights = await mysqlService.query(
                `SELECT intent, commercial_stage, product_consulted, outcome, sentiment, topic_summary
                 FROM conversation_insights
                 WHERE user_phone = ? AND created_at >= NOW() - INTERVAL 24 HOUR
                 ORDER BY created_at ASC`,
                [userPhone]
            );

            if (insights.length === 0) return;

            // Aggregate
            const intents = {};
            const products = new Set();
            const topics = new Set();
            const sentiments = { positive: 0, neutral: 0, negative: 0 };
            let finalStage = 'DISCOVERY';
            let finalOutcome = 'ongoing';

            for (const ins of insights) {
                intents[ins.intent] = (intents[ins.intent] || 0) + 1;
                if (ins.product_consulted) products.add(ins.product_consulted);
                if (ins.topic_summary) topics.add(ins.topic_summary);
                sentiments[ins.sentiment] = (sentiments[ins.sentiment] || 0) + 1;
                finalStage = ins.commercial_stage || finalStage;
                finalOutcome = ins.outcome || finalOutcome;
            }

            const primaryIntent = Object.entries(intents).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
            const overallSentiment = Object.entries(sentiments).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
            const resolved = ['purchased', 'resolved', 'just_asked'].includes(finalOutcome) ? 1 : 0;

            // Upsert report
            const existing = await mysqlService.query(
                `SELECT id FROM conversation_reports WHERE user_phone = ? AND created_at >= NOW() - INTERVAL 24 HOUR LIMIT 1`,
                [userPhone]
            );

            if (existing.length > 0) {
                await mysqlService.execute(
                    `UPDATE conversation_reports SET
                        primary_intent = ?, final_stage = ?, products_consulted = ?, final_outcome = ?,
                        overall_sentiment = ?, topics = ?, message_count = ?, resolved = ?, updated_at = NOW()
                     WHERE id = ?`,
                    [
                        primaryIntent, finalStage, JSON.stringify([...products]),
                        finalOutcome, overallSentiment, JSON.stringify([...topics]),
                        insights.length, resolved, existing[0].id
                    ]
                );
            } else {
                await mysqlService.execute(
                    `INSERT INTO conversation_reports 
                        (user_phone, user_name, primary_intent, final_stage, products_consulted, final_outcome,
                         overall_sentiment, topics, message_count, resolved, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        userPhone, userName || null, primaryIntent, finalStage,
                        JSON.stringify([...products]), finalOutcome, overallSentiment,
                        JSON.stringify([...topics]), insights.length, resolved
                    ]
                );
            }

            logger.debug(`[INSIGHT] Summarized session for ${userPhone}: ${insights.length} insights, intent=${primaryIntent}`);
        } catch (error) {
            logger.error(`[INSIGHT] Error summarizing ${userPhone}: ${error.message}`);
        }
    }
}

module.exports = new InsightClassifierService();
