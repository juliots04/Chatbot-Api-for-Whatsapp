/**
 * metrics.js — Sistema de métricas y analíticas de rendimiento
 * Registra latencias, contadores y estadísticas del sistema en tiempo real
 */

class Metrics {
    constructor() {
        this.startTime = Date.now();
        this.counters = {
            messagesReceived: 0,
            messagesProcessed: 0,
            messagesFailed: 0,
            geminiCalls: 0,
            geminiErrors: 0,
            geminiKeyRotations: 0,
            whatsappMessagesSent: 0,
            whatsappErrors: 0,
            rateLimitHits: 0,
            duplicateMessages: 0,
            securityBlocked: 0
        };

        // Histograma de latencia de respuesta (en ms)
        this.responseLatencies = [];
        this.maxLatencySamples = 1000; // Mantener últimas 1000 muestras

        // Contadores por período (para calcular tasas)
        this.periodicCounters = {
            lastReset: Date.now(),
            messagesThisPeriod: 0
        };

        this.userStats = new Map();
        this.errorEvents = [];
        this.maxErrorEvents = 200;

        // Reset de contadores periódicos cada minuto
        this.periodicInterval = setInterval(() => this.resetPeriodic(), 60000);
    }

    ensureUser(phone, userName = '') {
        if (!phone) return null;
        const current = this.userStats.get(phone) || {
            phone,
            userName: '',
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            messagesReceived: 0,
            messagesProcessed: 0,
            messagesFailed: 0,
            totalLatencyMs: 0,
            avgLatencyMs: 0,
            lastLatencyMs: 0
        };

        if (userName && userName.trim()) {
            current.userName = userName.trim();
        }

        current.lastSeenAt = Date.now();
        this.userStats.set(phone, current);
        return current;
    }

    trackUserReceived(phone, userName = '') {
        const user = this.ensureUser(phone, userName);
        if (!user) return;
        user.messagesReceived += 1;
    }

    trackUserProcessed(phone, latencyMs = 0, userName = '') {
        const user = this.ensureUser(phone, userName);
        if (!user) return;
        user.messagesProcessed += 1;
        if (Number.isFinite(latencyMs) && latencyMs > 0) {
            user.lastLatencyMs = latencyMs;
            user.totalLatencyMs += latencyMs;
            user.avgLatencyMs = Math.round(user.totalLatencyMs / user.messagesProcessed);
        }
    }

    trackUserFailed(phone, userName = '') {
        const user = this.ensureUser(phone, userName);
        if (!user) return;
        user.messagesFailed += 1;
    }

    recordError(component, message, context = {}) {
        this.errorEvents.push({
            timestamp: Date.now(),
            component,
            message,
            context
        });

        if (this.errorEvents.length > this.maxErrorEvents) {
            this.errorEvents = this.errorEvents.slice(-this.maxErrorEvents);
        }
    }

    /**
     * Incrementa un contador específico
     */
    increment(counterName, amount = 1) {
        if (this.counters[counterName] !== undefined) {
            this.counters[counterName] += amount;
        }
    }

    /**
     * Registra una latencia de respuesta
     */
    recordLatency(latencyMs) {
        this.responseLatencies.push({
            value: latencyMs,
            timestamp: Date.now()
        });

        // Mantener solo las últimas N muestras
        if (this.responseLatencies.length > this.maxLatencySamples) {
            this.responseLatencies = this.responseLatencies.slice(-this.maxLatencySamples);
        }

        this.periodicCounters.messagesThisPeriod++;
    }

    /**
     * Calcula estadísticas de latencia
     */
    getLatencyStats() {
        if (this.responseLatencies.length === 0) {
            return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, count: 0 };
        }

        const values = this.responseLatencies.map(l => l.value).sort((a, b) => a - b);
        const sum = values.reduce((acc, v) => acc + v, 0);
        const len = values.length;

        return {
            avg: Math.round(sum / len),
            min: values[0],
            max: values[len - 1],
            p50: values[Math.floor(len * 0.5)],
            p95: values[Math.floor(len * 0.95)],
            p99: values[Math.floor(len * 0.99)],
            count: len
        };
    }

    resetPeriodic() {
        this.periodicCounters = {
            lastReset: Date.now(),
            messagesThisPeriod: 0
        };
    }

    getReliabilityStats() {
        const received = this.counters.messagesReceived || 0;
        const processed = this.counters.messagesProcessed || 0;
        const failed = this.counters.messagesFailed || 0;
        const successRate = received > 0 ? ((processed / received) * 100).toFixed(2) : '0.00';
        const failureRate = received > 0 ? ((failed / received) * 100).toFixed(2) : '0.00';

        return {
            successRate: Number(successRate),
            failureRate: Number(failureRate),
            received,
            processed,
            failed
        };
    }

    getTopUsers(limit = 10) {
        return Array.from(this.userStats.values())
            .sort((a, b) => b.messagesReceived - a.messagesReceived)
            .slice(0, limit)
            .map((u) => ({
                phone: u.phone,
                userName: u.userName || '',
                messagesReceived: u.messagesReceived,
                messagesProcessed: u.messagesProcessed,
                messagesFailed: u.messagesFailed,
                avgLatencyMs: u.avgLatencyMs,
                lastLatencyMs: u.lastLatencyMs,
                lastSeenAt: u.lastSeenAt
            }));
    }

    getRecentErrors(limit = 20) {
        return this.errorEvents
            .slice(-limit)
            .reverse()
            .map((e) => ({
                ...e,
                isoTime: new Date(e.timestamp).toISOString()
            }));
    }

    /**
     * Genera un reporte completo de métricas para el endpoint /health
     */
    getReport() {
        const uptimeMs = Date.now() - this.startTime;
        const uptimeHours = Math.round(uptimeMs / 3600000 * 100) / 100;
        const memUsage = process.memoryUsage();

        return {
            status: 'online',
            version: require('../../package.json').version,
            uptime: {
                ms: uptimeMs,
                hours: uptimeHours,
                human: this.formatUptime(uptimeMs)
            },
            memory: {
                rss: this.formatBytes(memUsage.rss),
                heapUsed: this.formatBytes(memUsage.heapUsed),
                heapTotal: this.formatBytes(memUsage.heapTotal),
                external: this.formatBytes(memUsage.external)
            },
            counters: { ...this.counters },
            latency: this.getLatencyStats(),
            throughput: {
                messagesPerMinute: this.periodicCounters.messagesThisPeriod,
                totalProcessed: this.counters.messagesProcessed
            },
            reliability: this.getReliabilityStats(),
            insights: {
                topUsers: this.getTopUsers(12),
                recentErrors: this.getRecentErrors(25),
                trackedUsers: this.userStats.size
            },
            timestamp: new Date().toISOString()
        };
    }

    formatUptime(ms) {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    formatBytes(bytes) {
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    destroy() {
        clearInterval(this.periodicInterval);
    }
}

module.exports = new Metrics();
