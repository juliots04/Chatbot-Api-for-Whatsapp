/**
 * scrape_buho_store.js — Scraper para productos de buho.la/store
 * Extrae información de las páginas de productos y actualiza los JSON en data/knowledge/
 * 
 * Uso: node scrape_buho_store.js
 * 
 * Requiere: axios, cheerio
 * Instalar: npm install cheerio
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
let playwright = null;

const KNOWLEDGE_DIR = path.join(__dirname, 'data', 'knowledge');

function cleanText(value = '') {
    return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeKey(value = '') {
    return cleanText(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

function extractSlug(value = '') {
    if (!value) return '';
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        return normalizeKey(parts[parts.length - 1] || '');
    } catch {
        const parts = String(value).split('/').filter(Boolean);
        return normalizeKey(parts[parts.length - 1] || '');
    }
}

function extractBasePrice(value = '') {
    const text = cleanText(value);
    if (/gratis|free/i.test(text)) {
        return 'Gratis';
    }
    const match = text.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*/i);
    return match ? cleanText(match[0]) : text;
}

function extractAmountLikePrice(value = '') {
    const text = cleanText(value);
    if (!text) return '';
    const match = text.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?/i);
    return match ? cleanText(match[0]) : '';
}

function parsePriceNumber(value = '') {
    const text = cleanText(value);
    const m = text.match(/(\d[\d.,]*)/);
    if (!m) return null;
    const normalized = m[1].replace(/,/g, '');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

function isFreePrice(value = '') {
    const text = cleanText(value);
    if (!text) return false;
    if (/gratis|free/i.test(text)) return true;
    const num = parsePriceNumber(text);
    return num === 0;
}

function formatPen(value) {
    if (!Number.isFinite(value)) return '';
    const hasDecimals = Math.abs(value % 1) > 0;
    return hasDecimals ? `S/${value.toFixed(2)} PEN` : `S/${value.toFixed(0)} PEN`;
}

function cycleNameFromMonths(months) {
    if (months === 1) return 'Mensual';
    if (months === 3) return 'Trimestral';
    if (months === 6) return 'Semi-Anual';
    if (months === 12) return 'Anual';
    return `${months} Meses`;
}

function cycleLabelByMonths(months) {
    if (months === 1) return '1 Mes';
    return `${months} Meses`;
}

function normalizeExtractedCycles(cycles = [], isFree = false) {
    if (!Array.isArray(cycles)) return [];
    const cleaned = mergeUniqueCycles(cycles)
        .map((c) => ({
            ciclo: normalizeCycleName(c.ciclo || ''),
            precio: cleanText(c.precio || ''),
            descuento: cleanText(c.descuento || ''),
            precio_original: cleanText(c.precio_original || '')
        }))
        .filter((c) => c.ciclo && c.precio);

    if (isFree) {
        return [{
            ciclo: 'Mensual',
            precio: 'Gratis',
            descuento: '',
            precio_original: ''
        }];
    }

    // Si vienen demasiados ciclos, suele ser señal de que tomó toda la tabla de planes.
    if (cleaned.length > 4) {
        return [];
    }

    return cleaned;
}

function shouldUseAnnualField(cycle = '') {
    return /anual|bianual|trienal/i.test(cycle) && !/semi-anual/i.test(cycle);
}

function shouldUseMonthlyField(cycle = '') {
    return /mensual/i.test(cycle);
}

function shouldUseSemiAnnualField(cycle = '') {
    return /semi-anual/i.test(cycle);
}

function shouldUseQuarterlyField(cycle = '') {
    return /trimestral/i.test(cycle);
}

function normalizeCycleName(value = '') {
    const text = cleanText(value);
    if (/mensual/i.test(text)) return 'Mensual';
    if (/trimestral/i.test(text)) return 'Trimestral';
    if (/semi-anual/i.test(text)) return 'Semi-Anual';
    if (/anual/i.test(text)) return 'Anual';
    if (/bianual/i.test(text)) return 'Bi-Anual';
    if (/trienal/i.test(text)) return 'Trienal';
    return text;
}

function parseCyclePriceText(text = '') {
    const flat = cleanText(text);
    const cycleMatch = flat.match(/Mensual|Trimestral|Semi-Anual|Anual|Bi-Anual|Trienal(?:mente)?/i);
    const priceMatch = flat.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?/i);
    const discountMatch = flat.match(/Ahorras?\s+el\s+\d+%|\d+%\s*(?:Dsto|Descuento|de ahorro)/i);
    const originalMatch = flat.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?\s*$/i);

    return {
        ciclo: normalizeCycleName(cycleMatch ? cycleMatch[0] : ''),
        precio: priceMatch ? cleanText(priceMatch[0]) : '',
        descuento: discountMatch ? cleanText(discountMatch[0]) : '',
        precio_original: discountMatch && originalMatch ? cleanText(originalMatch[0]) : ''
    };
}

function mergeUniqueCycles(cycles = []) {
    const seen = new Set();
    const merged = [];
    for (const c of cycles) {
        const key = `${normalizeKey(c.ciclo)}|${normalizeKey(c.precio)}|${normalizeKey(c.descuento)}|${normalizeKey(c.precio_original)}`;
        if (key !== '|||' && !seen.has(key)) {
            seen.add(key);
            merged.push(c);
        }
    }
    return merged;
}

function extractTokenHints(name = '') {
    const text = normalizeKey(name);
    const hints = [];
    if (text.includes('essential')) hints.push('essential');
    if (text.includes('priority')) hints.push('priority');
    if (text.includes('ilimitado')) hints.push('ilimitado');
    return hints;
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCyclesFromTextBlock(text = '') {
    const cycles = [];
    const cycleRegex = /(Mensual|Trimestral|Semi-Anual|Anual|Bi-Anual|Trienal(?:mente)?)\s*((?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?)(?:\s*Ahorras?\s*(?:el\s*)?(\d+%))?(?:\s*((?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?))?/gi;
    let m;
    while ((m = cycleRegex.exec(text)) !== null) {
        cycles.push({
            ciclo: normalizeCycleName(m[1]),
            precio: cleanText(m[2]),
            descuento: m[3] ? cleanText(m[3]) : '',
            precio_original: m[4] ? cleanText(m[4]) : ''
        });
    }
    return mergeUniqueCycles(cycles);
}

async function scrapePurchasePageWithBrowser(url, expectedPlanName = '') {
    try {
        if (!playwright) {
            playwright = require('playwright');
        }
    } catch (error) {
        console.log('   ⚠️  Playwright no está disponible para fallback de click real.');
        return null;
    }

    let browser;
    try {
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        const page = await context.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1200);

        let bodyText = cleanText(await page.textContent('body'));
        let isConfig = /configurar|elija ciclo|sumario de pedido|importe a la fecha/i.test(bodyText);

        // Si no llegó a Configurar, intenta clickear el botón Pedir Ahora del plan esperado.
        if (!isConfig) {
            const cards = page.locator('.package');
            const count = await cards.count();
            const expectedNorm = normalizeKey(expectedPlanName);

            for (let i = 0; i < count; i++) {
                const card = cards.nth(i);
                const cardText = normalizeKey(await card.innerText());
                if (!expectedNorm || cardText.includes(expectedNorm.substring(0, Math.min(expectedNorm.length, 12)))) {
                    const btn = card.locator('a.btn-order-now').first();
                    if (await btn.count()) {
                        await Promise.all([
                            page.waitForLoadState('domcontentloaded', { timeout: 45000 }),
                            btn.click({ timeout: 10000 })
                        ]);
                        await page.waitForTimeout(1200);
                        break;
                    }
                }
            }

            bodyText = cleanText(await page.textContent('body'));
            isConfig = /configurar|elija ciclo|sumario de pedido|importe a la fecha/i.test(bodyText);
        }

        if (!isConfig) {
            await context.close();
            return null;
        }

        const cycleSectionMatch = bodyText.match(/Elija Ciclo[\s\S]*?Sumario de Pedido/i);
        const cycleSection = cycleSectionMatch ? cycleSectionMatch[0] : bodyText;
        const billingCycles = extractCyclesFromTextBlock(cycleSection);

        const summary = await page.evaluate(() => {
            const result = {};
            const allText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
            const totalMatch = allText.match(/Importe a la Fecha\s*((?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?)/i);
            if (totalMatch) result.total = totalMatch[1].trim();
            return result;
        });

        await context.close();
        return { billingCycles, summary };
    } catch (error) {
        console.log(`   ⚠️  Fallback browser falló: ${error.message}`);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function scrapeCyclesByClickFromListing(listingUrl, expectedPlanName = '') {
    try {
        if (!playwright) {
            playwright = require('playwright');
        }
    } catch (error) {
        console.log('   ⚠️  Playwright no está disponible para click real en listado.');
        return null;
    }

    let browser;
    try {
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        const page = await context.newPage();

        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1200);

        const expectedNorm = normalizeKey(expectedPlanName);

        // Activar la pestaña según el plan para que el botón Pedir Ahora sea visible.
        if (expectedNorm.includes('api') || expectedNorm.includes('codigofuente')) {
            const apiTab = page.locator('.section-content-packages .nav-link[href*="api-y-codigo-fuente"]').first();
            if (await apiTab.count()) {
                await apiTab.click({ timeout: 8000 });
                await page.waitForTimeout(500);
            }
        } else if (expectedNorm.includes('reseller')) {
            const resellerTab = page.locator('.section-content-packages .nav-link[href*="planes-reseller"]').first();
            if (await resellerTab.count()) {
                await resellerTab.click({ timeout: 8000 });
                await page.waitForTimeout(500);
            }
        }

        const cards = page.locator('.section-content-packages .tab-pane.active .package, .section-content-packages .package, .package');
        const cardCount = await cards.count();
        let clicked = false;

        for (let i = 0; i < cardCount; i++) {
            const card = cards.nth(i);
            const cardText = normalizeKey(await card.innerText());
            if (!expectedNorm || cardText.includes(expectedNorm)) {
                const btn = card.locator('a.btn-order-now, a.btn.btn-primary, a[href*="cart.php"]').first();
                if (await btn.count()) {
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click({ timeout: 10000, force: true });
                    await page.waitForTimeout(1200);
                    await page.waitForURL(/cart\.php\?a=(?:confproduct|view)/i, { timeout: 8000 }).catch(() => null);
                    clicked = true;
                    break;
                }
            }
        }

        if (!clicked) {
            await context.close();
            return null;
        }

        const bodyText = cleanText(await page.textContent('body'));
        const isConfigPage = /elija ciclo|configurar|sumario de pedido|importe a la fecha/i.test(bodyText);
        if (!isConfigPage) {
            await context.close();
            return null;
        }

        const billingCyclesRaw = await page.evaluate(() => {
            const out = [];
            const labels = Array.from(document.querySelectorAll('#sectionCycles label[data-update-config], #sectionCycles .check-cycle label'));
            for (const label of labels) {
                const title = (label.querySelector('.check-title')?.textContent || '').replace(/\s+/g, ' ').trim();
                const subtitle = (label.querySelector('.check-subtitle')?.textContent || '').replace(/\s+/g, ' ').trim();
                const original = (label.querySelector('.cycle-full-price')?.textContent || '').replace(/\s+/g, ' ').trim();
                const cycleMatch = title.match(/Mensual|Trimestral|Semi-Anual|Anual|Bi-Anual|Trienal/i);
                const priceMatch = title.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?/i);
                const discountMatch = subtitle.match(/Ahorras?\s*(?:el\s*)?\d+%|\d+%\s*(?:Dsto|Descuento|de ahorro)/i);

                if (cycleMatch && priceMatch) {
                    out.push({
                        ciclo: cycleMatch[0],
                        precio: priceMatch[0],
                        descuento: discountMatch ? discountMatch[0] : '',
                        precio_original: original || ''
                    });
                }
            }
            return out;
        });

        const billingCycles = mergeUniqueCycles(
            (billingCyclesRaw || []).map((c) => ({
                ciclo: normalizeCycleName(c.ciclo || ''),
                precio: cleanText(c.precio || ''),
                descuento: cleanText(c.descuento || ''),
                precio_original: cleanText(c.precio_original || '')
            })).filter((c) => c.ciclo && c.precio)
        );

        const summary = await page.evaluate(() => {
            const result = {};
            const allText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
            const totalMatch = allText.match(/Importe a la Fecha\s*((?:S\/|US\$|\$)\s?\d[\d.,]*(?:\s?[A-Z]{3})?)/i);
            if (totalMatch) result.total = totalMatch[1].trim();
            return result;
        });

        await context.close();
        return { billingCycles, summary };
    } catch (error) {
        console.log(`   ⚠️  Click real en listado falló: ${error.message}`);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

function extractFacturaloPeriods(html = '', planKey = 'essential') {
    const blockRegex = new RegExp(`${planKey}\\s*:\\s*\\{([\\s\\S]*?)defaultPeriodIndex`, 'i');
    const blockMatch = html.match(blockRegex);
    if (!blockMatch) return [];

    const periodsBlock = blockMatch[1];
    const periodRegex = /\{[^}]*durationMonths\s*:\s*(\d+)[^}]*price\s*:\s*([\d.]+)[^}]*label\s*:\s*"([^"]+)"[^}]*\}/gi;
    const periods = [];
    let match;

    while ((match = periodRegex.exec(periodsBlock)) !== null) {
        periods.push({
            meses: Number(match[1]),
            precio_total: Number(match[2]),
            etiqueta: cleanText(match[3])
        });
    }

    return periods;
}

function extractFacturaloPeriodsWithDiscount(html = '', planKey = 'essential') {
    const dataBlocks = [...String(html).matchAll(/const\s+plansData\s*=\s*\{[\s\S]*?\};/gi)].map((m) => m[0]);
    if (dataBlocks.length === 0) return [];

    // Preferir el bloque que incluya etiquetas "Dsto" (precios finales con descuento real).
    const preferredBlock = dataBlocks.find((b) => /Dsto/i.test(b)) || dataBlocks[dataBlocks.length - 1];
    const planRegex = new RegExp(`${planKey}\\s*:\\s*\\{[\\s\\S]*?periods\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i');
    const planMatch = preferredBlock.match(planRegex);
    if (!planMatch) return [];

    const periodsBlock = planMatch[1];
    const periodRegex = /\{[^}]*durationMonths\s*:\s*(\d+)[^}]*price\s*:\s*([\d.]+)[^}]*label\s*:\s*"([^"]+)"[^}]*monthlyEquivalent\s*:\s*([\d.]+)[^}]*\}/gi;
    const periods = [];
    let match;

    while ((match = periodRegex.exec(periodsBlock)) !== null) {
        const meses = Number(match[1]);
        const precioOriginal = Number(match[2]);
        const etiqueta = cleanText(match[3]);
        const precioFinal = Number(match[4]);
        const dsto = (etiqueta.match(/(\d+%)\s*Dsto/i) || [])[1] || '';

        periods.push({
            meses,
            etiqueta,
            descuento: dsto,
            precio_original: precioOriginal,
            precio_final: precioFinal
        });
    }

    return periods;
}

function extractFacturaloDiscountMap(text = '', startToken = '', endToken = '') {
    if (!startToken) return {};
    const startIndex = text.toLowerCase().indexOf(startToken.toLowerCase());
    if (startIndex < 0) return {};

    let endIndex = text.length;
    if (endToken) {
        const candidate = text.toLowerCase().indexOf(endToken.toLowerCase(), startIndex + startToken.length);
        if (candidate > startIndex) endIndex = candidate;
    }

    const section = text.slice(startIndex, endIndex);
    const discountMap = {};
    const regex = /(\d+)\s*Mes(?:es)?(?:\s*con\s*(\d+)%\s*Dsto)?/gi;
    let m;
    while ((m = regex.exec(section)) !== null) {
        discountMap[Number(m[1])] = m[2] ? `${m[2]}%` : 'Oferta';
    }

    return discountMap;
}

async function scrapeFacturaloPro8Page(url) {
    try {
        console.log(`\n📦 Scrapeando (método Facturalo): ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = res.data;
        const $ = cheerio.load(html);
        const title = cleanText($('h1').first().text()) || 'Facturalo Perú';
        const bodyText = cleanText($('body').text());

        const cards = $('.pricing-rates, .business-rate, .prices-section .card');
        const cardInfo = [];
        cards.each((i, el) => {
            const name = cleanText($(el).find('h4, h5, .title').first().text());
            const includes = [];
            $(el).find('li').each((j, li) => {
                const t = cleanText($(li).text());
                if (t) includes.push(t);
            });
            if (name) cardInfo.push({ name, includes });
        });

        let essentialPeriods = extractFacturaloPeriodsWithDiscount(html, 'essential');
        let priorityPeriods = extractFacturaloPeriodsWithDiscount(html, 'priority');

        // Preferir precios visibles del DOM (campañas activas) sobre bloques JS estáticos.
        const browserPeriods = await scrapeFacturaloPro8PeriodsFromBrowser(url);
        if (browserPeriods.essential.length > 0) {
            essentialPeriods = browserPeriods.essential;
        }
        if (browserPeriods.priority.length > 0) {
            priorityPeriods = browserPeriods.priority;
        }

        const plans = [];

        if (essentialPeriods.length > 0) {
            const includes = (cardInfo.find((c) => /essential/i.test(c.name)) || {}).includes || [];
            plans.push({
                nombre: 'Plan Essential',
                descripcion: 'Plan extraído desde facturaloperu.com/pro8',
                ciclos_facturacion: essentialPeriods.map((p) => ({
                    ciclo: cycleLabelByMonths(p.meses),
                    precio: formatPen(p.precio_final || p.precio_original),
                    descuento: p.descuento || '',
                    precio_original: p.precio_original ? formatPen(p.precio_original) : '',
                    incluye: includes
                })),
                precio: formatPen(((essentialPeriods.find((p) => p.meses === 1) || essentialPeriods[0]).precio_final || (essentialPeriods.find((p) => p.meses === 1) || essentialPeriods[0]).precio_original)).replace(' PEN', '')
            });
        }

        if (priorityPeriods.length > 0) {
            const includes = (cardInfo.find((c) => /priority/i.test(c.name)) || {}).includes || [];
            plans.push({
                nombre: 'Plan Priority',
                descripcion: 'Plan extraído desde facturaloperu.com/pro8',
                ciclos_facturacion: priorityPeriods.map((p) => ({
                    ciclo: cycleLabelByMonths(p.meses),
                    precio: formatPen(p.precio_final || p.precio_original),
                    descuento: p.descuento || '',
                    precio_original: p.precio_original ? formatPen(p.precio_original) : '',
                    incluye: includes
                })),
                precio: formatPen(((priorityPeriods.find((p) => p.meses === 1) || priorityPeriods[0]).precio_final || (priorityPeriods.find((p) => p.meses === 1) || priorityPeriods[0]).precio_original)).replace(' PEN', '')
            });
        }

        return {
            title,
            description: cleanText($('.section-title p').first().text()),
            plans,
            sourceType: 'facturalo-pro8'
        };
    } catch (error) {
        console.error(`   ❌ Error en método Facturalo: ${error.message}`);
        return null;
    }
}

async function scrapeFacturaloPro8MigrationPage(url) {
    try {
        console.log(`\n📦 Scrapeando (migracion Pro8): ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(res.data);
        const dangerBlock = $('.row.alert.alert-danger').first();
        const warningBlock = $('.row.alert.alert-warning').first();

        const dangerTitle = cleanText(dangerBlock.find('h1, h2, h3, h4, h5').first().text());
        const warningTitle = cleanText(warningBlock.find('h1, h2, h3, h4, h5').first().text());

        const dangerParagraphs = dangerBlock
            .find('p')
            .map((_, el) => cleanText($(el).text()))
            .get()
            .filter(Boolean);

        const obsoleteFunctions = dangerBlock
            .find('li')
            .map((_, el) => cleanText($(el).text()))
            .get()
            .filter(Boolean);

        const warningParagraphs = warningBlock
            .find('p')
            .map((_, el) => cleanText($(el).text()))
            .get()
            .filter(Boolean);

        const warningText = cleanText(warningBlock.text());
        const migrationCosts = {};
        const costRegex = /S\/\s?(\d+)\s*para\s*migrar\s*desde\s*el\s*(Pro\d+)\s*al\s*Pro8/gi;
        let costMatch;
        while ((costMatch = costRegex.exec(warningText)) !== null) {
            migrationCosts[`${costMatch[2]}_a_Pro8`] = `S/${costMatch[1]}`;
        }

        const importantNotes = [];
        const importantRaw = warningParagraphs.find((line) => /precio indicado|migraci[oó]n se realiza|sin personalizaciones/i.test(line)) || '';
        if (importantRaw) {
            const parts = importantRaw
                .split(/\s+-\s+/)
                .map((p) => cleanText(p.replace(/^-\s*/, '')))
                .filter(Boolean);
            importantNotes.push(...parts);
        }

        return {
            title: 'Migrar a Pro8',
            description: dangerParagraphs[0] || warningParagraphs[0] || '',
            plans: [],
            sourceType: 'pro8-migration-info',
            migrationData: {
                url,
                bloque_alerta_previa: {
                    titulo: dangerTitle,
                    descripcion: dangerParagraphs[0] || '',
                    funciones_obsoletas: obsoleteFunctions,
                    cierre: dangerParagraphs.slice(1).find((line) => /comunicate|soluciones/i.test(line)) || ''
                },
                bloque_actualizacion_migracion: {
                    titulo: warningTitle,
                    descripcion: warningParagraphs.find((line) => /plan pro5|plan pro6|plan pro7|nuevo plan/i.test(line)) || warningParagraphs[0] || '',
                    costos_migracion: migrationCosts,
                    importante: importantNotes
                }
            }
        };
    } catch (error) {
        console.error(`   ❌ Error en método migración Pro8: ${error.message}`);
        return null;
    }
}

async function scrapeFasturaColombiaPage(url) {
    try {
        console.log(`\n📦 Scrapeando (Fastura Colombia tabs): ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(res.data);
        const title = cleanText($('h1').first().text()) || cleanText($('title').first().text()) || 'Fastura - Colombia';
        const description = cleanText($('.product-group-description, .product-group-subtitle, .sub-heading').first().text());

        const tabNameById = {};
        $('.section-content-packages .nav-tabs .nav-link').each((_, el) => {
            const href = cleanText($(el).attr('href') || '');
            const tabId = href.startsWith('#') ? href.slice(1) : '';
            const tabName = cleanText($(el).find('.nav-link-text').first().text()) || cleanText($(el).text());
            if (tabId && tabName) {
                tabNameById[tabId] = tabName;
            }
        });

        const plans = [];
        $('.section-content-packages .tab-content .tab-pane').each((_, tabPane) => {
            const paneId = cleanText($(tabPane).attr('id') || '');
            const segmento = tabNameById[paneId] || '';

            $(tabPane).find('.package').each((__, el) => {
                const planName = cleanText(
                    $(el)
                        .find('.package-title, .package-name h3, .package-name, .package-header h3, h3')
                        .first()
                        .text()
                );

                const priceAmount = cleanText(
                    $(el).find('.price-ammount, .price-amount').first().text()
                ) || extractAmountLikePrice(cleanText($(el).find('.package-price').first().text()));
                const priceCycle = cleanText($(el).find('.price-cycle').first().text());
                const setupFee = cleanText($(el).find('.price-setup').first().text());
                const orderUrlRaw =
                    $(el).find('a.btn-order-now, a[href*="cart.php"], a[href*="store/"]').first().attr('href') || '';

                const features = [];
                $(el).find('.package-features li, .package-content li').each((___, li) => {
                    const text = cleanText($(li).text());
                    if (text) features.push(text);
                });

                if (!planName) return;

                plans.push({
                    nombre: planName,
                    precio: priceAmount || 'Consultar',
                    ciclo: priceCycle || '',
                    costo_instalacion: setupFee || '',
                    caracteristicas: features,
                    segmento,
                    url_pedido: orderUrlRaw.startsWith('http')
                        ? orderUrlRaw
                        : (orderUrlRaw ? `https://buho.la${orderUrlRaw}` : '')
                });
            });
        });

        const dedup = [];
        const seen = new Set();
        for (const plan of plans) {
            const key = `${normalizeKey(plan.nombre)}|${normalizeKey(plan.precio)}|${normalizeKey(plan.ciclo)}|${normalizeKey(plan.segmento)}`;
            if (!seen.has(key)) {
                seen.add(key);
                dedup.push(plan);
                console.log(`   ✅ Plan: ${plan.nombre} — ${plan.precio} ${plan.ciclo}${plan.segmento ? ` [${plan.segmento}]` : ''}`);
            }
        }

        return {
            title,
            description,
            plans: dedup,
            sourceType: 'fastura-colombia-tabs'
        };
    } catch (error) {
        console.error(`   ❌ Error método Fastura Colombia: ${error.message}`);
        return null;
    }
}

async function scrapeFacturaloPro8PeriodsFromBrowser(url) {
    try {
        if (!playwright) {
            playwright = require('playwright');
        }
    } catch (_) {
        return { essential: [], priority: [] };
    }

    let browser;
    try {
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        const page = await context.newPage();
        await page.goto(`${url.replace(/\/$/, '')}/#prices`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1800);

        const data = await page.evaluate(async () => {
            const clean = (v = '') => String(v || '').replace(/\s+/g, ' ').trim();
            const parseMoney = (txt = '') => {
                const all = [...String(txt || '').matchAll(/S\s*\/\.?\s*([0-9][\d.,]*)/gi)]
                    .map((m) => Number(String(m[1]).replace(/,/g, '')))
                    .filter((n) => Number.isFinite(n));
                return all;
            };
            const parseMonths = (txt = '') => {
                const m = String(txt || '').match(/(\d+)\s*Mes/i);
                return m ? Number(m[1]) : null;
            };

            const cards = Array.from(document.querySelectorAll('.pricing-rates, .business-rate, .prices-section .card'));
            const result = { essential: [], priority: [] };

            for (const card of cards) {
                const title = clean((card.querySelector('h4, h5, .title') || {}).textContent || '').toLowerCase();
                const isEssential = /essential/.test(title);
                const isPriority = /priority/.test(title);
                if (!isEssential && !isPriority) continue;

                const planKey = isEssential ? 'essential' : 'priority';
                const buttons = Array.from(card.querySelectorAll('button, [role="button"], .period-item, .period, .billing-cycle button, .billing button'))
                    .filter((b) => /(\d+)\s*Mes/i.test(clean(b.textContent || '')));

                const periods = [];

                for (const btn of buttons) {
                    try { btn.click(); } catch (_) {}
                    await new Promise((resolve) => setTimeout(resolve, 70));

                    const activeText = clean(btn.textContent || '');
                    const meses = parseMonths(activeText);
                    if (!meses) continue;

                    const cardText = clean(card.innerText || '');
                    const numbers = parseMoney(cardText);
                    if (numbers.length === 0) continue;

                    const hasDiscount = /(\d+)%\s*Dsto/i.test(activeText) || /(\d+)%\s*Dsto/i.test(cardText);
                    const descuento = ((activeText.match(/(\d+)%\s*Dsto/i) || cardText.match(/(\d+)%\s*Dsto/i) || [])[1] || '');

                    const precioFinalNum = Math.min(...numbers);
                    const precioOriginalNum = hasDiscount && numbers.length > 1 ? Math.max(...numbers) : null;

                    periods.push({
                        meses,
                        etiqueta: activeText,
                        descuento: descuento ? `${descuento}%` : '',
                        precio_final: precioFinalNum,
                        precio_original: precioOriginalNum
                    });
                }

                const unique = [];
                const seen = new Set();
                for (const p of periods) {
                    const key = `${p.meses}|${p.precio_final}|${p.precio_original || ''}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        unique.push(p);
                    }
                }

                unique.sort((a, b) => a.meses - b.meses);
                result[planKey] = unique;
            }

            return result;
        });

        await context.close();
        return {
            essential: Array.isArray(data?.essential) ? data.essential : [],
            priority: Array.isArray(data?.priority) ? data.priority : []
        };
    } catch (error) {
        console.log(`   ⚠️  Fallback DOM Pro8 falló: ${error.message}`);
        return { essential: [], priority: [] };
    } finally {
        if (browser) await browser.close();
    }
}

async function scrapeFacturaloProxPage(url) {
    try {
        console.log(`\n📦 Scrapeando (método Facturalo ProX): ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = res.data;
        const $ = cheerio.load(html);
        const title = cleanText($('h1').first().text()) || 'Facturalo ProX';
        const rawText = $('body').text() || '';
        const bodyText = cleanText(rawText);

        const plans = [];
        const planRegex = /(ESSENTIAL|PRIORITY)\s*(6|12)[\s\S]{0,260}?(S\/?\.?\s*\d[\d.,]*)/gi;
        let match;

        const extractBenefitsForPlan = (tier = '', months = '') => {
            const marker = `${tier} ${months}`;
            const start = rawText.toUpperCase().indexOf(marker.toUpperCase());
            if (start < 0) return [];

            const tail = rawText.slice(start + marker.length);
            const endMatch = tail.match(/(?:ESSENTIAL\s*(?:6|12)|PRIORITY\s*(?:6|12)|\*Precios no incluyen IGV|Certificados Digitales|¿Qué significa "SE")/i);
            const section = endMatch ? tail.slice(0, endMatch.index) : tail;

            const lines = section
                .split(/\r?\n/)
                .map((l) => cleanText(l.replace(/[\uE000-\uF8FF]/g, '').replace(/^[-*•\u25CF\u25A0\u2713\u2714\u2717\u2718\s]+/, '')))
                .filter(Boolean)
                .filter((l) => l.length > 8)
                .filter((l) => !/^S\/?\.?\s*\d/.test(l))
                .filter((l) => !/^\(Para\s*1\s*dominio\)$/i.test(l))
                .filter((l) => !/^(Comprar|Planes ProX|Instalaci[oó]n en tu propio servidor, c[oó]digo fuente)/i.test(l));

            return dedupeStrings(lines).slice(0, 10);
        };

        while ((match = planRegex.exec(rawText)) !== null) {
            const tier = String(match[1] || '').toUpperCase();
            const months = Number(match[2]);
            const price = extractBasePrice(match[3] || '');
            const includes = extractBenefitsForPlan(tier, months);
            plans.push({
                nombre: `${tier} ${months}`,
                precio: price,
                ciclo: `${months} Meses`,
                descripcion: `Plan ${tier} para ${months} meses (ProX SE).`,
                incluye: includes,
                url_pedido: 'https://wa.me/51944999965?text=Hola,%20quiero%20m%C3%A1s%20info%20sobre%20el%20facturador%20PRO%20X'
            });
        }

        const uniquePlans = [];
        const seen = new Set();
        for (const p of plans) {
            const key = normalizeKey(`${p.nombre}|${p.precio}|${p.ciclo}`);
            if (!seen.has(key)) {
                seen.add(key);
                uniquePlans.push(p);
            }
        }

        return {
            title,
            description: /Sistema de gestion para Resellers y Desarrolladores/i.test(bodyText)
                ? 'ProX(SE) orientado a resellers y desarrolladores con planes Essential y Priority.'
                : cleanText($('.section-title p').first().text()),
            plans: uniquePlans,
            sourceType: 'facturalo-prox',
            pricingNote: '*Precios no incluyen IGV. Para requerir factura aumentar el 18% del IGV. Servicio autoadministrado.'
        };
    } catch (error) {
        console.error(`   ❌ Error en método Facturalo ProX: ${error.message}`);
        return null;
    }
}

async function scrapeSpaPricingPage(url, sourceType = 'spa-pricing') {
    try {
        if (!playwright) {
            playwright = require('playwright');
        }
    } catch (error) {
        console.error('   ❌ Playwright no está disponible para scrapear VendeYa (SPA).');
        return null;
    }

    let browser;
    try {
        console.log(`\n📦 Scrapeando (método SPA): ${url}`);
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        const page = await context.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        const pricesLink = page.locator('a:has-text("Precios")').first();
        if (await pricesLink.count()) {
            try {
                await pricesLink.click({ timeout: 8000 });
                await page.waitForTimeout(1800);
            } catch {
                // Si falla el click, continúa con el DOM actual.
            }
        }

        let cards = page.locator('div.uk-card.uk-card-default.uk-card-body');
        if (await cards.count() === 0) {
            await page.goto(`${url}#precios`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2500);
            cards = page.locator('div.uk-card.uk-card-default.uk-card-body');
        }

        const plans = await page.evaluate(() => {
            const clean = (v = '') => String(v).replace(/\s+/g, ' ').trim();
            const normalizePrice = (raw = '') => {
                const flat = clean(raw);
                if (/gratis|free/i.test(flat)) return 'Gratis';
                const m = flat.match(/(?:S\/|US\$|\$)\s?\d[\d.,]*/i);
                return m ? clean(m[0]) : flat;
            };

            const cardNodes = Array.from(document.querySelectorAll('div.uk-card.uk-card-default.uk-card-body'));
            const extracted = [];

            for (const card of cardNodes) {
                const name = clean((card.querySelector('h3.el-meta') || card.querySelector('h3'))?.textContent || '');
                if (!name) continue;

                const priceText = clean((card.querySelector('.el-title') || card.querySelector('.price-original'))?.textContent || '');
                const desc = clean((card.querySelector('.el-content p') || {}).textContent || '');
                const actionHref = (card.querySelector('a.el-link') || {}).href || '';

                const incluye = [];
                const noIncluye = [];

                for (const li of Array.from(card.querySelectorAll('li'))) {
                    const text = clean(li.textContent || '');
                    if (!text) continue;

                    const hasDangerIcon = !!li.querySelector('.uk-text-danger');
                    const imgSrc = ((li.querySelector('img') || {}).getAttribute?.('src') || '').toLowerCase();
                    const isNoIncluded = hasDangerIcon || /circle-close|cross|xmark|times/.test(imgSrc) || /^x\s+/i.test(text) || /^×\s*/.test(text);
                    if (isNoIncluded) noIncluye.push(text.replace(/^x\s+/i, '').replace(/^×\s*/, ''));
                    else incluye.push(text);
                }

                extracted.push({
                    nombre: name,
                    precio: normalizePrice(priceText),
                    descripcion: desc,
                    incluye,
                    no_incluye: noIncluye,
                    url_pedido: actionHref
                });
            }

            return extracted;
        });

        const title = cleanText(await page.title()) || 'VendeYa.pe';
        const description = cleanText(await page.locator('body').innerText()).match(/Vende y atiende[^.]+\./i)?.[0] || '';

        await context.close();
        return {
            title,
            description: cleanText(description),
            plans,
            sourceType
        };
    } catch (error) {
        console.error(`   ❌ Error en método SPA: ${error.message}`);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function scrapeVendeyaPage(url) {
    return await scrapeSpaPricingPage(url, 'vendeya-spa');
}

async function scrapeMozoPage(url) {
    return await scrapeSpaPricingPage(url, 'mozo-spa');
}

function isManualDocumentationUrl(url = '') {
    return /manual\.uio\.la|manual\.pro8\.uio\.la/i.test(String(url || ''));
}

function dedupeStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const text = cleanText(item || '');
        if (!text) continue;
        const key = normalizeKey(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function isDocumentationNoise(text = '') {
    const value = cleanText(text);
    if (!value) return true;
    if (value.length < 6) return true;
    return /(chatbuho|app android|actualizaciones|multi empresa|guias adicionales|preguntas comunes|errores sunat|admin reseller|novedades y nuevas funciones|manual de uso de diversos sistemas|pagina de inicio)/i.test(value);
}

async function scrapeDocumentationPage(url) {
    try {
        console.log(`\n📚 Scrapeando documentación: ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(res.data);
        const title = cleanText($('h1').first().text()) || cleanText($('title').first().text()) || 'Documentación';
        const metaDescription = cleanText($('meta[name="description"]').attr('content') || '');

        const paragraphs = dedupeStrings(
            $('main p, article p, .theme-doc-markdown p, p')
                .map((_, el) => cleanText($(el).text()))
                .get()
                .filter((t) => t.length >= 40)
                .slice(0, 12)
        );

        const headings = dedupeStrings(
            $('main h2, main h3, article h2, article h3, .theme-doc-markdown h2, .theme-doc-markdown h3, h2, h3')
                .map((_, el) => cleanText($(el).text()))
                .get()
            .filter((t) => !isDocumentationNoise(t))
                .slice(0, 24)
        );

        const bullets = dedupeStrings(
            $('main li, article li, .theme-doc-markdown li, li')
                .map((_, el) => cleanText($(el).text()))
                .get()
                .filter((t) => t.length >= 8)
            .filter((t) => !isDocumentationNoise(t))
                .slice(0, 40)
        );

        const links = dedupeStrings(
            $('a[href]')
                .map((_, el) => $(el).attr('href') || '')
                .get()
                .filter((href) => /^https?:\/\//i.test(href) || href.startsWith('/'))
                .slice(0, 30)
        );

        const description = paragraphs[0] || metaDescription;

        return {
            title,
            description,
            plans: [],
            sourceType: 'manual-doc',
            docData: {
                url,
                titulo: title,
                resumen: description,
                secciones: headings,
                puntos_clave: bullets,
                enlaces_relacionados: links
            }
        };
    } catch (error) {
        console.error(`   ❌ Error en documentación: ${error.message}`);
        return null;
    }
}

function findMatchingPlan(existingPlanes, scrapedPlan) {
    const scrapedNameNorm = normalizeKey(scrapedPlan.nombre);
    const scrapedSlug = extractSlug(scrapedPlan.url_pedido);

    if (scrapedSlug) {
        const bySlug = existingPlanes.find((p) => extractSlug(p.url_pedido) === scrapedSlug);
        if (bySlug) return bySlug;
    }

    const byCode = existingPlanes.find((p) => {
        if (!p.codigo) return false;
        const codeNorm = normalizeKey(p.codigo);
        return codeNorm && scrapedNameNorm.includes(codeNorm);
    });
    if (byCode) return byCode;

    const byExactName = existingPlanes.find((p) => normalizeKey(p.nombre) === scrapedNameNorm);
    if (byExactName) return byExactName;

    const scrapedHints = extractTokenHints(scrapedPlan.nombre);
    if (scrapedHints.length > 0) {
        const byHints = existingPlanes.find((p) => {
            const planHints = extractTokenHints(p.nombre);
            return scrapedHints.some((h) => planHints.includes(h));
        });
        if (byHints) return byHints;
    }

    return null;
}

// Configuración de productos a scrapear (TODOS los 17 productos de buho.la/store)
const PRODUCTS = [
    // ─── Infraestructura ───
    {
        url: 'https://buho.la/store/hosting-compartido',
        jsonFile: 'hosting.json',
        name: 'Hosting Linux',
        samplePurchaseUrl: 'https://buho.la/store/hosting-compartido/hosting-l5'
    },
    {
        url: 'https://buho.la/store/vps',
        jsonFile: 'vps.json',
        name: 'Servidores Cloud VPS',
        samplePurchaseUrl: 'https://buho.la/store/vps/e4'
    },
    // ─── Correos Corporativos ───
    {
        url: 'https://buho.la/store/google-workspace',
        jsonFile: 'correoscorporativos.json',
        name: 'Correos Corporativos: Google Workspace',
        samplePurchaseUrl: 'https://buho.la/store/google-workspace/g30a'
    },
    {
        url: 'https://buho.la/store/zoho-mail',
        jsonFile: 'zohomail.json',
        name: 'Correos Corporativos: Zoho Mail',
        samplePurchaseUrl: 'https://buho.la/store/zoho-mail/zoho-mail-z5'
    },
    // ─── Comunicación ───
    {
        url: 'https://buho.la/store/chat',
        jsonFile: 'buhochat.json',
        name: 'Chat Buho',
        samplePurchaseUrl: 'https://buho.la/store/chat/chat-buho-ch-3'
    },
    // ─── WhatsApp API (Waya) ───
    {
        url: 'https://buho.la/store/waya-empresa',
        jsonFile: 'waya_empresa.json',
        name: 'Waya - 1 Empresa',
        samplePurchaseUrl: 'https://buho.la/store/waya-empresa/w1'
    },
    {
        url: 'https://buho.la/store/waya-reseller',
        jsonFile: 'waya_reseller.json',
        name: 'Waya - Resellers',
        samplePurchaseUrl: 'https://buho.la/store/waya-reseller/wr5'
    },
    // ─── Facturación Perú ───
    {
        url: 'https://buho.la/store/facturafacil',
        jsonFile: 'facturafacil.json',
        name: 'Factura Fácil - Perú',
        samplePurchaseUrl: 'https://buho.la/store/facturafacil/factura-facil-f3'
    },
    {
        url: 'https://buho.la/store/fastura',
        jsonFile: 'fastura.json',
        name: 'Fastura - Perú',
        samplePurchaseUrl: 'https://buho.la/store/fastura/fastura-reseller-r5'
    },
    {
        url: 'https://buho.la/store/validacion',
        jsonFile: 'validacion.json',
        name: 'Validación OSE / Firmas PSE - Perú',
        samplePurchaseUrl: 'https://buho.la/store/validacion/ose-ff-1k'
    },
    {
        url: 'https://buho.la/store/certificado-sunat',
        jsonFile: 'certificadosunat.json',
        name: 'Certificado Digital - SUNAT Perú',
        samplePurchaseUrl: 'https://buho.la/store/certificado-sunat/certificado-digital-sunat-clientes'
    },
    {
        url: 'https://buho.la/store/pro8',
        jsonFile: 'pro8_facturaloperu.json',
        name: 'Facturador Pro 8 - Perú',
        samplePurchaseUrl: null
    },
    {
        url: 'https://facturaloperu.com/pro8/',
        jsonFile: 'pro8_facturaloperu.json',
        name: 'Facturalo Perú - Pro8',
        samplePurchaseUrl: null
    },
    {
        url: 'https://facturaloperu.com/pro8/',
        jsonFile: 'migrar_a_pro8.json',
        name: 'Migrar a Pro8',
        samplePurchaseUrl: null
    },
    {
        url: 'https://facturaloperu.com/prox/',
        jsonFile: 'prox.json',
        name: 'Facturalo Perú - ProX',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.pro8.uio.la/',
        jsonFile: 'pro8_facturaloperu.json',
        name: 'Manual Pro8',
        samplePurchaseUrl: null
    },
    {
        url: 'https://mozo.pe/',
        jsonFile: 'mozo.json',
        name: 'Mozo.pe - Perú',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.pro8.uio.la/mozo/introduccion',
        jsonFile: 'mozo.json',
        name: 'Mozo - Documentación Pro8',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.pro8.uio.la/vendeya/introduccion',
        jsonFile: 'vendeya.json',
        name: 'VendeYa - Documentación Pro8',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.uio.la/Pro7',
        jsonFile: 'pro7.json',
        name: 'Pro7 - Documentación',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.uio.la/Pro7/mozo/mozo-comparison',
        jsonFile: 'pro7.json',
        name: 'Pro7 - Mozo comparison',
        samplePurchaseUrl: null
    },
    {
        url: 'https://manual.uio.la/ProX',
        jsonFile: 'prox.json',
        name: 'ProX - Documentación',
        samplePurchaseUrl: null
    },
    {
        url: 'https://buho.la/store/app',
        jsonFile: 'app31.json',
        name: 'APP 3.1 Facturación - Perú',
        samplePurchaseUrl: 'https://buho.la/store/app/essential'
    },
    // ─── Colombia ───
    {
        url: 'https://buho.la/co/fastura?currency=3',
        jsonFile: 'fastura_colombia.json',
        name: 'Fastura - Colombia',
        samplePurchaseUrl: null
    },
    {
        url: 'https://buho.la/store/certificados-dian',
        jsonFile: 'certificados_dian.json',
        name: 'Certificado Digital - DIAN Colombia',
        samplePurchaseUrl: null
    },
    // ─── Otros ───
    {
        url: 'https://buho.la/store/qrbuho',
        jsonFile: 'qrbuho.json',
        name: 'Qrbuho',
        samplePurchaseUrl: null
    }
];


/**
 * Extrae los planes y precios de una página de producto de buho.la/store
 */
async function scrapeProductPage(url, product = null) {
    try {
        if (/facturaloperu\.com\/pro8\/?$/i.test(url) && normalizeKey(product?.jsonFile || '') === 'migrarapro8json') {
            return await scrapeFacturaloPro8MigrationPage(url);
        }

        if (isManualDocumentationUrl(url)) {
            return await scrapeDocumentationPage(url);
        }

        if (/buho\.la\/co\/fastura\?currency=3/i.test(url)) {
            return await scrapeFasturaColombiaPage(url);
        }

        if (/facturaloperu\.com\/pro8/i.test(url)) {
            return await scrapeFacturaloPro8Page(url);
        }

        if (/facturaloperu\.com\/prox/i.test(url)) {
            return await scrapeFacturaloProxPage(url);
        }

        if (/vendeya\.pe/i.test(url)) {
            return await scrapeVendeyaPage(url);
        }

        if (/mozo\.pe/i.test(url)) {
            return await scrapeMozoPage(url);
        }

        console.log(`\n📦 Scrapeando: ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const $ = cheerio.load(res.data);

        // Extraer título principal
        const title = cleanText($('h1').first().text());
        console.log(`   Título: ${title}`);

        // Extraer descripción
        const description = cleanText(
            $('.product-group-description, .product-group-subtitle, .sub-heading')
                .first().text()
        );

        // Extraer planes con precios
        const plans = [];
        $('.package').each((i, el) => {
            const planName = cleanText(
                $(el)
                    .find('.package-title, .package-name h3, .package-name, .package-header h3, h3')
                    .first()
                    .text()
            );

            const priceAmount = cleanText(
                $(el).find('.price-ammount, .price-amount').first().text()
            ) || extractAmountLikePrice(cleanText($(el).find('.package-price').first().text()));
            const priceCycle = cleanText($(el).find('.price-cycle').first().text());
            const setupFee = cleanText($(el).find('.price-setup').first().text());
            const orderUrl = $(el).find('a.btn-order-now, a[href*="cart.php"], a[href*="store/"]').first().attr('href') || '';

            // Extraer características del plan
            const features = [];
            $(el).find('.package-features li, .package-content li').each((j, li) => {
                const text = cleanText($(li).text());
                if (text) features.push(text);
            });

            if (planName) {
                plans.push({
                    nombre: planName,
                    precio: priceAmount || 'Consultar',
                    ciclo: priceCycle || '',
                    costo_instalacion: setupFee || '',
                    caracteristicas: features,
                    url_pedido: orderUrl.startsWith('http') ? orderUrl : `https://buho.la${orderUrl}`
                });
                console.log(`   ✅ Plan: ${planName} — ${priceAmount} ${priceCycle}`);
            }
        });

        if (plans.length === 0 && $('.package').length > 0) {
            console.log('   ⚠️  Se detectaron bloques .package pero no se pudo extraer nombre de planes.');
        }

        return { title, description, plans };
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return null;
    }
}

/**
 * Intenta scrapear la página de compra de un producto
 */
async function scrapePurchasePage(url, expectedPlanName = '') {
    try {
        console.log(`   🛒 Scrapeando página de compra: ${url}`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            maxRedirects: 5
        });
        const $ = cheerio.load(res.data);
        const pageText = cleanText($('body').text());
        const isConfigPage = /configurar|elija ciclo|sumario de pedido|importe a la fecha/i.test(pageText);

        // Extraer opciones de ciclo de facturación
        const billingCycles = [];
        $('input[name="billingcycle"], .billing-cycle-option, .cycle-option').each((i, el) => {
            const cycleName = cleanText($(el).parent().text()) || $(el).attr('data-label') || '';
            const cyclePrice = cleanText($(el).attr('data-price') || '');
            if (cycleName) {
                const parsed = parseCyclePriceText(`${cycleName} ${cyclePrice}`);
                billingCycles.push({
                    ciclo: parsed.ciclo || normalizeCycleName(cycleName),
                    precio: parsed.precio || cyclePrice,
                    descuento: parsed.descuento || '',
                    precio_original: parsed.precio_original || ''
                });
            }
        });

        // Fallback estricto para páginas de configuración real.
        if (billingCycles.length === 0 && isConfigPage) {
            const cycleSectionMatch = pageText.match(/Elija Ciclo[\s\S]*?Sumario de Pedido/i);
            const cycleSection = cycleSectionMatch ? cycleSectionMatch[0] : pageText;
            billingCycles.push(...extractCyclesFromTextBlock(cycleSection));
        }

        // Extraer resumen de precios
        const summary = {};
        $('.order-summary, .product-summary, .total-due-today').each((i, el) => {
            const totalText = cleanText($(el).find('.total, .total-amount, .amount').text());
            if (totalText) summary.total = totalText;
        });

        const uniqueCycles = mergeUniqueCycles(
            billingCycles.filter((c) => c && c.ciclo && c.precio)
        );

        if (uniqueCycles.length === 0) {
            const browserData = await scrapePurchasePageWithBrowser(url, expectedPlanName);
            if (browserData && browserData.billingCycles && browserData.billingCycles.length > 0) {
                return browserData;
            }
        }

        return { billingCycles: uniqueCycles, summary };
    } catch (error) {
        console.error(`   ❌ Error en página de compra: ${error.message}`);
        return await scrapePurchasePageWithBrowser(url, expectedPlanName);
    }
}

/**
 * Actualiza el JSON de un producto con los planes scrapeados
 */
function updateProductJSON(product, productData) {
    const filePath = path.join(KNOWLEDGE_DIR, product.jsonFile);

    if (!fs.existsSync(filePath)) {
        if (productData && productData.sourceType === 'pro8-migration-info') {
            const baseData = {
                sitio: productData.title || 'Migrar a Pro8',
                url: product.url,
                ultima_actualizacion: new Date().toISOString(),
                fuente: 'facturaloperu.com',
                descripcion_general: productData.description || '',
                bloques: {}
            };
            fs.writeFileSync(filePath, JSON.stringify(baseData, null, 2), 'utf-8');
            console.log(`   🆕 Archivo creado: ${product.jsonFile}`);
        } else {
            console.log(`   ⚠️  Archivo ${product.jsonFile} no existe, saltando actualización.`);
            return;
        }
    }

    try {
        const existingData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const scrapedPlans = (productData && Array.isArray(productData.plans)) ? productData.plans : [];

        if (productData && productData.title) {
            existingData.sitio = existingData.sitio || productData.title;
        }

        if (productData && productData.description && !existingData.descripcion_general) {
            existingData.descripcion_general = productData.description;
        }

        // Actualizar precios de planes existentes si hay datos nuevos scrapeados
        const existingPlanes = Array.isArray(existingData.planes) ? existingData.planes : [];

        if (productData && productData.sourceType === 'manual-doc') {
            const docData = productData.docData || {};

            if (!existingData.descripcion_general && productData.description) {
                existingData.descripcion_general = productData.description;
            }

            if (!existingData.documentacion) {
                existingData.documentacion = {
                    paginas: []
                };
            }
            if (!Array.isArray(existingData.documentacion.paginas)) {
                existingData.documentacion.paginas = [];
            }

            const pageRecord = {
                url: product.url,
                titulo: docData.titulo || productData.title || '',
                resumen: docData.resumen || productData.description || '',
                secciones: Array.isArray(docData.secciones) ? docData.secciones.slice(0, 20) : [],
                puntos_clave: Array.isArray(docData.puntos_clave) ? docData.puntos_clave.slice(0, 25) : [],
                extraido_en: new Date().toISOString()
            };

            const existingIndex = existingData.documentacion.paginas.findIndex((p) => p.url === product.url);
            if (existingIndex >= 0) {
                existingData.documentacion.paginas[existingIndex] = pageRecord;
            } else {
                existingData.documentacion.paginas.push(pageRecord);
            }

            const keepPublicSources = ['pro7json', 'proxjson'].includes(normalizeKey(product.jsonFile));
            if (keepPublicSources) {
                if (!Array.isArray(existingData.fuentes_publicas)) {
                    existingData.fuentes_publicas = [];
                }
                const hasSource = existingData.fuentes_publicas.some((s) => s.url === product.url);
                if (!hasSource) {
                    existingData.fuentes_publicas.push({
                        fuente: 'Documentación oficial',
                        url: product.url,
                        evidencia: docData.titulo || productData.title || 'Página de documentación'
                    });
                }
            } else if (Array.isArray(existingData.fuentes_publicas)) {
                delete existingData.fuentes_publicas;
            }

            if (!Array.isArray(existingData.resumen_documentacion)) {
                existingData.resumen_documentacion = [];
            }
            const highlights = Array.isArray(docData.puntos_clave) ? docData.puntos_clave.slice(0, 8) : [];
            existingData.resumen_documentacion = dedupeStrings([
                ...existingData.resumen_documentacion,
                ...highlights
            ]).slice(0, 40);

            console.log(`   ✅ Documentación integrada en ${product.jsonFile}`);
        } else if (productData && productData.sourceType === 'facturalo-pro8') {
            if (scrapedPlans.length > 0) {
                existingData.planes = scrapedPlans;
                console.log(`   ✅ Planes de Facturalo actualizados (${scrapedPlans.length})`);
            } else {
                console.log('   ⚠️  Método Facturalo sin planes extraídos, se mantiene JSON actual.');
            }
        } else if (productData && productData.sourceType === 'pro8-migration-info') {
            const migrationData = productData.migrationData || {};
            existingData.sitio = productData.title || existingData.sitio || 'Migrar a Pro8';
            existingData.url = product.url;
            existingData.descripcion_general = productData.description || existingData.descripcion_general || '';
            existingData.bloques = {
                alerta_previa_migracion: migrationData.bloque_alerta_previa || {
                    titulo: '',
                    descripcion: '',
                    funciones_obsoletas: [],
                    cierre: ''
                },
                alerta_actualizacion_migracion: migrationData.bloque_actualizacion_migracion || {
                    titulo: '',
                    descripcion: '',
                    costos_migracion: {},
                    importante: []
                }
            };
            console.log('   ✅ Datos de migración Pro8 actualizados.');
        } else if (productData && productData.sourceType === 'facturalo-prox') {
            if (scrapedPlans.length > 0) {
                existingData.planes = scrapedPlans;
                if (productData.pricingNote) {
                    existingData.nota_precios = productData.pricingNote;
                }
                console.log(`   ✅ Planes ProX actualizados (${scrapedPlans.length})`);
            } else {
                console.log('   ⚠️  Método Facturalo ProX sin planes extraídos, se mantiene JSON actual.');
            }
        } else if (productData && (productData.sourceType === 'vendeya-spa' || productData.sourceType === 'mozo-spa')) {
            if (scrapedPlans.length > 0) {
                existingData.planes = scrapedPlans;
                console.log(`   ✅ Planes SPA actualizados (${scrapedPlans.length})`);
            } else {
                console.log('   ⚠️  Método SPA sin planes extraídos, se mantiene JSON actual.');
            }
        } else if (productData && productData.sourceType === 'fastura-colombia-tabs') {
            if (scrapedPlans.length > 0) {
                const plansWithCycles = scrapedPlans.map((plan) => {
                    const ciclos = normalizeExtractedCycles(plan.ciclos_facturacion_extraidos || [], false);
                    const cicloBase = normalizeCycleName(plan.ciclo || '');
                    const precioBase = cleanText(plan.precio || '');
                    const ciclosFiltrados = ciclos.filter((c) => {
                        const mismoCiclo = normalizeCycleName(c.ciclo || '') === cicloBase;
                        const mismoPrecio = cleanText(c.precio || '') === precioBase;
                        return !(mismoCiclo && mismoPrecio);
                    });
                    const cleaned = {
                        nombre: plan.nombre,
                        precio: plan.precio,
                        ciclo: plan.ciclo,
                        costo_instalacion: plan.costo_instalacion || '',
                        caracteristicas: Array.isArray(plan.caracteristicas) ? plan.caracteristicas : [],
                        segmento: plan.segmento || '',
                        url_pedido: plan.url_pedido || ''
                    };
                    if (ciclosFiltrados.length > 0) {
                        cleaned.ciclos_facturacion = ciclosFiltrados;
                    }
                    return cleaned;
                });

                existingData.planes = plansWithCycles;
                existingData.url = product.url;
                if (existingData.contacto && typeof existingData.contacto === 'object') {
                    existingData.contacto.web = product.url;
                }
                if (existingData.nota) delete existingData.nota;
                console.log(`   ✅ Planes Fastura Colombia actualizados (${scrapedPlans.length})`);
            } else {
                console.log('   ⚠️  Método Fastura Colombia sin planes extraídos, se mantiene JSON actual.');
            }
        } else if (scrapedPlans && scrapedPlans.length > 0 && existingPlanes.length > 0) {
            for (const scrapedPlan of scrapedPlans) {
                // Buscar plan correspondiente en el JSON existente
                const existingPlan = findMatchingPlan(existingPlanes, scrapedPlan);

                const planLooksFree =
                    isFreePrice(scrapedPlan.precio) ||
                    (existingPlan && isFreePrice(existingPlan.precio)) ||
                    /gratis/i.test(cleanText(scrapedPlan.nombre));

                if (existingPlan && planLooksFree) {
                    existingPlan.precio = 'Gratis';
                    existingPlan.ciclos_facturacion = [{
                        ciclo: 'Mensual',
                        precio: 'Gratis',
                        descuento: '',
                        precio_original: ''
                    }];
                    console.log(`   🔒 Plan gratis protegido (sin mezcla de otros ciclos): ${existingPlan.nombre}`);
                    continue;
                }

                if (existingPlan && scrapedPlan.precio && scrapedPlan.precio !== 'Consultar') {
                    const normalizedPrice = extractBasePrice(scrapedPlan.precio);
                    let targetField = 'precio';

                    if (existingPlan.precio_trimestral && shouldUseQuarterlyField(scrapedPlan.ciclo)) {
                        targetField = 'precio_trimestral';
                    } else
                    if (existingPlan.precio_semianual && shouldUseSemiAnnualField(scrapedPlan.ciclo)) {
                        targetField = 'precio_semianual';
                    } else if (existingPlan.precio_mensual && shouldUseMonthlyField(scrapedPlan.ciclo)) {
                        targetField = 'precio_mensual';
                    } else if (existingPlan.precio_anual && shouldUseAnnualField(scrapedPlan.ciclo)) {
                        targetField = 'precio_anual';
                    } else if (existingPlan.precio) {
                        targetField = 'precio';
                    }

                    const oldPrice = existingPlan[targetField];
                    existingPlan[targetField] = normalizedPrice;

                    if (oldPrice !== normalizedPrice) {
                        console.log(`   📝 Precio actualizado (${targetField}): ${existingPlan.nombre}: ${oldPrice} → ${normalizedPrice}`);
                    }
                } else if (!existingPlan) {
                    const newPlan = {
                        nombre: scrapedPlan.nombre,
                        precio: extractBasePrice(scrapedPlan.precio || ''),
                        ciclo: scrapedPlan.ciclo || '',
                        incluye: scrapedPlan.caracteristicas || [],
                        url_pedido: scrapedPlan.url_pedido || ''
                    };
                    existingPlanes.push(newPlan);
                    console.log(`   ➕ Plan agregado al JSON: ${scrapedPlan.nombre}`);
                    continue;
                }

                if (existingPlan && scrapedPlan.ciclos_facturacion_extraidos && scrapedPlan.ciclos_facturacion_extraidos.length > 0) {
                    const sanitizedCycles = normalizeExtractedCycles(scrapedPlan.ciclos_facturacion_extraidos, false);
                    if (sanitizedCycles.length > 0) {
                        existingPlan.ciclos_facturacion = sanitizedCycles;
                        console.log(`   🔄 Ciclos extraídos de carrito actualizados para ${existingPlan.nombre}`);
                    } else {
                        console.log(`   ⚠️  Ciclos descartados por mezcla/rango inválido en ${existingPlan.nombre}`);
                    }
                }
            }

            // Factura Fácil: agrupar por tipo de plan para evitar mezcla de tabs (Emprendedores/Profesionales).
            if (normalizeKey(product.jsonFile) === 'facturafaciljson') {
                for (const plan of existingPlanes) {
                    const key = normalizeKey(plan.nombre);
                    if (key.includes('gratis') || key.includes('f1') || key.includes('f2')) {
                        plan.segmento = 'Emprendedores';
                    } else if (key.includes('f3') || key.includes('f4') || key.includes('f5') || key.includes('f6') || key.includes('f7') || key.includes('f8') || key.includes('f9') || key.includes('ilimitado')) {
                        plan.segmento = 'Profesionales';
                    }
                }
            }
        } else if (existingPlanes.length === 0) {
            existingData.nota = existingData.nota || 'Actualmente no hay productos visibles en esta categoría.';
            console.log('   ℹ️  Categoría sin planes visibles, se mantiene JSON con nota informativa.');
        }

        // Actualizar fecha de última actualización
        existingData.ultima_actualizacion = new Date().toISOString();

        fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2), 'utf-8');
        console.log(`   ✅ ${product.jsonFile} actualizado`);
    } catch (error) {
        console.error(`   ❌ Error actualizando ${product.jsonFile}: ${error.message}`);
    }
}

/**
 * Función principal
 */
async function main() {
    console.log('═══════════════════════════════════════');
    console.log('🦉 SCRAPER DE PRODUCTOS DIGITAL BUHO');
    console.log('═══════════════════════════════════════');
    console.log(`📁 Directorio de conocimiento: ${KNOWLEDGE_DIR}`);
    console.log(`📅 Fecha: ${new Date().toISOString()}\n`);

    // Verificar que existe el directorio
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        console.error('❌ Directorio de conocimiento no encontrado. Creándolo...');
        fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }

    // Cargar fuentes adicionales desde scraper_sources.json
    const SCRAPER_SOURCES_FILE = path.join(__dirname, 'data', 'scraper_sources.json');
    if (fs.existsSync(SCRAPER_SOURCES_FILE)) {
        try {
            const extraSources = JSON.parse(fs.readFileSync(SCRAPER_SOURCES_FILE, 'utf-8'));
            if (extraSources.sources && Array.isArray(extraSources.sources)) {
                console.log(`\n📥 Cargando fuentes adicionales desde scraper_sources.json...`);
                let added = 0;
                for (const source of extraSources.sources) {
                    if (source.enabled) {
                        const alreadyConfigured = PRODUCTS.some((p) =>
                            normalizeKey(p.jsonFile) === normalizeKey(source.outputFile)
                            && normalizeKey(p.url) === normalizeKey(source.url)
                        );
                        if (alreadyConfigured) {
                            console.log(`   ℹ️  Fuente extra omitida por duplicado de url+outputFile: ${source.url} -> ${source.outputFile}`);
                            continue;
                        }
                        PRODUCTS.push({
                            url: source.url,
                            jsonFile: source.outputFile,
                            name: `[EXTRA] ${source.name}`,
                            samplePurchaseUrl: null
                        });
                        added++;
                    }
                }
                console.log(`   Se agregaron ${added} fuentes adicionales.`);
            }
        } catch (error) {
            console.error(`❌ Error leyendo scraper_sources.json: ${error.message}`);
        }
    }

    const onlyFilter = process.env.SCRAPE_ONLY
        ? process.env.SCRAPE_ONLY.split(',').map((x) => normalizeKey(x)).filter(Boolean)
        : [];

    const productsToProcess = onlyFilter.length > 0
        ? PRODUCTS.filter((p) => onlyFilter.includes(normalizeKey(p.jsonFile)) || onlyFilter.includes(normalizeKey(p.name)))
        : PRODUCTS;

    if (onlyFilter.length > 0) {
        console.log(`\n🎯 Filtro activo SCRAPE_ONLY. Productos a procesar: ${productsToProcess.length}`);
    }

    for (const product of productsToProcess) {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`🔍 Procesando: ${product.name}`);

        // 1. Scrapear página principal del producto
        const productData = await scrapeProductPage(product.url, product);

        // 2. Extraer ciclos de facturación reales de los enlaces "Pedir Ahora" de cada plan
        if (productData && productData.plans.length > 0) {
            for (const plan of productData.plans) {
                const planIsFree = isFreePrice(plan.precio) || /gratis/i.test(cleanText(plan.nombre));
                if (planIsFree) {
                    plan.ciclos_facturacion_extraidos = [{
                        ciclo: 'Mensual',
                        precio: 'Gratis',
                        descuento: '',
                        precio_original: ''
                    }];
                    continue;
                }

                if (plan.url_pedido && (plan.url_pedido.includes('/store/') || plan.url_pedido.includes('/cart.php'))) {
                    const purchaseData = productData.sourceType === 'fastura-colombia-tabs'
                        ? (await scrapeCyclesByClickFromListing(product.url, plan.nombre)) || (await scrapePurchasePage(plan.url_pedido, plan.nombre))
                        : await scrapePurchasePage(plan.url_pedido, plan.nombre);
                    if (purchaseData && purchaseData.billingCycles && purchaseData.billingCycles.length > 0) {
                        const normalizedCycles = normalizeExtractedCycles(purchaseData.billingCycles, false);
                        if (normalizedCycles.length > 0) {
                            plan.ciclos_facturacion_extraidos = normalizedCycles;
                        }
                    }

                    if (
                        productData.sourceType === 'fastura-colombia-tabs'
                        && (!Array.isArray(plan.ciclos_facturacion_extraidos) || plan.ciclos_facturacion_extraidos.length === 0)
                        && plan.precio
                    ) {
                        plan.ciclos_facturacion_extraidos = [{
                            ciclo: plan.ciclo || 'Mensual',
                            precio: plan.precio,
                            descuento: '',
                            precio_original: ''
                        }];
                    }
                }
                // Esperar un poco entre requests para evitar saturar el servidor
                await new Promise(r => setTimeout(r, 500));
            }

            // 3. Actualizar JSON si tenemos datos
            updateProductJSON(product, productData);
        } else {
            console.log(`   ⚠️  No se encontraron planes en la página principal.`);
            console.log(`   ℹ️  (Puede ser un SPA o los precios fueron establecidos manualmente en el JSON).`);
            updateProductJSON(product, productData || { plans: [] });
        }

        // Esperar un poco entre requests
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`\n${'═'.repeat(40)}`);
    console.log('✅ Scraping completado');

    // Mostrar resumen de archivos
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.json'));
    console.log(`\n📊 RESUMEN:`);
    console.log(`   Total archivos JSON: ${files.length}`);
    for (const f of files) {
        const size = fs.statSync(path.join(KNOWLEDGE_DIR, f)).size;
        console.log(`   - ${f} (${(size / 1024).toFixed(1)} KB)`);
    }
}

async function runBuhoStoreScrape() {
    await main();
}

if (require.main === module) {
    runBuhoStoreScrape().catch(err => console.error('Error fatal:', err));
}

module.exports = {
    runBuhoStoreScrape
};
