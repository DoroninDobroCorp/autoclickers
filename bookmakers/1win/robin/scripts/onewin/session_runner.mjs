// Owns the lifetime of one browser session: temporary proxy bridge, Chromium and the guard-ready
// context. Whatever ends the session (normal return, error, timeout, SIGTERM/SIGINT) closes the
// context, the browser and the bridge and proves it in the returned summary. Chromium is started
// with a unique marker so that a leftover process of THIS session can be found and killed; nothing
// else is touched.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startConnectBridge } from './proxy_bridge.mjs';

const require = createRequire(import.meta.url);

async function loadChromium() {
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/srv/betting/automation/node_modules/playwright'].filter(Boolean)) {
    try {
      const mod = require(spec);
      if (mod.chromium) return mod.chromium;
    } catch { /* next */ }
  }
  throw new Error('PLAYWRIGHT_UNAVAILABLE');
}

export function pidsWithMarker(marker) {
  if (!marker) return [];
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n')
      .filter((line) => line.includes(marker) && !line.includes('ps -eo'))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch { return []; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withBrowserSession(options, fn) {
  const {
    proxy = null,
    allowDirect = false,
    expectedProxyEndpoint = null,
    storageState = null,
    cookieOverrides = [],
    executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    timeoutMs = 120000,
    allowedPorts = [80, 443],
    contextOptions = {},
    launchArgs = [],
    installSignalHandlers = true,
    marker = `onewin-session-${crypto.randomUUID()}`,
  } = options || {};
  if (typeof fn !== 'function') throw new Error('SESSION_FN_REQUIRED');
  if (!proxy && !allowDirect) throw new Error('PROXY_REQUIRED');
  if (proxy && expectedProxyEndpoint && `${proxy.host}:${proxy.port}` !== expectedProxyEndpoint) {
    throw new Error('UNAPPROVED_PROXY_ENDPOINT');
  }
  const chromium = options.chromium || await loadChromium();
  const resources = { bridge: null, browser: null, context: null };
  const closed = { context: false, browser: false, bridge: false };
  let terminated = false;
  const abort = new AbortController();

  const cleanup = async () => {
    if (resources.context) { await Promise.race([resources.context.close().then(() => { closed.context = true; }, () => { closed.context = true; }), sleep(4000)]); }
    if (resources.browser) { await Promise.race([resources.browser.close().then(() => { closed.browser = true; }, () => { closed.browser = true; }), sleep(6000)]); }
    // a browser that ignored close() is killed by its marker; nothing outside this session is matched
    for (const pid of pidsWithMarker(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (resources.bridge) { await resources.bridge.close(); closed.bridge = true; }
  };

  const terminate = (name) => {
    if (terminated) return;
    terminated = true;
    abort.abort();
    cleanup().finally(() => process.exit(name === 'SIGINT' ? 130 : 124));
  };
  const onTerm = () => terminate('SIGTERM');
  const onInt = () => terminate('SIGINT');
  if (installSignalHandlers) {
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
  }
  const removeSignalHandlers = () => {
    if (installSignalHandlers) {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    }
  };

  let timer = null;
  try {
    let browserProxy;
    if (proxy) {
      if (proxy.scheme === 'socks5') {
        resources.bridge = await startConnectBridge({ upstream: proxy, allowedPorts });
        browserProxy = { server: resources.bridge.url };
      } else {
        browserProxy = { server: `${proxy.scheme}://${proxy.host}:${proxy.port}`,
          ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}) };
      }
    }
    resources.browser = await chromium.launch({
      headless: true,
      executablePath,
      ...(browserProxy ? { proxy: browserProxy } : {}),
      args: ['--no-sandbox', `--onewin-session-marker=${marker}`, ...launchArgs],
    });
    let state = storageState;
    if (state && cookieOverrides.length) {
      state = JSON.parse(JSON.stringify(state));
      for (const override of cookieOverrides) {
        for (const cookie of state.cookies || []) if (cookie.name === override.name) cookie.value = override.value;
      }
    }
    resources.context = await resources.browser.newContext({
      // a service worker would own requests and sockets outside every route
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
      ...(state ? { storageState: state } : {}),
      ...contextOptions,
    });
    const page = await resources.context.newPage();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('SESSION_TIMEOUT')); }, timeoutMs);
    });
    const value = await Promise.race([
      fn({ browser: resources.browser, context: resources.context, page, bridge: resources.bridge, signal: abort.signal, marker }),
      deadline,
    ]);
    return { value, closed: await finish() };
  } catch (error) {
    await finish();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeSignalHandlers();
  }

  async function finish() {
    await cleanup();
    return {
      ...closed,
      bridge_stats: resources.bridge ? resources.bridge.stats() : null,
      leftover_pids: pidsWithMarker(marker),
    };
  }
}
