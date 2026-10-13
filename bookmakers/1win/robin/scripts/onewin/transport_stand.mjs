// Local first-party stand for transport-guard tests: a real HTTP server plus a real WebSocket server
// on loopback, reached by a REAL Chromium through --host-resolver-rules so that the code under test
// sees the production host names. It never touches an external bookmaker, account or proxy.
//
// Everything here is a TEST ENDPOINT: "money" accepted by it is a counter in this process.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const BET_HOST = 'api-gateway.top-parser.com';
export const SITE_HOST = '1win.pro';

export function loadWs() {
  for (const spec of ['ws', '/srv/betting/automation/node_modules/ws', '/srv/betting/robinarb/current/node_modules/ws']) {
    try { return require(spec); } catch { /* next */ }
  }
  throw new Error('ws module not available');
}

export async function loadChromium() {
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/srv/betting/automation/node_modules/playwright/index.mjs'].filter(Boolean)) {
    try {
      const mod = await import(spec);
      return mod.chromium || mod.default?.chromium || null;
    } catch { /* next */ }
  }
  return null;
}

export function chromiumPath() {
  return process.env.PLAYWRIGHT_CHROMIUM_PATH
    || ['/home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'].find((p) => fs.existsSync(p))
    || undefined;
}

// The DOM contract the carts rely on (market groups, outcome buttons, betslip aside, masked amount
// input, trash button, "Place a bet"). The submit handler posts a make-bet-v2 body to the bet API
// origin of the stand. Used for end-to-end runs of the real carts in a real Chromium.
export function eventPageHtml({ betOrigin, eventId = '40021999', marketId = '6271', oddId = '10:193671744120169820:0',
  marketTitle = 'Total', outcomeName = 'Under 60.5', price = '1.87', extraGroups = '', extraScript = '' } = {}) {
  return `<html><head><title>stand event</title></head><body>
<div data-scope="ListGroup"><h2>${marketTitle}</h2>
  <button id="pick" data-odd="${oddId}" data-market="${marketId}" data-event="${eventId}"><span class="_name_">${outcomeName}</span><span class="_cf_">${price}</span></button></div>
${extraGroups}
<aside><h2>Betslip</h2><div id="coupon">Select an outcome</div></aside>
<script>
window.selectionClicks = 0; window.placeClicks = 0; window.lastBetResponse = null;
document.getElementById('pick').addEventListener('click', () => {
  window.selectionClicks++;
  document.querySelector('#coupon').innerHTML = '<span>${marketTitle}, ${outcomeName}</span>'
    + '<input data-qa="amount" value="10">'
    + '<button id="trash" onclick="clearCoupon()"><span style="--icon:trash.svg">delete</span></button>'
    + '<button id="place">Place a bet</button>';
  document.getElementById('place').addEventListener('click', async () => {
    window.placeClicks++;
    const amount = Number(document.querySelector('input[data-qa="amount"]').value.replace(/[^0-9.]/g, ''));
    // the request the first-party client builds (betting bundle, 2026-10-13): idempotencyKey is its own
    // random UUID, selections carry oddId/cf/matchId only, no marketId
    const body = { currencyCode: 'USDT', idempotencyKey: crypto.randomUUID(), amount,
      meta: { autoBetAmount: undefined, isDirtyAmountField: true, sharedBetCode: undefined },
      coupon: { amount, selections: [{ oddId: '${oddId}', cf: ${price}, matchId: '${eventId}' }] },
      wallet: { type: 'real' } };
    try {
      const r = await fetch('${betOrigin}/bets/make-bet-v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      window.lastBetResponse = { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { window.lastBetResponse = { error: String(e) }; }
  });
});
window.clearCoupon = () => { document.querySelector('#coupon').textContent = 'Select an outcome'; };
${extraScript}
</script></body></html>`;
}

const SNAPSHOT = { messageType: 'match-odds-snapshot', data: { matchId: '40021999', groups: [{ id: 6271, name: 'Total' }] } };

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onewin-stand-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', `/CN=${SITE_HOST}`, '-addext', `subjectAltName=DNS:${SITE_HOST},DNS:${BET_HOST}`], { stdio: 'ignore' });
  const material = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return material;
}

export async function startStand({ tls = false } = {}) {
  const { WebSocketServer } = loadWs();
  const log = {
    http: [],        // every request the server saw: {method, path, host, origin, body}
    ws: [],          // {path, data, socket}
    wsConnections: 0,
    money: [],       // accepted "bets" (the only thing a guard must never allow in a read-only run)
  };
  let betSeq = 0;
  // test hook: (body) => JSON-able answer of make-bet-v2; null = the default accepted answer
  const hooks = { makeBetAnswer: null };
  const isMoneyPath = (p) => /\/bets\/(?:make-bet|refund|cashout|sell)|\/fortune-wheel\/make-roll|\/bets\/api\/v1\/user\/bets\/ordinary/i.test(p);

  const pages = new Map();
  pages.set('/', '<html><head><title>stand</title></head><body>stand</body></html>');
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('access-control-allow-origin', req.headers.origin || '*');
      res.setHeader('access-control-allow-headers', 'content-type,authorization');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/sw.js') {
        res.setHeader('content-type', 'application/javascript');
        res.setHeader('service-worker-allowed', '/');
        res.end(`self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',async e=>{const m=e.data||{};
  try{ if(m.kind==='post'){ const r=await fetch(m.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m.body||{})}); e.source.postMessage({ok:true,status:r.status}); }
       if(m.kind==='ws'){ const s=new WebSocket(m.url); s.onopen=()=>{s.send(m.frame);e.source.postMessage({ok:true,ws:'sent'});}; s.onerror=()=>e.source.postMessage({ok:false,ws:'error'}); }
  }catch(err){ e.source.postMessage({ok:false,error:String(err)}); }
});`);
        return;
      }
      if (url.pathname === '/worker.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(`self.onmessage=async e=>{const m=e.data||{};
  try{ if(m.kind==='post'){ const r=await fetch(m.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m.body||{})}); self.postMessage({ok:true,status:r.status}); }
       if(m.kind==='ws'){ const s=new WebSocket(m.url); s.onopen=()=>{s.send(m.frame);self.postMessage({ok:true,ws:'sent'});}; s.onerror=()=>self.postMessage({ok:false,ws:'error'}); }
  }catch(err){ self.postMessage({ok:false,error:String(err)}); }};`);
        return;
      }
      if (pages.has(url.pathname) || /^\/betting\/match\/sport\/\d+$/.test(url.pathname)) {
        res.setHeader('content-type', 'text/html');
        const page = pages.get(url.pathname) || pages.get('/betting/match/*') || pages.get('/');
        res.end(typeof page === 'function' ? page(url) : page);
        return;
      }
      if (url.searchParams.get('redirect') === '1') {
        log.http.push({ method: req.method, path: url.pathname, host: req.headers.host, origin: req.headers.origin || null, body: null, redirected: true });
        res.statusCode = 307;
        res.setHeader('location', '/bets/make-bet-v2');
        res.end();
        return;
      }
      let body = null;
      try { body = data ? JSON.parse(data) : null; } catch { body = data; }
      const entry = { method: req.method, path: url.pathname, host: req.headers.host, origin: req.headers.origin || null, body };
      log.http.push(entry);
      res.setHeader('content-type', 'application/json');
      if (isMoneyPath(url.pathname) && req.method !== 'GET') {
        betSeq += 1;
        log.money.push({ via: 'http', ...entry, id: betSeq });
        if (hooks.makeBetAnswer) { res.end(JSON.stringify(hooks.makeBetAnswer(body, betSeq))); return; }
        res.end(JSON.stringify({ result: { success: { betId: `STAND-${betSeq}`, cf: body?.coupon?.selections?.[0]?.cf ?? 1.87,
          amount: body?.amount ?? 1, currencyCode: body?.currencyCode ?? 'USDT' } } }));
        return;
      }
      if (url.pathname === '/bets/get-max-bet-amount') { res.end(JSON.stringify({ maxBetAmount: 8.45 })); return; }
      if (url.pathname === '/bets/get-base-settings') { res.end(JSON.stringify({ minBetAmount: 0.1, amountStep: 1 })); return; }
      res.end(JSON.stringify({ ok: true }));
    });
  };
  const server = tls ? https.createServer(selfSignedCert(), handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const pathName = new URL(req.url, 'http://x').pathname;
      log.wsConnections += 1;
      const id = log.wsConnections;
      ws.send('0{"sid":"stand","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
      ws.on('message', (raw) => {
        const data = raw.toString();
        log.ws.push({ path: pathName, data, socket: id });
        if (data === '40') ws.send('40{"sid":"stand-sio"}');
        else if (data.startsWith('42')) {
          let parsed = null;
          try { parsed = JSON.parse(data.slice(2)); } catch { /* not json */ }
          const messageType = parsed?.[1]?.messageType;
          if (typeof messageType === 'string' && /^subscribe-/.test(messageType)) {
            ws.send('42' + JSON.stringify(['message', SNAPSHOT]));
          } else {
            betSeq += 1;
            log.money.push({ via: 'ws', path: pathName, frame: data, id: betSeq });
            ws.send('42' + JSON.stringify(['message', { messageType: 'bet-accepted', betId: `STAND-${betSeq}` }]));
          }
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, log, pages, hooks,
    tls,
    siteOrigin: `${tls ? 'https' : 'http'}://${SITE_HOST}:${port}`,
    betOrigin: `${tls ? 'https' : 'http'}://${BET_HOST}:${port}`,
    wsBase: `${tls ? 'wss' : 'ws'}://${BET_HOST}:${port}`,
    reset() { log.http.length = 0; log.ws.length = 0; log.money.length = 0; },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Chromium that resolves the production host names to the stand. extraArgs are appended.
export async function launchStandBrowser(stand, { extraArgs = [], contextOptions = {} } = {}) {
  const chromium = await loadChromium();
  if (!chromium) return null;
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath(), args: [
    '--no-sandbox',
    `--host-resolver-rules=MAP ${BET_HOST} 127.0.0.1,MAP ${SITE_HOST} 127.0.0.1`,
    '--proxy-bypass-list=<-loopback>',
    `--unsafely-treat-insecure-origin-as-secure=${stand.siteOrigin}`,
    ...(stand.tls ? ['--ignore-certificate-errors'] : []),
    ...extraArgs,
  ] });
  const context = await browser.newContext(contextOptions);
  return { browser, context };
}
