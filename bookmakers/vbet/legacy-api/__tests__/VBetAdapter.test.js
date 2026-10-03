'use strict';

const { VBetAdapter } = require('../VBetAdapter');
const { buildProxyUrl } = require('../SwarmClient');

class FakeSwarmClient {
    constructor(responses = {}) {
        this.responses = responses;
        this.loggedIn = false;
        this.requests = [];
    }

    async requestSession() {
        return { sid: 'fake' };
    }

    async login() {
        this.loggedIn = true;
        return { user: { deposit_amount: 250 } };
    }

    async get(params) {
        this.requests.push(params);
        if (params.source === 'user') return this.responses.profile;
        if (params.where?.game?.id) return this.responses.markets;
        return this.responses.catalog;
    }

    async request(command, params) {
        this.requests.push({ command, params });
        return this.responses[command] || { code: 0, data: { id: 'ticket-1' } };
    }

    close() {}
}

function makeAdapter(responses = {}) {
    return new VBetAdapter({
        credentials: { username: 'user', password: 'pass' },
        clientFactory: () => new FakeSwarmClient(responses),
        logger: { log: jest.fn(), error: jest.fn() },
    });
}

function makeMarkets(adapter) {
    return adapter._normalizeMarkets({
        market: {
            winner: {
                id: 1,
                type: 'P1XP2',
                name: 'Match Result',
                display_key: 'WINNER',
                display_sub_key: 'MATCH',
                event: {
                    w1: { id: 101, type_1: 'W1', name: 'W1', price: 2.1, order: 0 },
                    x: { id: 102, type_1: 'X', name: 'Draw', price: 3.2, order: 1 },
                    w2: { id: 103, type_1: 'W2', name: 'W2', price: 3.8, order: 2 },
                },
            },
            totals: {
                id: 2,
                type: 'OverUnder',
                name: 'Total',
                display_key: 'TOTALS',
                display_sub_key: 'MATCH',
                base: 134.5,
                event: {
                    over: { id: 201, type_1: 'Over', name: 'Over', base: 134.5, price: 1.91, order: 0 },
                    under: { id: 202, type_1: 'Under', name: 'Under', base: 134.5, price: 1.85, order: 1 },
                },
            },
            team2total: {
                id: 3,
                type: 'Team2OverUnder',
                name: 'Team 2: Total',
                display_key: 'TEAM_TOTALS',
                display_sub_key: 'MATCH',
                base: 10.5,
                event: {
                    over: { id: 301, type_1: 'Over', name: 'Over', base: 10.5, price: 1.75, order: 0 },
                    under: { id: 302, type_1: 'Under', name: 'Under', base: 10.5, price: 1.95, order: 1 },
                },
            },
            handicap: {
                id: 4,
                type: 'AsianHandicap',
                name: 'Handicap',
                display_key: 'HANDICAP',
                display_sub_key: 'MATCH',
                base: 0.5,
                event: {
                    home: { id: 401, type_1: 'Home', name: 'Home', base: -0.5, price: 2.05, order: 0 },
                    away: { id: 402, type_1: 'Away', name: 'Away', base: 0.5, price: 1.67, order: 1 },
                },
            },
            correctScore: {
                id: 5,
                type: 'CorrectScore',
                name: 'Correct Score',
                display_key: 'CORRECT SCORE',
                display_sub_key: 'MATCH',
                event: {
                    score: { id: 501, type_1: 'Home-Away', name: '0-0', price: 9.5, order: 0 },
                },
            },
            q1total: {
                id: 6,
                type: 'FirstQuarterOverUnder',
                name: '1 quarter total',
                display_key: 'TOTALS',
                display_sub_key: 'PERIOD',
                base: 56.5,
                event: {
                    over: { id: 601, type_1: 'Over', name: 'Over', base: 56.5, price: 1.82, order: 0 },
                    under: { id: 602, type_1: 'Under', name: 'Under', base: 56.5, price: 1.92, order: 1 },
                },
            },
        },
    });
}

describe('VBetAdapter', () => {
    test('normalizes host:port:user:pass into an authenticated SOCKS5 URL', () => {
        expect(buildProxyUrl('127.0.0.1:1080:user:pass')).toBe('socks5://user:pass@127.0.0.1:1080');
        expect(buildProxyUrl('socks5://user:pass@127.0.0.1:1080')).toBe('socks5://user:pass@127.0.0.1:1080');
    });

    test('loads and normalizes Swarm catalog entries', async () => {
        const adapter = makeAdapter({
            catalog: {
                data: {
                    sport: {
                        1: {
                            id: 1,
                            alias: 'Soccer',
                            name: 'Football',
                            region: {
                                10001: {
                                    id: 10001,
                                    name: 'World',
                                    alias: 'World',
                                    competition: {
                                        2969: {
                                            id: 2969,
                                            name: 'World Cup',
                                            game: {
                                                299: {
                                                    id: 299,
                                                    team1_name: 'Home FC',
                                                    team2_name: 'Away FC',
                                                    is_live: 1,
                                                    type: 1,
                                                    markets_count: 20,
                                                    info: { score1: '1', score2: '0' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const catalog = await adapter.getCatalog('soccer');
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
            matchId: '299',
            sport: 'soccer',
            home: 'Home FC',
            away: 'Away FC',
            league: 'World Cup',
            mode: 'live',
            score: '1-0',
        });
    });

    test('finds common VBet market selections from normalized outcome strings', () => {
        const adapter = makeAdapter();
        const match = { M: makeMarkets(adapter), markets: makeMarkets(adapter) };

        expect(adapter.findOutcome(match, '1').selectionId).toBe(101);
        expect(adapter.findOutcome(match, 'T> 134.5').selectionId).toBe(201);
        expect(adapter.findOutcome(match, 'IT2< 10.5').selectionId).toBe(302);
        expect(adapter.findOutcome(match, 'H1 -0.5').selectionId).toBe(401);
        expect(adapter.findOutcome(match, 'CS 0:0').selectionId).toBe(501);
        expect(adapter.findOutcome(match, 'P1 T< 56.5').selectionId).toBe(602);
    });

    test('requests and preserves stats in match details for live score guards', async () => {
        const adapter = makeAdapter({
            markets: {
                data: {
                    game: {
                        299: {
                            id: 299,
                            team1_name: 'Home FC',
                            team2_name: 'Away FC',
                            sport_alias: 'Soccer',
                            is_live: 1,
                            type: 1,
                            '#competition:name': 'World Cup',
                            stats: {
                                score_set1: {
                                    team1_value: '2',
                                    team2_value: '1',
                                },
                            },
                            market: {},
                        },
                    },
                },
            },
        });

        const details = await adapter.getMatchDetails(299, 'soccer');
        const request = adapter.client.requests.find((item) => item.where?.game?.id === 299);

        expect(request.what.game).toContain('stats');
        expect(details.raw.stats.score_set1.team1_value).toBe('2');
        expect(details.H.TeamHome).toBe('Home FC');
    });

    test('keeps real submit disabled unless explicitly enabled', async () => {
        const adapter = makeAdapter();
        const result = await adapter.placeBet({
            outcome: { selectionId: 201, oddVal: 1.91 },
            stake: 5,
        });

        expect(result.success).toBe(false);
        expect(result.realSubmitDisabled).toBe(true);
    });

    test('reads balance from profile response through logged-in Swarm session', async () => {
        const adapter = makeAdapter({
            profile: {
                data: {
                    profile: {
                        1: { deposit_amount: 250 },
                    },
                },
            },
        });

        await expect(adapter.getBalance()).resolves.toBe(250);
    });

    test('treats create_bets code=0 with HasError as rejected, not placed', async () => {
        const adapter = makeAdapter({
            create_bets: {
                code: 0,
                data: {
                    StatusCode: 'RequiredSessionLimitsDoesNotSet',
                    Data: {
                        Key: 'RequiredSessionLimitsDoesNotSet',
                        Message: 'RequiredSessionLimitsDoesNotSet',
                    },
                    HasError: true,
                },
            },
        });
        adapter.config.allowRealSubmit = true;

        const result = await adapter.placeBet({
            outcome: { selectionId: 201, oddVal: 1.91 },
            stake: 5,
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('RequiredSessionLimitsDoesNotSet');
        expect(result.requiresSessionLimits).toBe(true);
    });

    test('does not mark ambiguous create_bets code=0 without ticket id as success', async () => {
        const adapter = makeAdapter({
            create_bets: {
                code: 0,
                data: { StatusCode: 'Ok' },
            },
        });
        adapter.config.allowRealSubmit = true;

        const result = await adapter.placeBet({
            outcome: { selectionId: 201, oddVal: 1.91 },
            stake: 5,
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/ticket id/);
    });

    test('classifies required session limits as non-retryable limit stop', () => {
        const adapter = makeAdapter();
        const result = adapter.parseError({ error: 'RequiredSessionLimitsDoesNotSet' });

        expect(result.type).toBe('limit_exceeded');
        expect(result.retryable).toBe(false);
        expect(result.requiresSessionLimits).toBe(true);
    });
});
