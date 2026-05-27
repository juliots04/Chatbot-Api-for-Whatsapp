/**
 * error_handler.js — Clases de error personalizadas y handler centralizado
 * Proporciona errores semánticos para cada capa del sistema
 */

class AppError extends Error {
    constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR') {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.timestamp = new Date().toISOString();
        Error.captureStackTrace(this, this.constructor);
    }

    toJSON() {
        return {
            error: this.name,
            code: this.errorCode,
            message: this.message,
            timestamp: this.timestamp
        };
    }
}

class WhatsAppAPIError extends AppError {
    constructor(message, originalError = null) {
        super(message, 502, 'WHATSAPP_API_ERROR');
        this.originalError = originalError;
        this.provider = 'whatsapp';
    }
}

class GeminiAPIError extends AppError {
    constructor(message, keyIndex = -1, originalError = null) {
        super(message, 502, 'GEMINI_API_ERROR');
        this.keyIndex = keyIndex;
        this.originalError = originalError;
        this.provider = 'gemini';
    }
}

class RateLimitError extends AppError {
    constructor(userPhone, retryAfterMs = 60000) {
        super(`Rate limit excedido para ${userPhone}`, 429, 'RATE_LIMIT_EXCEEDED');
        this.userPhone = userPhone;
        this.retryAfterMs = retryAfterMs;
    }
}

class ValidationError extends AppError {
    constructor(message, field = null) {
        super(message, 400, 'VALIDATION_ERROR');
        this.field = field;
    }
}

class SecurityError extends AppError {
    constructor(message) {
        super(message, 403, 'SECURITY_ERROR');
    }
}

module.exports = {
    AppError,
    WhatsAppAPIError,
    GeminiAPIError,
    RateLimitError,
    ValidationError,
    SecurityError
};
