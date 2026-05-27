/**
 * security.js — Middleware de seguridad para validar webhooks de Meta
 * Verifica la firma HMAC-SHA256 del payload para asegurar autenticidad
 */

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { SecurityError } = require('../utils/error_handler');

/**
 * Middleware que valida la firma X-Hub-Signature-256 de Meta
 * Solo se activa si APP_SECRET está configurado en las variables de entorno
 */
function validateMetaSignature(req, res, next) {
    const appSecret = config.security.appSecret;

    // Si no hay APP_SECRET configurado, saltar validación (modo desarrollo)
    if (!appSecret) {
        logger.debug('[SECURITY] APP_SECRET no configurado — Validación de firma desactivada (modo desarrollo)');
        return next();
    }

    const signature = req.headers['x-hub-signature-256'];

    if (!signature) {
        metrics.increment('securityBlocked');
        logger.warn('[SECURITY] ❌ Petición rechazada: Falta header X-Hub-Signature-256');
        return res.status(401).json(new SecurityError('Firma de autenticación no proporcionada').toJSON());
    }

    // Necesitamos el raw body para verificar la firma
    const rawBody = req.rawBody;
    if (!rawBody) {
        logger.warn('[SECURITY] ⚠️ Raw body no disponible — No se puede verificar firma');
        return next(); // Continuar sin validar si no hay raw body
    }

    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

    const isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );

    if (!isValid) {
        metrics.increment('securityBlocked');
        logger.warn('[SECURITY] ❌ Petición rechazada: Firma HMAC-SHA256 inválida');
        return res.status(403).json(new SecurityError('Firma de autenticación inválida').toJSON());
    }

    logger.debug('[SECURITY] ✓ Firma HMAC-SHA256 verificada correctamente');
    next();
}

/**
 * Middleware para capturar el raw body necesario para la verificación de firma
 */
function captureRawBody(req, res, buf) {
    req.rawBody = buf.toString('utf8');
}

module.exports = {
    validateMetaSignature,
    captureRawBody
};
