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

    test('temp files of writers that died between write and rename are removed at start, a fresh one is left', () => {
      const old = `${file}.4242.deadbeef.tmp`;
      const fresh = `${file}.4343.cafebabe.tmp`;
      fs.writeFileSync(old, '{"half');
      fs.writeFileSync(fresh, '{"half');
      const past = new Date(Date.now() - 5 * 60 * 1000);
      fs.utimesSync(old, past, past);
      new TasksManager({ tasksFilePath: file });
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).history).toEqual([]);
    });

    test('a lock of a dead process is reaped, a lock of a live process is waited for and then refused', () => {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2147483646, host: os.hostname(), token: 'dead', at: Date.now() }));
      expect(manager.startProcessing('1win')).toBe(true);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);

      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'live', at: Date.now() }));
      expect(() => new TasksManager({ tasksFilePath: file, lockTimeoutMs: 150 })).toThrow('TASKS_FILE_LOCK_TIMEOUT');
      fs.unlinkSync(`${file}.lock`);
    });
  });

  describe('lock ownership (a live holder is never robbed because of its age)', () => {
    const holder = path.join(__dirname, 'fixtures', 'tasks-manager-lock-holder.js');
    const startHolder = (holdMs, label = '') => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [holder, file, String(holdMs), label], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('LOCKED')) resolve(child);
      });
      child.on('error', reject);
      child.on('exit', () => { if (!out.includes('LOCKED')) reject(new Error('holder did not take the lock')); });
    });
    const lockFile = () => `${file}.lock`;
    const readLock = () => JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    const writeLock = (info) => fs.writeFileSync(lockFile(), JSON.stringify(info));
    const exited = (child) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) resolve(); else child.on('exit', resolve); });
    const quick = () => new TasksManager({ tasksFilePath: file, lockTimeoutMs: 400, startupCleanup: false });

    test('a LIVE same-host holder older than 30 s keeps the lock; the contender waits and then refuses, nothing is overwritten', async () => {
      const child = await startHolder(60000);
      try {
        const info = readLock();
        expect(info.pid).toBe(child.pid);
        writeLock({ ...info, at: Date.now() - 31000 });            // same live pid, same start token, "31 s old"
        expect(() => quick().startProcessing('1win')).toThrow('TASKS_FILE_LOCK_TIMEOUT');   // opening the file already waits for the lock
        expect(readLock().token).toBe(info.token);                  // the holder's lock is still the holder's
      } finally {
        child.kill('SIGKILL');
        await exited(child);
      }
    });

    test('a PAUSED (SIGSTOP) holder keeps the lock however old it looks; when it continues, both writes survive', async () => {
      const child = await startHolder(1500, 'paused');
      const info = readLock();
      process.kill(child.pid, 'SIGSTOP');
      try {
        writeLock({ ...info, at: Date.now() - 120000 });
        expect(() => quick().startProcessing('1win')).toThrow('TASKS_FILE_LOCK_TIMEOUT');
        expect(readLock().token).toBe(info.token);
      } finally {
        process.kill(child.pid, 'SIGCONT');
      }
      await exited(child);
      const late = new TasksManager({ tasksFilePath: file, lockTimeoutMs: 5000, startupCleanup: false });
      expect(late.startProcessing('1win')).toBe(true);
      const history = JSON.parse(fs.readFileSync(file, 'utf8')).history;
      expect(history.map((h) => h.outcome)).toEqual(['paused']);
    });

    test('a slow critical section of a live holder is waited for, not interrupted', async () => {
      const child = await startHolder(900, 'slow');
      const t0 = Date.now();
      const contender = new TasksManager({ tasksFilePath: file, lockTimeoutMs: 8000, startupCleanup: false });
      contender.recordBetResult({ id: 'mine', bookmakerId: '1win', home: 'A', away: 'B', outcome: 'mine', matchKey: 'a_b', stake: 1 }, 'completed', { odds: 2, stake: 1 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      await exited(child);
      const history = JSON.parse(fs.readFileSync(file, 'utf8')).history;
      expect(history.map((h) => h.outcome).sort()).toEqual(['mine', 'slow']);
    });

    test('a holder that really died is recovered at once, atomically, with the records intact', async () => {
      new TasksManager({ tasksFilePath: file }).recordBetResult({ id: 'before', bookmakerId: '1win', home: 'A', away: 'B', outcome: 'before', matchKey: 'a_b', stake: 1 }, 'completed', {});
      const child = await startHolder(60000);
      child.kill('SIGKILL');
      await exited(child);
      expect(fs.existsSync(lockFile())).toBe(true);                 // the dead holder left it behind
      const t0 = Date.now();
      const next = new TasksManager({ tasksFilePath: file, lockTimeoutMs: 5000, startupCleanup: false });
      expect(next.startProcessing('1win')).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).history.map((h) => h.outcome)).toEqual(['before']);
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    test('a pid that is alive but is not the process that took the lock (pid reuse) is recovered', async () => {
      const child = await startHolder(60000);
      try {
        const info = readLock();
        child.kill('SIGKILL');
        await exited(child);
        // the dead holder's pid number now "belongs" to a live process: this test process, with another start token
        writeLock({ ...info, pid: process.pid, start: 'a-different-process-start-token' });
        const t0 = Date.now();
        expect(quick().startProcessing('1win')).toBe(true);
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        child.kill('SIGKILL');
      }
    });

    test('unknown or corrupt holder metadata, and a lock of another host, are never guessed dead', () => {
      for (const content of ['', 'not json', '{"pid":"x"}', JSON.stringify({ pid: 1, host: 'some-other-host', token: 't', at: Date.now() - 600000 })]) {
        fs.writeFileSync(lockFile(), content);
        const past = new Date(Date.now() - 600000);
        fs.utimesSync(lockFile(), past, past);                       // old by every clock
        expect(() => quick().startProcessing('1win')).toThrow(/TASKS_FILE_LOCK_(TIMEOUT|UNKNOWN_HOLDER)/);
        expect(fs.readFileSync(lockFile(), 'utf8')).toBe(content);   // untouched: an operator decides
        fs.unlinkSync(lockFile());
      }
    });

    test('contenders and the reaper do not remove a lock that a new owner took after the dead one was removed', async () => {
      const dead = await startHolder(60000);
      dead.kill('SIGKILL');
      await exited(dead);
      const workers = [];
      for (let i = 0; i < 4; i += 1) workers.push(new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'tasks-manager-writer.js'), file, `w${i}`, '25'], { stdio: 'ignore' });
        c.on('exit', resolve);
      }));
      expect(await Promise.all(workers)).toEqual([0, 0, 0, 0]);
      const history = JSON.parse(fs.readFileSync(file, 'utf8')).history;
      expect(history).toHaveLength(100);                             // 4 x 25, none lost, none duplicated
      expect(fs.existsSync(lockFile())).toBe(false);
      expect(fs.existsSync(`${lockFile()}.reap`)).toBe(false);
    }, 60000);
  });

  describe('hand-off mark (a lease that is lost after the order may have left is not a cancellation)', () => {
    const KEY = 'q-handoff-1';
    const claimedAndHandedOff = (t = task(), key = KEY) => {
      expect(manager.addTask(t)).toBe(true);
      const claim = manager.claimTask(t.id, { consumerId: 'consumer-A', leaseMs: 1000, now: Date.now() - 10000 }).claim;   // lease already over
      expect(manager.markClaimHandoff(t.id, claim.token, key)).toEqual({ marked: true });
      return { t, claim };
    };

    test('the mark needs the live token, is idempotent, and says which attempt key may be on its way', () => {
      const t = task();
      manager.addTask(t);
      const { claim } = manager.claimTask(t.id, { consumerId: 'A', leaseMs: 30000 });
      expect(manager.markClaimHandoff(t.id, 'not-the-token', KEY)).toEqual({ marked: false, reason: 'claim_lost' });
      expect(manager.markClaimHandoff('missing', claim.token, KEY)).toEqual({ marked: false, reason: 'task_not_current' });
      expect(manager.markClaimHandoff(t.id, claim.token, KEY)).toEqual({ marked: true });
      expect(manager.markClaimHandoff(t.id, claim.token, KEY)).toEqual({ marked: true, already: true });
      expect(manager.getCurrentTask('1win').executionClaim.handedOff.attemptKey).toBe(KEY);
      expect(() => manager.markClaimHandoff(t.id, claim.token, '')).toThrow('attemptKey');
    });

    test('lease expiry after the mark frees the slot with an UNRESOLVED entry that counts as exposure', () => {
      const { t } = claimedAndHandedOff();
      expect(manager.addTask(task({ outcome: 'P2 T< 1', home: 'Gamma FC', away: 'Delta FC' }))).toBe(true);   // another match takes the slot
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')).history.find((h) => h.taskId === t.id);
      expect(entry).toMatchObject({ status: 'unresolved', step: 'handoff_lease_expired', testMode: false, claimConsumerId: 'consumer-A' });
      expect(entry.executionOutcome).toMatchObject({ attemptKey: KEY, status: 'unresolved', placeholder: 'lease_expired_after_handoff' });
      expect(manager.calculateMatchTotal(entry.matchKey, entry.betCategory)).toBeGreaterThan(0);
    });

    test('without the mark the same expiry is a cancellation (nothing was handed over)', () => {
      const lone = task({ outcome: 'P1 X', home: 'Eps FC', away: 'Zeta FC' });
      manager.addTask(lone);
      manager.claimTask(lone.id, { consumerId: 'A', leaseMs: 1000, now: Date.now() - 10000 });      // no mark
      expect(manager.addTask(task({ outcome: 'P2 X', home: 'Eta FC', away: 'Theta FC' }))).toBe(true);
      const plain = JSON.parse(fs.readFileSync(file, 'utf8')).history.find((h) => h.taskId === lone.id);
      expect(plain).toMatchObject({ status: 'cancelled', step: 'claim_lease_expired' });
      expect(manager.calculateMatchTotal(plain.matchKey, plain.betCategory)).toBe(0);
    });

    test('startup cleanup of a stale handed-off task keeps it in the history as unresolved, and it survives cleanup()', () => {
      const t = task({ createdAt: Date.now() - 120000 });
      manager.addTask(t);
      const { claim } = manager.claimTask(t.id, { consumerId: 'A', leaseMs: 1000, now: Date.now() - 10000 });
      manager.markClaimHandoff(t.id, claim.token, KEY);
      const restarted = new TasksManager({ tasksFilePath: file });                               // default cleanup of any process
      expect(restarted.getCurrentTask('1win')).toBeNull();
      const entries = restarted.read().history.filter((h) => h.taskId === t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: 'unresolved', step: 'handoff_lease_expired' });
      entries[0].timestamp = Date.now() - 10 * 24 * 3600 * 1000;                                 // far older than the history age
      const data = restarted.read();
      data.history = [entries[0]];
      restarted.atomicWrite(data);
      restarted.cleanup();
      expect(restarted.read().history).toHaveLength(1);
      expect(restarted.calculateMatchTotal(entries[0].matchKey, entries[0].betCategory)).toBeGreaterThan(0);
    });

    test("the consumer's record of the same attempt key replaces the placeholder once: placed, not placed, still unknown", () => {
      for (const [status, extra, expected] of [
        ['accepted', { ticketId: 'B-77', odds: 1.9 }, 'completed'],
        ['not_sent', { reason: 'executor_fenced_order_before_claim' }, 'cancelled'],
        ['unresolved', { reason: 'order_delivery_unknown_after_restart' }, 'unresolved'],
      ]) {
        const key = `q-${status}`;
        const t = task({ outcome: `P1 ${status}`, home: `H-${status}`, away: `A-${status}` });
        claimedAndHandedOff(t, key);
        manager.addTask(task({ outcome: 'P9', home: `X-${status}`, away: `Y-${status}` }));     // lease expiry writes the placeholder
        const first = manager.recordExecutionOutcome(t.id, { status, attemptKey: key, stake: 1, taskSnapshot: t, ...extra });
        expect(first).toMatchObject({ recorded: true, replacedPlaceholder: true });
        const entries = manager.read().history.filter((h) => h.executionOutcome && h.executionOutcome.attemptKey === key);
        expect(entries).toHaveLength(1);
        expect(entries[0].status).toBe(expected);
        expect(entries[0].executionOutcome.replacedPlaceholder.kind).toBe('lease_expired_after_handoff');
        expect(entries[0].executionOutcome.placeholder).toBeUndefined();
        // the same record again changes nothing (restart, duplicate delivery)
        const second = manager.recordExecutionOutcome(t.id, { status, attemptKey: key, stake: 1, taskSnapshot: t, ...extra });
        expect(second).toMatchObject({ recorded: false, already: true });
        expect(manager.read().history.filter((h) => h.executionOutcome && h.executionOutcome.attemptKey === key)).toHaveLength(1);
        manager.cancelTask(manager.getCurrentTask('1win').id, { reason: 'next', forceCurrent: true });
      }
    });

    test('a placeholder is resolved by identity like any unresolved entry; a settled entry is never replaced', () => {
      const t = task({ home: 'Res FC', away: 'Olved FC' });
      claimedAndHandedOff(t, 'q-resolve');
      manager.addTask(task({ outcome: 'P9', home: 'Next FC', away: 'Other FC' }));
      expect(manager.resolveExecutionOutcome('q-resolve', { resolution: 'accepted', ticketId: 'B-5', evidence: 'late receipt', operator: 'consumer' }))
        .toMatchObject({ resolved: true });
      const settled = manager.read().history.find((h) => h.executionOutcome && h.executionOutcome.attemptKey === 'q-resolve');
      expect(settled).toMatchObject({ status: 'completed', ticketId: 'B-5' });
      // a later record of the same key (restart) must not overwrite what was settled
      const out = manager.recordExecutionOutcome(t.id, { status: 'unresolved', attemptKey: 'q-resolve', taskSnapshot: t });
      expect(out).toMatchObject({ recorded: false, already: true });
      expect(manager.read().history.find((h) => h.executionOutcome && h.executionOutcome.attemptKey === 'q-resolve').status).toBe('completed');
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
