// Queue side of the 1win consumer: one process that owns the TasksManager I/O of one tasks file.
// The consumer (Python) talks to it with JSON lines on stdin/stdout:
//
//   request  {"id": 7, "op": "claim", "args": {...}}
//   response {"id": 7, "ok": true, "result": {...}}  |  {"id": 7, "ok": false, "error": {"code", "message"}}
//
// It calls the REAL TasksManager (core/node/tasks/tasks-manager.js): the file lock, the execution
// claim and the outcome record live there, not here. This worker only exposes them.
//
//   node queue_worker.mjs --tasks-file <file> [--bookmaker 1win] [--producer-ops]
//
// --producer-ops adds `produce`, `cancel`, `request_stop`: the producer side of the queue (the real
// TaskBuilder + addTask), for isolated tests and drills. A production consumer never enables it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const { TasksManager } = require(path.join(repo, 'core/node/tasks/tasks-manager.js'));
const { TaskBuilder } = require(path.join(repo, 'core/node/betting/TaskBuilder.js'));

// the manager logs to stdout; stdout belongs to the protocol
const toStderr = (...args) => process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
console.log = toStderr;
console.warn = toStderr;
console.error = toStderr;
console.info = toStderr;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const tasksFile = arg('tasks-file');
const bookmaker = arg('bookmaker', '1win');
const producerOps = process.argv.includes('--producer-ops');
if (!tasksFile) {
  process.stderr.write('usage: queue_worker.mjs --tasks-file <file> [--bookmaker 1win] [--producer-ops]\n');
  process.exit(2);
}

// the consumer owns one bookmaker's slot: its start never cleans the slots of the others
const manager = new TasksManager({ tasksFilePath: tasksFile, startupCleanup: false });

function locate(taskId) {
  const data = manager.read();
  const current = data.currentTasks[bookmaker];
  if (current && current.id === taskId) return { where: 'current', task: current, data };
  const pending = data.pendingTasks[bookmaker];
  if (pending && pending.id === taskId) return { where: 'pending', task: pending, data };
  return { where: null, task: null, data };
}

const OPS = {
  ping: () => ({ pong: true, bookmaker, pid: process.pid }),

  // what the consumer sees: the current task of its bookmaker and whether the slot is busy
  current: () => {
    const data = manager.read();
    return {
      item: data.currentTasks[bookmaker] || null,
      pending: data.pendingTasks[bookmaker] || null,
      processing: data.processing[bookmaker] === true,
    };
  },

  // state of one task: still queued where, asked to stop, lease, and its history record if it left
  task_state: ({ task_id: taskId }) => {
    const { where, task, data } = locate(taskId);
    const history = data.history.filter((h) => h.taskId === taskId && h.bookmakerId === bookmaker).slice(-3)
      .map((h) => ({ status: h.status, timestamp: h.timestamp, step: h.step || null, error: h.error || null,
        attemptKey: h.executionOutcome ? h.executionOutcome.attemptKey : null }));
    return {
      where,
      stop_requested: Boolean(task && task.stopRequested === true),
      claim: task && task.executionClaim ? task.executionClaim : null,
      processing: data.processing[bookmaker] === true,
      history,
    };
  },

  claim: ({ task_id: taskId, consumer_id: consumerId, lease_ms: leaseMs }) =>
    manager.claimTask(taskId, { consumerId, leaseMs: Number(leaseMs) || 30000 }),

  renew: ({ task_id: taskId, token, lease_ms: leaseMs }) =>
    manager.renewClaim(taskId, token, { leaseMs: Number(leaseMs) || 30000 }),

  release: ({ task_id: taskId, token }) => manager.releaseClaim(taskId, token),

  // the order is about to be handed to the executor: a lost lease from here on is an unresolved
  // exposure, not a cancellation (see TasksManager.markClaimHandoff)
  mark_handoff: ({ task_id: taskId, token, attempt_key: attemptKey }) => manager.markClaimHandoff(taskId, token, attemptKey),

  record_outcome: ({ task_id: taskId, outcome }) => manager.recordExecutionOutcome(taskId, outcome),

  resolve_outcome: ({ attempt_key: attemptKey, resolution }) => manager.resolveExecutionOutcome(attemptKey, resolution),

  history_by_attempt: ({ attempt_key: attemptKey }) => {
    const data = manager.read();
    const entry = data.history.find((h) => h.executionOutcome && h.executionOutcome.attemptKey === attemptKey);
    return { entry: entry || null };
  },

  stats: () => manager.getStats(),
};

if (producerOps) {
  OPS.produce = ({ pair, outcome, stake, source_type: sourceType, id, account_id: accountId, created_at: createdAt }) => {
    const builder = new TaskBuilder({ bookmakerName: bookmaker });
    const tracker = { pair, outcomeData: outcome, type: 'single', outcome: outcome.outcome, lastROI: outcome.roi ?? 0,
      matchId: pair.second.matchId };
    const task = builder.build(tracker, { stake: stake ?? 1, isHighROI: false, home: pair.first.homeName, away: pair.first.awayName,
      ourSide: pair.second, expectedOdds: outcome.score2.value });
    if (sourceType) { task.sourceType = sourceType; task.source = sourceType; }
    if (id !== undefined) task.id = id;                 // a re-delivered message keeps its id
    if (accountId !== undefined) task.accountId = accountId;
    if (createdAt !== undefined) task.createdAt = createdAt;
    const added = manager.addTask(task);
    return { added, item: manager.getCurrentTask(bookmaker), task_id: task.id };
  };
  OPS.cancel = ({ task_id: taskId, force_current: force }) => manager.cancelTask(taskId, { reason: 'drill-cancel', forceCurrent: force === true });
  OPS.request_stop = ({ task_id: taskId }) => manager.markStopRequested(taskId, { requestedBy: 'drill' });
  OPS.restart_manager = () => {
    // what any process does when it starts: the constructor cleanup (stale tasks, stuck flags)
    const fresh = new TasksManager({ tasksFilePath: tasksFile });
    return { current: fresh.getCurrentTask(bookmaker), processing: fresh.isProcessing(bookmaker) };
  };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: { code: 'BAD_JSON', message: 'request is not JSON' } })}\n`);
    return;
  }
  const op = OPS[request.op];
  if (!op) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'UNKNOWN_OP', message: String(request.op) } })}\n`);
    return;
  }
  try {
    const result = op(request.args || {});
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'OP_FAILED', message: String((error && error.message) || error).slice(0, 300) } })}\n`);
  }
});
rl.on('close', () => process.exit(0));
