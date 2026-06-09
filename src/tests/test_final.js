require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Only working keys (excludes suspended #2 and #7, loaded from env)
const WORKING_KEYS = [
    { idx: 1, key: process.env.GEMINI_API_KEY_1 },
    { idx: 3, key: process.env.GEMINI_API_KEY_3 },
    { idx: 4, key: process.env.GEMINI_API_KEY_4 },
    { idx: 5, key: process.env.GEMINI_API_KEY_5 },
    { idx: 6, key: process.env.GEMINI_API_KEY_6 },
].filter(k => k.key);

// ============ PART 1: Test regex fallback ============
function testRegexFallback() {
    console.log('=== PART 1: REGEX FALLBACK TESTS (no API) ===\n');
    
    // Inline product detection (same as service)
    function detectProduct(msg) {
        msg = String(msg || '').trim().toLowerCase();
        const products = [
            { pattern: /\bpro\s*8\b/i, name: 'Pro 8' },
            { pattern: /\bpro\s*7\b/i, name: 'Pro 7' },
            { pattern: /\bprox\b/i, name: 'ProX' },
            { pattern: /\bfastura\b/i, name: 'Fastura' },
            { pattern: /\bfactura\s*f[aá]cil\b/i, name: 'Factura Fácil' },
            { pattern: /\bhosting\b/i, name: 'Hosting' },
            { pattern: /\bvps\b/i, name: 'VPS' },
            { pattern: /\bcorreos?\s*(corporativ|empresarial)/i, name: 'Correos Corporativos' },
            { pattern: /\bzoho\s*mail\b/i, name: 'Zoho Mail' },
            { pattern: /\bbuho\s*chat\b/i, name: 'BuhoChat' },
            { pattern: /\bbuhochat\b/i, name: 'BuhoChat' },
            { pattern: /\bcertificad[oa]s?\s*dian\b/i, name: 'Certificados DIAN' },
            { pattern: /\bcertificad[oa]s?\s*sunat\b/i, name: 'Certificado SUNAT' },
            { pattern: /\bvendeya\b/i, name: 'VendeYa' },
            { pattern: /\bvende\s*ya\b/i, name: 'VendeYa' },
            { pattern: /\bapp\s*31\b/i, name: 'App31' },
            { pattern: /\bapp31\b/i, name: 'App31' },
            { pattern: /\bqr\s*buho\b/i, name: 'QR Buho' },
            { pattern: /\bmozo\b/i, name: 'Mozo' },
            { pattern: /\bwaya\b/i, name: 'Waya Empresa' },
            { pattern: /\bvalidaci[oó]n\b/i, name: 'Validación' },
        ];
        for (const p of products) if (p.pattern.test(msg)) return p.name;
        return null;
    }
    
    function classifyIntent(msg) {
        msg = String(msg || '').trim().toLowerCase();
        if (/^(hola|buenos?\s*(d[ií]as?|tardes?|noches?)|hey|saludos|qu[eé]\s*tal|hi|hello)\b/.test(msg) && msg.length < 40) return 'greeting';
        if (/\b(adi[oó]s|hasta\s*luego|chao|chau|bye|nos\s*vemos|gracias\s*por\s*todo|eso\s*(ser[ií]a|es)\s*todo|ok\s*gracias|muchas\s*gracias)\b/.test(msg)) return 'farewell';
        if (/\b(comprar|adquirir|quiero\s*el|me\s*quedo\s*con|lo\s*quiero|activar|contratar|tomar\s*el|vamos\s*con|me\s*interesa\s*comprar|vendeme|v[eé]ndeme)\b/.test(msg)) return 'purchase_interest';
        if (/\b(precio|precios|cu[aá]nto\s*(cuesta|vale|est[aá]|sale)|costo|costos|tarifa|valor|mensual|trimestral|semestral|anual)\b/.test(msg)) return 'price_inquiry';
        if (/\b(problema|no\s*funciona|error|falla|malo|p[eé]simo|queja|reclamo|insatisf|molest|no\s*sirve|lento|ca[ií]do|no\s*responde|deficiente)\b/.test(msg)) return 'complaint';
        if (/\b(ayuda|soporte|asistencia|no\s*puedo|c[oó]mo\s*(hago|puedo|configuro|instalo|activo)|necesito\s*ayuda|tengo\s*(un|una)\s*(duda|problema|consulta))\b/.test(msg)) return 'support';
        if (detectProduct(msg)) return 'info_request';
        if (/\b(informaci[oó]n|info|detalles|caracter[ií]sticas|incluye|qu[eé]\s*(es|ofrece|tiene|incluye|vende)|cu[aá]les?\s*(son|hay)|opciones|cat[aá]logo|servicios|productos|ofrecen|que\s*mas)\b/.test(msg)) return 'info_request';
        if (/\?$/.test(msg.trim()) || /^(cu[aá]l|qu[eé]|c[oó]mo|d[oó]nde|cu[aá]ndo|por\s*qu[eé]|para\s*qu[eé]|tienen|hay|existe|es\s*posible)\b/.test(msg)) return 'question';
        return 'other';
    }
    
    function extractTopic(msg, product, intent) {
        if (product && product !== 'NINGUNO') {
            const labelMap = { 'purchase_interest': 'Interés de compra', 'price_inquiry': 'Consulta precio', 'complaint': 'Problema con', 'support': 'Soporte técnico', 'info_request': 'Consulta sobre', 'question': 'Consulta sobre' };
            return `${labelMap[intent] || 'Consulta sobre'} ${product}`;
        }
        const topicMap = { 'greeting': 'Saludo inicial', 'farewell': 'Cierre de conversación', 'purchase_interest': 'Interés de compra', 'price_inquiry': 'Consulta de precios', 'complaint': 'Reporte de problema', 'support': 'Soporte técnico', 'info_request': 'Consulta catálogo de productos', 'question': 'Consulta general', 'other': 'Mensaje no clasificable' };
        return topicMap[intent] || 'Consulta general';
    }
    
    const tests = [
        { msg: 'hola', wantIntent: 'greeting', wantProduct: null, wantTopic: 'Saludo inicial' },
        { msg: 'buenas tardes', wantIntent: 'greeting', wantProduct: null, wantTopic: 'Saludo inicial' },
        { msg: 'mozo??', wantIntent: 'info_request', wantProduct: 'Mozo', wantTopic: 'Consulta sobre Mozo' },
        { msg: 'el pro8 que tal es', wantIntent: 'info_request', wantProduct: 'Pro 8', wantTopic: 'Consulta sobre Pro 8' },
        { msg: 'cuanto cuesta el hosting', wantIntent: 'price_inquiry', wantProduct: 'Hosting', wantTopic: 'Consulta precio Hosting' },
        { msg: 'en tus productos en que mas', wantIntent: 'info_request', wantProduct: null, wantTopic: 'Consulta catálogo de productos' },
        { msg: 'que mas ofrecen', wantIntent: 'info_request', wantProduct: null, wantTopic: 'Consulta catálogo de productos' },
        { msg: 'quiero comprar fastura', wantIntent: 'purchase_interest', wantProduct: 'Fastura', wantTopic: 'Interés de compra Fastura' },
        { msg: 'no funciona el sistema que compre', wantIntent: 'complaint', wantProduct: null, wantTopic: 'Reporte de problema' },
        { msg: 'gracias eso es todo', wantIntent: 'farewell', wantProduct: null, wantTopic: 'Cierre de conversación' },
        { msg: 'ok', wantIntent: 'other', wantProduct: null, wantTopic: 'Mensaje no clasificable' },
        { msg: 'jajaja', wantIntent: 'other', wantProduct: null, wantTopic: 'Mensaje no clasificable' },
        { msg: 'y el VPS?', wantIntent: 'info_request', wantProduct: 'VPS', wantTopic: 'Consulta sobre VPS' },
        { msg: 'tienen correos corporativos?', wantIntent: 'info_request', wantProduct: 'Correos Corporativos', wantTopic: 'Consulta sobre Correos Corporativos' },
        { msg: 'que es buhochat', wantIntent: 'info_request', wantProduct: 'BuhoChat', wantTopic: 'Consulta sobre BuhoChat' },
        { msg: 'necesito certificado dian', wantIntent: 'info_request', wantProduct: 'Certificados DIAN', wantTopic: 'Consulta sobre Certificados DIAN' },
        { msg: 'como funciona app31', wantIntent: 'info_request', wantProduct: 'App31', wantTopic: 'Consulta sobre App31' },
        { msg: 'vendeme el pro 7', wantIntent: 'purchase_interest', wantProduct: 'Pro 7', wantTopic: 'Interés de compra Pro 7' },
        { msg: 'ok gracias', wantIntent: 'farewell', wantProduct: null, wantTopic: 'Cierre de conversación' },
        { msg: 'aaaaa', wantIntent: 'other', wantProduct: null, wantTopic: 'Mensaje no clasificable' },
    ];
    
    let passed = 0;
    for (const t of tests) {
        const intent = classifyIntent(t.msg);
        const product = detectProduct(t.msg);
        const topic = extractTopic(t.msg, product, intent);
        
        const intentOk = intent === t.wantIntent;
        const productOk = t.wantProduct === null ? !product : (product === t.wantProduct);
        const topicOk = topic === t.wantTopic;
        const ok = intentOk && productOk && topicOk;
        if (ok) passed++;
        
        const icon = ok ? '✅' : '❌';
        const issues = [];
        if (!intentOk) issues.push(`intent: got "${intent}", want "${t.wantIntent}"`);
        if (!productOk) issues.push(`product: got "${product}", want "${t.wantProduct}"`);
        if (!topicOk) issues.push(`topic: got "${topic}", want "${t.wantTopic}"`);
        
        console.log(`${icon} "${t.msg}" → intent=${intent} product=${product || '-'} topic="${topic}"${issues.length ? ' | ' + issues.join('; ') : ''}`);
    }
    
    console.log(`\n--- Regex fallback: ${passed}/${tests.length} passed (${((passed/tests.length)*100).toFixed(0)}%) ---\n`);
    return passed === tests.length;
}

// ============ PART 2: Test AI classification (1 call per key) ============
async function testAIClassification() {
    console.log('=== PART 2: AI CLASSIFICATION (1 call per key, 5 tests) ===\n');
    
    const prompt = (msg) => `Clasifica este mensaje de WhatsApp. Responde SOLO JSON sin backticks ni texto extra:
{"intent":"...","sentiment":"...","outcome":"...","topic_summary":"...","product_consulted":null,"confidence":0.9}

Intents: greeting, farewell, info_request, price_inquiry, purchase_interest, complaint, support, question, other
Productos: Pro 8, Pro 7, ProX, Fastura, Hosting, VPS, Correos Corporativos, BuhoChat, Certificados DIAN, VendeYa, App31, QR Buho, Mozo, Waya
Reglas:
- Si menciona producto → product_consulted=nombre del producto
- topic_summary = etiqueta genérica (Saludo inicial, Consulta sobre [producto], Consulta catálogo de productos, Cierre de conversación, Confirmación, Mensaje no clasificable). PROHIBIDO copiar el mensaje.
- "mozo??" = info_request, product=Mozo
- Preguntas informales sobre producto = info_request

Mensaje: "${msg}"`;

    const tests = [
        { msg: 'mozo??', wantIntent: 'info_request', wantProduct: 'Mozo' },
        { msg: 'cuanto cuesta el hosting', wantIntent: 'price_inquiry', wantProduct: 'Hosting' },
        { msg: 'hola', wantIntent: 'greeting', wantProduct: null },
        { msg: 'vendeme el pro 7', wantIntent: 'purchase_interest', wantProduct: 'Pro 7' },
        { msg: 'gracias eso es todo', wantIntent: 'farewell', wantProduct: null },
    ];
    
    let passed = 0;
    for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const keyInfo = WORKING_KEYS[i % WORKING_KEYS.length];
        
        try {
            const genAI = new GoogleGenerativeAI(keyInfo.key);
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                generationConfig: { temperature: 0.1, maxOutputTokens: 1024, topP: 0.8 }
            });
            
            const start = Date.now();
            const result = await Promise.race([
                model.generateContent([{ text: prompt(t.msg) }]),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout 12s')), 12000))
            ]);
            const elapsed = Date.now() - start;
            const raw = result.response.text().trim();
            const json = raw.match(/\{[\s\S]*\}/);
            
            if (!json) {
                console.log(`⚠️ Key#${keyInfo.idx} "${t.msg}" → No JSON (${elapsed}ms)`);
                continue;
            }
            
            const j = JSON.parse(json[0]);
            const intentOk = j.intent === t.wantIntent;
            const productOk = t.wantProduct === null
                ? (!j.product_consulted || j.product_consulted === null || j.product_consulted === 'null')
                : (j.product_consulted && j.product_consulted.toLowerCase().includes(t.wantProduct.toLowerCase()));
            const topicOk = j.topic_summary && j.topic_summary.toLowerCase() !== t.msg.toLowerCase();
            
            const ok = intentOk && productOk && topicOk;
            if (ok) passed++;
            
            const icon = ok ? '✅' : '❌';
            console.log(`${icon} Key#${keyInfo.idx} (${elapsed}ms) "${t.msg}" → intent=${j.intent} product=${j.product_consulted || '-'} topic="${j.topic_summary}"`);
            if (!ok) {
                if (!intentOk) console.log(`   ↳ intent wrong: got "${j.intent}", want "${t.wantIntent}"`);
                if (!productOk) console.log(`   ↳ product wrong: got "${j.product_consulted}", want "${t.wantProduct}"`);
                if (!topicOk) console.log(`   ↳ topic is literal copy`);
            }
        } catch (e) {
            const isRate = /429|resource.*exhausted|rate/i.test(e.message);
            if (isRate) {
                console.log(`🔄 Key#${keyInfo.idx} RATE LIMITED — "${t.msg}" skipped`);
            } else {
                console.log(`❌ Key#${keyInfo.idx} ERROR — "${t.msg}": ${e.message.substring(0, 80)}`);
            }
        }
        
        if (i < tests.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log(`\n--- AI classification: ${passed}/${tests.length} passed ---`);
    return passed;
}

// ============ MAIN ============
async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  FINAL TEST: Regex + AI Classification          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    
    const regexOk = testRegexFallback();
    
    if (!regexOk) {
        console.log('⚠️ Regex fallback has issues — AI classification will be tested anyway\n');
    }
    
    const aiPassed = await testAIClassification();
    
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║  FINAL SUMMARY                                  ║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Regex fallback: ${regexOk ? '✅ ALL PASS' : '❌ ISSUES'}                       ║`);
    console.log(`║  AI classification: ${aiPassed}/5 passed              ║`);
    console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
