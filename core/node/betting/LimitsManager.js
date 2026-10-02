/**
 * LimitsManager - Управление лимитами ставок
 * 
 * Handles:
 * - Bet counting (attempts, successful)
 * - Local history tracking (PERSISTENT shared file!)
 * - Per-match limits with configurable scope
 * - Per-strategy limits
 * 
 * History is saved to a SHARED file (.bettor_shared_history.json) and loaded on start.
 * Records older than 24 hours are automatically cleaned.
 * 
 * Each bet record stores: outcome, source, stake, timestamp, bookmaker, mode.
 * matchLimitScope controls how limits are applied:
 *   crossMode: true  → prematch bet blocks live on same match (and vice versa)
 *   crossBookmaker: true → bet in Sansabet blocks same match in Volcano
 */

const fs = require('fs');
const path = require('path');

class LimitsManager {
    constructor(config = {}, logger = console) {
        this.logger = logger;
        
        // Identity: who is this instance? (used for filtering history)
        this.bookmaker = config.bookmaker || 'unknown';
        this.mode = config.mode || 'live'; // 'live' or 'prematch'
        
        // Match limit scope
        this.matchLimitScope = {
            crossMode: config.matchLimitScope?.crossMode ?? true,
            crossBookmaker: config.matchLimitScope?.crossBookmaker ?? false
        };
        
        // Goal limits
        this.maxBets = config.maxBets || Infinity;
        this.maxSuccessful = config.maxSuccessful || Infinity;
        
        // Per-match limits
        this.maxBetsPerMatch = config.maxBetsPerMatch || 4;
        this.maxStakePerBet = config.maxStakePerBet || null;
        this.maxStakePerStrategy = config.maxStakePerStrategy || null;
        
        // History retention (24 hours default)
        this.historyRetentionMs = (config.historyRetentionHours || 24) * 60 * 60 * 1000;
        
        // Counters
        this.betAttempts = 0;
        this.betsPlaced = 0;
        
        // Bet history - loaded from file for persistence across restarts
        this.betHistory = new Map();
        
        // History file path (set via setHistoryFile)
        this.historyFilePath = config.historyFilePath || null;
        
        // Load history from file if path provided
        if (this.historyFilePath) {
            this._loadHistory();
        }
        
        this.logger.log(
            `📋 LimitsManager: bookmaker=${this.bookmaker} mode=${this.mode} ` +
            `crossMode=${this.matchLimitScope.crossMode} crossBookmaker=${this.matchLimitScope.crossBookmaker}`
        );
        
        // Optional: TasksManager for persistent history
        this.tasksManager = null;
    }

    _inferSourceType(source) {
        const normalized = String(source || '').trim().toLowerCase();
        if (normalized.startsWith('telegram')) return 'telegram';
        if (normalized.startsWith('analyzer')) return 'analyzer';
        return normalized || 'unknown';
    }

    _resolveConfiguredLimitValue(configValue, source, sourceType) {
        if (typeof configValue === 'number') {
            return configValue;
        }

        if (!configValue || typeof configValue !== 'object' || Array.isArray(configValue)) {
            return null;
        }

        const candidates = [
            configValue.bySource?.[source],
            configValue.sources?.[source],
            configValue[source],
            configValue.bySourceType?.[sourceType],
            configValue[sourceType],
            configValue.default
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'number') {
                return candidate;
            }
        }

        return null;
    }
    
    /**
     * Set history file path and load existing history
     */
    setHistoryFile(filePath) {
        this.historyFilePath = filePath;
        this._loadHistory();
    }
    
    /**
     * Load bet history from file (called on startup and before each limit check)
     */
    _loadHistory() {
        if (!this.historyFilePath) return;
        
        try {
            if (fs.existsSync(this.historyFilePath)) {
                const raw = fs.readFileSync(this.historyFilePath, 'utf8');
                // SAFETY: empty file check before parse
                if (!raw || raw.trim().length < 3) {
                    this.logger.log(`\u26a0\ufe0f History file empty/corrupt, keeping in-memory data (${this.betHistory.size} keys)`);
                    return;
                }
                const data = JSON.parse(raw);
                const now = Date.now();
                let loaded = 0;
                let cleaned = 0;
                
                // MERGE instead of CLEAR+REPLACE - prevents history loss
                // Do NOT call this.betHistory.clear()!
                
                for (const [matchKey, bets] of Object.entries(data)) {
                    const freshBets = bets.filter(b => {
                        const age = now - (b.timestamp || 0);
                        if (age > this.historyRetentionMs) {
                            cleaned++;
                            return false;
                        }
                        return true;
                    });
                    
                    if (freshBets.length > 0) {
                        // Merge with existing in-memory data (deduplicate by timestamp+outcome)
                        const existing = this.betHistory.get(matchKey) || [];
                        const merged = [...existing];
                        for (const fb of freshBets) {
                            if (!merged.some(e => e.timestamp === fb.timestamp && e.outcome === fb.outcome)) {
                                merged.push(fb);
                            }
                        }
                        this.betHistory.set(matchKey, merged);
                        loaded += freshBets.length;
                    }
                }
                
                this.logger.log(`\ud83d\udcc2 Loaded ${loaded} bets from history, total ${this.betHistory.size} keys (cleaned ${cleaned} old records)`);
            }
        } catch (e) {
            this.logger.log(`\u26a0\ufe0f Failed to load bet history: ${e.message}`);
        }
    }
    
    /**
     * Save bet history to file
     */
    _saveHistory() {
        if (!this.historyFilePath) return;
        
        try {
            // Convert Map to object for JSON serialization
            const data = {};
            for (const [key, value] of this.betHistory.entries()) {
                data[key] = value;
            }
            
            // Safety: do not overwrite non-empty history file with empty data
            if (Object.keys(data).length === 0 && fs.existsSync(this.historyFilePath)) {
                try {
                    const existing = fs.readFileSync(this.historyFilePath, 'utf8');
                    if (existing.trim().length > 5) {
                        this.logger.log('⚠️ SAFETY: Not overwriting history with empty data');
                        return;
                    }
                } catch (e) { /* ignore */ }
            }
            // Atomic write: temp file + rename
            const tempPath = this.historyFilePath + '.tmp';
            fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
            fs.renameSync(tempPath, this.historyFilePath);
        } catch (e) {
            this.logger.log(`⚠️ Failed to save bet history: ${e.message}`);
        }
    }
    
    /**
     * Set TasksManager for persistent history lookup
     */
    setTasksManager(tasksManager) {
        this.tasksManager = tasksManager;
    }
    
    /**
     * Restore state from saved data (for crash recovery)
     */
    restoreState(state) {
        if (state.betAttempts) this.betAttempts = state.betAttempts;
        if (state.betsPlaced) this.betsPlaced = state.betsPlaced;
    }
    
    /**
     * Get current state for persistence
     */
    getState() {
        return {
            betAttempts: this.betAttempts,
            betsPlaced: this.betsPlaced
        };
    }
    
    // ==================== GOAL LIMITS ====================
    
    /**
     * Check if we've reached our betting goals
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkGoalLimits() {
        if (this.betAttempts >= this.maxBets) {
            return { 
                allowed: false, 
                reason: `Max bet attempts reached (${this.maxBets})` 
            };
        }
        
        if (this.betsPlaced >= this.maxSuccessful) {
            return { 
                allowed: false, 
                reason: `Max successful bets reached (${this.betsPlaced}/${this.maxSuccessful})` 
            };
        }
        
        return { allowed: true };
    }
    
    /**
     * Increment attempt counter
     */
    recordAttempt() {
        this.betAttempts++;
    }
    
    /**
     * Increment successful bet counter
     */
    recordSuccess() {
        this.betsPlaced++;
    }
    
    // ==================== MATCH/STRATEGY LIMITS ====================
    
    /**
     * Generate normalized match key (consistent with TaskBuilder — substring(0,20))
     * @param {string} home - Home team name
     * @param {string} away - Away team name
     * @param {string} [matchDate] - ISO date string of match start (pair.first.matchDate from Pinnacle)
     * @returns {string} Normalized key like "team1_team2_20260312" or "team1_team2" (fallback)
     */
    generateMatchKey(home, away, matchDate) {
        const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20);
        const base = `${normalize(home)}_${normalize(away)}`;
        const datePart = LimitsManager._extractDatePart(matchDate);
        return datePart ? `${base}_${datePart}` : base;
    }

    /**
     * Extract YYYYMMDD date part from ISO date string.
     * Returns null for zero/invalid/missing dates.
     */
    static _extractDatePart(matchDate) {
        if (!matchDate || typeof matchDate !== 'string') return null;
        // Zero time from Go: "0001-01-01T00:00:00Z"
        if (matchDate.startsWith('0001-01-01')) return null;
        try {
            const d = new Date(matchDate);
            if (isNaN(d.getTime()) || d.getFullYear() < 2020) return null;
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const day = String(d.getUTCDate()).padStart(2, '0');
            return `${y}${m}${day}`;
        } catch {
            return null;
        }
    }
    
    /**
     * Filter bets by matchLimitScope
     * @param {Array} bets - All bets for a match
     * @returns {Array} - Bets that count toward this instance's limits
     */
    _filterByScope(bets) {
        return bets.filter(b => {
            // Always count bets from same bookmaker + mode
            const sameBookmaker = !b.bookmaker || b.bookmaker === this.bookmaker;
            const sameMode = !b.mode || b.mode === this.mode;
            
            if (sameBookmaker && sameMode) return true;
            
            // Cross-mode: same bookmaker, different mode
            if (sameBookmaker && !sameMode) {
                return this.matchLimitScope.crossMode;
            }
            
            // Cross-bookmaker: different bookmaker
            if (!sameBookmaker) {
                if (!this.matchLimitScope.crossBookmaker) return false;
                // If crossBookmaker=true, also respect crossMode
                if (sameMode) return true;
                return this.matchLimitScope.crossMode;
            }
            
            return false;
        });
    }
    
    /**
     * Get bet statistics for a match (scope-aware)
     * @param {string} matchKey - Normalized match key
     * @param {string} source - Strategy source (e.g., 'analyzer_fast')
     */
    getMatchStats(matchKey, source = null) {
        // Re-read from file to see bets from other processes
        this._loadHistory();
        
        let allBets = [...(this.betHistory.get(matchKey) || [])];
        
        // BACKWARD COMPAT: also check old-format key (without date suffix)
        // During transition, old records have "team1_team2" but new keys have "team1_team2_20260312"
        const baseKey = matchKey.replace(/_\d{8}$/, '');
        if (baseKey !== matchKey) {
            const oldBets = this.betHistory.get(baseKey) || [];
            if (oldBets.length > 0) {
                allBets = allBets.concat(oldBets);
            }
        }
        
        const scopedBets = this._filterByScope(allBets);
        
        let count = scopedBets.length;
        let totalStaked = scopedBets.reduce((sum, b) => sum + (b.stake || 0), 0);
        let totalStakedBySource = 0;
        let hasBetForSource = false;
        
        if (source) {
            const sourceBets = scopedBets.filter(b => b.source === source);
            totalStakedBySource = sourceBets.reduce((sum, b) => sum + (b.stake || 0), 0);
            hasBetForSource = sourceBets.length > 0;
        }
        
        return { count, totalStaked, totalStakedBySource, hasBetForSource };
    }
    
    /**
     * Check local limits for a bet
     * @param {string} matchKey - Match key
     * @param {string} source - Strategy source
     * @param {number} stake - Proposed stake
     * @returns {{ allowed: boolean, reason?: string, adjustedStake?: number }}
     */
    checkLocalLimits(matchKey, source, stake, options = {}) {
        const stats = this.getMatchStats(matchKey, source);
        const sourceType = this._inferSourceType(source);
        const resolvedMaxBetsPerMatch =
            (typeof options.maxBetsPerMatch === 'number' ? options.maxBetsPerMatch : null) ??
            this._resolveConfiguredLimitValue(this.maxBetsPerMatch, source, sourceType) ??
            4;
        const resolvedMaxStakePerBet =
            (typeof options.maxStakePerBet === 'number' ? options.maxStakePerBet : null) ??
            this._resolveConfiguredLimitValue(this.maxStakePerBet, source, sourceType);
        const resolvedMaxStakePerStrategy =
            (typeof options.maxStakePerStrategy === 'number' ? options.maxStakePerStrategy : null) ??
            (typeof options.maxStake === 'number' ? options.maxStake : null) ??
            this._resolveConfiguredLimitValue(this.maxStakePerStrategy, source, sourceType);
        
        // Check 1: Already bet with this exact strategy?
        if (stats.hasBetForSource && resolvedMaxStakePerStrategy === null) {
            return {
                allowed: false,
                reason: `Already bet on this match with strategy ${source}`
            };
        }
        
        // Check 2: Max bets per match
        if (stats.count >= resolvedMaxBetsPerMatch) {
            return {
                allowed: false,
                reason: `Match limit reached: ${stats.count}/${resolvedMaxBetsPerMatch} bets`
            };
        }
        
        let adjustedStake = stake;
        if (Number.isFinite(resolvedMaxStakePerBet) && adjustedStake > resolvedMaxStakePerBet) {
            adjustedStake = Math.floor(resolvedMaxStakePerBet * 100) / 100;
        }

        // Check 3: Max stake per strategy
        const maxStake = resolvedMaxStakePerStrategy || adjustedStake;
        const remaining = maxStake - stats.totalStakedBySource;
        
        if (remaining <= 0.01) {
            return {
                allowed: false,
                reason: `Strategy stake limit: ${stats.totalStakedBySource.toFixed(2)}/${maxStake.toFixed(2)} EUR`
            };
        }
        
        // Adjust stake if needed
        if (stake > remaining) {
            adjustedStake = Math.floor(remaining * 100) / 100;
        }
        
        return { allowed: true, adjustedStake };
    }
    
    /**
     * Record a placed bet in shared history and save to file
     * @param {string} matchKey - Normalized match key (with date if available)
     * @param {string} outcome - Bet outcome
     * @param {string} source - Strategy source
     * @param {number} stake - Stake amount
     * @param {string} [matchDate] - ISO match start date (for debugging)
     */
    recordBet(matchKey, outcome, source, stake, matchDate) {
        // Re-read first to get latest from other processes
        this._loadHistory();
        
        if (!this.betHistory.has(matchKey)) {
            this.betHistory.set(matchKey, []);
        }
        
        this.betHistory.get(matchKey).push({
            outcome,
            source,
            stake,
            bookmaker: this.bookmaker,
            mode: this.mode,
            timestamp: Date.now(),
            matchDate: matchDate || null
        });
        
        // Persist to shared file
        this._saveHistory();
        
        this.logger.log(
            `📝 Recorded bet: ${matchKey} ${outcome} ${this.bookmaker}/${this.mode} ${stake} EUR`
        );
    }
    
    /**
     * Log current limits status
     */
    logStatus(matchKey, source) {
        const stats = this.getMatchStats(matchKey, source);
        const sourceType = this._inferSourceType(source);
        const maxStakePerBet = this._resolveConfiguredLimitValue(this.maxStakePerBet, source, sourceType) ?? 'N/A';
        const maxStake = this._resolveConfiguredLimitValue(this.maxStakePerStrategy, source, sourceType) ?? 'N/A';
        const maxBetsPerMatch = this._resolveConfiguredLimitValue(this.maxBetsPerMatch, source, sourceType) ?? this.maxBetsPerMatch;
        const allBets = this.betHistory.get(matchKey) || [];
        
        this.logger.log(
            `📊 Match limits (${this.bookmaker}/${this.mode}, ${source}): ` +
            `${stats.count}/${maxBetsPerMatch} bets in scope, ` +
            `${allBets.length} total across all sources, ` +
            `${stats.totalStakedBySource.toFixed(2)}/${maxStake} EUR by this strategy, ` +
            `${maxStakePerBet} EUR max per bet`
        );
    }
}

module.exports = { LimitsManager };
