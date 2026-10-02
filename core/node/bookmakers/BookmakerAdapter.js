/**
 * BookmakerAdapter — base contract for any bookmaker plugin.
 *
 * v2 architecture: adding a new bookmaker = subclass this, register in
 * config.bookmakers.json, no other pipeline changes needed.
 *
 * Required:
 *   getCatalog(sport)             → Promise<NormalizedMatch[]>
 *   submitBet({ matchId, outcome, stake })
 *                                → Promise<SubmitResult>
 * Optional:
 *   getMatchOdds(matchId)         → Promise<MarketsObject|null>
 *   getMatchStatus(matchId)       → Promise<{ isFinished, isLive, marketCount }|null>
 *
 * NormalizedMatch:
 *   {
 *     matchId:   string,    // bookmaker-internal id
 *     sport:     'soccer'|'basketball'|...|'unknown',
 *     home:      string,
 *     away:      string,
 *     league:    string|null,
 *     mode:      'live'|'prematch',
 *     score:     string|null,    // 'X-Y'
 *     isLive:    boolean,
 *     kickoffTs: number|null,    // epoch ms, optional
 *     raw:       object|null,    // bookmaker raw record
 *   }
 *
 * SubmitResult:
 *   {
 *     ok:                 boolean,
 *     status:             'placed'|'rejected'|'design_stop'|'network_error'|'unknown',
 *     bookmakerMessage:   string,         // raw bookmaker response message
 *     designStopReason:   string|null,    // e.g. "Maksimalna uplata 5 EUR"
 *     oddsTaken:          number|null,
 *     submittedAt:        number,
 *   }
 */
'use strict';

class BookmakerAdapter {
    /** @param {Object} opts.logger */
    constructor({ logger } = {}) {
        this.logger = logger || console;
    }

    /** Bookmaker name, e.g. 'sansabet'. */
    get bookmakerId() { throw new Error('bookmakerId must be overridden'); }

    /**
     * @param {string|null} sport  'soccer'|'basketball'|...|null|'all'
     * @returns {Promise<NormalizedMatch[]>}
     */
    async getCatalog(_sport) { throw new Error('getCatalog must be implemented'); }

    /**
     * @param {Object} input
     * @param {string} input.matchId
     * @param {string} input.outcome   normalized outcome label (e.g. 'T> 2.5')
     * @param {number} input.stake     EUR
     * @param {Object} [input.match]   optional full NormalizedMatch the locator picked
     * @returns {Promise<SubmitResult>}
     */
    async submitBet(_input) { throw new Error('submitBet must be implemented'); }

    /** Optional. Returns markets object (raw bookmaker shape) or null. */
    async getMatchOdds(_matchId) { return null; }

    /** Optional. Returns { isFinished, isLive, marketCount } or null. */
    async getMatchStatus(_matchId) { return null; }
}

module.exports = { BookmakerAdapter };
