const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { WhatsAppAPIError } = require('../utils/error_handler');

class WhatsAppService {
    constructor() {
        this.token = config.whatsapp.token;
        this.phoneNumberId = config.whatsapp.phoneNumberId;
        this.apiUrl = config.whatsapp.apiUrl;
        this.retryConfig = config.whatsapp.retry;

        // Instancia Axios reutilizable con keep-alive y headers pre-configurados
        this.client = axios.create({
            baseURL: `${this.apiUrl}/${this.phoneNumberId}`,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000 // 15s timeout por request
        });
    }

    /**
     * Envía un mensaje de texto simple
     */
    async sendMessage(to, text) {
        if (!this.token || !this.phoneNumberId) {
            logger.warn('[WHATSAPP] Token o Phone Number ID no configurado (modo simulación activo).');
            logger.info(`[WHATSAPP-SIMULADO] Para: ${to}\n[WHATSAPP-SIMULADO] Mensaje: ${text}`);
            return { simulated: true, messages: [{ id: 'simulated_id' }] };
        }

        const data = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            type: "text",
            text: { preview_url: false, body: text }
        };

        return this._sendWithRetry('/messages', data, to, 'texto');
    }

    /**
     * Marca un mensaje como leído (doble check azul)
     */
    async markAsRead(messageId) {
        if (!this.token || !this.phoneNumberId) return;

        try {
            await this.client.post('/messages', {
                messaging_product: "whatsapp",
                status: "read",
                message_id: messageId
            });
            logger.debug(`[WHATSAPP] Mensaje ${messageId} marcado como leído`);
        } catch (error) {
            logger.error(`[WHATSAPP] Error marcando mensaje como leído: ${error.message}`);
        }
    }

    async getMediaInfo(mediaId) {
        if (!mediaId) {
            throw new WhatsAppAPIError('Media ID no proporcionado');
        }

        if (!this.token) {
            throw new WhatsAppAPIError('Token de WhatsApp no configurado para descargar media');
        }

        try {
            const response = await axios.get(`${this.apiUrl}/${mediaId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                timeout: 15000
            });

            return response.data;
        } catch (error) {
            const detail = error.response ? JSON.stringify(error.response.data) : error.message;
            throw new WhatsAppAPIError(`No se pudo obtener metadata de media: ${detail}`, error);
        }
    }

    async downloadMediaAsBase64(mediaId) {
        const info = await this.getMediaInfo(mediaId);
        const mediaUrl = info?.url;
        if (!mediaUrl) {
            throw new WhatsAppAPIError('No se recibio URL de descarga para la media');
        }

        try {
            const response = await axios.get(mediaUrl, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                responseType: 'arraybuffer',
                timeout: 30000
            });

            const buffer = Buffer.from(response.data);
            return {
                base64: buffer.toString('base64'),
                mimeType: info?.mime_type || response.headers['content-type'] || 'image/jpeg',
                fileSizeBytes: Number(info?.file_size || buffer.length || 0),
                sha256: info?.sha256 || ''
            };
        } catch (error) {
            const detail = error.response ? JSON.stringify(error.response.data) : error.message;
            throw new WhatsAppAPIError(`No se pudo descargar media: ${detail}`, error);
        }
    }

    /**
     * Envía una petición con reintentos y backoff exponencial
     */
    async _sendWithRetry(endpoint, data, to, tipo) {
        let lastError;

        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = Math.min(
                        this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1),
                        this.retryConfig.maxDelayMs
                    );
                    logger.debug(`[WHATSAPP] Reintento ${attempt}/${this.retryConfig.maxRetries} en ${delay}ms...`);
                    await this._sleep(delay);
                }

                logger.debug(`[WHATSAPP] POST enviando ${tipo} a ${to}...`);
                const response = await this.client.post(endpoint, data);
                logger.info(`[WHATSAPP] ✓ Mensaje ${tipo} enviado a ${to} (ID: ${response.data.messages[0].id})`);
                return response.data;

            } catch (error) {
                lastError = error;
                const errorData = error.response ? JSON.stringify(error.response.data) : error.message;
                const statusCode = error.response?.status;

                // No reintentar errores 4xx (excepto 429 rate limit)
                if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
                    logger.error(`[WHATSAPP] Error ${statusCode} no reintentable enviando a ${to}: ${errorData}`);
                    metrics.increment('whatsappErrors');
                    metrics.recordError('whatsapp', `Error ${statusCode}: ${errorData}`, { phone: to, statusCode });
                    throw new WhatsAppAPIError(`Error ${statusCode}: ${errorData}`, error);
                }

                logger.warn(`[WHATSAPP] Intento ${attempt + 1} fallido enviando a ${to}: ${errorData}`);
            }
        }

        metrics.increment('whatsappErrors');
        metrics.recordError('whatsapp', `Falló después de ${this.retryConfig.maxRetries} reintentos`, { phone: to });
        throw new WhatsAppAPIError(`Falló después de ${this.retryConfig.maxRetries} reintentos`, lastError);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new WhatsAppService();
