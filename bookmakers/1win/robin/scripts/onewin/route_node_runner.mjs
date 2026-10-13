// Node side of the isolated route proof (see route_proof.py).
//
//   queue-add     stdin {pair, outcome, stake, expected_odds}  -> REAL TaskBuilder + TasksManager.addTask
//   queue-current --file tasks.json                            -> what a (restarted) consumer reads
//   queue-cancel  --file tasks.json --id <id>                  -> REAL TasksManager.cancelTask
//   consume       --file tasks.json stdin {...}                -> REAL OneWinLiveCart in a REAL Chromium
//                                                               against a local TLS stand (a STUB of the
//                                                               bookmaker: "money" is a counter there)
//
// The consumer here is glue written for the proof: it reads the queue item through TasksManager,
// takes the already verified plan, drives the real cart and writes the outcome back to the queue
// (markCompleted / markFailed). It adds no decision logic of its own.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OneWinLiveCart, DurableAttemptStore } from './browser_live_cart.mjs';
import { eventPageHtml, launchStandBrowser, startStand } from './transport_stand.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const { TaskBuilder } = require(path.join(repo, 'core/node/betting/TaskBuilder.js'));
const { TasksManager } = require(path.join(repo, 'core/node/tasks/tasks-manager.js'));

function readStdin() {
  return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const quiet = (fn) => {
  const log = console.log; const warn = console.warn; const err = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; console.error = err; }
};
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';

const command = process.argv[2];

if (command === 'queue-add') {
  const input = readStdin();
  const file = arg('file');
  const result = quiet(() => {
    const manager = new TasksManager({ tasksFilePath: file });
    const builder = new TaskBuilder({ bookmakerName: '1win' });
    const tracker = { pair: input.pair, outcomeData: input.outcome, type: 'single', outcome: input.outcome.outcome,
      lastROI: input.outcome.roi ?? 0, matchId: input.pair.second.matchId };
    const task = builder.build(tracker, { stake: input.stake ?? 1, isHighROI: false, home: input.pair.first.homeName,
      away: input.pair.first.awayName, ourSide: input.pair.second, expectedOdds: input.outcome.score2.value });
    const added = manager.addTask(task);
    return { added, item: manager.getCurrentTask('1win') };
  });
  out(result);
} else if (command === 'queue-current') {
  const file = arg('file');
  const manager = quiet(() => new TasksManager({ tasksFilePath: file }));
  out({ item: quiet(() => manager.getCurrentTask('1win')), processing: quiet(() => manager.isProcessing('1win')) });
} else if (command === 'queue-cancel') {
  const manager = quiet(() => new TasksManager({ tasksFilePath: arg('file') }));
  const id = Number(arg('id'));
  out({ result: quiet(() => manager.cancelTask(id, { reason: 'proof-cancel', forceCurrent: true })),
    item_after: quiet(() => manager.getCurrentTask('1win')) });
} else if (command === 'store-read') {
  // a restarted process reads the durable attempt: what survived a crash
  const store = new DurableAttemptStore(arg('store'));
  out({ attempt: store.getAttempt(arg('key')) });
} else if (command === 'reconcile') {
  // operator reconciliation of an unknown outcome against the bookmaker's history, by identity
  const input = readStdin();
  const store = new DurableAttemptStore(input.store_path);
  const seq = await store.addRevision(input.key, { kind: input.kind, data: input.data });
  out({ seq, attempt: store.getAttempt(input.key) });
} else if (command === 'consume') {
  const input = readStdin();
  const file = arg('file');
  const scenario = input.scenario || {};
  const plan = input.plan;
  const manager = quiet(() => new TasksManager({ tasksFilePath: file }));
  const item = quiet(() => manager.getCurrentTask('1win'));
  const summary = { queue_item_id: item ? item.id : null, plan_key: plan.idempotency_key };
  const stand = await startStand({ tls: true });
  let browser;
  try {
    const launched = await launchStandBrowser(stand);
    if (!launched) throw new Error('PLAYWRIGHT_UNAVAILABLE');
    browser = launched.browser;
    await launched.context.close();
    stand.hooks.makeBetAnswer = scenario.answer ? () => scenario.answer : null;
    stand.hooks.makeBetDelayMs = scenario.delay_ms || 0;
    const sel = plan.selection;
    const price = scenario.board_price ?? sel.price;
    stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin, eventId: sel.event_id, marketId: sel.market_id,
      oddId: sel.selection_id, marketTitle: sel.market_name, outcomeName: plan.ui_selection_name, price: String(price) }));
    // the plan names the production URL; the stand answers on the same host name at its own port
    const planForStand = JSON.parse(JSON.stringify(plan));
    planForStand.selection.event_url = `https://1win.pro:${stand.port}/betting/match/sport/${sel.event_id}`;

    const store = new DurableAttemptStore(input.store_path);
    // fault injection points are keyed on durable phase records of the REAL store
    const realRecord = store.record.bind(store);
    let jump = 0;
    store.record = async (key, status, detail) => {
      const result = await realRecord(key, status, detail);
      if (scenario.crash_after === status) process.kill(process.pid, 'SIGKILL');
      if (scenario.clock_jump_after === status) jump = scenario.clock_jump_seconds || 0;
      if (scenario.withdraw_after === status) await store.requestWithdrawal(key, 'proof-withdrawal');
      return result;
    };
    if (scenario.crash_when_stand_receives) {
      stand.hooks.onMakeBet = () => process.kill(process.pid, 'SIGKILL');
    }
    const t0 = Date.now();
    const clockStart = input.clock_start;
    const now = () => clockStart + (Date.now() - t0) / 1000 + jump;
    const cancelled = async () => {
      const current = quiet(() => new TasksManager({ tasksFilePath: file }).getCurrentTask('1win'));
      return !current || current.id !== summary.queue_item_id;
    };
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const cart = new OneWinLiveCart(page, { attemptStore: store, liveEnabled: true,
        diagnosticMode: scenario.diagnostic_mode !== false,
        transportPolicy: { betApiOrigins: [stand.betOrigin] } });
      if (scenario.processing_flag !== false) quiet(() => manager.startProcessing('1win'));
      let result; let thrown = null;
      try {
        result = await cart.run(planForStand, { now, cancelled });
      } catch (error) {
        thrown = String(error && error.message || error).slice(0, 300);
      }
      let attempt = null;
      try { attempt = store.getAttempt(plan.idempotency_key); } catch { /* unreadable */ }
      // write the outcome back to the queue, as a consumer must
      let queueWriteBack = null;
      if (attempt && attempt.status === 'ACCEPTED') {
        queueWriteBack = quiet(() => manager.markCompleted(summary.queue_item_id, { odds: attempt.receipt && attempt.receipt.accepted_cf,
          stake: attempt.stake, receipt_ref: attempt.receipt && attempt.receipt.bet_id, synthetic: true }));
      } else if (attempt && ['REJECTED', 'WITHDRAWN', 'INDETERMINATE'].includes(attempt.status)) {
        queueWriteBack = quiet(() => manager.markFailed(summary.queue_item_id, { message: `attempt_${attempt.status}`, step: 'executor' }));
      }
      const history = await page.evaluate(async (url) => {
        try { return (await (await fetch(url)).json()).result.items; } catch { return null; }
      }, `${stand.betOrigin}/bets/stand-history`).catch(() => null);
      summary.thrown = thrown;
      summary.result = result ? {
        status: result.status, ok: result.ok, error: result.error || null, stage: result.stage,
        submit_sent_count: result.submit_sent_count, blocked_reasons: result.blocked_reasons,
        receipt: result.receipt ? { bet_id: result.receipt.bet_id, accepted_cf: result.receipt.accepted_cf,
          amount: result.receipt.amount, currency: result.receipt.currency, condition_mismatches: result.receipt.condition_mismatches } : null,
        rejection_code: result.rejection_code || null,
        transport_guard: result.transport_guard ? { coverage: result.transport_guard.coverage, violation_kinds: result.transport_guard.violation_kinds } : null,
      } : null;
      summary.attempt = attempt ? { key: attempt.key, status: attempt.status, stake: attempt.stake, currency: attempt.currency,
        event_id: attempt.event_id, market_id: attempt.market_id, selection_id: attempt.selection_id, expected_odds: attempt.expected_odds,
        receipt: attempt.receipt, error: attempt.error, created_at: attempt.created_at, updated_at: attempt.updated_at,
        withdrawal_requested: attempt.withdrawal_requested || null, not_sent_proof: attempt.not_sent_proof || null } : null;
      summary.stand = {
        money_requests: stand.log.money.length,
        bodies: stand.log.money.map((m) => (m.body ? { idempotencyKey: m.body.idempotencyKey, amount: m.body.amount, currencyCode: m.body.currencyCode,
          oddId: m.body.coupon.selections[0].oddId, matchId: m.body.coupon.selections[0].matchId, cf: m.body.coupon.selections[0].cf } : null)),
        history,
      };
      summary.queue_write_back = queueWriteBack;
      summary.queue_after = quiet(() => ({ current: manager.getCurrentTask('1win'), processing: manager.isProcessing('1win') }));
    } finally { await context.close(); }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stand.close().catch(() => {});
  }
  out(summary);
} else {
  process.stderr.write('usage: route_node_runner.mjs queue-add|queue-current|queue-cancel|consume\n');
  process.exit(2);
}
