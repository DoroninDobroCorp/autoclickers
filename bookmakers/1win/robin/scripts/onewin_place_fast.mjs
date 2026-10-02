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
  return 'Pgt1xRxPZtp7XQMDRsXWFKEoSB52Ak_k';
}

export function parseAmount(text) {
  const value = Number(String(text).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

// Optimized Batch Resolver: Resolves ALL arbs in ONE WebSocket round
async function resolveBatchPlans(arbs) {
  const t0 = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn('/srv/betting/robinarb/current/backend/.venv/bin/python',
      ['/srv/betting/robinarb/current/scripts/onewin_plan_batch.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output);
        parsed.batch_spawn_ms = Date.now() - t0;
        resolveResult(parsed);
      } catch {
        reject(new Error('BATCH_RESOLVE_PARSE_ERROR'));
      }
    });
    child.stdin.end(JSON.stringify(arbs));
  });
}

async function clearSlip(page) {
  try {
    const aside = page.locator('aside').filter({ hasText: /betslip|купон/i });
    const slip = await aside.count() > 0 ? aside.first() : page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');

    const continueBtn = page.getByRole('button', { name: /continue|keep betting|продолжить|понятно|ок/i });
    if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
      await continueBtn.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }

    const empty = slip.getByText('Select an outcome', { exact: false });
    if (await empty.count() > 0 && await empty.first().isVisible()) return true;

    const trash = slip.getByRole('button').filter({ has: page.locator('[style*="trash.svg"]') });
    if (await trash.count() > 0 && await trash.first().isVisible()) {
      await trash.first().click({ timeout: 3000 }).catch(() => {});
    }

    try {
      await empty.first().waitFor({ state: 'visible', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function recordBetInTracker(arb, selectionName, stake, odds, market, balanceAfter) {
  return new Promise(resolve => {
    try {
      const recordProc = spawn('/srv/betting/robinarb/current/backend/.venv/bin/python',
        ['/srv/betting/robinarb/current/scripts/onewin_record_bet.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      recordProc.stdout.on('data', d => out += d);
      recordProc.on('close', () => {
        try {
          const res = JSON.parse(out);
          console.log('[LIMITS] Bet recorded in limits history:', res);
          resolve(res);
        } catch {
          resolve(null);
        }
      });
      recordProc.stdin.end(JSON.stringify({
        arb,
        selection: selectionName,
        stake,
        odds,
        market,
        balance_after: balanceAfter
      }));
    } catch (e) {
      console.warn('[LIMITS] Failed to record bet:', e);
      resolve(null);
    }
  });
}

async function main() {
  console.log('=== FAST 1WIN BET PLACEMENT VERIFICATION (1 BET) ===\n');
  const overallStart = Date.now();

  // Phase 1: Scan & Batch Resolution
  const scanStart = Date.now();
  const token = await getAuthToken();
  const resp = await fetch(ARBS_URL, { headers: { Authorization: 'Bearer ' + token } });
  const arbsData = await resp.json();
  const allArbs = arbsData.arbs || [];
  const onewinArbs = allArbs.filter(a => (a.bk2 || '').includes('1win'));
  console.log(`[SCAN] Fetched ${allArbs.length} total forks, ${onewinArbs.length} with 1win leg.`);

  console.log(`[SCAN] Running Batch WebSocket Resolution for ${onewinArbs.length} 1win arbs in single round...`);
  const batchResult = await resolveBatchPlans(onewinArbs);
  const scanDurationMs = Date.now() - scanStart;

  console.log(`[SCAN COMPLETE] Batch resolved in ${scanDurationMs} ms (Python+WS: ${batchResult.total_ms} ms, Prefetch: ${batchResult.prefetch_ms} ms)`);
  console.log(`[SCAN COMPLETE] Verified candidates returned: ${batchResult.candidates_count}`);

  // Find all candidate forks with exact matching odds and allowed limits
  const matchingCandidates = [];
  for (const plan of batchResult.plans || []) {
    if (plan.limits_allowed === false) {
      continue;
    }
    const feedOdds = Number(plan.quote?.feed_odds);
    const currOdds = Number(plan.quote?.current_odds);
    if (Math.abs(feedOdds - currOdds) < 0.001) {
      matchingCandidates.push(plan);
    }
  }

  console.log(`[CANDIDATES] Found ${matchingCandidates.length} candidate forks with exact matching odds.`);
  if (matchingCandidates.length === 0) {
    console.error('No candidate fork with exact matching odds and allowed limits found.');
    process.exit(1);
  }

  // Phase 2: Browser Setup
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

  let targetPlan = null;
  let button = null;
  let boardPrice = null;
  let navDurationMs = 0;
  let locateDurationMs = 0;

  // Try candidates until one renders cleanly and button is found
  for (const plan of matchingCandidates) {
    console.log(`\n>>> TESTING CANDIDATE: ${plan.match} (${plan.sport}) <<<`);
    console.log(`Market: ${plan.selection.market_name} -> ${plan.ui_selection_name} | Odds: ${plan.quote.current_odds}`);

    const navStart = Date.now();
    try {
      await page.goto(plan.selection.event_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('button:has(span[class^="_cf_"])', { timeout: 15000 });
      navDurationMs = Date.now() - navStart;
      console.log(`[NAV] Page loaded and odds buttons rendered in ${navDurationMs} ms`);
    } catch (e) {
      console.warn(`[NAV] Page render failed or timed out for ${plan.match}: ${e.message}. Trying next candidate...`);
      continue;
    }

    // Locate market outcome
    const locateStart = Date.now();
    const title = page.getByText(plan.selection.market_name, { exact: true }).filter({ visible: true });
    let group = null;
    if (await title.count() > 0) {
      group = title.first().locator('xpath=ancestor::div[.//button[.//span[starts-with(@class,"_cf_")]]][1]');
    }

    const scope = (group && await group.count() > 0) ? group : page;
    const allButtons = scope.getByRole('button').filter({ has: page.locator('span[class*="_cf_"]') });
    const totalButtons = await allButtons.count();

    const expectedOdds = Number(plan.quote.current_odds);
    let foundBtn = null;
    let foundPrice = null;

    // Strategy A: Outcome name + matching odds
    for (let i = 0; i < totalButtons; i++) {
      const btn = allButtons.nth(i);
      const text = await btn.innerText().catch(() => '');
      const cfText = await btn.locator('span[class*="_cf_"]').innerText().catch(() => '');
      const cf = parseAmount(cfText);
      if (text.includes(plan.ui_selection_name) && cf && Math.abs(cf - expectedOdds) <= 0.015) {
        foundBtn = btn;
        foundPrice = cf;
        console.log(`[LOCATE] Found outcome button: "${text.replace(/\n/g, ' ')}" -> price ${foundPrice}`);
        break;
      }
    }

    // Strategy B: Market group matching odds
    if (!foundBtn && group && await group.count() > 0) {
      for (let i = 0; i < totalButtons; i++) {
        const btn = allButtons.nth(i);
        const text = await btn.innerText().catch(() => '');
        const cfText = await btn.locator('span[class*="_cf_"]').innerText().catch(() => '');
        const cf = parseAmount(cfText);
        if (cf && Math.abs(cf - expectedOdds) <= 0.015) {
          foundBtn = btn;
          foundPrice = cf;
          console.log(`[LOCATE] Found via group price match: "${text.replace(/\n/g, ' ')}" -> price ${foundPrice}`);
          break;
        }
      }
    }

    if (foundBtn) {
      targetPlan = plan;
      button = foundBtn;
      boardPrice = foundPrice;
      locateDurationMs = Date.now() - locateStart;
      break;
    } else {
      console.warn(`[LOCATE] Outcome button not found on page for ${plan.match}. Trying next candidate...`);
    }
  }

  if (!targetPlan || !button) {
    console.error('Could not locate any candidate outcome on 1win.');
    await browser.close();
    process.exit(1);
  }

  const selection = targetPlan.selection;
  const expectedOdds = Number(targetPlan.quote.current_odds);

  // Phase 3: Betslip Preparation
  const slip = page.locator('aside').filter({ hasText: /betslip|купон/i }).first();
  await clearSlip(page);

  // Phase 5: Fast Click & Slip Check (optimized: no 30s timeout!)
  const clickStart = Date.now();
  await button.click({ timeout: 5000 });
  await page.waitForTimeout(800);

  try {
    await slip.getByText(targetPlan.ui_selection_name, { exact: false }).first().waitFor({ timeout: 2000 });
  } catch {
    console.log('[SLIP] Proceeding with slip check');
  }

  const slipOddsText = await slip.locator('span[class*="_cf_"], div[class*="badge"], div[class*="odd"]')
    .filter({ hasText: /^\d+\.\d+$/ }).first().innerText({ timeout: 1000 }).catch(() => '');
  const slipOdds = parseAmount(slipOddsText);
  console.log(`[SLIP] Slip odds: ${slipOdds || 'verified on board'}`);
  const clickDurationMs = Date.now() - clickStart;

  // Phase 6: Fast Enter Stake (1 USDT)
  const inputStart = Date.now();
  const amountInput = slip.locator('input[data-qa="amount"]:visible').first();
  await amountInput.click();
  await amountInput.press('ControlOrMeta+A');
  await amountInput.press('Backspace');
  await amountInput.pressSequentially('1');
  await amountInput.press('Tab');
  await page.waitForTimeout(300);

  const enteredAmount = parseAmount(await amountInput.inputValue());
  console.log(`[INPUT] Entered stake: ${enteredAmount} USDT`);
  if (enteredAmount !== 1) {
    throw new Error(`Amount entry error: ${enteredAmount}`);
  }
  const inputDurationMs = Date.now() - inputStart;

  // Phase 7: Submit & Fast API Intercept
  const submitStart = Date.now();
  const submitBtn = slip.getByRole('button', { name: /place a bet|сделать ставку/i });

  console.log('>>> [SUBMIT] Placing bet now... <<<');
  const responsePromise = page.waitForResponse(
    res => res.url().includes('make-bet-v2') && res.request().method() === 'POST',
    { timeout: 15000 }
  ).then(async res => {
    try {
      return { status: res.status(), body: await res.json() };
    } catch {
      return { status: res.status(), text: await res.text().catch(() => '') };
    }
  }).catch(err => {
    console.warn('[SUBMIT] Response wait timeout:', err.message);
    return null;
  });

  await submitBtn.click();
  const apiPlacementResponse = await responsePromise;
  const submitDurationMs = Date.now() - submitStart;
  console.log(`[SUBMIT] make-bet-v2 responded in ${submitDurationMs} ms:`, JSON.stringify(apiPlacementResponse));

  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/bet_fast_verification.png' });

  // Read balance
  const headerText = await page.locator('header').innerText().catch(() => '');
  const balanceMatch = headerText.match(/USDT\s*[|\n\r\t\s]*([\d]+[.,][\d]{2})/i)
    || (await page.innerText('body')).match(/USDT\s*[|\n\r\t\s]*([\d]+[.,][\d]{2})/i);
  const balanceAfter = balanceMatch ? balanceMatch[1] : 'unknown';
  console.log(`[BALANCE] Balance after bet: ${balanceAfter} USDT`);

  // Verify success
  let betSuccess = false;
  let confirmedBetId = null;
  let confirmedCf = expectedOdds;

  if (apiPlacementResponse && apiPlacementResponse.body?.result?.success) {
    betSuccess = true;
    confirmedBetId = apiPlacementResponse.body.result.success.betId;
    confirmedCf = apiPlacementResponse.body.result.success.cf;
  }

  const totalCycleMs = Date.now() - overallStart;

  if (betSuccess) {
    console.log(`\n==============================================`);
    console.log(`>>> VERIFICATION BET PLACED SUCCESSFULLY! <<<`);
    console.log(`Match: ${targetPlan.match}`);
    console.log(`Bet ID: ${confirmedBetId}`);
    console.log(`Odds: ${confirmedCf}`);
    console.log(`Stake: 1.0 USDT`);
    console.log(`Balance after: ${balanceAfter} USDT`);
    console.log(`Total cycle time: ${totalCycleMs} ms (${(totalCycleMs / 1000).toFixed(1)}s)`);
    console.log(`==============================================`);
    console.log(`\nTIMINGS BREAKDOWN:`);
    console.log(`- Batch Scanner Resolution: ${scanDurationMs} ms (WS prefetch: ${batchResult.prefetch_ms} ms)`);
    console.log(`- SPA Navigation & Render: ${navDurationMs} ms`);
    console.log(`- Market Outcome Locate: ${locateDurationMs} ms`);
    console.log(`- Outcome Click & Slip: ${clickDurationMs} ms (was ~31,700 ms before fix!)`);
    console.log(`- Stake Input: ${inputDurationMs} ms`);
    console.log(`- 1win API Placement (make-bet-v2): ${submitDurationMs} ms`);

    // Record in limits tracker
    await recordBetInTracker(targetPlan.arb || {}, targetPlan.ui_selection_name, 1.0, confirmedCf, selection.market_name, balanceAfter);

    fs.writeFileSync('/tmp/fast_verification_result.json', JSON.stringify({
      ok: true,
      match: targetPlan.match,
      bet_id: confirmedBetId,
      odds: confirmedCf,
      balance_after: balanceAfter,
      timings: {
        scan_ms: scanDurationMs,
        nav_ms: navDurationMs,
        locate_ms: locateDurationMs,
        click_ms: clickDurationMs,
        input_ms: inputDurationMs,
        submit_api_ms: submitDurationMs,
        total_ms: totalCycleMs
      }
    }, null, 2));

  } else {
    console.error('Bet submission was not confirmed by make-bet-v2 API!');
    process.exit(1);
  }

  await browser.close();
}

main().catch(err => {
  console.error('Fast placement fatal error:', err);
  process.exit(1);
});
