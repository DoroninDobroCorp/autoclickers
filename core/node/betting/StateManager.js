/**
 * StateManager - Persistence and state management
 * 
 * Extracted from BaseBettor. Handles:
 * - State save/load to file
 * - State expiration (1 hour)  
 * - Integration with LimitsManager for full state
 */

const fs = require('fs');
const constants = require('../config/constants.js');

class StateManager {
    /**
     * @param {Object} options
     * @param {string} options.filePath - Path to state file
     * @param {Object} options.limitsManager - LimitsManager instance for state sync
     * @param {Object} [options.logger] - Logger instance
     */
    constructor(options = {}) {
        this.filePath = options.filePath;
        this.limitsManager = options.limitsManager;
        this.logger = options.logger || console;
        this.maxAgeMs = options.maxAgeMs || constants.STATE_MAX_AGE_MS;
        
        // Core state
        this.state = {
            started: Date.now(),
            errors: 0,
            lastActivity: Date.now(),
            status: 'idle',
            goalReached: false,
            restartCount: 0,
            loginError: null,
            lastLoginAttempt: null
        };
    }

    /**
     * Load state from file
     * @returns {boolean} true if state was loaded
     */
    load() {
        if (!this.filePath || !fs.existsSync(this.filePath)) {
            return false;
        }

        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            
            // Check if state is still valid
            if (data.lastActivity && (Date.now() - data.lastActivity > this.maxAgeMs)) {
                this.logger.log('📂 State file too old (>1h), starting fresh');
                return false;
            }
            
            // Restore LimitsManager state if available
            if (this.limitsManager) {
                this.limitsManager.restoreState({
                    betsPlaced: data.betsPlaced || 0,
                    betAttempts: data.betAttempts || 0,
                    betHistory: data.betHistory || {}
                });
            }
            
            // Restore core state
            this.state.errors = data.errors || 0;
            this.state.goalReached = data.goalReached || false;
            this.state.restartCount = (data.restartCount || 0) + 1;
            this.state.started = data.started || Date.now();
            
            const bets = this.limitsManager?.getState()?.betsPlaced || 0;
            const attempts = this.limitsManager?.getState()?.betAttempts || 0;
            this.logger.log(`📂 Restored state: ${bets} bets, ${attempts} attempts, restart #${this.state.restartCount}`);
            return true;
        } catch (e) {
            this.logger.error(`Failed to load state: ${e.message}`);
            return false;
        }
    }

    /**
     * Save state to file
     */
    save() {
        if (!this.filePath) return;

        try {
            const limitsState = this.limitsManager?.getState() || {};
            const fullState = {
                ...this.state,
                betsPlaced: limitsState.betsPlaced,
                betAttempts: limitsState.betAttempts,
                betHistory: limitsState.betHistory,
                savedAt: Date.now()
            };
            fs.writeFileSync(this.filePath, JSON.stringify(fullState, null, 2));
        } catch (e) {
            this.logger.error(`Failed to save state: ${e.message}`);
        }
    }

    /**
     * Clear state file
     */
    clear() {
        if (!this.filePath) return;
        try {
            if (fs.existsSync(this.filePath)) {
                fs.unlinkSync(this.filePath);
            }
        } catch (e) {
            // Ignore
        }
    }

    /** Get state field */
    get(key) { return this.state[key]; }
    
    /** Set state field */
    set(key, value) { 
        this.state[key] = value; 
        this.state.lastActivity = Date.now();
    }
    
    /** Get full state */
    getAll() { return { ...this.state }; }
    
    /** Record error */
    recordError() { this.state.errors++; }
    
    /** Get uptime in seconds */
    getUptime() { return Math.floor((Date.now() - this.state.started) / 1000); }
}

module.exports = { StateManager };
