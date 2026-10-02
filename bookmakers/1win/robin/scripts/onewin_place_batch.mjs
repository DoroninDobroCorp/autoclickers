import { chromium } from 'playwright';
import fs from 'fs';
import { spawn } from 'node:child_process';

const PROXY = 'socks5://127.0.0.1:10800';
const SESSION_FILE = '/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json';
const ARBS_URL = 'http://127.0.0.1:8899/api/arbs';
const TARGET_BETS_COUNT = 4;
const REPORT_FILE = '/tmp/onewin_batch_report.json';

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
  try {
    const aside = page.locator('aside').filter({ hasText: /betslip|купон/i });
    const slip = await aside.count() > 0 ? aside.first() : page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');

    const continueBtn = page.getByRole('button', { name: /continue|keep betting|продолжить|понятно|ок/i });
    if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
      await continueBtn.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    const empty = slip.getByText('Select an outcome', { exact: false });
    if (await empty.count() > 0 && await empty.first().isVisible()) return true;

    const trash = slip.getByRole('button').filter({ has: page.locator('[style*="trash.svg"]') });
    if (await trash.count() > 0 && await trash.first().isVisible()) {
      await trash.first().click({ timeout: 5000 }).catch(() => {});
    }

    try {
      await empty.first().waitFor({ state: 'visible', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  } catch (e) {
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
  console.log(`=== STARTING 1WIN BATCH BET PLACEMENT (TARGET: ${TARGET_BETS_COUNT} BETS) ===`);

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

  const report = {
    started_at: new Date().toISOString(),
    target_bets: TARGET_BETS_COUNT,
    successful_bets: [],
    skipped_summary: {
      odds_drift: 0,
      limits_blocked: 0,
      board_mismatch: 0,
      slip_mismatch: 0,
      dom_not_found: 0,
      api_errors: 0
    },
    telemetry: [],
    findings: []
  };

  let placedCount = 0;
  let attempt = 0;
  const maxAttempts = 25;
  const blacklistedMatchKeys = new Set();

  while (placedCount < TARGET_BETS_COUNT && attempt < maxAttempts) {
    attempt++;
    console.log(`\n==============================================`);
    console.log(`>>> ATTEMPT ${attempt} (PLACED: ${placedCount}/${TARGET_BETS_COUNT}) <<<`);
    console.log(`==============================================`);

    const betStartTime = Date.now();
    let targetArb = null;
    let targetPlan = null;
    let scanRounds = 0;

    // Phase 1: Scanner & Odds Match
    const scanStart = Date.now();
    for (let round = 1; round <= 15; round++) {
      scanRounds = round;
      console.log(`[BET ${placedCount + 1} | Attempt ${attempt}] Scan round ${round}...`);
      const arbs = await getCandidateArbs();

      for (const arb of arbs) {
        if (!arb.bk2 || !arb.bk2.includes('1win')) continue;
        const matchKey = (arb.match || '').trim();
        if (blacklistedMatchKeys.has(matchKey)) continue;

        let plan;
        try {
          plan = await resolvePlan(arb);
        } catch {
          continue;
        }

        if (!plan || !plan.ok || !plan.quote?.verified) continue;

        if (plan.limits_allowed === false) {
          report.skipped_summary.limits_blocked++;
          console.log(`[LIMITS] Skip ${arb.match} -> ${plan.ui_selection_name}: ${plan.limits_reason}`);
          blacklistedMatchKeys.add(matchKey);
          continue;
        }

        const feedOdds = Number(plan.quote.feed_odds);
        const currOdds = Number(plan.quote.current_odds);
        const diff = Math.abs(feedOdds - currOdds);

        if (diff < 0.001) {
          console.log(`[MATCH FOUND] ${arb.match} | ${plan.selection.market_name} -> ${plan.ui_selection_name} | Feed: ${feedOdds} vs 1win: ${currOdds}`);
          targetArb = arb;
          targetPlan = plan;
          break;
        } else {
          report.skipped_summary.odds_drift++;
        }
      }

      if (targetPlan) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    const scanDurationMs = Date.now() - scanStart;

    if (!targetPlan) {
      console.error(`[BET ${placedCount + 1}] No matching candidate fork found in scan.`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const selection = targetPlan.selection;
    const expectedOdds = Number(targetPlan.quote.current_odds);

    // Phase 2: Navigation
    const navStart = Date.now();
    console.log(`[BET ${placedCount + 1} | Attempt ${attempt}] Navigating to: ${selection.event_url}`);
    try {
      await page.goto(selection.event_url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      // Wait for 1win SPA to render live odds buttons
      console.log(`[BET ${placedCount + 1}] Waiting for odds buttons to render...`);
      await page.waitForSelector('button:has(span[class^="_cf_"])', { timeout: 25000 });
      console.log(`[BET ${placedCount + 1}] Odds buttons rendered on page.`);
    } catch (e) {
      console.error(`[BET ${placedCount + 1}] Navigation / DOM render error:`, e.message);
      report.skipped_summary.dom_not_found++;
      blacklistedMatchKeys.add(targetArb.match);
      await page.screenshot({ path: `/tmp/bet_attempt_${attempt}_nav_err.png` }).catch(() => {});
      continue;
    }
    const navDurationMs = Date.now() - navStart;

    // Phase 3: Betslip Preparation
    const slip = page.locator('aside').filter({ hasText: /betslip|купон/i }).first();
    await clearSlip(page);

    // Phase 4: Market & Outcome Locate
    const locateStart = Date.now();
    console.log(`[BET ${placedCount + 1}] Locating market "${selection.market_name}", outcome "${targetPlan.ui_selection_name}" (expected odds: ${expectedOdds})...`);

    let button = null;
    let boardPrice = null;

    try {
      // Find the market header
      const title = page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
      let group = null;
      if (await title.count() > 0) {
        group = title.first().locator('xpath=ancestor::div[.//button[.//span[starts-with(@class,"_cf_")]]][1]');
      }

      const scope = (group && await group.count() > 0) ? group : page;
      const allButtons = scope.getByRole('button').filter({ has: page.locator('span[class*="_cf_"]') });
      const totalButtons = await allButtons.count();

      // Strategy A: Exact / substring outcome name + matching odds
      for (let i = 0; i < totalButtons; i++) {
        const btn = allButtons.nth(i);
        const text = await btn.innerText().catch(() => '');
        const cfText = await btn.locator('span[class*="_cf_"]').innerText().catch(() => '');
        const cf = parseAmount(cfText);
        if (text.includes(targetPlan.ui_selection_name) && cf && Math.abs(cf - expectedOdds) <= 0.015) {
          button = btn;
          boardPrice = cf;
          console.log(`[BET ${placedCount + 1}] Found via Strategy A: "${text.replace(/\n/g, ' ')}" -> price ${boardPrice}`);
          break;
        }
      }

      // Strategy B: If not found, match odds inside market group
      if (!button && group && await group.count() > 0) {
        for (let i = 0; i < totalButtons; i++) {
          const btn = allButtons.nth(i);
          const text = await btn.innerText().catch(() => '');
          const cfText = await btn.locator('span[class*="_cf_"]').innerText().catch(() => '');
          const cf = parseAmount(cfText);
          if (cf && Math.abs(cf - expectedOdds) <= 0.015) {
            const cleanTarget = targetPlan.ui_selection_name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (cleanText.includes(cleanTarget) || cleanTarget.includes(cleanText.replace(/\d+/g, ''))) {
              button = btn;
              boardPrice = cf;
              console.log(`[BET ${placedCount + 1}] Found via Strategy B: "${text.replace(/\n/g, ' ')}" -> price ${boardPrice}`);
              break;
            }
          }
        }
      }

      // Strategy C: Direct getByText filter inside group
      if (!button && group && await group.count() > 0) {
        const directBtn = group.getByRole('button').filter({ has: page.getByText(targetPlan.ui_selection_name, { exact: false }) });
        if (await directBtn.count() > 0) {
          const btn = directBtn.first();
          const cfText = await btn.locator('span[class*="_cf_"]').innerText().catch(() => '');
          const cf = parseAmount(cfText);
          if (cf && Math.abs(cf - expectedOdds) <= 0.015) {
            button = btn;
            boardPrice = cf;
            console.log(`[BET ${placedCount + 1}] Found via Strategy C: price ${boardPrice}`);
          }
        }
      }

      if (!button) {
        throw new Error(`Could not locate button for "${selection.market_name}" -> "${targetPlan.ui_selection_name}" with odds ${expectedOdds}`);
      }
    } catch (e) {
      console.error(`[BET ${placedCount + 1}] Market locate failed:`, e.message);
      report.skipped_summary.dom_not_found++;
      blacklistedMatchKeys.add(targetArb.match);
      await page.screenshot({ path: `/tmp/bet_attempt_${attempt}_locate_err.png` }).catch(() => {});
      continue;
    }
    const locateDurationMs = Date.now() - locateStart;

    if (Math.abs(boardPrice - expectedOdds) > 0.015) {
      console.warn(`[BET ${placedCount + 1}] Board price mismatch: expected ${expectedOdds}, got ${boardPrice}. Skipping!`);
      report.skipped_summary.board_mismatch++;
      blacklistedMatchKeys.add(targetArb.match);
      continue;
    }

    // Phase 5: Click & Verify Slip
    const clickStart = Date.now();
    await button.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    console.log(`[BET ${placedCount + 1}] Checking slip contains outcome...`);
    try {
      await slip.getByText(targetPlan.ui_selection_name, { exact: false }).first().waitFor({ timeout: 6000 });
    } catch (e) {
      const slipItems = await slip.locator('div[class*="item"], div[class*="selection"], div[class*="card"]').count();
      if (slipItems === 0) {
        console.warn(`[BET ${placedCount + 1}] Selection did not appear in slip:`, e.message);
        blacklistedMatchKeys.add(targetArb.match);
        await clearSlip(page);
        continue;
      }
    }

    const slipOddsText = await slip.locator('span[class*="_cf_"], div[class*="badge"], div[class*="odd"]')
      .filter({ hasText: /^\d+\.\d+$/ }).first().innerText().catch(() => '');
    const slipOdds = parseAmount(slipOddsText);
    console.log(`[BET ${placedCount + 1}] Slip odds: ${slipOdds}, Expected: ${expectedOdds}`);

    if (slipOdds && Math.abs(slipOdds - expectedOdds) > 0.015) {
      console.warn(`[BET ${placedCount + 1}] Odds drifted in slip: expected ${expectedOdds}, got ${slipOdds}. Aborting!`);
      report.skipped_summary.slip_mismatch++;
      blacklistedMatchKeys.add(targetArb.match);
      await clearSlip(page);
      continue;
    }
    const clickDurationMs = Date.now() - clickStart;

    // Phase 6: Enter Amount (1 USDT)
    const inputStart = Date.now();
    const amountInput = slip.locator('input[data-qa="amount"]:visible').first();
    await amountInput.click();
    await amountInput.press('ControlOrMeta+A');
    await amountInput.press('Backspace');
    await amountInput.pressSequentially('1');
    await amountInput.press('Tab');
    await page.waitForTimeout(400);

    const enteredAmount = parseAmount(await amountInput.inputValue());
    console.log(`[BET ${placedCount + 1}] Entered stake: ${enteredAmount} USDT`);
    if (enteredAmount !== 1) {
      console.error(`[BET ${placedCount + 1}] Stake entry error: readback ${enteredAmount}`);
      blacklistedMatchKeys.add(targetArb.match);
      await clearSlip(page);
      continue;
    }
    const inputDurationMs = Date.now() - inputStart;

    await slip.screenshot({ path: `/tmp/bet_attempt_${attempt}_before_slip.png` }).catch(() => {});

    // Phase 7: Submit & Fast API Response Intercept
    const submitStart = Date.now();
    const submitBtn = slip.getByRole('button', { name: /place a bet|сделать ставку/i });
    if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
      console.error(`[BET ${placedCount + 1}] Submit button not clickable!`);
      blacklistedMatchKeys.add(targetArb.match);
      await clearSlip(page);
      continue;
    }

    console.log(`[BET ${placedCount + 1}] >>> SUBMITTING BET NOW... <<<`);

    let apiPlacementResponse = null;

    const responsePromise = page.waitForResponse(
      res => res.url().includes('make-bet-v2') && res.request().method() === 'POST',
      { timeout: 15000 }
    ).then(async res => {
      try {
        const json = await res.json();
        return { status: res.status(), body: json };
      } catch {
        return { status: res.status(), text: await res.text().catch(() => '') };
      }
    }).catch(err => {
      console.warn(`[BET ${placedCount + 1}] Response wait timeout:`, err.message);
      return null;
    });

    await submitBtn.click();
    apiPlacementResponse = await responsePromise;
    const submitDurationMs = Date.now() - submitStart;

    console.log(`[BET ${placedCount + 1}] make-bet-v2 responded in ${submitDurationMs} ms:`, JSON.stringify(apiPlacementResponse));

    await page.waitForTimeout(2500);
    await page.screenshot({ path: `/tmp/bet_${placedCount + 1}_after_full.png` }).catch(() => {});

    // Read balance after bet
    const headerText = await page.locator('header').innerText().catch(() => '');
    const balanceMatch = headerText.match(/USDT\s*[|\n\r\t\s]*([\d]+[.,][\d]{2})/i)
      || (await page.innerText('body')).match(/USDT\s*[|\n\r\t\s]*([\d]+[.,][\d]{2})/i);
    const balanceAfter = balanceMatch ? balanceMatch[1] : 'unknown';
    console.log(`[BET ${placedCount + 1}] Balance after bet: ${balanceAfter} USDT`);

    // Verify success
    let betSuccess = false;
    let confirmedBetId = null;
    let confirmedCf = expectedOdds;

    if (apiPlacementResponse && apiPlacementResponse.body?.result?.success) {
      betSuccess = true;
      confirmedBetId = apiPlacementResponse.body.result.success.betId;
      confirmedCf = apiPlacementResponse.body.result.success.cf;
    } else if (apiPlacementResponse && apiPlacementResponse.body?.success) {
      betSuccess = true;
      confirmedBetId = apiPlacementResponse.body.payload?.id;
      confirmedCf = apiPlacementResponse.body.payload?.coefficient;
    } else {
      const hasReceipt = await page.getByText(/bet placed|ставка принята|bet accepted/i).count();
      if (hasReceipt > 0) {
        betSuccess = true;
      }
    }

    const totalBetTimeMs = Date.now() - betStartTime;

    if (betSuccess) {
      placedCount++;
      blacklistedMatchKeys.add(targetArb.match);
      console.log(`\n>>> [BET ${placedCount} SUCCESS] <<<`);
      console.log(`Match: ${targetArb.match}`);
      console.log(`Bet ID: ${confirmedBetId}, Placed Cf: ${confirmedCf}`);
      console.log(`Balance after bet: ${balanceAfter} USDT`);
      console.log(`Total cycle time: ${totalBetTimeMs} ms\n`);

      const betRecord = {
        bet_number: placedCount,
        match: targetArb.match,
        sport: targetArb.sport,
        market: selection.market_name,
        selection: targetPlan.ui_selection_name,
        expected_odds: expectedOdds,
        placed_odds: confirmedCf,
        stake: 1.0,
        bet_id: confirmedBetId,
        balance_after: balanceAfter,
        timings: {
          scan_ms: scanDurationMs,
          nav_ms: navDurationMs,
          locate_ms: locateDurationMs,
          click_ms: clickDurationMs,
          input_ms: inputDurationMs,
          submit_api_ms: submitDurationMs,
          total_ms: totalBetTimeMs
        }
      };

      report.successful_bets.push(betRecord);

      // Record in limits tracker
      await recordBetInTracker(targetArb, targetPlan.ui_selection_name, 1.0, confirmedCf, selection.market_name, balanceAfter);

    } else {
      console.error(`[BET ${placedCount + 1} FAILED] API response did not confirm success:`, apiPlacementResponse);
      report.skipped_summary.api_errors++;
      report.findings.push(`Bet attempt ${attempt} (${targetArb.match}) submission failed: ${JSON.stringify(apiPlacementResponse)}`);
      blacklistedMatchKeys.add(targetArb.match);
    }

    await clearSlip(page);
    await page.waitForTimeout(1000);
  }

  report.finished_at = new Date().toISOString();
  report.total_placed = placedCount;

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n=== BATCH RUN FINISHED: ${placedCount} OF ${TARGET_BETS_COUNT} BETS PLACED ===`);
  console.log(`Full report saved to ${REPORT_FILE}`);

  await browser.close();
}

main().catch(err => {
  console.error('Fatal batch error:', err);
  process.exit(1);
});
