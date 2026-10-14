// The product executor as a PROCESS (executor_service.mjs --config), against the local TLS stand:
// authentication, configuration refusals, start-up recovery of orphaned attempts, owner lock,
// a real dry run in a real browser, and a clean exit that closes the browser it owns.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DurableAttemptStore } from './browser_live_cart.mjs';
import { pidsWithMarker } from './session_runner.mjs';
import { BET_HOST, SITE_HOST, XSITE_HOST, chromiumPath, eventPageHtml, startStand } from './transport_stand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, 'executor_service.mjs');
const TOKEN = `test-token-${crypto.randomUUID()}`;
const MARKER = `onewin-service-test-${crypto.randomUUID().slice(0, 8)}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-executor-service-'));

function configFor(stand, dir, over = {}) {
  const file = path.join(dir, 'executor.json');
  fs.writeFileSync(file, JSON.stringify({
    store_path: path.join(dir, 'attempts.json'), mode: 'dry', environment: 'local_stand', token_env: 'ONEWIN_EXECUTOR_TOKEN',
    listen: { host: '127.0.0.1', port: 0 }, bet_api_origins: [stand.betOrigin], site_origin: stand.siteOrigin,
    session: { allow_direct: true, ...(chromiumPath() ? { executable_path: chromiumPath() } : {}), launch_args: [
      `--host-resolver-rules=MAP ${BET_HOST} 127.0.0.1,MAP ${SITE_HOST} 127.0.0.1,MAP ${XSITE_HOST} 127.0.0.1`,
      '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors', `--onewin-test-marker=${MARKER}`] },
    ...over,
  }));
  return file;
}

function start(configFile, env = {}) {
  const proc = spawn(process.execPath, [SERVICE, '--config', configFile], {
    env: { ...process.env, ONEWIN_EXECUTOR_TOKEN: TOKEN, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { err += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line: ${err.slice(-400)}`)), 60000);
    const poll = setInterval(() => {
      const line = out.split('\n').find((l) => l.includes('executor_ready'));
      if (line) { clearInterval(poll); clearTimeout(timer); resolve(JSON.parse(line)); }
    }, 50);
    proc.on('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`exited ${code}: ${err.slice(-400)}`)); });
  });
  ready.catch(() => {});   // a process that never gets ready is observed through `exited`
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve({ code, err })));
  return { proc, ready, exited };
}

async function call(port, method, urlPath, body, token = TOKEN) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('configuration refusals: no token, production with foreign origins, unknown environment, open listener', async () => {
  const dir = tmp();
  const stand = await startStand({ tls: true });
  try {
    const file = configFor(stand, dir);
    const noToken = spawn(process.execPath, [SERVICE, '--config', file], { env: { ...process.env, ONEWIN_EXECUTOR_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise((resolve) => noToken.on('exit', resolve));
    assert.equal(code, 1);
    for (const over of [{ environment: 'production' }, { environment: 'staging' }, { mode: 'live' },
      { listen: { host: '0.0.0.0', port: 0 } }]) {
      const bad = configFor(stand, dir, over);
      const proc = start(bad);
      const result = await proc.exited;
      assert.equal(result.code, 1, JSON.stringify(over));
    }
  } finally { await stand.close(); }
});

test('service process: auth, recovery of orphans on start, owner lock, real dry run, clean exit', async (t) => {
  const dir = tmp();
  const stand = await startStand({ tls: true });
  stand.pages.set('/betting/match/*', () => eventPageHtml({ betOrigin: stand.betOrigin, eventId: '40021999', marketId: '6271',
    oddId: '10:193671744120169820:0', marketTitle: '1st half. Total', outcomeName: 'Under 1.0', price: '1.87' }));
  // two orphans a dead owner left behind
  const seed = new DurableAttemptStore(path.join(dir, 'attempts.json'));
  const payload = (key, n) => ({ idempotency_key: key, stake: 1, currency: 'USDT', event_id: '4002199' + n, market_id: '6271', selection_id: `10:19367174412016982${n}:0` });
  await seed.claim('orphan-claimed', { stake: 1, payload: payload('orphan-claimed', 1) });
  await seed.claim('orphan-submitting', { stake: 1, payload: payload('orphan-submitting', 2) });
  await seed.record('orphan-submitting', 'PRE_CHECK_PASSED');
  await seed.record('orphan-submitting', 'SUBMITTING');
  const file = configFor(stand, dir);
  const service = start(file);
  try {
    const ready = await service.ready;
    assert.equal(ready.environment, 'local_stand');
    assert.equal((await call(ready.port, 'GET', '/v1/health', undefined, 'x'.repeat(32))).status, 401);
    const health = (await call(ready.port, 'GET', '/v1/health')).body;
    assert.equal(health.contract, 'automation-executor.v1');
    assert.deepEqual(health.recovered_on_start.map((r) => [r.key, r.from, r.to]).sort(),
      [['orphan-claimed', 'CLAIMED', 'WITHDRAWN'], ['orphan-submitting', 'SUBMITTING', 'INDETERMINATE']]);
    assert.equal(health.evidence_provider, null);
    const evidence = (await call(ready.port, 'POST', '/v1/evidence', { quote: {} })).body;
    assert.deepEqual([evidence.available, evidence.reason], [false, 'evidence_provider_not_configured']);

    // a second process on the same store refuses to start
    const second = start(file);
    assert.equal((await second.exited).code, 1);

    // a real dry run in a real browser: reads the board, prepares the coupon, clears it, places nothing
    const plan = { ok: true, idempotency_key: 'dry-key-1', ui_selection_name: 'Under 1.0',
      selection: { event_id: '40021999', event_url: 'https://1win.pro/betting/match/sport/40021999', market_id: '6271', market_name: '1st half. Total',
        selection_id: '10:193671744120169820:0', price: 1.87 } };
    const dry = await call(ready.port, 'POST', '/v1/dry-runs', { schema: 'automation-executor-order.v1', mode: 'dry', plan,
      provenance: { synthetic: true }, consumer: { id: 'test' } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.result.ok, dry.body.external_placement, dry.body.result.cart_cleared], [true, false, true], JSON.stringify(dry.body.result));
    assert.equal(stand.log.money.length, 0);
    // the executor is dry: a real order is refused before anything else
    const real = await call(ready.port, 'POST', '/v1/orders', { schema: 'automation-executor-order.v1', mode: 'real', plan,
      provenance: { synthetic: true }, consumer: { id: 'test' } });
    assert.deepEqual([real.status, real.body.error.code], [409, 'EXECUTOR_NOT_LIVE']);
    assert.ok(pidsWithMarker(MARKER).length > 0, 'the browser of the service is up and carries the marker');
  } finally {
    service.proc.kill('SIGTERM');
    const done = await service.exited;
    assert.equal(done.code, 0);
    await stand.close();
  }
  // the browser it owned is gone with it
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(pidsWithMarker(MARKER), []);
  const after = new DurableAttemptStore(path.join(dir, 'attempts.json'));
  assert.equal(after.getAttempt('orphan-claimed').status, 'WITHDRAWN');
  assert.equal(after.getAttempt('orphan-submitting').status, 'INDETERMINATE');
  assert.equal(fs.existsSync(path.join(dir, 'attempts.json.executor.lock')), false, 'the owner lock is released');
});
