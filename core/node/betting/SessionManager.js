/**
 * SessionManager - Manages login, session refresh, and validation
 * 
 * Extracted from BaseBettor for better separation of concerns.
 * Handles:
 * - Initial login
 * - Periodic session validation
 * - Automatic re-login on expiry
 * - Session state tracking for health checks
 */

const { SESSION_CHECK_INTERVAL_MS, SESSION_CACHE_TTL_MS } = require('../config/constants.js');

/**
 * @typedef {Object} SessionState
 * @property {boolean} isValid - Current session validity
 * @property {number|null} lastCheckTime - Last validation time
 * @property {number|null} lastLoginTime - Last successful login time
 * @property {string|null} loginError - Last login error message
 * @property {number} loginAttempts - Total login attempts
 */

/**
 * @typedef {Object} SessionManagerOptions
 * @property {Object} adapter - Bookmaker adapter with login/isSessionValid methods
 * @property {number} [checkIntervalMs] - Session check interval
 * @property {number} [cacheTTLMs] - Session cache TTL
 * @property {Object} [logger] - Logger instance
 */

class SessionManager {
    /**
     * @param {SessionManagerOptions} options
     */
    constructor(options = {}) {
        this.adapter = options.adapter;
        this.checkIntervalMs = options.checkIntervalMs || SESSION_CHECK_INTERVAL_MS;
        this.cacheTTLMs = options.cacheTTLMs || SESSION_CACHE_TTL_MS;
        this.logger = options.logger || console;
        
        // State
        this._isValid = false;
        this._lastCheckTime = null;
        this._lastLoginTime = null;
        this._loginError = null;
        this._loginAttempts = 0;
        
        // Checker interval
        this._checkInterval = null;
        
        // Callbacks
        this._onLoginSuccess = null;
        this._onLoginFailed = null;
        this._onSessionExpired = null;
    }

    /**
     * Set callback for successful login
     * @param {Function} callback - () => void
     */
    onLoginSuccess(callback) {
        this._onLoginSuccess = callback;
        return this;
    }

    /**
     * Set callback for failed login
     * @param {Function} callback - (error: string) => void
     */
    onLoginFailed(callback) {
        this._onLoginFailed = callback;
        return this;
    }

    /**
     * Set callback for session expiry
     * @param {Function} callback - () => void
     */
    onSessionExpired(callback) {
        this._onSessionExpired = callback;
        return this;
    }

    /**
     * Perform initial login
     * @returns {Promise<boolean>} Success status
     */
    async login() {
        this._loginAttempts++;
        
        try {
            this.logger.log('🔐 Attempting login...');
            const success = await this.adapter.login();
            
            if (success) {
                this._isValid = true;
                this._lastLoginTime = Date.now();
                this._lastCheckTime = Date.now();
                this._loginError = null;
                
                this.logger.log('✅ Login successful');
                
                if (this._onLoginSuccess) {
                    this._onLoginSuccess();
                }
                
                return true;
            } else {
                this._isValid = false;
                this._loginError = 'Login returned false';
                
                this.logger.error('❌ Login failed');
                
                if (this._onLoginFailed) {
                    this._onLoginFailed(this._loginError);
                }
                
                return false;
            }
        } catch (e) {
            this._isValid = false;
            this._loginError = e.message;
            
            this.logger.error(`❌ Login error: ${e.message}`);
            
            if (this._onLoginFailed) {
                this._onLoginFailed(this._loginError);
            }
            
            return false;
        }
    }

    /**
     * Start periodic session checking
     */
    startChecker() {
        if (this._checkInterval) {
            this.logger.log('⚠️ Session checker already running');
            return;
        }

        this._checkInterval = setInterval(async () => {
            await this._checkAndRefresh();
        }, this.checkIntervalMs);
        
        this.logger.log(`🔐 Session checker started (every ${this.checkIntervalMs / 1000}s)`);
    }

    /**
     * Stop periodic session checking
     */
    stopChecker() {
        if (this._checkInterval) {
            clearInterval(this._checkInterval);
            this._checkInterval = null;
            this.logger.log('🔐 Session checker stopped');
        }
    }

    /**
     * Check and refresh session if needed
     * @returns {Promise<boolean>} Current session validity
     */
    async _checkAndRefresh() {
        try {
            const valid = await this.adapter.isSessionValid();
            this._lastCheckTime = Date.now();
            
            if (valid) {
                this._isValid = true;
                return true;
            }
            
            // Session expired - try re-login
            this.logger.log('⚠️ Session expired, re-logging in...');
            
            if (this._onSessionExpired) {
                this._onSessionExpired();
            }
            
            return await this.login();
            
        } catch (e) {
            this.logger.error(`Session check error: ${e.message}`);
            this._loginError = e.message;
            this._isValid = false;
            return false;
        }
    }

    /**
     * Check if session is valid (with caching)
     * @param {boolean} [useCache=true] - Use cached result if fresh
     * @returns {Promise<boolean>} Session validity
     */
    async isValid(useCache = true) {
        // Return cached result if fresh enough
        if (useCache && this._lastCheckTime) {
            const cacheAge = Date.now() - this._lastCheckTime;
            if (cacheAge < this.cacheTTLMs) {
                return this._isValid;
            }
        }
        
        // Check fresh
        try {
            this._isValid = await this.adapter.isSessionValid();
            this._lastCheckTime = Date.now();
            
            if (!this._isValid) {
                this._loginError = 'Session invalid';
            }
            
            return this._isValid;
        } catch (e) {
            this._loginError = e.message;
            this._isValid = false;
            return false;
        }
    }

    /**
     * Get current session state
     * @returns {SessionState}
     */
    getState() {
        return {
            isValid: this._isValid,
            lastCheckTime: this._lastCheckTime,
            lastLoginTime: this._lastLoginTime,
            loginError: this._loginError,
            loginAttempts: this._loginAttempts
        };
    }

    /**
     * Check if there's a login error
     * @returns {boolean}
     */
    hasError() {
        return this._loginError !== null;
    }

    /**
     * Get last login error
     * @returns {string|null}
     */
    getError() {
        return this._loginError;
    }

    /**
     * Reset state (for testing)
     */
    reset() {
        this._isValid = false;
        this._lastCheckTime = null;
        this._lastLoginTime = null;
        this._loginError = null;
        this._loginAttempts = 0;
    }
}

module.exports = { SessionManager };
