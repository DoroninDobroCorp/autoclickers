import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { OneWinLiveCart, InMemoryAttemptStore } from './browser_live_cart.mjs';

const defaultChrome = '/home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const executablePath = process.env.ONEWIN_TEST_CHROMIUM || (fs.existsSync(defaultChrome) ? defaultChrome : undefined);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });

const basePlan = {
  ok: true,
  idempotency_key: 'live-test-key-1',
  stake: 1,
  currency: 'USDT',
  expires_at: 2000,
  selection: {
    event_id: '40021999',
    event_url: 'https://1win.pro/betting/match/sport/40021999',
    market_id: '6271',
    market_name: 'Total',
    selection_id: '10:193671744120169820:0',
    price: 1.87,
  },
  ui_selection_name: 'Under 60.5',
};

function group(label, price = '1.87', title = 'Total') {
  return `<div data-scope="ListGroup"><h2>${title}</h2><button onclick="pick()"><span class="_name_">${label}</span><span class="_cf_">${price}</span></button></div>`;
}

function html(groups, { driftOnInput = false } = {}) {
  return `<html><body>${groups}<aside><h2>Betslip</h2><div id="coupon">Select an outcome</div></aside>
  <script>
    window.selectionClicks = 0;
    window.submitClicks = 0;
    window.pick = () => {
      window.selectionClicks++;
      document.querySelector('#coupon').innerHTML =
        '<span>Total, Under 60.5</span>' +
        '<input data-qa="amount" value="10">' +
        '<button onclick="submitBet()">Place a bet</button>' +
        '<button onclick="clearCoupon()"><span style="--icon:trash.svg">delete</span></button>';
      if (${driftOnInput ? 'true' : 'false'}) {
        const input = document.querySelector('input[data-qa="amount"]');
        input.addEventListener('blur', () => {
          const cf = document.querySelector('span._cf_');
          if (cf) cf.textContent = '1.75';
        });
      }
    };
    window.submitBet = () => {
      window.submitClicks++;
      fetch('https://api-gateway.top-parser.com/bets/make-bet-v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1 })
      }).catch(() => {});
    };
    window.clearCoupon = () => {
      document.querySelector('#coupon').textContent = 'Select an outcome';
    };
  </script></body></html>`;
}

try {
  // 1. Rejects when liveEnabled is false or env var not set
  {
    delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    await assert.rejects(() => cart.run(basePlan, { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);
    process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
    const disabledCart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: false });
    await assert.rejects(() => disabledCart.run(basePlan, { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);
    await context.close();
  }

  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';

  // 2. Rejects budget > 1 USDT or invalid stake (e.g. 9999 or 2 or 0)
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    for (const badStake of [0, 0.5, 2, 10, 9999]) {
      await assert.rejects(
        () => cart.run({ ...basePlan, idempotency_key: `stake-${badStake}`, stake: badStake }, { now: () => 1000 }),
        /STAKE_BUDGET_VIOLATION/
      );
    }
    await context.close();
  }

  // 3. Rejects expired task before navigation
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    await assert.rejects(
      () => cart.run(basePlan, { now: () => 2001 }),
      /TASK_EXPIRED/
    );
    await context.close();
  }

  // 4. Rejects price drift on board or right before submit without sending POST
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let makeBetPosts = 0;
    await page.route('**/*', route => {
      if (route.request().url().includes('make-bet-v2')) {
        makeBetPosts++;
        return route.abort();
      }
      return route.fulfill({ contentType: 'text/html', body: html(group('Under 60.5', '1.87'), { driftOnInput: true }) });
    });
    await page.goto(basePlan.selection.event_url);
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    const res = await cart.run({ ...basePlan, idempotency_key: 'drift-before-submit' }, { now: () => 1000 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'ABORTED_PRE_SUBMIT');
    assert.match(res.error, /PRICE_DRIFT_BEFORE_SUBMIT/);
    assert.equal(makeBetPosts, 0, 'drifted price before submit must never send make-bet-v2');
    assert.equal(res.cart_cleared, true);
    await context.close();
  }

  // 5. Bookmaker rejection recorded as REJECTED and duplicate replay blocked
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let makeBetPosts = 0;
    await page.route('**/*', route => {
      if (route.request().url().includes('make-bet-v2')) {
        makeBetPosts++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ errors: [{ code: 'max_bet_amount', meta: { maxBetAmount: 0.5 } }] }),
        });
      }
      return route.fulfill({ contentType: 'text/html', body: html(group('Under 60.5', '1.87')) });
    });
    await page.goto(basePlan.selection.event_url);
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    const res = await cart.run({ ...basePlan, idempotency_key: 'reject-key-1' }, { now: () => 1000 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'REJECTED');
    assert.equal(res.rejection_code, 'max_bet_amount');
    assert.equal(makeBetPosts, 1);
    assert.equal(res.cart_cleared, true);

    // Replaying same idempotency_key must fail closed before touching DOM
    await assert.rejects(
      () => cart.run({ ...basePlan, idempotency_key: 'reject-key-1' }, { now: () => 1000 }),
      /DUPLICATE_IDEMPOTENCY_KEY/
    );
    assert.equal(makeBetPosts, 1, 'replay must not send a second POST');
    await context.close();
  }

  // 6. Network abort / indeterminate response marks INDETERMINATE and blocks retry
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let makeBetPosts = 0;
    await page.route('**/*', route => {
      if (route.request().url().includes('make-bet-v2')) {
        makeBetPosts++;
        return route.fulfill({
          status: 502,
          contentType: 'text/plain',
          body: 'Bad Gateway',
        });
      }
      return route.fulfill({ contentType: 'text/html', body: html(group('Under 60.5', '1.87')) });
    });
    await page.goto(basePlan.selection.event_url);
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    const res = await cart.run({ ...basePlan, idempotency_key: 'indeterminate-key-1' }, { now: () => 1000 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(makeBetPosts, 1);
    assert.equal(store.attempts.get('indeterminate-key-1')?.status, 'INDETERMINATE');
    await assert.rejects(
      () => cart.run({ ...basePlan, idempotency_key: 'indeterminate-key-1' }, { now: () => 1000 }),
      /DUPLICATE_IDEMPOTENCY_KEY/
    );
    await context.close();
  }

  // 7. Accepted single 1 USDT bet records receipt and blocks any second POST or refund
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    let makeBetPosts = 0;
    await page.route('**/*', route => {
      if (route.request().url().includes('make-bet-v2')) {
        makeBetPosts++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              success: {
                betId: 987654321,
                cf: 1.87,
                amount: 1,
                currencyCode: 'USDT',
                possibleProfitAmount: 1.87,
              }
            }
          }),
        });
      }
      return route.fulfill({ contentType: 'text/html', body: html(group('Under 60.5', '1.87')) });
    });
    await page.goto(basePlan.selection.event_url);
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    const res = await cart.run({ ...basePlan, idempotency_key: 'accept-key-1' }, { now: () => 1000 });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'ACCEPTED');
    assert.deepEqual(res.receipt, {
      bet_id: '987654321',
      accepted_cf: 1.87,
      amount: 1,
      currency: 'USDT',
      possible_profit_amount: 1.87,
    });
    assert.equal(makeBetPosts, 1);

    // Refund and un-armed make-bet-v2 are blocked by the guard
    for (const forbidden of ['/bets/refund', '/bets/make-bet-v2']) {
      const st = await page.evaluate(async u => {
        try { await fetch(u, { method: 'POST', body: '{}' }); return 'sent'; }
        catch { return 'aborted'; }
      }, forbidden);
      assert.equal(st, 'aborted', `${forbidden} must be aborted when not armed`);
    }
    await context.close();
  }

  // 8. Rejects incompatible market axes (period / unit / side) before DOM navigation
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = new InMemoryAttemptStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    await assert.rejects(
      () => cart.run({
        ...basePlan,
        idempotency_key: 'axes-mismatch-1',
        expected_axes: { period: 'full_time', unit: 'goals', side: 'under' },
        selection: { ...basePlan.selection, axes: { period: '1st_half', unit: 'goals', side: 'under' } },
      }, { now: () => 1000 }),
      /AXES_MISMATCH:period/
    );
    await context.close();
  }

  console.log('8 live cart fixture regressions passed: disabled gate, budget guard, expiry, pre-submit drift, rejection, indeterminate lock, single-shot receipt, axes mismatch');
} finally {
  delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;
  await browser.close();
}
