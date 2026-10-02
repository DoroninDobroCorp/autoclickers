/**
 * TaskBuilder - создание task объекта из стабильного трекера
 * Выделен из BaseBettor для уменьшения God class
 */

class TaskBuilder {
    constructor(options = {}) {
        this.bookmakerName = options.bookmakerName || 'Unknown';
        this.isPrematch = options.isPrematch || false;
    }

    /**
     * Создать task из трекера
     * @param {Object} tracker - стабильный трекер от StabilityTracker
     * @param {Object} options - дополнительные опции
     * @returns {Object} task объект для BetProcessor
     */
    build(tracker, options = {}) {
        const { pair, outcomeData, type } = tracker;
        const { stake, isHighROI, home, away, ourSide, expectedOdds } = options;
        
        // Match keys (include matchDate from Pinnacle for cross-mode dedup)
        const matchDate = pair.first?.matchDate || null;
        const normalizedMatchKey = this._generateMatchKey(
            pair.first?.homeName || home, 
            pair.first?.awayName || away,
            matchDate
        );
        const freshDataMatchKey = tracker.matchId;
        
        // Odds
        const pinnacleOdds = outcomeData.score1?.value;
        const bookmakerOdds = outcomeData.score2?.value;
        
        // Margin: convert from multiplier (1.025) to percentage (2.5%)
        const margin = outcomeData.margin 
            ? ((outcomeData.margin - 1) * 100)
            : null;

        return {
            id: Date.now() + Math.random(),
            bookmakerId: this.bookmakerName.toLowerCase(),
            bookmaker: this.bookmakerName.replace('_Prematch', ''),
            isPrematch: pair.isLive === false,
            
            // Keys
            matchKey: normalizedMatchKey,
            freshDataMatchKey,
            bookmakerMatchId: ourSide.matchId,
            matchDate: matchDate || null,
            
            // Names
            homeName: pair.first?.homeName || home,
            awayName: pair.first?.awayName || away,
            home,
            away,
            
            // Bet info
            outcome: tracker.outcome,
            expectedROI: tracker.lastROI,
            expectedOdds,
            pinnacleOdds,
            bookmakerOdds,
            margin,
            stake,
            
            // Meta
            sport: pair.sportName || 'Unknown',
            league: ourSide.leagueName || pair.first?.leagueName || 'Unknown',
            bookmakers: `${pair.first?.bookmaker || 'Pinnacle'} vs ${pair.second?.bookmaker || this.bookmakerName}`,
            source: `analyzer_${type}${isHighROI ? '_high' : ''}`,
            sourceType: 'analyzer',
            sourceVariant: type,
            sourceProfileId: null,
            createdAt: Date.now(),
            type,
            
            // Bookmaker side identification (computed once, used everywhere)
            isFirstOurs: (pair.first?.bookmaker || '').toLowerCase() === this.bookmakerName.replace('_Prematch', '').toLowerCase(),
            
            // Full data for Calculator
            pair,
            pairFull: {
                first: pair.first,
                second: pair.second,
                outcome: outcomeData,
                sportName: pair.sportName || 'Unknown',
                isLive: pair.isLive !== undefined ? pair.isLive : true
            },
            outcomeData,
            pinnacleBestSource: outcomeData?.pinnacleBestSource || null,
            pinnacleStdOdds: outcomeData?.pinnacleStdOdds || null,
            pinnacleSources: outcomeData?.pinnacleSources || null,
            fallback: tracker.allowLowROI || false
        };
    }

    _generateMatchKey(home, away, matchDate) {
        const normalize = (str) => (str || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .substring(0, 20);
        const base = `${normalize(home)}_${normalize(away)}`;
        // Import-free date extraction (same logic as LimitsManager._extractDatePart)
        if (matchDate && typeof matchDate === 'string' && !matchDate.startsWith('0001-01-01')) {
            try {
                const d = new Date(matchDate);
                if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
                    const y = d.getUTCFullYear();
                    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(d.getUTCDate()).padStart(2, '0');
                    return `${base}_${y}${m}${day}`;
                }
            } catch { /* fallback */ }
        }
        return base;
    }
}

module.exports = { TaskBuilder };
