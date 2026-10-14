// The make-bet-v2 wire contract as the FIRST-PARTY client implements it (betting bundle
// betting-4a7Dz1oG.js, fetched 2026-10-13 through the approved read-only session; see
// evidence/native-wire-contract.json): request {currencyCode, idempotencyKey, amount, meta,
// coupon:{amount, selections:[{oddId, cf, matchId}]}, wallet:{type:'real'}}; answer {result} or
// {errors:[{code,meta}]}, and inside result either {success:{betId,currencyCode,cf,amount,...}} or
// {error:{code, selections?}}. The stand answers with every shape of that contract and the real
// OneWinLiveCart must classify each one without a second attempt. Receipts here are SYNTHETIC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

let stand = null;
let browser = null;
let skip = null;
try {
  stand = await startStand({ tls: true });
  const launched = await launchStandBrowser(stand);
  if (!launched) skip = 'playwright is not installed';
  else { browser = launched.browser; await launched.context.close(); }
} catch (error) { skip = `stand unavailable: ${String(error.message).slice(0, 100)}`; }
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
test.after(async () => { if (browser) await browser.close().catch(() => {}); if (stand) await stand.close().catch(() => {}); });

const ODD = '10:193671744120169820:0';
let currentOdd = ODD;
const plan = (key) => {
  const axes = { period: 'full_time', scope: 'REG', unit: 'goals', market: 'total', line: 60.5, side: 'under',
    payout_rule: { status: 'not_declared', result_variant: null, draw_payout: null } };
  const t = Date.now() / 1000 + 600;
  return { ok: true, execution_ready: true, execution_blockers: [], live_submit_contract_verified: true,
    live_submit_contract_source: 'local-stand-first-party-contract', idempotency_key: key, stake: 1, currency: 'USDT', expires_at: t,
    evidence: { expiries: Object.fromEntries(['task', 'donor', 'reference', 'margins', 'executor_quote', 'account'].map((k) => [k, t])) },
    expected_axes: { ...axes },
    account_conditions: { logged_in: true, account_identity_verified: true, account_identity_source: 'local-stand', currency: 'USDT',
      available_balance: 8.45, commission: 0, max_stake: 8.45, live_submit_contract_verified: true },
    selection: { event_id: '40021999', event_url: `https://1win.pro:${stand.port}/betting/match/sport/40021999`, market_id: '6271',
      market_name: 'Total', selection_id: currentOdd, price: 1.87, axes: { ...axes } },
    ui_selection_name: 'Under 60.5' };
};

async function placeWith(answer, key, { drop = false, redirect = false } = {}) {
  stand.reset();
  stand.hooks.makeBetAnswer = answer;
  stand.hooks.dropMakeBet = drop ? 1 : 0;
  stand.hooks.makeBetRedirect = redirect ? '/bets/make-bet-v2?redirected=1' : null;
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin, oddId: currentOdd }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-wire-'));
  try {
    const page = await context.newPage();
    const store = new DurableAttemptStore(path.join(dir, 'a.json'));
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: { betApiOrigins: [stand.betOrigin] } });
    const result = await cart.run(plan(key), { now: () => Date.now() / 1000 });
    const recovered = new DurableAttemptStore(path.join(dir, 'a.json'));
    const attempt = recovered.getAttempt(key);
    const sameKeyClaimed = await recovered.claim(key, { stake: 1, currency: 'USDT', payload: { idempotency_key: key } });
    // can ANOTHER key take the same native selection afterwards?
    const second = await recovered.claim(`${key}-again`, { stake: 1, currency: 'USDT',
      payload: { idempotency_key: `${key}-again`, stake: 1, currency: 'USDT', event_id: '40021999', market_id: '6271', selection_id: ODD } });
    return { result, attempt, sameKeyClaimed, selectionReleased: second === true, moneyReached: stand.log.money.length,
      requestBody: stand.log.money[0] && stand.log.money[0].body };
  } finally {
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
    stand.hooks.dropMakeBet = 0;
    stand.hooks.makeBetRedirect = null;
  }
}

test('the request of the first-party client passes the cart validation and carries its own idempotency key', async (t) => {
  if (skip) return t.skip(skip);
  const r = await placeWith(null, 'wire-ok');
  assert.equal(r.result.status, 'ACCEPTED', JSON.stringify(r.result));
  assert.equal(r.moneyReached, 1);
  const body = r.requestBody;
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'coupon', 'currencyCode', 'idempotencyKey', 'meta', 'wallet']);
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(body.coupon.selections[0]).sort(), ['cf', 'matchId', 'oddId']);
  assert.equal(r.attempt.status, 'ACCEPTED');
  assert.equal(r.selectionReleased, false, 'an accepted bet keeps its selection owned');
});

test('both native odd id forms of the feed are accepted, anything else is refused before a claim', async (t) => {
  if (skip) return t.skip(skip);
  try {
    for (const odd of ['10:56847534920502740:0', '1:761353402:_:17:10:32.5:_', '1:761353402:_:1:1:_:_', '1:761353402:_:2:7:-1.5:_']) {
      currentOdd = odd;
      const r = await placeWith(null, `wire-odd-${odd.length}-${odd.charCodeAt(0)}-${odd.slice(-6).replace(/\W/g, '')}`);
      assert.equal(r.result.status, 'ACCEPTED', `${odd}: ${JSON.stringify(r.result)}`);
      assert.equal(r.requestBody.coupon.selections[0].oddId, odd);
    }
    for (const bad of ['', '10:abc:0', '10:1:2:3', '1:761353402:x:17:10:32.5:_', 'DROP:1:2', ' 10:1:2']) {
      currentOdd = bad;
      stand.reset();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-wire-bad-'));
        const cart = new OneWinLiveCart(page, { attemptStore: new DurableAttemptStore(path.join(dir, 'a.json')), liveEnabled: true,
          transportPolicy: { betApiOrigins: [stand.betOrigin] } });
        const out = await cart.run(plan('wire-bad-odd'), { now: () => Date.now() / 1000 }).catch((e) => ({ thrown: String(e.message) }));
        assert.match(String(out.thrown || out.error), /EXACT_SELECTION_IDENTITY_REQUIRED/, JSON.stringify(bad));
        assert.equal(stand.log.money.length, 0);
      } finally { await context.close(); }
    }
  } finally { currentOdd = ODD; }
});

test('a request that drifts from the first-party contract is never forwarded and the attempt is withdrawn', async (t) => {
  if (skip) return t.skip(skip);
  const mutations = {
    unknown_top_field: "body.fastBet = true;",
    unknown_selection_field: "body.coupon.selections[0].stakeFactor = 2;",
    shared_bet_code: "body.meta.sharedBetCode = 'ABC123';",
    bonus_percent: "body.bonusPercent = 10;",
    freebet: "body.freebetId = 'fb-1';",
    wrong_amount: "body.amount = 9999; body.coupon.amount = 9999;",
    wrong_odd: "body.coupon.selections[0].oddId = '10:1:1';",
    wrong_cf: "body.coupon.selections[0].cf = 2.5;",
    two_selections: "body.coupon.selections.push({ oddId: '10:2:2', cf: 1.5, matchId: '1' });",
    bonus_wallet: "body.wallet = { type: 'bonus', bonusId: 'b1' };",
    other_currency: "body.currencyCode = 'EUR';",
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    stand.reset();
    stand.hooks.makeBetAnswer = null;
    stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin, oddId: currentOdd, mutateBody: mutate }));
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-wire-drift-'));
      const store = new DurableAttemptStore(path.join(dir, 'a.json'));
      const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: { betApiOrigins: [stand.betOrigin] } });
      const r = await cart.run(plan(`wire-drift-${name}`), { now: () => Date.now() / 1000 });
      assert.equal(stand.log.money.length, 0, `${name}: nothing may reach the bookmaker`);
      assert.equal(r.status, 'ABORTED_PRE_SUBMIT', `${name}: ${JSON.stringify(r.error)}`);
      assert.equal(r.submit_sent_count, 0);
      assert.equal(store.getAttempt(`wire-drift-${name}`).status, 'WITHDRAWN');
    } finally { await context.close(); }
  }
});

const rejected = (code, extra = {}) => () => ({ result: { error: { code, ...extra } } });
for (const code of ['odd_cf_changed', 'odd_closed', 'not_enough_funds', 'min_bet_amount_v2', 'max_bet_amount_v2', 'events_bet_limit_reached']) {
  test(`in-band rejection ${code} is REJECTED (decided answer), the selection is released and nothing is retried`, async (t) => {
    if (skip) return t.skip(skip);
    const r = await placeWith(rejected(code), `wire-${code}`);
    assert.equal(r.result.status, 'REJECTED', JSON.stringify(r.result));
    assert.equal(r.result.rejection_code, code);
    assert.equal(r.moneyReached, 1, 'exactly one request was ever made');
    assert.equal(r.result.submit_sent_count, 1);
    assert.equal(r.attempt.status, 'REJECTED');
    assert.equal(r.selectionReleased, true);
  });
}

test('selections_errors with known per-selection codes is REJECTED with the first selection code', async (t) => {
  if (skip) return t.skip(skip);
  const r = await placeWith(() => ({ result: { error: { code: 'selections_errors', selections: [{ oddId: ODD, error: { code: 'odd_closed' } }] } } }), 'wire-sel');
  assert.equal(r.result.status, 'REJECTED');
  assert.equal(r.result.rejection_code, 'odd_closed');
  assert.equal(r.selectionReleased, true);
});

test('an unknown code, an auth error and rate limiting are INDETERMINATE: the selection stays owned', async (t) => {
  if (skip) return t.skip(skip);
  for (const [name, answer] of [
    ['unknown', rejected('some_new_code_2027')],
    ['unauth', () => ({ errors: [{ code: 'unauthenticated_error' }] })],
    ['ratelimit', () => ({ errors: [{ code: 'many_request_error' }] })],
    ['selections_unknown', () => ({ result: { error: { code: 'selections_errors', selections: [{ oddId: ODD, error: { code: 'brand_new' } }] } } })],
    ['empty_selections', () => ({ result: { error: { code: 'selections_errors', selections: [] } } })],
    ['mixed', () => ({ result: { error: { code: 'odd_cf_changed' }, success: { betId: 7, cf: 1.87, amount: 1, currencyCode: 'USDT' } } })],
    ['no_body_shape', () => ({ hello: 'world' })],
  ]) {
    const r = await placeWith(answer, `wire-${name}`);
    assert.equal(r.result.status, 'INDETERMINATE', `${name}: ${JSON.stringify(r.result)}`);
    assert.equal(r.attempt.status, 'INDETERMINATE');
    assert.equal(r.selectionReleased, false, `${name}: an unknown outcome must keep the selection blocked`);
    assert.equal(r.moneyReached, 1);
  }
});

test('an accepted answer with other facts than asked is ACCEPTED with condition mismatches, never silently ok', async (t) => {
  if (skip) return t.skip(skip);
  const r = await placeWith(() => ({ result: { success: { betId: 99, currencyCode: 'USDT', cf: 1.5, amount: 1, possibleProfitAmount: 1.5, rejectedAmount: 0 } } }), 'wire-cf');
  assert.equal(r.result.status, 'ACCEPTED');
  assert.equal(r.result.ok, false);
  assert.deepEqual(r.result.condition_mismatches, ['accepted_cf_mismatch']);
  assert.equal(r.attempt.status, 'ACCEPTED');
});

for (const [name, fault] of [['lost response', { drop: true }], ['307 redirect', { redirect: true }]]) {
  test(`single-send end to end: ${name} remains durably INDETERMINATE after reopening the store`, async (t) => {
    if (skip) return t.skip(skip);
    const r = await placeWith(null, `wire-single-send-${name.replace(/ /g, '-')}`, fault);
    assert.equal(r.moneyReached, 1);
    assert.equal(r.result.status, 'INDETERMINATE');
    assert.equal(r.result.submit_sent_count, 1);
    assert.equal(r.result.submit_transport_unknown, true);
    assert.equal(r.attempt.status, 'INDETERMINATE');
    assert.equal(r.sameKeyClaimed, false);
    assert.equal(r.selectionReleased, false, 'Unknown delivery must continue owning the selection after restart');
    assert.ok(r.attempt.native_request.body_sha256);
    assert.ok(r.attempt.native_request.idempotency_key);
    assert.equal(r.attempt.not_sent_proof, undefined);
  });
}
