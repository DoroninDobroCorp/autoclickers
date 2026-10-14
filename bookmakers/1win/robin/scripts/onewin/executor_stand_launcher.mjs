// ISOLATED TEST HARNESS (never part of a deployment): the product executor (ExecutorCore + HTTP
// service) in front of a local TLS stand that plays the bookmaker, with a control API for drills.
//
//   - the executor, the cart, the transport guard and the durable attempt store are the PRODUCT code;
//   - the bookmaker is a counter in this process ("money" = a request that reached make-bet-v2);
//   - the evidence (native ids, commission, account) is SYNTHETIC and labelled so: it is what the
//     stand "serves", not a fact about 1win.
//
//   node executor_stand_launcher.mjs --state-dir <dir> --mode dry|real --token-env <NAME> [--clock-offset <seconds>] [--tls]
//
// Control API (loopback, no auth, test only): GET /stand/log  POST /stand/config  POST /stand/reset
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ExecutorCore } from './executor_core.mjs';
import { createExecutorServer } from './executor_service.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const stateDir = arg('state-dir');
const mode = arg('mode', 'dry');
const tokenEnv = arg('token-env', 'ONEWIN_EXECUTOR_TOKEN');
const clockOffset = arg('clock-offset') ? Number(arg('clock-offset')) : 0;
if (!stateDir) { process.stderr.write('--state-dir required\n'); process.exit(2); }
fs.mkdirSync(stateDir, { recursive: true });
const token = process.env[tokenEnv];
if (!token) { process.stderr.write(`environment variable ${tokenEnv} is not set\n`); process.exit(2); }
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = process.env.ONEWIN_AUTOMATION_LIVE_ENABLED ?? 'true';

const SYNTHETIC_SOURCE = 'synthetic-stand-fixture (not a bookmaker fact)';
const config = {
  ui: { market_name: '1st half. Total', ui_selection_name: 'Under 1.0' },
  native_market: { sport_id: 18, group_name: '1st half. Total', selection_name: 'Under 1.0', points: 1.0, outcome_code: 'under' },
  board: { price_delta: 0 },
  answer: null,           // make-bet-v2 answer (JSON) or null = accepted
  delay_ms: 0,
  drop_make_bet: 0,
  crash_when_stand_receives: false,
  crash_after_record: null,   // attempt status after whose durable record this process kills itself
  withdraw_after_record: null, // attempt status after whose durable record the attempt is asked to withdraw
  page_delay_ms: 0,           // the event page answers slowly (a long phase before the point of no return)
  clock_jump_seconds: 0,
  clock_offset: null,        // seconds added to the wall clock (set by a drill right before it runs)
  evidence: { available: true, reason: null, commission: 0.0, max_stake: 8.45, available_balance: 8.45, currency: 'USDT',
    account_currency: 'USDT', account_identity_verified: true, logged_in: true, odds_delta: 0, axes: null,
    native_market: null, native_selection_id: null, source_age_s: 0.2, contract_verified: true },
};
const merge = (target, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
};

const stand = await startStand({ tls: true });
const calls = { evidence: 0, orders: 0, dry_runs: 0 };
const clock = () => Date.now() / 1000 + (config.clock_offset ?? clockOffset) + config.clock_jump_seconds;

let lastBoard = null;
function serveBoard(request) {
  const ex = request.quote.execution;
  lastBoard = {
    eventId: String(ex.provider_event_key), marketId: String(ex.provider_market_key), oddId: String(ex.provider_selection_key),
    price: request.quote.odds,
  };
  stand.pages.set('/betting/match/*', () => eventPageHtml({
    betOrigin: stand.betOrigin, eventId: lastBoard.eventId, marketId: lastBoard.marketId, oddId: lastBoard.oddId,
    marketTitle: config.ui.market_name, outcomeName: config.ui.ui_selection_name,
    price: String(Number((lastBoard.price + config.board.price_delta).toFixed(4))),
  }));
}

const evidenceProvider = {
  name: 'synthetic-stand-evidence',
  async collect(request) {
    const e = config.evidence;
    calls.evidence += 1;
    if (!e.available) return { available: false, reason: e.reason || 'stand_evidence_withheld' };
    const ex = request.quote.execution || {};
    serveBoard(request);
    const at = request.now - e.source_age_s;
    const quote = {
      identity_verified_by: 'onewin-executor', verified: true,
      provider_id_namespace: ex.provider_id_namespace, provider_event_key: ex.provider_event_key,
      native_event_id: ex.provider_event_key, native_market_id: ex.provider_market_key,
      native_selection_id: e.native_selection_id ?? ex.provider_selection_key,
      source_market: request.quote.source_market, odds: Number((request.quote.odds + e.odds_delta).toFixed(4)), source_ts: at,
      currency: e.currency, commission: e.commission, max_stake: e.max_stake,
      axes: e.axes ?? request.quote.market_axes,
      live_submit_contract_verified: e.contract_verified, live_submit_contract_source: e.contract_verified ? SYNTHETIC_SOURCE : null,
      native_market: e.native_market ?? { ...config.native_market },
    };
    return {
      available: true, synthetic: true, source: SYNTHETIC_SOURCE,
      executor_quote: quote,
      account_state: { logged_in: e.logged_in, account_identity_verified: e.account_identity_verified, account_identity_source: SYNTHETIC_SOURCE,
        currency: e.account_currency, available_balance: e.available_balance, observed_at: at },
      ui: { market_name: config.ui.market_name, ui_selection_name: config.ui.ui_selection_name,
        event_url: `https://1win.pro/betting/match/sport/${ex.provider_event_key}` },
    };
  },
};

const core = new ExecutorCore({
  storePath: path.join(stateDir, 'attempts.json'),
  betApiOrigins: [stand.betOrigin],
  siteOrigin: stand.siteOrigin,
  mode,
  clock,
  evidenceProvider,
  browserFactory: async () => {
    // one marker per launch (prefix: the drill's), recorded in the owner lock for a successor to find
    const marker = `${process.env.ONEWIN_STAND_MARKER || 'onewin-stand'}-${process.pid}-${Date.now()}`;
    const launched = await launchStandBrowser(stand, { marker });
    await launched.context.close();
    return { browser: launched.browser, info: { version: launched.browser.version(), marker },
      close: async () => { await launched.browser.close().catch(() => {}); } };
  },
});
await core.start();
// a warm browser: the first order does not pay for the launch
await core._ensureSession();
const realSubmit = core.submitOrder.bind(core);
core.submitOrder = async (envelope) => { calls.orders += 1; return realSubmit(envelope); };
const realDry = core.dryRun.bind(core);
core.dryRun = async (envelope) => { calls.dry_runs += 1; return realDry(envelope); };

// fault injection keyed on durable records of the REAL store and on what the stand receives
const realRecord = core.store.record.bind(core.store);
core.store.record = async (key, status, detail) => {
  const result = await realRecord(key, status, detail);
  if (config.crash_after_record === status) process.kill(process.pid, 'SIGKILL');
  if (config.withdraw_after_record === status) await core.store.requestWithdrawal(key, 'drill-withdrawal');
  return result;
};
stand.hooks.onMakeBet = () => { if (config.crash_when_stand_receives) process.kill(process.pid, 'SIGKILL'); };
Object.defineProperty(stand.hooks, 'makeBetAnswer', { get: () => (config.answer ? () => config.answer : null), configurable: true });
Object.defineProperty(stand.hooks, 'makeBetDelayMs', { get: () => config.delay_ms, configurable: true });
Object.defineProperty(stand.hooks, 'pageDelayMs', { get: () => config.page_delay_ms, configurable: true });
Object.defineProperty(stand.hooks, 'dropMakeBet', {
  get: () => config.drop_make_bet,
  set: (value) => { config.drop_make_bet = value; },
  configurable: true,
});

const service = createExecutorServer(core, { token, host: '127.0.0.1', port: Number(arg('executor-port', 0)) });
const address = await service.listen();

const control = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://control');
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'bad json' }); }
    if (req.method === 'GET' && url.pathname === '/stand/log') {
      return send(200, {
        money_requests: stand.log.money.length,
        money: stand.log.money.map((m) => ({ via: m.via, path: m.path, body: m.body || null })),
        http_paths: stand.log.http.map((h) => `${h.method} ${h.path}`),
        page_paths: stand.log.pages.map((h) => `${h.method} ${h.path}`),
        ws_money: stand.log.money.filter((m) => m.via === 'ws').length,
        board: lastBoard, clock: clock(), calls,
      });
    }
    if (req.method === 'POST' && url.pathname === '/stand/config') { merge(config, body); return send(200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/stand/reset') { stand.reset(); return send(200, { ok: true }); }
    return send(404, { error: 'unknown' });
  });
});
await new Promise((resolve) => control.listen(Number(arg('control-port', 0)), '127.0.0.1', resolve));

process.stdout.write(`${JSON.stringify({ event: 'stand_ready', executor_port: address.port, control_port: control.address().port, pid: process.pid,
  mode, environment: core.environment, bet_origin: stand.betOrigin, recovered_on_start: core.recovered })}\n`);

const shutdown = async () => {
  await service.close().catch(() => {});
  await new Promise((resolve) => control.close(resolve));
  await core.stop().catch(() => {});
  await stand.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
