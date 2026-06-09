const config = require('../../config');
const logger = require('../utils/logger');

// Lazy-load to avoid crash if not yet installed
let _bcrypt = null;
let _jwt = null;

function getBcrypt() {
    if (!_bcrypt) _bcrypt = require('bcryptjs');
    return _bcrypt;
}

function getJwt() {
    if (!_jwt) _jwt = require('jsonwebtoken');
    return _jwt;
}

const SALT_ROUNDS = 12;

/**
 * Verifica credenciales contra la tabla admin_users en MySQL.
 * Retorna el usuario si es válido, null si no.
 */
async function verifyCredentials(username, password) {
    const mysqlService = require('./mysql_service');
    if (!mysqlService.isConfigured()) {
        throw new Error('MySQL no configurado');
    }

    const rows = await mysqlService.query(
        `SELECT id, username, password_hash, display_name, role, is_active
         FROM admin_users WHERE username = ? LIMIT 1`,
        [username]
    );

    const user = rows[0];
    if (!user) return null;
    if (!user.is_active) return null;

    const match = await getBcrypt().compare(password, user.password_hash);
    if (!match) return null;

    // Actualizar last_login_at
    await mysqlService.query(
        `UPDATE admin_users SET last_login_at = NOW() WHERE id = ?`,
        [user.id]
    ).catch(err => logger.warn(`[AUTH] No se pudo actualizar last_login_at: ${err.message}`));

    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role
    };
}

/**
 * Genera un JWT firmado para el usuario autenticado.
 */
function generateToken(user) {
    const payload = {
        sub: user.id,
        username: user.username,
        role: user.role
    };

    return getJwt().sign(payload, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
        issuer: 'ia-buho'
    });
}

/**
 * Verifica y decodifica un JWT.
 * Retorna el payload si es válido, null si no.
 */
function verifyToken(token) {
    try {
        const jwt = getJwt();
        return jwt.verify(token, config.jwt.secret, { issuer: 'ia-buho' });
    } catch (err) {
        // If jsonwebtoken is not installed or token is invalid, return null gracefully
        return null;
    }
}

/**
 * Hashea una contraseña con bcrypt (para crear/actualizar admins).
 */
async function hashPassword(plainPassword) {
    return getBcrypt().hash(plainPassword, SALT_ROUNDS);
}

/**
 * Crea un usuario admin en la base de datos.
 * Usado por el endpoint de setup o seed script.
 */
async function createAdminUser(username, password, displayName = null, role = 'admin') {
    const mysqlService = require('./mysql_service');
    if (!mysqlService.isConfigured()) {
        throw new Error('MySQL no configurado');
    }

    const hash = await hashPassword(password);
    await mysqlService.query(
        `INSERT INTO admin_users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), display_name = VALUES(display_name), role = VALUES(role), updated_at = NOW()`,
        [username, hash, displayName, role]
    );

    logger.info(`[AUTH] Usuario admin creado/actualizado: ${username} (${role})`);
    return { username, displayName, role };
}

/**
 * Cambia la contraseña de un admin verificando la actual primero.
 */
async function changePassword(userId, currentPassword, newPassword) {
    const mysqlService = require('./mysql_service');
    if (!mysqlService.isConfigured()) {
        throw new Error('MySQL no configurado');
    }

    const rows = await mysqlService.query(
        `SELECT id, password_hash FROM admin_users WHERE id = ? AND is_active = 1 LIMIT 1`,
        [userId]
    );

    const user = rows[0];
    if (!user) throw new Error('Usuario no encontrado');

    const match = await getBcrypt().compare(currentPassword, user.password_hash);
    if (!match) throw new Error('Contraseña actual incorrecta');

    const newHash = await getBcrypt().hash(newPassword, SALT_ROUNDS);
    await mysqlService.query(
        `UPDATE admin_users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [newHash, userId]
    );

    logger.info(`[AUTH] Contraseña actualizada para userId=${userId}`);
    return true;
}

/**
 * Obtiene info del usuario admin por ID.
 */
async function getAdminUserById(userId) {
    const mysqlService = require('./mysql_service');
    if (!mysqlService.isConfigured()) return null;

    const rows = await mysqlService.query(
        `SELECT id, username, display_name, role, last_login_at, created_at FROM admin_users WHERE id = ? LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

module.exports = {
    verifyCredentials,
    generateToken,
    verifyToken,
    hashPassword,
    createAdminUser,
    changePassword,
    getAdminUserById
};
