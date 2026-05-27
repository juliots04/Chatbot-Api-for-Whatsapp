const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 horas

class MetricsSnapshotService {
    constructor() {
        this._timer = null;
        this._cleanupTimer = null;
    }

    start() {
        const mysqlService = require('./mysql_service');
        if (!mysqlService.isConfigured()) {
            logger.info('[METRICS_SNAPSHOT] MySQL no configurado, snapshots desactivados.');
            return;
        }

        logger.info(`[METRICS_SNAPSHOT] Persistencia activa cada ${SNAPSHOT_INTERVAL_MS / 1000}s.`);
        this._timer = setInterval(() => this._saveSnapshot(), SNAPSHOT_INTERVAL_MS);

        // Primer snapshot tras 30s de arranque
        setTimeout(() => this._saveSnapshot(), 30000);

        // Cleanup diario (datos > 1 mes)
        this._cleanupTimer = setInterval(() => this._cleanupOldData(), CLEANUP_INTERVAL_MS);
        // Primera limpieza tras 2 min de arranque
        setTimeout(() => this._cleanupOldData(), 120000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }

    async _cleanupOldData() {
        const mysqlService = require('./mysql_service');
        if (!mysqlService.isConfigured()) return;

        try {
            const tables = [
                'metrics_snapshots',
                'gemini_token_usage',
                'system_events'
            ];
            for (const table of tables) {
                await mysqlService.execute(
                    `DELETE FROM ${table} WHERE created_at < NOW() - INTERVAL 1 MONTH`
                );
            }
            logger.info('[METRICS_SNAPSHOT] Limpieza mensual completada.');
        } catch (error) {
            logger.error(`[METRICS_SNAPSHOT] Error en limpieza mensual: ${error.message}`);
        }
    }

    async _saveSnapshot() {
        const mysqlService = require('./mysql_service');
        if (!mysqlService.isConfigured()) return;

        try {
            const report = metrics.getReport();

            await mysqlService.execute(
                `INSERT INTO metrics_snapshots (
                    status, uptime_ms,
                    messages_received, messages_processed, messages_failed,
                    gemini_calls, gemini_errors, gemini_key_rotations,
                    whatsapp_messages_sent, whatsapp_errors,
                    rate_limit_hits, duplicate_messages, security_blocked,
                    latency_avg_ms, latency_p50_ms, latency_p95_ms, latency_p99_ms,
                    throughput_messages_per_minute, active_conversations,
                    heap_used_mb, heap_total_mb,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    report.status || 'online',
                    report.uptime?.ms || 0,
                    report.counters?.messagesReceived || 0,
                    report.counters?.messagesProcessed || 0,
                    report.counters?.messagesFailed || 0,
                    report.counters?.geminiCalls || 0,
                    report.counters?.geminiErrors || 0,
                    report.counters?.geminiKeyRotations || 0,
                    report.counters?.whatsappMessagesSent || 0,
                    report.counters?.whatsappErrors || 0,
                    report.counters?.rateLimitHits || 0,
                    report.counters?.duplicateMessages || 0,
                    report.counters?.securityBlocked || 0,
                    report.latency?.avg || 0,
                    report.latency?.p50 || 0,
                    report.latency?.p95 || 0,
                    report.latency?.p99 || 0,
                    report.throughput?.messagesPerMinute || 0,
                    report.insights?.trackedUsers || 0,
                    this._parseHeapMb(report.memory?.heapUsed),
                    this._parseHeapMb(report.memory?.heapTotal)
                ]
            );

            logger.debug('[METRICS_SNAPSHOT] Snapshot guardado en MySQL.');
        } catch (error) {
            logger.error(`[METRICS_SNAPSHOT] Error guardando snapshot: ${error.message}`);
        }
    }

    _parseHeapMb(heapStr) {
        if (!heapStr) return 0;
        const match = String(heapStr).match(/([\d.]+)/);
        return match ? parseFloat(match[1]) : 0;
    }
}

module.exports = new MetricsSnapshotService();
