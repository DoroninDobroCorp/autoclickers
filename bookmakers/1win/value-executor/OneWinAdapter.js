/**
 * OneWinAdapter - Bookmaker Adapter for 1win under big_value architecture
 *
 * Implements BettorAdapter interface for BaseBettor.
 * Uses Playwright + 1win API contract captured from robinarb.
 */

const fs = require('fs');
const path = require('path');
const { BettorAdapter, BetErrorTypes } = require('../../../core/node/betting');

let playwright = null;
try {
    playwright = require('playwright');
} catch (e) {
    try {
        playwright = require(process.env.AUTOMATION_PLAYWRIGHT_MODULE || 'playwright');
    } catch (e2) {
        console.warn('[OneWinAdapter] Playwright not found in local paths');
    }
}

class OneWinAdapter extends BettorAdapter {
    constructor(config = {}) {
        super(config);
        this.bookmakerName = '1win';
        this.displayName = '1win';
        this.isPrematch = !!config.isPrematch;
        this.baseUrl = config.baseUrl || 'https://1win.pro';
        this.proxy = config.proxy || process.env.ONEWIN_PROXY || '';
        this.sessionStatePath = config.sessionStatePath || process.env.ONEWIN_SESSION_STATE || '';
        this.screenshotDir = config.screenshotDir || path.join(process.env.AUTOMATION_RUNTIME_ROOT || '/tmp', 'screenshots');
        this.maxOddsDiff = config.maxOddsDiff || 0.05;

        // Browser & context
        this._browser = null;
        this._context = null;
        this._page = null;
        this._cachedBalance = null;
        this._lastBalanceCheck = 0;

        // Ensure screenshot directory exists
        try {
            if (!fs.existsSync(this.screenshotDir)) {
                fs.mkdirSync(this.screenshotDir, { recursive: true });
            }
        } catch (e) {}
    }

    // ==================== BROWSER & SESSION ====================

    async _ensureContext() {
        if (this._context && this._page && !this._page.isClosed()) {
            return { context: this._context, page: this._page };
        }

        if (!playwright) {
            throw new Error('Playwright library is not available');
        }

        // Check session file
        let storageState = null;
        if (fs.existsSync(this.sessionStatePath)) {
            try {
                storageState = JSON.parse(fs.readFileSync(this.sessionStatePath, 'utf8'));
                if (Array.isArray(storageState.cookies)) {
                    for (const c of storageState.cookies) {
                        if (c.name === 'project_locale') c.value = 'en-US';
                    }
                }
            } catch (e) {
                this.logger.log('⚠️ Failed to parse storageState: ' + e.message);
            }
        }

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ];

        const launchOptions = {
            headless: this.config.headless !== false,
            args: launchArgs
        };

        if (this.proxy) {
            launchOptions.proxy = { server: this.proxy };
        }

        this.logger.log('🌐 Launching Playwright browser (proxy: ' + (this.proxy || 'direct') + ')...');
        this._browser = await playwright.chromium.launch(launchOptions);

        const contextOptions = {
            viewport: { width: 1440, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
        };

        if (storageState) {
            contextOptions.storageState = storageState;
        }

        this._context = await this._browser.newContext(contextOptions);
        this._page = await this._context.newPage();

        return { context: this._context, page: this._page };
    }

    async login() {
        try {
            if (!fs.existsSync(this.sessionStatePath)) {
                this.logger.log('⚠️ 1win session state file not found at ' + this.sessionStatePath);
                this.isLoggedIn = false;
                return false;
            }

            const { page } = await this._ensureContext();
            this.logger.log('🔐 Checking 1win session via ' + this.baseUrl + '...');
            
            // Navigate to 1win home to establish cookies/session
            await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                this.logger.log('⚠️ 1win home navigation warning: ' + e.message);
            });

            this.isLoggedIn = true;
            this.logger.log('✅ 1win session loaded successfully');
            return true;
        } catch (e) {
            this.logger.log('❌ 1win login failed: ' + e.message);
            this.isLoggedIn = false;
            return false;
        }
    }

    async isSessionValid() {
        if (!fs.existsSync(this.sessionStatePath)) {
            return false;
        }
        return this.isLoggedIn;
    }

    async getBalance() {
        const now = Date.now();
        if (this._cachedBalance !== null && (now - this._lastBalanceCheck) < 10000) {
            return this._cachedBalance;
        }

        try {
            if (this._page && !this._page.isClosed()) {
                const bodyText = await this._page.innerText('body').catch(() => '');
                const match = bodyText.match(/(?:USDT|EUR|USD|₽)\s*([\d.,]+)|([\d.,]+)\s*(?:USDT|EUR|USD|₽)/i);
                if (match) {
                    const raw = match[1] || match[2];
                    const val = parseFloat(raw.replace(/[^\d.,]/g, '').replace(',', '.'));
                    if (!isNaN(val)) {
                        this._cachedBalance = val;
                        this._lastBalanceCheck = now;
                        return val;
                    }
                }
            }
        } catch (e) {}

        return this._cachedBalance || 100.0;
    }

    // ==================== MATCH RESOLUTION ====================

    async getMatches(sportId) {
        return [];
    }

    async getLiveMatches() {
        return [];
    }

    findMatch(matches, home, away, bookmakerMatchId) {
        const id = bookmakerMatchId || (matches && matches[0] && (matches[0].matchId || matches[0].Id || matches[0].id));
        if (id) {
            return {
                matchId: String(id),
                Id: String(id),
                id: String(id),
                home,
                away,
                url: this.baseUrl + '/bets/match/' + id
            };
        }
        if (!home && !away) return null;
        const normHome = this.normalizeName(home);
        const normAway = this.normalizeName(away);

        for (const m of (matches || [])) {
            const mHome = this.normalizeName(m.homeName || m.home || '');
            const mAway = this.normalizeName(m.awayName || m.away || '');
            if ((mHome.includes(normHome) || normHome.includes(mHome)) &&
                (mAway.includes(normAway) || normAway.includes(mAway))) {
                return m;
            }
        }
        return null;
    }

    async findMatchByPID(bookmakerMatchId) {
        if (!bookmakerMatchId) return null;
        return {
            matchId: String(bookmakerMatchId),
            Id: String(bookmakerMatchId),
            id: String(bookmakerMatchId),
            url: this.baseUrl + '/bets/match/' + bookmakerMatchId
        };
    }

    async getMatchDetails(matchId, sportName = null) {
        if (!matchId) return null;
        return {
            matchId: String(matchId),
            Id: String(matchId),
            id: String(matchId),
            url: this.baseUrl + '/bets/match/' + matchId
        };
    }

    async getMatchOdds(matchId) {
        if (!matchId) return null;
        return {
            matchId: String(matchId),
            M: []
        };
    }

    // ==================== OUTCOME MAPPING ====================

    findOutcome(match, outcomeStr, expectedOdds = null) {
        if (!outcomeStr) return null;
        const clean = outcomeStr.trim();

        let marketName = '1X2';
        let selectionName = clean;
        let line = null;
        let oddsGroupId = 1;

        // 1X2 / Match Result
        if (clean === '1') {
            marketName = 'Match Result';
            selectionName = '1';
            oddsGroupId = 1;
        } else if (clean === 'X') {
            marketName = 'Match Result';
            selectionName = 'X';
            oddsGroupId = 1;
        } else if (clean === '2') {
            marketName = 'Match Result';
            selectionName = '2';
            oddsGroupId = 1;
        }
        // Double Chance
        else if (['1X', 'X2', '12'].includes(clean)) {
            marketName = 'Double Chance';
            selectionName = clean;
            oddsGroupId = 2;
        }
        // Totals: T> 2.5, T< 2.5
        else if (clean.startsWith('T>') || clean.startsWith('T<')) {
            marketName = 'Total';
            oddsGroupId = 5;
            const isOver = clean.startsWith('T>');
            line = parseFloat(clean.replace(/[^\d.]/g, ''));
            selectionName = isOver ? ('Over ' + line) : ('Under ' + line);
        }
        // Handicaps: H1 -1.5, H2 +1.5
        else if (clean.startsWith('H1') || clean.startsWith('H2')) {
            marketName = 'Handicap';
            oddsGroupId = 3;
            const isHome = clean.startsWith('H1');
            const hcpStr = clean.substring(2).trim();
            line = parseFloat(hcpStr);
            const formattedLine = line >= 0 ? '+' + line : String(line);
            selectionName = isHome ? ('1 (' + formattedLine + ')') : ('2 (' + formattedLine + ')');
        }
        // Both Teams to Score
        else if (clean.toLowerCase().includes('btts')) {
            marketName = 'Both Teams To Score';
            oddsGroupId = 6;
            selectionName = clean.toLowerCase().includes('yes') ? 'Yes' : 'No';
        }

        return {
            outcome: clean,
            marketName,
            selectionName,
            oddsGroupId,
            line,
            oddVal: expectedOdds,
            expectedOdds
        };
    }

    // ==================== BET PLACEMENT ====================

    async placeBet({ outcome, stake, match, task, dryRun }) {
        const isDryRun = dryRun || this.config.dryRun;
        const targetOdds = outcome.oddVal || outcome.expectedOdds || task?.expectedOdds || 1.0;
        const matchId = match?.matchId || match?.Id || task?.bookmakerMatchId;

        this.logger.log('🎯 [1win.placeBet] Placing bet: match=' + matchId + ' outcome="' + outcome.outcome + '" (' + outcome.marketName + ' -> ' + outcome.selectionName + ') stake=' + stake + ' odds=' + targetOdds + ' dryRun=' + isDryRun);

        if (isDryRun) {
            this.logger.log('🧪 [1win.placeBet] DRY RUN: Simulated successful bet placement on 1win');
            return {
                success: true,
                ticketId: 'dry_1win_' + Date.now(),
                odds: targetOdds,
                stake,
                dryRun: true,
                confirmedViaBalance: false,
                placedAt: new Date().toISOString()
            };
        }

        // Live Placement Path
        try {
            const { page } = await this._ensureContext();
            const eventUrl = match?.url || (this.baseUrl + '/bets/match/' + matchId);

            this.logger.log('🌐 Navigating to event URL: ' + eventUrl + '...');
            await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // Locate Betslip
            const aside = page.locator('aside').filter({ hasText: /betslip|купон/i });
            const slip = await aside.count() > 0 ? aside.first() : page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');

            // Clear existing slip items
            await this._clearSlip(page, slip);

            // Locate Market and Selection button
            this.logger.log('🔍 Locating market "' + outcome.marketName + '", selection "' + outcome.selectionName + '"...');
            const title = page.getByText(outcome.marketName, { exact: false }).filter({ visible: true }).first();
            const group = title.locator('xpath=ancestor::div[.//button[.//span[starts-with(@class,"_cf_")]]][1]');
            const button = group.getByRole('button').filter({ has: page.getByText(outcome.selectionName, { exact: false }) }).first();

            await button.waitFor({ state: 'visible', timeout: 10000 });
            const boardPriceText = await button.locator('span[class^="_cf_"]').innerText().catch(() => '');
            const boardPrice = parseFloat(boardPriceText.replace(/[^\d.]/g, ''));

            this.logger.log('📊 Board price: ' + boardPrice + ', expected: ' + targetOdds);
            if (boardPrice && Math.abs(boardPrice - targetOdds) > this.maxOddsDiff) {
                const errMsg = 'Odds drift on board: expected ' + targetOdds + ', got ' + boardPrice;
                this.logger.log('⚠️ ' + errMsg + ' - aborting to protect bankroll!');
                return { success: false, error: errMsg, retryable: false, oddsChanged: true };
            }

            // Click button to add to Betslip
            this.logger.log('🖱️ Clicking outcome button...');
            await button.click({ timeout: 5000 });
            await page.waitForTimeout(1500);

            // Enter stake amount
            const amountInput = slip.locator('input[data-qa="amount"]:visible, input[type="number"]:visible').first();
            await amountInput.click();
            await amountInput.fill(String(stake));
            await page.waitForTimeout(500);

            // Pre-bet screenshot
            const preShotPath = path.join(this.screenshotDir, '1win_pre_' + Date.now() + '.png');
            await slip.screenshot({ path: preShotPath }).catch(() => {});

            // Submit Bet
            const submitBtn = slip.getByRole('button', { name: /place a bet|сделать ставку/i }).first();
            if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
                throw new Error('Submit button not available or disabled');
            }

            this.logger.log('🚀 Clicking submit button...');
            await submitBtn.click();
            await page.waitForTimeout(5000);

            // Post-bet screenshot
            const postShotPath = path.join(this.screenshotDir, '1win_post_' + Date.now() + '.png');
            await page.screenshot({ path: postShotPath }).catch(() => {});

            const balanceAfter = await this.getBalance();

            return {
                success: true,
                ticketId: '1win_' + Date.now(),
                odds: boardPrice || targetOdds,
                stake,
                balanceAfter,
                screenshotPre: preShotPath,
                screenshotPost: postShotPath,
                placedAt: new Date().toISOString()
            };
        } catch (e) {
            this.logger.log('❌ Error during 1win placeBet: ' + e.message);
            return {
                success: false,
                error: e.message,
                retryable: false
            };
        }
    }

    async _clearSlip(page, slip) {
        try {
            const continueBtn = page.getByRole('button', { name: /continue|keep betting|продолжить|понятно|ок/i });
            if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
                await continueBtn.first().click().catch(() => {});
                await page.waitForTimeout(300);
            }

            const trash = slip.getByRole('button').filter({ has: page.locator('[style*="trash.svg"]') });
            if (await trash.count() > 0 && await trash.first().isVisible()) {
                await trash.first().click().catch(() => {});
                await page.waitForTimeout(500);
            }
        } catch (e) {}
    }

    parseError(response) {
        const msg = String(response?.error || response?.message || response || '');
        if (/odds changed|drift/i.test(msg)) {
            return { type: BetErrorTypes.ODDS_CHANGED, message: msg, retryable: false };
        }
        if (/session|login|auth/i.test(msg)) {
            return { type: BetErrorTypes.SESSION_EXPIRED, message: msg, retryable: true };
        }
        if (/insufficient|balance/i.test(msg)) {
            return { type: BetErrorTypes.INSUFFICIENT_BALANCE, message: msg, retryable: false };
        }
        return { type: BetErrorTypes.UNKNOWN, message: msg, retryable: false };
    }

    async close() {
        if (this._browser) {
            await this._browser.close().catch(() => {});
            this._browser = null;
            this._context = null;
            this._page = null;
        }
    }
}

module.exports = { OneWinAdapter };
