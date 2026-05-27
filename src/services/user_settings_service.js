const config = require('../../config');
const mysqlService = require('./mysql_service');
const logger = require('../utils/logger');

function normalizePhone(phone = '') {
    return String(phone).trim();
}

class UserSettingsService {
    constructor() {
        this.users = new Map(); // phone -> metadata
        this.overrides = new Map(); // phone -> partial overrides
        this.initialized = false;
        this.initPromise = null;
        this.persistTimers = new Map(); // phone -> timeout
    }

    _defaultSettings() {
        return {
            rateLimiting: {
                maxMessagesPerWindow: config.rateLimiting.maxMessagesPerWindow,
                windowSizeMs: config.rateLimiting.windowSizeMs,
                cooldownMs: config.rateLimiting.cooldownMs
            },
            gemini: {
                temperature: config.gemini.generationConfig.temperature,
                maxOutputTokens: config.gemini.generationConfig.maxOutputTokens,
                timeout: config.gemini.timeout,
                failureThreshold: config.gemini.circuitBreaker.failureThreshold,
                recoveryTimeMs: config.gemini.circuitBreaker.recoveryTimeMs
            }
        };
    }

    async initialize() {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (!mysqlService.isConfigured()) {
                logger.warn('[USER SETTINGS] Persistencia MySQL desactivada: DB_* no configuradas.');
                this.initialized = true;
                return;
            }

            const connected = await mysqlService.connect();
            if (!connected) {
                logger.warn('[USER SETTINGS] No se pudo inicializar desde MySQL; se usará memoria temporal.');
                this.initialized = true;
                return;
            }

            await this._loadUsersAndOverridesFromDb();
            await this._loadGlobalConversationFromDb();
            this.initialized = true;
            logger.info(`[USER SETTINGS] Inicializado desde MySQL. Usuarios cargados: ${this.users.size}`);
        })().catch((error) => {
            logger.error(`[USER SETTINGS] Error en initialize(): ${error.message}`);
            this.initialized = true;
        }).finally(() => {
            this.initPromise = null;
        });

        return this.initPromise;
    }

    async _loadUsersAndOverridesFromDb() {
        const rows = await mysqlService.query(`
            SELECT
                u.phone,
                u.display_name,
                u.first_seen_at,
                u.last_seen_at,
                u.received_count,
                u.processed_count,
                u.failed_count,
                u.avg_latency_ms,
                c.rate_max_messages,
                c.rate_window_ms,
                c.rate_cooldown_ms,
                c.gemini_temperature,
                c.gemini_max_output_tokens,
                c.gemini_timeout_ms,
                c.gemini_failure_threshold,
                c.gemini_recovery_time_ms
            FROM users u
            LEFT JOIN user_runtime_config c ON c.user_id = u.id
            ORDER BY u.last_seen_at DESC
        `);

        for (const row of rows) {
            const phone = normalizePhone(row.phone);
            if (!phone) continue;

            const processed = Number(row.processed_count || 0);
            const avgLatency = Number(row.avg_latency_ms || 0);
            const profile = {
                phone,
                userName: row.display_name || '',
                firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at).getTime() : Date.now(),
                lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now(),
                messagesReceived: Number(row.received_count || 0),
                messagesProcessed: processed,
                messagesFailed: Number(row.failed_count || 0),
                lastLatencyMs: avgLatency,
                avgLatencyMs: avgLatency,
                totalLatencyMs: processed > 0 ? Math.round(avgLatency * processed) : 0
            };

            this.users.set(phone, profile);

            if (row.rate_max_messages !== null && row.rate_max_messages !== undefined) {
                this.overrides.set(phone, {
                    rateLimiting: {
                        maxMessagesPerWindow: Number(row.rate_max_messages),
                        windowSizeMs: Number(row.rate_window_ms),
                        cooldownMs: Number(row.rate_cooldown_ms)
                    },
                    gemini: {
                        temperature: Number(row.gemini_temperature),
                        maxOutputTokens: Number(row.gemini_max_output_tokens),
                        timeout: Number(row.gemini_timeout_ms),
                        failureThreshold: Number(row.gemini_failure_threshold),
                        recoveryTimeMs: Number(row.gemini_recovery_time_ms)
                    }
                });
            }
        }
    }

    async _loadGlobalConversationFromDb() {
        const rows = await mysqlService.query(
            'SELECT max_history_messages, inactivity_timeout_ms FROM global_conversation_config WHERE id = 1 LIMIT 1'
        );
        if (!rows || rows.length === 0) return;

        const row = rows[0];
        if (row.max_history_messages !== undefined && row.max_history_messages !== null) {
            config.conversation.maxHistoryMessages = Number(row.max_history_messages);
        }
        if (row.inactivity_timeout_ms !== undefined && row.inactivity_timeout_ms !== null) {
            config.conversation.inactivityTimeoutMs = Number(row.inactivity_timeout_ms);
        }
    }

    _schedulePersistUser(phone) {
        if (!mysqlService.isConfigured()) return;

        const normalized = normalizePhone(phone);
        if (!normalized) return;

        if (this.persistTimers.has(normalized)) {
            clearTimeout(this.persistTimers.get(normalized));
        }

        const timer = setTimeout(() => {
            this.persistTimers.delete(normalized);
            this._persistUserToDb(normalized).catch((error) => {
                logger.error(`[USER SETTINGS] Error persistiendo usuario ${normalized}: ${error.message}`);
            });
        }, 500);

        this.persistTimers.set(normalized, timer);
    }

    async _persistUserToDb(phone) {
        if (!mysqlService.isConfigured()) return;
        const user = this.users.get(phone);
        if (!user) return;

        await mysqlService.execute(
            `INSERT INTO users (
                phone,
                display_name,
                first_seen_at,
                last_seen_at,
                received_count,
                processed_count,
                failed_count,
                avg_latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at)),
                last_seen_at = VALUES(last_seen_at),
                received_count = VALUES(received_count),
                processed_count = VALUES(processed_count),
                failed_count = VALUES(failed_count),
                avg_latency_ms = VALUES(avg_latency_ms)`,
            [
                user.phone,
                user.userName || null,
                new Date(user.firstSeenAt),
                new Date(user.lastSeenAt),
                user.messagesReceived || 0,
                user.messagesProcessed || 0,
                user.messagesFailed || 0,
                Number(user.avgLatencyMs || 0)
            ]
        );
    }

    async _persistOverrideToDb(phone) {
        if (!mysqlService.isConfigured()) return;
        const normalized = normalizePhone(phone);
        if (!normalized) return;

        await this._persistUserToDb(normalized);

        const settings = this.getUserSettings(normalized);
        await mysqlService.execute(
            `INSERT INTO user_runtime_config (
                user_id,
                rate_max_messages,
                rate_window_ms,
                rate_cooldown_ms,
                gemini_temperature,
                gemini_max_output_tokens,
                gemini_timeout_ms,
                gemini_failure_threshold,
                gemini_recovery_time_ms
            )
            SELECT
                id,
                ?, ?, ?, ?, ?, ?, ?, ?
            FROM users
            WHERE phone = ?
            ON DUPLICATE KEY UPDATE
                rate_max_messages = VALUES(rate_max_messages),
                rate_window_ms = VALUES(rate_window_ms),
                rate_cooldown_ms = VALUES(rate_cooldown_ms),
                gemini_temperature = VALUES(gemini_temperature),
                gemini_max_output_tokens = VALUES(gemini_max_output_tokens),
                gemini_timeout_ms = VALUES(gemini_timeout_ms),
                gemini_failure_threshold = VALUES(gemini_failure_threshold),
                gemini_recovery_time_ms = VALUES(gemini_recovery_time_ms)`,
            [
                settings.rateLimiting.maxMessagesPerWindow,
                settings.rateLimiting.windowSizeMs,
                settings.rateLimiting.cooldownMs,
                settings.gemini.temperature,
                settings.gemini.maxOutputTokens,
                settings.gemini.timeout,
                settings.gemini.failureThreshold,
                settings.gemini.recoveryTimeMs,
                normalized
            ]
        );
    }

    async persistGlobalConversation(updatedBy = 'admin_api') {
        if (!mysqlService.isConfigured()) return false;

        await mysqlService.execute(
            `INSERT INTO global_conversation_config (
                id,
                max_history_messages,
                inactivity_timeout_ms,
                updated_by
            ) VALUES (1, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                max_history_messages = VALUES(max_history_messages),
                inactivity_timeout_ms = VALUES(inactivity_timeout_ms),
                updated_by = VALUES(updated_by)`,
            [
                Number(config.conversation.maxHistoryMessages || 20),
                Number(config.conversation.inactivityTimeoutMs || 7200000),
                updatedBy
            ]
        );

        return true;
    }

    touchUser(phone, userName = '') {
        const normalized = normalizePhone(phone);
        if (!normalized) return null;

        const now = Date.now();
        const current = this.users.get(normalized) || {
            phone: normalized,
            userName: '',
            firstSeenAt: now,
            lastSeenAt: now,
            messagesReceived: 0,
            messagesProcessed: 0,
            messagesFailed: 0,
            lastLatencyMs: 0,
            avgLatencyMs: 0,
            totalLatencyMs: 0
        };

        if (userName && userName.trim()) {
            current.userName = userName.trim();
        }

        current.lastSeenAt = now;
        this.users.set(normalized, current);
        this._schedulePersistUser(normalized);

        return current;
    }

    markMessageReceived(phone) {
        const user = this.touchUser(phone);
        if (user) {
            user.messagesReceived += 1;
            this._schedulePersistUser(phone);
        }
    }

    markMessageProcessed(phone, latencyMs = 0) {
        const user = this.touchUser(phone);
        if (!user) return;
        user.messagesProcessed += 1;
        if (Number.isFinite(latencyMs) && latencyMs > 0) {
            user.lastLatencyMs = latencyMs;
            user.totalLatencyMs += latencyMs;
            user.avgLatencyMs = Math.round(user.totalLatencyMs / user.messagesProcessed);
        }
        this._schedulePersistUser(phone);
    }

    markMessageFailed(phone) {
        const user = this.touchUser(phone);
        if (user) {
            user.messagesFailed += 1;
            this._schedulePersistUser(phone);
        }
    }

    listUsers() {
        return Array.from(this.users.values())
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .map((user) => ({
                ...user,
                settings: this.getUserSettings(user.phone)
            }));
    }

    getUserProfile(phone) {
        const normalized = normalizePhone(phone);
        return this.users.get(normalized) || null;
    }

    getUserSettings(phone) {
        const normalized = normalizePhone(phone);
        const defaults = this._defaultSettings();
        const override = this.overrides.get(normalized) || {};

        return {
            rateLimiting: {
                ...defaults.rateLimiting,
                ...(override.rateLimiting || {})
            },
            gemini: {
                ...defaults.gemini,
                ...(override.gemini || {})
            }
        };
    }

    upsertUserSettings(phone, payload = {}) {
        const normalized = normalizePhone(phone);
        if (!normalized) {
            throw new Error('Número de usuario inválido');
        }

        this.touchUser(normalized);

        const current = this.overrides.get(normalized) || {};
        const next = {
            ...current,
            rateLimiting: {
                ...(current.rateLimiting || {}),
                ...(payload.rateLimiting || {})
            },
            gemini: {
                ...(current.gemini || {}),
                ...(payload.gemini || {})
            }
        };

        this.overrides.set(normalized, next);

        return this._persistOverrideToDb(normalized)
            .then(() => this.getUserSettings(normalized));
    }

    clearUserSettings(phone) {
        const normalized = normalizePhone(phone);
        this.overrides.delete(normalized);
        if (mysqlService.isConfigured()) {
            mysqlService.execute(
                `DELETE c FROM user_runtime_config c
                 INNER JOIN users u ON c.user_id = u.id
                 WHERE u.phone = ?`,
                [normalized]
            ).catch((error) => {
                logger.error(`[USER SETTINGS] Error limpiando override de ${normalized}: ${error.message}`);
            });
        }
        return this.getUserSettings(normalized);
    }

    getDefaults() {
        return this._defaultSettings();
    }
}

module.exports = new UserSettingsService();
