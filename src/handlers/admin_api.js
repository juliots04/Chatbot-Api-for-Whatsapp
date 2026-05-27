const express = require('express');
const router = express.Router();
const config = require('../../config');
const logger = require('../utils/logger');
const botHandler = require('./bot_handler');
const userSettingsService = require('../services/user_settings_service');

/**
 * GET /api/config — Devuelve la configuración actual (sin datos sensibles)
 */
router.get('/config', async (req, res) => {
    try {
        await userSettingsService.initialize();
        res.json({
            defaults: userSettingsService.getDefaults(),
            conversation: { ...config.conversation }
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo config: ${error.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/config — Actualiza la configuración en caliente (hot-reload)
 * No requiere reiniciar el servidor
 */
router.put('/config', async (req, res) => {
    try {
        await userSettingsService.initialize();
        const { section, data } = req.body;

        if (!section || !data) {
            return res.status(400).json({ error: 'Se requiere "section" y "data"' });
        }

        switch (section) {
            case 'conversation':
                if (data.maxHistoryMessages !== undefined) config.conversation.maxHistoryMessages = parseInt(data.maxHistoryMessages);
                if (data.inactivityTimeoutMs !== undefined) config.conversation.inactivityTimeoutMs = parseInt(data.inactivityTimeoutMs);
                await userSettingsService.persistGlobalConversation('admin_api');
                logger.info(`[ADMIN] Conversation config actualizado: ${JSON.stringify(config.conversation)}`);
                break;

            default:
                return res.status(400).json({ error: `Sección desconocida: "${section}"` });
        }

        res.json({ success: true, section, message: `Configuración de "${section}" actualizada correctamente` });

    } catch (error) {
        logger.error(`[ADMIN API] Error actualizando config: ${error.message}`);
        res.status(500).json({ error: 'Error actualizando configuración' });
    }
});

/**
 * GET /api/users — Lista usuarios conocidos por el bot
 */
router.get('/users', async (req, res) => {
    try {
        await userSettingsService.initialize();
        res.json({ users: botHandler.getUsers() });
    } catch (error) {
        logger.error(`[ADMIN API] Error listando usuarios: ${error.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/users/:phone/config — Obtiene configuración efectiva por usuario
 */
router.get('/users/:phone/config', async (req, res) => {
    try {
        await userSettingsService.initialize();
        const phone = String(req.params.phone || '').trim();
        if (!phone) {
            return res.status(400).json({ error: 'Número inválido' });
        }

        const profile = userSettingsService.touchUser(phone);
        const settings = userSettingsService.getUserSettings(phone);

        res.json({
            user: profile,
            settings
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo configuración de usuario: ${error.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/users/:phone/config — Actualiza rate limiting + gemini por usuario
 */
router.put('/users/:phone/config', async (req, res) => {
    try {
        await userSettingsService.initialize();
        const phone = String(req.params.phone || '').trim();
        const { section, data } = req.body;

        const toFiniteInt = (value) => {
            if (value === undefined || value === null || value === '') return undefined;
            const n = Number(value);
            if (!Number.isFinite(n)) return undefined;
            return Math.trunc(n);
        };

        const toFiniteFloat = (value) => {
            if (value === undefined || value === null || value === '') return undefined;
            const n = Number(value);
            if (!Number.isFinite(n)) return undefined;
            return n;
        };

        const clamp = (n, min, max) => {
            if (!Number.isFinite(n)) return undefined;
            return Math.min(max, Math.max(min, n));
        };

        if (!phone) {
            return res.status(400).json({ error: 'Número inválido' });
        }
        if (!section || !data) {
            return res.status(400).json({ error: 'Se requiere "section" y "data"' });
        }

        if (!['rateLimiting', 'gemini'].includes(section)) {
            return res.status(400).json({ error: `Sección no permitida para usuario: "${section}"` });
        }

        const payload = section === 'rateLimiting'
            ? {
                rateLimiting: {
                    maxMessagesPerWindow: clamp(toFiniteInt(data.maxMessagesPerWindow), 1, 1000),
                    windowSizeMs: clamp(toFiniteInt(data.windowSizeMs), 1000, 3600000),
                    cooldownMs: clamp(toFiniteInt(data.cooldownMs), 1000, 3600000)
                }
            }
            : {
                gemini: {
                    temperature: clamp(toFiniteFloat(data.temperature), 0, 2),
                    maxOutputTokens: clamp(toFiniteInt(data.maxOutputTokens), 100, 8192),
                    timeout: clamp(toFiniteInt(data.timeout), 18000, 120000),
                    failureThreshold: clamp(toFiniteInt(data.failureThreshold), 1, 20),
                    recoveryTimeMs: clamp(toFiniteInt(data.recoveryTimeMs), 1000, 3600000)
                }
            };

        // Remover propiedades undefined para evitar sobreescrituras accidentales
        if (payload.rateLimiting) {
            payload.rateLimiting = Object.fromEntries(
                Object.entries(payload.rateLimiting).filter(([, value]) => value !== undefined)
            );
        }
        if (payload.gemini) {
            payload.gemini = Object.fromEntries(
                Object.entries(payload.gemini).filter(([, value]) => value !== undefined)
            );
        }

        if (section === 'gemini' && Object.keys(payload.gemini || {}).length === 0) {
            return res.status(400).json({ error: 'No se detectaron valores Gemini válidos para guardar' });
        }
        if (section === 'rateLimiting' && Object.keys(payload.rateLimiting || {}).length === 0) {
            return res.status(400).json({ error: 'No se detectaron valores de rate limiting válidos para guardar' });
        }

        const settings = await userSettingsService.upsertUserSettings(phone, payload);
        logger.info(`[ADMIN] Config por usuario actualizada para ${phone} (${section})`);

        res.json({
            success: true,
            phone,
            section,
            settings,
            message: `Configuración de ${section} actualizada para ${phone}`
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error actualizando config por usuario: ${error.message}`);
        res.status(500).json({ error: 'Error actualizando configuración de usuario' });
    }
});

/**
 * GET /api/users/:phone/stats — Analytics agregadas por usuario
 */
router.get('/users/:phone/stats', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        const phone = String(req.params.phone || '').trim();
        if (!phone) return res.status(400).json({ error: 'Número inválido' });
        if (!mysqlService.isConfigured()) return res.json({ stats: null, source: 'mysql_not_configured' });

        // User profile from DB
        const userRows = await mysqlService.query(
            `SELECT id, display_name, first_seen_at, last_seen_at, received_count, processed_count, failed_count, avg_latency_ms FROM users WHERE phone = ? LIMIT 1`,
            [phone]
        );
        const user = userRows[0] || null;

        // Message counts & timing
        const msgStats = await mysqlService.query(
            `SELECT
                COUNT(*) AS total_messages,
                SUM(CASE WHEN cm.direction='inbound' THEN 1 ELSE 0 END) AS inbound,
                SUM(CASE WHEN cm.direction='outbound' THEN 1 ELSE 0 END) AS outbound,
                ROUND(AVG(cm.latency_ms),0) AS avg_latency,
                MAX(cm.created_at) AS last_message_at,
                MIN(cm.created_at) AS first_message_at,
                COUNT(DISTINCT DATE(cm.created_at)) AS active_days
             FROM conversation_messages cm
             INNER JOIN conversation_sessions cs ON cm.session_id = cs.id
             INNER JOIN users u ON cs.user_id = u.id
             WHERE u.phone = ?`,
            [phone]
        );

        // Sessions info
        const sessionStats = await mysqlService.query(
            `SELECT COUNT(*) AS total_sessions,
                SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_sessions,
                SUM(total_messages) AS session_messages
             FROM conversation_sessions cs
             INNER JOIN users u ON cs.user_id = u.id
             WHERE u.phone = ?`,
            [phone]
        );

        // Token usage per user
        const tokenStats = await mysqlService.query(
            `SELECT
                COUNT(*) AS total_calls,
                SUM(input_tokens) AS total_input,
                SUM(output_tokens) AS total_output,
                SUM(total_tokens) AS total_tokens,
                ROUND(AVG(total_tokens),0) AS avg_tokens,
                ROUND(AVG(latency_ms),0) AS avg_ai_latency
             FROM gemini_token_usage
             WHERE user_phone = ?`,
            [phone]
        );

        // Errors per user
        const errorStats = await mysqlService.query(
            `SELECT COUNT(*) AS total_errors FROM system_events WHERE user_phone = ? AND level IN ('error','critical')`,
            [phone]
        );

        // Hourly distribution (last 30 days)
        const hourly = await mysqlService.query(
            `SELECT HOUR(cm.created_at) AS h, COUNT(*) AS cnt
             FROM conversation_messages cm
             INNER JOIN conversation_sessions cs ON cm.session_id = cs.id
             INNER JOIN users u ON cs.user_id = u.id
             WHERE u.phone = ? AND cm.created_at >= NOW() - INTERVAL 30 DAY
             GROUP BY HOUR(cm.created_at) ORDER BY h`,
            [phone]
        );

        res.json({
            user,
            messages: msgStats[0] || {},
            sessions: sessionStats[0] || {},
            tokens: tokenStats[0] || {},
            errors: errorStats[0] || {},
            hourlyDistribution: hourly
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo stats de ${req.params.phone}: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo estadísticas' });
    }
});

/**
 * GET /api/chat/:phone — Devuelve historial de mensajes para el Chat Mirror
 * Extrae los últimos N mensajes de conversation_messages (MySQL)
 */
router.get('/chat/:phone', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        const phone = String(req.params.phone || '').trim();
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);

        if (!phone) {
            return res.status(400).json({ error: 'Número inválido' });
        }

        if (!mysqlService.isConfigured()) {
            return res.json({ messages: [], source: 'mysql_not_configured' });
        }

        const rows = await mysqlService.query(
            `SELECT
                cm.id,
                cm.direction,
                cm.source,
                cm.body,
                cm.latency_ms,
                cm.created_at
             FROM conversation_messages cm
             INNER JOIN conversation_sessions cs ON cm.session_id = cs.id
             INNER JOIN users u ON cs.user_id = u.id
             WHERE u.phone = ?
             ORDER BY cm.created_at DESC
             LIMIT ?`,
            [phone, limit]
        );

        // Reverse so oldest first for chat display
        res.json({ messages: rows.reverse(), phone });

    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo chat de ${req.params.phone}: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo historial de chat' });
    }
});

/**
 * GET /api/chat/:phone/count — Devuelve solo el conteo de mensajes (polling liviano)
 */
router.get('/chat/:phone/count', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        const phone = String(req.params.phone || '').trim();

        if (!phone || !mysqlService.isConfigured()) {
            return res.json({ count: 0 });
        }

        const rows = await mysqlService.query(
            `SELECT COUNT(*) AS total
             FROM conversation_messages cm
             INNER JOIN conversation_sessions cs ON cm.session_id = cs.id
             INNER JOIN users u ON cs.user_id = u.id
             WHERE u.phone = ?`,
            [phone]
        );

        res.json({ count: rows[0]?.total || 0 });

    } catch (error) {
        res.json({ count: 0 });
    }
});

/**
 * GET /api/users/:phone/token-history — Últimas N llamadas Gemini del usuario (para mini chart)
 */
router.get('/users/:phone/token-history', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        const phone = String(req.params.phone || '').trim();
        if (!phone) return res.status(400).json({ error: 'Número inválido' });
        if (!mysqlService.isConfigured()) return res.json({ calls: [] });

        const rows = await mysqlService.query(
            `SELECT id, key_slot, input_tokens, output_tokens, total_tokens, latency_ms, created_at
             FROM gemini_token_usage
             WHERE user_phone = ?
             ORDER BY created_at DESC LIMIT 60`,
            [phone]
        );

        res.json({ calls: rows.reverse() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/metrics/history/daily — Historial diario del último mes (1 punto por día)
 */
router.get('/metrics/history/daily', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ days: [], source: 'mysql_not_configured' });
        }

        // Use Peru timezone (UTC-5) for all date grouping
        const TZ = "'-05:00'";

        const rows = await mysqlService.query(
            `SELECT
                DATE(CONVERT_TZ(created_at, '+00:00', ${TZ})) AS day,
                MAX(messages_received) - MIN(messages_received) AS received,
                MAX(messages_processed) - MIN(messages_processed) AS processed,
                MAX(messages_failed) - MIN(messages_failed) AS failed,
                ROUND(AVG(throughput_messages_per_minute), 2) AS avg_mpm,
                ROUND(AVG(heap_used_mb), 2) AS avg_heap_mb,
                MAX(heap_used_mb) AS peak_heap_mb,
                ROUND(AVG(latency_p50_ms), 0) AS avg_p50,
                ROUND(AVG(latency_p95_ms), 0) AS avg_p95
             FROM metrics_snapshots
             WHERE created_at >= NOW() - INTERVAL 30 DAY
             GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', ${TZ}))
             ORDER BY day ASC`
        );

        // Also get daily token aggregation
        const tokenRows = await mysqlService.query(
            `SELECT
                DATE(CONVERT_TZ(created_at, '+00:00', ${TZ})) AS day,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(total_tokens) AS total_tokens,
                COUNT(*) AS calls
             FROM gemini_token_usage
             WHERE created_at >= NOW() - INTERVAL 30 DAY
             GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', ${TZ}))
             ORDER BY day ASC`
        );

        // Hourly usage distribution (last 30 days) — try conversation_messages first, fallback to gemini_token_usage
        let hourlyRows = [];
        try {
            hourlyRows = await mysqlService.query(
                `SELECT HOUR(CONVERT_TZ(created_at, '+00:00', ${TZ})) AS hour, COUNT(*) AS messages
                 FROM conversation_messages
                 WHERE created_at >= NOW() - INTERVAL 30 DAY
                 GROUP BY HOUR(CONVERT_TZ(created_at, '+00:00', ${TZ}))
                 ORDER BY hour ASC`
            );
        } catch (_) {}
        // Fallback: if no conversation_messages data, use gemini_token_usage
        if (!hourlyRows || hourlyRows.length === 0) {
            try {
                hourlyRows = await mysqlService.query(
                    `SELECT HOUR(CONVERT_TZ(created_at, '+00:00', ${TZ})) AS hour, COUNT(*) AS messages
                     FROM gemini_token_usage
                     WHERE created_at >= NOW() - INTERVAL 30 DAY
                     GROUP BY HOUR(CONVERT_TZ(created_at, '+00:00', ${TZ}))
                     ORDER BY hour ASC`
                );
            } catch (_) {}
        }

        res.json({ days: rows, tokenDays: tokenRows, hourlyDistribution: hourlyRows });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo historial diario: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo historial diario' });
    }
});

/**
 * GET /api/metrics/history — Historial de métricas del último mes agrupado por intervalos
 */
router.get('/metrics/history', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ snapshots: [], source: 'mysql_not_configured' });
        }

        // Get last 30 days of snapshots, max 500 rows (grouped by ~6h intervals for the month)
        const rows = await mysqlService.query(
            `SELECT
                created_at,
                messages_received,
                messages_processed,
                messages_failed,
                throughput_messages_per_minute,
                latency_p50_ms,
                latency_p95_ms,
                latency_p99_ms,
                heap_used_mb,
                gemini_calls,
                gemini_errors,
                active_conversations
             FROM metrics_snapshots
             WHERE created_at >= NOW() - INTERVAL 30 DAY
             ORDER BY created_at ASC
             LIMIT 500`
        );

        res.json({ snapshots: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo historial métricas: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo historial' });
    }
});

/**
 * GET /api/metrics/errors — Errores del sistema del último mes
 */
router.get('/metrics/errors', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ errors: [], source: 'mysql_not_configured' });
        }

        const rows = await mysqlService.query(
            `SELECT id, level, component, event_code, user_phone, message, context_json, created_at
             FROM system_events
             WHERE level IN ('error', 'critical')
             AND created_at >= NOW() - INTERVAL 30 DAY
             ORDER BY created_at DESC
             LIMIT 100`
        );

        res.json({ errors: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo errores: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo errores' });
    }
});

/**
 * GET /api/metrics/errors/key/:index — Errores de una API key específica
 */
router.get('/metrics/errors/key/:index', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ errors: [], source: 'mysql_not_configured' });
        }

        const keyIndex = parseInt(req.params.index);
        if (isNaN(keyIndex)) return res.status(400).json({ error: 'Índice inválido' });

        const rows = await mysqlService.query(
            `SELECT id, level, event_code, user_phone, message, context_json, created_at
             FROM system_events
             WHERE component = 'gemini'
             AND level IN ('error', 'critical')
             AND JSON_EXTRACT(context_json, '$.keyIndex') = ?
             AND created_at >= NOW() - INTERVAL 30 DAY
             ORDER BY created_at DESC
             LIMIT 100`,
            [keyIndex]
        );

        res.json({ errors: rows, keyIndex });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo errores de key: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo errores' });
    }
});

/**
 * GET /api/metrics/tokens — Historial de tokens del último mes
 */
router.get('/metrics/tokens', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ tokens: [], source: 'mysql_not_configured' });
        }

        const rows = await mysqlService.query(
            `SELECT id, key_slot, user_phone, input_tokens, output_tokens, total_tokens, latency_ms, created_at
             FROM gemini_token_usage
             WHERE created_at >= NOW() - INTERVAL 30 DAY
             ORDER BY created_at DESC
             LIMIT 200`
        );

        res.json({ tokens: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error obteniendo tokens: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo tokens' });
    }
});

// =============================================
// REPORTS MODULE ENDPOINTS
// =============================================

const TZ_PERU = "'-05:00'";

/**
 * GET /api/reports/summary — KPIs generales para el módulo de reportes
 */
router.get('/reports/summary', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ summary: null, source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;

        const [totals] = await mysqlService.query(
            `SELECT 
                COUNT(*) AS total_interactions,
                SUM(intent = 'purchase_interest') AS purchase_intents,
                SUM(outcome = 'purchased') AS purchases,
                SUM(sentiment = 'positive') AS positive,
                SUM(sentiment = 'neutral') AS neutral_count,
                SUM(sentiment = 'negative') AS negative,
                SUM(intent = 'complaint') AS complaints,
                SUM(outcome = 'unresolved') AS unresolved,
                SUM(outcome IN ('purchased','resolved','redirected')) AS resolved_count,
                COUNT(DISTINCT user_phone) AS unique_users
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY`,
            [days]
        );

        const totalInt = parseInt(totals.total_interactions) || 0;
        const purchaseRate = totalInt > 0
            ? Math.round((totals.purchases / totalInt) * 10000) / 100
            : 0;
        const resolvedCount = parseInt(totals.resolved_count) || 0;
        const resolutionRate = totalInt > 0
            ? Math.round((resolvedCount / totalInt) * 10000) / 100
            : 0;

        res.json({
            summary: {
                totalInteractions: totalInt,
                uniqueUsers: parseInt(totals.unique_users) || 0,
                purchaseIntents: parseInt(totals.purchase_intents) || 0,
                purchases: parseInt(totals.purchases) || 0,
                purchaseRate,
                positive: parseInt(totals.positive) || 0,
                neutral: parseInt(totals.neutral_count) || 0,
                negative: parseInt(totals.negative) || 0,
                complaints: parseInt(totals.complaints) || 0,
                unresolved: parseInt(totals.unresolved) || 0,
                resolvedCount,
                resolutionRate,
                days
            }
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/summary: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo resumen de reportes' });
    }
});

/**
 * GET /api/reports/insights — Lista paginada de insights individuales
 */
router.get('/reports/insights', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ insights: [], total: 0, source: 'mysql_not_configured' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 10, 200);
        const offset = parseInt(req.query.offset) || 0;
        const intent = req.query.intent || null;
        const sentiment = req.query.sentiment || null;
        const outcome = req.query.outcome || null;
        const product = req.query.product || null;
        const user = req.query.user || null;

        let where = 'WHERE created_at >= NOW() - INTERVAL 30 DAY';
        const params = [];
        if (intent) { where += ' AND intent = ?'; params.push(intent); }
        if (sentiment) { where += ' AND sentiment = ?'; params.push(sentiment); }
        if (outcome) { where += ' AND outcome = ?'; params.push(outcome); }
        if (product) { where += ' AND product_consulted LIKE ?'; params.push('%' + product + '%'); }
        if (user) { where += ' AND (user_name LIKE ? OR user_phone LIKE ?)'; params.push('%' + user + '%', '%' + user + '%'); }

        const countParams = [...params];
        const [countRow] = await mysqlService.query(
            `SELECT COUNT(*) AS total FROM conversation_insights ${where}`,
            countParams
        );

        params.push(limit, offset);
        const rows = await mysqlService.query(
            `SELECT id, user_phone, user_name, intent, commercial_stage, product_consulted,
                    outcome, sentiment, topic_summary, user_message_preview, confidence, created_at
             FROM conversation_insights
             ${where}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            params
        );

        res.json({ insights: rows, total: parseInt(countRow.total) || 0 });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/insights: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo insights' });
    }
});

/**
 * GET /api/reports/topics — Temas más frecuentes agregados
 */
router.get('/reports/topics', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ topics: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;
        const rows = await mysqlService.query(
            `SELECT topic_summary AS topic, COUNT(*) AS count,
                    SUM(sentiment = 'positive') AS positive,
                    SUM(sentiment = 'neutral') AS neutral_count,
                    SUM(sentiment = 'negative') AS negative
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
               AND topic_summary IS NOT NULL AND topic_summary != ''
             GROUP BY topic_summary
             ORDER BY count DESC
             LIMIT 20`,
            [days]
        );

        res.json({ topics: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/topics: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo temas' });
    }
});

/**
 * GET /api/reports/products — Productos más consultados con outcomes
 */
router.get('/reports/products', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ products: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;
        const rows = await mysqlService.query(
            `SELECT product_consulted AS product, COUNT(*) AS total,
                    SUM(outcome = 'purchased') AS purchased,
                    SUM(outcome = 'just_asked') AS just_asked,
                    SUM(outcome = 'problem_reported') AS problems,
                    SUM(outcome = 'ongoing') AS ongoing
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
               AND product_consulted IS NOT NULL AND product_consulted != ''
             GROUP BY product_consulted
             ORDER BY total DESC
             LIMIT 15`,
            [days]
        );

        res.json({ products: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/products: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo productos' });
    }
});

/**
 * GET /api/reports/funnel — Embudo comercial (cuántos llegan a cada stage)
 */
router.get('/reports/funnel', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ funnel: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;
        const rows = await mysqlService.query(
            `SELECT commercial_stage AS stage, COUNT(*) AS count,
                    COUNT(DISTINCT user_phone) AS unique_users
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
               AND commercial_stage IS NOT NULL
             GROUP BY commercial_stage
             ORDER BY FIELD(commercial_stage, 'DISCOVERY','PRODUCT_INTEREST','PLAN_SELECTION','PAYMENT_METHOD','PAYMENT_PROOF','CLOSING')`,
            [days]
        );

        res.json({ funnel: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/funnel: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo embudo' });
    }
});

/**
 * GET /api/reports/intents — Distribución de intenciones
 */
router.get('/reports/intents', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ intents: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;
        const rows = await mysqlService.query(
            `SELECT intent, COUNT(*) AS count
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY intent
             ORDER BY count DESC`,
            [days]
        );

        res.json({ intents: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/intents: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo intenciones' });
    }
});

/**
 * GET /api/reports/sentiment-daily — Sentimiento por día
 */
router.get('/reports/sentiment-daily', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ days: [], source: 'mysql_not_configured' });
        }

        const daysParam = parseInt(req.query.days) || 30;
        const rows = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    SUM(sentiment = 'positive') AS positive,
                    SUM(sentiment = 'neutral') AS neutral_count,
                    SUM(sentiment = 'negative') AS negative,
                    COUNT(*) AS total
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU}))
             ORDER BY day ASC`,
            [daysParam]
        );

        res.json({ days: rows });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/sentiment-daily: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo sentimiento diario' });
    }
});

/**
 * GET /api/reports/complaints — Detalle de quejas con tendencia diaria
 */
router.get('/reports/complaints', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ complaints: [], daily: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;

        const rows = await mysqlService.query(
            `SELECT id, user_phone, user_name, product_consulted, topic_summary,
                    user_message_preview, outcome, sentiment, confidence, created_at
             FROM conversation_insights
             WHERE intent = 'complaint' AND created_at >= NOW() - INTERVAL ? DAY
             ORDER BY created_at DESC
             LIMIT 100`,
            [days]
        );

        const daily = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    COUNT(*) AS count
             FROM conversation_insights
             WHERE intent = 'complaint' AND created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day ASC`,
            [days]
        );

        res.json({ complaints: rows, daily });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/complaints: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo quejas' });
    }
});

/**
 * GET /api/reports/unresolved — Detalle de problemas sin resolver con tendencia diaria
 */
router.get('/reports/unresolved', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ unresolved: [], daily: [], source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;

        const rows = await mysqlService.query(
            `SELECT id, user_phone, user_name, intent, product_consulted, topic_summary,
                    user_message_preview, sentiment, confidence, commercial_stage, created_at
             FROM conversation_insights
             WHERE outcome = 'unresolved' AND created_at >= NOW() - INTERVAL ? DAY
             ORDER BY created_at DESC
             LIMIT 100`,
            [days]
        );

        const daily = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    COUNT(*) AS count
             FROM conversation_insights
             WHERE outcome = 'unresolved' AND created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day ASC`,
            [days]
        );

        res.json({ unresolved: rows, daily });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/unresolved: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo problemas sin resolver' });
    }
});

/**
 * GET /api/reports/valoracion-detail — Datos útiles de valoración para el modal
 */
router.get('/reports/valoracion-detail', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;

        // Top 3 usuarios con más negativos
        const topNegUsers = await mysqlService.query(
            `SELECT COALESCE(user_name, user_phone) AS user_label, COUNT(*) AS neg_count
             FROM conversation_insights
             WHERE sentiment = 'negative' AND created_at >= NOW() - INTERVAL ? DAY
             GROUP BY user_label ORDER BY neg_count DESC LIMIT 3`,
            [days]
        );

        // Top 3 productos con más negativos
        const topNegProducts = await mysqlService.query(
            `SELECT product_consulted AS product, COUNT(*) AS neg_count
             FROM conversation_insights
             WHERE sentiment = 'negative' AND product_consulted IS NOT NULL AND product_consulted != ''
               AND created_at >= NOW() - INTERVAL ? DAY
             GROUP BY product_consulted ORDER BY neg_count DESC LIMIT 3`,
            [days]
        );

        // Día con más negativos y día con más positivos
        const peakDays = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    SUM(sentiment = 'positive') AS pos,
                    SUM(sentiment = 'negative') AS neg,
                    COUNT(*) AS total
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day ASC`,
            [days]
        );

        // Interacciones negativas recientes (últimas 10)
        const recentNeg = await mysqlService.query(
            `SELECT user_name, user_phone, product_consulted, topic_summary, user_message_preview, created_at
             FROM conversation_insights
             WHERE sentiment = 'negative' AND created_at >= NOW() - INTERVAL ? DAY
             ORDER BY created_at DESC LIMIT 10`,
            [days]
        );

        res.json({ topNegUsers, topNegProducts, peakDays, recentNeg });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/valoracion-detail: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo detalle de valoración' });
    }
});

/**
 * GET /api/reports/valoracion-daily-detail — Tabla detallada día a día
 */
router.get('/reports/valoracion-daily-detail', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ source: 'mysql_not_configured' });
        }

        const days = parseInt(req.query.days) || 30;

        const dailyRows = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    SUM(sentiment = 'positive') AS positive,
                    SUM(sentiment = 'neutral') AS neutral_count,
                    SUM(sentiment = 'negative') AS negative,
                    COUNT(*) AS total
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day DESC`,
            [days]
        );

        // Top 5 interacciones negativas del periodo con detalle
        const worstInteractions = await mysqlService.query(
            `SELECT COALESCE(user_name, user_phone) AS user_label, product_consulted,
                    topic_summary, user_message_preview, intent, created_at
             FROM conversation_insights
             WHERE sentiment = 'negative' AND created_at >= NOW() - INTERVAL ? DAY
             ORDER BY created_at DESC LIMIT 10`,
            [days]
        );

        res.json({ daily: dailyRows, worstInteractions });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/valoracion-daily-detail: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo detalle diario de valoración' });
    }
});

/**
 * GET /api/reports/kpi-daily — Datos diarios para sparklines de las 4 KPIs
 */
router.get('/reports/kpi-daily', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ days: [], source: 'mysql_not_configured' });
        }

        const numDays = parseInt(req.query.days) || 14;

        const rows = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    COUNT(*) AS total,
                    SUM(outcome IN ('purchased','resolved','redirected')) AS resolved,
                    SUM(intent = 'complaint') AS complaints,
                    SUM(outcome = 'purchased') AS purchases,
                    SUM(outcome = 'unresolved') AS unresolved
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day ASC`,
            [numDays]
        );

        res.json({
            days: rows.map(r => ({
                day: r.day,
                total: parseInt(r.total) || 0,
                resolved: parseInt(r.resolved) || 0,
                complaints: parseInt(r.complaints) || 0,
                purchases: parseInt(r.purchases) || 0,
                unresolved: parseInt(r.unresolved) || 0,
                resolutionRate: (parseInt(r.total) || 0) > 0
                    ? Math.round(((parseInt(r.resolved) || 0) / (parseInt(r.total) || 1)) * 100)
                    : 0,
                purchaseRate: (parseInt(r.total) || 0) > 0
                    ? Math.round(((parseInt(r.purchases) || 0) / (parseInt(r.total) || 1)) * 100)
                    : 0
            }))
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/kpi-daily: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo KPI diarios' });
    }
});

/**
 * GET /api/reports/outcome-daily — Datos diarios por outcome para sparkline multi-línea
 */
router.get('/reports/outcome-daily', async (req, res) => {
    try {
        const mysqlService = require('../services/mysql_service');
        if (!mysqlService.isConfigured()) {
            return res.json({ days: [], source: 'mysql_not_configured' });
        }

        const numDays = parseInt(req.query.days) || 14;

        const rows = await mysqlService.query(
            `SELECT DATE(CONVERT_TZ(created_at, '+00:00', ${TZ_PERU})) AS day,
                    SUM(outcome = 'purchased') AS purchased,
                    SUM(outcome = 'just_asked') AS just_asked,
                    SUM(outcome = 'problem_reported') AS problem_reported,
                    SUM(outcome = 'unresolved') AS unresolved,
                    SUM(outcome = 'ongoing') AS ongoing,
                    SUM(outcome = 'resolved') AS resolved,
                    SUM(outcome = 'redirected') AS redirected,
                    COUNT(*) AS total
             FROM conversation_insights
             WHERE created_at >= NOW() - INTERVAL ? DAY
             GROUP BY day ORDER BY day ASC`,
            [numDays]
        );

        res.json({
            days: rows.map(r => ({
                day: r.day,
                purchased: parseInt(r.purchased) || 0,
                just_asked: parseInt(r.just_asked) || 0,
                problem_reported: parseInt(r.problem_reported) || 0,
                unresolved: parseInt(r.unresolved) || 0,
                ongoing: parseInt(r.ongoing) || 0,
                resolved: parseInt(r.resolved) || 0,
                redirected: parseInt(r.redirected) || 0,
                total: parseInt(r.total) || 0
            }))
        });
    } catch (error) {
        logger.error(`[ADMIN API] Error reports/outcome-daily: ${error.message}`);
        res.status(500).json({ error: 'Error obteniendo outcomes diarios' });
    }
});

module.exports = router;
