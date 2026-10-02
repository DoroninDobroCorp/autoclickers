/**
 * Debug Collector for Autobetting
 * Collects errors and sends to AI for analysis
 * 
 * Outcome types (for grouping):
 * - T> (Total Over) - all lines grouped together
 * - T< (Total Under)
 * - P1T> (Period 1 Total Over)
 * - P1T< (Period 1 Total Under)
 * - IT1> (Individual Total 1 Over)
 * - IT1< (Individual Total 1 Under)
 * - IT2> (Individual Total 2 Over)
 * - IT2< (Individual Total 2 Under)
 * - H1 (Handicap 1)
 * - H2 (Handicap 2)
 * - 1X2 (Match result)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REDACTED = '[REDACTED]';

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sanitizeFileComponent(value) {
    return String(value || 'unknown')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function isSecretKey(key) {
    return /pass|token|cookie|authorization|secret|api[_-]?key|serviceaccount/i.test(String(key || ''));
}

function cloneForJson(value, options = {}, depth = 0) {
    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 6;
    const maxStringLength = Number.isFinite(options.maxStringLength) ? options.maxStringLength : 20000;

    if (value === null || value === undefined) {
        return value;
    }
    if (depth > maxDepth) {
        return '[MaxDepth]';
    }
    if (typeof value === 'string') {
        if (value.length <= maxStringLength) {
            return value;
        }
        return `${value.slice(0, maxStringLength)}\n...[truncated ${value.length - maxStringLength} chars]`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return `<Buffer ${value.length} bytes>`;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => cloneForJson(entry, options, depth + 1));
    }
    if (typeof value === 'object') {
        const output = {};
        for (const [key, entry] of Object.entries(value)) {
            if (isSecretKey(key)) {
                output[key] = REDACTED;
                continue;
            }
            output[key] = cloneForJson(entry, options, depth + 1);
        }
        return output;
    }

    return String(value);
}

function stringifyArtifact(content, options = {}) {
    if (content === null || content === undefined) {
        return '';
    }
    if (typeof content === 'string') {
        return content;
    }
    return JSON.stringify(cloneForJson(content, options), null, 2);
}

class DebugCollector {
    constructor(bookmaker, config = {}) {
        this.bookmaker = bookmaker;
        this.config = {
            maxRequestsPerType: config.maxRequestsPerType || 3,
            runDurationMs: config.runDurationMs || 10 * 60 * 1000, // 10 minutes
            logDir: config.logDir || '/srv/big_value/logs/debug',
            attemptsDir: config.attemptsDir || path.join(config.logDir || '/srv/big_value/logs/debug', 'attempts'),
            enabled: config.enabled !== false,
            retainDays: config.retainDays || 14,
            maxArtifactBytes: config.maxArtifactBytes || 2 * 1024 * 1024,
            maxInlineStringLength: config.maxInlineStringLength || 20000,
            maxEventsPerAttempt: config.maxEventsPerAttempt || 500,
            ...config
        };
        
        this.errorBuffer = [];
        this.typeRequestCounts = {}; // Track requests per outcome type
        this.startTime = Date.now();
        this.isActive = true;
        this.analyzer = null;
        this.logger = config.logger || console;
        this.attempts = new Map();
        
        // Create log directory
        ensureDir(this.config.logDir);
        ensureDir(this.config.attemptsDir);
        this._pruneAttemptDirectories();
        
        // Schedule shutdown
        if (this.config.runDurationMs > 0) {
            setTimeout(() => this.shutdown(), this.config.runDurationMs);
            this.logger.log(`🔬 DebugCollector started for ${this.bookmaker}, will run for ${this.config.runDurationMs / 1000}s`);
        }
    }

    _pruneAttemptDirectories() {
        if (!Number.isFinite(this.config.retainDays) || this.config.retainDays <= 0) {
            return;
        }

        const cutoffTs = Date.now() - (this.config.retainDays * 24 * 60 * 60 * 1000);
        let dayEntries = [];
        try {
            dayEntries = fs.readdirSync(this.config.attemptsDir, { withFileTypes: true });
        } catch (_error) {
            return;
        }

        for (const entry of dayEntries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(this.config.attemptsDir, entry.name);
            const stats = fs.statSync(dirPath);
            if (stats.mtimeMs >= cutoffTs) continue;
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            } catch (_error) {
                // Best effort cleanup only.
            }
        }
    }

    _getSanitizeOptions() {
        return {
            maxStringLength: this.config.maxInlineStringLength,
            maxDepth: 8
        };
    }

    _writeAttemptBundle(attempt) {
        const bundlePath = path.join(attempt.attemptDir, 'bundle.json');
        fs.writeFileSync(bundlePath, JSON.stringify(attempt.bundle, null, 2));
    }

    _appendAttemptEvent(attempt, event) {
        const eventsPath = path.join(attempt.attemptDir, 'events.jsonl');
        fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    }

    _getAttempt(attemptId) {
        if (!attemptId) {
            return null;
        }
        return this.attempts.get(String(attemptId)) || null;
    }

    startAttempt(task = {}, meta = {}) {
        if (!this.isActive || !this.config.enabled) {
            return null;
        }

        const day = new Date().toISOString().slice(0, 10);
        const taskId = sanitizeFileComponent(task.id || `${task.home || 'home'}_vs_${task.away || 'away'}`);
        const attemptId = `${Date.now()}_${taskId}_${crypto.randomBytes(3).toString('hex')}`;
        const attemptDir = path.join(this.config.attemptsDir, day, attemptId);
        ensureDir(attemptDir);

        const bundle = {
            attemptId,
            bookmaker: this.bookmaker,
            createdAt: new Date().toISOString(),
            status: 'running',
            meta: cloneForJson(meta, this._getSanitizeOptions()),
            task: cloneForJson(task, this._getSanitizeOptions()),
            result: null,
            artifacts: [],
            events: []
        };

        const attempt = {
            attemptId,
            attemptDir,
            bundle,
            createdAt: Date.now(),
            droppedEvents: 0
        };

        this.attempts.set(attemptId, attempt);
        this._writeAttemptBundle(attempt);
        this.captureAttempt(attemptId, 'attempt_started', {
            taskId: task.id || null,
            home: task.home || null,
            away: task.away || null,
            outcome: task.outcome || null
        });
        return attemptId;
    }

    captureAttempt(attemptId, eventType, payload = {}) {
        const attempt = this._getAttempt(attemptId);
        if (!attempt || !this.isActive || !this.config.enabled) {
            return null;
        }

        const event = {
            ts: new Date().toISOString(),
            eventType,
            payload: cloneForJson(payload, this._getSanitizeOptions())
        };

        this._appendAttemptEvent(attempt, event);
        if (attempt.bundle.events.length < this.config.maxEventsPerAttempt) {
            attempt.bundle.events.push(event);
        } else {
            attempt.droppedEvents += 1;
            attempt.bundle.droppedEvents = attempt.droppedEvents;
        }
        attempt.bundle.lastEventAt = event.ts;
        attempt.bundle.lastEventType = eventType;
        this._writeAttemptBundle(attempt);
        return event;
    }

    writeAttemptArtifact(attemptId, name, content, options = {}) {
        const attempt = this._getAttempt(attemptId);
        if (!attempt || !this.isActive || !this.config.enabled) {
            return null;
        }

        const artifactDir = path.join(attempt.attemptDir, 'artifacts');
        ensureDir(artifactDir);

        const baseName = sanitizeFileComponent(name || 'artifact');
        const extension = sanitizeFileComponent(options.extension || (typeof content === 'string' ? 'txt' : 'json'));
        const fileName = `${Date.now()}_${baseName}.${extension}`;
        const filePath = path.join(artifactDir, fileName);

        let serialized = stringifyArtifact(content, this._getSanitizeOptions());
        let truncated = false;
        const maxArtifactBytes = Math.max(1024, Number(this.config.maxArtifactBytes) || (2 * 1024 * 1024));
        if (Buffer.byteLength(serialized, 'utf8') > maxArtifactBytes) {
            truncated = true;
            serialized = `${serialized.slice(0, maxArtifactBytes)}\n...[truncated artifact]`;
        }

        fs.writeFileSync(filePath, serialized, 'utf8');

        const artifactMeta = {
            ts: new Date().toISOString(),
            name,
            kind: options.kind || extension,
            fileName,
            relativePath: path.relative(attempt.attemptDir, filePath),
            bytes: Buffer.byteLength(serialized, 'utf8'),
            truncated
        };
        attempt.bundle.artifacts.push(artifactMeta);
        this._writeAttemptBundle(attempt);
        return artifactMeta;
    }

    finishAttempt(attemptId, status, result = {}) {
        const attempt = this._getAttempt(attemptId);
        if (!attempt) {
            return null;
        }

        const finishedAt = new Date().toISOString();
        this.captureAttempt(attemptId, 'attempt_finished', result);
        attempt.bundle.status = status || 'finished';
        attempt.bundle.finishedAt = finishedAt;
        attempt.bundle.durationMs = Date.now() - attempt.createdAt;
        attempt.bundle.result = cloneForJson(result, this._getSanitizeOptions());
        this._writeAttemptBundle(attempt);
        this.attempts.delete(attemptId);
        return attempt.bundle;
    }
    
    setAnalyzer(analyzer) {
        this.analyzer = analyzer;
    }
    
    /**
     * Extract outcome type from outcome string (ignoring line values)
     * Examples:
     * - "T> 181.5" -> "T>"
     * - "T< 2.5" -> "T<"
     * - "P1 T> 0.5" -> "P1T>"
     * - "IT1> 0.5" -> "IT1>"
     * - "H1(-1.5)" -> "H1"
     * - "1" -> "1X2"
     */
    getOutcomeType(outcomeStr) {
        const s = outcomeStr.trim();
        
        // Period totals: P1 T>, P2 T<, etc
        if (/^P\d\s*T[><]/i.test(s)) {
            const match = s.match(/^P(\d)\s*T([><])/i);
            return `P${match[1]}T${match[2]}`;
        }
        
        // Individual totals: IT1>, IT2<, etc
        if (/^IT[12][><]/i.test(s)) {
            const match = s.match(/^IT([12])([><])/i);
            return `IT${match[1]}${match[2]}`;
        }
        
        // Period individual totals: P1 IT1>, etc
        if (/^P\d\s*IT[12][><]/i.test(s)) {
            const match = s.match(/^P(\d)\s*IT([12])([><])/i);
            return `P${match[1]}IT${match[2]}${match[3]}`;
        }
        
        // General totals: T>, T<
        if (/^T[><]/i.test(s)) {
            const match = s.match(/^T([><])/i);
            return `T${match[1]}`;
        }
        
        // Handicap: H1, H2, or "1 (-1.5)", "2 (+0.5)"
        if (/^H[12]/i.test(s) || /^[12]\s*\([+-]?\d/i.test(s)) {
            const match = s.match(/^H?([12])/i);
            return `H${match[1]}`;
        }
        
        // 1X2
        if (/^[1X2]$/i.test(s)) {
            return '1X2';
        }
        
        // Period 1X2: P1 1, P2 X
        if (/^P\d\s*[1X2]$/i.test(s)) {
            return 'P_1X2';
        }
        
        return 'OTHER';
    }
    
    /**
     * Check if we should analyze this error type
     */
    shouldAnalyze(outcomeType) {
        if (!this.isActive || !this.config.enabled) return false;
        
        const count = this.typeRequestCounts[outcomeType] || 0;
        return count < this.config.maxRequestsPerType;
    }
    
    /**
     * Capture an error for potential AI analysis
     */
    async capture(errorType, context) {
        if (!this.isActive || !this.config.enabled) return;
        
        const outcomeType = this.getOutcomeType(context.outcome || '');
        if (context?.debugAttemptId) {
            this.captureAttempt(context.debugAttemptId, `collector_${errorType}`, context);
        }
        
        // Log to JSONL file always
        this.logToFile(errorType, outcomeType, context);
        
        // Check if we should send to AI
        if (!this.shouldAnalyze(outcomeType)) {
            if ((this.typeRequestCounts[outcomeType] || 0) === this.config.maxRequestsPerType) {
                this.logger.log(`🔬 [DEBUG] Skipping ${outcomeType} - already sent ${this.config.maxRequestsPerType} requests`);
            }
            return;
        }
        
        // Increment counter
        this.typeRequestCounts[outcomeType] = (this.typeRequestCounts[outcomeType] || 0) + 1;
        
        // Send to AI analyzer
        if (this.analyzer) {
            try {
                this.logger.log(`🔬 [DEBUG] Sending ${outcomeType} error to AI (${this.typeRequestCounts[outcomeType]}/${this.config.maxRequestsPerType})`);
                await this.analyzer.analyze({
                    bookmaker: this.bookmaker,
                    errorType,
                    outcomeType,
                    context,
                    timestamp: Date.now()
                });
            } catch (err) {
                this.logger.log(`🔬 [DEBUG] AI analysis failed: ${err.message}`);
            }
        }
    }
    
    /**
     * Log error to JSONL file
     */
    logToFile(errorType, outcomeType, context) {
        const entry = {
            ts: Date.now(),
            bookmaker: this.bookmaker,
            errorType,
            outcomeType,
            outcome: context.outcome,
            expectedOdds: context.expectedOdds,
            foundOdds: context.foundOdds,
            match: context.match,
            availableMarkets: context.availableMarkets?.slice(0, 20),
            debugAttemptId: context.debugAttemptId || null
        };
        
        const logFile = path.join(this.config.logDir, `${this.bookmaker}_errors.jsonl`);
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    }
    
    /**
     * Shutdown the collector
     */
    shutdown() {
        if (!this.isActive) return;
        
        this.isActive = false;
        const duration = (Date.now() - this.startTime) / 1000;
        
        this.logger.log(`🔬 [DEBUG] DebugCollector shutting down after ${duration.toFixed(1)}s`);
        this.logger.log(`🔬 [DEBUG] Requests by type: ${JSON.stringify(this.typeRequestCounts)}`);
        
        // Save summary
        const summaryFile = path.join(this.config.logDir, `${this.bookmaker}_summary.json`);
        fs.writeFileSync(summaryFile, JSON.stringify({
            bookmaker: this.bookmaker,
            startTime: this.startTime,
            endTime: Date.now(),
            durationSeconds: duration,
            requestsByType: this.typeRequestCounts
        }, null, 2));
    }
    
    isRunning() {
        return this.isActive;
    }
}

module.exports = { DebugCollector };
