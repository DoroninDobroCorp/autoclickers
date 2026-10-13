// Read-only first-party probe of the account site (no money, no login, no CAPTCHA handling).
//
// Everything runs through ONE approved upstream via the temporary bridge, in a context that has the
// transport guard (HTTP default-deny, WebSocket frame policy, workers removed, redirects checked), so
// the probe itself exercises the same boundary the carts use. Secrets (session state, proxy URL) are
// read from private files given by flag/env and are never printed. The raw result is written with
// mode 0600 to --private-out; stdout carries a redacted summary only.
//
//   node account_readonly_probe.mjs --stage discover --private-out <file>
//
// Stages
//   discover  load /betting, record which requests/sockets the first-party client really uses
//   list      same, plus the first-party match list for football/basketball/... (read-only POST)
//   snapshot  open one event page (--event-id) and keep its native odds frames privately
import crypto from 'node:crypto';
import fs from 'node:fs';
import { OneWinDryRunCart, parseAmount } from './browser_cart.mjs';
import { parseProxyUrl } from './proxy_bridge.mjs';
import { withBrowserSession } from './session_runner.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env[`ONEWIN_PROBE_${name.toUpperCase().replace(/-/g, '_')}`] || fallback);
}

const stage = arg('stage', 'discover');
const proxyConfig = arg('proxy-config', `${process.env.HOME}/.config/betting/onewin/account-site-proxy-20261012.json`);
const sessionState = arg('session-state', '/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json');
const privateOut = arg('private-out');
const expectedEndpoint = arg('expected-proxy-endpoint', '196.19.228.25:8000');
const executablePath = arg('chromium', process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined);
const timeoutMs = Number(arg('timeout-ms', '150000'));

if (!privateOut) throw new Error('--private-out is required (raw results never go to stdout)');

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const startedAt = new Date().toISOString();
const raw = { schema: 'onewin-account-readonly-probe.v1', stage, started_at: startedAt, external_placement: false, requests: {}, sockets: [], events: [] };

const proxy = parseProxyUrl(JSON.parse(fs.readFileSync(proxyConfig, 'utf8')).proxy);
const state = JSON.parse(fs.readFileSync(sessionState, 'utf8'));

const session = await withBrowserSession({
  proxy, expectedProxyEndpoint: expectedEndpoint, storageState: state,
  cookieOverrides: [{ name: 'project_locale', value: 'en-US' }], executablePath, timeoutMs,
}, async ({ page, context, bridge }) => {
  raw.frames = [];
  const cart = new OneWinDryRunCart(page, { onWsFrame: ({ direction, host, path, data, allowed, at }) => {
    if (typeof data !== 'string') return;
    const interesting = process.argv.includes('--all-frames') || direction === 'client_to_server'
      || /match-odds|odds-snapshot|match-info|"messageType"/.test(data.slice(0, 240));
    if (interesting && raw.frames.length < 60 && data.length < 6_000_000) raw.frames.push({ at, direction, host, path, allowed, payload: direction === 'client_to_server' ? data.slice(0, 600) : data });
  } });
  await cart.installGuard();
  raw.guard_installed = cart._guard.report();
  const record = (map, key) => { map[key] = (map[key] || 0) + 1; };
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      record(raw.requests, `${request.method()} ${url.hostname}${url.pathname.replace(/\d{5,}/g, '{n}')}`);
    } catch { /* ignore */ }
  });
  page.on('websocket', (socket) => {
    try { raw.sockets.push({ host: new URL(socket.url()).hostname, path: new URL(socket.url()).pathname }); } catch { /* ignore */ }
  });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(message.text().slice(0, 160)); });

  raw.responses = {};
  let apiHeaders = null;
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.hostname === 'api-gateway.top-parser.com' && url.pathname === '/matches/get-many' && !apiHeaders) {
        const all = request.headers();
        apiHeaders = Object.fromEntries(Object.entries(all).filter(([k]) => /^(?:content-type|accept|token|x-[a-z-]+)$/i.test(k)));
      }
    } catch { /* ignore */ }
  });
  const assetPattern = arg('save-assets-pattern');
  const assetDir = arg('assets-dir');
  raw.saved_assets = [];
  page.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (assetPattern && assetDir && url.hostname === '1win.pro' && response.request().resourceType() === 'script'
        && new RegExp(assetPattern).test(url.pathname)) {
        const text = await response.text();
        const name = url.pathname.split('/').pop();
        fs.mkdirSync(assetDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(`${assetDir}/${name}`, text, { mode: 0o600 });
        raw.saved_assets.push({ name, bytes: text.length, sha256: sha(text) });
      }
      if (/\/(?:matches|highlights)\/get-many$|\/bets\/get-(?:base-settings|max-bet-amount|auto-bet-amount-v2)$/.test(url.pathname)) {
        const key = `${response.request().method()} ${url.pathname}`;
        (raw.responses[key] ||= []);
        if (raw.responses[key].length < 4) {
          raw.responses[key].push({ at: Date.now(), status: response.status(),
            request: (() => { try { return response.request().postDataJSON(); } catch { return null; } })(),
            body: await response.json().catch(() => null) });
        }
      }
    } catch { /* ignore */ }
  });
  await cart._guard.ensureFreshDocument();
  const target = stage === 'snapshot' ? `https://1win.pro/betting/match/sport/${arg('event-id', '40021999')}` : 'https://1win.pro/betting';
  const response = await page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });
  raw.http_status = response ? response.status() : null;
  await page.locator('[data-testid="header-balance-sum"]').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(Number(arg('wait-ms', '5000')));
  if (stage === 'list') {
    // replay the client's own list call (same headers it sent) for the sports that matter
    const headers = apiHeaders;
    raw.lists = {};
    for (const [name, body] of Object.entries({
      live: { limit: 100, service: 'live', excludeSportType: ['polybet', 'racing', 'esport'] },
      prematch: { limit: 100, service: 'prematch', excludeSportType: ['polybet', 'racing', 'esport'] },
    })) {
      raw.lists[name] = await page.evaluate(async ({ url, headers, body }) => {
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, { url: 'https://api-gateway.top-parser.com/matches/get-many', headers, body });
    }
  }
  raw.coverage = await cart._guard.verifyCoverage();
  raw.logged_in_balance_visible = await page.locator('[data-testid="header-balance-sum"]').isVisible().catch(() => false);
  raw.balance_text = await page.locator('[data-testid="header-balance-sum"]').innerText().catch(() => null);
  raw.currency_text = await page.locator('[data-testid="header-balance-currency-text"]').innerText().catch(() => null);
  raw.balance = raw.balance_text ? parseAmount(raw.balance_text) : null;
  raw.match_links = await page.locator('a[href*="/betting/match/sport/"]').count().catch(() => 0);
  raw.console_errors = consoleErrors;
  raw.guard_final = cart._guard.report();
  raw.blocked_money = cart.blocked.slice(0, 50);
  raw.blocked_unknown = cart.blockedUnknown.slice(0, 100);
  raw.guard_violations = cart._guard.violations.slice(0, 50);
  raw.bridge = bridge ? bridge.stats() : null;
  void context;
  return true;
});
raw.session_closed = session.closed;
raw.finished_at = new Date().toISOString();
fs.writeFileSync(privateOut, JSON.stringify(raw, null, 2), { mode: 0o600 });
fs.chmodSync(privateOut, 0o600);

const summary = {
  stage, started_at: startedAt, finished_at: raw.finished_at, proxy_endpoint: proxy.endpoint,
  proxy_config_sha256_prefix: sha(fs.readFileSync(proxyConfig)).slice(0, 12),
  http_status: raw.http_status, logged_in: raw.logged_in_balance_visible, currency: raw.currency_text,
  guard_coverage: raw.coverage && raw.coverage.checks, blocked_money: raw.blocked_money.length,
  blocked_unknown: raw.blocked_unknown.length, match_links: raw.match_links,
  session_closed: raw.session_closed, private_out: privateOut,
};
console.log(JSON.stringify(summary, null, 2));
