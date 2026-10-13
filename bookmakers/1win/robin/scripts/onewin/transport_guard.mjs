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
//     service-worker registration, WebTransport, WebSocketStream, fetchLater, RTCDataChannel) in
//     every frame of a FRESH document and puts the same frame policy INSIDE the page in front of
//     Playwright's WebSocket mock (whose internals are reachable from page scripts);
//   * a response-stage CDP guard: a redirect is followed only if its target is itself a plain read;
//   * canaries against the real bet API origin and reserved names proving, on the document used for
//     the submit, that every one of those layers is really active.
// A layer that cannot be proven is a refusal, never a default permission. What cannot be mediated
// from inside the browser (browser-process prefetch GETs, a wire-level retry of the one exact POST)
// is listed in README.md as residual.
//
// Nothing here knows about value, accounts or credentials.

export const TRANSPORT_GUARD_VERSION = 'onewin-transport-guard.v2';

export const DEFAULT_BET_API_ORIGINS = Object.freeze(['https://api-gateway.top-parser.com']);

// First-party endpoints of the bet API origin that are POST by contract but only read. Observed in
// the 1win SPA during read-only account windows: coupon limit lookups (2026-10-12/13) and the match /
// highlight lists the event pages are built from (2026-10-13 discovery window: `matches/get-many`
// 9x and `highlights/get-many` 2x on /betting, answers are match lists). Every other POST of the
// client (monitoring/log-event, analytics, profile and bonus calls) is refused by default; it is
// recorded in the cart result so an operator can extend this list on evidence.
export const READ_ONLY_POST_PATHS = Object.freeze([
  '/bets/get-max-bet-amount',
  '/bets/get-auto-bet-amount-v2',
  '/matches/get-many',
  '/highlights/get-many',
]);

// Session bootstrap of the first-party client: the public token of the logged-in page is exchanged
// for the API session token (body {publicToken}, answer {sessionToken, userId}); every authenticated
// API call, the limit lookup and make-bet-v2 included, needs it. Found on the real site: with this
// POST refused the limit lookup answers `unauthenticated_error`. It is NOT a credential login: the
// body must be exactly {publicToken: <string>}; anything else (a password, an e-mail) is refused.
export const SESSION_BOOTSTRAP_POSTS = Object.freeze({
  '/auth/login': (body) => Boolean(body) && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && typeof body.publicToken === 'string'
    && body.publicToken.length > 0 && body.publicToken.length < 4096,
});

export const SUBMIT_PATH = '/bets/make-bet-v2';

// Paths that move money or change a bet. Refused for EVERY method: a GET is not read-only just
// because of its verb. A verb followed by anything ([\w-]*) is a placement path (cashout-v2, refund-all).
const MONEY_PATH = new RegExp([
  '\\/bets\\/(?:make-?bet|refund|cashout|sell|buyout|ordinary|express|place|create|submit|withdraw|settle|cancel|bet-?out)[\\w-]*',
  '\\/bets\\/api\\/v\\d+\\/user\\/bets',
  'place.?bet', 'bet.?place', 'create.?bet', 'bets?\\/create', 'bets?\\/submit', 'wager',
  'express-ordinary', '\\/ordinary(?:\\/|$)',
  '\\/fortune-wheel\\/make-roll', 'make-?roll',
].join('|'), 'i');

// A request to this path on any origin is a coverage canary: answered by the guard, never forwarded.
export const CANARY_PATH = '/__onewin-guard-canary';
const SW_CANARY_PATH = '/__onewin-guard-canary-sw.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override', 'x-original-url', 'x-rewrite-url'];

// Percent-encoding must not hide a placement path from the pattern ("make%2Dbet-v2"): the server
// decodes, so the guard matches the raw and the decoded (up to three layers) form.
function decodedForms(pathName) {
  const forms = [String(pathName || '')];
  let current = forms[0];
  for (let i = 0; i < 3; i += 1) {
    let next;
    try { next = decodeURIComponent(current); } catch { break; }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

export function isMoneyPath(pathName) {
  return decodedForms(pathName).some((form) => MONEY_PATH.test(form));
}

// Pure HTTP classification. `kind` is one of
//   read | read_post | submit_endpoint | canary | sw_canary | blocked
export function classifyHttpRequest({ method, url, betApiOrigins = DEFAULT_BET_API_ORIGINS, readOnlyPostPaths = READ_ONLY_POST_PATHS, live = false, postBody }) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url)); } catch { return { kind: 'blocked', reason: 'unparseable_url' }; }
  const verb = String(method || '').toUpperCase();
  const pathName = parsed.pathname;
  if (pathName === CANARY_PATH) return { kind: 'canary', reason: 'canary' };
  if (pathName === SW_CANARY_PATH) return { kind: 'sw_canary', reason: 'sw_canary' };
  const origins = new Set(betApiOrigins);
  const money = isMoneyPath(pathName);
  if (READ_METHODS.has(verb)) {
    // A placement path is refused whatever the verb (OPTIONS with a body included), but static assets
    // that merely contain such a word (an icon called wager.svg) are not API calls.
    const apiLike = origins.has(parsed.origin) || /^\/(?:bets?|fortune-wheel|coupon|payments?|api)\//i.test(pathName);
    if (apiLike && money) return { kind: 'blocked', reason: 'mutation_path_via_read_method', money: true, signal: false };
    return { kind: 'read' };
  }
  // the one exact placement request: live cart only, exact verb/origin/path, nothing "similar"
  if (live && verb === 'POST' && origins.has(parsed.origin) && pathName === SUBMIT_PATH) return { kind: 'submit_endpoint' };
  if (verb === 'POST' && origins.has(parsed.origin) && readOnlyPostPaths.includes(pathName)) return { kind: 'read_post' };
  if (verb === 'POST' && origins.has(parsed.origin) && Object.hasOwn(SESSION_BOOTSTRAP_POSTS, pathName)) {
    return SESSION_BOOTSTRAP_POSTS[pathName](postBody)
      ? { kind: 'read_post', session: true }
      : { kind: 'blocked', reason: 'session_bootstrap_unexpected_body', money: false };
  }
  if (money) return { kind: 'blocked', reason: /make-?bet/i.test(decodedForms(pathName).join(' ')) ? 'unknown_bet_endpoint' : 'forbidden_mutation_path', money: true };
  return { kind: 'blocked', reason: 'unknown_mutation_blocked', money: false };
}

// Pure classification of ONE client->server WebSocket frame. Only protocol control frames and
// subscription requests (the read channel of the odds feed) are allowed; everything else, binary
// frames and unparseable text included, is refused. The function is SELF-CONTAINED on purpose: its
// source is also installed inside the page (see HARDEN), so both enforcement points are one policy.
function wsFramePolicy(frame, extraEvents) {
  const CONTROL = ['2', '3', '5', '6', '2probe', '3probe'];
  const SUB_EVENT = /^(?:subscribe|unsubscribe)$/;
  const SUB_TYPE = /^(?:subscribe|unsubscribe)-[a-z0-9][a-z0-9-]*$/;
  if (typeof frame !== 'string') return { ok: false, reason: 'ws_binary_or_unknown_frame' };
  if (CONTROL.includes(frame)) return { ok: true, kind: 'engine_control' };
  const match = /^4([0-6])(.*)$/s.exec(frame);
  if (!match) return { ok: false, reason: 'ws_unrecognized_frame' };
  const packetType = match[1];
  const rest = match[2];
  if (packetType === '1') return rest === '' || /^\/[^,]*,?$/.test(rest) ? { ok: true, kind: 'sio_disconnect' } : { ok: false, reason: 'ws_malformed_disconnect' };
  if (packetType === '0') {
    // namespace and an optional auth object: 40, 40/ns, 40/ns,{...}, 40{...}
    const m = /^(?:\/[^,{]*,?)?(\{.*\})?$/s.exec(rest);
    if (!m) return { ok: false, reason: 'ws_malformed_connect' };
    if (m[1]) { try { JSON.parse(m[1]); } catch (e) { return { ok: false, reason: 'ws_malformed_connect_payload' }; } }
    return { ok: true, kind: 'sio_connect' };
  }
  if (packetType === '2') {
    const m = /^(?:\/[^,]*,)?(\d*)(\[.*\])$/s.exec(rest);
    if (!m) return { ok: false, reason: 'ws_malformed_event' };
    let parsed;
    try { parsed = JSON.parse(m[2]); } catch (e) { return { ok: false, reason: 'ws_malformed_event_json' }; }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2 || typeof parsed[0] !== 'string') return { ok: false, reason: 'ws_event_shape' };
    const name = parsed[0];
    const body = parsed[1];
    if (SUB_EVENT.test(name) && body && typeof body === 'object' && !Array.isArray(body)
      && typeof body.messageType === 'string' && SUB_TYPE.test(body.messageType)) {
      return { ok: true, kind: 'subscription', event: name, messageType: body.messageType };
    }
    if (Array.isArray(extraEvents) && extraEvents.includes(name)) return { ok: true, kind: 'extra_event', event: name };
    return { ok: false, reason: 'ws_event_not_allowed:' + String(name).slice(0, 40) };
  }
  if (packetType === '3') {
    // an acknowledgement answers a server event: scalars only, never an object that could carry an order
    const m = /^(?:\/[^,]*,)?\d+(\[.*\])$/s.exec(rest);
    if (!m) return { ok: false, reason: 'ws_malformed_ack' };
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch (e) { return { ok: false, reason: 'ws_malformed_ack' }; }
    const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
    return Array.isArray(parsed) && parsed.length <= 8 && parsed.every(scalar) ? { ok: true, kind: 'sio_ack' } : { ok: false, reason: 'ws_ack_not_scalar' };
  }
  return { ok: false, reason: 'ws_binary_or_connect_error_packet' };
}

export function classifyWsFrame(frame, { extraEvents = [] } = {}) {
  return wsFramePolicy(frame, extraEvents);
}

export const REPORT_BINDING = '__onewinGuardReport';

// Runs before any page script in every frame of a document created after the guard (and after
// Playwright's WebSocket mock, which it wraps).
function buildHardenScript({ blockWorkers, wsExtraEvents }) {
  return `(() => {
  const refuse = (name) => function () { throw new DOMException(name + ' is disabled by the transport guard', 'SecurityError'); };
  const define = (target, key, value) => { try { Object.defineProperty(target, key, { value, configurable: false, writable: false }); } catch (e) {} };
  const report = (payload) => { try { const f = globalThis[${JSON.stringify(REPORT_BINDING)}]; if (typeof f === 'function') f(JSON.stringify(payload)); } catch (e) {} };
  // transports that no route can mediate
  for (const name of ['WebSocketStream', 'WebTransport']) {
    if (typeof globalThis[name] !== 'undefined') define(globalThis, name, refuse(name));
  }
  if (typeof fetchLater !== 'undefined') define(globalThis, 'fetchLater', refuse('fetchLater'));
  try {
    if (typeof RTCPeerConnection !== 'undefined') define(RTCPeerConnection.prototype, 'createDataChannel', refuse('RTCDataChannel'));
  } catch (e) {}
  ${blockWorkers ? `
  if (typeof Worker !== 'undefined') define(globalThis, 'Worker', refuse('Worker'));
  if (typeof SharedWorker !== 'undefined') define(globalThis, 'SharedWorker', refuse('SharedWorker'));
  try {
    if (typeof ServiceWorkerContainer !== 'undefined') {
      define(ServiceWorkerContainer.prototype, 'register', function () {
        return Promise.reject(new DOMException('service worker registration is disabled by the transport guard', 'SecurityError'));
      });
    }
  } catch (e) {}` : ''}
  // The frame policy INSIDE the page. Playwright's routeWebSocket mock keeps its native socket in public
  // fields and exposes a dispatch function, so page code could talk past a Node-side filter; the page
  // only ever gets an object that holds the mock in a #private field.
  try {
    const Inner = globalThis.WebSocket;
    if (typeof Inner === 'function' && Inner.name !== 'GuardedWebSocket') {
      const policy = ${wsFramePolicy.toString()};
      const EXTRA = ${JSON.stringify(wsExtraEvents)};
      const EVENTS = ['open', 'message', 'error', 'close'];
      class GuardedWebSocket extends EventTarget {
        #i;
        constructor(url, protocols) {
          super();
          this.#i = protocols === undefined ? new Inner(url) : new Inner(url, protocols);
          for (const type of EVENTS) {
            this.#i.addEventListener(type, (e) => {
              let copy;
              if (type === 'message') copy = new MessageEvent('message', { data: e.data, origin: e.origin });
              else if (type === 'close') copy = new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean });
              else copy = new Event(type);
              this.dispatchEvent(copy);
            });
          }
          for (const type of EVENTS) {
            let handler = null;
            Object.defineProperty(this, 'on' + type, { configurable: false, get: () => handler,
              set: (fn) => { if (handler) this.removeEventListener(type, handler); handler = typeof fn === 'function' ? fn : null; if (handler) this.addEventListener(type, handler); } });
          }
        }
        get url() { return this.#i.url; }
        get readyState() { return this.#i.readyState; }
        get protocol() { return this.#i.protocol; }
        get extensions() { return this.#i.extensions; }
        get bufferedAmount() { return this.#i.bufferedAmount; }
        get binaryType() { return this.#i.binaryType; }
        set binaryType(value) { this.#i.binaryType = value; }
        send(data) {
          const verdict = policy(data, EXTRA);
          if (!verdict.ok) {
            // the same observable behaviour as the Node-side refusal: the frame is dropped, nothing is thrown
            report({ kind: 'ws_frame_blocked', reason: verdict.reason, url: String(this.#i.url) });
            return undefined;
          }
          return this.#i.send(data);
        }
        close(code, reason) { return this.#i.close(code, reason); }
      }
      GuardedWebSocket.CONNECTING = 0; GuardedWebSocket.OPEN = 1; GuardedWebSocket.CLOSING = 2; GuardedWebSocket.CLOSED = 3;
      define(globalThis, 'WebSocket', GuardedWebSocket);
    }
  } catch (e) {}
})();`;
}

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
      workers_seen: 0, service_workers_seen: 0, popups_closed: 0 };
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
    try {
      return await this._install();
    } catch (error) {
      // never leave half of the layers registered: a second attempt would stack handlers
      await this.dispose();
      this._handlers = [];
      throw error;
    }
  }

  async _install() {
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
    if (context && typeof context.addInitScript === 'function') {
      // reports of the in-page policy (dropped frames) come back through a binding
      if (typeof context.exposeFunction === 'function') {
        await context.exposeFunction(REPORT_BINDING, (raw) => this._onPageReport(raw));
      }
      // after routeWebSocket: the init script must wrap Playwright's mock, not the other way round
      await context.addInitScript(buildHardenScript({ blockWorkers: this.blockWorkers, wsExtraEvents: this.wsExtraEvents }));
      this.capabilities.init_script = true;
    }
    if (context) {
      // Anything that appears although it is blocked is a transport that bypasses the routes.
      const onWorker = (worker) => { this.stats.workers_seen += 1; this._violation('worker_created', worker && typeof worker.url === 'function' ? worker.url() : '?'); this.onAbortSignal('worker_created'); };
      const onServiceWorker = (worker) => { this.stats.service_workers_seen += 1; this._violation('service_worker_created', worker && typeof worker.url === 'function' ? worker.url() : '?'); this.onAbortSignal('service_worker_created'); };
      const onPage = (newPage) => {
        // A second window is never needed by a cart. Its redirect guard would attach asynchronously, so it
        // is closed at once instead of being trusted.
        this.stats.popups_closed += 1;
        this._violation('popup_closed', typeof newPage.url === 'function' ? newPage.url() : '?');
        if (typeof newPage.close === 'function') newPage.close().catch(() => {});
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
      if (typeof page.on === 'function') {
        // cross-site iframes live in their own process and have their own network session
        const onFrame = (frame) => { this._attachRedirectGuard(frame, context).catch(() => {}); };
        page.on('frameattached', onFrame);
        this._cleanup.push(() => { try { page.off('frameattached', onFrame); } catch { /* closed */ } });
      }
      if (typeof page.frames === 'function') {
        for (const frame of page.frames()) this._attachRedirectGuard(frame, context).catch(() => {});
      }
    }
    // Existing documents predate the init script and may hold sockets or workers.
    this.needsFreshDocument = !this._isTestDouble();
    this.installed = true;
    return this.report();
  }

  _onPageReport(raw) {
    let payload;
    try { payload = JSON.parse(String(raw)); } catch { return; }
    if (!payload || payload.kind !== 'ws_frame_blocked') return;
    this.stats.ws_frames_blocked += 1;
    this._violation('ws_frame_blocked', `page:${String(payload.reason).slice(0, 80)}`);
    let hostName = '?';
    let pathName = '?';
    try { const u = new URL(String(payload.url)); hostName = u.hostname; pathName = u.pathname; } catch { /* keep */ }
    this.onBlocked({ kind: 'ws', path: pathName, host: hostName, reason: String(payload.reason).slice(0, 80), money: false });
    if (this.isArmed()) this.onAbortSignal(`ws:${payload.reason}`);
  }

  // Playwright routes only the first hop of a request: a redirect of an allowed read endpoint into
  // a placement endpoint is followed by the network stack unseen (reproduced on the stand). The
  // answers to fetch/XHR/document requests are therefore inspected at the RESPONSE stage of a second
  // CDP client; a redirect is followed only when its target is itself a plain read.
  async _attachRedirectGuard(target, context) {
    if (this._cdp.has(target)) return;
    let session;
    try { session = await context.newCDPSession(target); } catch { return; }
    this._cdp.set(target, session);
    session.on('Fetch.requestPaused', async (event) => {
      try {
        const status = event.responseStatusCode;
        const location = (event.responseHeaders || []).find((h) => String(h.name).toLowerCase() === 'location')?.value;
        if (typeof status === 'number' && status >= 300 && status < 400 && location) {
          let next;
          try { next = new URL(location, event.request.url); } catch { next = null; }
          const original = String(event.request.method || 'GET').toUpperCase();
          const nextMethod = (status === 307 || status === 308) ? original : (original === 'HEAD' ? 'HEAD' : 'GET');
          const verdict = next ? classifyHttpRequest({ method: nextMethod, url: next, betApiOrigins: this.betApiOrigins,
            readOnlyPostPaths: this.readOnlyPostPaths, live: false }) : { kind: 'blocked', reason: 'redirect_target_unparseable' };
          if (verdict.kind !== 'read' && verdict.kind !== 'read_post') {
            this.stats.http_blocked += 1;
            this._violation('redirect_blocked', `${original} ${new URL(event.request.url).pathname} -> ${status} ${next ? next.pathname : '?'}`);
            this.onBlocked({ kind: 'redirect', path: next ? next.pathname : '?', host: next ? next.hostname : '?',
              reason: `redirect_to_${verdict.kind}:${verdict.reason || ''}`, money: verdict.money === true });
            if (this.isArmed() || this.mode === 'live') this.onAbortSignal('redirect_blocked');
            await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
            return;
          }
        }
        await session.send('Fetch.continueResponse', { requestId: event.requestId });
      } catch (error) {
        // A request that was cancelled by a navigation while it was paused is gone: nothing to decide.
        const message = String(error && error.message);
        if (!/Invalid InterceptionId|No such|Target closed|Session closed|detached/i.test(message)) {
          this._violation('redirect_guard_error', message);
          try { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch { /* gone */ }
        }
      }
    });
    await session.send('Fetch.enable', {
      patterns: ['XHR', 'Fetch', 'Document', 'Ping'].map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Response' })),
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
      // verb / path rewriting headers would let a harmless-looking request act as a placement
      if (typeof request.headers === 'function') {
        const headers = request.headers() || {};
        const override = OVERRIDE_HEADERS.find((name) => Object.hasOwn(headers, name));
        if (override) return this._block(route, url, `method_override_header:${override}`, { signal: this.isArmed() });
      }
      let postBody;
      if (method === 'POST' && Object.hasOwn(SESSION_BOOTSTRAP_POSTS, url.pathname)) {
        try { postBody = typeof request.postDataJSON === 'function' ? request.postDataJSON() : JSON.parse(request.postData() || 'null'); } catch { postBody = null; }
      }
      const verdict = classifyHttpRequest({ method, url, betApiOrigins: this.betApiOrigins,
        readOnlyPostPaths: this.readOnlyPostPaths, live: this.mode === 'live', postBody });
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
    let pathName = '';
    try { const u = new URL(url); host = u.hostname; pathName = u.pathname; } catch { /* keep empty */ }
    if (pathName === CANARY_PATH) {
      // Mocked completely: nothing leaves the process, the page just proves it was routed.
      this._canary.ws += 1;
      ws.send('canary-ok');
      return;
    }
    this.stats.ws_opened += 1;
    const server = ws.connectToServer();
    const observe = (direction, data, allowed) => {
      if (!this.onWsFrame) return;
      try { this.onWsFrame({ direction, host, path: pathName, data, allowed, at: Date.now() }); } catch { /* observer must not break the transport */ }
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
      this.onBlocked({ kind: 'ws', path: pathName, host, reason: verdict.reason, money: false });
      if (this.isArmed()) this.onAbortSignal(`ws:${verdict.reason}`);
    });
    server.onMessage((message) => { observe('server_to_client', message, true); ws.send(message); });
    ws.onClose((code, reason) => { try { server.close({ code, reason }); } catch { /* already closed */ } });
    server.onClose((code, reason) => { try { ws.close({ code, reason }); } catch { /* already closed */ } });
  }

  // Empirical proof, on the CURRENT document, that every layer is active. The HTTP and WebSocket
  // canaries go to the REAL bet API origin on a reserved path, so that a later handler written for
  // that host (a continue()/passthrough) cannot hide behind a synthetic name: if the guard did not
  // answer, the request would reach a path that does not exist. Returns {ok, checks}.
  async verifyCoverage() {
    if (!this.installed) return { ok: false, checks: { installed: false } };
    if (this._isTestDouble()) {
      return { ok: true, test_double: true, checks: { http_route: this.capabilities.http_route } };
    }
    const checks = {
      http_route: this.capabilities.http_route,
      ws_route: this.capabilities.ws_route,
      init_script: this.capabilities.init_script,
      http_canary: false,
      ws_canary: false,
      ws_policy_in_page: false,
      unmediated_transports_removed: false,
      worker_blocked: !this.blockWorkers,
      service_worker_blocked: false,
      redirect_guard: false,
      no_foreign_worker: true,
      no_other_site_pages: true,
    };
    const beforeHttp = this._canary.http;
    const beforeWs = this._canary.ws;
    const beforeSw = this._canary.sw;
    const origin = this.betApiOrigins[0];
    const httpUrl = `${origin}${CANARY_PATH}`;
    const wsUrl = `${origin.replace(/^http/, 'ws')}${CANARY_PATH}`;
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
        out.ws_policy_in_page = typeof WebSocket === 'function' && WebSocket.name === 'GuardedWebSocket';
        const refused = (fn) => { try { fn(); return false; } catch (e) { return /transport guard/.test(String(e && e.message)); } };
        out.unmediated_removed = (typeof WebSocketStream === 'undefined' || refused(() => new WebSocketStream('wss://x.invalid/')))
          && (typeof WebTransport === 'undefined' || refused(() => new WebTransport('https://x.invalid/')))
          && (typeof fetchLater === 'undefined' || refused(() => fetchLater('https://x.invalid/')));
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
      }, { httpUrl, wsUrl });
    } catch (error) {
      return { ok: false, checks, error: String(error && error.message).slice(0, 200) };
    }
    checks.http_canary = probe.http_aborted === true && this._canary.http === beforeHttp + 1;
    checks.ws_canary = probe.ws_open === true && this._canary.ws === beforeWs + 1;
    checks.ws_policy_in_page = probe.ws_policy_in_page === true;
    checks.unmediated_transports_removed = probe.unmediated_removed === true;
    if (this.blockWorkers) checks.worker_blocked = probe.worker_blocked === true && probe.shared_worker_blocked === true;
    // blocked = the registration never even asked for its script and nothing is registered
    checks.service_worker_blocked = this._canary.sw === beforeSw && probe.sw_registrations === 0;
    checks.redirect_guard = this._cdp.has(this.page);
    const context = this.page.context();
    if (typeof context.serviceWorkers === 'function' && context.serviceWorkers().length > 0) checks.no_foreign_worker = false;
    if (typeof this.page.workers === 'function' && this.page.workers().length > 0) checks.no_foreign_worker = false;
    // a worker that appeared at any time (even one that is gone now) means the removal failed once, and a
    // worker's sockets are the one transport the routes cannot see
    if (this.stats.workers_seen > 0 || this.stats.service_workers_seen > 0
      || this.violations.some((v) => v.kind === 'route_handler_error' || v.kind === 'redirect_guard_error')) {
      checks.no_foreign_worker = false;
    }
    // another open document of the bookmaker predates the guard and may hold sockets of its own
    if (typeof context.pages === 'function') {
      const siteHosts = new Set([...this.betApiOrigins.map((o) => new URL(o).hostname), '1win.pro']);
      for (const other of context.pages()) {
        if (other === this.page) continue;
        try {
          if (siteHosts.has(new URL(other.url()).hostname)) checks.no_other_site_pages = false;
        } catch { /* about:blank and friends */ }
      }
    }
    const ok = Object.values(checks).every((value) => value === true);
    return { ok, checks };
  }

  async dispose() {
    for (const cleanup of this._cleanup.splice(0)) {
      try { await cleanup(); } catch { /* closing */ }
    }
  }
}
