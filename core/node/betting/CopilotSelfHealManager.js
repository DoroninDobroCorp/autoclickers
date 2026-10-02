/**
 * CopilotSelfHealManager - automated Copilot CLI self-heal loop
 *
 * Triggered once per finalized betting attempt (success or failure).
 * Serializes runs so overlapping Copilot processes never execute concurrently.
 * Persists an attempt bundle with enough context for Copilot to act usefully.
 *
 * Guardrails:
 * - Never crashes the betting process on self-heal failure
 * - Preserves source-chat read-only guarantees (explicit in prompt)
 * - Forbids fixing issues by lowering effective stake to <= 5 EUR
 * - Forbids changing the intended Telegram outcome/market to dodge bookmaker max-stake caps
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_COPILOT_PATH = '/home/ubuntu/.local/bin/copilot';
const DEFAULT_BUNDLES_DIR = 'self_heal_bundles';
const DEFAULT_REPORTS_DIR = 'self_heal_reports';
const LOG_TAIL_LINES = 80;
const DEFAULT_COPILOT_MODEL = 'gpt-5.4';
const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_WATCH_PATHS = ['backend/autobetting'];
// Minimal allowlist: file inspection + patch editing only; no shell, no git,
// no network. Keep this aligned with the current Copilot CLI tool surface used
// by the self-heal default model (gpt-5.4).
const DEFAULT_ALLOWED_TOOLS = [
    'view',
    'apply_patch',
    'glob',
    'rg',
    'report_intent',
];
// Failure steps that are clearly NOT code bugs and must not trigger any
// autonomous self-heal Copilot run. Adding entries here is the primary
// safety knob between business-logic rejections (bookmaker max-stake,
// selection lookup miss, balance issue, etc.) and a code-modification loop.
const NON_CODE_FAILURE_STEPS = new Set([
    'bookmaker_max_stake',
    'max_stake',
    'maksimalna_uplata',
    'selection_not_found',
    'selection_finder_no_match',
    'insufficient_balance',
    'balance_low',
    'telegram_stop',
    'telegram_skip',
    'telegram_expired',
    'session_expired',
    'login_failed',
]);
const NON_CODE_ERROR_PATTERNS = [
    /maksimalna uplata/i,
    /max(?:imal)?\s*stake/i,
    /selection[_\s-]*not[_\s-]*found/i,
    /insufficient balance/i,
    /session expired/i,
    /login failed/i,
];
const DEFAULT_ALLOWED_ENV_KEYS = [
    'HOME',
    'PATH',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
];
const DEFAULT_SECRET_ENV_VARS = [
    'TG_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USERNAME',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'POSTGRES_SSLMODE',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
];
const FORCE_KILL_GRACE_MS = 10 * 1000;
const WATCHED_RUNTIME_EXTENSIONS = new Set(['.js', '.json', '.ts', '.tsx', '.mjs', '.cjs']);

function sanitizeFileToken(value, fallback = 'unknown') {
    const normalized = String(value || fallback)
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    return normalized || fallback;
}

class CopilotSelfHealManager {
    constructor(options = {}) {
        // SAFETY: self-heal MUST default to OFF. Callers (launchers) must
        // explicitly opt in by passing { enabled: true } or via env var.
        this.enabled = options.enabled === true;
        this.copilotPath = options.copilotPath || DEFAULT_COPILOT_PATH;
        this.bundlesDir = options.bundlesDir || path.join(process.cwd(), DEFAULT_BUNDLES_DIR);
        this.reportsDir = options.reportsDir || path.join(path.dirname(this.bundlesDir), DEFAULT_REPORTS_DIR);
        this.repoRoot = options.repoRoot || '/srv/big_value';
        this.logFilePath = options.logFilePath || null;
        this.logger = options.logger || console;
        this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
            ? Number(options.timeoutMs)
            : null;
        this.model = options.model || DEFAULT_COPILOT_MODEL;
        this.reasoningEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT;
        this.extraAllowedDirs = Array.isArray(options.extraAllowedDirs) ? options.extraAllowedDirs : [];
        this.onCodeChange = typeof options.onCodeChange === 'function' ? options.onCodeChange : null;
        // SAFETY: never auto-restart the live runner on code change by default.
        // Restart-on-code-change must be explicitly opted in.
        this.restartOnCodeChange = options.restartOnCodeChange === true;
        this.watchPaths = Array.isArray(options.watchPaths) && options.watchPaths.length > 0
            ? options.watchPaths
            : DEFAULT_WATCH_PATHS;
        this.allowedEnvKeys = Array.isArray(options.allowedEnvKeys) && options.allowedEnvKeys.length > 0
            ? options.allowedEnvKeys
            : DEFAULT_ALLOWED_ENV_KEYS;
        this.secretEnvVars = Array.isArray(options.secretEnvVars) && options.secretEnvVars.length > 0
            ? options.secretEnvVars
            : DEFAULT_SECRET_ENV_VARS;
        this.allowedTools = Array.isArray(options.allowedTools) && options.allowedTools.length > 0
            ? options.allowedTools
            : DEFAULT_ALLOWED_TOOLS;

        // Serialization
        this._queue = [];
        this._running = false;
        this._disposed = false;
        this._activeChild = null;
        this._activeRunPromise = null;

        // Stats
        this.stats = { queued: 0, completed: 0, failed: 0, dropped: 0 };

        if (this.enabled) {
            try {
                fs.mkdirSync(this.bundlesDir, { recursive: true });
                fs.mkdirSync(this.reportsDir, { recursive: true });
            } catch (e) {
                this.logger.error?.(`[SelfHeal] Failed to create bundles dir: ${e.message}`) ||
                    this.logger.log(`[SelfHeal] Failed to create bundles dir: ${e.message}`);
            }
        }
    }

    /**
     * Called after every finalized queued task (success, failure, or cancelled).
     * This is the only public entry point for triggering self-heal.
     */
    onTaskFinalized(bundle) {
        if (!this.enabled || this._disposed) return;

        try {
            const enriched = this._enrichBundle(bundle);
            // Pre-spawn safety guard: never invoke Copilot for failures that
            // are clearly business-logic rejections (bookmaker max-stake,
            // selection lookup miss, balance issue, telegram STOP etc.).
            // These are NOT code bugs and an autonomous "fix" attempt is a
            // pure source of risk.
            if (this._isNonCodeFailure(enriched)) {
                this.stats.dropped++;
                this._log(`⏭ Skipping self-heal for non-code failure (${enriched.taskId} step=${enriched.step || 'n/a'})`);
                return;
            }
            this._queue.push(enriched);
            this.stats.queued++;
            this._log(`📦 Queued self-heal bundle #${this.stats.queued}: ${enriched.taskId || 'unknown'} [${enriched.outcome}]`);
            this._processQueue();
        } catch (e) {
            this._logError(`Failed to enqueue self-heal bundle: ${e.message}`);
        }
    }

    _isNonCodeFailure(bundle = {}) {
        if (bundle.status === 'completed') return false;
        const step = String(bundle.step || bundle.failureStep || '').toLowerCase().trim();
        if (step && NON_CODE_FAILURE_STEPS.has(step)) return true;
        const errorText = String(bundle.error || bundle.message || '').trim();
        if (errorText) {
            for (const pattern of NON_CODE_ERROR_PATTERNS) {
                if (pattern.test(errorText)) return true;
            }
        }
        return false;
    }

    _enrichBundle(bundle) {
        const enriched = {
            timestamp: new Date().toISOString(),
            taskId: bundle.taskId || bundle.task?.id || 'unknown',
            status: bundle.status || 'unknown',
            outcome: bundle.outcome || 'unknown',
            ...bundle,
        };

        // Attach log tail if log file available
        if (this.logFilePath && !enriched.logTail) {
            enriched.logTail = this._getLogTail(this.logFilePath, LOG_TAIL_LINES);
        }

        return enriched;
    }

    _getLogTail(filePath, lines) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const content = fs.readFileSync(filePath, 'utf8');
            const allLines = content.split('\n');
            return allLines.slice(-lines).join('\n');
        } catch (e) {
            return `[error reading log: ${e.message}]`;
        }
    }

    async _processQueue() {
        if (this._running || this._disposed) return;
        if (this._queue.length === 0) return;

        this._running = true;
        while (this._queue.length > 0 && !this._disposed) {
            const bundle = this._queue.shift();
            const runPromise = this._executeSelfHeal(bundle);
            this._activeRunPromise = runPromise;
            try {
                const runResult = await runPromise;
                this.stats.completed++;
                if (
                    this.restartOnCodeChange &&
                    this.onCodeChange &&
                    runResult?.exitCode === 0 &&
                    Array.isArray(runResult.runtimeChangedPaths) &&
                    runResult.runtimeChangedPaths.length > 0
                ) {
                    try {
                        await Promise.resolve(this.onCodeChange({
                            ...runResult,
                            bundle
                        }));
                    } catch (hookError) {
                        this._logError(`Self-heal code-change hook failed for ${bundle.taskId}: ${hookError.message}`);
                    }
                }
            } catch (e) {
                this.stats.failed++;
                this._logError(`Self-heal run failed for ${bundle.taskId}: ${e.message}`);
            } finally {
                if (this._activeRunPromise === runPromise) {
                    this._activeRunPromise = null;
                }
            }
        }
        this._running = false;
    }

    async _executeSelfHeal(bundle) {
        const bundlePath = this._writeBundleFile(bundle);
        const reportPath = this._writeReportStub(bundle, bundlePath);
        const prompt = this._buildPrompt(bundle, bundlePath, reportPath);
        const beforeSnapshot = this.restartOnCodeChange
            ? this._captureWatchedFileSnapshot()
            : null;

        this._log(`🔧 Starting Copilot self-heal for task ${bundle.taskId} (status: ${bundle.status})`);

        try {
            const result = await this._runCopilot(prompt);
            this._log(`✅ Copilot self-heal completed for ${bundle.taskId} (exit: ${result.exitCode})`);
            if (result.exitCode !== 0) {
                this._log(`⚠️ Copilot non-zero exit (${result.exitCode}): ${(result.stderr || '').slice(0, 200)}`);
            }
            const afterSnapshot = beforeSnapshot
                ? this._captureWatchedFileSnapshot()
                : null;
            const changedPaths = beforeSnapshot && afterSnapshot
                ? this._diffWatchedFileSnapshots(beforeSnapshot, afterSnapshot)
                : [];
            const runtimeChangedPaths = changedPaths.filter((filePath) => this._isRuntimeRestartCandidate(filePath));
            if (runtimeChangedPaths.length > 0) {
                this._log(`🔄 Runtime file changes detected: ${runtimeChangedPaths.join(', ')}`);
            }
            return {
                ...result,
                bundlePath,
                reportPath,
                changedPaths,
                runtimeChangedPaths,
                taskId: bundle.taskId,
            };
        } catch (e) {
            this._logError(`Copilot process error for ${bundle.taskId}: ${e.message}`);
            throw e;
        }
    }

    _writeBundleFile(bundle) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safeTaskId = sanitizeFileToken(bundle.taskId, 'unknown');
        const fileName = `bundle_${safeTaskId}_${ts}.json`;
        const bundlesDirPath = path.resolve(this.bundlesDir);
        const filePath = path.resolve(bundlesDirPath, fileName);
        if (!filePath.startsWith(`${bundlesDirPath}${path.sep}`)) {
            throw new Error(`Resolved bundle path escaped bundlesDir: ${filePath}`);
        }

        try {
            fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
        } catch (e) {
            this._logError(`Failed to write bundle file: ${e.message}`);
            throw e;
        }

        return filePath;
    }

    _getOutcomeSummary(bundle = {}) {
        const originalOutcome = bundle.originalOutcome || bundle.outcome || null;
        const currentOutcome = bundle.currentOutcome || bundle.outcome || null;
        return {
            originalOutcome,
            currentOutcome,
            lastAttemptedOutcome: currentOutcome && currentOutcome !== originalOutcome
                ? currentOutcome
                : null
        };
    }

    _writeReportStub(bundle, bundlePath) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safeTaskId = sanitizeFileToken(bundle.taskId, 'unknown');
        const fileName = `report_${safeTaskId}_${ts}.md`;
        const reportsDirPath = path.resolve(this.reportsDir);
        const filePath = path.resolve(reportsDirPath, fileName);
        if (!filePath.startsWith(`${reportsDirPath}${path.sep}`)) {
            throw new Error(`Resolved report path escaped reportsDir: ${filePath}`);
        }

        const { originalOutcome, lastAttemptedOutcome } = this._getOutcomeSummary(bundle);
        const summary = [
            `# Self-heal report`,
            '',
            `- Attempt timestamp: ${bundle.timestamp || new Date().toISOString()}`,
            `- Task ID: ${bundle.taskId || 'unknown'}`,
            `- Status: ${bundle.status || 'unknown'}`,
            bundle.home && bundle.away ? `- Match: ${bundle.home} vs ${bundle.away}` : null,
            originalOutcome ? `- Outcome: ${originalOutcome}` : null,
            lastAttemptedOutcome ? `- Last attempted outcome: ${lastAttemptedOutcome}` : null,
            bundle.stake ? `- Stake: ${bundle.stake} EUR` : null,
            bundle.error ? `- Error: ${bundle.error}` : null,
            bundle.step ? `- Step: ${bundle.step}` : null,
            `- Bundle: \`${bundlePath}\``,
            '',
            `## Copilot findings`,
            '',
            `_Pending Copilot analysis._`,
            '',
            `## Files changed`,
            '',
            `_Pending Copilot analysis._`,
            '',
            `## Validation`,
            '',
            `_Pending Copilot analysis._`,
            '',
            `## Next steps`,
            '',
            `_Pending Copilot analysis._`,
            ''
        ].filter(Boolean).join('\n');

        try {
            fs.writeFileSync(filePath, summary, 'utf8');
        } catch (e) {
            this._logError(`Failed to write report stub: ${e.message}`);
            throw e;
        }

        return filePath;
    }

    _buildPrompt(bundle, bundlePath, reportPath) {
        const statusEmoji = bundle.status === 'completed' ? '✅' : '❌';
        const { originalOutcome, lastAttemptedOutcome } = this._getOutcomeSummary(bundle);
        const taskSummary = [
            `Status: ${statusEmoji} ${bundle.status}`,
            `Task ID: ${bundle.taskId}`,
            bundle.home && bundle.away ? `Match: ${bundle.home} vs ${bundle.away}` : null,
            originalOutcome ? `Outcome: ${originalOutcome}` : null,
            lastAttemptedOutcome ? `Last attempted outcome: ${lastAttemptedOutcome}` : null,
            bundle.stake ? `Stake: ${bundle.stake} EUR` : null,
            bundle.error ? `Error: ${bundle.error}` : null,
            bundle.step ? `Failed at step: ${bundle.step}` : null,
            bundle.source ? `Source: ${bundle.source}` : null,
        ].filter(Boolean).join('\n');

        return `You are a self-heal agent for an automated betting system.

ATTEMPT BUNDLE (full JSON at: ${bundlePath}):
${taskSummary}

REPORT FILE FOR THIS EXACT ATTEMPT:
${reportPath}

YOUR TASK:
1. Read the attempt bundle at ${bundlePath} to understand exactly what happened.
2. Investigate the root cause in the repository at ${this.repoRoot}.
3. If you identify a genuine bug or fixable issue, implement a safe, minimal fix.
4. Run targeted validation (relevant tests or a quick syntax check) for any changes you make.
5. If the attempt succeeded, review for any latent issues or improvements in the code path that executed.
6. Update the markdown report at ${reportPath}. This attempt must have exactly one report file, and this is it.
7. Even if you make no code changes, still write the report with diagnosis, rationale, and what you checked.

STRICT RULES — VIOLATIONS ARE FORBIDDEN:
- Do NOT lower the effective stake to <= 5 EUR as a fix. The system must not "solve" failures by reducing stake below a viable threshold.
- Do NOT change the intended Telegram bet outcome/market or silently switch to another ladder/alternative candidate to bypass a bookmaker max-stake rejection.
- Do NOT modify any source-chat integration to send messages or write to source chats. Source chats are READ-ONLY. Preserve all sourceReadOnly guarantees.
- Do NOT touch unrelated code. Only fix issues directly related to this attempt's code path.
- Do NOT revert or modify existing test files unless you are fixing a test that tests the code you changed.
- Do NOT modify configuration credentials or authentication logic unless the bundle explicitly shows an auth-related root cause.
- Do NOT create any additional markdown report files. Use only ${reportPath}.
- If no fix is justified, do nothing. Not every failure needs a code change.

Focus on the files under backend/autobetting/ in ${this.repoRoot}.`;
    }

    _buildCopilotArgs(prompt) {
        const allowedDirs = new Set([
            this.bundlesDir,
            this.reportsDir,
            ...this.extraAllowedDirs.filter(Boolean)
        ]);
        const args = [
            '-p',
            prompt,
            '--no-ask-user',
            '--model',
            this.model,
            '--reasoning-effort',
            this.reasoningEffort,
            '--silent',
            '--secret-env-vars',
            this.secretEnvVars.join(','),
        ];

        // Explicit minimal tool allowlist — NO shell, NO git, NO network tools.
        // Self-heal must only be able to inspect and edit files.
        for (const tool of this.allowedTools) {
            args.push('--allow-tool', tool);
        }

        // Always grant the repo path read/write via --add-dir; cwd is set to
        // bundlesDir (writable scratch) so an accidental `cwd`-relative write
        // lands in the bundles directory, not the repo root.
        const repoRootPath = path.resolve(this.repoRoot);
        if (!allowedDirs.has(repoRootPath)) {
            allowedDirs.add(repoRootPath);
        }

        for (const dir of allowedDirs) {
            args.push('--add-dir', dir);
        }

        return args;
    }

    _buildCopilotEnv() {
        const env = {};
        for (const key of this.allowedEnvKeys) {
            if (process.env[key] !== undefined) {
                env[key] = process.env[key];
            }
        }
        return env;
    }

    _captureWatchedFileSnapshot() {
        const snapshot = new Map();
        const repoRootPath = path.resolve(this.repoRoot);
        const collect = (entryPath) => {
            if (!fs.existsSync(entryPath)) {
                return;
            }
            const stat = fs.statSync(entryPath);
            if (stat.isDirectory()) {
                for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
                    if (entry.name === '.git' || entry.name === 'node_modules') {
                        continue;
                    }
                    collect(path.join(entryPath, entry.name));
                }
                return;
            }

            if (!stat.isFile() || !this._shouldWatchFile(entryPath)) {
                return;
            }

            const relativePath = path.relative(repoRootPath, entryPath).replace(/\\/g, '/');
            snapshot.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
        };

        for (const watchPath of this.watchPaths) {
            const absoluteWatchPath = path.resolve(repoRootPath, watchPath);
            if (absoluteWatchPath !== repoRootPath && !absoluteWatchPath.startsWith(`${repoRootPath}${path.sep}`)) {
                continue;
            }
            collect(absoluteWatchPath);
        }

        return snapshot;
    }

    _shouldWatchFile(filePath) {
        return WATCHED_RUNTIME_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    _diffWatchedFileSnapshots(beforeSnapshot, afterSnapshot) {
        const changedPaths = [];
        const allPaths = new Set([
            ...beforeSnapshot.keys(),
            ...afterSnapshot.keys()
        ]);
        for (const filePath of allPaths) {
            if (beforeSnapshot.get(filePath) !== afterSnapshot.get(filePath)) {
                changedPaths.push(filePath);
            }
        }
        return changedPaths.sort();
    }

    _isRuntimeRestartCandidate(filePath = '') {
        const normalized = String(filePath || '').replace(/\\/g, '/');
        if (!normalized) {
            return false;
        }
        if (normalized.includes('/__tests__/') || normalized.endsWith('.test.js') || normalized.endsWith('.spec.js')) {
            return false;
        }
        return true;
    }

    _runCopilot(prompt) {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let forceKillTimer = null;
            const child = spawn(this.copilotPath, this._buildCopilotArgs(prompt), {
                // SAFETY: cwd is the (writable scratch) bundles dir, not the
                // repo root. The repo is exposed read/write via --add-dir
                // instead so any accidental cwd-relative write lands in the
                // sandbox bundlesDir rather than /srv/big_value.
                cwd: this.bundlesDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: this._buildCopilotEnv(),
            });
            this._activeChild = child;

            const scheduleForceKill = () => {
                if (forceKillTimer) {
                    return;
                }
                forceKillTimer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    } catch (e) {}
                }, FORCE_KILL_GRACE_MS);
            };

            const timer = this.timeoutMs
                ? setTimeout(() => {
                    timedOut = true;
                    try {
                        child.kill('SIGTERM');
                    } catch (e) {}
                    scheduleForceKill();
                }, this.timeoutMs)
                : null;

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code, signal) => {
                if (timer) {
                    clearTimeout(timer);
                }
                if (forceKillTimer) {
                    clearTimeout(forceKillTimer);
                    forceKillTimer = null;
                }
                if (this._activeChild === child) {
                    this._activeChild = null;
                }
                if (timedOut) {
                    reject(new Error(`Copilot process timed out after ${this.timeoutMs}ms`));
                } else if (child._selfHealKilledByDispose === true) {
                    reject(new Error('Copilot process interrupted during self-heal shutdown'));
                } else {
                    resolve({ exitCode: code, signal, stdout, stderr });
                }
            });

            child.on('error', (err) => {
                if (timer) {
                    clearTimeout(timer);
                }
                if (forceKillTimer) {
                    clearTimeout(forceKillTimer);
                    forceKillTimer = null;
                }
                if (this._activeChild === child) {
                    this._activeChild = null;
                }
                reject(err);
            });

            // Close stdin so copilot doesn't wait for input
            child.stdin.end();
        });
    }

    _log(msg) {
        const prefixed = `[SelfHeal] ${msg}`;
        if (typeof this.logger.log === 'function') {
            this.logger.log(prefixed);
        } else {
            console.log(prefixed);
        }
    }

    _logError(msg) {
        const prefixed = `[SelfHeal] ${msg}`;
        if (typeof this.logger.error === 'function') {
            this.logger.error(prefixed);
        } else {
            console.error(prefixed);
        }
    }

    async dispose() {
        this._disposed = true;
        this._queue.length = 0;
        let forceKillTimer = null;
        if (this._activeChild && !this._activeChild.killed) {
            this._activeChild._selfHealKilledByDispose = true;
            this._activeChild.kill('SIGTERM');
            forceKillTimer = setTimeout(() => {
                try {
                    this._activeChild?.kill('SIGKILL');
                } catch (e) {}
            }, FORCE_KILL_GRACE_MS);
        }
        if (this._activeRunPromise) {
            try {
                await this._activeRunPromise;
            } catch (e) {}
        }
        if (forceKillTimer) {
            clearTimeout(forceKillTimer);
        }
    }

    async waitForIdle(timeoutMs = null) {
        const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Number(timeoutMs)
            : (this.timeoutMs ? this.timeoutMs + FORCE_KILL_GRACE_MS : null);
        const deadline = effectiveTimeoutMs ? Date.now() + effectiveTimeoutMs : null;
        while (this._running || this._queue.length > 0 || this._activeRunPromise) {
            if (deadline && Date.now() > deadline) {
                throw new Error(`Self-heal manager did not go idle within ${effectiveTimeoutMs}ms`);
            }

            if (this._activeRunPromise) {
                try {
                    await this._activeRunPromise;
                } catch (e) {}
                continue;
            }

            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this._queue.length,
            running: this._running,
        };
    }
}

module.exports = { CopilotSelfHealManager };
