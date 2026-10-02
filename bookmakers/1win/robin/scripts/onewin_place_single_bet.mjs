import { chromium } from 'playwright';
import fs from 'fs';
import { spawn } from 'node:child_process';

const PROXY = 'socks5://127.0.0.1:10800';
const SESSION_FILE = '/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json';
const ARBS_URL = 'http://127.0.0.1:8899/api/arbs';
let cachedToken = null;

async function getAuthToken() {
  if (cachedToken) return cachedToken;
  try {
    const resp = await fetch('http://127.0.0.1:8899/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'owner123' })
    });
    const data = await resp.json();
    if (data.token) {
      cachedToken = data.token;
      return cachedToken;
    }
  } catch (e) {
    console.warn('Auto-login failed:', e);
  }
  return 'OTN8VpUOJE57zPib_AOF2Bj7PUxi-LlB';
}

export function parseAmount(text) {
  const value = Number(String(text).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

async function resolvePlan(arb) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('/srv/betting/robinarb/current/backend/.venv/bin/python',
      ['/srv/betting/robinarb/current/scripts/onewin_plan.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.stdout.on('data', x => output += x);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try { resolveResult(JSON.parse(output)); } catch { reject(new Error('NO_PLAN_OUTPUT')); }
    });
    child.stdin.end(JSON.stringify(arb));
  });
}

async function getCandidateArbs() {
  const token = await getAuthToken();
  const resp = await fetch(ARBS_URL, { headers: { Authorization: 'Bearer ' + token } });
  const data = await resp.json();
  return data.arbs || [];
}

async function clearSlip(page) {
  const slip = page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');
  const empty = slip.getByText('Select an outcome', { exact: false });
  if (await empty.isVisible()) return true;
  const trash = slip.getByRole('button').filter({ has: page.locator('[style*="trash.svg"]') });
  if (await trash.count() === 1 && await trash.isVisible()) {
    await trash.click({ timeout: 5000 });
  }
  try {
    await empty.waitFor({ state: 'visible', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('=== STARTING 1WIN SINGLE BET PLACEMENT ===');
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

  // Intercept all network traffic around bet placement
  const interceptedRequests = [];
  const interceptedResponses = [];

  page.on('request', req => {
    const url = req.url();
    if (req.method() === 'POST') {
      interceptedRequests.push({ url, method: req.method(), postData: req.postData() });
      if (/(?:place|bet|order|coupon|ticket|wager)/i.test(url)) {
        console.log('[TARGET-REQ]', req.method(), url, req.postData()?.slice(0, 150));
      }
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (res.request().method() === 'POST') {
      try {
        const text = await res.text();
        interceptedResponses.push({ url, status: res.status(), text: text.slice(0, 500) });
        if (/(?:place|bet|order|coupon|ticket|wager)/i.test(url)) {
          console.log('[TARGET-RESP]', res.status(), url, text.slice(0, 250));
        }
      } catch (e) {}
    }
  });

  console.log('Scanning for candidate fork with matching odds...');
  let targetArb = null;
  let targetPlan = null;

  for (let round = 1; round <= 15; round++) {
    console.log(`Scan round ${round}...`);
    const arbs = await getCandidateArbs();
    console.log(`Fetched ${arbs.length} candidate arbs.`);

    for (const arb of arbs) {
      if (!arb.bk2 || !arb.bk2.includes('1win')) continue;
      let plan;
      try {
        plan = await resolvePlan(arb);
      } catch {
        continue;
      }
      if (!plan || !plan.ok || !plan.quote?.verified) continue;
      if (plan.limits_allowed === false) {
        console.log(`[LIMITS] Skipping fork ${arb.match} -> ${plan.ui_selection_name}: ${plan.limits_reason}`);
        continue;
      }

      const feedOdds = Number(plan.quote.feed_odds);
      const currOdds = Number(plan.quote.current_odds);
      if (Math.abs(feedOdds - currOdds) < 0.001) {
        console.log(`Found matching fork: ${arb.match} | ${plan.selection.market_name} -> ${plan.ui_selection_name} | Feed: ${feedOdds} vs Curr: ${currOdds}`);
        targetArb = arb;
        targetPlan = plan;
        break;
      }
    }
    if (targetPlan) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!targetPlan) {
    console.error('No matching fork found.');
    await browser.close();
    process.exit(1);
  }

  const selection = targetPlan.selection;
  const expectedOdds = Number(targetPlan.quote.current_odds);
  console.log(`Navigating to event URL: ${selection.event_url}`);
  await page.goto(selection.event_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const slip = page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');
  await clearSlip(page);

  console.log(`Locating market: "${selection.market_name}", outcome: "${targetPlan.ui_selection_name}"...`);
  const title = page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
  const group = title.locator('xpath=ancestor::div[.//button[.//span[starts-with(@class,"_cf_")]]][1]');
  const button = group.getByRole('button').filter({ has: page.getByText(targetPlan.ui_selection_name, { exact: true }) });

  await button.waitFor({ state: 'visible', timeout: 10000 });
  const boardPriceText = await button.locator('span[class^="_cf_"]').innerText();
  const boardPrice = parseAmount(boardPriceText);
  console.log(`Board price on button: ${boardPrice}, expected: ${expectedOdds}`);

  if (Math.abs(boardPrice - expectedOdds) > 0.01) {
    console.error(`ODDS CHANGED ON BOARD: expected ${expectedOdds}, got ${boardPrice}. Skipping to protect accuracy!`);
    await page.screenshot({ path: '/tmp/odds_mismatch.png' });
    await browser.close();
    process.exit(2);
  }

  console.log('Odds match! Clicking outcome button to add to Betslip...');
  await button.click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  const expectedInSlip = `${selection.market_name}, ${targetPlan.ui_selection_name}`;
  console.log(`Checking slip contains "${expectedInSlip}"...`);
  await slip.getByText(expectedInSlip, { exact: true }).waitFor({ timeout: 6000 });

  // Readback odds in slip
  const slipOddsText = await slip.locator('span[class*="_cf_"], div[class*="badge"], div[class*="odd"]').filter({ hasText: /^\d+\.\d+$/ }).first().innerText().catch(() => '');
  const slipOdds = parseAmount(slipOddsText);
  console.log(`Odds in slip: ${slipOdds}`);
  if (slipOdds && Math.abs(slipOdds - expectedOdds) > 0.01) {
    console.error(`ODDS DRIFTED IN SLIP: expected ${expectedOdds}, got ${slipOdds}. Aborting!`);
    await clearSlip(page);
    await browser.close();
    process.exit(2);
  }

  // Enter amount
  const amountInput = slip.locator('input[data-qa="amount"]:visible');
  await amountInput.click();
  await amountInput.press('ControlOrMeta+A');
  await amountInput.press('Backspace');
  await amountInput.pressSequentially('1');
  await amountInput.press('Tab');
  await page.waitForTimeout(500);

  const finalAmount = parseAmount(await amountInput.inputValue());
  console.log(`Entered stake amount: ${finalAmount} USDT`);
  if (finalAmount !== 1) {
    throw new Error(`Amount readback error: ${finalAmount}`);
  }

  // Pre-bet screenshot
  await slip.screenshot({ path: '/tmp/before_bet_slip.png' });
  console.log('Saved /tmp/before_bet_slip.png');

  // Submit button
  const submitBtn = slip.getByRole('button', { name: /place a bet/i });
  if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
    throw new Error('Submit button not available');
  }

  console.log('>>> PLACING BET NOW (SUBMIT CLICK)... <<<');
  await submitBtn.click();

  // Wait 10 seconds for submission to complete and network responses to arrive
  console.log('Waiting for confirmation response...');
  await page.waitForTimeout(10000);

  await page.screenshot({ path: '/tmp/after_bet_full.png' });
  console.log('Saved /tmp/after_bet_full.png');

  // Check balance after bet
  const bodyText = await page.innerText('body');
  const balanceMatch = bodyText.match(/USDT\s*([\d.,]+)/);
  const balanceAfter = balanceMatch ? balanceMatch[1] : 'unknown';
  console.log(`Balance in header after bet: ${balanceAfter} USDT`);

  // Write placement log
  const resultData = {
    ok: true,
    match: targetArb.match,
    market: selection.market_name,
    selection: targetPlan.ui_selection_name,
    expected_odds: expectedOdds,
    board_price: boardPrice,
    slip_odds: slipOdds,
    stake: finalAmount,
    balance_after: balanceAfter,
    intercepted_requests: interceptedRequests,
    intercepted_responses: interceptedResponses
  };
  fs.writeFileSync('/tmp/bet_placement_result.json', JSON.stringify(resultData, null, 2));

  // Record bet in limits tracker
  try {
    const recordProc = spawn('/srv/betting/robinarb/current/backend/.venv/bin/python',
      ['/srv/betting/robinarb/current/scripts/onewin_record_bet.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    recordProc.stdin.end(JSON.stringify({
      arb: targetArb,
      selection: targetPlan.ui_selection_name,
      stake: finalAmount,
      odds: expectedOdds,
      market: selection.market_name,
      balance_after: balanceAfter
    }));
    console.log('[LIMITS] Bet recorded in limits history');
  } catch (e) {
    console.warn('[LIMITS] Failed to record bet in limits tracker:', e);
  }

  console.log('=== BET EXECUTION FINISHED ===');
  console.log(JSON.stringify(resultData, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
