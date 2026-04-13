const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'logs', 'monitor-logs.json');
const reportFile = path.join(__dirname, 'public', 'report.json');

if (!fs.existsSync(logFile)) {
    console.error("No logs found. Run server.js and allow it to ping targets first.");
    process.exit(1);
}

let logs = [];
try {
    logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
} catch (e) {
    console.error("Failed to parse logs:", e);
    process.exit(1);
}

const report = {
    summary: {
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        totalSlowRequests: 0,
        statusCounts: {}
    },
    endpointDetails: {}
};

let totalAppTime = 0;
let totalErrors = 0;

logs.forEach(log => {
    report.summary.totalRequests++;
    totalAppTime += log.duration;

    if (!log.success) totalErrors++;
    if (log.duration > 500) report.summary.totalSlowRequests++;

    const statusGroup = log.status === 0 ? '0xx (Network Error)' : (Math.floor(log.status / 100) + 'xx');
    report.summary.statusCounts[statusGroup] = (report.summary.statusCounts[statusGroup] || 0) + 1;

    const key = `${log.method} ${log.url}`;
    if (!report.endpointDetails[key]) {
        report.endpointDetails[key] = {
            method: log.method,
            endpoint: log.url,
            totalRequests: 0,
            averageResponseTime: 0,
            slowRequests: 0,
            errors: 0,
            _totalTime: 0
        };
    }

    const stats = report.endpointDetails[key];
    stats.totalRequests++;
    stats._totalTime += log.duration;
    if (log.duration > 500) stats.slowRequests++;
    if (!log.success) stats.errors++;
});

if (report.summary.totalRequests > 0) {
    report.summary.averageResponseTime = totalAppTime / report.summary.totalRequests;
    report.summary.errorRate = (totalErrors / report.summary.totalRequests) * 100;
}

Object.values(report.endpointDetails).forEach(stats => {
    stats.averageResponseTime = stats._totalTime / stats.totalRequests;
    delete stats._totalTime;
});

fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log("Analysis complete. Report generated at:", reportFile);
