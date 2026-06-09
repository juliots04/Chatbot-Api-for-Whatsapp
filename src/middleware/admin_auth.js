const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');
const authService = require('../services/auth_service');

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
        return { enabled: true, usingDevFallback: false, method: 'jwt+legacy' };
    }

    const isProd = String(config.nodeEnv || '').toLowerCase() === 'production';
    const allowFallback = Boolean(config.admin?.allowDevFallbackToken);
    if (!isProd && allowFallback) {
        return { enabled: true, usingDevFallback: true, fallbackToken: DEV_FALLBACK_TOKEN, method: 'jwt+legacy' };
    }

    return { enabled: true, usingDevFallback: false, method: 'jwt' };
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
    const providedToken = _extractToken(req);

    if (!providedToken) {
        return res.status(401).json({ error: 'No autorizado: token requerido' });
    }

    // 1) Try JWT verification first
    const jwtPayload = authService.verifyToken(providedToken);
    if (jwtPayload) {
        req.adminUser = jwtPayload;
        return next();
    }

    // 2) Fallback: legacy static token (ADMIN_API_TOKEN / dev-admin-token)
    const expectedToken = _resolveExpectedToken();
    if (expectedToken && _safeEqual(providedToken, expectedToken)) {
        req.adminUser = { sub: 0, username: '_legacy_token', role: 'superadmin' };
        return next();
    }

    return res.status(403).json({ error: 'No autorizado: token inválido o expirado' });
}

module.exports = {
    validateAdminApiToken,
    getAdminAuthMode
};
