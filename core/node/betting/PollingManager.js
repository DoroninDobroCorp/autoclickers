/**
 * PollingManager - Manages analyzer polling and pair filtering
 * 
 * Extracted from BaseBettor for better separation of concerns.
 * Handles:
 * - Periodic polling of analyzer API
 * - Filtering pairs for target bookmaker
 * - Overlap protection (prevents concurrent polls)
 * - Analyzer availability tracking
 */

const { POLL_INTERVAL_MS } = require('../config/constants.js');

/**
 * @typedef {Object} PollingManagerOptions
 * @property {Object} analyzerClient - Analyzer API client
 * @property {string} bookmakerName - Target bookmaker name
 * @property {number} [pollIntervalMs] - Polling interval in ms
 * @property {boolean} [verbose] - Enable verbose logging
 * @property {boolean} [debug] - Enable debug logging
 * @property {Object} [logger] - Logger instance
 */

class PollingManager {
    /**
     * @param {PollingManagerOptions} options
     */
    constructor(options = {}) {
        this.analyzerClient = options.analyzerClient;
        this.prematchAnalyzerClient = options.prematchAnalyzerClient || null;
        this.bookmakerName = options.bookmakerName || '';
        this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
        this.verbose = options.verbose || false;
        this.debug = options.debug || false;
        this.logger = options.logger || console;
        
        // State
        this._isPolling = false;
        this._isRunning = false;
        this._pollIntervalId = null;
        this._analyzerAvailable = true;
        
        // Callbacks
        this._onPairs = null;
        this._onAnalyzerDown = null;
        this._onAnalyzerUp = null;
        
        // Stats
        this._pollCount = 0;
        this._lastPollTime = null;
        this._lastPollDuration = null;
    }

    /**
     * Set callback for when pairs are received
     * @param {Function} callback - (pairs: Array) => Promise<void>
     */
    onPairs(callback) {
        this._onPairs = callback;
        return this;
    }

    /**
     * Set callback for when analyzer goes down
     * @param {Function} callback - (reason: string) => void
     */
    onAnalyzerDown(callback) {
        this._onAnalyzerDown = callback;
        return this;
    }

    /**
     * Set callback for when analyzer recovers
     * @param {Function} callback - () => void
     */
    onAnalyzerUp(callback) {
        this._onAnalyzerUp = callback;
        return this;
    }

    /**
     * Start polling
     */
    start() {
        if (this._isRunning) {
            this.logger.log('⚠️ PollingManager already running');
            return;
        }

        this._isRunning = true;
        this.logger.log(`🔄 Starting analyzer polling (every ${this.pollIntervalMs}ms)`);
        
        // Initial poll
        this._poll();
        
        // Periodic polling
        this._pollIntervalId = setInterval(() => {
            this._poll();
        }, this.pollIntervalMs);
    }

    /**
     * Stop polling
     */
    stop() {
        this._isRunning = false;
        
        if (this._pollIntervalId) {
            clearInterval(this._pollIntervalId);
            this._pollIntervalId = null;
        }
        
        this.logger.log('🔄 PollingManager stopped');
    }

    /**
     * Single poll iteration
     */
    async _poll() {
        if (!this._isRunning) return;
        
        // Prevent overlapping polls (race condition fix)
        if (this._isPolling) {
            if (this.verbose || this.debug) {
                this.logger.log('⏳ Previous poll still running, skipping...');
            }
            return;
        }
        
        this._isPolling = true;
        const pollStartTime = Date.now();
        this._pollCount++;
        
        try {
            const pairsData = await this.analyzerClient.fetchPairs();
            let pairs = this._filterPairs(pairsData);
            
            // Dual polling: also fetch prematch pairs if configured
            if (this.prematchAnalyzerClient) {
                try {
                    const prematchData = await this.prematchAnalyzerClient.fetchPairs();
                    let prematchPairs = this._filterPairs(prematchData);
                    if (prematchPairs.length > 0) {
                        // Filter out prematch pairs that overlap with live pairs
                        // (match already went live → prematch data is stale)
                        if (pairs.length > 0) {
                            const liveMatchIds = new Set(
                                pairs.map(p => String(p.second?.matchId)).filter(Boolean)
                            );
                            const before = prematchPairs.length;
                            prematchPairs = prematchPairs.filter(p => {
                                const mid = p.second?.matchId;
                                return !mid || !liveMatchIds.has(String(mid));
                            });
                            if (before !== prematchPairs.length && (this.verbose || this.debug)) {
                                this.logger.log(`🔄 Filtered ${before - prematchPairs.length} stale prematch pairs (match already live)`);
                            }
                        }
                        // Prematch pairs FIRST for priority
                        pairs = [...prematchPairs, ...pairs];
                        if (this.verbose || this.debug) {
                            this.logger.log(`📦 Dual poll: ${prematchPairs.length} prematch + ${pairs.length - prematchPairs.length} live pairs`);
                        }
                    }
                } catch (e) {
                    // Prematch fetch failure is non-critical
                    if (this.debug) {
                        this.logger.log(`⚠️ Prematch analyzer fetch failed: ${e.message}`);
                    }
                }
            }
            
            if (this.debug && this._pollCount <= 3) {
                const totalPairs = Object.values(pairsData.data || pairsData || {}).length;
                this.logger.log(`🔍 DEBUG: fetchPairs returned ${totalPairs} total, ${pairs.length} filtered for "${this.bookmakerName}"`);
            }
            
            if (pairs.length > 0) {
                this._handleAnalyzerRecovered();
                
                if (this._onPairs) {
                    await this._onPairs(pairs);
                }
            } else {
                this._handleAnalyzerEmpty('No pairs for this bookmaker');
            }
        } catch (e) {
            this._handleAnalyzerEmpty(`Analyzer error: ${e.message}`);
            if (this.verbose) {
                this.logger.error(`Poll error: ${e.message}`);
            }
        } finally {
            this._isPolling = false;
            this._lastPollTime = Date.now();
            this._lastPollDuration = Date.now() - pollStartTime;
            
            if (this.debug) {
                this.logger.log(`🔍 DEBUG: Poll #${this._pollCount} completed in ${this._lastPollDuration}ms`);
            }
        }
    }

    /**
     * Filter pairs for target bookmaker
     * @param {Object} pairsData - Raw data from analyzer
     * @returns {Array} Filtered pairs
     */
    _filterPairs(pairsData) {
        const allPairs = Object.values(pairsData.data || pairsData || {});
        
        // Remove _Prematch suffix for matching (analyzer uses base bookmaker name)
        const target = this.bookmakerName.toLowerCase().replace(/_(live|prematch)$/, '');
        
        return allPairs.filter(p => {
            const bm1 = (p.first?.bookmaker || '').toLowerCase().replace(/_(live|prematch)$/, '');
            const bm2 = (p.second?.bookmaker || '').toLowerCase().replace(/_(live|prematch)$/, '');
            return bm1 === target || bm2 === target;
        });
    }

    /**
     * Handle analyzer becoming unavailable
     */
    _handleAnalyzerEmpty(reason = 'Analyzer returned empty dataset') {
        if (!this._analyzerAvailable) return;
        
        this._analyzerAvailable = false;
        this.logger.log(`🛑 Analyzer paused: ${reason}`);
        
        if (this._onAnalyzerDown) {
            this._onAnalyzerDown(reason);
        }
    }

    /**
     * Handle analyzer recovery
     */
    _handleAnalyzerRecovered() {
        if (this._analyzerAvailable) return;
        
        this._analyzerAvailable = true;
        this.logger.log('✅ Analyzer data stream restored');
        
        if (this._onAnalyzerUp) {
            this._onAnalyzerUp();
        }
    }

    /**
     * Check if analyzer is available
     */
    isAnalyzerAvailable() {
        return this._analyzerAvailable;
    }

    /**
     * Check if polling is running
     */
    isRunning() {
        return this._isRunning;
    }

    /**
     * Get polling statistics
     */
    getStats() {
        return {
            isRunning: this._isRunning,
            isPolling: this._isPolling,
            analyzerAvailable: this._analyzerAvailable,
            pollCount: this._pollCount,
            lastPollTime: this._lastPollTime,
            lastPollDuration: this._lastPollDuration
        };
    }
}

module.exports = { PollingManager };
