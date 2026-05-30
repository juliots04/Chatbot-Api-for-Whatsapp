require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    gemini: {
        apiKeys: [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY_4,
            process.env.GEMINI_API_KEY_5,
            process.env.GEMINI_API_KEY_6,
            process.env.GEMINI_API_KEY_7

        ].filter(Boolean),
        model: 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.3,
            topP: 0.9,
            maxOutputTokens: 2000
        },
        timeout: parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10), // Aumentado de 12s a 25s para que no corte respuestas
        totalTimeoutMs: parseInt(process.env.GEMINI_TOTAL_TIMEOUT_MS || '90000', 10), 
        maxAttemptsPerMessage: parseInt(process.env.GEMINI_MAX_ATTEMPTS || '4', 10), // Reducido a 4 para no tardar una eternidad intentando
        retryKnowledgePromptChars: parseInt(process.env.GEMINI_RETRY_KNOWLEDGE_CHARS || '7000', 10),
        initialHistoryWindow: parseInt(process.env.GEMINI_INITIAL_HISTORY_WINDOW || '10', 10),
        retryHistoryWindow: parseInt(process.env.GEMINI_RETRY_HISTORY_WINDOW || '4', 10),
        maxMessageCharsInHistory: parseInt(process.env.GEMINI_MAX_MESSAGE_CHARS_HISTORY || '900', 10),
        // 0 = sin recorte (preservar contexto completo)
        maxKnowledgePromptChars: parseInt(process.env.GEMINI_MAX_KNOWLEDGE_CHARS || '0', 10),
        circuitBreaker: {
            failureThreshold: 3,   // Fallos consecutivos antes de desactivar la key
            recoveryTimeMs: 120000 // 2 minutos antes de reintentar una key desactivada
        }
    },

    whatsapp: {
        token: process.env.WHATSAPP_TOKEN,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        verifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
        apiUrl: 'https://graph.facebook.com/v22.0',
        retry: {
            maxRetries: 3,
            baseDelayMs: 1000, // Backoff exponencial: 1s, 2s, 4s
            maxDelayMs: 8000
        }
    },

    rateLimiting: {
        maxMessagesPerWindow: 15, // Máximo de mensajes por ventana
        windowSizeMs: 60000,      // Ventana de 1 minuto
        cooldownMs: 10000         // Cooldown mínimo tras exceder el límite
    },

    security: {
        appSecret: process.env.META_APP_SECRET || null
    },

    admin: {
        apiToken: String(process.env.ADMIN_API_TOKEN || '').trim(),
        allowDevFallbackToken: process.env.ADMIN_API_ALLOW_DEV_FALLBACK !== 'false'
    },

    conversation: {
        maxHistoryMessages: 20,    // Máximo de mensajes en el historial
        inactivityTimeoutMs: 7200000 // 2 horas de inactividad para limpiar contexto
    },

    mysql: {
        host: process.env.DB_HOST || '',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || '',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || ''
    },

    scraper: {
        schedule: process.env.SCRAPER_SCHEDULE || 'manual' // 'manual', 'daily', 'weekly'
    },

    buhoStoreScraper: {
        enabled: process.env.BUHO_STORE_SCRAPER_ENABLED !== 'false',
        cron: process.env.BUHO_STORE_SCRAPER_CRON || '0 3 * * *',
        timezone: process.env.BUHO_STORE_SCRAPER_TZ || 'America/Lima'
    }
};
