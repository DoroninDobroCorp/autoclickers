// The not-sent fence of the executor's attempt store (stage 0 of the platform follow-up, review P1-A):
// when no attempt exists for a key, a durable tombstone makes every later claim impossible; when one exists
// nothing is changed.  The claim and the fence are serialised by the same store lock, so for one key exactly
// one of them wins, whatever the interleaving — and a fence that was acknowledged can never be followed by a bet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DurableAttemptStore } from './browser_live_cart.mjs';
import { ExecutorCore, ExecutorError } from './executor_core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-fence-'));
const payload = (key, n = 1) => ({ idempotency_key: key, stake: 1, currency: 'USDT', event_id: `4002199${n}`, market_id: '6271', selection_id: `10:19367174412016982${n}:0` });

test('a fence on a key without an attempt is durable and refuses every later claim', async () => {
  const file = path.join(tmp(), 'attempts.json');
  const store = new DurableAttemptStore(file);
  const first = await store.fenceUnclaimed('k-1', 'consumer_order_not_acknowledged');
  assert.equal(first.fenced, true);
  assert.equal(first.tombstone.reason, 'consumer_order_not_acknowledged');
  // idempotent: the same tombstone, not a new one
  const again = await store.fenceUnclaimed('k-1', 'other reason');
  assert.deepEqual(again.tombstone, first.tombstone);
  // durable: a new process (another store object on the same file) sees it
  const successor = new DurableAttemptStore(file);
  assert.equal(successor.getTombstone('k-1').reason, 'consumer_order_not_acknowledged');
  await assert.rejects(() => successor.claim('k-1', { stake: 1, payload: payload('k-1') }), /WITHDRAWN_BEFORE_CLAIM/);
  assert.equal(successor.getAttempt('k-1'), null);
  // another key is not affected
  assert.equal(await successor.claim('k-2', { stake: 1, payload: payload('k-2', 2) }), true);
  assert.equal(successor.getTombstone('k-2'), null);
});

test('a fence on a key that has an attempt changes nothing and reports its status', async () => {
  const store = new DurableAttemptStore(path.join(tmp(), 'attempts.json'));
  await store.claim('k-3', { stake: 1, payload: payload('k-3', 3) });
  await store.record('k-3', 'PRE_CHECK_PASSED');
  const out = await store.fenceUnclaimed('k-3', 'x');
  assert.deepEqual(out, { fenced: false, status: 'PRE_CHECK_PASSED' });
  assert.equal(store.getTombstone('k-3'), null);
  assert.equal(store.getAttempt('k-3').withdrawal_requested, null, 'a fence is not a withdrawal');
  assert.equal(store.getAttempt('k-3').status, 'PRE_CHECK_PASSED');
});

test('two store objects on one file (one process): the claim and the fence of one key never both succeed', async () => {
  const file = path.join(tmp(), 'attempts.json');
  const a = new DurableAttemptStore(file);
  const b = new DurableAttemptStore(file);
  let claimedWins = 0;
  let fenceWins = 0;
  for (let i = 0; i < 40; i += 1) {
    const key = `race-${i}`;
    const pay = payload(key, (i % 9) + 1);
    pay.event_id = `9000${i}`;          // distinct selections: only the key decides
    const claimTask = a.claim(key, { stake: 1, payload: pay }).then((v) => ({ claimed: v }), (e) => ({ error: e.message }));
    const fenceTask = i % 2 ? b.fenceUnclaimed(key, 'race') : Promise.resolve().then(() => b.fenceUnclaimed(key, 'race'));
    const [c, f] = await Promise.all([claimTask, fenceTask]);
    if (c.claimed === true) {
      claimedWins += 1;
      assert.equal(f.fenced, false, `${key}: a claim succeeded and the fence was acknowledged`);
      assert.ok(b.getAttempt(key), key);
    } else {
      fenceWins += 1;
      assert.equal(f.fenced, true, `${key}: the claim failed (${c.error}) but the fence was not acknowledged`);
      assert.match(c.error || '', /WITHDRAWN_BEFORE_CLAIM/);
      assert.equal(b.getAttempt(key), null);
    }
  }
  assert.equal(claimedWins + fenceWins, 40);
});

function runWorker(file, op, key, startAt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, 'attempt_store_fence_worker.mjs'), file, op, key, String(startAt)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', reject);
    proc.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error(`no answer: ${out}`)); } });
  });
}

test('REAL processes: the claim and the fence of one key, started at the same instant, never both succeed', async () => {
  const file = path.join(tmp(), 'attempts.json');
  new DurableAttemptStore(file);
  const rounds = 16;
  const results = [];
  for (let round = 0; round < 4; round += 1) {
    const startAt = Date.now() + 600;                       // every process of the batch waits for the same instant
    const batch = [];
    for (let i = 0; i < rounds / 4; i += 1) {
      const key = `proc-race-${round}-${i}`;
      batch.push(runWorker(file, 'claim', key, startAt), runWorker(file, 'fence', key, startAt));
    }
    results.push(...await Promise.all(batch));
  }
  const store = new DurableAttemptStore(file);
  let claims = 0;
  let fences = 0;
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < rounds / 4; i += 1) {
      const key = `proc-race-${round}-${i}`;
      const claim = results.find((r) => r.key === key && r.op === 'claim');
      const fence = results.find((r) => r.key === key && r.op === 'fence');
      const claimed = claim.claimed === true;
      assert.ok(!(claimed && fence.fenced === true), `${key}: both won (${JSON.stringify([claim, fence])})`);
      assert.ok(claimed || fence.fenced === true, `${key}: neither won (${JSON.stringify([claim, fence])})`);
      if (claimed) { claims += 1; assert.ok(store.getAttempt(key)); assert.equal(store.getTombstone(key), null); }
      else { fences += 1; assert.equal(store.getAttempt(key), null); assert.ok(store.getTombstone(key)); }
    }
  }
  assert.equal(claims + fences, rounds);
});

test('the executor refuses a fenced key for good and shows the tombstone in the attempt view', async () => {
  const dir = tmp();
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  let browserOpened = 0;
  const core = new ExecutorCore({ storePath: path.join(dir, 'attempts.json'), mode: 'real', betApiOrigins: ['https://127.0.0.1:1'],
    browserFactory: async () => { browserOpened += 1; throw new Error('must not be reached'); } });
  await core.start();
  try {
    const answer = await core.fence('late-1', 'consumer_order_not_acknowledged');
    assert.equal(answer.fence.fenced, true);
    assert.equal(answer.fenced.reason, 'consumer_order_not_acknowledged');
    assert.equal(answer.attempt, null);
    assert.equal(answer.store.path_sha256.length, 16);
    const view = core.attempt('late-1');
    assert.equal(view.fenced.reason, 'consumer_order_not_acknowledged');
    // the delayed request arrives: refused, no run, no browser
    const envelope = { schema: 'automation-executor-order.v1', mode: 'real', plan: { idempotency_key: 'late-1', selection: { event_id: '1' } },
      provenance: { synthetic: true }, consumer: { id: 'c' } };
    await assert.rejects(() => core.submitOrder(envelope), (error) => error instanceof ExecutorError && error.code === 'ORDER_FENCED' && error.status === 409);
    assert.equal(core.inFlight.size, 0);
    assert.equal(core.lastRuns.has('late-1'), false);
    assert.equal(browserOpened, 0);
    // the fence of a key that is unknown to a restarted executor is the same tombstone
    await core.stop();
    const next = new ExecutorCore({ storePath: path.join(dir, 'attempts.json'), mode: 'real', betApiOrigins: ['https://127.0.0.1:1'],
      browserFactory: async () => { throw new Error('must not be reached'); } });
    await next.start();
    assert.equal(next.attempt('late-1').fenced.reason, 'consumer_order_not_acknowledged');
    await next.stop();
  } finally {
    await core.stop().catch(() => {});
  }
});
