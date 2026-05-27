/**
 * message_queue.js — Cola FIFO por usuario con concurrencia controlada
 * Garantiza que los mensajes de un mismo usuario se procesan en orden secuencial
 * mientras permite procesamiento paralelo entre usuarios distintos
 */

const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '../../data/runtime');
const DEDUP_FILE = path.join(RUNTIME_DIR, 'message_dedup.json');

class MessageQueue {
    constructor() {
        this.queues = new Map(); // phone -> { processing: boolean, items: [] }
        this.processedIds = new Map(); // messageId -> timestamp (deduplicación)
        this.maxDeduplicationAge = 300000; // 5 minutos
        this._dirty = false;
        this._persistTimer = null;

        this._hydrateFromDisk();

        // Limpieza de IDs procesados cada 5 minutos
        this.cleanupInterval = setInterval(() => this.cleanupProcessedIds(), 300000);
    }

    _ensureRuntimeDir() {
        if (!fs.existsSync(RUNTIME_DIR)) {
            fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        }
    }

    _hydrateFromDisk() {
        try {
            this._ensureRuntimeDir();
            if (!fs.existsSync(DEDUP_FILE)) return;

            const raw = fs.readFileSync(DEDUP_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            const ids = parsed && typeof parsed === 'object' && parsed.processedIds ? parsed.processedIds : {};
            const now = Date.now();

            for (const [messageId, timestamp] of Object.entries(ids)) {
                const ts = Number(timestamp);
                if (Number.isFinite(ts) && now - ts <= this.maxDeduplicationAge) {
                    this.processedIds.set(messageId, ts);
                }
            }
        } catch (error) {
            logger.warn(`[QUEUE] No se pudo hidratar deduplicacion persistida: ${error.message}`);
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
                logger.warn(`[QUEUE] Error en persistencia asincrona: ${error.message}`);
            });
        }, 600);
    }

    async _persistToDisk() {
        if (!this._dirty) return;

        try {
            this._ensureRuntimeDir();
            const payload = {
                processedIds: Object.fromEntries(this.processedIds.entries())
            };
            await fs.promises.writeFile(DEDUP_FILE, JSON.stringify(payload, null, 2), 'utf8');
            this._dirty = false;
        } catch (error) {
            logger.warn(`[QUEUE] No se pudo persistir deduplicacion: ${error.message}`);
        }
    }

    /**
     * Verifica si un mensaje ya fue procesado (duplicado)
     * @param {string} messageId - ID del mensaje de WhatsApp
     * @returns {boolean}
     */
    isDuplicate(messageId) {
        if (this.processedIds.has(messageId)) {
            logger.debug(`[QUEUE] Mensaje duplicado detectado: ${messageId}`);
            return true;
        }
        this.processedIds.set(messageId, Date.now());
        this._schedulePersist();
        return false;
    }

    /**
     * Encola un trabajo para un usuario y lo procesa cuando sea su turno
     * @param {string} userPhone - Número de teléfono
     * @param {Function} task - Función async que ejecuta el procesamiento
     * @returns {Promise<void>}
     */
    async enqueue(userPhone, task) {
        if (!this.queues.has(userPhone)) {
            this.queues.set(userPhone, { processing: false, items: [] });
        }

        const queue = this.queues.get(userPhone);

        return new Promise((resolve, reject) => {
            queue.items.push({ task, resolve, reject });

            logger.debug(`[QUEUE] Mensaje encolado para ${userPhone}. Pendientes: ${queue.items.length}`);

            // Si no está procesando, iniciar el procesamiento
            if (!queue.processing) {
                this.processQueue(userPhone);
            }
        });
    }

    /**
     * Procesa la cola de un usuario secuencialmente
     */
    async processQueue(userPhone) {
        const queue = this.queues.get(userPhone);
        if (!queue || queue.processing) return;

        queue.processing = true;

        while (queue.items.length > 0) {
            const { task, resolve, reject } = queue.items.shift();
            try {
                await task();
                resolve();
            } catch (error) {
                logger.error(`[QUEUE] Error procesando tarea para ${userPhone}: ${error.message}`);
                reject(error);
            }
        }

        queue.processing = false;

        // Limpiar colas vacías
        if (queue.items.length === 0) {
            this.queues.delete(userPhone);
        }
    }

    /**
     * Limpia IDs de deduplicación expirados
     */
    cleanupProcessedIds() {
        const now = Date.now();
        let cleaned = 0;

        for (const [id, timestamp] of this.processedIds.entries()) {
            if (now - timestamp > this.maxDeduplicationAge) {
                this.processedIds.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug(`[QUEUE] Limpieza: ${cleaned} IDs de deduplicación expirados`);
            this._schedulePersist();
        }
    }

    /**
     * Obtiene estadísticas de la cola
     */
    getStats() {
        let totalPending = 0;
        for (const [, queue] of this.queues.entries()) {
            totalPending += queue.items.length;
        }

        return {
            activeQueues: this.queues.size,
            totalPending,
            trackedMessageIds: this.processedIds.size
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

module.exports = new MessageQueue();
