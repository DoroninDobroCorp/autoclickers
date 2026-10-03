'use strict';

const { BettorAdapter, BetErrorTypes } = require('../../../core/node/betting/BettorAdapter');
const { OutcomeParser } = require('../../../core/node/parsers/outcome-parser');
const { SwarmClient } = require('./SwarmClient');

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
    cybersport: 'esports',
    tabletennis: 'table_tennis',
    table_tennis: 'table_tennis',
};

const VBET_SPORT_ALIAS = {
    soccer: 'Soccer',
    basketball: 'Basketball',
    tennis: 'Tennis',
    volleyball: 'Volleyball',
    handball: 'Handball',
    hockey: 'IceHockey',
    esports: 'CyberFootball',
    table_tennis: 'TableTennis',
};

const VBET_SPORT_ID = {
    1: 'soccer',
    2: 'hockey',
    3: 'basketball',
    4: 'tennis',
    5: 'volleyball',
    29: 'handball',
};

const DEFAULT_CATALOG_SPORTS = ['soccer', 'basketball', 'tennis', 'volleyball', 'handball', 'hockey'];

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function asArray(value) {
    if (!value || typeof value !== 'object') return [];
    return Array.isArray(value) ? value : Object.values(value);
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

function boolFromVBet(value) {
    return value === true || value === 1 || value === '1';
}

class VBetAdapter extends BettorAdapter {
    constructor(config = {}) {
        super(config);
        this.bookmakerName = config.bookmakerName || 'VBet';
        this.bookmakerId = 'vbet';
        this.currency = config.currency || 'UAH';
        this.isPrematch = Boolean(config.isPrematch);
        this.clientFactory = config.clientFactory || ((options) => new SwarmClient(options));
        this.client = config.client || null;
        this._catalogCache = new Map();
        this._catalogCacheTtlMs = config.catalogCacheTtlMs || 5000;
        this._lastLoginError = null;
        this._balance = null;
        this.sportMap = config.sportMap || {};
    }

    async login() {
        try {
            const credentials = this._getCredentials();
            const client = await this._ensureClient();
            await client.login(credentials);
            this.isLoggedIn = true;
            this._lastLoginError = null;
            return true;
        } catch (error) {
            this.isLoggedIn = false;
            this._lastLoginError = error.message;
            this.logger?.log?.(`VBet login failed: ${error.message}`);
            return false;
        }
    }

    async isSessionValid() {
        if (!this._hasCredentials()) {
            return false;
        }
        try {
            const balance = await this.getBalance();
            return Number.isFinite(balance);
        } catch (_) {
            return false;
        }
    }

    async getBalance() {
        const client = await this._ensureClient({ login: true });
        const data = await client.get({
            source: 'user',
            what: { profile: [] },
            subscribe: false,
        });
        const profile = this._extractProfile(data) || client.loginData?.user || client.loginData || {};
        const balance = this._extractBalance(profile);
        if (!Number.isFinite(balance)) {
            throw new Error('VBet balance was not found in profile response');
        }
        this._balance = balance;
        return balance;
    }

    getSportId(sportName) {
        const normalized = normalizeSport(sportName);
        return this.sportMap[normalized] || normalized;
    }

    async getCatalog(sport = 'all') {
        const aliases = this._resolveSportAliases(sport);
        const modes = this.config.catalogModes || ['live', 'prematch'];
        const tasks = [];

        for (const sportAlias of aliases) {
            for (const mode of modes) {
                tasks.push(this._getCatalogForAliasMode(sportAlias, mode));
            }
        }

        const settled = await Promise.allSettled(tasks);
        const matches = [];
        for (const item of settled) {
            if (item.status === 'fulfilled') {
                matches.push(...item.value);
            } else {
                this.logger?.log?.(`VBet catalog segment failed: ${item.reason?.message || item.reason}`);
            }
        }

        const seen = new Set();
        return matches.filter((match) => {
            const key = String(match.matchId);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    async getMatches(sportId = 'all') {
        const sport = VBET_SPORT_ID[Number(sportId)] || normalizeSport(sportId);
        const catalog = await this.getCatalog(sport === 'unknown' ? 'all' : sport);
        return catalog.map((match) => this._toLegacyMatch(match));
    }

    async getLiveMatches() {
        const aliases = this._resolveSportAliases('all');
        const parts = await Promise.allSettled(aliases.map((alias) => this._getCatalogForAliasMode(alias, 'live')));
        return parts
            .filter((part) => part.status === 'fulfilled')
            .flatMap((part) => part.value)
            .map((match) => this._toLegacyMatch(match));
    }

    async getPrematchMatches(sportId = 'all') {
        const sport = VBET_SPORT_ID[Number(sportId)] || normalizeSport(sportId);
        const aliases = this._resolveSportAliases(sport === 'unknown' ? 'all' : sport);
        const parts = await Promise.allSettled(aliases.map((alias) => this._getCatalogForAliasMode(alias, 'prematch')));
        return parts
            .filter((part) => part.status === 'fulfilled')
            .flatMap((part) => part.value)
            .map((match) => this._toLegacyMatch(match));
    }

    findMatch(matches = [], home, away, bookmakerMatchId = null) {
        const list = Array.isArray(matches) ? matches : [];
        if (bookmakerMatchId) {
            const exact = list.find((match) => String(match.Id || match.id || match.matchId) === String(bookmakerMatchId));
            if (exact) return exact;
        }

        const wantedHome = normalizeName(home);
        const wantedAway = normalizeName(away);
        let best = null;
        let bestScore = 0;

        for (const match of list) {
            const homeName = match.home || match.TeamHome || match.H?.TeamHome || match.H?.home || '';
            const awayName = match.away || match.TeamAway || match.H?.TeamAway || match.H?.away || '';
            const directScore = this._pairScore(wantedHome, wantedAway, normalizeName(homeName), normalizeName(awayName));
            if (directScore > bestScore) {
                best = match;
                bestScore = directScore;
            }
        }

        return bestScore >= 6 ? best : null;
    }

    async findMatchByPID(pid) {
        const details = await this.getMatchDetails(pid);
        if (!details || !details.H) {
            return null;
        }
        return {
            ...details,
            _fromASP: true,
            _fromVBetDirect: true,
        };
    }

    async getMatchOdds(matchId) {
        const details = await this.getMatchDetails(matchId);
        if (!details || !details.H) return null;
        return { H: details.H, M: details.M || [] };
    }

    async getMatchDetails(matchId, sportName = null) {
        const client = await this._ensureClient();
        const data = await client.get({
            source: 'betting',
            what: {
                game: ['id', 'is_blocked', 'is_live', 'team1_name', 'team2_name', 'sport_alias', 'start_ts', 'type', 'info', 'stats', '#competition:name'],
                market: ['type', 'name', 'display_key', 'display_sub_key', 'base', 'id', 'express_id', 'name_template', 'main_order', 'available_for_betbuilder'],
                event: ['id', 'price', 'type_1', 'name', 'base', 'order'],
            },
            where: { game: { id: Number(matchId) } },
            subscribe: false,
        });

        const game = this._extractSingleGame(data);
        if (!game) return {};
        const sport = normalizeSport(sportName || game.sport_alias || game.sport?.alias || game.sport?.name);
        const home = game.team1_name || '';
        const away = game.team2_name || '';
        const isLive = boolFromVBet(game.is_live) || Number(game.type) === 1;
        const markets = this._normalizeMarkets(game);
        const header = {
            PID: Number(game.id || matchId),
            Sifra: Number(game.id || matchId),
            ParNaziv: `${home}: ${away}`,
            TeamHome: home,
            TeamAway: away,
            LN: game.competition?.name || game['#competition:name'] || null,
            SID: sport,
            MS: isLive ? 'LIVE' : 'NSY',
            isLive,
            isBlocked: boolFromVBet(game.is_blocked),
        };

        return {
            id: Number(game.id || matchId),
            Id: Number(game.id || matchId),
            matchId: Number(game.id || matchId),
            home,
            away,
            sport,
            isLive,
            H: header,
            M: markets,
            odds: { H: header, M: markets },
            markets,
            raw: game,
        };
    }

    findOutcome(match, outcomeStr, expectedOdds = null) {
        const parsed = OutcomeParser.parse({ outcome: outcomeStr });
        if (!parsed) {
            this.logger?.log?.(`VBet outcome parse failed: ${outcomeStr}`);
            return null;
        }

        const target = match?.odds || match || {};
        const markets = target.M || target.markets || match?.markets || [];
        const found = this._findParsedOutcome(markets, parsed, expectedOdds);
        if (!found) {
            this.logger?.log?.(`VBet selection not found for ${outcomeStr}`);
            return null;
        }

        return {
            selectionId: found.selection.N,
            oddVal: found.selection.O,
            sbv: found.line,
            pick: outcomeStr,
            market: found.market,
            selection: found.selection,
        };
    }

    async prepareBet() {
        try {
            await this.getBalance();
        } catch (error) {
            this.logger?.log?.(`VBet prepareBet balance check failed: ${error.message}`);
        }
    }

    async placeBet({ outcome, stake }) {
        const allowRealSubmit = this.config.allowRealSubmit === true || process.env.VBET_ALLOW_REAL_SUBMIT === '1';
        if (!allowRealSubmit) {
            return {
                success: false,
                error: 'VBet real submit disabled (set VBET_ALLOW_REAL_SUBMIT=1 only after manual validation)',
                realSubmitDisabled: true,
            };
        }

        const client = await this._ensureClient({ login: true });
        const payload = {
            bets: [{
                AcceptTypeId: Number(this.config.acceptTypeId ?? 0),
                Amount: Number(stake),
                EachWay: false,
                Events: [{
                    SelectionId: Number(outcome.selectionId || outcome.selection?.N),
                    Coeficient: Number(outcome.oddVal || outcome.selection?.O),
                }],
                Type: Number(this.config.singleBetTypeId ?? 1),
                OddType: Number(this.config.oddType ?? 0),
                Source: Number(this.config.source || 42),
                IsSuperBet: false,
            }],
        };

        let response;
        try {
            response = await client.request('create_bets', payload);
        } catch (error) {
            return { success: false, error: error.message, raw: null };
        }

        return this._normalizeCreateBetsResponse(response, outcome);
    }

    parseError(response = {}) {
        const message = response.error || response.msg || response.message || JSON.stringify(response.raw || response || {});
        const normalized = lower(message);
        if (/requiredsessionlimits|session limits|ліміт.*сесі|лимит.*сес/i.test(message)) {
            return { type: BetErrorTypes.LIMIT_EXCEEDED, message, retryable: false, requiresSessionLimits: true };
        }
        if (/balance|insufficient|not enough|недостат|кошт|рахунк/.test(normalized)) {
            return { type: BetErrorTypes.INSUFFICIENT_BALANCE, message, retryable: false };
        }
        if (/blocked|single|express only|одинар/.test(normalized)) {
            return { type: BetErrorTypes.MATCH_CLOSED, message, retryable: false };
        }
        return super.parseError(response);
    }

    async close() {
        if (this.client && typeof this.client.close === 'function') {
            this.client.close();
        }
        this.client = null;
        this.isLoggedIn = false;
    }

    async _ensureClient(options = {}) {
        if (!this.client) {
            this.client = this.clientFactory({
                swarmUrl: this.config.swarmUrl,
                language: this.config.language || 'ukr',
                siteId: this.config.siteId,
                source: this.config.source,
                releaseDate: this.config.releaseDate,
                requestTimeoutMs: this.config.requestTimeoutMs || this.config.httpTimeoutMs || 15000,
                proxyUrl: this._getProxyUrl(),
                logger: this.logger,
            });
        }

        await this.client.requestSession();
        if (options.login && !this.client.loggedIn) {
            await this.client.login(this._getCredentials());
            this.isLoggedIn = true;
        }
        return this.client;
    }

    _getCredentials() {
        return {
            username: this.config.credentials?.username || process.env.VBET_UA_USERNAME || process.env.VBET_USERNAME || '',
            password: this.config.credentials?.password || process.env.VBET_UA_PASSWORD || process.env.VBET_PASSWORD || '',
        };
    }

    _hasCredentials() {
        const credentials = this._getCredentials();
        return Boolean(credentials.username && credentials.password);
    }

    _getProxyUrl() {
        return this.config.proxyUrl || this.config.proxy || process.env.VBET_UA_PROXY || process.env.VBET_PROXY || '';
    }

    _extractProfile(data = {}) {
        const root = data.data || data;
        if (root.profile) {
            if (Array.isArray(root.profile)) return root.profile[0] || null;
            if (typeof root.profile === 'object') {
                const values = Object.values(root.profile);
                return root.profile.id ? root.profile : values[0] || root.profile;
            }
        }
        return root.user || root;
    }

    _extractBalance(profile = {}) {
        const candidates = [
            profile.balance,
            profile.deposit_amount,
            profile.available_balance,
            profile.availableBalance,
            profile.cash,
            profile.money,
        ];
        for (const candidate of candidates) {
            const value = toNumber(candidate);
            if (Number.isFinite(value)) return value;
        }
        return null;
    }

    _resolveSportAliases(sport) {
        const requested = String(sport || 'all').trim().toLowerCase();
        if (!requested || requested === 'all' || requested === '*') {
            return (this.config.catalogSports || DEFAULT_CATALOG_SPORTS)
                .map((item) => VBET_SPORT_ALIAS[normalizeSport(item)] || item)
                .filter(Boolean);
        }

        const canonical = VBET_SPORT_ID[Number(sport)] || normalizeSport(sport);
        return [VBetAdapter.vbetSportAlias(canonical)].filter(Boolean);
    }

    static vbetSportAlias(canonical) {
        return VBET_SPORT_ALIAS[canonical] || null;
    }

    async _getCatalogForAliasMode(sportAlias, mode) {
        const key = `${sportAlias}:${mode}`;
        const cached = this._catalogCache.get(key);
        if (cached && Date.now() - cached.at <= this._catalogCacheTtlMs) {
            return cached.matches;
        }

        const client = await this._ensureClient();
        const where = {
            sport: { alias: sportAlias },
            game: mode === 'live'
                ? { type: 1 }
                : { '@or': [{ visible_in_prematch: 1 }, { type: { '@in': [0, 2] } }] },
        };

        const data = await client.get({
            source: 'betting',
            what: {
                sport: ['id', 'name', 'alias'],
                region: ['id', 'name', 'alias'],
                competition: ['id', 'name'],
                game: ['id', 'markets_count', 'is_blocked', 'is_live', 'team1_name', 'team2_name', 'team1_id', 'team2_id', 'start_ts', 'game_number', 'info', 'stats', 'type'],
            },
            where,
            subscribe: false,
        });

        const matches = this._flattenCatalogGames(data, mode)
            .map((entry) => this._normalizeCatalogMatch(entry, mode))
            .filter(Boolean);
        this._catalogCache.set(key, { at: Date.now(), matches });
        return matches;
    }

    _flattenCatalogGames(data, fallbackMode) {
        const root = data?.data || data || {};
        const out = [];
        for (const sport of asArray(root.sport)) {
            for (const region of asArray(sport.region)) {
                for (const competition of asArray(region.competition)) {
                    for (const game of asArray(competition.game)) {
                        out.push({ sport, region, competition, game, mode: fallbackMode });
                    }
                }
            }
        }
        return out;
    }

    _normalizeCatalogMatch(entry, fallbackMode) {
        const game = entry.game || {};
        if (!game.id || !game.team1_name || !game.team2_name) return null;
        const isLive = boolFromVBet(game.is_live) || Number(game.type) === 1;
        const mode = isLive ? 'live' : fallbackMode || 'prematch';
        const score1 = game.info?.score1 ?? game.stats?.score_set1?.team1_value;
        const score2 = game.info?.score2 ?? game.stats?.score_set1?.team2_value;
        const score = score1 !== undefined && score2 !== undefined ? `${score1}-${score2}` : null;
        const sport = normalizeSport(entry.sport?.alias || entry.sport?.name);
        return {
            matchId: String(game.id),
            sport,
            home: game.team1_name,
            away: game.team2_name,
            league: entry.competition?.name || null,
            region: entry.region?.name || null,
            mode,
            score,
            isLive,
            kickoffTs: game.start_ts ? Number(game.start_ts) * 1000 : null,
            raw: {
                sport: entry.sport,
                region: entry.region,
                competition: entry.competition,
                game,
            },
        };
    }

    _toLegacyMatch(match) {
        const id = Number(match.matchId);
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
            marketcounter: match.raw?.game?.markets_count ?? null,
        };
        return {
            id,
            Id: id,
            matchId: id,
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

    _pairScore(wantedHome, wantedAway, candidateHome, candidateAway) {
        return this._nameScore(wantedHome, candidateHome) + this._nameScore(wantedAway, candidateAway);
    }

    _nameScore(wanted, candidate) {
        if (!wanted || !candidate) return 0;
        if (wanted === candidate) return 5;
        if (wanted.includes(candidate) || candidate.includes(wanted)) return 3;
        const wantedTokens = new Set(wanted.split(' ').filter(Boolean));
        const candidateTokens = candidate.split(' ').filter(Boolean);
        return candidateTokens.reduce((score, token) => score + (wantedTokens.has(token) ? 1 : 0), 0);
    }

    _extractSingleGame(data = {}) {
        const root = data?.data || data || {};
        if (root.game) {
            return asArray(root.game)[0] || null;
        }
        for (const sport of asArray(root.sport)) {
            for (const region of asArray(sport.region)) {
                for (const competition of asArray(region.competition)) {
                    const game = asArray(competition.game)[0];
                    if (game) {
                        game.sport = sport;
                        game.region = region;
                        game.competition = competition;
                        return game;
                    }
                }
            }
        }
        return null;
    }

    _normalizeMarkets(game = {}) {
        return asArray(game.market).map((market) => {
            const selections = asArray(market.event)
                .map((event) => ({
                    N: Number(event.id),
                    O: Number(event.price),
                    type_1: event.type_1 || null,
                    name: event.name || '',
                    base: toNumber(event.base),
                    order: toNumber(event.order),
                    raw: event,
                }))
                .filter((selection) => Number.isFinite(selection.N) && Number.isFinite(selection.O));
            return {
                id: Number(market.id),
                type: market.type || '',
                name: market.name || '',
                displayKey: market.display_key || '',
                displaySubKey: market.display_sub_key || '',
                B: toNumber(market.base),
                base: toNumber(market.base),
                S: selections,
                raw: market,
            };
        }).filter((market) => Number.isFinite(market.id) && market.S.length > 0);
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
            case 'doublechance':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketKey(market) === 'DOUBLE CHANCE' || market.type === '1X12X2',
                    selection: (selection) => upper(selection.type_1 || selection.name) === upper(parsed.selection),
                });
            case 'btts':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketKey(market) === 'BOTHTEAMTOSCORE' || /BothTeamsToScore/i.test(market.type),
                    selection: (selection) => lower(selection.type_1 || selection.name) === lower(parsed.selection),
                });
            case 'oddeven':
                return this._findSimpleSelection(markets, parsed, expectedOdds, {
                    market: (market) => this._marketKey(market) === 'ODD/EVEN' || /EvenOdd/i.test(market.type),
                    selection: (selection) => lower(selection.type_1 || selection.name) === lower(parsed.selection),
                });
            default:
                return null;
        }
    }

    _findOneXTwo(markets, parsed, expectedOdds) {
        const wanted = parsed.oneXtwo === '1' ? 'W1' : parsed.oneXtwo === '2' ? 'W2' : 'X';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                this._marketKey(market) === 'WINNER' &&
                this._periodMatches(market, parsed.period) &&
                (parsed.period ? this._isPeriodMarket(market) : this._isMatchMarket(market))
            ),
            selection: (selection) => upper(selection.type_1) === wanted,
        });
    }

    _findTotals(markets, parsed, expectedOdds) {
        const wantedType = parsed.overUnder === 'over' ? 'OVER' : 'UNDER';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                (this._marketKey(market) === 'TOTALS' || /OverUnder/i.test(market.type)) &&
                !/Team[12]/i.test(market.type) &&
                !/Corner/i.test(market.type) &&
                this._periodMatches(market, parsed.period) &&
                nearlyEqual(this._marketLine(market), parsed.line)
            ),
            selection: (selection, market) => upper(selection.type_1) === wantedType && nearlyEqual(this._selectionLine(selection, market), parsed.line),
        });
    }

    _findTeamTotals(markets, parsed, expectedOdds) {
        const team = Number(parsed.teamIndex);
        const wantedType = parsed.overUnder === 'over' ? 'OVER' : 'UNDER';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                (this._marketKey(market) === 'TEAM_TOTALS' || new RegExp(`Team${team}.*OverUnder`, 'i').test(market.type)) &&
                this._teamTotalMarketTeam(market) === team &&
                this._periodMatches(market, parsed.period) &&
                nearlyEqual(this._marketLine(market), parsed.line)
            ),
            selection: (selection, market) => upper(selection.type_1) === wantedType && nearlyEqual(this._selectionLine(selection, market), parsed.line),
        });
    }

    _findHandicap(markets, parsed, expectedOdds) {
        const wantedType = Number(parsed.handicapTeam) === 1 ? 'HOME' : 'AWAY';
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                (this._marketKey(market) === 'HANDICAP' || /AsianHandicap/i.test(market.type)) &&
                this._periodMatches(market, parsed.period) &&
                !/3WAY/i.test(this._marketKey(market))
            ),
            selection: (selection) => upper(selection.type_1) === wantedType && nearlyEqual(selection.base, parsed.handicapLine),
            line: (selection) => selection.base,
        });
    }

    _findCorrectScore(markets, parsed, expectedOdds) {
        const wanted = `${parsed.homeScore}-${parsed.awayScore}`;
        return this._findSimpleSelection(markets, parsed, expectedOdds, {
            market: (market) => (
                (this._marketKey(market) === 'CORRECT SCORE' || /CorrectScore/i.test(market.type)) &&
                this._periodMatches(market, parsed.period)
            ),
            selection: (selection) => String(selection.name || '').trim().replace(':', '-') === wanted,
        });
    }

    _findSimpleSelection(markets, parsed, expectedOdds, rules) {
        const candidates = [];
        for (const market of markets || []) {
            if (!rules.market(market)) continue;
            for (const selection of market.S || []) {
                if (!Number.isFinite(selection.O) || selection.O <= 1) continue;
                if (!rules.selection(selection, market)) continue;
                candidates.push({
                    market,
                    selection,
                    line: typeof rules.line === 'function' ? rules.line(selection, market) : this._selectionLine(selection, market),
                });
            }
        }
        if (candidates.length === 0) return null;
        if (!Number.isFinite(Number(expectedOdds))) return candidates[0];
        candidates.sort((left, right) => Math.abs(left.selection.O - expectedOdds) - Math.abs(right.selection.O - expectedOdds));
        return candidates[0];
    }

    _marketKey(market) {
        return upper(market.displayKey || market.raw?.display_key || '');
    }

    _marketLine(market) {
        return toNumber(market.B ?? market.base ?? market.raw?.base);
    }

    _selectionLine(selection, market) {
        const selectionLine = toNumber(selection.base);
        return selectionLine !== null ? selectionLine : this._marketLine(market);
    }

    _teamTotalMarketTeam(market) {
        const type = String(market.type || '');
        const name = String(market.name || '');
        if (/Team1/i.test(type) || /Team\s*1/i.test(name)) return 1;
        if (/Team2/i.test(type) || /Team\s*2/i.test(name)) return 2;
        return null;
    }

    _periodMatches(market, period) {
        const normalizedPeriod = Number(period) || null;
        if (!normalizedPeriod) {
            return this._isMatchMarket(market);
        }
        if (!this._isPeriodMarket(market)) {
            return false;
        }
        const haystack = `${market.type || ''} ${market.name || ''}`.toLowerCase();
        if (normalizedPeriod === 1) {
            return /halftime|firsthalf|1st|1-й|1.?й|quarter1|1.*quarter|1.*чвер|set1|period1/.test(haystack) || this._marketSubKey(market) === 'PERIOD';
        }
        return new RegExp(`(^|[^0-9])${normalizedPeriod}([^0-9]|$)|quarter${normalizedPeriod}|set${normalizedPeriod}|period${normalizedPeriod}`).test(haystack);
    }

    _isMatchMarket(market) {
        const subKey = this._marketSubKey(market);
        const haystack = `${market.type || ''} ${market.name || ''}`.toLowerCase();
        if (subKey === 'MATCH') return true;
        if (subKey === 'PERIOD') return false;
        return !/halftime|half time|quarter|чвер|set[0-9]|period[0-9]|1-й|2-й|тайм/.test(haystack);
    }

    _isPeriodMarket(market) {
        const subKey = this._marketSubKey(market);
        const haystack = `${market.type || ''} ${market.name || ''}`.toLowerCase();
        return subKey === 'PERIOD' || /halftime|half time|quarter|чвер|set[0-9]|period[0-9]|1-й|2-й|тайм/.test(haystack);
    }

    _marketSubKey(market) {
        return upper(market.displaySubKey || market.raw?.display_sub_key || '');
    }

    _normalizeCreateBetsResponse(response, outcome) {
        const errorMessage = this._extractCreateBetsErrorMessage(response);
        if (errorMessage) {
            const requiresSessionLimits = /requiredsessionlimits|session limits/i.test(errorMessage);
            return {
                success: false,
                error: errorMessage,
                msg: errorMessage,
                requiresSessionLimits,
                failureClass: requiresSessionLimits ? 'account_limits_required' : undefined,
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }

        const text = JSON.stringify(response || {});
        const lowered = lower(text);
        if (/balance|insufficient|not enough|недостат|кошт|рахунк/.test(lowered)) {
            return {
                success: false,
                error: 'Insufficient balance',
                msg: text,
                failureClass: 'insufficient_balance',
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }
        if (response?.code !== 0) {
            return {
                success: false,
                error: response?.msg || response?.message || `VBet create_bets code=${response?.code}`,
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }
        if (/blocked|unavailable|suspend|closed|single/.test(lowered)) {
            return {
                success: false,
                error: response?.msg || response?.message || text,
                singlesBlocked: /single/.test(lowered),
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }
        const ticketId = this._extractCreateBetsTicketId(response);
        if (!ticketId) {
            return {
                success: false,
                error: 'VBet create_bets response did not include a ticket id',
                msg: text,
                failureClass: 'unknown_submit_response',
                failureStage: 'bookmaker_submit',
                submitReached: true,
                bookmakerRejected: true,
                raw: response,
            };
        }
        return {
            success: true,
            ticketId,
            odds: outcome.oddVal,
            raw: response,
        };
    }

    _extractCreateBetsErrorMessage(response = {}) {
        if (!response) return null;
        if (response.code !== undefined && response.code !== 0) {
            return response.msg || response.message || response.error || `VBet create_bets code=${response.code}`;
        }

        const data = response.data || {};
        if (data.HasError === true || data.hasError === true || data.error || data.Error) {
            return data.Data?.Message ||
                data.Data?.Key ||
                data.Message ||
                data.message ||
                data.StatusCode ||
                data.error ||
                data.Error ||
                response.msg ||
                response.message ||
                'VBet create_bets returned an error';
        }

        const nestedCandidates = [
            data.Result,
            data.result,
            data.Bets,
            data.bets,
            data.Data,
        ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean);

        for (const item of nestedCandidates) {
            if (item.HasError === true || item.hasError === true || item.Error || item.error) {
                return item.Message ||
                    item.message ||
                    item.ErrorMessage ||
                    item.errorMessage ||
                    item.StatusCode ||
                    item.Error ||
                    item.error ||
                    'VBet create_bets returned an item error';
            }
        }

        return null;
    }

    _extractCreateBetsTicketId(response = {}) {
        const data = response.data || {};
        const candidates = [
            data.bet_id,
            data.betId,
            data.BetId,
            data.id,
            data.Id,
            data.ticket_id,
            data.ticketId,
            data.bets?.[0]?.id,
            data.bets?.[0]?.Id,
            data.bets?.[0]?.bet_id,
            data.Bets?.[0]?.Id,
            data.Bets?.[0]?.BetId,
            data.Data?.BetId,
            data.Data?.bet_id,
            data.Data?.Id,
            data.Result?.BetId,
            data.Result?.bet_id,
            data.Result?.Id,
        ];
        return candidates.find((candidate) => candidate !== undefined && candidate !== null && String(candidate) !== '') || null;
    }
}

module.exports = {
    VBetAdapter,
    normalizeSport,
    normalizeName,
};
