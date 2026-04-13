package com.monitor;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class PerformanceAnalyzer {

    public static class LogEntry {
        public String timestamp;
        public String url;
        public String method;
        public int status;
        public boolean success;
        public double duration;
    }

    public static class EndpointStats {
        public String method;
        public String endpoint; // mapped to url
        public int totalRequests;
        public double totalResponseTime;
        public int slowRequests; 
        public int errors;       
    }

    public static class Summary {
        public int totalRequests;
        public double averageResponseTime;
        public double errorRate;
        public int totalSlowRequests;
        public Map<String, Integer> statusCounts = new HashMap<>();
    }

    public static class Report {
        public Summary summary = new Summary();
        public Map<String, EndpointStats> endpointDetails = new HashMap<>();
    }

    public static void main(String[] args) {
        File logFile = new File("node-server/logs/monitor-logs.json");
        if (!logFile.exists()) {
            logFile = new File("../node-server/logs/monitor-logs.json");
        }

        if (!logFile.exists()) {
            System.err.println("Could not find monitor-logs.json! Searched: " + logFile.getAbsolutePath());
            writeReport(new Report());
            return;
        }

        System.out.println("Reading logs from: " + logFile.getAbsolutePath());
        List<LogEntry> logs = parseLogs(logFile);
        Report report = analyzeLogs(logs);
        writeReport(report);
    }

    private static List<LogEntry> parseLogs(File file) {
        List<LogEntry> logs = new ArrayList<>();
        try {
            String content = new String(Files.readAllBytes(Paths.get(file.getAbsolutePath())));
            // Regex for: "timestamp":"...","url":"...","method":"...","status":200,"success":true,"duration":123.45
            Pattern pattern = Pattern.compile("\"timestamp\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"url\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"method\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"status\"\\s*:\\s*(\\d+)\\s*,\\s*\"success\"\\s*:\\s*(true|false)\\s*,\\s*\"duration\"\\s*:\\s*([0-9.]+)");
            Matcher m = pattern.matcher(content);
            while (m.find()) {
                LogEntry e = new LogEntry();
                e.timestamp = m.group(1);
                e.url = m.group(2);
                e.method = m.group(3);
                e.status = Integer.parseInt(m.group(4));
                e.success = Boolean.parseBoolean(m.group(5));
                e.duration = Double.parseDouble(m.group(6));
                logs.add(e);
            }
        } catch (Exception e) {
            System.err.println("Error parsing logs: " + e.getMessage());
            e.printStackTrace();
        }
        return logs;
    }

    private static Report analyzeLogs(List<LogEntry> logs) {
        Report report = new Report();
        double totalAppTime = 0;
        int totalErrors = 0;

        for (LogEntry log : logs) {
            report.summary.totalRequests++;
            totalAppTime += log.duration;

            if (!log.success) {
                totalErrors++;
            }

            if (log.duration > 500) {
                report.summary.totalSlowRequests++;
            }

            String statusGroup = (log.status / 100) + "xx";
            if (log.status == 0) statusGroup = "0xx (Network Error)";
            report.summary.statusCounts.put(statusGroup, report.summary.statusCounts.getOrDefault(statusGroup, 0) + 1);

            String key = log.method + " " + log.url;
            EndpointStats stats = report.endpointDetails.getOrDefault(key, new EndpointStats());
            stats.method = log.method;
            stats.endpoint = log.url;
            stats.totalRequests++;
            stats.totalResponseTime += log.duration;
            if (log.duration > 500) stats.slowRequests++;
            if (!log.success) stats.errors++;
            
            report.endpointDetails.put(key, stats);
        }

        if (report.summary.totalRequests > 0) {
            report.summary.averageResponseTime = totalAppTime / report.summary.totalRequests;
            report.summary.errorRate = ((double) totalErrors / report.summary.totalRequests) * 100.0;
        }

        return report;
    }

    private static void writeReport(Report report) {
        File reportFile = new File("node-server/public/report.json");
        if (!reportFile.getParentFile().exists()) {
            reportFile = new File("../node-server/public/report.json");
        }

        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"summary\": {\n");
        sb.append("    \"totalRequests\": ").append(report.summary.totalRequests).append(",\n");
        sb.append("    \"averageResponseTime\": ").append(report.summary.averageResponseTime).append(",\n");
        sb.append("    \"errorRate\": ").append(report.summary.errorRate).append(",\n");
        sb.append("    \"totalSlowRequests\": ").append(report.summary.totalSlowRequests).append(",\n");
        sb.append("    \"statusCounts\": {");
        int count = 0;
        for (Map.Entry<String, Integer> entry : report.summary.statusCounts.entrySet()) {
            sb.append("\"").append(entry.getKey()).append("\": ").append(entry.getValue());
            if (++count < report.summary.statusCounts.size()) sb.append(", ");
        }
        sb.append("}\n  },\n");
        sb.append("  \"endpointDetails\": {\n");
        count = 0;
        for (Map.Entry<String, EndpointStats> entry : report.endpointDetails.entrySet()) {
            EndpointStats st = entry.getValue();
            sb.append("    \"").append(entry.getKey()).append("\": {\n");
            sb.append("      \"method\": \"").append(st.method).append("\",\n");
            sb.append("      \"endpoint\": \"").append(st.endpoint).append("\",\n");
            sb.append("      \"totalRequests\": ").append(st.totalRequests).append(",\n");
            sb.append("      \"averageResponseTime\": ").append(st.totalRequests == 0 ? 0 : st.totalResponseTime / st.totalRequests).append(",\n");
            sb.append("      \"slowRequests\": ").append(st.slowRequests).append(",\n");
            sb.append("      \"errors\": ").append(st.errors).append("\n");
            sb.append("    }");
            if (++count < report.endpointDetails.size()) sb.append(",");
            sb.append("\n");
        }
        sb.append("  }\n}");

        try {
            if (!reportFile.getParentFile().exists()) {
                reportFile.getParentFile().mkdirs();
            }
            try (FileWriter fw = new FileWriter(reportFile)) {
                fw.write(sb.toString());
                System.out.println("Analysis complete. Report generated at: " + reportFile.getAbsolutePath());
            }
        } catch (IOException e) {
            System.err.println("Failed to write report: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
