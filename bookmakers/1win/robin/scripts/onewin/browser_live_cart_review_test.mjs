// Review regressions for the live cart (task 3 follow-up, 2026-10-13).
// Written against the public surface that exists on the reviewed revision so
// that each test fails with a meaningful assertion before the fix.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';

const CART_URL = new URL('./browser_live_cart.mjs', import.meta.url).href;

function tmpStore(t, name = 'attempts.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

const AXES = { period: 'full_time', scope: 'REG', unit: 'goals', market: 'total', line: 60.5, side: 'under' };

function plan(overrides = {}) {
  return {
    ok: true,
    execution_ready: true,
    execution_blockers: [],
    live_submit_contract_verified: true,
    live_submit_contract_source: 'synthetic-review-fixture',
    idempotency_key: 'review-key-1',
    stake: 1,
    currency: 'USDT',
    expires_at: 2000,
    evidence: { expiries: { task: 2000, donor: 2000, reference: 2000, margins: 2000, executor_quote: 2000, account: 2000 } },
    expected_axes: { ...AXES },
    account_conditions: {
      logged_in: true, account_identity_verified: true, account_identity_source: 'synthetic-review-fixture',
      currency: 'USDT', available_balance: 8.45, commission: 0, max_stake: 8.45,
      live_submit_contract_verified: true,
    },
    selection: {
      event_id: '40021999', event_url: 'https://1win.pro/betting/match/sport/40021999',
      market_id: '6271', market_name: 'Total', selection_id: '10:193671744120169820:0',
      price: 1.87, axes: { ...AXES },
    },
    ui_selection_name: 'Under 60.5',
    ...overrides,
  };
}

function makeBetBody(p) {
  return {
    currencyCode: p.currency, idempotencyKey: p.idempotency_key, amount: p.stake,
    coupon: { amount: p.stake, selections: [{ oddId: p.selection.selection_id, cf: p.selection.price,
      matchId: p.selection.event_id, marketId: p.selection.market_id }] },
    wallet: { type: 'real' },
  };
}

// Minimal Playwright-like page with injection points for every await the cart
// performs between the last freshness check and the forwarded POST.
function hookedPage({ hooks = {}, makeBetHandler = null } = {}) {
  let routeHandler = null;
  let couponEmpty = true;
  let buffer = '10';
  let selected = false;
  let makeBetPosts = 0;
  let pending = null;
  const fire = async (name, ...args) => { if (hooks[name]) await hooks[name](...args); };

  async function dispatch(urlStr, body) {
    let aborted = false; let forwarded = false;
    const req = { url: () => urlStr, method: () => 'POST', postData: () => JSON.stringify(body), postDataJSON: () => body };
    await routeHandler({ request: () => req, abort: async () => { aborted = true; }, fallback: async () => { forwarded = true; } });
    if (aborted || !forwarded) throw new Error('REQUEST_ABORTED_BY_GUARD');
    makeBetPosts += 1;
    const res = makeBetHandler ? await makeBetHandler(body) : { status: 200, json: async () => ({ result: { success: {
      betId: 987654321, cf: 1.87, amount: 1, currencyCode: 'USDT', possibleProfitAmount: 1.87 } } }) };
    const resObj = { url: () => urlStr, status: () => 200, request: () => req, json: res.json };
    if (pending && pending.predicate(resObj)) pending.resolve(resObj);
    return resObj;
  }

  const amount = {
    click: async () => { selected = false; },
    press: async (key) => {
      if (key === 'ControlOrMeta+A') selected = true;
      else if (key === 'Backspace') { buffer = selected ? '' : buffer.slice(0, -1); selected = false; }
    },
    pressSequentially: async (text) => { buffer = selected ? String(text) : buffer + String(text); selected = false; },
    inputValue: async () => { await fire('inputValue'); return `USDT ${buffer}`; },
  };
  const outcomeButton = {
    first: () => outcomeButton, waitFor: async () => {}, count: async () => 1,
    locator: () => ({ innerText: async () => '1.87' }),
    click: async () => { couponEmpty = false; buffer = '10'; },
  };
  const group = { count: async () => 1, getByRole: () => ({ filter: () => outcomeButton }) };
  const slip = {
    getByText: (text) => ({
      isVisible: async () => (text === 'Select an outcome' ? couponEmpty : !couponEmpty),
      waitFor: async () => {},
    }),
    getByRole: (_role, opts = {}) => {
      if (opts.name === 'Place a bet') {
        return {
          isVisible: async () => { await fire('submitVisible'); return !couponEmpty; },
          isEnabled: async () => { await fire('submitEnabled'); return !couponEmpty; },
          click: async () => { await fire('beforeClick'); await dispatch('https://api-gateway.top-parser.com/bets/make-bet-v2', makeBetBody(plan({ stake: Number(buffer) || 1 }))); },
        };
      }
      return { filter: () => ({ count: async () => (couponEmpty ? 0 : 1), isVisible: async () => !couponEmpty,
        click: async () => { couponEmpty = true; } }) };
    },
    locator: () => amount,
    screenshot: async () => { await fire('screenshotPre'); },
  };
  return {
    route: async (_p, h) => { routeHandler = h; },
    url: () => 'https://1win.pro/betting/match/sport/40021999',
    goto: async () => {},
    locator: () => ({}),
    getByText: (text) => (text === 'Betslip' ? { locator: () => slip } : { filter: () => ({ locator: () => group }) }),
    waitForResponse: (predicate) => new Promise((resolve, reject) => { pending = { predicate, resolve, reject }; }),
    screenshot: async () => {},
    stats: () => ({ makeBetPosts }),
  };
}

function wrapRecord(store, onRecord) {
  const original = store.record.bind(store);
  store.record = async (key, status, detail) => {
    const result = await original(key, status, detail);
    await onRecord(status, key);
    return result;
  };
  return store;
}

async function runCart(t, { clock, hooks = {}, planOverrides = {}, cancelled, onRecord, storePath } = {}) {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const file = storePath || tmpStore(t);
  const store = new DurableAttemptStore(file);
  if (onRecord) wrapRecord(store, onRecord);
  const page = hookedPage({ hooks });
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  const result = await cart.run(plan(planOverrides), {
    now: () => clock.t,
    screenshotPre: '/tmp/review-pre.png',
    ...(cancelled ? { cancelled } : {}),
  });
  return { result, store, page, cart, file };
}

// ---------------------------------------------------------------- P0.3
for (const point of ['after_pre_check_record', 'during_screenshot', 'after_submit_button_check', 'after_submitting_record']) {
  test(`P0.3 expiry at the POST boundary (${point}) forwards zero requests`, async (t) => {
    const clock = { t: 1000 };
    const expire = () => { clock.t = 2001; };
    const hooks = {};
    let onRecord;
    if (point === 'after_pre_check_record') onRecord = async (status) => { if (status === 'PRE_CHECK_PASSED') expire(); };
    if (point === 'during_screenshot') hooks.screenshotPre = expire;
    if (point === 'after_submit_button_check') hooks.submitEnabled = expire;
    if (point === 'after_submitting_record') onRecord = async (status) => { if (status === 'SUBMITTING') expire(); };
    const { result, page, cart, store } = await runCart(t, { clock, hooks, onRecord });
    assert.equal(page.stats().makeBetPosts, 0, `a POST was forwarded after the plan expired (${point})`);
    assert.equal(cart.submitSentCount, 0);
    assert.notEqual(result.status, 'ACCEPTED');
    assert.match(String(result.error), /EXPIRED/i);
    assert.notEqual(store.getAttempt('review-key-1').status, 'ACCEPTED');
  });
}

test('P0.3 a plan that outlives its own earliest evidence is rejected before any claim', async (t) => {
  const clock = { t: 1000 };
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(tmpStore(t));
  const page = hookedPage();
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  const expiries = { task: 2000, donor: 2000, reference: 2000, margins: 2000, executor_quote: 1500, account: 2000 };
  await assert.rejects(() => cart.run(plan({ evidence: { expiries } }), { now: () => clock.t }), /PLAN_EXPIRY_EXCEEDS_EVIDENCE/);
  assert.equal(store.getAttempt('review-key-1'), null);
  assert.equal(page.stats().makeBetPosts, 0);
});

test('P0.3 task-level expiry is not the only absolute expiry: earliest evidence expiry blocks the POST', async (t) => {
  const clock = { t: 1000 };
  const expiries = { task: 2000, donor: 2000, reference: 2000, margins: 2000, executor_quote: 1500, account: 2000 };
  const { result, page } = await runCart(t, {
    clock,
    planOverrides: { expires_at: 1500, evidence: { expiries } },
    onRecord: async (status) => { if (status === 'SUBMITTING') clock.t = 1600; },
  });
  assert.equal(page.stats().makeBetPosts, 0, 'executor quote expired at 1500 but the POST was forwarded at 1600');
  assert.match(String(result.error), /EXPIRED/i);
});

test('P0.3 withdrawal requested after SUBMITTING is honoured at the boundary', async (t) => {
  const clock = { t: 1000 };
  const file = tmpStore(t);
  const { result, page } = await runCart(t, {
    clock, storePath: file,
    onRecord: async (status, key) => {
      if (status === 'SUBMITTING') {
        const other = new DurableAttemptStore(file);
        if (typeof other.requestWithdrawal === 'function') await other.requestWithdrawal(key, 'queue_withdrawn');
      }
    },
    cancelled: (() => { let flag = false; return async () => flag; })(),
  });
  assert.equal(page.stats().makeBetPosts, 0, 'withdrawn attempt was still forwarded');
  assert.match(String(result.error), /WITHDRAW|CANCEL/i);
});

test('P0.3 cancellation callback flipping after SUBMITTING stops the POST', async (t) => {
  const clock = { t: 1000 };
  let cancelledNow = false;
  const { result, page } = await runCart(t, {
    clock,
    onRecord: async (status) => { if (status === 'SUBMITTING') cancelledNow = true; },
    cancelled: async () => cancelledNow,
  });
  assert.equal(page.stats().makeBetPosts, 0, 'cancelled attempt was still forwarded');
  assert.match(String(result.error), /CANCEL|WITHDRAW/i);
});

test('P0.3 a request that was already forwarded is never retried and stays INDETERMINATE', async (t) => {
  const clock = { t: 1000 };
  const file = tmpStore(t);
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const store = new DurableAttemptStore(file);
  const page = hookedPage({ makeBetHandler: async () => { throw new Error('socket hang up after send'); } });
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
  const first = await cart.run(plan(), { now: () => clock.t });
  assert.equal(first.status, 'INDETERMINATE');
  assert.equal(page.stats().makeBetPosts, 1);
  const again = new OneWinLiveCart(page, { attemptStore: new DurableAttemptStore(file), liveEnabled: true });
  await assert.rejects(() => again.run(plan(), { now: () => clock.t }), /DUPLICATE_IDEMPOTENCY_KEY/);
  assert.equal(page.stats().makeBetPosts, 1);
});

// ---------------------------------------------------------------- P1.4
const claimPayload = (key = 'seal-1', stake = 1) => ({ idempotency_key: key, stake, currency: 'USDT',
  event_id: '40021999', market_id: '6271', selection_id: '10:1:0', expected_odds: 1.87 });

async function claimed(t, key = 'seal-1') {
  const file = tmpStore(t);
  const store = new DurableAttemptStore(file);
  assert.equal(await store.claim(key, { stake: 1, currency: 'USDT', payload: claimPayload(key) }), true);
  await store.record(key, 'SUBMITTING');
  return { file, store };
}

test('P1.4 a second ACCEPTED record cannot replace the receipt', async (t) => {
  const { store } = await claimed(t);
  await store.record('seal-1', 'ACCEPTED', { receipt: { bet_id: 'first', amount: 1, currency: 'USDT' } });
  await assert.rejects(() => store.record('seal-1', 'ACCEPTED', { receipt: { bet_id: 'changed', amount: 1, currency: 'USDT' } }),
    /TERMINAL_ATTEMPT/);
  assert.equal(store.getAttempt('seal-1').receipt.bet_id, 'first');
});

test('P1.4 an identical terminal record is idempotent and does not touch the entry', async (t) => {
  const { store } = await claimed(t);
  const receipt = { bet_id: 'first', amount: 1, currency: 'USDT' };
  await store.record('seal-1', 'ACCEPTED', { receipt });
  const before = JSON.stringify(store.getAttempt('seal-1'));
  await store.record('seal-1', 'ACCEPTED', { receipt: { ...receipt } });
  assert.equal(JSON.stringify(store.getAttempt('seal-1')), before, 'idempotent repeat rewrote the sealed entry');
});

test('P1.4 terminal error and mismatch lists are sealed too', async (t) => {
  const { store } = await claimed(t);
  await store.record('seal-1', 'REJECTED', { receipt: { errors: [{ code: 'max_bet_amount' }] }, error: 'max_bet_amount' });
  await assert.rejects(() => store.record('seal-1', 'REJECTED', { receipt: { errors: [{ code: 'max_bet_amount' }] }, error: 'other' }),
    /TERMINAL_ATTEMPT/);
  assert.equal(store.getAttempt('seal-1').error, 'max_bet_amount');
});

test('P1.4 accepted facts need a receipt and a legal phase path', async (t) => {
  const file = tmpStore(t);
  const store = new DurableAttemptStore(file);
  await store.claim('path-1', { stake: 1, currency: 'USDT', payload: claimPayload('path-1') });
  await assert.rejects(() => store.record('path-1', 'ACCEPTED', { receipt: { bet_id: 'x' } }), /ILLEGAL_TRANSITION|INVALID_TRANSITION/);
  await store.record('path-1', 'PRE_CHECK_PASSED');
  await assert.rejects(() => store.record('path-1', 'CLAIMED'), /ILLEGAL_TRANSITION|INVALID_TRANSITION/);
  await store.record('path-1', 'SUBMITTING');
  await assert.rejects(() => store.record('path-1', 'PRE_CHECK_PASSED'), /ILLEGAL_TRANSITION|INVALID_TRANSITION/);
  await assert.rejects(() => store.record('path-1', 'ACCEPTED'), /RECEIPT_REQUIRED/);
  await assert.rejects(() => store.record('path-1', 'ACCEPTED', { receipt: { amount: 1 } }), /RECEIPT_REQUIRED/);
  assert.equal(store.getAttempt('path-1').status, 'SUBMITTING');
});

test('P1.4 withdrawal after a potential submit needs proof that nothing was forwarded', async (t) => {
  const { store } = await claimed(t);
  await assert.rejects(() => store.record('seal-1', 'WITHDRAWN', { error: 'cancelled' }), /ILLEGAL_TRANSITION|NOT_SENT_PROOF/);
  assert.equal(store.getAttempt('seal-1').status, 'SUBMITTING');
});

test('P1.4 restart and timeout never revive a terminal attempt', async (t) => {
  const { file, store } = await claimed(t);
  await store.record('seal-1', 'INDETERMINATE', { error: 'timeout' });
  const reopened = new DurableAttemptStore(file);
  assert.equal(await reopened.claim('seal-1', { stake: 1, currency: 'USDT', payload: claimPayload() }), false);
  await assert.rejects(() => reopened.record('seal-1', 'SUBMITTING'), /TERMINAL_ATTEMPT|ILLEGAL_TRANSITION/);
  await assert.rejects(() => reopened.record('seal-1', 'WITHDRAWN', { error: 'late withdrawal' }), /TERMINAL_ATTEMPT|ILLEGAL_TRANSITION/);
  assert.equal(reopened.getAttempt('seal-1').status, 'INDETERMINATE');
});

// ---------------------------------------------------------------- P1.5
function failFsync(kind, code = 'EIO') {
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const isDir = fs.fstatSync(fd).isDirectory();
    if ((kind === 'dir' && isDir) || (kind === 'file' && !isDir)) {
      const err = new Error(`synthetic ${kind} sync failure`); err.code = code; throw err;
    }
    return original(fd);
  };
  return () => { fs.fsyncSync = original; };
}

test('P1.5 directory fsync EIO is reflected in the state and blocks placement', async (t) => {
  const file = tmpStore(t);
  const store = new DurableAttemptStore(file);
  const restore = failFsync('dir');
  try {
    let threw = false;
    try { await store.claim('sync-1', { stake: 1, currency: 'USDT', payload: claimPayload('sync-1') }); } catch { threw = true; }
    assert.equal(threw, true, 'claim reported success although the directory sync failed');
    assert.equal(store.isDurable, false, 'store still claims durability after a failed directory fsync');
    assert.ok(store.syncFailure, 'sync failure must be visible in the state');
    await assert.rejects(() => store.claim('sync-2', { stake: 1, currency: 'USDT', payload: claimPayload('sync-2') }));
  } finally { restore(); }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'file must remain a valid store');
});

const WRITE_FAILURES = [
  ['file fsync EIO', () => failFsync('file')],
  ['rename EIO', () => {
    const original = fs.renameSync;
    fs.renameSync = () => { const e = new Error('synthetic rename failure'); e.code = 'EIO'; throw e; };
    return () => { fs.renameSync = original; };
  }],
  ['write ENOSPC', () => {
    const original = fs.writeFileSync;
    fs.writeFileSync = (target, ...rest) => {
      if (typeof target === 'number') { const e = new Error('synthetic write failure'); e.code = 'ENOSPC'; throw e; }
      return original(target, ...rest);
    };
    return () => { fs.writeFileSync = original; };
  }],
];

for (const [name, patch] of WRITE_FAILURES) {
  test(`P1.5 ${name} before the receipt leaves the original file intact and blocks the claim`, async (t) => {
    const file = tmpStore(t);
    const store = new DurableAttemptStore(file);
    const before = fs.readFileSync(file, 'utf8');
    const restore = patch();
    let claimedResult = null; let threw = false;
    try { claimedResult = await store.claim('sync-3', { stake: 1, currency: 'USDT', payload: claimPayload('sync-3') }); }
    catch { threw = true; } finally { restore(); }
    assert.equal(threw || claimedResult === false, true, 'claim must not report success');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'original store bytes changed');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp.')), [], 'temporary file leaked');
    assert.equal(store.isDurable, false);
  });

  test(`P1.5 ${name} at the SUBMITTING record forwards nothing`, async (t) => {
    const clock = { t: 1000 };
    let restore = null;
    // the failure is armed right before the cart records SUBMITTING
    process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
    const file = tmpStore(t);
    const store = new DurableAttemptStore(file);
    const original = store.record.bind(store);
    store.record = async (key, status, detail) => {
      if (status === 'SUBMITTING') restore = patch();
      try { return await original(key, status, detail); } finally { if (restore) { restore(); restore = null; } }
    };
    const page = hookedPage();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    const result = await cart.run(plan(), { now: () => clock.t });
    assert.equal(page.stats().makeBetPosts, 0, 'a bet was forwarded although SUBMITTING could not be recorded durably');
    assert.equal(cart.submitSentCount, 0);
    assert.notEqual(result.status, 'ACCEPTED');
    assert.equal(store.isDurable, false);
  });

  test(`P1.5 ${name} after the accepted receipt keeps the fact and forbids another bet`, async (t) => {
    const clock = { t: 1000 };
    const file = tmpStore(t);
    process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
    const store = new DurableAttemptStore(file);
    let restore = null;
    // the failure strikes after the request was forwarded, while the answer is being processed
    const page = hookedPage({ makeBetHandler: async () => {
      restore = patch();
      return { status: 200, json: async () => ({ result: { success: {
        betId: 987654321, cf: 1.87, amount: 1, currencyCode: 'USDT', possibleProfitAmount: 1.87 } } }) };
    } });
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true });
    let result;
    try { result = await cart.run(plan(), { now: () => clock.t }); } finally { if (restore) restore(); }
    assert.equal(page.stats().makeBetPosts, 1);
    assert.equal(result.status, 'ACCEPTED', 'accepted fact lost after the write error');
    assert.equal(result.receipt.bet_id, '987654321');
    assert.equal(result.durable_record_failed, true);
    assert.equal(store.isDurable, false);
    const reopened = new DurableAttemptStore(file);
    assert.equal(await reopened.claim('review-key-1', { stake: 1, currency: 'USDT', payload: claimPayload('review-key-1') }), false);
    assert.equal(reopened.getAttempt('review-key-1').status, 'SUBMITTING');
  });
}

test('P1.5 directory sync failure after the accepted receipt keeps the fact and forbids another bet', async (t) => {
  const clock = { t: 1000 };
  const file = tmpStore(t);
  let restore = null;
  const { result, store } = await runCart(t, {
    clock, storePath: file,
    onRecord: async (status) => { if (status === 'SUBMITTING') restore = failFsync('dir'); },
  });
  if (restore) restore();
  assert.equal(result.status, 'ACCEPTED', 'accepted fact lost after the sync error');
  assert.equal(result.receipt.bet_id, '987654321');
  assert.equal(result.durable_record_failed, true);
  const journal = `${file}.receipts.jsonl`;
  assert.equal(fs.existsSync(journal), true, 'emergency receipt journal missing');
  assert.match(fs.readFileSync(journal, 'utf8'), /987654321/);
  const reopened = new DurableAttemptStore(file);
  assert.equal(await reopened.claim('review-key-1', { stake: 1, currency: 'USDT', payload: claimPayload('review-key-1') }), false);
  assert.equal(store.isDurable, false);
});

test('P1.5 an unsupported directory sync is only accepted through an explicit opt-in', async (t) => {
  const restore = failFsync('dir', 'EINVAL');
  try {
    const strict = tmpStore(t, 'strict.json');
    let strictStore = null; let strictThrew = false;
    try { strictStore = new DurableAttemptStore(strict); } catch { strictThrew = true; }
    assert.equal(strictThrew || strictStore.isDurable === false, true,
      'EINVAL on directory fsync was silently accepted as durable');
    const optIn = tmpStore(t, 'optin.json');
    const accepted = new DurableAttemptStore(optIn, { allowUnsupportedDirectorySync: true });
    assert.equal(accepted.isDurable, true);
    assert.equal(accepted.durabilityLevel, 'file_fsync_only');
  } finally { restore(); }
});

// ---------------------------------------------------------------- P1.6
function seedFile(t, content) {
  const file = tmpStore(t);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  return file;
}
const goodEntry = (key = 'k1', extra = {}) => ({
  key, status: 'CLAIMED', stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0',
  expected_odds: 1.87, payload: { idempotency_key: key, stake: 1, currency: 'USDT' }, receipt: null, error: null,
  condition_mismatches: [], created_at: 1000, updated_at: 1000, ...extra,
});

test('P1.6 the reviewed empty-object entry is rejected without touching the file', async (t) => {
  const raw = '{"version":1,"entries":[["bad",{}]]}';
  const file = seedFile(t, raw);
  assert.throws(() => new DurableAttemptStore(file), /CORRUPT_DURABLE_ATTEMPT_STORE/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

for (const [name, mutate] of [
  ['unknown status', (e) => ({ ...e, status: 'MAYBE' })],
  ['key mismatch', (e) => ({ ...e, key: 'other' })],
  ['stake as string', (e) => ({ ...e, stake: '1' })],
  ['stake zero', (e) => ({ ...e, stake: 0 })],
  ['stake boolean', (e) => ({ ...e, stake: true })],
  ['lowercase currency', (e) => ({ ...e, currency: 'usd' })],
  ['payload stake mismatch', (e) => ({ ...e, payload: { ...e.payload, stake: 2 } })],
  ['payload key mismatch', (e) => ({ ...e, payload: { ...e.payload, idempotency_key: 'other' } })],
  ['payload not object', (e) => ({ ...e, payload: 'x' })],
  ['accepted without receipt', (e) => ({ ...e, status: 'ACCEPTED', receipt: null })],
  ['accepted receipt without bet id', (e) => ({ ...e, status: 'ACCEPTED', receipt: { amount: 1 } })],
  ['missing clock', (e) => ({ ...e, created_at: undefined })],
  ['clock order', (e) => ({ ...e, updated_at: 1 })],
  ['mismatches not array', (e) => ({ ...e, condition_mismatches: 'x' })],
  ['event id not string', (e) => ({ ...e, event_id: 7 })],
]) {
  test(`P1.6 persisted attempt with ${name} fails closed`, async (t) => {
    const raw = JSON.stringify({ version: 1, entries: [['k1', mutate(goodEntry('k1'))]] });
    const file = seedFile(t, raw);
    assert.throws(() => new DurableAttemptStore(file), /CORRUPT_DURABLE_ATTEMPT_STORE/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
}

test('P1.6 a complete legacy store is migrated explicitly with a byte-identical backup', async (t) => {
  const legacy = JSON.stringify({ version: 1, attempts: { k1: goodEntry('k1') } });
  const file = seedFile(t, legacy);
  const store = new DurableAttemptStore(file);
  assert.equal(await store.claim('k1', { stake: 1, currency: 'USDT', payload: claimPayload('k1') }), false);
  assert.equal(await store.claim('k2', { stake: 1, currency: 'USDT', payload: claimPayload('k2') }), true);
  const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.legacy-v1.'));
  assert.equal(backups.length, 1, 'legacy file was rewritten without a backup');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), legacy);
});

test('P1.6 an incomplete legacy entry is not invented into a financial fact', async (t) => {
  const legacy = JSON.stringify({ version: 1, attempts: { k1: { status: 'ACCEPTED' } } });
  const file = seedFile(t, legacy);
  assert.throws(() => new DurableAttemptStore(file), /CORRUPT_DURABLE_ATTEMPT_STORE/);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
});

// ---------------------------------------------------------------- real child processes
function child(file, script) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, CART_URL, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code, signal) => resolve({ code, signal, out: out.trim(), err: err.trim() }));
  });
}
const CHILD_PRELUDE = `
const [cartUrl, file] = process.argv.slice(1);
const { DurableAttemptStore } = await import(cartUrl);
const payload = (key) => ({ idempotency_key: key, stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0', expected_odds: 1.87 });
`;

test('P1 concurrent child processes: exactly one claim wins', async (t) => {
  const file = tmpStore(t);
  new DurableAttemptStore(file);
  const script = `${CHILD_PRELUDE}
const s = new DurableAttemptStore(file);
const ok = await s.claim('race-1', { stake: 1, currency: 'USDT', payload: payload('race-1') });
console.log(JSON.stringify({ ok }));`;
  const results = await Promise.all(Array.from({ length: 6 }, () => child(file, script)));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(results.filter((r) => JSON.parse(r.out).ok === true).length, 1);
});

test('P1 crash after SUBMITTING keeps the attempt locked and recoverable only as INDETERMINATE', async (t) => {
  const file = tmpStore(t);
  const script = `${CHILD_PRELUDE}
const s = new DurableAttemptStore(file);
await s.claim('crash-1', { stake: 1, currency: 'USDT', payload: payload('crash-1') });
await s.record('crash-1', 'SUBMITTING');
process.kill(process.pid, 'SIGKILL');`;
  const r = await child(file, script);
  assert.equal(r.signal, 'SIGKILL');
  const store = new DurableAttemptStore(file);
  assert.equal(store.getAttempt('crash-1').status, 'SUBMITTING');
  assert.equal(await store.claim('crash-1', { stake: 1, currency: 'USDT', payload: claimPayload('crash-1') }), false);
  await assert.rejects(() => store.record('crash-1', 'WITHDRAWN', { error: 'restart' }), /ILLEGAL_TRANSITION|NOT_SENT_PROOF/);
  await store.record('crash-1', 'INDETERMINATE', { error: 'restart_recovery' });
  assert.equal(store.getAttempt('crash-1').status, 'INDETERMINATE');
});

test('P1 conflicting terminal receipts from concurrent processes: one wins, the other is refused', async (t) => {
  const file = tmpStore(t);
  const seed = new DurableAttemptStore(file);
  await seed.claim('term-1', { stake: 1, currency: 'USDT', payload: claimPayload('term-1') });
  await seed.record('term-1', 'SUBMITTING');
  const script = (id) => `${CHILD_PRELUDE}
const s = new DurableAttemptStore(file);
let outcome = 'recorded';
try { await s.record('term-1', 'ACCEPTED', { receipt: { bet_id: '${id}', amount: 1, currency: 'USDT' } }); } catch (e) { outcome = String(e.message); }
console.log(JSON.stringify({ outcome }));`;
  const results = await Promise.all([child(file, script('A')), child(file, script('B'))]);
  const recorded = results.map((r) => JSON.parse(r.out).outcome);
  assert.equal(recorded.filter((o) => o === 'recorded').length, 1, JSON.stringify(recorded));
  assert.match(recorded.find((o) => o !== 'recorded'), /TERMINAL_ATTEMPT/);
  const final = new DurableAttemptStore(file).getAttempt('term-1');
  assert.ok(['A', 'B'].includes(final.receipt.bet_id));
});

test('the module path used by child processes is relative to this worktree', () => {
  assert.equal(execFileSync(process.execPath, ['-e', `console.log(${JSON.stringify(CART_URL)})`], { encoding: 'utf8' }).trim(), CART_URL);
  assert.equal(fs.existsSync(new URL(CART_URL)), true);
});
