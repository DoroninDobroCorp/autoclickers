import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OneWinLiveCart,
  DurableAttemptStore,
  InMemoryAttemptStore,
} from './browser_live_cart.mjs';

function makeTempStorePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-live-cart-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'attempts.json');
}

function makeValidPlan(overrides = {}) {
  const axes = {
    period: 'full_time',
    scope: 'REG',
    unit: 'goals',
    market: 'total',
    line: 60.5,
    side: 'under',
  };
  return {
    ok: true,
    execution_ready: true,
    execution_blockers: [],
    idempotency_key: 'live-test-key-1',
    stake: 1,
    currency: 'USDT',
    expires_at: 2000,
    expected_axes: { ...axes },
    account_conditions: {
      logged_in: true,
      account_identity_verified: true,
      currency: 'USDT',
      available_balance: 8.45,
      commission: 0,
      max_stake: 8.45,
    },
    selection: {
      event_id: '40021999',
      event_url: 'https://1win.pro/betting/match/sport/40021999',
      market_id: '6271',
      market_name: 'Total',
      selection_id: '10:193671744120169820:0',
      price: 1.87,
      axes: { ...axes },
    },
    ui_selection_name: 'Under 60.5',
    ...overrides,
  };
}

function createFakePage({
  initialBoardPrice = '1.87',
  recheckBoardPrice = null,
  makeBetHandler = null,
  screenshotPostError = null,
  cleanupError = null,
} = {}) {
  let currentUrl = 'https://1win.pro/betting/match/sport/40021999';
  let routeHandler = null;
  let couponEmpty = true;
  let inputBuffer = '10';
  let selectedInFocusedInput = false;
  let boardPriceNow = initialBoardPrice;
  let selectionClicks = 0;
  let makeBetPosts = 0;
  let responseListener = null;

  async function dispatchRequest(urlStr, method = 'POST') {
    let aborted = false;
    let fallbackCalled = false;
    const reqObj = {
      url: () => urlStr,
      method: () => method,
    };
    const routeObj = {
      request: () => reqObj,
      abort: async () => { aborted = true; },
      fallback: async () => { fallbackCalled = true; },
    };
    if (routeHandler) {
      await routeHandler(routeObj);
    } else {
      fallbackCalled = true;
    }
    if (aborted || !fallbackCalled) {
      throw new Error('REQUEST_ABORTED_BY_GUARD');
    }
    if (urlStr.includes('/bets/make-bet-v2') && method === 'POST') {
      makeBetPosts += 1;
      const handlerRes = makeBetHandler
        ? await makeBetHandler()
        : {
            status: 200,
            json: async () => ({
              result: {
                success: {
                  betId: 987654321,
                  cf: 1.87,
                  amount: 1,
                  currencyCode: 'USDT',
                  possibleProfitAmount: 1.87,
                },
              },
            }),
          };
      const resObj = {
        url: () => urlStr,
        status: () => handlerRes.status ?? 200,
        request: () => reqObj,
        json: handlerRes.json || (async () => handlerRes.body),
      };
      if (responseListener && responseListener.predicate(resObj)) {
        responseListener.resolve(resObj);
      }
      return resObj;
    }
    return { status: () => 200, json: async () => ({}) };
  }

  const amountLocator = {
    click: async () => { selectedInFocusedInput = false; },
    press: async (key) => {
      if (key === 'ControlOrMeta+A') selectedInFocusedInput = true;
      else if (key === 'Backspace') {
        inputBuffer = selectedInFocusedInput ? '' : inputBuffer.slice(0, -1);
        selectedInFocusedInput = false;
      } else if (key === 'Tab') {
        if (recheckBoardPrice !== null) {
          boardPriceNow = recheckBoardPrice;
        }
      }
    },
    pressSequentially: async (text) => {
      if (selectedInFocusedInput) {
        inputBuffer = String(text);
        selectedInFocusedInput = false;
      } else {
        inputBuffer += String(text);
      }
    },
    inputValue: async () => `USDT ${inputBuffer}`,
  };

  const outcomeButton = {
    first: () => outcomeButton,
    waitFor: async () => {},
    count: async () => 1,
    locator: () => ({
      innerText: async () => String(boardPriceNow),
    }),
    click: async () => {
      selectionClicks += 1;
      couponEmpty = false;
      inputBuffer = '10';
    },
  };

  const groupLocator = {
    count: async () => 1,
    getByRole: () => ({
      filter: () => outcomeButton,
    }),
  };

  const slipLocator = {
    getByText: (text) => ({
      isVisible: async () => (text === 'Select an outcome' ? couponEmpty : !couponEmpty),
      waitFor: async () => {
        if (text === 'Select an outcome' && cleanupError) {
          throw new Error(cleanupError);
        }
      },
    }),
    getByRole: (_role, opts = {}) => {
      if (opts.name === 'Place a bet') {
        return {
          isVisible: async () => !couponEmpty,
          isEnabled: async () => !couponEmpty,
          click: async () => {
            await dispatchRequest('https://api-gateway.top-parser.com/bets/make-bet-v2', 'POST');
          },
        };
      }
      return {
        filter: () => ({
          count: async () => (couponEmpty ? 0 : 1),
          isVisible: async () => !couponEmpty,
          click: async () => {
            if (cleanupError) throw new Error(cleanupError);
            couponEmpty = true;
          },
        }),
      };
    },
    locator: () => amountLocator,
    screenshot: async () => {},
  };

  const page = {
    route: async (_pattern, handler) => { routeHandler = handler; },
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    locator: () => ({}),
    getByText: (text) => {
      if (text === 'Betslip') {
        return {
          locator: () => slipLocator,
        };
      }
      return {
        filter: () => ({
          locator: () => groupLocator,
        }),
      };
    },
    waitForResponse: (predicate) => new Promise((resolve, reject) => {
      responseListener = { predicate, resolve, reject };
    }),
    screenshot: async () => {
      if (screenshotPostError) throw new Error(screenshotPostError);
    },
    dispatchRequest,
    getStats: () => ({ selectionClicks, makeBetPosts, couponEmpty }),
  };

  return page;
}

test('1. Rejects when liveEnabled is false or ONEWIN_AUTOMATION_LIVE_ENABLED is not set', async (t) => {
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;

  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  await assert.rejects(() => cart.run(makeValidPlan(), { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);

  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const disabledCart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: false });
  await assert.rejects(() => disabledCart.run(makeValidPlan(), { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);
});

test('2. Rejects InMemoryAttemptStore and non-durable mock objects in live mode', async () => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const page = createFakePage();
  const inMemory = new InMemoryAttemptStore();
  assert.equal(inMemory.isDurable, false);

  assert.throws(
    () => new OneWinLiveCart(page, { attemptStore: inMemory, liveEnabled: true }),
    /DURABLE_ATTEMPT_STORE_REQUIRED/
  );
  assert.throws(
    () => new OneWinLiveCart(page, { attemptStore: { claim: async () => true, record: async () => {} }, liveEnabled: true }),
    /DURABLE_ATTEMPT_STORE_REQUIRED/
  );

  // Even if constructed with liveEnabled: false and later toggled, run() still rejects InMemoryAttemptStore
  const bypassedCart = new OneWinLiveCart(page, { attemptStore: inMemory, liveEnabled: false });
  bypassedCart.liveEnabled = true;
  await assert.rejects(() => bypassedCart.run(makeValidPlan(), { now: () => 1000 }), /DURABLE_ATTEMPT_STORE_REQUIRED/);
});

test('3. DurableAttemptStore validates inputs and persists state across real disk restarts', async (t) => {
  const storePath = makeTempStorePath(t);
  const store1 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  assert.equal(store1.isDurable, true);

  // Rejects boolean, NaN, <=0, >maxStake, bad currency, empty payload, or mismatched payload fields
  const plan = makeValidPlan({ idempotency_key: 'persist-1', stake: 2.5 });
  await assert.rejects(() => store1.claim('bad-1', { stake: true, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-2', { stake: Number.NaN, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-3', { stake: 0, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-4', { stake: 15, currency: 'USDT', payload: plan }), /STAKE_BUDGET_VIOLATION/);
  await assert.rejects(() => store1.claim('bad-5', { stake: 1, currency: '123', payload: plan }), /UNSUPPORTED_CURRENCY/);
  await assert.rejects(() => store1.claim('bad-6', { stake: 1, currency: 'USDT', payload: {} }), /VALID_PAYLOAD_REQUIRED/);
  await assert.rejects(() => store1.claim('bad-7', { stake: 1, currency: 'USDT', payload: plan }), /PAYLOAD_KEY_MISMATCH/);

  // Claim and record SUBMITTING -> simulate process crash before response
  assert.equal(await store1.claim('persist-1', { stake: 2.5, currency: 'USDT', payload: plan }), true);
  await store1.record('persist-1', 'SUBMITTING');
  store1.close();

  // Reopen a brand-new DurableAttemptStore on the same file path
  const store2 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  const recovered = store2.getAttempt('persist-1');
  assert.equal(recovered.status, 'SUBMITTING');
  assert.equal(recovered.stake, 2.5);
  assert.equal(recovered.event_id, '40021999');
  assert.equal(recovered.selection_id, '10:193671744120169820:0');
  assert.equal(await store2.claim('persist-1', { stake: 2.5, currency: 'USDT', payload: plan }), false);

  // Transition to INDETERMINATE and verify immutability across another reopen
  await store2.record('persist-1', 'INDETERMINATE', { error: 'crash_during_submit' });
  store2.close();

  const store3 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  assert.equal(store3.getAttempt('persist-1').status, 'INDETERMINATE');
  await assert.rejects(() => store3.record('persist-1', 'ACCEPTED'), /TERMINAL_ATTEMPT_IMMUTABLE/);
  store3.close();
});

test('4. Rejects missing, NaN, non-finite, or expired expires_at before claiming attempt', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  for (const badExpiry of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '2000', true, 0, -10]) {
    await assert.rejects(
      () => cart.run(makeValidPlan({ idempotency_key: 'exp-bad', expires_at: badExpiry }), { now: () => 1000 }),
      /EXPIRES_AT_REQUIRED/
    );
  }
  await assert.rejects(
    () => cart.run(makeValidPlan({ idempotency_key: 'exp-past', expires_at: 1000 }), { now: () => 1000 }),
    /TASK_EXPIRED/
  );
  assert.equal(store.getAttempt('exp-bad'), null, 'invalid plan must never claim an attempt');
  assert.equal(store.getAttempt('exp-past'), null, 'expired plan must never claim an attempt');
});

test('5. Rejects missing currency, missing/guessed axes, unverified readiness, or unverified commission', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  // Unverified readiness or blockers present
  await assert.rejects(
    () => cart.run(makeValidPlan({ execution_ready: false }), { now: () => 1000 }),
    /EXECUTION_NOT_READY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ execution_blockers: ['unverified_commission'] }), { now: () => 1000 }),
    /EXECUTION_NOT_READY/
  );

  // Missing or wrong currency
  await assert.rejects(
    () => cart.run(makeValidPlan({ currency: undefined }), { now: () => 1000 }),
    /UNSUPPORTED_CURRENCY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ currency: 'RUB' }), { now: () => 1000 }),
    /UNSUPPORTED_CURRENCY/
  );

  // Missing axes, guessed unit, or mismatched axes
  await assert.rejects(
    () => cart.run(makeValidPlan({ expected_axes: undefined }), { now: () => 1000 }),
    /AXES_REQUIRED/
  );
  const guessedAxes = { period: 'full_time', scope: 'REG', unit: 'match_base_unit', market: 'total', line: 4.5, side: 'under' };
  await assert.rejects(
    () => cart.run(makeValidPlan({
      expected_axes: guessedAxes,
      selection: { ...makeValidPlan().selection, axes: guessedAxes },
    }), { now: () => 1000 }),
    /UNVERIFIED_AXES_UNIT/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({
      selection: {
        ...makeValidPlan().selection,
        axes: { ...makeValidPlan().expected_axes, period: '1st_half' },
      },
    }), { now: () => 1000 }),
    /AXES_MISMATCH:period/
  );

  // Unverified commission (null / undefined / boolean) or unverified account identity
  await assert.rejects(
    () => cart.run(makeValidPlan({
      account_conditions: { ...makeValidPlan().account_conditions, commission: null },
    }), { now: () => 1000 }),
    /UNVERIFIED_COMMISSION/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({
      account_conditions: { ...makeValidPlan().account_conditions, account_identity_verified: false },
    }), { now: () => 1000 }),
    /ACCOUNT_IDENTITY_UNVERIFIED/
  );
});

test('6. Enforces 1 USDT diagnostic budget vs configurable product budget', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const storePath = makeTempStorePath(t);
  const store = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  const page = createFakePage({
    makeBetHandler: async () => ({
      status: 200,
      json: async () => ({
        result: {
          success: {
            betId: 55501,
            cf: 1.87,
            amount: 5,
            currencyCode: 'USDT',
            possibleProfitAmount: 9.35,
          },
        },
      }),
    }),
  });

  // Default diagnosticMode=true rejects stake !== 1
  const diagCart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  for (const badStake of [0, 0.5, 2, 5, 9999, true, '1']) {
    await assert.rejects(
      () => diagCart.run(makeValidPlan({ idempotency_key: `diag-${badStake}`, stake: badStake }), { now: () => 1000 }),
      /STAKE_BUDGET_VIOLATION/
    );
  }

  // Product mode (diagnosticMode: false, maxBudgetUsdt: 10.0) allows stake: 5 and rejects stake: 15
  const prodCart = new OneWinLiveCart(page, {
    attemptStore: store,
    liveEnabled: true,
    diagnosticMode: false,
    maxBudgetUsdt: 10.0,
  });
  await assert.rejects(
    () => prodCart.run(makeValidPlan({ idempotency_key: 'prod-15', stake: 15 }), { now: () => 1000 }),
    /STAKE_BUDGET_VIOLATION/
  );
  const prodRes = await prodCart.run(makeValidPlan({ idempotency_key: 'prod-5', stake: 5 }), { now: () => 1000 });
  assert.equal(prodRes.ok, true);
  assert.equal(prodRes.status, 'ACCEPTED');
  assert.equal(prodRes.amount, 5);
  assert.equal(store.getAttempt('prod-5').stake, 5);
});

test('7. Pre-submit price drift and pre-submit expiry abort without sending make-bet-v2', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const driftPage = createFakePage({ initialBoardPrice: '1.87', recheckBoardPrice: '1.75' });
  const cart = new OneWinLiveCart(driftPage, { attemptStore: store, liveEnabled: true });

  const res = await cart.run(makeValidPlan({ idempotency_key: 'drift-1' }), { now: () => 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'ABORTED_PRE_SUBMIT');
  assert.match(res.error, /PRICE_DRIFT_BEFORE_SUBMIT/);
  assert.equal(driftPage.getStats().makeBetPosts, 0);
  assert.equal(store.getAttempt('drift-1').status, 'WITHDRAWN');
});

test('8. Definitive bookmaker rejection vs indeterminate error codes and restart replay lock', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const storePath = makeTempStorePath(t);
  const store1 = new DurableAttemptStore(storePath);

  // 8a. Known rejection code -> REJECTED
  const rejectPage = createFakePage({
    makeBetHandler: async () => ({
      status: 200,
      json: async () => ({ errors: [{ code: 'max_bet_amount', meta: { maxBetAmount: 0.5 } }] }),
    }),
  });
  const rejectCart = new OneWinLiveCart(rejectPage, { attemptStore: store1, liveEnabled: true });
  const rejRes = await rejectCart.run(makeValidPlan({ idempotency_key: 'rej-key-1' }), { now: () => 1000 });
  assert.equal(rejRes.ok, false);
  assert.equal(rejRes.status, 'REJECTED');
  assert.equal(rejRes.rejection_code, 'max_bet_amount');

  // 8b. Unknown error code (internal_server_error) -> INDETERMINATE
  const indPage = createFakePage({
    makeBetHandler: async () => ({
      status: 200,
      json: async () => ({ errors: [{ code: 'internal_server_error' }] }),
    }),
  });
  const indCart = new OneWinLiveCart(indPage, { attemptStore: store1, liveEnabled: true });
  const indRes = await indCart.run(makeValidPlan({ idempotency_key: 'ind-key-1' }), { now: () => 1000 });
  assert.equal(indRes.ok, false);
  assert.equal(indRes.status, 'INDETERMINATE');
  store1.close();

  // Reopen a fresh DurableAttemptStore on the same file to verify restart durability
  const store2 = new DurableAttemptStore(storePath);
  assert.equal(store2.getAttempt('rej-key-1').status, 'REJECTED');
  assert.equal(store2.getAttempt('ind-key-1').status, 'INDETERMINATE');

  const replayCart = new OneWinLiveCart(indPage, { attemptStore: store2, liveEnabled: true });
  await assert.rejects(
    () => replayCart.run(makeValidPlan({ idempotency_key: 'rej-key-1' }), { now: () => 1000 }),
    /DUPLICATE_IDEMPOTENCY_KEY/
  );
  await assert.rejects(
    () => replayCart.run(makeValidPlan({ idempotency_key: 'ind-key-1' }), { now: () => 1000 }),
    /DUPLICATE_IDEMPOTENCY_KEY/
  );
  assert.equal(indPage.getStats().makeBetPosts, 1, 'replay after restart must never send a second POST');
});

test('9. Screenshot or cleanup failure after ACCEPTED never overwrites receipt or transitions to INDETERMINATE', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const storePath = makeTempStorePath(t);
  const store = new DurableAttemptStore(storePath);
  const page = createFakePage({
    screenshotPostError: 'DISK_FULL_SCREENSHOT_FAILED',
    cleanupError: 'CLEANUP_TIMEOUT_AFTER_BET',
  });
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  const res = await cart.run(
    makeValidPlan({ idempotency_key: 'accept-shot-err' }),
    { now: () => 1000, screenshotPost: '/tmp/nonexistent/shot.png' }
  );
  assert.equal(res.status, 'ACCEPTED');
  assert.equal(res.ok, true);
  assert.equal(res.condition_mismatch, false);
  assert.equal(res.receipt.bet_id, '987654321');
  assert.equal(res.receipt.accepted_cf, 1.87);
  assert.equal(res.receipt.amount, 1);
  assert.equal(res.receipt.currency, 'USDT');
  assert.match(res.screenshot_post_error, /DISK_FULL_SCREENSHOT_FAILED/);
  assert.match(res.cleanup_error, /CLEANUP_TIMEOUT_AFTER_BET/);

  // Reopen store from disk to prove ACCEPTED receipt survived intact
  const reopened = new DurableAttemptStore(storePath);
  const persisted = reopened.getAttempt('accept-shot-err');
  assert.equal(persisted.status, 'ACCEPTED');
  assert.equal(persisted.receipt.bet_id, '987654321');

  // Guard blocks any subsequent refund or un-armed make-bet-v2
  await assert.rejects(
    () => page.dispatchRequest('https://api-gateway.top-parser.com/bets/refund', 'POST'),
    /REQUEST_ABORTED_BY_GUARD/
  );
  await assert.rejects(
    () => page.dispatchRequest('https://api-gateway.top-parser.com/bets/make-bet-v2', 'POST'),
    /REQUEST_ABORTED_BY_GUARD/
  );
});

test('10. Receipt with altered cf/amount/currency saves ACCEPTED receipt on disk and flags condition_mismatch', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const storePath = makeTempStorePath(t);
  const store = new DurableAttemptStore(storePath);
  const page = createFakePage({
    makeBetHandler: async () => ({
      status: 200,
      json: async () => ({
        result: {
          success: {
            betId: 777888999,
            cf: 1.72,          // drifted from requested 1.87
            amount: 0.8,       // partial/different from requested 1.0
            currencyCode: '',  // missing currency in response
            possibleProfitAmount: 1.376,
            rejectedAmount: 0.2,
          },
        },
      }),
    }),
  });
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  const res = await cart.run(makeValidPlan({ idempotency_key: 'mismatch-accept-1' }), { now: () => 1000 });
  assert.equal(res.status, 'ACCEPTED', 'accepted bet must still be marked ACCEPTED so it is never retried');
  assert.equal(res.ok, false, 'condition mismatch must set ok=false');
  assert.equal(res.condition_mismatch, true);
  assert.deepEqual(res.condition_mismatches, [
    'accepted_cf_mismatch',
    'accepted_amount_mismatch',
    'missing_accepted_currency',
    'partial_rejection_amount',
  ]);
  assert.equal(res.receipt.bet_id, '777888999');

  // Verify persisted receipt and duplicate lock on disk
  const reopened = new DurableAttemptStore(storePath);
  const saved = reopened.getAttempt('mismatch-accept-1');
  assert.equal(saved.status, 'ACCEPTED');
  assert.equal(saved.receipt.bet_id, '777888999');
  assert.deepEqual(saved.condition_mismatches, [
    'accepted_cf_mismatch',
    'accepted_amount_mismatch',
    'missing_accepted_currency',
    'partial_rejection_amount',
  ]);
  await assert.rejects(
    () => cart.run(makeValidPlan({ idempotency_key: 'mismatch-accept-1' }), { now: () => 1000 }),
    /DUPLICATE_IDEMPOTENCY_KEY/
  );
});
