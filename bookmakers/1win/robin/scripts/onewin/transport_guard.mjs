// Shared network boundary of the 1win carts (read-only OneWinDryRunCart and OneWinLiveCart).
//
// What a browser can do to an account is not limited to `fetch`: it can open WebSockets, create
// workers, register service workers, open popups, navigate forms. Playwright gives interception
// points for part of that surface only, so the guard combines
//   * a CONTEXT-level HTTP route (popups, dedicated workers and service-worker fetches included),
//     default-deny for every non-read request that is not a proven read-only endpoint;
//   * a CONTEXT-level WebSocket route: client->server frames pass a protocol-level allow-list
//     (engine.io control frames, socket.io connect, subscribe-* events); the stream is not blocked
//     wholesale because the quote feed needs it;
//   * an init script that removes the transports Playwright cannot route (Worker, SharedWorker,
//     service-worker registration, WebTransport, RTCDataChannel) in every frame of a FRESH document;
//   * canary probes against reserved ".invalid" names that prove, on the very document used for the
//     submit, that every one of those layers is really active.
// A layer that cannot be proven is a refusal, never a default permission.
//
// Nothing here knows about value, accounts or credentials.

export const TRANSPORT_GUARD_VERSION = 'onewin-transport-guard.v1';

export const DEFAULT_BET_API_ORIGINS = Object.freeze(['https://api-gateway.top-parser.com']);

// First-party endpoints of the bet API origin that are POST by contract but only read. Observed in
// the 1win SPA during read-only account windows: coupon limit lookups (2026-10-12/13) and the match /
// highlight lists the event pages are built from (2026-10-13 discovery window: `matches/get-many`
// 9x and `highlights/get-many` 2x on /betting, answers are match lists). Every other POST of the
// client (monitoring/log-event, analytics, profile and bonus calls, auth/login refresh) is refused
// by default; it is recorded in the cart result so an operator can extend this list on evidence.
export const READ_ONLY_POST_PATHS = Object.freeze([
  '/bets/get-max-bet-amount',
  '/bets/get-auto-bet-amount-v2',
  '/matches/get-many',
  '/highlights/get-many',
]);

// Paths that move money or change a bet. Refused for EVERY method: a GET is not read-only just
// because of its verb.
const MONEY_PATH = new RegExp([
  '\\/bets\\/(?:make-?bet[\\w-]*|refund|cashout|sell|buyout|ordinary|express[\\w-]*|place[\\w-]*|create[\\w-]*|submit[\\w-]*)(?:\\/|$)',
  '\\/bets\\/api\\/v\\d+\\/user\\/bets',
  'place.?bet', 'bet.?place', 'create.?bet', 'bets?\\/create', 'bets?\\/submit', 'wager',
  'express-ordinary', '\\/ordinary(?:\\/|$)',
  '\\/fortune-wheel\\/make-roll', 'make-?roll',
].join('|'), 'i');

export const CANARY_HOST = 'onewin-guard-canary.invalid';
const CANARY_HTTP_URL = `https://${CANARY_HOST}/bets/make-bet-v2`;
const CANARY_WS_URL = `wss://${CANARY_HOST}/canary`;
const SW_CANARY_PATH = '/__onewin-guard-canary-sw.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMoneyPath(pathName) {
  return MONEY_PATH.test(String(pathName || ''));
}

// Pure HTTP classification. `kind` is one of
//   read | read_post | submit_endpoint | blocked
export function classifyHttpRequest({ method, url, betApiOrigins = DEFAULT_BET_API_ORIGINS, readOnlyPostPaths = READ_ONLY_POST_PATHS, live = false }) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url)); } catch { return { kind: 'blocked', reason: 'unparseable_url' }; }
  const verb = String(method || '').toUpperCase();
  const pathName = parsed.pathname;
  if (parsed.hostname === CANARY_HOST) return { kind: 'canary', reason: 'canary' };
  if (parsed.pathname === SW_CANARY_PATH) return { kind: 'sw_canary', reason: 'sw_canary' };
  const origins = new Set(betApiOrigins);
  if (READ_METHODS.has(verb)) {
    // A placement path is refused whatever the verb, but static assets that merely contain such a
    // word (an icon called wager.svg) are not API calls.
    const apiLike = origins.has(parsed.origin) || /^\/(?:bets?|fortune-wheel|coupon|payments?|api)\//i.test(pathName);
    if (verb !== 'OPTIONS' && apiLike && isMoneyPath(pathName)) return { kind: 'blocked', reason: 'mutation_path_via_read_method', money: true, signal: false };
    return { kind: 'read' };
  }
  if (live && /\/bets\/make-bet-v2(?:\/|$)/i.test(pathName)) return { kind: 'submit_endpoint' };
  if (verb === 'POST' && origins.has(parsed.origin) && readOnlyPostPaths.includes(pathName)) return { kind: 'read_post' };
  if (isMoneyPath(pathName)) return { kind: 'blocked', reason: live && /make-?bet/i.test(pathName) ? 'unknown_bet_endpoint' : 'forbidden_mutation_path', money: true };
  return { kind: 'blocked', reason: 'unknown_mutation_blocked', money: false };
}

const ENGINE_IO_CONTROL = new Set(['2', '3', '5', '6', '2probe', '3probe']);
const SUBSCRIBE_EVENT = /^(?:subscribe|unsubscribe)$/;
const SUBSCRIBE_TYPE = /^(?:subscribe|unsubscribe)-[a-z0-9][a-z0-9-]*$/;

// Pure classification of ONE client->server WebSocket frame. Only protocol control frames and
// subscription requests (the read channel of the odds feed) are allowed; everything else,
// binary frames and unparseable text included, is refused.
export function classifyWsFrame(frame, { extraEvents = [] } = {}) {
  if (typeof frame !== 'string') return { ok: false, reason: 'ws_binary_or_unknown_frame' };
  if (ENGINE_IO_CONTROL.has(frame)) return { ok: true, kind: 'engine_control' };
  const match = /^4([0-6])(.*)$/s.exec(frame);
  if (!match) return { ok: false, reason: 'ws_unrecognized_frame' };
  const [, packetType, rest] = match;
  if (packetType === '1') return rest === '' || /^\/[^,]*,?$/.test(rest) ? { ok: true, kind: 'sio_disconnect' } : { ok: false, reason: 'ws_malformed_disconnect' };
  if (packetType === '0') {
    // namespace and an optional auth object: 40, 40/ns, 40/ns,{...}, 40{...}
    const m = /^(?:\/[^,{]*,?)?(\{.*\})?$/s.exec(rest);
    if (!m) return { ok: false, reason: 'ws_malformed_connect' };
    if (m[1]) { try { JSON.parse(m[1]); } catch { return { ok: false, reason: 'ws_malformed_connect_payload' }; } }
    return { ok: true, kind: 'sio_connect' };
  }
  if (packetType === '2') {
    const m = /^(?:\/[^,]*,)?(\d*)(\[.*\])$/s.exec(rest);
    if (!m) return { ok: false, reason: 'ws_malformed_event' };
    let parsed;
    try { parsed = JSON.parse(m[2]); } catch { return { ok: false, reason: 'ws_malformed_event_json' }; }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2 || typeof parsed[0] !== 'string') return { ok: false, reason: 'ws_event_shape' };
    const name = parsed[0];
    const body = parsed[1];
    if (SUBSCRIBE_EVENT.test(name) && body && typeof body === 'object' && !Array.isArray(body) && SUBSCRIBE_TYPE.test(String(body.messageType || ''))) {
      return { ok: true, kind: 'subscription', event: name, messageType: body.messageType };
    }
    if (extraEvents.includes(name)) return { ok: true, kind: 'extra_event', event: name };
    return { ok: false, reason: `ws_event_not_allowed:${String(name).slice(0, 40)}` };
  }
  if (packetType === '3') {
    return /^(?:\/[^,]*,)?\d+\[.*\]$/s.test(rest) ? { ok: true, kind: 'sio_ack' } : { ok: false, reason: 'ws_malformed_ack' };
  }
  return { ok: false, reason: 'ws_binary_or_connect_error_packet' };
}

// Runs before any page script in every frame of a document created after the guard.
const HARDEN_SCRIPT = `(() => {
  const refuse = (name) => function () { throw new DOMException(name + ' is disabled by the transport guard', 'SecurityError'); };
  const define = (target, key, value) => { try { Object.defineProperty(target, key, { value, configurable: false, writable: false }); } catch (e) {} };
  if (typeof Worker !== 'undefined') define(globalThis, 'Worker', refuse('Worker'));
  if (typeof SharedWorker !== 'undefined') define(globalThis, 'SharedWorker', refuse('SharedWorker'));
  if (typeof WebTransport !== 'undefined') define(globalThis, 'WebTransport', refuse('WebTransport'));
  try {
    if (typeof ServiceWorkerContainer !== 'undefined') {
      define(ServiceWorkerContainer.prototype, 'register', function () {
        return Promise.reject(new DOMException('service worker registration is disabled by the transport guard', 'SecurityError'));
      });
    }
  } catch (e) {}
  try {
    if (typeof RTCPeerConnection !== 'undefined') define(RTCPeerConnection.prototype, 'createDataChannel', refuse('RTCDataChannel'));
  } catch (e) {}
})();`;

export class TransportGuard {
  constructor({
    page,
    mode = 'read_only',
    betApiOrigins = DEFAULT_BET_API_ORIGINS,
    readOnlyPostPaths = READ_ONLY_POST_PATHS,
    wsExtraEvents = [],
    blockWorkers = true,
    decideSubmit = null,
    isArmed = () => false,
    onBlocked = () => {},
    onAbortSignal = () => {},
    onWsFrame = null,
  } = {}) {
    if (!page) throw new Error('TRANSPORT_GUARD_PAGE_REQUIRED');
    if (mode !== 'read_only' && mode !== 'live') throw new Error('TRANSPORT_GUARD_MODE_INVALID');
    this.page = page;
    this.mode = mode;
    this.betApiOrigins = [...betApiOrigins];
    this.readOnlyPostPaths = [...readOnlyPostPaths];
    this.wsExtraEvents = [...wsExtraEvents];
    this.blockWorkers = Boolean(blockWorkers);
    this.decideSubmit = decideSubmit;
    this.isArmed = isArmed;
    this.onBlocked = onBlocked;
    this.onAbortSignal = onAbortSignal;
    // Observation only (evidence capture): receives every frame in both directions, cannot alter it.
    this.onWsFrame = typeof onWsFrame === 'function' ? onWsFrame : null;
    this.installed = false;
    this.needsFreshDocument = false;
    this.capabilities = { http_route: false, ws_route: false, init_script: false, scope: null };
    this.stats = { http_read: 0, http_read_post: 0, http_blocked: 0, http_submit_delegated: 0, ws_opened: 0, ws_frames_allowed: 0, ws_frames_blocked: 0,
      workers_seen: 0, service_workers_seen: 0 };
    this.violations = [];
    this._canary = { http: 0, ws: 0, sw: 0 };
    this._seen = new WeakSet();
    this._handlers = [];
    this._cleanup = [];
    this._cdp = new Map();
  }

  _violation(kind, detail) {
    if (this.violations.length < 200) this.violations.push({ kind, detail: String(detail).slice(0, 200), at: Date.now() });
  }

  _isTestDouble() {
    return typeof this.page.context !== 'function';
  }

  async install() {
    if (this.installed) return this.report();
    const page = this.page;
    const context = this._isTestDouble() ? null : page.context();
    if (context && typeof context.serviceWorkers === 'function' && context.serviceWorkers().length > 0) {
      // A service worker owns requests and sockets outside any route.
      throw new Error('SERVICE_WORKER_PRESENT');
    }
    const handler = (route) => this._handleRoute(route);
    // Page-level handlers run before context-level ones, so the guard is registered on BOTH: the
    // page-level copy (registered last = first to run) sees the page's requests before any
    // earlier page handler could answer or continue them, the context-level copy covers popups,
    // workers and service-worker fetches. A request seen twice is decided once.
    if (context && typeof context.route === 'function') {
      await context.route('**/*', handler);
      this.capabilities.scope = 'context+page';
      this._cleanup.push(() => context.unroute('**/*', handler).catch(() => {}));
    } else {
      this.capabilities.scope = 'page';
    }
    await page.route('**/*', handler);
    this._cleanup.push(() => (typeof page.unroute === 'function' ? page.unroute('**/*', handler).catch(() => {}) : null));
    this.capabilities.http_route = true;
    this._handlers.push(handler);
    if (context && typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(/.*/, (ws) => this._handleWebSocket(ws));
      this.capabilities.ws_route = true;
    }
    if (context && typeof context.addInitScript === 'function' && this.blockWorkers) {
      await context.addInitScript(HARDEN_SCRIPT);
      this.capabilities.init_script = true;
    }
    if (context) {
      // Anything that appears although it is blocked is a transport that bypasses the routes.
      const onWorker = (worker) => { this.stats.workers_seen += 1; this._violation('worker_created', worker && typeof worker.url === 'function' ? worker.url() : '?'); this.onAbortSignal('worker_created'); };
      const onServiceWorker = (worker) => { this.stats.service_workers_seen += 1; this._violation('service_worker_created', worker && typeof worker.url === 'function' ? worker.url() : '?'); this.onAbortSignal('service_worker_created'); };
      const onPage = (newPage) => {
        if (typeof newPage.on === 'function') newPage.on('worker', onWorker);
      };
      if (typeof page.on === 'function') page.on('worker', onWorker);
      if (typeof context.on === 'function') {
        context.on('serviceworker', onServiceWorker);
        context.on('page', onPage);
        this._cleanup.push(() => { try { context.off('serviceworker', onServiceWorker); context.off('page', onPage); } catch { /* closed */ } });
      }
    }
    if (context && typeof context.newCDPSession === 'function') {
      await this._attachRedirectGuard(page, context);
      if (typeof context.on === 'function') {
        context.on('page', (newPage) => { this._attachRedirectGuard(newPage, context).catch(() => {}); });
      }
    }
    // Existing documents predate the init script and may hold sockets or workers.
    this.needsFreshDocument = !this._isTestDouble();
    this.installed = true;
    return this.report();
  }

  // Playwright routes only the first hop of a request: a redirect of an allowed read endpoint into
  // a placement endpoint is followed by the network stack unseen (reproduced on the stand). The
  // answers of the bet API origins are therefore inspected at the RESPONSE stage of a second CDP
  // client; a redirect is followed only when its target is itself a plain read.
  async _attachRedirectGuard(page, context) {
    if (this._cdp.has(page)) return;
    let session;
    try { session = await context.newCDPSession(page); } catch { return; }
    this._cdp.set(page, session);
    session.on('Fetch.requestPaused', async (event) => {
      try {
        const status = event.responseStatusCode;
        const location = (event.responseHeaders || []).find((h) => String(h.name).toLowerCase() === 'location')?.value;
        if (typeof status === 'number' && status >= 300 && status < 400 && location) {
          let target;
          try { target = new URL(location, event.request.url); } catch { target = null; }
          const original = String(event.request.method || 'GET').toUpperCase();
          const nextMethod = (status === 307 || status === 308) ? original : (original === 'HEAD' ? 'HEAD' : 'GET');
          const verdict = target ? classifyHttpRequest({ method: nextMethod, url: target, betApiOrigins: this.betApiOrigins,
            readOnlyPostPaths: this.readOnlyPostPaths, live: false }) : { kind: 'blocked', reason: 'redirect_target_unparseable' };
          if (verdict.kind !== 'read' && verdict.kind !== 'read_post') {
            this.stats.http_blocked += 1;
            this._violation('redirect_blocked', `${original} ${new URL(event.request.url).pathname} -> ${status} ${target ? target.pathname : '?'}`);
            this.onBlocked({ kind: 'redirect', path: target ? target.pathname : '?', host: target ? target.hostname : '?',
              reason: `redirect_to_${verdict.kind}:${verdict.reason || ''}`, money: verdict.money === true });
            if (this.isArmed() || this.mode === 'live') this.onAbortSignal('redirect_blocked');
            await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
            return;
          }
        }
        await session.send('Fetch.continueResponse', { requestId: event.requestId });
      } catch (error) {
        this._violation('redirect_guard_error', error && error.message);
        try { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch { /* gone */ }
      }
    });
    await session.send('Fetch.enable', {
      patterns: this.betApiOrigins.map((origin) => ({ urlPattern: `${origin}/*`, requestStage: 'Response' })),
    });
    this._cleanup.push(() => session.detach().catch(() => {}));
  }

  report() {
    return {
      version: TRANSPORT_GUARD_VERSION,
      mode: this.mode,
      installed: this.installed,
      capabilities: { ...this.capabilities },
      stats: { ...this.stats },
      violations: this.violations.length,
      needs_fresh_document: this.needsFreshDocument,
    };
  }

  // The page must be navigated after the guard is installed so that every socket and frame of the
  // document is created under the guard. Cheap and idempotent.
  async ensureFreshDocument() {
    if (!this.needsFreshDocument) return false;
    await this.page.goto('about:blank');
    this.needsFreshDocument = false;
    return true;
  }

  async _handleRoute(route) {
    let request;
    let url;
    let method;
    try {
      request = route.request();
      url = new URL(request.url());
      method = String(request.method()).toUpperCase();
    } catch {
      this.stats.http_blocked += 1;
      return route.abort();
    }
    // Registered at page and context level: the second sighting of the same request is a no-op.
    if (request && typeof request === 'object') {
      if (this._seen.has(request)) return route.fallback();
      this._seen.add(request);
    }
    try {
      const verdict = classifyHttpRequest({ method, url, betApiOrigins: this.betApiOrigins,
        readOnlyPostPaths: this.readOnlyPostPaths, live: this.mode === 'live' });
      if (verdict.kind === 'canary') {
        this._canary.http += 1;
        return route.abort();
      }
      if (verdict.kind === 'sw_canary') {
        // Only reached when a registration was NOT stopped before it asked for its script.
        this._canary.sw += 1;
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'canary' });
      }
      if (verdict.kind === 'read') {
        this.stats.http_read += 1;
        return route.fallback();
      }
      if (verdict.kind === 'read_post') {
        this.stats.http_read_post += 1;
        return route.fallback();
      }
      if (verdict.kind === 'submit_endpoint') {
        this.stats.http_submit_delegated += 1;
        if (typeof this.decideSubmit !== 'function') return this._block(route, url, 'make_bet_endpoint_without_decider', { signal: true });
        return await this.decideSubmit({ route, request, url, method, block: (reason, opts) => this._block(route, url, reason, opts) });
      }
      // blocked: while a submit is armed an unexpected mutation also aborts the attempt.
      const armed = this.isArmed();
      const reason = armed && !verdict.money ? 'unexpected_mutation_while_armed' : verdict.reason;
      return this._block(route, url, reason, { signal: armed || verdict.signal === true, money: verdict.money === true });
    } catch (error) {
      // Fail closed on any handler failure.
      this._violation('route_handler_error', error && error.message);
      return this._block(route, url, `guard_error:${String(error && error.message).slice(0, 60)}`, { signal: true });
    }
  }

  _block(route, url, reason, { signal = true, money = false } = {}) {
    this.stats.http_blocked += 1;
    this.onBlocked({ kind: 'http', path: url.pathname, host: url.hostname, reason, money });
    if (signal) this.onAbortSignal(reason);
    return route.abort();
  }

  _handleWebSocket(ws) {
    let url = '';
    try { url = ws.url(); } catch { /* keep empty */ }
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep empty */ }
    if (host === CANARY_HOST) {
      // Mocked completely: nothing leaves the process, the page just proves it was routed.
      this._canary.ws += 1;
      ws.send('canary-ok');
      return;
    }
    this.stats.ws_opened += 1;
    const server = ws.connectToServer();
    const observe = (direction, data, allowed) => {
      if (!this.onWsFrame) return;
      try { this.onWsFrame({ direction, host, path: new URL(url).pathname, data, allowed, at: Date.now() }); } catch { /* observer must not break the transport */ }
    };
    ws.onMessage((message) => {
      const verdict = classifyWsFrame(message, { extraEvents: this.wsExtraEvents });
      observe('client_to_server', message, verdict.ok);
      if (verdict.ok) {
        this.stats.ws_frames_allowed += 1;
        server.send(message);
        return;
      }
      this.stats.ws_frames_blocked += 1;
      this._violation('ws_frame_blocked', `${host}:${verdict.reason}`);
      this.onBlocked({ kind: 'ws', path: new URL(url).pathname, host, reason: verdict.reason, money: false });
      if (this.isArmed()) this.onAbortSignal(`ws:${verdict.reason}`);
    });
    server.onMessage((message) => { observe('server_to_client', message, true); ws.send(message); });
    ws.onClose((code, reason) => { try { server.close({ code, reason }); } catch { /* already closed */ } });
    server.onClose((code, reason) => { try { ws.close({ code, reason }); } catch { /* already closed */ } });
  }

  // Empirical proof, on the CURRENT document, that every layer is active. Uses reserved names, so
  // a failure cannot leak anything. Returns {ok, checks}.
  async verifyCoverage() {
    if (!this.installed) return { ok: false, checks: { installed: false } };
    if (this._isTestDouble()) {
      return { ok: true, test_double: true, checks: { http_route: this.capabilities.http_route } };
    }
    const checks = {
      http_route: this.capabilities.http_route,
      ws_route: this.capabilities.ws_route,
      init_script: this.capabilities.init_script || !this.blockWorkers,
      http_canary: false,
      ws_canary: false,
      worker_blocked: !this.blockWorkers,
      service_worker_blocked: false,
      redirect_guard: false,
      no_foreign_worker: true,
    };
    const beforeHttp = this._canary.http;
    const beforeWs = this._canary.ws;
    const beforeSw = this._canary.sw;
    let probe;
    try {
      probe = await this.page.evaluate(async ({ httpUrl, wsUrl }) => {
        const out = {};
        out.http_aborted = await fetch(httpUrl, { method: 'POST', body: '{}' }).then(() => false, () => true);
        out.ws_open = await new Promise((resolve) => {
          let settled = false;
          const done = (value) => { if (!settled) { settled = true; resolve(value); } };
          const timer = setTimeout(() => done(false), 3000);
          try {
            const socket = new WebSocket(wsUrl);
            socket.onmessage = (event) => { clearTimeout(timer); done(event.data === 'canary-ok'); try { socket.close(); } catch { /* closed */ } };
            socket.onerror = () => { clearTimeout(timer); done(false); };
          } catch { clearTimeout(timer); done(false); }
        });
        out.worker_blocked = (() => {
          try { new Worker(URL.createObjectURL(new Blob(['1']))); return false; } catch { return true; }
        })();
        out.shared_worker_blocked = (() => {
          if (typeof SharedWorker === 'undefined') return true;
          try { new SharedWorker(URL.createObjectURL(new Blob(['1']))); return false; } catch { return true; }
        })();
        out.sw_registrations = await (async () => {
          if (!('serviceWorker' in navigator)) return 0;
          try { await navigator.serviceWorker.register('/__onewin-guard-canary-sw.js'); } catch { /* refused: expected */ }
          try { return (await navigator.serviceWorker.getRegistrations()).length; } catch { return 0; }
        })();
        return out;
      }, { httpUrl: CANARY_HTTP_URL, wsUrl: CANARY_WS_URL });
    } catch (error) {
      return { ok: false, checks, error: String(error && error.message).slice(0, 200) };
    }
    checks.http_canary = probe.http_aborted === true && this._canary.http === beforeHttp + 1;
    checks.ws_canary = probe.ws_open === true && this._canary.ws === beforeWs + 1;
    if (this.blockWorkers) checks.worker_blocked = probe.worker_blocked === true && probe.shared_worker_blocked === true;
    // blocked = the registration never even asked for its script and nothing is registered
    checks.service_worker_blocked = this._canary.sw === beforeSw && probe.sw_registrations === 0;
    checks.redirect_guard = this._cdp.size > 0;
    const context = this.page.context();
    if (typeof context.serviceWorkers === 'function' && context.serviceWorkers().length > 0) checks.no_foreign_worker = false;
    if (typeof this.page.workers === 'function' && this.page.workers().length > 0) checks.no_foreign_worker = false;
    const ok = Object.values(checks).every((value) => value === true);
    return { ok, checks };
  }

  async dispose() {
    for (const cleanup of this._cleanup.splice(0)) {
      try { await cleanup(); } catch { /* closing */ }
    }
  }
}
