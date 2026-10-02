/**
 * FreshDataManager - управление ожиданием свежих данных от analyzer
 * 
 * Используется для:
 * 1. Ожидания свежих данных перед submit ставки
 * 2. Retry логики при изменении коэффициентов
 */

class FreshDataManager {
    constructor(config = {}) {
        this.waiters = [];
        this.latestData = new Map(); // key -> { timestamp, roi, odds, ... }
        this.lastTimestamp = 0;
        this.analyzerAvailable = true;
        this.config = {
            defaultTimeout: config.defaultTimeout || 10000,
            maxDataAge: config.maxDataAge || 2000, // max acceptable data age
            verbose: config.verbose || false
        };
        this.logger = config.logger || console;
    }

    /**
     * Создать ключ для данных
     */
    makeKey(matchKey, outcome) {
        return `${matchKey}||${outcome}`;
    }

    /**
     * Обновить данные от analyzer
     * @param {Array} pairs - массив пар от analyzer
     * @param {number} timestamp - timestamp обновления
     */
    updateData(pairs, timestamp) {
        this.lastTimestamp = timestamp;
        
        for (const pair of pairs) {
            const matchKey = `${pair.first?.matchId}_${pair.second?.matchId}`;
            
            for (const outcome of (pair.outcome || [])) {
                const key = this.makeKey(matchKey, outcome.outcome);
                
                this.latestData.set(key, {
                    timestamp,
                    roi: outcome.roi,
                    // SAFETY: never fall back to Pinnacle odds (score1) — if donor odds are missing, return null
                    // This prevents false-positive ROI when donor market temporarily closes
                    odds: outcome.score2?.value || null,
                    score1: outcome.score1?.value,  // Pinnacle odds
                    score2: outcome.score2?.value,
                    score1Full: outcome.score1,  // полный объект {value, raw} для BetNum
                    score2Full: outcome.score2,  // полный объект {value, raw} для BetNum  // Target bookmaker odds
                    outcome,
                    pair,
                    matchKey
                });
            }
        }

        // Notify waiters
        this._notifyWaiters(pairs, timestamp);
    }

    /**
     * Уведомить ожидающих о новых данных
     */
    _notifyWaiters(pairs, timestamp) {
        if (this.waiters.length === 0) return;

        const notified = [];
        const remaining = [];

        for (const waiter of this.waiters) {
            // Check if we have fresh data for this waiter
            if (timestamp > waiter.startTimestamp) {
                const key = this.makeKey(waiter.matchKey, waiter.outcome);
                const data = this.latestData.get(key);
                
                if (data && data.timestamp > waiter.startTimestamp) {
                    clearTimeout(waiter.timeout);
                    waiter.resolve({
                        timestamp: data.timestamp,
                        outcome: data.outcome,
                        pair: data.pair,
                        roi: data.roi,
                        odds: data.odds
                    });
                    notified.push(waiter);
                } else {
                    remaining.push(waiter);
                }
            } else {
                remaining.push(waiter);
            }
        }

        this.waiters = remaining;

        if (notified.length > 0 && this.config.verbose) {
            this.logger.log(`📡 Notified ${notified.length} waiters with fresh data`);
        }
    }

    /**
     * Ожидать свежие данные для конкретного исхода
     * @param {Object} params
     * @param {string} params.matchKey - ключ матча
     * @param {string} params.outcome - строка исхода
     * @param {number} params.timeoutMs - timeout в ms
     * @returns {Promise<Object>} свежие данные
     */
    waitForFreshData({ matchKey, outcome, timeoutMs = null }) {
        const timeout = timeoutMs || this.config.defaultTimeout;

        if (!this.analyzerAvailable) {
            return Promise.reject(new Error('Analyzer offline'));
        }

        return new Promise((resolve, reject) => {
            const startTimestamp = this.lastTimestamp;

            const timeoutId = setTimeout(() => {
                const index = this.waiters.findIndex(w => w.resolve === resolve);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new Error(`Timeout waiting for fresh data (${timeout}ms)`));
            }, timeout);

            this.waiters.push({
                matchKey,
                outcome,
                startTimestamp,
                resolve,
                reject,
                timeout: timeoutId
            });
        });
    }

    /**
     * Получить последние данные для исхода (без ожидания)
     */
    getLatestData(matchKey, outcome) {
        const key = this.makeKey(matchKey, outcome);
        return this.latestData.get(key);
    }

    /**
     * Проверить свежесть данных
     */
    isDataFresh(matchKey, outcome) {
        const data = this.getLatestData(matchKey, outcome);
        if (!data) return false;
        return (Date.now() - data.timestamp) <= this.config.maxDataAge;
    }

    /**
     * Установить статус analyzer
     */
    setAnalyzerAvailable(available) {
        const wasAvailable = this.analyzerAvailable;
        this.analyzerAvailable = available;

        if (!wasAvailable && available) {
            this.logger.log('✅ Analyzer back online');
        } else if (wasAvailable && !available) {
            this.logger.log('⚠️ Analyzer offline');
            // Reject all waiters
            for (const waiter of this.waiters) {
                clearTimeout(waiter.timeout);
                waiter.reject(new Error('Analyzer went offline'));
            }
            this.waiters = [];
        }
    }

    /**
     * Очистить старые данные
     */
    cleanup(maxAge = 60000) {
        const now = Date.now();
        let removed = 0;
        for (const [key, data] of this.latestData.entries()) {
            if (now - data.timestamp > maxAge) {
                this.latestData.delete(key);
                removed++;
            }
        }
        return removed;
    }

    /**
     * Получить все исходы для матча с ROI >= minROI
     * @param {string} matchKey - ключ матча
     * @param {number} minROI - минимальный ROI (default 3)
     * @returns {Array} массив исходов отсортированных по ROI
     */
    getMatchOutcomes(matchKey, minROI = 3) {
        const outcomes = [];
        const prefix = `${matchKey}||`;
        
        for (const [key, data] of this.latestData.entries()) {
            if (key.startsWith(prefix) && data.roi >= minROI) {
                outcomes.push({
                    outcome: data.outcome?.outcome || key.split('||')[1],
                    roi: data.roi,
                    odds: data.odds,
                    timestamp: data.timestamp,
                    data
                });
            }
        }
        
        // Sort by lowest Pinnacle odds (score1) — safer bets first
        outcomes.sort((a, b) => (a.data?.score1 || 99) - (b.data?.score1 || 99));
        return outcomes;
    }

    /**
     * Ожидать любые свежие данные для матча (без фильтра по outcome)
     * @param {Object} params
     * @param {string} params.matchKey - ключ матча  
     * @param {number} params.timeoutMs - timeout в ms
     * @param {number} params.minROI - минимальный ROI
     * @returns {Promise<Object>} лучший исход или reject
     */
    waitForAnyFreshData({ matchKey, timeoutMs = 10000, minROI = 3 }) {
        if (!this.analyzerAvailable) {
            return Promise.reject(new Error('Analyzer offline'));
        }
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const checkInterval = 500; // Check every 500ms
            
            const check = () => {
                const outcomes = this.getMatchOutcomes(matchKey, minROI);
                const elapsed = Date.now() - startTime;
                
                // Look for fresh outcomes (updated after we started waiting)
                const fresh = outcomes.filter(o => o.timestamp > startTime);
                
                if (fresh.length > 0) {
                    resolve(fresh[0]); // Return best ROI
                } else if (elapsed >= timeoutMs) {
                    // Timeout - return current best if any
                    if (outcomes.length > 0) {
                        resolve(outcomes[0]);
                    } else {
                        reject(new Error(`No valid outcomes for match (timeout ${timeoutMs}ms)`));
                    }
                } else {
                    setTimeout(check, checkInterval);
                }
            };
            
            check();
        });
    }

    /**
     * Получить статистику
     */
    getStats() {
        return {
            dataEntries: this.latestData.size,
            pendingWaiters: this.waiters.length,
            lastTimestamp: this.lastTimestamp,
            analyzerAvailable: this.analyzerAvailable
        };
    }

    /**
     * Ожидать обновление данных по матчу от анализатора
     * 
     * Возвращает лучший исход (по ROI) для матча после получения свежих данных.
     * Если ROI всех исходов ниже minROI - возвращает null (ROI упал).
     * 
     * @param {Object} params
     * @param {string} params.matchKey - ключ матча
     * @param {number} params.minROI - минимальный ROI
     * @param {number} params.timeoutMs - timeout в ms (default 10000)
     * @returns {Promise<{bestOutcome: Object|null, allOutcomes: Array, roiDropped: boolean}>}
     */
    waitForMatchUpdate({ matchKey, minROI, timeoutMs = 10000, outcome = null }) {
        if (!this.analyzerAvailable) {
            return Promise.reject(new Error('Analyzer offline'));
        }

        return new Promise((resolve, reject) => {
            const startTimestamp = this.lastTimestamp;
            const startTime = Date.now();
            const checkInterval = 300;

            const check = () => {
                const elapsed = Date.now() - startTime;
                
                // Получаем все исходы для матча (без фильтра по ROI)
                const allOutcomes = this._getMatchOutcomesRaw(matchKey);
                
                // Проверяем есть ли свежие данные (обновлённые после начала ожидания)
                const freshOutcomes = allOutcomes.filter(o => o.timestamp > startTimestamp);
                
                if (freshOutcomes.length > 0) {
                    // Получили свежие данные - проверяем ROI
                    const goodOutcomes = freshOutcomes.filter(o => o.roi >= minROI);
                    
                    if (goodOutcomes.length === 0) {
                        // ROI упал по всем исходам
                        const bestRoi = freshOutcomes.length > 0 
                            ? Math.max(...freshOutcomes.map(o => o.roi))
                            : 0;
                        resolve({
                            bestOutcome: null,
                            allOutcomes: freshOutcomes,
                            roiDropped: true,
                            bestRoi,
                            pair: freshOutcomes[0]?.data?.pair  // CRITICAL: Include fresh pair!
                        });
                        return;
                    }
                    
                    // Sort by lowest Pinnacle odds (score1); if specific outcome requested, prefer it
                    goodOutcomes.sort((a, b) => (a.score1 || 99) - (b.score1 || 99));
                    let bestOutcome = goodOutcomes[0];
                    if (outcome) {
                        const ours = goodOutcomes.find(o => o.outcome === outcome);
                        if (ours) {
                            bestOutcome = ours; // Our outcome still valid — use it
                        }
                        // If not found, bestOutcome = highest ROI (switching)
                    }
                    resolve({
                        bestOutcome,
                        allOutcomes: freshOutcomes,
                        roiDropped: false,
                        pair: bestOutcome?.data?.pair  // CRITICAL: Include fresh pair with updated createdAt!
                    });
                    return;
                }
                
                // Timeout
                if (elapsed >= timeoutMs) {
                    reject(new Error(`Timeout waiting for match update (${timeoutMs}ms)`));
                    return;
                }
                
                // Продолжаем ждать
                setTimeout(check, checkInterval);
            };

            check();
        });
    }

    /**
     * Получить все исходы для матча (без фильтра по ROI)
     * @private
     */
    _getMatchOutcomesRaw(matchKey) {
        const outcomes = [];
        const prefix = `${matchKey}||`;
        
        for (const [key, data] of this.latestData.entries()) {
            if (key.startsWith(prefix)) {
                outcomes.push({
                    outcome: data.outcome?.outcome || key.split('||')[1],
                    roi: data.roi,
                    odds: data.odds,
                    score1: data.score1,
                    score2: data.score2,
                    score1Full: data.score1Full,
                    score2Full: data.score2Full,
                    timestamp: data.timestamp,
                    pair: data.pair,
                    data
                });
            }
        }
        
        return outcomes;
    }
}

module.exports = { FreshDataManager };
