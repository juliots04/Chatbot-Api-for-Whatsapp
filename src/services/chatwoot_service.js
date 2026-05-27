const axios = require('axios');
const logger = require('../utils/logger');

class ChatwootService {
    /**
     * Send a message to a specific Chatwoot conversation.
     * @param {string} baseUrl The Chatwoot base URL (ngrok URL)
     * @param {string} apiToken The Chatwoot API token
     * @param {string|number} accountId The Chatwoot account ID
     * @param {string|number} conversationId The Chatwoot conversation ID
     * @param {string} content The message text to send
     * @returns {Promise<Object>} Response from Chatwoot API
     */
    async sendMessage(baseUrl, apiToken, accountId, conversationId, content) {
        if (!baseUrl || !apiToken) {
            logger.warn('[CHATWOOT] baseUrl or apiToken not provided in request. Cannot send message.');
            return null;
        }

        try {
            const client = axios.create({
                baseURL: baseUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': apiToken
                }
            });

            const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
            const payload = {
                content: content,
                message_type: 'outgoing', // Representa un mensaje de la IA/Agente
                private: false
            };

            const response = await client.post(url, payload);
            logger.info(`[CHATWOOT] Message sent successfully to conversation ${conversationId}`);
            return response.data;
        } catch (error) {
            logger.error(`[CHATWOOT] Error sending message: ${error.message}`);
            if (error.response) {
                logger.error(`[CHATWOOT] Response data: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }
}

module.exports = new ChatwootService();
