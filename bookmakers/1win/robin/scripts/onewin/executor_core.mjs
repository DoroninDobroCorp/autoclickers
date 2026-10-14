// The executor side of the 1win route: accepts an order that was built and verified elsewhere,
// runs it in a browser under the transport guard, keeps the durable attempt and answers with the
// state of that attempt. It decides nothing about value: every condition was checked by the common
// engine before the order left the consumer, and the cart re-checks the plan at the point of no return.
//
// Contract: automation-executor.v1 (see executor_service.mjs for the HTTP wire). Ownership:
//   - one executor process owns one account's attempt store (owner lock with a heartbeat);
//   - one order at a time (one page, one placement in flight);
//   - an attempt that was left in a phase by a dead owner is resolved by recoverOrphans() and never
//     re-sent: before SUBMITTING -> WITHDRAWN (nothing could have left), SUBMITTING -> INDETERMINATE.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OneWinDryRunCart } from './browser_cart.mjs';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';
import { DEFAULT_BET_API_ORIGINS, TRANSPORT_GUARD_VERSION } from './transport_guard.mjs';

export const EXECUTOR_CONTRACT = 'automation-executor.v1';
export const ORDER_SCHEMA = 'automation-executor-order.v1';
export const REVISION_KINDS = new Set(['receipt_reconciled', 'reconciled_not_placed']);
const TERMINAL = new Set(['ACCEPTED', 'REJECTED', 'INDETERMINATE', 'WITHDRAWN']);
const OPEN = new Set(['CLAIMED', 'PRE_CHECK_PASSED', 'SUBMITTING']);

export class ExecutorError extends Error {
  constructor(code, message, status = 400, extra = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sameOrigins = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

// A single process may drive one account's store. A second one refuses to start while the first
// beats; a dead owner (no heartbeat) is taken over.
export class OwnerLock {
  constructor(lockPath, { heartbeatMs = 4000, staleMs = 20000 } = {}) {
    this.lockPath = lockPath;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.token = crypto.randomUUID();
    this.timer = null;
  }

  _body() {
    return JSON.stringify({ pid: process.pid, host: os.hostname(), token: this.token, started_at: this.startedAt, heartbeat_at: Date.now() });
  }

  _write(exclusive) {
    const fd = fs.openSync(this.lockPath, exclusive ? 'wx' : 'w', 0o600);
    try { fs.writeSync(fd, this._body()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  acquire() {
    this.startedAt = Date.now();
    for (let round = 0; round < 3; round += 1) {
      try {
        this._write(true);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { holder = null; }
        // a holder on this host whose process is gone is stale at once; otherwise it must keep beating
        let processGone = false;
        if (holder && holder.host === os.hostname() && Number.isInteger(holder.pid)) {
          try { process.kill(holder.pid, 0); } catch (killError) { processGone = killError.code === 'ESRCH'; }
        }
        const alive = holder && !processGone && Date.now() - Number(holder.heartbeat_at || 0) < this.staleMs;
        if (alive) throw new ExecutorError('EXECUTOR_ALREADY_RUNNING', `store is owned by pid ${holder.pid}`, 409);
        try { fs.unlinkSync(this.lockPath); } catch { /* raced */ }
        if (round === 2) throw new ExecutorError('EXECUTOR_LOCK_UNAVAILABLE', 'owner lock could not be taken', 500);
      }
    }
    this.timer = setInterval(() => { try { this._write(false); } catch { /* next beat */ } }, this.heartbeatMs);
    this.timer.unref?.();
  }

  release() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      const holder = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (holder.token === this.token) fs.unlinkSync(this.lockPath);
    } catch { /* gone */ }
  }
}

export class ExecutorCore {
  /**
   * @param {object} o
   * @param {string} o.storePath        durable attempt store of THIS account
   * @param {string[]} [o.betApiOrigins]  default: the production origin
   * @param {'dry'|'real'} [o.mode]     'real' still needs ONEWIN_AUTOMATION_LIVE_ENABLED=true (cart gate)
   * @param {() => Promise<{browser, close: () => Promise<any>, info?: object}>} o.browserFactory
   * @param {{collect: (request: object) => Promise<object>}} [o.evidenceProvider]
   * @param {() => number} [o.clock]    epoch seconds
   * @param {string|null} [o.siteOrigin]  only for a non-production environment: where the event page lives
   */
  constructor({ storePath, betApiOrigins = DEFAULT_BET_API_ORIGINS, mode = 'dry', browserFactory, evidenceProvider = null,
    clock = () => Date.now() / 1000, siteOrigin = null, maxBudgetUsdt = 1.0, diagnosticMode = true, contextOptions = {},
    log = () => {} } = {}) {
    if (!storePath) throw new Error('EXECUTOR_STORE_PATH_REQUIRED');
    if (!['dry', 'real'].includes(mode)) throw new Error('EXECUTOR_MODE_INVALID');
    if (typeof browserFactory !== 'function') throw new Error('EXECUTOR_BROWSER_FACTORY_REQUIRED');
    this.storePath = storePath;
    this.betApiOrigins = [...betApiOrigins];
    this.mode = mode;
    this.browserFactory = browserFactory;
    this.evidenceProvider = evidenceProvider;
    this.clock = clock;
    this.siteOrigin = siteOrigin;
    this.maxBudgetUsdt = maxBudgetUsdt;
    this.diagnosticMode = diagnosticMode;
    this.contextOptions = contextOptions;
    this.log = log;
    this.environment = sameOrigins(this.betApiOrigins, DEFAULT_BET_API_ORIGINS) ? 'production' : 'local_stand';
    if (this.siteOrigin && this.environment === 'production') throw new Error('SITE_ORIGIN_OVERRIDE_ONLY_OUTSIDE_PRODUCTION');
    this.store = null;
    this.lock = new OwnerLock(`${storePath}.executor.lock`);
    this.session = null;
    this.inFlight = new Map();
    this.lastRuns = new Map();
    this.startedAt = null;
    this.recovered = [];
  }

  async start() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    this.lock.acquire();
    try {
      this.store = new DurableAttemptStore(this.storePath, { maxStake: this.maxBudgetUsdt });
      if (this.store.isDurable !== true) throw new ExecutorError('STORE_NOT_DURABLE', 'attempt store is not durable', 500);
      this.recovered = await this.recoverOrphans({ reason: 'executor_start' });
    } catch (error) {
      this.lock.release();
      throw error;
    }
    this.startedAt = Date.now();
    return this.health();
  }

  async stop() {
    if (this.session) {
      try { await this.session.close(); } catch { /* closing */ }
      this.session = null;
    }
    this.lock.release();
  }

  provenance() {
    return {
      contract: EXECUTOR_CONTRACT,
      transport_environment: this.environment,
      bet_api_origins: [...this.betApiOrigins],
      guard_version: TRANSPORT_GUARD_VERSION,
      mode: this.mode,
      site_origin_override: this.siteOrigin,
    };
  }

  health() {
    return {
      contract: EXECUTOR_CONTRACT,
      mode: this.mode,
      transport_environment: this.environment,
      bet_api_origins: [...this.betApiOrigins],
      guard_version: TRANSPORT_GUARD_VERSION,
      live_gate_open: process.env.ONEWIN_AUTOMATION_LIVE_ENABLED === 'true',
      store: { durable: Boolean(this.store && this.store.isDurable), path_sha256: sha256(this.storePath).slice(0, 16) },
      in_flight: [...this.inFlight.keys()],
      started_at: this.startedAt,
      recovered_on_start: this.recovered,
      browser: this.session ? { version: this.session.info?.version || null } : null,
      evidence_provider: this.evidenceProvider ? (this.evidenceProvider.name || 'configured') : null,
    };
  }

  async _ensureSession() {
    if (this.session && this.session.browser && typeof this.session.browser.isConnected === 'function' && !this.session.browser.isConnected()) {
      try { await this.session.close(); } catch { /* dead */ }
      this.session = null;
    }
    if (!this.session) this.session = await this.browserFactory();
    return this.session;
  }

  // ------------------------------------------------------------------ evidence (read-only)
  async evidence(request) {
    if (!this.evidenceProvider) {
      return { available: false, reason: 'evidence_provider_not_configured', provenance: this.provenance() };
    }
    const result = await this.evidenceProvider.collect({ ...request, executor: this.provenance(), now: this.clock() });
    return { available: Boolean(result && result.executor_quote && result.account_state), ...result, provenance: this.provenance() };
  }

  // ------------------------------------------------------------------ attempts
  attempt(key) {
    const entry = this.store.getAttempt(key);
    const run = this.lastRuns.get(key) || null;
    return { attempt: entry, in_flight: this.inFlight.has(key), last_run: run, executor: this.provenance() };
  }

  listAttempts(filter = {}) {
    return this.store.listAttempts(filter);
  }

  async withdraw(key, reason = 'withdrawn') {
    const accepted = await this.store.requestWithdrawal(String(key), String(reason).slice(0, 200));
    return { requested: accepted, ...this.attempt(key) };
  }

  async addRevision(key, kind, data) {
    if (!REVISION_KINDS.has(kind)) throw new ExecutorError('REVISION_KIND_NOT_ALLOWED', `revision kind ${kind}`, 400);
    if (!isObject(data)) throw new ExecutorError('REVISION_DATA_INVALID', 'data object required', 400);
    const entry = this.store.getAttempt(key);
    if (!entry) throw new ExecutorError('UNKNOWN_ATTEMPT', 'no such attempt', 404);
    if (entry.status !== 'INDETERMINATE') throw new ExecutorError('REVISION_ONLY_FOR_INDETERMINATE', `attempt is ${entry.status}`, 409);
    // the same reconciliation twice is one revision, not two
    const same = (entry.revisions || []).find((r) => r.kind === kind && JSON.stringify(r.data) === JSON.stringify(data));
    if (same) return { seq: same.seq, duplicate: true, ...this.attempt(key) };
    const seq = await this.store.addRevision(key, { kind, data });
    return { seq, ...this.attempt(key) };
  }

  /**
   * Resolve attempts whose owner is gone. Never re-sends anything.
   *   CLAIMED / PRE_CHECK_PASSED -> WITHDRAWN   (SUBMITTING was never reached: nothing could have left)
   *   SUBMITTING                 -> INDETERMINATE (a request may have left: reconcile by identity)
   */
  async recoverOrphans({ reason = 'recover' } = {}) {
    const changed = [];
    for (const row of this.store.listAttempts({ statuses: [...OPEN] })) {
      if (this.inFlight.has(row.key)) continue;
      if (row.status === 'SUBMITTING') {
        await this.store.record(row.key, 'INDETERMINATE', { error: `OWNER_GONE_DURING_SUBMIT:${reason}` });
        changed.push({ key: row.key, from: 'SUBMITTING', to: 'INDETERMINATE', reason });
      } else {
        await this.store.record(row.key, 'WITHDRAWN', { error: `OWNER_GONE_BEFORE_SEND:${reason}` });
        changed.push({ key: row.key, from: row.status, to: 'WITHDRAWN', reason });
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ orders
  _validateEnvelope(envelope, expectedMode) {
    if (!isObject(envelope) || envelope.schema !== ORDER_SCHEMA) throw new ExecutorError('ORDER_SCHEMA_INVALID', `schema ${ORDER_SCHEMA} required`);
    if (envelope.mode !== expectedMode) throw new ExecutorError('ORDER_MODE_MISMATCH', `order mode ${envelope.mode}`, 409);
    const plan = envelope.plan;
    if (!isObject(plan) || typeof plan.idempotency_key !== 'string' || !plan.idempotency_key.trim()) {
      throw new ExecutorError('ORDER_PLAN_INVALID', 'plan with idempotency_key required');
    }
    if (!isObject(envelope.provenance) || typeof envelope.provenance.synthetic !== 'boolean') {
      throw new ExecutorError('ORDER_PROVENANCE_REQUIRED', 'provenance.synthetic (boolean) required');
    }
    if (!isObject(envelope.consumer) || typeof envelope.consumer.id !== 'string') {
      throw new ExecutorError('ORDER_CONSUMER_REQUIRED', 'consumer.id required');
    }
    return plan;
  }

  _planForRun(plan, envelope) {
    const run = JSON.parse(JSON.stringify(plan));
    // The executor states what IT is: nothing the order says about the environment is kept.
    run.provenance = { synthetic: envelope.provenance.synthetic, evidence_source: envelope.provenance.evidence_source || null };
    run.executor_provenance = this.provenance();
    run.consumer = { id: envelope.consumer.id };
    if (this.siteOrigin) {
      run.selection = { ...run.selection, event_url: `${this.siteOrigin}/betting/match/sport/${run.selection.event_id}` };
    }
    return run;
  }

  async _newPage() {
    const session = await this._ensureSession();
    const extra = typeof this.contextOptions === 'function' ? await this.contextOptions() : this.contextOptions;
    const context = await session.browser.newContext({ serviceWorkers: 'block', ignoreHTTPSErrors: this.environment !== 'production',
      ...extra });
    const page = await context.newPage();
    return { context, page };
  }

  /**
   * Hand a verified order to the executor. Returns at once; the attempt is followed through
   * attempt(key). A key that is already known is NOT executed again: its current state is returned.
   */
  async submitOrder(envelope) {
    if (this.mode !== 'real') throw new ExecutorError('EXECUTOR_NOT_LIVE', 'executor runs in dry mode', 409);
    if (process.env.ONEWIN_AUTOMATION_LIVE_ENABLED !== 'true') throw new ExecutorError('LIVE_GATE_CLOSED', 'live placement gate is closed', 409);
    const plan = this._validateEnvelope(envelope, 'real');
    const key = plan.idempotency_key.trim();
    const known = this.store.getAttempt(key);
    if (known || this.inFlight.has(key)) return { accepted: false, duplicate: true, key, ...this.attempt(key) };
    if (this.inFlight.size > 0) throw new ExecutorError('EXECUTOR_BUSY', 'another order is in flight', 409);
    const run = this._planForRun(plan, envelope);
    const entry = { started_at: Date.now(), key };
    const promise = this._execute(key, run).finally(() => { this.inFlight.delete(key); });
    entry.promise = promise;
    this.inFlight.set(key, entry);
    return { accepted: true, duplicate: false, key, ...this.attempt(key) };
  }

  async _execute(key, run) {
    const summary = { started_at: Date.now(), thrown: null, result: null };
    this.lastRuns.set(key, summary);
    let context = null;
    let cart = null;
    try {
      const made = await this._newPage();
      context = made.context;
      cart = new OneWinLiveCart(made.page, { attemptStore: this.store, liveEnabled: true, diagnosticMode: this.diagnosticMode,
        maxBudgetUsdt: this.maxBudgetUsdt, transportPolicy: { betApiOrigins: this.betApiOrigins } });
      const cancelled = async () => {
        const entry = this.store.getAttempt(key);
        return Boolean(entry && entry.withdrawal_requested);
      };
      const result = await cart.run(run, { now: this.clock, cancelled });
      summary.result = {
        status: result.status, ok: result.ok, error: result.error || null, stage: result.stage, submit_sent_count: result.submit_sent_count,
        blocked_reasons: result.blocked_reasons, rejection_code: result.rejection_code || null,
        durable_record_failed: result.durable_record_failed === true,
        coverage_ok: Boolean(result.transport_guard && result.transport_guard.coverage && Object.values(result.transport_guard.coverage).every(Boolean)),
      };
    } catch (error) {
      summary.thrown = String((error && error.message) || error).slice(0, 300);
    } finally {
      summary.finished_at = Date.now();
      // the placement is over: the next order does not wait for the browser context to be torn down
      this.inFlight.delete(key);
      try { if (cart && cart._guard) await cart._guard.dispose(); } catch { /* closing */ }
      try { if (context) await context.close(); } catch { /* closing */ }
    }
    // The truth is the durable attempt. An attempt that is still open here lost its owner thread.
    try {
      const entry = this.store.getAttempt(key);
      if (entry && OPEN.has(entry.status)) {
        await this.recoverOrphans({ reason: 'run_ended_without_terminal_state' });
      }
    } catch (error) {
      this.log({ event: 'post_run_recovery_failed', key, message: String(error && error.message).slice(0, 200) });
    }
    return summary;
  }

  /** Read-only preparation of the exact order in the browser; nothing can be placed (read-only guard). */
  async dryRun(envelope) {
    const plan = this._validateEnvelope(envelope, 'dry');
    if (this.inFlight.size > 0) throw new ExecutorError('EXECUTOR_BUSY', 'another order is in flight', 409);
    const run = this._planForRun(plan, envelope);
    run.ok = true;
    const token = `dry:${plan.idempotency_key}:${crypto.randomUUID()}`;
    this.inFlight.set(token, { started_at: Date.now(), key: token });
    let context = null;
    try {
      const made = await this._newPage();
      context = made.context;
      const cart = new OneWinDryRunCart(made.page, { transportPolicy: { betApiOrigins: this.betApiOrigins } });
      const result = await cart.run(run);
      return {
        key: plan.idempotency_key,
        dry_run: true,
        external_placement: false,
        result: {
          ok: result.ok === true, error: result.error || null, stage: result.stage, board_price: result.board_price ?? null,
          amount: result.amount ?? null, cart_cleared: result.cart_cleared === true,
          blocked_submit_requests: result.blocked_submit_requests, blocked_unknown_transport: result.blocked_unknown_transport,
          coverage_ok: Boolean(result.transport_coverage && Object.values(result.transport_coverage).every(Boolean)),
        },
        executor: this.provenance(),
      };
    } finally {
      this.inFlight.delete(token);
      try { if (context) await context.close(); } catch { /* closing */ }
    }
  }
}

export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}
