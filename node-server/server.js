const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Supports older Node versions without native fetch
let fetchFn = global.fetch;
if (!fetchFn) {
    try { fetchFn = require('node-fetch'); } catch(e) {}
}

const LOG_FILE    = path.join(__dirname, 'logs', 'monitor-logs.json');
const TARGETS_FILE = path.join(__dirname, 'targets.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── File helpers ──────────────────────────────────────────────────────────────
const getTargets = () => JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8') || '[]');
const saveTargets = t => fs.writeFileSync(TARGETS_FILE, JSON.stringify(t, null, 2));
const getLogs     = () => { try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8') || '[]'); } catch { return []; } };

// Bootstrap files
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]', 'utf8');
if (!fs.existsSync(TARGETS_FILE)) {
    saveTargets([
        { id: 1, url: 'http://localhost:3000/api/dummy/success', method: 'GET', name: 'Success Endpoint', addedAt: new Date().toISOString() },
        { id: 2, url: 'http://localhost:3000/api/dummy/slow',    method: 'GET', name: 'Slow Endpoint',    addedAt: new Date().toISOString() },
        { id: 3, url: 'http://localhost:3000/api/dummy/error',   method: 'GET', name: 'Error Endpoint',   addedAt: new Date().toISOString() }
    ]);
}

// ── Targets CRUD ──────────────────────────────────────────────────────────────
app.get('/api/targets', (req, res) => res.json(getTargets()));

app.post('/api/targets', (req, res) => {
    const { url, method = 'GET', name = '' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const targets = getTargets();
    if (targets.find(t => t.url === url && t.method === method))
        return res.status(400).json({ error: 'Target already exists' });
    targets.push({ id: Date.now(), url, method, name: name || url, addedAt: new Date().toISOString() });
    saveTargets(targets);
    res.status(201).json({ message: 'Target added successfully' });
});

app.delete('/api/targets/:id', (req, res) => {
    saveTargets(getTargets().filter(t => t.id !== parseInt(req.params.id)));
    res.json({ message: 'Target removed' });
});

// ── Raw logs ──────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
    const { limit = 100, url } = req.query;
    let logs = getLogs();
    if (url) logs = logs.filter(l => l.url === url);
    res.json(logs.slice(-parseInt(limit)));
});

// ── Analytics: computed stats on the fly ─────────────────────────────────────
app.get('/api/analytics', (req, res) => {
    const logs    = getLogs();
    const targets = getTargets();
    if (!logs.length) return res.json({ summary: {}, endpointDetails: {}, timeline: [] });

    const summary = {
        totalRequests: logs.length,
        averageResponseTime: 0,
        errorRate: 0,
        totalSlowRequests: 0,
        successCount: 0,
        failureCount: 0,
        statusCounts: {}
    };

    let totalTime = 0, totalErrors = 0;
    const endpointDetails = {};

    logs.forEach(log => {
        totalTime += log.duration;
        if (!log.success) totalErrors++;
        else summary.successCount++;
        if (log.duration > 500) summary.totalSlowRequests++;

        const sg = log.status === 0 ? '0xx' : Math.floor(log.status / 100) + 'xx';
        summary.statusCounts[sg] = (summary.statusCounts[sg] || 0) + 1;

        const key = `${log.method} ${log.url}`;
        if (!endpointDetails[key]) {
            endpointDetails[key] = {
                method: log.method, endpoint: log.url,
                totalRequests: 0, averageResponseTime: 0,
                slowRequests: 0, errors: 0, _totalTime: 0,
                lastStatus: 0, lastChecked: null
            };
        }
        const s = endpointDetails[key];
        s.totalRequests++;
        s._totalTime += log.duration;
        if (log.duration > 500) s.slowRequests++;
        if (!log.success) s.errors++;
        s.lastStatus  = log.status;
        s.lastChecked = log.timestamp;
    });

    summary.failureCount = totalErrors;
    summary.averageResponseTime = totalTime / logs.length;
    summary.errorRate = (totalErrors / logs.length) * 100;

    Object.values(endpointDetails).forEach(s => {
        s.averageResponseTime = s._totalTime / s.totalRequests;
        s.uptime = ((s.totalRequests - s.errors) / s.totalRequests) * 100;
        delete s._totalTime;
    });

    // Hourly timeline for charts (last 24 h)
    const now   = Date.now();
    const hours = Array.from({ length: 24 }, (_, i) => {
        const t = new Date(now - (23 - i) * 3600000);
        return { hour: t.toISOString().slice(0, 13), count: 0, errors: 0, totalDuration: 0 };
    });
    logs.forEach(log => {
        const h = log.timestamp.slice(0, 13);
        const slot = hours.find(x => x.hour === h);
        if (slot) { slot.count++; if (!log.success) slot.errors++; slot.totalDuration += log.duration; }
    });

    res.json({ summary, endpointDetails, timeline: hours, targets: targets.length });
});

// ── Activity feed (last N events) ────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const logs  = getLogs().slice(-limit).reverse();
    res.json(logs);
});

// ── Status per target (latest ping result) ────────────────────────────────────
app.get('/api/status', (req, res) => {
    const targets = getTargets();
    const logs    = getLogs();
    const status  = targets.map(t => {
        const key = `${t.method} ${t.url}`;
        const relevant = logs.filter(l => `${l.method} ${l.url}` === key);
        const last = relevant[relevant.length - 1] || null;
        return {
            id: t.id, url: t.url, method: t.method, name: t.name,
            lastStatus: last?.status ?? null,
            lastDuration: last?.duration ?? null,
            lastChecked: last?.timestamp ?? null,
            success: last?.success ?? null,
            pings: relevant.length
        };
    });
    res.json(status);
});

// ── Dummy endpoints ───────────────────────────────────────────────────────────
app.get('/api/dummy/success', (req, res) => res.json({ ok: true, message: 'All systems operational' }));
app.get('/api/dummy/slow',    (req, res) => setTimeout(() => res.json({ ok: true, message: 'Slow but alive' }), 800));
app.get('/api/dummy/error',   (req, res) => res.status(500).json({ error: 'Internal Server Error' }));

// ── Scheduler ─────────────────────────────────────────────────────────────────
const monitorTargets = async () => {
    const targets = getTargets();
    if (!targets.length) return;

    const newLogs = [];
    for (const target of targets) {
        const start = process.hrtime();
        let status = 0, success = false;
        try {
            if (fetchFn) {
                const ctrl = new AbortController();
                const tid  = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetchFn(target.url, { method: target.method, signal: ctrl.signal });
                clearTimeout(tid);
                status  = resp.status;
                success = resp.ok;
            } else { success = true; status = 200; }
        } catch { status = 0; success = false; }

        const diff = process.hrtime(start);
        newLogs.push({
            timestamp: new Date().toISOString(),
            url: target.url, method: target.method,
            status, success,
            duration: parseFloat((diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2))
        });
    }

    try {
        const logs = getLogs();
        // Keep log to last 5000 entries to prevent unbounded growth
        const combined = [...logs, ...newLogs].slice(-5000);
        fs.writeFileSync(LOG_FILE, JSON.stringify(combined, null, 2));
    } catch(e) { console.error('Could not write logs:', e); }
};

console.log('Starting Active API Monitor scheduler (interval: 10s)...');
setInterval(monitorTargets, 10000);
setTimeout(monitorTargets, 1000);

app.listen(PORT, () => console.log(`API Monitor running → http://localhost:${PORT}`));
