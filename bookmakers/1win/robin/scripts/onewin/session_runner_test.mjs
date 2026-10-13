// Lifetime of the temporary proxy bridge and of the browser: whatever ends the session closes both.
// Real Chromium, a real loopback SOCKS5 upstream (with authentication) and the TLS stand; no
// external network, no account, no real proxy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pidsWithMarker, withBrowserSession } from './session_runner.mjs';
import { chromiumPath, loadChromium, startStand } from './transport_stand.mjs';

const chromium = await loadChromium().catch(() => null);
const executablePath = chromiumPath();

// minimal RFC1928/1929 server: username/password auth, CONNECT only, every destination name is
// mapped to loopback (the test double of "the internet"); it records what was asked.
function startFakeSocks({ user = 'u', pass = 'p' } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth' && buffer.length >= 2) {
        const ulen = buffer[1];
        if (buffer.length >= 2 + ulen + 1) {
          const plen = buffer[2 + ulen];
          if (buffer.length >= 3 + ulen + plen) {
            const u = buffer.subarray(2, 2 + ulen).toString();
            const p = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
            buffer = buffer.subarray(3 + ulen + plen);
            if (u !== user || p !== pass) { client.end(Buffer.from([1, 1])); return; }
            client.write(Buffer.from([1, 0]));
            stage = 'request';
          }
        }
      }
      if (stage === 'request' && buffer.length >= 5) {
        const atyp = buffer[3];
        if (atyp !== 3) { client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const nlen = buffer[4];
        if (buffer.length >= 5 + nlen + 2) {
          const host = buffer.subarray(5, 5 + nlen).toString();
          const port = buffer.readUInt16BE(5 + nlen);
          const rest = buffer.subarray(5 + nlen + 2);
          stage = 'piping';
          seen.push(`${host}:${port}`);
          const upstream = net.connect(port, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) upstream.write(rest);
            client.pipe(upstream); upstream.pipe(client);
          });
          sockets.add(upstream);
          upstream.on('close', () => sockets.delete(upstream));
          upstream.on('error', () => client.destroy());
          client.on('close', () => upstream.destroy());
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, seen,
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  })));
}

function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

const baseOptions = (socks, stand, extra = {}) => ({
  chromium, executablePath, installSignalHandlers: false,
  proxy: { scheme: 'socks5', host: '127.0.0.1', port: socks.port, username: 'u', password: 'p' },
  allowedPorts: [stand.port],
  launchArgs: ['--ignore-certificate-errors'],
  contextOptions: { ignoreHTTPSErrors: true },
  ...extra,
});

async function fixture(t) {
  if (!chromium) { t.skip('playwright is not installed'); return null; }
  const stand = await startStand({ tls: true });
  const socks = await startFakeSocks();
  t.after(async () => { await socks.close(); await stand.close(); });
  return { stand, socks };
}

test('session reaches the site only through the authenticated upstream and closes everything afterwards', async (t) => {
  const f = await fixture(t); if (!f) return;
  const { stand, socks } = f;
  let bridgePort; let marker;
  const result = await withBrowserSession(baseOptions(socks, stand), async ({ page, bridge, marker: m }) => {
    bridgePort = bridge.port; marker = m;
    const response = await page.goto(`https://1win.pro:${stand.port}/`);
    assert.equal(response.status(), 200);
    assert.deepEqual(pidsWithMarker(marker).length > 0, true, 'the browser of this session is running');
    return 'done';
  });
  assert.equal(result.value, 'done');
  assert.ok(socks.seen.includes(`1win.pro:${stand.port}`), `traffic must go through the upstream: ${JSON.stringify(socks.seen)}`);
  assert.deepEqual(result.closed, { context: true, browser: true, bridge: true, bridge_stats: result.closed.bridge_stats, leftover_pids: [] });
  assert.ok(result.closed.bridge_stats.upstream_connections >= 1);
  assert.equal(await portIsClosed(bridgePort), true, 'bridge listener is gone');
  assert.deepEqual(pidsWithMarker(marker), []);
});

test('an error inside the session still closes bridge and browser', async (t) => {
  const f = await fixture(t); if (!f) return;
  let bridgePort; let marker;
  await assert.rejects(() => withBrowserSession(baseOptions(f.socks, f.stand), async ({ bridge, marker: m }) => {
    bridgePort = bridge.port; marker = m;
    throw new Error('boom');
  }), /boom/);
  assert.equal(await portIsClosed(bridgePort), true);
  assert.deepEqual(pidsWithMarker(marker), []);
});

test('a hanging session is stopped by the timeout and closes bridge and browser', async (t) => {
  const f = await fixture(t); if (!f) return;
  let bridgePort; let marker;
  const started = Date.now();
  await assert.rejects(() => withBrowserSession(baseOptions(f.socks, f.stand, { timeoutMs: 1500 }), async ({ page, bridge, marker: m }) => {
    bridgePort = bridge.port; marker = m;
    await page.goto(`https://1win.pro:${f.stand.port}/`);
    await new Promise(() => {});
  }), /SESSION_TIMEOUT/);
  assert.ok(Date.now() - started < 15000);
  assert.equal(await portIsClosed(bridgePort), true);
  assert.deepEqual(pidsWithMarker(marker), []);
});

test('SIGTERM of the owning process closes bridge and browser (exit 124)', async (t) => {
  const f = await fixture(t); if (!f) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-session-sigterm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'child.mjs');
  const here = new URL('./session_runner.mjs', import.meta.url).href;
  fs.writeFileSync(script, `
    import { withBrowserSession } from '${here}';
    await withBrowserSession({ proxy: { scheme: 'socks5', host: '127.0.0.1', port: ${f.socks.port}, username: 'u', password: 'p' },
      allowedPorts: [${f.stand.port}], launchArgs: ['--ignore-certificate-errors'], contextOptions: { ignoreHTTPSErrors: true },
      executablePath: ${JSON.stringify(executablePath || null)} || undefined }, async ({ page, bridge, marker }) => {
      await page.goto('https://1win.pro:${f.stand.port}/');
      console.log(JSON.stringify({ ready: true, bridgePort: bridge.port, marker }));
      await new Promise(() => {});
    });`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 40000;
  while (!out.includes('"ready":true') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('"ready":true'), `child did not become ready: ${out}`);
  const info = JSON.parse(out.trim().split('\n').pop());
  assert.equal(await portIsClosed(info.bridgePort), false, 'bridge listens while the session lives');
  assert.ok(pidsWithMarker(info.marker).length > 0);
  child.kill('SIGTERM');
  const exit = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 20000))]);
  assert.equal(exit.code, 124, JSON.stringify(exit));
  assert.equal(await portIsClosed(info.bridgePort), true, 'bridge listener is gone after SIGTERM');
  assert.deepEqual(pidsWithMarker(info.marker), []);
});

test('an unreachable upstream never falls back to a direct connection', async (t) => {
  const f = await fixture(t); if (!f) return;
  const deadPort = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const before = f.stand.log.http.length;
  const result = await withBrowserSession(baseOptions(f.socks, f.stand, {
    proxy: { scheme: 'socks5', host: '127.0.0.1', port: deadPort, username: 'u', password: 'p' } }), async ({ page }) => {
    return page.goto(`https://1win.pro:${f.stand.port}/`, { timeout: 8000 }).then(() => 'loaded', (e) => `failed:${String(e.message).slice(0, 60)}`);
  });
  assert.match(result.value, /^failed/);
  assert.equal(f.stand.log.http.length, before, 'the stand saw nothing: no direct fallback');
  assert.ok(result.closed.bridge_stats.upstream_failures >= 1);
});

test('only the approved endpoint is accepted and a missing proxy is refused', async (t) => {
  await assert.rejects(() => withBrowserSession({ proxy: { scheme: 'socks5', host: '203.0.113.9', port: 1080 },
    expectedProxyEndpoint: '196.19.228.25:8000', installSignalHandlers: false, chromium: {} }, async () => 1), /UNAPPROVED_PROXY_ENDPOINT/);
  await assert.rejects(() => withBrowserSession({ installSignalHandlers: false, chromium: {} }, async () => 1), /PROXY_REQUIRED/);
  void t;
});
