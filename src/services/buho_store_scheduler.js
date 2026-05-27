const cron = require('node-cron');
const config = require('../../config');
const logger = require('../utils/logger');
const { runBuhoStoreScrape } = require('../../scrape_buho_store');

class BuhoStoreScheduler {
    constructor() {
        this.task = null;
        this.isRunning = false;
        this.isStopping = false;
        this.currentRunPromise = null;
    }

    _isValidTimezone(timezone) {
        try {
            Intl.DateTimeFormat('en-US', { timeZone: timezone });
            return true;
        } catch {
            return false;
        }
    }

    _describeSchedule(cronExpr, timezone) {
        if (cronExpr === '0 3 * * *' && timezone === 'America/Lima') {
            return 'todos los dias a las 03:00 hora Peru';
        }

        return `cron personalizado (${cronExpr}) en tz=${timezone}`;
    }

    start() {
        if (!config.buhoStoreScraper.enabled) {
            logger.info('[BUHO_STORE_SCHEDULER] Desactivado por configuracion (BUHO_STORE_SCRAPER_ENABLED=false).');
            return;
        }

        if (this.task) {
            return;
        }

        const cronExpr = config.buhoStoreScraper.cron;
        const timezone = config.buhoStoreScraper.timezone;

        if (!this._isValidTimezone(timezone)) {
            logger.error(`[BUHO_STORE_SCHEDULER] Zona horaria invalida: ${timezone}. Scheduler no iniciado.`);
            return;
        }

        if (!cron.validate(cronExpr)) {
            logger.error(`[BUHO_STORE_SCHEDULER] Cron invalido: ${cronExpr}. Scheduler no iniciado.`);
            return;
        }

        this.isStopping = false;

        this.task = cron.schedule(cronExpr, async () => {
            if (this.isStopping) {
                logger.warn('[BUHO_STORE_SCHEDULER] Ejecucion omitida: scheduler en proceso de detencion.');
                return;
            }

            if (this.isRunning) {
                logger.warn('[BUHO_STORE_SCHEDULER] Ejecucion omitida: el scraper anterior sigue en proceso.');
                return;
            }

            const run = async () => {
                const startTime = Date.now();
                this.isRunning = true;
                logger.info(`[BUHO_STORE_SCHEDULER] Iniciando scraping programado (${cronExpr}, tz=${timezone}).`);

                try {
                    await runBuhoStoreScrape();
                    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
                    logger.info(`[BUHO_STORE_SCHEDULER] Scraping programado completado en ${durationSec}s.`);
                } catch (error) {
                    logger.error(`[BUHO_STORE_SCHEDULER] Error en scraping programado: ${error.message}`);
                } finally {
                    this.isRunning = false;
                    this.currentRunPromise = null;
                }
            };

            this.currentRunPromise = run();
            await this.currentRunPromise;
        }, {
            timezone
        });

        logger.info(`[BUHO_STORE_SCHEDULER] Activo: ${this._describeSchedule(cronExpr, timezone)}.`);
    }

    stop() {
        this.isStopping = true;

        if (this.task) {
            this.task.stop();
            this.task.destroy();
            this.task = null;
            logger.info('[BUHO_STORE_SCHEDULER] Scheduler detenido.');
        }

        if (this.isRunning) {
            logger.warn('[BUHO_STORE_SCHEDULER] Hay una ejecucion en curso; se permitira que termine antes del cierre total.');
        }
    }
}

module.exports = new BuhoStoreScheduler();
