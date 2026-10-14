/**
 * TasksManager: cross-process lock, execution claims and durable execution outcomes
 * (the 1win queue consumer). Multi-process cases fork real node processes on one tasks file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { TasksManager } = require('../tasks/tasks-manager.js');

const FIXTURE_NOW = () => Date.now();
const task = (over = {}) => ({
  id: Date.now() + Math.random(), bookmakerId: '1win', home: 'Alpha FC', away: 'Beta FC', outcome: 'P1 T< 1',
  stake: 1, sourceType: 'analyzer', source: 'analyzer_stable', createdAt: FIXTURE_NOW(), ...over
});

describe('TasksManager execution ownership and outcomes', () => {
  let dir;
  let file;
  let manager;
  const quiet = () => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); };

  beforeEach(() => {
    quiet();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-exec-'));
    file = path.join(dir, 'bet_tasks.json');
    manager = new TasksManager({ tasksFilePath: file, betting: { protection: { maxFailedAttempts: 3, matchBlockDurationMinutes: 30 } } });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('cross-process lock', () => {
    const worker = path.join(__dirname, 'fixtures', 'tasks-manager-writer.js');

    test('concurrent writers in separate processes lose no update', () => {
      const procs = [];
      for (let i = 0; i < 4; i += 1) {
        procs.push(spawn(process.execPath, [worker, file, `w${i}`, '40'], { stdio: 'ignore' }));
      }
      return Promise.all(procs.map((p) => new Promise((resolve) => p.on('exit', resolve)))).then((codes) => {
        expect(codes).toEqual([0, 0, 0, 0]);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(data.history).toHaveLength(160);
        const perWriter = {};
        for (const h of data.history) perWriter[h.outcome] = (perWriter[h.outcome] || 0) + 1;
        expect(Object.values(perWriter)).toEqual([40, 40, 40, 40]);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
        expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      });
    }, 60000);

    test('a lock of a dead process is reaped, a lock of a live process is waited for and then refused', () => {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2147483646, host: os.hostname(), token: 'dead', at: Date.now() }));
      expect(manager.startProcessing('1win')).toBe(true);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);

      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'live', at: Date.now() }));
      expect(() => new TasksManager({ tasksFilePath: file, lockTimeoutMs: 150 })).toThrow('TASKS_FILE_LOCK_TIMEOUT');
      fs.unlinkSync(`${file}.lock`);
    });
  });

  describe('execution claim', () => {
    test('one consumer holds the current task; the second is told who and until when', () => {
      const t = task();
      expect(manager.addTask(t)).toBe(true);
      const a = manager.claimTask(t.id, { consumerId: 'consumer-A', leaseMs: 30000 });
      expect(a.claimed).toBe(true);
      expect(manager.isProcessing('1win')).toBe(true);
      const b = manager.claimTask(t.id, { consumerId: 'consumer-B' });
      expect(b).toMatchObject({ claimed: false, reason: 'claimed_by_other', holder: 'consumer-A' });
      // same consumer id (a restart) takes its own lease over with a new token
      const again = manager.claimTask(t.id, { consumerId: 'consumer-A' });
      expect(again.claimed).toBe(true);
      expect(again.claim.token).not.toEqual(a.claim.token);
      expect(manager.renewClaim(t.id, a.claim.token)).toMatchObject({ renewed: false, reason: 'claim_lost' });
      expect(manager.renewClaim(t.id, again.claim.token).renewed).toBe(true);
    });

    test('an expired lease can be taken over, a pending task cannot be claimed', () => {
      const t = task();
      manager.addTask(t);
      const a = manager.claimTask(t.id, { consumerId: 'A', leaseMs: 1000, now: Date.now() - 5000 });
      expect(a.claimed).toBe(true);
      const b = manager.claimTask(t.id, { consumerId: 'B' });
      expect(b.claimed).toBe(true);
      expect(b.claim.takeover).toBe(true);
      const pending = task({ sourceType: 'telegram', source: 'telegram' });
      expect(manager.addTask(pending)).toBe(true);
      expect(manager.getPendingTask('1win').id).toBe(pending.id);
      expect(manager.claimTask(pending.id, { consumerId: 'B' })).toMatchObject({ claimed: false, reason: 'task_not_current' });
    });

    test('a claimed task is not stale at startup, an expired one is; producers see a busy slot', () => {
      const t = task({ createdAt: Date.now() - 120000 });
      manager.addTask(t);
      manager.claimTask(t.id, { consumerId: 'A', leaseMs: 60000 });
      const restarted = new TasksManager({ tasksFilePath: file });
      expect(restarted.getCurrentTask('1win').id).toBe(t.id);
      expect(restarted.isProcessing('1win')).toBe(true);
      expect(restarted.addTask(task({ outcome: 'P2 T< 1' }))).toBe(false); // analyzer is refused while processing

      manager.claimTask(t.id, { consumerId: 'A', leaseMs: 1000, now: Date.now() - 10000 });
      const afterCrash = new TasksManager({ tasksFilePath: file });
      expect(afterCrash.getCurrentTask('1win')).toBeNull();
      expect(afterCrash.isProcessing('1win')).toBe(false);
    });

    test('a consumer that opens the file with startupCleanup=false leaves every slot as it found it', () => {
      const old = task({ createdAt: Date.now() - 120000 });
      manager.addTask(old);
      manager.startProcessing('1win');
      const other = task({ bookmakerId: 'sansabet', createdAt: Date.now() - 120000, id: 99.5 });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.currentTasks.sansabet = other;
      data.processing.sansabet = true;
      fs.writeFileSync(file, JSON.stringify(data));
      new TasksManager({ tasksFilePath: file, startupCleanup: false });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(data);
      new TasksManager({ tasksFilePath: file });
      const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(cleaned.currentTasks.sansabet).toBeNull(); // the default behaviour of every other process
    });

    test('a producer is not locked out by a consumer that lost its lease; a live lease still blocks it', () => {
      const t = task();
      manager.addTask(t);
      manager.claimTask(t.id, { consumerId: 'A', leaseMs: 60000 });
      const blocked = task({ outcome: 'P2 T< 1' });
      expect(manager.addTask(blocked)).toBe(false);
      expect(manager.getCurrentTask('1win').id).toBe(t.id);

      manager.claimTask(t.id, { consumerId: 'A', leaseMs: 1000, now: Date.now() - 10000 });
      const waiting = task({ outcome: 'P2 T< 1' });
      expect(manager.addTask(waiting)).toBe(true);
      expect(manager.getCurrentTask('1win').id).toBe(waiting.id);
      expect(manager.isProcessing('1win')).toBe(false);
      const lease = manager.getHistory('1win').find((h) => h.step === 'claim_lease_expired');
      expect(lease).toMatchObject({ status: 'cancelled', taskId: t.id, claimConsumerId: 'A' });
      // the consumer's own recovery can still settle the old task from its journal snapshot
      const late = manager.recordExecutionOutcome(t.id, { status: 'unresolved', attemptKey: 'late', taskSnapshot: t, stake: 1 });
      expect(late.recorded).toBe(true);
      expect(manager.getCurrentTask('1win').id).toBe(waiting.id); // the new task keeps its slot
    });

    test('releaseClaim needs the token and frees the processing flag', () => {
      const t = task();
      manager.addTask(t);
      const { claim } = manager.claimTask(t.id, { consumerId: 'A' });
      expect(manager.releaseClaim(t.id, 'nope')).toMatchObject({ released: false });
      expect(manager.releaseClaim(t.id, claim.token)).toEqual({ released: true });
      expect(manager.isProcessing('1win')).toBe(false);
      expect(manager.getCurrentTask('1win').executionClaim).toBeUndefined();
    });
  });

  describe('execution outcomes', () => {
    const settle = (status, extra = {}) => {
      const t = task();
      manager.addTask(t);
      manager.claimTask(t.id, { consumerId: 'A' });
      const result = manager.recordExecutionOutcome(t.id, { status, attemptKey: `att-${t.id}`, stake: 1, ...extra });
      return { t, result };
    };

    test('accepted needs the ticket of the attempt receipt and counts as exposure', () => {
      const t = task();
      manager.addTask(t);
      manager.claimTask(t.id, { consumerId: 'A' });
      expect(() => manager.recordExecutionOutcome(t.id, { status: 'accepted', attemptKey: 'k' })).toThrow(/ticketId/);
      const result = manager.recordExecutionOutcome(t.id, { status: 'accepted', attemptKey: 'k', stake: 1, ticketId: 'B-100', odds: 1.9,
        transportEnvironment: 'production' });
      expect(result.recorded).toBe(true);
      expect(result.entry).toMatchObject({ status: 'completed', ticketId: 'B-100', testMode: false, dryRun: false });
      expect(manager.getCurrentTask('1win')).toBeNull();
      expect(manager.calculateMatchTotal(result.entry.matchKey, 'analyzer_normal')).toBe(1);
    });

    test('a synthetic accepted result is a test entry: no exposure, no block', () => {
      const { result } = settle('accepted', { ticketId: 'STAND-1', synthetic: true, transportEnvironment: 'local_stand' });
      expect(result.entry.testMode).toBe(true);
      expect(manager.calculateMatchTotal(result.entry.matchKey, 'analyzer_normal')).toBe(0);
    });

    test('unresolved is not a failure, counts as exposure, survives cleanup, frees the slot', () => {
      for (let i = 0; i < 4; i += 1) {
        const t = task({ outcome: `P1 T< ${i}` });
        manager.addTask(t);
        manager.claimTask(t.id, { consumerId: 'A' });
        const r = manager.recordExecutionOutcome(t.id, { status: 'unresolved', attemptKey: `k${i}`, stake: 1, reason: 'INDETERMINATE' });
        expect(r.recorded).toBe(true);
        expect(manager.getCurrentTask('1win')).toBeNull();
        expect(manager.isProcessing('1win')).toBe(false);
      }
      const matchKey = manager.getRecentHistory(1)[0].matchKey;
      expect(manager.isMatchBlocked(matchKey)).toBe(false); // markFailed x4 would have blocked the match
      expect(manager.calculateMatchTotal(matchKey, 'analyzer_normal')).toBe(4);
      expect(manager.getStats()).toMatchObject({ unresolved: 4, failed: 0, completed: 0 });
      const aged = new TasksManager({ tasksFilePath: file, maxHistoryAge: 1 });
      aged.cleanup();
      expect(aged.getHistory('1win')).toHaveLength(4);
    });

    test('rejected is a proved bookmaker refusal; not_sent and dry_run are neither failure nor bet', () => {
      const { result: rejected } = settle('rejected', { errorCode: 'odd_cf_changed', reason: 'odd_cf_changed' });
      expect(rejected.entry).toMatchObject({ status: 'failed', bookmakerRejected: true, submitReached: true });
      const { result: notSent } = settle('not_sent', { reason: 'price_drift' });
      expect(notSent.entry).toMatchObject({ status: 'cancelled' });
      const { result: dry } = settle('dry_run', { odds: 1.9 });
      expect(dry.entry).toMatchObject({ status: 'dry_run', dryRun: true });
      expect(manager.calculateMatchTotal(dry.entry.matchKey, 'analyzer_normal')).toBe(0);
    });

    test('a repeated record is a no-op (restart, duplicate delivery) and a vanished task is recorded from its snapshot', () => {
      const { t, result } = settle('unresolved', { reason: 'x' });
      const again = manager.recordExecutionOutcome(t.id, { status: 'unresolved', attemptKey: `att-${t.id}`, stake: 1 });
      expect(again).toMatchObject({ recorded: false, already: true, same: true });
      expect(manager.getHistory('1win')).toHaveLength(1);

      const ghost = task({ id: 4242.5 });
      expect(manager.recordExecutionOutcome(ghost.id, { status: 'not_sent', attemptKey: 'ghost' })).toMatchObject({ recorded: false, reason: 'task_not_found' });
      const viaSnapshot = manager.recordExecutionOutcome(ghost.id, { status: 'not_sent', attemptKey: 'ghost', taskSnapshot: { ...ghost, matchKey: 'a_b' } });
      expect(viaSnapshot.recorded).toBe(true);
      expect(result.recorded).toBe(true);
    });

    test('pending task is promoted to current when the claimed one is settled', () => {
      const t = task();
      manager.addTask(t);
      manager.claimTask(t.id, { consumerId: 'A' });
      const waiting = task({ sourceType: 'telegram', source: 'telegram', outcome: 'P2 T< 1' });
      manager.addTask(waiting);
      manager.recordExecutionOutcome(t.id, { status: 'not_sent', attemptKey: 'k', reason: 'stale' });
      expect(manager.getCurrentTask('1win').id).toBe(waiting.id);
      expect(manager.getPendingTask('1win')).toBeNull();
    });

    test('an unresolved outcome is resolved by identity: placed becomes completed, not placed becomes cancelled', () => {
      const { t } = settle('unresolved', { reason: 'x' });
      expect(() => manager.resolveExecutionOutcome(`att-${t.id}`, { resolution: 'accepted' })).toThrow(/bet id/);
      const done = manager.resolveExecutionOutcome(`att-${t.id}`, { resolution: 'accepted', ticketId: 'B-7', evidence: 'history by key', operator: 'op' });
      expect(done.resolved).toBe(true);
      expect(done.entry).toMatchObject({ status: 'completed', ticketId: 'B-7' });
      expect(manager.resolveExecutionOutcome(`att-${t.id}`, { resolution: 'accepted', ticketId: 'B-7' })).toMatchObject({ resolved: false, already: true });
      expect(manager.resolveExecutionOutcome(`att-${t.id}`, { resolution: 'not_placed' })).toMatchObject({ resolved: false, already: false });
    });
  });
});
