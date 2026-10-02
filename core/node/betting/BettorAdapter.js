/**
 * BettorAdapter - базовый interface для адаптеров букмекеров
 * 
 * Реализации:
 * - API адаптер (Sansabet, Zlatnik) - HTTP запросы
 * - Playwright адаптер - браузерная автоматизация
 * - Hybrid адаптер (Volcano) - Playwright для логина, API для ставок
 */

class BettorAdapter {
    constructor(config = {}) {
        this.config = config;
        this.bookmakerName = config.bookmakerName || 'Unknown';
        this.isLoggedIn = false;
        this.logger = config.logger || console;
        
        // Test mode: track used outcome types
        this.usedOutcomeTypes = new Set();
    }

    // ==================== HTTP HELPERS ====================

    /**
     * Fetch with timeout - base method for all adapters
     * Adapters can override _request() to add cookies/auth headers
     */
    async _fetchWithTimeout(url, options = {}) {
        const timeoutMs = this.config.httpTimeoutMs || 20000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            const text = await res.text();
            
            let json = null;
            try { json = JSON.parse(text); } catch (e) {}
            
            return { status: res.status, text, json, ok: res.ok, headers: res.headers };
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                this.logger.error(`⏱️ Request timeout (${timeoutMs/1000}s): ${url}`);
                return { ok: false, error: e, timeout: true };
            }
            const errInfo = `${e.message || 'no message'} | code=${e.code || 'none'} | cause=${e.cause?.message || 'none'}`;
            this.logger.error(`Request failed: ${url} - ${errInfo}`);
            return { ok: false, error: e };
        }
    }

    /**
     * Авторизация на букмекере
     * @returns {Promise<boolean>} успех
     */
    async login() {
        throw new Error('login() must be implemented by adapter');
    }

    /**
     * Проверить валидность сессии
     * @returns {Promise<boolean>} сессия валидна
     */
    async isSessionValid() {
        throw new Error('isSessionValid() must be implemented by adapter');
    }

    /**
     * Обновить сессию если истекла
     * @returns {Promise<boolean>} успех
     */
    async refreshSession() {
        if (!await this.isSessionValid()) {
            return await this.login();
        }
        return true;
    }

    /**
     * Получить список матчей
     * @param {number} sportId - ID спорта
     * @returns {Promise<Array>} массив матчей
     */
    async getMatches(sportId) {
        throw new Error('getMatches() must be implemented by adapter');
    }

    /**
     * Получить детали матча (рынки, коэффициенты)
     * @param {string|number} matchId - ID матча
     * @param {string} sportName - название спорта (для выбора правильных marketIds)
     * @returns {Promise<Object>} детали матча
     */
    async getMatchDetails(matchId, sportName = null) {
        throw new Error('getMatchDetails() must be implemented by adapter');
    }

    /**
     * Найти матч по названиям команд
     * @param {Array} matches - список матчей
     * @param {string} home - домашняя команда
     * @param {string} away - гостевая команда
     * @returns {Object|null} найденный матч
     */
    findMatch(matches, home, away) {
        throw new Error('findMatch() must be implemented by adapter');
    }

    /**
     * Найти исход (selection) в матче
     * @param {Object} match - матч с деталями
     * @param {string} outcomeStr - строка исхода ("1", "X", "2", "T> 2.5", "H1 -1.5")
     * @param {number} expectedOdds - ожидаемый коэффициент (для валидации)
     * @returns {Object|null} найденный исход { betData, selectionId, oddVal, pick, ... }
     */
    findOutcome(match, outcomeStr, expectedOdds = null) {
        throw new Error('findOutcome() must be implemented by adapter');
    }

    /**
     * Разместить ставку
     * @param {Object} params
     * @param {Object} params.outcome - данные исхода от findOutcome()
     * @param {number} params.stake - сумма ставки
     * @param {Object} params.match - данные матча
     * @returns {Promise<Object>} результат { success, ticketId, error, ... }
     */
    async placeBet({ outcome, stake, match }) {
        throw new Error('placeBet() must be implemented by adapter');
    }

    /**
     * Парсинг ошибки от букмекера
     * Базовая реализация - адаптеры могут переопределить для специфичных сообщений
     * @param {Object} response - ответ от API/страницы
     * @returns {Object} { type, message, retryable }
     */
    parseError(response) {
        const error = response.error || response.msg || response.text || '';
        const errorLower = (typeof error === 'string' ? error : JSON.stringify(error)).toLowerCase();
        
        // Odds changed (universal patterns)
        if (errorLower.includes('odds') || errorLower.includes('changed') || 
            errorLower.includes('kvota') || errorLower.includes('promenjen') ||
            errorLower.includes('sbv_changed') || errorLower.includes('coefficient')) {
            return { type: BetErrorTypes.ODDS_CHANGED, message: error, retryable: true };
        }
        
        // Match/market closed
        if (errorLower.includes('closed') || errorLower.includes('suspend') ||
            errorLower.includes('zatvor') || errorLower.includes('završ') ||
            errorLower.includes('unavailable') || errorLower.includes('not allowed') ||
            errorLower.includes('nije dozvoljen') || errorLower.includes('dozvoljen za klađenje')) {
            return { type: BetErrorTypes.MATCH_CLOSED, message: error, retryable: false };
        }
        
        // Insufficient balance
        if (errorLower.includes('balance') || errorLower.includes('insufficient') ||
            errorLower.includes('sredstav') || errorLower.includes('sredstv') ||
            errorLower.includes('nema dovoljno') || errorLower.includes('nemate dovoljno') ||
            errorLower.includes('dovoljno sred')) {
            return { type: BetErrorTypes.INSUFFICIENT_BALANCE, message: error, retryable: false };
        }
        
        // Session expired
        if (errorLower.includes('session') || errorLower.includes('login') ||
            errorLower.includes('401') || errorLower.includes('token') ||
            errorLower.includes('expired') || errorLower.includes('prijav') ||
            errorLower.includes('unauthorized')) {
            return { type: BetErrorTypes.SESSION_EXPIRED, message: error, retryable: true };
        }
        
        // Limit exceeded
        if (errorLower.includes('limit') || errorLower.includes('maksim') ||
            errorLower.includes('maximum')) {
            return { type: BetErrorTypes.LIMIT_EXCEEDED, message: error, retryable: false };
        }
        
        // Invalid stake
        if (errorLower.includes('stake') || errorLower.includes('ulog') ||
            errorLower.includes('amount') || errorLower.includes('iznos') ||
            errorLower.includes('minimum') || errorLower.includes('minim')) {
            return { type: BetErrorTypes.INVALID_STAKE, message: error, retryable: false };
        }
        
        return { type: BetErrorTypes.UNKNOWN, message: error, retryable: false };
    }
    
    // ==================== ODDS VALIDATION ====================
    
    /**
     * Validate odds against expected value
     * @param {number} actual - Actual odds from bookmaker
     * @param {number} expected - Expected odds
     * @param {number} threshold - Max allowed difference (default 0.01)
     * @returns {{ valid: boolean, diff: number, error?: string }}
     */
    validateOdds(actual, expected, threshold = 0.01) {
        if (!actual || !expected) {
            return { valid: true, diff: 0 }; // Can't validate, assume OK
        }
        
        const diff = Math.abs(actual - expected);
        
        if (diff > threshold) {
            return {
                valid: false,
                diff,
                error: `Odds changed: expected ${expected}, got ${actual} (Δ${diff.toFixed(3)})`
            };
        }
        
        return { valid: true, diff };
    }
    
    // ==================== BALANCE VERIFICATION ====================
    
    /**
     * Wait for balance change to confirm bet placement
     * Polls balance every pollInterval ms up to maxWaitMs
     * @param {number} balanceBefore - Balance before bet
     * @param {number} expectedDiff - Expected decrease (stake amount)
     * @param {number} maxWaitMs - Maximum wait time (default 20000)
     * @param {number} pollInterval - Poll interval (default 2000)
     * @returns {Promise<{confirmed: boolean, diff: number, balanceAfter: number}>}
     */
    async waitForBalanceChange(balanceBefore, expectedDiff, maxWaitMs = 20000, pollInterval = 2000) {
        const tolerance = 0.10;
        const maxChecks = Math.ceil(maxWaitMs / pollInterval);
        
        for (let check = 1; check <= maxChecks; check++) {
            await new Promise(r => setTimeout(r, pollInterval));
            
            const balanceAfter = await this.getBalance();
            const diff = balanceBefore - balanceAfter;
            
            this.logger.log(`💰 Balance check ${check}/${maxChecks}: ${balanceAfter.toFixed(2)} EUR (diff: ${diff.toFixed(2)})`);
            
            if (balanceBefore > 0 && diff >= (expectedDiff - tolerance)) {
                return { confirmed: true, diff, balanceAfter };
            }
        }
        
        return { confirmed: false, diff: 0, balanceAfter: balanceBefore };
    }
    
    // ==================== COMMON PLACABET HELPERS ====================
    
    /**
     * Handle uncertain bet result (API returned OK but no confirmation)
     * @param {number} balanceBefore - Balance before bet
     * @param {number} stake - Bet stake
     * @param {Object} apiResponse - Original API response
     * @returns {Promise<Object>} Bet result with uncertain flag if needed
     */
    async handleUncertainResult(balanceBefore, stake, apiResponse = {}) {
        this.logger.log(`⚠️ No clear confirmation - waiting up to 20s for balance change...`);
        
        const result = await this.waitForBalanceChange(balanceBefore, stake, 20000);
        
        if (result.confirmed) {
            this.logger.log(`✅ Bet CONFIRMED via balance! Decreased by ${result.diff.toFixed(2)} EUR`);
            return {
                success: true,
                ticketId: 'confirmed_via_balance',
                confirmedViaBalance: true
            };
        }
        
        // Balance didn't change - uncertain result
        this.logger.log(`❌ Balance unchanged after 20s - result UNCERTAIN`);
        return {
            success: false,
            error: 'Bet not confirmed: balance unchanged after 20s',
            uncertain: true,
            apiResponse
        };
    }

    /**
     * Получить баланс аккаунта
     * @returns {Promise<number>} баланс
     */
    async getBalance() {
        throw new Error('getBalance() must be implemented by adapter');
    }

    /**
     * Закрыть соединение/браузер
     */
    async close() {
        // Override if needed (e.g., close Playwright browser)
    }

    /**
     * Получить ID спорта по названию
     * @param {string} sportName - название спорта
     * @returns {number} ID спорта
     */
    getSportId(sportName) {
        const sportMap = this.config.sportMap || {
            'soccer': 1,
            'football': 1,
            'tennis': 2,
            'basketball': 3
        };
        return sportMap[sportName.toLowerCase()] || 1;
    }

    /**
     * Нормализовать название команды для сравнения
     */
    normalizeName(name) {
        if (!name) return '';
        return name.toLowerCase()
            .replace(/\./g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Exact matching названий команд с нормализацией
     */
    exactNameMatch(name1, name2) {
        if (!name1 || !name2) return false;
        const n1 = this.normalizeName(name1);
        const n2 = this.normalizeName(name2);
        return n1 === n2;
    }

    // ==================== TEST MODE HELPERS ====================

    /**
     * Extract outcome type from analyzer outcome string
     * Returns: "T>" | "T<" | "H1" | "H2" | "1" | "X" | "2" | "IT1>" | "IT1<" | "IT2>" | "IT2<" | "P1T>" | etc
     */
    getOutcomeType(outcomeStr) {
        if (!outcomeStr) return 'unknown';
        const s = outcomeStr.trim();
        
        // Period-specific totals: P1T>2.5, P2T<3.5, P3T>...
        const periodTotalMatch = s.match(/^P(\d+)T([><])/);
        if (periodTotalMatch) return `P${periodTotalMatch[1]}T${periodTotalMatch[2]}`;
        
        // Period-specific team totals: P1IT1>2.5, P2IT2<3.5
        const periodTeamTotalMatch = s.match(/^P(\d+)IT(\d)([><])/);
        if (periodTeamTotalMatch) return `P${periodTeamTotalMatch[1]}IT${periodTeamTotalMatch[2]}${periodTeamTotalMatch[3]}`;
        
        // Period-specific handicaps: P1H1, P2H2
        const periodHcpMatch = s.match(/^P(\d+)H(\d)/);
        if (periodHcpMatch) return `P${periodHcpMatch[1]}H${periodHcpMatch[2]}`;
        
        // Team totals: IT1>2.5, IT2<3.5
        if (s.startsWith('IT1>')) return 'IT1>';
        if (s.startsWith('IT1<')) return 'IT1<';
        if (s.startsWith('IT2>')) return 'IT2>';
        if (s.startsWith('IT2<')) return 'IT2<';
        
        // Regular totals: T>2.5, T<3.5  
        if (s.startsWith('T>')) return 'T>';
        if (s.startsWith('T<')) return 'T<';
        
        // Handicaps: H1 -5.5, H2 3.5
        if (s.startsWith('H1')) return 'H1';
        if (s.startsWith('H2')) return 'H2';
        
        // 1X2
        if (s === '1' || s === 'X' || s === '2') return s;
        
        return 'other';
    }
    
    /**
     * Check if this outcome type was already used (for onePerOutcomeType mode)
     */
    isOutcomeTypeUsed(outcomeStr, sport = 'unknown') {
        if (!this.config.testMode?.onePerOutcomeType) return false;
        
        const type = this.getOutcomeType(outcomeStr);
        const key = `${sport}:${type}`;
        return this.usedOutcomeTypes.has(key);
    }
    
    /**
     * Mark outcome type as used after successful bet
     */
    markOutcomeTypeUsed(outcomeStr, sport = 'unknown') {
        if (!this.config.testMode?.onePerOutcomeType) return;
        
        const type = this.getOutcomeType(outcomeStr);
        const key = `${sport}:${type}`;
        this.usedOutcomeTypes.add(key);
        this.logger.log(`🧪 TEST MODE: Marked ${key} as used. Total types: ${this.usedOutcomeTypes.size}`);
    }
}

/**
 * Error types from bookmakers
 */
const BetErrorTypes = {
    SESSION_EXPIRED: 'session_expired',
    ODDS_CHANGED: 'odds_changed',
    SBV_CHANGED: 'sbv_changed',
    INSUFFICIENT_BALANCE: 'insufficient_balance',
    MATCH_CLOSED: 'match_closed',
    MARKET_SUSPENDED: 'market_suspended',
    LIMIT_EXCEEDED: 'limit_exceeded',
    INVALID_STAKE: 'invalid_stake',
    UNKNOWN: 'unknown'
};

module.exports = { BettorAdapter, BetErrorTypes };
