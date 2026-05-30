/**
 * scraper_service.js — Servicio de web scraping con programación configurable
 * Extrae contenido de URLs configuradas y lo convierte en JSON estructurado
 * usando Gemini como motor de extracción inteligente de información
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const DATA_DIR = path.join(__dirname, '../../data/knowledge');
const SOURCES_FILE = path.join(__dirname, '../../data/scraper_sources.json');

class ScraperService {
    constructor() {
        this.schedulerInterval = null;
        this.isRunning = false;
        this.lastRunResults = [];
        this.lastRunTime = null;

        // Asegurar que el directorio de datos exista
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        // Iniciar scheduler si está configurado
        this._startScheduler();
    }

    /**
     * Obtiene las fuentes configuradas
     */
    getSources() {
        try {
            if (!fs.existsSync(SOURCES_FILE)) {
                return [];
            }
            const data = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf-8'));
            return data.sources || [];
        } catch (error) {
            logger.error(`[SCRAPER] Error leyendo fuentes: ${error.message}`);
            return [];
        }
    }

    /**
     * Guarda las fuentes configuradas
     */
    saveSources(sources) {
        try {
            fs.writeFileSync(SOURCES_FILE, JSON.stringify({ sources }, null, 2), 'utf-8');
            logger.info(`[SCRAPER] Fuentes guardadas: ${sources.length} fuentes`);
        } catch (error) {
            logger.error(`[SCRAPER] Error guardando fuentes: ${error.message}`);
            throw error;
        }
    }

    /**
     * Agrega una nueva fuente de scraping
     */
    addSource(source) {
        const sources = this.getSources();
        const id = source.id || source.name.toLowerCase().replace(/[^a-z0-9]/g, '_');

        if (sources.find(s => s.id === id)) {
            throw new Error(`Ya existe una fuente con ID "${id}"`);
        }

        sources.push({
            id,
            name: source.name,
            url: source.url,
            outputFile: `${id}.json`,
            enabled: source.enabled !== false,
            description: source.description || ''
        });

        this.saveSources(sources);
        return sources;
    }

    /**
     * Elimina una fuente de scraping
     */
    removeSource(sourceId) {
        let sources = this.getSources();
        sources = sources.filter(s => s.id !== sourceId);
        this.saveSources(sources);
        return sources;
    }

    /**
     * Activa o desactiva una fuente
     */
    toggleSource(sourceId, enabled) {
        const sources = this.getSources();
        const source = sources.find(s => s.id === sourceId);
        if (source) {
            source.enabled = enabled;
            this.saveSources(sources);
        }
        return sources;
    }

    /**
     * Ejecuta el scraping de todas las fuentes activas
     */
    async scrapeAll() {
        if (this.isRunning) {
            logger.warn('[SCRAPER] Ya hay un scraping en ejecución. Esperando...');
            return { status: 'already_running' };
        }

        this.isRunning = true;
        const sources = this.getSources().filter(s => s.enabled);
        const results = [];

        logger.info(`[SCRAPER] 🕷️ Iniciando scraping de ${sources.length} fuentes...`);

        for (const source of sources) {
            try {
                const result = await this._scrapeSource(source);
                results.push(result);
            } catch (error) {
                results.push({
                    id: source.id,
                    name: source.name,
                    url: source.url,
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }

        this.isRunning = false;
        this.lastRunResults = results;
        this.lastRunTime = new Date().toISOString();

        const succeeded = results.filter(r => r.status === 'success').length;
        const failed = results.filter(r => r.status === 'error').length;
        logger.info(`[SCRAPER] ✓ Scraping completado: ${succeeded} exitosos, ${failed} fallidos`);

        return { results, timestamp: this.lastRunTime };
    }

    /**
     * Ejecuta el scraping de una fuente específica
     */
    async scrapeSingle(sourceId) {
        const sources = this.getSources();
        const source = sources.find(s => s.id === sourceId);

        if (!source) {
            throw new Error(`Fuente no encontrada: ${sourceId}`);
        }

        return this._scrapeSource(source);
    }

    /**
     * Scraping interno de una sola fuente
     */
    async _scrapeSource(source) {
        const startTime = Date.now();
        logger.info(`[SCRAPER] Scrapeando: ${source.name} (${source.url})`);

        try {
            // Obtener el HTML de la página
            const response = await axios.get(source.url, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8'
                }
            });

            const html = response.data;

            // Extraer texto relevante del HTML (limpiar tags, scripts, styles)
            const textContent = this._extractText(html);

            if (textContent.length < 50) {
                logger.warn(`[SCRAPER] ${source.name}: Contenido muy corto (${textContent.length} chars). El sitio posiblemente es una SPA que requiere JavaScript.`);

                // Si ya existe un archivo JSON previo, mantenerlo
                const existingFile = path.join(DATA_DIR, source.outputFile);
                if (fs.existsSync(existingFile)) {
                    // Actualizar solo la fecha de verificación
                    const existing = JSON.parse(fs.readFileSync(existingFile, 'utf-8'));
                    existing.ultima_verificacion = new Date().toISOString();
                    existing.nota_scraping = 'Sitio SPA — contenido no accesible via scraping HTTP estándar. Los datos se mantienen de la última actualización manual.';
                    fs.writeFileSync(existingFile, JSON.stringify(existing, null, 2), 'utf-8');
                }

                return {
                    id: source.id,
                    name: source.name,
                    url: source.url,
                    status: 'success',
                    note: 'SPA detectada — datos previos mantenidos',
                    contentLength: textContent.length,
                    latencyMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                };
            }

            // Actualizar el archivo JSON con el nuevo contenido extraído
            const outputPath = path.join(DATA_DIR, source.outputFile);
            let existingData = {};

            if (fs.existsSync(outputPath)) {
                try {
                    existingData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
                } catch (e) {
                    existingData = {};
                }
            }

            // Inteligencia: Usar Gemini para extraer información estructurada del HTML
            let extractedJson = null;
            if (config.gemini && config.gemini.apiKeys && config.gemini.apiKeys.length > 0) {
                try {
                    logger.info(`[SCRAPER] Solicitando a Gemini extracción estructurada para ${source.name}...`);
                    const genAI = new GoogleGenerativeAI(config.gemini.apiKeys[0]);
                    const model = genAI.getGenerativeModel({ model: config.gemini.model || 'gemini-2.5-flash' });
                    
                    const prompt = `Analiza el siguiente contenido extraído de la web de ${source.name}.
Extrae la información más importante y devuélvela estrictamente como un objeto JSON válido con la siguiente estructura (omite markdown y cualquier texto adicional, solo el JSON):
{
  "descripcion_general": "Breve resumen de qué es y para qué sirve",
  "caracteristicas_clave": [ {"titulo": "...", "descripcion": "..."} ],
  "planes": [ {"nombre": "...", "precio": "...", "descripcion": "...", "incluye": ["..."], "no_incluye": ["..."]} ],
  "contacto": { "whatsapp": "...", "web": "...", "empresa": "..." }
}

Contenido web extraído:
${textContent.substring(0, 15000)}`;

                    const result = await model.generateContent(prompt);
                    const responseText = result.response.text();
                    
                    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
                    extractedJson = JSON.parse(cleanedText);
                    logger.info(`[SCRAPER] ✓ Extracción estructurada automatizada exitosa para ${source.name}`);
                } catch (err) {
                    logger.warn(`[SCRAPER] Error extrayendo info estructurada con Gemini para ${source.name}: ${err.message}`);
                }
            }

            // Actualizar metadata de scraping
            existingData.ultima_actualizacion = new Date().toISOString();
            existingData.contenido_extraido = textContent.substring(0, 15000); // Guardar texto limpio ampliado
            existingData.url = source.url;
            existingData.sitio = existingData.sitio || source.name;

            // Merge de datos extraídos por la IA
            if (extractedJson) {
                if (extractedJson.descripcion_general) existingData.descripcion_general = extractedJson.descripcion_general;
                if (extractedJson.caracteristicas_clave && extractedJson.caracteristicas_clave.length > 0) existingData.caracteristicas_clave = extractedJson.caracteristicas_clave;
                if (extractedJson.planes && extractedJson.planes.length > 0) existingData.planes = extractedJson.planes;
                if (extractedJson.contacto) existingData.contacto = { ...existingData.contacto, ...extractedJson.contacto };
            }

            fs.writeFileSync(outputPath, JSON.stringify(existingData, null, 2), 'utf-8');

            const latency = Date.now() - startTime;
            logger.info(`[SCRAPER] ✓ ${source.name} completado en ${latency}ms (${textContent.length} chars extraídos)`);

            return {
                id: source.id,
                name: source.name,
                url: source.url,
                status: 'success',
                contentLength: textContent.length,
                latencyMs: latency,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            logger.error(`[SCRAPER] ❌ Error scrapeando ${source.name}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extrae texto legible del HTML eliminando tags, scripts, styles
     */
    _extractText(html) {
        let text = html;

        // Eliminar scripts y styles
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

        // Convertir <br>, <p>, <div>, <li> a saltos de línea
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, '\n');

        // Eliminar todas las tags HTML restantes
        text = text.replace(/<[^>]+>/g, ' ');

        // Decodificar entidades HTML comunes
        text = text.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');

        // Limpiar espacios múltiples y líneas vacías
        text = text.replace(/[ \t]+/g, ' ');
        text = text.replace(/\n\s*\n/g, '\n');
        text = text.trim();

        return text;
    }

    /**
     * Inicia el scheduler para scraping automático
     */
    _startScheduler() {
        this._stopScheduler();

        const scheduleMode = config.scraper.schedule;
        let intervalMs = null;

        switch (scheduleMode) {
            case 'daily':
                intervalMs = 24 * 60 * 60 * 1000; // 24 horas
                break;
            case 'weekly':
                intervalMs = 7 * 24 * 60 * 60 * 1000; // 7 días
                break;
            case 'manual':
            default:
                logger.info('[SCRAPER] Modo de scraping: MANUAL (sin programación automática)');
                return;
        }

        logger.info(`[SCRAPER] Scheduler configurado: ${scheduleMode} (cada ${intervalMs / 3600000}h)`);

        this.schedulerInterval = setInterval(async () => {
            logger.info(`[SCRAPER] ⏰ Scraping programado (${scheduleMode}) iniciando...`);
            try {
                await this.scrapeAll();
            } catch (error) {
                logger.error(`[SCRAPER] Error en scraping programado: ${error.message}`);
            }
        }, intervalMs);
    }

    _stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
        }
    }

    /**
     * Cambia el modo del scheduler
     */
    setSchedule(mode) {
        config.scraper.schedule = mode;
        this._startScheduler();
        return { schedule: mode };
    }

    /**
     * Obtiene estadísticas del scraper
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            schedule: config.scraper.schedule,
            sources: this.getSources().length,
            enabledSources: this.getSources().filter(s => s.enabled).length,
            lastRunTime: this.lastRunTime,
            lastRunResults: this.lastRunResults
        };
    }

    destroy() {
        this._stopScheduler();
    }
}

module.exports = new ScraperService();
