/**
 * StabilityTracker - отслеживание стабильности ROI перед ставкой
 * 
 * ЛОГИКА (исправлена 2024-12-07, обновлена 2026-03-16):
 * - Время стабильности НАКАПЛИВАЕТСЯ только при получении реальных данных от анализатора
 * - Если outcome временно исчез из poll анализатора - tracker уходит в missing grace
 *   Во время grace: не ставим, но накопленное время сохраняем
 *   Если outcome вернулся в grace с валидным ROI - можно ставить сразу на этом тике
 * - Ставка возможна ТОЛЬКО когда накопленное время >= requiredDuration
 *   И последнее обновление было свежим (в момент вызова isStable)
 * 
 * СБРОС (разделённый):
 * - ROI < minROI → немедленный полный сброс (арб ушёл)
 * - Рынок закрыт (odds=0) но ROI был ОК → grace period (20с live / 200с prematch)
 *   Во время grace: заморозка (не накапливаем, не сбрасываем, не ставим)
 *   После grace: полный сброс
 * - Рынок вернулся до истечения grace → продолжаем с того же accumulated
 * 
 * Пример:
 *   00:00 - ROI >= 3%, accumulatedMs = 0
 *   00:02 - ROI >= 3%, +2 сек, accumulatedMs = 2000
 *   00:04 - ROI >= 3%, +2 сек, accumulatedMs = 4000
 *   00:06 - ROI >= 3%, +2 сек, accumulatedMs = 6000 >= 5000 → СТАБИЛЬНО!
 * 
 * Но если:
 *   00:00 - ROI >= 3%, accumulatedMs = 0
 *   00:02 - ROI >= 3%, +2 сек, accumulatedMs = 2000
 *   00:07 - ROI >= 3%, НО прошло 5 сек > 4 сек порог → СБРОС! accumulatedMs = 0
 */

class StabilityTracker {
    constructor(config = {}) {
        this.trackers = new Map();
        this.config = {
            fastDurationMs: (config.fast?.durationSeconds || 5) * 1000,
            slowDurationMs: (config.slow?.durationSeconds || 30) * 1000,
            singleDurationMs: (config.single?.durationSeconds || 5) * 1000,
            minROI: config.minROI ?? 3,  // Use ?? to allow 0
            highROI: config.highROI ?? 10,
            freshnessThreshold: config.freshnessThreshold || 4000, // max ms between updates before reset
            prematchFreshnessThreshold: config.prematchFreshnessThreshold || 120000, // 120s for prematch
            pinnacleMaxAge: config.pinnacleMaxAge || 15000, // 15 sec - relaxed, betslip verification is the real safety net
            prematchPinnacleMaxAge: config.prematchPinnacleMaxAge || 90000, // 90s for prematch
            marketClosedGraceLive: config.marketClosedGraceLive || 20000, // 20s grace before reset on market closed (live)
            marketClosedGracePrematch: config.marketClosedGracePrematch || 200000, // 200s grace for prematch
            missingPollGraceLive: config.missingPollGraceLive || 30000, // 30s grace if outcome disappears from analyzer poll
            missingPollGracePrematch: config.missingPollGracePrematch || 180000, // 3 min grace for prematch poll disappearance
            cleanupInterval: config.cleanupInterval || 30000,
            verbose: config.verbose || false
        };
        this.logger = config.logger || console;
    }

    /**
     * Создать ключ для tracker
     */
    makeKey(matchId, outcome, type = 'fast') {
        return `${matchId}_${outcome}_${type}`;
    }

    /**
     * Get duration for strategy type
     */
    _getDuration(type) {
        if (type === 'single') return this.config.singleDurationMs;
        return type === 'fast' ? this.config.fastDurationMs : this.config.slowDurationMs;
    }

    _getMissingPollGrace(isPrematchPair) {
        return isPrematchPair
            ? this.config.missingPollGracePrematch
            : this.config.missingPollGraceLive;
    }

    _resetTrackerState(tracker, now, roi) {
        tracker.firstSeenAt = now;
        tracker.lastGoodUpdateAt = null;
        tracker.accumulatedStabilityMs = 0;
        tracker.trackingActive = false;
        tracker.marketClosedSince = null;
        tracker.dataGapSince = null;
        tracker.missingFromPollSince = null;
        tracker.updateCount = 1;
        tracker.minROI = roi;
    }

    /**
     * Обновить или создать tracker для исхода
     * @param {Object} params
     * @param {string} params.matchId - ID матча
     * @param {string} params.outcome - строка исхода ("1", "T> 2.5", etc)
     * @param {number} params.roi - текущий ROI
     * @param {Object} params.pair - полные данные пары
     * @param {Object} params.outcomeData - полные данные исхода
     * @param {string} params.type - 'fast', 'slow' или 'single'
     * @param {boolean} params.allowLowROI - разрешить низкий ROI (fallback)
     * @param {number} params.minUpdates - минимум приходов от анализатора (default: 2)
     * @param {number} params.odds - текущие коэффициенты (0 = рынок закрыт)
     * @returns {Object} { isNew, tracker }
     */
    track({ matchId, outcome, roi, pair, outcomeData, type = 'fast', allowLowROI = false, minUpdates = 2, odds = null }) {
        const now = Date.now();
        const key = this.makeKey(matchId, outcome, type);
        const minROI = this.config.minROI;
        const isPrematchPair = pair && pair.isLive === false;
        const freshnessThreshold = isPrematchPair ? this.config.prematchFreshnessThreshold : this.config.freshnessThreshold;
        
        // Проверка на закрытый рынок (odds = 0 или null/undefined)
        const marketOpen = odds !== null && odds !== undefined && odds > 0;
        
        // CRITICAL: for real ROI tracking, only count ROI >= minROI AND market is open
        const roiMeetsThreshold = roi >= minROI && marketOpen;
        const requiredDuration = this._getDuration(type);

        let tracker = this.trackers.get(key);
        let isNew = false;

        if (!tracker) {
            // Новый tracker
            isNew = true;
            tracker = {
                key,
                type,
                matchId,
                outcome,
                firstSeenAt: now,
                lastSeenAt: now,
                lastGoodUpdateAt: roiMeetsThreshold ? now : null,  // Время последнего обновления с ROI >= порога
                accumulatedStabilityMs: 0,  // Накопленное время стабильности
                trackingActive: roiMeetsThreshold,
                marketClosedSince: null,  // grace period for temporarily closed markets
                dataGapSince: null,
                missingFromPollSince: null,
                minROI: roi,
                lastROI: roi,
                pair,
                outcomeData,
                betPlaced: false,
                allowLowROI,
                requiredDuration,
                updateCount: 1,
                minUpdates
            };
            this.trackers.set(key, tracker);
            // Silent until stability reached - no logging here
        } else {
            // Обновляем существующий
            const prevLastSeenAt = tracker.lastSeenAt;
            const prevLastGoodUpdateAt = tracker.lastGoodUpdateAt;
            const timeSinceLastUpdate = now - prevLastSeenAt;
            const wasMissingFromPoll = !!tracker.missingFromPollSince;
            const missingPollGrace = this._getMissingPollGrace(isPrematchPair);
            const missingPollMs = wasMissingFromPoll ? now - tracker.missingFromPollSince : 0;
            let restartedAfterMissingGrace = false;
            
            tracker.lastSeenAt = now;
            tracker.lastROI = roi;
            tracker.pair = pair;
            tracker.outcomeData = outcomeData;
            tracker.updateCount = (tracker.updateCount || 1) + 1;
            if (roi < tracker.minROI) tracker.minROI = roi;

            if (wasMissingFromPoll) {
                tracker.missingFromPollSince = null;
                tracker.dataGapSince = null;
                if (missingPollMs > missingPollGrace) {
                    this._resetTrackerState(tracker, now, roi);
                    restartedAfterMissingGrace = true;
                    if (this.config.verbose) {
                        this.logger.log(`⏹️ Missing-from-poll grace expired (${(missingPollMs/1000).toFixed(1)}s > ${missingPollGrace/1000}s) - RESET: ${outcome}`);
                    }
                } else if (this.config.verbose) {
                    this.logger.log(`▶️ Outcome returned from poll grace, resuming: ${outcome} (accumulated ${(tracker.accumulatedStabilityMs/1000).toFixed(1)}s)`);
                }
            }

            // FIX: если tracker пришёл через fallback путь (allowLowROI=true в параметрах)
            // но был создан как обычный (allowLowROI=false), нужно обновить флаг
            if (allowLowROI && !tracker.allowLowROI) {
                tracker.allowLowROI = true;
                // Silent demotion to fallback
            }

            // CRITICAL FIX: если ROI вырос выше порога - убираем флаг fallback
            if (tracker.allowLowROI && roiMeetsThreshold) {
                tracker.allowLowROI = false;
                if (this.config.verbose) {
                    this.logger.log(`🔄 Fallback promoted to VALUE BET: ${outcome} (ROI ${roi.toFixed(2)}% >= ${this.config.minROI}%)`);
                }
            }

            // НОВАЯ ЛОГИКА: накапливаем время стабильности ТОЛЬКО при получении данных
            if (roiMeetsThreshold) {
                // ROI >= порога И рынок открыт - проверяем можно ли добавить время
                // ВАЖНО: порядок условий критичен!
                const wasInGrace = !!tracker.marketClosedSince;
                tracker.marketClosedSince = null;  // рынок открыт — сбрасываем grace timer
                
                if (restartedAfterMissingGrace || !prevLastGoodUpdateAt) {
                    // 1. Первое обновление с хорошим ROI - начинаем отсчёт
                    tracker.trackingActive = true;
                    if (this.config.verbose) {
                        this.logger.log(`📈 ROI above threshold - tracking started: ${outcome} (${roi.toFixed(2)}%)`);
                    }
                } else if (wasMissingFromPoll) {
                    // 2. Outcome returned after disappearing from poll — preserve accumulated,
                    // do not add the missing time, but allow immediate bet on this fresh tick.
                    tracker.trackingActive = true;
                } else if (wasInGrace) {
                    // 3. Recovering from market-closed grace — resume without adding frozen time
                    tracker.trackingActive = true;
                    if (this.config.verbose) {
                        this.logger.log(`▶️ Market reopened from grace, resuming: ${outcome} (accumulated ${(tracker.accumulatedStabilityMs/1000).toFixed(1)}s)`);
                    }
                } else if (timeSinceLastUpdate > freshnessThreshold) {
                    // 4. Pause in data (between games, halftime) - FREEZE, not reset
                    // Only ROI < minROI resets (below). Data gaps just freeze accumulation.
                    if (!tracker.dataGapSince) {
                        tracker.dataGapSince = now;
                        if (this.config.verbose) {
                            this.logger.log(`⏸️ Data gap, freeze started: ${outcome} (accumulated ${(tracker.accumulatedStabilityMs/1000).toFixed(1)}s)`);
                        }
                    }
                    const gapMs = now - tracker.dataGapSince;
                    const maxGap = isPrematchPair ? 300000 : 60000; // 5min prematch, 60s live
                    
                    if (gapMs > maxGap) {
                        // Grace expired - FULL RESET
                        if (tracker.accumulatedStabilityMs > 0 && this.config.verbose) {
                            this.logger.log(`⏹️ Data gap grace expired (${(gapMs/1000).toFixed(1)}s > ${maxGap/1000}s) - RESET: ${outcome}`);
                        }
                        tracker.accumulatedStabilityMs = 0;
                        tracker.lastGoodUpdateAt = null;
                        tracker.trackingActive = false;
                        tracker.dataGapSince = null;
                    }
                    // else: frozen - do not accumulate, do not reset
                    tracker.trackingActive = true;
                } else {
                    // 5. Всё ОК - добавляем время между обновлениями
                    const timeSinceLastGood = now - prevLastGoodUpdateAt;
                    tracker.accumulatedStabilityMs += timeSinceLastGood;
                    tracker.trackingActive = true;
                    tracker.dataGapSince = null; // Clear gap freeze on good data
                    // Silent accumulation - no logging until stable
                }
                
                tracker.lastGoodUpdateAt = now;
            } else {
                // roiMeetsThreshold = false: ROI < minROI ИЛИ рынок закрыт (odds=0/null)
                const roiNegative = roi < minROI;

                if (roiNegative) {
                    // A) ROI ниже порога → НЕМЕДЛЕННЫЙ ПОЛНЫЙ СБРОС
                    tracker.accumulatedStabilityMs = 0;
                    tracker.lastGoodUpdateAt = null;
                    tracker.trackingActive = false;
                    tracker.marketClosedSince = null;
                    tracker.dataGapSince = null;
                } else {
                    // B) ROI >= minROI но рынок закрыт (odds=0/null/undefined)
                    // Grace period — не сбрасываем сразу, замораживаем
                    if (!tracker.marketClosedSince) {
                        tracker.marketClosedSince = now;
                        if (this.config.verbose) {
                            this.logger.log(`⏸️ Market closed, grace started: ${outcome} (accumulated ${(tracker.accumulatedStabilityMs/1000).toFixed(1)}s)`);
                        }
                    }
                    const closedMs = now - tracker.marketClosedSince;
                    const gracePeriod = isPrematchPair
                        ? this.config.marketClosedGracePrematch
                        : this.config.marketClosedGraceLive;

                    if (closedMs > gracePeriod) {
                        // Grace истёк → ПОЛНЫЙ СБРОС
                        if (tracker.accumulatedStabilityMs > 0 && this.config.verbose) {
                            this.logger.log(`⏹️ Market closed grace expired (${(closedMs/1000).toFixed(1)}s > ${gracePeriod/1000}s) - RESET: ${outcome}`);
                        }
                        tracker.accumulatedStabilityMs = 0;
                        tracker.lastGoodUpdateAt = null;
                        tracker.trackingActive = false;
                        tracker.marketClosedSince = null;
                    }
                    // else: заморозка — НЕ накапливаем, НЕ сбрасываем
                }
            }
        }

        return { isNew, tracker };
    }

    /**
     * Проверить готов ли tracker для ставки
     * 
     * ЛОГИКА (обновлено 2024-12-07):
     * - accumulatedStabilityMs >= requiredDuration (накопленное время из РЕАЛЬНЫХ обновлений)
     * - Последнее обновление было свежим (данные не устарели)
     * - ROI по-прежнему >= порога
     * - Достаточно обновлений (minUpdates)
     * - КРИТИЧНО: Цена Pinnacle (first) свежая < 3.5 сек
     * 
     * ВАЖНО: isStable() должен вызываться СРАЗУ после track() - когда пришли свежие данные.
     * Если вызвать позже - freshness проверка не пройдёт.
     */
    isStable(tracker) {
        if (!tracker || tracker.betPlaced) return false;
        // During market-closed grace period, never consider stable
        if (tracker.marketClosedSince) return false;
        if (tracker.missingFromPollSince) return false;

        const now = Date.now();
        const freshness = now - tracker.lastSeenAt;
        const roiMeetsThreshold = tracker.lastROI >= this.config.minROI;
        const updatesOk = (tracker.updateCount || 1) >= (tracker.minUpdates || 1);
        const accumulatedOk = tracker.accumulatedStabilityMs >= tracker.requiredDuration;
        const isPrematchPair = tracker.pair && tracker.pair.isLive === false;
        const freshnessThreshold = isPrematchPair ? this.config.prematchFreshnessThreshold : this.config.freshnessThreshold;
        const dataFresh = freshness <= freshnessThreshold;

        // КРИТИЧНО: Проверяем свежесть цены Pinnacle (first bookmaker)
        // Защита от suspended линий - если Pinnacle закрыл линию, цена не обновляется
        let pinnacleDataFresh = true;
        let pinnacleAge = 0;
        const maxPinnacleAge = isPrematchPair ? this.config.prematchPinnacleMaxAge : this.config.pinnacleMaxAge;
        if (tracker.pair?.first?.createdAt) {
            const pinnacleCreatedAt = new Date(tracker.pair.first.createdAt).getTime();
            pinnacleAge = now - pinnacleCreatedAt;
            pinnacleDataFresh = pinnacleAge <= maxPinnacleAge;
        }

        // Логируем ТОЛЬКО когда tracker был бы готов к ставке, но Pinnacle stale
        // Это реально важная информация (потерянная ставка), а не спам каждый poll
        const wouldBeStable = accumulatedOk && updatesOk && dataFresh && roiMeetsThreshold;
        if (wouldBeStable && !pinnacleDataFresh && this.config.verbose) {
            this.logger.log(`⚠️ READY but Pinnacle STALE (${(pinnacleAge/1000).toFixed(1)}s > ${maxPinnacleAge/1000}s): ${tracker.outcome} - waiting for fresh data`);
        }

        return wouldBeStable && pinnacleDataFresh;
    }

    /**
     * Получить все стабильные trackers готовые для ставки
     */
    getStableTrackers() {
        const stable = [];
        for (const tracker of this.trackers.values()) {
            if (this.isStable(tracker)) {
                stable.push(tracker);
            }
        }
        // Sort: prematch first (priority), then by ROI descending
        stable.sort((a, b) => {
            const aIsLive = a.pair?.isLive !== false;
            const bIsLive = b.pair?.isLive !== false;
            if (aIsLive !== bIsLive) return aIsLive ? 1 : -1; // prematch first
            return (b.lastROI || 0) - (a.lastROI || 0);
        });
        return stable;
    }

    /**
     * Отметить что ставка сделана
     */
    markBetPlaced(key) {
        const tracker = this.trackers.get(key);
        if (tracker) {
            tracker.betPlaced = true;
        }
    }

    /**
     * Получить tracker по ключу
     */
    get(key) {
        return this.trackers.get(key);
    }

    markMissingFromPoll(key, now = Date.now()) {
        const tracker = this.trackers.get(key);
        if (!tracker || tracker.betPlaced) return false;
        if (!tracker.missingFromPollSince) {
            tracker.missingFromPollSince = now;
            tracker.trackingActive = false;
            tracker.dataGapSince = null;
        }
        return true;
    }

    /**
     * Удалить старые trackers
     */
    cleanup(maxAge = 30000) {
        const now = Date.now();
        let removed = 0;
        for (const [key, tracker] of this.trackers.entries()) {
            const isPrematchPair = tracker.pair && tracker.pair.isLive === false;
            if (tracker.missingFromPollSince) {
                const missingGrace = this._getMissingPollGrace(isPrematchPair);
                if (now - tracker.missingFromPollSince > missingGrace) {
                    this.trackers.delete(key);
                    removed++;
                }
                continue;
            }
            if (now - tracker.lastSeenAt > maxAge) {
                this.trackers.delete(key);
                removed++;
            }
        }
        if (removed > 0 && this.config.verbose) {
            this.logger.log(`🧹 Cleaned up ${removed} stale trackers`);
        }
        return removed;
    }

    /**
     * Очистить все trackers
     */
    clear() {
        const count = this.trackers.size;
        this.trackers.clear();
        return count;
    }

    /**
     * Получить статистику
     */
    getStats() {
        let active = 0;
        let stable = 0;
        let placed = 0;

        for (const tracker of this.trackers.values()) {
            if (tracker.trackingActive) active++;
            if (this.isStable(tracker)) stable++;
            if (tracker.betPlaced) placed++;
        }

        return {
            total: this.trackers.size,
            active,
            stable,
            placed
        };
    }
}

module.exports = { StabilityTracker };
