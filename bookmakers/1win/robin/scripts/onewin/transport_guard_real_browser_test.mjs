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
      assert.deepEqual(Object.keys(verdict.checks).sort(), ['http_canary', 'http_route', 'init_script', 'no_foreign_worker', 'no_other_site_pages',
        'redirect_guard', 'service_worker_blocked', 'unmediated_transports_removed', 'worker_blocked', 'ws_canary', 'ws_policy_in_page', 'ws_route']);
      assert.equal(stand.log.http.some((h) => /canary/.test(String(h.path))), false, 'the canary never reaches the bet API origin');
      assert.equal(stand.log.ws.length, 0);
    });
  });

  test(`${kind}: a worker that was ever seen, or a guard error, makes the coverage proof fail for good`, async (t) => {
    await withCart(t, kind, async ({ cart }) => {
      assert.equal((await cart._guard.verifyCoverage()).ok, true);
      cart._guard.stats.workers_seen = 1;
      assert.equal((await cart._guard.verifyCoverage()).checks.no_foreign_worker, false);
      cart._guard.stats.workers_seen = 0;
      cart._guard._violation('route_handler_error', 'boom');
      const verdict = await cart._guard.verifyCoverage();
      assert.equal(verdict.ok, false);
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

  test(`${kind}: a popup is closed at once and moves nothing, even with an immediate redirecting POST`, async (t) => {
    await withCart(t, kind, async ({ page, context, settle }) => {
      const popupPromise = context.waitForEvent('page');
      await page.evaluate(({ url }) => {
        // the popup's first script fires a redirecting read POST the moment it runs
        const w = window.open('/', '_blank');
        try { w.addEventListener('load', () => w.fetch(url, { method: 'POST', body: '{}' }).catch(() => {})); } catch { /* cross-origin */ }
      }, { url: stand.betOrigin + '/bets/get-max-bet-amount?redirect=1' });
      const popup = await popupPromise;
      await settle(600);
      assert.equal(popup.isClosed(), true, 'the second window is closed by the guard');
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

  test(`${kind}: transports that no route mediates (WebSocketStream, fetchLater) are removed and the Playwright mock is not reachable`, async (t) => {
    await withCart(t, kind, async ({ page, settle }) => {
      const result = await page.evaluate(async ({ ws, bet }) => {
        const out = {};
        const attempt = async (name, fn) => { try { await fn(); out[name] = 'done'; } catch (e) { out[name] = `refused:${e.name}`; } };
        await attempt('websocketstream', async () => {
          if (typeof WebSocketStream === 'undefined') throw Object.assign(new Error('absent'), { name: 'Absent' });
          const stream = new WebSocketStream(ws + '/ws/bet');
          const { writable } = await stream.opened;
          await writable.getWriter().write('42["place-bet",{"stake":9999}]');
        });
        await attempt('fetchlater', async () => {
          if (typeof fetchLater === 'undefined') throw Object.assign(new Error('absent'), { name: 'Absent' });
          fetchLater(bet + '/bets/make-bet-v2', { method: 'POST', body: '{"amount":9999}', activateAfter: 0 });
        });
        // the mock Playwright puts behind window.WebSocket: its internals must not be reachable from the page
        out.mock_internals = await new Promise((resolve) => {
          const s = new WebSocket(ws + '/ws/bet');
          s.onopen = () => {
            const reach = [];
            try { if (s._ws) { s._ws.send('42["place-bet",{"via":"_ws"}]'); reach.push('_ws'); } } catch { /* absent */ }
            try { s._passthrough = true; s.send('42["place-bet",{"via":"_passthrough"}]'); } catch { /* absent */ }
            try {
              if (typeof __pwWebSocketDispatch === 'function' && s._id !== undefined) {
                __pwWebSocketDispatch({ id: s._id, type: 'sendToServer', data: '42["place-bet",{"via":"dispatch"}]' });
                reach.push('dispatch');
              }
            } catch { /* absent */ }
            setTimeout(() => resolve(reach), 200);
          };
          s.onerror = () => resolve(['error']);
        });
        return out;
      }, { ws: stand.wsBase, bet: stand.betOrigin });
      await settle(500);
      assert.match(result.websocketstream, /^(?:refused|done)/);
      assert.deepEqual(result.mock_internals, [], 'no Playwright internals on the object the page holds');
      assert.equal(stand.log.money.length, 0, JSON.stringify({ result, money: stand.log.money }));
    });
  });

  test(`${kind}: OPTIONS and rewriting headers do not turn a harmless request into a placement`, async (t) => {
    await withCart(t, kind, async ({ page, settle }) => {
      const out = await page.evaluate(async ({ bet }) => {
        const run = (url, init) => fetch(url, init).then((r) => r.status, (e) => 'blocked');
        return {
          options_money_path: await run(bet + '/bets/make-bet-v2', { method: 'OPTIONS', body: '{"amount":1}' }),
          override_header: await run(bet + '/bets/get-max-bet-amount', { method: 'POST', headers: { 'x-http-method-override': 'PUT', 'content-type': 'application/json' }, body: '{}' }),
          original_url_header: await run(bet + '/bets/get-base-settings', { headers: { 'x-original-url': '/bets/make-bet-v2' } }),
        };
      }, { bet: stand.betOrigin });
      await settle();
      assert.deepEqual(out, { options_money_path: 'blocked', override_header: 'blocked', original_url_header: 'blocked' });
      assert.equal(stand.log.money.length, 0);
    });
  });

  test(`${kind}: another window of the bookmaker predating the guard makes the coverage proof fail`, async (t) => {
    await withCart(t, kind, async ({ cart, context }) => {
      assert.equal((await cart._guard.verifyCoverage()).ok, true);
      const other = await context.newPage().catch(() => null);
      // a popup is closed by the guard; a window that was opened some other way is a stranger
      if (other) { await other.goto(stand.siteOrigin + '/').catch(() => {}); }
      const verdict = await cart._guard.verifyCoverage();
      if (other && !other.isClosed()) assert.equal(verdict.checks.no_other_site_pages, false);
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

test('live: a failed installation leaves no handler behind, the retry decides every request exactly once', async (t) => {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(stand.siteOrigin + EVENT_PATH);
    const { store } = tempStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: POLICY() });
    // the first page.route() fails AFTER the context-level route was registered
    const realRoute = page.route.bind(page);
    let failures = 1;
    page.route = async (...args) => {
      if (failures > 0) { failures -= 1; throw new Error('route install boom'); }
      return realRoute(...args);
    };
    await assert.rejects(() => cart.installGuard(), /route install boom/);
    assert.equal(cart.guarded, false);
    await cart.installGuard();
    assert.equal(cart.guarded, true);
    await cart._guard.ensureFreshDocument();
    await page.goto(stand.siteOrigin + EVENT_PATH);
    await store.claim('retry-key', { stake: 1, currency: 'USDT', payload: { idempotency_key: 'retry-key', stake: 1, currency: 'USDT',
      event_id: '40021999', market_id: '6271', selection_id: '10:193671744120169820:0' } });
    await store.record('retry-key', 'PRE_CHECK_PASSED');
    await store.record('retry-key', 'SUBMITTING');
    cart._runtime = { now: () => 1000, cancelled: async () => false };
    cart.armedExpectation = { idempotencyKey: 'retry-key', eventId: '40021999', marketId: '6271', selectionId: '10:193671744120169820:0',
      stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
    const answer = await page.evaluate(async ({ url }) => {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          currencyCode: 'USDT', idempotencyKey: 'client-uuid-2', amount: 1,
          coupon: { amount: 1, selections: [{ oddId: '10:193671744120169820:0', cf: 1.87, matchId: '40021999' }] },
          wallet: { type: 'real' } }) });
        return { status: r.status };
      } catch (e) { return { blocked: String(e) }; }
    }, { url: stand.betOrigin + '/bets/make-bet-v2' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(answer.status, 200, JSON.stringify({ answer, blocked: cart.blocked_reasons }));
    assert.equal(stand.log.money.length, 1, 'exactly one request, decided once');
    assert.equal(cart.submitSentCount, 1);
  } finally { await context.close(); }
});

async function armedLiveCart(t, fn) {
  if (skipReason) return t.skip(skipReason);
  stand.reset();
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(stand.siteOrigin + EVENT_PATH);
    const { store } = tempStore();
    const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: POLICY() });
    await cart.installGuard();
    await cart._guard.ensureFreshDocument();
    await page.goto(stand.siteOrigin + EVENT_PATH);
    let n = 0;
    const arm = async () => {
      n += 1;
      const key = `armed-${n}`;
      await store.claim(key, { stake: 1, currency: 'USDT', payload: { idempotency_key: key, stake: 1, currency: 'USDT',
        event_id: '40021999', market_id: '6271', selection_id: `10:193671744120169820:${n}` } });
      await store.record(key, 'PRE_CHECK_PASSED');
      await store.record(key, 'SUBMITTING');
      cart._runtime = { now: () => 1000, cancelled: async () => false };
      cart.armedExpectation = { idempotencyKey: key, eventId: '40021999', marketId: '6271', selectionId: '10:193671744120169820:0',
        stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
      cart.submitSentCount = 0;
    };
    const send = (path_, raw, headers = { 'content-type': 'application/json' }, method = 'POST') => page.evaluate(async ({ url, raw, headers, method }) => {
      try { const r = await fetch(url, { method, headers, body: raw }); return { status: r.status }; } catch (e) { return { blocked: String(e) }; }
    }, { url: stand.betOrigin + path_, raw, headers, method });
    await fn({ page, cart, arm, send, context });
  } finally { await context.close(); }
}

const goodRaw = () => JSON.stringify({ currencyCode: 'USDT', idempotencyKey: 'client-uuid', amount: 1, meta: { isDirtyAmountField: true },
  coupon: { amount: 1, selections: [{ oddId: '10:193671744120169820:0', cf: 1.87, matchId: '40021999' }] }, wallet: { type: 'real' } });

test('live armed: only the exact verb, origin and path is forwarded; every similar path is refused', async (t) => {
  await armedLiveCart(t, async ({ arm, send, cart }) => {
    for (const p of ['/bets/make-bet-v2/', '/bets/make-bet-v2/anything', '/bets/make-bet-v2/refund', '/BETS/MAKE-BET-V2', '/x/bets/make-bet-v2',
      '//bets/make-bet-v2', '/bets/make-bet-v2;x', '/bets/make%2Dbet-v2', '/bets/make-bet-v2/..%2f..%2fbets%2frefund']) {
      await arm();
      const r = await send(p, goodRaw());
      assert.ok(r.blocked, `${p} must not be forwarded: ${JSON.stringify(r)}`);
      assert.equal(cart.armedExpectation, null, 'a refused request still disarms');
    }
    assert.equal(stand.log.money.length, 0);
    await arm();
    assert.equal((await send('/bets/make-bet-v2', goodRaw())).status, 200);
    assert.equal(stand.log.money.length, 1);
  });
});

test('live armed: the body is a closed, canonical contract (types, duplicates, coercions, content type)', async (t) => {
  await armedLiveCart(t, async ({ arm, send }) => {
    const base = JSON.parse(goodRaw());
    const variants = {
      array_odd_id: JSON.stringify({ ...base, coupon: { ...base.coupon, selections: [{ ...base.coupon.selections[0], oddId: ['10:193671744120169820:0'] }] } }),
      array_match_id: JSON.stringify({ ...base, coupon: { ...base.coupon, selections: [{ ...base.coupon.selections[0], matchId: [40021999] }] } }),
      numeric_string_market_array: JSON.stringify({ ...base, coupon: { ...base.coupon, selections: [{ ...base.coupon.selections[0], marketId: ['6271'] }] } }),
      auto_bet_amount_object: JSON.stringify({ ...base, meta: { autoBetAmount: {} } }),
      dirty_flag_object: JSON.stringify({ ...base, meta: { isDirtyAmountField: {} } }),
      meta_array: JSON.stringify({ ...base, meta: ['x'] }),
      bonuses_object: JSON.stringify({ ...base, bonuses: { id: 5 } }),
      bonus_percent_string: JSON.stringify({ ...base, bonusPercent: 'X' }),
      wallet_missing: JSON.stringify({ ...base, wallet: undefined }),
      idempotency_key_missing: JSON.stringify({ ...base, idempotencyKey: undefined }),
      amount_off_by_epsilon: JSON.stringify({ ...base, amount: 1.0000000001 }),
      cf_off_by_epsilon: JSON.stringify({ ...base, coupon: { ...base.coupon, selections: [{ ...base.coupon.selections[0], cf: 1.87000000001 }] } }),
      duplicate_amount_key: goodRaw().replace('"amount":1,', '"amount":1000,"amount":1,'),
      padded_with_whitespace: ` ${goodRaw()}`,
      trailing_second_document: `${goodRaw()}{"amount":9999}`,
      escaped_key: goodRaw().replace('"currencyCode"', '"currency\\u0043ode"'),
    };
    for (const [name, raw] of Object.entries(variants)) {
      await arm();
      const r = await send('/bets/make-bet-v2', raw);
      assert.ok(r.blocked, `${name} must be refused: ${JSON.stringify(r)}`);
    }
    await arm();
    const textPlain = await send('/bets/make-bet-v2', goodRaw(), { 'content-type': 'text/plain' });
    assert.ok(textPlain.blocked, 'the contract is JSON');
    assert.equal(stand.log.money.length, 0);
    await arm();
    assert.equal((await send('/bets/make-bet-v2', goodRaw())).status, 200);
    assert.equal(stand.log.money.length, 1);
  });
});

test('live: a later handler written for the bet host (continue / passthrough) is caught by the canary on the REAL origin', async (t) => {
  await armedLiveCart(t, async ({ page, context, cart }) => {
    assert.equal((await cart._guard.verifyCoverage()).ok, true);
    const betHost = new URL(stand.betOrigin).hostname;
    await context.route((url) => url.hostname === betHost, (route) => route.continue());
    await page.route((url) => url.hostname === betHost, (route) => route.continue());
    const verdict = await cart._guard.verifyCoverage();
    assert.equal(verdict.ok, false, JSON.stringify(verdict));
    assert.equal(verdict.checks.http_canary, false);
  });
});

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

test('live cart end to end on the stand: a stray WebSocket frame beside the exact POST never moves money and never lets a second request through', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const outcomes = new Set();
  for (let round = 0; round < 4; round += 1) {
    stand.reset();
    stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin,
      extraScript: `document.addEventListener('click', (e) => { if (e.target && e.target.id === 'place') {
        const s = new WebSocket('${stand.wsBase}/ws/bet'); s.onopen = () => s.send('42["place-bet",{"stake":9999}]'); } }, true);` }));
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const { store } = tempStore();
      const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: POLICY() });
      const result = await cart.run(goodPlan({ idempotency_key: `stand-e2e-${round}` }), { now: () => Date.now() / 1000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const httpMoney = stand.log.money.filter((m) => m.via === 'http').length;
      assert.equal(stand.log.money.filter((m) => m.via === 'ws').length, 0, 'the stray WebSocket frame never reached the stand');
      assert.ok(httpMoney <= 1, 'never more than the one exact request');
      assert.ok(result.transport_guard.violation_kinds.includes('ws_frame_blocked'), JSON.stringify(result.transport_guard));
      assert.equal(result.transport_guard.coverage.ws_canary, true);
      // anything wrong while the submit is armed ends the attempt: either the exact POST won the race (a
      // bet that exists) or the armed window was closed first (nothing sent) - never a mixture
      if (result.status === 'ACCEPTED') {
        assert.equal(httpMoney, 1);
        assert.equal(result.submit_sent_count, 1);
        assert.equal(store.getAttempt(`stand-e2e-${round}`).status, 'ACCEPTED');
      } else {
        assert.equal(result.status, 'ABORTED_PRE_SUBMIT', JSON.stringify(result));
        assert.equal(httpMoney, 0);
        assert.equal(result.submit_sent_count, 0);
        assert.equal(store.getAttempt(`stand-e2e-${round}`).status, 'WITHDRAWN');
      }
      outcomes.add(result.status);
    } finally { await context.close(); }
  }
  assert.ok(outcomes.size >= 1);
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
