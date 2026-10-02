/**
 * SansabetV2Adapter — wraps the legacy bookmakers/sansabet/SansabetAdapter
 * to expose the v2 BookmakerAdapter contract.
 *
 * Catalog source: analyzer endpoints (:7005/match-data live, :7006/match-data
 * prematch). They are populated by the parse_sansabet container and reflect
 * "what Sansabet is actively trading right now". Faster and more accurate
 * than direct Sansabet API calls.
 *
 * submitBet path: legacyAdapter.placeBet(...) — keeps the proven Sansabet
 * login/cookie/HTTP logic intact.
 */
'use strict';

const http = require('http');
const { BookmakerAdapter } = require('../../../core/node/bookmakers/BookmakerAdapter.js');

const DEFAULT_LIVE_URL = 'http://127.0.0.1:7005/match-data';
const DEFAULT_PREMATCH_URL = 'http://127.0.0.1:7006/match-data';

const SPORT_NORMALIZE = {
    soccer: 'soccer', football: 'soccer', футбол: 'soccer',
    basketball: 'basketball', баскетбол: 'basketball',
    tennis: 'tennis', теннис: 'tennis',
    volleyball: 'volleyball', волейбол: 'volleyball',
    hockey: 'hockey', хоккей: 'hockey',
    handball: 'handball', гандбол: 'handball',
    esports: 'esports', киберспорт: 'esports', cybersport: 'esports',
};

function normSport(s) {
    if (!s) return 'unknown';
    const k = String(s).toLowerCase().trim();
    return SPORT_NORMALIZE[k] || 'unknown';
}

class SansabetV2Adapter extends BookmakerAdapter {
    /**
     * @param {Object} opts
     * @param {Object} opts.legacyAdapter        Existing SansabetAdapter (for placeBet & getMatchOdds).
     * @param {string} [opts.liveUrl]            Override analyzer live endpoint.
     * @param {string} [opts.prematchUrl]        Override analyzer prematch endpoint.
     * @param {number} [opts.catalogTimeoutMs]
     */
    constructor({ legacyAdapter, liveUrl, prematchUrl, catalogTimeoutMs, logger } = {}) {
        super({ logger });
        if (!legacyAdapter) throw new Error('SansabetV2Adapter requires legacyAdapter');
        this.legacyAdapter = legacyAdapter;
        this.liveUrl = liveUrl || DEFAULT_LIVE_URL;
        this.prematchUrl = prematchUrl || DEFAULT_PREMATCH_URL;
        this.catalogTimeoutMs = catalogTimeoutMs || 5000;
    }

    get bookmakerId() { return 'sansabet'; }

    async getCatalog(sport) {
        const wanted = sport && sport !== 'all' ? normSport(sport) : null;
        const [liveItems, prematchItems] = await Promise.all([
            this._loadAnalyzer(this.liveUrl, 'live'),
            this._loadAnalyzer(this.prematchUrl, 'prematch'),
        ]);
        let merged = liveItems.concat(prematchItems);
        if (wanted) merged = merged.filter((m) => m.sport === wanted);
        return merged;
    }

    async submitBet({ matchId, outcome, stake, match }) {
        if (!matchId) return this._failResult('no_match_id');
        if (!outcome) return this._failResult('no_outcome');

        // Hydrate match details if caller didn't pass full match object.
        let liveMatch = match;
        if (!liveMatch || !liveMatch.odds) {
            try { liveMatch = await this.legacyAdapter.findMatchByPID(matchId); } catch (_) {}
        }
        if (!liveMatch) {
            try {
                const odds = await this.legacyAdapter.getMatchOdds(matchId);
                if (odds) liveMatch = { Id: matchId, H: odds.H || {}, M: odds.M || [], odds, markets: odds.M || [] };
            } catch (_) {}
        }
        if (!liveMatch) return this._failResult('match_not_resolvable_on_bookmaker');

        const t0 = Date.now();
        let raw;
        try {
            raw = await this.legacyAdapter.placeBet({
                outcome,
                stake,
                match: liveMatch,
                task: { sourceType: 'telegram_v2' },
            });
        } catch (e) {
            return {
                ok: false, status: 'network_error',
                bookmakerMessage: e.message || String(e),
                designStopReason: null, oddsTaken: null,
                submittedAt: Date.now(),
            };
        }
        const ms = Date.now() - t0;
        const okFlag = raw && (raw.success === true || raw.ok === true);
        const msg = (raw && (raw.msg || raw.message || raw.error)) || '';
        const isDesignStop = /Maksimalna uplata/i.test(msg);

        return {
            ok: okFlag === true && !isDesignStop,
            status: isDesignStop ? 'design_stop' : (okFlag ? 'placed' : 'rejected'),
            bookmakerMessage: msg,
            designStopReason: isDesignStop ? msg : null,
            oddsTaken: raw?.oddsTaken || raw?.odds || null,
            submittedAt: t0,
            latencyMs: ms,
            raw,
        };
    }

    async getMatchOdds(matchId) {
        try { return await this.legacyAdapter.getMatchOdds(matchId); }
        catch (_) { return null; }
    }

    async getMatchStatus(matchId) {
        try {
            const details = await this.legacyAdapter.getMatchDetails(matchId);
            if (!details) return null;
            const ms = details.H?.MS || details.MS;
            const es = details.H?.ES || details.ES;
            const markets = details.M || details.markets || [];
            return {
                isFinished: ms === 'F' || es === 'C',
                isLive: ms === 'IP' || ms === 'LIVE' || details.isLive === true,
                marketCount: Array.isArray(markets) ? markets.length : 0,
                raw: details,
            };
        } catch (_) { return null; }
    }

    // ─── helpers ────────────────────────────────────────────────────────

    _failResult(reason) {
        return {
            ok: false, status: 'rejected',
            bookmakerMessage: reason, designStopReason: null,
            oddsTaken: null, submittedAt: Date.now(),
        };
    }

    async _loadAnalyzer(url, mode) {
        try {
            const data = await this._httpJson(url);
            const dict = data?.data || {};
            const out = [];
            for (const k of Object.keys(dict)) {
                const v = dict[k];
                if (!v || v.Source !== 'Sansabet') continue;
                const score = (v.HomeScore != null && v.AwayScore != null)
                    ? `${v.HomeScore}-${v.AwayScore}` : null;
                out.push({
                    matchId: String(v.MatchId),
                    sport: normSport(v.SportName),
                    home: v.homeName || '',
                    away: v.awayName || '',
                    league: v.LeagueName || null,
                    mode,
                    score,
                    isLive: v.isLive === true,
                    kickoffTs: null,
                    raw: null,  // skip raw to keep payload small
                });
            }
            return out;
        } catch (e) {
            if (this.logger?.log) this.logger.log(`⚠️ [SansabetV2] analyzer ${mode} failed: ${e.message}`);
            return [];
        }
    }

    _httpJson(url) {
        return new Promise((resolve, reject) => {
            const req = http.get(url, { timeout: this.catalogTimeoutMs }, (res) => {
                let buf = '';
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(buf)); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('timeout')); });
        });
    }
}

module.exports = { SansabetV2Adapter };
