// The native idempotency key of the first-party request is durable before the request leaves,
// is written once, and a store that cannot take it forwards nothing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

const ODD = '10:193671744120169820:0';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const payload = (key) => ({ idempotency_key: key, stake: 1, currency: 'USDT', event_id: '40021999', market_id: '6271', selection_id: ODD });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-native-key-'));

test('store: written once, only while SUBMITTING, survives a reopen and the terminal transition', async () => {
  const file = path.join(tmp(), 'attempts.json');
  const store = new DurableAttemptStore(file);
  await store.claim('k1', { stake: 1, currency: 'USDT', payload: payload('k1') });
  await assert.rejects(() => store.recordNativeRequest('k1', { idempotency_key: 'n1', body_sha256: sha('a') }), /REQUIRES_SUBMITTING:CLAIMED/);
  await store.record('k1', 'PRE_CHECK_PASSED');
  await store.record('k1', 'SUBMITTING');
  const first = await store.recordNativeRequest('k1', { idempotency_key: 'native-1', body_sha256: sha('a') });
  assert.equal(first.idempotency_key, 'native-1');
  assert.deepEqual(await store.recordNativeRequest('k1', { idempotency_key: 'native-1', body_sha256: sha('a') }), first, 'identical repeat is a no-op');
  await assert.rejects(() => store.recordNativeRequest('k1', { idempotency_key: 'native-2', body_sha256: sha('a') }), /NATIVE_REQUEST_ALREADY_RECORDED/);
  await assert.rejects(() => store.recordNativeRequest('k1', { idempotency_key: 'native-1', body_sha256: sha('b') }), /NATIVE_REQUEST_ALREADY_RECORDED/);
  await store.record('k1', 'INDETERMINATE', { error: 'x' });
  const reopened = new DurableAttemptStore(file);
  assert.equal(reopened.getAttempt('k1').native_request.idempotency_key, 'native-1');
  assert.equal(reopened.listAttempts({ statuses: ['INDETERMINATE'] })[0].native_request.idempotency_key, 'native-1');
  await assert.rejects(() => reopened.recordNativeRequest('k1', { idempotency_key: 'native-1', body_sha256: 'zz' }), /DIGEST_INVALID/);
});

let stand; let browser; let skip = null;
try {
  stand = await startStand({ tls: true });
  const launched = await launchStandBrowser(stand);
  if (!launched) skip = 'playwright unavailable';
  else { browser = launched.browser; await launched.context.close(); }
} catch (error) { skip = String(error.message).slice(0, 100); }
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
test.after(async () => { if (browser) await browser.close().catch(() => {}); if (stand) await stand.close().catch(() => {}); });

async function armedPost(t, { breakStore = false } = {}) {
  if (skip) return t.skip(skip);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`${stand.siteOrigin}/betting/match/sport/40021999`);
    const store = new DurableAttemptStore(path.join(tmp(), 'attempts.json'));
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: { betApiOrigins: [stand.betOrigin] } });
    await cart.installGuard();
    await cart._guard.ensureFreshDocument();
    await page.goto(`${stand.siteOrigin}/betting/match/sport/40021999`);
    await store.claim('k-native', { stake: 1, currency: 'USDT', payload: payload('k-native') });
    await store.record('k-native', 'PRE_CHECK_PASSED');
    await store.record('k-native', 'SUBMITTING');
    if (breakStore) store.recordNativeRequest = async () => { throw new Error('disk full'); };
    cart._runtime = { now: () => 1000, cancelled: async () => false };
    cart.armedExpectation = { idempotencyKey: 'k-native', eventId: '40021999', marketId: '6271', selectionId: ODD, stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
    const body = JSON.stringify({ currencyCode: 'USDT', idempotencyKey: 'page-generated-uuid', amount: 1,
      coupon: { amount: 1, selections: [{ oddId: ODD, cf: 1.87, matchId: '40021999' }] }, wallet: { type: 'real' } });
    const answer = await page.evaluate(async ({ url, body }) => {
      try { return { status: (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status }; }
      catch (e) { return { failed: String(e.message) }; }
    }, { url: `${stand.betOrigin}/bets/make-bet-v2`, body });
    return { answer, store, cart, body };
  } finally { await context.close(); }
}

test('cart: the key of the request on the wire is already in the durable attempt, with the digest of the exact body', async (t) => {
  const run = await armedPost(t);
  if (!run) return;
  assert.equal(run.answer.status, 200);
  assert.equal(stand.log.money.length, 1);
  const attempt = run.store.getAttempt('k-native');
  assert.equal(attempt.native_request.idempotency_key, stand.log.money[0].body.idempotencyKey);
  assert.equal(attempt.native_request.body_sha256, sha(run.body));
});

test('cart: a store that cannot take the key forwards nothing', async (t) => {
  const run = await armedPost(t, { breakStore: true });
  if (!run) return;
  assert.ok(run.answer.failed, JSON.stringify(run.answer));
  assert.equal(stand.log.money.length, 0);
  assert.ok(run.cart.blocked_reasons.some((r) => r.startsWith('native_request_not_recorded:')), JSON.stringify(run.cart.blocked_reasons));
  assert.equal(run.cart.submitSentCount, 0);
});
