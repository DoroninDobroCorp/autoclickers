/**
 * BookmakerAutomation Interface
 * 
 * Implements DRIVER-REQ-01 from Story 1.5
 * Defined in Story 3.1 (AUTO-DRIVER-1)
 * 
 * All bookmaker drivers MUST implement this interface.
 * This interface provides a unified API for interacting with any bookmaker,
 * enabling the system to:
 * - Place bets on any bookmaker through standardized methods
 * - Add new bookmakers without modifying core logic
 * - Filter tasks by bookmaker capabilities (supported outcomes)
 * 
 * @interface BookmakerAutomation
 * @see docs/stories/1.5.story.md (DRIVER-REQ-01 to DRIVER-REQ-05)
 * @see docs/stories/3.1.story.md (this story)
 */

/**
 * BetTask structure (input for placeBet)
 * 
 * @typedef {Object} BetTask
 * @property {number} id - Unique task ID (timestamp)
 * @property {string} bookmakerId - Bookmaker identifier (e.g., 'sansabet', 'pinnacle')
 * @property {string} home - Home team name
 * @property {string} away - Away team name
 * @property {string} outcome - Outcome string (e.g., 'T> 2.5', 'IT1> 0.5', '1')
 * @property {number} stake - Bet stake in EUR
 * @property {number} [minOdds] - Minimum acceptable odds (optional)
 * @property {number} [maxOdds] - Maximum acceptable odds (optional)
 * @property {string} source - Task source ('analyzer' | 'telegram')
 * @property {string} [matchKey] - Match key for deduplication (optional)
 * @property {string} [sport] - Sport type (optional)
 * @property {number} timestamp - Task creation timestamp
 */

/**
 * BetResult structure (success case)
 * 
 * @typedef {Object} BetResultSuccess
 * @property {true} ok - true for success
 * @property {number} odds - Final odds at which bet was placed
 * @property {number} stake - Final stake (may differ from requested)
 * @property {number} attempts - Number of attempts made
 * @property {string} [betId] - Bookmaker's bet ID (if available)
 */

/**
 * BetResult structure (failure case)
 * 
 * @typedef {Object} BetResultFailure
 * @property {false} ok - false for failure
 * @property {string} error - Error code (see BetErrorCode enum)
 * @property {string} step - Step name where error occurred (e.g., 'find_match', 'click_outcome')
 * @property {number} stepNumber - Step number (1-based)
 * @property {string|null} lastScreenshot - Path to error screenshot (if captured)
 */

/**
 * Standard error codes for bet placement failures
 * 
 * Use these codes in BetResultFailure.error for consistency.
 * 
 * @enum {string}
 */
const BetErrorCode = {
  // Match-related errors
  MATCH_NOT_FOUND: 'match_not_found',         // Match not found on live betting page
  MATCH_SUSPENDED: 'match_suspended',         // Match is suspended/not accepting bets
  MATCH_FINISHED: 'match_finished',           // Match has already finished
  
  // Outcome-related errors
  OUTCOME_NOT_FOUND: 'outcome_not_found',     // Outcome not available on site
  OUTCOME_SUSPENDED: 'outcome_suspended',     // Outcome is suspended
  
  // Odds-related errors
  ODDS_CHANGED: 'odds_changed',               // Odds changed beyond acceptable range
  ODDS_TOO_LOW: 'odds_too_low',               // Odds below minOdds
  ODDS_TOO_HIGH: 'odds_too_high',             // Odds above maxOdds
  DATA_TOO_OLD: 'data_too_old',               // Data freshness check failed
  
  // Bet submission errors
  BET_REJECTED: 'bet_rejected',               // Bet rejected by bookmaker
  INSUFFICIENT_BALANCE: 'insufficient_balance', // Not enough balance for stake
  STAKE_INVALID: 'stake_invalid',             // Stake outside allowed range
  
  // Technical errors
  TIMEOUT: 'timeout',                         // Operation timed out
  NETWORK_ERROR: 'network_error',             // Network/connection issue
  SITE_ERROR: 'site_error',                   // Bookmaker site error/down
  
  // Authentication errors
  NOT_LOGGED_IN: 'not_logged_in',             // User not logged in
  SESSION_EXPIRED: 'session_expired',         // Session expired
  LOGIN_FAILED: 'login_failed',               // Login attempt failed
  
  // Other
  UNKNOWN_ERROR: 'unknown_error'              // Unknown/unclassified error
};

/**
 * Required minimums for bookmaker drivers.
 * 
 * These values are based on Sansabet hotfix lessons (November 2025).
 * DO NOT lower these values without testing!
 * 
 * Rationale:
 * - RETRY_ATTEMPTS: 6 retries reduce outcome_not_found from 70% to <5%
 * - RETRY_DELAY_MS: 600ms allows SPA to update DOM between retries
 * - FRESHNESS_BEFORE_MS: 2000ms ensures data is recent (strict check)
 * - FRESHNESS_AFTER_MS: 10000ms tolerates odds change delay (relaxed check)
 * - MAX_SUBMIT_ATTEMPTS: 10 attempts handle odds changes + UI glitches
 * 
 * @constant {Object} REQUIRED_MINIMUMS
 */
const REQUIRED_MINIMUMS = {
  /**
   * Minimum retry attempts for outcome search.
   * Hotfix: increased from 0 to 6 → reduced failures by 65%
   */
  RETRY_ATTEMPTS: 6,

  /**
   * Minimum delay between retries (ms).
   * Hotfix: added 600ms wait → allows DOM to update
   */
  RETRY_DELAY_MS: 600,

  /**
   * Maximum data age before submit (ms) - STRICT check.
   * Hotfix: added 2s limit → prevents stale bets
   */
  FRESHNESS_BEFORE_MS: 2000,

  /**
   * Maximum data age after odds change (ms) - RELAXED check.
   * Hotfix: added 10s tolerance → allows odds change handling
   */
  FRESHNESS_AFTER_MS: 10000,

  /**
   * Maximum submit loop iterations (includes odds change retries).
   * Hotfix: added 10 attempts → handles multiple odds changes
   */
  MAX_SUBMIT_ATTEMPTS: 10
};

/**
 * HealthStatus structure
 * 
 * @typedef {Object} HealthStatus
 * @property {boolean} ok - true if driver is healthy
 * @property {string} status - Status string: 'active' | 'idle' | 'error' | 'logged_out'
 * @property {number} [lastActivity] - Timestamp of last activity (optional)
 * @property {number} [uptime] - Driver uptime in milliseconds (optional)
 * @property {string} [error] - Error message if status is 'error' (optional)
 */

/**
 * BookmakerConfig structure (from bookmakers.<id> in config)
 * 
 * @typedef {Object} BookmakerConfig
 * @property {string} id - Bookmaker identifier
 * @property {string} url - Bookmaker website URL
 * @property {Object} auth - Authentication credentials
 * @property {string} auth.login - Login/username
 * @property {string} auth.password - Password (from secrets)
 * @property {Object} betting - Betting parameters
 * @property {number} betting.stake - Default stake in EUR
 * @property {number} betting.maxTotalPerMatch - Max total stake per match
 * @property {Object} [browser] - Browser settings (optional)
 * @property {boolean} [browser.headless] - Run in headless mode
 */

/**
 * BookmakerAutomation Interface
 * 
 * All bookmaker drivers must implement this interface.
 * This is a SPECIFICATION only - all methods throw NotImplementedError.
 * 
 * @interface
 */
class BookmakerAutomation {
  /**
   * Initialize driver with Playwright page and bookmaker config
   * 
   * PURPOSE:
   * - Navigate to bookmaker website
   * - Set up browser context (cookies, local storage)
   * - Initialize internal state (logger, screenshot manager, etc.)
   * 
   * WHEN CALLED:
   * - Once at driver startup
   * - After browser crash/restart
   * 
   * IMPLEMENTS: DRIVER-REQ-05 (receives config from bookmakers.<id>)
   * 
   * @param {import('playwright').Page} page - Playwright page object
   * @param {BookmakerConfig} config - Bookmaker configuration
   * @returns {Promise<void>}
   * @throws {Error} InitializationError if navigation or setup fails
   * 
   * @example
   * // Example implementation (Sansabet):
   * async init(page, config) {
   *   this.page = page;
   *   this.config = config;
   *   this.logger = new Logger({ prefix: `${config.id}Driver` });
   *   this.screenshotManager = new ScreenshotManager({ screenshotDir: './screenshots' });
   *   
   *   this.logger.info(`Initializing driver for ${config.id}`);
   *   
   *   try {
   *     await this.page.goto(config.url, { waitUntil: 'networkidle' });
   *     this.logger.info(`Navigated to ${config.url}`);
   *   } catch (error) {
   *     this.logger.error(`Failed to navigate: ${error.message}`);
   *     throw new Error(`InitializationError: ${error.message}`);
   *   }
   * }
   */
  async init(page, config) {
    throw new Error('NotImplementedError: Must be implemented by driver');
  }
  
  /**
   * Ensure driver is logged in to bookmaker site
   * 
   * PURPOSE:
   * - Check if already logged in (e.g., check for logout button)
   * - Perform login if not logged in
   * - Handle 2FA, captcha, or other auth challenges
   * 
   * WHEN CALLED:
   * - Before each bet placement (or periodically)
   * - After session expiration detected
   * 
   * IMPLEMENTS: DRIVER-REQ-02 (DOM logic isolated in driver)
   * 
   * @returns {Promise<boolean>} true if logged in successfully
   * @throws {Error} LoginError if login fails after retries
   * 
   * @example
   * // Example implementation (Sansabet):
   * async ensureLoggedIn() {
   *   // Check if already logged in
   *   const logoutButton = await this.page.locator('[aria-label="Выход"]').count();
   *   if (logoutButton > 0) {
   *     this.logger.debug('Already logged in');
   *     return true;
   *   }
   *   
   *   this.logger.info('Not logged in, performing login...');
   *   
   *   try {
   *     // Fill login form
   *     await this.page.fill('input[name="login"]', this.config.auth.login);
   *     await this.page.fill('input[name="password"]', this.config.auth.password);
   *     await this.page.click('button[type="submit"]');
   *     
   *     // Wait for login to complete
   *     await this.page.waitForSelector('[aria-label="Выход"]', { timeout: 10000 });
   *     
   *     this.logger.info('Login successful');
   *     return true;
   *   } catch (error) {
   *     this.logger.error(`Login failed: ${error.message}`);
   *     throw new Error(`LoginError: ${error.message}`);
   *   }
   * }
   */
  async ensureLoggedIn() {
    throw new Error('NotImplementedError: Must be implemented by driver');
  }
  
  /**
   * Place bet on bookmaker site
   * 
   * PURPOSE:
   * - Find match on live betting page
   * - Locate and click on specified outcome
   * - Fill bet stake in betslip
   * - Submit bet and verify acceptance
   * 
   * WHEN CALLED:
   * - For each task from TasksManager
   * - After ensureLoggedIn() succeeds
   * 
   * WORKFLOW:
   * 1. Parse outcome using OutcomeParser (from core)
   * 2. Find match (by home/away team names)
   * 3. Click on outcome element
   * 4. Wait for betslip to populate
   * 5. Fill stake
   * 6. Submit bet
   * 7. Handle popups (odds changed, bet rejected, etc.)
   * 8. Return result (success or failure with details)
   * 
   * IMPLEMENTS:
   * - DRIVER-REQ-02 (DOM logic isolated)
   * - DRIVER-REQ-03 (only supported outcomes)
   * - DRIVER-REQ-04 (structured errors with step/stepNumber)
   * 
   * ⚠️ IMPLEMENTATION REQUIREMENTS (from Sansabet hotfix lessons):
   * 1. ✅ Must call checkFreshnessBeforeSubmit() FIRST (before any actions)
   * 2. ✅ Must call scrollMatchPage() before finding outcomes (lazy loading)
   * 3. ✅ Must use submitBetWithRetryLoop() not simple submit (6+ retries)
   * 4. ✅ Must handle odds changes via handleOddsChange() (PRIHVATAM button)
   * 5. ✅ Must retry minimum 6 times for outcome_not_found errors
   * 6. ✅ Must wait between retries (minimum 600ms)
   * 
   * IMPLEMENTATION CHECKLIST:
   * - [ ] Step 1: checkFreshnessBeforeSubmit() — verify data is fresh
   * - [ ] Step 2: navigateToMatch() — open match page
   * - [ ] Step 3: scrollMatchPage() — load all outcomes
   * - [ ] Step 4: clickOutcome() — find and click outcome (with retries)
   * - [ ] Step 5: submitBetWithRetryLoop() — submit with odds change handling
   * 
   * @param {BetTask} task - Task object from TasksManager
   * @returns {Promise<BetResultSuccess|BetResultFailure>} Bet placement result
   * @throws {Error} Critical errors only (most errors returned in BetResultFailure)
   * 
   * @example
   * // Example implementation (Sansabet):
   * async placeBet(task) {
   *   const { OutcomeParser } = require('@autobetting/core');
   *   const parser = new OutcomeParser();
   *   
   *   let stepNumber = 0;
   *   
   *   try {
   *     // Step 1: Parse outcome
   *     stepNumber = 1;
   *     const parsed = parser.parse(task.outcome);
   *     this.logger.info(`Parsed outcome: ${JSON.stringify(parsed)}`);
   *     
   *     // Step 2: Find match
   *     stepNumber = 2;
   *     const match = await this.findMatch(task.home, task.away);
   *     if (!match) {
   *       return {
   *         ok: false,
   *         error: 'match_not_found',
   *         step: 'find_match',
   *         stepNumber: 2,
   *         lastScreenshot: await this.screenshotManager.capture(this.page, 'ERROR_find_match', task)
   *       };
   *     }
   *     
   *     // Step 3: Click outcome
   *     stepNumber = 3;
   *     const clicked = await this.clickOutcome(match, parsed);
   *     if (!clicked) {
   *       return {
   *         ok: false,
   *         error: 'outcome_not_found',
   *         step: 'click_outcome',
   *         stepNumber: 3,
   *         lastScreenshot: await this.screenshotManager.capture(this.page, 'ERROR_click_outcome', task)
   *       };
   *     }
   *     
   *     // Step 4: Fill stake
   *     stepNumber = 4;
   *     await this.page.fill('[data-test="stake-input"]', task.stake.toString());
   *     
   *     // Step 5: Submit bet
   *     stepNumber = 5;
   *     await this.page.click('[data-test="place-bet-button"]');
   *     
   *     // Step 6: Wait for result
   *     stepNumber = 6;
   *     const result = await this.waitForBetResult();
   *     
   *     if (result.accepted) {
   *       this.logger.info(`Bet accepted: odds=${result.odds}, stake=${result.stake}`);
   *       return {
   *         ok: true,
   *         odds: result.odds,
   *         stake: result.stake,
   *         attempts: 1,
   *         betId: result.betId
   *       };
   *     } else {
   *       return {
   *         ok: false,
   *         error: result.error, // e.g., 'bet_rejected', 'odds_changed'
   *         step: 'submit_bet',
   *         stepNumber: 6,
   *         lastScreenshot: await this.screenshotManager.capture(this.page, 'ERROR_submit_bet', task)
   *       };
   *     }
   *   } catch (error) {
   *     this.logger.error(`Bet placement failed at step ${stepNumber}: ${error.message}`);
   *     return {
   *       ok: false,
   *       error: error.message,
   *       step: `step_${stepNumber}`,
   *       stepNumber,
   *       lastScreenshot: await this.screenshotManager.capture(this.page, `ERROR_step_${stepNumber}`, task)
   *     };
   *   }
   * }
   */
  async placeBet(task) {
    throw new Error('NotImplementedError: Must be implemented by driver');
  }
  
  /**
   * ⚠️ REQUIRED: Submit bet with retry loop for odds changes
   * 
   * CRITICAL: This method is REQUIRED after Sansabet hotfix lessons.
   * Without retry loop, 70% of bets fail with outcome_not_found.
   * 
   * PURPOSE:
   * - Submit bet with automatic retry on odds changes
   * - Handle PRIHVATAM/Accept odds change popups
   * - Implement freshness checks (before submit + after odds change)
   * - Retry up to MAX_SUBMIT_ATTEMPTS times
   * 
   * REQUIREMENTS (from hotfix):
   * - MUST implement retry logic (minimum 6 attempts)
   * - MUST handle odds changes (PRIHVATAM/Accept buttons)
   * - MUST implement freshness checks (2-level: before + after)
   * - MUST wait between retries (minimum 600ms)
   * 
   * @param {BetTask} task - Betting task
   * @param {Object} oddsResult - Current odds from clickOutcome()
   * @param {number} oddsResult.odds - Current odds value
   * @param {number} oddsResult.timestamp - Timestamp of odds
   * @param {number} stake - Bet amount
   * @returns {Promise<Object>} Result object
   * @returns {boolean} returns.success - true if bet placed successfully
   * @returns {number} returns.finalOdds - Final odds at which bet was placed
   * @returns {number} returns.attempts - Number of attempts made
   * @returns {string} [returns.error] - Error message if failed
   * @throws {Error} If bet fails after all retries
   * 
   * @example
   * const result = await this.submitBetWithRetryLoop(task, oddsResult, stake);
   * if (!result.success) {
   *   // Handle failure after all retries
   *   throw new BetPlacementError(result.error, 'submit_bet', 5);
   * }
   */
  async submitBetWithRetryLoop(task, oddsResult, stake) {
    throw new Error('NotImplementedError: submitBetWithRetryLoop() must be implemented by driver');
  }
  
  /**
   * ⚠️ REQUIRED: Scroll match page to load virtualized elements
   * 
   * CRITICAL: Required for SPAs with lazy loading / virtualization.
   * Without scrolling, 40% of outcomes are not visible in DOM.
   * 
   * PURPOSE:
   * - Scroll entire match page to trigger lazy loading
   * - Ensure all outcomes are loaded into DOM
   * - Handle dynamic content and infinite scroll
   * 
   * REQUIREMENTS (from hotfix):
   * - MUST scroll entire page (top to bottom)
   * - MUST wait for elements to load (waitForLoadState)
   * - MUST handle dynamic content (infinite scroll)
   * 
   * @returns {Promise<void>}
   * 
   * @example
   * await this.scrollMatchPage();
   * // Now all outcomes are loaded and visible
   * const outcome = await page.locator(`text="${outcomeText}"`);
   */
  async scrollMatchPage() {
    throw new Error('NotImplementedError: scrollMatchPage() must be implemented by driver');
  }
  
  /**
   * ⚠️ REQUIRED: Handle odds change popup (Accept/Reject changes)
   * 
   * CRITICAL: Required when bookmaker shows "odds changed" dialog.
   * Without handling, 30% of bets fail when odds change mid-bet.
   * 
   * PURPOSE:
   * - Detect odds change popup (PRIHVATAM/Accept button)
   * - Check if new odds are acceptable (freshness check)
   * - Accept or reject based on checkFreshnessAfterOddsChange()
   * - Return new odds if accepted
   * 
   * REQUIREMENTS (from hotfix):
   * - MUST detect popup (PRIHVATAM/Accept button)
   * - MUST check if new odds are acceptable (freshness check)
   * - MUST click Accept if acceptable, Cancel otherwise
   * - MUST return new odds after accepting
   * 
   * @param {BetTask} task - Original task with expectedOdds
   * @param {Object} oddsResult - Current odds before change
   * @param {number} oddsResult.odds - Current odds value
   * @param {import('playwright').Locator} button - PRIHVATAM/Accept button element
   * @returns {Promise<Object>} Result object
   * @returns {boolean} returns.accepted - true if odds change accepted
   * @returns {number} [returns.newOdds] - New odds value (if accepted)
   * @returns {string} [returns.reason] - Reason for rejection (if not accepted)
   * 
   * @example
   * const prihvatamButton = await page.locator('text=PRIHVATAM');
   * if (await prihvatamButton.isVisible()) {
   *   const result = await this.handleOddsChange(task, oddsResult, prihvatamButton);
   *   if (result.accepted) {
   *     // Continue with new odds
   *     oddsResult.odds = result.newOdds;
   *   } else {
   *     // Reject and retry
   *     throw new Error(`Odds change rejected: ${result.reason}`);
   *   }
   * }
   */
  async handleOddsChange(task, oddsResult, button) {
    throw new Error('NotImplementedError: handleOddsChange() must be implemented by driver');
  }
  
  /**
   * ⚠️ REQUIRED: First freshness check (BEFORE submit)
   * 
   * CRITICAL: Prevents betting on stale odds.
   * STRICT rules: dataAge < 2000ms, ROI >= config.minROI
   * 
   * PURPOSE:
   * - Check if odds data is fresh enough to bet
   * - Verify ROI is still acceptable
   * - Reject if data is too old (strict check)
   * 
   * REQUIREMENTS (from hotfix):
   * - MUST check dataAge (time since last odds update)
   * - MUST check ROI (current vs expected)
   * - MUST be STRICT (no tolerance)
   * - MUST reject if data is stale (> 2s)
   * 
   * @param {BetTask} task - Task with expectedOdds, minROI
   * @param {number} task.expectedOdds - Expected odds from analyzer
   * @param {number} task.minROI - Minimum acceptable ROI
   * @param {Object} currentData - Current odds data with timestamp
   * @param {number} currentData.odds - Current odds value
   * @param {number} currentData.timestamp - Timestamp of odds (Date.now())
   * @returns {Promise<boolean>} true if fresh, false if stale
   * 
   * @example
   * const isFresh = await this.checkFreshnessBeforeSubmit(task, currentOdds);
   * if (!isFresh) {
   *   logger.warn('Data too old, aborting bet');
   *   throw new BetPlacementError('Stale data', 'freshness_check', 4);
   * }
   */
  async checkFreshnessBeforeSubmit(task, currentData) {
    throw new Error('NotImplementedError: checkFreshnessBeforeSubmit() must be implemented by driver');
  }
  
  /**
   * ⚠️ REQUIRED: Second freshness check (AFTER odds change)
   * 
   * CRITICAL: More relaxed than first check (odds just changed).
   * RELAXED rules: dataAge < 10000ms, ROI >= expectedROI * 0.9
   * 
   * PURPOSE:
   * - Check if new odds after change are acceptable
   * - More tolerant than checkFreshnessBeforeSubmit()
   * - Allow some ROI degradation (90% of expected)
   * 
   * REQUIREMENTS (from hotfix):
   * - MUST check dataAge (less strict: < 10s)
   * - MUST check ROI (with tolerance: 90% of expected)
   * - MUST be RELAXED (odds just changed, some tolerance OK)
   * - MUST accept if ROI still profitable (even if lower)
   * 
   * @param {BetTask} task - Task with expectedOdds, minROI
   * @param {number} task.expectedOdds - Expected odds from analyzer
   * @param {number} task.minROI - Minimum acceptable ROI
   * @param {Object} newOdds - Odds after change with new timestamp
   * @param {number} newOdds.odds - New odds value
   * @param {number} newOdds.timestamp - Timestamp of new odds (Date.now())
   * @returns {Promise<boolean>} true if acceptable, false otherwise
   * 
   * @example
   * // After odds change detected
   * const isAcceptable = await this.checkFreshnessAfterOddsChange(task, newOdds);
   * if (isAcceptable) {
   *   // Accept new odds
   *   await prihvatamButton.click();
   * } else {
   *   // Reject and retry from scratch
   *   await cancelButton.click();
   *   throw new Error('New odds not acceptable');
   * }
   */
  async checkFreshnessAfterOddsChange(task, newOdds) {
    throw new Error('NotImplementedError: checkFreshnessAfterOddsChange() must be implemented by driver');
  }
  
  /**
   * Perform health check on driver
   * 
   * PURPOSE:
   * - Verify bookmaker site is accessible
   * - Check login status
   * - Report driver status (active, idle, error)
   * 
   * WHEN CALLED:
   * - Periodically by monitoring (e.g., every 60 seconds)
   * - Before task execution
   * - On demand via API endpoint /health/<bookmakerId>
   * 
   * IMPLEMENTS: EXECUTOR-REQ-03 from Story 1.5
   * 
   * @returns {Promise<HealthStatus>} Health status object
   * 
   * @example
   * // Example implementation (Sansabet):
   * async healthCheck() {
   *   try {
   *     // Check if page is responsive
   *     const title = await this.page.title();
   *     if (!title) {
   *       return {
   *         ok: false,
   *         status: 'error',
   *         error: 'Page not responsive'
   *       };
   *     }
   *     
   *     // Check if logged in
   *     const loggedIn = await this.checkLoginStatus();
   *     
   *     return {
   *       ok: true,
   *       status: loggedIn ? 'active' : 'logged_out',
   *       lastActivity: Date.now(),
   *       uptime: Date.now() - this.startTime
   *     };
   *   } catch (error) {
   *     return {
   *       ok: false,
   *       status: 'error',
   *       error: error.message
   *     };
   *   }
   * }
   */
  async healthCheck() {
    throw new Error('NotImplementedError: Must be implemented by driver');
  }
  
  /**
   * Get list of supported outcome types
   * 
   * PURPOSE:
   * - Declare which outcome types this driver can handle
   * - Enable TasksManager to filter tasks by driver capabilities
   * - Document driver coverage for metrics (Story 1.4)
   * 
   * WHEN CALLED:
   * - Once at driver initialization
   * - By TasksManager when filtering tasks
   * 
   * IMPLEMENTS: DRIVER-REQ-03 from Story 1.5
   * 
   * OUTCOME TYPES (from Story 1.3 catalog):
   * - '1x2' — Match result (1, X, 2)
   * - 'totals' — Total goals/points (T> 2.5, T< 3.5)
   * - 'individual_totals' — Individual team totals (IT1> 1.5, IT2< 2.5)
   * - 'team_totals' — Team totals with team name (Team1 T> 1.5)
   * - 'handicap' — Handicaps (H1 -1.5, H2 +2.5)
   * - 'period' — Period bets (P1 T> 0.5, P2 1)
   * 
   * @returns {string[]} Array of supported outcome type identifiers
   * 
   * @example
   * // Example implementation (Sansabet - full support):
   * getSupportedOutcomes() {
   *   return [
   *     '1x2',
   *     'totals',
   *     'individual_totals',
   *     'team_totals',
   *     'handicap',
   *     'period'
   *   ];
   * }
   * 
   * @example
   * // Example implementation (SimpleBookmaker - partial support):
   * getSupportedOutcomes() {
   *   return [
   *     '1x2',
   *     'totals'
   *   ]; // Only basic outcomes supported
   * }
   */
  getSupportedOutcomes() {
    throw new Error('NotImplementedError: Must be implemented by driver');
  }
  
  /**
   * Cleanup driver resources
   * 
   * PURPOSE:
   * - Close browser/page
   * - Delete temporary files/screenshots
   * - Save state if needed
   * 
   * WHEN CALLED:
   * - On graceful system shutdown
   * - When driver is being replaced/restarted
   * - On unrecoverable errors
   * 
   * OPTIONAL: Driver may skip cleanup if no resources to release
   * 
   * @returns {Promise<void>}
   * 
   * @example
   * // Example implementation (Sansabet):
   * async cleanup() {
   *   this.logger.info('Cleaning up driver resources...');
   *   
   *   try {
   *     // Close page if open
   *     if (this.page && !this.page.isClosed()) {
   *       await this.page.close();
   *     }
   *     
   *     // Cleanup old screenshots
   *     if (this.screenshotManager) {
   *       const deleted = await this.screenshotManager.cleanup(72);
   *       this.logger.info(`Deleted ${deleted} old screenshots`);
   *     }
   *     
   *     this.logger.info('Cleanup complete');
   *   } catch (error) {
   *     this.logger.warn(`Cleanup error (non-critical): ${error.message}`);
   *   }
   * }
   */
  async cleanup() {
    // Optional: drivers may skip if no cleanup needed
  }
}

module.exports = { BookmakerAutomation, BetErrorCode, REQUIRED_MINIMUMS };
