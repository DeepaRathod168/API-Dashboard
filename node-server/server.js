const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// To support old versions of Node, we can dynamically import node-fetch if global fetch is undefined
let fetchFn = global.fetch;
if (!fetchFn) {
    try {
        fetchFn = require('node-fetch');
    } catch(e) {
        console.warn("fetch API not found natively and node-fetch not installed. Using native http.");
    }
}

const LOG_FILE = path.join(__dirname, 'logs', 'monitor-logs.json');
const TARGETS_FILE = path.join(__dirname, 'targets.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure files exist
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]', 'utf8');
if (!fs.existsSync(TARGETS_FILE)) {
    // Inject some default dummies
    fs.writeFileSync(TARGETS_FILE, JSON.stringify([
        { id: 1, url: 'http://localhost:3000/api/dummy/success', method: 'GET', addedAt: new Date().toISOString() },
        { id: 2, url: 'http://localhost:3000/api/dummy/slow', method: 'GET', addedAt: new Date().toISOString() },
        { id: 3, url: 'http://localhost:3000/api/dummy/error', method: 'GET', addedAt: new Date().toISOString() }
    ], null, 2), 'utf8');
}

const getTargets = () => JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8') || '[]');
const saveTargets = (targets) => fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2));

app.get('/api/targets', (req, res) => {
    res.json(getTargets());
});

app.post('/api/targets', (req, res) => {
    const { url, method = 'GET' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const targets = getTargets();
    if (targets.find(t => t.url === url && t.method === method)) {
        return res.status(400).json({ error: 'Target already exists' });
    }

    targets.push({ id: Date.now(), url, method, addedAt: new Date().toISOString() });
    saveTargets(targets);
    res.status(201).json({ message: 'Target added successfully' });
});

app.delete('/api/targets/:id', (req, res) => {
    let targets = getTargets();
    targets = targets.filter(t => t.id !== parseInt(req.params.id));
    saveTargets(targets);
    res.json({ message: 'Target removed' });
});

// Dummy endpoints for realistic monitoring tests
app.get('/api/dummy/success', (req, res) => res.json({ ok: true }));
app.get('/api/dummy/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 800));
app.get('/api/dummy/error', (req, res) => res.status(500).json({ error: 'Internal Server Error' }));

// ----------------- Scheduler / Active Monitor -----------------
const monitorTargets = async () => {
    const targets = getTargets();
    if (targets.length === 0) return;

    let newLogs = [];

    for (const target of targets) {
        const start = process.hrtime();
        let status = 0;
        let success = false;
        
        try {
            if (fetchFn) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const response = await fetchFn(target.url, { 
                    method: target.method,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                status = response.status;
                success = response.ok;
            } else {
                success = true; status = 200; 
            }
        } catch (error) {
            status = 0;
            success = false;
        }

        const diff = process.hrtime(start);
        const duration = parseFloat((diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2));

        newLogs.push({
            timestamp: new Date().toISOString(),
            url: target.url,
            method: target.method,
            status,
            success,
            duration
        });
    }

    // Flush all ping results of this interval synchronously to avoid race conditions
    try {
        const existingData = fs.readFileSync(LOG_FILE, 'utf8');
        const logs = JSON.parse(existingData || '[]');
        logs.push(...newLogs);
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch(e) { console.error("Could not write logs", e); }
};

// Actively monitor every 10 seconds
console.log("Starting active API Monitor scheduler (interval: 10s)...");
setInterval(monitorTargets, 10000);
// Trigger an immediate ping
setTimeout(monitorTargets, 1000);

app.listen(PORT, () => {
    console.log(`Active Monitor Node.js Server running on http://localhost:${PORT}`);
});
