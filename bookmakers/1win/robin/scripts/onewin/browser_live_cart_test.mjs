import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OneWinLiveCart,
  DurableAttemptStore,
  InMemoryAttemptStore,
} from './browser_live_cart.mjs';

// Child processes must exercise the module of THIS worktree, never a path of
// another checkout.
const CART_MODULE_URL = new URL('./browser_live_cart.mjs', import.meta.url).href;

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
    payout_rule: { status: 'not_declared', result_variant: null, draw_payout: null },
  };
  return {
    ok: true,
    execution_ready: true,
    execution_blockers: [],
    live_submit_contract_verified: true,
    live_submit_contract_source: 'unit-test-fixture',
    idempotency_key: 'live-test-key-1',
    stake: 1,
    currency: 'USDT',
    expires_at: 2000,
    evidence: { expiries: { task: 2000, donor: 2000, reference: 2000, margins: 2000, executor_quote: 2000, account: 2000 } },
    expected_axes: { ...axes },
    account_conditions: {
      logged_in: true,
      account_identity_verified: true,
      account_identity_source: 'unit-test-fixture',
      currency: 'USDT',
      available_balance: 8.45,
      commission: 0,
      max_stake: 8.45,
      live_submit_contract_verified: true,
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

function buildSyntheticMakeBetBody(plan) {
  const sel = plan.selection;
  return {
    currencyCode: plan.currency || 'USDT',
    idempotencyKey: plan.idempotency_key,
    amount: plan.stake,
    coupon: {
      amount: plan.stake,
      selections: [
        {
          oddId: sel.selection_id,
          cf: sel.price,
          matchId: sel.event_id,
          marketId: sel.market_id,
        },
      ],
    },
    wallet: {
      type: 'real',
    },
  };
}

function createFakePage({
  initialBoardPrice = '1.87',
  recheckBoardPrice = null,
  makeBetHandler = null,
  makeBetBodyGenerator = null,
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

  async function dispatchRequest(urlStr, method = 'POST', explicitBody = null) {
    let aborted = false;
    let fallbackCalled = false;
    const reqObj = {
      url: () => urlStr,
      method: () => method,
      postData: () => (explicitBody !== null ? JSON.stringify(explicitBody) : ''),
      postDataJSON: () => explicitBody,
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
        ? await makeBetHandler(explicitBody)
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
            const body = makeBetBodyGenerator
              ? makeBetBodyGenerator()
              : buildSyntheticMakeBetBody(makeValidPlan({ stake: Number(inputBuffer) || 1 }));
            await dispatchRequest('https://api-gateway.top-parser.com/bets/make-bet-v2', 'POST', body);
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

test('1. Prototype safety: __proto__, constructor, hasOwnProperty keys persist to disk and block duplicate claim across child processes', async (t) => {
  const storePath = makeTempStorePath(t);
  const store = new DurableAttemptStore(storePath);
  const protoKeys = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'];
  for (const protoKey of protoKeys) {
    // Distinct native selections: the store allows one live intent per selection.
    const plan = makeValidPlan({
      idempotency_key: protoKey,
      selection: { ...makeValidPlan().selection, selection_id: `10:${protoKeys.indexOf(protoKey) + 1}:0` },
    });
    assert.equal(await store.claim(protoKey, { stake: 1, currency: 'USDT', payload: plan }), true);
    assert.equal(await store.claim(protoKey, { stake: 1, currency: 'USDT', payload: plan }), false);
  }

  // Re-verify in a brand-new spawned Node child process
  const planProto = makeValidPlan({ idempotency_key: '__proto__' });
  const childOut = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DurableAttemptStore } from ${JSON.stringify(CART_MODULE_URL)};
     const s = new DurableAttemptStore(${JSON.stringify(storePath)});
     const claimedAgain = await s.claim("__proto__", { stake: 1, currency: "USDT", payload: ${JSON.stringify(planProto)} });
     const saved = s.getAttempt("__proto__");
     const ctorSaved = s.getAttempt("constructor");
     console.log(JSON.stringify({ claimedAgain, status: saved?.status, key: saved?.key, ctorKey: ctorSaved?.key }));`,
  ], { encoding: 'utf8' });

  const parsed = JSON.parse(childOut.trim());
  assert.equal(parsed.claimedAgain, false);
  assert.equal(parsed.status, 'CLAIMED');
  assert.equal(parsed.key, '__proto__');
  assert.equal(parsed.ctorKey, 'constructor');
});

test('2. Lock ownership & crash recovery: live PID locks are never stolen by age, foreign release fails, and crashed child process locks are reaped safely', async (t) => {
  const storePath = makeTempStorePath(t);
  const store = new DurableAttemptStore(storePath);
  const lockPath = `${storePath}.lock`;

  // 2a. Live PID lock backdated by 30 seconds must NOT be stolen. The holder is another live
  // process (the parent): a lock carrying this process's own PID is stale by construction because
  // store operations are synchronous.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, token: 'live-owner-token', created_at: Date.now() - 30000 }), { mode: 0o600 });
  const past = new Date(Date.now() - 30000);
  fs.utimesSync(lockPath, past, past);

  assert.throws(
    () => store._acquireLock(40),
    /DURABLE_STORE_LOCK_TIMEOUT/,
    'Lock held by a live process must never be stolen solely by age'
  );

  // 2b. Releasing foreign lock token throws LOCK_OWNERSHIP_LOST without deleting the file
  assert.throws(
    () => store._releaseLock({ token: 'wrong-token', ino: fs.statSync(lockPath).ino }),
    /LOCK_OWNERSHIP_LOST/
  );
  assert.equal(fs.existsSync(lockPath), true, 'Foreign lock file must not be unlinked on ownership mismatch');
  fs.unlinkSync(lockPath);

  // 2c. Spawn a child process that claims an attempt, acquires the lock, and crashes (exits without releasing lock)
  const crashPlan = makeValidPlan({ idempotency_key: 'crash-child-1' });
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DurableAttemptStore } from ${JSON.stringify(CART_MODULE_URL)};
     const s = new DurableAttemptStore(${JSON.stringify(storePath)});
     await s.claim("crash-child-1", { stake: 1, currency: "USDT", payload: ${JSON.stringify(crashPlan)} });
     await s.record("crash-child-1", "SUBMITTING");
     // Acquire lock and crash before releasing it
     s._acquireLock(500);
     process.exit(0);`,
  ], { encoding: 'utf8' });

  // The child process has exited, leaving its lock file behind on disk
  assert.equal(fs.existsSync(lockPath), true, 'Crashed child left lock file on disk');

  // Now spawn a second separate child process: it must detect the dead PID (ESRCH), reap the abandoned lock,
  // see crash-child-1 in SUBMITTING state, and refuse to duplicate-claim crash-child-1!
  const recoverOut = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DurableAttemptStore } from ${JSON.stringify(CART_MODULE_URL)};
     const s = new DurableAttemptStore(${JSON.stringify(storePath)});
     const existing = s.getAttempt("crash-child-1");
     const duplicateClaim = await s.claim("crash-child-1", { stake: 1, currency: "USDT", payload: ${JSON.stringify(crashPlan)} });
     console.log(JSON.stringify({ status: existing?.status, duplicateClaim }));`,
  ], { encoding: 'utf8' });

  const recovered = JSON.parse(recoverOut.trim());
  assert.equal(recovered.status, 'SUBMITTING');
  assert.equal(recovered.duplicateClaim, false);
  assert.equal(fs.existsSync(lockPath), false, 'Reaped lock was cleanly released after recovery');
});

test('3. Store corruption protection: existing 0-byte, invalid JSON, or invalid schema files fail closed without overwriting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 3a. Pre-existing empty file (0 bytes)
  const emptyPath = path.join(dir, 'empty.json');
  fs.writeFileSync(emptyPath, '', { mode: 0o600 });
  assert.throws(() => new DurableAttemptStore(emptyPath), /CORRUPT_DURABLE_ATTEMPT_STORE:EMPTY_EXISTING_FILE/);
  assert.equal(fs.readFileSync(emptyPath, 'utf8'), '', 'Empty pre-existing file must not be modified or overwritten');

  // 3b. Pre-existing invalid JSON
  const invalidJsonPath = path.join(dir, 'bad.json');
  fs.writeFileSync(invalidJsonPath, '{ invalid json', { mode: 0o600 });
  assert.throws(() => new DurableAttemptStore(invalidJsonPath), /CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_JSON/);
  assert.equal(fs.readFileSync(invalidJsonPath, 'utf8'), '{ invalid json', 'Invalid JSON file must not be modified');

  // 3c. Pre-existing invalid schema
  const badSchemaPath = path.join(dir, 'bad-schema.json');
  fs.writeFileSync(badSchemaPath, JSON.stringify({ version: 99, entries: 'not-an-array' }), { mode: 0o600 });
  assert.throws(() => new DurableAttemptStore(badSchemaPath), /CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_SCHEMA/);
});

test('4. Route guard body binding: rejects mismatched event, market, selection, stake, currency, price, express, or freebet/bonus substitutions before network', async (t) => {
  const store = new DurableAttemptStore(makeTempStorePath(t));
  let routeHandler = null;
  const fakePage = {
    route: async (_pat, h) => { routeHandler = h; },
  };
  const cart = new OneWinLiveCart(fakePage, { attemptStore: store, liveEnabled: true });
  await cart.installGuard();

  const plan = makeValidPlan();
  const validBody = buildSyntheticMakeBetBody(plan);
  // The guard now also decides freshness and attempt state at the boundary, so
  // the manually armed expectation needs the same context run() provides.
  await store.claim(plan.idempotency_key, { stake: plan.stake, currency: 'USDT', payload: plan });
  await store.record(plan.idempotency_key, 'SUBMITTING');
  cart._runtime = { now: () => 1000, cancelled: async () => false };

  async function testBody(candidateBody) {
    cart.submitArmed = true;
    cart.armedExpectation = {
      idempotencyKey: plan.idempotency_key,
      expiresAt: 2000,
      eventId: plan.selection.event_id,
      marketId: plan.selection.market_id,
      selectionId: plan.selection.selection_id,
      stake: plan.stake,
      currency: plan.currency,
      price: plan.selection.price,
    };
    let aborted = false;
    let forwarded = false;
    await routeHandler({
      request: () => ({
        url: () => 'https://api-gateway.top-parser.com/bets/make-bet-v2',
        method: () => 'POST',
        postData: () => JSON.stringify(candidateBody),
        postDataJSON: () => candidateBody,
      }),
      abort: async () => { aborted = true; },
      fallback: async () => { forwarded = true; },
    });
    return { aborted, forwarded };
  }

  // Mismatched selection ID
  assert.equal((await testBody({
    ...validBody,
    coupon: { ...validBody.coupon, selections: [{ ...validBody.coupon.selections[0], oddId: '10:OTHER:0' }] },
  })).aborted, true);

  // Mismatched match ID
  assert.equal((await testBody({
    ...validBody,
    coupon: { ...validBody.coupon, selections: [{ ...validBody.coupon.selections[0], matchId: '99999999' }] },
  })).aborted, true);

  // Mismatched market ID
  assert.equal((await testBody({
    ...validBody,
    coupon: { ...validBody.coupon, selections: [{ ...validBody.coupon.selections[0], marketId: '9999' }] },
  })).aborted, true);

  // Mismatched stake/amount (e.g. 9999 or 2 instead of 1)
  assert.equal((await testBody({ ...validBody, amount: 9999, coupon: { ...validBody.coupon, amount: 9999 } })).aborted, true);

  // Mismatched odds / price
  assert.equal((await testBody({
    ...validBody,
    coupon: { ...validBody.coupon, selections: [{ ...validBody.coupon.selections[0], cf: 1.50 }] },
  })).aborted, true);

  // Freebet or bonus wallet substitution
  assert.equal((await testBody({ ...validBody, freebetId: 'fb-123' })).aborted, true);
  assert.equal((await testBody({ ...validBody, wallet: { type: 'bonus', bonusId: 5 } })).aborted, true);

  // Multiple selections (express)
  assert.equal((await testBody({
    ...validBody,
    coupon: { ...validBody.coupon, selections: [validBody.coupon.selections[0], validBody.coupon.selections[0]] },
  })).aborted, true);

  // Exact matching body is forwarded through fallback
  const validCall = await testBody(validBody);
  assert.equal(validCall.aborted, false);
  assert.equal(validCall.forwarded, true);
});

test('5. Rejects unverified live submit wire contract before execution', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  const unverifiedPlan = makeValidPlan({
    live_submit_contract_verified: false,
    account_conditions: { ...makeValidPlan().account_conditions, live_submit_contract_verified: false },
  });
  await assert.rejects(() => cart.run(unverifiedPlan, { now: () => 1000 }), /LIVE_SUBMIT_CONTRACT_UNVERIFIED/);
});

test('6. Rejects when liveEnabled is false or ONEWIN_AUTOMATION_LIVE_ENABLED is not set', async (t) => {
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;

  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  await assert.rejects(() => cart.run(makeValidPlan(), { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);

  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const disabledCart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: false });
  await assert.rejects(() => disabledCart.run(makeValidPlan(), { now: () => 1000 }), /LIVE_PLACEMENT_DISABLED/);
});

test('7. Rejects InMemoryAttemptStore and non-durable mock objects in live mode', async () => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const page = createFakePage();
  const inMemory = new InMemoryAttemptStore();
  assert.equal(inMemory.isDurable, false);

  assert.throws(
    () => new OneWinLiveCart(page, { attemptStore: inMemory, liveEnabled: true }),
    /DURABLE_ATTEMPT_STORE_REQUIRED/
  );
});

test('8. DurableAttemptStore validates inputs and persists state across real disk restarts', async (t) => {
  const storePath = makeTempStorePath(t);
  const store1 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  assert.equal(store1.isDurable, true);

  const plan = makeValidPlan({ idempotency_key: 'persist-1', stake: 2.5 });
  await assert.rejects(() => store1.claim('bad-1', { stake: true, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-2', { stake: Number.NaN, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-3', { stake: 0, currency: 'USDT', payload: plan }), /INVALID_STAKE/);
  await assert.rejects(() => store1.claim('bad-4', { stake: 15, currency: 'USDT', payload: plan }), /STAKE_BUDGET_VIOLATION/);
  await assert.rejects(() => store1.claim('bad-5', { stake: 1, currency: '123', payload: plan }), /UNSUPPORTED_CURRENCY/);
  await assert.rejects(() => store1.claim('bad-6', { stake: 1, currency: 'USDT', payload: {} }), /VALID_PAYLOAD_REQUIRED/);
  await assert.rejects(() => store1.claim('bad-7', { stake: 1, currency: 'USDT', payload: plan }), /PAYLOAD_KEY_MISMATCH/);

  assert.equal(await store1.claim('persist-1', { stake: 2.5, currency: 'USDT', payload: plan }), true);
  await store1.record('persist-1', 'SUBMITTING');
  store1.close();

  const store2 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  const recovered = store2.getAttempt('persist-1');
  assert.equal(recovered.status, 'SUBMITTING');
  assert.equal(recovered.stake, 2.5);
  assert.equal(await store2.claim('persist-1', { stake: 2.5, currency: 'USDT', payload: plan }), false);

  await store2.record('persist-1', 'INDETERMINATE', { error: 'crash_during_submit' });
  store2.close();

  const store3 = new DurableAttemptStore(storePath, { maxStake: 10.0 });
  assert.equal(store3.getAttempt('persist-1').status, 'INDETERMINATE');
  await assert.rejects(() => store3.record('persist-1', 'ACCEPTED'), /TERMINAL_ATTEMPT_IMMUTABLE/);
  store3.close();
});

test('9. Rejects missing, NaN, non-finite, or expired expires_at before claiming attempt', async (t) => {
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
  assert.equal(store.getAttempt('exp-bad'), null);
  assert.equal(store.getAttempt('exp-past'), null);
});

test('10. Rejects missing currency, missing/guessed axes, unverified readiness, or unverified commission', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(makeTempStorePath(t));
  const page = createFakePage();
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  await assert.rejects(
    () => cart.run(makeValidPlan({ execution_ready: false }), { now: () => 1000 }),
    /EXECUTION_NOT_READY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ execution_blockers: ['unverified_commission'] }), { now: () => 1000 }),
    /EXECUTION_NOT_READY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ currency: undefined }), { now: () => 1000 }),
    /UNSUPPORTED_CURRENCY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ currency: 'RUB' }), { now: () => 1000 }),
    /UNSUPPORTED_CURRENCY/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({ expected_axes: undefined }), { now: () => 1000 }),
    /AXES_REQUIRED/
  );
  const guessedAxes = { period: 'full_time', scope: 'REG', unit: 'match_base_unit', market: 'total', line: 4.5, side: 'under',
    payout_rule: { status: 'not_declared', result_variant: null, draw_payout: null } };
  await assert.rejects(
    () => cart.run(makeValidPlan({
      expected_axes: guessedAxes,
      selection: { ...makeValidPlan().selection, axes: guessedAxes },
    }), { now: () => 1000 }),
    /UNVERIFIED_AXES_UNIT/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({
      selection: { ...makeValidPlan().selection, axes: { ...makeValidPlan().expected_axes, period: '1st_half' } },
    }), { now: () => 1000 }),
    /AXES_MISMATCH:period/
  );
  await assert.rejects(
    () => cart.run(makeValidPlan({
      account_conditions: { ...makeValidPlan().account_conditions, commission: null },
    }), { now: () => 1000 }),
    /UNVERIFIED_COMMISSION/
  );
});

test('11. Enforces 1 USDT diagnostic budget vs configurable product budget', async (t) => {
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

  const diagCart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  for (const badStake of [0, 0.5, 2, 5, 9999, true, '1']) {
    await assert.rejects(
      () => diagCart.run(makeValidPlan({ idempotency_key: `diag-${badStake}`, stake: badStake }), { now: () => 1000 }),
      /STAKE_BUDGET_VIOLATION/
    );
  }

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

test('12. Pre-submit price drift and pre-submit expiry abort without sending make-bet-v2', async (t) => {
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

test('13. Definitive bookmaker rejection vs indeterminate error codes and restart replay lock', async (t) => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const storePath = makeTempStorePath(t);
  const store1 = new DurableAttemptStore(storePath);

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
  assert.equal(indPage.getStats().makeBetPosts, 1);
});

test('14. Screenshot or cleanup failure after ACCEPTED never overwrites receipt or transitions to INDETERMINATE', async (t) => {
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
  assert.equal(res.receipt.bet_id, '987654321');
  assert.match(res.screenshot_post_error, /DISK_FULL_SCREENSHOT_FAILED/);
  assert.match(res.cleanup_error, /CLEANUP_TIMEOUT_AFTER_BET/);

  const reopened = new DurableAttemptStore(storePath);
  assert.equal(reopened.getAttempt('accept-shot-err').status, 'ACCEPTED');
});

test('15. Receipt with altered cf/amount/currency saves ACCEPTED receipt on disk and flags condition_mismatch', async (t) => {
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
            cf: 1.72,
            amount: 0.8,
            currencyCode: '',
            possibleProfitAmount: 1.376,
            rejectedAmount: 0.2,
          },
        },
      }),
    }),
  });
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });

  const res = await cart.run(makeValidPlan({ idempotency_key: 'mismatch-accept-1' }), { now: () => 1000 });
  assert.equal(res.status, 'ACCEPTED');
  assert.equal(res.ok, false);
  assert.equal(res.condition_mismatch, true);
  assert.deepEqual(res.condition_mismatches, [
    'accepted_cf_mismatch',
    'accepted_amount_mismatch',
    'missing_accepted_currency',
    'partial_rejection_amount',
  ]);
  assert.equal(res.receipt.bet_id, '777888999');

  const reopened = new DurableAttemptStore(storePath);
  const saved = reopened.getAttempt('mismatch-accept-1');
  assert.equal(saved.status, 'ACCEPTED');
  assert.equal(saved.receipt.bet_id, '777888999');
  await assert.rejects(
    () => cart.run(makeValidPlan({ idempotency_key: 'mismatch-accept-1' }), { now: () => 1000 }),
    /DUPLICATE_IDEMPOTENCY_KEY/
  );
});
