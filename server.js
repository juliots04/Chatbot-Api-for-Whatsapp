const fs = require('fs');
const path = require('path');

// Capturar errores de inicio y escribirlos a un archivo de log de fallos de forma síncrona
process.on('uncaughtException', (error) => {
    try {
        const logPath = path.join(__dirname, 'logs', 'crash.log');
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] CRITICAL CRASH:\n${error.stack || error}\n`);
    } catch (e) {
        console.error('Failed to write crash log:', e);
    }
    
    if (typeof logger !== 'undefined' && logger.error) {
        logger.error(`[CRITICAL] Excepción no capturada: ${error.stack || error}`);
    }
    
    if (typeof gracefulShutdown === 'function') {
        gracefulShutdown('uncaughtException');
    } else {
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason) => {
    try {
        const logPath = path.join(__dirname, 'logs', 'crash.log');
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] CRITICAL REJECTION:\n${reason?.stack || reason}\n`);
    } catch (e) {
        console.error('Failed to write crash log:', e);
    }
    
    if (typeof logger !== 'undefined' && logger.error) {
        logger.error(`[CRITICAL] Promesa rechazada no manejada: ${reason?.stack || reason}`);
    }
});

const express = require('express');
const config = require('./config');
const logger = require('./src/utils/logger');
const metrics = require('./src/utils/metrics');
const webhookRoutes = require('./src/handlers/webhook');
const chatwootWebhookRoutes = require('./src/handlers/chatwoot_webhook');
const adminApiRoutes = require('./src/handlers/admin_api');
const { validateMetaSignature, captureRawBody } = require('./src/middleware/security');
const { validateAdminApiToken, getAdminAuthMode } = require('./src/middleware/admin_auth');
const geminiService = require('./src/services/gemini_service');
const botHandler = require('./src/handlers/bot_handler');
const rateLimiter = require('./src/utils/rate_limiter');
const messageQueue = require('./src/utils/message_queue');
const mysqlService = require('./src/services/mysql_service');
const userSettingsService = require('./src/services/user_settings_service');
const buhoStoreScheduler = require('./src/services/buho_store_scheduler');
const metricsSnapshotService = require('./src/services/metrics_snapshot_service');

// Inicializar la aplicación Express
const app = express();

// Middleware para capturar raw body (necesario para validación de firma HMAC)
app.use(express.json({
    limit: '1mb',
    verify: captureRawBody
}));

// Servir archivos estáticos del panel de administración
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Middleware de seguridad — Validación de firma de Meta (solo en /webhook POST)
app.use('/webhook', (req, res, next) => {
    if (req.method === 'POST') {
        return validateMetaSignature(req, res, next);
    }
    next();
});

// Endpoint de Health Check con métricas del sistema
app.get('/health', (req, res) => {
    try {
        const report = metrics.getReport();
        report.services = {
            gemini: geminiService.getStats(),
            bot: botHandler.getStats(),
            rateLimiter: rateLimiter.getStats(),
            queue: messageQueue.getStats()
        };
        mysqlService.health()
            .then((mysqlStatus) => {
                report.services.mysql = mysqlStatus;
                res.json(report);
            })
            .catch((error) => {
                report.services.mysql = {
                    configured: false,
                    connected: false,
                    error: error.message,
                    lastConnectedAt: null
                };
                res.json(report);
            });
    } catch (error) {
        logger.error(`[HEALTH] Error generando reporte: ${error.message}`);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Auth endpoints (no requieren token previo)
const authService = require('./src/services/auth_service');

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Se requiere username y password' });
        }

        const user = await authService.verifyCredentials(username, password);
        if (!user) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const token = authService.generateToken(user);
        const config = require('./config');
        res.json({
            success: true,
            token,
            expiresIn: config.jwt.expiresIn,
            user: { username: user.username, displayName: user.displayName, role: user.role }
        });
    } catch (error) {
        logger.error(`[AUTH] Error en login: ${error.message}`);
        res.status(500).json({ error: 'Error interno de autenticación' });
    }
});

app.post('/api/auth/setup', async (req, res) => {
    try {
        const mysqlSvc = require('./src/services/mysql_service');
        if (!mysqlSvc.isConfigured()) {
            return res.status(503).json({ error: 'MySQL no configurado' });
        }

        const existing = await mysqlSvc.query('SELECT COUNT(*) AS cnt FROM admin_users');
        if (existing[0]?.cnt > 0) {
            return res.status(409).json({ error: 'Ya existe al menos un administrador' });
        }

        const { username, password, displayName } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Se requiere username y password' });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const user = await authService.createAdminUser(username, password, displayName || username, 'superadmin');
        const token = authService.generateToken({ id: 1, ...user });

        res.json({ success: true, token, user, message: 'Administrador creado exitosamente' });
    } catch (error) {
        logger.error(`[AUTH] Error en setup: ${error.message}`);
        res.status(500).json({ error: 'Error creando administrador' });
    }
});

// Auth endpoints that require JWT (validated inline)
app.get('/api/auth/me', validateAdminApiToken, async (req, res) => {
    try {
        const user = await authService.getAdminUserById(req.adminUser.sub);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                role: user.role,
                lastLoginAt: user.last_login_at,
                createdAt: user.created_at
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo perfil' });
    }
});

app.put('/api/auth/password', validateAdminApiToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Se requiere contraseña actual y nueva' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
        }

        await authService.changePassword(req.adminUser.sub, currentPassword, newPassword);
        res.json({ success: true, message: 'Contraseña actualizada correctamente' });
    } catch (error) {
        if (error.message === 'Contraseña actual incorrecta') {
            return res.status(403).json({ error: error.message });
        }
        logger.error(`[AUTH] Error cambiando password: ${error.message}`);
        res.status(500).json({ error: 'Error actualizando contraseña' });
    }
});

// API de administración (configuración en caliente)
app.use('/api', validateAdminApiToken, adminApiRoutes);

// Webhook routes
app.use('/webhook/chatwoot', chatwootWebhookRoutes);
app.use('/webhook', webhookRoutes);

// Iniciar servidor HTTP
const host = process.env.IP || '::';
const server = app.listen(config.port, host, () => {
    logger.info(`=======================================================`);
    logger.info(`🦉 Servidor ia-buho v2.0 iniciado en el puerto ${config.port} host ${host}`);
    logger.info(`⚙️  Entorno: ${config.nodeEnv}`);
    logger.info(`🌐 Panel:   / (Dashboard de administración)`);
    logger.info(`🔗 Webhook: /webhook (GET verificación / POST eventos)`);
    logger.info(`📊 Health:  /health (Métricas y estado del sistema)`);
    logger.info(`🔧 API:     /api/config (GET / PUT configuración)`);
    const adminAuth = getAdminAuthMode();
    if (adminAuth.enabled) {
        logger.info(`🔐 Admin API auth: ACTIVADA (${adminAuth.usingDevFallback ? 'token dev fallback' : 'token configurado'})`);
        if (adminAuth.usingDevFallback && adminAuth.fallbackToken) {
            logger.warn('🔐 Admin API token fallback activo (solo desarrollo).');
        }
    } else {
        logger.error('🔐 Admin API auth: DESACTIVADA por configuracion. La API /api respondera 503 hasta configurar ADMIN_API_TOKEN.');
    }
    logger.info(`🔑 API Keys Gemini configuradas: ${config.gemini.apiKeys.length}`);
    logger.info(`🛡️  Seguridad HMAC: ${config.security.appSecret ? 'ACTIVADA' : 'DESACTIVADA (modo desarrollo)'}`);
    logger.info(`⚡ Rate Limiting: ${config.rateLimiting.maxMessagesPerWindow} msgs/${config.rateLimiting.windowSizeMs / 1000}s`);
    (async () => {
        const connected = await mysqlService.connect();
        logger.info(`🗄️  MySQL: ${connected ? 'CONECTADO' : 'NO CONECTADO (revisa DB_*)'}`);

        if (connected) {
            await userSettingsService.initialize();
            await userSettingsService.persistGlobalConversation('server_bootstrap');
            await geminiService.hydrateKeyStatsFromDB();
            metricsSnapshotService.start();
        }

        buhoStoreScheduler.start();
    })().catch((error) => {
        logger.error(`[STARTUP] Error inicializando persistencia MySQL: ${error.message}`);
    });
    logger.info(`=======================================================`);
});

let isShuttingDown = false;
let shutdownForceTimer = null;

// ═══════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — Cierre limpio del servidor
// ═══════════════════════════════════════════════════════

function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn(`[SHUTDOWN] Señal ${signal} ignorada: cierre ya en progreso.`);
        return;
    }
    isShuttingDown = true;

    logger.info(`[SHUTDOWN] Señal ${signal} recibida. Iniciando cierre limpio...`);

    server.close(async () => {
        logger.info('[SHUTDOWN] Servidor HTTP cerrado.');

        try {
            buhoStoreScheduler.stop();
            metricsSnapshotService.stop();
            await rateLimiter.destroy();
            await messageQueue.destroy();
            metrics.destroy();
            await botHandler.destroy();
            await mysqlService.close();
            logger.info('[SHUTDOWN] Recursos limpiados correctamente.');
        } catch (error) {
            logger.error(`[SHUTDOWN] Error limpiando recursos: ${error.message}`);
        }

        if (shutdownForceTimer) {
            clearTimeout(shutdownForceTimer);
            shutdownForceTimer = null;
        }

        logger.info('[SHUTDOWN] ✓ Cierre limpio completado. Adiós. 🦉');
        process.exit(0);
    });

    shutdownForceTimer = setTimeout(() => {
        logger.error('[SHUTDOWN] Cierre forzado por timeout (10s).');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

