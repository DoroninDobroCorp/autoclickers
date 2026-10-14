// HTTP face of the 1win executor (contract automation-executor.v1) and its command line.
//
//   node executor_service.mjs --config <executor.json>
//
// The config is a private file whose location is an operational fact: there is no default. It is
// never read from the repository and no secret is printed. The service listens on loopback; a
// consumer on another host reaches it through a tunnel (the Mac boundary is documented in HANDOFF).
// A bearer token (taken from the environment variable named in the config) is required on every call.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ExecutorCore, ExecutorError, EXECUTOR_CONTRACT } from './executor_core.mjs';
import { DEFAULT_BET_API_ORIGINS } from './transport_guard.mjs';
import { parseProxyUrl } from './proxy_bridge.mjs';
import { withBrowserSession } from './session_runner.mjs';

const MAX_BODY = 1_000_000;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ExecutorError('BODY_TOO_LARGE', 'request body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new ExecutorError('BODY_NOT_JSON', 'JSON body required', 400)); }
    });
    req.on('error', reject);
  });
}

const tokenOk = (given, expected) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export function createExecutorServer(core, { token, host = '127.0.0.1', port = 0 } = {}) {
  if (!token || String(token).length < 16) throw new Error('EXECUTOR_TOKEN_TOO_SHORT');
  const server = http.createServer(async (req, res) => {
    try {
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ') || !tokenOk(auth.slice(7), token)) throw new ExecutorError('UNAUTHORIZED', 'bearer token required', 401);
      const url = new URL(req.url, 'http://executor');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== 'v1') throw new ExecutorError('NOT_FOUND', 'unknown route', 404);
      const method = req.method.toUpperCase();
      const body = method === 'POST' ? await readBody(req) : null;
      const route = parts.slice(1);
      if (method === 'GET' && route[0] === 'health' && route.length === 1) return sendJson(res, 200, core.health());
      if (method === 'POST' && route[0] === 'evidence' && route.length === 1) return sendJson(res, 200, await core.evidence(body));
      if (method === 'POST' && route[0] === 'orders' && route.length === 1) {
        const out = await core.submitOrder(body);
        return sendJson(res, out.accepted ? 202 : 200, out);
      }
      if (method === 'POST' && route[0] === 'dry-runs' && route.length === 1) return sendJson(res, 200, await core.dryRun(body));
      if (method === 'POST' && route[0] === 'recover' && route.length === 1) {
        return sendJson(res, 200, { changed: await core.recoverOrphans({ reason: 'requested' }) });
      }
      if (route[0] === 'attempts') {
        if (method === 'GET' && route.length === 1) return sendJson(res, 200, { attempts: core.listAttempts() });
        const key = route[1];
        if (method === 'GET' && route.length === 2) return sendJson(res, 200, core.attempt(key));
        if (method === 'POST' && route.length === 3 && route[2] === 'withdraw') return sendJson(res, 200, await core.withdraw(key, body && body.reason));
        if (method === 'POST' && route.length === 3 && route[2] === 'revisions') {
          return sendJson(res, 200, await core.addRevision(key, body && body.kind, body && body.data));
        }
      }
      throw new ExecutorError('NOT_FOUND', 'unknown route', 404);
    } catch (error) {
      if (error instanceof ExecutorError) {
        return sendJson(res, error.status, { error: { code: error.code, message: error.message, ...(error.extra || {}) } });
      }
      const code = String((error && error.message) || error).slice(0, 120);
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: code } });
    }
  });
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A browser that stays up between orders: owned (and closed, with proof) by withBrowserSession.
export async function openLongLivedSession(options) {
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  let ready;
  const readyPromise = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  // the service handles SIGTERM/SIGINT itself (it must stop the server and release the owner lock)
  const finished = withBrowserSession({ ...options, timeoutMs: 24 * 24 * 3600 * 1000, installSignalHandlers: false }, async (handles) => {
    ready.resolve(handles);
    await parked;
    return 'closed';
  });
  finished.catch((error) => ready.reject(error));
  const handles = await readyPromise;
  return {
    browser: handles.browser,
    info: { version: handles.browser.version(), marker: handles.marker },
    close: async () => { release(); return finished.catch(() => null); },
  };
}

function loadConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['store_path', 'mode', 'environment', 'listen', 'token_env']) {
    if (config[field] === undefined) throw new Error(`executor config: ${field} is required`);
  }
  if (!['dry', 'real'].includes(config.mode)) throw new Error('executor config: mode must be dry or real');
  if (!['production', 'local_stand'].includes(config.environment)) throw new Error('executor config: environment must be production or local_stand');
  if (config.environment === 'production' && config.bet_api_origins) throw new Error('executor config: a production executor uses the production origins');
  if (config.environment === 'local_stand' && !Array.isArray(config.bet_api_origins)) throw new Error('executor config: local_stand needs bet_api_origins');
  // the order contract carries money: it is reached through a tunnel, never through an open listener
  const host = (config.listen && config.listen.host) || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && config.listen.allow_non_loopback !== true) {
    throw new Error('executor config: listen.host must be loopback (set listen.allow_non_loopback only behind a firewall you own)');
  }
  return config;
}

async function main() {
  const flag = process.argv.indexOf('--config');
  if (flag < 0 || !process.argv[flag + 1]) {
    process.stderr.write('usage: executor_service.mjs --config <executor.json>\n');
    process.exit(2);
  }
  const config = loadConfig(process.argv[flag + 1]);
  const token = process.env[config.token_env];
  if (!token) throw new Error(`executor token: environment variable ${config.token_env} is not set`);
  const session = config.session || {};
  const options = {
    allowDirect: session.allow_direct === true,
    proxy: session.proxy_config_path ? parseProxyUrl(JSON.parse(fs.readFileSync(session.proxy_config_path, 'utf8')).proxy) : null,
    expectedProxyEndpoint: session.expected_proxy_endpoint || null,
    executablePath: session.executable_path || undefined,
    launchArgs: Array.isArray(session.launch_args) ? session.launch_args : [],
  };
  const core = new ExecutorCore({
    storePath: config.store_path,
    betApiOrigins: config.environment === 'production' ? DEFAULT_BET_API_ORIGINS : config.bet_api_origins,
    mode: config.mode,
    siteOrigin: config.site_origin || null,
    maxBudgetUsdt: config.max_budget_usdt || 1.0,
    browserFactory: () => openLongLivedSession(options),
    contextOptions: () => (session.storage_state_path
      ? { storageState: JSON.parse(fs.readFileSync(session.storage_state_path, 'utf8')) } : {}),
    log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  });
  const health = await core.start();
  const service = createExecutorServer(core, { token, host: config.listen.host || '127.0.0.1', port: config.listen.port || 0 });
  const address = await service.listen();
  process.stdout.write(`${JSON.stringify({ event: 'executor_ready', contract: EXECUTOR_CONTRACT, host: address.address, port: address.port,
    pid: process.pid, mode: health.mode, environment: health.transport_environment })}\n`);
  const shutdown = async () => {
    await service.close().catch(() => {});
    await core.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`executor failed to start: ${String((error && error.message) || error).slice(0, 300)}\n`);
    process.exit(1);
  });
}
