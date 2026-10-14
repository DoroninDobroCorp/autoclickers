// One store operation in its own process (used by attempt_store_fence_test.mjs): `claim` or `fence` of one key.
import { DurableAttemptStore } from './browser_live_cart.mjs';

const [file, op, key, startAt] = process.argv.slice(2);
const store = new DurableAttemptStore(file);
const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);   // a common starting line
try {
  if (op === 'claim') {
    const claimed = await store.claim(key, { stake: 1, payload: { idempotency_key: key, stake: 1, currency: 'USDT', event_id: `E-${key}`, market_id: '6271', selection_id: `S-${key}` } });
    process.stdout.write(`${JSON.stringify({ op, key, claimed })}\n`);
  } else {
    const out = await store.fenceUnclaimed(key, 'process-race');
    process.stdout.write(`${JSON.stringify({ op, key, fenced: out.fenced, status: out.status || null })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ op, key, error: String(error.message) })}\n`);
}
