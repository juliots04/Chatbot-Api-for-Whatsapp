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
    }

    // =============================================
    // AI CLASSIFICATION — Primary method
    // =============================================
    async _classifyWithAI(userMessage, responseText, commercialStage, activeProduct) {
        const apiKeys = config.gemini?.apiKeys || [];
        if (apiKeys.length === 0) return null;

        const prompt = `Eres un clasificador de mensajes para un chatbot comercial de WhatsApp. Tu trabajo es clasificar CADA mensaje del usuario en las categorías correctas.

MENSAJE DEL USUARIO: "${String(userMessage || '').substring(0, 500)}"
RESPUESTA DEL BOT: "${String(responseText || '').substring(0, 300)}"
ETAPA COMERCIAL: ${commercialStage || 'DISCOVERY'}
PRODUCTO ACTIVO: ${activeProduct || 'ninguno'}

Responde SOLO con un JSON válido (sin markdown, sin backticks, sin texto extra):
{"intent":"...","sentiment":"...","outcome":"...","topic_summary":"...","product_consulted":null,"confidence":0.9}

INTENT — clasifica la INTENCIÓN del mensaje del usuario:
- "greeting" → saludos: hola, hi, hello, hey, buenas, buenos días, buenas tardes, buenas noches, qué tal, saludos, ey, ola, wena
- "farewell" → despedidas: adiós, chao, chau, bye, hasta luego, nos vemos, gracias por todo, eso sería todo
- "purchase_interest" → quiere comprar: comprar, adquirir, lo quiero, me quedo con, contratar, activar, tomar el plan
- "price_inquiry" → pregunta precios: cuánto cuesta, precio, costo, tarifa, valor, cuánto sale, cuánto vale
- "complaint" → queja/reclamo: no funciona, problema, error, falla, pésimo, malo, reclamo, no sirve, estafa
- "support" → pide ayuda: ayuda, no puedo, cómo hago, cómo configuro, necesito asistencia, soporte
- "info_request" → pide información: qué es, qué ofrece, qué incluye, información, detalles, catálogo, productos, servicios
- "question" → pregunta general que no encaja arriba
- "other" → SOLO si realmente no encaja en NINGUNA categoría (muy raro, casi nunca uses esto)

SENTIMENT:
- "positive" → agradecimiento, satisfacción, entusiasmo: gracias, genial, perfecto, excelente, me encanta
- "negative" → frustración, molestia, queja: problema, horrible, no sirve, estafa, molesto
- "neutral" → sin emoción clara, saludos simples, preguntas informativas

OUTCOME:
- "purchased" → confirmó compra o envió comprobante
- "resolved" → el bot resolvió su duda/problema satisfactoriamente
- "just_asked" → solo pidió información sin comprar
- "problem_reported" → reportó problema o queja
- "unresolved" → el bot no pudo resolver
- "redirected" → se redirigió a otro canal
- "ongoing" → saludo inicial, conversación en curso, sin resolución aún

EJEMPLOS:
- "hola" → {"intent":"greeting","sentiment":"neutral","outcome":"ongoing","topic_summary":"Saludo","product_consulted":null,"confidence":0.95}
- "hi" → {"intent":"greeting","sentiment":"neutral","outcome":"ongoing","topic_summary":"Saludo","product_consulted":null,"confidence":0.95}
- "buenas tardes" → {"intent":"greeting","sentiment":"neutral","outcome":"ongoing","topic_summary":"Saludo","product_consulted":null,"confidence":0.95}
- "cuánto cuesta el plan básico" → {"intent":"price_inquiry","sentiment":"neutral","outcome":"just_asked","topic_summary":"Precio plan básico","product_consulted":"Plan básico","confidence":0.9}
- "no me sirve esta porquería" → {"intent":"complaint","sentiment":"negative","outcome":"problem_reported","topic_summary":"Queja servicio","product_consulted":null,"confidence":0.9}
- "quiero comprarlo" → {"intent":"purchase_interest","sentiment":"positive","outcome":"ongoing","topic_summary":"Interés de compra","product_consulted":null,"confidence":0.9}
- "gracias, eso era todo" → {"intent":"farewell","sentiment":"positive","outcome":"resolved","topic_summary":"Despedida","product_consulted":null,"confidence":0.9}

IMPORTANTE: Prioriza siempre la categoría más específica. "hola", "hi", "hey", "buenas" SIEMPRE son "greeting", nunca "other".`;

        try {
            const genAI = new GoogleGenerativeAI(apiKeys[0]);
            const model = genAI.getGenerativeModel({
                model: config.gemini.model || 'gemini-2.5-flash',
                generationConfig: { temperature: 0.1, maxOutputTokens: 200, topP: 0.8 }
            });

            const result = await Promise.race([
                model.generateContent([{ text: prompt }]),
                new Promise((_, reject) => setTimeout(() => reject(new Error('AI classify timeout')), 5000))
            ]);

            const raw = String(result?.response?.text?.() || '').trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

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
                logger.warn(`[INSIGHT] Invalid JSON structure from AI: ${raw}`);
                return null;
            }

            return { intent, sentiment, outcome, topicSummary, product, confidence };
        } catch (err) {
            logger.debug(`[INSIGHT] AI classification failed, using fallback: ${err.message}`);
            return null;
        }
    }

    // =============================================
    // REGEX FALLBACK — Used when AI is unavailable
    // =============================================
    _classifyIntentRegex(userMessage) {
        const msg = String(userMessage || '').trim().toLowerCase();
        if (/^(hola|buenos?\s*(d[ií]as?|tardes?|noches?)|hey|saludos|qu[eé]\s*tal|hi|hello)\b/.test(msg) && msg.length < 40) return { intent: 'greeting', confidence: 0.90 };
        if (/\b(adi[oó]s|hasta\s*luego|chao|chau|bye|nos\s*vemos|gracias\s*por\s*todo|eso\s*(ser[ií]a|es)\s*todo)\b/.test(msg)) return { intent: 'farewell', confidence: 0.85 };
        if (/\b(comprar|adquirir|quiero\s*el|me\s*quedo\s*con|lo\s*quiero|activar|contratar|tomar\s*el|vamos\s*con|me\s*interesa\s*comprar)\b/.test(msg)) return { intent: 'purchase_interest', confidence: 0.85 };
        if (/\b(precio|precios|cu[aá]nto\s*(cuesta|vale|est[aá]|sale)|costo|costos|tarifa|valor|mensual|trimestral|semestral|anual)\b/.test(msg)) return { intent: 'price_inquiry', confidence: 0.80 };
        if (/\b(problema|no\s*funciona|error|falla|malo|p[eé]simo|queja|reclamo|insatisf|molest|no\s*sirve|lento|ca[ií]do|no\s*responde|deficiente)\b/.test(msg)) return { intent: 'complaint', confidence: 0.80 };
        if (/\b(ayuda|soporte|asistencia|no\s*puedo|c[oó]mo\s*(hago|puedo|configuro|instalo|activo)|necesito\s*ayuda|tengo\s*(un|una)\s*(duda|problema|consulta))\b/.test(msg)) return { intent: 'support', confidence: 0.75 };
        if (/\b(informaci[oó]n|info|detalles|caracter[ií]sticas|incluye|qu[eé]\s*(es|ofrece|tiene|incluye|vende)|cu[aá]les?\s*(son|hay)|opciones|cat[aá]logo|servicios|productos)\b/.test(msg)) return { intent: 'info_request', confidence: 0.75 };
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
        const msg = String(userMessage || '').trim();
        if (productConsulted && productConsulted !== 'NINGUNO') {
            const label = { 'purchase_interest': 'Compra', 'price_inquiry': 'Precios', 'complaint': 'Problema', 'support': 'Soporte', 'info_request': 'Información', 'question': 'Consulta' }[intent] || 'Consulta';
            return `${label}: ${productConsulted}`.substring(0, 255);
        }
        const cleaned = msg.replace(/\b(el|la|los|las|un|una|unos|unas|de|del|en|con|por|para|que|es|son|hay|tengo|quiero|necesito|me|mi|tu|su|hola|buenas?|d[ií]as?|tardes?|noches?)\b/gi, '').replace(/\s+/g, ' ').trim();
        if (cleaned.length > 3) return cleaned.substring(0, 255);
        return intent === 'greeting' ? 'Saludo' : 'Consulta general';
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
                topicSummary = this._extractTopicRegex(userMessage, productFromFlow, intent);
                productConsulted = productFromFlow;
                logger.debug(`[INSIGHT] Regex fallback ${userPhone}: intent=${intent} outcome=${outcome} sentiment=${sentiment}`);
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
