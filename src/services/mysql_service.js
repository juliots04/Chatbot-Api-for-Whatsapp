const mysql = require('mysql2/promise');
const config = require('../../config');
const logger = require('../utils/logger');

class MySQLService {
    constructor() {
        this.pool = null;
        this.lastError = null;
        this.lastConnectedAt = null;
    }

    isConfigured() {
        const db = config.mysql || {};
        return Boolean(db.host && db.user && db.database);
    }

    getConnectionConfig() {
        const db = config.mysql || {};
        return {
            host: db.host,
            port: db.port,
            user: db.user,
            password: db.password,
            database: db.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            charset: 'utf8mb4',
            timezone: 'Z',
            namedPlaceholders: true
        };
    }

    async connect() {
        if (!this.isConfigured()) {
            this.lastError = 'MySQL no configurado (DB_HOST, DB_USER, DB_NAME).';
            logger.warn('[MYSQL] Conexion omitida: faltan variables DB_HOST, DB_USER o DB_NAME.');
            return false;
        }

        if (this.pool) {
            return true;
        }

        try {
            this.pool = mysql.createPool(this.getConnectionConfig());
            await this.pool.query('SELECT 1 AS ok');
            this.lastConnectedAt = Date.now();
            this.lastError = null;
            logger.info('[MYSQL] Conexion establecida correctamente.');
            await this._ensureReportsTables();
            return true;
        } catch (error) {
            this.lastError = error.message;
            this.pool = null;
            logger.error(`[MYSQL] Error conectando: ${error.message}`);
            return false;
        }
    }

    async query(sql, params = []) {
        if (!this.pool) {
            const connected = await this.connect();
            if (!connected) {
                throw new Error(this.lastError || 'No hay conexion MySQL disponible.');
            }
        }

        try {
            const [rows] = await this.pool.query(sql, params);
            return rows;
        } catch (error) {
            this.lastError = error.message;
            throw error;
        }
    }

    async execute(sql, params = []) {
        if (!this.pool) {
            const connected = await this.connect();
            if (!connected) {
                throw new Error(this.lastError || 'No hay conexion MySQL disponible.');
            }
        }

        try {
            const [result] = await this.pool.execute(sql, params);
            return result;
        } catch (error) {
            this.lastError = error.message;
            throw error;
        }
    }

    async health() {
        if (!this.isConfigured()) {
            return {
                configured: false,
                connected: false,
                error: 'Variables DB_* no configuradas',
                lastConnectedAt: this.lastConnectedAt
            };
        }

        if (!this.pool) {
            return {
                configured: true,
                connected: false,
                error: this.lastError || 'Pool no inicializado',
                lastConnectedAt: this.lastConnectedAt
            };
        }

        try {
            await this.pool.query('SELECT 1 AS ok');
            return {
                configured: true,
                connected: true,
                error: null,
                lastConnectedAt: this.lastConnectedAt
            };
        } catch (error) {
            this.lastError = error.message;
            return {
                configured: true,
                connected: false,
                error: error.message,
                lastConnectedAt: this.lastConnectedAt
            };
        }
    }

    async _ensureReportsTables() {
        try {
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS conversation_insights (
                  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                  message_id BIGINT UNSIGNED NULL,
                  user_phone VARCHAR(32) NOT NULL,
                  user_name VARCHAR(120) NULL,
                  intent ENUM('greeting','question','purchase_interest','complaint','support','farewell','info_request','price_inquiry','other') NOT NULL DEFAULT 'other',
                  commercial_stage VARCHAR(40) NULL,
                  product_consulted VARCHAR(120) NULL,
                  outcome ENUM('purchased','just_asked','problem_reported','unresolved','redirected','ongoing','resolved') NOT NULL DEFAULT 'ongoing',
                  sentiment ENUM('positive','neutral','negative') NOT NULL DEFAULT 'neutral',
                  topic_summary VARCHAR(255) NULL,
                  user_message_preview VARCHAR(255) NULL,
                  confidence DECIMAL(3,2) NOT NULL DEFAULT 0.50,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (id),
                  KEY idx_insights_phone (user_phone),
                  KEY idx_insights_intent (intent),
                  KEY idx_insights_stage (commercial_stage),
                  KEY idx_insights_product (product_consulted),
                  KEY idx_insights_outcome (outcome),
                  KEY idx_insights_sentiment (sentiment),
                  KEY idx_insights_created (created_at)
                ) ENGINE=InnoDB
            `);
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS conversation_reports (
                  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                  session_id BIGINT UNSIGNED NULL,
                  user_phone VARCHAR(32) NOT NULL,
                  user_name VARCHAR(120) NULL,
                  primary_intent VARCHAR(40) NULL,
                  final_stage VARCHAR(40) NULL,
                  products_consulted JSON NULL,
                  final_outcome VARCHAR(40) NULL,
                  overall_sentiment VARCHAR(20) NULL,
                  topics JSON NULL,
                  message_count INT UNSIGNED NOT NULL DEFAULT 0,
                  duration_minutes INT UNSIGNED NOT NULL DEFAULT 0,
                  resolved TINYINT(1) NOT NULL DEFAULT 0,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (id),
                  KEY idx_reports_phone (user_phone),
                  KEY idx_reports_session (session_id),
                  KEY idx_reports_intent (primary_intent),
                  KEY idx_reports_outcome (final_outcome),
                  KEY idx_reports_sentiment (overall_sentiment),
                  KEY idx_reports_created (created_at)
                ) ENGINE=InnoDB
            `);
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS gemini_key_stats (
                  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                  key_slot INT UNSIGNED NOT NULL,
                  key_label VARCHAR(30) NOT NULL,
                  total_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
                  total_errors BIGINT UNSIGNED NOT NULL DEFAULT 0,
                  last_error VARCHAR(500) NULL,
                  last_error_at DATETIME NULL,
                  month_year VARCHAR(7) NOT NULL,
                  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (id),
                  UNIQUE KEY uq_key_month (key_slot, month_year)
                ) ENGINE=InnoDB
            `);
            logger.info('[MYSQL] Reports tables ensured.');
        } catch (error) {
            logger.warn(`[MYSQL] Error ensuring reports tables (non-fatal): ${error.message}`);
        }
    }

    async close() {
        if (!this.pool) return;

        try {
            await this.pool.end();
            logger.info('[MYSQL] Pool cerrado correctamente.');
        } catch (error) {
            logger.error(`[MYSQL] Error cerrando pool: ${error.message}`);
        } finally {
            this.pool = null;
        }
    }
}

module.exports = new MySQLService();
