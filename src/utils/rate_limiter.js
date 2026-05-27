/**
 * rate_limiter.js — Sliding window rate limiter por usuario
 * Controla el flujo de mensajes para evitar abuso y saturación del bot
 */

const logger = require('./logger');
const config = require('../../config');
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '../../data/runtime');
const RATE_LIMITER_FILE = path.join(RUNTIME_DIR, 'rate_limiter_windows.json');

class RateLimiter {
    constructor() {
        this.windows = new Map(); // phone -> [timestamp, timestamp, ...]
        this.maxMessages = config.rateLimiting.maxMessagesPerWindow;
        this.windowSizeMs = config.rateLimiting.windowSizeMs;
        this.cooldownMs = config.rateLimiting.cooldownMs;
        this._dirty = false;
        this._persistTimer = null;

        this._hydrateFromDisk();

        // Limpieza periódica de ventanas expiradas cada 5 minutos
        this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
    }

    _ensureRuntimeDir() {
        if (!fs.existsSync(RUNTIME_DIR)) {
            fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        }
    }

    _hydrateFromDisk() {
        try {
            this._ensureRuntimeDir();
            if (!fs.existsSync(RATE_LIMITER_FILE)) return;

            const raw = fs.readFileSync(RATE_LIMITER_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            const entries = parsed && typeof parsed === 'object' && parsed.windows ? parsed.windows : {};
            const now = Date.now();

            for (const [phone, timestamps] of Object.entries(entries)) {
                if (!Array.isArray(timestamps)) continue;
                const active = timestamps
                    .map((v) => Number(v))
                    .filter((v) => Number.isFinite(v) && now - v < this.windowSizeMs);
                if (active.length) {
                    this.windows.set(phone, active);
                }
            }
        } catch (error) {
            logger.warn(`[RATE_LIMITER] No se pudo hidratar estado persistido: ${error.message}`);
        }
    }

    _schedulePersist() {
        this._dirty = true;
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
        }

        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persistToDisk().catch((error) => {
                logger.warn(`[RATE_LIMITER] Error en persistencia asincrona: ${error.message}`);
            });
        }, 600);
    }

    async _persistToDisk() {
        if (!this._dirty) return;

        try {
            this._ensureRuntimeDir();
            const payload = { windows: Object.fromEntries(this.windows.entries()) };
            await fs.promises.writeFile(RATE_LIMITER_FILE, JSON.stringify(payload, null, 2), 'utf8');
            this._dirty = false;
        } catch (error) {
            logger.warn(`[RATE_LIMITER] No se pudo persistir estado: ${error.message}`);
        }
    }

    /**
     * Verifica si un usuario puede enviar un mensaje
     * @param {string} userPhone - Número de teléfono del usuario
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    check(userPhone, userRateConfig = null) {
        const now = Date.now();
        const effectiveConfig = {
            maxMessagesPerWindow: userRateConfig?.maxMessagesPerWindow ?? this.maxMessages,
            windowSizeMs: userRateConfig?.windowSizeMs ?? this.windowSizeMs,
            cooldownMs: userRateConfig?.cooldownMs ?? this.cooldownMs
        };

        let timestamps = this.windows.get(userPhone) || [];

        // Filtrar solo los timestamps dentro de la ventana activa
        timestamps = timestamps.filter(ts => now - ts < effectiveConfig.windowSizeMs);

        if (timestamps.length >= effectiveConfig.maxMessagesPerWindow) {
            const oldestInWindow = timestamps[0];
            const retryAfterMs = effectiveConfig.windowSizeMs - (now - oldestInWindow);

            logger.warn(`[RATE_LIMITER] Usuario ${userPhone} excedió el límite: ${timestamps.length}/${effectiveConfig.maxMessagesPerWindow} mensajes en ventana`);

            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: Math.max(retryAfterMs, effectiveConfig.cooldownMs)
            };
        }

        // Registrar el timestamp del mensaje actual
        timestamps.push(now);
        this.windows.set(userPhone, timestamps);
        this._schedulePersist();

        const remaining = effectiveConfig.maxMessagesPerWindow - timestamps.length;
        logger.debug(`[RATE_LIMITER] ${userPhone}: ${timestamps.length}/${effectiveConfig.maxMessagesPerWindow} mensajes (quedan ${remaining})`);

        return {
            allowed: true,
            remaining,
            retryAfterMs: 0
        };
    }

    /**
     * Limpia ventanas expiradas para liberar memoria
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [phone, timestamps] of this.windows.entries()) {
            const active = timestamps.filter(ts => now - ts < this.windowSizeMs);
            if (active.length === 0) {
                this.windows.delete(phone);
                cleaned++;
            } else {
                this.windows.set(phone, active);
            }
        }

        if (cleaned > 0) {
            logger.debug(`[RATE_LIMITER] Limpieza: ${cleaned} ventanas expiradas eliminadas`);
            this._schedulePersist();
        }
    }

    /**
     * Obtiene estadísticas del rate limiter
     */
    getStats() {
        return {
            activeUsers: this.windows.size,
            config: {
                maxMessagesPerWindow: this.maxMessages,
                windowSizeMs: this.windowSizeMs
            }
        };
    }

    async destroy() {
        clearInterval(this.cleanupInterval);
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        await this._persistToDisk();
    }
}

module.exports = new RateLimiter();
