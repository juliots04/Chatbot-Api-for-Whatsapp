const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');

const DEV_FALLBACK_TOKEN = 'dev-admin-token';

function _resolveExpectedToken() {
    const configured = String(config.admin?.apiToken || '').trim();
    if (configured) return configured;

    const isProd = String(config.nodeEnv || '').toLowerCase() === 'production';
    const allowFallback = Boolean(config.admin?.allowDevFallbackToken);
    if (!isProd && allowFallback) {
        return DEV_FALLBACK_TOKEN;
    }

    return '';
}

function getAdminAuthMode() {
    const configured = String(config.admin?.apiToken || '').trim();
    if (configured) {
        return { enabled: true, usingDevFallback: false };
    }

    const isProd = String(config.nodeEnv || '').toLowerCase() === 'production';
    const allowFallback = Boolean(config.admin?.allowDevFallbackToken);
    if (!isProd && allowFallback) {
        return { enabled: true, usingDevFallback: true, fallbackToken: DEV_FALLBACK_TOKEN };
    }

    return { enabled: false, usingDevFallback: false };
}

function _extractToken(req) {
    const authHeader = String(req.headers?.authorization || '');
    if (/^Bearer\s+/i.test(authHeader)) {
        return authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    const xToken = String(req.headers?.['x-admin-token'] || '').trim();
    if (xToken) return xToken;

    return '';
}

function _safeEqual(a = '', b = '') {
    const aa = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
}

function validateAdminApiToken(req, res, next) {
    const expectedToken = _resolveExpectedToken();

    if (!expectedToken) {
        logger.error('[ADMIN AUTH] API administrativa deshabilitada: falta ADMIN_API_TOKEN en produccion o fallback no permitido.');
        return res.status(503).json({ error: 'API administrativa temporalmente no disponible' });
    }

    const providedToken = _extractToken(req);
    if (!providedToken) {
        return res.status(401).json({ error: 'No autorizado: token de administrador requerido' });
    }

    if (!_safeEqual(providedToken, expectedToken)) {
        return res.status(403).json({ error: 'No autorizado: token de administrador invalido' });
    }

    next();
}

module.exports = {
    validateAdminApiToken,
    getAdminAuthMode
};
