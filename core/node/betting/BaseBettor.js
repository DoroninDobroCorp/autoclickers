/**
 * BaseBettor - базовый класс автоматического беттинга
 * 
 * Содержит общую логику:
 * - Lock protection (один процесс)
 * - Stability tracking (ожидание 5 сек)
 * - Fresh data wait before submit
 * - Limits check (calculator, global)
 * - Retry logic при изменении odds
 * - Health endpoint
 * - Graceful shutdown
 * 
 * Использует adapter для специфики букмекера (API/Playwright/Hybrid)
 */

const path = require('path');
const { acquireLock, releaseLock } = require('./LockManager.js');
const { StabilityTracker } = require('./StabilityTracker.js');
const { FreshDataManager } = require('./FreshDataManager.js');
const { LimitsManager } = require('./LimitsManager.js');
const { BetProcessor } = require('./BetProcessor.js');
const { HealthServer } = require('./HealthServer.js');
const { SessionManager } = require('./SessionManager.js');
const { PollingManager } = require('./PollingManager.js');
const { StateManager } = require('./StateManager.js');
const { TaskBuilder } = require('./TaskBuilder.js');
const { LongLivedBetMonitor } = require('./LongLivedBetMonitor.js');
const { CalculatorClient } = require('../integrations/calculator-client.js');
const { TasksManager } = require('../tasks/tasks-manager.js');
const { getResolvedSource, normalizeIdentifier } = require('../tasks/task-source.js');
const { getTaskLimitProfileKey } = require('../tasks/task-limits.js');
const { getTelegramNotifier } = require('../integrations/telegram-notifier.js');
const { AnalyzerClient } = require('../integrations/analyzer-client.js');
const { ChatProfileManager, uniqueChatIds } = require('../telegram/ChatProfileManager.js');
const { CandidateLadderBuilder } = require('../telegram/CandidateLadderBuilder.js');
const { TelegramBotClient } = require('../telegram/TelegramBotClient.js');
const { TelegramSignalParser } = require('../telegram/TelegramSignalParser.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { CopilotSelfHealManager } = require('./CopilotSelfHealManager.js');

// v2 LLM stack
const { buildVisionClient } = require('../llm');
const { buildTextClient } = require('../llm/TextLLMClient.js');
const { MatchLocator } = require('../llm/MatchLocator.js');
const { TextSignalClient } = require('../llm/TextSignalClient.js');
const { OutcomeResolverLLM } = require('../llm/OutcomeResolverLLM.js');
const { createBookmakerAdapter } = require('../bookmakers');

// Config
const constants = require('../config/constants.js');

function normalizeExecutionMode(value) {
    const mode = String(value || 'analyzer-only').trim().toLowerCase();
    if (mode === 'telegram-only' || mode === 'tg-only') return 'telegram-only';
    if (mode === 'hybrid' || mode === 'both') return 'hybrid';
    return 'analyzer-only';
}

function resolveTelegramIngressBotToken(ingressConfig = {}, telegramConfig = {}, env = process.env) {
    return ingressConfig.botToken ||
        ingressConfig.token ||
        telegramConfig.ingressBotToken ||
        telegramConfig.ingress?.botToken ||
        telegramConfig.ingress?.token ||
        env.TELEGRAM_INGRESS_BOT_TOKEN ||
        '';
}

function describeTelegramIngressFix(lastError = '') {
    const errorText = String(lastError || '').toLowerCase();
    if (errorText.includes('unauthorized')) {
        return 'Set a valid TELEGRAM_INGRESS_BOT_TOKEN (or telegram.ingress.botToken) for the ingress bot; generic TG_TOKEN/TELEGRAM_BOT_TOKEN no longer apply here.';
    }
    return 'Set TELEGRAM_INGRESS_BOT_TOKEN (or telegram.ingress.botToken) to the dedicated ingress bot and verify that bot is added to the configured source chats.';
}

function getDefaultTelegramTaskConfig(config = {}) {
    const telegram = config.telegram || {};
    const defaults = telegram.defaults || {};
    const defaultStake = defaults.brm?.stake ??
        defaults.stake ??
        telegram.stake ??
        config.singleStake ??
        constants.DEFAULT_STAKE;
    const defaultMinOdds = defaults.defaultMinOdds ??
        defaults.minOdds ??
        telegram.minOdds ??
        1.7;
    const defaultMaxOdds = defaults.maxOdds ??
        telegram.maxOdds ??
        null;
    const defaultMaxTotalPerMatch = defaults.limits?.maxTotalPerMatch ??
        telegram.maxTotalPerMatch ??
        30;
    const defaultMaxStakePerBet = defaults.limits?.maxStakePerBet ??
        telegram.maxStakePerBet ??
        null;
    const defaultMaxStakePerStrategy = defaults.limits?.maxStakePerStrategy ??
        telegram.maxStakePerStrategy ??
        null;
    const defaultMaxBetsPerMatch = defaults.limits?.maxBetsPerMatch ??
        telegram.maxBetsPerMatch ??
        null;
    const hardCapMaxTotalPerMatch = defaults.limits?.hardCapMaxTotalPerMatch ??
        defaults.limits?.maxExposureHardCap ??
        telegram.hardCapMaxTotalPerMatch ??
        telegram.maxExposureHardCap ??
        500;

    return {
        stake: defaultStake,
        minOdds: defaultMinOdds,
        maxOdds: defaultMaxOdds,
        maxTotalPerMatch: defaultMaxTotalPerMatch,
        maxStakePerBet: defaultMaxStakePerBet,
        maxStakePerStrategy: defaultMaxStakePerStrategy,
        maxBetsPerMatch: defaultMaxBetsPerMatch,
        hardCapMaxTotalPerMatch
    };
}

class BaseBettor {
    constructor(adapter, config = {}) {
        this.adapter = adapter;
        this.bookmakerName = adapter.bookmakerName;
        this.bookmakerId = normalizeIdentifier(adapter.bookmakerName) || 'unknown';
        const executionMode = normalizeExecutionMode(config.executionMode);
        const enableTelegramModeByDefault = executionMode !== 'analyzer-only';
        const enableSharedTaskRunnerByDefault = Boolean(config.tasksFilePath);
        
        // Config with defaults from constants
        this.config = {
            // Core
            analyzerUrl: config.analyzerUrl || constants.DEFAULT_ANALYZER_URL,
            pollIntervalMs: config.pollIntervalMs || constants.POLL_INTERVAL_MS,
            minROI: config.minROI ?? constants.MIN_ROI,
            maxROI: config.maxROI ?? constants.MAX_ROI,
            healthPort: config.healthPort || constants.DEFAULT_HEALTH_PORT,
            sessionCheckIntervalMs: config.sessionCheckIntervalMs || constants.SESSION_CHECK_INTERVAL_MS,
            
            // Strategy
            singleStrategy: config.singleStrategy || false,
            singleDurationSeconds: config.stabilitySeconds || constants.SINGLE_DURATION_SECONDS,
            singleStake: config.stake || constants.DEFAULT_STAKE,
            minUpdates: config.minUpdates || constants.MIN_UPDATES_FOR_STABILITY,
            fastDurationSeconds: config.fast?.durationSeconds || constants.FAST_DURATION_SECONDS,
            slowDurationSeconds: config.slow?.durationSeconds || constants.SLOW_DURATION_SECONDS,
            fastStake: config.fast?.stake ?? constants.DEFAULT_STAKE,
            slowStake: config.slow?.stake ?? constants.DEFAULT_STAKE,
            fastHighROIStake: config.fast?.highROI?.stake ?? constants.DEFAULT_STAKE,
            slowHighROIStake: config.slow?.highROI?.stake ?? constants.DEFAULT_STAKE,
            highROIThreshold: config.highROI?.minROI ?? constants.HIGH_ROI_THRESHOLD,
            
            // Limits
            maxBets: config.maxBets ?? Infinity,
            maxSuccessful: config.maxSuccessful ?? Infinity,
            maxBetsPerMatch: config.maxBetsPerMatch ?? constants.MAX_BETS_PER_MATCH,
            maxRetryAttempts: config.maxRetryAttempts || 3,
            minOdds: config.minOdds ?? constants.MIN_ODDS,
            maxOdds: config.maxOdds ?? constants.MAX_ODDS,
            
            // Protection
            blockDurationMinutes: config.blockDurationMinutes ?? constants.BLOCK_DURATION_MINUTES,
            maxFailedAttempts: config.maxFailedAttempts ?? constants.MAX_FAILED_ATTEMPTS,
            matchBlockDurationMinutes: config.matchBlockDurationMinutes ?? constants.MATCH_BLOCK_DURATION_MINUTES,
            postBetDelayMs: config.postBetDelayMs || constants.POST_BET_DELAY_MS,
            
            // Paths
            lockFilePath: config.lockFilePath || null,
            stateFilePath: config.stateFilePath || null,
            tasksFilePath: config.tasksFilePath || null,
            historyFilePath: config.historyFilePath || null,
            
            // Behavior
            verbose: config.verbose ?? false,
            debug: config.debug ?? false,
            dryRun: config.dryRun ?? false,
            executionMode,
            enableAnalyzerPolling: config.enableAnalyzerPolling ?? (executionMode !== 'telegram-only'),
            enableTelegramQueue: config.enableTelegramQueue ?? enableTelegramModeByDefault,
            enableTaskRunner: config.enableTaskRunner ?? enableSharedTaskRunnerByDefault,
            enableTaskQueueApi: config.enableTaskQueueApi ?? enableTelegramModeByDefault,
            enableTelegramIngress: config.enableTelegramIngress ?? (config.telegram?.ingress?.enabled === true),
            taskRunnerIntervalMs: config.taskRunnerIntervalMs || 1000,
            ignoreROI: config.ignoreROI || false,
            ignoreOddsLimits: config.ignoreOddsLimits || false,
            enableFallback: config.enableFallback ?? true,
            excludedSports: config.excludedSports || [],
            testMode: config.testMode || null,
            
            // Pinnacle odds filter
            pinnacleMinOdds: config.pinnacleMinOdds ?? constants.PINNACLE_MIN_ODDS,
            pinnacleMaxOdds: config.pinnacleMaxOdds ?? constants.PINNACLE_MAX_ODDS,
            
            // Pass through any extra config
            ...config
        };
        this.config.executionMode = normalizeExecutionMode(this.config.executionMode);
        
        this.logger = config.logger || console;
        this.lockFilePath = this.config.lockFilePath;
        this.stateFilePath = this.config.stateFilePath;
        
        // Components
        this.stabilityTracker = new StabilityTracker({
            fast: { durationSeconds: this.config.fastDurationSeconds },
            slow: { durationSeconds: this.config.slowDurationSeconds },
            single: { durationSeconds: this.config.singleDurationSeconds },
            minROI: this.config.minROI,
            highROI: this.config.highROIThreshold,
            freshnessThreshold: this.config.freshnessThreshold,
            pinnacleMaxAge: this.config.pinnacleMaxAge,
            verbose: this.config.verbose,
            logger: this.logger
        });
        
        this.freshDataManager = new FreshDataManager({
            verbose: this.config.verbose,
            logger: this.logger
        });
        
        this.calculator = new CalculatorClient();
        const telegramConfig = this.config.telegram || {};
        const telegramLogsChatId = telegramConfig.logsChatId || process.env.TELEGRAM_LOGS_CHAT_ID;
        const bookmakerChatIds = { ...(telegramConfig.bookmakerChatIds || {}) };
        if (telegramLogsChatId && this.bookmakerName && bookmakerChatIds[this.bookmakerName] === undefined) {
            bookmakerChatIds[this.bookmakerName] = telegramLogsChatId;
        }
        this.telegram = getTelegramNotifier({
            botToken: telegramConfig.botToken || process.env.TELEGRAM_BOT_TOKEN,
            logsChatId: telegramLogsChatId,
            subscribers: telegramConfig.subscribers || [],
            bookmakerChatIds,
            compactMode: telegramConfig.compactMode === true,
            allowedTargetChatIds: telegramConfig.allowedTargetChatIds || telegramConfig.allowedChatIds || []
        });
        this.analyzerClient = new AnalyzerClient({ url: this.config.analyzerUrl });
        this.chatProfileManager = new ChatProfileManager(this.config.telegram || {});
        this.candidateLadderBuilder = new CandidateLadderBuilder(this.config.telegram?.expansion || {});
        this._taskRunnerTimer = null;
        this._taskRunnerBusy = false;
        this._telegramTaskSeq = 0;
        this.telegramBotClient = null;
        this.telegramVisionClient = null;
        this.telegramTextClient = null;
        this.telegramMatchLocator = null;
        this.telegramV2Adapter = null;
        this.telegramSignalParser = null;
        this.telegramIngress = null;
        this._telegramIngressInitError = null;
        
        // Prematch analyzer client for dual polling (prematch priority)
        this.prematchAnalyzerClient = null;
        if (config.prematch?.analyzerUrl && !config.isPrematch) {
            this.prematchAnalyzerClient = new AnalyzerClient({ url: config.prematch.analyzerUrl });
            this.logger.log(`📦 Prematch priority enabled: ${config.prematch.analyzerUrl}`);
        }
        
        // TasksManager - история и лимиты (если указан путь к файлу)
        if (this.config.tasksFilePath) {
            const telegramTaskDefaults = getDefaultTelegramTaskConfig(this.config);
            this.tasksManager = new TasksManager({
                tasksFilePath: this.config.tasksFilePath,
                betting: {
                    stake: this.config.singleStake || constants.DEFAULT_STAKE,
                    minOdds: this.config.minOdds,
                    maxOdds: this.config.maxOdds,
                    highROI: { threshold: this.config.highROIThreshold || 10 },
                    telegram: telegramTaskDefaults,
                    protection: {
                        blockDurationMinutes: this.config.blockDurationMinutes || 15,
                        maxFailedAttempts: this.config.maxFailedAttempts || 3,
                        matchBlockDurationMinutes: this.config.matchBlockDurationMinutes || 30
                    }
                }
            });
            this.logger.log(`📋 TasksManager initialized: ${this.config.tasksFilePath}`);
        } else {
            this.tasksManager = null;
        }
        
        // LimitsManager - handles all limits and bet history
        // SHARED history file: all processes read/write the same file
        const historyFilePath = this.config.historyFilePath || 
            (this.config.tasksFilePath ? 
                path.join(path.dirname(this.config.tasksFilePath), '.bettor_shared_history.json') : null);
        
        this.limitsManager = new LimitsManager({
            bookmaker: this.config.bookmakerName || this.bookmakerName || 'unknown',
            mode: this.config.mode || 'live',
            matchLimitScope: this.config.matchLimitScope || { crossMode: true, crossBookmaker: false },
            maxBets: this.config.maxBets,
            maxSuccessful: this.config.maxSuccessful,
            maxBetsPerMatch: this.config.maxBetsPerMatch || 4,
            maxStakePerBet: this.config.maxStakePerBet || null,
            maxStakePerStrategy: this.config.maxStakePerStrategy || null,
            historyFilePath: historyFilePath,
            historyRetentionHours: this.config.historyRetentionHours || constants.HISTORY_RETENTION_HOURS
        }, this.logger);
        
        // Connect TasksManager if available
        if (this.tasksManager) {
            this.limitsManager.setTasksManager(this.tasksManager);
        }
        
        // State manager (using extracted module)
        this._stateManager = new StateManager({
            filePath: this.stateFilePath,
            limitsManager: this.limitsManager,
            logger: this.logger
        });
        // Expose state for backward compatibility
        this.state = this._stateManager.state;
        
        // Pause control (e.g. insufficient balance)
        this._pausedUntil = null;
        this._pauseReason = null;
        
        // BetProcessor - handles single bet attempts
        this.betProcessor = new BetProcessor({
            adapter: this.adapter,
            freshDataManager: this.freshDataManager,
            limitsManager: this.limitsManager,
            tasksManager: this.tasksManager,  // For outcome blocking and history
            telegram: this.telegram,
            calculator: this.calculator,
            logger: this.logger,
            config: this.config,
            bookmakerName: this.bookmakerName,
            bettor: this  // Reference for pause control
        });
        
        // Self-heal manager - Copilot CLI loop for automated fixes
        const selfHealConfig = config.selfHeal || {};
        this.selfHealManager = new CopilotSelfHealManager({
            enabled: Boolean(selfHealConfig.enabled),
            copilotPath: selfHealConfig.copilotPath,
            bundlesDir: selfHealConfig.bundlesDir || (this.config.tasksFilePath
                ? path.join(path.dirname(this.config.tasksFilePath), 'self_heal_bundles')
                : undefined),
            repoRoot: selfHealConfig.repoRoot,
            logFilePath: this.logger.logFile || null,
            logger: this.logger,
            timeoutMs: selfHealConfig.timeoutMs,
            model: selfHealConfig.model,
            reasoningEffort: selfHealConfig.reasoningEffort,
            extraAllowedDirs: selfHealConfig.extraAllowedDirs,
            onCodeChange: async (payload) => {
                await this._handleSelfHealCodeChange(payload);
            },
            restartOnCodeChange: selfHealConfig.restartOnCodeChange,
            watchPaths: selfHealConfig.watchPaths,
        });
        if (selfHealConfig.enabled) {
            this.logger.log(`🔧 CopilotSelfHealManager enabled (bundles: ${this.selfHealManager.bundlesDir})`);
        }
        
        // Health server (using extracted module)
        this._healthServer = new HealthServer({
            port: this.config.healthPort,
            logger: this.logger,
            getStatus: () => this._getHealthStatus(),
            handlers: this._getHealthHandlers()
        });
        
        // Session manager (using extracted module)
        this._sessionManager = new SessionManager({
            adapter: this.adapter,
            checkIntervalMs: this.config.sessionCheckIntervalMs,
            logger: this.logger
        });
        
        // Wire up session events to update state
        this._sessionManager
            .onLoginSuccess(() => {
                this.state.loginError = null;
                this.state.status = 'active';
            })
            .onLoginFailed((error) => {
                this.state.loginError = error;
                this.state.status = 'login_error';
            })
            .onSessionExpired(() => {
                this.state.lastLoginAttempt = Date.now();
            });
        
        // Polling manager (using extracted module)
        this._pollingManager = new PollingManager({
            analyzerClient: this.analyzerClient,
            prematchAnalyzerClient: this.prematchAnalyzerClient,
            bookmakerName: this.bookmakerName,
            pollIntervalMs: this.config.pollIntervalMs,
            verbose: this.config.verbose,
            debug: this.config.debug,
            logger: this.logger
        });
        
        // Wire up polling events
        this._pollingManager
            .onPairs(async (pairs) => {
                this.freshDataManager.setAnalyzerAvailable(true);
                this.freshDataManager.updateData(pairs, Date.now());
                await this._processPairs(pairs);
            })
            .onAnalyzerDown((reason) => {
                this._handleAnalyzerEmpty(reason);
                this.freshDataManager.setAnalyzerAvailable(false);
            })
            .onAnalyzerUp(() => {
                this._handleAnalyzerRecovered();
            });
        
        // Analyzer availability (tracked by PollingManager now)
        this.analyzerAvailable = true;
        
        // Bet processing lock (prevent parallel bets)
        this.isProcessingBet = false;
        
        // Task builder (extracted from _processStableTracker)
        this._taskBuilder = new TaskBuilder({
            bookmakerName: this.bookmakerName,
            isPrematch: this.adapter.isPrematch || false
        });
        
        // Long-lived bet monitor (sends notifications to HIGH_ROI chat for long-lasting value bets)
        this._longLivedMonitor = new LongLivedBetMonitor({
            telegram: this.telegram,
            logger: this.logger,
            isPrematch: this.adapter.isPrematch || false,
            bookmakerName: this.bookmakerName
        });
        
        // Running state
        this.isRunning = false;
        
        // Session cache for pre-flight checks
        this.lastSessionCheck = 0;
        this.lastSessionValid = false;
        this.SESSION_CHECK_TTL = constants.SESSION_CACHE_TTL_MS;

        this._initializeTelegramIngress();
    }

    // ==================== STATE PERSISTENCE ====================
    // Delegated to StateManager module

    _saveState() { this._stateManager.save(); }
    _loadState() { this._stateManager.load(); }
    _clearState() { this._stateManager.clear(); }

    // ==================== MATCH KEY HELPERS ====================

    _generateMatchKey(home, away, matchDate) {
        return this.limitsManager.generateMatchKey(home, away, matchDate);
    }

    /**
     * Check local limits - delegated to LimitsManager
     */
    _checkLocalLimits(home, away, source, stake, matchDate) {
        const matchKey = this._generateMatchKey(home, away, matchDate);
        return this.limitsManager.checkLocalLimits(matchKey, source, stake);
    }

    // ==================== SESSION MANAGEMENT ====================
    // Delegated to SessionManager module

    async _checkAndRefreshSession() {
        return this._sessionManager._checkAndRefresh();
    }

    _startSessionChecker() {
        this._sessionManager.startChecker();
    }

    _stopSessionChecker() {
        this._sessionManager.stopChecker();
    }

    // ==================== LIMITS CHECK ====================

    _checkLimits() {
        const result = this.limitsManager.checkGoalLimits();
        if (!result.allowed) {
            this.logger.log(`🛑 ${result.reason}`);
            this.state.goalReached = true;
            this._saveState();
            return false;
        }
        return true;
    }

    // ==================== ANALYZER AVAILABILITY ====================

    _handleAnalyzerEmpty(reason = 'Analyzer returned empty dataset') {
        if (!this.analyzerAvailable) return;
        this.analyzerAvailable = false;
        this.logger.log(`🛑 Analyzer paused: ${reason}`);
        
        // Clear stability trackers - data is stale
        const stats = this.stabilityTracker.getStats();
        if (stats.total > 0) {
            this.logger.log(`🧊 Clearing ${stats.total} stability trackers due to analyzer pause`);
            this.stabilityTracker.clear();
        }
    }

    _handleAnalyzerRecovered() {
        if (this.analyzerAvailable) return;
        this.analyzerAvailable = true;
        this.logger.log('✅ Analyzer data stream restored. Resuming betting logic.');
    }

    // ==================== LIFECYCLE ====================

    /**
     * Запустить bettor
     */
    async start() {
        this.logger.log(`Starting ${this.bookmakerName} Bettor...`);
        
        // Acquire lock (prevent duplicate processes)
        if (this.lockFilePath) {
            if (!acquireLock(this.lockFilePath)) {
                throw new Error('Could not acquire lock - another instance may be running');
            }
            
            // Setup cleanup on exit
            const cleanup = () => releaseLock(this.lockFilePath);
            process.on('exit', cleanup);
            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);
            process.on('uncaughtException', (e) => {
                this.logger.error('Uncaught exception:', e);
                cleanup();
                process.exit(1);
            });
        }
        
        // Load saved state
        this._loadState();

        if (!this._checkLimits()) {
            this.logger.log('🎯 Goal already reached from restored state. Exiting before login.');
            if (this.lockFilePath) {
                releaseLock(this.lockFilePath);
            }
            return;
        }
        
        // Login
        const loginOk = await this.adapter.login();
        if (!loginOk) {
            if (this.lockFilePath) releaseLock(this.lockFilePath);
            throw new Error('Failed to login');
        }
        this.logger.log('✅ Login successful');
        
        // Tell BetProcessor that session is fresh (avoid redundant re-check)
        if (this.betProcessor) {
            this.betProcessor._lastSessionCheck = Date.now();
            this.betProcessor._lastSessionValid = true;
        }
        
        // Start health server
        await this._startHealthServer();

        try {
            // Start session checker
            this._startSessionChecker();
            
            this.isRunning = true;
            
            if (this.config.enableAnalyzerPolling) {
                this._startPolling();
            } else {
                this.logger.log('ℹ️ Analyzer polling disabled for this runtime');
            }

            if (this.config.enableTaskRunner) {
                this._startTaskRunner();
            }

            if (this.config.enableTelegramIngress) {
                await this._startTelegramIngress();
            }
        } catch (error) {
            this.isRunning = false;
            this._stopPolling();
            this._stopTaskRunner();
            await this._stopTelegramIngress();
            this._stopSessionChecker();
            await this._stopHealthServer();
            await this.adapter.close();
            if (this.lockFilePath) {
                releaseLock(this.lockFilePath);
            }
            throw error;
        }
        
        // Log mode
        let modeText;
        const _hasMaxSuccessful = this.config.maxSuccessful !== Infinity;
        const _hasMaxBets = this.config.maxBets !== Infinity;
        if (_hasMaxSuccessful && _hasMaxBets) {
            modeText = `🎯 ${this.config.maxSuccessful} успешных ставок ИЛИ 🎲 ${this.config.maxBets} попыток (что раньше)`;
            this.logger.log(`⚙️ Mode: ${this.config.maxSuccessful} successful OR ${this.config.maxBets} attempts (whichever first)`);
        } else if (_hasMaxSuccessful) {
            modeText = `🎯 ${this.config.maxSuccessful} успешных ставок`;
            this.logger.log(`⚙️ Mode: ${this.config.maxSuccessful} successful bets`);
        } else if (_hasMaxBets) {
            modeText = `🎲 ${this.config.maxBets} попыток ставок`;
            this.logger.log(`⚙️ Mode: ${this.config.maxBets} bet attempts`);
        } else {
            modeText = '♾️ Бесконечный режим';
            this.logger.log(`⚙️ Mode: Continuous (infinite)`);
        }
        this.logger.log(`📡 Execution mode: ${this.config.executionMode}`);
        
        this.logger.log(`🚀 ${this.bookmakerName} Bettor started`);
        
        // Send startup Telegram notification (suppressed in unified mode — unified sends its own)
        if (!this.config.suppressTelegramStartStop) {
            try {
                const stakeInfo = this.config.singleStrategy 
                    ? `${this.config.singleStake} EUR (single strategy)`
                    : `${this.config.fastStake}, ${this.config.fastHighROIStake}, ${this.config.slowStake}, ${this.config.slowHighROIStake} EUR`;
                const stabilityInfo = this.config.singleStrategy
                    ? `⏱️ Стабильность: ${this.config.singleDurationSeconds}s`
                    : '';
                const isPrematch = this.adapter.isPrematch ? '⏰ PREMATCH' : 
                    (this.prematchAnalyzerClient ? '🔴 LIVE + ⏰ PREMATCH PRIORITY' : '🔴 LIVE');
                const sportsFilter = this.config.allowedSports?.length 
                    ? `⚽ Спорт: ${this.config.allowedSports.join(', ')}`
                    : '⚽ Спорт: все';
                const oddsRange = `📈 Коэфф: ${this.config.minOdds}-${this.config.maxOdds}`;
                const pinnacleRange = `🔒 Pinnacle: ${this.config.pinnacleMinOdds}-${this.config.pinnacleMaxOdds}`;
                await this.telegram.sendToAll(
                    `🚀 <b>${this.bookmakerName.toUpperCase()} BETTOR</b> запущен [${isPrematch}]\n\n` +
                    `⚙️ Режим: ${modeText}\n` +
                    `📊 ROI >= ${this.config.minROI}%\n` +
                    `💰 Ставки: ${stakeInfo}\n` +
                    (stabilityInfo ? `${stabilityInfo}\n` : '') +
                    `${sportsFilter}\n` +
                    `${oddsRange}\n` +
                    `${pinnacleRange}\n` +
                    `🔄 Автоперезапуск: ${this.state.restartCount > 0 ? `✅ (restart #${this.state.restartCount})` : '✅'}\n\n` +
                    `🕐 ${new Date().toLocaleString('ru-RU')}`,
                    { parse_mode: 'HTML', bookmaker: this.bookmakerName }
                );
                this.logger.log(`📱 Telegram notification sent (startup)`);
            } catch (e) {
                this.logger.error(`Telegram startup notification error: ${e.message}`);
            }
        } else {
            this.logger.log(`📱 Telegram startup suppressed (unified mode)`);
        }
        
        // Return a promise that resolves only when goal is reached or bettor is stopped.
        // Without this, start() resolves immediately and callers think the goal was reached.
        return new Promise((resolve) => {
            this._doneResolve = resolve;
        });
    }

    /**
     * Остановить bettor
     */
    async stop() {
        this.logger.log(`Stopping ${this.bookmakerName} Bettor...`);
        this.isRunning = false;
        
        // Stop polling (delegated to PollingManager)
        this._stopPolling();

        this._stopTaskRunner();
        await this._stopTelegramIngress();
        
        // Stop session checker (delegated to SessionManager)
        this._stopSessionChecker();
        
        await this._stopHealthServer();
        await this.selfHealManager?.dispose?.();
        await this.adapter.close();
        
        // Save state
        this._saveState();
        
        // Release lock
        if (this.lockFilePath) {
            releaseLock(this.lockFilePath);
        }
        
        // Send shutdown Telegram notification (suppressed in unified mode)
        if (!this.config.suppressTelegramStartStop) {
            try {
                const ls = this.limitsManager.getState();
                const uptimeMs = Date.now() - this.state.started;
                const uptimeMin = Math.floor(uptimeMs / 60000);
                const uptimeSec = Math.floor((uptimeMs % 60000) / 1000);
                
                const lastBet = this.state.lastSuccessfulBet;
                const lastBetInfo = lastBet
                    ? `\n🏆 Последняя ставка:\n   ${lastBet.home} vs ${lastBet.away}\n   ${lastBet.outcome} @ ${lastBet.odds}\n   💰 ${lastBet.stake} EUR\n`
                    : '';
                await this.telegram.sendToAll(
                    `🛑 <b>${this.bookmakerName.toUpperCase()} BETTOR</b> остановлен\n\n` +
                    `📊 Результаты сессии:\n` +
                    `   ✅ Успешных ставок: <b>${ls.betsPlaced}</b>\n` +
                    `   🎯 Всего попыток: <b>${ls.betAttempts}</b>\n` +
                    `   ❌ Ошибок: <b>${this.state.errors}</b>${lastBetInfo}\n\n` +
                    `⏱️ Время работы: ${uptimeMin}м ${uptimeSec}с\n` +
                    `🕐 ${new Date().toLocaleString('ru-RU')}`,
                    { parse_mode: 'HTML', bookmaker: this.bookmakerName }
                );
                this.logger.log(`📱 Telegram notification sent (shutdown)`);
            } catch (e) {
                this.logger.error(`Telegram shutdown notification error: ${e.message}`);
            }
        }
        
        this.logger.log(`🛑 ${this.bookmakerName} Bettor stopped`);
        
        // Resolve the start() promise so the caller can exit cleanly
        if (this._doneResolve) { this._doneResolve(); this._doneResolve = null; }
    }

    async _handleSelfHealCodeChange(payload = {}) {
        const changedPaths = Array.isArray(payload.runtimeChangedPaths)
            ? payload.runtimeChangedPaths
            : [];
        if (changedPaths.length > 0) {
            const preview = changedPaths.slice(0, 5).join(', ');
            this.logger.log(`[SelfHeal] Runtime code changes detected (${changedPaths.length})${preview ? `: ${preview}` : ''}`);
        }

        const hook = this.config.selfHeal?.onCodeChange;
        if (typeof hook === 'function') {
            await Promise.resolve(hook({
                ...payload,
                bettor: this,
            }));
        }
    }

    // ==================== PAUSE CONTROL ====================
    
    /**
     * Pause betting for specified minutes (e.g. insufficient balance)
     */
    pauseFor(minutes, reason = 'Unknown reason') {
        const pauseUntil = Date.now() + minutes * 60 * 1000;
        this._pausedUntil = pauseUntil;
        this._pauseReason = reason;
        
        const resumeTime = new Date(pauseUntil).toLocaleTimeString('ru-RU');
        this.logger.log(`⏸️ PAUSED for ${minutes} minutes until ${resumeTime}`);
        this.logger.log(`   Reason: ${reason}`);
    }
    
    /**
     * Check if currently paused
     */
    isPaused() {
        if (!this._pausedUntil) return false;
        
        if (Date.now() >= this._pausedUntil) {
            // Pause expired
            this.logger.log(`▶️ Pause ended, resuming operations`);
            this._pausedUntil = null;
            this._pauseReason = null;
            return false;
        }
        
        return true;
    }
    
    /**
     * Get remaining pause time in minutes
     */
    getPauseRemaining() {
        if (!this._pausedUntil) return 0;
        const remaining = this._pausedUntil - Date.now();
        return Math.max(0, Math.ceil(remaining / 60000));
    }

    // ==================== POLLING ====================
    // Delegated to PollingManager module

    _startPolling() {
        this._pollingManager.start();
    }
    
    _stopPolling() {
        this._pollingManager.stop();
    }

    _hasSharedTaskRunner() {
        return Boolean(this.tasksManager && this.config.enableTaskRunner);
    }

    _hasQueuedTaskWork() {
        if (!this._hasSharedTaskRunner()) {
            return false;
        }

        return Boolean(
            this.tasksManager.getCurrentTask(this.bookmakerId) ||
            this.tasksManager.getPendingTask(this.bookmakerId) ||
            this.tasksManager.isProcessing(this.bookmakerId)
        );
    }

    _initializeTelegramIngress() {
        if (!this.config.enableTelegramIngress) {
            return;
        }

        if (!this.config.enableTelegramQueue) {
            this._telegramIngressInitError = 'Telegram ingress requires telegram queue to be enabled';
            this.logger.log(`⚠️ ${this._telegramIngressInitError}`);
            return;
        }

        if (!this.tasksManager) {
            this._telegramIngressInitError = 'Telegram ingress requires TasksManager';
            this.logger.log(`⚠️ ${this._telegramIngressInitError}`);
            return;
        }

        const telegramConfig = this.config.telegram || {};
        const ingressConfig = telegramConfig.ingress || {};
        const botToken = resolveTelegramIngressBotToken(ingressConfig, telegramConfig, process.env);
        if (!botToken) {
            this._telegramIngressInitError = 'Telegram ingress requires TELEGRAM_INGRESS_BOT_TOKEN or telegram.ingress.botToken';
            this.logger.log(`⚠️ ${this._telegramIngressInitError}`);
            return;
        }

        const storagePaths = this._getTelegramIngressStoragePaths(ingressConfig);
        const llmConfig = {
            ...(this.config.debug?.ai || {}),
            ...(telegramConfig.llm || {})
        };
        const textLlmConfig = {
            ...(telegramConfig.llmText || {})
        };

        this.telegramBotClient = ingressConfig.botClient || telegramConfig.botClient || new TelegramBotClient({
            botToken,
            apiHost: ingressConfig.apiHost,
            logger: this.logger
        });

        // ─── v2 LLM stack ─────────────────────────────────────────────
        // Vision parses the screenshot. Text LLM does match-locator across
        // the active bookmaker catalog. Bookmaker-specific catalog/submit
        // details live behind the v2 BookmakerAdapter registry, not here.
        this.telegramVisionClient = ingressConfig.visionClient || telegramConfig.visionClient
            || buildVisionClient({ logger: this.logger, ...llmConfig });
        this.telegramTextClient = ingressConfig.textClient || telegramConfig.textClient
            || buildTextClient({ logger: this.logger, ...llmConfig, ...textLlmConfig });
        this.telegramMatchLocator = ingressConfig.matchLocator || telegramConfig.matchLocator
            || new MatchLocator({ textClient: this.telegramTextClient, logger: this.logger });
        this.telegramTextSignalClient = ingressConfig.textSignalClient || telegramConfig.textSignalClient
            || new TextSignalClient({ textClient: this.telegramTextClient, logger: this.logger });
        this.telegramOutcomeResolver = ingressConfig.outcomeResolver || telegramConfig.outcomeResolver
            || new OutcomeResolverLLM({ textClient: this.telegramTextClient, logger: this.logger });
        try {
            this.telegramV2Adapter = createBookmakerAdapter({
                bookmakerId: this.bookmakerId,
                legacyAdapter: this.adapter,
                config: this.config,
                telegramConfig,
                ingressConfig,
                logger: this.logger,
            });
        } catch (error) {
            this._telegramIngressInitError = error.message;
            this.logger.log(`⚠️ ${this._telegramIngressInitError}`);
            return;
        }

        this.telegramSignalParser = ingressConfig.signalParser || telegramConfig.signalParser
            || new TelegramSignalParser({
                visionClient: this.telegramVisionClient,
                matchLocator: this.telegramMatchLocator,
                adapter: this.telegramV2Adapter,
                textSignalClient: this.telegramTextSignalClient,
                outcomeResolver: this.telegramOutcomeResolver,
                logger: this.logger,
                lowConfGate: typeof ingressConfig.lowConfGate === 'number' ? ingressConfig.lowConfGate : (telegramConfig.lowConfGate ?? 0.5),
                highConfGate: typeof ingressConfig.highConfGate === 'number' ? ingressConfig.highConfGate : (telegramConfig.highConfGate ?? 0.85),
                minResolvedConfidence: typeof llmConfig.minResolvedConfidence === 'number' ? llmConfig.minResolvedConfidence : 0.65,
            });

        this.telegramIngress = ingressConfig.instance || telegramConfig.ingressInstance || new TelegramPollingIngress({
            botClient: this.telegramBotClient,
            chatProfileManager: this.chatProfileManager,
            signalParser: this.telegramSignalParser,
            onResolvedSignal: async (task, meta) => this.enqueueTelegramTask({
                ...task,
                parsedSignal: meta?.parsedSignal || null
            }),
            onStopSignal: async (payload) => this.stopTelegramSignal(payload),
            notifier: this.telegram,
            logger: this.logger,
            bookmakerName: this.bookmakerName,
            bookmakerId: this.bookmakerId,
            accountId: normalizeIdentifier(this.config.accountId) || null,
            runtimeMode: this.adapter.isPrematch ? 'prematch' : 'live',
            defaultProfileId: ingressConfig.defaultProfileId || telegramConfig.defaultProfileId || null,
            allowUnmappedChats: ingressConfig.allowUnmappedChats === true,
            pollTimeoutSeconds: ingressConfig.pollTimeoutSeconds,
            pollRetryMs: ingressConfig.pollRetryMs,
            externalUpdatesOnly: ingressConfig.externalUpdatesOnly === true,
            sessionWindowMs: ingressConfig.sessionWindowMs,
            finalizeAfterMs: ingressConfig.finalizeAfterMs,
            clarificationTimeoutMs: ingressConfig.clarificationTimeoutMs,
            allowedUpdates: ingressConfig.allowedUpdates,
            downloadsDir: storagePaths.downloadsDir,
            stateFilePath: storagePaths.stateFilePath,
            // F1 (review_7): wire persistent dedupe registry and tasks file
            // path so cross-restart dedupe (the F5/F7 atomic-write + restored
            // TTL + orphan-task pruning logic) is actually exercised in
            // production. Defaults live alongside the existing state file;
            // launcher overrides via ingressConfig take precedence.
            dedupeFilePath: ingressConfig.dedupeFilePath || storagePaths.dedupeFilePath,
            tasksFilePath: ingressConfig.tasksFilePath || this.config.tasksFilePath || null,
            restoredDedupeTtlMs: ingressConfig.restoredDedupeTtlMs,
            recentSignalsLimit: ingressConfig.recentSignalsLimit,
            // P1 fix (2026-05-29): plumb envelopeDumpDir from sandbox/prod
            // config into ingress. Without this the shadow-corpus directory
            // was always null and envelope_dumps_written stayed at 0 even
            // when admins set the path in config.telegram.ingress.envelopeDumpDir.
            envelopeDumpDir: ingressConfig.envelopeDumpDir || null,
            quiet: this.config.tgQuiet === true || ingressConfig.quiet === true
        });
        // F2 (review_4): wire ingress reference into the notifier so outbound
        // task notices register their resulting message_ids back into the draft
        // index. Enables STOP-by-reply against queued/lifecycle anchors before
        // any clarification has been issued.
        if (typeof this.telegram?.setIngress === 'function') {
            this.telegram.setIngress(this.telegramIngress);
        }
        this._telegramIngressInitError = null;
    }

    _getTelegramIngressStoragePaths(ingressConfig = {}) {
        const stateBasePath = this.config.tasksFilePath || this.config.stateFilePath || path.join(process.cwd(), '.bettor_tasks.json');
        const baseDir = ingressConfig.rootDir || path.join(path.dirname(stateBasePath), '.telegram_ingress');
        const runtimeMode = this.adapter.isPrematch ? 'prematch' : 'live';
        const accountId = normalizeIdentifier(this.config.accountId) || 'default';
        return {
            rootDir: baseDir,
            downloadsDir: ingressConfig.downloadsDir || path.join(baseDir, 'downloads', `${this.bookmakerId}_${accountId}_${runtimeMode}`),
            stateFilePath: ingressConfig.stateFilePath || path.join(baseDir, `${this.bookmakerId}_${accountId}_${runtimeMode}_state.json`),
            // F1 (review_7): default dedupe registry path lives alongside the
            // ingress state file so persistence happens out-of-the-box.
            dedupeFilePath: ingressConfig.dedupeFilePath || path.join(baseDir, `${this.bookmakerId}_${accountId}_${runtimeMode}_dedupe.json`)
        };
    }

    async _startTelegramIngress() {
        if (!this.config.enableTelegramIngress) {
            return;
        }

        if (this._telegramIngressInitError) {
            throw new Error(this._telegramIngressInitError);
        }

        if (!this.telegramIngress) {
            throw new Error('Telegram ingress is enabled but not initialized');
        }

        await this.telegramIngress.start();
    }

    async _stopTelegramIngress() {
        if (!this.telegramIngress) {
            return;
        }

        try {
            await this.telegramIngress.stop();
        } catch (error) {
            this.logger.error(`Telegram ingress stop error: ${error.message}`);
        }
    }

    /**
     * Обработать пары от analyzer
     * 
     * CRITICAL FIX (2025-12-08): Отслеживаем исчезновение outcomes!
     * Если outcome не пришёл в текущем poll - значит линия закрыта на Pinnacle.
     * Раньше такие trackers оставались в памяти 30 секунд и могли триггернуть ставку.
     */
    async _processPairs(pairs) {
        const now = Date.now();
        let eligibleOutcomesFound = 0;
        const fallbackCandidates = [];
        
        // CRITICAL: Track which outcomes we see in THIS poll
        // Outcomes not seen = line closed on Pinnacle = must remove tracker immediately
        const seenTrackerKeys = new Set();

        for (const pair of pairs) {
            // Sport filtering
            const sportName = (pair.sportName || '').toLowerCase();
            
            // WHITELIST: If allowedSports is set, only process these sports
            if (this.config.allowedSports && this.config.allowedSports.length > 0) {
                const isAllowed = this.config.allowedSports.some(s => sportName === s.toLowerCase());
                if (!isAllowed) {
                    continue;
                }
            }
            
            // BLACKLIST: excludedSports (legacy support)
            if (this.config.excludedSports && this.config.excludedSports.length > 0) {
                if (this.config.excludedSports.some(s => sportName === s.toLowerCase())) {
                    continue;
                }
            }
            
            for (const outcome of (pair.outcome || [])) {
                const matchKey = `${pair.first?.matchId}_${pair.second?.matchId}`;
                
                                // ROI checks
                const meetsROI = this.config.ignoreROI || outcome.roi >= this.config.minROI;
                const exceedsMaxROI = !this.config.ignoreROI && outcome.roi > this.config.maxROI;
                
                // Block bets with suspiciously high ROI (> 18%)
                // Still track for monitoring but don't allow actual betting (silent)
                
                if (!meetsROI) {
                    // CRITICAL FIX (2025-12-06): Update existing trackers even when ROI drops!
                    // Without this, ROI can "skip" updates and bets trigger prematurely.
                    // Bug: If ROI drops below minROI, track() wasn't called, so:
                    //   - lastSeenAt wasn't updated
                    //   - accumulatedStabilityMs wasn't reset!
                    // Fix: Call track() for existing trackers to reset their timers.
                    const strategies = this.config.singleStrategy ? ['single'] : ['fast', 'slow'];
                    const isFirstOurs = (pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
                    const expectedOdds = isFirstOurs ? outcome.score1?.value : outcome.score2?.value;
                    
                    for (const type of strategies) {
                        const key = this.stabilityTracker.makeKey(matchKey, outcome.outcome, type);
                        // CRITICAL: Mark as seen even for low ROI - outcome exists in analyzer response
                        seenTrackerKeys.add(key);
                        
                        const existingTracker = this.stabilityTracker.get(key);
                        
                        if (existingTracker && !existingTracker.betPlaced) {
                            // Tracker exists - update it with low ROI (this will reset the timer!)
                            this.stabilityTracker.track({
                                matchId: matchKey,
                                outcome: outcome.outcome,
                                roi: outcome.roi,  // Low ROI - will reset accumulatedStabilityMs
                                pair,
                                outcomeData: outcome,
                                type,
                                allowLowROI: false,
                                minUpdates: this.config.minUpdates,
                                odds: expectedOdds
                            });
                            // Silent reset - no logging
                        }
                    }
                    
                    // Collect for potential fallback (only if enableFallback is on)
                    if (this.config.enableFallback) {
                        fallbackCandidates.push({ pair, outcome, matchKey });
                    }
                    continue;
                }
                
                eligibleOutcomesFound++;
                
                // Determine which side is our bookmaker
                const isFirstOurs = (pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
                const ourSide = isFirstOurs ? pair.first : pair.second;
                const homeName = ourSide.homeName || pair.first?.homeName || 'Unknown';
                const awayName = ourSide.awayName || pair.first?.awayName || 'Unknown';
                const expectedOdds = isFirstOurs ? outcome.score1?.value : outcome.score2?.value;

                // Track for stability
                const strategies = this.config.singleStrategy ? ['single'] : ['fast', 'slow'];
                for (const type of strategies) {
                    const key = this.stabilityTracker.makeKey(matchKey, outcome.outcome, type);
                    // CRITICAL: Mark as seen - this outcome exists in current poll
                    seenTrackerKeys.add(key);
                    
                    const result = this.stabilityTracker.track({
                        matchId: matchKey,
                        outcome: outcome.outcome,
                        roi: outcome.roi,
                        pair,
                        outcomeData: outcome,
                        type,
                        allowLowROI: false,
                        minUpdates: this.config.minUpdates,
                        odds: expectedOdds  // Для проверки закрытого рынка
                    });
                    
                    // Mark tracker as blocked if ROI exceeds maxROI (for monitoring only, no betting)
                    if (exceedsMaxROI && result.tracker) {
                        result.tracker.blockedByMaxROI = true;
                    } else if (result.tracker && result.tracker.blockedByMaxROI) {
                        // Unblock if ROI dropped back below maxROI
                        result.tracker.blockedByMaxROI = false;
                        if (this.config.verbose) {
                            this.logger.log(`✅ ROI normalized (${outcome.roi.toFixed(2)}% <= ${this.config.maxROI}%), unblocking: ${outcome.outcome}`);
                        }
                    }
                    
                    // Silent tracking until stability reached - logging moved to bet execution
                }
            }
        }
        
        // Fallback: if no good outcomes, pick the best low-ROI one
        if (this.config.enableFallback && eligibleOutcomesFound === 0 && fallbackCandidates.length > 0) {
            // Sort by ROI descending
            fallbackCandidates.sort((a, b) => (b.outcome?.roi || -Infinity) - (a.outcome?.roi || -Infinity));
            const fallback = fallbackCandidates[0];
            
            if (fallback && fallback.pair && fallback.outcome) {
                const homeName = fallback.pair.first?.homeName || fallback.pair.second?.homeName || 'Unknown';
                const awayName = fallback.pair.first?.awayName || fallback.pair.second?.awayName || 'Unknown';
                const roiLabel = fallback.outcome.roi?.toFixed(2) || 'n/a';
                const isFirstOursFallback = (fallback.pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
                const fallbackOdds = isFirstOursFallback ? fallback.outcome.score1?.value : fallback.outcome.score2?.value;
                
                // Silent fallback tracking - no logging
                
                // Track with allowLowROI = true
                const fallbackStrategies = this.config.singleStrategy ? ['single'] : ['fast', 'slow'];
                for (const type of fallbackStrategies) {
                    const key = this.stabilityTracker.makeKey(fallback.matchKey, fallback.outcome.outcome, type);
                    // CRITICAL: Mark fallback as seen too
                    seenTrackerKeys.add(key);
                    
                    this.stabilityTracker.track({
                        matchId: fallback.matchKey,
                        outcome: fallback.outcome.outcome,
                        roi: fallback.outcome.roi,
                        pair: fallback.pair,
                        outcomeData: fallback.outcome,
                        type,
                        allowLowROI: true,
                        minUpdates: this.config.minUpdates,
                        odds: fallbackOdds  // Для проверки закрытого рынка
                    });
                }
            }
        }

        // If outcome disappeared from this analyzer poll, mark it as temporarily missing.
        // This prevents betting while absent, but preserves accumulated stability for short gaps.
        let missingCount = 0;
        for (const [key, tracker] of this.stabilityTracker.trackers) {
            if (!seenTrackerKeys.has(key) && !tracker.betPlaced) {
                if (this.stabilityTracker.markMissingFromPoll(key)) {
                    missingCount++;
                }
            }
        }
        if (missingCount > 0 && this.config.debug) {
            this.logger.log(`🧊 Marked ${missingCount} trackers as missing from analyzer poll`);
        }

        // Check for stable outcomes ready to bet
        const stableTrackers = this.stabilityTracker.getStableTrackers();
        
        // DEBUG: Log stable trackers count
        if (this.config.debug && stableTrackers.length > 0) {
            this.logger.log(`🔍 DEBUG: Found ${stableTrackers.length} stable trackers`);
            stableTrackers.forEach((t, i) => {
                this.logger.log(`   [${i}] ${t.outcome} | ROI: ${t.lastROI?.toFixed(2)}% | betPlaced: ${t.betPlaced} | blocked: ${t.blockedByMaxROI || false}`);
            });
        }
        
        for (const tracker of stableTrackers) {
            // Check Long-Lived Bet Monitor (sends notification to HIGH_ROI chat)
            // Works for ALL stable trackers regardless of blockedByMaxROI
            await this._longLivedMonitor.check(tracker);
            
            // Skip betting if ROI exceeds maxROI (but still monitored above)
            if (tracker.blockedByMaxROI) {
                this.logger.log(`🚫 BLOCKED (ROI > ${this.config.maxROI}%): ${tracker.outcome} | ROI: ${tracker.lastROI?.toFixed(2)}%`);
                this.stabilityTracker.markBetPlaced(tracker.key); // Mark to prevent re-processing
                continue;
            }
            
            // Check if another bet is being processed (prevent parallel bets)
            if (this.isProcessingBet) {
                if (this.config.debug) {
                    this.logger.log(`🔍 DEBUG: Skipping tracker (isProcessingBet=true): ${tracker.outcome}`);
                }
                continue;
            }

            if (this._hasQueuedTaskWork()) {
                if (this.config.debug) {
                    this.logger.log(`🔍 DEBUG: Skipping analyzer tracker because task queue is busy (${tracker.outcome})`);
                }
                continue;
            }
            
            // Check if paused (e.g. insufficient balance)
            if (this.isPaused()) {
                const remaining = this.getPauseRemaining();
                this.logger.log(`⏸️ Paused (${remaining}m remaining): ${this._pauseReason || 'Unknown'}`);
                continue;
            }
            
            // Check limits before processing
            if (!this._checkLimits()) {
                this.logger.log(`🎯 Goal reached! Stopping...`);
                await this.stop();
                if (this._doneResolve) { this._doneResolve(); this._doneResolve = null; }
                return;
            }
            // CRITICAL FIX: Don't await here!
            // Processing a bet takes 5-10 seconds (login, find match, etc).
            // If we await, polling is blocked and freshDataManager doesn't get updates.
            // This causes "Pinnacle data stale" failures because no fresh data arrives.
            // Run async without blocking the poll loop.
            this._processStableTracker(tracker).catch(e => {
                this.logger.error(`❌ _processStableTracker error: ${e.message}`);
            });
        }

        // Cleanup old trackers
        this.stabilityTracker.cleanup();
    }

    // ==================== BET PROCESSING ====================

    async _processStableTracker(tracker) {
        const { pair, outcomeData, type } = tracker;
        
        // DEBUG: Log entry
        if (this.config.debug) {
            this.logger.log(`🔍 DEBUG: _processStableTracker START | key: ${tracker.key} | isProcessingBet was: ${this.isProcessingBet}`);
        }
        
        try {
            // Determine home/away
            const isFirstOurs = (pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
            const ourSide = isFirstOurs ? pair.first : pair.second;
            const home = ourSide.homeName;
            const away = ourSide.awayName;

            // Detailed log like old bettor
            const accumulatedMs = tracker.accumulatedStabilityMs || 0;
            const fallbackLabel = tracker.allowLowROI ? ' 🐟 FALLBACK' : '';
            const expectedOdds = isFirstOurs ? outcomeData.score1?.value : outcomeData.score2?.value;
            const isHighROI = tracker.lastROI >= this.config.highROIThreshold;
            
            // Calculate stake for log
            const displayStake = this._getStrategyStake(type, isHighROI);
            
            const dataAge = tracker.lastSeenAt ? (Date.now() - tracker.lastSeenAt) : 0;
            this.logger.log(`\n${'='.repeat(80)}`);
            this.logger.log(`✅ СТАБИЛЬНЫЙ ${type.toUpperCase()} (${(accumulatedMs/1000).toFixed(1)}s accumulated)${fallbackLabel}: ${home} vs ${away} | ${tracker.outcome}`);
            this.logger.log(`   ROI: ${tracker.lastROI.toFixed(2)}% | Odds: ${expectedOdds} | Data age: ${(dataAge/1000).toFixed(1)}s`);
            this.logger.log(`   Stake: ${displayStake} EUR | Strategy: ${type}${isHighROI ? ' (high ROI)' : ''}`);
            this.logger.log(`   Sport: ${pair.sportName || 'Unknown'}, League: ${ourSide.leagueName || 'Unknown'}`);
            
            // DEBUG: Detailed odds tracking for mismatch investigation
            const pinnacleCreatedAt = pair.first?.createdAt ? new Date(pair.first.createdAt) : null;
            const pinnacleAge = pinnacleCreatedAt ? (Date.now() - pinnacleCreatedAt.getTime()) / 1000 : null;
            const pinnacleOdds = outcomeData.score1?.value;
            const bookmakerOdds = outcomeData.score2?.value;
            this.logger.log(`   📊 ODDS DEBUG: Pinnacle=${pinnacleOdds}, Bookmaker=${bookmakerOdds}, Expected=${expectedOdds}`);
            this.logger.log(`   📊 PINNACLE AGE: ${pinnacleAge?.toFixed(1) || 'N/A'}s (createdAt: ${pinnacleCreatedAt?.toISOString() || 'N/A'})`);
            this.logger.log(`   📊 TIMESTAMP NOW: ${new Date().toISOString()}`);

            // CRITICAL: Fallback = monitor-only, do NOT place real bets!
            if (tracker.allowLowROI) {
                this.logger.log(`🐟 Fallback tracker reached stability, but stake placement skipped (monitor-only).`);
                this.stabilityTracker.markBetPlaced(tracker.key);
                return;
            }

            // SAFETY CHECK: Re-verify ROI hasn't dropped during queue wait
            if (!this.config.ignoreROI && tracker.lastROI < this.config.minROI) {
                this.logger.log(`⚠️ ROI dropped during queue: ${tracker.lastROI.toFixed(2)}% < ${this.config.minROI}%. Skipping.`);
                this.stabilityTracker.markBetPlaced(tracker.key);
                return;
            }

            // EARLY MATCH LIMIT CHECK - before creating task or counting attempt
            const matchDate = pair.first?.matchDate || null;
            const matchKey = this._generateMatchKey(pair.first?.homeName || home, pair.first?.awayName || away, matchDate);
            const matchStats = this.limitsManager.getMatchStats(matchKey);
            if (matchStats && matchStats.count >= this.limitsManager.maxBetsPerMatch && !this.config.enableSafeOppositeBets) {
                this.logger.log(`⚠️ Match limit already reached (${matchStats.count}/${this.limitsManager.maxBetsPerMatch}): ${home} vs ${away} | ${tracker.outcome}. Skipping (no attempt counted).`);
                this.stabilityTracker.markBetPlaced(tracker.key);
                if (!this.config.tgQuiet) {
                    this.telegram.notifySkipped({ matchKey, home, away, outcome: tracker.outcome, expectedROI: tracker.lastROI, isPrematch: tracker.isPrematch, bookmaker: this.bookmakerName, pair, pairFull: pair }, `Лимит на матч (${matchStats.count}/${this.limitsManager.maxBetsPerMatch})`).catch(() => {});
                }
                return;
            }

            // PRE-CHECK: Pinnacle odds range before counting attempt (bookmaker odds can be any value)
            const pinnacleOddsForCheck = isFirstOurs ? outcomeData.score2?.value : outcomeData.score1?.value;
            if (pinnacleOddsForCheck) {
                const maxOdds = this.config.pinnacleMaxOdds || this.config.maxOdds || 4.0;
                const minOdds = this.config.pinnacleMinOdds || this.config.minOdds || 1.1;
                if (pinnacleOddsForCheck > maxOdds) {
                    this.logger.log(`⚠️ Pinnacle odds too high: ${pinnacleOddsForCheck} > ${maxOdds} (max) - SKIPPING (no attempt counted)`);
                    if (!this.config.tgQuiet) {
                        this.telegram.notifySkipped({ matchKey, home, away, outcome: tracker.outcome, expectedROI: tracker.lastROI, isPrematch: tracker.isPrematch, bookmaker: this.bookmakerName, pair, pairFull: pair }, `Pinnacle odds ${pinnacleOddsForCheck} > ${maxOdds}`).catch(() => {});
                    }
                    this.stabilityTracker.markBetPlaced(tracker.key);
                    return;
                }
                if (pinnacleOddsForCheck < minOdds) {
                    this.logger.log(`⚠️ Pinnacle odds too low: ${pinnacleOddsForCheck} < ${minOdds} (min) - SKIPPING (no attempt counted)`);
                    if (!this.config.tgQuiet) {
                        this.telegram.notifySkipped({ matchKey, home, away, outcome: tracker.outcome, expectedROI: tracker.lastROI, isPrematch: tracker.isPrematch, bookmaker: this.bookmakerName, pair, pairFull: pair }, `Pinnacle odds ${pinnacleOddsForCheck} < ${minOdds}`).catch(() => {});
                    }
                    this.stabilityTracker.markBetPlaced(tracker.key);
                    return;
                }
            }

            // PRE-CHECK: Match blocked (3 failures) — skip without counting attempt
            if (this.tasksManager?.isMatchBlocked(matchKey)) {
                this.logger.log(`⚠️ Match blocked (3 failures): ${home} vs ${away} | ${tracker.outcome}. Skipping (no attempt counted).`);
                this.stabilityTracker.markBetPlaced(tracker.key);
                if (!this.config.tgQuiet) {
                    this.telegram.notifySkipped({ matchKey, home, away, outcome: tracker.outcome, expectedROI: tracker.lastROI, isPrematch: tracker.isPrematch, bookmaker: this.bookmakerName, pair, pairFull: pair }, 'Матч заблокирован (3 неудачи)').catch(() => {});
                }
                return;
            }

            const task = this._taskBuilder.build(tracker, {
                stake: displayStake,
                isHighROI,
                home,
                away,
                ourSide,
                expectedOdds
            });
            task.trackerKey = tracker.key;

            if (this._hasSharedTaskRunner()) {
                const limitContext = this.tasksManager.resolveLimitContext(task);
                if (!this.tasksManager.checkMatchTotalLimit(task.matchKey, task.stake, limitContext)) {
                    this.stabilityTracker.markBetPlaced(tracker.key);
                    if (!this.config.tgQuiet) {
                        this.telegram.notifySkipped(task, 'Лимит суммы на матч исчерпан').catch(() => {});
                    }
                    return;
                }

                const added = this.tasksManager.addTask(task);
                if (!added) {
                    if (this.config.debug) {
                        this.logger.log(`🔍 DEBUG: Analyzer task ${task.id} not queued (${tracker.outcome})`);
                    }
                    return;
                }

                this.logger.log(`📥 [ANALYZER] Task queued: ${task.id} | ${task.home} vs ${task.away} | ${task.outcome}`);
                this._kickTaskRunner();
                return;
            }

            await this._executeQueuedTask(task);
        } finally {
            if (this.config.debug) {
                this.logger.log(`🔍 DEBUG: _processStableTracker END | queued/direct handoff complete`);
            }
        }
    }

    /**
     * Process a single bet attempt - delegates to BetProcessor
     * @param {Object} task - Task with all bet details  
     * @param {number} attempt - Attempt number (for logging)
     */
    async _processBetAttempt(task, attempt) {
        // Sync state to BetProcessor
        this.betProcessor.analyzerAvailable = this.analyzerAvailable;

        try {
            this.adapter.beginAttemptDebug?.(task, {
                attempt,
                bookmakerName: this.bookmakerName,
                bookmakerId: this.bookmakerId,
                runtimeMode: task.isPrematch ? 'prematch' : 'live'
            });
        } catch (error) {
            this.logger.log(`⚠️ Attempt debug init failed: ${error.message}`);
        }

        let result;
        let thrownError = null;

        try {
            result = await this.betProcessor.process(task);
        } catch (error) {
            thrownError = error;
            try {
                this.adapter.captureAttemptDebug?.('processor_exception', {
                    message: error.message,
                    stack: error.stack || null
                });
            } catch (_captureError) {}
            throw error;
        } finally {
            try {
                const status = thrownError
                    ? 'exception'
                    : result?.success
                    ? 'success'
                    : result?.cancelled
                    ? 'cancelled'
                    : 'failed';
                this.adapter.finishAttemptDebug?.(task, status, {
                    result: result || null,
                    attempt,
                    lastError: task._lastError || null,
                    executionState: task.executionState || null
                });
            } catch (error) {
                this.logger.log(`⚠️ Attempt debug finalize failed: ${error.message}`);
            }
        }
        
        // Track errors in state
        if (!result.success && !result.shouldRetry) {
            this.state.errors++;
        }
        
        return result;
    }

    // ==================== BET HISTORY (delegated to LimitsManager) ====================

    _recordBet(matchKey, outcome, source, stake) {
        this.limitsManager.recordBet(matchKey, outcome, source, stake);
    }

    // ==================== DIAGNOSTIC LOGGING ====================

    /**
     * Сохранить diagnostic лог для Calculator API
     * @param {Object} task - данные ставки
     * @param {Object} result - результат { success, error, roi, odds, ... }
     */
    async _saveDiagnostic(task, result) {
        if (!this.config.enableDiagnostics) return;
        
        try {
            const diagnostic = {
                bookmaker: this.bookmakerName,
                timestamp: new Date().toISOString(),
                match: {
                    home: task.home,
                    away: task.away,
                    matchId: task.matchId
                },
                outcome: task.outcome,
                stake: task.stake,
                expectedOdds: task.expectedOdds,
                expectedROI: task.expectedROI,
                result: {
                    success: result.success,
                    error: result.error || null,
                    errorType: result.errorType || null,
                    actualOdds: result.actualOdds || null,
                    ticketId: result.ticketId || null
                },
                pairFull: task.pairFull || null
            };

            // Log to Calculator API if available
            if (this.calculator && result.success === false) {
                await this.calculator.logDiagnostic(diagnostic);
            }

            // Also save to file if path configured
            if (this.config.diagnosticsPath) {
                const filename = `${task.home}_vs_${task.away}_${this.bookmakerName}_${Date.now()}.json`;
                const filepath = path.join(this.config.diagnosticsPath, filename);
                fs.writeFileSync(filepath, JSON.stringify(diagnostic, null, 2));
            }
        } catch (e) {
            this.logger.error(`Diagnostic save failed: ${e.message}`);
        }
    }

    // ==================== HEALTH SERVER ====================

    /**
     * Get health status for health server
     * @returns {Object} Health status
     */
    _getHealthStatus() {
        const hasLoginError = !!this.state.loginError;
        const hasTelegramIngressError = this.config.enableTelegramIngress && Boolean(this._telegramIngressInitError || this.telegramIngress?.lastError);
        const isHealthy = !hasLoginError && !hasTelegramIngressError && this.state.status !== 'login_error';
        
        return {
            service: `${this.bookmakerName.toLowerCase()}-bettor`,
            status: isHealthy ? 'ok' : 'error',
            uptime: Math.floor((Date.now() - this.state.started) / 1000),
            state: this.state,
            stability: this.stabilityTracker.getStats(),
            freshData: this.freshDataManager.getStats(),
            limits: this.limitsManager.getState(),
            execution: {
                mode: this.config.executionMode,
                analyzerPolling: this.config.enableAnalyzerPolling,
                telegramQueue: this.config.enableTelegramQueue,
                taskRunner: this.config.enableTaskRunner,
                taskQueueApi: this.config.enableTaskQueueApi,
                telegramIngress: this.config.enableTelegramIngress
            },
            taskQueue: this._getTaskQueueStatus(),
            telegramIngress: this._getTelegramIngressStatus(),
            telegramIngressFix: hasTelegramIngressError
                ? describeTelegramIngressFix(this._telegramIngressInitError || this.telegramIngress?.lastError)
                : null,
            loginError: this.state.loginError,
            lastLoginAttempt: this.state.lastLoginAttempt
        };
    }

    _startHealthServer() {
        return this._healthServer.start();
    }

    _stopHealthServer() {
        return this._healthServer.stop();
    }

    _getHealthHandlers() {
        const handlers = {};

        if (this.config.enableTaskQueueApi && this.tasksManager) {
            handlers['GET /tasks/status'] = async () => ({
                body: this._getTaskQueueStatus()
            });
            handlers['GET /tasks/current'] = async () => ({
                body: {
                    bookmakerId: this.bookmakerId,
                    current: this.tasksManager.getCurrentTask(this.bookmakerId),
                    pending: this.tasksManager.getPendingTask(this.bookmakerId),
                    processing: this.tasksManager.isProcessing(this.bookmakerId)
                }
            });
            handlers['GET /tasks/history'] = async ({ query }) => ({
                body: {
                    bookmakerId: this.bookmakerId,
                    history: this.tasksManager.getHistory(
                        this.bookmakerId,
                        { limit: Number(query?.limit) || 20 }
                    )
                }
            });
            handlers['POST /tasks/telegram'] = async ({ body }) => {
                const result = await this.enqueueTelegramTask(body || {});
                return {
                    status: result.accepted ? 202 : 400,
                    body: result
                };
            };
        }

        if (this.config.enableTelegramIngress) {
            handlers['GET /telegram/ingress/status'] = async () => ({
                body: this._getTelegramIngressStatus()
            });
            handlers['GET /telegram/ingress/sessions'] = async () => ({
                body: {
                    bookmakerId: this.bookmakerId,
                    runtimeMode: this.adapter.isPrematch ? 'prematch' : 'live',
                    sessions: this.telegramIngress?.getActiveSessions() || []
                }
            });
            handlers['GET /telegram/ingress/signals'] = async ({ query }) => ({
                body: {
                    bookmakerId: this.bookmakerId,
                    runtimeMode: this.adapter.isPrematch ? 'prematch' : 'live',
                    signals: this.telegramIngress?.getRecentSignals(Number(query?.limit) || 20) || []
                }
            });
            handlers['POST /telegram/ingress/flush'] = async ({ body }) => {
                await this.telegramIngress?.flushExpiredSessions(Date.now(), body?.force !== false);
                return {
                    body: this._getTelegramIngressStatus()
                };
            };
            handlers['POST /telegram/ingress/update'] = async ({ body, rawRequest }) => {
                const remoteAddress = rawRequest?.socket?.remoteAddress || '';
                const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
                if (!isLocal) {
                    return {
                        status: 403,
                        body: { status: 'error', error: 'Forbidden' }
                    };
                }

                if (!this.telegramIngress || !this.telegramIngress.running) {
                    return {
                        status: 503,
                        body: { status: 'error', error: 'Telegram ingress not running' }
                    };
                }

                const updates = Array.isArray(body) ? body : [body || {}];
                await this.telegramIngress.processUpdates(updates);
                return {
                    status: 202,
                    body: { status: 'accepted', count: updates.length }
                };
            };
        }

        return handlers;
    }

    _getTelegramIngressStatus() {
        if (!this.config.enableTelegramIngress) {
            return {
                enabled: false,
                bookmakerId: this.bookmakerId,
                reason: 'Telegram ingress disabled'
            };
        }

        if (this._telegramIngressInitError) {
            return {
                enabled: false,
                bookmakerId: this.bookmakerId,
                runtimeMode: this.adapter.isPrematch ? 'prematch' : 'live',
                reason: this._telegramIngressInitError
            };
        }

        if (!this.telegramIngress) {
            return {
                enabled: false,
                bookmakerId: this.bookmakerId,
                runtimeMode: this.adapter.isPrematch ? 'prematch' : 'live',
                reason: 'Telegram ingress not initialized'
            };
        }

        return this.telegramIngress.getStatus();
    }

    _getTaskQueueStatus() {
        if (!this.tasksManager) {
            return {
                enabled: false,
                bookmakerId: this.bookmakerId,
                reason: 'TasksManager not configured'
            };
        }

        return {
            enabled: true,
            bookmakerId: this.bookmakerId,
            mode: this.config.executionMode,
            current: this.tasksManager.getCurrentTask(this.bookmakerId),
            pending: this.tasksManager.getPendingTask(this.bookmakerId),
            processing: this.tasksManager.isProcessing(this.bookmakerId),
            stats: this.tasksManager.getStats()
        };
    }

    _startTaskRunner() {
        if (!this.tasksManager) {
            this.logger.log('⚠️ Task runner requested but TasksManager is not configured');
            return;
        }

        if (this._taskRunnerTimer) {
            return;
        }

        const intervalMs = Math.max(250, this.config.taskRunnerIntervalMs || 1000);
        this._taskRunnerTimer = setInterval(() => {
            this._runTaskRunnerTick().catch((e) => {
                this.logger.error(`❌ Task runner tick error: ${e.message}`);
            });
        }, intervalMs);

        if (typeof this._taskRunnerTimer.unref === 'function') {
            this._taskRunnerTimer.unref();
        }

        this.logger.log(`📬 Task runner started (${intervalMs}ms interval)`);
        this._runTaskRunnerTick().catch((e) => {
            this.logger.error(`❌ Initial task runner tick error: ${e.message}`);
        });
    }

    _stopTaskRunner() {
        if (!this._taskRunnerTimer) {
            return;
        }

        clearInterval(this._taskRunnerTimer);
        this._taskRunnerTimer = null;
        this.logger.log('📬 Task runner stopped');
    }

    _kickTaskRunner() {
        if (!this.config.enableTaskRunner) {
            return;
        }

        this._runTaskRunnerTick().catch((e) => {
            this.logger.error(`❌ Task runner kick error: ${e.message}`);
        });
    }

    async _runTaskRunnerTick() {
        if (!this.isRunning || !this.tasksManager || !this.config.enableTaskRunner) {
            return;
        }

        if (this._taskRunnerBusy || this.isProcessingBet || this.isPaused()) {
            return;
        }

        if (this.tasksManager.isProcessing(this.bookmakerId)) {
            return;
        }

        const currentTask = this.tasksManager.getCurrentTask(this.bookmakerId);
        if (!currentTask) {
            return;
        }

        this._taskRunnerBusy = true;
        try {
            await this._executeQueuedTask(currentTask);
        } finally {
            this._taskRunnerBusy = false;
        }
    }

    async _executeQueuedTask(task) {
        const sourceMeta = getResolvedSource(task);
        const executionTask = {
            ...task,
            bookmaker: task.bookmaker || this.bookmakerName,
            bookmakerId: task.bookmakerId || this.bookmakerId,
            pair: task.pair || { sportName: task.sport || 'soccer' }
        };

        if (sourceMeta.isTelegram && executionTask.expiresAt && Date.now() > executionTask.expiresAt) {
            const reason = 'Telegram task expired before execution';
            this.logger.log(`⏰ ${reason}: ${executionTask.id}`);
            const cancelResult = this.tasksManager?.cancelTask?.(executionTask.id, {
                message: reason,
                step: 'telegram_expired',
                forceCurrent: true
            });
            if (!cancelResult?.cancelled) {
                this.tasksManager?.removeTask?.(executionTask.id);
            }
            if (executionTask.signalId) {
                this.telegramIngress?.applyTaskLifecycle(executionTask.signalId, {
                    taskId: executionTask.id,
                    state: 'cancelled'
                });
            }
            if (!this.config.tgQuiet) {
                await this.telegram?.notifySkipped(executionTask, reason);
            }
            return;
        }

        this.isProcessingBet = true;
        this.tasksManager?.startProcessing(this.bookmakerId);
        if (sourceMeta.isTelegram) {
            this.tasksManager?.setTaskExecutionState?.(task.id, 'started');
        }
        if (sourceMeta.isTelegram && task.signalId) {
            this.telegramIngress?.applyTaskLifecycle(task.signalId, {
                taskId: task.id,
                state: 'executing',
                executionState: 'started'
            });
        }

        // Track finalization for self-heal (one trigger per finalized attempt)
        let selfHealBundle = null;
        let shouldStopAfterFinalize = false;

        try {
            if (sourceMeta.isAnalyzer && executionTask.trackerKey) {
                this.stabilityTracker.markBetPlaced(executionTask.trackerKey);
            }

            if (!this._checkLimits()) {
                this.logger.log('🎯 Goal reached before queued task execution');
                await this.stop();
                return;
            }

            await this._recordTaskAttempt(executionTask);

            let telegramStartSent = false;
            for (let attempt = 1; attempt <= this.config.maxRetryAttempts; attempt++) {
                executionTask._sendTelegramStart = !telegramStartSent;
                executionTask._isLastAttempt = attempt === this.config.maxRetryAttempts;
                telegramStartSent = true;

                if (attempt > 1) {
                    const retryLabel = sourceMeta.isTelegram ? 'TG RETRY' : 'RETRY';
                    this.logger.log(`\n🔄 ${retryLabel} ${attempt}/${this.config.maxRetryAttempts} for task ${executionTask.id}`);
                    await this._sleep(1000);

                    if (sourceMeta.isAnalyzer) {
                        const shouldContinue = await this._prepareAnalyzerRetry(executionTask);
                        if (!shouldContinue) {
                            break;
                        }
                    }
                }

                const result = await this._processBetAttempt(executionTask, attempt);
                if (result?.step) {
                    executionTask._lastFailureStep = result.step;
                }
                if (result.cancelled) {
                    executionTask._lastError = result.message || executionTask._lastError || 'Telegram STOP requested';
                    this.tasksManager?.recordTaskResult(executionTask, 'cancelled', {
                        message: executionTask._lastError,
                        step: result.step || 'telegram_stop'
                    });
                    this.limitsManager.betAttempts--;
                    if (sourceMeta.isTelegram && executionTask.signalId) {
                        this.telegramIngress?.applyTaskLifecycle(executionTask.signalId, {
                            taskId: executionTask.id,
                            state: 'cancelled'
                        });
                    }
                    return;
                }

                if (result.skipCount) {
                    this.limitsManager.betAttempts--;
                    const skipMessage = sourceMeta.isTelegram
                        ? 'Telegram task skipped before execution'
                        : 'Analyzer task skipped before execution';
                    const skipStep = result.step || (sourceMeta.isTelegram ? 'telegram_skip' : 'analyzer_skip');
                    this.tasksManager?.recordTaskResult(executionTask, 'cancelled', {
                        message: executionTask._lastError || skipMessage,
                        step: skipStep
                    });
                    if (sourceMeta.isTelegram && executionTask.signalId) {
                        this.telegramIngress?.applyTaskLifecycle(executionTask.signalId, {
                            taskId: executionTask.id,
                            state: 'cancelled'
                        });
                    }
                    return;
                }

                if (result.success) {
                    if (executionTask._dryRunCompleted) {
                        this.logger.log(`🧪 Dry-run task finalized: ${executionTask.id}`);
                    } else {
                        this.limitsManager.recordSuccess();
                        this.state.lastSuccessfulBet = {
                            home: executionTask.home || executionTask.homeName,
                            away: executionTask.away || executionTask.awayName,
                            outcome: executionTask.outcome,
                            odds: executionTask._betDetails?.odds || executionTask.expectedOdds,
                            stake: executionTask._betDetails?.stake || executionTask.stake,
                        };
                        this._saveState();

                        if (!this._checkLimits()) {
                            this.logger.log('🎯 Goal reached! Stopping...');
                            shouldStopAfterFinalize = true;
                        }
                    }
                    if (sourceMeta.isTelegram && executionTask.signalId) {
                        this.telegramIngress?.applyTaskLifecycle(executionTask.signalId, {
                            taskId: executionTask.id,
                            state: 'completed'
                        });
                    }
                    selfHealBundle = this._buildSelfHealBundle(executionTask, 'completed', null, null, sourceMeta);
                    return;
                }

                if (!result.shouldRetry) {
                    break;
                }
            }

            await this._finalizeTaskFailure(executionTask);
            if (sourceMeta.isTelegram && executionTask.signalId) {
                this.telegramIngress?.applyTaskLifecycle(executionTask.signalId, {
                    taskId: executionTask.id,
                    state: 'failed',
                    step: executionTask._lastFailureStep || 'retry_loop_exhausted',
                    failureStage: executionTask._lastFailureStage || null,
                    error: executionTask._lastError || null
                });
            }
            selfHealBundle = this._buildSelfHealBundle(
                executionTask,
                'failed',
                executionTask._lastError,
                executionTask._lastFailureStep || 'retry_loop_exhausted',
                sourceMeta
            );
        } catch (e) {
            this.logger.error(`❌ Queued task ${task.id} crashed: ${e.message}`);
            this.tasksManager?.recordTaskResult(task, 'failed', {
                message: e.message,
                step: 'task_runner_exception'
            });
            if (sourceMeta.isTelegram && task.signalId) {
                this.telegramIngress?.applyTaskLifecycle(task.signalId, {
                    taskId: task.id,
                    state: 'failed',
                    step: 'task_runner_exception',
                    error: e.message
                });
            }
            if (!this.config.tgQuiet) {
                try {
                    await this.telegram?.notifyTaskFailed(task, {
                        message: e.message,
                        step: 'task_runner_exception'
                    });
                } catch (notifyError) {}
            }
            selfHealBundle = this._buildSelfHealBundle(task, 'failed', e.message, 'task_runner_exception', sourceMeta);
        } finally {
            if (this.tasksManager?.isProcessing(this.bookmakerId)) {
                this.tasksManager.stopProcessing(this.bookmakerId);
            }
            this.isProcessingBet = false;

            // Self-heal: one trigger per finalized task attempt
            if (sourceMeta.isTelegram && selfHealBundle) {
                try {
                    this.selfHealManager.onTaskFinalized(selfHealBundle);
                    if (shouldStopAfterFinalize) {
                        await this.selfHealManager.waitForIdle();
                    }
                } catch (shErr) {
                    this.logger.error?.(`[SelfHeal] trigger error (non-fatal): ${shErr.message}`) ||
                        this.logger.log(`[SelfHeal] trigger error (non-fatal): ${shErr.message}`);
                }
            }

            if (shouldStopAfterFinalize) {
                await this.stop();
            }
        }
    }

    async _recordTaskAttempt(task) {
        this.limitsManager.recordAttempt();
        this.state.lastActivity = Date.now();

        const sourceMeta = getResolvedSource(task);
        const limitsState = this.limitsManager.getState();
        const maxLabel = this.config.maxBets === Infinity ? '∞' : this.config.maxBets;
        const sourceLabel = sourceMeta.isTelegram ? 'TG' : 'ANALYZER';
        this.logger.log(`📊 ${sourceLabel} attempt ${limitsState.betAttempts}/${maxLabel}: ${task.home} vs ${task.away} | ${task.outcome} [${task.id}]`);

        if (sourceMeta.isAnalyzer && !this.config.tgQuiet) {
            const roiLabel = Number.isFinite(task.expectedROI) ? task.expectedROI.toFixed(1) : 'N/A';
            try {
                await this.telegram?.sendToAll(
                    `📊 Попытка #${limitsState.betAttempts}/${maxLabel} засчитана\n` +
                    `${task.home} vs ${task.away}\n` +
                    `${task.outcome} | ROI: ${roiLabel}%`,
                    { bookmaker: this.bookmakerName, parse_mode: null }
                );
            } catch (e) {}
        }
    }

    _buildSelfHealBundle(task, status, error, step, sourceMeta) {
        try {
            const originalOutcome = task._originalOutcome || task.outcome || null;
            const currentOutcome = task.outcome || null;
            return {
                taskId: task.id,
                status,
                home: task.home || task.homeName,
                away: task.away || task.awayName,
                outcome: originalOutcome,
                originalOutcome,
                currentOutcome,
                stake: task._betDetails?.stake || task.stake,
                expectedOdds: task.expectedOdds,
                expectedROI: task.expectedROI,
                bookmakerMatchId: task.bookmakerMatchId || task.matchId || null,
                sport: task.sport || task.pair?.sportName || null,
                selectedCandidate: task.selectedCandidate || null,
                candidateLadder: Array.isArray(task.candidateLadder) ? task.candidateLadder : [],
                outcomeCandidates: Array.isArray(task.outcomeCandidates)
                    ? task.outcomeCandidates
                    : (Array.isArray(task.telegramContext?.outcomeCandidates) ? task.telegramContext.outcomeCandidates : []),
                bookmaker: task.bookmaker || this.bookmakerName,
                bookmakerId: task.bookmakerId || this.bookmakerId || null,
                mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
                source: sourceMeta?.isTelegram ? 'telegram' : 'analyzer',
                error: error || task._lastError || null,
                step: step || null,
                signalId: task.signalId || task.telegramContext?.signalId || null,
                telegramContext: task.telegramContext || task._telegramContext || null,
                profileId: task.profileId || null,
                sourceProfileId: task.sourceProfileId || task.profileId || null,
                originChatId: task.telegramContext?.originChatId || task.originChatId || null,
                originTargetLabel: task.telegramContext?.originTargetLabel || null,
                task: {
                    id: task.id,
                    outcome: currentOutcome,
                    originalOutcome,
                    currentOutcome,
                    sport: task.sport || task.pair?.sportName,
                    bookmakerMatchId: task.bookmakerMatchId || task.matchId || null,
                    mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
                    expectedROI: task.expectedROI,
                    dryRun: task._dryRunCompleted || false,
                    candidateLadder: Array.isArray(task.candidateLadder) ? task.candidateLadder : [],
                    outcomeCandidates: Array.isArray(task.outcomeCandidates)
                        ? task.outcomeCandidates
                        : (Array.isArray(task.telegramContext?.outcomeCandidates) ? task.telegramContext.outcomeCandidates : []),
                    telegramContext: task.telegramContext || null,
                },
            };
        } catch (e) {
            return {
                taskId: task?.id || 'unknown',
                status,
                error: error || 'unknown',
                step,
                _bundleError: e.message,
            };
        }
    }

    async _prepareAnalyzerRetry(task) {
        const freshData = this.freshDataManager.getLatestData(task.freshDataMatchKey, task.outcome);
        if (freshData && freshData.score2) {
            const newOdds = freshData.score2;
            if (newOdds !== task.expectedOdds) {
                this.logger.log(`📊 Odds updated: ${task.expectedOdds} → ${newOdds} (from analyzer)`);
                task.expectedOdds = newOdds;
                task.expectedROI = freshData.roi;
            }
            task._analyzerDonorOdds = freshData.score2;

            if (freshData.pair) {
                task.pair = freshData.pair;
            }
        }

        const PINNACLE_MAX_AGE_MS = 15000;
        if (task.pair?.first?.createdAt) {
            const pinnacleCreatedAt = new Date(task.pair.first.createdAt).getTime();
            const pinnacleAge = Date.now() - pinnacleCreatedAt;
            if (pinnacleAge > PINNACLE_MAX_AGE_MS) {
                const staleReason = `Pinnacle stale ${(pinnacleAge / 1000).toFixed(1)}s > ${PINNACLE_MAX_AGE_MS / 1000}s`;
                const prevError = task._lastError ? ` (after: ${task._lastError})` : '';
                this.logger.log(`⏳ ${staleReason}${prevError} - waiting for analyzer update (max 7s)...`);

                try {
                    const updateResult = await this.freshDataManager.waitForMatchUpdate({
                        matchKey: task.freshDataMatchKey,
                        minROI: this.config.minROI,
                        timeoutMs: 7000
                    });

                    if (updateResult.roiDropped) {
                        task._lastError = `ROI dropped to ${updateResult.bestRoi?.toFixed(2) || 0}% during stale wait`;
                        this.logger.log(`❌ ${task._lastError}`);
                        return false;
                    }

                    if (updateResult.pair) {
                        task.pair = updateResult.pair;
                    }
                    if (updateResult.bestOutcome) {
                        const best = updateResult.bestOutcome;
                        const isFirstOurs = (task.pair?.first?.bookmaker || '').toLowerCase() === this.bookmakerName.toLowerCase();
                        task.expectedOdds = isFirstOurs ? best.score1 : best.score2;
                        task.expectedROI = best.roi;
                        this.logger.log(`✅ Got fresh data after stale: ${best.outcome} @ ${task.expectedOdds} (ROI ${best.roi.toFixed(2)}%)`);
                    }
                } catch (e) {
                    task._lastError = `${staleReason} - analyzer timeout (7s), line likely closed`;
                    this.logger.log(`❌ ${task._lastError}`);
                    return false;
                }
            }
        }

        if (!task.fallback && task.expectedROI !== undefined && task.expectedROI < this.config.minROI) {
            task._lastError = `ROI dropped below threshold: ${task.expectedROI.toFixed(2)}% < ${this.config.minROI}%`;
            this.logger.log(`❌ ${task._lastError}`);
            this.logger.log(`🛑 Aborting retry - ROI no longer valid`);
            return false;
        }

        return true;
    }

    async _finalizeTaskFailure(task) {
        if (task._betSucceeded || task._notificationSent) {
            return;
        }

        const sourceMeta = getResolvedSource(task);
        const failReason = task._lastError || (sourceMeta.isTelegram ? 'Telegram task failed' : 'Pre-checks failed or max retry attempts exceeded');
        const failLs = this.limitsManager.getState();
        const failMaxLabel = this.config.maxBets === Infinity ? '∞' : this.config.maxBets;
        if (!this.config.tgQuiet) {
            try {
                if (task._telegramStartSent) {
                    await this.telegram?.notifyTaskFailed(task, {
                        message: `${failReason} [попытка #${failLs.betAttempts}/${failMaxLabel}]`,
                        step: '🏁 Финальный этап'
                    });
                } else {
                    // F3 (review_4): pre-check failure path previously routed
                    // through the bare bookmaker default chat, so cluster
                    // operators (vova/supernova) silently lost visibility into
                    // why their queued bet was dropped before submit. Funnel
                    // through the same routing helper as the success/queued/
                    // failed paths so feedbackChatIds + sourceReadOnly flags
                    // honor per-profile partitioning.
                    const failRouting = typeof this.telegram?._getRoutingOptionsForTask === 'function'
                        ? this.telegram._getRoutingOptionsForTask(task, this.bookmakerName)
                        : { bookmaker: this.bookmakerName };
                    await this.telegram?.sendToAll(
                        `❌ Попытка #${failLs.betAttempts}/${failMaxLabel} не удалась (pre-check)\n` +
                        `${task.homeName || task.home} vs ${task.awayName || task.away}\n` +
                        `${task.outcome} @ ${task.expectedOdds} | Pinnacle: ${task.pinnacleOdds || 'N/A'} | ROI: ${(task.expectedROI || 0).toFixed(1)}%\n` +
                        `Причина: ${failReason}`,
                        {
                            ...failRouting,
                            sourceReadOnly: task.telegramContext?.sourceReadOnly === true,
                            parse_mode: null
                        }
                    );
                }
            } catch (e) {
                this.logger.log(`⚠️ Failed to send failure notification: ${e.message}`);
            }
        }

        this.tasksManager?.recordTaskResult(task, 'failed', {
            message: failReason,
            step: task._lastFailureStep || (task._telegramStartSent ? 'retry_loop_exit' : (sourceMeta.isTelegram ? 'telegram_queue' : 'pre_checks_failed'))
        });
    }

    async enqueueTelegramTask(rawTask = {}) {
        if (!this.config.enableTelegramQueue) {
            return { accepted: false, error: 'Telegram queue is disabled in this runtime' };
        }

        if (!this.tasksManager) {
            return { accepted: false, error: 'TasksManager is not configured' };
        }

        const signalId = rawTask.signalId || rawTask.telegramContext?.signalId || null;
        let task;
        try {
            task = this._normalizeTelegramTask(rawTask);
        } catch (e) {
            return {
                accepted: false,
                error: e.message
            };
        }

        if (signalId) {
            const existing = this.tasksManager.findTaskBySignalId(signalId, this.bookmakerId);
            if (existing?.task) {
                return await this._updateExistingTelegramTask(existing, task);
            }
        }

        const added = this.tasksManager.addTask(task);
        if (!added) {
            const reason = 'TasksManager rejected task (blocked match or limits)';
            if (!this.config.tgQuiet) {
                try {
                    await this.telegram?.notifySkipped(task, reason);
                } catch (e) {}
            }
            return {
                accepted: false,
                error: reason,
                taskId: task.id,
                queue: this._getTaskQueueStatus()
            };
        }

        this.logger.log(`📥 [TG] Task queued: ${task.id} | ${task.home} vs ${task.away} | ${task.outcome}`);
        this.telegramIngress?.applyTaskLifecycle(task.signalId, {
            taskId: task.id,
            state: 'queued'
        });
        this._kickTaskRunner();
        if (!this.config.tgQuiet) {
            try {
                // F1: route through the same helper that every other task-bound
                // notifier funnels through so sourceReadOnly profiles do NOT
                // get the source chat id silently re-injected via originChatId.
                const routingOptions = typeof this.telegram?._getRoutingOptionsForTask === 'function'
                    ? this.telegram._getRoutingOptionsForTask(task, this.bookmakerName)
                    : {
                        bookmaker: this.bookmakerName,
                        chatIds: task.feedbackChatIds,
                        originChatId: task.telegramContext?.sourceReadOnly === true ? null : task.originChatId,
                        // F2 fallback: still propagate signalId for anchor indexing.
                        _anchorSignalId: task.signalId || task.telegramContext?.signalId || null
                    };
                await this.telegram?.sendToAll(
                    `🟡 TG СИГНАЛ В ОЧЕРЕДИ\n` +
                    `ID: ${task.id}\n` +
                    `${task.home} vs ${task.away}\n` +
                    `${task.outcome}\n` +
                    `Режим: ${task.isPrematch ? 'prematch' : 'live'}`,
                    {
                        ...routingOptions,
                        sourceReadOnly: task.telegramContext?.sourceReadOnly === true,
                        parse_mode: null
                    }
                );
            } catch (e) {}
        }

        return {
            accepted: true,
            taskId: task.id,
            queue: this._getTaskQueueStatus(),
            task
        };
    }

    async stopTelegramSignal(payload = {}) {
        if (!this.tasksManager) {
            return { accepted: false, error: 'TasksManager is not configured' };
        }

        const signalId = payload.signalId || null;
        if (!signalId) {
            return { accepted: false, error: 'STOP requires signalId' };
        }

        const found = this.tasksManager.findTaskBySignalId(signalId, this.bookmakerId);
        if (!found?.task) {
            return { accepted: false, error: 'Signal is not queued anymore' };
        }

        const processing = this.tasksManager.isProcessing(this.bookmakerId);
        const executionState = found.task.executionState || null;
        if (processing && found.location === 'current' && executionState === 'submit_started') {
            return { accepted: false, error: 'Bet submit already started' };
        }

        if (found.location === 'pending' || (found.location === 'current' && !processing)) {
            const cancelled = this.tasksManager.cancelTask(found.task.id, {
                message: 'STOP requested by signal author',
                step: 'telegram_stop',
                requestedBy: payload.requesterUserId || null
            });
            if (!cancelled?.cancelled) {
                return { accepted: false, error: 'Failed to remove queued telegram task' };
            }

            this.telegramIngress?.applyTaskLifecycle(signalId, {
                taskId: found.task.id,
                state: 'cancelled'
            });

            return {
                accepted: true,
                cancelled: true,
                taskId: found.task.id,
                queue: this._getTaskQueueStatus()
            };
        }

        const updated = this.tasksManager.markStopRequested
            ? this.tasksManager.markStopRequested(found.task.id, {
                requesterUserId: payload.requesterUserId || null,
                requesterUsername: payload.requesterUsername || null
            })
            : { updated: this.tasksManager.updateTaskById(found.task.id, {
                stopRequested: true,
                stopRequestedAt: Date.now(),
                stopRequestedBy: {
                    userId: payload.requesterUserId || null,
                    username: payload.requesterUsername || null
                }
            }) };

        if (!(updated?.updated || updated === true)) {
            return { accepted: false, error: 'Failed to mark executing task for STOP' };
        }

        this.telegramIngress?.applyTaskLifecycle(signalId, {
            taskId: found.task.id,
            state: 'executing',
            executionState: 'stop_requested'
        });

        return {
            accepted: true,
            stopRequested: true,
            taskId: found.task.id,
            queue: this._getTaskQueueStatus()
        };
    }

    async _updateExistingTelegramTask(existing, nextTask) {
        const processing = this.tasksManager.isProcessing(this.bookmakerId);
        if (existing.location === 'current' && processing) {
            return {
                accepted: false,
                error: 'Telegram task is already executing and cannot be updated',
                taskId: existing.task.id,
                queue: this._getTaskQueueStatus()
            };
        }

        const updatedTask = {
            ...existing.task,
            ...nextTask,
            id: existing.task.id,
            createdAt: existing.task.createdAt || nextTask.createdAt,
            signalId: existing.task.signalId || nextTask.signalId,
            telegramContext: {
                ...(existing.task.telegramContext || {}),
                ...(nextTask.telegramContext || {}),
                signalId: existing.task.telegramContext?.signalId || nextTask.telegramContext?.signalId || existing.task.signalId || nextTask.signalId
            },
            stopRequested: false,
            stopRequestedAt: null,
            stopRequestedBy: null,
            executionState: existing.task.executionState || 'queued'
        };

        const updated = this.tasksManager.updateTaskById(existing.task.id, updatedTask);
        if (!updated) {
            return {
                accepted: false,
                error: 'Failed to update queued telegram task',
                taskId: existing.task.id,
                queue: this._getTaskQueueStatus()
            };
        }

        this.logger.log(`📝 [TG] Task updated: ${existing.task.id} | ${updatedTask.home} vs ${updatedTask.away} | ${updatedTask.outcome}`);
        this.telegramIngress?.applyTaskLifecycle(updatedTask.signalId, {
            taskId: existing.task.id,
            state: existing.location === 'pending' || this.tasksManager.getPendingTask(this.bookmakerId)?.id === existing.task.id
                ? 'queued'
                : 'queued'
        });
        this._kickTaskRunner();

        return {
            accepted: true,
            updated: true,
            taskId: existing.task.id,
            queue: this._getTaskQueueStatus(),
            task: updatedTask
        };
    }

    _normalizeTelegramTask(rawTask = {}) {
        if (!rawTask || typeof rawTask !== 'object') {
            throw new Error('Telegram task payload must be an object');
        }

        const home = String(rawTask.home || '').trim();
        const away = String(rawTask.away || '').trim();
        const requestedMode = String(
            rawTask.mode || (rawTask.isPrematch ? 'prematch' : (this.adapter.isPrematch ? 'prematch' : 'live'))
        ).toLowerCase();
        const isPrematch = requestedMode === 'prematch';
        this._assertTelegramTaskMode(isPrematch);

        const policy = this._resolveTelegramPolicy(rawTask, requestedMode);
        const builder = policy.expansion && Object.keys(policy.expansion).length > 0
            ? new CandidateLadderBuilder(policy.expansion)
            : this.candidateLadderBuilder;
        const candidateLadder = Array.isArray(rawTask.candidateLadder)
            ? rawTask.candidateLadder
            : (rawTask.normalizedIntent || rawTask.intent
                ? builder.build({
                    ...(rawTask.normalizedIntent || rawTask.intent),
                    sport: rawTask.sport || rawTask.sportName || rawTask.pair?.sportName || null
                }, rawTask.candidateOptions || {})
                : []);
        const outcome = String(rawTask.outcome || candidateLadder[0]?.outcome || '').trim();

        if (!home || !away || !outcome) {
            throw new Error('Telegram task requires home, away and outcome (or candidate ladder)');
        }

        const now = Date.now();
        const ttlMs = Number(rawTask.ttlMs ?? policy.raw?.ttlMs ?? 30000);
        const originChatId = rawTask.originChatId ??
            rawTask.telegramContext?.originChatId ??
            rawTask.chatId ??
            null;
        const sourceReadOnly = policy.sourceReadOnly === true;
        const feedbackChatIds = uniqueChatIds([
            ...(policy.feedbackChatIds || []),
            ...(rawTask.feedbackChatIds || []),
            // Never feed the source chat back into outbound feedback for read-only
            // profiles (vova_cluster / supernova_cluster) — that would leak bot
            // notifications into upstream operator-only channels.
            sourceReadOnly ? null : originChatId
        ]);
        const sport = rawTask.sport || rawTask.sportName || rawTask.pair?.sportName || 'soccer';
        const limitPolicy = policy.limits || {};
        const task = {
            id: rawTask.id || this._createTelegramTaskId(),
            bookmaker: this.bookmakerName,
            bookmakerId: this.bookmakerId,
            accountId: rawTask.accountId || this.config.accountId || null,
            home,
            away,
            outcome,
            sport,
            league: rawTask.league || null,
            isPrematch,
            mode: requestedMode,
            bookmakerMatchId: rawTask.bookmakerMatchId || rawTask.matchId || null,
            matchDate: rawTask.matchDate || null,
            expectedOdds: rawTask.expectedOdds ?? null,
            expectedROI: rawTask.expectedROI ?? null,
            stake: rawTask.stake ?? policy.brm?.stake ?? policy.stake ?? null,
            minOdds: rawTask.minOdds ?? policy.minOdds ?? null,
            maxOdds: rawTask.maxOdds ?? policy.maxOdds ?? null,
            sourceType: 'telegram',
            sourceVariant: policy.profileId || 'default',
            sourceProfileId: policy.profileId || 'default',
            sourcePolicy: {
                stake: rawTask.stake ?? policy.brm?.stake ?? policy.stake ?? null,
                minOdds: rawTask.minOdds ?? policy.minOdds ?? null,
                maxOdds: rawTask.maxOdds ?? policy.maxOdds ?? null,
                preemption: policy.preemption || null,
                limits: limitPolicy
            },
            telegramPolicy: {
                stake: rawTask.stake ?? policy.brm?.stake ?? policy.stake ?? null,
                minOdds: rawTask.minOdds ?? policy.minOdds ?? null,
                maxOdds: rawTask.maxOdds ?? policy.maxOdds ?? null,
                feedbackChatIds,
                limits: limitPolicy
            },
            limitPolicy,
            feedbackChatIds,
            originChatId,
            createdAt: rawTask.createdAt || now,
            expiresAt: rawTask.expiresAt || (ttlMs > 0 ? now + ttlMs : null),
            signalId: rawTask.signalId || rawTask.telegramContext?.signalId || null,
            executionState: rawTask.executionState || 'queued',
            stopRequested: false,
            stopRequestedAt: null,
            stopRequestedBy: null,
            candidateLadder,
            outcomeCandidates: Array.isArray(rawTask.outcomeCandidates)
                ? rawTask.outcomeCandidates
                : (Array.isArray(rawTask.telegramContext?.outcomeCandidates)
                    ? rawTask.telegramContext.outcomeCandidates
                    : []),
            normalizedIntent: rawTask.normalizedIntent || rawTask.intent || null,
            pair: rawTask.pair || { sportName: sport },
            outcomeData: rawTask.outcomeData || null,
            pairFull: rawTask.pairFull || null,
            originTargetLabel: rawTask.originTargetLabel || rawTask.telegramContext?.originTargetLabel || null,
            telegramContext: {
                profileId: policy.profileId || 'default',
                clusterId: policy.clusterId || rawTask.telegramContext?.clusterId || null,
                sourceReadOnly,
                originChatId,
                signalId: rawTask.signalId || rawTask.telegramContext?.signalId || null,
                feedbackChatIds,
                messageIds: rawTask.messageIds || rawTask.telegramContext?.messageIds || [],
                textContext: rawTask.textContext || rawTask.telegramContext?.textContext || '',
                mediaGroupId: rawTask.mediaGroupId || rawTask.telegramContext?.mediaGroupId || null,
                chatId: rawTask.chatId || rawTask.telegramContext?.chatId || originChatId || null,
                topicId: rawTask.topicId || rawTask.telegramContext?.topicId || null,
                authorId: rawTask.authorId || rawTask.telegramContext?.authorId || null,
                authorUsername: rawTask.authorUsername || rawTask.telegramContext?.authorUsername || null,
                originTargetLabel: rawTask.originTargetLabel || rawTask.telegramContext?.originTargetLabel || null,
                outcomeCandidates: Array.isArray(rawTask.outcomeCandidates)
                    ? rawTask.outcomeCandidates
                    : (Array.isArray(rawTask.telegramContext?.outcomeCandidates)
                        ? rawTask.telegramContext.outcomeCandidates
                        : [])
            }
        };

        task.matchKey = rawTask.matchKey || this._generateMatchKey(task.home, task.away, task.matchDate);
        task.limitProfileKey = rawTask.limitProfileKey || getTaskLimitProfileKey(task);
        return task;
    }

    _resolveTelegramPolicy(rawTask = {}, mode = 'live') {
        const requestedBookmakerId = normalizeIdentifier(rawTask.bookmakerId || this.bookmakerId) || this.bookmakerId;
        if (requestedBookmakerId !== this.bookmakerId) {
            throw new Error(`Telegram task bookmaker mismatch: expected ${this.bookmakerId}, got ${requestedBookmakerId}`);
        }

        const defaultProfileId = normalizeIdentifier(this.config.telegram?.defaultProfileId);
        const requestedProfileId = normalizeIdentifier(
            rawTask.sourceProfileId ||
            rawTask.profileId ||
            rawTask.chatProfileId ||
            rawTask.telegramContext?.profileId ||
            defaultProfileId
        ) || 'default';
        const accountId = normalizeIdentifier(rawTask.accountId || this.config.accountId);

        if (requestedProfileId && this.chatProfileManager.hasProfile(requestedProfileId)) {
            const resolved = this.chatProfileManager.resolveExecutionPolicy({
                profileId: requestedProfileId,
                bookmakerId: this.bookmakerId,
                accountId,
                mode,
                explicitMinOdds: rawTask.minOdds ?? rawTask.explicitMinOdds
            });

            if (!resolved.enabled) {
                throw new Error(`Telegram profile "${requestedProfileId}" rejected task: ${resolved.reason}`);
            }

            return resolved;
        }

        return this._buildImplicitTelegramPolicy({
            profileId: requestedProfileId,
            rawTask,
            mode,
            bookmakerId: this.bookmakerId,
            accountId
        });
    }

    _buildImplicitTelegramPolicy({ profileId, rawTask = {}, mode, bookmakerId, accountId }) {
        const defaults = getDefaultTelegramTaskConfig(this.config);
        const telegramDefaults = this.config.telegram?.defaults || {};
        const originChatId = rawTask.originChatId || rawTask.telegramContext?.originChatId || rawTask.chatId || null;

        // F1 fail-closed: when the requested profile id was non-default but is
        // unknown to ChatProfileManager (renamed/removed/typo), or when the
        // ingress already marked the upstream signal as sourceReadOnly, we
        // MUST NOT funnel the originating chat id back into feedbackChatIds
        // — that would re-open the source-chat write leak. Look up the
        // profile catalog for any matching source target as a defense-in-depth
        // signal too: if any enabled profile classifies the originChatId as a
        // sourceReadOnly source target, default sourceReadOnly:true.
        let sourceReadOnly = rawTask.telegramContext?.sourceReadOnly === true;

        const requestedProfileId = profileId && profileId !== 'default' ? profileId : null;
        const profileMissing = !!(requestedProfileId && this.chatProfileManager &&
            !this.chatProfileManager.hasProfile(requestedProfileId));
        if (profileMissing) {
            sourceReadOnly = true;
        }

        if (!sourceReadOnly && originChatId && this.chatProfileManager?.getEnabledProfiles) {
            try {
                const enabled = this.chatProfileManager.getEnabledProfiles({ bookmakerId, accountId, mode });
                for (const candidate of enabled) {
                    if (candidate?.sourceReadOnly &&
                        this.chatProfileManager.isSourceTarget(candidate, originChatId, null)) {
                        sourceReadOnly = true;
                        break;
                    }
                }
            } catch (_err) {
                // best-effort defense; on lookup failure stay with prior value
            }
        }

        const feedbackChatIds = uniqueChatIds([
            ...(telegramDefaults.feedbackChatIds || telegramDefaults.chatIds || []),
            ...(rawTask.feedbackChatIds || []),
            // Fail-closed: never feed source chat into outbound feedback when
            // sourceReadOnly is set (or when we cannot confirm otherwise).
            sourceReadOnly ? null : originChatId
        ]);
        const stake = rawTask.stake ?? telegramDefaults.brm?.stake ?? defaults.stake;

        return {
            enabled: true,
            profileId: profileId || 'default',
            mode,
            bookmakerId,
            accountId: accountId || null,
            minOdds: rawTask.minOdds ?? defaults.minOdds,
            maxOdds: rawTask.maxOdds ?? defaults.maxOdds,
            stake,
            brm: {
                ...(telegramDefaults.brm || {}),
                stake
            },
            limits: telegramDefaults.limits || {},
            preemption: telegramDefaults.preemption || { allowReplaceUntil: 'submit_started' },
            expansion: telegramDefaults.expansion || {},
            sourceReadOnly,
            feedbackChatIds,
            chatIds: feedbackChatIds,
            llmHints: telegramDefaults.llmHints || {},
            raw: {
                ...telegramDefaults,
                ttlMs: rawTask.ttlMs ?? telegramDefaults.ttlMs ?? 30000
            }
        };
    }

    _assertTelegramTaskMode(isPrematch) {
        const runtimeIsPrematch = Boolean(this.adapter.isPrematch);
        if (runtimeIsPrematch !== Boolean(isPrematch)) {
            this.logger.log(
                `⚠️ Telegram task mode differs from runtime: signal says ${isPrematch ? 'prematch' : 'live'}, runtime is ${runtimeIsPrematch ? 'prematch' : 'live'}`
            );
        }
    }

    _createTelegramTaskId() {
        this._telegramTaskSeq += 1;
        return `tg_${this.bookmakerId}_${Date.now()}_${process.pid}_${this._telegramTaskSeq}`;
    }

    // ==================== UTILS ====================

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getState() {
        return { ...this.state };
    }

    // ==================== STRATEGY HELPERS ====================

    /**
     * Get stability duration for strategy type
     */
    _getStrategyDuration(type) {
        if (type === 'single') return this.config.singleDurationSeconds;
        return type === 'fast' ? this.config.fastDurationSeconds : this.config.slowDurationSeconds;
    }

    /**
     * Get stake for strategy type
     */
    _getStrategyStake(type, isHighROI = false) {
        if (type === 'single') return this.config.singleStake;
        if (type === 'fast') {
            return isHighROI ? this.config.fastHighROIStake : this.config.fastStake;
        }
        return isHighROI ? this.config.slowHighROIStake : this.config.slowStake;
    }
}

module.exports = { BaseBettor };
