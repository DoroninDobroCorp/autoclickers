// Characterization of what the transport guard CANNOT decide, measured on the local TLS stand with a
// full Chrome (not a unit test: it prints facts, it does not assert that a residual is acceptable).
//
//   A. network-stack retry: the guard decides once per request it sees; Chrome may resend a POST by
//      itself when the connection it reused dies before an answer. How many requests reach the stand?
//   B. GET requests that are not issued by the page's network stack (prefetch, speculation rules):
//      are they seen by the guard, and do they reach the stand?
//
// node transport_residuals_probe.mjs [--runs N]
import { OneWinLiveCart, DurableAttemptStore } from './browser_live_cart.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : 3;
const EVENT_PATH = '/betting/match/sport/40021999';
const ODD = '10:193671744120169820:0';

async function armedCart(stand, browser, n) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(stand.siteOrigin + EVENT_PATH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-residual-'));
  const store = new DurableAttemptStore(path.join(dir, 'attempts.json'));
  const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, transportPolicy: { betApiOrigins: [stand.betOrigin] } });
  await cart.installGuard();
  await cart._guard.ensureFreshDocument();
  await page.goto(stand.siteOrigin + EVENT_PATH);
  const key = `residual-${n}`;
  await store.claim(key, { stake: 1, currency: 'USDT', payload: { idempotency_key: key, stake: 1, currency: 'USDT',
    event_id: '40021999', market_id: '6271', selection_id: ODD } });
  await store.record(key, 'PRE_CHECK_PASSED');
  await store.record(key, 'SUBMITTING');
  cart._runtime = { now: () => 1000, cancelled: async () => false };
  cart.armedExpectation = { idempotencyKey: key, eventId: '40021999', marketId: '6271', selectionId: ODD, stake: 1, currency: 'USDT', price: 1.87, expiresAt: 2000 };
  return { context, page, cart, dir };
}

const out = { chrome: null, runs: RUNS, network_retry: [], get_prefetch: null };
const stand = await startStand({ tls: true });
stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin }));
const launched = await launchStandBrowser(stand);
const browser = launched.browser;
await launched.context.close();
out.chrome = browser.version();

// ---- A. network retry
for (const mode of ['reused_connection', 'fresh_connection']) {
  const rows = [];
  for (let i = 0; i < RUNS; i += 1) {
    stand.reset();
    stand.hooks.dropMakeBet = 1;
    const { context, page, cart } = await armedCart(stand, browser, `${mode}-${i}`);
    const body = JSON.stringify({ currencyCode: 'USDT', idempotencyKey: `native-${mode}-${i}`, amount: 1,
      coupon: { amount: 1, selections: [{ oddId: ODD, cf: 1.87, matchId: '40021999' }] }, wallet: { type: 'real' } });
    if (mode === 'reused_connection') {
      // a keep-alive connection to the bet origin exists before the placement
      await page.evaluate((url) => fetch(url, { method: 'POST', body: '{}' }).then(() => null, () => null), `${stand.betOrigin}/bets/get-max-bet-amount`);
    }
    const answer = await page.evaluate(async ({ url, body }) => {
      try { return { status: (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status }; }
      catch (e) { return { failed: String(e.message) }; }
    }, { url: `${stand.betOrigin}/bets/make-bet-v2`, body });
    await new Promise((resolve) => setTimeout(resolve, 400));
    rows.push({ page_saw: answer, guard_decisions: cart.submitSentCount, requests_that_reached_the_stand: stand.log.money.length,
      same_key: stand.log.money.every((m) => m.body && m.body.idempotencyKey === `native-${mode}-${i}`) });
    await context.close();
  }
  out.network_retry.push({ mode, rows });
}

// ---- B. GET that does not come from the page's fetch stack
{
  stand.reset();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const target = `${stand.betOrigin}/bets/make-bet-v2?residual=get`;
  stand.pages.set('/prefetch', `<html><head>
    <link rel="prefetch" href="${target}&via=link-prefetch">
    <link rel="preload" as="fetch" crossorigin href="${target}&via=link-preload">
    <link rel="preconnect" href="${stand.betOrigin}">
    <script type="speculationrules">{"prefetch":[{"source":"list","urls":["${target}&via=speculation-rules"]}]}</script>
    </head><body><img src="${target}&via=img"></body></html>`);
  const seenByRoute = [];
  await context.route('**/*', async (route) => { seenByRoute.push(new URL(route.request().url()).searchParams.get('via')); await route.fallback(); });
  await page.goto(`${stand.siteOrigin}/prefetch`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const reached = stand.log.http.filter((h) => h.path === '/bets/make-bet-v2').map((h) => ({ method: h.method }));
  out.get_prefetch = { note: 'plain context route (no guard) to see what Playwright itself is shown; the guard sits on the same route',
    seen_by_route: seenByRoute.filter(Boolean), reached_stand: reached, reached_count: reached.length };
  await context.close();
}
await browser.close();
await stand.close();
console.log(JSON.stringify(out, null, 2));
