/**
 * Tests for CopilotSelfHealManager
 *
 * Covers: initialization, bundle building, queue serialization,
 * prompt guardrails, error resilience, and dispose behavior.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { CopilotSelfHealManager } = require('../betting/CopilotSelfHealManager.js');

describe('CopilotSelfHealManager', () => {
    let tempDir;
    let bundlesDir;
    let reportsDir;
    let logFilePath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-test-'));
        bundlesDir = path.join(tempDir, 'bundles');
        reportsDir = path.join(tempDir, 'reports');
        logFilePath = path.join(tempDir, 'test.log');
        fs.writeFileSync(logFilePath, 'line1\nline2\nline3\nline4\nline5\n');
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    function createManager(overrides = {}) {
        return new CopilotSelfHealManager({
            enabled: true,
            copilotPath: '/usr/bin/echo',
            bundlesDir,
            reportsDir,
            repoRoot: tempDir,
            logFilePath,
            logger: { log: jest.fn(), error: jest.fn() },
            timeoutMs: 5000,
            ...overrides,
        });
    }

    describe('constructor', () => {
        test('creates bundles directory when enabled', () => {
            const mgr = createManager();
            expect(fs.existsSync(bundlesDir)).toBe(true);
            expect(fs.existsSync(reportsDir)).toBe(true);
            expect(mgr.enabled).toBe(true);
        });

        test('does not create bundles dir when disabled', () => {
            const mgr = createManager({ enabled: false });
            expect(fs.existsSync(bundlesDir)).toBe(false);
            expect(mgr.enabled).toBe(false);
        });

        test('starts with zero stats', () => {
            const mgr = createManager();
            expect(mgr.getStats()).toEqual({
                queued: 0,
                completed: 0,
                failed: 0,
                dropped: 0,
                queueLength: 0,
                running: false,
            });
        });

        test('supports disabled timeout for long-running self-heal sessions', () => {
            const mgr = createManager({ timeoutMs: null });
            expect(mgr.timeoutMs).toBeNull();
        });
    });

    describe('onTaskFinalized', () => {
        test('does nothing when disabled', () => {
            const mgr = createManager({ enabled: false });
            mgr.onTaskFinalized({ taskId: 't1', status: 'failed', outcome: '1X' });
            expect(mgr.stats.queued).toBe(0);
        });

        test('enqueues bundle when enabled', () => {
            const mgr = createManager();
            // Stub _processQueue to avoid spawning
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({ taskId: 't1', status: 'completed', outcome: 'Over 2.5' });
            expect(mgr.stats.queued).toBe(1);
            expect(mgr._processQueue).toHaveBeenCalledTimes(1);
        });

        test('enriches bundle with log tail', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({ taskId: 't2', status: 'failed', outcome: '2' });
            const bundle = mgr._queue[0];
            expect(bundle.logTail).toContain('line5');
            expect(bundle.timestamp).toBeDefined();
        });

        test('handles missing log file gracefully', () => {
            const mgr = createManager({ logFilePath: '/nonexistent/path.log' });
            mgr._processQueue = jest.fn();
            expect(() => {
                mgr.onTaskFinalized({ taskId: 't3', status: 'failed', outcome: '1' });
            }).not.toThrow();
            expect(mgr._queue[0].logTail).toBeNull();
        });

        test('does nothing after dispose', () => {
            const mgr = createManager();
            mgr.dispose();
            mgr.onTaskFinalized({ taskId: 't4', status: 'failed', outcome: '2' });
            expect(mgr.stats.queued).toBe(0);
        });

        test('skips non-code failure: bookmaker_max_stake step', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({
                taskId: 'tmaxstake',
                status: 'failed',
                outcome: '1',
                step: 'bookmaker_max_stake',
                error: 'Maksimalna uplata za ovaj tiket je: 5,00 EUR'
            });
            expect(mgr.stats.queued).toBe(0);
            expect(mgr.stats.dropped).toBe(1);
            expect(mgr._processQueue).not.toHaveBeenCalled();
        });

        test('skips non-code failure when error matches Maksimalna uplata regex', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({
                taskId: 'tmaxstake2',
                status: 'failed',
                outcome: '1',
                step: 'place_bet',
                error: 'Maksimalna uplata za ovaj tiket je: 5,00 EUR'
            });
            expect(mgr.stats.queued).toBe(0);
            expect(mgr.stats.dropped).toBe(1);
        });

        test('skips selection_not_found failures', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({
                taskId: 'tsel',
                status: 'failed',
                outcome: 'T> 1.5',
                step: 'selection_not_found'
            });
            expect(mgr.stats.queued).toBe(0);
            expect(mgr.stats.dropped).toBe(1);
        });

        test('still enqueues genuine failures (no business-logic step)', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({
                taskId: 'tbug',
                status: 'failed',
                outcome: '1',
                step: 'unexpected_state',
                error: 'TypeError: cannot read properties of undefined'
            });
            expect(mgr.stats.queued).toBe(1);
        });

        test('disabled manager does not spawn even on bookmaker_max_stake', () => {
            const mgr = createManager({ enabled: false });
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({
                taskId: 't',
                status: 'failed',
                outcome: '1',
                step: 'bookmaker_max_stake'
            });
            expect(mgr.stats.queued).toBe(0);
            expect(mgr._processQueue).not.toHaveBeenCalled();
        });
    });

    describe('safety defaults (F1)', () => {
        test('default constructor is disabled', () => {
            const mgr = new CopilotSelfHealManager();
            expect(mgr.enabled).toBe(false);
        });

        test('restartOnCodeChange defaults to false', () => {
            const mgr = createManager();
            expect(mgr.restartOnCodeChange).toBe(false);
        });

        test('restartOnCodeChange true requires explicit opt-in', () => {
            expect(createManager({ restartOnCodeChange: true }).restartOnCodeChange).toBe(true);
            expect(createManager({ restartOnCodeChange: false }).restartOnCodeChange).toBe(false);
            expect(createManager({}).restartOnCodeChange).toBe(false);
        });

        test('_buildCopilotArgs does NOT include --allow-all-tools', () => {
            const mgr = createManager();
            const args = mgr._buildCopilotArgs('test prompt');
            expect(args).not.toContain('--allow-all-tools');
        });

        test('_buildCopilotArgs uses explicit current-tool --allow-tool entries (no shell, no git)', () => {
            const mgr = createManager();
            const args = mgr._buildCopilotArgs('test prompt');
            // Must contain at least one --allow-tool
            expect(args.filter((a) => a === '--allow-tool').length).toBeGreaterThan(0);
            const toolNames = args
                .map((a, i) => (args[i - 1] === '--allow-tool' ? a : null))
                .filter(Boolean)
                .map((s) => s.toLowerCase());
            expect(toolNames).toEqual(expect.arrayContaining([
                'view',
                'apply_patch',
                'glob',
                'rg',
                'report_intent',
            ]));
            for (const legacy of ['edit', 'create', 'grep']) {
                expect(toolNames).not.toContain(legacy);
            }
            // Must NOT include shell or git in tool allowlist
            for (const forbidden of ['shell', 'bash', 'git', 'web_fetch', 'web_search']) {
                expect(toolNames).not.toContain(forbidden);
            }
        });

        test('_buildCopilotArgs adds repo root via --add-dir', () => {
            const mgr = createManager();
            const args = mgr._buildCopilotArgs('test prompt');
            const addDirIndices = args
                .map((a, i) => (a === '--add-dir' ? i : -1))
                .filter((i) => i !== -1);
            const dirs = addDirIndices.map((i) => args[i + 1]);
            expect(dirs).toContain(path.resolve(tempDir));
        });
    });

    describe('_buildPrompt', () => {
        test('includes stake guardrail in prompt', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt(
                { taskId: 't1', status: 'failed', outcome: '1', stake: 10, error: 'timeout' },
                '/fake/bundle.json',
                '/fake/report.md'
            );
            expect(prompt).toContain('Do NOT lower the effective stake to <= 5 EUR');
        });

        test('includes source-chat read-only guardrail', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt(
                { taskId: 't2', status: 'completed', outcome: 'Over 2.5' },
                '/fake/bundle.json',
                '/fake/report.md'
            );
            expect(prompt).toContain('READ-ONLY');
            expect(prompt).toContain('sourceReadOnly');
        });

        test('includes bundle file path in prompt', () => {
            const mgr = createManager();
            const bundlePath = '/some/path/bundle_t1.json';
            const prompt = mgr._buildPrompt({ taskId: 't1', status: 'failed' }, bundlePath, '/some/path/report_t1.md');
            expect(prompt).toContain(bundlePath);
        });

        test('includes task summary details', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt({
                taskId: 'task-123',
                status: 'failed',
                home: 'Real Madrid',
                away: 'Barcelona',
                outcome: '1X',
                stake: 10,
                error: 'odds mismatch',
                step: 'find_outcome',
                source: 'telegram',
            }, '/fake/bundle.json', '/fake/report.md');
            expect(prompt).toContain('Real Madrid');
            expect(prompt).toContain('Barcelona');
            expect(prompt).toContain('odds mismatch');
            expect(prompt).toContain('telegram');
        });

        test('uses original outcome in prompt and shows last attempted outcome when task switched', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt({
                taskId: 'task-switched',
                status: 'failed',
                home: 'Chapecoense',
                away: 'Avai',
                outcome: '2',
                originalOutcome: '1',
                currentOutcome: '2',
                step: 'singles_blocked',
                source: 'telegram',
            }, '/fake/bundle.json', '/fake/report.md');
            expect(prompt).toContain('Outcome: 1');
            expect(prompt).toContain('Last attempted outcome: 2');
        });

        test('handles successful tasks', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt(
                { taskId: 't5', status: 'completed', outcome: '2' },
                '/fake/bundle.json',
                '/fake/report.md'
            );
            expect(prompt).toContain('✅');
            expect(prompt).toContain('succeeded');
        });

        test('requires writing exactly one markdown report for the attempt', () => {
            const mgr = createManager();
            const prompt = mgr._buildPrompt({ taskId: 't6', status: 'failed' }, '/fake/b.json', '/fake/report.md');
            expect(prompt).toContain('Update the markdown report at /fake/report.md');
            expect(prompt).toContain('Do NOT create any additional markdown report files');
            expect(prompt).toContain('Even if you make no code changes, still write the report');
        });
    });

    describe('_writeBundleFile', () => {
        test('writes valid JSON bundle file', () => {
            const mgr = createManager();
            const bundle = { taskId: 'b1', status: 'failed', outcome: '1', error: 'test error' };
            const filePath = mgr._writeBundleFile(bundle);
            expect(fs.existsSync(filePath)).toBe(true);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(content.taskId).toBe('b1');
            expect(content.error).toBe('test error');
        });

        test('creates unique filenames per call', () => {
            const mgr = createManager();
            const path1 = mgr._writeBundleFile({ taskId: 'x1' });
            const path2 = mgr._writeBundleFile({ taskId: 'x2' });
            expect(path1).not.toBe(path2);
        });

        test('sanitizes taskId so bundle path stays inside bundles dir', () => {
            const mgr = createManager();
            const filePath = mgr._writeBundleFile({ taskId: '../../../evil' });
            expect(filePath.startsWith(path.resolve(bundlesDir) + path.sep)).toBe(true);
            expect(path.basename(filePath)).toContain('evil');
            expect(path.basename(filePath)).not.toContain('..');
        });

        test('throws when bundle write fails', () => {
            const mgr = createManager();
            const spy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
                throw new Error('disk full');
            });
            expect(() => mgr._writeBundleFile({ taskId: 'broken' })).toThrow('disk full');
            spy.mockRestore();
        });
    });

    describe('_writeReportStub', () => {
        test('writes markdown report stub per attempt', () => {
            const mgr = createManager();
            const filePath = mgr._writeReportStub({ taskId: 'r1', status: 'failed', outcome: '1' }, '/fake/bundle.json');
            expect(fs.existsSync(filePath)).toBe(true);
            const content = fs.readFileSync(filePath, 'utf8');
            expect(content).toContain('# Self-heal report');
            expect(content).toContain('Task ID: r1');
            expect(content).toContain('`/fake/bundle.json`');
        });

        test('creates report inside reports dir with sanitized taskId', () => {
            const mgr = createManager();
            const filePath = mgr._writeReportStub({ taskId: '../../../evil', status: 'failed' }, '/fake/bundle.json');
            expect(filePath.startsWith(path.resolve(reportsDir) + path.sep)).toBe(true);
            expect(path.basename(filePath)).toContain('evil');
            expect(path.basename(filePath)).not.toContain('..');
        });

        test('report stub prefers original outcome and records last attempted outcome', () => {
            const mgr = createManager();
            const filePath = mgr._writeReportStub({
                taskId: 'r-switched',
                status: 'failed',
                outcome: '2',
                originalOutcome: '1',
                currentOutcome: '2',
            }, '/fake/bundle.json');
            const content = fs.readFileSync(filePath, 'utf8');
            expect(content).toContain('- Outcome: 1');
            expect(content).toContain('- Last attempted outcome: 2');
        });
    });

    describe('_getLogTail', () => {
        test('returns last N lines of log file', () => {
            const mgr = createManager();
            const tail = mgr._getLogTail(logFilePath, 3);
            const lines = tail.split('\n').filter(l => l.length > 0);
            expect(lines).toContain('line4');
            expect(lines).toContain('line5');
        });

        test('returns null for nonexistent file', () => {
            const mgr = createManager();
            const tail = mgr._getLogTail('/nonexistent.log', 10);
            expect(tail).toBeNull();
        });
    });

    describe('_buildCopilotEnv', () => {
        test('does not leak launcher secrets into copilot subprocess env', () => {
            process.env.TG_TOKEN = 'super-secret';
            process.env.POSTGRES_PASSWORD = 'db-secret';
            const mgr = createManager();
            const env = mgr._buildCopilotEnv();
            expect(env.TG_TOKEN).toBeUndefined();
            expect(env.POSTGRES_PASSWORD).toBeUndefined();
            expect(env.PATH).toBe(process.env.PATH);
        });
    });

    describe('serialization', () => {
        test('processes queue items one at a time', async () => {
            const mgr = createManager();
            const executionOrder = [];
            let resolveFirst;
            const firstPromise = new Promise(r => { resolveFirst = r; });

            mgr._executeSelfHeal = jest.fn()
                .mockImplementationOnce(async (b) => {
                    executionOrder.push(`start-${b.taskId}`);
                    await firstPromise;
                    executionOrder.push(`end-${b.taskId}`);
                })
                .mockImplementationOnce(async (b) => {
                    executionOrder.push(`start-${b.taskId}`);
                    executionOrder.push(`end-${b.taskId}`);
                });

            mgr.onTaskFinalized({ taskId: 'first', status: 'failed', outcome: '1' });
            // Queue second while first is running
            mgr.onTaskFinalized({ taskId: 'second', status: 'completed', outcome: '2' });

            // First should be running, second queued
            expect(mgr._running).toBe(true);

            // Resolve first
            resolveFirst();
            // Wait for queue drain
            await new Promise(r => setTimeout(r, 50));

            expect(executionOrder).toEqual([
                'start-first', 'end-first',
                'start-second', 'end-second'
            ]);
        });

        test('invokes onCodeChange hook after successful run with runtime file changes', async () => {
            const onCodeChange = jest.fn(async () => {});
            const mgr = createManager({ onCodeChange, restartOnCodeChange: true });
            mgr._executeSelfHeal = jest.fn().mockResolvedValue({
                exitCode: 0,
                runtimeChangedPaths: ['backend/autobetting/core/betting/BetProcessor.js'],
                reportPath: '/fake/report.md',
                bundlePath: '/fake/bundle.json',
                taskId: 'changed'
            });

            mgr.onTaskFinalized({ taskId: 'changed', status: 'failed', outcome: '1' });
            await new Promise(r => setTimeout(r, 50));

            expect(onCodeChange).toHaveBeenCalledWith(expect.objectContaining({
                taskId: 'changed',
                runtimeChangedPaths: ['backend/autobetting/core/betting/BetProcessor.js']
            }));
        });
    });

    describe('error resilience', () => {
        test('failed self-heal does not throw from onTaskFinalized', () => {
            const mgr = createManager();
            mgr._executeSelfHeal = jest.fn().mockRejectedValue(new Error('copilot crashed'));

            expect(() => {
                mgr.onTaskFinalized({ taskId: 'err1', status: 'failed', outcome: '1' });
            }).not.toThrow();
        });

        test('failed self-heal increments failed counter', async () => {
            const mgr = createManager();
            mgr._executeSelfHeal = jest.fn().mockRejectedValue(new Error('boom'));
            mgr.onTaskFinalized({ taskId: 'err2', status: 'failed', outcome: '1' });

            // Wait for async queue processing
            await new Promise(r => setTimeout(r, 50));
            expect(mgr.stats.failed).toBe(1);
            expect(mgr.stats.completed).toBe(0);
        });

        test('logger errors in bundle building do not propagate', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            // Pass unusual bundle data
            expect(() => {
                mgr.onTaskFinalized(null);
            }).not.toThrow();
        });
    });

    describe('dispose', () => {
        test('clears queue and prevents new entries', async () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({ taskId: 'd1', status: 'failed', outcome: '1' });
            expect(mgr._queue.length).toBe(1);
            await mgr.dispose();
            expect(mgr._queue.length).toBe(0);
            mgr.onTaskFinalized({ taskId: 'd2', status: 'failed', outcome: '2' });
            expect(mgr._queue.length).toBe(0);
        });

        test('terminates active child on shutdown', async () => {
            const mgr = createManager();
            const kill = jest.fn();
            mgr._activeChild = { killed: false, kill };
            let resolveRun;
            mgr._activeRunPromise = new Promise((resolve) => { resolveRun = resolve; });
            const disposePromise = mgr.dispose();
            expect(kill).toHaveBeenCalledWith('SIGTERM');
            resolveRun();
            await disposePromise;
        });
    });

    describe('waitForIdle', () => {
        test('waits until queue and active run are drained', async () => {
            const mgr = createManager();
            let resolveRun;
            mgr._running = true;
            mgr._activeRunPromise = new Promise((resolve) => { resolveRun = resolve; });
            const waiter = mgr.waitForIdle(2000);
            setTimeout(() => {
                mgr._running = false;
                mgr._activeRunPromise = null;
                resolveRun();
            }, 10);
            await expect(waiter).resolves.toBeUndefined();
        });
    });

    describe('_runCopilot', () => {
        test('runs copilot binary and captures output', async () => {
            // Use /usr/bin/echo as a stand-in for copilot
            const mgr = createManager({ copilotPath: '/usr/bin/echo' });
            const result = await mgr._runCopilot('hello world');
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('-p');
            expect(result.stdout).toContain('--allow-tool');
            expect(result.stdout).toContain('--allow-tool apply_patch');
            expect(result.stdout).toContain('--allow-tool rg');
            expect(result.stdout).not.toContain('--allow-tool edit');
            expect(result.stdout).not.toContain('--allow-tool create');
            expect(result.stdout).not.toContain('--allow-tool grep');
            expect(result.stdout).not.toContain('--allow-all-tools');
            expect(result.stdout).toContain('--no-ask-user');
            expect(result.stdout).toContain('--add-dir');
            expect(result.stdout).toContain(bundlesDir);
            expect(result.stdout).toContain(reportsDir);
            expect(result.stdout).toContain('--secret-env-vars');
            expect(result.stdout).toContain('--model gpt-5.4');
        });

        test('handles missing binary gracefully', async () => {
            const mgr = createManager({ copilotPath: '/nonexistent/binary' });
            await expect(mgr._runCopilot('test')).rejects.toThrow();
        });
    });

    describe('getStats', () => {
        test('returns current stats snapshot', () => {
            const mgr = createManager();
            mgr._processQueue = jest.fn();
            mgr.onTaskFinalized({ taskId: 's1', status: 'completed', outcome: '1' });
            mgr.onTaskFinalized({ taskId: 's2', status: 'failed', outcome: '2' });
            const stats = mgr.getStats();
            expect(stats.queued).toBe(2);
            expect(stats.queueLength).toBe(2);
        });
    });
});

describe('BaseBettor self-heal integration', () => {
    test('_buildSelfHealBundle is a method on BaseBettor prototype', () => {
        // Verify the method exists without instantiating the full bettor
        const { BaseBettor } = require('../betting/BaseBettor.js');
        expect(typeof BaseBettor.prototype._buildSelfHealBundle).toBe('function');
    });

    test('_buildSelfHealBundle produces correct structure', () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        // Call it in isolation with a mock context
        const bundle = BaseBettor.prototype._buildSelfHealBundle.call(
            { bookmakerName: 'Sansabet' },
            {
                id: 'task-42',
                home: 'Team A',
                away: 'Team B',
                outcome: 'Over 2.5',
                stake: 10,
                expectedOdds: 1.85,
                _lastError: 'odds dropped',
                signalId: 'sig-1',
                profileId: 'default',
                sourceProfileId: 'default',
                sport: 'Soccer',
                telegramContext: {
                    signalId: 'sig-1',
                    originChatId: '-1002000',
                    originTargetLabel: 'bet20_online',
                },
            },
            'failed',
            'odds dropped',
            'retry_loop_exhausted',
            { isTelegram: true }
        );

        expect(bundle.taskId).toBe('task-42');
        expect(bundle.status).toBe('failed');
        expect(bundle.source).toBe('telegram');
        expect(bundle.home).toBe('Team A');
        expect(bundle.away).toBe('Team B');
        expect(bundle.outcome).toBe('Over 2.5');
        expect(bundle.error).toBe('odds dropped');
        expect(bundle.signalId).toBe('sig-1');
        expect(bundle.sourceProfileId).toBe('default');
        expect(bundle.originChatId).toBe('-1002000');
        expect(bundle.originTargetLabel).toBe('bet20_online');
        expect(bundle.telegramContext).toEqual(expect.objectContaining({
            signalId: 'sig-1',
            originChatId: '-1002000',
        }));
        expect(bundle.task.sport).toBe('Soccer');
    });

    test('_buildSelfHealBundle preserves original and current outcomes when task switched', () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        const bundle = BaseBettor.prototype._buildSelfHealBundle.call(
            { bookmakerName: 'Sansabet' },
            {
                id: 'task-switched',
                home: 'Chapecoense',
                away: 'Avai',
                outcome: '2',
                _originalOutcome: '1',
                selectedCandidate: { outcome: '2', reason: 'explicit_outcome_candidate' },
                stake: 10,
                sport: 'soccer',
                telegramContext: {
                    signalId: 'sig-switched',
                    originChatId: '-1002000',
                },
            },
            'failed',
            'Singles blocked for all outcomes',
            'singles_blocked',
            { isTelegram: true }
        );

        expect(bundle.outcome).toBe('1');
        expect(bundle.originalOutcome).toBe('1');
        expect(bundle.currentOutcome).toBe('2');
        expect(bundle.selectedCandidate).toEqual(expect.objectContaining({
            outcome: '2',
        }));
        expect(bundle.task.outcome).toBe('2');
        expect(bundle.task.originalOutcome).toBe('1');
    });

    test('_buildSelfHealBundle handles errors gracefully', () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        const bundle = BaseBettor.prototype._buildSelfHealBundle.call(
            { bookmakerName: 'Test' },
            null,
            'failed',
            'crash',
            'exception',
            null
        );
        expect(bundle.status).toBe('failed');
        expect(bundle._bundleError).toBeDefined();
    });

    test('cancelled telegram tasks do not trigger self-heal', async () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        class FakeAdapter {
            constructor() {
                this.bookmakerName = 'FakeBook';
                this.isPrematch = false;
            }

            async login() { return true; }
            async close() { return true; }
            async isSessionValid() { return true; }
            getSportId() { return 1; }
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-bettor-'));
        const tasksFilePath = path.join(tmpDir, 'tasks.json');
        const stateFilePath = path.join(tmpDir, 'state.json');

        try {
            const bettor = new BaseBettor(new FakeAdapter(), {
                executionMode: 'telegram-only',
                tasksFilePath,
                stateFilePath,
                logger: { log: jest.fn(), error: jest.fn() },
                tgQuiet: true,
                selfHeal: { enabled: true },
            });

            await bettor.enqueueTelegramTask({
                signalId: 'sig-stop',
                home: 'Home',
                away: 'Away',
                outcome: '1',
                originChatId: '-2002',
            });

            bettor._processBetAttempt = jest.fn().mockResolvedValue({
                cancelled: true,
                message: 'STOP requested before submit',
                step: 'telegram_stop',
            });
            bettor.selfHealManager.onTaskFinalized = jest.fn();

            const current = bettor.tasksManager.getCurrentTask('fakebook');
            await bettor._executeQueuedTask(current);

            expect(bettor.selfHealManager.onTaskFinalized).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('terminal telegram failure keeps actual failure step in self-heal bundle', async () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        class FakeAdapter {
            constructor() {
                this.bookmakerName = 'FakeBook';
                this.isPrematch = false;
            }

            async login() { return true; }
            async close() { return true; }
            async isSessionValid() { return true; }
            getSportId() { return 1; }
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-terminal-step-'));
        const tasksFilePath = path.join(tmpDir, 'tasks.json');
        const stateFilePath = path.join(tmpDir, 'state.json');

        try {
            const bettor = new BaseBettor(new FakeAdapter(), {
                executionMode: 'telegram-only',
                tasksFilePath,
                stateFilePath,
                logger: { log: jest.fn(), error: jest.fn() },
                tgQuiet: true,
                selfHeal: { enabled: true },
            });

            await bettor.enqueueTelegramTask({
                signalId: 'sig-max-stake',
                home: 'Home',
                away: 'Away',
                outcome: '2',
                originChatId: '-2002',
            });

            bettor._processBetAttempt = jest.fn().mockImplementation(async (task) => {
                task._lastError = 'Maksimalna uplata za ovaj tiket je : 5,00 EUR';
                task._notificationSent = true;
                return { success: false, shouldRetry: false, step: 'bet_submit' };
            });
            bettor.selfHealManager.onTaskFinalized = jest.fn();

            const current = bettor.tasksManager.getCurrentTask('fakebook');
            await bettor._executeQueuedTask(current);

            expect(bettor.selfHealManager.onTaskFinalized).toHaveBeenCalledWith(expect.objectContaining({
                status: 'failed',
                step: 'bet_submit',
                error: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR',
            }));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('enqueueTelegramTask preserves originTargetLabel in telegram context', async () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        class FakeAdapter {
            constructor() {
                this.bookmakerName = 'FakeBook';
                this.isPrematch = false;
            }

            async login() { return true; }
            async close() { return true; }
            async isSessionValid() { return true; }
            getSportId() { return 1; }
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-origin-label-'));
        const tasksFilePath = path.join(tmpDir, 'tasks.json');
        const stateFilePath = path.join(tmpDir, 'state.json');

        try {
            const bettor = new BaseBettor(new FakeAdapter(), {
                executionMode: 'telegram-only',
                tasksFilePath,
                stateFilePath,
                logger: { log: jest.fn(), error: jest.fn() },
                tgQuiet: true,
            });

            await bettor.enqueueTelegramTask({
                signalId: 'sig-origin',
                home: 'Home',
                away: 'Away',
                outcome: '1',
                originChatId: '-2002',
                originTargetLabel: 'bet20_online',
            });

            const current = bettor.tasksManager.getCurrentTask('fakebook');
            expect(current.originTargetLabel).toBe('bet20_online');
            expect(current.telegramContext.originTargetLabel).toBe('bet20_online');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('goal-reaching successful telegram task still triggers self-heal before stop', async () => {
        const { BaseBettor } = require('../betting/BaseBettor.js');
        class FakeAdapter {
            constructor() {
                this.bookmakerName = 'FakeBook';
                this.isPrematch = false;
            }

            async login() { return true; }
            async close() { return true; }
            async isSessionValid() { return true; }
            getSportId() { return 1; }
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-goal-stop-'));
        const tasksFilePath = path.join(tmpDir, 'tasks.json');
        const stateFilePath = path.join(tmpDir, 'state.json');

        try {
            const bettor = new BaseBettor(new FakeAdapter(), {
                executionMode: 'telegram-only',
                tasksFilePath,
                stateFilePath,
                logger: { log: jest.fn(), error: jest.fn() },
                tgQuiet: true,
                suppressTelegramStartStop: true,
                maxSuccessful: 1,
                selfHeal: { enabled: true },
            });

            await bettor.enqueueTelegramTask({
                signalId: 'sig-success',
                home: 'Home',
                away: 'Away',
                outcome: '1',
                originChatId: '-2002',
            });

            bettor._checkLimits = jest.fn()
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(false);
            bettor._processBetAttempt = jest.fn().mockResolvedValue({ success: true });
            bettor.selfHealManager._executeSelfHeal = jest.fn().mockResolvedValue(undefined);

            const current = bettor.tasksManager.getCurrentTask('fakebook');
            await bettor._executeQueuedTask(current);

            expect(bettor.selfHealManager._executeSelfHeal).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
