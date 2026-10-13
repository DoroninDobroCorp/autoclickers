// Regressions for the independent review of 2026-10-13 (R-xx ids follow its report).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';

const AXES = { period: 'full_time', scope: 'REG', unit: 'goals', market: 'total', line: 60.5, side: 'under',
  payout_rule: { status: 'not_declared', result_variant: null, draw_payout: null } };
function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-followup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'attempts.json');
}
function plan(overrides = {}) {
  return {
    ok: true, execution_ready: true, execution_blockers: [],
    live_submit_contract_verified: true, live_submit_contract_source: 'followup-fixture',
    idempotency_key: 'followup-key-1', stake: 1, currency: 'USDT', expires_at: 2000,
    evidence: { expiries: { task: 2000, donor: 2000, reference: 2000, margins: 2000, executor_quote: 2000, account: 2000 } },
    expected_axes: JSON.parse(JSON.stringify(AXES)),
    account_conditions: { logged_in: true, account_identity_verified: true, account_identity_source: 'followup-fixture',
      currency: 'USDT', available_balance: 8.45, commission: 0, max_stake: 8.45, live_submit_contract_verified: true },
    selection: { event_id: '40021999', event_url: 'https://1win.pro/betting/match/sport/40021999', market_id: '6271',
      market_name: 'Total', selection_id: '10:193671744120169820:0', price: 1.87, axes: JSON.parse(JSON.stringify(AXES)) },
    ui_selection_name: 'Under 60.5',
    ...overrides,
  };
}
const body = (p) => ({ currencyCode: p.currency, idempotencyKey: p.idempotency_key, amount: p.stake,
  coupon: { amount: p.stake, selections: [{ oddId: p.selection.selection_id, cf: p.selection.price,
    matchId: p.selection.event_id, marketId: p.selection.market_id }] }, wallet: { type: 'real' } });

// Fake page. `submit` decides which request the Place-a-bet click produces.
function page({ routeFails = 0, submit = null, answer = null } = {}) {
  let handler = null; let failures = routeFails;
  let empty = true; let buffer = '10'; let selected = false;
  const sent = []; let pending = null; let current = plan();
  async function dispatch(url, method, data) {
    let aborted = false; let passed = false;
    const req = { url: () => url, method: () => method, postData: () => JSON.stringify(data), postDataJSON: () => data };
    if (handler) await handler({ request: () => req, abort: async () => { aborted = true; }, fallback: async () => { passed = true; } });
    else passed = true; // no guard installed: the request simply goes out
    if (aborted || !passed) throw new Error('REQUEST_ABORTED_BY_GUARD');
    sent.push({ url, method });
    if (answer && /make-bet-v2/.test(url)) {
      const res = { url: () => url, status: () => 200, request: () => req, json: async () => answer };
      if (pending && pending.predicate(res)) pending.resolve(res);
    }
  }
  const amount = {
    click: async () => { selected = false; },
    press: async (k) => { if (k === 'ControlOrMeta+A') selected = true; else if (k === 'Backspace') { buffer = selected ? '' : buffer.slice(0, -1); selected = false; } },
    pressSequentially: async (x) => { buffer = selected ? String(x) : buffer + String(x); selected = false; },
    inputValue: async () => `USDT ${buffer}`,
  };
  const button = { first: () => button, waitFor: async () => {}, count: async () => 1,
    locator: () => ({ innerText: async () => '1.87' }), click: async () => { empty = false; buffer = '10'; } };
  const group = { count: async () => 1, getByRole: () => ({ filter: () => button }) };
  const slip = {
    getByText: (text) => ({ isVisible: async () => (text === 'Select an outcome' ? empty : !empty), waitFor: async () => {} }),
    getByRole: (_r, opts = {}) => (opts.name === 'Place a bet'
      ? { isVisible: async () => !empty, isEnabled: async () => !empty,
          click: async () => {
            const p = { ...current, stake: Number(buffer) || 1 };
            const action = submit || { url: 'https://api-gateway.top-parser.com/bets/make-bet-v2', method: 'POST', data: body(p) };
            for (const step of Array.isArray(action) ? action : [action]) await dispatch(step.url, step.method, step.data ?? body(p));
          } }
      : { filter: () => ({ count: async () => (empty ? 0 : 1), isVisible: async () => !empty, click: async () => { empty = true; } }) }),
    locator: () => amount, screenshot: async () => {},
  };
  return {
    route: async (_p, h) => { if (failures > 0) { failures -= 1; throw new Error('Protocol error (Fetch.enable): Target closed'); } handler = h; },
    url: () => 'https://1win.pro/betting/match/sport/40021999', goto: async () => {}, locator: () => ({}),
    getByText: (text) => (text === 'Betslip' ? { locator: () => slip } : { filter: () => ({ locator: () => group }) }),
    waitForResponse: (predicate) => new Promise((resolve, reject) => { pending = { predicate, resolve, reject };
      setTimeout(() => reject(new Error('waitForResponse timeout')), 400); }),
    screenshot: async () => {}, sent: () => sent, setPlan: (p) => { current = p; },
  };
}
async function newCart(t, pageOptions = {}, storeOptions = {}, cartOptions = {}) {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  const file = tmpFile(t);
  const store = new DurableAttemptStore(file, storeOptions);
  const fake = page(pageOptions);
  const cart = new OneWinLiveCart(fake, { attemptStore: store, liveEnabled: true, ...cartOptions });
  return { file, store, fake, cart };
}
const OK_ANSWER = { result: { success: { betId: 42, cf: 1.87, amount: 1, currencyCode: 'USDT', possibleProfitAmount: 1.87 } } };

// ------------------------------------------------------------------ R-01
test('R-01 a failed route installation never leaves a guard-less cart marked as guarded', async (t) => {
  const { cart, fake, store } = await newCart(t, { routeFails: 1, answer: OK_ANSWER });
  const first = await cart.run(plan(), { now: () => 1000 });
  assert.notEqual(first.status, 'ACCEPTED');
  assert.equal(fake.sent().length, 0);
  const retry = plan({ idempotency_key: 'followup-key-2', selection: { ...plan().selection, selection_id: '10:2:0' } });
  fake.setPlan(retry);
  const second = await cart.run(retry, { now: () => 1000 });
  assert.equal(second.status, 'ACCEPTED', 'a healthy second installation may work');
  assert.equal(cart.guarded, true);
  assert.equal(fake.sent().length, 1);
  assert.equal(store.getAttempt('followup-key-1').status, 'WITHDRAWN');
});

test('R-01 a stale "guarded" flag without a handler is repaired before anything is clicked', async (t) => {
  const { cart, fake } = await newCart(t, { answer: OK_ANSWER });
  cart.guarded = true; // the state the reviewed bug leaves behind: flag set, handler absent
  const result = await cart.run(plan(), { now: () => 1000 });
  assert.equal(typeof cart._guardHandler, 'function', 'the route handler must exist after a run');
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(cart.submitSentCount, 1, 'the request must have been counted by the guard');
  assert.equal(fake.sent().length, 1);
});

// ------------------------------------------------------------------ R-02
for (const [name, step] of [
  ['another make-bet version', { url: 'https://api-gateway.top-parser.com/bets/make-bet-v3', method: 'POST' }],
  ['the same path with PUT', { url: 'https://api-gateway.top-parser.com/bets/make-bet-v2', method: 'PUT' }],
  ['an unknown ordinary endpoint', { url: 'https://api-gateway.top-parser.com/bets/api/v1/user/bets/ordinary', method: 'POST' }],
  ['another host with the expected path', { url: 'https://evil.example/bets/make-bet-v2', method: 'POST' }],
]) {
  test(`R-02 ${name} is stopped by the guard and does not count as "not sent" evidence for a second bet`, async (t) => {
    const { cart, fake, store } = await newCart(t, { submit: step, answer: OK_ANSWER });
    const result = await cart.run(plan(), { now: () => 1000 });
    assert.equal(fake.sent().length, 0, `the guard forwarded ${JSON.stringify(fake.sent())}`);
    assert.notEqual(result.status, 'ACCEPTED');
    assert.equal(store.getAttempt('followup-key-1').status, 'WITHDRAWN');
  });
}

test('R-02 an extra mutation next to the expected POST is not forwarded while armed', async (t) => {
  const p = plan();
  const { cart, fake } = await newCart(t, { answer: OK_ANSWER, submit: [
    { url: 'https://api-gateway.top-parser.com/bets/other-mutation', method: 'POST', data: { x: 1 } },
    { url: 'https://api-gateway.top-parser.com/bets/make-bet-v2', method: 'POST', data: body(p) },
  ] });
  await cart.run(p, { now: () => 1000 });
  assert.deepEqual(fake.sent().filter((r) => /other-mutation/.test(r.url)), []);
});

// ------------------------------------------------------------------ R-10
test('R-10 an answer with both errors and a bet id is INDETERMINATE and keeps the selection owned', async (t) => {
  const mixed = { errors: [{ code: 'odd_cf_changed' }], result: { success: { betId: 777, cf: 1.87, amount: 1, currencyCode: 'USDT' } } };
  const { cart, store } = await newCart(t, { answer: mixed });
  const result = await cart.run(plan(), { now: () => 1000 });
  assert.equal(result.status, 'INDETERMINATE');
  const attempt = store.getAttempt('followup-key-1');
  assert.equal(attempt.status, 'INDETERMINATE');
  assert.equal(attempt.receipt.result.success.betId, 777);
  assert.equal(await store.claim('other', { stake: 1, currency: 'USDT', payload: {
    idempotency_key: 'other', stake: 1, currency: 'USDT', event_id: '40021999', market_id: '6271',
    selection_id: '10:193671744120169820:0' } }), false);
});

// ------------------------------------------------------------------ R-13
test('R-13 a plan without a payout rule, or with an unverified one, is refused', async (t) => {
  const { cart, fake } = await newCart(t, { answer: OK_ANSWER });
  const without = plan();
  delete without.expected_axes.payout_rule;
  delete without.selection.axes.payout_rule;
  await assert.rejects(() => cart.run(without, { now: () => 1000 }), /PAYOUT_RULE_UNVERIFIED/);
  const bad = plan({ idempotency_key: 'followup-key-3' });
  bad.expected_axes.payout_rule.status = 'unverified';
  bad.selection.axes.payout_rule.status = 'unverified';
  await assert.rejects(() => cart.run(bad, { now: () => 1000 }), /PAYOUT_RULE_UNVERIFIED/);
  assert.equal(fake.sent().length, 0);
});

// ------------------------------------------------------------------ R-11
test('R-11 a withdrawal for a key that was not claimed yet is honoured by the later claim', async (t) => {
  const { cart, store, fake } = await newCart(t, { answer: OK_ANSWER });
  assert.equal(await store.requestWithdrawal('followup-key-1', 'queue_withdrawn'), true);
  await assert.rejects(() => cart.run(plan(), { now: () => 1000 }), /WITHDRAWN_BEFORE_CLAIM/);
  assert.equal(fake.sent().length, 0);
  const reopened = new DurableAttemptStore(store.filePath);
  await assert.rejects(() => reopened.claim('followup-key-1', { stake: 1, currency: 'USDT', payload: {
    idempotency_key: 'followup-key-1', stake: 1, currency: 'USDT' } }), /WITHDRAWN_BEFORE_CLAIM/);
});

// ------------------------------------------------------------------ R-14
test('R-14 a vanished store file is corruption, not an empty history', async (t) => {
  const { store, file } = await newCart(t);
  assert.equal(await store.claim('a', { stake: 1, currency: 'USDT', payload: {
    idempotency_key: 'a', stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0' } }), true);
  fs.unlinkSync(file);
  await assert.rejects(() => store.claim('a', { stake: 1, currency: 'USDT', payload: {
    idempotency_key: 'a', stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0' } }),
  /CORRUPT_DURABLE_ATTEMPT_STORE:MISSING_AFTER_INIT/);
  assert.equal(fs.existsSync(file), false, 'the store must not silently recreate the file');
});

// ------------------------------------------------------------------ R-19
test('R-19 production mode: counters are per run, a second selection is placed by the same cart', async (t) => {
  const { cart, store, fake } = await newCart(t, { answer: OK_ANSWER }, {}, { diagnosticMode: false, maxBudgetUsdt: 10 });
  const first = await cart.run(plan(), { now: () => 1000 });
  assert.equal(first.status, 'ACCEPTED');
  const next = plan({ idempotency_key: 'followup-key-9', selection: { ...plan().selection, selection_id: '10:9:0' } });
  fake.setPlan(next);
  const second = await cart.run(next, { now: () => 1000 });
  assert.equal(second.status, 'ACCEPTED', JSON.stringify(second));
  assert.equal(second.submit_sent_count, 1);
  assert.equal(store.getAttempt('followup-key-9').status, 'ACCEPTED');
  assert.equal(fake.sent().length, 2);
});

test('R-19 diagnostic mode: the single test bet is spent per cart and a second run is refused before claiming', async (t) => {
  const { cart, store, fake } = await newCart(t, { answer: OK_ANSWER });
  assert.equal((await cart.run(plan(), { now: () => 1000 })).status, 'ACCEPTED');
  const next = plan({ idempotency_key: 'followup-key-9', selection: { ...plan().selection, selection_id: '10:9:0' } });
  await assert.rejects(() => cart.run(next, { now: () => 1000 }), /DIAGNOSTIC_BUDGET_SPENT/);
  assert.equal(store.getAttempt('followup-key-9'), null, 'a refused run must not claim anything');
  assert.equal(fake.sent().length, 1);
});

test('R-19 two concurrent runs on one cart: the second is refused before it claims anything', async (t) => {
  const { cart, store } = await newCart(t, { answer: OK_ANSWER }, {}, { diagnosticMode: false, maxBudgetUsdt: 10 });
  const first = cart.run(plan(), { now: () => 1000 });
  const second = cart.run(plan({ idempotency_key: 'followup-key-8', selection: { ...plan().selection, selection_id: '10:8:0' } }),
    { now: () => 1000 });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((r) => r.status === 'rejected' && /BUSY/.test(String(r.reason.message))).length, 1);
  assert.equal(store.getAttempt('followup-key-8'), null);
});

// ------------------------------------------------------------------ R-24
test('R-24 a reconciled_not_placed revision with operator and evidence frees the selection', async (t) => {
  const { store } = await newCart(t);
  const payload = (k) => ({ idempotency_key: k, stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0' });
  await store.claim('a', { stake: 1, currency: 'USDT', payload: payload('a') });
  await store.record('a', 'SUBMITTING');
  await store.record('a', 'INDETERMINATE', { error: 'timeout' });
  assert.equal(await store.claim('b', { stake: 1, currency: 'USDT', payload: payload('b') }), false);
  await assert.rejects(() => store.addRevision('a', { kind: 'reconciled_not_placed', data: { note: 'looked fine' } }),
    /REVISION_EVIDENCE_REQUIRED/);
  await store.addRevision('a', { kind: 'reconciled_not_placed', data: { operator: 'owner', evidence: 'history 15:30Z: no bet' } });
  assert.equal(store.getAttempt('a').status, 'INDETERMINATE');
  assert.equal(await store.claim('b', { stake: 1, currency: 'USDT', payload: payload('b') }), true);
});

// ------------------------------------------------------------------ R-15
test('R-15 "nothing was sent" needs the in-flight submission token of the process that holds it', async (t) => {
  const { store, file } = await newCart(t);
  const payload = { idempotency_key: 'a', stake: 1, currency: 'USDT', event_id: '1', market_id: '2', selection_id: '10:1:0' };
  await store.claim('a', { stake: 1, currency: 'USDT', payload });
  await store.record('a', 'SUBMITTING');
  await assert.rejects(() => store.record('a', 'WITHDRAWN', { error: 'x', not_sent_proof: { forwarded_requests: 0 } }),
    /NOT_SENT_PROOF_REQUIRED/);
  await assert.rejects(() => store.record('a', 'WITHDRAWN', { error: 'x',
    not_sent_proof: { forwarded_requests: 0, submit_token: 'guess' } }), /NOT_SENT_PROOF_REQUIRED/);
  const token = store.submitToken('a');
  assert.equal(typeof token, 'string');
  const restarted = new DurableAttemptStore(file);
  assert.equal(restarted.submitToken('a'), null);
  await assert.rejects(() => restarted.record('a', 'WITHDRAWN', { error: 'x',
    not_sent_proof: { forwarded_requests: 0, submit_token: token } }), /NOT_SENT_PROOF_REQUIRED/);
  await store.record('a', 'WITHDRAWN', { error: 'x', not_sent_proof: { forwarded_requests: 0, submit_token: token } });
  assert.equal(store.getAttempt('a').status, 'WITHDRAWN');
});

// ------------------------------------------------------------------ R-23
test('R-23 a lock left by this very process is stale, not a 5 second outage', async (t) => {
  const { store } = await newCart(t);
  fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, token: 'left-over', created_at: Date.now() - 60000 }));
  const started = Date.now();
  assert.equal(store.getAttempt('missing'), null);
  assert.ok(Date.now() - started < 2000, 'a stale same-process lock must be reaped promptly');
});

test('R-23 a lock written by another host is never stolen', async (t) => {
  const { store } = await newCart(t);
  fs.writeFileSync(store.lockPath, JSON.stringify({ pid: 999999, host: 'some-other-host.example', token: 'x', created_at: 1 }));
  assert.throws(() => store._acquireLock(150), /DURABLE_STORE_LOCK_TIMEOUT/);
  assert.equal(fs.existsSync(store.lockPath), true);
});

test('R-23 an orphaned reap guard and leftover temporary locks are cleaned instead of blocking the store', async (t) => {
  const { store } = await newCart(t);
  fs.writeFileSync(store.lockPath, JSON.stringify({ pid: 999999, token: 'dead', created_at: 1 }));
  fs.writeFileSync(store.reapPath, JSON.stringify({ pid: 999998, at: Date.now() - 120000 }));
  const leftover = `${store.lockPath}.999997.${'0'.repeat(8)}`;
  fs.writeFileSync(leftover, '{}');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(leftover, old, old);
  assert.equal(store.getAttempt('missing'), null);
  assert.equal(fs.existsSync(store.reapPath), false);
  new DurableAttemptStore(store.filePath);
  assert.equal(fs.existsSync(leftover), false);
});

// ------------------------------------------------------------------ service workers
test('a context that already runs a service worker is not guardable and nothing is clicked', async (t) => {
  const { cart, fake } = await newCart(t, { answer: OK_ANSWER });
  fake.context = () => ({ serviceWorkers: () => [{ url: () => 'https://1win.pro/sw.js' }] });
  const result = await cart.run(plan(), { now: () => 1000 });
  assert.notEqual(result.status, 'ACCEPTED');
  assert.match(String(result.error), /SERVICE_WORKER_PRESENT/);
  assert.equal(fake.sent().length, 0);
  assert.equal(cart.guarded, false);
});
