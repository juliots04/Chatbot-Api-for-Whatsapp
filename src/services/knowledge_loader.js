/**
 * knowledge_loader.js - Cargador dinamico de base de conocimiento desde JSON
 * Lee todos los archivos JSON del directorio data/knowledge/ y los combina
 * en un prompt de sistema para Gemini
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const KNOWLEDGE_DIR = path.join(__dirname, '../../data/knowledge');

class KnowledgeLoader {
    constructor() {
        this._cachedKnowledge = null;
        this._lastLoadTime = 0;
        this._cacheTTLMs = 60000; // Recargar cada 1 minuto
        this._cachedEntries = null;
        this._lastEntriesLoadTime = 0;
    }

    _normalizeText(text = '') {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s.-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _extractQueryTokens(query = '') {
        const stop = new Set([
            'el', 'la', 'los', 'las', 'de', 'del', 'y', 'o', 'u', 'un', 'una', 'por', 'para', 'con', 'sin',
            'quiero', 'necesito', 'sobre', 'info', 'informacion', 'dime', 'me', 'podrias', 'puedes', 'que',
            'cual', 'cuanto', 'precio', 'precios', 'plan', 'planes', 'producto', 'servicio', 'servicios',
            'venden', 'vendes', 'ofrecen', 'tienen', 'hola', 'ayuda'
        ]);

        return this._normalizeText(query)
            .split(' ')
            .filter((t) => t && t.length > 2 && !stop.has(t));
    }

    async _loadEntries() {
        const now = Date.now();
        if (this._cachedEntries && (now - this._lastEntriesLoadTime) < this._cacheTTLMs) {
            return this._cachedEntries;
        }

        if (!fs.existsSync(KNOWLEDGE_DIR)) {
            this._cachedEntries = [];
            this._lastEntriesLoadTime = now;
            return this._cachedEntries;
        }

        const files = (await fs.promises.readdir(KNOWLEDGE_DIR))
            .filter(f => f.endsWith('.json'))
            .sort((a, b) => a.localeCompare(b));

        const entries = [];
        for (const file of files) {
            try {
                const filePath = path.join(KNOWLEDGE_DIR, file);
                const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
                const sitio = String(data.sitio || file.replace('.json', '')).trim();
                const alias = file.replace('.json', '');
                const searchBlob = this._normalizeText([
                    sitio,
                    alias,
                    data.url || '',
                    data.descripcion_general || '',
                    Array.isArray(data.caracteristicas_clave)
                        ? data.caracteristicas_clave.map((c) => `${c.titulo || ''} ${c.descripcion || ''}`).join(' ')
                        : '',
                    Array.isArray(data.funcionalidades_detalladas)
                        ? data.funcionalidades_detalladas.join(' ')
                        : '',
                    Array.isArray(data.planes)
                        ? data.planes.map((p) => `${p.nombre || ''} ${p.codigo || ''} ${p.precio || ''}`).join(' ')
                        : ''
                ].join(' '));

                entries.push({
                    file,
                    alias,
                    sitio,
                    data,
                    searchBlob
                });
            } catch (error) {
                logger.error(`[KNOWLEDGE] Error leyendo entrada ${file}: ${error.message}`);
            }
        }

        this._cachedEntries = entries;
        this._lastEntriesLoadTime = now;
        return this._cachedEntries;
    }

    /**
     * Carga y combina todos los archivos JSON de conocimiento
     * en un string formateado para usar como prompt de sistema
     */
    async load() {
        const now = Date.now();

        // Usar cache si es reciente
        if (this._cachedKnowledge && (now - this._lastLoadTime) < this._cacheTTLMs) {
            return this._cachedKnowledge;
        }

        try {
            if (!fs.existsSync(KNOWLEDGE_DIR)) {
                logger.warn('[KNOWLEDGE] Directorio de conocimiento no encontrado. Usando conocimiento por defecto.');
                return this._getDefaultKnowledge();
            }

            const files = (await fs.promises.readdir(KNOWLEDGE_DIR)).filter(f => f.endsWith('.json'));

            if (files.length === 0) {
                logger.warn('[KNOWLEDGE] No hay archivos JSON de conocimiento. Usando conocimiento por defecto.');
                return this._getDefaultKnowledge();
            }

            let knowledgeText = 'Eres un agente virtual que atiende por WhatsApp. A continuacion tienes la base de conocimiento actualizada sobre cada producto:\n\n';

            for (const file of files) {
                try {
                    const filePath = path.join(KNOWLEDGE_DIR, file);
                    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
                    const productName = data.sitio || file.replace('.json', '');

                    knowledgeText += '=======================================\n';
                    knowledgeText += `PRODUCTO: ${productName}\n`;
                    knowledgeText += '=======================================\n';
                    knowledgeText += this._formatJSON(data);
                    knowledgeText += '\n\n';

                } catch (error) {
                    logger.error(`[KNOWLEDGE] Error leyendo ${file}: ${error.message}`);
                }
            }

            knowledgeText += this._getRules();

            this._cachedKnowledge = knowledgeText;
            this._lastLoadTime = now;

            logger.debug(`[KNOWLEDGE] Base de conocimiento cargada: ${files.length} fuentes, ${knowledgeText.length} caracteres`);
            return knowledgeText;

        } catch (error) {
            logger.error(`[KNOWLEDGE] Error cargando conocimiento: ${error.message}`);
            return this._getDefaultKnowledge();
        }
    }

    async getCatalogDigest() {
        try {
            const items = [];
            const entries = await this._loadEntries();
            for (const entry of entries) {
                const rawSummary = String(entry.data.descripcion_general || entry.data.descripcion || '').trim();
                const firstSentence = rawSummary.split('. ')[0]?.trim() || '';
                
                // Try to extract a starting price
                let startingPrice = '';
                if (Array.isArray(entry.data.planes) && entry.data.planes.length > 0) {
                    const firstPlan = entry.data.planes[0];
                    if (firstPlan.precio) {
                        startingPrice = ` - Desde: ${firstPlan.precio}`;
                    }
                }

                items.push({
                    name: entry.sitio,
                    source: entry.file,
                    summary: firstSentence + startingPrice
                });
            }

            return {
                total: items.length,
                items
            };
        } catch (error) {
            logger.error(`[KNOWLEDGE] Error armando catálogo: ${error.message}`);
            return { total: 0, items: [] };
        }
    }

    async findProductsByQuery(query = '', limit = 3) {
        const entries = await this._loadEntries();
        if (!entries.length) return [];

        const tokens = this._extractQueryTokens(query);
        if (!tokens.length) return [];

        const queryNorm = this._normalizeText(query);

        // Detectar señales geográficas en el query del usuario
        const peruSignals = ['sunat', 'peru', 'indecopi', 'soles', 's/'];
        const colombiaSignals = ['dian', 'colombia', 'radian', 'bancolombia', 'cop', 'pesos colombianos', 'nit'];
        const queryMentionsPeru = peruSignals.some(s => queryNorm.includes(s));
        const queryMentionsColombia = colombiaSignals.some(s => queryNorm.includes(s));

        const ranked = [];
        for (const entry of entries) {
            let score = 0;
            const sitioNorm = this._normalizeText(entry.sitio);
            const aliasNorm = this._normalizeText(entry.alias);

            // Keywords del JSON también contribuyen al score
            const entryKeywords = Array.isArray(entry.data?.keywords)
                ? entry.data.keywords.map(k => this._normalizeText(k))
                : [];

            for (const token of tokens) {
                if (sitioNorm === token) {
                    score += 15; // Exact match on name
                } else if (sitioNorm.includes(token)) {
                    score += 5;
                }
                
                if (aliasNorm === token) {
                    score += 10;
                } else if (aliasNorm.includes(token)) {
                    score += 4;
                }

                if (entry.searchBlob.includes(token)) score += 1;
                if (entryKeywords.some(kw => kw.includes(token))) score += 3;
            }

            // Penalización geográfica: si el usuario menciona un país,
            // penalizar fuertemente los productos del otro país
            if (score > 0) {
                const entryPais = this._normalizeText(entry.data?.pais_iso || '');
                const entryBlob = entry.searchBlob || '';
                const isPeruEntry = entryPais === 'pe' || peruSignals.some(s => entryBlob.includes(s));
                const isColombiaEntry = entryPais === 'co' || colombiaSignals.some(s => entryBlob.includes(s));

                if (queryMentionsPeru && isColombiaEntry && !queryMentionsColombia) {
                    score -= 25; // Penalizar producto colombiano cuando se busca Perú
                }
                if (queryMentionsColombia && isPeruEntry && !queryMentionsPeru) {
                    score -= 25; // Penalizar producto peruano cuando se busca Colombia
                }
            }

            if (score > 0) {
                ranked.push({
                    ...entry,
                    score
                });
            }
        }

        ranked.sort((a, b) => b.score - a.score);

        // Optimización RAG: Si el mejor resultado es muy superior a los demás, solo devolver ese.
        if (ranked.length > 1 && ranked[0].score >= ranked[1].score + 10) {
            return ranked.slice(0, 1);
        }

        return ranked.slice(0, Math.max(1, limit));
    }

    isColombiaEntry(entry = {}) {
        const blob = this._normalizeText([
            entry?.sitio || '',
            entry?.alias || '',
            entry?.data?.url || '',
            entry?.data?.descripcion_general || '',
            entry?.searchBlob || ''
        ].join(' '));

        return /(colombia|dian|radian|fastura-colombia|certificados-dian)/.test(blob);
    }

    async getColombiaPaymentProfile() {
        const entries = await this._loadEntries();
        for (const entry of entries) {
            if (!this.isColombiaEntry(entry)) continue;
            if (entry?.data?.pagos) {
                return {
                    ...entry.data.pagos,
                    fuente: entry.sitio,
                    correo_documentos: entry?.data?.canales_documentacion?.correo_documentos || ''
                };
            }
        }

        return null;
    }

    async getColombiaOperationalProfile() {
        const entries = await this._loadEntries();
        for (const entry of entries) {
            if (!this.isColombiaEntry(entry)) continue;

            const requisitos = Array.isArray(entry?.data?.requisitos_documentales)
                ? entry.data.requisitos_documentales
                : [];
            const tiempos = entry?.data?.tiempos_emision || null;
            const datosRegistro = Array.isArray(entry?.data?.datos_registro_cliente)
                ? entry.data.datos_registro_cliente
                : [];

            if (requisitos.length || tiempos || datosRegistro.length) {
                return {
                    requisitos_documentales: requisitos,
                    tiempos_emision: tiempos,
                    datos_registro_cliente: datosRegistro,
                    fuente: entry.sitio
                };
            }
        }

        return {
            requisitos_documentales: [],
            tiempos_emision: null,
            datos_registro_cliente: [],
            fuente: ''
        };
    }

    async getPaymentValidationProfiles() {
        const entries = await this._loadEntries();
        const profiles = [];

        for (const entry of entries) {
            const pagos = entry?.data?.pagos;
            if (!pagos) continue;

            const canales = entry?.data?.canales_documentacion || {};
            const pais = this.isColombiaEntry(entry) ? 'CO' : 'PE';

            profiles.push({
                producto: entry.sitio,
                alias: entry.alias,
                pais,
                pagos,
                canales_documentacion: canales
            });
        }

        return profiles;
    }

    /**
     * Formatea un objeto JSON en texto legible para el prompt
     */
    _formatJSON(data, indent = 0) {
        let text = '';
        const prefix = '  '.repeat(indent);

        for (const [key, value] of Object.entries(data)) {
            // Saltar campos internos de scraping
            if (['contenido_extraido', 'ultima_verificacion', 'nota_scraping'].includes(key)) continue;

            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

            if (typeof value === 'string') {
                text += `${prefix}- ${label}: ${value}\n`;
            } else if (typeof value === 'number') {
                text += `${prefix}- ${label}: ${value}\n`;
            } else if (typeof value === 'boolean') {
                text += `${prefix}- ${label}: ${value ? 'Si' : 'No'}\n`;
            } else if (Array.isArray(value)) {
                text += `${prefix}- ${label}:\n`;
                for (const item of value) {
                    if (typeof item === 'string') {
                        text += `${prefix}  - ${item}\n`;
                    } else if (typeof item === 'object') {
                        text += `${prefix}  -----\n`;
                        text += this._formatJSON(item, indent + 2);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                text += `${prefix}- ${label}:\n`;
                text += this._formatJSON(value, indent + 1);
            }
        }

        return text;
    }

    /**
     * Reglas del bot (siempre se agregan al final)
     */
    _getRules() {
        return `
- TUS REGLAS DE ORO PARA RESPONDER SIEMPRE:
- IDENTIDAD: Eres un agente virtual de atencion por WhatsApp.
- PRESENTACION: Si te presentas, usa "Soy tu agente virtual" y evita "asesor personal".
- EMPRESA: No digas "trabajo en Digital Buho" ni menciones la empresa a menos que el cliente lo pregunte de forma directa.
- Utiliza SOLO la informacion proporcionada en tu base de conocimiento.
- PROFESIONALISMO: Responde de forma servicial, clara y directa. Tono corporativo natural.
- TONO NATURAL Y CORPORATIVO: Escribe como un asesor ejecutivo por WhatsApp. Frases cortas y legibles.
- EVITA SALUDOS REPETITIVOS: No inicies siempre con "Hola" ni repitas el nombre del cliente en cada mensaje.
- USO DEL NOMBRE: Menciona el nombre del cliente solo al inicio o de forma ocasional. No lo repitas en mensajes seguidos.
- BREVEDAD SITUACIONAL: En saludos o respuestas sin pedido de info de producto, responde en 2-3 lineas. PERO cuando el cliente pide info de un producto, extiendete lo necesario para mostrar TODOS los planes y ciclos. La informacion comercial completa es PRIORITARIA sobre la brevedad.
- VE DIRECTO AL GRANO: No repitas toda la base de datos si el usuario hizo una pregunta ambigua.
- FORMATO WHATSAPP ESTRICTO: El asterisco (*) DEBE estar pegado a la palabra (ejemplo: *Hola* para negrita).
- RESTRICCION DE EMOJIS: Usa un tono profesional. NO uses emojis a menos que sea estrictamente necesario. Maximo 1 emoji por mensaje.
- AMBIGÜEDAD: Si el usuario dice algo ambiguo como 'historial?', 'hola', o 'ayuda', NO asumas que quiere comprar el último producto discutido. Preguntale amablemente a que se refiere.
- VINETAS LIMPIAS: NUNCA uses emojis como vinetas. Usa "- " y deja una linea entre items para buena lectura.
- NO ENUMERES TODO EL CATALOGO: Si preguntan algo general, sugiere 2 o 3 opciones relevantes, no todo.
- CATALOGO COMPLETO SOLO BAJO PEDIDO: Solo lista todo el catalogo si el cliente lo pide de forma explicita (ejemplo: "pasame todo", "quiero ver todo", "catalogo completo").
- RESPUESTA A NEGATIVAS: Si el cliente dice "no", "ninguno", "nada", "no gracias" o similar, responde corto y cierra sin insistir ni ofrecer todo el catalogo.
- NO PRESION COMERCIAL: Evita repreguntar varias veces seguidas para vender cuando el cliente ya rechazo.
- CERO MENTIRAS SOBRE VENTAS O DEMANDA: NUNCA afirmes que sabes cuales son los productos "mas solicitados", "mas vendidos" o "con mayor demanda".
- ALERTA DE PAGOS: NO des numeros de cuenta ni pidas depositos a menos que el cliente lo pida EXPLICITAMENTE con frases como "donde pago", "dame tu cuenta", "quiero comprarlo ya" o "numero de yape".
- Si el cliente pide los datos de cuenta o yape de forma directa, responde OBLIGATORIAMENTE con estos datos.
- Al finalizar cada respuesta, puedes incluir UNA pregunta breve y relevante solo si ayuda a avanzar; si el cliente ya cerro el tema, no preguntes.
- REGLA DE CERTIFICADOS (CRITICA): Si el cliente pregunta por "certificado digital", "certificado" o "firma digital" SIN especificar pais o entidad (SUNAT/DIAN), DEBES preguntarle si es para Peru (SUNAT) o Colombia (DIAN) ANTES de dar precios o requisitos. NUNCA mezcles precios, requisitos ni datos de pago de ambos paises en una misma respuesta.
- REGLA DE MONEDAS (CRITICA): Los precios en Soles (S/) son EXCLUSIVAMENTE para productos de Peru. Los precios en pesos colombianos (COP/$) son EXCLUSIVAMENTE para productos de Colombia. NUNCA des un precio en la moneda equivocada ni mezcles monedas de distintos paises.
- REGLA ANTI-ALUCINACION: Si no tienes el dato exacto (precio, ciclo, requisito), di "no tengo esa info confirmada en este momento" en lugar de inventar un dato. NUNCA inventes precios, descuentos ni condiciones que no esten en tu base de conocimiento.

Datos de Pago (DIGITAL BUHO S.A.C.):
*BCP* - Cuenta Corriente en Soles (S/)
- Numero: 191-2562765-0-13
- CCI: 002-19100-2562765-013-55
*YAPE:* 944 999 965
`;
    }

    /**
     * Conocimiento por defecto si no hay archivos JSON
     */
    _getDefaultKnowledge() {
        return `Eres un agente virtual de atencion al cliente.

Reglas:
- Se amable y usa formato WhatsApp.
- Para mas info, dirige al usuario a contactar por WhatsApp: +51 944 999 965.
`;
    }

    /**
     * Fuerza una recarga del conocimiento (invalida cache)
     */
    invalidateCache() {
        this._cachedKnowledge = null;
        this._lastLoadTime = 0;
        logger.info('[KNOWLEDGE] Cache de conocimiento invalidada');
    }

    /**
     * Obtiene estadisticas del loader
     */
    getStats() {
        const files = fs.existsSync(KNOWLEDGE_DIR)
            ? fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.json'))
            : [];

        return {
            totalSources: files.length,
            files,
            cacheActive: !!this._cachedKnowledge,
            lastLoadTime: this._lastLoadTime ? new Date(this._lastLoadTime).toISOString() : null,
            characterCount: this._cachedKnowledge ? this._cachedKnowledge.length : 0
        };
    }
}

module.exports = new KnowledgeLoader();
