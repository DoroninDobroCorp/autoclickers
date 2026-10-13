// Explicit live cart executor with durable disk attempt store, strict condition checks, and receipt verification.
// OneWinDryRunCart in browser_cart.mjs remains strictly read-only.
import fs from 'node:fs';
import path from 'node:path';
import { parseAmount, eventIdFromUrl } from './browser_cart.mjs';

const TERMINAL_STATUSES = new Set(['ACCEPTED', 'REJECTED', 'INDETERMINATE', 'WITHDRAWN']);
const VALID_STATUSES = new Set(['CLAIMED', 'PRE_CHECK_PASSED', 'SUBMITTING', ...TERMINAL_STATUSES]);
const GUESSED_UNITS = new Set(['', 'unknown', 'unverified', 'match_base_unit', 'unverified_from_dom_only', 'guessed']);
const REQUIRED_AXIS_KEYS = ['period', 'scope', 'unit', 'market', 'side'];
const KNOWN_REJECTIONS = new Set([
  'not_enough_funds', 'zero_bet', 'odd_closed', 'odd_not_found',
  'currency_not_supported', 'odd_cf_changed', 'min_bet_amount',
  'min_bet_amount_v2', 'max_bet_amount', 'max_bet_amount_v2',
  'events_bet_limit_reached', 'express_not_enough_outcomes',
  'freebet_not_found', 'express_not_allowed', 'freebet_cf_limit',
  'freebet_not_valid_currency', 'validation_error', 'bad_request_error',
]);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export class InMemoryAttemptStore {
  constructor() {
    this.isDurable = false;
    this.attempts = new Map();
  }
  async claim(key, meta = {}) {
    const clean = String(key || '').trim();
    if (!clean || this.attempts.has(clean)) return false;
    this.attempts.set(clean, { status: 'CLAIMED', ...meta, claimed_at: Date.now() });
    return true;
  }
  async record(key, status, detail = {}) {
    const entry = this.attempts.get(key);
    if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
    if (TERMINAL_STATUSES.has(entry.status) && entry.status !== status) {
      throw new Error('TERMINAL_ATTEMPT_IMMUTABLE');
    }
    Object.assign(entry, { status, ...detail, updated_at: Date.now() });
    return entry;
  }
  getAttempt(key) {
    return this.attempts.get(key) || null;
  }
}

export class DurableAttemptStore {
  constructor(filePath, { maxStake = null } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('DURABLE_STORE_PATH_REQUIRED');
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.maxStake = maxStake !== null && maxStake !== undefined ? Number(maxStake) : null;
    if (this.maxStake !== null && (!Number.isFinite(this.maxStake) || this.maxStake <= 0)) {
      throw new Error('INVALID_MAX_STAKE');
    }
    this.isDurable = false;
    this._initOnDisk();
    this.isDurable = true;
  }

  _acquireLock(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`, 'utf8');
        fs.fsyncSync(fd);
        return fd;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > 15000) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {}
        if (Date.now() >= deadline) {
          throw new Error('DURABLE_STORE_LOCK_TIMEOUT');
        }
        // Busy wait 5ms using Atomics.wait on a shared buffer
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  _releaseLock(fd) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(this.lockPath); } catch {}
  }

  _withLock(fn) {
    const fd = this._acquireLock();
    try {
      return fn();
    } finally {
      this._releaseLock(fd);
    }
  }

  _readDataUnlocked() {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, attempts: {} };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return { version: 1, attempts: {} };
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.attempts)) {
      throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE');
    }
    return parsed;
  }

  _writeDataUnlocked(data) {
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const raw = JSON.stringify(data, null, 2) + '\n';
    const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, raw, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  _initOnDisk() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this._withLock(() => {
      const data = this._readDataUnlocked();
      this._writeDataUnlocked(data);
      const readback = this._readDataUnlocked();
      if (!isPlainObject(readback.attempts)) {
        throw new Error('DURABLE_STORE_READBACK_FAILED');
      }
    });
  }

  async claim(key, { stake, currency = 'USDT', payload = null, maxStake = null } = {}) {
    if (typeof key !== 'string' || !key.trim() || key.trim().length > 128) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }
    const cleanKey = key.trim();
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
      throw new Error('INVALID_STAKE');
    }
    const limit = maxStake !== null && maxStake !== undefined ? Number(maxStake) : this.maxStake;
    if (limit !== null && stake > limit) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3,6}$/.test(currency.trim().toUpperCase())) {
      throw new Error('UNSUPPORTED_CURRENCY');
    }
    const cleanCurrency = currency.trim().toUpperCase();
    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      throw new Error('VALID_PAYLOAD_REQUIRED');
    }
    if (payload.idempotency_key !== undefined && String(payload.idempotency_key).trim() !== cleanKey) {
      throw new Error('PAYLOAD_KEY_MISMATCH');
    }
    if (payload.stake !== undefined && (typeof payload.stake !== 'number' || Math.abs(payload.stake - stake) > 1e-9)) {
      throw new Error('PAYLOAD_STAKE_MISMATCH');
    }
    if (payload.currency !== undefined && String(payload.currency).trim().toUpperCase() !== cleanCurrency) {
      throw new Error('PAYLOAD_CURRENCY_MISMATCH');
    }

    const sel = isPlainObject(payload.selection) ? payload.selection : {};
    const eventId = String(payload.event_id || sel.event_id || '') || null;
    const marketId = String(payload.market_id || sel.market_id || '') || null;
    const selectionId = String(payload.selection_id || sel.selection_id || '') || null;
    const rawOdds = payload.expected_odds ?? payload.odds ?? sel.price;
    const expectedOdds = typeof rawOdds === 'number' && Number.isFinite(rawOdds) ? rawOdds : null;

    return this._withLock(() => {
      const data = this._readDataUnlocked();
      if (Object.prototype.hasOwnProperty.call(data.attempts, cleanKey)) {
        return false;
      }
      const now = Date.now();
      data.attempts[cleanKey] = {
        key: cleanKey,
        status: 'CLAIMED',
        stake,
        currency: cleanCurrency,
        event_id: eventId,
        market_id: marketId,
        selection_id: selectionId,
        expected_odds: expectedOdds,
        payload: JSON.parse(JSON.stringify(payload)),
        receipt: null,
        error: null,
        condition_mismatches: [],
        created_at: now,
        updated_at: now,
      };
      this._writeDataUnlocked(data);
      return true;
    });
  }

  async record(key, status, { receipt = null, error = null, condition_mismatches = null } = {}) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('UNKNOWN_ATTEMPT_KEY');
    }
    const cleanKey = key.trim();
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`INVALID_ATTEMPT_STATUS:${status}`);
    }
    return this._withLock(() => {
      const data = this._readDataUnlocked();
      const entry = data.attempts[cleanKey];
      if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
      if (TERMINAL_STATUSES.has(entry.status) && entry.status !== status) {
        throw new Error('TERMINAL_ATTEMPT_IMMUTABLE');
      }
      entry.status = status;
      if (receipt !== null && receipt !== undefined) {
        entry.receipt = JSON.parse(JSON.stringify(receipt));
      }
      if (error !== null && error !== undefined) {
        entry.error = String(error);
      }
      if (Array.isArray(condition_mismatches)) {
        entry.condition_mismatches = [...condition_mismatches];
      }
      entry.updated_at = Date.now();
      this._writeDataUnlocked(data);
      return JSON.parse(JSON.stringify(entry));
    });
  }

  getAttempt(key) {
    if (typeof key !== 'string' || !key.trim()) return null;
    const cleanKey = key.trim();
    return this._withLock(() => {
      const data = this._readDataUnlocked();
      const entry = data.attempts[cleanKey];
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    });
  }

  close() {}
}

export class OneWinLiveCart {
  constructor(page, { attemptStore, liveEnabled = false, maxBudgetUsdt = 1.0, diagnosticMode = true } = {}) {
    this.page = page;
    this.attemptStore = attemptStore || null;
    this.liveEnabled = Boolean(liveEnabled);
    this.maxBudgetUsdt = Number(maxBudgetUsdt);
    this.diagnosticMode = Boolean(diagnosticMode);
    if (!Number.isFinite(this.maxBudgetUsdt) || this.maxBudgetUsdt <= 0) {
      throw new Error('INVALID_MAX_BUDGET');
    }
    if (this.liveEnabled) {
      if (
        !this.attemptStore ||
        !(this.attemptStore instanceof DurableAttemptStore) ||
        this.attemptStore.isDurable !== true ||
        typeof this.attemptStore.claim !== 'function' ||
        typeof this.attemptStore.record !== 'function'
      ) {
        throw new Error('DURABLE_ATTEMPT_STORE_REQUIRED');
      }
    }
    this.busy = false;
    this.guarded = false;
    this.submitArmed = false;
    this.submitSentCount = 0;
    this.blocked = [];
  }

  async installGuard() {
    if (this.guarded) return;
    this.guarded = true;
    await this.page.route('**/*', async route => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const isForbiddenMutation = /\/bets\/(?:refund|cashout|sell)(?:\/|$)/i.test(pathName);
      const isMakeBet = /\/bets\/make-bet-v2(?:\/|$)/i.test(pathName)
        || /(?:place.?bet|bet.?place|create.?bet|bets?\/create|bets?\/submit|wager)/i.test(pathName);
      if (request.method() === 'POST' && isForbiddenMutation) {
        this.blocked.push(pathName);
        return route.abort();
      }
      if (request.method() === 'POST' && isMakeBet) {
        if (!this.submitArmed || this.submitSentCount >= 1) {
          this.blocked.push(pathName);
          return route.abort();
        }
        // Single-shot consumption: disarm immediately before forwarding
        this.submitArmed = false;
        this.submitSentCount += 1;
        return route.fallback();
      }
      return route.fallback();
    });
  }

  slip() {
    return this.page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');
  }

  async clear() {
    const slip = this.slip();
    const empty = slip.getByText('Select an outcome', { exact: false });
    if (await empty.isVisible()) return true;
    const trash = slip.getByRole('button').filter({ has: this.page.locator('[style*="trash.svg"]') });
    if (await trash.count() === 1 && await trash.isVisible()) await trash.click({ timeout: 5000 });
    await empty.waitFor({ state: 'visible', timeout: 8000 });
    return true;
  }

  _validateLivePlan(plan, nowFn) {
    if (!isPlainObject(plan) || !isPlainObject(plan.selection) || typeof plan.ui_selection_name !== 'string' || !plan.ui_selection_name.trim()) {
      throw new Error('EXACT_PLAN_REQUIRED');
    }
    if (plan.execution_ready !== true || (Array.isArray(plan.execution_blockers) && plan.execution_blockers.length > 0)) {
      throw new Error('EXECUTION_NOT_READY');
    }
    const idempotencyKey = typeof plan.idempotency_key === 'string' ? plan.idempotency_key.trim() : '';
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }

    const currentNow = nowFn();
    if (typeof currentNow !== 'number' || !Number.isFinite(currentNow) || currentNow <= 0) {
      throw new Error('INVALID_CLOCK');
    }
    const expiresAt = plan.expires_at;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      throw new Error('EXPIRES_AT_REQUIRED');
    }
    if (currentNow >= expiresAt) {
      throw new Error('TASK_EXPIRED');
    }

    if (typeof plan.currency !== 'string' || plan.currency.trim() !== 'USDT') {
      throw new Error('UNSUPPORTED_CURRENCY');
    }

    const stake = plan.stake;
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (this.diagnosticMode && (stake !== 1 || this.maxBudgetUsdt > 1)) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (stake > this.maxBudgetUsdt) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }

    // Validate expected_axes and selection.axes
    const expectedAxes = plan.expected_axes;
    const selectionAxes = plan.selection.axes;
    if (!isPlainObject(expectedAxes) || !isPlainObject(selectionAxes)) {
      throw new Error('AXES_REQUIRED');
    }
    for (const reqKey of REQUIRED_AXIS_KEYS) {
      if (typeof expectedAxes[reqKey] !== 'string' || !expectedAxes[reqKey].trim()) {
        throw new Error(`AXES_INCOMPLETE:${reqKey}`);
      }
      if (typeof selectionAxes[reqKey] !== 'string' || !selectionAxes[reqKey].trim()) {
        throw new Error(`AXES_INCOMPLETE:${reqKey}`);
      }
    }
    const expUnit = expectedAxes.unit.trim().toLowerCase();
    const selUnit = selectionAxes.unit.trim().toLowerCase();
    if (GUESSED_UNITS.has(expUnit) || GUESSED_UNITS.has(selUnit)) {
      throw new Error('UNVERIFIED_AXES_UNIT');
    }
    const expKeys = Object.keys(expectedAxes).sort();
    const selKeys = Object.keys(selectionAxes).sort();
    if (expKeys.length !== selKeys.length || !expKeys.every((k, i) => k === selKeys[i])) {
      throw new Error('AXES_MISMATCH:keys');
    }
    for (const k of expKeys) {
      if (expectedAxes[k] !== selectionAxes[k]) {
        throw new Error(`AXES_MISMATCH:${k}`);
      }
    }

    // Validate account and execution conditions
    const acct = plan.account_conditions;
    if (!isPlainObject(acct)) {
      throw new Error('ACCOUNT_CONDITIONS_REQUIRED');
    }
    if (acct.logged_in !== true) {
      throw new Error('ACCOUNT_NOT_LOGGED_IN');
    }
    if (acct.account_identity_verified !== true) {
      throw new Error('ACCOUNT_IDENTITY_UNVERIFIED');
    }
    if (acct.currency !== 'USDT') {
      throw new Error('ACCOUNT_CURRENCY_MISMATCH');
    }
    if (typeof acct.available_balance !== 'number' || !Number.isFinite(acct.available_balance) || acct.available_balance < stake) {
      throw new Error('INSUFFICIENT_WALLET_BALANCE');
    }
    if (typeof acct.commission !== 'number' || !Number.isFinite(acct.commission) || acct.commission < 0 || acct.commission >= 1) {
      throw new Error('UNVERIFIED_COMMISSION');
    }
    if (typeof acct.max_stake !== 'number' || !Number.isFinite(acct.max_stake) || acct.max_stake < stake) {
      throw new Error('INSUFFICIENT_CAPACITY');
    }

    // Validate selection identity fields
    const selection = plan.selection;
    if (
      typeof selection.event_id !== 'string' || !/^\d+$/.test(selection.event_id) ||
      typeof selection.market_id !== 'string' || !selection.market_id.trim() ||
      typeof selection.selection_id !== 'string' || !/^\d+:\d+:\d+$/.test(selection.selection_id) ||
      typeof selection.market_name !== 'string' || !selection.market_name.trim() ||
      typeof selection.price !== 'number' || !Number.isFinite(selection.price) || selection.price <= 1
    ) {
      throw new Error('EXACT_SELECTION_IDENTITY_REQUIRED');
    }

    let url;
    try {
      url = new URL(selection.event_url);
    } catch {
      throw new Error('UNSAFE_EVENT_URL');
    }
    if (url.protocol !== 'https:' || url.hostname !== '1win.pro'
      || url.pathname !== `/betting/match/sport/${selection.event_id}`) {
      throw new Error('UNSAFE_EVENT_URL');
    }

    return { idempotencyKey, stake, expiresAt, selection };
  }

  async run(plan, { now = () => Date.now() / 1000, screenshotPre, screenshotPost, cancelled = async () => false } = {}) {
    if (this.busy) throw new Error('ONEWIN_LIVE_CART_BUSY');
    if (!this.liveEnabled || process.env.ONEWIN_AUTOMATION_LIVE_ENABLED !== 'true') {
      throw new Error('LIVE_PLACEMENT_DISABLED');
    }
    if (
      !this.attemptStore ||
      !(this.attemptStore instanceof DurableAttemptStore) ||
      this.attemptStore.isDurable !== true ||
      typeof this.attemptStore.claim !== 'function' ||
      typeof this.attemptStore.record !== 'function'
    ) {
      throw new Error('DURABLE_ATTEMPT_STORE_REQUIRED');
    }

    const { idempotencyKey, stake, expiresAt, selection } = this._validateLivePlan(plan, now);

    const claimed = await this.attemptStore.claim(idempotencyKey, {
      stake,
      currency: 'USDT',
      payload: plan,
      maxStake: this.maxBudgetUsdt,
    });
    if (!claimed) {
      throw new Error('DUPLICATE_IDEMPOTENCY_KEY');
    }

    this.busy = true;
    const started = performance.now();
    const result = {
      ok: false,
      dry_run: false,
      live: true,
      idempotency_key: idempotencyKey,
      status: 'INITIATED',
      cart_cleared: false,
      event_id: selection.event_id,
      market_id: selection.market_id,
      selection_id: selection.selection_id,
      market: selection.market_name,
      selection: plan.ui_selection_name,
      stake,
      currency: 'USDT',
      phases: {},
    };

    const phase = async (name, action) => {
      result.stage = name;
      const start = performance.now();
      try { return await action(); } finally { result.phases[name] = Math.round(performance.now() - start); }
    };

    try {
      await this.installGuard();
      if (await cancelled()) throw new Error('CANCELLED');

      await phase('navigation', async () => {
        if (eventIdFromUrl(this.page.url()) !== selection.event_id) {
          await this.page.goto(selection.event_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        await this.slip().getByText('Betslip', { exact: true }).waitFor({ timeout: 10000 });
      });

      await phase('initial_cleanup', () => this.clear());
      if (await cancelled()) throw new Error('CANCELLED');

      await phase('exact_selection', async () => {
        const title = this.page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({ has: this.page.getByText(plan.ui_selection_name, { exact: true }) });
        await button.first().waitFor({ state: 'visible', timeout: 8000 });
        if (await button.count() !== 1) throw new Error('AMBIGUOUS_EXACT_OUTCOME');
        result.market_title_candidates = await group.count();
        result.board_price = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (!(result.board_price > 1)) throw new Error('INVALID_BOARD_PRICE');
        if (Math.abs(selection.price - result.board_price) > 1e-9) {
          throw new Error('BOARD_PRICE_CHANGED');
        }
        await button.click({ timeout: 5000 });
      });

      await phase('basket_readback', async () => {
        const slip = this.slip();
        const expected = `${selection.market_name}, ${plan.ui_selection_name}`;
        await slip.getByText(expected, { exact: true }).waitFor({ timeout: 5000 });
        const amount = slip.locator('input[data-qa="amount"]:visible');
        await amount.click();
        await amount.press('ControlOrMeta+A');
        await amount.press('Backspace');
        await amount.pressSequentially(String(stake));
        await amount.press('Tab');
        result.amount = parseAmount(await amount.inputValue());
        if (result.amount === null || Math.abs(result.amount - stake) > 1e-9) {
          throw new Error('AMOUNT_READBACK_MISMATCH');
        }
        const title = this.page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({ has: this.page.getByText(plan.ui_selection_name, { exact: true }) });
        const recheckPrice = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (recheckPrice === null || Math.abs(recheckPrice - selection.price) > 1e-9) {
          throw new Error('PRICE_DRIFT_BEFORE_SUBMIT');
        }
        const submitNow = now();
        if (typeof submitNow !== 'number' || !Number.isFinite(submitNow) || submitNow >= expiresAt) {
          throw new Error('TASK_EXPIRED_BEFORE_SUBMIT');
        }
        if (await cancelled()) throw new Error('CANCELLED');
        await this.attemptStore.record(idempotencyKey, 'PRE_CHECK_PASSED');
        if (screenshotPre) await slip.screenshot({ path: screenshotPre });
      });

      await phase('submit_and_reconcile', async () => {
        const slip = this.slip();
        const submitBtn = slip.getByRole('button', { name: 'Place a bet', exact: true });
        if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
          throw new Error('SUBMIT_BUTTON_UNAVAILABLE');
        }
        await this.attemptStore.record(idempotencyKey, 'SUBMITTING');
        const responsePromise = this.page.waitForResponse(
          res => /\/bets\/make-bet-v2(?:\/|$)/i.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
          { timeout: 15000 }
        );
        this.submitArmed = true;
        let response;
        try {
          await submitBtn.click({ timeout: 5000 });
          response = await responsePromise;
        } catch (sendErr) {
          this.submitArmed = false;
          result.status = 'INDETERMINATE';
          await this.attemptStore.record(idempotencyKey, 'INDETERMINATE', { error: String(sendErr.message || sendErr) });
          throw sendErr;
        }
        this.submitArmed = false;

        const body = await response.json().catch(() => null);
        if (!isPlainObject(body)) {
          result.status = 'INDETERMINATE';
          await this.attemptStore.record(idempotencyKey, 'INDETERMINATE', { error: 'INVALID_RESPONSE_BODY' });
          throw new Error('PLACEMENT_INDETERMINATE:INVALID_RESPONSE_BODY');
        }

        if (Array.isArray(body.errors) && body.errors.length > 0) {
          const errObj = isPlainObject(body.errors[0]) ? body.errors[0] : {};
          const errCode = typeof errObj.code === 'string' && errObj.code.trim() ? errObj.code.trim() : '';
          if (errCode && KNOWN_REJECTIONS.has(errCode)) {
            result.status = 'REJECTED';
            result.rejection_code = errCode;
            result.rejection_meta = errObj.meta || null;
            await this.attemptStore.record(idempotencyKey, 'REJECTED', { error: errCode, receipt: body });
            throw new Error(`BOOKMAKER_REJECTED:${errCode}`);
          }
          const indCode = errCode || 'UNKNOWN_ERROR_CODE';
          result.status = 'INDETERMINATE';
          await this.attemptStore.record(idempotencyKey, 'INDETERMINATE', { error: indCode, receipt: body });
          throw new Error(`PLACEMENT_INDETERMINATE:${indCode}`);
        }

        const success = isPlainObject(body.result) && isPlainObject(body.result.success) ? body.result.success : null;
        const rawBetId = success?.betId;
        const validBetId = (typeof rawBetId === 'number' && Number.isFinite(rawBetId) && rawBetId > 0)
          || (typeof rawBetId === 'string' && rawBetId.trim().length > 0);
        if (!success || !validBetId) {
          result.status = 'INDETERMINATE';
          await this.attemptStore.record(idempotencyKey, 'INDETERMINATE', { error: 'MISSING_BET_ID', receipt: body });
          throw new Error('PLACEMENT_INDETERMINATE:MISSING_BET_ID');
        }

        // Bet was accepted by bookmaker: validate fields and persist receipt immediately
        const rawCf = success.cf;
        const acceptedCf = typeof rawCf !== 'boolean' && rawCf !== null && rawCf !== undefined ? Number(rawCf) : Number.NaN;
        const rawAmount = success.amount;
        const acceptedAmount = typeof rawAmount !== 'boolean' && rawAmount !== null && rawAmount !== undefined ? Number(rawAmount) : Number.NaN;
        const acceptedCurrency = typeof success.currencyCode === 'string' ? success.currencyCode.trim().toUpperCase() : '';
        const rawProfit = success.possibleProfitAmount;
        const possibleProfitAmount = typeof rawProfit !== 'boolean' && rawProfit !== null && rawProfit !== undefined && Number.isFinite(Number(rawProfit))
          ? Number(rawProfit)
          : null;
        const rejectedAmount = typeof success.rejectedAmount === 'number' && Number.isFinite(success.rejectedAmount)
          ? success.rejectedAmount
          : 0;

        const mismatches = [];
        if (!Number.isFinite(acceptedCf) || acceptedCf <= 1) {
          mismatches.push('invalid_accepted_cf');
        } else if (Math.abs(acceptedCf - selection.price) > 1e-9) {
          mismatches.push('accepted_cf_mismatch');
        }
        if (!Number.isFinite(acceptedAmount) || acceptedAmount <= 0) {
          mismatches.push('invalid_accepted_amount');
        } else if (Math.abs(acceptedAmount - stake) > 1e-9) {
          mismatches.push('accepted_amount_mismatch');
        }
        if (!acceptedCurrency) {
          mismatches.push('missing_accepted_currency');
        } else if (acceptedCurrency !== plan.currency) {
          mismatches.push('accepted_currency_mismatch');
        }
        if (rejectedAmount > 0) {
          mismatches.push('partial_rejection_amount');
        }

        result.receipt = {
          bet_id: String(rawBetId).trim(),
          accepted_cf: Number.isFinite(acceptedCf) ? acceptedCf : null,
          amount: Number.isFinite(acceptedAmount) ? acceptedAmount : null,
          currency: acceptedCurrency || null,
          possible_profit_amount: possibleProfitAmount,
          rejected_amount: rejectedAmount,
          condition_mismatch: mismatches.length > 0,
          condition_mismatches: mismatches,
          raw_success: success,
        };
        result.status = 'ACCEPTED';
        result.condition_mismatch = mismatches.length > 0;
        result.condition_mismatches = mismatches;
        result.ok = mismatches.length === 0;
        if (mismatches.length > 0) {
          result.error = `ACCEPTED_CONDITION_MISMATCH:${mismatches.join(',')}`;
        }

        await this.attemptStore.record(idempotencyKey, 'ACCEPTED', {
          receipt: result.receipt,
          condition_mismatches: mismatches,
          error: result.error || null,
        });

        // Post-bet screenshot failure must never invalidate or overwrite a confirmed ACCEPTED receipt
        if (screenshotPost) {
          try {
            await this.page.screenshot({ path: screenshotPost });
          } catch (shotErr) {
            result.screenshot_post_error = String(shotErr.message || shotErr).slice(0, 300);
          }
        }
      });
    } catch (error) {
      this.submitArmed = false;
      if (result.status !== 'ACCEPTED' && result.status !== 'REJECTED' && result.status !== 'INDETERMINATE') {
        if (this.submitSentCount > 0) {
          result.status = 'INDETERMINATE';
          await this.attemptStore.record(idempotencyKey, 'INDETERMINATE', { error: String(error.message || error) }).catch(() => {});
        } else {
          result.status = 'ABORTED_PRE_SUBMIT';
          await this.attemptStore.record(idempotencyKey, 'WITHDRAWN', { error: String(error.message || error) }).catch(() => {});
        }
      }
      if (!result.error) {
        result.error = String(error.message || error).slice(0, 600);
      }
    } finally {
      this.submitArmed = false;
      const terminalReached = result.status === 'ACCEPTED' || result.status === 'REJECTED' || result.status === 'INDETERMINATE';
      const failedStage = result.stage;
      try {
        result.cart_cleared = await phase('cleanup', () => this.clear());
      } catch (cleanupError) {
        result.cleanup_error = String(cleanupError.message || cleanupError).slice(0, 400);
        if (result.status !== 'ACCEPTED') {
          result.ok = false;
        }
      }
      if (!terminalReached && result.error) {
        result.stage = failedStage;
      } else if (result.status === 'ACCEPTED') {
        result.stage = 'completed';
      }
      result.elapsed_ms = Math.round(performance.now() - started);
      result.submit_sent_count = this.submitSentCount;
      result.blocked_submit_requests = this.blocked.length;
      this.busy = false;
    }
    return result;
  }
}
