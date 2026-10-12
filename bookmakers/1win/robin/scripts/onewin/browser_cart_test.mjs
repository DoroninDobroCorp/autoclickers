import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { OneWinDryRunCart } from './browser_cart.mjs';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.ONEWIN_TEST_CHROMIUM || undefined,
  args: ['--no-sandbox'] });
const plan = { ok: true, selection: { event_id: '40021999',
  event_url: 'https://1win.pro/betting/match/sport/40021999', market_name: 'Total', price: 1.87 },
  ui_selection_name: 'Under 60.5' };
function group(label, price = '1.87', title = 'Total') {
  return `<div data-scope="ListGroup"><h2>${title}</h2><button onclick="pick()"><span class="_name_">${label}</span><span class="_cf_">${price}</span></button></div>`;
}
function html(groups) {
  return `<html><body>${groups}<aside><h2>Betslip</h2><div id="coupon">Select an outcome</div></aside>
  <script>window.selectionClicks=0; window.pick=()=>{window.selectionClicks++;
    document.querySelector('#coupon').innerHTML='<span>Total, Under 60.5</span><input data-qa="amount" value="10"><button onclick="clearCoupon()"><span style="--icon:trash.svg">delete</span></button>';
  }; window.clearCoupon=()=>{document.querySelector('#coupon').textContent='Select an outcome';};</script></body></html>`;
}
async function run(groups) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let intercepted = 0;
  await page.route('**/*', route => { intercepted++; return route.fulfill({ contentType: 'text/html', body: html(groups) }); });
  await page.goto(plan.selection.event_url);
  const result = await new OneWinDryRunCart(page).run(plan);
  const clicks = await page.evaluate(() => window.selectionClicks);
  assert.equal(intercepted, 1, 'the fixture must never request the bookmaker');
  assert.equal(result.external_placement, false);
  assert.equal(result.cart_cleared, true);
  assert.equal(result.blocked_submit_requests, 0);
  await context.close();
  return { result, clicks };
}
try {
  const unique = await run(group('Under 60.5') + group('Under 10.5'));
  assert.equal(unique.result.ok, true, 'a unique selection survives duplicate market titles');
  assert.equal(unique.result.amount, 1, 'masked stake editing must replace the initial ten');
  assert.equal(unique.clicks, 1);
  const duplicate = await run(group('Under 60.5') + group('Under 60.5'));
  assert.equal(duplicate.result.ok, false, 'two identical selections must remain ambiguous');
  assert.equal(duplicate.clicks, 0);
  const drift = await run(group('Under 60.5', '1.99'));
  assert.equal(drift.result.ok, false, 'changed source price must not prepare a stale plan');
  assert.equal(drift.clicks, 0);
  const navigation = await run(`<div><nav><span>Total</span></nav>${group('Under 60.5', '1.87', '1st half. Total')}</div>`);
  assert.equal(navigation.result.ok, false, 'a navigation tab must never authorize a different period market');
  assert.equal(navigation.clicks, 0);
  const context = await browser.newContext();
  const page = await context.newPage();
  let requestsReachingFixture = 0;
  await page.route('**/*', route => {
    requestsReachingFixture++;
    return route.fulfill({ contentType: 'text/html', body: html('') });
  });
  await page.goto(plan.selection.event_url);
  const guardedCart = new OneWinDryRunCart(page);
  await guardedCart.installGuard();
  await context.setOffline(true);
  for (const path of ['/bets/make-bet-v2', '/bets/refund']) {
    const status = await page.evaluate(async url => {
      try { await fetch(url, { method: 'POST', body: '{}' }); return 'sent'; }
      catch { return 'aborted'; }
    }, path);
    assert.equal(status, 'aborted', `the real mutation endpoint ${path} must be blocked`);
    assert.ok(guardedCart.blocked.includes(path), 'the cart guard itself must reject the mutation');
  }
  const lookupStatus = await page.evaluate(async () =>
    (await fetch('/bets/get-max-bet-amount', { method: 'POST', body: '{}' })).status);
  assert.equal(lookupStatus, 200, 'the read-only market limit lookup must remain available');
  assert.equal(requestsReachingFixture, 2, 'only navigation and the read-only lookup reach the fixture');
  assert.equal(guardedCart.blocked.length, 2);
  await context.close();
  console.log('5 browser cart regressions passed: unique title, duplicate outcome, changed price, navigation scope, mutation guard');
} finally { await browser.close(); }
