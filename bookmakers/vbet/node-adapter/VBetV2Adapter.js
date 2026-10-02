'use strict';

const { BookmakerAdapter } = require('../../../core/node/bookmakers/BookmakerAdapter.js');

class VBetV2Adapter extends BookmakerAdapter {
    constructor({ legacyAdapter, logger } = {}) {
        super({ logger });
        if (!legacyAdapter) throw new Error('VBetV2Adapter requires legacyAdapter');
        this.legacyAdapter = legacyAdapter;
    }

    get bookmakerId() { return 'vbet'; }

    async getCatalog(sport) {
        return this.legacyAdapter.getCatalog(sport);
    }

    async getMatchOdds(matchId) {
        try {
            return await this.legacyAdapter.getMatchOdds(matchId);
        } catch (_) {
            return null;
        }
    }

    async getMatchStatus(matchId) {
        try {
            const details = await this.legacyAdapter.getMatchDetails(matchId);
            if (!details) return null;
            const markets = details.M || details.markets || [];
            return {
                isFinished: false,
                isLive: details.isLive === true || details.H?.isLive === true,
                marketCount: Array.isArray(markets) ? markets.length : 0,
                raw: details,
            };
        } catch (_) {
            return null;
        }
    }

    async submitBet({ matchId, outcome, stake, match }) {
        if (!matchId) return this._fail('no_match_id');
        if (!outcome) return this._fail('no_outcome');

        let liveMatch = match;
        try {
            if (!liveMatch || !Array.isArray(liveMatch.M || liveMatch.markets)) {
                liveMatch = await this.legacyAdapter.getMatchDetails(matchId);
            }
            const selection = this.legacyAdapter.findOutcome(liveMatch, outcome);
            if (!selection) return this._fail('outcome_not_found');
            const raw = await this.legacyAdapter.placeBet({ outcome: selection, stake, match: liveMatch });
            return {
                ok: raw?.success === true,
                status: raw?.success === true ? 'placed' : 'rejected',
                bookmakerMessage: raw?.error || raw?.msg || raw?.message || '',
                designStopReason: raw?.realSubmitDisabled ? raw.error : null,
                oddsTaken: selection.oddVal || null,
                submittedAt: Date.now(),
                raw,
            };
        } catch (error) {
            return {
                ok: false,
                status: 'network_error',
                bookmakerMessage: error.message || String(error),
                designStopReason: null,
                oddsTaken: null,
                submittedAt: Date.now(),
            };
        }
    }

    _fail(reason) {
        return {
            ok: false,
            status: 'rejected',
            bookmakerMessage: reason,
            designStopReason: null,
            oddsTaken: null,
            submittedAt: Date.now(),
        };
    }
}

module.exports = { VBetV2Adapter };
