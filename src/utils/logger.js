const winston = require('winston');
const path = require('path');

// Nivel de log configurable vía variable de entorno
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ level, message, timestamp, module, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]`;
        if (module) {
            log += ` [${module}]`;
        }
        log += `: ${message}`;
        if (meta && Object.keys(meta).length > 0 && !(meta instanceof Error)) {
            const cleaned = Object.fromEntries(
                Object.entries(meta).filter(([k]) => k !== 'splat')
            );
            if (Object.keys(cleaned).length > 0) {
                log += ` | ${JSON.stringify(cleaned)}`;
            }
        }
        return log;
    })
);

const logsDir = path.join(__dirname, '../../logs');

const logger = winston.createLogger({
    level: logLevel,
    format: logFormat,
    transports: [
        // Archivo de errores
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024, // 5MB por archivo
            maxFiles: 5,              // Mantener últimos 5 archivos
            tailable: true
        }),
        // Archivo general de la app
        new winston.transports.File({
            filename: path.join(logsDir, 'app.log'),
            maxsize: 10 * 1024 * 1024, // 10MB por archivo
            maxFiles: 5,
            tailable: true
        })
    ],
    // Handler para excepciones no capturadas
    exceptionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'exceptions.log'),
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3
        })
    ],
    // Handler para promesas rechazadas no manejadas
    rejectionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'rejections.log'),
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3
        })
    ]
});

// Log en consola si no está en producción
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            logFormat
        )
    }));
}

module.exports = logger;
