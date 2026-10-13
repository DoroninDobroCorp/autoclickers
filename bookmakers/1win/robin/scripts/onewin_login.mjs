// Standard 1win login utility reading credentials and proxy from private config.
// Never logs sensitive payloads or tampers with CAPTCHA callbacks.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const DEFAULT_PROXY_CONFIG = '/home/ubuntu/.config/betting/onewin/account-site-proxy-20261012.json';
const DEFAULT_CREDENTIALS_CONFIG = '/home/ubuntu/.config/betting/onewin/account-credentials-20261012.json';
const DEFAULT_SESSION_FILE = '/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json';
const DEFAULT_CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

function loadPrivateJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  const proxyCfg = loadPrivateJson(process.env.ONEWIN_PROXY_CONFIG || DEFAULT_PROXY_CONFIG);
  const credsCfg = loadPrivateJson(process.env.ONEWIN_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_CONFIG);
  const proxyRaw = process.env.ONEWIN_PROXY || proxyCfg.proxy;
  const email = process.env.ONEWIN_LOGIN || credsCfg.email;
  const password = process.env.ONEWIN_PASSWORD || credsCfg.password;
  const sessionFile = process.env.ONEWIN_SESSION_STATE || DEFAULT_SESSION_FILE;

  if (!proxyRaw) throw new Error('ONEWIN_PROXY_REQUIRED');
  if (!email || !password) throw new Error('ONEWIN_CREDENTIALS_REQUIRED');

  const proxyUrl = new URL(proxyRaw);
  let proxy = { server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}` };
  if (proxyUrl.username) proxy.username = decodeURIComponent(proxyUrl.username);
  if (proxyUrl.password) proxy.password = decodeURIComponent(proxyUrl.password);

  let browser;
  let bridge;
  const bridgeSockets = new Set();

  async function closeResources() {
    if (browser) await browser.close().catch(() => {});
    for (const socket of bridgeSockets) socket.destroy();
    if (bridge?.listening) await new Promise(resolve => bridge.close(resolve));
  }

  process.on('SIGTERM', async () => { await closeResources(); process.exit(124); });
  process.on('SIGINT', async () => { await closeResources(); process.exit(130); });

  try {
    if (proxyUrl.protocol === 'socks5:') {
      const require = createRequire(import.meta.url);
      const { SocksClient } = require('socks');
      bridge = http.createServer((req, res) => res.writeHead(405).end());
      bridge.on('connection', socket => {
        bridgeSockets.add(socket);
        socket.on('close', () => bridgeSockets.delete(socket));
      });
      bridge.on('connect', async (req, client, head) => {
        try {
          const dest = new URL(`https://${req.url}`);
          const port = Number(dest.port || 443);
          if (![80, 443].includes(port)) throw new Error('PORT_REJECTED');
          const { socket } = await SocksClient.createConnection({
            command: 'connect',
            timeout: 15000,
            proxy: {
              host: proxyUrl.hostname,
              port: Number(proxyUrl.port),
              type: 5,
              userId: decodeURIComponent(proxyUrl.username),
              password: decodeURIComponent(proxyUrl.password),
            },
            destination: { host: dest.hostname, port },
          });
          bridgeSockets.add(socket);
          socket.on('close', () => bridgeSockets.delete(socket));
          socket.on('error', () => client.destroy());
          client.on('error', () => socket.destroy());
          client.on('close', () => socket.destroy());
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) socket.write(head);
          socket.pipe(client);
          client.pipe(socket);
        } catch {
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      });
      await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
      proxy = { server: `http://127.0.0.1:${bridge.address().port}` };
    }

    const headless = process.env.ONEWIN_HEADLESS !== 'false';
    const executablePath = process.env.ONEWIN_TEST_CHROMIUM || (fs.existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined);
    browser = await chromium.launch({
      headless,
      proxy,
      executablePath,
      args: ['--no-sandbox'],
    });

    const initialState = fs.existsSync(sessionFile)
      ? JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
      : { cookies: [{ name: 'project_locale', value: 'en-US', domain: '1win.pro', path: '/' }], origins: [] };
    for (const c of initialState.cookies || []) {
      if (c.name === 'project_locale') c.value = 'en-US';
    }

    const context = await browser.newContext({
      storageState: initialState,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    let captchaTriggered = false;
    page.on('request', req => {
      if (req.url().includes('gcaptcha4.geetest.com')) captchaTriggered = true;
    });

    await page.goto('https://1win.pro/betting', { timeout: 40000, waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="header-balance-sum"], [data-testid="header-auth-button"]').first().waitFor({ state: 'visible', timeout: 25000 });

    const balanceLocator = page.locator('[data-testid="header-balance-sum"]');
    if (await balanceLocator.isVisible()) {
      console.log(JSON.stringify({ ok: true, status: 'ALREADY_AUTHENTICATED' }));
      return;
    }

    await page.locator('[data-testid="header-auth-button"]').click({ timeout: 5000 });
    const emailTab = page.locator('[data-testid="signInByPhone-form-tab-email"], [data-testid="signInByEmail-form-tab-email"]').filter({ visible: true });
    if (await emailTab.count() > 0) {
      await emailTab.first().click({ timeout: 3000 });
    }
    await page.locator('[data-testid="signInByEmail-form-email"]').fill(email, { timeout: 5000 });
    await page.locator('[data-testid="signInByEmail-form-password"]').fill(password, { timeout: 5000 });
    await page.locator('[data-testid="signInByEmail-form-submit"]').click({ timeout: 5000 });

    await balanceLocator.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    if (!await balanceLocator.isVisible()) {
      console.log(JSON.stringify({
        ok: false,
        status: captchaTriggered ? 'INTERACTIVE_CAPTCHA_REQUIRED' : 'LOGIN_NOT_COMPLETED',
        captcha_triggered: captchaTriggered,
      }));
      process.exitCode = 2;
      return;
    }

    await context.storageState({ path: sessionFile });
    fs.chmodSync(sessionFile, 0o600);
    console.log(JSON.stringify({ ok: true, status: 'AUTHENTICATED_AND_SAVED' }));
  } finally {
    await closeResources();
  }
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, status: 'ERROR', error: err.message }));
  process.exit(1);
});
