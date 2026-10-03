'use strict';

const { BettorAdapter, BetErrorTypes } = require('../../../core/node/betting/BettorAdapter');
const { OutcomeParser } = require('../../../core/node/parsers/outcome-parser');
const { BetfairClient } = require('./BetfairClient');

const SPORT_ALIASES = {
    soccer: 'soccer',
    football: 'soccer',
    futbol: 'soccer',
    basketball: 'basketball',
    basket: 'basketball',
    tennis: 'tennis',
    volleyball: 'volleyball',
    handball: 'handball',
    hockey: 'hockey',
    icehockey: 'hockey',
    ice_hockey: 'hockey',
    esports: 'esports',
    esport: 'esports',
};

const BETFAIR_EVENT_TYPE_IDS = {
    soccer: '1',
    tennis: '2',
    golf: '3',
    cricket: '4',
    rugby_union: '5',
    boxing: '6',
    horse_racing: '7',
    motor_sport: '8',
    special_bets: '10',
    cycling: '11',
    rugby_league: '1477',
    darts: '3503',
    athletics: '3988',
    snooker: '6422',
    american_football: '6423',
    baseball: '7511',
    basketball: '7522',
    ice_hockey: '7524',
    hockey: '7524',
    volleyball: '998917',
    handball: '468328',
};

const DEFAULT_CATALOG_SPORTS = ['soccer', 'basketball', 'tennis', 'volleyball', 'handball', 'hockey'];

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function normalizeSport(value) {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s.-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    return SPORT_ALIASES[key] || SPORT_ALIASES[key.replace(/_/g, '')] || (key || 'unknown');
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\u2019'`]/g, '')
        .replace(/[^a-zа-яіїєґ0-9]+/gi, ' ')
        .replace(/\b(fc|cf|sc|afc|bc|u19|u20|u21|women|w)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nearlyEqual(left, right, tolerance = 0.001) {
    const a = toNumber(left);
    const b = toNumber(right);
    return a !== null && b !== null && Math.abs(a - b) <= tolerance;
}

function upper(value) {
    return String(value || '').trim().toUpperCase();
}

function lower(value) {
    return String(value || '').trim().toLowerCase();
}

function makeNumericId(value) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

class BetfairAdapter extends BettorAdapter {
    constructor(config = {}) {
        super(config);
        this.bookmakerName = config.bookmakerName || 'Betfair';
        this.bookmakerId = 'betfair';
        this.currency = config.currency || 'EUR';
        this.clientFactory = config.clientFactory || ((options) => new BetfairClient(options));
        this.client = config.client || null;
        this._catalogCache = new Map();
        this._catalogCacheTtlMs = Number(config.catalogCacheTtlMs || 5000);
        this._lastLoginError = null;
    }

    async login() {
        try {
            const client = await this._ensureClient();
            await client.login({ ...this._getCredentials(), forceRefresh: this._lastSessionInvalid === true });
            this.isLoggedIn = true;
            this._lastSessionInvalid = false;
            this._lastLoginError = null;
            return true;
        } catch (error) {
            this.isLoggedIn = false;
            this._lastLoginError = error.message;
            this.logger?.log?.(`Betfair login failed: ${error.message}`);
            return false;
        }
    }

    async isSessionValid() {
        try {
            const client = await this._ensureClient();
            await client.keepAlive();
            this._lastSessionInvalid = false;
            return true;
        } catch (error) {
            if (/session|token|auth|login|invalid_session/i.test(error.message || String(error))) {
                this._lastSessionInvalid = true;
            }
            return false;
        }
    }

    async getBalance() {
        const client = await this._ensureClient({ login: true });
        const funds = await client.getAccountFunds({});
        const balance = toNumber(funds.availableToBetBalance);
        if (!Number.isFinite(balance)) {
            throw new Error('Betfair balance was not found in getAccountFunds response');
        }
        return balance;
    }

    getSportId(sportName) {
        const sport = normalizeSport(sportName);
        return BETFAIR_EVENT_TYPE_IDS[sport] || BETFAIR_EVENT_TYPE_IDS.soccer;
    }

    async getCatalog(sport = 'all') {
        const sports = this._resolveCatalogSports(sport);
        const modes = this.config.catalogModes || ['live', 'prematch'];
        const tasks = [];
        for (const sportName of sports) {
            for (const mode of modes) {
                tasks.push(this._getCatalogForSportMode(sportName, mode));
            }
        }

        const settled = await Promise.allSettled(tasks);
        const matches = [];
        const failures = [];
        for (const item of settled) {
            if (item.status === 'fulfilled') {
                matches.push(...item.value);
            } else {
                failures.push(item.reason);
                this.logger?.log?.(`Betfair catalog segment failed: ${item.reason?.message || item.reason}`);
            }
        }
        if (tasks.length > 0 && failures.length === tasks.length) {
            const first = failures[0];
            throw new Error(`Betfair catalog unavailable: ${first?.message || first}`);
        }

        const seen = new Set();
        return matches.filter((match) => {
            const key = `${match.matchId}:${match.mode}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    async getMatches(sportId = 'all') {
        const sport = this._sportFromEventTypeId(sportId);
        const catalog = await this.getCatalog(sport || sportId || 'all');
        return catalog.map((match) => this._toLegacyMatch(match));
    }

    async getLiveMatches() {
        const previousModes = this.config.catalogModes;
        this.config.catalogModes = ['live'];
        try {
            return (await this.getCatalog('all')).map((match) => this._toLegacyMatch(match));
        } finally {
            this.config.catalogModes = previousModes;
        }
    }

    async getPrematchMatches(sportId = 'all') {
        const previousModes = this.config.catalogModes;
        this.config.catalogModes = ['prematch'];
        try {
            const sport = this._sportFromEventTypeId(sportId);
            return (await this.getCatalog(sport || sportId || 'all')).map((match) => this._toLegacyMatch(match));
        } finally {
            this.config.catalogModes = previousModes;
        }
    }

    async getMatchOdds(matchId) {
        const details = await this.getMatchDetails(matchId);
        if (!details || !details.H) return null;
        return { H: details.H, M: details.M || [] };
    }

    async getMatchDetails(matchId, sportName = null) {
        const client = await this._ensureClient({ login: true });
        const rawId = this._stripMatchId(matchId);
        const filter = rawId.includes('.')
            ? { marketIds: [rawId] }
            : { eventIds: [rawId] };
        const maxResults = String(this.config.detailMaxResults || 200);
        const catalogue = await client.listMarketCatalogue({
            filter,
            marketProjection: ['EVENT', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME', 'MARKET_DESCRIPTION'],
            sort: 'FIRST_TO_START',
            maxResults,
        });
        const markets = Array.isArray(catalogue) ? catalogue : [];
        if (markets.length === 0) return {};

        const marketBooks = await this._getMarketBooks(markets.map((market) => market.marketId).filter(Boolean));
        const booksByMarketId = new Map(marketBooks.map((book) => [String(book.marketId), book]));
        const first = markets[0];
        const event = first.event || {};
        const names = this._splitEventName(event.name || '');
        const sport = normalizeSport(sportName || this._sportFromEventTypeId(first.eventType?.id) || this.config.defaultSport || 'unknown');
        const isLive = markets.some((market) => market.description?.inPlay === true || booksByMarketId.get(String(market.marketId))?.inplay === true);
        const header = {
            PID: makeNumericId(event.id || rawId),
            Sifra: makeNumericId(event.id || rawId),
            ParNaziv: `${names.home}: ${names.away}`,
            TeamHome: names.home,
            TeamAway: names.away,
            LN: first.competition?.name || null,
            SID: sport,
            MS: isLive ? 'LIVE' : 'NSY',
            isLive,
            marketcounter: markets.length,
        };

        const normalizedMarkets = markets
            .map((market) => this._normalizeMarket(market, booksByMarketId.get(String(market.marketId)), header))
            .filter((market) => market.S.length > 0);

        return {
            id: header.PID,
            Id: header.PID,
            matchId: String(event.id || rawId),
            home: names.home,
            away: names.away,
            sport,
            league: header.LN,
            isLive,
            H: header,
            M: normalizedMarkets,
            odds: { H: header, M: normalizedMarkets },
            markets: normalizedMarkets,
            raw: {
                event,
                catalogue: markets,
                marketBooks,
            },
        };
    }

    findMatch(matches = [], home, away, bookmakerMatchId = null) {
        const list = Array.isArray(matches) ? matches : [];
        if (bookmakerMatchId) {
            const exact = list.find((match) => {
                const ids = [
                    match.Id,
                    match.id,
                    match.matchId,
                    match.H?.PID,
                    match.raw?.eventId,
                    match.raw?.event?.id,
                    match.raw?.matchOddsMarketId,
                ].filter((value) => value !== undefined && value !== null);
                return ids.some((id) => String(id) === String(bookmakerMatchId));
            });
            if (exact) return exact;
        }

        const wantedHome = normalizeName(home);
        const wantedAway = normalizeName(away);
        let best = null;
        let bestScore = 0;
        for (const match of list) {
            const candidateHome = normalizeName(match.home || match.TeamHome || match.H?.TeamHome || '');
            const candidateAway = normalizeName(match.away || match.TeamAway || match.H?.TeamAway || '');
            const directScore = this._pairScore(wantedHome, wantedAway, candidateHome, candidateAway);
            const reverseScore = this._pairScore(wantedHome, wantedAway, candidateAway, candidateHome) - 1;
            const score = Math.max(directScore, reverseScore);
            if (score > bestScore) {
                best = match;
                bestScore = score;
            }
        }
        return bestScore >= 6 ? best : null;
    }

    findOutcome(match, outcomeStr, expectedOdds = null) {
        const rawExchange = typeof outcomeStr === 'object' ? outcomeStr.raw || outcomeStr : null;
        if (rawExchange?.marketId && rawExchange?.selectionId) {
            return this._selectionFromRawExchange(match, rawExchange, outcomeStr.pick || outcomeStr.outcome || 'exchange_selection');
        }

        const parsed = OutcomeParser.parse({ outcome: String(outcomeStr || '') });
        if (!parsed) {
            this.logger?.log?.(`Betfair outcome parse failed: ${outcomeStr}`);
            return null;
        }

        const target = match?.odds || match || {};
        const markets = target.M || target.markets || match?.markets || [];
        const found = this._findParsedOutcome(markets, parsed, expectedOdds);
        if (!found) {
            this.logger?.log?.(`Betfair selection not found for ${outcomeStr}`);
            return null;
        }

        return {
            selectionId: found.selection.N,
            marketId: found.market.marketId,
            oddVal: found.selection.O,
            sbv: found.line,
            handicap: found.selection.handicap ?? found.line ?? undefined,
            side: 'BACK',
            pick: outcomeStr,
            market: found.market,
            selection: found.selection,
            raw: {
                marketId: found.market.marketId,
                selectionId: found.selection.N,
                handicap: found.selection.handicap ?? found.line ?? undefined,
                marketType: found.market.type,
                runnerName: found.selection.name,
            },
        };
    }

    async prepareBet() {
        try {
            await this.getBalance();
        } catch (error) {
            this.logger?.log?.(`Betfair prepareBet balance check failed: ${error.message}`);
        }
    }

    async placeBet({ outcome, stake }) {
        if (!outcome?.marketId || !outcome?.selectionId) {
            return {
                success: false,
                error: 'Betfair outcome is missing marketId/selectionId',
                failureStage: 'adapter_validation',
            };
        }

        const price = toNumber(outcome.oddVal);
        const size = toNumber(stake);
        if (!Number.isFinite(price) || price <= 1 || !Number.isFinite(size) || size <= 0) {
            return {
                success: false,
                error: `Betfair invalid bet payload price=${price} stake=${size}`,
                failureStage: 'adapter_validation',
            };
        }

        const payload = this._buildPlaceOrdersPayload(outcome, size, price);
        const allowRealSubmit = this.config.allowRealSubmit === true || process.env.BETFAIR_ALLOW_REAL_SUBMIT === '1';
        if (!allowRealSubmit) {
            return {
                success: false,
                error: 'Betfair real submit disabled (set BETFAIR_ALLOW_REAL_SUBMIT=1 only after manual validation)',
                realSubmitDisabled: true,
                failureStage: 'design_stop',
                submitReached: false,
                orderPayload: payload,
            };
        }

        const client = await this._ensureClient({ login: true });
        let response;
        try {
            response = await client.placeOrders(payload);
        } catch (error) {
            return {
                success: false,
                error: error.message || String(error),
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: error.response || error.data || null,
            };
        }
        return this._normalizePlaceOrdersResponse(response, outcome, size);
    }

    parseError(response = {}) {
        const raw = response.raw || response.response || response || {};
        const instructionError = raw.instructionReports?.[0]?.errorCode;
        const message = response.error ||
            response.msg ||
            response.message ||
            raw.errorCode ||
            instructionError ||
            JSON.stringify(raw);
        const normalized = lower(message);
        if (/insufficient.*fund|insufficient_funds|exposure.*limit|balance/.test(normalized)) {
            return { type: BetErrorTypes.INSUFFICIENT_BALANCE, message, retryable: false };
        }
        if (/invalid.*session|no_session|session.*expired|auth|login|token/.test(normalized)) {
            return { type: BetErrorTypes.SESSION_EXPIRED, message, retryable: true };
        }
        if (/market.*suspend|market_suspended|market.*closed|market.*not.*open|event.*closed/.test(normalized)) {
            return { type: BetErrorTypes.MATCH_CLOSED, message, retryable: false };
        }
        if (/bet_taken_or_lapsed|invalid_odds|price|odds/.test(normalized)) {
            return { type: BetErrorTypes.ODDS_CHANGED, message, retryable: true };
        }
        if (/minimum.*stake|invalid.*size|size|stake/.test(normalized)) {
            return { type: BetErrorTypes.INVALID_STAKE, message, retryable: false };
        }
        return super.parseError(response);
    }

    async close() {
        if (this.client && typeof this.client.close === 'function') {
            await this.client.close();
        }
        this.client = null;
        this.isLoggedIn = false;
    }

    async _ensureClient(options = {}) {
        if (!this.client) {
            this.client = this.clientFactory({
                appKey: this.config.appKey || process.env.BETFAIR_APP_KEY,
                sessionToken: this.config.sessionToken || process.env.BETFAIR_SESSION_TOKEN,
                proxyUrl: this.config.proxyUrl || this.config.proxy || process.env.BETFAIR_PROXY,
                proxyProtocol: this.config.proxyProtocol || process.env.BETFAIR_PROXY_PROTOCOL,
                bettingEndpoint: this.config.bettingEndpoint,
                accountEndpoint: this.config.accountEndpoint,
                loginEndpoint: this.config.loginEndpoint,
                keepAliveEndpoint: this.config.keepAliveEndpoint,
                appConfigUrl: this.config.appConfigUrl,
                autoDiscoverAppKey: this.config.autoDiscoverAppKey,
                userAgent: this.config.userAgent,
                requestTimeoutMs: this.config.requestTimeoutMs || this.config.httpTimeoutMs,
                fetchImpl: this.config.fetchImpl,
                dispatcher: this.config.dispatcher,
                logger: this.logger,
            });
        }
        if (options.login && !this.client.sessionToken) {
            await this.client.login(this._getCredentials());
            this.isLoggedIn = true;
        }
        return this.client;
    }

    _getCredentials() {
        return {
            username: this.config.credentials?.username || process.env.BETFAIR_USERNAME || '',
            password: this.config.credentials?.password || process.env.BETFAIR_PASSWORD || '',
        };
    }

    _resolveCatalogSports(sport) {
        const requested = String(sport || 'all').trim().toLowerCase();
        if (!requested || requested === 'all' || requested === '*') {
            return (this.config.catalogSports || DEFAULT_CATALOG_SPORTS).map(normalizeSport).filter((item) => BETFAIR_EVENT_TYPE_IDS[item]);
        }
        const byId = this._sportFromEventTypeId(sport);
        const normalized = normalizeSport(byId || sport);
        return BETFAIR_EVENT_TYPE_IDS[normalized] ? [normalized] : [];
    }

    _sportFromEventTypeId(value) {
        const id = String(value || '');
        return Object.keys(BETFAIR_EVENT_TYPE_IDS).find((sport) => BETFAIR_EVENT_TYPE_IDS[sport] === id) || null;
    }

    async _getCatalogForSportMode(sport, mode) {
        const key = `${sport}:${mode}`;
        const cached = this._catalogCache.get(key);
        if (cached && Date.now() - cached.at <= this._catalogCacheTtlMs) {
            return cached.matches;
        }

        const client = await this._ensureClient({ login: true });
        const now = new Date();
        const to = new Date(now.getTime() + Number(this.config.catalogDaysAhead || 3) * 24 * 60 * 60 * 1000);
        const filter = {
            eventTypeIds: [BETFAIR_EVENT_TYPE_IDS[sport]],
            marketTypeCodes: ['MATCH_ODDS'],
            inPlayOnly: mode === 'live',
        };
        if (mode !== 'live') {
            filter.marketStartTime = {
                from: now.toISOString(),
                to: to.toISOString(),
            };
        }
        if (Array.isArray(this.config.marketCountries) && this.config.marketCountries.length > 0) {
            filter.marketCountries = this.config.marketCountries;
        }

        const catalogue = await client.listMarketCatalogue({
            filter,
            marketProjection: ['EVENT', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME', 'MARKET_DESCRIPTION'],
            sort: mode === 'live' ? 'MAXIMUM_TRADED' : 'FIRST_TO_START',
            maxResults: String(this.config.catalogMaxResults || 100),
        });
        const matches = (Array.isArray(catalogue) ? catalogue : [])
            .map((market) => this._normalizeCatalogMatch(market, sport, mode))
            .filter(Boolean);
        this._catalogCache.set(key, { at: Date.now(), matches });
        return matches;
    }

    async _getMarketBooks(marketIds) {
        const client = await this._ensureClient({ login: true });
        const out = [];
        for (const batch of chunk(marketIds, Number(this.config.marketBookBatchSize || 40))) {
            if (batch.length === 0) continue;
            const books = await client.listMarketBook({
                marketIds: batch,
                priceProjection: {
                    priceData: ['EX_BEST_OFFERS'],
                    exBestOffersOverrides: {
                        bestPricesDepth: 1,
                    },
                },
            });
            if (Array.isArray(books)) out.push(...books);
        }
        return out;
    }

    _normalizeCatalogMatch(market, sport, fallbackMode) {
        const event = market.event || {};
        if (!event.id || !event.name) return null;
        const names = this._splitEventName(event.name);
        if (!names.home || !names.away) return null;
        const isLive = fallbackMode === 'live' || market.description?.inPlay === true;
        return {
            matchId: String(event.id),
            sport,
            home: names.home,
            away: names.away,
            league: market.competition?.name || null,
            mode: isLive ? 'live' : fallbackMode || 'prematch',
            score: null,
            isLive,
            kickoffTs: market.marketStartTime ? Date.parse(market.marketStartTime) : (event.openDate ? Date.parse(event.openDate) : null),
            raw: {
                eventId: String(event.id),
                matchOddsMarketId: market.marketId,
                event,
                competition: market.competition || null,
                market,
            },
        };
    }

    _toLegacyMatch(match) {
        const id = makeNumericId(match.matchId);
        const header = {
            PID: id,
            Sifra: id,
            ParNaziv: `${match.home}: ${match.away}`,
            TeamHome: match.home,
            TeamAway: match.away,
            LN: match.league,
            SID: match.sport,
            MS: match.isLive ? 'LIVE' : 'NSY',
            isLive: match.isLive,
            marketcounter: match.raw?.market?.totalMatched ?? null,
        };
        return {
            id,
            Id: id,
            matchId: String(match.matchId),
            home: match.home,
            away: match.away,
            sport: match.sport,
            league: match.league,
            isLive: match.isLive,
            mode: match.mode,
            H: header,
            raw: match.raw,
        };
    }

    _normalizeMarket(catalogueMarket = {}, marketBook = {}, header = {}) {
        const marketType = catalogueMarket.description?.marketType || catalogueMarket.marketType || '';
        const line = this._marketLine(catalogueMarket, marketBook);
        const bookRunners = new Map((marketBook.runners || []).map((runner) => [`${runner.selectionId}:${runner.handicap ?? ''}`, runner]));
        const selections = (catalogueMarket.runners || [])
            .map((runner) => {
                const bookRunner = bookRunners.get(`${runner.selectionId}:${runner.handicap ?? ''}`) ||
                    (marketBook.runners || []).find((item) => String(item.selectionId) === String(runner.selectionId)) ||
                    {};
                const bestBack = bookRunner.ex?.availableToBack?.[0] || null;
                const price = toNumber(bestBack?.price);
                return {
                    N: Number(runner.selectionId),
                    selectionId: Number(runner.selectionId),
                    O: price,
                    type_1: this._selectionType(catalogueMarket, runner, header),
                    name: runner.runnerName || '',
                    base: this._selectionLine(catalogueMarket, runner, line),
                    handicap: toNumber(runner.handicap ?? bookRunner.handicap),
                    availableSize: toNumber(bestBack?.size),
                    status: bookRunner.status || null,
                    raw: {
                        runner,
                        bookRunner,
                    },
                };
            })
            .filter((selection) => Number.isFinite(selection.N));

        return {
            id: catalogueMarket.marketId,
            marketId: catalogueMarket.marketId,
            type: marketType,
            name: catalogueMarket.marketName || '',
            displayKey: marketType,
            displaySubKey: catalogueMarket.marketName || '',
            B: line,
            base: line,
            status: marketBook.status || null,
            inplay: marketBook.inplay === true || catalogueMarket.description?.inPlay === true,
            S: selections,
            raw: {
                header,
                catalogue: catalogueMarket,
                book: marketBook,
            },
        };
    }

    _selectionFromRawExchange(match, raw, pick) {
        const markets = match?.M || match?.markets || match?.odds?.M || [];
        const market = markets.find((item) => String(item.marketId || item.id) === String(raw.marketId));
        const selection = market?.S?.find((item) => String(item.N || item.selectionId) === String(raw.selectionId));
        return {
            selectionId: Number(raw.selectionId),
            marketId: String(raw.marketId),
            oddVal: toNumber(raw.price || raw.oddVal || selection?.O),
            handicap: raw.handicap ?? selection?.handicap,
            side: raw.side || 'BACK',
            pick,
            market,
            selection,
            raw,
        };
    }

    _findParsedOutcome(markets, parsed, expectedOdds) {
        switch (parsed.marketHint) {
            case '1x2':
                return this._findOneXTwo(markets, parsed, expectedOdds);
            case 'totals':
                return this._findTotals(markets, parsed, expectedOdds);
            case 'teamtotals':
                return this._findTeamTotals(markets, parsed, expectedOdds);
            case 'handicap':
                return this._findHandicap(markets, parsed, expectedOdds);
            case 'correctscore':
                return this._findCorrectScore(markets, parsed, expectedOdds);
            case 'btts':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketType(market) === 'BOTH_TEAMS_TO_SCORE' || /both teams to score/i.test(market.name),
                    selection: (selection) => lower(selection.name) === parsed.selection || lower(selection.type_1) === parsed.selection,
                });
            case 'doublechance':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketType(market) === 'DOUBLE_CHANCE' || /double chance/i.test(market.name),
                    selection: (selection, market) => this._selectionMatchesDoubleChance(selection, parsed.selection, market),
                });
            case 'drawnobet':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketType(market) === 'DRAW_NO_BET' || /draw no bet/i.test(market.name),
                    selection: (selection, market) => this._selectionIsTeam(selection, Number(parsed.selection), market),
                });
            default:
                return null;
        }
    }

    _findOneXTwo(markets, parsed, expectedOdds) {
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                this._marketType(market) === 'MATCH_ODDS' &&
                this._periodMatches(market, parsed.period)
            ),
            selection: (selection, market) => {
                if (parsed.oneXtwo === 'X') return upper(selection.type_1) === 'DRAW' || /draw/i.test(selection.name);
                return this._selectionIsTeam(selection, parsed.oneXtwo === '1' ? 1 : 2, market);
            },
        });
    }

    _findTotals(markets, parsed, expectedOdds) {
        const wanted = parsed.overUnder === 'over' ? 'OVER' : 'UNDER';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                this._isTotalsMarket(market) &&
                !this._isTeamTotalsMarket(market) &&
                this._periodMatches(market, parsed.period) &&
                nearlyEqual(this._lineForMarket(market), parsed.line)
            ),
            selection: (selection) => upper(selection.type_1) === wanted || upper(selection.name).includes(wanted),
        });
    }

    _findTeamTotals(markets, parsed, expectedOdds) {
        const team = Number(parsed.teamIndex);
        const wanted = parsed.overUnder === 'over' ? 'OVER' : 'UNDER';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                this._isTeamTotalsMarket(market) &&
                this._teamTotalMarketTeam(market) === team &&
                this._periodMatches(market, parsed.period) &&
                nearlyEqual(this._lineForMarket(market), parsed.line)
            ),
            selection: (selection) => upper(selection.type_1) === wanted || upper(selection.name).includes(wanted),
        });
    }

    _findHandicap(markets, parsed, expectedOdds) {
        const team = Number(parsed.handicapTeam);
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                /HANDICAP/.test(this._marketType(market)) &&
                this._periodMatches(market, parsed.period)
            ),
            selection: (selection, market) => (
                this._selectionIsTeam(selection, team, market) &&
                nearlyEqual(this._selectionLineValue(selection, market), parsed.handicapLine, 0.01)
            ),
            line: (selection, market) => this._selectionLineValue(selection, market),
        });
    }

    _findCorrectScore(markets, parsed, expectedOdds) {
        const wantedCompact = `${parsed.homeScore}-${parsed.awayScore}`;
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                this._marketType(market) === 'CORRECT_SCORE' &&
                this._periodMatches(market, parsed.period)
            ),
            selection: (selection) => {
                const value = String(selection.name || '').trim().replace(/\s+/g, '').replace(':', '-');
                return value === wantedCompact || value === `${parsed.homeScore}-${parsed.awayScore}`;
            },
        });
    }

    _findSimpleSelection(markets, parsed, expectedOdds, rules) {
        const candidates = [];
        for (const market of markets || []) {
            if (!rules.market(market)) continue;
            for (const selection of market.S || []) {
                if (!Number.isFinite(selection.O) || selection.O <= 1) continue;
                if (selection.status && selection.status !== 'ACTIVE') continue;
                if (!rules.selection(selection, market)) continue;
                candidates.push({
                    market,
                    selection,
                    line: typeof rules.line === 'function' ? rules.line(selection, market) : this._selectionLineValue(selection, market),
                });
            }
        }
        if (candidates.length === 0) return null;
        if (!Number.isFinite(Number(expectedOdds))) return candidates[0];
        candidates.sort((left, right) => Math.abs(left.selection.O - expectedOdds) - Math.abs(right.selection.O - expectedOdds));
        return candidates[0];
    }

    _buildPlaceOrdersPayload(outcome, stake, price) {
        const instruction = {
            selectionId: Number(outcome.selectionId),
            side: 'BACK',
            orderType: 'LIMIT',
            limitOrder: {
                size: Number(stake.toFixed(2)),
                price: Number(price.toFixed(2)),
                persistenceType: this.config.persistenceType || 'LAPSE',
                timeInForce: this.config.timeInForce || 'FILL_OR_KILL',
                minFillSize: Number(stake.toFixed(2)),
            },
        };
        const handicap = toNumber(outcome.handicap);
        if (Number.isFinite(handicap)) instruction.handicap = handicap;
        return {
            marketId: String(outcome.marketId),
            instructions: [instruction],
            customerRef: this._customerRef(),
        };
    }

    _normalizePlaceOrdersResponse(response, outcome, requestedSize) {
        const topStatus = upper(response?.status);
        const report = response?.instructionReports?.[0] || {};
        const instructionStatus = upper(report.status);
        const failure = response?.errorCode || report.errorCode || response?.error || null;
        if (topStatus !== 'SUCCESS' || instructionStatus !== 'SUCCESS') {
            const message = failure && report.errorCode && failure !== report.errorCode
                ? `${failure}: ${report.errorCode}`
                : (failure || response?.marketId || JSON.stringify(response || {}));
            const parsed = this.parseError({ error: message, raw: response });
            return {
                success: false,
                error: message,
                msg: message,
                failureClass: parsed.type === BetErrorTypes.INSUFFICIENT_BALANCE ? 'insufficient_balance' : undefined,
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }

        const sizeMatched = toNumber(report.sizeMatched) || 0;
        const requireFullyMatched = this.config.requireFullyMatched !== false;
        if (requireFullyMatched && sizeMatched + 0.0001 < requestedSize) {
            return {
                success: false,
                error: `Betfair order accepted but not fully matched (${sizeMatched}/${requestedSize})`,
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: false,
                orderAcceptedUnmatched: true,
                raw: response,
            };
        }

        return {
            success: true,
            ticketId: report.betId || response.customerRef || 'betfair_order',
            odds: outcome.oddVal,
            matchedSize: sizeMatched,
            raw: response,
        };
    }

    _customerRef() {
        const prefix = String(this.config.customerRefPrefix || 'bvbf').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'bvbf';
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
    }

    _marketType(market) {
        return upper(market.type || market.displayKey || market.raw?.catalogue?.description?.marketType || '');
    }

    _lineForMarket(market) {
        return toNumber(market.B ?? market.base ?? market.raw?.catalogue?.line);
    }

    _selectionLineValue(selection, market) {
        const selectionLine = toNumber(selection.base ?? selection.handicap);
        return selectionLine !== null ? selectionLine : this._lineForMarket(market);
    }

    _marketLine(catalogueMarket = {}, marketBook = {}) {
        for (const runner of catalogueMarket.runners || []) {
            const handicap = toNumber(runner.handicap);
            if (handicap !== null && handicap !== 0 && this._isOverUnderRunner(runner.runnerName)) return Math.abs(handicap);
        }
        const fromType = this._lineFromType(catalogueMarket.description?.marketType || catalogueMarket.marketType || '');
        if (fromType !== null) return fromType;
        const fromName = this._lineFromText(catalogueMarket.marketName || marketBook.marketName || '');
        if (fromName !== null) return fromName;
        return null;
    }

    _selectionLine(catalogueMarket, runner, fallbackLine) {
        const handicap = toNumber(runner.handicap);
        const marketType = upper(catalogueMarket.description?.marketType || catalogueMarket.marketType || '');
        if (Number.isFinite(handicap) && /HANDICAP/.test(marketType)) return handicap;
        if (Number.isFinite(handicap) && this._isOverUnderRunner(runner.runnerName)) return Math.abs(handicap);
        return fallbackLine;
    }

    _lineFromType(marketType) {
        const match = upper(marketType).match(/OVER_UNDER_([0-9]+)/);
        if (!match) return null;
        return Number(match[1]) / 10;
    }

    _lineFromText(text) {
        const match = String(text || '').match(/(?:over\/under|total(?:\s+goals|\s+points)?|goals?)\s*([0-9]+(?:[.,][0-9]+)?)/i) ||
            String(text || '').match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:goals|points)/i);
        return match ? Number(match[1].replace(',', '.')) : null;
    }

    _selectionType(catalogueMarket, runner, header) {
        const marketType = upper(catalogueMarket.description?.marketType || catalogueMarket.marketType || '');
        const runnerName = String(runner.runnerName || '');
        const runnerNorm = normalizeName(runnerName);
        if (/draw/i.test(runnerName)) return 'DRAW';
        if (this._isOverUnderRunner(runnerName)) return /over/i.test(runnerName) ? 'OVER' : 'UNDER';
        if (/^(yes|no)$/i.test(runnerName.trim())) return lower(runnerName);
        if (/HANDICAP|MATCH_ODDS|DRAW_NO_BET/.test(marketType)) {
            if (runnerNorm && runnerNorm === normalizeName(header.TeamHome)) return 'HOME';
            if (runnerNorm && runnerNorm === normalizeName(header.TeamAway)) return 'AWAY';
        }
        return runnerName;
    }

    _isOverUnderRunner(name) {
        return /\b(over|under)\b/i.test(String(name || ''));
    }

    _isTotalsMarket(market) {
        const type = this._marketType(market);
        const name = lower(market.name);
        return /^OVER_UNDER/.test(type) || /over\/under|total goals|total points|match total/.test(name);
    }

    _isTeamTotalsMarket(market) {
        const name = lower(market.name);
        return /team total|home total|away total|to score over\/under|total goals by/.test(name);
    }

    _teamTotalMarketTeam(market) {
        const name = normalizeName(market.name);
        const header = market.raw?.header || {};
        const home = normalizeName(header.TeamHome);
        const away = normalizeName(header.TeamAway);
        if (/home|team 1|team1/.test(name)) return 1;
        if (/away|team 2|team2/.test(name)) return 2;
        if (home && name.includes(home)) return 1;
        if (away && name.includes(away)) return 2;
        return null;
    }

    _selectionIsTeam(selection, team, market) {
        const type = upper(selection.type_1);
        if (team === 1 && type === 'HOME') return true;
        if (team === 2 && type === 'AWAY') return true;
        const header = market.raw?.header || market.H || {};
        const wanted = team === 1 ? normalizeName(header.TeamHome) : normalizeName(header.TeamAway);
        return wanted && normalizeName(selection.name) === wanted;
    }

    _selectionMatchesDoubleChance(selection, code, market) {
        const normalizedCode = upper(code).replace(/\s+/g, '');
        const compactName = upper(selection.name).replace(/[^A-Z0-9]+/g, '');
        if (compactName === normalizedCode) return true;

        const header = market.raw?.header || market.H || {};
        const name = normalizeName(selection.name);
        const home = normalizeName(header.TeamHome);
        const away = normalizeName(header.TeamAway);
        const hasDraw = /\bdraw\b/i.test(selection.name) || /\btie\b/i.test(selection.name);
        const hasHome = home && name.includes(home);
        const hasAway = away && name.includes(away);

        if (normalizedCode === '1X') return hasHome && hasDraw;
        if (normalizedCode === 'X2') return hasAway && hasDraw;
        if (normalizedCode === '12') return hasHome && hasAway && !hasDraw;
        return false;
    }

    _periodMatches(market, period) {
        const normalizedPeriod = Number(period) || null;
        const haystack = lower(`${market.type || ''} ${market.name || ''}`);
        if (!normalizedPeriod) {
            return !/half|1st|2nd|quarter|set|period/.test(haystack);
        }
        if (normalizedPeriod === 1) return /half|1st|first|quarter 1|set 1|period 1/.test(haystack);
        return new RegExp(`(?:quarter|set|period)\\s*${normalizedPeriod}|${normalizedPeriod}(?:st|nd|rd|th)`).test(haystack);
    }

    _splitEventName(name) {
        const text = String(name || '').trim();
        const parts = text.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+|\s+@\s+/i).map((part) => part.trim()).filter(Boolean);
        if (parts.length >= 2) return { home: parts[0], away: parts.slice(1).join(' v ') };
        return { home: text, away: '' };
    }

    _pairScore(wantedHome, wantedAway, candidateHome, candidateAway) {
        return this._nameScore(wantedHome, candidateHome) + this._nameScore(wantedAway, candidateAway);
    }

    _nameScore(wanted, candidate) {
        if (!wanted || !candidate) return 0;
        if (wanted === candidate) return 5;
        if (wanted.includes(candidate) || candidate.includes(wanted)) return 3;
        const wantedTokens = new Set(wanted.split(' ').filter(Boolean));
        return candidate.split(' ').filter(Boolean).reduce((score, token) => score + (wantedTokens.has(token) ? 1 : 0), 0);
    }

    _stripMatchId(matchId) {
        return String(matchId || '').replace(/^bf:(event|market):/i, '').replace(/^event:/i, '').replace(/^market:/i, '');
    }
}

module.exports = {
    BetfairAdapter,
    BETFAIR_EVENT_TYPE_IDS,
    normalizeSport,
    normalizeName,
};
