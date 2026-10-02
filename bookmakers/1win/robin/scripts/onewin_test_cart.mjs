import { chromium } from 'playwright';
import fs from 'fs';
import { OneWinDryRunCart } from './onewin/browser_cart.mjs';

const PROXY = 'socks5://127.0.0.1:10800';
const SESSION_FILE = '/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json';

const plan = {
  ok: true,
  selection: {
    event_id: '39363494',
    event_url: 'https://1win.pro/betting/match/sport/39363494',
    market_id: '6379',
    market_name: 'Total',
    selection_id: '10:37870240019970360:1',
    selection_name: 'Under (3,5)',
    raw_selection: 'Under (3,5)',
    outcome: 'under',
    price: 1.59,
    points: 3.5,
    source: 'onewin-public-ws'
  },
  quote: {
    verified: true,
    status: 'OK',
    current_odds: 1.59,
    feed_odds: 1.59,
    selection: 'Under (3,5)',
    raw_selection: 'Under (3,5)',
    event_id: '39363494',
    source: 'onewin-public-ws',
    elapsed_ms: 715.1,
    detail: '1win public feed verified Total / Under 3.5',
    odds_group_id: '6379',
    odds_group_name: 'Total',
    selection_id: '10:37870240019970360:1',
    outcome: 'under',
    points: 3.5,
    context_inferred: false,
    snapshot_ts: 1788547151493
  },
  ui_selection_name: 'Under 3.5'
};

async function main() {
  const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  for (const c of storageState.cookies) {
    if (c.name === 'project_locale') c.value = 'en-US';
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    storageState,
    proxy: { server: PROXY },
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  const cart = new OneWinDryRunCart(page);

  console.log('Running dry-run cart test on plan...');
  const result = await cart.run(plan, { screenshot: '/tmp/cart_slip.png' });
  console.log('Cart result:', JSON.stringify(result, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
