// Transport boundary of the carts under a REAL Chromium against a local first-party stand (own HTTP
// and WebSocket endpoints, own TLS certificate, no external bookmaker, no account, no proxy).
//
// Every scenario runs for BOTH carts. "money" is whatever reached the stand's bet endpoints: the
// stand counts a request/frame as accepted money, so `stand.log.money.length === 0` is the assertion
// that a transport did not get through. The scenarios were first run against d454 (no WebSocket, worker,
// popup, service-worker or unknown-endpoint coverage) to prove they are reachable there; see the
// RED evidence in evidence/transport-red-d454.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OneWinDryRunCart } from './browser_cart.mjs';
import { OneWinLiveCart, DurableAttemptStore } from './browser_live_cart.mjs';
import { classifyHttpRequest, classifyWsFrame, READ_ONLY_POST_PATHS } from './transport_guard.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

const EVENT_PATH = '/betting/match/sport/40021999';

// ---------------------------------------------------------------- pure classification
test('WS frames: control, connect and subscribe-* pass; every other event, binary and junk is refused', () => {
  for (const frame of ['2', '3', '2probe', '3probe', '5', '40', '40/ns,', '40{"token":"x"}', '41',
    '42["subscribe",{"messageType":"subscribe-match-odds","data":{"matchIds":[1]}}]',
    '421["unsubscribe",{"messageType":"unsubscribe-match-odds"}]',
    '42/feed,["subscribe",{"messageType":"subscribe-live-matches"}]']) {
    assert.equal(classifyWsFrame(frame).ok, true, frame);
  }
  for (const frame of ['42["place-bet",{"stake":1}]', '42["subscribe",{"messageType":"make-bet"}]',
    '42["subscribe",{"messageType":"subscribe-x"},"extra"]', '42["bet"]', '42[]', '42{"a":1}', '42["subscribe"',
    '45["subscribe",{"messageType":"subscribe-a"}]', '46', '4', 'hello', '', '40{broken', Buffer.from('42')]) {
    assert.equal(classifyWsFrame(frame).ok, false, String(frame));
  }
});

test('HTTP classification: default deny for every non-read request that is not a proven read endpoint', () => {
  const origin = 'https://api-gateway.top-parser.com';
  const c = (method, url, live = false) => classifyHttpRequest({ method, url, live }).kind;
  assert.equal(c('GET', `${origin}/bets/get-base-settings`), 'read');
  assert.equal(c('POST', `${origin}/bets/get-max-bet-amount`), 'read_post');
  assert.equal(c('POST', `${origin}/bets/get-auto-bet-amount-v2`), 'read_post');
  assert.equal(c('POST', `${origin}/matches/get-many`), 'read_post');
  assert.equal(c('POST', `${origin}/highlights/get-many`), 'read_post');
  for (const refused of ['/monitoring/log-event', '/matches/delete-many', '/bets/get-max-bet-amount/extra']) {
    assert.equal(c('POST', `${origin}${refused}`), 'blocked', refused);
  }
  // session bootstrap: only the public-token exchange, never a credential login
  const login = (postBody) => classifyHttpRequest({ method: 'POST', url: `${origin}/auth/login`, postBody }).kind;
  assert.equal(login({ publicToken: 'abc' }), 'read_post');
  for (const bad of [undefined, null, {}, { publicToken: '' }, { publicToken: 'a', password: 'x' }, { email: 'a@b.c', password: 'x' }, [], 'x']) {
    assert.equal(login(bad), 'blocked', JSON.stringify(bad));
  }
  assert.equal(classifyHttpRequest({ method: 'POST', url: 'https://1win.pro/auth/login', postBody: { publicToken: 'a' } }).kind, 'blocked',
    'only the bet API origin may bootstrap a session');
  assert.equal(c('POST', 'https://evil.example/bets/get-max-bet-amount'), 'blocked', 'read endpoint on another origin');
  assert.equal(c('PUT', `${origin}/bets/get-max-bet-amount`), 'blocked');
  for (const url of [`${origin}/fortune-wheel/make-roll`, `${origin}/bets/api/v1/user/bets/ordinary`, `${origin}/bets/make-bet-v3`,
    `${origin}/telemetry/collect`, `${origin}/bets/refund`, `${origin}/anything/new`]) {
    assert.equal(c('POST', url), 'blocked', url);
  }
  assert.equal(c('GET', `${origin}/bets/make-bet-v2?amount=1`), 'blocked', 'a GET does not make a placement endpoint read-only');
  assert.equal(c('GET', `${origin}/fortune-wheel/make-roll`), 'blocked');
  assert.equal(c('GET', 'https://1win.pro/assets/wager-icon.svg'), 'read', 'static assets keep loading');
  for (const encoded of ['/bets/make%2Dbet-v2', '/bets/make%252Dbet-v2', '/fortune-wheel/make%2Droll', '/%62ets/refund']) {
    assert.equal(c('GET', `${origin}${encoded}`), 'blocked', `GET ${encoded}`);
    assert.equal(c('POST', `${origin}${encoded}`, true), 'blocked', `POST ${encoded}`);
  }
  assert.equal(c('POST', `${origin}/bets/make-bet-v2`, true), 'submit_endpoint');
  assert.equal(c('POST', `${origin}/bets/make-bet-v2`, false), 'blocked', 'the read-only cart has no submit endpoint');
  assert.ok(READ_ONLY_POST_PATHS.every((p) => /^\/[a-z]+\/get-[a-z0-9-]+$/.test(p)), 'only get-* reads are allow-listed');
});

// ---------------------------------------------------------------- real browser
let stand = null;
let browser = null;
let skipReason = null;
try {
  stand = await startStand({ tls: true });
  const launched = await launchStandBrowser(stand);
  if (!launched) skipReason = 'playwright is not installed';
  else {
    browser = launched.browser;
    await launched.context.close();
  }
} catch (error) {
  skipReason = `stand or chromium unavailable: ${String(error.message).slice(0, 120)}`;
  if (stand) await stand.close().catch(() => {});
  stand = null;
}
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
test.after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (stand) await stand.close().catch(() => {});
});

const POLICY = () => ({ betApiOrigins: [stand.betOrigin] });
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-transport-'));
  return { store: new DurableAttemptStore(path.join(dir, 'attempts.json')), dir };
}

async function withCart(t, kind, fn, { contextOptions = {}, beforeGuard = null, fresh = true } = {}) {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...contextOptions });
  try {
    const page = await context.newPage();
    await page.goto(stand.siteOrigin + EVENT_PATH);
    if (beforeGuard) await beforeGuard({ page, context });
    let cart;
    let dir = null;
    if (kind === 'dry') cart = new OneWinDryRunCart(page, { transportPolicy: POLICY() });
    else {
      const made = tempStore();
      dir = made.dir;
      cart = new OneWinLiveCart(page, { attemptStore: made.store, liveEnabled: true, transportPolicy: POLICY() });
    }
    await cart.installGuard();
    if (fresh) {
      await cart._guard.ensureFreshDocument();
      await page.goto(stand.siteOrigin + EVENT_PATH);
    }
    const helpers = {
      wsExchange: (path_, frames, wait = 250) => page.evaluate(({ url, frames, wait }) => new Promise((resolve) => {
        const received = [];
        let socket;
        try { socket = new WebSocket(url); } catch (e) { resolve({ error: String(e), received }); return; }
        socket.onmessage = (e) => received.push(String(e.data));
        socket.onerror = () => resolve({ error: 'socket_error', received });
        socket.onopen = () => { for (const f of frames) socket.send(f); setTimeout(() => { resolve({ received }); try { socket.close(); } catch { /* closed */ } }, wait); };
      }), { url: stand.wsBase + path_, frames, wait }),
      post: (url, body = { amount: 1 }, method = 'POST') => page.evaluate(({ url, body, method }) =>
        fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then((r) => ({ status: r.status })).catch((e) => ({ blocked: String(e.message) })), { url, body, method }),
      get: (url) => page.evaluate((url) => fetch(url).then((r) => ({ status: r.status })).catch((e) => ({ blocked: String(e.message) })), url),
      settle: (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    await fn({ page, context, cart, stand, ...helpers });
  } finally {
    await context.close().catch(() => {});
  }
}

for (const kind of ['dry', 'live']) {
  test(`${kind}: coverage canary proves every layer on the document that will be used`, async (t) => {
    await withCart(t, kind, async ({ cart }) => {
      const verdict = await cart._guard.verifyCoverage();
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      assert.deepEqual(Object.keys(verdict.checks).sort(), ['http_canary', 'http_route', 'init_script', 'no_foreign_worker',
        'redirect_guard', 'service_worker_blocked', 'worker_blocked', 'ws_canary', 'ws_route']);
      assert.equal(stand.log.http.some((h) => /canary/.test(String(h.host))), false, 'canary never reaches the network');
    });
  });

  test(`${kind}: a document created before the guard is NOT covered and the canary says so`, async (t) => {
    await withCart(t, kind, async ({ cart }) => {
      const verdict = await cart._guard.verifyCoverage();
      assert.equal(verdict.ok, false);
      assert.equal(verdict.checks.worker_blocked, false, 'workers of a pre-guard document are not blocked');
    }, { fresh: false });
  });

  test(`${kind}: a socket opened before the guard dies with the pre-guard document; the new document is clean`, async (t) => {
    await withCart(t, kind, async ({ page, cart, wsExchange, settle }) => {
      assert.equal(await page.evaluate(() => window.__preGuardSocket === undefined), true, 'fresh document has no inherited socket');
      assert.equal(cart._guard.needsFreshDocument, false);
      const attack = await wsExchange('/ws/bet', ['42["place-bet",{}]']);
      await settle();
      assert.equal(stand.log.money.length, 0, JSON.stringify(attack));
    }, { beforeGuard: async ({ page }) => {
      // an existing, already open socket of the document that predates the guard
      await page.evaluate(({ url }) => new Promise((resolve) => {
        window.__preGuardSocket = new WebSocket(url);
        window.__preGuardSocket.onopen = () => resolve();
      }), { url: stand.wsBase + '/ws/bet' });
    } });
  });

  test(`${kind}: WebSocket mutation frame on a new socket is refused, subscriptions keep working`, async (t) => {
    await withCart(t, kind, async ({ wsExchange, settle }) => {
      const read = await wsExchange('/push-server-v2/', ['40', '3',
        '42["subscribe",{"messageType":"subscribe-match-odds","data":{"matchIds":[40021999],"isBaseOddsGroups":false}}]']);
      assert.ok(read.received.some((m) => m.includes('match-odds-snapshot')), `quote feed must keep working: ${JSON.stringify(read)}`);
      const attack = await wsExchange('/ws/bet', ['42["place-bet",{"stake":1,"currency":"USDT"}]']);
      await settle();
      assert.equal(stand.log.money.length, 0, 'no money frame reached the server');
      assert.equal(attack.received.some((m) => m.includes('bet-accepted')), false);
      assert.ok(stand.log.ws.some((f) => f.data.includes('subscribe-match-odds')), 'the read frame did reach the server');
      assert.equal(stand.log.ws.some((f) => f.data.includes('place-bet')), false);
    });
  });

  test(`${kind}: after the server drops the socket a re-connection is guarded again`, async (t) => {
    await withCart(t, kind, async ({ page, wsExchange, settle }) => {
      const first = await wsExchange('/push-server-v2/', ['40']);
      assert.ok(first.received.length >= 1);
      for (let i = 0; i < 3; i += 1) {
        await page.evaluate(({ url }) => new Promise((resolve) => {
          const s = new WebSocket(url);
          s.onopen = () => { s.close(); setTimeout(resolve, 100); };
        }), { url: stand.wsBase + '/push-server-v2/' });
      }
      const attack = await wsExchange('/push-server-v2/', ['42["place-bet",{"stake":1}]']);
      await settle();
      assert.equal(stand.log.money.length, 0);
      void attack;
    });
  });

  test(`${kind}: dedicated worker can neither post a mutation nor open a socket`, async (t) => {
    await withCart(t, kind, async ({ page, settle }) => {
      const created = await page.evaluate(() => { try { new Worker('/worker.js'); return 'created'; } catch (e) { return `refused:${e.name}`; } });
      assert.match(created, /^refused:/, 'Worker constructor is removed in a guarded document');
      const shared = await page.evaluate(() => { try { new SharedWorker('/worker.js'); return 'created'; } catch (e) { return `refused:${e.name}`; } });
      assert.match(shared, /^refused:/);
      await settle();
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: popup is routed too (HTTP and WebSocket)`, async (t) => {
    await withCart(t, kind, async ({ page, context, settle }) => {
      const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('/', '_blank'); })]);
      await popup.waitForLoadState();
      const http = await popup.evaluate(({ url }) => fetch(url, { method: 'POST', body: '{"amount":1}' }).then(() => 'sent', () => 'blocked'),
        { url: stand.betOrigin + '/bets/make-bet-v2' });
      assert.equal(http, 'blocked');
      await popup.evaluate(({ url }) => new Promise((resolve) => {
        const s = new WebSocket(url); s.onopen = () => { s.send('42["place-bet",{}]'); setTimeout(resolve, 150); }; s.onerror = resolve;
      }), { url: stand.wsBase + '/ws/bet' });
      await settle();
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: iframe is covered by the same init script and routes`, async (t) => {
    await withCart(t, kind, async ({ page, settle }) => {
      await page.evaluate(() => { const f = document.createElement('iframe'); f.src = 'about:blank'; document.body.appendChild(f); });
      const frame = page.frames()[1];
      const created = await frame.evaluate(() => { try { new Worker('/worker.js'); return 'created'; } catch (e) { return 'refused'; } });
      assert.equal(created, 'refused');
      await frame.evaluate(({ url }) => new Promise((resolve) => {
        const s = new WebSocket(url); s.onopen = () => { s.send('42["place-bet",{}]'); setTimeout(resolve, 150); }; s.onerror = resolve;
      }), { url: stand.wsBase + '/ws/bet' });
      await settle();
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: service worker registration is refused; an already running one makes the context unguardable`, async (t) => {
    await withCart(t, kind, async ({ page }) => {
      const reg = await page.evaluate(async () => {
        if (!navigator.serviceWorker) return 'unavailable';
        try { await navigator.serviceWorker.register('/sw.js'); return 'registered'; } catch (e) { return `refused:${e.name}`; }
      });
      assert.notEqual(reg, 'registered');
    });
    // a worker that was running BEFORE the guard cannot be removed and refuses the guard
    if (skipReason) return;
    stand.reset();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto(stand.siteOrigin + '/');
      await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      const cart = kind === 'dry' ? new OneWinDryRunCart(page, { transportPolicy: POLICY() })
        : new OneWinLiveCart(page, { attemptStore: tempStore().store, liveEnabled: true, transportPolicy: POLICY() });
      await assert.rejects(() => cart.installGuard(), /SERVICE_WORKER_PRESENT/);
    } finally { await context.close(); }
  });

  test(`${kind}: unknown mutation endpoints and mutation paths over read verbs never reach the server`, async (t) => {
    await withCart(t, kind, async ({ post, get, settle }) => {
      const attempts = [
        ['POST', '/fortune-wheel/make-roll', { betAmount: 1, currencyCode: 'USDT' }],
        ['POST', '/bets/api/v1/user/bets/ordinary', { amount: 1 }],
        ['POST', '/bets/make-bet-v3', { amount: 1 }],
        ['PUT', '/bets/make-bet-v2', { amount: 1 }],
        ['POST', '/bets/refund', { id: 1 }],
        ['POST', '/telemetry/collect', { a: 1 }],
        ['DELETE', '/bets/anything', {}],
      ];
      for (const [method, p, body] of attempts) {
        const r = await post(stand.betOrigin + p, body, method);
        assert.ok(r.blocked, `${method} ${p} must be refused, got ${JSON.stringify(r)}`);
      }
      const get1 = await get(stand.betOrigin + '/bets/make-bet-v2?amount=1');
      assert.ok(get1.blocked, 'a placement path is refused even with GET');
      await settle();
      assert.equal(stand.log.money.length, 0);
      assert.equal(stand.log.http.filter((h) => h.method !== 'GET').length, 0, 'no non-read request reached the stand');
    });
  });

  test(`${kind}: legitimate reads keep working (settings GET, max-bet lookup POST, odds feed)`, async (t) => {
    await withCart(t, kind, async ({ post, get, wsExchange }) => {
      assert.equal((await get(stand.betOrigin + '/bets/get-base-settings')).status, 200);
      assert.equal((await post(stand.betOrigin + '/bets/get-max-bet-amount', { currencyCode: 'USDT', coupon: { selections: [] } })).status, 200);
      assert.equal((await post(stand.betOrigin + '/bets/get-auto-bet-amount-v2', {})).status, 200);
      assert.equal((await post(stand.betOrigin + '/auth/login', { publicToken: 'public' })).status, 200, 'session bootstrap passes');
      assert.ok((await post(stand.betOrigin + '/auth/login', { email: 'a@b.c', password: 'secret' })).blocked, 'a credential login never passes');
      const feed = await wsExchange('/push-server-v2/', ['40',
        '42["subscribe",{"messageType":"subscribe-match-odds","data":{"matchIds":[1]}}]']);
      assert.ok(feed.received.some((m) => m.includes('match-odds-snapshot')));
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: a redirect from an allowed read endpoint into a placement endpoint is stopped at the second hop`, async (t) => {
    await withCart(t, kind, async ({ post, settle }) => {
      const r = await post(stand.betOrigin + '/bets/get-max-bet-amount?redirect=1', { currencyCode: 'USDT' });
      await settle();
      assert.ok(r.blocked, JSON.stringify(r));
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: beacon and form navigation to a placement endpoint are refused`, async (t) => {
    await withCart(t, kind, async ({ page, settle }) => {
      await page.evaluate((url) => navigator.sendBeacon(url, '{"amount":1}'), stand.betOrigin + '/bets/make-bet-v2');
      await page.evaluate((url) => { const f = document.createElement('form'); f.method = 'POST'; f.action = url; document.body.appendChild(f); f.submit(); },
        stand.betOrigin + '/bets/make-bet-v2').catch(() => {});
      await settle(500);
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: a later route handler that continues everything is detected by the canary, nothing is clicked`, async (t) => {
    await withCart(t, kind, async ({ page, cart }) => {
      // registered AFTER the guard, therefore running before it: the bypass the review described
      await page.route('**/*', (route) => route.continue());
      const verdict = await cart._guard.verifyCoverage();
      assert.equal(verdict.ok, false, 'a bypassing handler must make the coverage proof fail');
      assert.equal(verdict.checks.http_canary, false);
    });
  });
}

// ---------------------------------------------------------------- end to end through the real carts
const goodPlan = (overrides = {}) => {
  const axes = { period: 'full_time', scope: 'REG', unit: 'goals', market: 'total', line: 60.5, side: 'under',
    payout_rule: { status: 'not_declared', result_variant: null, draw_payout: null } };
  return {
    ok: true, execution_ready: true, execution_blockers: [], live_submit_contract_verified: true,
    live_submit_contract_source: 'local-stand', idempotency_key: 'stand-e2e-1', stake: 1, currency: 'USDT',
    expires_at: Date.now() / 1000 + 600,
    evidence: { expiries: Object.fromEntries(['task', 'donor', 'reference', 'margins', 'executor_quote', 'account'].map((k) => [k, Date.now() / 1000 + 600])) },
    expected_axes: { ...axes },
    account_conditions: { logged_in: true, account_identity_verified: true, account_identity_source: 'local-stand', currency: 'USDT',
      available_balance: 8.45, commission: 0, max_stake: 8.45, live_submit_contract_verified: true },
    selection: { event_id: '40021999', event_url: `https://1win.pro:${stand.port}/betting/match/sport/40021999`, market_id: '6271', market_name: 'Total',
      selection_id: '10:193671744120169820:0', price: 1.87, axes: { ...axes } },
    ui_selection_name: 'Under 60.5',
    ...overrides,
  };
};

test('live cart end to end on the stand: one exact POST is the only money; a stray WebSocket frame beside it is refused', async (t) => {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin,
    extraScript: `document.addEventListener('click', (e) => { if (e.target && e.target.id === 'place') {
      const s = new WebSocket('${stand.wsBase}/ws/bet'); s.onopen = () => s.send('42["place-bet",{"stake":9999}]'); } }, true);` }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const { store } = tempStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: POLICY() });
    const result = await cart.run(goodPlan(), { now: () => Date.now() / 1000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(result.status, 'ACCEPTED', JSON.stringify(result));
    assert.equal(stand.log.money.filter((m) => m.via === 'http').length, 1, 'exactly one HTTP placement');
    assert.equal(stand.log.money.filter((m) => m.via === 'ws').length, 0, 'the stray WebSocket frame did not reach the stand');
    assert.equal(result.submit_sent_count, 1);
    assert.equal(result.transport_guard.coverage.ws_canary, true);
    assert.ok(result.transport_guard.violation_kinds.includes('ws_frame_blocked'));
    assert.equal(stand.log.money[0].body.amount, 1);
    assert.equal(store.getAttempt('stand-e2e-1').status, 'ACCEPTED');
  } finally { await context.close(); }
});

test('live cart end to end: replay of the same key and a second selection key after ACCEPTED send nothing', async (t) => {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const { store } = tempStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, diagnosticMode: false, transportPolicy: POLICY() });
    const first = await cart.run(goodPlan(), { now: () => Date.now() / 1000 });
    assert.equal(first.status, 'ACCEPTED');
    await assert.rejects(() => cart.run(goodPlan(), { now: () => Date.now() / 1000 }), /DUPLICATE_IDEMPOTENCY_KEY/);
    await assert.rejects(() => cart.run(goodPlan({ idempotency_key: 'stand-e2e-2' }), { now: () => Date.now() / 1000 }), /DUPLICATE_SELECTION_ATTEMPT/);
    assert.equal(stand.log.money.length, 1);
  } finally { await context.close(); }
});

test('read-only cart end to end: the Place a bet button is never allowed to place anything', async (t) => {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const cart = new OneWinDryRunCart(page, { transportPolicy: POLICY() });
    const plan = { ok: true, selection: { event_id: '40021999', event_url: `https://1win.pro:${stand.port}/betting/match/sport/40021999`,
      market_name: 'Total', price: 1.87 }, ui_selection_name: 'Under 60.5' };
    const result = await cart.run(plan);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.cart_cleared, true);
    assert.equal(result.transport_coverage.ws_canary, true);
    assert.equal(stand.log.money.length, 0);
  } finally { await context.close(); }
});
