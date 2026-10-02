/**
 * BetProcessor - Обработка одной попытки размещения ставки
 * 
 * Flow:
 * 0. Pre-checks (session, blocked, odds limits, Pinnacle odds filter)
 * 1. Find match
 * 2. Find outcome
 * 3. Check odds
 * 4. Determine stake + check limits
 * 5. Place bet
 */

/**
 * GOLDEN RULE: Единственная валидная причина отказа ставки — реальное
 * изменение коэффициента, подтверждённое в таблице bet_attempts.
 * ВСЕ остальные причины (odds mismatch, outcome not found, timeout) —
 * БАГ В НАШЕМ КОДЕ. Не списывай на "так и должно быть".
 */

const constants = require('../config/constants.js');
const { getResolvedSource, getTaskSourceKey, normalizeIdentifier } = require('../tasks/task-source.js');
const { getTaskLocalLimitOverrides } = require('../tasks/task-limits.js');
const { BetErrorTypes } = require('./BettorAdapter.js');

function resolveCurrency(context = {}) {
    return context.config?.currency || context.adapter?.currency || 'EUR';
}

class BetProcessor {
    constructor(options = {}) {
        this.adapter = options.adapter;
        this.freshDataManager = options.freshDataManager;
        this.limitsManager = options.limitsManager;
        this.tasksManager = options.tasksManager;
        this.telegram = options.telegram;
        this.calculator = options.calculator;
        this.logger = options.logger || console;
        this.config = options.config || {};
        this.bookmakerName = options.bookmakerName || 'Unknown';
        this.bettor = options.bettor;
        
        // Session cache
        this._lastSessionCheck = 0;
        this._lastSessionValid = false;
        this._sessionCacheTTL = constants.SESSION_CACHE_TTL_MS;
        
        // Analyzer availability
        this.analyzerAvailable = true;
    }

    _currency() {
        return resolveCurrency(this);
    }

    _captureAttemptDebug(eventType, payload = {}) {
        if (typeof this.adapter?.captureAttemptDebug !== 'function') {
            return;
        }
        try {
            this.adapter.captureAttemptDebug(eventType, payload);
        } catch (error) {
            this.logger.log(`⚠️ Attempt debug capture failed (${eventType}): ${error.message}`);
        }
    }
    
    // ==================== BALANCE CHECK ====================
    
    /**
     * Safe balance check - returns null if failed (fail-safe)
     */
    async _safeGetBalance() {
        try {
            const balance = await this.adapter.getBalance();
            if (Number.isFinite(balance) && balance >= 0) {
                return balance;
            }
            return null;
        } catch (e) {
            this.logger.log(`⚠️ Balance check failed: ${e.message}`);
            return null;
        }
    }
    
    /**
     * Check if balance is sufficient for the planned stake
     * @param {number} stake - The stake amount to place
     * Returns { ok: true } or { ok: false, balance, stake }
     */
    async _checkBalanceSufficient(stake) {
        const currency = resolveCurrency(this);
        if (this.config.dryRun) {
            this.logger.log(`🧪 [DRY RUN] Balance check skipped for stake ${stake.toFixed(2)} ${currency}`);
            this._captureAttemptDebug('balance_check_skipped_dry_run', { stake });
            return { ok: true, dryRun: true };
        }

        const balance = await this._safeGetBalance();
        
        // If balance check failed - continue (fail-safe)
        if (balance === null) {
            this.logger.log(`⚠️ Could not verify balance - continuing`);
            this._captureAttemptDebug('balance_check_unavailable', { stake });
            return { ok: true };
        }
        
        this.logger.log(`💰 Balance: ${balance.toFixed(2)} ${currency}, stake: ${stake.toFixed(2)} ${currency}`);
        this._captureAttemptDebug('balance_check', { balance, stake, sufficient: balance >= stake });
        
        if (balance < stake) {
            return { ok: false, balance, stake };
        }
        
        return { ok: true, balance };
    }

    _getTelegramStopRequest(task = {}) {
        const sourceMeta = getResolvedSource(task);
        if (!sourceMeta.isTelegram || !task.signalId || !this.tasksManager) {
            return null;
        }

        const bookmakerId = task.bookmakerId || normalizeIdentifier(this.bookmakerName) || null;
        const currentTask = bookmakerId ? this.tasksManager.getCurrentTask(bookmakerId) : null;
        const signalId = task.signalId || task.telegramContext?.signalId || null;
        if (!signalId) {
            return null;
        }

        const matchesSignal = (candidate) => candidate && (
            candidate.signalId === signalId ||
            candidate.telegramContext?.signalId === signalId
        );

        if (matchesSignal(currentTask) && currentTask.stopRequested) {
            return currentTask;
        }

        const found = this.tasksManager.findTaskBySignalId?.(signalId, bookmakerId);
        if (found?.task?.stopRequested) {
            return found.task;
        }

        return null;
    }

    _setTelegramExecutionState(task = {}, executionState) {
        const sourceMeta = getResolvedSource(task);
        if (!sourceMeta.isTelegram || !task?.id || !this.tasksManager || !executionState) {
            return;
        }

        task.executionState = executionState;
        if (typeof this.tasksManager.setTaskExecutionState === 'function') {
            this.tasksManager.setTaskExecutionState(task.id, executionState);
            return;
        }

        this.tasksManager.updateTaskById?.(task.id, {
            executionState,
            executionStateUpdatedAt: Date.now()
        });
    }

    _balanceCheckMode() {
        return String(this.config.balanceCheckMode || 'processor').trim().toLowerCase();
    }

    _usesBookmakerSubmitBalanceCheck() {
        return this._balanceCheckMode() === 'bookmaker-submit';
    }

    _annotateBookmakerBalanceReject(task = {}, betResult = {}) {
        if (!betResult || betResult.success || typeof this.adapter?.parseError !== 'function') {
            return false;
        }

        const errorInfo = this.adapter.parseError(betResult);
        if (errorInfo?.type !== BetErrorTypes.INSUFFICIENT_BALANCE) {
            return false;
        }

        betResult.failureClass = 'insufficient_balance';
        betResult.failureStage = 'bookmaker_submit';
        betResult.submitReached = true;
        task._lastError = betResult.error || betResult.message || betResult.msg || 'Insufficient balance';
        task._lastFailureStep = 'insufficient_balance';
        task._lastFailureStage = 'bookmaker_submit';
        return true;
    }
    
    /**
     * Process a single bet attempt - full flow
     * @param {Object} task - Task with all bet details
     * @returns {Promise<{success: boolean, shouldRetry?: boolean}>}
     */
    async process(task) {
        // Initialize switch counter for this attempt
        task._switchCount = task._switchCount || 0;
        const t0 = Date.now();
        const _t = (label) => `${label} [+${Date.now() - t0}ms]`;
        const currency = resolveCurrency(this);
        
        this.logger.log(`\n${'═'.repeat(60)}`);
        this.logger.log(`🎯 BET ATTEMPT: ${task.home} vs ${task.away} | ${task.outcome} @ ${task.expectedOdds} | ROI ${task.expectedROI?.toFixed(2)}%`);
        this.logger.log(`   📋 Sport: ${task.pair?.sportName || '?'} | Type: ${task.type} | Mode: ${task.pair?.second?.isPrematch ? 'prematch' : 'live'}`);
        this.logger.log(`   📊 Pinnacle: ${task.pinnacleOdds || '?'} | Bookmaker: ${task.expectedOdds || '?'} | Margin: ${task.pair?.margin?.toFixed(3) || '?'}`);
        this.logger.log(`${'═'.repeat(60)}`);
        this._captureAttemptDebug('processor_started', {
            taskId: task.id || null,
            home: task.home,
            away: task.away,
            outcome: task.outcome,
            expectedOdds: task.expectedOdds || null,
            expectedROI: task.expectedROI || null,
            isPrematch: !!task.isPrematch,
            sourceType: task.sourceType || null,
            signalId: task.signalId || null,
            bookmakerMatchId: task.bookmakerMatchId || null
        });
        
        try {
            // 0. Pre-checks
            this._setTelegramExecutionState(task, 'pre_checks');
            this.logger.log(_t('▶ Step 0: Pre-checks'));
            const preCheckResult = await this._runPreChecks(task);
            if (!preCheckResult.ok) {
                this._captureAttemptDebug('pre_checks_failed', {
                    result: preCheckResult.result || null,
                    reason: task._lastError || null
                });
                this.logger.log(_t('✖ Step 0: Pre-checks FAILED'));
                return preCheckResult.result;
            }
            this.logger.log(_t('✔ Step 0: Pre-checks OK'));

            const minStake = task.minStake || task.stake || this.config.stake || constants.DEFAULT_STAKE;
            const bookmakerSubmitBalanceCheck = this._usesBookmakerSubmitBalanceCheck();

            // 0.5. Early balance check (before expensive operations)
            // Uses config stake as minimum — if can't afford min stake, skip everything.
            // Sandbox smoke tests can defer this to bookmaker submit to prove match/outcome/cart.
            if (bookmakerSubmitBalanceCheck) {
                this.logger.log(_t('⏭ Step 0.5: Early balance check skipped (balanceCheckMode=bookmaker-submit)'));
            } else {
                this.logger.log(_t('▶ Step 0.5: Early balance check'));
                const earlyBalanceCheck = await this._checkBalanceSufficient(minStake);
                if (!earlyBalanceCheck.ok) {
                    const msg = `Insufficient balance: ${earlyBalanceCheck.balance?.toFixed(2)} < ${minStake.toFixed(2)} ${currency} (min stake)`;
                    task._lastError = msg;
                    task._lastFailureStep = 'insufficient_balance';
                    this.logger.log(_t(`✖ Step 0.5: ${msg}`));

                    try {
                        const bookmaker = task.pairFull?.second?.bookmaker || this.bookmakerName;
                        await this.telegram?.sendToAll(
                            `🚫 НЕДОСТАТОЧНО СРЕДСТВ!\n\n` +
                            `💰 Баланс: ${earlyBalanceCheck.balance?.toFixed(2)} ${currency}\n` +
                            `📊 Мин. ставка: ${minStake.toFixed(2)} ${currency}\n` +
                            `⏸️ Пауза: 15 минут\n\n` +
                            `Пополните баланс для продолжения работы.`,
                            { bookmaker, parse_mode: null }
                        );
                    } catch (e) {}

                    if (this.bettor?.pauseFor && !this.config.disableBalancePause) {
                        this.bettor.pauseFor(15, msg);
                    }

                    return { success: false, shouldRetry: false, step: 'insufficient_balance', message: msg };
                }
                this.logger.log(_t(`✔ Step 0.5: Balance OK (${earlyBalanceCheck.balance?.toFixed(2)} ${currency})`));
            }

            // 1. Find match
            this._setTelegramExecutionState(task, 'finding_match');
            this.logger.log(_t('▶ Step 1: Find match'));
            const matchResult = await this._findMatch(task);
            if (!matchResult.success) {
                this._captureAttemptDebug('match_resolution_failed', {
                    error: matchResult.error,
                    bookmakerMatchId: task.bookmakerMatchId || null,
                    home: task.home,
                    away: task.away,
                    sport: task.pair?.sportName || 'soccer'
                });
                // Prematch pair for a match that went live — skip silently, don't count as attempt
                if (matchResult.error === 'prematch_pair_is_live') {
                    this.logger.log(_t('⚡ Prematch data stale (match went live), skipping'));
                    if (!this.config.tgQuiet) { try { await this.telegram?.notifySkipped(task, 'Матч ушёл в лайв (prematch stale)'); } catch(e) {} }
                    return { success: false, shouldRetry: false, skipCount: true };
                }
                this.logger.log(_t(`✖ Step 1: Match not found — ${matchResult.error}`));
                if (!this.config.tgQuiet) await this._notifyFailed(task, matchResult.error, 'team_search');
                return { success: false, shouldRetry: false };
            }
            const match = matchResult.match;
            this._captureAttemptDebug('match_resolved', {
                matchId: match.Id || match.id || match.matchId || null,
                bookmakerMatchId: task.bookmakerMatchId || null,
                fromASP: !!match._fromASP,
                marketCount: Array.isArray(match.markets) ? match.markets.length : Array.isArray(match.M) ? match.M.length : null,
                home: match.home || null,
                away: match.away || null
            });
            this.logger.log(_t('✔ Step 1: Match found'));

            // 2. Find outcome + 3. Check odds (with switch logic)
            this._setTelegramExecutionState(task, 'finding_outcome');
            this.logger.log(_t('▶ Step 2-3: Find outcome + validate odds'));
            const outcomeResult = await this._findAndValidateOutcome(task, match);
            if (!outcomeResult.success) {
                this._captureAttemptDebug('outcome_resolution_failed', {
                    result: outcomeResult.result || null,
                    lastError: task._lastError || null
                });
                this.logger.log(_t('✖ Step 2-3: Outcome validation FAILED'));
                return outcomeResult.result;
            }
            let outcome = outcomeResult.outcome;  // let - may be reassigned after freshness check
            this._captureAttemptDebug('outcome_resolved', {
                pick: outcome.pick,
                odds: outcome.oddVal,
                selectionId: outcome.selectionId || outcome.selection?.N || null,
                marketLine: outcome.sbv || outcome.market?.B || null
            });
            this.logger.log(_t(`✔ Step 2-3: Outcome OK — ${outcome.pick} @ ${outcome.oddVal}`));

            // 4. Determine stake + check limits
            this._setTelegramExecutionState(task, 'determining_stake');
            this.logger.log(_t('▶ Step 4: Stake + limits'));
            const stakeResult = await this._determineStake(task);
            if (!stakeResult.success) {
                this.logger.log(_t('✖ Step 4: Limits check FAILED'));
                return { success: false, shouldRetry: false };
            }
            const { stake, strategy, source } = stakeResult;
            this._captureAttemptDebug('stake_determined', { stake, strategy, source });
            this.logger.log(_t(`✔ Step 4: Stake=${stake} ${currency}, strategy=${strategy}`));

            // 4.5. Final balance check with actual stake (may differ from min stake checked at 0.5)
            if (bookmakerSubmitBalanceCheck) {
                this.logger.log(_t('⏭ Step 4.5: Processor balance check deferred to bookmaker submit'));
            } else if (stake > minStake) {
                this.logger.log(_t(`▶ Step 4.5: Re-check balance for actual stake ${stake} ${currency}`));
                const balanceCheck = await this._checkBalanceSufficient(stake);
                if (!balanceCheck.ok) {
                    const msg = `Insufficient balance for actual stake: ${balanceCheck.balance?.toFixed(2)} < ${stake.toFixed(2)} ${currency}`;
                    task._lastError = msg;
                    task._lastFailureStep = 'insufficient_balance';
                    this.logger.log(_t(`✖ Step 4.5: ${msg}`));
                    
                    try {
                        const bookmaker = task.pairFull?.second?.bookmaker || this.bookmakerName;
                        await this.telegram?.sendToAll(
                            `🚫 НЕДОСТАТОЧНО СРЕДСТВ!\n\n` +
                            `💰 Баланс: ${balanceCheck.balance?.toFixed(2)} ${currency}\n` +
                            `📊 Ставка: ${stake.toFixed(2)} ${currency}\n` +
                            `⏸️ Пауза: 15 минут\n\n` +
                            `Пополните баланс для продолжения работы.`,
                            { bookmaker, parse_mode: null }
                        );
                    } catch (e) {}
                    
                    if (this.bettor?.pauseFor && !this.config.disableBalancePause) {
                        this.bettor.pauseFor(15, msg);
                    }
                    
                    return { success: false, shouldRetry: false, step: 'insufficient_balance', message: msg };
                }
                this.logger.log(_t(`✔ Step 4.5: Balance OK (${balanceCheck.balance?.toFixed(2)} ${currency})`));
            } else {
                this.logger.log(_t('✔ Step 4.5: Balance already verified at step 0.5'));
            }

            // 4.9. FRESHNESS CHECK — DISABLED
            // Kept disabled to preserve the existing analyzer/task flow.
            /*
            this.logger.log(_t('▶ Step 4.9: Final freshness check'));
            const freshnessResult = await this._ensureDataFresh(task, outcome);
            if (!freshnessResult.ok) {
                this.logger.log(_t(`✖ Step 4.9: ${freshnessResult.reason} - ABORTING bet`));
                if (!this.config.tgQuiet) await this._notifyFailed(task, freshnessResult.reason, 'data_stale');
                return { success: false, shouldRetry: false };
            }
            this.logger.log(_t('✔ Step 4.9: Data fresh'));
            
            // If outcome changed during freshness wait, refind on bookmaker
            if (freshnessResult.outcomeChanged) {
                this.logger.log(_t('▶ Step 4.9b: Refinding outcome after change'));
                const newOutcomeResult = await this._findAndValidateOutcome(task, match);
                if (!newOutcomeResult.success) {
                    return newOutcomeResult.result;
                }
                outcome = newOutcomeResult.outcome;
                this.logger.log(_t(`✔ Step 4.9b: New outcome — ${outcome.pick} @ ${outcome.oddVal}`));
            }
            */

            // 4.92. Pre-fetch bookmaker data (balance + tip details) before placement
            if (this.adapter.prepareBet) {
                this._setTelegramExecutionState(task, 'preparing_bet');
                this.logger.log(_t('▶ Step 4.92: Preparing bet data'));
                await this.adapter.prepareBet({ outcome, match });
                this.logger.log(_t('✔ Step 4.92: Bet data prepared'));
            }

            this._setTelegramExecutionState(task, 'pre_submit');
            const stopRequest = this._getTelegramStopRequest(task);
            if (stopRequest) {
                const message = 'Telegram STOP requested before submit';
                task._lastError = message;
                this.logger.log(_t(`🛑 Step 4.96: ${message}`));
                if (!this.config.tgQuiet) {
                    await this.telegram?.notifySkipped(task, 'STOP принят до отправки ставки');
                }
                return {
                    success: false,
                    shouldRetry: false,
                    cancelled: true,
                    step: 'telegram_stop',
                    message
                };
            }

            // 5. Place bet
            this._setTelegramExecutionState(task, 'submit_started');
            this._captureAttemptDebug('submit_started', {
                stake,
                pick: outcome.pick,
                odds: outcome.oddVal,
                selectionId: outcome.selectionId || outcome.selection?.N || null,
                matchId: match.Id || match.id || match.matchId || null
            });
            this.logger.log(_t(`▶ Step 5: Place bet — ${stake} ${currency} on ${outcome.pick} @ ${outcome.oddVal}`));
            
            if (this.config.dryRun) {
                this.logger.log(_t('[DRY RUN] Would place bet'));
                return await this._handleBetResult(task, outcome, stake, strategy, source, {
                    success: true,
                    dryRun: true,
                    odds: outcome.oddVal,
                    ticketId: 'dry-run'
                });
            }

            let betResult = await this.adapter.placeBet({ outcome, stake, match, task });
            this._annotateBookmakerBalanceReject(task, betResult);
            
            // Singles blocked — check alternatives immediately, don't waste time waiting
            if (betResult.singlesBlocked) {
                const telegramSinglesFallback = await this._retryTelegramCandidateAfterSinglesBlocked({
                    task,
                    match,
                    stake
                });
                if (telegramSinglesFallback) {
                    outcome = telegramSinglesFallback.outcome;
                    betResult = telegramSinglesFallback.betResult;
                    this._annotateBookmakerBalanceReject(task, betResult);
                    this.logger.log(_t(`${betResult.success ? '✔' : '✖'} Step 5a: Singles fallback ${betResult.success ? 'PLACED' : 'FAILED'} — ${outcome.pick} @ ${outcome.oddVal}`));
                }
            }

            if (betResult.singlesBlocked) {
                // Check for alternatives RIGHT NOW before waiting for analyzer
                if (!task._triedOutcomes) task._triedOutcomes = new Set();
                task._triedOutcomes.add(task.outcome);
                // Merge outcomes that recently failed for this match (prevents circular switching across tasks)
                const recentFailed = this.tasksManager?.getRecentlyFailedOutcomes?.(task.matchKey) || new Set();
                for (const o of recentFailed) task._triedOutcomes.add(o);
                const currentOutcomes = this.freshDataManager._getMatchOutcomesRaw(task.freshDataMatchKey);
                const alternatives = (currentOutcomes || []).filter(o =>
                    !task._triedOutcomes.has(o.outcome) &&
                    o.roi >= this.config.minROI &&
                    o.score1 >= (this.config.minOdds || 1.1) &&
                    o.score1 <= (this.config.maxOdds || 4)
                );

                if (alternatives.length === 0) {
                    this.logger.log(`🛑 Singles blocked for "${task.outcome}" — no alternatives available, ending attempt`);
                    if (!this.config.tgQuiet) await this._notifyFailed(task, 'Singles blocked, no alternative outcomes', 'singles_blocked');
                    return { success: false, shouldRetry: false };
                }

                this.logger.log(`🔄 Singles blocked for "${task.outcome}" — ${alternatives.length} alternative(s) found, switching...`);
                try {
                    if (!this.config.tgQuiet) await this._sendTaskUpdate(
                        task,
                        `⚠️ <b>SINGLES BLOCKED</b>\n\n` +
                        `📋 ${this.telegram.escapeHtml(task.home)} vs ${this.telegram.escapeHtml(task.away)}\n` +
                        `🎯 Исход: <code>${this.telegram.escapeHtml(task.outcome)}</code>\n` +
                        `🔄 Переключение на ${alternatives.length} альтернатив(ы)...`
                    );
                } catch (e) {}
                
                const switchResult = await this._waitForUpdateAndSwitch(task, match, 'singles_blocked');
                if (switchResult.success) {
                    outcome = switchResult.outcome;
                    this.logger.log(_t(`✔ Step 5b: Switched to ${outcome.pick} @ ${outcome.oddVal}`));
                    // Re-prepare and place bet with new outcome
                    if (typeof this.adapter.prepareBet === 'function') {
                        await this.adapter.prepareBet({ outcome, match });
                    }
                    betResult = await this.adapter.placeBet({ outcome, stake, match, task });
                    if (betResult.singlesBlocked) {
                        this.logger.log(`❌ Singles also blocked for switched outcome — aborting`);
                        if (!this.config.tgQuiet) await this._notifyFailed(task, 'Singles blocked for all outcomes', 'singles_blocked');
                        return { success: false, shouldRetry: false };
                    }
                } else {
                    if (!this.config.tgQuiet) await this._notifyFailed(task, 'Singles blocked, no alternative outcome found', 'singles_blocked');
                    return { success: false, shouldRetry: false };
                }
            }

            const telegramSubmitFallback = await this._retryTelegramCandidateAfterSubmit({
                task,
                match,
                outcome,
                stake,
                betResult
            });
            if (telegramSubmitFallback) {
                outcome = telegramSubmitFallback.outcome;
                betResult = telegramSubmitFallback.betResult;
                if (betResult.success) {
                    this.logger.log(_t(`✔ Step 5b: Submit fallback PLACED — ${outcome.pick} @ ${outcome.oddVal}`));
                } else {
                    this.logger.log(_t(`✖ Step 5b: Submit fallback FAILED — ${outcome.pick} @ ${outcome.oddVal}`));
                }
            }
            this._captureAttemptDebug('submit_result', {
                success: !!betResult.success,
                error: betResult.error || null,
                ticketId: betResult.ticketId || null,
                odds: betResult.odds || outcome.oddVal || null,
                stake: betResult.stake || stake,
                singlesBlocked: !!betResult.singlesBlocked,
                oddsChanged: !!betResult.oddsChanged,
                sessionExpired: !!betResult.sessionExpired
            });
            
            this.logger.log(_t(`${betResult.success ? '✔' : '✖'} Step 5: Bet ${betResult.success ? 'PLACED' : 'FAILED'}`));
            this.logger.log(_t(`⏱️ TOTAL TIME: ${Date.now() - t0}ms`));

            return await this._handleBetResult(task, outcome, stake, strategy, source, betResult);

        } catch (e) {
            this._captureAttemptDebug('processor_exception', {
                message: e.message,
                stack: e.stack || null,
                lastError: task._lastError || null
            });
            this.logger.error(`Bet attempt error: ${e.message}`);
            if (!this.config.tgQuiet) await this._notifyFailed(task, e.message, 'bet_attempt_exception');
            
            if (e.message.includes('401')) {
                this.logger.log('🔄 Got 401, attempting re-login...');
                try {
                    const loginOk = await this.adapter.login();
                    if (loginOk) this.logger.log('✅ Re-login successful, will retry');
                } catch (loginErr) {}
            }
            
            return { success: false, shouldRetry: false };
        }
    }
    
    // ==================== PRE-CHECKS ====================
    
    async _runPreChecks(task) {
        // Session check
        const sessionOk = await this._checkSession();
        if (!sessionOk) {
            if (!this.config.tgQuiet) await this._notifyFailed(task, 'Session expired and re-login failed', 'pre_flight_check');
            return { ok: false, result: { success: false, shouldRetry: false } };
        }

        // Match blocked check (any 3 failures on the match)
        if (this.tasksManager?.isMatchBlocked(task.matchKey)) {
            this.logger.log(`🚫 Match blocked (3 failures). Skipping.`);
            if (!this.config.tgQuiet) { try { await this.telegram?.notifySkipped(task, 'Матч заблокирован (3 неудачи)'); } catch(e) {} }
            return { ok: false, result: { success: false, shouldRetry: false } };
        }

        // Pinnacle odds range filter (early rejection before any work)
        // NOTE: Only Pinnacle odds are filtered — bookmaker odds can be any value
        if (!this.config.ignoreOddsLimits && task.pinnacleOdds) {
            const pMinOdds = this.config.pinnacleMinOdds ?? constants.PINNACLE_MIN_ODDS;
            const pMaxOdds = this.config.pinnacleMaxOdds ?? constants.PINNACLE_MAX_ODDS;
            if (task.pinnacleOdds < pMinOdds) {
                const msg = `Pinnacle odds too low: ${task.pinnacleOdds} < ${pMinOdds} (min)`;
                this.logger.log(`⚠️ ${msg} - SKIPPING`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, msg, 'pinnacle_odds_filter');
                return { ok: false, result: { success: false, shouldRetry: false } };
            }
            if (task.pinnacleOdds > pMaxOdds) {
                const msg = `Pinnacle odds too high: ${task.pinnacleOdds} > ${pMaxOdds} (max)`;
                this.logger.log(`⚠️ ${msg} - SKIPPING`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, msg, 'pinnacle_odds_filter');
                return { ok: false, result: { success: false, shouldRetry: false } };
            }
            this.logger.log(`✅ Pinnacle odds filter passed: ${task.pinnacleOdds} (${pMinOdds}-${pMaxOdds})`);
        }

        // EARLY local limits check (before Telegram notification)
        // This prevents "ЗАДАЧА ПОЛУЧЕНА" followed by silent skip
        // Infinity stake = skip stake adjustment, but catch "Already bet" and "Match limit"
        if (this.limitsManager && task.matchKey) {
            const source = getTaskSourceKey(task, { highROIThreshold: this.config.highROIThreshold });
            const localCheck = this.limitsManager.checkLocalLimits(
                task.matchKey,
                source,
                Infinity,
                getTaskLocalLimitOverrides(task)
            );
            if (!localCheck.allowed) {
                this.logger.log(`⚠️ ${localCheck.reason}. Skipping (early check).`);
                task._lastError = localCheck.reason;
                if (!this.config.tgQuiet) { try { await this.telegram?.notifySkipped(task, localCheck.reason); } catch(e) {} }
                return { ok: false, result: { success: false, shouldRetry: false } };
            }
        }

        // Send telegram start
        if (task._sendTelegramStart) {
            try { 
                if (!this.config.tgQuiet) await this.telegram?.notifyTaskStarted(task); 
                task._telegramStartSent = true;  // Mark that "ЗАДАЧА ПОЛУЧЕНА" was actually sent
            } catch (e) {}
        }

        return { ok: true };
    }
    
    // ==================== FIND AND VALIDATE OUTCOME ====================
    
    /**
     * Найти исход и проверить коэффициент.
     * При проблемах - ждём обновление анализатора (макс 3 переключения).
     */
    async _findAndValidateOutcome(task, match) {
        const sourceMeta = getResolvedSource(task);
        if (sourceMeta.isTelegram) {
            return this._findAndValidateTelegramOutcome(task, match);
        }

        this.logger.log(`🎯 Finding outcome: ${task.outcome} (expected odds: ${task.expectedOdds || 'N/A'})`);
        
        let outcome = await this._findOutcomeOnBookmaker(task, match, task.outcome, task.expectedOdds);
        
        // Если нашли - проверяем коэффициент
        if (outcome) {
            this.logger.log(`✅ Selection found: ${outcome.pick} @ ${outcome.oddVal}`);
            
            const oddsDiff = outcome.oddVal - task.expectedOdds;
            const absDiff = Math.abs(oddsDiff);
            this.logger.log(`   📊 ODDS CHECK: expected=${task.expectedOdds}, found=${outcome.oddVal}, diff=${absDiff.toFixed(4)}, tolerance=${constants.ODDS_TOLERANCE}`);
            
            if (absDiff <= constants.ODDS_TOLERANCE) {
                this.logger.log(`   ✅ ODDS MATCH: diff ${absDiff.toFixed(4)} <= tolerance ${constants.ODDS_TOLERANCE}`);
                return { success: true, outcome };
            }
            
            // Коэффициент не совпадает — ждём обновление от анализатора
            this.logger.log(`⚠️ Odds mismatch: expected ${task.expectedOdds}, got ${outcome.oddVal} (Δ${absDiff.toFixed(3)}, ${oddsDiff > 0 ? 'UP' : 'DOWN'})`);
            this.logger.log(`   📊 MISMATCH DEBUG: task.expectedOdds=${task.expectedOdds} (from analyzer at task creation)`);
            this.logger.log(`   📊 MISMATCH DEBUG: outcome.oddVal=${outcome.oddVal} (from bookmaker API NOW)`);
            this.logger.log(`   📊 MISMATCH DEBUG: tolerance=${constants.ODDS_TOLERANCE}, diff=${absDiff.toFixed(4)}`);
            // Odds mismatch: use convergence loop instead of switch
            return await this._waitForOddsConvergence(task, match, outcome.oddVal);
        }
        
        // Selection not found — market closed on bookmaker
        const betNum = task.outcomeData?.score2?.raw?.bet_num;
        this.logger.log(`❌ Selection not found (bet_num=${betNum || 'none'}) — market closed`);
        if (!this.config.tgQuiet) await this._notifyFailed(task, `Market closed: selection not found (bet_num=${betNum || 'none'})`, 'market_closed');
        return { success: false, result: { success: false, shouldRetry: false } };
    }

    async _findAndValidateTelegramOutcome(task, match) {
        const candidates = this._getTelegramOutcomeCandidates(task);
        const range = this._getTelegramOddsRange(task);

        this.logger.log(`🎯 [TG] Finding outcome candidates (${candidates.length}) for ${task.home} vs ${task.away}`);
        const closedMatchResult = await this._failTelegramIfMatchFinished(task, match);
        if (closedMatchResult) {
            return closedMatchResult;
        }
        const resolution = await this._resolveTelegramOutcomeCandidates(task, match, { candidates, range });
        if (resolution.success) {
            return { success: true, outcome: resolution.outcome };
        }

        if (resolution.rejectedByOdds.length > 0) {
            const rejectedByOdds = resolution.rejectedByOdds;
            const attempted = rejectedByOdds
                .map((entry) => `${entry.outcome} @ ${entry.odds}`)
                .join(', ');
            const msg = `No telegram candidate within odds range ${range.minOdds}-${range.maxOdds ?? '∞'} (${attempted})`;
            this.logger.log(`❌ [TG] ${msg}`);
            task._lastError = msg;
            if (!this.config.tgQuiet) {
                await this._notifyFailed(task, msg, 'odds_validation');
            }
            return { success: false, result: { success: false, shouldRetry: false, step: 'odds_validation' } };
        }

        if (!resolution.foundSelection) {
            const recheckResult = await this._retryTelegramOutcomeAvailability(task, match);
            if (recheckResult) {
                return recheckResult;
            }
        }

        const msg = resolution.foundSelection
            ? 'Telegram candidates were found but could not be validated'
            : `No telegram candidates found on bookmaker (${candidates.map((candidate) => candidate.outcome).filter(Boolean).join(', ') || 'empty'})`;
        this.logger.log(`❌ [TG] ${msg}`);
        task._lastError = msg;
        if (!this.config.tgQuiet) {
            await this._notifyFailed(task, msg, 'outcome_not_found');
        }
        return { success: false, result: { success: false, shouldRetry: false, step: 'outcome_not_found' } };
    }

    _rememberOriginalOutcome(task = {}) {
        if (!task._originalOutcome && task.outcome) {
            task._originalOutcome = task.outcome;
        }
    }

    _getTelegramOutcomeCandidates(task) {
        const candidates = [];
        const seen = new Set();
        const hasExactBetNum = Number.isFinite(Number(task.outcomeData?.score2?.raw?.bet_num));
        const explicitCandidates = this._getTelegramExplicitOutcomeCandidates(task);
        const push = (candidate = {}, fallbackReason = 'candidate') => {
            const outcome = candidate.outcome || candidate.normalizedOutcome || null;
            if (!outcome || seen.has(outcome)) {
                return;
            }
            seen.add(outcome);
            candidates.push({
                ...candidate,
                outcome,
                reason: candidate.reason || fallbackReason
            });
        };

        push({ outcome: task.outcome, reason: 'primary_task_outcome', priority: 0 });

        for (const candidate of explicitCandidates) {
            push(candidate, candidate.reason || 'explicit_outcome_candidate');
        }

        if (hasExactBetNum) {
            return candidates;
        }

        const ladder = Array.isArray(task.candidateLadder) ? task.candidateLadder : [];
        for (const candidate of ladder) {
            push(typeof candidate === 'string' ? { outcome: candidate } : candidate, 'candidate_ladder');
        }

        return candidates;
    }

    _getTelegramExplicitOutcomeCandidates(task = {}) {
        const candidates = [];
        const rawCandidates = Array.isArray(task.outcomeCandidates)
            ? task.outcomeCandidates
            : (Array.isArray(task.telegramContext?.outcomeCandidates)
                ? task.telegramContext.outcomeCandidates
                : []);
        for (const candidate of rawCandidates) {
            candidates.push(typeof candidate === 'string'
                ? { outcome: candidate, reason: 'explicit_outcome_candidate' }
                : candidate);
        }
        return candidates;
    }

    _getTelegramOddsRange(task) {
        return {
            minOdds: task.minOdds ??
                task.telegramPolicy?.minOdds ??
                task.sourcePolicy?.minOdds ??
                1.7,
            maxOdds: task.maxOdds ??
                task.telegramPolicy?.maxOdds ??
                task.sourcePolicy?.maxOdds ??
                null
        };
    }

    _isTelegramOddsAllowed(range, odds) {
        if (!Number.isFinite(odds)) {
            return false;
        }

        if (Number.isFinite(range.minOdds) && odds < range.minOdds) {
            return false;
        }

        if (Number.isFinite(range.maxOdds) && odds > range.maxOdds) {
            return false;
        }

        return true;
    }

    _getTelegramLadderCandidates(task = {}) {
        const ladder = Array.isArray(task.candidateLadder) ? task.candidateLadder : [];
        const candidates = [];
        const seen = new Set();
        for (let index = 0; index < ladder.length; index++) {
            const rawCandidate = ladder[index];
            const candidate = typeof rawCandidate === 'string'
                ? { outcome: rawCandidate }
                : (rawCandidate || {});
            const outcome = candidate.outcome || candidate.normalizedOutcome || null;
            if (!outcome || seen.has(outcome)) {
                continue;
            }
            seen.add(outcome);
            candidates.push({
                ...candidate,
                outcome,
                priority: Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : index,
                reason: candidate.reason || 'candidate_ladder'
            });
        }
        return candidates;
    }

    _getTelegramSubmitFallbackCandidates(task = {}) {
        const ladderCandidates = this._getTelegramLadderCandidates(task);
        if (ladderCandidates.length === 0) {
            return [];
        }

        const currentOutcome = String(task.selectedCandidate?.outcome || task.outcome || '').trim();
        let currentPriority = Number.isFinite(Number(task.selectedCandidate?.priority))
            ? Number(task.selectedCandidate.priority)
            : null;

        if (!Number.isFinite(currentPriority)) {
            const selectedCandidate = ladderCandidates.find((candidate) => candidate.outcome === currentOutcome);
            currentPriority = selectedCandidate ? selectedCandidate.priority : null;
        }

        if (!Number.isFinite(currentPriority)) {
            return [];
        }

        const triedOutcomes = task._telegramSubmitFallbackTriedOutcomes instanceof Set
            ? task._telegramSubmitFallbackTriedOutcomes
            : new Set();
        if (currentOutcome) {
            triedOutcomes.add(currentOutcome);
        }
        task._telegramSubmitFallbackTriedOutcomes = triedOutcomes;

        return ladderCandidates.filter((candidate) =>
            candidate.priority > currentPriority &&
            !triedOutcomes.has(candidate.outcome)
        );
    }

    _isTelegramMaxStakeSubmitFailure(task = {}, betResult = {}) {
        const sourceMeta = getResolvedSource(task);
        if (!sourceMeta.isTelegram || task.pinnacleOdds) {
            return false;
        }
        if (!betResult || betResult.success || betResult.singlesBlocked) {
            return false;
        }

        const errorText = String(betResult.error || betResult.msg || betResult.text || '').toLowerCase();
        return errorText.includes('maksimalna uplata') ||
            errorText.includes('maximalna uplata') ||
            errorText.includes('maximum stake') ||
            errorText.includes('max stake') ||
            errorText.includes('maximum bet');
    }

    async _retryTelegramCandidateAfterSinglesBlocked({ task, match, stake }) {
        const sourceMeta = getResolvedSource(task);
        if (!sourceMeta.isTelegram) {
            return null;
        }

        const candidates = this._getTelegramSubmitFallbackCandidates(task);
        if (candidates.length === 0) {
            return null;
        }

        this.logger.log(`ℹ️ [TG] Singles blocked for "${task.outcome}" — trying ${candidates.length} ladder fallback(s)`);
        const range = this._getTelegramOddsRange(task);

        for (const candidate of candidates) {
            const resolved = await this._resolveTelegramOutcomeCandidates(task, match, {
                candidates: [candidate],
                range
            });
            if (!resolved.success || !resolved.outcome) {
                continue;
            }

            const switchedOutcome = resolved.outcome;
            if (typeof this.adapter.prepareBet === 'function') {
                await this.adapter.prepareBet({ outcome: switchedOutcome, match });
            }

            const betResult = await this.adapter.placeBet({ outcome: switchedOutcome, stake, match, task });
            if (!betResult.singlesBlocked) {
                return {
                    outcome: switchedOutcome,
                    betResult
                };
            }

            this.logger.log(`⚠️ [TG] Singles also blocked for ladder fallback "${candidate.outcome}"`);
        }

        return null;
    }

    async _retryTelegramCandidateAfterSubmit({ task, stake, betResult }) {
        if (!this._isTelegramMaxStakeSubmitFailure(task, betResult)) {
            return null;
        }

        this.logger.log(
            `ℹ️ [TG] Max stake rejection for "${task.outcome}" — not switching ladder candidates because the bookmaker already refused ${stake} ${resolveCurrency(this)} on this ticket`
        );
        return null;
    }

    async _resolveTelegramOutcomeCandidates(task, match, options = {}) {
        const candidates = Array.isArray(options.candidates) ? options.candidates : this._getTelegramOutcomeCandidates(task);
        const range = options.range || this._getTelegramOddsRange(task);
        const rejectedByOdds = [];
        let foundSelection = false;

        for (const candidate of candidates) {
            if (!candidate?.outcome) {
                continue;
            }

            const outcome = await this._findOutcomeOnBookmaker(task, match, candidate.outcome, null);
            if (!outcome) {
                continue;
            }

            foundSelection = true;
            const odds = Number(outcome.oddVal);
            if (!this._isTelegramOddsAllowed(range, odds)) {
                rejectedByOdds.push({
                    outcome: candidate.outcome,
                    odds,
                    reason: candidate.reason || 'candidate'
                });
                this.logger.log(`⚠️ [TG] Candidate rejected by odds: ${candidate.outcome} @ ${odds} (range ${range.minOdds}-${range.maxOdds ?? '∞'})`);
                continue;
            }

            if (task.outcome !== candidate.outcome) {
                this._rememberOriginalOutcome(task);
                this.logger.log(`🔄 [TG] Candidate selected: ${task.outcome} → ${candidate.outcome} (${candidate.reason || 'ladder'})`);
                task.outcome = candidate.outcome;
            }

            task.selectedCandidate = {
                outcome: candidate.outcome,
                reason: candidate.reason || 'candidate',
                priority: candidate.priority ?? null,
                normalizedIntent: candidate.normalizedIntent || null
            };
            task.expectedOdds = odds;
            task.bookmakerOdds = odds;
            return {
                success: true,
                outcome,
                foundSelection: true,
                rejectedByOdds,
                candidates
            };
        }

        return {
            success: false,
            foundSelection,
            rejectedByOdds,
            candidates
        };
    }

    _getTelegramOutcomeRecheckPolicy(task = {}) {
        const rawPolicy = task.telegramPolicy?.outcomeRecheck ||
            task.sourcePolicy?.outcomeRecheck ||
            this.config.telegram?.outcomeRecheck ||
            {};
        const intervalMs = Number(rawPolicy.intervalMs ?? 30 * 1000);
        const totalWindowMs = Number(rawPolicy.totalWindowMs ?? 5 * 60 * 1000);
        // Fast-fail window: if the matched bookmaker entry shows zero markets
        // after this much time, give up early instead of grinding for 5
        // minutes. Default min(30s, totalWindow) so test configs with tiny
        // totalWindow values continue to behave like before (single window).
        const finalTotal = Number.isFinite(totalWindowMs) && totalWindowMs > 0 ? totalWindowMs : 5 * 60 * 1000;
        const rawMarketMissing = Number(rawPolicy.marketMissingWindowMs ?? Math.min(30 * 1000, finalTotal));
        const marketMissingWindowMs = Number.isFinite(rawMarketMissing) && rawMarketMissing > 0
            ? Math.min(rawMarketMissing, finalTotal)
            : finalTotal;
        return {
            enabled: rawPolicy.enabled !== false,
            intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30 * 1000,
            totalWindowMs: finalTotal,
            marketMissingWindowMs
        };
    }

    _getBookmakerLiveMatchState(match = {}) {
        const header = match.odds?.H || match.H || {};
        const matchStatus = String(header.MS || match.MS || '').trim().toUpperCase();
        const eventStatus = String(header.ES || match.ES || '').trim().toUpperCase();
        const rawMarketCount = header.marketcounter ??
            match.marketcounter ??
            match.odds?.M?.length ??
            match.M?.length ??
            match.markets?.length ??
            null;
        const marketCount = Number.isFinite(Number(rawMarketCount)) ? Number(rawMarketCount) : null;
        return {
            matchStatus,
            eventStatus,
            marketCount,
            isFinished: ['F', 'FT', 'FINISHED', 'ENDED', 'END'].includes(matchStatus)
        };
    }

    async _failTelegramIfMatchFinished(task, match) {
        const state = this._getBookmakerLiveMatchState(match);
        if (!state.isFinished) {
            return null;
        }

        const details = [
            state.matchStatus ? `MS=${state.matchStatus}` : null,
            state.eventStatus ? `ES=${state.eventStatus}` : null,
            state.marketCount !== null ? `markets=${state.marketCount}` : null
        ].filter(Boolean).join(', ');
        const msg = `Market closed: live match already finished on bookmaker${details ? ` (${details})` : ''}`;
        this.logger.log(`❌ [TG] ${msg}`);
        task._lastError = msg;
        if (!this.config.tgQuiet) {
            await this._notifyFailed(task, msg, 'market_closed');
        }
        return { success: false, result: { success: false, shouldRetry: false, step: 'market_closed' } };
    }

    async _retryTelegramOutcomeAvailability(task, match) {
        const policy = this._getTelegramOutcomeRecheckPolicy(task);
        if (!policy.enabled || policy.intervalMs <= 0 || policy.totalWindowMs <= 0) {
            return null;
        }

        const startAt = Date.now();
        const deadline = startAt + policy.totalWindowMs;
        const marketMissingDeadline = startAt + policy.marketMissingWindowMs;
        const range = this._getTelegramOddsRange(task);
        this._setTelegramExecutionState(task, 'waiting_outcome_recheck');

        // Fast-fail #0: if the bookmaker entry says the match is already
        // finished BEFORE we even enter the recheck loop, we'd otherwise
        // sleep 30s for nothing. Catch this immediately.
        const initiallyClosed = await this._failTelegramIfMatchFinished(task, match);
        if (initiallyClosed) {
            return initiallyClosed;
        }

        this.logger.log(`⏳ [TG] Match found but outcome unavailable. Rechecking every ${(policy.intervalMs / 1000).toFixed(0)}s for up to ${(policy.totalWindowMs / 1000).toFixed(0)}s (market-missing fast-fail at ${(policy.marketMissingWindowMs / 1000).toFixed(0)}s) without new LLM calls.`);

        const initialCandidates = this._getTelegramOutcomeCandidates(task);
        if (!this.config.tgQuiet) {
            try {
                await this._notifyTelegramOutcomeRecheckStarted(task, initialCandidates, policy);
            } catch (error) {
                this.logger.log(`⚠️ [TG] Outcome recheck notification failed: ${error.message}`);
            }
        }

        // Track whether we ever observed markets at all. If markets stay empty
        // through the marketMissingWindowMs deadline, the bookmaker simply
        // has no markets for this match (e.g. partner bet on a market that
        // Sansabet doesn't trade) — there's no point grinding.
        const initialMarketCount = BetProcessor._countMatchMarkets(match);
        let marketEverSeen = initialMarketCount > 0;

        let attempt = 0;
        while (Date.now() < deadline) {
            const stopRequest = this._getTelegramStopRequest(task);
            if (stopRequest) {
                const message = 'Telegram STOP requested during outcome recheck';
                task._lastError = message;
                this.logger.log(`🛑 [TG] ${message}`);
                return {
                    success: false,
                    result: {
                        success: false,
                        shouldRetry: false,
                        cancelled: true,
                        step: 'telegram_stop',
                        message
                    }
                };
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, Math.min(policy.intervalMs, remainingMs)));
            attempt += 1;

            try {
                await this._refreshTelegramMatchDetails(task, match);
            } catch (error) {
                this.logger.log(`⚠️ [TG] Outcome recheck refresh failed: ${error.message}`);
            }

            const closedMatchResult = await this._failTelegramIfMatchFinished(task, match);
            if (closedMatchResult) {
                return closedMatchResult;
            }

            if (!marketEverSeen) {
                const currentMarketCount = BetProcessor._countMatchMarkets(match);
                if (currentMarketCount > 0) {
                    marketEverSeen = true;
                }
            }

            const resolution = await this._resolveTelegramOutcomeCandidates(task, match, {
                candidates: this._getTelegramOutcomeCandidates(task),
                range
            });
            if (resolution.success) {
                this.logger.log(`✅ [TG] Outcome became available after ${attempt} recheck(s)`);
                return { success: true, outcome: resolution.outcome };
            }

            if (resolution.rejectedByOdds.length > 0) {
                const attempted = resolution.rejectedByOdds
                    .map((entry) => `${entry.outcome} @ ${entry.odds}`)
                    .join(', ');
                const msg = `No telegram candidate within odds range ${range.minOdds}-${range.maxOdds ?? '∞'} after recheck (${attempted})`;
                this.logger.log(`❌ [TG] ${msg}`);
                task._lastError = msg;
                if (!this.config.tgQuiet) {
                    await this._notifyFailed(task, msg, 'odds_validation');
                }
                return { success: false, result: { success: false, shouldRetry: false, step: 'odds_validation' } };
            }

            // Fast-fail: market category never seen on the bookmaker for this
            // match, after marketMissingWindowMs. Bookmaker doesn't trade
            // anything on this match — partner sent a signal we can't fulfil.
            if (!marketEverSeen && Date.now() >= marketMissingDeadline) {
                const msg = `Bookmaker has no markets at all for this match after ${(policy.marketMissingWindowMs / 1000).toFixed(0)}s (outcome ${task.outcome}); fast-fail without waiting full ${(policy.totalWindowMs / 1000).toFixed(0)}s window`;
                this.logger.log(`❌ [TG] ${msg}`);
                task._lastError = msg;
                if (!this.config.tgQuiet) {
                    await this._notifyFailed(task, msg, 'outcome_not_found');
                }
                return { success: false, result: { success: false, shouldRetry: false, step: 'outcome_recheck_no_markets' } };
            }

            const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            this.logger.log(`⏳ [TG] Outcome still unavailable after recheck #${attempt}; ${secondsLeft}s remaining (marketEverSeen=${marketEverSeen})`);
        }

        const finalCandidates = this._getTelegramOutcomeCandidates(task);
        const msg = `No telegram candidates found on bookmaker after ${(policy.totalWindowMs / 1000).toFixed(0)}s recheck (${finalCandidates.map((candidate) => candidate.outcome).filter(Boolean).join(', ') || 'empty'})`;
        this.logger.log(`❌ [TG] ${msg}`);
        task._lastError = msg;
        if (!this.config.tgQuiet) {
            await this._notifyFailed(task, msg, 'outcome_not_found');
        }
        return { success: false, result: { success: false, shouldRetry: false, step: 'outcome_recheck_timeout' } };
    }

    static _countMatchMarkets(match) {
        if (!match) return 0;
        const sources = [match.markets, match.M, match.odds?.M];
        for (const src of sources) {
            if (Array.isArray(src) && src.length > 0) {
                return src.length;
            }
        }
        return 0;
    }

    async _refreshTelegramMatchDetails(task, match) {
        const sportName = task.pair?.sportName || task.sport || match.sport || 'soccer';
        const matchId = match.Id || match.id || match.H?.PID || task.bookmakerMatchId;

        if (task.isPrematch && task.bookmakerMatchId && typeof this.adapter.findMatchByPID === 'function') {
            const freshPrematch = await this.adapter.findMatchByPID(task.bookmakerMatchId);
            if (freshPrematch) {
                freshPrematch.odds = { H: freshPrematch.H, M: freshPrematch.M };
                freshPrematch.markets = freshPrematch.M || [];
                freshPrematch.sport = sportName || 'soccer';
                Object.assign(match, freshPrematch);
                return true;
            }
        }

        if (matchId && typeof this.adapter.getMatchDetails === 'function') {
            const freshDetails = await this.adapter.getMatchDetails(matchId, sportName);
            if (freshDetails) {
                Object.assign(match, freshDetails);
                return true;
            }
        }

        if (matchId && typeof this.adapter.getMatchOdds === 'function') {
            const freshOdds = await this.adapter.getMatchOdds(matchId);
            if (freshOdds) {
                match.odds = freshOdds;
                match.markets = freshOdds.M || [];
                if (freshOdds.M) {
                    match.M = freshOdds.M;
                }
                return true;
            }
        }

        return false;
    }

    async _findOutcomeOnBookmaker(task, match, outcomeStr, expectedOdds = null) {
        const betNumOutcome = task._betNumOutcome || task.outcome;
        if (!task._betNumOutcome) {
            task._betNumOutcome = betNumOutcome;
        }

        const canUseBetNum = outcomeStr === betNumOutcome;
        const donorBetNum = canUseBetNum ? task.outcomeData?.score2?.raw?.bet_num : null;
        this.logger.log(`🔍 [OutcomeLookup] outcome=${outcomeStr} expected=${expectedOdds ?? 'N/A'} bet_num=${donorBetNum || 'none'}`);
        this._captureAttemptDebug('outcome_lookup_started', {
            outcome: outcomeStr,
            expectedOdds: expectedOdds ?? null,
            betNum: donorBetNum || null,
            totalMarkets: Array.isArray(match?.markets) ? match.markets.length : Array.isArray(match?.M) ? match.M.length : null
        });

        let outcome;
        if (donorBetNum && typeof this.adapter.findOutcomeByBetNum === 'function') {
            this.logger.log(`🔑 [BetNum] Using parser BetNum: N=${donorBetNum}`);
            outcome = this.adapter.findOutcomeByBetNum(match, outcomeStr, donorBetNum, expectedOdds);
        } else {
            outcome = this.adapter.findOutcome(match, outcomeStr, expectedOdds);
        }

        if (!outcome && outcomeStr.startsWith('PP ') && typeof this.adapter.findPlayerPropOutcome === 'function') {
            const { OutcomeParser } = require('../parsers/outcome-parser.js');
            const parsed = OutcomeParser.parse({ outcome: outcomeStr });
            if (parsed && parsed.marketHint === 'playerprop') {
                this.logger.log(`🎯 [PP] Trying async player prop lookup...`);
                outcome = await this.adapter.findPlayerPropOutcome(match, parsed, outcomeStr, expectedOdds);
            }
        }

        this._captureAttemptDebug(outcome ? 'outcome_lookup_succeeded' : 'outcome_lookup_failed', {
            outcome: outcomeStr,
            expectedOdds: expectedOdds ?? null,
            foundOdds: outcome?.oddVal || null,
            selectionId: outcome?.selectionId || outcome?.selection?.N || null,
            marketLine: outcome?.sbv || outcome?.market?.B || null
        });

        return outcome;
    }
    /**
     * Ожидание конвергенции цен: ждём пока анализатор обновит цену,
     * при каждом обновлении заново проверяем коэффициент на букмекере.
     * Live: 20s, Prematch: 90s
     */
    async _waitForOddsConvergence(task, match, bookmakerOdds) {
        const isPrematch = task.isPrematch;
        const totalTimeoutMs = isPrematch 
            ? constants.ODDS_CONVERGENCE_PREMATCH_MS 
            : constants.ODDS_CONVERGENCE_LIVE_MS;
        const pollIntervalMs = 1000; // check every 1s
        const startTime = Date.now();
        let attempt = 0;
        let lastAnalyzerTs = this.freshDataManager?.lastTimestamp || 0;

        this.logger.log(`🔄 Odds convergence: waiting up to ${(totalTimeoutMs / 1000).toFixed(0)}s (${isPrematch ? 'prematch' : 'live'}) for analyzer to match bookmaker price ${bookmakerOdds}`);

        while (true) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= totalTimeoutMs) {
                const msg = `Odds convergence timeout: analyzer never matched bookmaker price in ${(totalTimeoutMs / 1000).toFixed(0)}s`;
                this.logger.log(`⏰ ${msg}`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, msg, 'odds_convergence_timeout');
                return { success: false, result: { success: false, shouldRetry: false } };
            }

            // Wait for next poll
            await new Promise(r => setTimeout(r, pollIntervalMs));
            attempt++;

            // Check if analyzer has fresh data
            const currentTs = this.freshDataManager?.lastTimestamp || 0;
            if (currentTs <= lastAnalyzerTs) {
                // No new data yet, keep waiting
                continue;
            }
            lastAnalyzerTs = currentTs;

            // Analyzer updated — get fresh pair data for our outcome
            const matchKey = task.freshDataMatchKey;
            const allOutcomes = this.freshDataManager._getMatchOutcomesRaw(matchKey);
            const ourOutcome = allOutcomes.find(o => o.outcome === task.outcome);

            if (!ourOutcome || ourOutcome.roi < this.config.minROI) {
                const bestRoi = ourOutcome ? ourOutcome.roi : 0;
                this.logger.log(`❌ ROI dropped during convergence: ${bestRoi.toFixed(2)}% < ${this.config.minROI}%`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, `ROI dropped to ${bestRoi.toFixed(2)}%`, 'roi_dropped');
                return { success: false, result: { success: false, shouldRetry: false } };
            }

            // Update task with fresh analyzer data using isFirstOurs pattern
            const isFirstOurs = task.isFirstOurs;
            const newExpected = isFirstOurs ? ourOutcome.data?.score1 : ourOutcome.data?.score2;
            const newPinnacle = isFirstOurs ? ourOutcome.data?.score2 : ourOutcome.data?.score1;
            if (newExpected) task.expectedOdds = newExpected;
            if (newPinnacle) task.pinnacleOdds = newPinnacle;
            if (ourOutcome.roi) task.expectedROI = ourOutcome.roi;

            // Refresh BetContext from fresh analyzer data (bet_num may have changed)
            const freshScore2Full = isFirstOurs ? ourOutcome.data?.score1Full : ourOutcome.data?.score2Full;
            if (freshScore2Full?.raw?.bet_num) {
                task.outcomeData = task.outcomeData || {};
                task.outcomeData.score2 = freshScore2Full;
            }

            // Re-fetch FRESH bookmaker odds (CRITICAL: must re-query API, not use cached match data!)
            let currentBookmakerOutcome;
            try {
                // Refresh match odds from bookmaker API every iteration
                if (typeof this.adapter.getMatchOdds === 'function') {
                    const matchId = match.Id || match.id || match.H?.PID;
                    if (matchId) {
                        const freshOdds = await this.adapter.getMatchOdds(matchId);
                        if (freshOdds) {
                            match.odds = freshOdds;
                            match.markets = freshOdds.M || [];
                            if (freshOdds.M) match.M = freshOdds.M;
                        }
                    }
                }
                // Use BetNum when available (same as initial findOutcome)
                const convergeBetNum = task.outcomeData?.score2?.raw?.bet_num;
                if (convergeBetNum && typeof this.adapter.findOutcomeByBetNum === "function") {
                    currentBookmakerOutcome = this.adapter.findOutcomeByBetNum(match, task.outcome, convergeBetNum, task.expectedOdds);
                } else {
                    currentBookmakerOutcome = this.adapter.findOutcome(match, task.outcome, task.expectedOdds);
                }
            } catch (e) {
                this.logger.log(`⚠️ findOutcome error during convergence: ${e.message}`);
                continue;
            }

            if (!currentBookmakerOutcome) {
                this.logger.log(`❌ Convergence attempt ${attempt}: selection disappeared — market closed`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, 'Selection disappeared during convergence', 'market_closed');
                return { success: false, result: { success: false, shouldRetry: false } };
            }

            const currentBkOdds = currentBookmakerOutcome.oddVal;
            const diff = Math.abs(currentBkOdds - task.expectedOdds);
            const remainSec = ((totalTimeoutMs - elapsed) / 1000).toFixed(0);

            if (diff <= constants.ODDS_TOLERANCE) {
                this.logger.log(`✅ Odds converged! analyzer=${task.expectedOdds} bookmaker=${currentBkOdds} (diff=${diff.toFixed(4)}) after ${attempt} polls (${(elapsed / 1000).toFixed(1)}s)`);
                return { success: true, outcome: currentBookmakerOutcome };
            }

            // Detailed diagnostic on first iteration
            if (attempt === 1) {
                const pairFirst = task.pair?.first?.bookmaker || '?';
                const pairSecond = task.pair?.second?.bookmaker || '?';
                this.logger.log(`📊 [CONV_DIAG] isPrematch=${task.isPrematch}, pair: ${pairFirst} vs ${pairSecond}`);
                this.logger.log(`📊 [CONV_DIAG] analyzer expectedOdds=${task.expectedOdds}, pinnacleOdds=${task.pinnacleOdds}, ROI=${task.expectedROI?.toFixed(2)}%`);
                this.logger.log(`📊 [CONV_DIAG] bookmaker found=${currentBkOdds} via matchId=${match.Id || match.id || match.H?.PID}`);
            }

            // Log every 3rd attempt to avoid spam
            if (attempt % 3 === 0) {
                this.logger.log(`⏳ Convergence: analyzer=${task.expectedOdds} vs bookmaker=${currentBkOdds} (diff=${diff.toFixed(3)}, ${remainSec}s left)`);
            }
        }
    }

    
    /**
     * Ждём обновление анализатора по матчу и переключаемся на лучший исход
     */
    async _waitForUpdateAndSwitch(task, match, reason) {
        this._rememberOriginalOutcome(task);
        
        // Проверяем лимит переключений
        if (task._switchCount >= constants.MAX_SWITCHES) {
            const msg = `Max switches reached (${constants.MAX_SWITCHES}). Stopping.`;
            this.logger.log(`🛑 ${msg}`);
            if (!this.config.tgQuiet) await this._notifyFailed(task, msg, reason);
            return { success: false, result: { success: false, shouldRetry: false } };
        }
        
        // Проверяем доступность анализатора
        if (!this.analyzerAvailable) {
            const msg = 'Analyzer offline - cannot wait for update';
            this.logger.log(`❌ ${msg}`);
            if (!this.config.tgQuiet) await this._notifyFailed(task, msg, reason);
            return { success: false, result: { success: false, shouldRetry: false } };
        }
        
        // Informative log showing WHY we're waiting
        const reasonText = reason === 'odds_mismatch' 
            ? `odds mismatch (expected ${task.expectedOdds}, got ${task._lastFoundOdds || '?'})`
            : reason === 'outcome_not_found'
            ? `outcome "${task.outcome}" not found on bookmaker`
            : reason;
        this.logger.log(`⏳ Waiting for analyzer update: ${reasonText} (switch ${task._switchCount + 1}/${constants.MAX_SWITCHES}, timeout 7s)...`);
        
        try {
            const updateResult = await this.freshDataManager.waitForMatchUpdate({
                matchKey: task.freshDataMatchKey,
                minROI: this.config.minROI,
                timeoutMs: constants.FRESH_DATA_TIMEOUT_MS
            });
            
            // ROI упал
            if (updateResult.roiDropped) {
                const msg = `ROI dropped: best is ${updateResult.bestRoi?.toFixed(2) || 0}% < ${this.config.minROI}%`;
                this.logger.log(`❌ ${msg}`);
                if (!this.config.tgQuiet) await this._notifyFailed(task, msg, 'roi_dropped');
                return { success: false, result: { success: false, shouldRetry: false } };
            }
            
            // Есть хороший исход - переключаемся
            let best = updateResult.bestOutcome;
            
            // Track tried outcomes to avoid re-selecting failed ones
            if (!task._triedOutcomes) task._triedOutcomes = new Set();
            // Merge outcomes that recently failed for this match (prevents circular switching across tasks)
            const recentFailed = this.tasksManager?.getRecentlyFailedOutcomes?.(task.matchKey) || new Set();
            for (const o of recentFailed) task._triedOutcomes.add(o);
            
            // If best outcome was already tried and failed, find an alternative
            if (task._triedOutcomes.has(best.outcome) || 
                best.score1 < (this.config.minOdds || 1.1) || best.score1 > (this.config.maxOdds || 4) ||
                (best.outcome === task.outcome && (reason === 'outcome_not_found' || reason === 'singles_blocked'))) {
                task._triedOutcomes.add(task.outcome);
                const alternatives = (updateResult.allOutcomes || [])
                    .filter(o => !task._triedOutcomes.has(o.outcome) && o.roi >= this.config.minROI && o.score1 >= (this.config.minOdds || 1.1) && o.score1 <= (this.config.maxOdds || 4));
                if (alternatives.length > 0) {
                    best = alternatives[0];
                    this.logger.log(`⚠️ Outcome "${best.outcome}" selected as alternative (tried: ${[...task._triedOutcomes].join(', ')})`);
                } else {
                    const msg = `No alternative outcomes available (tried: ${[...task._triedOutcomes].join(', ')})`;
                    this.logger.log(`🛑 ${msg}`);
                    if (!this.config.tgQuiet) await this._notifyFailed(task, msg, 'no_alternatives');
                    return { success: false, result: { success: false, shouldRetry: false } };
                }
            }
            
            task._switchCount++;
            
            const prevOutcome = task.outcome;
            this.logger.log(`🔄 SWITCH ${task._switchCount}/${constants.MAX_SWITCHES}: ${prevOutcome} → ${best.outcome} (ROI: ${best.roi.toFixed(2)}%)`);
            
            // Обновляем task
            this._updateTaskFromAnalyzer(task, best);
            
            // Notify Telegram about switch
            if (this.telegram && task._telegramStartSent) {
                const betType = task.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
                if (!this.config.tgQuiet) await this._sendTaskUpdate(
                    task,
                    `🔄 <b>SWITCH</b> ${task._switchCount}/${constants.MAX_SWITCHES} [${betType}]\n` +
                    `📋 ID: <code>${task.id}</code>\n\n` +
                    `❌ ${this.telegram.escapeHtml(prevOutcome)} → ✅ ${this.telegram.escapeHtml(task.outcome)}\n` +
                    `📈 ROI: <b>${task.expectedROI.toFixed(2)}%</b>\n` +
                    `📊 Pinnacle: <b>${task.pinnacleOdds || 'N/A'}</b>\n` +
                    `📊 Букмекер: <b>${task.expectedOdds || 'N/A'}</b>`
                ).catch(() => {});
            }
            
            // Пробуем найти новый исход
            // Use BetNum when available
            const retryBetNum = task.outcomeData?.score2?.raw?.bet_num;
            let newOutcome;
            if (retryBetNum && typeof this.adapter.findOutcomeByBetNum === "function") {
                newOutcome = this.adapter.findOutcomeByBetNum(match, task.outcome, retryBetNum, task.expectedOdds);
            } else {
                newOutcome = this.adapter.findOutcome(match, task.outcome, task.expectedOdds);
            }
            // Player Props: async path
            if (!newOutcome && task.outcome.startsWith('PP ') && typeof this.adapter.findPlayerPropOutcome === 'function') {
                const { OutcomeParser } = require('../parsers/outcome-parser.js');
                const parsed = OutcomeParser.parse({ outcome: task.outcome });
                if (parsed && parsed.marketHint === 'playerprop') {
                    newOutcome = await this.adapter.findPlayerPropOutcome(match, parsed, task.outcome, task.expectedOdds);
                }
            }
            if (!newOutcome) {
                this.logger.log(`⚠️ New outcome ${task.outcome} also not found on bookmaker`);
                // Рекурсивно пробуем ещё раз
                return await this._waitForUpdateAndSwitch(task, match, 'outcome_not_found');
            }
            
            // Проверяем коэффициент нового исхода
            const newOddsDiff = Math.abs(newOutcome.oddVal - task.expectedOdds);
            if (newOddsDiff > constants.ODDS_TOLERANCE) {
                this.logger.log(`⚠️ New outcome odds dropped: expected ${task.expectedOdds}, got ${newOutcome.oddVal}`);
                // Рекурсивно пробуем ещё раз
                return await this._waitForUpdateAndSwitch(task, match, 'odds_mismatch');
            }
            
            this.logger.log(`✅ New selection found: ${newOutcome.pick} @ ${newOutcome.oddVal}`);
            return { success: true, outcome: newOutcome };
            
        } catch (e) {
            // Informative error based on reason
            let msg;
            const originalOutcome = task._originalOutcome || task.outcome;
            
            if (reason === 'outcome_not_found') {
                msg = `Outcome "${originalOutcome}" not found on bookmaker`;
            } else if (reason === 'odds_mismatch') {
                msg = `Odds mismatch for "${originalOutcome}" - bookmaker odds differ from analyzer`;
            } else {
                msg = `Timeout waiting for analyzer update: ${e.message}`;
            }
            
            this.logger.log(`❌ ${msg}`);
            if (!this.config.tgQuiet) await this._notifyFailed(task, msg, reason);
            return { success: false, result: { success: false, shouldRetry: false } };
        }
    }
    
    /**
     * Обновить task данными от анализатора
     */
    _updateTaskFromAnalyzer(task, analyzerData) {
        const isFirstOurs = task.isFirstOurs;
        
        this._rememberOriginalOutcome(task);
        task.outcome = analyzerData.outcome;
        task.expectedROI = analyzerData.roi;
        task.expectedOdds = isFirstOurs ? analyzerData.score1 : analyzerData.score2;
        
        // Update all odds/source fields so downstream task handling uses switched data
        task.pinnacleOdds = isFirstOurs ? analyzerData.score2 : analyzerData.score1;
        task.bookmakerOdds = task.expectedOdds;
        const outcomeObj = analyzerData.data?.outcome || analyzerData.outcome;
        if (outcomeObj && typeof outcomeObj === 'object') {
            task.outcomeData = outcomeObj;
            task.pinnacleBestSource = outcomeObj.pinnacleBestSource || null;
            task.pinnacleStdOdds = outcomeObj.pinnacleStdOdds || null;
            task.pinnacleSources = outcomeObj.pinnacleSources || null;
            if (outcomeObj.margin) {
                task.margin = (outcomeObj.margin - 1) * 100;
            }
        } else if (typeof outcomeObj === 'string') {
            // Switch case: outcomeObj is string (e.g. "2"), build outcomeData from FreshDataManager full scores
            task.outcomeData = {
                outcome: outcomeObj,
                score1: analyzerData.score1Full || { value: analyzerData.score1 },
                score2: analyzerData.score2Full || { value: analyzerData.score2 },
                roi: analyzerData.roi
            };
        }
        // Update pair with fresh data (for createdAt freshness)
        if (analyzerData.pair) {
            task.pair = analyzerData.pair;
            task.pairFull = analyzerData.pair;
        }
    }
    
    // ==================== DETERMINE STAKE ====================
    
    async _determineStake(task) {
        const sourceMeta = getResolvedSource(task);
        const isHighROI = (task.expectedROI || 0) >= this.config.highROIThreshold;
        let stake;
        if (typeof task.stake === 'number' && task.stake > 0) {
            stake = task.stake;
        } else if (sourceMeta.isTelegram) {
            stake = task.telegramPolicy?.stake ||
                task.sourcePolicy?.stake ||
                this.config.telegram?.stake ||
                this.config.singleStake ||
                constants.DEFAULT_STAKE;
        } else if (task.type === 'single') {
            stake = this.config.singleStake;
        } else if (task.type === 'fast') {
            stake = isHighROI ? this.config.fastHighROIStake : this.config.fastStake;
        } else {
            stake = isHighROI ? this.config.slowHighROIStake : this.config.slowStake;
        }

        const source = getTaskSourceKey(task, { highROIThreshold: this.config.highROIThreshold });
        const strategy = task.strategy || this._getStrategyForTask(task, sourceMeta, source);

        // Check LOCAL limits
        if (this.limitsManager) {
            const localCheck = this.limitsManager.checkLocalLimits(
                task.matchKey,
                source,
                stake,
                getTaskLocalLimitOverrides(task)
            );
            if (!localCheck.allowed) {
                this.logger.log(`⚠️ ${localCheck.reason}. Skipping.`);
                return { success: false };
            }
            if (localCheck.adjustedStake && localCheck.adjustedStake < stake) {
                this.logger.log(`💰 Adjusting stake (local limit): ${stake.toFixed(2)} → ${localCheck.adjustedStake.toFixed(2)} ${resolveCurrency(this)}`);
                stake = localCheck.adjustedStake;
            }
        }

        // Check global limits (Calculator)
        stake = await this._checkGlobalLimits(task, stake, strategy);
        if (stake === null) {
            return { success: false };
        }

        if (sourceMeta.isTelegram && task.matchKey && this.tasksManager) {
            const allowed = this.tasksManager.checkTelegramExposureHardCap?.(task.matchKey, stake, {
                excludeTaskId: task.id
            });
            if (allowed === false) {
                this.logger.log(`⚠️ Telegram hard-cap exceeded for ${task.matchKey}. Skipping.`);
                task._lastError = 'Telegram hard-cap exceeded';
                return { success: false };
            }
        }

        return { success: true, stake, strategy, source };
    }

    _getStrategyForTask(task, sourceMeta, source) {
        if (this.config.strategyPrefix && !sourceMeta.isTelegram) {
            return this.config.strategyPrefix;
        }

        if (sourceMeta.isTelegram) {
            const profileSuffix = normalizeIdentifier(task.sourceProfileId || task.telegramContext?.profileId);
            const base = `${this.bookmakerName.toLowerCase()}_telegram`;
            return profileSuffix ? `${base}_${profileSuffix}` : base;
        }

        const type = task.type || sourceMeta.sourceVariant || 'single';
        return `${this.bookmakerName.toLowerCase()}_${type}`;
    }

    // ==================== SESSION ====================
    
    async _checkSession() {
        const now = Date.now();
        if (now - this._lastSessionCheck <= this._sessionCacheTTL) {
            const cacheAge = ((now - this._lastSessionCheck) / 1000).toFixed(1);
            this.logger.log(`✅ Session valid (cached ${cacheAge}s ago)`);
            return this._lastSessionValid;
        }
        
        this.logger.log('🔐 Pre-flight: Checking session...');
        this._lastSessionValid = await this.adapter.isSessionValid();
        this._lastSessionCheck = now;
        
        if (!this._lastSessionValid) {
            this.logger.log('❌ Session invalid, attempting re-login...');
            // Update bettor state for health dashboard
            if (this.bettor?.state) {
                this.bettor.state.lastLoginAttempt = Date.now();
            }
            const loginOk = await this.adapter.login();
            if (!loginOk) {
                this.logger.log('❌ Re-login failed');
                // Update bettor state for health dashboard
                if (this.bettor?.state) {
                    this.bettor.state.loginError = 'Re-login failed';
                    this.bettor.state.status = 'login_error';
                }
                return false;
            }
            this.logger.log('✅ Re-login successful');
            this._lastSessionValid = true;
            // Clear login error on success
            if (this.bettor?.state) {
                this.bettor.state.loginError = null;
                this.bettor.state.status = 'active';
            }
        } else {
            this.logger.log('✅ Session valid');
        }
        return true;
    }

    // ==================== DATA FRESHNESS CHECK ====================
    
    /**
     * Ensure data is fresh before placing bet, with retry logic.
     * Waits for analyzer updates if data is stale or odds changed.
     * 
     * @param {Object} task - Task with pair data
     * @param {Object} outcome - Found outcome from bookmaker
     * @param {number} maxRetries - Max retry attempts (default: 5)
     * @returns {Promise<{ok: boolean, reason?: string, updatedOdds?: number}>}
     */
    async _ensureDataFresh(task, outcome, maxRetries = 5) {
        const pinnacleMaxAge = this.config.pinnacleMaxAge || 3500;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const check = this._checkDataFreshness(task, pinnacleMaxAge);
            
            if (check.ok) {
                return { ok: true };
            }
            
            // Last attempt - give up
            if (attempt === maxRetries) {
                return {
                    ok: false,
                    reason: `${check.reason} (after ${maxRetries} attempts)`
                };
            }
            
            this.logger.log(`⏳ Freshness check failed (attempt ${attempt}/${maxRetries}): ${check.reason}`);
            this.logger.log(`   Waiting for analyzer update...`);
            
            // Wait for fresh data from analyzer
            try {
                const updateResult = await this.freshDataManager.waitForMatchUpdate({
                    matchKey: task.freshDataMatchKey,
                    minROI: this.config.minROI,
                    timeoutMs: constants.FRESH_DATA_TIMEOUT_MS || 7000,
                    outcome: task.outcome  // prefer current outcome; switch only if gone
                });
                
                // ROI dropped below threshold
                if (updateResult.roiDropped) {
                    return {
                        ok: false,
                        reason: `ROI dropped to ${updateResult.bestRoi?.toFixed(2) || 0}% < ${this.config.minROI}% during freshness wait`
                    };
                }
                
                // Update task with fresh data
                if (updateResult.bestOutcome) {
                    const best = updateResult.bestOutcome;
                    const isFirstOurs = task.isFirstOurs;
                    const newOdds = isFirstOurs ? best.score1 : best.score2;
                    
                    // Update task with new data; signal outcomeChanged for caller to re-find selection
                    const outcomeChanged = best.outcome !== task.outcome;
                    if (outcomeChanged) {
                        this._rememberOriginalOutcome(task);
                        this.logger.log(`🔄 Outcome switched: ${task.outcome} → ${best.outcome} (ROI ${best.roi.toFixed(2)}%)`);
                        task.outcome = best.outcome;
                    }
                    
                    task.pair = updateResult.pair || task.pair;
                    task.outcomeData = best;
                    task.expectedOdds = newOdds;
                    task.expectedROI = best.roi;
                    
                    this.logger.log(`🔄 Got fresh data: ${best.outcome} @ ${newOdds} (ROI ${best.roi.toFixed(2)}%)`);
                    
                    if (outcomeChanged) {
                        return { ok: true, outcomeChanged: true, newOutcome: best.outcome };
                    }
                }
                
            } catch (e) {
                // Timeout means analyzer has no fresh data for this match
                // This likely means the line is closed/suspended on Pinnacle
                // Don't retry - abort immediately
                this.logger.log(`⚠️ Analyzer update timeout: ${e.message}`);
                return {
                    ok: false,
                    reason: `Analyzer timeout - Pinnacle line likely closed/suspended`
                };
            }
        }
        
        return { ok: false, reason: 'Max retries exceeded' };
    }
    
    /**
     * Single freshness check (no retries)
     * 
     * @param {Object} task - Task with pair data  
     * @param {number} pinnacleMaxAge - Max age for Pinnacle data in ms
     * @returns {{ok: boolean, reason?: string, issue?: string}}
     */
    _checkDataFreshness(task, pinnacleMaxAge = 3500) {
        const now = Date.now();
        
        // 1. Check Pinnacle (first bookmaker) data age
        if (task.pair?.first?.createdAt) {
            const pinnacleCreatedAt = new Date(task.pair.first.createdAt).getTime();
            const pinnacleAge = now - pinnacleCreatedAt;
            
            if (pinnacleAge > pinnacleMaxAge) {
                return {
                    ok: false,
                    reason: `Pinnacle data stale: ${(pinnacleAge / 1000).toFixed(1)}s > ${pinnacleMaxAge / 1000}s`,
                    issue: 'pinnacle_stale'
                };
            }
            
            this.logger.log(`✅ Pinnacle fresh: ${(pinnacleAge / 1000).toFixed(1)}s`);
        }
        
        // 2. Check that bookmaker (donor) odds match expectedOdds from analyzer within tolerance.
        // CRITICAL: Both PS3838 (Pinnacle) and donor prices MUST come from analyzer.
        // Only the analyzer calculates ROI. If either price diverges, bet is invalid.
        // This rule applies to ALL donors: Sansabet, Volcano, and any future bookmakers.
        // 2. Check that bookmaker odds match expectedOdds within ±0.01
        const isFirstOurs = task.isFirstOurs;
        const currentOdds = isFirstOurs 
            ? task.outcomeData?.score1?.value 
            : task.outcomeData?.score2?.value;
        
        if (currentOdds && task.expectedOdds) {
            const oddsDiff = Math.abs(currentOdds - task.expectedOdds);
            if (oddsDiff > constants.ODDS_TOLERANCE) {
                return {
                    ok: false,
                    reason: `Odds changed: expected ${task.expectedOdds}, got ${currentOdds} (Δ${oddsDiff.toFixed(3)})`,
                    issue: 'odds_changed'
                };
            }
            
            this.logger.log(`✅ Odds match: ${currentOdds}`);
        }
        
        return { ok: true };
    }

    // ==================== FIND MATCH ====================
    
    async _findMatch(task) {
        const sportName = task.pair?.sportName || 'soccer';
        const sportId = this.adapter.getSportId(sportName);
        this.logger.log(`🔍 Finding match: ${task.home} vs ${task.away} (sport: ${sportName}, PID: ${task.bookmakerMatchId || 'none'})`);
        this._captureAttemptDebug('match_search_started', {
            sportName,
            sportId,
            home: task.home,
            away: task.away,
            bookmakerMatchId: task.bookmakerMatchId || null,
            isPrematch: !!task.isPrematch
        });
        
        let match = null;
        
        // PREMATCH STALE GUARD: For prematch tasks, check if match is now live via apilive.
        // If found in apilive → match has gone live → prematch pair is stale → skip.
        // This prevents massive odds mismatch when prematch analyzer has stale data.
        if (task.isPrematch && task.bookmakerMatchId) {
            try {
                // Use getLiveMatches() to always check LIVE API (GetAll), not prematch API
                const getLive = typeof this.adapter.getLiveMatches === 'function' 
                    ? this.adapter.getLiveMatches.bind(this.adapter)
                    : typeof this.adapter.getMatches === 'function'
                    ? this.adapter.getMatches.bind(this.adapter, sportId)
                    : null;
                if (getLive) {
                    const liveMatches = await getLive();
                    const liveMatch = this.adapter.findMatch(liveMatches, task.home, task.away, task.bookmakerMatchId);
                    if (liveMatch) {
                        // Check if match is ACTUALLY live, not just scheduled for live coverage
                        // MS=NSY means "Not Started Yet" — match is in live API but hasn't started
                        const matchStatus = liveMatch.H?.MS || liveMatch.MS || '';
                        if (matchStatus === 'NSY') {
                            this.logger.log(`ℹ️ Match found in live API but MS=NSY (not started yet) — proceeding with prematch`);
                        } else if (task.sourceType === 'telegram' && !this.adapter.isPrematch) {
                            this.logger.log(`🔄 Telegram task inferred prematch, but live API says MS=${matchStatus} — continuing as live`);
                            task.isPrematch = false;
                            task.mode = 'live';
                            match = liveMatch;
                        } else {
                            this.logger.log(`⚡ Prematch pair is STALE: match is live (MS=${matchStatus}, ID=${liveMatch.Id || liveMatch.id}), skipping`);
                            return { success: false, error: 'prematch_pair_is_live' };
                        }
                    }
                }
            } catch (e) {
                // Live API unavailable — proceed with prematch path
                if (this.debug) {
                    this.logger.log(`⚠️ Live API check failed: ${e.message}, proceeding with prematch path`);
                }
            }
        }
        
        // For prematch: always use ASP.NET (GetTipoviV2) for correct odds and TiketPar fields
        if (!match && task.isPrematch && task.bookmakerMatchId && typeof this.adapter.findMatchByPID === 'function') {
            match = await this.adapter.findMatchByPID(task.bookmakerMatchId);
        }

        // Fallback to API search if ASP.NET didn't work
        if (!match) {
            const matches = await this.adapter.getMatches(sportId);
            match = this.adapter.findMatch(matches, task.home, task.away, task.bookmakerMatchId);
        }
        
        if (!match) {
            this._captureAttemptDebug('match_search_not_found', {
                home: task.home,
                away: task.away,
                bookmakerMatchId: task.bookmakerMatchId || null,
                sportName
            });
            return { success: false, error: `Match not found: ${task.home} vs ${task.away}` };
        }
        
        this.logger.log(`✅ Match found: ID=${match.Id || match.id}${match._fromASP ? ' (via ASP.NET)' : ''}`);
        
        // Get match details (skip for ASP.NET matches - they already have odds in M[])
        if (!match._fromASP) {
            const matchDetails = await this.adapter.getMatchDetails(match.Id || match.id, sportName);
            Object.assign(match, matchDetails);
        } else {
            match.odds = { H: match.H, M: match.M };
            match.markets = match.M || [];
            match.sport = sportName || 'soccer';
        }
        this._captureAttemptDebug('match_details_loaded', {
            matchId: match.Id || match.id || null,
            fromASP: !!match._fromASP,
            markets: Array.isArray(match.markets) ? match.markets.length : Array.isArray(match.M) ? match.M.length : null,
            sport: match.sport || sportName
        });
        
        return { success: true, match };
    }

    // ==================== GLOBAL LIMITS ====================
    
    async _checkGlobalLimits(task, stake, strategy) {
        this.logger.log(`📊 Checking global limits...`);
        try {
            const limitCheck = await this.calculator.checkBettingLimits({
                bookmaker: this.bookmakerName,
                leagueName: task.pair?.first?.leagueName,
                homeName: task.home,
                awayName: task.away,
                sportName: task.pair?.sportName || 'Unknown',
                strategy,
                odds: task.expectedOdds,
                expectedROI: task.expectedROI,
                outcome: task.outcome || ''
            });

            if (!limitCheck.allowed) {
                this.logger.log(`⚠️ LIMIT BLOCKED: ${limitCheck.reason} (mode: ${limitCheck.mode || 'normal'}). Skipping.`);
                return null;
            }
            
            // Log safe-opposite mode if active
            if (limitCheck.mode === 'safe_opposite_allowed') {
                this.logger.log(`🔄 Safe opposite exemption: bet allowed as safe-opposite of "${limitCheck.safeOppositeOf}"`);
                this.logger.log(`   Gross: ${limitCheck.globalPercentUsed?.toFixed(1)}%, credit: +${limitCheck.safeOppositeCreditPercent?.toFixed(1) || '0.0'}%, remaining: ${limitCheck.remainingPercent?.toFixed(1)}%`);
            }

            const remainingAmount = limitCheck.remainingAmount || Infinity;
            const kellyAmount = limitCheck.kellyAmount || 0;
            this.logger.log(`✅ Global limits OK: Kelly=${kellyAmount.toFixed(2)} ${resolveCurrency(this)}, remaining=${remainingAmount.toFixed(2)} ${resolveCurrency(this)}`);
            
            if (remainingAmount < Infinity && stake > remainingAmount) {
                this.logger.log(`💰 Adjusting stake (global limit MAX): ${stake.toFixed(2)} → ${remainingAmount.toFixed(2)} ${resolveCurrency(this)}`);
                stake = Math.floor(remainingAmount * 100) / 100;
            }
            
            return stake;
        } catch (e) {
            this.logger.log(`⚠️ Limits check failed: ${e.message} - continuing`);
            return stake;
        }
    }

    // ==================== HANDLE BET RESULT ====================
    
    async _handleBetResult(task, outcome, stake, strategy, source, betResult) {
        const currency = resolveCurrency(this);
        if (betResult.success) {
            const isDryRun = betResult.dryRun === true;
            task._betSucceeded = true;  // Mark for retry loop exit notification
            task._dryRunCompleted = isDryRun;
            if (isDryRun) {
                task.testMode = true;
            }
            task._betDetails = { odds: outcome.oddVal, stake, ticketId: betResult.ticketId, dryRun: isDryRun };
            // Audit (📝): one structured JSON line per bet outcome — success path.
            try {
                this.logger.log(`📝 [audit] ${JSON.stringify({
                    kind: 'bet_attempt_audit',
                    finalState: isDryRun ? 'dry_run' : 'placed',
                    ts: new Date().toISOString(),
                    taskId: task.id || null,
                    activationCode: task.activationCode || null,
                    sourceType: task.sourceType || null,
                    sourceChatId: task.telegramContext?.chatId ?? task.sourceChatId ?? null,
                    sport: task.pair?.sportName || task.sport || null,
                    home: task.home || task.homeName || null,
                    away: task.away || task.awayName || null,
                    outcomeRequested: task._originalOutcome || task.outcome,
                    outcomePlaced: task.outcome,
                    odds: outcome.oddVal,
                    stake,
                    ticketId: betResult.ticketId || null,
                    bookmakerId: this.adapter?.bookmakerId || null,
                    matchId: task.bookmakerMatchId || null,
                    expectedRoiPct: task.expectedROI ?? null,
                })}`);
            } catch (_) { /* never fail bet flow on audit */ }
            if (isDryRun) {
                this.logger.log(`🧪🧪🧪 DRY RUN COMPLETED`);
                this.logger.log(`   💰 Would place: ${stake} ${currency} @ ${betResult.odds || outcome.oddVal}`);
                this.logger.log(`   📈 Expected ROI: ${task.expectedROI?.toFixed(2) || 'N/A'}%`);
            } else {
                this.logger.log(`✅✅✅ BET PLACED! Ticket: ${betResult.ticketId}`);
                this.logger.log(`   💰 Stake: ${stake} ${currency} @ ${betResult.odds || outcome.oddVal}`);
                this.logger.log(`   📈 Expected ROI: ${task.expectedROI?.toFixed(2) || 'N/A'}%`);
            }
            
            // Record bet (include matchDate for cross-mode dedup)
            if (!isDryRun) {
                this.limitsManager?.recordBet(task.matchKey, task.outcome, source, stake, task.matchDate);
            }
            
            // Log to calculator
            if (!isDryRun && !this.config.isTest && !this.config.dryRun) {
                if (task.pairFull) {
                    try {
                        await this.calculator.logBetAccept({ task, odds: outcome.oddVal, stake, strategy });
                    } catch (e) {
                        this.logger.error(`⚠️ Calculator API error: ${e.message}`);
                    }
                } else {
                    this.logger.log('ℹ️ Skipping calculator log: task.pairFull unavailable');
                }
            }

            // Telegram notification — check delivery and retry plaintext on failure
            try {
                const tgResults = await this.telegram?.notifyTaskCompleted(task, {
                    ticketId: betResult.ticketId,
                    odds: outcome.oddVal,
                    stake,
                    dryRun: isDryRun,
                    debugMode: isDryRun
                });
                // Check if HTML message was delivered
                if (tgResults && Array.isArray(tgResults)) {
                    const failedCount = tgResults.filter(r => !r.ok).length;
                    if (failedCount > 0) {
                        this.logger.log(`⚠️ notifyTaskCompleted: ${failedCount}/${tgResults.length} failed, retrying plaintext`);
                        const plaintextMessage = isDryRun
                            ? `🧪 DRY RUN\n${task.home || task.homeName} vs ${task.away || task.awayName}\n${task.outcome} @ ${outcome.oddVal}\nСумма: ${stake} ${currency}\nСтавка букмекеру не отправлялась`
                            : `✅ СТАВКА РАЗМЕЩЕНА\n${task.home || task.homeName} vs ${task.away || task.awayName}\n${task.outcome} @ ${outcome.oddVal}\nСтавка: ${stake} ${currency} | Ticket: ${betResult.ticketId}`;
                        await this._sendTaskUpdate(task, plaintextMessage, { parse_mode: null });
                    }
                }
            } catch (e) {
                this.logger.log(`⚠️ notifyTaskCompleted error: ${e.message}`);
            }

            // Record in TasksManager
            this.tasksManager?.recordTaskResult(task, 'completed', {
                odds: outcome.oddVal,
                stake,
                ticketId: betResult.ticketId,
                dryRun: isDryRun
            });

            // Post-bet delay
            if (this.config.postBetDelayMs > 0) {
                this.logger.log(`⏳ Post-bet delay: ${this.config.postBetDelayMs}ms`);
                await new Promise(r => setTimeout(r, this.config.postBetDelayMs));
            }
            
            return { success: true };
        } else {
            this.logger.log(`❌ Bet failed: ${betResult.error}`);
            const errorInfo = this.adapter.parseError(betResult);
            const isBookmakerBalanceReject = errorInfo?.type === BetErrorTypes.INSUFFICIENT_BALANCE;
            const failureStep = isBookmakerBalanceReject ? 'insufficient_balance' : 'bet_submit';
            const failureStage = betResult.failureStage || 'bookmaker_submit';
            task._lastError = betResult.error || 'Unknown error';  // Save for retry loop exit notification
            task._lastFailureStep = failureStep;
            task._lastFailureStage = failureStage;
            // Audit (📝): one structured JSON line per bet outcome — fail path.
            try {
                this.logger.log(`📝 [audit] ${JSON.stringify({
                    kind: 'bet_attempt_audit',
                    finalState: 'rejected',
                    ts: new Date().toISOString(),
                    taskId: task.id || null,
                    activationCode: task.activationCode || null,
                    sourceType: task.sourceType || null,
                    sourceChatId: task.telegramContext?.chatId ?? task.sourceChatId ?? null,
                    sport: task.pair?.sportName || task.sport || null,
                    home: task.home || task.homeName || null,
                    away: task.away || task.awayName || null,
                    outcomeRequested: task._originalOutcome || task.outcome,
                    outcomePlaced: task.outcome,
                    odds: outcome?.oddVal ?? null,
                    stake,
                    bookmakerId: this.adapter?.bookmakerId || null,
                    matchId: task.bookmakerMatchId || null,
                    error: betResult.error || null,
                    bookmakerMessage: betResult.msg || betResult.message || null,
                    failureClass: isBookmakerBalanceReject ? 'insufficient_balance' : (betResult.failureClass || null),
                    failureStage,
                    submitReached: true,
                    bookmakerRejected: true,
                    designStop: /Maksimalna uplata/i.test(betResult.error || betResult.msg || '') || null,
                })}`);
            } catch (_) {}
            const isFinal = task._isLastAttempt || !errorInfo.retryable;
            
            if (isFinal) {
                // Telegram notification
                try {
                    if (!this.config.tgQuiet) await this.telegram?.notifyTaskFailed(task, { 
                        message: betResult.error || 'Unknown error', 
                        step: failureStep,
                        failureStage,
                        submitReached: true
                    });
                    task._notificationSent = true;  // Prevent duplicate notification in retry loop exit
                } catch (e) {}

                // Log to calculator with FAIL_ strategy for CSV price capture
                if (!this.config.skipFailCsv && !this.config.isTest && !this.config.dryRun) {
                    if (task.pairFull) {
                        try {
                            await this.calculator.logBetAccept({
                                task,
                                odds: outcome.oddVal,
                                stake,
							strategy: `FAIL_${strategy}`
                            });
                        } catch (e) {
                            this.logger.error(`⚠️ Calculator FAIL log error: ${e.message}`);
                        }
                    } else {
                        this.logger.log('ℹ️ Skipping calculator FAIL log: task.pairFull unavailable');
                    }
                }

                // Record failed in TasksManager
                this.tasksManager?.recordTaskResult(task, 'failed', {
                    message: betResult.error || 'Unknown error',
                    step: failureStep,
                    failureClass: isBookmakerBalanceReject ? 'insufficient_balance' : betResult.failureClass,
                    failureStage,
                    submitReached: true,
                    bookmakerRejected: true
                });
            }
            
            return { success: false, shouldRetry: errorInfo.retryable, step: failureStep };
        }
    }

    // ==================== NOTIFICATIONS ====================

    _getTaskUpdateRouting(task = {}, options = {}) {
        const bookmaker = options.bookmaker || task.pairFull?.second?.bookmaker || task.bookmaker || this.bookmakerName;
        const baseOptions = this.telegram && typeof this.telegram._getRoutingOptionsForTask === 'function'
            ? this.telegram._getRoutingOptionsForTask(task, bookmaker)
            : { bookmaker };
        return {
            ...baseOptions,
            ...options,
            bookmaker
        };
    }

    async _sendTaskUpdate(task, text, options = {}) {
        if (!this.telegram?.sendToAll) {
            return [];
        }
        return this.telegram.sendToAll(text, this._getTaskUpdateRouting(task, options));
    }

    async _notifyTelegramOutcomeRecheckStarted(task, candidates = [], policy = {}) {
        const escapeHtml = typeof this.telegram?.escapeHtml === 'function'
            ? this.telegram.escapeHtml.bind(this.telegram)
            : (value) => String(value ?? '');
        const outcomes = candidates
            .map((candidate) => candidate?.outcome || candidate?.normalizedOutcome || null)
            .filter(Boolean);
        const preview = outcomes.slice(0, 6).join(', ');
        const previewText = outcomes.length > 6 ? `${preview}, ...` : (preview || task.outcome || '—');
        const intervalSeconds = Math.max(1, Math.round((Number(policy.intervalMs) || 0) / 1000));
        const totalSeconds = Math.max(intervalSeconds, Math.round((Number(policy.totalWindowMs) || 0) / 1000));

        await this._sendTaskUpdate(
            task,
            `⏳ <b>ИСХОД ПОКА НЕ ДОСТУПЕН</b>\n\n` +
                `📋 ${escapeHtml(task.home)} vs ${escapeHtml(task.away)}\n` +
                `🎯 Основной исход: <code>${escapeHtml(task.outcome)}</code>\n` +
                `🔎 Проверяю варианты: <code>${escapeHtml(previewText)}</code>\n` +
                `⏱️ Повтор каждые ${intervalSeconds}с, максимум ${totalSeconds}с`
        );
    }
    
    async _notifyFailed(task, message, step) {
        if (step) {
            task._lastFailureStep = step;
        }
        try {
            if (!this.config.tgQuiet) await this.telegram?.notifyTaskFailed(task, { message, step });
            task._notificationSent = true;  // Prevent duplicate notification in retry loop exit
        } catch (e) {}

        // Record failure in task history so isMatchBlocked can count it
        try {
            this.tasksManager?.recordTaskResult(task, 'failed', { message, step });
        } catch (e) {}

        // Log to calculator with FAIL_ strategy for CSV price capture (always 2 min delay)
        if (task.pairFull && !this.config.skipFailCsv && !this.config.isTest && !this.config.dryRun) {
            try {
                const outcomes = Array.isArray(task.pairFull.outcome) ? task.pairFull.outcome : [task.pairFull.outcome];
                const outcomeData = task.outcomeData || outcomes.find(o => o.outcome === task.outcome) || outcomes[0];
                const odds = outcomeData?.score1?.value || outcomeData?.score2?.value || 0;
                await this.calculator.logBetAccept({
                    task,
                    odds,
                    stake: 0,
					strategy: `FAIL_${step}`
                });
            } catch (e) {
                this.logger.error(`⚠️ Calculator FAIL log error: ${e.message}`);
            }
        }
    }
    
    async _sendOddsChangeWarning(task, betResult) {
        try {
            await this._sendTaskUpdate(
                task,
                `🚨 ВНИМАНИЕ: КОЭФФИЦИЕНТ ИЗМЕНИЛСЯ!\n\n` +
                `📋 Матч: ${task.home} vs ${task.away}\n` +
                `🎯 Исход: ${task.outcome}\n` +
                `❌ Ожидаемый: ${betResult.expectedOdds}\n` +
                `✅ Фактический: ${betResult.odds}\n` +
                `📉 Разница: ${betResult.oddsDiff?.toFixed(3)}\n` +
                `🎫 Тикет: ${betResult.ticketId}\n\n` +
                `⚠️ Ставка принята по ДРУГОМУ коэффициенту!`,
                { parse_mode: null }
            );
        } catch (e) {}
    }
    
    async _sendUncertainWarning(task, outcome, stake, ticketId = null, error = null) {
        try {
            const currency = resolveCurrency(this);
            const errorLine = error ? `\n❌ Ошибка: ${error}` : '';
            await this._sendTaskUpdate(
                task,
                `⚠️ ВНИМАНИЕ: НЕОПРЕДЕЛЁННЫЙ РЕЗУЛЬТАТ!\n\n` +
                `📋 Матч: ${task.home} vs ${task.away}\n` +
                `🎯 Исход: ${task.outcome}\n` +
                `💰 Сумма: ${stake} ${currency} @ ${outcome.oddVal}\n` +
                `🎫 Тикет: ${ticketId || 'N/A'}` +
                errorLine +
                `\n\n❓ Баланс не изменился после 20 сек\n` +
                `⚠️ ПРОВЕРЬТЕ ВРУЧНУЮ!`,
                { parse_mode: null }
            );
        } catch (e) {}
    }
}

module.exports = { BetProcessor };
