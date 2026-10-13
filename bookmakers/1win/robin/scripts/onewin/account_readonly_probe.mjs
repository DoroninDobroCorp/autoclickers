// Read-only first-party probe of the account site (no money, no login, no CAPTCHA handling).
//
// Everything runs through ONE approved upstream via the temporary bridge, in a context that has the
// transport guard (HTTP default-deny, WebSocket frame policy, workers removed, redirects checked), so
// the probe itself exercises the same boundary the carts use. Secrets (session state, proxy URL,
// credentials) are read from private files given by flag/env and are never printed. The raw result
// is written with mode 0600 to --private-out; stdout carries a redacted summary only.
//
//   node account_readonly_probe.mjs --stage <stage> --private-out <file> [--event-ids a,b]
//
// Stages
//   discover  load /betting, record which requests/sockets the first-party client really uses
//   list      same, plus the first-party match lists (live, prematch) as the client requests them
//   snapshot  open one event page (--event-id) and keep its native frames privately
//   binding   per event (--event-ids): native snapshot -> exact selections, UI coupon readback of the
//             same selection, capacity/negative controls on the read-only limit endpoint, account
//             identity and wallet. Nothing is submitted: the coupon is cleared after each readback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { OneWinDryRunCart, parseAmount } from './browser_cart.mjs';
import { parseProxyUrl } from './proxy_bridge.mjs';
import { withBrowserSession } from './session_runner.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env[`ONEWIN_PROBE_${name.toUpperCase().replace(/-/g, '_')}`] || fallback);
}
const flag = (name) => process.argv.includes(`--${name}`);

const stage = arg('stage', 'discover');
// Private inputs are never defaulted in the repository: the files hold the proxy URL, the stored
// session and the expected account, and their locations are operational facts, not source.
const required = (name) => {
  const value = arg(name);
  if (!value) throw new Error(`--${name} (or ONEWIN_PROBE_${name.toUpperCase().replace(/-/g, '_')}) is required`);
  return value;
};
const proxyConfig = required('proxy-config');
const sessionState = required('session-state');
const credentialsFile = stage === 'binding' ? required('credentials-file') : arg('credentials-file');
const expectedEndpoint = required('expected-proxy-endpoint');
const privateOut = arg('private-out');
const executablePath = arg('chromium', process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined);
const timeoutMs = Number(arg('timeout-ms', '280000'));
const eventIds = (arg('event-ids', arg('event-id', '')) || '').split(',').map((v) => v.trim()).filter(Boolean);
const waitMs = Number(arg('wait-ms', '5000'));

if (!privateOut) throw new Error('--private-out is required (raw results never go to stdout)');

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const startedAt = new Date().toISOString();
const raw = { schema: 'onewin-account-readonly-probe.v1', stage, started_at: startedAt, external_placement: false,
  requests: {}, sockets: [], frames: [], responses: {}, events: {} };

const proxy = parseProxyUrl(JSON.parse(fs.readFileSync(proxyConfig, 'utf8')).proxy);
const state = JSON.parse(fs.readFileSync(sessionState, 'utf8'));

// frames of the odds feed, newest per match id
const oddsByMatch = new Map();
const infoByMatch = new Map();
function ingestFrame(direction, host, data, at) {
  if (direction !== 'server_to_client' || typeof data !== 'string' || !data.startsWith('42')) return;
  let parsed;
  try { parsed = JSON.parse(data.slice(2).replace(/^[^\[]*(?=\[)/, '')); } catch { return; }
  const body = Array.isArray(parsed) ? parsed[1] : null;
  if (!body || typeof body !== 'object') return;
  const payload = body.data;
  if (payload && typeof payload === 'object' && Array.isArray(payload.oddsGroups) && payload.matchId !== undefined) {
    // the list page subscribes with isBaseOddsGroups (a handful of base groups per match); the event page gets the
    // full board. Keep the fuller board unless the stored one is old.
    const key = String(payload.matchId);
    const previous = oddsByMatch.get(key);
    if (!previous || payload.oddsGroups.length >= previous.groups.length || at - previous.at > 8000) {
      oddsByMatch.set(key, { at, ts: payload.ts, groups: payload.oddsGroups, message_type: body.messageType || null });
    }
  } else if (payload && typeof payload === 'object' && payload.matchId !== undefined && 'sportId' in payload) {
    infoByMatch.set(String(payload.matchId), { at, ...payload });
  }
}

const session = await withBrowserSession({
  proxy, expectedProxyEndpoint: expectedEndpoint, storageState: state,
  cookieOverrides: [{ name: 'project_locale', value: 'en-US' }], executablePath, timeoutMs,
}, async ({ page, bridge }) => {
  const cart = new OneWinDryRunCart(page, { transportPolicy: { blockWorkers: !flag('allow-workers') }, onWsFrame: ({ direction, host, path, data, allowed, at }) => {
    ingestFrame(direction, host, data, at);
    if (typeof data !== 'string') return;
    const interesting = flag('all-frames') || direction === 'client_to_server'
      || /match-odds|odds-snapshot|match-info|"messageType"/.test(data.slice(0, 240));
    if (interesting && raw.frames.length < 80 && data.length < 6_000_000) {
      raw.frames.push({ at, direction, host, path, allowed, payload: direction === 'client_to_server' ? data.slice(0, 600) : data });
    }
  } });
  await cart.installGuard();
  raw.guard_installed = cart._guard.report();
  const record = (map, key) => { map[key] = (map[key] || 0) + 1; };
  let apiHeaders = null;
  const maxBetRequests = [];
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      record(raw.requests, `${request.method()} ${url.hostname}${url.pathname.replace(/\d{5,}/g, '{n}')}`);
      if (url.hostname === 'api-gateway.top-parser.com' && request.method() === 'POST') {
        const all = request.headers();
        // the headers of an AUTHENTICATED call of the client itself (a public list call carries no token)
        if (all.token && (!apiHeaders || !apiHeaders.token)) {
          apiHeaders = Object.fromEntries(Object.entries(all).filter(([k]) => /^(?:content-type|accept|token|x-[a-z-]+)$/i.test(k)));
        } else if (!apiHeaders) {
          apiHeaders = Object.fromEntries(Object.entries(all).filter(([k]) => /^(?:content-type|accept|x-[a-z-]+)$/i.test(k)));
        }
      }
      if (url.pathname === '/bets/get-max-bet-amount') {
        let body = null;
        try { body = request.postDataJSON(); } catch { /* not json */ }
        maxBetRequests.push({ at: Date.now(), body });
      }
    } catch { /* ignore */ }
  });
  page.on('websocket', (socket) => {
    try { raw.sockets.push({ host: new URL(socket.url()).hostname, path: new URL(socket.url()).pathname }); } catch { /* ignore */ }
  });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(message.text().slice(0, 160)); });
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
        if (raw.responses[key].length < 6) {
          raw.responses[key].push({ at: Date.now(), status: response.status(),
            request: (() => { try { return response.request().postDataJSON(); } catch { return null; } })(),
            body: await response.json().catch(() => null) });
        }
      }
    } catch { /* ignore */ }
  });

  await cart._guard.ensureFreshDocument();
  const target = stage === 'snapshot' ? `https://1win.pro/betting/match/sport/${eventIds[0] || '40021999'}` : 'https://1win.pro/betting';
  const response = await page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });
  raw.http_status = response ? response.status() : null;
  await page.locator('[data-testid="header-balance-sum"]').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  raw.logged_in_balance_visible = await page.locator('[data-testid="header-balance-sum"]').isVisible().catch(() => false);
  raw.balance_text = await page.locator('[data-testid="header-balance-sum"]').innerText().catch(() => null);
  raw.currency_text = await page.locator('[data-testid="header-balance-currency-text"]').innerText().catch(() => null);
  raw.balance = raw.balance_text ? parseAmount(raw.balance_text) : null;

  const apiPost = (path, body) => page.evaluate(async ({ url, headers, body }) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { url: `https://api-gateway.top-parser.com${path}`, headers: apiHeaders, body });

  if (stage === 'list' || stage === 'binding') {
    raw.lists = {};
    for (const [name, body] of Object.entries({
      live: { limit: 100, service: 'live', excludeSportType: ['polybet', 'racing', 'esport'] },
      prematch: { limit: 100, service: 'prematch', excludeSportType: ['polybet', 'racing', 'esport'] },
    })) {
      raw.lists[name] = apiHeaders ? await apiPost('/matches/get-many', body) : { error: 'no_api_headers' };
    }
  }

  if (stage === 'binding') {
    // ---- account facts (read-only)
    const emailInfo = await page.evaluate(async () => {
      try { const r = await fetch('/api/VERIFICATION/email-info', { credentials: 'include' }); return { status: r.status, body: await r.json().catch(() => null) }; }
      catch (e) { return { error: String(e).slice(0, 120) }; }
    });
    let expectedEmail = null;
    try { expectedEmail = String(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).email || '').trim().toLowerCase() || null; } catch { /* absent */ }
    const seenEmail = emailInfo.body && typeof emailInfo.body.email === 'string' ? emailInfo.body.email.trim().toLowerCase() : null;
    raw.identity = {
      endpoint: 'GET /api/VERIFICATION/email-info', status: emailInfo.status ?? null, error: emailInfo.error ?? null,
      email_present: Boolean(seenEmail), expected_present: Boolean(expectedEmail),
      match: seenEmail && expectedEmail ? seenEmail === expectedEmail : null,
      seen_sha256_prefix: seenEmail ? sha(seenEmail).slice(0, 12) : null,
      expected_sha256_prefix: expectedEmail ? sha(expectedEmail).slice(0, 12) : null,
      is_verified: emailInfo.body ? emailInfo.body.isVerified ?? null : null,
    };
    raw.balances = await page.evaluate(async () => {
      try { const r = await fetch('/api/USER-SERVICE-API/api-v1-balances-get-activated', { credentials: 'include' }); return { status: r.status, body: await r.json().catch(() => null) }; }
      catch (e) { return { error: String(e).slice(0, 120) }; }
    });

    // ---- per event
    const items = new Map();
    for (const list of Object.values(raw.lists)) {
      for (const item of ((list.body || {}).result || {}).items || []) items.set(String(item.id), item);
    }
    const bound = [];
    for (const eventId of eventIds) {
      const entry = { event_id: eventId, list_item: items.get(eventId) || null, error: null };
      raw.events[eventId] = entry;
      try {
        oddsByMatch.delete(eventId);
        infoByMatch.delete(eventId);
        const before = maxBetRequests.length;
        await page.goto(`https://1win.pro/betting/match/sport/${eventId}`, { timeout: 45000, waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 40 && !oddsByMatch.has(eventId); i += 1) await page.waitForTimeout(500);
        await page.waitForTimeout(1500);
        const snap = oddsByMatch.get(eventId);
        entry.match_info = infoByMatch.get(eventId) || null;
        if (!snap) { entry.error = 'no_odds_snapshot'; continue; }
        entry.snapshot = { received_at: snap.at, ts: snap.ts, message_type: snap.message_type, groups: snap.groups };
        const wanted = [/^Total(?: \(incl\. OT\))?$/, /^(?:Winner(?: \(incl\. OT\))?|Result(?: \(reg\. time\))?|Full time result)$/, /^Handicap(?: \(incl\. OT\))?$/];
        entry.chosen = [];
        for (const pattern of wanted) {
          const group = snap.groups.find((g) => pattern.test(String(g.name)) && Array.isArray(g.oddsList)
            && g.oddsList.filter((o) => o.status === 1 && Number(o.cf) > 1.01).length >= 2);
          if (!group) continue;
          const open = group.oddsList.filter((o) => o.status === 1 && Number(o.cf) > 1.01);
          // the line closest to an even price is the most liquid, hence least likely to move
          const odd = [...open].sort((a, b) => Math.abs(Number(a.cf) - 1.9) - Math.abs(Number(b.cf) - 1.9))[0];
          entry.chosen.push({ group_id: group.id, group_name: group.name, odd_id: odd.id, odd_name: odd.name, outcome: odd.outcome,
            points: odd.vars ? odd.vars.v1 ?? null : null, cf: odd.cf, odd_ts: odd.ts, status: odd.status });
        }
        // UI readback of the first chosen selection: the coupon must carry the SAME oddId/cf the feed shows
        const first = entry.chosen[0];
        if (first) {
          await cart.clear().catch(() => {});
          const title = page.getByText(first.group_name, { exact: true }).filter({ visible: true });
          const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
          const button = group.getByRole('button').filter({ has: page.getByText(first.odd_name, { exact: true }) });
          const ui = { button_count: await button.count().catch(() => 0) };
          entry.ui = ui;
          if (ui.button_count === 1) {
            ui.board_price = parseAmount(await button.locator('span[class^="_cf_"]').innerText().catch(() => ''));
            await button.click({ timeout: 6000 });
            const slip = cart.slip();
            await slip.getByText(`${first.group_name}, ${first.odd_name}`, { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
            const amount = slip.locator('input[data-qa="amount"]:visible');
            await amount.click();
            await amount.press('ControlOrMeta+A');
            await amount.press('Backspace');
            await amount.pressSequentially('1');
            await amount.press('Tab');
            ui.amount_readback = parseAmount(await amount.inputValue());
            await page.waitForTimeout(2500);
            const text = await slip.innerText();
            const win = /Possible win\s*\n?\s*(?:USDT)?\s*([\d.,]+)/i.exec(text);
            ui.possible_win_text = win ? win[1] : null;
            ui.possible_win = win ? parseAmount(win[1]) : null;
            ui.slip_text_masked = text.replace(/\d[\d.,]*/g, '#').slice(0, 300);
            await slip.getByRole('button', { name: 'MAX', exact: true }).click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2500);
            ui.max_bet_requests = maxBetRequests.slice(before).map((r) => ({ at: r.at, currencyCode: r.body && r.body.currencyCode,
              selections: r.body && r.body.coupon && r.body.coupon.selections }));
            ui.max_bet_answers = (raw.responses['POST /bets/get-max-bet-amount'] || []).slice(-3).map((r) => ({ at: r.at, status: r.status, body: r.body }));
            ui.cleared = await cart.clear().catch(() => false);
          }
        }
        bound.push(entry);
      } catch (error) {
        entry.error = String(error && error.message).slice(0, 200);
        await cart.clear().catch(() => {});
      }
    }

    // ---- capacity and negative controls on the read-only limit endpoint
    raw.controls = {};
    raw.controls_have_token = Boolean(apiHeaders && apiHeaders.token);
    if (apiHeaders && apiHeaders.token && bound.length) {
      const a = bound[0].chosen && bound[0].chosen[0];
      const sameEventOther = bound[0].chosen && bound[0].chosen[1];
      const otherEvent = bound[1] && bound[1].chosen && bound[1].chosen[0];
      const lim = (selections, currencyCode = 'USDT') => apiPost('/bets/get-max-bet-amount', { currencyCode, coupon: { selections } });
      if (a) {
        raw.controls.exact = await lim([{ oddId: a.odd_id, cf: a.cf }]);
        raw.controls.cf_plus_25pct = await lim([{ oddId: a.odd_id, cf: Number((a.cf * 1.25).toFixed(2)) }]);
        raw.controls.cf_minus_25pct = await lim([{ oddId: a.odd_id, cf: Number((a.cf * 0.75).toFixed(2)) }]);
        raw.controls.wrong_currency_eur = await lim([{ oddId: a.odd_id, cf: a.cf }], 'EUR');
        raw.controls.unknown_odd_id = await lim([{ oddId: a.odd_id.replace(/:\d+$/, ':99').replace(/^10:\d+/, '10:1'), cf: a.cf }]);
        if (sameEventOther) {
          raw.controls.same_event_other_market = await lim([{ oddId: sameEventOther.odd_id, cf: sameEventOther.cf }]);
          raw.controls.same_event_two_selections = await lim([{ oddId: a.odd_id, cf: a.cf }, { oddId: sameEventOther.odd_id, cf: sameEventOther.cf }]);
        }
        if (otherEvent) {
          raw.controls.other_event_valid_selection = await lim([{ oddId: otherEvent.odd_id, cf: otherEvent.cf }]);
          raw.controls.two_events_express = await lim([{ oddId: a.odd_id, cf: a.cf }, { oddId: otherEvent.odd_id, cf: otherEvent.cf }]);
        }
      }
    }
    raw.base_settings = (raw.responses['GET /bets/get-base-settings'] || [])[0] || null;
  }

  raw.coverage = await cart._guard.verifyCoverage();
  raw.console_errors = consoleErrors;
  raw.guard_final = cart._guard.report();
  raw.blocked_money = cart.blocked.slice(0, 50);
  raw.blocked_unknown = cart.blockedUnknown.slice(0, 150);
  raw.guard_violations = cart._guard.violations.slice(0, 50);
  raw.bridge = bridge ? bridge.stats() : null;
  return true;
});
raw.session_closed = session.closed;
raw.finished_at = new Date().toISOString();
fs.writeFileSync(privateOut, JSON.stringify(raw, null, 2), { mode: 0o600 });
fs.chmodSync(privateOut, 0o600);

const summary = {
  stage, started_at: startedAt, finished_at: raw.finished_at, proxy_endpoint: proxy.endpoint,
  proxy_config_sha256_prefix: sha(fs.readFileSync(proxyConfig)).slice(0, 12),
  http_status: raw.http_status, logged_in: raw.logged_in_balance_visible, currency: raw.currency_text, balance: raw.balance,
  guard_coverage: raw.coverage && raw.coverage.checks, blocked_money: raw.blocked_money.length,
  blocked_unknown: raw.blocked_unknown.length,
  identity: raw.identity ? { status: raw.identity.status, match: raw.identity.match } : undefined,
  events: Object.fromEntries(Object.entries(raw.events).map(([id, e]) => [id, { error: e.error, chosen: (e.chosen || []).length,
    ui_button_count: e.ui && e.ui.button_count, ui_amount: e.ui && e.ui.amount_readback }])),
  session_closed: raw.session_closed, private_out: privateOut,
};
console.log(JSON.stringify(summary, null, 2));
