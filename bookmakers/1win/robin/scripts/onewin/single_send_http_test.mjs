// Real browser, literal loopback native endpoint, synthetic counter only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

const EVENT = '/betting/match/sport/40021999';
const ODD = '10:193671744120169820:0';

async function fixture(fn, { proxy = false, httpCredentials = null } = {}) {
  const stand = await startStand({ tls: true });
  stand.betOrigin = `https://127.0.0.1:${stand.port}`;
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const launched = await launchStandBrowser(stand);
  const browser = launched.browser;
  await launched.context.close();
  const proxySockets = new Set();
  const proxyUpstreamPorts = new Set();
  let proxyServer = null;
  let proxyOptions = {};
  if (proxy) {
    proxyServer = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxyServer.on('connect', (req, client, head) => {
      const destination = new URL('http://' + req.url);
      // Every tunnel is pinned to this fixture; background/external requests are refused.
      if (Number(destination.port) !== stand.port
          || !['127.0.0.1', '1win.pro', 'api-gateway.top-parser.com'].includes(destination.hostname)) {
        client.destroy(); return;
      }
      const upstream = net.connect(stand.port, '127.0.0.1', () => {
        proxyUpstreamPorts.add(upstream.localPort);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      for (const socket of [client, upstream]) {
        proxySockets.add(socket);
        socket.on('error', () => { client.destroy(); upstream.destroy(); });
        socket.on('close', () => proxySockets.delete(socket));
      }
    });
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyOptions = { proxy: { server: 'http://127.0.0.1:' + proxyServer.address().port } };
  }
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...proxyOptions,
    ...(httpCredentials ? { httpCredentials } : {}) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-single-send-'));
  try {
    const page = await context.newPage();
    await page.goto(stand.siteOrigin + EVENT);
    const store = new DurableAttemptStore(path.join(dir, 'attempts.json'));
    process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true,
      transportPolicy: { betApiOrigins: [stand.betOrigin] } });
    await cart.installGuard();
    await cart._guard.ensureFreshDocument();
    await page.goto(stand.siteOrigin + EVENT);
    const key = 'single-send-key';
    await store.claim(key, { stake: 1, currency: 'USDT', payload: {
      idempotency_key: key, stake: 1, currency: 'USDT', event_id: '40021999', market_id: '6271', selection_id: ODD } });
    await store.record(key, 'PRE_CHECK_PASSED');
    await store.record(key, 'SUBMITTING');
    cart._runtime = { now: () => 1000, cancelled: async () => false };
    cart.armedExpectation = { idempotencyKey: key, eventId: '40021999', marketId: '6271',
      selectionId: ODD, stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
    const raw = JSON.stringify({ currencyCode: 'USDT', idempotencyKey: 'synthetic-native-key', amount: 1,
      coupon: { amount: 1, selections: [{ oddId: ODD, cf: 1.87, matchId: '40021999' }] }, wallet: { type: 'real' } });
    const send = () => page.evaluate(async ({ url, raw }) => {
      try { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
        return { status: response.status, body: await response.json() }; }
      catch { return { failed: true }; }
    }, { url: stand.betOrigin + '/bets/make-bet-v2', raw });
    await fn({ stand, page, context, cart, store, key, raw, send, proxyUpstreamPorts });
  } finally {
    await context.close();
    await browser.close();
    for (const socket of proxySockets) socket.destroy();
    if (proxyServer) await new Promise(resolve => proxyServer.close(resolve));
    await stand.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('single-send: successful response and exact native body survive', async () => {
  await fixture(async ({ stand, cart, store, key, raw, send }) => {
    const result = await send();
    assert.equal(result.status, 200);
    assert.equal(result.body.result.success.betId, 'STAND-1');
    assert.equal(stand.log.money.length, 1);
    assert.equal(cart.submitSentCount, 1);
    assert.equal(store.getAttempt(key).native_request.body_sha256,
      crypto.createHash('sha256').update(raw).digest('hex'));
    await send();
    assert.equal(stand.log.money.length, 1, 'another page attempt cannot reuse the permission');
  });
});

test('single-send: native request uses the configured context proxy', async () => {
  await fixture(async ({ stand, send, proxyUpstreamPorts }) => {
    let port = null;
    stand.hooks.onMakeBet = (_body, _sequence, observed) => { port = observed.socketRemotePort; };
    assert.equal((await send()).status, 200);
    assert.equal(stand.log.money.length, 1);
    assert.ok(proxyUpstreamPorts.has(port), 'Native TLS request bypassed the configured proxy');
  }, { proxy: true });
});

test('single-send: lost response on primed browser connection is one uncertain request', async () => {
  await fixture(async ({ stand, page, cart, send }) => {
    await page.evaluate(url => fetch(url, { method: 'POST', body: '{}' }).then(() => null),
      stand.betOrigin + '/bets/get-max-bet-amount');
    stand.hooks.dropMakeBet = 1;
    assert.equal((await send()).failed, true);
    assert.equal(stand.log.money.length, 1);
    assert.equal(cart.submitSentCount, 1);
    assert.equal(cart.submitTransportUnknown, true);
    await send();
    assert.equal(stand.log.money.length, 1);
  });
});

test('single-send: context cookie and authorization header reach only the approved endpoint', async () => {
  await fixture(async ({ stand, page, context, cart, send }) => {
    let receivedHeaders = null;
    stand.hooks.onMakeBet = (_body, _sequence, observed) => { receivedHeaders = observed.headers; };
    await context.addCookies([{ name: 'stand_cookie', value: 'synthetic-cookie', domain: '127.0.0.1', path: '/', secure: true }]);
    await page.setExtraHTTPHeaders({ authorization: 'Bearer synthetic-token' });
    const result = await send();
    assert.equal(result.status, 200);
    assert.equal(stand.log.money.length, 1);
    assert.equal(cart.submitSentCount, 1);
    assert.equal(receivedHeaders.authorization, 'Bearer synthetic-token');
    assert.match(receivedHeaders.cookie, /stand_cookie=synthetic-cookie/);
  });
});

test('single-send: a body-preserving redirect never creates another request', async () => {
  await fixture(async ({ stand, cart, send }) => {
    stand.hooks.makeBetRedirect = '/bets/make-bet-v2?redirected=1';
    assert.equal((await send()).failed, true);
    assert.equal(stand.log.money.length, 1);
    assert.equal(cart.submitTransportUnknown, true);
    assert.equal(cart.submitSentCount, 1);
  });
});

test('single-send: HTTP Basic credentials cannot enable a hidden authentication replay', async () => {
  await fixture(async ({ stand, cart, send }) => {
    stand.hooks.makeBetBasicChallenge = true;
    await send();
    assert.equal(stand.log.money.length, 0, 'An authentication-retrying transport must be refused before native send');
    assert.equal(cart.submitSentCount, 0);
    assert.ok(cart.blocked_reasons.includes('single_send_http_auth_unverified'));
  }, { httpCredentials: { username: 'synthetic-user', password: 'synthetic-password' } });
});
