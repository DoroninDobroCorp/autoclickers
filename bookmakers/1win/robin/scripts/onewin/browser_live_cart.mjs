// Explicit single-attempt 1 USDT live cart executor with strict budget and duplicate guards.
// OneWinDryRunCart in browser_cart.mjs remains strictly read-only.
import { parseAmount, eventIdFromUrl } from './browser_cart.mjs';

export class InMemoryAttemptStore {
  constructor() { this.attempts = new Map(); }
  async claim(key, meta = {}) {
    const clean = String(key || '').trim();
    if (!clean || this.attempts.has(clean)) return false;
    this.attempts.set(clean, { status: 'CLAIMED', ...meta, claimed_at: Date.now() });
    return true;
  }
  async record(key, status, detail = {}) {
    const entry = this.attempts.get(key);
    if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
    const terminal = new Set(['ACCEPTED', 'REJECTED', 'INDETERMINATE', 'WITHDRAWN']);
    if (terminal.has(entry.status) && entry.status !== status) {
      throw new Error('TERMINAL_ATTEMPT_IMMUTABLE');
    }
    Object.assign(entry, { status, ...detail, updated_at: Date.now() });
    return entry;
  }
}

export class OneWinLiveCart {
  constructor(page, { attemptStore, liveEnabled = false, maxBudgetUsdt = 1.0 } = {}) {
    this.page = page;
    this.attemptStore = attemptStore || null;
    this.liveEnabled = Boolean(liveEnabled);
    this.maxBudgetUsdt = Number(maxBudgetUsdt);
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
      const path = new URL(request.url()).pathname;
      const isForbiddenMutation = /\/bets\/(?:refund|cashout|sell)(?:\/|$)/i.test(path);
      const isMakeBet = /\/bets\/make-bet-v2(?:\/|$)/i.test(path)
        || /(?:place.?bet|bet.?place|create.?bet|bets?\/create|bets?\/submit|wager)/i.test(path);
      if (request.method() === 'POST' && isForbiddenMutation) {
        this.blocked.push(path);
        return route.abort();
      }
      if (request.method() === 'POST' && isMakeBet) {
        if (!this.submitArmed || this.submitSentCount >= 1) {
          this.blocked.push(path);
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

  async run(plan, { now = () => Date.now() / 1000, screenshotPre, screenshotPost, cancelled = async () => false } = {}) {
    if (this.busy) throw new Error('ONEWIN_LIVE_CART_BUSY');
    if (!this.liveEnabled || process.env.ONEWIN_AUTOMATION_LIVE_ENABLED !== 'true') {
      throw new Error('LIVE_PLACEMENT_DISABLED');
    }
    if (!this.attemptStore || typeof this.attemptStore.claim !== 'function') {
      throw new Error('DURABLE_ATTEMPT_STORE_REQUIRED');
    }
    if (!plan?.ok || !plan.selection || !plan.ui_selection_name) {
      throw new Error('EXACT_PLAN_REQUIRED');
    }
    const idempotencyKey = String(plan.idempotency_key || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }
    const stake = Number(plan.stake);
    if (!Number.isFinite(stake) || stake !== 1 || stake > this.maxBudgetUsdt || this.maxBudgetUsdt > 1) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (plan.currency && plan.currency !== 'USDT') {
      throw new Error('UNSUPPORTED_CURRENCY');
    }
    if (plan.expected_axes) {
      const actualAxes = plan.selection.axes || {};
      for (const [k, v] of Object.entries(plan.expected_axes)) {
        if (actualAxes[k] !== v) throw new Error(`AXES_MISMATCH:${k}`);
      }
    }
    if (plan.expires_at !== undefined && now() >= Number(plan.expires_at)) {
      throw new Error('TASK_EXPIRED');
    }

    const selection = plan.selection;
    const url = new URL(selection.event_url);
    if (url.protocol !== 'https:' || url.hostname !== '1win.pro'
      || url.pathname !== `/betting/match/sport/${selection.event_id}`) {
      throw new Error('UNSAFE_EVENT_URL');
    }

    const claimed = await this.attemptStore.claim(idempotencyKey, {
      event_id: selection.event_id,
      selection_id: selection.selection_id,
      stake: 1,
      expected_odds: selection.price,
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
      stake: 1,
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
        if (!Number.isFinite(selection.price) || selection.price <= 1 || selection.price !== result.board_price) {
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
        await amount.pressSequentially('1');
        await amount.press('Tab');
        result.amount = parseAmount(await amount.inputValue());
        if (result.amount !== 1) throw new Error('AMOUNT_READBACK_MISMATCH');
        // Re-verify board price immediately before arming submit
        const title = this.page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({ has: this.page.getByText(plan.ui_selection_name, { exact: true }) });
        const recheckPrice = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (recheckPrice !== selection.price) throw new Error('PRICE_DRIFT_BEFORE_SUBMIT');
        if (plan.expires_at !== undefined && now() >= Number(plan.expires_at)) {
          throw new Error('TASK_EXPIRED_BEFORE_SUBMIT');
        }
        if (await cancelled()) throw new Error('CANCELLED');
        if (screenshotPre) await slip.screenshot({ path: screenshotPre });
      });

      await phase('submit_and_reconcile', async () => {
        const slip = this.slip();
        const submitBtn = slip.getByRole('button', { name: 'Place a bet', exact: true });
        if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
          throw new Error('SUBMIT_BUTTON_UNAVAILABLE');
        }
        const responsePromise = this.page.waitForResponse(
          res => /\/bets\/make-bet-v2(?:\/|$)/i.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
          { timeout: 15000 }
        );
        this.submitArmed = true;
        try {
          await submitBtn.click({ timeout: 5000 });
          const response = await responsePromise;
          const body = await response.json().catch(() => null);
          if (!body || typeof body !== 'object') {
            result.status = 'INDETERMINATE';
            await this.attemptStore.record?.(idempotencyKey, 'INDETERMINATE', { error: 'INVALID_RESPONSE_BODY' });
            throw new Error('PLACEMENT_INDETERMINATE');
          }
          if (Array.isArray(body.errors) && body.errors.length > 0) {
            const errCode = body.errors[0]?.code || 'UNKNOWN_BOOKMAKER_ERROR';
            result.status = 'REJECTED';
            result.rejection_code = errCode;
            result.rejection_meta = body.errors[0]?.meta || null;
            await this.attemptStore.record?.(idempotencyKey, 'REJECTED', { error: errCode });
            throw new Error(`BOOKMAKER_REJECTED:${errCode}`);
          }
          const success = body.result?.success;
          if (!success || !success.betId) {
            result.status = 'INDETERMINATE';
            await this.attemptStore.record?.(idempotencyKey, 'INDETERMINATE', { error: 'MISSING_BET_ID' });
            throw new Error('PLACEMENT_INDETERMINATE');
          }
          result.status = 'ACCEPTED';
          result.ok = true;
          result.receipt = {
            bet_id: String(success.betId),
            accepted_cf: Number(success.cf),
            amount: Number(success.amount),
            currency: String(success.currencyCode || 'USDT'),
            possible_profit_amount: Number(success.possibleProfitAmount),
          };
          await this.attemptStore.record?.(idempotencyKey, 'ACCEPTED', { receipt: result.receipt });
          if (screenshotPost) await this.page.screenshot({ path: screenshotPost });
        } catch (err) {
          this.submitArmed = false;
          if (result.status !== 'REJECTED' && result.status !== 'INDETERMINATE' && this.submitSentCount > 0) {
            result.status = 'INDETERMINATE';
            await this.attemptStore.record?.(idempotencyKey, 'INDETERMINATE', { error: String(err.message || err) });
          }
          throw err;
        }
      });
    } catch (error) {
      if (result.status === 'INITIATED') {
        result.status = 'ABORTED_PRE_SUBMIT';
        await this.attemptStore.record?.(idempotencyKey, 'WITHDRAWN', { error: String(error.message || error) }).catch(() => {});
      }
      result.error = String(error.message || error).slice(0, 600);
    } finally {
      this.submitArmed = false;
      try { result.cart_cleared = await phase('cleanup', () => this.clear()); }
      catch (cleanupError) { result.cleanup_error = String(cleanupError.message || cleanupError).slice(0, 400); }
      result.elapsed_ms = Math.round(performance.now() - started);
      result.submit_sent_count = this.submitSentCount;
      result.blocked_submit_requests = this.blocked.length;
      this.busy = false;
    }
    return result;
  }
}
