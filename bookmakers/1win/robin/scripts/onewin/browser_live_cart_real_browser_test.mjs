// Route-guard semantics under a REAL Chromium (Playwright), without any external network: the
// bet host name is mapped to a local server with --host-resolver-rules. Skipped when Playwright
// or its browser is not installed. Does not touch the 1win site, any account or any proxy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';

let chromium = null;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/srv/betting/automation/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = await import(spec)); break; } catch { /* try next */ }
}
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'].find((p) => fs.existsSync(p));

const HOST = 'api-gateway.top-parser.com';
const plan = {
  idempotency_key: 'real-browser-1', stake: 1, currency: 'USDT',
  selection: { event_id: '40021999', market_id: '6271', selection_id: '10:193671744120169820:0', price: 1.87 },
};
const goodBody = {
  currencyCode: 'USDT', amount: 1,
  coupon: { amount: 1, selections: [{ oddId: plan.selection.selection_id, cf: 1.87, matchId: '40021999', marketId: '6271' }] },
  wallet: { type: 'real' },
};

async function withBrowser(t, fn) {
  if (!chromium) return t.skip('playwright is not installed');
  const received = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/bets/')) { res.setHeader('content-type', 'text/html'); res.end('<html><body>ok</body></html>'); return; }
      received.push({ method: req.method, url: req.url });  // only bet-API paths count (browser favicon etc. do not)
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { success: { betId: 1, cf: 1.87, amount: 1, currencyCode: 'USDT' } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined, args: [
      '--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--proxy-bypass-list=<-loopback>'] });
  } catch (e) {
    server.close();
    return t.skip(`chromium unavailable: ${String(e.message).slice(0, 80)}`);
  }
  try {
    const page = await browser.newPage();
    await page.goto(`http://${HOST}:${port}/`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-real-browser-'));
    process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
    const store = new DurableAttemptStore(path.join(dir, 'attempts.json'));
    await store.claim(plan.idempotency_key, { stake: 1, currency: 'USDT', payload: { ...plan, event_id: '40021999',
      market_id: '6271', selection_id: plan.selection.selection_id } });
    await store.record(plan.idempotency_key, 'PRE_CHECK_PASSED');
    await store.record(plan.idempotency_key, 'SUBMITTING');
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true,
      transportPolicy: { betApiOrigins: [`http://${HOST}:${port}`] } });
    const clock = { t: 1000 };
    cart._runtime = { now: () => clock.t, cancelled: async () => false };
    await cart.installGuard();
    const arm = () => {
      cart.submitArmed = true;
      cart.armedExpectation = { idempotencyKey: plan.idempotency_key, eventId: '40021999', marketId: '6271',
        selectionId: plan.selection.selection_id, stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
    };
    const post = (pathName, method = 'POST', body = goodBody) => page.evaluate(async ({ url, method, body }) => {
      try {
        const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { ok: true, status: r.status };
      } catch (e) { return { ok: false, error: String(e) }; }
    }, { url: `http://${HOST}:${port}${pathName}`, method, body });
    await fn({ page, cart, store, clock, arm, post, received });
  } finally {
    await browser.close();
    server.close();
  }
}

test('real Chromium: only the armed, fresh, exact POST reaches the server', async (t) => {
  await withBrowser(t, async ({ cart, post, arm, received, clock }) => {
    assert.equal((await post('/bets/make-bet-v2')).ok, false, 'an unarmed POST must be aborted');
    assert.equal(received.length, 0);
    arm();
    assert.equal((await post('/bets/make-bet-v3')).ok, false, 'another version must be aborted');
    assert.equal((await post('/bets/make-bet-v2', 'PUT')).ok, false, 'another verb must be aborted');
    assert.equal(received.length, 0);
    arm();
    const sentOk = await post('/bets/make-bet-v2');
    assert.equal(sentOk.ok, true);
    assert.equal(received.length, 1);
    assert.equal(cart.submitSentCount, 1);
    arm();
    assert.equal((await post('/bets/make-bet-v2')).ok, false, 'a second POST must be refused (one per run)');
    assert.equal(received.length, 1);
    void clock;
  });
});

test('real Chromium: expiry decided at the boundary and a body mismatch never reach the server', async (t) => {
  await withBrowser(t, async ({ cart, post, arm, received, clock }) => {
    arm();
    clock.t = 2001;
    assert.equal((await post('/bets/make-bet-v2')).ok, false);
    assert.ok(cart.blocked_reasons.includes('expired_at_post_boundary'), JSON.stringify(cart.blocked_reasons));
    clock.t = 1000;
    arm();
    const tampered = { ...goodBody, amount: 9999, coupon: { ...goodBody.coupon, amount: 9999 } };
    assert.equal((await post('/bets/make-bet-v2', 'POST', tampered)).ok, false);
    assert.equal(received.length, 0);
  });
});

test('real Chromium: a mutation next to the armed submit is stopped, reads pass', async (t) => {
  await withBrowser(t, async ({ cart, page, post, arm, received }) => {
    arm();
    assert.equal((await post('/bets/other-mutation', 'POST', { a: 1 })).ok, false);
    assert.ok(cart.blocked_reasons.includes('unexpected_mutation_while_armed'));
    assert.equal(received.length, 0);
    const read = await page.evaluate(async (url) => (await fetch(url)).status, `http://${HOST}:${new URL(page.url()).port}/bets/get-something`);
    assert.equal(read, 200);
    assert.equal(received.filter((r) => r.method === 'GET').length, 1);
  });
});
