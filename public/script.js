const API_BASE = window.location.origin;
const ADMIN_TOKEN_STORAGE_KEY = 'iaBuhoAdminApiToken';
const DEBUG_MAX_LINES = 220;

let selectedUserPhone = '';
let adminToken = '';
let debugEnabled = true;
let debugLines = [];
let lastHealthPayload = null;
let lastCutoffLoggedAt = 0;
let lastRequestDebugId = '';

// =============================================
// CHART SYSTEM — Metrics History Buffer + Charts
// =============================================
const HISTORY_MAX = 30;
const metricsHistory = {
    labels: [],
    received: [],
    processed: [],
    failed: []
};

let chartMessages = null;
let chartLatency = null;
let chartTokens = null;
let chartMpm = null;
let chartMph = null;
let chartMemory = null;
let chartKeys = null;

// Sparkline history buffers
const mpmHistory = [];
const mphHistory = [];
const memoryHistory = [];

// Track previous counters to compute deltas
let prevCounters = { received: null, processed: null, failed: null };

function pushMetricsHistory(data) {
    const now = new Date();
    const label = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0') + ':' + now.getSeconds().toString().padStart(2,'0');

    const curReceived = data.counters?.messagesReceived || 0;
    const curProcessed = data.counters?.messagesProcessed || 0;
    const curFailed = data.counters?.messagesFailed || 0;

    // Calculate deltas (new messages since last poll)
    const deltaR = prevCounters.received !== null ? Math.max(0, curReceived - prevCounters.received) : 0;
    const deltaP = prevCounters.processed !== null ? Math.max(0, curProcessed - prevCounters.processed) : 0;
    const deltaF = prevCounters.failed !== null ? Math.max(0, curFailed - prevCounters.failed) : 0;

    prevCounters.received = curReceived;
    prevCounters.processed = curProcessed;
    prevCounters.failed = curFailed;

    metricsHistory.labels.push(label);
    metricsHistory.received.push(deltaR);
    metricsHistory.processed.push(deltaP);
    metricsHistory.failed.push(deltaF);

    for (const key of Object.keys(metricsHistory)) {
        if (metricsHistory[key].length > HISTORY_MAX) {
            metricsHistory[key].shift();
        }
    }
}

function initCharts() {
    const gridColor = 'rgba(255,255,255,0.04)';
    const tickColor = '#64748b';

    Chart.defaults.font.family = 'Inter, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = tickColor;

    // 1. Messages Area Line Chart (daily — grows as month progresses)
    const msgCtx = document.getElementById('chartMessages');
    if (msgCtx) {
        chartMessages = new Chart(msgCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Recibidos',
                        data: [],
                        borderColor: '#94a3b8',
                        backgroundColor: 'rgba(148,163,184,0.12)',
                        fill: true,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 4,
                        pointBackgroundColor: '#94a3b8',
                        pointHitRadius: 10
                    },
                    {
                        label: 'Procesados',
                        data: [],
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16,185,129,0.12)',
                        fill: true,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 4,
                        pointBackgroundColor: '#10b981',
                        pointHitRadius: 10
                    },
                    {
                        label: 'Errores',
                        data: [],
                        borderColor: '#f43f5e',
                        backgroundColor: 'rgba(244,63,94,0.12)',
                        fill: true,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 4,
                        pointBackgroundColor: '#f43f5e',
                        pointHitRadius: 10
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 16, font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: '#1e1e24',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        titleFont: { size: 11 },
                        bodyFont: { size: 11 },
                        padding: 10,
                        cornerRadius: 8
                    }
                },
                scales: {
                    x: { grid: { color: gridColor }, ticks: { maxTicksLimit: 15, font: { size: 9 } } },
                    y: { grid: { color: gridColor }, beginAtZero: true, ticks: { maxTicksLimit: 5 } }
                },
                animation: { duration: 400, easing: 'easeOutQuart' }
            }
        });
    }

    // 2. Latency Bar Chart
    const latCtx = document.getElementById('chartLatency');
    if (latCtx) {
        chartLatency = new Chart(latCtx, {
            type: 'bar',
            data: {
                labels: ['P50', 'P95', 'P99'],
                datasets: [{
                    label: 'ms',
                    data: [0, 0, 0],
                    backgroundColor: ['rgba(192,132,252,0.6)', 'rgba(251,191,36,0.6)', 'rgba(244,63,94,0.6)'],
                    borderColor: ['#c084fc', '#fbbf24', '#f43f5e'],
                    borderWidth: 1,
                    borderRadius: 6,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1e1e24',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 8,
                        cornerRadius: 8,
                        callbacks: { label: (ctx) => ctx.parsed.x + ' ms' }
                    }
                },
                scales: {
                    x: { grid: { color: gridColor }, beginAtZero: true, ticks: { maxTicksLimit: 4, callback: (v) => v + 'ms' } },
                    y: { grid: { display: false } }
                },
                animation: { duration: 400 }
            }
        });
    }

    // 3. Tokens per message bar chart
    const tokCtx = document.getElementById('chartTokens');
    if (tokCtx) {
        chartTokens = new Chart(tokCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Input',
                        data: [],
                        backgroundColor: 'rgba(148,163,184,0.5)',
                        borderColor: '#94a3b8',
                        borderWidth: 1,
                        borderRadius: 4,
                        barPercentage: 0.7,
                        maxBarThickness: 28
                    },
                    {
                        label: 'Output',
                        data: [],
                        backgroundColor: 'rgba(192,132,252,0.5)',
                        borderColor: '#c084fc',
                        borderWidth: 1,
                        borderRadius: 4,
                        barPercentage: 0.7,
                        maxBarThickness: 28
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12, font: { size: 10 } }
                    },
                    tooltip: {
                        backgroundColor: '#1e1e24',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 8,
                        cornerRadius: 8,
                        callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens' }
                    }
                },
                scales: {
                    x: { grid: { color: gridColor }, ticks: { font: { size: 8 }, maxTicksLimit: 10 } },
                    y: { grid: { color: gridColor }, beginAtZero: true, ticks: { maxTicksLimit: 4 } }
                },
                animation: { duration: 400 }
            }
        });
    }

    // 4. MPM Sparkline
    const mpmCtx = document.getElementById('chartMpm');
    if (mpmCtx) {
        chartMpm = new Chart(mpmCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
        });
    }

    // 4b. MPH Sparkline (messages per hour)
    const mphCtx = document.getElementById('chartMph');
    if (mphCtx) {
        chartMph = new Chart(mphCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
        });
    }

    // 5. Memory Sparkline
    const memCtx = document.getElementById('chartMemory');
    if (memCtx) {
        chartMemory = new Chart(memCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ data: [], borderColor: '#c084fc', backgroundColor: 'rgba(192,132,252,0.1)', fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
        });
    }

    // 6. API Keys bar chart
    const keysCtx = document.getElementById('chartKeys');
    if (keysCtx) {
        chartKeys = new Chart(keysCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    { label: 'Llamadas', data: [], backgroundColor: 'rgba(16,185,129,0.5)', borderColor: '#10b981', borderWidth: 1, borderRadius: 6, barPercentage: 0.6 },
                    { label: 'Errores', data: [], backgroundColor: 'rgba(244,63,94,0.5)', borderColor: '#f43f5e', borderWidth: 1, borderRadius: 6, barPercentage: 0.6 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (evt, elements) => {
                    if (elements.length > 0) openKeyModal(elements[0].index);
                },
                plugins: {
                    legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12, font: { size: 10 } } },
                    tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 8 }
                },
                scales: {
                    x: { grid: { color: gridColor } },
                    y: { grid: { color: gridColor }, beginAtZero: true, ticks: { maxTicksLimit: 5 } }
                },
                animation: { duration: 400 }
            }
        });
    }
}

function updateCharts(data) {
    pushMetricsHistory(data);

    // Messages chart is loaded from daily MySQL data, not live updates

    if (chartLatency) {
        chartLatency.data.datasets[0].data = [
            data.latency?.p50 || 0,
            data.latency?.p95 || 0,
            data.latency?.p99 || 0
        ];
        chartLatency.update('none');
    }

    // Tokens chart loaded from daily MySQL data, not live updates

    // MPM sparkline
    const mpm = data.throughput?.messagesPerMinute || 0;
    mpmHistory.push(mpm);
    if (mpmHistory.length > HISTORY_MAX) mpmHistory.shift();
    if (chartMpm) {
        chartMpm.data.labels = mpmHistory.map((_, i) => i);
        chartMpm.data.datasets[0].data = mpmHistory;
        chartMpm.update('none');
    }

    // MPH sparkline — use actual processed count as running total
    const processed = data.counters?.messagesProcessed || 0;
    mphHistory.push(processed);
    if (mphHistory.length > HISTORY_MAX) mphHistory.shift();
    if (chartMph) {
        chartMph.data.labels = mphHistory.map((_, i) => i);
        chartMph.data.datasets[0].data = mphHistory;
        chartMph.update('none');
    }

    // Memory sparkline
    const heapStr = data.memory?.heapUsed || '0';
    const heapMb = parseFloat(String(heapStr).replace(/[^\d.]/g, '')) || 0;
    memoryHistory.push(heapMb);
    if (memoryHistory.length > HISTORY_MAX) memoryHistory.shift();
    if (chartMemory) {
        chartMemory.data.labels = memoryHistory.map((_, i) => i);
        chartMemory.data.datasets[0].data = memoryHistory;
        chartMemory.update('none');
    }

    // Keys chart
    const keys = data.services?.gemini?.keys || [];
    if (chartKeys && keys.length > 0) {
        chartKeys.data.labels = keys.map(k => k.label || 'Key #' + k.index);
        chartKeys.data.datasets[0].data = keys.map(k => k.totalCalls || 0);
        chartKeys.data.datasets[1].data = keys.map(k => k.totalErrors || 0);
        chartKeys.update('none');
    }

    // Total errors KPI — fetch from MySQL for persistence across restarts
    _refreshErrorCount();
}

function debugLog(message, data = null, level = 'log') {
    if (!debugEnabled) return;

    const ts = new Date().toLocaleTimeString();
    const serialized = data ? ' | ' + JSON.stringify(data) : '';
    const line = `[${ts}] ${String(message || '')}${serialized}`;

    debugLines.push(line);
    if (debugLines.length > DEBUG_MAX_LINES) {
        debugLines = debugLines.slice(debugLines.length - DEBUG_MAX_LINES);
    }

    const box = document.getElementById('debugConsole');
    if (box) {
        box.textContent = debugLines.join('\n');
        box.scrollTop = box.scrollHeight;
    }

    if (level === 'error') {
        console.error('[INDEX DEBUG]', message, data || '');
    } else if (level === 'warn') {
        console.warn('[INDEX DEBUG]', message, data || '');
    } else {
        console.log('[INDEX DEBUG]', message, data || '');
    }
}

function clearDebugConsole() {
    debugLines = [];
    const box = document.getElementById('debugConsole');
    if (box) box.textContent = '';
    debugLog('Consola de depuración limpiada manualmente.');
}

async function copyDebugConsole() {
    try {
        const text = debugLines.join('\n');
        await navigator.clipboard.writeText(text || 'Sin registros en consola de depuración.');
        showToast('Consola de depuración copiada');
    } catch (_) {
        showToast('No se pudo copiar la consola de depuración');
    }
}

function toggleDebugConsole() {
    debugEnabled = !debugEnabled;
    const btn = document.getElementById('debugToggleBtn');
    if (btn) {
        btn.textContent = debugEnabled ? 'Depurar ON' : 'Depurar OFF';
        btn.classList.toggle('active', debugEnabled);
    }
    if (debugEnabled) {
        debugLog('Depuración reactivada.');
    }
}

function getStoredAdminToken() {
    return String(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
}

function setStoredAdminToken(token) {
    const value = String(token || '').trim();
    if (!value) {
        localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
        return;
    }

    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
}

function updateAdminTokenStatus() {
    const status = document.getElementById('adminTokenStatus');
    const input = document.getElementById('adminTokenInput');
    const hasToken = Boolean(adminToken);
    
    if (status) {
        status.textContent = hasToken
            ? '✅ Protegido por Token'
            : '⚠️ Sin Token configurado';
        status.className = hasToken ? 'status-text success' : 'status-text warning';
    }
    
    if (input) {
        input.value = adminToken;
    }
}

function ensureAdminToken() {
    adminToken = getStoredAdminToken();
    const overlay = document.getElementById('adminTokenOverlay');
    
    if (adminToken) {
        if (overlay) overlay.style.display = 'none';
        return true;
    }

    // Comportamiento modal para token faltante
    if (overlay) overlay.style.display = 'flex';
    updateAdminTokenStatus();
    return false;
}

function saveAdminToken() {
    const input = document.getElementById('adminTokenInput');
    const value = String(input?.value || '').trim();
    adminToken = value;
    setStoredAdminToken(value);
    updateAdminTokenStatus();
    showToast(value ? 'Token guardado' : 'Token eliminado');
    if (value) {
        // Recargar después de un breve retraso para que se muestre el toast
        setTimeout(() => location.reload(), 300);
    }
}

function buildAuthHeaders(base = {}) {
    const headers = { ...base };
    if (adminToken) {
        headers['Authorization'] = 'Bearer ' + adminToken;
        headers['X-Admin-Token'] = adminToken;
    }
    return headers;
}

async function fetchJSON(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const t0 = Date.now();
    debugLog(`HTTP ${method} ${url} -> inicio`);

    const customHeaders = options.headers || {};
    const body = options.body;
    const defaultHeaders = body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {};

    const res = await fetch(API_BASE + url, {
        ...options,
        headers: buildAuthHeaders({ ...defaultHeaders, ...customHeaders })
    });

    if (!res.ok) {
        let payload = null;
        try {
            payload = await res.json();
        } catch (_) {
            payload = null;
        }

        const serverMessage = payload && payload.error ? String(payload.error) : '';
        debugLog(`HTTP ${method} ${url} -> error ${res.status}`, {
            status: res.status,
            elapsedMs: Date.now() - t0,
            error: serverMessage || ('HTTP ' + res.status)
        }, 'error');
        if (res.status === 401 || res.status === 403) {
            throw new Error(serverMessage || 'No autorizado: revisa ADMIN_API_TOKEN');
        }
        throw new Error(serverMessage || ('HTTP ' + res.status));
    }
    const payload = await res.json();
    debugLog(`HTTP ${method} ${url} -> ok`, {
        status: res.status,
        elapsedMs: Date.now() - t0
    });
    return payload;
}

async function openSecuredEndpoint(path) {
    try {
        if (!adminToken && !ensureAdminToken()) {
            showToast('Necesitas token para abrir ese endpoint');
            return;
        }

        const data = await fetchJSON(path);
        const popup = window.open('', '_blank', 'noopener,noreferrer');
        if (!popup) {
            showToast('Activa ventanas emergentes para abrir la respuesta');
            return;
        }

        popup.document.write(`
            <style>
                body { background: #000; color: #a4b1cd; font-family: 'Inter', monospace; padding: 2rem; }
                pre { background: #0a0a0f; padding: 1.5rem; border-radius: 12px; border: 1px solid rgba(138, 43, 226, 0.2); }
            </style>
            <pre>${JSON.stringify(data, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        `);
        popup.document.close();
    } catch (err) {
        debugLog('openSecuredEndpoint fallo', { path, error: err.message || String(err) }, 'error');
        showToast(err.message || 'No se pudo abrir endpoint protegido');
    }
}

function showToast(message) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast show';
    el.textContent = message;
    wrap.appendChild(el);
    
    // React-like mount effect
    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0) scale(1)';
    });

    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px) scale(0.95)';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

function formatTs(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString();
}

// Actualiza los values y lanza un pulse effect si cambiaron
function setInputValueWithEffect(id, newValue) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.value != newValue) {
        el.value = newValue;
        el.classList.add('pulse-effect');
        setTimeout(() => el.classList.remove('pulse-effect'), 500);
    }
}

function setInnerHtmlWithEffect(id, newHtml) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.innerHTML !== newHtml) {
        el.innerHTML = newHtml;
        el.classList.add('pulse-text');
        setTimeout(() => el.classList.remove('pulse-text'), 500);
    }
}

function setTextContentWithEffect(id, newText) {
    const el = document.getElementById(id);
    if (!el) return;
    const textStr = String(newText);
    if (el.textContent !== textStr) {
        el.textContent = textStr;
        el.classList.add('pulse-text');
        setTimeout(() => el.classList.remove('pulse-text'), 500);
    }
}

async function loadGeneralConfig() {
    try {
        const cfg = await fetchJSON('/api/config');
        if(cfg && cfg.conversation) {
            setInputValueWithEffect('gConvoMaxHistory', cfg.conversation.maxHistoryMessages);
            setInputValueWithEffect('gConvoTimeout', cfg.conversation.inactivityTimeoutMs);
        }
    } catch (err) {
        showToast('No se pudo cargar configuracion global');
    }
}

async function saveGlobalConversation() {
    try {
        await fetchJSON('/api/config', {
            method: 'PUT',
            body: JSON.stringify({
                section: 'conversation',
                data: {
                    maxHistoryMessages: parseInt(document.getElementById('gConvoMaxHistory').value || 10),
                    inactivityTimeoutMs: parseInt(document.getElementById('gConvoTimeout').value || 600000)
                }
            })
        });
        showToast('Conversaciones global actualizada');
    } catch (err) {
        showToast('Error guardando configuracion global');
    }
}

async function loadUsers() {
    try {
        const data = await fetchJSON('/api/users');
        const users = data.users || [];
        const select = document.getElementById('userSelect');
        if(!select) return;

        if (users.length === 0) {
            select.innerHTML = '<option value="">Sin usuarios detectados</option>';
            return;
        }

        const currentVal = select.value;
        const optionsHtml = users.map((u) => {
            const name = u.userName ? ' - ' + u.userName : '';
            return `<option value="${u.phone}">${u.phone}${name}</option>`;
        }).join('');
        
        select.innerHTML = optionsHtml;
        
        const chatUserList = document.getElementById('chatUserList');
        if (chatUserList) {
            chatUserList.innerHTML = users.map((u) => {
                const isActive = u.phone === selectedUserPhone ? 'active' : '';
                const initial = (u.userName || u.phone || '?').charAt(0).toUpperCase();
                const displayName = u.userName || 'Sin nombre';
                const lastSeen = u.lastSeenAt ? timeAgo(u.lastSeenAt) : '';
                return `<div class="chat-user-item ${isActive}" onclick="syncUserSelect('${u.phone}')" data-phone="${u.phone}" data-name="${(displayName).toLowerCase()}">
                    <div class="chat-user-initials">${initial}</div>
                    <div class="chat-user-details">
                        <div class="chat-user-name">${escapeHtml(displayName)}</div>
                        <div class="chat-user-phone">${u.phone}</div>
                    </div>
                    ${lastSeen ? `<span class="chat-user-time">${lastSeen}</span>` : ''}
                </div>`;
            }).join('');
        }

        if (currentVal && users.some((u) => u.phone === currentVal)) {
            select.value = currentVal;
            selectedUserPhone = currentVal;
        } else if (!selectedUserPhone || !users.some((u) => u.phone === selectedUserPhone)) {
            selectedUserPhone = users[0].phone;
            select.value = selectedUserPhone;
        } else {
            select.value = selectedUserPhone;
        }

        await loadSelectedUserConfig();
    } catch (err) {
        showToast('No se pudo cargar usuarios');
    }
}

async function selectManualPhone() {
    const phone = String(document.getElementById('manualPhone').value || '').trim();
    if (!phone) {
        showToast('Ingresa un numero de WhatsApp');
        return;
    }

    selectedUserPhone = phone;
    await loadSelectedUserConfig();
    await loadUsers();
}

async function loadSelectedUserConfig() {
    const select = document.getElementById('userSelect');
    if(!select) return;
    const selected = String(select.value || selectedUserPhone || '').trim();

    if (!selected) {
        return;
    }

    selectedUserPhone = selected;

    try {
        const data = await fetchJSON('/api/users/' + encodeURIComponent(selectedUserPhone) + '/config');
        const s = data.settings;
        const user = data.user || {};

        if (s?.rateLimiting) {
            setInputValueWithEffect('uRateMax', s.rateLimiting.maxMessagesPerWindow);
            setInputValueWithEffect('uRateWindow', s.rateLimiting.windowSizeMs);
            setInputValueWithEffect('uRateCooldown', s.rateLimiting.cooldownMs);
        }

        if (s?.gemini) {
            setInputValueWithEffect('uGemTemp', s.gemini.temperature);
            setInputValueWithEffect('uGemTokens', s.gemini.maxOutputTokens);
            setInputValueWithEffect('uGemTimeout', s.gemini.timeout);
            setInputValueWithEffect('uGemFail', s.gemini.failureThreshold);
            setInputValueWithEffect('uGemRecovery', s.gemini.recoveryTimeMs);
        }

        const initials = (user.userName || 'U').charAt(0).toUpperCase();
        const meta = `
            <div class="user-profile-header">
                <div class="user-avatar">${initials}</div>
                <div class="user-info">
                    <span class="user-info-name">${user.userName || 'Sin nombre'}</span>
                    <span class="user-info-phone">${selectedUserPhone}</span>
                </div>
            </div>
            <div class="user-metrics">
                <div class="user-metric" onclick="openUserModal('received')">
                    <span class="user-metric-value">${user.messagesReceived || 0}</span>
                    <span class="user-metric-label">Recibidos</span>
                </div>
                <div class="user-metric" onclick="openUserModal('processed')">
                    <span class="user-metric-value">${user.messagesProcessed || 0}</span>
                    <span class="user-metric-label">Procesados</span>
                </div>
                <div class="user-metric user-metric--err" onclick="openUserModal('errors')">
                    <span class="user-metric-value">${user.messagesFailed || 0}</span>
                    <span class="user-metric-label">Errores</span>
                </div>
            </div>
            <div class="user-last-seen">
                <span class="material-symbols-outlined">schedule</span>
                ${formatTs(user.lastSeenAt)}
            </div>`;
        setInnerHtmlWithEffect('userMeta', meta);

        // Update chat header
        const name = user.display_name || user.userName || selectedUserPhone;
        const initial = name.charAt(0).toUpperCase();
        const avatarEl = document.getElementById('chatMainAvatar');
        const nameLabelEl = document.getElementById('chatUserNameLabel');
        const phoneLabelEl = document.getElementById('chatPhoneLabel');
        if (avatarEl) avatarEl.textContent = initial;
        if (nameLabelEl) nameLabelEl.textContent = name;
        if (phoneLabelEl) phoneLabelEl.textContent = selectedUserPhone;

        // Update User Info Panel
        _updateUserInfoPanel(user, data);

    } catch (err) {
        // Silently fail if not found, to avoid spam
    }
}

async function saveUserSection(section) {
    if (!selectedUserPhone) {
        showToast('Selecciona un usuario primero');
        return;
    }

    let dataToSave = {};
    if (section === 'rateLimiting') {
        dataToSave = {
            maxMessagesPerWindow: parseInt(document.getElementById('uRateMax').value),
            windowSizeMs: parseInt(document.getElementById('uRateWindow').value),
            cooldownMs: parseInt(document.getElementById('uRateCooldown').value)
        };
    } else {
        dataToSave = {
            temperature: parseFloat(document.getElementById('uGemTemp').value),
            maxOutputTokens: parseInt(document.getElementById('uGemTokens').value),
            timeout: Math.max(parseInt(document.getElementById('uGemTimeout').value), 18000),
            failureThreshold: parseInt(document.getElementById('uGemFail').value),
            recoveryTimeMs: parseInt(document.getElementById('uGemRecovery').value)
        };
    }

    debugLog('Guardando configuracion de usuario', { phone: selectedUserPhone, section, data: dataToSave });

    try {
        const response = await fetchJSON('/api/users/' + encodeURIComponent(selectedUserPhone) + '/config', {
            method: 'PUT',
            body: JSON.stringify({ section, data: dataToSave })
        });
        showToast('Configuracion guardada para ' + selectedUserPhone);
        await loadSelectedUserConfig();
    } catch (err) {
        showToast('Error guardando: ' + (err.message || 'sin detalle'));
    }
}

let lastKeysData = [];

function renderKeys(keys) {
    const body = document.getElementById('keysList');
    if(!body) return;

    const countEl = document.getElementById('keysCount');
    
    if (!Array.isArray(keys) || keys.length === 0) {
        body.innerHTML = '<div class="keys-empty">Sin llaves configuradas</div>';
        if(countEl) countEl.textContent = '0';
        lastKeysData = [];
        return;
    }

    lastKeysData = keys;
    const activeCount = keys.filter(k => k.active).length;
    if(countEl) countEl.textContent = activeCount + '/' + keys.length + ' activas';

    body.innerHTML = keys.map((k, i) => {
        const statusClass = k.active ? 'active' : 'inactive';
        const statusDot = k.active ? '●' : '○';
        const label = k.label || ('Key #' + k.index);
        return `<div class="key-chip" onclick="openKeyModal(${i})" style="cursor:pointer;">
            <span class="key-chip-status ${statusClass}">${statusDot}</span>
            <span class="key-chip-name">${label}</span>
            <div class="key-chip-stats">
                <span>${k.totalCalls || 0} calls</span>
                <span class="color-err">${k.totalErrors || 0} err</span>
            </div>
        </div>`;
    }).join('');
}

function openKeyModal(index) {
    const k = lastKeysData[index];
    if (!k) return;

    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'API Key #' + k.index;

    const statusLabel = k.active ? '<span style="color:var(--ok);">● Activa</span>' : '<span style="color:var(--danger);">● Inactiva</span>';
    const disabledInfo = !k.active && k.disabledUntil
        ? `<div class="modal-stat-row"><span class="modal-stat-label">Reactivación</span><span class="modal-stat-value">${formatTs(k.disabledUntil)}</span></div>`
        : '';
    const lastErrorInfo = k.lastError
        ? `<div class="modal-section-title">Último error</div>
           <div class="modal-error-item">
               <div class="err-msg">${k.lastError}</div>
               <div class="err-time">${k.lastErrorAt ? formatTs(k.lastErrorAt) : '-'}</div>
           </div>`
        : '';

    body.innerHTML = `
        <div class="modal-stat-row">
            <span class="modal-stat-label">Estado</span>
            <span class="modal-stat-value">${statusLabel}</span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Key completa</span>
            <span class="modal-stat-value" style="font-size:0.7rem; font-family:monospace; word-break:break-all; cursor:pointer;" onclick="copyToClipboard('${k.fullKey || ''}');" title="Click para copiar">${k.fullKey || 'N/A'}</span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Llamadas totales</span>
            <span class="modal-stat-value">${k.totalCalls || 0}</span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Errores totales</span>
            <span class="modal-stat-value" style="color:var(--danger);">${k.totalErrors || 0} <a href="#" onclick="event.preventDefault();openKeyErrorsModal(${k.index + 1}, '${k.label || ''}');" style="color:var(--primary);font-size:0.65rem;margin-left:6px;">ver errores</a></span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Fallos consecutivos</span>
            <span class="modal-stat-value">${k.failures || 0} / ${k.failureThreshold || 3}</span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Último uso</span>
            <span class="modal-stat-value">${k.lastUsedAt ? formatTs(k.lastUsedAt) : 'Nunca'}</span>
        </div>
        ${disabledInfo}
        ${lastErrorInfo}
    `;

    modal.style.display = 'flex';
}

async function openKeyErrorsModal(keyIndex, keyLabel) {
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = `Errores — ${keyLabel || 'Key #' + keyIndex}`;
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando errores...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON(`/api/metrics/errors/key/${keyIndex}`);
        const errors = data.errors || [];

        if (errors.length === 0) {
            body.innerHTML = `
                <div style="text-align:center; padding:2rem; color:var(--on-surface-variant);">
                    <span class="material-symbols-outlined" style="font-size:32px; display:block; margin-bottom:8px; opacity:0.4;">check_circle</span>
                    Sin errores registrados para esta key
                </div>`;
            return;
        }

        const html = errors.map(e => {
            let ctx = '';
            try { const c = JSON.parse(e.context_json || '{}'); ctx = c.probableCause || ''; } catch {}
            return `<div class="modal-error-item">
                <div class="err-code">${e.event_code || 'ERROR'}</div>
                <div class="err-msg">${String(e.message || '').slice(0, 300)}</div>
                ${ctx ? `<div class="err-msg" style="opacity:0.6;font-size:0.6rem;">${ctx}</div>` : ''}
                ${e.user_phone ? `<div style="font-size:0.55rem;color:var(--on-surface-variant);">Usuario: ${e.user_phone}</div>` : ''}
                <div class="err-time">${e.created_at ? formatTs(e.created_at) : '-'}</div>
            </div>`;
        }).join('');

        body.innerHTML = `
            <div class="modal-stat-row" style="margin-bottom:8px;">
                <span class="modal-stat-label">Total errores (último mes)</span>
                <span class="modal-stat-value" style="color:var(--danger);">${errors.length}</span>
            </div>
            ${html}`;
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

function copyToClipboard(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast('API Key copiada al portapapeles');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('API Key copiada');
    });
}

function renderTopUsers(users) {
    // No-op if no target element
}

function renderRecentErrors(errors) {
    // No-op if no target element
}

// =============================================
// MPM DETAIL MODAL (Chart.js)
// =============================================
let _modalChartInstance = null;
function _destroyModalChart() {
    if (_modalChartInstance) { _modalChartInstance.destroy(); _modalChartInstance = null; }
}

function openMpmModal() {
    _destroyModalChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    const hp = lastHealthPayload;
    const current = hp?.throughput?.messagesPerMinute || 0;
    const peak = mpmHistory.length > 0 ? Math.max(...mpmHistory) : 0;
    const avg = mpmHistory.length > 0 ? (mpmHistory.reduce((a, b) => a + b, 0) / mpmHistory.length).toFixed(2) : 0;
    const min = mpmHistory.length > 0 ? Math.min(...mpmHistory) : 0;
    const totalReceived = hp?.counters?.messagesReceived || 0;
    const totalProcessed = hp?.counters?.messagesProcessed || 0;
    const totalFailed = hp?.counters?.messagesFailed || 0;

    title.textContent = 'Mensajes por minuto — Detalle';
    body.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">
            <div class="modal-stat-row"><span class="modal-stat-label">MPM actual</span><span class="modal-stat-value" style="color:var(--ok);">${current}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Pico máximo</span><span class="modal-stat-value">${peak.toFixed(1)}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Promedio</span><span class="modal-stat-value">${avg}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Mínimo</span><span class="modal-stat-value">${min.toFixed(1)}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;">
            <div class="modal-stat-row"><span class="modal-stat-label">Recibidos</span><span class="modal-stat-value">${totalReceived}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Procesados</span><span class="modal-stat-value">${totalProcessed}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Fallidos</span><span class="modal-stat-value" style="color:var(--danger);">${totalFailed}</span></div>
        </div>
        <div style="position:relative;height:180px;"><canvas id="modalMpmChart"></canvas></div>
    `;
    modal.style.display = 'flex';

    setTimeout(() => {
        const ctx = document.getElementById('modalMpmChart');
        if (!ctx) return;
        _modalChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: mpmHistory.map((_, i) => i + 1),
                datasets: [{
                    label: 'MPM',
                    data: [...mpmHistory],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 1, pointHitRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 6, cornerRadius: 6 } },
                scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { maxTicksLimit: 4, font: { size: 9 } } } },
                animation: { duration: 300 }
            }
        });
    }, 50);
}

// =============================================
// MPH DETAIL MODAL (Chart.js) — real hourly data from MySQL
// =============================================
async function openMphModal() {
    _destroyModalChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Mensajes por hora — Detalle';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const dailyData = await fetchJSON('/api/metrics/history/daily');
        const hourly = dailyData.hourlyDistribution || [];

        // Build 24h array (0-23)
        const hourCounts = new Array(24).fill(0);
        let totalMsgs = 0;
        for (const h of hourly) {
            hourCounts[h.hour] = parseInt(h.messages) || 0;
            totalMsgs += hourCounts[h.hour];
        }

        const peak = Math.max(...hourCounts);
        const peakHour = hourCounts.indexOf(peak);
        const avg = Math.round(totalMsgs / 24);

        // Top 3 horas pico
        const ranked = hourCounts.map((c, i) => ({ hour: i, count: c })).sort((a, b) => b.count - a.count);
        const top3 = ranked.slice(0, 3).filter(r => r.count > 0);
        const top3Html = top3.length > 0
            ? top3.map(r => `<span style="color:#f59e0b;font-weight:600;">${r.hour.toString().padStart(2,'0')}:00</span> (${r.count})`).join(' · ')
            : 'Sin datos';

        body.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">
                <div class="modal-stat-row"><span class="modal-stat-label">Total mensajes (mes)</span><span class="modal-stat-value">${totalMsgs}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Promedio / hora</span><span class="modal-stat-value">${avg}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Hora pico</span><span class="modal-stat-value" style="color:#f59e0b;">${peakHour.toString().padStart(2,'0')}:00 (${peak} msgs)</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Pico máximo</span><span class="modal-stat-value">${peak}</span></div>
            </div>
            <div class="modal-stat-row" style="margin-bottom:10px;">
                <span class="modal-stat-label">Top horas de uso</span>
                <span class="modal-stat-value" style="font-size:0.7rem;">${top3Html}</span>
            </div>
            <div style="position:relative;height:180px;"><canvas id="modalMphChart"></canvas></div>
        `;

        setTimeout(() => {
            const ctx = document.getElementById('modalMphChart');
            if (!ctx) return;
            const labels = Array.from({length: 24}, (_, i) => i.toString().padStart(2, '0') + ':00');
            const colors = hourCounts.map(c => c === peak && peak > 0 ? 'rgba(245,158,11,0.85)' : 'rgba(245,158,11,0.4)');
            _modalChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: 'Mensajes',
                        data: hourCounts,
                        backgroundColor: colors,
                        borderColor: '#f59e0b',
                        borderWidth: 1,
                        borderRadius: 3,
                        maxBarThickness: 18
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6, callbacks: { label: (c) => c.parsed.y + ' mensajes' } }
                    },
                    scales: {
                        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 8 }, maxRotation: 0 } },
                        y: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { maxTicksLimit: 4, font: { size: 9 } } }
                    },
                    animation: { duration: 300 }
                }
            });
        }, 50);
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

// =============================================
// MEMORY DETAIL MODAL (Chart.js)
// =============================================
function openMemoryModal() {
    _destroyModalChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    const hp = lastHealthPayload;
    const heapUsed = hp?.memory?.heapUsed || '-';
    const heapTotal = hp?.memory?.heapTotal || '-';
    const rss = hp?.memory?.rss || '-';
    const external = hp?.memory?.external || '-';

    const peak = memoryHistory.length > 0 ? Math.max(...memoryHistory).toFixed(2) : '-';
    const min = memoryHistory.length > 0 ? Math.min(...memoryHistory).toFixed(2) : '-';
    const avg = memoryHistory.length > 0 ? (memoryHistory.reduce((a, b) => a + b, 0) / memoryHistory.length).toFixed(2) : '-';
    const current = memoryHistory.length > 0 ? memoryHistory[memoryHistory.length - 1].toFixed(2) : '-';

    let trend = 'estable';
    if (memoryHistory.length >= 5) {
        const r5 = memoryHistory.slice(-5);
        const diff = r5[r5.length - 1] - r5[0];
        if (diff > 1) trend = '↑ subiendo';
        else if (diff < -1) trend = '↓ bajando';
    }

    title.textContent = 'Memoria — Detalle';
    body.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">
            <div class="modal-stat-row"><span class="modal-stat-label">Heap usado</span><span class="modal-stat-value">${heapUsed}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Heap total</span><span class="modal-stat-value">${heapTotal}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">RSS</span><span class="modal-stat-value">${rss}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">External</span><span class="modal-stat-value">${external}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;">
            <div class="modal-stat-row"><span class="modal-stat-label">Pico</span><span class="modal-stat-value">${peak} MB</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Mín</span><span class="modal-stat-value">${min} MB</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Prom</span><span class="modal-stat-value">${avg} MB</span></div>
        </div>
        <div class="modal-stat-row" style="margin-bottom:8px;"><span class="modal-stat-label">Tendencia</span><span class="modal-stat-value">${trend}</span></div>
        <div style="position:relative;height:180px;"><canvas id="modalMemChart"></canvas></div>
    `;
    modal.style.display = 'flex';

    setTimeout(() => {
        const ctx = document.getElementById('modalMemChart');
        if (!ctx) return;
        _modalChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: memoryHistory.map((_, i) => i + 1),
                datasets: [{
                    label: 'Heap MB',
                    data: [...memoryHistory],
                    borderColor: '#c084fc',
                    backgroundColor: 'rgba(192,132,252,0.1)',
                    fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 1, pointHitRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 6, cornerRadius: 6, callbacks: { label: (c) => c.parsed.y.toFixed(1) + ' MB' } } },
                scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxTicksLimit: 4, font: { size: 9 }, callback: (v) => v + ' MB' } } },
                animation: { duration: 300 }
            }
        });
    }, 50);
}

// =============================================
// TOKENS DETAIL MODAL
// =============================================
async function openTokensModal() {
    _destroyModalChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Tokens — Detalle por llamada';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON('/api/metrics/tokens');
        const tokens = (data.tokens || []).reverse(); // oldest first

        if (tokens.length === 0) {
            body.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--on-surface-variant);">Sin datos de tokens registrados</div>';
            return;
        }

        const inputs = tokens.map(t => t.input_tokens || 0);
        const outputs = tokens.map(t => t.output_tokens || 0);
        const totals = tokens.map(t => t.total_tokens || 0);

        const totalAll = totals.reduce((a, b) => a + b, 0);
        const totalIn = inputs.reduce((a, b) => a + b, 0);
        const totalOut = outputs.reduce((a, b) => a + b, 0);
        const avgTotal = Math.round(totalAll / tokens.length);
        const peak = Math.max(...totals);
        const min = Math.min(...totals);
        const avgIn = Math.round(totalIn / tokens.length);
        const avgOut = Math.round(totalOut / tokens.length);

        body.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">
                <div class="modal-stat-row"><span class="modal-stat-label">Total tokens</span><span class="modal-stat-value">${totalAll.toLocaleString()}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Llamadas</span><span class="modal-stat-value">${tokens.length}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Prom. input</span><span class="modal-stat-value">${avgIn.toLocaleString()}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Prom. output</span><span class="modal-stat-value">${avgOut.toLocaleString()}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Pico (total)</span><span class="modal-stat-value">${peak.toLocaleString()}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Mín (total)</span><span class="modal-stat-value">${min.toLocaleString()}</span></div>
            </div>
            <div class="modal-stat-row" style="margin-bottom:8px;"><span class="modal-stat-label">Promedio total/llamada</span><span class="modal-stat-value">${avgTotal.toLocaleString()}</span></div>
            <div style="position:relative;height:180px;"><canvas id="modalTokensChart"></canvas></div>
        `;

        setTimeout(() => {
            const ctx = document.getElementById('modalTokensChart');
            if (!ctx) return;
            _modalChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: tokens.map((_, i) => '#' + (i + 1)),
                    datasets: [
                        {
                            label: 'Input',
                            data: inputs,
                            borderColor: '#94a3b8',
                            backgroundColor: 'rgba(148,163,184,0.10)',
                            fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 8
                        },
                        {
                            label: 'Output',
                            data: outputs,
                            borderColor: '#c084fc',
                            backgroundColor: 'rgba(192,132,252,0.10)',
                            fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 8
                        }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12, font: { size: 10 } } },
                        tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6, callbacks: { label: (c) => c.dataset.label + ': ' + c.parsed.y.toLocaleString() + ' tokens' } }
                    },
                    scales: {
                        x: { display: false },
                        y: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { maxTicksLimit: 4, font: { size: 9 }, callback: (v) => v.toLocaleString() } }
                    },
                    animation: { duration: 300 }
                }
            });
        }, 50);
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

// =============================================
// LATENCY INFO MODAL
// =============================================
function openLatencyModal() {
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    const hp = lastHealthPayload;
    const p50 = hp?.latency?.p50 || 0;
    const p95 = hp?.latency?.p95 || 0;
    const p99 = hp?.latency?.p99 || 0;
    const avg = hp?.latency?.avg || 0;

    title.textContent = 'Latencia — Percentiles';
    body.innerHTML = `
        <div style="color:var(--on-surface-variant); font-size:0.8rem; line-height:1.6; margin-bottom:1rem;">
            Los percentiles miden el tiempo de respuesta del bot. Un percentil indica que ese porcentaje de solicitudes tardaron <strong>menos</strong> que el valor mostrado.
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label">Promedio</span>
            <span class="modal-stat-value">${avg} ms</span>
        </div>
        <div class="modal-stat-row">
            <span class="modal-stat-label" style="color:#c084fc;">P50 (Mediana)</span>
            <span class="modal-stat-value">${p50} ms</span>
        </div>
        <div style="font-size:0.7rem; color:var(--on-surface-variant); margin:-4px 0 8px 0;">El 50% de las respuestas tardaron menos que esto. Representa la experiencia típica del usuario.</div>
        <div class="modal-stat-row">
            <span class="modal-stat-label" style="color:#fbbf24;">P95</span>
            <span class="modal-stat-value">${p95} ms</span>
        </div>
        <div style="font-size:0.7rem; color:var(--on-surface-variant); margin:-4px 0 8px 0;">El 95% de las respuestas tardaron menos que esto. Solo el 5% fueron más lentas.</div>
        <div class="modal-stat-row">
            <span class="modal-stat-label" style="color:#f43f5e;">P99</span>
            <span class="modal-stat-value">${p99} ms</span>
        </div>
        <div style="font-size:0.7rem; color:var(--on-surface-variant); margin:-4px 0 8px 0;">El 99% de las respuestas tardaron menos que esto. Representa los peores casos (1 de cada 100).</div>
    `;
    modal.style.display = 'flex';
}

// =============================================
// SYSTEM ERRORS MODAL
// =============================================
async function openErrorsModal() {
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Errores del sistema';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON('/api/metrics/errors');
        const errors = data.errors || [];

        if (errors.length === 0) {
            body.innerHTML = `
                <div style="text-align:center; padding:2rem; color:var(--on-surface-variant);">
                    <span class="material-symbols-outlined" style="font-size:32px; display:block; margin-bottom:8px; opacity:0.4;">check_circle</span>
                    Sin errores en el último mes
                </div>`;
            return;
        }

        const html = errors.slice(0, 50).map(e => {
            let ctx = '';
            try { ctx = e.context_json ? JSON.parse(e.context_json)?.keyLabel || '' : ''; } catch(x) {}
            return `<div class="modal-error-item">
                <div class="err-code">${e.event_code || e.component || 'ERROR'}${ctx ? ' — ' + ctx : ''}</div>
                <div class="err-msg">${e.message || 'Sin detalle'}</div>
                <div class="err-time">${e.user_phone ? '📱 ' + e.user_phone + ' · ' : ''}${e.created_at ? formatTs(e.created_at) : '-'}</div>
            </div>`;
        }).join('');

        body.innerHTML = `
            <div class="modal-stat-row">
                <span class="modal-stat-label">Total errores (último mes)</span>
                <span class="modal-stat-value" style="color:var(--danger);">${errors.length}</span>
            </div>
            <div class="modal-section-title">Últimos errores</div>
            ${html}`;
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

// =============================================
// ERROR COUNT FROM MYSQL (persistent across restarts)
// =============================================
async function _refreshErrorCount() {
    try {
        const data = await fetchJSON('/api/metrics/errors');
        const count = (data.errors || []).length;
        setTextContentWithEffect('mTotalErrors', count);
    } catch (_) { /* silencioso */ }
}

// =============================================
// LOAD HISTORICAL DATA FROM MYSQL
// =============================================
async function loadHistoricalData() {
    try {
        // 1) Load daily aggregated data for Messages chart (monthly view)
        const dailyData = await fetchJSON('/api/metrics/history/daily');
        const days = dailyData.days || [];
        if (days.length > 0 && chartMessages) {
            const labels = days.map(d => {
                const raw = String(d.day).replace('T', ' ').replace('Z', '').substring(0, 10);
                const dt = new Date(raw + 'T12:00:00');
                return dt.getDate() + '/' + (dt.getMonth() + 1);
            });
            const received = days.map(d => parseInt(d.received) || 0);
            const processed = days.map(d => parseInt(d.processed) || 0);
            const failed = days.map(d => parseInt(d.failed) || 0);

            // With only 1 point, duplicate it so the line/area is visible as a flat segment
            if (labels.length === 1) {
                labels.push(labels[0]);
                received.push(received[0]);
                processed.push(processed[0]);
                failed.push(failed[0]);
            }

            chartMessages.data.labels = labels;
            chartMessages.data.datasets[0].data = received;
            chartMessages.data.datasets[1].data = processed;
            chartMessages.data.datasets[2].data = failed;
            chartMessages.update('none');
        }

        // Calculate avg/hr from hourly distribution for the KPI card
        const hourly = dailyData.hourlyDistribution || [];
        if (hourly.length > 0) {
            let totalMsgs = 0;
            for (const h of hourly) totalMsgs += parseInt(h.messages) || 0;
            const avgPerHour = Math.round(totalMsgs / 24);
            setTextContentWithEffect('mMph', avgPerHour);
        }

        // Calculate avg mpm from mpmHistory for the KPI card
        if (mpmHistory.length > 0) {
            const mpmAvg = (mpmHistory.reduce((a, b) => a + b, 0) / mpmHistory.length).toFixed(1);
            setTextContentWithEffect('mMpm', mpmAvg);
        }

        // Load daily token aggregation into Tokens chart
        const tokenDays = dailyData.tokenDays || [];
        if (tokenDays.length > 0 && chartTokens) {
            const tokLabels = tokenDays.map(d => {
                const raw = String(d.day).replace('T', ' ').replace('Z', '').substring(0, 10);
                const dt = new Date(raw + 'T12:00:00');
                return dt.getDate() + '/' + (dt.getMonth() + 1);
            });
            chartTokens.data.labels = tokLabels;
            chartTokens.data.datasets[0].data = tokenDays.map(d => parseInt(d.input_tokens) || 0);
            chartTokens.data.datasets[1].data = tokenDays.map(d => parseInt(d.output_tokens) || 0);
            chartTokens.update('none');
        }

        // 2) Load recent snapshots for sparklines (MPM, Memory) + set prevCounters
        const data = await fetchJSON('/api/metrics/history');
        const snapshots = data.snapshots || [];
        if (snapshots.length > 0) {
            for (const s of snapshots) {
                mpmHistory.push(s.throughput_messages_per_minute || 0);
                mphHistory.push(s.messages_processed || 0);
                memoryHistory.push(parseFloat(s.heap_used_mb) || 0);
            }

            const trim = (arr) => { while (arr.length > HISTORY_MAX) arr.shift(); };
            trim(mpmHistory);
            trim(mphHistory);
            trim(memoryHistory);

            // Set prevCounters from last snapshot so live deltas continue correctly
            const last = snapshots[snapshots.length - 1];
            prevCounters.received = last.messages_received || 0;
            prevCounters.processed = last.messages_processed || 0;
            prevCounters.failed = last.messages_failed || 0;

            if (chartMpm) {
                chartMpm.data.labels = mpmHistory.map((_, i) => i);
                chartMpm.data.datasets[0].data = mpmHistory;
                chartMpm.update('none');
            }
            if (chartMph) {
                chartMph.data.labels = mphHistory.map((_, i) => i);
                chartMph.data.datasets[0].data = mphHistory;
                chartMph.update('none');
            }
            if (chartMemory) {
                chartMemory.data.labels = memoryHistory.map((_, i) => i);
                chartMemory.data.datasets[0].data = memoryHistory;
                chartMemory.update('none');
            }
        }

        // Tokens chart already loaded from dailyData.tokenDays above
    } catch (err) {
        console.warn('[HISTORY] No se pudieron cargar datos históricos:', err.message);
    }
}

// =============================================
// USER STATS MODAL
// =============================================
let lastUserData = null;

function openUserModal(type) {
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    if (!selectedUserPhone) {
        showToast('Selecciona un usuario primero');
        return;
    }

    if (type === 'received') {
        title.textContent = 'Actividad — Mensajes recibidos';
        fetchUserAnalytics('received');
    } else if (type === 'processed') {
        title.textContent = 'Rendimiento — Procesados';
        fetchUserAnalytics('processed');
    } else if (type === 'errors') {
        title.textContent = 'Errores del usuario';
        fetchUserErrors();
    }

    modal.style.display = 'flex';
}

function closeUserModal() {
    _destroyModalChart();
    if (_uipModalChart) { _uipModalChart.destroy(); _uipModalChart = null; }
    const modal = document.getElementById('userStatsModal');
    if (modal) modal.style.display = 'none';
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
    if (e.target.id === 'userStatsModal') closeUserModal();
});
// Close modal on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeUserModal();
});

function timeAgo(dateStr) {
    if (!dateStr) return 'nunca';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'justo ahora';
    if (mins < 60) return mins + ' min atrás';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h atrás';
    const days = Math.floor(hours / 24);
    return days + 'd atrás';
}

function buildHourlyBar(hourly) {
    if (!hourly || hourly.length === 0) return '';
    const max = Math.max(...hourly.map(h => h.cnt || 0), 1);
    const bars = Array(24).fill(0);
    hourly.forEach(h => { bars[h.h] = h.cnt || 0; });
    const barHtml = bars.map((v, i) => {
        const pct = Math.round((v / max) * 100);
        const label = i === 0 || i === 6 || i === 12 || i === 18 ? `<span style="font-size:0.5rem;color:var(--on-surface-variant);">${i}h</span>` : '';
        return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:2px;">
            <div style="width:100%;max-width:10px;height:${Math.max(pct, 3)}%;background:${v > 0 ? 'var(--primary)' : 'rgba(255,255,255,0.05)'};border-radius:2px;min-height:2px;"></div>
            ${label}
        </div>`;
    }).join('');
    return `<div style="display:flex;align-items:flex-end;height:40px;gap:1px;margin:8px 0;">${barHtml}</div>`;
}

// =============================================
// USER INFO PANEL (right sidebar)
// =============================================
let _uipTokenChart = null;
let _uipModalChart = null;
let _chatPanelVisible = localStorage.getItem('chatPanelVisible') !== 'false';

function toggleChatPanel() {
    _chatPanelVisible = !_chatPanelVisible;
    localStorage.setItem('chatPanelVisible', _chatPanelVisible);
    const panel = document.getElementById('userInfoPanel');
    const icon = document.getElementById('chatTogglePanelIcon');
    if (panel) panel.classList.toggle('collapsed', !_chatPanelVisible);
    if (icon) icon.textContent = _chatPanelVisible ? 'chevron_right' : 'chevron_left';
}

function _initChatPanel() {
    const panel = document.getElementById('userInfoPanel');
    const icon = document.getElementById('chatTogglePanelIcon');
    if (panel) panel.classList.toggle('collapsed', !_chatPanelVisible);
    if (icon) icon.textContent = _chatPanelVisible ? 'chevron_right' : 'chevron_left';
}

function _getUserStatus(lastSeenAt) {
    if (!lastSeenAt) return { label: 'Inactivo', color: 'rgba(148,163,184,0.4)', dotColor: 'rgba(148,163,184,0.4)' };
    const diff = Date.now() - new Date(lastSeenAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 30) return { label: 'Activo', color: '#10b981', dotColor: '#10b981' };
    if (mins < 1440) return { label: 'Reciente', color: '#f59e0b', dotColor: '#f59e0b' };
    return { label: 'Inactivo', color: 'rgba(148,163,184,0.4)', dotColor: 'rgba(148,163,184,0.4)' };
}

function filterChatUsers(query) {
    const q = (query || '').toLowerCase().trim();
    document.querySelectorAll('.chat-user-item').forEach(el => {
        const phone = (el.dataset.phone || '').toLowerCase();
        const name = (el.dataset.name || '').toLowerCase();
        el.style.display = (!q || phone.includes(q) || name.includes(q)) ? '' : 'none';
    });
}

async function _updateUserInfoPanel(user, data) {
    const phone = selectedUserPhone || '';
    const name = user.display_name || user.userName || 'Sin nombre';
    const initial = name.charAt(0).toUpperCase();
    const status = _getUserStatus(user.last_seen_at || user.lastSeenAt);

    const avatarEl = document.getElementById('uipAvatar');
    const nameEl = document.getElementById('uipName');
    const phoneEl = document.getElementById('uipPhone');
    const statusEl = document.getElementById('uipStatus');

    if (avatarEl) avatarEl.textContent = initial;
    if (nameEl) nameEl.textContent = name;
    if (phoneEl) phoneEl.textContent = phone;
    if (statusEl) {
        statusEl.innerHTML = `<span class="uip-dot" style="background:${status.dotColor};"></span><span style="color:${status.color};">${status.label}</span>`;
    }

    const tok = data.tokens || {};
    const sess = data.sessions || {};
    const errs = data.errors || {};
    const hourly = data.hourlyDistribution || [];

    const tokensEl = document.getElementById('uipTokens');
    const latencyEl = document.getElementById('uipLatency');
    const apiKeyEl = document.getElementById('uipApiKey');
    const sessionsEl = document.getElementById('uipSessions');

    if (tokensEl) tokensEl.textContent = tok.total_tokens ? parseInt(tok.total_tokens).toLocaleString() : '—';
    if (latencyEl) latencyEl.textContent = tok.avg_ai_latency ? parseInt(tok.avg_ai_latency) + ' ms' : '—';
    if (sessionsEl) sessionsEl.textContent = sess.total_sessions || '—';

    const hourlyEl = document.getElementById('uipHourlyBar');
    if (hourlyEl) {
        const bar = buildHourlyBar(hourly);
        hourlyEl.innerHTML = bar || '<span style="color:rgba(148,163,184,0.3);font-size:0.65rem;">Sin datos</span>';
    }

    const errCount = parseInt(errs.total_errors) || 0;
    const errWrap = document.getElementById('uipErrorsWrap');
    const errCountEl = document.getElementById('uipErrorCount');
    if (errWrap) errWrap.style.display = errCount > 0 ? 'block' : 'none';
    if (errCountEl) errCountEl.textContent = errCount;

    try {
        const tokenHistory = await fetchJSON(`/api/users/${encodeURIComponent(phone)}/token-history`);
        const calls = tokenHistory.calls || [];

        if (apiKeyEl && calls.length > 0) {
            const lastKey = calls[calls.length - 1];
            apiKeyEl.textContent = lastKey.key_slot ? 'Key #' + lastKey.key_slot : '—';
        } else if (apiKeyEl) {
            apiKeyEl.textContent = tok.total_calls > 0 ? 'Key asignada' : '—';
        }

        // Update button with summary info
        const callCountEl = document.getElementById('uipTokenCallCount');
        const avgEl = document.getElementById('uipTokenAvg');
        if (calls.length > 0) {
            const avgTk = Math.round(calls.reduce((s, c) => s + (c.total_tokens || 0), 0) / calls.length);
            const maxTk = Math.max(...calls.map(c => c.total_tokens || 0));
            if (callCountEl) callCountEl.textContent = calls.length + ' llamadas registradas';
            if (avgEl) avgEl.textContent = 'Prom: ' + avgTk.toLocaleString() + ' tk · Pico: ' + maxTk.toLocaleString() + ' tk';
        } else {
            if (callCountEl) callCountEl.textContent = 'Sin llamadas aún';
            if (avgEl) avgEl.textContent = 'Toca para más detalles';
        }

        // Cache calls for modal
        window._uipTokenCalls = calls;
    } catch (err) {
        if (apiKeyEl) apiKeyEl.textContent = '—';
    }
}

function _openTokenCallDetail(call) {
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;
    const d = new Date(call.created_at);
    const dateStr = d.toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    title.textContent = 'Detalle de llamada IA';
    body.innerHTML = `
        <div class="modal-stat-row"><span class="modal-stat-label">Fecha</span><span class="modal-stat-value">${dateStr}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Total tokens</span><span class="modal-stat-value" style="color:var(--primary);">${(call.total_tokens || 0).toLocaleString()}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Tokens entrada</span><span class="modal-stat-value">${(call.input_tokens || 0).toLocaleString()}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Tokens salida</span><span class="modal-stat-value">${(call.output_tokens || 0).toLocaleString()}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Latencia IA</span><span class="modal-stat-value">${call.latency_ms || 0} ms</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">API Key slot</span><span class="modal-stat-value">Key #${call.key_slot || '?'}</span></div>
    `;
    modal.style.display = 'flex';
}

async function openUserTokensModal() {
    _destroyModalChart();
    if (_uipModalChart) { _uipModalChart.destroy(); _uipModalChart = null; }
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Tokens por llamada — ' + (selectedUserPhone || '');
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const calls = window._uipTokenCalls || [];
        const fresh = calls.length === 0;
        let allCalls = calls;
        if (fresh) {
            const res = await fetchJSON(`/api/users/${encodeURIComponent(selectedUserPhone)}/token-history`);
            allCalls = res.calls || [];
        }

        if (allCalls.length === 0) {
            body.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--on-surface-variant);">Sin llamadas registradas para este usuario</div>';
            return;
        }

        const total = allCalls.reduce((s, c) => s + (c.total_tokens || 0), 0);
        const avgTk = Math.round(total / allCalls.length);
        const maxTk = Math.max(...allCalls.map(c => c.total_tokens || 0));
        const avgLat = Math.round(allCalls.reduce((s, c) => s + (c.latency_ms || 0), 0) / allCalls.length);
        const lastKey = allCalls[allCalls.length - 1];

        body.innerHTML = `
            <div class="modal-stat-row"><span class="modal-stat-label">Llamadas registradas</span><span class="modal-stat-value">${allCalls.length}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Tokens totales</span><span class="modal-stat-value" style="color:var(--primary);">${total.toLocaleString()}</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Promedio / llamada</span><span class="modal-stat-value">${avgTk.toLocaleString()} tk</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Pico máximo</span><span class="modal-stat-value">${maxTk.toLocaleString()} tk</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Latencia IA promedio</span><span class="modal-stat-value">${avgLat} ms</span></div>
            <div class="modal-stat-row"><span class="modal-stat-label">Última API Key</span><span class="modal-stat-value">Key #${lastKey?.key_slot || '?'}</span></div>
            <div class="modal-section-title">Histórico de tokens (cronológico)</div>
            <div style="height:140px; margin-bottom:12px;"><canvas id="modalTokenChart"></canvas></div>
            <div class="modal-section-title">Últimas llamadas</div>
            ${allCalls.slice(-20).reverse().map(c => {
                const d = new Date(c.created_at);
                const t = d.toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                return `<div class="modal-stat-row" style="cursor:pointer;" onclick="_openTokenCallDetail(${JSON.stringify(c).replace(/"/g, '&quot;')})">
                    <span class="modal-stat-label">${t} · Key #${c.key_slot || '?'}</span>
                    <span class="modal-stat-value" style="color:var(--primary);">${(c.total_tokens||0).toLocaleString()} tk <span style="color:var(--on-surface-variant);font-weight:400;">${c.latency_ms||0}ms</span></span>
                </div>`;
            }).join('')}
        `;

        const ctx = document.getElementById('modalTokenChart');
        if (ctx) {
            _uipModalChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: allCalls.map((c, i) => {
                        const d = new Date(c.created_at);
                        return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
                    }),
                    datasets: [{
                        label: 'Tokens',
                        data: allCalls.map(c => c.total_tokens || 0),
                        borderColor: '#c084fc',
                        backgroundColor: 'rgba(192,132,252,0.08)',
                        fill: true, tension: 0.3, borderWidth: 1.5,
                        pointRadius: 3, pointHoverRadius: 5,
                        pointBackgroundColor: '#c084fc'
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
                            callbacks: {
                                label: (item) => {
                                    const c = allCalls[item.dataIndex];
                                    return [` ${(c.total_tokens||0).toLocaleString()} tk`, ` in:${c.input_tokens} / out:${c.output_tokens}`, ` ${c.latency_ms}ms · Key #${c.key_slot||'?'}`];
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { font: { size: 8 }, color: 'rgba(255,255,255,0.3)', maxTicksLimit: 10 } },
                        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 8 }, color: 'rgba(255,255,255,0.4)', callback: v => v.toLocaleString() } }
                    },
                    animation: { duration: 300 },
                    onClick: (evt, elements) => {
                        if (!elements.length) return;
                        _openTokenCallDetail(allCalls[elements[0].index]);
                    }
                }
            });
        }
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

async function fetchUserAnalytics(filterType) {
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando analytics...</div>';

    try {
        const data = await fetchJSON(`/api/users/${encodeURIComponent(selectedUserPhone)}/stats`);
        const msg = data.messages || {};
        const sess = data.sessions || {};
        const tok = data.tokens || {};
        const errs = data.errors || {};
        const hourly = data.hourlyDistribution || [];

        if (filterType === 'received') {
            const inbound = parseInt(msg.inbound) || 0;
            const activeDays = parseInt(msg.active_days) || 1;
            const avgPerDay = (inbound / activeDays).toFixed(1);
            body.innerHTML = `
                <div class="modal-stat-row"><span class="modal-stat-label">Total recibidos</span><span class="modal-stat-value">${inbound}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Promedio / día</span><span class="modal-stat-value">${avgPerDay}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Días activo</span><span class="modal-stat-value">${activeDays}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Último mensaje</span><span class="modal-stat-value">${timeAgo(msg.last_message_at)}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Primera vez</span><span class="modal-stat-value">${msg.first_message_at ? formatTs(msg.first_message_at) : '-'}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Sesiones totales</span><span class="modal-stat-value">${parseInt(sess.total_sessions) || 0}</span></div>
                <div class="modal-section-title">Actividad por hora (último mes)</div>
                ${buildHourlyBar(hourly)}
            `;
        } else {
            const outbound = parseInt(msg.outbound) || 0;
            const inbound = parseInt(msg.inbound) || 1;
            const responseRate = Math.round((outbound / Math.max(inbound, 1)) * 100);
            const avgLatency = parseInt(msg.avg_latency) || 0;
            const totalTokens = parseInt(tok.total_tokens) || 0;
            const avgTokens = parseInt(tok.avg_tokens) || 0;
            const aiLatency = parseInt(tok.avg_ai_latency) || 0;
            const totalCalls = parseInt(tok.total_calls) || 0;
            body.innerHTML = `
                <div class="modal-stat-row"><span class="modal-stat-label">Respuestas enviadas</span><span class="modal-stat-value">${outbound}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Tasa de respuesta</span><span class="modal-stat-value">${responseRate}%</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Latencia promedio</span><span class="modal-stat-value">${avgLatency} ms</span></div>
                <div class="modal-section-title">Uso de IA (Gemini)</div>
                <div class="modal-stat-row"><span class="modal-stat-label">Llamadas a Gemini</span><span class="modal-stat-value">${totalCalls}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Tokens totales</span><span class="modal-stat-value">${totalTokens.toLocaleString()}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Tokens promedio / msg</span><span class="modal-stat-value">${avgTokens}</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Latencia IA promedio</span><span class="modal-stat-value">${aiLatency} ms</span></div>
                <div class="modal-stat-row"><span class="modal-stat-label">Errores del usuario</span><span class="modal-stat-value" style="color:var(--danger);">${parseInt(errs.total_errors) || 0}</span></div>
                <div class="modal-section-title">Actividad por hora (último mes)</div>
                ${buildHourlyBar(hourly)}
            `;
        }
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message || 'No se pudieron cargar las analytics'}</div>`;
    }
}

async function fetchUserErrors() {
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';

    try {
        // Get errors from health payload
        const healthData = lastHealthPayload;
        const recentErrors = healthData?.insights?.recentErrors || [];
        const userErrors = recentErrors.filter(e =>
            e.phone === selectedUserPhone || e.context?.phone === selectedUserPhone
        );

        // Also get gemini errors from keys
        const geminiDebug = healthData?.services?.gemini?.lastRequestDebug;
        let geminiInfo = '';
        if (geminiDebug && geminiDebug.status === 'ERROR') {
            geminiInfo = `<div class="modal-error-item">
                <div class="err-code">Último error Gemini</div>
                <div class="err-msg">${geminiDebug.final?.errorCode || 'UNKNOWN'}: ${geminiDebug.final?.errorMessage || 'Sin detalle'}</div>
                <div class="err-time">${geminiDebug.finishedAt ? formatTs(geminiDebug.finishedAt) : '-'}</div>
            </div>`;
        }

        if (userErrors.length === 0 && !geminiInfo) {
            body.innerHTML = `
                <div style="text-align:center; padding:2rem; color:var(--on-surface-variant);">
                    <span class="material-symbols-outlined" style="font-size:32px; display:block; margin-bottom:8px; opacity:0.4;">check_circle</span>
                    Sin errores recientes para este usuario
                </div>`;
            return;
        }

        const errorsHtml = userErrors.map(e => `
            <div class="modal-error-item">
                <div class="err-code">${e.errorCode || e.type || 'ERROR'}</div>
                <div class="err-msg">${e.message || e.probableCause || 'Sin detalles'}</div>
                <div class="err-time">${e.timestamp ? formatTs(e.timestamp) : '-'}</div>
            </div>`).join('');

        body.innerHTML = `
            <div class="modal-stat-row">
                <span class="modal-stat-label">Errores registrados</span>
                <span class="modal-stat-value" style="color:var(--danger);">${userErrors.length}</span>
            </div>
            ${geminiInfo ? '<div class="modal-section-title">Gemini</div>' + geminiInfo : ''}
            ${errorsHtml ? '<div class="modal-section-title">Historial de errores</div>' + errorsHtml : ''}`;
    } catch (err) {
        body.innerHTML = `<div style="text-align:center; padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
}

function formatCutoffReason(reason) {
    const labels = {
        NO_KEYS_CONFIGURED: 'No hay llaves API configuradas',
        NO_AVAILABLE_KEYS: 'Disyuntor: Sin llaves activas',
        TOTAL_BUDGET_EXHAUSTED: 'Presupuesto de tiempo agotado',
        RESPONSE_TRUNCATED_TIMEOUT: 'Respuesta truncada por tiempo de espera'
    };
    return labels[reason] || reason || 'No disponible';
}

function renderLastCutoff(cutoff) {
    // No-op if no target element
}

function renderLastRequestDebug(reqDebug) {
    if (!reqDebug || !reqDebug.requestId) return;
    if (reqDebug.requestId === lastRequestDebugId) return;
    lastRequestDebugId = reqDebug.requestId;
}

// =============================================
// ESPEJO DE CHAT: Flujo de Inteligencia en Vivo
// =============================================
let chatMirrorLastCount = 0;
let chatMirrorTimer = null;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatMessageBody(raw) {
    let text = escapeHtml(raw || '');
    // WhatsApp-style bold: *text*
    text = text.replace(/\*([^\*\n]+)\*/g, '<strong>$1</strong>');
    // WhatsApp-style italic: _text_
    text = text.replace(/\_([^\_\n]+)\_/g, '<em>$1</em>');
    // WhatsApp-style strikethrough: ~text~
    text = text.replace(/~([^~\n]+)~/g, '<s>$1</s>');
    // WhatsApp-style monospace: `text`
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Line breaks
    text = text.replace(/\n/g, '<br>');
    return text;
}

function formatChatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('es-PE', { 
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        day: '2-digit', month: 'short'
    });
}

async function loadChatMirror() {
    if (!selectedUserPhone) return;

    const stream = document.getElementById('chatStream');
    const phoneLabel = document.getElementById('chatPhoneLabel');
    const nameLabel = document.getElementById('chatUserNameLabel');
    if (!stream) return;

    if (phoneLabel) phoneLabel.textContent = selectedUserPhone;
    // nameLabel and avatar are set by loadSelectedUserConfig, don't overwrite here

    try {
        const data = await fetchJSON('/api/chat/' + encodeURIComponent(selectedUserPhone) + '?limit=150');
        const messages = data.messages || [];

        if (messages.length === 0) {
            stream.innerHTML = `
                <div class="chat-empty-state">
                    <span class="material-symbols-outlined" style="font-size: 3rem; margin-bottom: 1rem; color: var(--on-surface-variant);">mark_chat_unread</span>
                    <p>No hay mensajes registrados para <strong>${escapeHtml(selectedUserPhone)}</strong> aún.</p>
                </div>
            `;
            chatMirrorLastCount = 0;
            return;
        }

        // Solo re-renderizar si el conteo cambió (optimización de rendimiento)
        if (messages.length === chatMirrorLastCount) return;
        chatMirrorLastCount = messages.length;

        stream.innerHTML = messages.map((msg, i) => {
            const dir = msg.direction === 'inbound' ? 'inbound' : 'outbound';
            const senderLabel = dir === 'inbound' ? 'Usuario' : 'Buho AI';
            const time = formatChatTime(msg.created_at);
            const latencyBadge = msg.latency_ms 
                ? `<span class="msg-latency"><span class="material-symbols-outlined" style="font-size:10px; vertical-align:middle;">bolt</span> ${msg.latency_ms}ms</span>` 
                : '';

            return `<div class="msg-wrapper ${dir}" style="animation-delay: ${Math.min(i * 0.03, 0.5)}s">
                <div class="msg-meta">
                    ${dir === 'outbound' ? latencyBadge : ''}
                    <span>${senderLabel} • ${time}</span>
                </div>
                <div class="msg-bubble">${formatMessageBody(msg.body || '')}</div>
            </div>`;
        }).join('');

        // Auto-scroll al final
        requestAnimationFrame(() => {
            stream.scrollTop = stream.scrollHeight;
        });

    } catch (err) {
        debugLog('Chat Mirror error', { error: err.message }, 'error');
    }
}

function startChatMirrorPolling() {
    if (chatMirrorTimer) clearInterval(chatMirrorTimer);
    let isPolling = false;
    chatMirrorTimer = setInterval(async () => {
        if (selectedUserPhone && !isPolling) {
            isPolling = true;
            try {
                const data = await fetchJSON('/api/chat/' + encodeURIComponent(selectedUserPhone) + '/count');
                if (data.count !== undefined && data.count !== chatMirrorLastCount) {
                    await loadChatMirror();
                }
            } catch (err) {
                // ignorar errores de polling en bg
            }
            isPolling = false;
        }
    }, 1500);
}

async function refreshMetrics() {
    try {
        const data = await fetchJSON('/health');
        lastHealthPayload = data;

        const dot = document.getElementById('statusDot');
        if(dot) dot.className = 'status-dot';
        setTextContentWithEffect('statusText', 'En línea');
        setTextContentWithEffect('heroStatus', 'En línea');
        setTextContentWithEffect('heroUptime', data.uptime?.human || '-');

        // KPIs
        setTextContentWithEffect('sReceived', data.counters?.messagesReceived || 0);
        setTextContentWithEffect('sProcessed', data.counters?.messagesProcessed || 0);
        setTextContentWithEffect('sFailed', data.counters?.messagesFailed || 0);
        setTextContentWithEffect('sLatency', data.latency?.avg ? data.latency.avg + 'ms' : '-');
        // mMph: avg/hr is calculated from loadHistoricalData, don't overwrite with raw processed count
        setTextContentWithEffect('sUptime', data.uptime?.human || '-');

        // Detailed Metrics
        setTextContentWithEffect('mGemCalls', data.counters?.geminiCalls || 0);
        setTextContentWithEffect('mGemErr', data.counters?.geminiErrors || 0);
        setTextContentWithEffect('mWAOk', data.counters?.whatsappMessagesSent || 0);
        setTextContentWithEffect('mWAErr', data.counters?.whatsappErrors || 0);
        setTextContentWithEffect('mRateHit', data.counters?.rateLimitHits || 0);
        setTextContentWithEffect('mDup', data.counters?.duplicateMessages || 0);
        setTextContentWithEffect('mP50', data.latency?.p50 ? data.latency.p50 + 'ms' : '-');
        setTextContentWithEffect('mP95', data.latency?.p95 ? data.latency.p95 + 'ms' : '-');
        setTextContentWithEffect('mP99', data.latency?.p99 ? data.latency.p99 + 'ms' : '-');
        setTextContentWithEffect('mHeap', data.memory?.heapUsed || '-');
        const mpmAvg = mpmHistory.length > 0 ? (mpmHistory.reduce((a, b) => a + b, 0) / mpmHistory.length).toFixed(1) : 0;
        setTextContentWithEffect('mMpm', mpmAvg);
        const reliabilityEl = document.getElementById('mReliability');
        const reliabilityVal = data.reliability?.successRate || 100;
        if (reliabilityEl) {
            reliabilityEl.textContent = reliabilityVal + '%';
            reliabilityEl.className = reliabilityVal >= 95 ? 'hero-reliability-value color-ok' : reliabilityVal >= 80 ? 'hero-reliability-value color-warn' : 'hero-reliability-value color-err';
        }

        // Update charts
        updateCharts(data);

        renderKeys(data.services?.gemini?.keys || []);
        renderLastCutoff(data.services?.gemini?.lastCutoff || null);
        renderLastRequestDebug(data.services?.gemini?.lastRequestDebug || null);
        renderTopUsers(data.insights?.topUsers || []);
        renderRecentErrors(data.insights?.recentErrors || []);

        const geminiRaw = document.getElementById('geminiRawPayload');
        if (geminiRaw) {
            geminiRaw.textContent = JSON.stringify(data.services?.gemini || {}, null, 2);
        }

    } catch (err) {
        const dot = document.getElementById('statusDot');
        if(dot) dot.className = 'status-dot offline';
        const txt = document.getElementById('statusText');
        if(txt) txt.textContent = 'Desconectado';
        const heroSt = document.getElementById('heroStatus');
        if(heroSt) heroSt.textContent = 'Desconectado';
        debugLog('refreshMetrics fallo', { error: err.message || String(err) }, 'error');
    }
}

// Inicialización de montaje
document.addEventListener('DOMContentLoaded', async () => {
    // Add load-in fade effect to main shell
    document.body.classList.add('app-loaded');
    
    // Vincular Eventos
    const selectEl = document.getElementById('userSelect');
    if (selectEl) {
        selectEl.addEventListener('change', async (e) => {
            selectedUserPhone = e.target.value;
            chatMirrorLastCount = 0; // Forzar re-renderizado al cambiar usuario
            await loadSelectedUserConfig();
            await loadChatMirror();
        });
    }

    debugLog('App Montada CSS/JS OK. Iniciando bootstrap...');
    adminToken = getStoredAdminToken();
    updateAdminTokenStatus();

    // Block access until token is provided
    if (!adminToken) {
        ensureAdminToken();
        return; // Stop bootstrap — page reloads after token is saved
    }
    // Hide overlay if token exists
    const overlay = document.getElementById('adminTokenOverlay');
    if (overlay) overlay.style.display = 'none';

    // Initialize Chart.js charts
    if (typeof Chart !== 'undefined') {
        initCharts();
        loadHistoricalData();
    }

    // Esperar cargadores skeleton
    try {
        await Promise.all([
            loadGeneralConfig(),
            loadUsers(),
            refreshMetrics()
        ]);
        // Router inicial: decide qué pantalla mostrar y qué usuario cargar basado en la URL
        handleRoute();
    } catch(e) {}
    
    // Auto-actualizaciones
    setInterval(refreshMetrics, 10000);
    setInterval(loadUsers, 15000);
    setInterval(loadHistoricalData, 30000);
    startChatMirrorPolling();
});

// =============================================
// ENRUTAMIENTO DE APP Y MÓVIL (SPA) + HASH ROUTER
// =============================================
function toggleMobileMenu() {
    document.querySelector('.sidebar').classList.toggle('active');
}

function backToThreadList() {
    // Volver a la lista de chats (quitar el phone del hash)
    window.location.hash = 'chat';
    document.querySelector('.chat-sidebar').classList.remove('mobile-hidden');
    document.querySelector('.chat-main').classList.remove('mobile-active');
}

function switchView(viewName, skipHashUpdate) {
    // Hide mobile menu on navigation
    document.querySelector('.sidebar').classList.remove('active');

    // 1. Hide all views
    document.getElementById('view-dashboard').style.display = 'none';
    document.getElementById('view-chat').style.display = 'none';
    const reportsView = document.getElementById('view-reports');
    if (reportsView) reportsView.style.display = 'none';
    
    // 2. Remove active from nav links
    document.querySelectorAll('.side-menu a').forEach(el => el.classList.remove('active'));
    
    // 3. Show requested view
    const breadcrumb = document.getElementById('topBreadcrumb');
    const navLinks = document.querySelectorAll('.side-menu a');
    
    // Stop reports refresh when navigating away and destroy charts
    if (_reportsRefreshTimer) { clearInterval(_reportsRefreshTimer); _reportsRefreshTimer = null; }
    if (viewName !== 'reports' && _reportsInitialized) {
        Object.values(_reportCharts).forEach(c => { try { c.destroy(); } catch(_){} });
        _reportCharts = {};
        _reportsInitialized = false;
    }

    if (viewName === 'chat') {
        document.getElementById('view-chat').style.display = 'block';
        document.querySelector('.main-content').classList.add('no-scroll');
        navLinks[1].classList.add('active');
        if(breadcrumb) breadcrumb.innerHTML = '<span class="muted">Digital Buho</span> <span class="sep">/</span> <span class="active">Chats</span>';
        _initChatPanel();
        loadChatMirror();
    } else if (viewName === 'reports') {
        if (reportsView) reportsView.style.display = 'block';
        document.querySelector('.main-content').classList.remove('no-scroll');
        navLinks[2].classList.add('active');
        if(breadcrumb) breadcrumb.innerHTML = '<span class="muted">Digital Buho</span> <span class="sep">/</span> <span class="active">Reportes</span>';
        loadReportsData();
    } else {
        document.getElementById('view-dashboard').style.display = 'block';
        document.querySelector('.main-content').classList.remove('no-scroll');
        navLinks[0].classList.add('active');
        if(breadcrumb) breadcrumb.innerHTML = '<span class="muted">Digital Buho</span> <span class="sep">/</span> <span class="active">Panel de Control</span>';
    }
}

// === HASH ROUTER ===
function handleRoute() {
    const hash = window.location.hash.slice(1) || 'dashboard'; // quitar el #
    const parts = hash.split('/');
    const view = parts[0]; // 'dashboard', 'chat'
    const param = parts[1] || null; // phone number si existe

    if (view === 'chat') {
        switchView('chat', true);
        // Si hay un teléfono en la URL, seleccionar ese chat
        if (param) {
            const decoded = decodeURIComponent(param);
            if (decoded !== selectedUserPhone) {
                syncUserSelect(decoded);
            }
        }
    } else if (view === 'reports') {
        switchView('reports', true);
    } else {
        switchView('dashboard', true);
    }
}

// Escuchar cambios de hash (atrás/adelante del navegador, clicks en links)
window.addEventListener('hashchange', handleRoute);

function syncUserSelect(phone) {
    selectedUserPhone = phone;
    chatMirrorLastCount = 0;

    // Actualizar hash con el teléfono seleccionado (SIN refrescar)
    const newHash = '#chat/' + encodeURIComponent(phone);
    if (window.location.hash !== newHash) {
        history.replaceState(null, '', newHash);
    }
    
    // Sincronizar selector principal del panel
    const mainSelect = document.getElementById('userSelect');
    if (mainSelect && mainSelect.value !== phone) {
        mainSelect.value = phone;
        loadSelectedUserConfig();
    }
    
    // Actualizar clase activa en barra lateral del chat
    const chatUserItems = document.querySelectorAll('.chat-user-item');
    chatUserItems.forEach(el => {
        const isMatch = el.dataset.phone === phone || el.innerHTML.includes(phone);
        el.classList.toggle('active', isMatch);
    });
    
    loadChatMirror();

    // Lógica específica para móvil
    if (window.innerWidth <= 768) {
        document.querySelector('.chat-sidebar').classList.add('mobile-hidden');
        document.querySelector('.chat-main').classList.add('mobile-active');
    }
}

// =============================================
// REPORTS MODULE
// =============================================
let _reportCharts = {};
let _reportsRefreshTimer = null;
let _reportsInitialized = false;
let _insightsPage = 0;
let _insightsTotal = 0;
let _insightsFilters = {};

const INTENT_LABELS = {
    'greeting': 'Saludo', 'question': 'Pregunta', 'purchase_interest': 'Interés compra',
    'complaint': 'Queja', 'support': 'Soporte', 'farewell': 'Despedida',
    'info_request': 'Info', 'price_inquiry': 'Precios', 'other': 'Otro'
};
const INTENT_COLORS = {
    'greeting': '#94a3b8', 'question': '#60a5fa', 'purchase_interest': '#10b981',
    'complaint': '#f43f5e', 'support': '#c084fc', 'farewell': '#64748b',
    'info_request': '#38bdf8', 'price_inquiry': '#f59e0b', 'other': '#475569'
};
const STAGE_LABELS = {
    'DISCOVERY': 'Descubrimiento', 'PRODUCT_INTEREST': 'Interés producto',
    'PLAN_SELECTION': 'Selección plan', 'PAYMENT_METHOD': 'Método pago',
    'PAYMENT_PROOF': 'Comprobante pago', 'CLOSING': 'Cierre'
};
const STAGE_ORDER = ['DISCOVERY','PRODUCT_INTEREST','PLAN_SELECTION','PAYMENT_METHOD','PAYMENT_PROOF','CLOSING'];
const OUTCOME_LABELS = {
    'purchased': 'Compró', 'just_asked': 'Solo preguntó', 'problem_reported': 'Problema',
    'unresolved': 'Sin resolver', 'redirected': 'Redirigido', 'ongoing': 'En curso', 'resolved': 'Resuelto'
};
const SENTIMENT_LABELS = { 'positive': 'Positivo', 'neutral': 'Neutro', 'negative': 'Negativo' };

async function loadReportsData() {
    if (!_reportsRefreshTimer) {
        _reportsRefreshTimer = setInterval(() => {
            const rv = document.getElementById('view-reports');
            if (rv && rv.style.display !== 'none') _refreshReportsData();
        }, 5000);
    }

    if (!_reportsInitialized) {
        _reportsInitialized = true;
        await _initReportsCharts();
    } else {
        await _refreshReportsData();
    }
}

async function _initReportsCharts() {
    try {
        const [summaryData, funnelData, productsData, intentsData, sentimentData, topicsData, kpiDailyData, outcomeDailyData] = await Promise.all([
            fetchJSON('/api/reports/summary'),
            fetchJSON('/api/reports/funnel'),
            fetchJSON('/api/reports/products'),
            fetchJSON('/api/reports/intents'),
            fetchJSON('/api/reports/sentiment-daily'),
            fetchJSON('/api/reports/topics'),
            fetchJSON('/api/reports/kpi-daily'),
            fetchJSON('/api/reports/outcome-daily').catch(() => ({ days: [] }))
        ]);

        _renderReportKPIs(summaryData.summary);
        _createKpiSparklines(kpiDailyData.days || [], outcomeDailyData.days || []);
        _createFunnelChart(funnelData.funnel || []);
        _createProductsChart(productsData.products || []);
        _createIntentsChart(intentsData.intents || []);
        _createSentimentChart(sentimentData.days || []);
        _renderTopicsList(topicsData.topics || []);
        _renderSentimentSummary(summaryData.summary);
        _loadInsightsPage();
    } catch (err) {
        console.error('[REPORTS] Error init:', err);
    }
}

async function _refreshReportsData() {
    try {
        const [summaryData, funnelData, productsData, intentsData, sentimentData, topicsData, kpiDailyData, outcomeDailyData] = await Promise.all([
            fetchJSON('/api/reports/summary'),
            fetchJSON('/api/reports/funnel'),
            fetchJSON('/api/reports/products'),
            fetchJSON('/api/reports/intents'),
            fetchJSON('/api/reports/sentiment-daily'),
            fetchJSON('/api/reports/topics'),
            fetchJSON('/api/reports/kpi-daily'),
            fetchJSON('/api/reports/outcome-daily').catch(() => ({ days: [] }))
        ]);

        _renderReportKPIs(summaryData.summary);
        _updateKpiSparklines(kpiDailyData.days || [], outcomeDailyData.days || []);
        _updateFunnelChart(funnelData.funnel || []);
        _updateProductsChart(productsData.products || []);
        _updateIntentsChart(intentsData.intents || []);
        _updateSentimentChart(sentimentData.days || []);
        _renderTopicsList(topicsData.topics || []);
        _renderSentimentSummary(summaryData.summary);
        _loadInsightsPage();
    } catch (err) {
        console.error('[REPORTS] Error refresh:', err);
    }
}

function _renderReportKPIs(s) {
    if (!s) return;
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    el('rOutcomes', s.totalInteractions || 0);
    el('rComplaints', s.complaints);
    el('rResolutionPurchase', s.resolutionRate + '%');
    el('rUnresolved', s.unresolved);
    el('rHeroTotal', s.totalInteractions + ' interacciones');
    el('rHeroUsers', s.uniqueUsers + ' usuarios');
}

// --- KPI SPARKLINES ---
function _makeSparkline(canvasId, color, bgColor) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: bgColor, fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true, suggestedMax: 1 } }, animation: { duration: 300 } }
    });
}

function _makeMultiSparkline(canvasId, datasetConfigs) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const datasets = datasetConfigs.map(c => ({
        data: [], borderColor: c.color, backgroundColor: c.bg || 'transparent',
        fill: !!c.bg, tension: 0.4, borderWidth: 1.5, pointRadius: 0
    }));
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true, suggestedMax: 1 } }, animation: { duration: 300 } }
    });
}

function _createKpiSparklines(kpiDays, outcomeDays) {
    // Card 1: Outcomes — multi-line (purchased, just_asked, problem, resolved)
    _reportCharts.kpiOutcomes = _makeMultiSparkline('chartKpiOutcomes', [
        { color: '#10b981', bg: 'rgba(16,185,129,0.08)' },
        { color: '#94a3b8' },
        { color: '#f43f5e' },
        { color: '#38bdf8' }
    ]);
    // Card 2: Complaints
    _reportCharts.kpiComplaints = _makeSparkline('chartKpiComplaints', '#f43f5e', 'rgba(244,63,94,0.1)');
    // Card 3: Resolution + Purchase — dual line
    _reportCharts.kpiResPurchase = _makeMultiSparkline('chartKpiResPurchase', [
        { color: '#10b981', bg: 'rgba(16,185,129,0.08)' },
        { color: '#c084fc', bg: 'rgba(192,132,252,0.08)' }
    ]);
    // Card 4: Unresolved
    _reportCharts.kpiUnresolved = _makeSparkline('chartKpiUnresolved', '#f59e0b', 'rgba(245,158,11,0.1)');
    _setKpiSparklineData(kpiDays, outcomeDays);
}

function _updateKpiSparklines(kpiDays, outcomeDays) {
    if (!_reportCharts.kpiOutcomes) return _createKpiSparklines(kpiDays, outcomeDays);
    _setKpiSparklineData(kpiDays, outcomeDays);
}

function _setKpiSparklineData(kpiDays, outcomeDays) {
    // KPI days (complaints, resolution, purchase, unresolved)
    let d = kpiDays.length > 0 ? kpiDays : [{ resolutionRate: 0, complaints: 0, purchaseRate: 0, unresolved: 0 }];
    if (d.length === 1) d = [d[0], d[0]];
    const labels = d.map((_, i) => i);

    // Complaints sparkline
    const setOne = (chart, data) => {
        if (!chart) return;
        chart.data.labels = labels;
        chart.data.datasets[0].data = data;
        chart.update('none');
    };
    setOne(_reportCharts.kpiComplaints, d.map(x => x.complaints || 0));
    setOne(_reportCharts.kpiUnresolved, d.map(x => x.unresolved || 0));

    // Resolution + Purchase dual sparkline
    if (_reportCharts.kpiResPurchase) {
        _reportCharts.kpiResPurchase.data.labels = labels;
        _reportCharts.kpiResPurchase.data.datasets[0].data = d.map(x => x.resolutionRate || 0);
        _reportCharts.kpiResPurchase.data.datasets[1].data = d.map(x => x.purchaseRate || 0);
        _reportCharts.kpiResPurchase.update('none');
    }

    // Outcomes multi-line sparkline
    let od = (outcomeDays && outcomeDays.length > 0) ? outcomeDays : [{ purchased: 0, just_asked: 0, problem_reported: 0, resolved: 0 }];
    if (od.length === 1) od = [od[0], od[0]];
    const oLabels = od.map((_, i) => i);
    if (_reportCharts.kpiOutcomes) {
        _reportCharts.kpiOutcomes.data.labels = oLabels;
        _reportCharts.kpiOutcomes.data.datasets[0].data = od.map(x => x.purchased || 0);
        _reportCharts.kpiOutcomes.data.datasets[1].data = od.map(x => x.just_asked || 0);
        _reportCharts.kpiOutcomes.data.datasets[2].data = od.map(x => x.problem_reported || 0);
        _reportCharts.kpiOutcomes.data.datasets[3].data = od.map(x => x.resolved || 0);
        _reportCharts.kpiOutcomes.update('none');
    }
}

// --- FUNNEL CHART ---
function _createFunnelChart(funnel) {
    const ctx = document.getElementById('chartFunnel');
    if (!ctx) return;
    const ordered = _getFunnelData(funnel);
    _reportCharts.funnel = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ordered.map(o => STAGE_LABELS[o.stage] || o.stage),
            datasets: [{ label: 'Usuarios', data: ordered.map(o => o.count), backgroundColor: ['#c084fc','#a78bfa','#818cf8','#60a5fa','#38bdf8','#22d3ee'], borderRadius: 6, maxBarThickness: 50 }]
        },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { font: { size: 9 } } }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } }, animation: { duration: 400 } }
    });
}
function _updateFunnelChart(funnel) {
    if (!_reportCharts.funnel) return _createFunnelChart(funnel);
    const ordered = _getFunnelData(funnel);
    _reportCharts.funnel.data.datasets[0].data = ordered.map(o => o.count);
    _reportCharts.funnel.update('none');
}
function _getFunnelData(funnel) {
    return STAGE_ORDER.map(stage => {
        const found = funnel.find(f => f.stage === stage);
        return { stage, count: found ? parseInt(found.unique_users) || 0 : 0 };
    });
}

// --- PRODUCTS CHART ---
function _createProductsChart(products) {
    const ctx = document.getElementById('chartProducts');
    if (!ctx) return;
    const top = products.slice(0, 8);
    _reportCharts.products = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: top.map(p => (p.product || '').substring(0, 20)),
            datasets: [
                { label: 'Compró', data: top.map(p => parseInt(p.purchased) || 0), backgroundColor: 'rgba(16,185,129,0.6)', borderRadius: 4, maxBarThickness: 30 },
                { label: 'Preguntó', data: top.map(p => parseInt(p.just_asked) || 0), backgroundColor: 'rgba(148,163,184,0.5)', borderRadius: 4, maxBarThickness: 30 },
                { label: 'Problema', data: top.map(p => parseInt(p.problems) || 0), backgroundColor: 'rgba(244,63,94,0.5)', borderRadius: 4, maxBarThickness: 30 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 10, font: { size: 9 } } }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 8 }, maxRotation: 45 } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { font: { size: 9 }, stepSize: 1 } } }, animation: { duration: 400 } }
    });
}
function _updateProductsChart(products) {
    if (!_reportCharts.products) return _createProductsChart(products);
    const top = products.slice(0, 8);
    _reportCharts.products.data.labels = top.map(p => (p.product || '').substring(0, 20));
    _reportCharts.products.data.datasets[0].data = top.map(p => parseInt(p.purchased) || 0);
    _reportCharts.products.data.datasets[1].data = top.map(p => parseInt(p.just_asked) || 0);
    _reportCharts.products.data.datasets[2].data = top.map(p => parseInt(p.problems) || 0);
    _reportCharts.products.update('none');
}

// --- INTENTS CHART ---
function _createIntentsChart(intents) {
    const ctx = document.getElementById('chartIntents');
    if (!ctx || intents.length === 0) return;
    _reportCharts.intents = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: intents.map(i => INTENT_LABELS[i.intent] || i.intent),
            datasets: [{ data: intents.map(i => parseInt(i.count) || 0), backgroundColor: intents.map(i => INTENT_COLORS[i.intent] || '#475569'), borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 8, font: { size: 9 } } }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, animation: { duration: 400 } }
    });
}
function _updateIntentsChart(intents) {
    if (!_reportCharts.intents) return _createIntentsChart(intents);
    _reportCharts.intents.data.labels = intents.map(i => INTENT_LABELS[i.intent] || i.intent);
    _reportCharts.intents.data.datasets[0].data = intents.map(i => parseInt(i.count) || 0);
    _reportCharts.intents.data.datasets[0].backgroundColor = intents.map(i => INTENT_COLORS[i.intent] || '#475569');
    _reportCharts.intents.update('none');
}

// --- SENTIMENT CHART ---
function _createSentimentChart(days) {
    const ctx = document.getElementById('chartSentiment');
    if (!ctx || days.length === 0) return;
    if (days.length === 1) days = [days[0], { ...days[0] }];
    const labels = _sentimentLabels(days);
    _reportCharts.sentiment = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Positivo', data: days.map(d => parseInt(d.positive) || 0), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#10b981' },
                { label: 'Neutro', data: days.map(d => parseInt(d.neutral_count) || 0), borderColor: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.08)', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#94a3b8' },
                { label: 'Negativo', data: days.map(d => parseInt(d.negative) || 0), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.08)', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#f43f5e' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 10, font: { size: 9 } } }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 8 } } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true, ticks: { font: { size: 9 } } } }, animation: { duration: 400 } }
    });
}
function _updateSentimentChart(days) {
    if (!_reportCharts.sentiment) return _createSentimentChart(days);
    if (days.length === 0) return;
    if (days.length === 1) days = [days[0], { ...days[0] }];
    _reportCharts.sentiment.data.labels = _sentimentLabels(days);
    _reportCharts.sentiment.data.datasets[0].data = days.map(d => parseInt(d.positive) || 0);
    _reportCharts.sentiment.data.datasets[1].data = days.map(d => parseInt(d.neutral_count) || 0);
    _reportCharts.sentiment.data.datasets[2].data = days.map(d => parseInt(d.negative) || 0);
    _reportCharts.sentiment.update('none');
}
function _sentimentLabels(days) {
    return days.map((d, idx) => {
        const raw = String(d.day).replace('T', ' ').replace('Z', '').substring(0, 10);
        const dt = new Date(raw + 'T12:00:00');
        return dt.getDate() + '/' + (dt.getMonth() + 1) + (days.length === 2 && idx === 1 ? ' ' : '');
    });
}

// --- TOPICS RANKING ---
let _lastTopicsHash = '';
function _renderTopicsList(topics) {
    const container = document.getElementById('topicsListContainer');
    if (!container) return;
    if (topics.length === 0) {
        const empty = '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">Sin datos aún</div>';
        if (container.innerHTML !== empty) container.innerHTML = empty;
        return;
    }
    const hash = topics.map(t => t.topic + ':' + t.count).join('|');
    if (hash === _lastTopicsHash) return;
    _lastTopicsHash = hash;
    const maxCount = parseInt(topics[0].count) || 1;
    const rankColors = ['#f59e0b', '#94a3b8', '#cd7f32'];
    container.innerHTML = topics.map((t, idx) => {
        const count = parseInt(t.count) || 0;
        const pct = Math.round((count / maxCount) * 100);
        const color = idx < 3 ? rankColors[idx] : 'rgba(148,163,184,0.4)';
        const rankLabel = idx < 3 ? `<span class="topic-rank" style="background:${color};">${idx + 1}°</span>` : `<span class="topic-rank">${idx + 1}</span>`;
        return `<div class="topic-item-ranked">
            <div class="topic-rank-row">${rankLabel}<span class="topic-item-label" title="${(t.topic || '').replace(/"/g, '&quot;')}">${t.topic || '-'}</span><span class="topic-item-count">${count}</span></div>
            <div class="topic-bar"><div class="topic-bar-fill" style="width:${pct}%; background:${color};"></div></div>
        </div>`;
    }).join('');
}

function _renderSentimentSummary(s) {
    const container = document.getElementById('sentimentSummaryContainer');
    if (!container || !s) return;
    const total = (s.positive || 0) + (s.neutral || 0) + (s.negative || 0);
    if (total === 0) { container.innerHTML = '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">Sin datos aún</div>'; return; }
    const pct = (v) => Math.round((v / total) * 100);
    container.innerHTML = `
        <div class="sentiment-bar-wrap"><span class="sentiment-bar-label" style="color:#10b981;">Positivo</span><div class="sentiment-bar"><div class="sentiment-bar-fill" style="width:${pct(s.positive)}%; background:#10b981;"></div></div><span class="sentiment-bar-value" style="color:#10b981;">${pct(s.positive)}%</span></div>
        <div class="sentiment-bar-wrap"><span class="sentiment-bar-label" style="color:#94a3b8;">Neutro</span><div class="sentiment-bar"><div class="sentiment-bar-fill" style="width:${pct(s.neutral)}%; background:#94a3b8;"></div></div><span class="sentiment-bar-value" style="color:#94a3b8;">${pct(s.neutral)}%</span></div>
        <div class="sentiment-bar-wrap"><span class="sentiment-bar-label" style="color:#f43f5e;">Negativo</span><div class="sentiment-bar"><div class="sentiment-bar-fill" style="width:${pct(s.negative)}%; background:#f43f5e;"></div></div><span class="sentiment-bar-value" style="color:#f43f5e;">${pct(s.negative)}%</span></div>
    `;
}

// --- INSIGHTS TABLE WITH PAGINATION & FILTERS ---
async function _loadInsightsPage() {
    const limit = 10;
    const offset = _insightsPage * limit;
    let qs = `limit=${limit}&offset=${offset}`;
    if (_insightsFilters.intent) qs += `&intent=${_insightsFilters.intent}`;
    if (_insightsFilters.sentiment) qs += `&sentiment=${_insightsFilters.sentiment}`;
    if (_insightsFilters.outcome) qs += `&outcome=${_insightsFilters.outcome}`;
    if (_insightsFilters.user) qs += `&user=${encodeURIComponent(_insightsFilters.user)}`;
    if (_insightsFilters.product) qs += `&product=${encodeURIComponent(_insightsFilters.product)}`;

    try {
        const data = await fetchJSON('/api/reports/insights?' + qs);
        _insightsTotal = data.total || 0;
        _renderInsightsTable(data.insights || []);
        _renderInsightsPagination();
    } catch (err) {
        console.error('[REPORTS] Error loading insights:', err);
    }
}

function _renderInsightsTable(insights) {
    const tbody = document.getElementById('insightsTableBody');
    if (!tbody) return;
    if (insights.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--on-surface-variant); padding:1rem;">Sin interacciones clasificadas aún.</td></tr>';
        return;
    }
    tbody.innerHTML = insights.map(i => {
        const dt = new Date(i.created_at);
        const time = dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
        const date = dt.getDate() + '/' + (dt.getMonth() + 1);
        const sentClass = i.sentiment === 'positive' ? 'badge--positive' : i.sentiment === 'negative' ? 'badge--negative' : 'badge--neutral';
        return `<tr>
            <td>${date} ${time}</td>
            <td>${i.user_name || i.user_phone || '-'}</td>
            <td><span class="badge badge--intent">${INTENT_LABELS[i.intent] || i.intent}</span></td>
            <td>${i.product_consulted || '-'}</td>
            <td><span class="badge ${sentClass}">${SENTIMENT_LABELS[i.sentiment] || i.sentiment}</span></td>
            <td><span class="badge badge--outcome">${OUTCOME_LABELS[i.outcome] || i.outcome}</span></td>
            <td title="${(i.topic_summary || '').replace(/"/g, '&quot;')}">${(i.topic_summary || '-').substring(0, 40)}</td>
        </tr>`;
    }).join('');
}

function _renderInsightsPagination() {
    const container = document.getElementById('insightsPagination');
    if (!container) return;
    const totalPages = Math.ceil(_insightsTotal / 10);
    const current = _insightsPage + 1;
    container.innerHTML = `
        <span class="insights-pag-info">${current} de ${totalPages || 1}</span>
        <button class="insights-pag-btn" ${_insightsPage === 0 ? 'disabled' : ''} onclick="_insightsPage--; _loadInsightsPage();"><span class="material-symbols-outlined" style="font-size:16px;">chevron_left</span></button>
        <button class="insights-pag-btn" ${current >= totalPages ? 'disabled' : ''} onclick="_insightsPage++; _loadInsightsPage();"><span class="material-symbols-outlined" style="font-size:16px;">chevron_right</span></button>
    `;
}

function applyInsightsFilters() {
    const get = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
    _insightsFilters = {
        intent: get('filterIntent'),
        sentiment: get('filterSentiment'),
        outcome: get('filterOutcome'),
        user: get('filterUser'),
        product: get('filterProduct')
    };
    _insightsPage = 0;
    _loadInsightsPage();
}

function clearInsightsFilters() {
    ['filterIntent','filterSentiment','filterOutcome','filterUser','filterProduct'].forEach(id => {
        const e = document.getElementById(id); if (e) e.value = '';
    });
    _insightsFilters = {};
    _insightsPage = 0;
    _loadInsightsPage();
}

// --- MODALS: COMPLAINTS & UNRESOLVED ---
let _modalMiniChart = null;
function _destroyModalMiniChart() { if (_modalMiniChart) { _modalMiniChart.destroy(); _modalMiniChart = null; } }

async function openComplaintsModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Quejas detectadas';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON('/api/reports/complaints');
        const complaints = data.complaints || [];
        const daily = data.daily || [];

        let chartHtml = '';
        if (daily.length > 0) {
            chartHtml = '<div style="height:100px;margin-bottom:12px;"><canvas id="modalComplaintsChart"></canvas></div>';
        }

        const listHtml = complaints.length === 0
            ? '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">No hay quejas registradas</div>'
            : complaints.map(c => {
                const dt = new Date(c.created_at);
                const dateStr = dt.getDate() + '/' + (dt.getMonth()+1) + ' ' + dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
                return `<div style="border-bottom:1px solid rgba(255,255,255,0.05); padding:8px 0;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="font-weight:600; color:var(--on-surface);">${c.user_name || c.user_phone}</span>
                        <span style="font-size:0.65rem; color:var(--on-surface-variant);">${dateStr}</span>
                    </div>
                    <div style="font-size:0.7rem; color:var(--on-surface-variant); margin-bottom:3px;"><b>Producto:</b> ${c.product_consulted || 'N/A'} · <b>Resultado:</b> ${OUTCOME_LABELS[c.outcome] || c.outcome}</div>
                    <div style="font-size:0.7rem; color:var(--on-surface);">"${(c.user_message_preview || c.topic_summary || '-').substring(0, 200)}"</div>
                    ${c.topic_summary ? `<div style="font-size:0.65rem; color:var(--primary); margin-top:2px;">Tema: ${c.topic_summary}</div>` : ''}
                </div>`;
            }).join('');

        body.innerHTML = `
            <div class="modal-stat-row"><span class="modal-stat-label">Total quejas (30 días)</span><span class="modal-stat-value" style="color:var(--danger);">${complaints.length}</span></div>
            ${chartHtml}
            <div style="max-height:300px; overflow-y:auto;">${listHtml}</div>
        `;

        if (daily.length > 0) {
            const ctx = document.getElementById('modalComplaintsChart');
            if (ctx) {
                const labels = daily.map(d => { const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); });
                _modalMiniChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets: [{ data: daily.map(d => parseInt(d.count) || 0), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.1)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 }] },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando quejas</div>';
    }
}

async function openUnresolvedModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Problemas sin resolver';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON('/api/reports/unresolved');
        const items = data.unresolved || [];
        const daily = data.daily || [];

        let chartHtml = '';
        if (daily.length > 0) {
            chartHtml = '<div style="height:100px;margin-bottom:12px;"><canvas id="modalUnresolvedChart"></canvas></div>';
        }

        const listHtml = items.length === 0
            ? '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">No hay problemas sin resolver</div>'
            : items.map(c => {
                const dt = new Date(c.created_at);
                const dateStr = dt.getDate() + '/' + (dt.getMonth()+1) + ' ' + dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
                const intentLabel = INTENT_LABELS[c.intent] || c.intent;
                return `<div style="border-bottom:1px solid rgba(255,255,255,0.05); padding:8px 0;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="font-weight:600; color:var(--on-surface);">${c.user_name || c.user_phone}</span>
                        <span style="font-size:0.65rem; color:var(--on-surface-variant);">${dateStr}</span>
                    </div>
                    <div style="font-size:0.7rem; color:var(--on-surface-variant); margin-bottom:3px;"><b>Intención:</b> ${intentLabel} · <b>Producto:</b> ${c.product_consulted || 'N/A'} · <b>Etapa:</b> ${STAGE_LABELS[c.commercial_stage] || c.commercial_stage || 'N/A'}</div>
                    <div style="font-size:0.7rem; color:var(--on-surface);">"${(c.user_message_preview || '-').substring(0, 200)}"</div>
                    ${c.topic_summary ? `<div style="font-size:0.65rem; color:#f59e0b; margin-top:2px;">Causa: ${c.topic_summary}</div>` : ''}
                </div>`;
            }).join('');

        body.innerHTML = `
            <div class="modal-stat-row"><span class="modal-stat-label">Total sin resolver (30 días)</span><span class="modal-stat-value" style="color:#f59e0b;">${items.length}</span></div>
            ${chartHtml}
            <div style="max-height:300px; overflow-y:auto;">${listHtml}</div>
        `;

        if (daily.length > 0) {
            const ctx = document.getElementById('modalUnresolvedChart');
            if (ctx) {
                const labels = daily.map(d => { const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); });
                _modalMiniChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets: [{ data: daily.map(d => parseInt(d.count) || 0), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 }] },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando problemas</div>';
    }
}

// --- MODAL: VALORACIÓN GENERAL ---
async function openValoracionModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Valoración general';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const [detailData, summaryData] = await Promise.all([
            fetchJSON('/api/reports/valoracion-detail'),
            fetchJSON('/api/reports/summary')
        ]);
        const s = summaryData.summary || {};
        const peakDays = detailData.peakDays || [];
        const topNegUsers = detailData.topNegUsers || [];
        const topNegProducts = detailData.topNegProducts || [];
        const recentNeg = detailData.recentNeg || [];
        const total = s.totalInteractions || 0;
        const pos = s.positive || 0;
        const neu = s.neutral || 0;
        const neg = s.negative || 0;
        const pct = v => total > 0 ? Math.round((v / total) * 100) : 0;

        let worstDay = null, bestDay = null;
        peakDays.forEach(d => {
            if (!worstDay || (parseInt(d.neg) || 0) > (parseInt(worstDay.neg) || 0)) worstDay = d;
            if (!bestDay || (parseInt(d.pos) || 0) > (parseInt(bestDay.pos) || 0)) bestDay = d;
        });
        const fmtDay = (d) => { if (!d) return '-'; const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); };

        let html = '';
        // Summary totals
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Total interacciones</span><span class="modal-stat-value">${total}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Positivas</span><span class="modal-stat-value" style="color:#10b981;">${pos} (${pct(pos)}%)</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Neutras</span><span class="modal-stat-value" style="color:#94a3b8;">${neu} (${pct(neu)}%)</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Negativas</span><span class="modal-stat-value" style="color:#f43f5e;">${neg} (${pct(neg)}%)</span></div>`;

        // Mini chart
        if (peakDays.length > 0) {
            html += '<div style="height:80px;margin:10px 0;"><canvas id="modalValoracionChart"></canvas></div>';
        }

        // Peak days
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Mejor día</span><span class="modal-stat-value" style="color:#10b981;">${fmtDay(bestDay)} — ${bestDay ? parseInt(bestDay.pos)||0 : 0} positivas</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Peor día</span><span class="modal-stat-value" style="color:#f43f5e;">${fmtDay(worstDay)} — ${worstDay ? parseInt(worstDay.neg)||0 : 0} negativas</span></div>`;

        // Users
        if (topNegUsers.length > 0) {
            html += '<div class="modal-section-title">Usuarios con más negativas</div>';
            html += topNegUsers.map((u, i) => `<div class="modal-stat-row"><span class="modal-stat-label">${i+1}. ${u.user_label}</span><span class="modal-stat-value" style="color:#f43f5e;">${u.neg_count}</span></div>`).join('');
        }

        // Products
        if (topNegProducts.length > 0) {
            html += '<div class="modal-section-title">Productos con más negativas</div>';
            html += topNegProducts.map((p, i) => `<div class="modal-stat-row"><span class="modal-stat-label">${i+1}. ${p.product}</span><span class="modal-stat-value" style="color:#f43f5e;">${p.neg_count}</span></div>`).join('');
        }

        // Recent negative
        if (recentNeg.length > 0) {
            html += '<div class="modal-section-title">Últimas negativas</div><div style="max-height:180px; overflow-y:auto;">';
            html += recentNeg.map(r => {
                const dt = new Date(r.created_at);
                const dateStr = dt.getDate() + '/' + (dt.getMonth()+1) + ' ' + dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
                return `<div style="border-bottom:1px solid var(--ghost-border); padding:8px 0; font-size:0.75rem;">
                    <div style="display:flex;justify-content:space-between;"><b>${r.user_name || r.user_phone}</b><span style="color:var(--on-surface-variant);">${dateStr}</span></div>
                    <div style="color:var(--on-surface-variant); margin-top:2px;">${r.product_consulted || 'N/A'} ${r.topic_summary ? '· ' + r.topic_summary : ''}</div>
                    ${r.user_message_preview ? `<div style="color:var(--on-surface); margin-top:2px;">"${r.user_message_preview.substring(0,120)}"</div>` : ''}
                </div>`;
            }).join('');
            html += '</div>';
        }

        body.innerHTML = html || '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">Sin datos aún</div>';

        // Render chart
        if (peakDays.length > 0) {
            const ctx = document.getElementById('modalValoracionChart');
            if (ctx) {
                let pd = peakDays; if (pd.length === 1) pd = [pd[0], pd[0]];
                const labels = pd.map(d => { const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); });
                _modalMiniChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets: [
                        { label: 'Positivas', data: pd.map(d => parseInt(d.pos)||0), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 },
                        { label: 'Negativas', data: pd.map(d => parseInt(d.neg)||0), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.08)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 }
                    ]},
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 6, boxHeight: 6, usePointStyle: true, pointStyle: 'circle', padding: 8, font: { size: 9 } } } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true, suggestedMax: 1 } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando datos</div>';
    }
}

// --- MODAL: VALORACIÓN POR DÍA ---
async function openValoracionDailyModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Valoración por día';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const data = await fetchJSON('/api/reports/valoracion-daily-detail');
        const daily = data.daily || [];
        const worst = data.worstInteractions || [];

        // Totals from daily
        let totalPos = 0, totalNeu = 0, totalNeg = 0, totalAll = 0;
        daily.forEach(d => { totalPos += parseInt(d.positive)||0; totalNeu += parseInt(d.neutral_count)||0; totalNeg += parseInt(d.negative)||0; totalAll += parseInt(d.total)||0; });

        // Week comparison
        let thisWeekNeg = 0, lastWeekNeg = 0;
        const now = new Date();
        daily.forEach(d => {
            const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00');
            const diffDays = Math.floor((now - dt) / 86400000);
            const neg = parseInt(d.negative) || 0;
            if (diffDays <= 7) thisWeekNeg += neg;
            else if (diffDays <= 14) lastWeekNeg += neg;
        });

        let html = '';

        // Summary KPIs
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Período</span><span class="modal-stat-value">${daily.length} días · ${totalAll} interacciones</span></div>`;
        if (lastWeekNeg > 0 || thisWeekNeg > 0) {
            const diff = thisWeekNeg - lastWeekNeg;
            const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
            const color = diff > 0 ? '#f43f5e' : diff < 0 ? '#10b981' : '#94a3b8';
            html += `<div class="modal-stat-row"><span class="modal-stat-label">Tendencia negativas</span><span class="modal-stat-value" style="color:${color};">${arrow} ${thisWeekNeg} esta semana vs ${lastWeekNeg} anterior</span></div>`;
        }

        // Mini chart
        if (daily.length > 0) {
            html += '<div style="height:90px;margin:10px 0;"><canvas id="modalValDailyChart"></canvas></div>';
        }

        // Daily table with better spacing
        html += '<div class="modal-section-title">Desglose por día</div>';
        html += '<div style="max-height:200px; overflow-y:auto;"><table class="insights-table" style="font-size:0.72rem;"><thead><tr><th style="padding:8px 12px;">Fecha</th><th style="padding:8px 12px; color:#10b981;">Pos</th><th style="padding:8px 12px; color:#94a3b8;">Neu</th><th style="padding:8px 12px; color:#f43f5e;">Neg</th><th style="padding:8px 12px;">Total</th><th style="padding:8px 12px;">% Neg</th></tr></thead><tbody>';
        daily.forEach(d => {
            const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00');
            const dateStr = dt.getDate() + '/' + (dt.getMonth()+1);
            const p = parseInt(d.positive)||0, n = parseInt(d.neutral_count)||0, ng = parseInt(d.negative)||0, t = parseInt(d.total)||1;
            const negPct = Math.round((ng / t) * 100);
            const rowStyle = negPct > 50 ? 'background:rgba(244,63,94,0.06);' : '';
            html += `<tr style="${rowStyle}"><td style="padding:8px 12px;">${dateStr}</td><td style="padding:8px 12px;">${p}</td><td style="padding:8px 12px;">${n}</td><td style="padding:8px 12px;color:#f43f5e;font-weight:600;">${ng}</td><td style="padding:8px 12px;">${t}</td><td style="padding:8px 12px;${negPct > 50 ? 'color:#f43f5e;font-weight:700;' : ''}">${negPct}%</td></tr>`;
        });
        html += '</tbody></table></div>';

        // Worst interactions
        if (worst.length > 0) {
            html += '<div class="modal-section-title">Últimas negativas</div><div style="max-height:160px; overflow-y:auto;">';
            html += worst.map(w => {
                const dt = new Date(w.created_at);
                const dateStr = dt.getDate() + '/' + (dt.getMonth()+1) + ' ' + dt.getHours().toString().padStart(2,'0') + ':' + dt.getMinutes().toString().padStart(2,'0');
                return `<div style="border-bottom:1px solid var(--ghost-border); padding:8px 0; font-size:0.75rem;">
                    <div style="display:flex;justify-content:space-between;"><b>${w.user_label}</b><span style="color:var(--on-surface-variant);">${dateStr}</span></div>
                    <div style="color:var(--on-surface-variant); margin-top:2px;">${INTENT_LABELS[w.intent] || w.intent} · ${w.product_consulted || 'N/A'}</div>
                    ${w.user_message_preview ? `<div style="color:var(--on-surface); margin-top:2px;">"${w.user_message_preview.substring(0,120)}"</div>` : ''}
                </div>`;
            }).join('');
            html += '</div>';
        }

        body.innerHTML = html || '<div style="text-align:center; color:var(--on-surface-variant); padding:1rem;">Sin datos aún</div>';

        // Render chart
        if (daily.length > 0) {
            const ctx = document.getElementById('modalValDailyChart');
            if (ctx) {
                let dd = daily.slice().reverse(); if (dd.length === 1) dd = [dd[0], dd[0]];
                const labels = dd.map(d => { const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); });
                _modalMiniChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets: [
                        { label: 'Pos', data: dd.map(d => parseInt(d.positive)||0), backgroundColor: 'rgba(16,185,129,0.5)', borderRadius: 3, maxBarThickness: 16 },
                        { label: 'Neu', data: dd.map(d => parseInt(d.neutral_count)||0), backgroundColor: 'rgba(148,163,184,0.3)', borderRadius: 3, maxBarThickness: 16 },
                        { label: 'Neg', data: dd.map(d => parseInt(d.negative)||0), backgroundColor: 'rgba(244,63,94,0.5)', borderRadius: 3, maxBarThickness: 16 }
                    ]},
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 6, boxHeight: 6, usePointStyle: true, pointStyle: 'circle', padding: 8, font: { size: 9 } } } }, scales: { x: { stacked: true, display: false }, y: { stacked: true, display: false, beginAtZero: true, suggestedMax: 1 } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando datos</div>';
    }
}

// --- MODAL: RESULTADOS (OUTCOMES) ---
async function openOutcomesModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Interacciones';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const [summaryData, outcomeDailyData] = await Promise.all([
            fetchJSON('/api/reports/summary'),
            fetchJSON('/api/reports/outcome-daily')
        ]);
        const s = summaryData.summary || {};
        const days = outcomeDailyData.days || [];
        const total = s.totalInteractions || 0;

        const outcomeMap = [
            { key: 'purchased', label: 'Compró', color: '#10b981' },
            { key: 'resolved', label: 'Resuelto', color: '#38bdf8' },
            { key: 'redirected', label: 'Redirigido', color: '#22d3ee' },
            { key: 'just_asked', label: 'Solo preguntó', color: '#94a3b8' },
            { key: 'ongoing', label: 'En curso', color: '#a78bfa' },
            { key: 'problem_reported', label: 'Problema', color: '#f43f5e' },
            { key: 'unresolved', label: 'Sin resolver', color: '#f59e0b' }
        ];

        // Compute totals from daily data
        const totals = {};
        outcomeMap.forEach(o => { totals[o.key] = 0; });
        days.forEach(d => { outcomeMap.forEach(o => { totals[o.key] += (d[o.key] || 0); }); });

        let html = '';
        html += `<div class="modal-stat-row" style="margin-bottom:12px;"><span class="modal-stat-label">Total interacciones</span><span class="modal-stat-value" style="font-size:1.1rem;">${total}</span></div>`;
        html += '<div style="height:160px;margin-bottom:12px;"><canvas id="modalOutcomesChart"></canvas></div>';
        html += '<div class="modal-section-title">Desglose por resultado</div>';
        outcomeMap.forEach(o => {
            const val = totals[o.key] || 0;
            if (val === 0) return;
            const pct = total > 0 ? Math.round((val / total) * 100) : 0;
            html += `<div class="modal-stat-row"><span class="modal-stat-label">${o.label}</span><span class="modal-stat-value" style="color:${o.color};">${val} (${pct}%)</span></div>`;
        });

        body.innerHTML = html;

        const ctx = document.getElementById('modalOutcomesChart');
        if (ctx) {
            const activeOutcomes = outcomeMap.filter(o => (totals[o.key] || 0) > 0);
            _modalMiniChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: activeOutcomes.map(o => o.label),
                    datasets: [{ data: activeOutcomes.map(o => totals[o.key] || 0), backgroundColor: activeOutcomes.map(o => o.color + 'cc'), borderColor: activeOutcomes.map(o => o.color), borderWidth: 1, borderRadius: 6 }]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.x} interacciones (${total > 0 ? Math.round((ctx.parsed.x / total) * 100) : 0}%)` } } },
                    scales: {
                        x: { display: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 9 }, color: 'rgba(255,255,255,0.5)', stepSize: 1 } },
                        y: { grid: { display: false }, ticks: { font: { size: 9 }, color: 'rgba(255,255,255,0.7)' } }
                    },
                    animation: { duration: 300 }
                }
            });
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando resultados</div>';
    }
}

// --- MODAL: RESOLUCIÓN Y COMPRA (UNIFIED) ---
async function openResolutionPurchaseModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Resolución y compra';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const [summaryData, productsData, kpiData] = await Promise.all([
            fetchJSON('/api/reports/summary'),
            fetchJSON('/api/reports/products'),
            fetchJSON('/api/reports/kpi-daily')
        ]);
        const s = summaryData.summary || {};
        const products = productsData.products || [];
        const days = kpiData.days || [];

        const total = s.totalInteractions || 0;
        const resolved = s.resolvedCount || 0;
        const notResolved = Math.max(0, total - resolved);
        const totalPurchases = s.purchases || 0;
        const totalInterest = s.purchaseIntents || 0;
        const convRate = totalInterest > 0 ? Math.round((totalPurchases / totalInterest) * 100) : 0;

        let html = '';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">';
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Total interacciones</span><span class="modal-stat-value">${total}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Resueltos</span><span class="modal-stat-value" style="color:#10b981;">${resolved} (${s.resolutionRate || 0}%)</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">No resueltos</span><span class="modal-stat-value" style="color:#f43f5e;">${notResolved}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Compras</span><span class="modal-stat-value" style="color:#c084fc;">${totalPurchases} (${s.purchaseRate || 0}%)</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Interés de compra</span><span class="modal-stat-value" style="color:#a78bfa;">${totalInterest}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Conversión interés→compra</span><span class="modal-stat-value" style="color:#f59e0b;">${convRate}%</span></div>`;
        html += '</div>';

        if (days.length > 0) {
            html += '<div style="height:100px;margin-bottom:12px;"><canvas id="modalResPurchaseChart"></canvas></div>';
        }

        // Products bought
        const bought = products.filter(p => parseInt(p.purchased) > 0);
        if (bought.length > 0) {
            html += '<div class="modal-section-title">Productos comprados</div>';
            html += bought.slice(0, 8).map((p, i) => {
                const purchased = parseInt(p.purchased) || 0;
                return `<div class="modal-stat-row"><span class="modal-stat-label">${i+1}. ${p.product}</span><span class="modal-stat-value" style="color:#10b981;">${purchased}</span></div>`;
            }).join('');
        }

        // Products only asked
        const interested = products.filter(p => parseInt(p.just_asked) > 0);
        if (interested.length > 0) {
            html += '<div class="modal-section-title">Más consultados sin comprar</div>';
            html += interested.slice(0, 5).map((p, i) => {
                return `<div class="modal-stat-row"><span class="modal-stat-label">${i+1}. ${p.product}</span><span class="modal-stat-value" style="color:#94a3b8;">${parseInt(p.just_asked) || 0}</span></div>`;
            }).join('');
        }

        body.innerHTML = html;

        if (days.length > 0) {
            const ctx = document.getElementById('modalResPurchaseChart');
            if (ctx) {
                let dd = days; if (dd.length === 1) dd = [dd[0], dd[0]];
                const labels = dd.map(d => { const dt = new Date(String(d.day).substring(0,10) + 'T12:00:00'); return dt.getDate() + '/' + (dt.getMonth()+1); });
                _modalMiniChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets: [
                        { label: '% Resolución', data: dd.map(d => d.resolutionRate || 0), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 },
                        { label: '% Compra', data: dd.map(d => d.purchaseRate || 0), borderColor: '#c084fc', backgroundColor: 'rgba(192,132,252,0.08)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 }
                    ]},
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 6, boxHeight: 6, usePointStyle: true, pointStyle: 'circle', padding: 8, font: { size: 9 } } } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true, suggestedMax: 100 } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando datos</div>';
    }
}

// --- MODAL: EMBUDO COMERCIAL ---
async function openFunnelModal() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Embudo Comercial';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const [funnelData, summaryData] = await Promise.all([
            fetchJSON('/api/reports/funnel'),
            fetchJSON('/api/reports/summary')
        ]);
        const funnel = funnelData.funnel || [];
        const s = summaryData.summary || {};
        const ordered = STAGE_ORDER.map(stage => {
            const found = funnel.find(f => f.stage === stage);
            return { stage, count: found ? parseInt(found.unique_users) || 0 : 0, total: found ? parseInt(found.count) || 0 : 0 };
        });
        const totalUsers = s.uniqueUsers || 0;
        const discovery = ordered.find(o => o.stage === 'DISCOVERY');
        const closing = ordered.find(o => o.stage === 'CLOSING');
        const convRate = discovery && discovery.count > 0 ? Math.round((closing ? closing.count : 0) / discovery.count * 100) : 0;

        let html = '';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">';
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Usuarios únicos</span><span class="modal-stat-value">${totalUsers}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Total interacciones</span><span class="modal-stat-value">${s.totalInteractions || 0}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Conversión global</span><span class="modal-stat-value" style="color:#10b981;">${convRate}%</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Compras</span><span class="modal-stat-value" style="color:#c084fc;">${s.purchases || 0}</span></div>`;
        html += '</div>';

        html += '<div style="height:140px;margin-bottom:12px;"><canvas id="modalFunnelChart"></canvas></div>';

        html += '<div class="modal-section-title">Desglose por etapa</div>';
        ordered.forEach(o => {
            const pct = totalUsers > 0 ? Math.round((o.count / totalUsers) * 100) : 0;
            html += `<div class="modal-stat-row"><span class="modal-stat-label">${STAGE_LABELS[o.stage] || o.stage}</span><span class="modal-stat-value">${o.count} usuarios (${pct}%)</span></div>`;
        });

        body.innerHTML = html;

        const ctx = document.getElementById('modalFunnelChart');
        if (ctx) {
            const colors = ['#c084fc','#a78bfa','#818cf8','#60a5fa','#38bdf8','#22d3ee'];
            _modalMiniChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ordered.map(o => STAGE_LABELS[o.stage] || o.stage),
                    datasets: [{ data: ordered.map(o => o.count), backgroundColor: colors, borderRadius: 4, maxBarThickness: 40 }]
                },
                options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, scales: { x: { display: false, beginAtZero: true }, y: { grid: { display: false }, ticks: { font: { size: 9 }, color: 'rgba(255,255,255,0.6)' } } }, animation: { duration: 300 } }
            });
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando embudo</div>';
    }
}

// --- MODAL: PRODUCTOS MÁS CONSULTADOS ---
async function openProductsModal2() {
    _destroyModalMiniChart();
    const modal = document.getElementById('userStatsModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!modal || !title || !body) return;

    title.textContent = 'Productos más consultados';
    body.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--on-surface-variant);">Cargando...</div>';
    modal.style.display = 'flex';

    try {
        const productsData = await fetchJSON('/api/reports/products');
        const products = productsData.products || [];
        const totalConsultas = products.reduce((sum, p) => sum + (parseInt(p.total) || 0), 0);
        const totalCompras = products.reduce((sum, p) => sum + (parseInt(p.purchased) || 0), 0);
        const totalProblemas = products.reduce((sum, p) => sum + (parseInt(p.problems) || 0), 0);
        const topProduct = products.length > 0 ? products[0].product : '-';

        let html = '';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-bottom:12px;">';
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Productos únicos</span><span class="modal-stat-value">${products.length}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Total consultas</span><span class="modal-stat-value">${totalConsultas}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Compras totales</span><span class="modal-stat-value" style="color:#10b981;">${totalCompras}</span></div>`;
        html += `<div class="modal-stat-row"><span class="modal-stat-label">Problemas totales</span><span class="modal-stat-value" style="color:#f43f5e;">${totalProblemas}</span></div>`;
        html += '</div>';

        html += `<div class="modal-stat-row" style="margin-bottom:10px;"><span class="modal-stat-label">Producto más consultado</span><span class="modal-stat-value" style="color:#c084fc;">${topProduct}</span></div>`;

        if (products.length > 0) {
            html += '<div style="height:150px;margin-bottom:12px;"><canvas id="modalProductsChart"></canvas></div>';
        }

        html += '<div class="modal-section-title">Detalle por producto</div>';
        html += '<div style="max-height:200px; overflow-y:auto;">';
        products.forEach((p, i) => {
            const purchased = parseInt(p.purchased) || 0;
            const asked = parseInt(p.just_asked) || 0;
            const problems = parseInt(p.problems) || 0;
            const total = parseInt(p.total) || 0;
            html += `<div style="border-bottom:1px solid var(--ghost-border); padding:8px 0; font-size:0.75rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b>${i+1}. ${p.product}</b>
                    <span style="color:var(--on-surface-variant);">${total} total</span>
                </div>
                <div style="display:flex;gap:12px;margin-top:4px;font-size:0.7rem;">
                    <span style="color:#10b981;">${purchased} compra${purchased!==1?'s':''}</span>
                    <span style="color:#94a3b8;">${asked} pregunta${asked!==1?'s':''}</span>
                    ${problems > 0 ? `<span style="color:#f43f5e;">${problems} problema${problems!==1?'s':''}</span>` : ''}
                </div>
            </div>`;
        });
        html += '</div>';

        body.innerHTML = html;

        if (products.length > 0) {
            const ctx = document.getElementById('modalProductsChart');
            if (ctx) {
                const top = products.slice(0, 8);
                _modalMiniChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: top.map(p => (p.product || '').substring(0, 18)),
                        datasets: [
                            { label: 'Compró', data: top.map(p => parseInt(p.purchased) || 0), backgroundColor: 'rgba(16,185,129,0.6)', borderRadius: 3, maxBarThickness: 24 },
                            { label: 'Preguntó', data: top.map(p => parseInt(p.just_asked) || 0), backgroundColor: 'rgba(148,163,184,0.5)', borderRadius: 3, maxBarThickness: 24 },
                            { label: 'Problema', data: top.map(p => parseInt(p.problems) || 0), backgroundColor: 'rgba(244,63,94,0.5)', borderRadius: 3, maxBarThickness: 24 }
                        ]
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 6, boxHeight: 6, usePointStyle: true, pointStyle: 'circle', padding: 8, font: { size: 9 } } }, tooltip: { backgroundColor: '#1e1e24', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 8, cornerRadius: 6 } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 8 }, maxRotation: 45, color: 'rgba(255,255,255,0.6)' } }, y: { display: false, beginAtZero: true } }, animation: { duration: 300 } }
                });
            }
        }
    } catch (err) {
        body.innerHTML = '<div style="color:var(--danger); padding:1rem;">Error cargando productos</div>';
    }
}
