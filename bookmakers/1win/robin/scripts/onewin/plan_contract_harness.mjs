// Offline contract harness: drives the real OneWinLiveCart state machine with a
// plan produced by the Python adapter against a fake page and a transport that
// can never reach the network. Every "receipt" it returns is SYNTHETIC and must
// not be presented as a bookmaker bet.
//
// stdin : {"plan": {...}, "store_path": "...", "now": 1790000000.0,
//          "scenario": "accept"|"reject"|"timeout_after_send"|"expire_after_submitting"|"withdraw_after_submitting",
//          "board_price": 1.87}
// stdout: {"result": {...}, "attempt": {...}, "forwarded_requests": n, "synthetic_transport": true}
import fs from 'node:fs';
import { DurableAttemptStore, OneWinLiveCart } from './browser_live_cart.mjs';

function makeBetBody(plan) {
  const sel = plan.selection;
  return {
    currencyCode: plan.currency, idempotencyKey: plan.idempotency_key, amount: plan.stake,
    coupon: { amount: plan.stake, selections: [{ oddId: sel.selection_id, cf: sel.price, matchId: sel.event_id, marketId: sel.market_id }] },
    wallet: { type: 'real' },
  };
}

function fakePage(plan, { scenario, boardPrice, afterSubmitting }) {
  let routeHandler = null;
  let couponEmpty = true;
  let buffer = '10';
  let selected = false;
  let forwarded = 0;
  let pending = null;
  const dispatch = async () => {
    const body = makeBetBody({ ...plan, stake: Number(buffer) || plan.stake });
    let aborted = false; let passed = false;
    const req = { url: () => 'https://api-gateway.top-parser.com/bets/make-bet-v2', method: () => 'POST',
      postData: () => JSON.stringify(body), postDataJSON: () => body };
    await routeHandler({ request: () => req, abort: async () => { aborted = true; }, fallback: async () => { passed = true; } });
    if (aborted || !passed) throw new Error('REQUEST_ABORTED_BY_GUARD');
    forwarded += 1;
    if (scenario === 'timeout_after_send') throw new Error('socket hang up after send');
    const answer = scenario === 'reject'
      ? { errors: [{ code: 'max_bet_amount', meta: { maxBetAmount: 0.5 } }] }
      : { result: { success: { betId: `SYNTHETIC-${plan.idempotency_key}`, cf: plan.selection.price, amount: plan.stake,
          currencyCode: plan.currency, possibleProfitAmount: plan.stake * plan.selection.price } } };
    const res = { url: () => req.url(), status: () => 200, request: () => req, json: async () => answer };
    if (pending && pending.predicate(res)) pending.resolve(res);
  };
  const amount = {
    click: async () => { selected = false; },
    press: async (k) => { if (k === 'ControlOrMeta+A') selected = true; else if (k === 'Backspace') { buffer = selected ? '' : buffer.slice(0, -1); selected = false; } },
    pressSequentially: async (t) => { buffer = selected ? String(t) : buffer + String(t); selected = false; },
    inputValue: async () => `USDT ${buffer}`,
  };
  const button = { first: () => button, waitFor: async () => {}, count: async () => 1,
    locator: () => ({ innerText: async () => String(boardPrice) }),
    click: async () => { couponEmpty = false; buffer = '10'; } };
  const group = { count: async () => 1, getByRole: () => ({ filter: () => button }) };
  const slip = {
    getByText: (text) => ({ isVisible: async () => (text === 'Select an outcome' ? couponEmpty : !couponEmpty), waitFor: async () => {} }),
    getByRole: (_r, opts = {}) => (opts.name === 'Place a bet'
      ? { isVisible: async () => !couponEmpty, isEnabled: async () => !couponEmpty, click: async () => { await dispatch(); } }
      : { filter: () => ({ count: async () => (couponEmpty ? 0 : 1), isVisible: async () => !couponEmpty, click: async () => { couponEmpty = true; } }) }),
    locator: () => amount,
    screenshot: async () => {},
  };
  return {
    route: async (_p, h) => { routeHandler = h; },
    url: () => plan.selection.event_url, goto: async () => {}, locator: () => ({}),
    getByText: (text) => (text === 'Betslip' ? { locator: () => slip } : { filter: () => ({ locator: () => group }) }),
    waitForResponse: (predicate) => new Promise((resolve, reject) => { pending = { predicate, resolve, reject }; }),
    screenshot: async () => {},
    forwarded: () => forwarded,
  };
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
const store = new DurableAttemptStore(input.store_path);
const clock = { t: input.now };
const page = fakePage(input.plan, { scenario: input.scenario || 'accept', boardPrice: input.board_price ?? input.plan.selection.price });
const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true, diagnosticMode: input.diagnostic_mode ?? true,
  maxBudgetUsdt: input.max_budget ?? 1.0 });
const original = store.record.bind(store);
store.record = async (key, status, detail) => {
  const out = await original(key, status, detail);
  if (status === 'SUBMITTING' && input.scenario === 'expire_after_submitting') clock.t = input.plan.expires_at + 1;
  if (status === 'SUBMITTING' && input.scenario === 'withdraw_after_submitting') await store.requestWithdrawal(key, 'queue_withdrawn');
  return out;
};
let result; let error = null;
try {
  result = await cart.run(input.plan, { now: () => clock.t });
} catch (e) {
  error = String(e.message || e);
}
console.log(JSON.stringify({ result: result ?? null, error, attempt: store.getAttempt(input.plan.idempotency_key),
  forwarded_requests: page.forwarded(), synthetic_transport: true, network_used: false }));
