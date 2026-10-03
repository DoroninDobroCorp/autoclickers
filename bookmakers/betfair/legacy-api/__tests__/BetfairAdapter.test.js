'use strict';

const { BetfairAdapter } = require('../BetfairAdapter');
const { BetfairClient, normalizeProxyUrl } = require('../BetfairClient');
const { BetfairV2Adapter } = require('../../node-adapter/BetfairV2Adapter');

function createClient(overrides = {}) {
    return {
        sessionToken: 'session',
        login: jest.fn(async () => ({ status: 'SUCCESS', token: 'session' })),
        keepAlive: jest.fn(async () => ({ status: 'SUCCESS' })),
        getAccountFunds: jest.fn(async () => ({ availableToBetBalance: 12.34 })),
        listMarketCatalogue: jest.fn(async () => []),
        listMarketBook: jest.fn(async () => []),
        placeOrders: jest.fn(async () => ({ status: 'SUCCESS', instructionReports: [{ status: 'SUCCESS', betId: 'bet-1', sizeMatched: 5 }] })),
        close: jest.fn(async () => {}),
        ...overrides,
    };
}

function soccerCatalog() {
    return [{
        marketId: '1.100',
        marketName: 'Match Odds',
        marketStartTime: '2026-06-07T20:00:00.000Z',
        description: { marketType: 'MATCH_ODDS', inPlay: false },
        event: { id: '3001', name: 'Arsenal v Chelsea', openDate: '2026-06-07T20:00:00.000Z' },
        competition: { id: '500', name: 'Premier League' },
        runners: [
            { selectionId: 11, runnerName: 'Arsenal', sortPriority: 1 },
            { selectionId: 12, runnerName: 'Chelsea', sortPriority: 2 },
            { selectionId: 13, runnerName: 'The Draw', sortPriority: 3 },
        ],
    }];
}

function liveSoccerCatalogWithoutDescriptionInPlay() {
    return [{
        marketId: '1.200',
        marketName: 'Match Odds',
        marketStartTime: '2026-06-07T20:00:00.000Z',
        description: { marketType: 'MATCH_ODDS' },
        event: { id: '3002', name: 'Liverpool v Everton', openDate: '2026-06-07T20:00:00.000Z' },
        competition: { id: '501', name: 'Premier League' },
        runners: [
            { selectionId: 61, runnerName: 'Liverpool', sortPriority: 1 },
            { selectionId: 62, runnerName: 'Everton', sortPriority: 2 },
            { selectionId: 63, runnerName: 'The Draw', sortPriority: 3 },
        ],
    }];
}

function matchDetailsCatalog() {
    return [
        ...soccerCatalog(),
        {
            marketId: '1.101',
            marketName: 'Over/Under 2.5 Goals',
            marketStartTime: '2026-06-07T20:00:00.000Z',
            description: { marketType: 'OVER_UNDER_25', inPlay: false },
            event: { id: '3001', name: 'Arsenal v Chelsea', openDate: '2026-06-07T20:00:00.000Z' },
            competition: { id: '500', name: 'Premier League' },
            runners: [
                { selectionId: 21, runnerName: 'Over 2.5 Goals', handicap: 2.5 },
                { selectionId: 22, runnerName: 'Under 2.5 Goals', handicap: 2.5 },
            ],
        },
        {
            marketId: '1.102',
            marketName: 'Correct Score',
            marketStartTime: '2026-06-07T20:00:00.000Z',
            description: { marketType: 'CORRECT_SCORE', inPlay: false },
            event: { id: '3001', name: 'Arsenal v Chelsea', openDate: '2026-06-07T20:00:00.000Z' },
            competition: { id: '500', name: 'Premier League' },
            runners: [
                { selectionId: 31, runnerName: '1 - 0' },
                { selectionId: 32, runnerName: '0 - 0' },
            ],
        },
        {
            marketId: '1.103',
            marketName: 'Asian Handicap',
            marketStartTime: '2026-06-07T20:00:00.000Z',
            description: { marketType: 'ASIAN_HANDICAP', inPlay: false },
            event: { id: '3001', name: 'Arsenal v Chelsea', openDate: '2026-06-07T20:00:00.000Z' },
            competition: { id: '500', name: 'Premier League' },
            runners: [
                { selectionId: 41, runnerName: 'Arsenal', handicap: -1.5 },
                { selectionId: 42, runnerName: 'Chelsea', handicap: 1.5 },
            ],
        },
        {
            marketId: '1.104',
            marketName: 'Double Chance',
            marketStartTime: '2026-06-07T20:00:00.000Z',
            description: { marketType: 'DOUBLE_CHANCE', inPlay: false },
            event: { id: '3001', name: 'Arsenal v Chelsea', openDate: '2026-06-07T20:00:00.000Z' },
            competition: { id: '500', name: 'Premier League' },
            runners: [
                { selectionId: 51, runnerName: 'Arsenal or Draw' },
                { selectionId: 52, runnerName: 'Chelsea or Draw' },
                { selectionId: 53, runnerName: 'Arsenal or Chelsea' },
            ],
        },
    ];
}

function marketBooks() {
    return [
        {
            marketId: '1.100',
            status: 'OPEN',
            inplay: false,
            runners: [
                { selectionId: 11, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.95, size: 100 }] } },
                { selectionId: 12, status: 'ACTIVE', ex: { availableToBack: [{ price: 4.1, size: 100 }] } },
                { selectionId: 13, status: 'ACTIVE', ex: { availableToBack: [{ price: 3.5, size: 100 }] } },
            ],
        },
        {
            marketId: '1.101',
            status: 'OPEN',
            runners: [
                { selectionId: 21, handicap: 2.5, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.82, size: 50 }] } },
                { selectionId: 22, handicap: 2.5, status: 'ACTIVE', ex: { availableToBack: [{ price: 2.08, size: 50 }] } },
            ],
        },
        {
            marketId: '1.102',
            status: 'OPEN',
            runners: [
                { selectionId: 31, status: 'ACTIVE', ex: { availableToBack: [{ price: 8.6, size: 10 }] } },
                { selectionId: 32, status: 'ACTIVE', ex: { availableToBack: [{ price: 11.0, size: 10 }] } },
            ],
        },
        {
            marketId: '1.103',
            status: 'OPEN',
            runners: [
                { selectionId: 41, handicap: -1.5, status: 'ACTIVE', ex: { availableToBack: [{ price: 2.4, size: 10 }] } },
                { selectionId: 42, handicap: 1.5, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.65, size: 10 }] } },
            ],
        },
        {
            marketId: '1.104',
            status: 'OPEN',
            runners: [
                { selectionId: 51, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.2, size: 50 }] } },
                { selectionId: 52, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.55, size: 50 }] } },
                { selectionId: 53, status: 'ACTIVE', ex: { availableToBack: [{ price: 1.3, size: 50 }] } },
            ],
        },
    ];
}

describe('BetfairAdapter', () => {
    test('normalizes colon proxy credentials to an http proxy URL', () => {
        expect(normalizeProxyUrl('127.0.0.1:2080:user:pa:ss')).toBe('http://user:pa%3Ass@127.0.0.1:2080');
        expect(normalizeProxyUrl('127.0.0.1:2080:user:pa:ss', 'socks5')).toBe('socks5://user:pa%3Ass@127.0.0.1:2080');
    });

    test('loads a normalized catalog from MATCH_ODDS markets', async () => {
        const client = createClient({
            listMarketCatalogue: jest.fn(async () => soccerCatalog()),
        });
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'session', catalogModes: ['prematch'] });

        const catalog = await adapter.getCatalog('soccer');

        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
            matchId: '3001',
            sport: 'soccer',
            home: 'Arsenal',
            away: 'Chelsea',
            league: 'Premier League',
        });
        expect(client.listMarketCatalogue).toHaveBeenCalledWith(expect.objectContaining({
            filter: expect.objectContaining({ eventTypeIds: ['1'], marketTypeCodes: ['MATCH_ODDS'] }),
        }));
    });

    test('marks live catalog matches as live even when catalogue description omits inPlay', async () => {
        const client = createClient({
            listMarketCatalogue: jest.fn(async () => liveSoccerCatalogWithoutDescriptionInPlay()),
        });
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'session', catalogModes: ['live'] });

        const catalog = await adapter.getCatalog('soccer');
        const legacy = await adapter.getLiveMatches();

        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({ matchId: '3002', mode: 'live', isLive: true });
        expect(legacy[0].H).toMatchObject({ MS: 'LIVE', isLive: true });
    });

    test('throws a catalog API error when every catalog segment fails', async () => {
        const client = createClient({
            listMarketCatalogue: jest.fn(async () => {
                throw new Error('INVALID_SESSION_INFORMATION');
            }),
        });
        const adapter = new BetfairAdapter({
            client,
            appKey: 'app',
            sessionToken: 'session',
            catalogSports: ['soccer'],
            catalogModes: ['live', 'prematch'],
            logger: { log: jest.fn(), error: jest.fn() },
        });

        await expect(adapter.getCatalog('soccer')).rejects.toThrow(/Betfair catalog unavailable: INVALID_SESSION_INFORMATION/);
    });

    test('uses only availableToBetBalance for balance checks', async () => {
        const client = createClient({
            getAccountFunds: jest.fn(async () => ({ exposureLimit: 1000, retainedCommission: 2 })),
        });
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'session' });

        await expect(adapter.getBalance()).rejects.toThrow(/balance was not found/);
    });

    test('normalizes market books and finds 1x2, totals, handicap and correct score outcomes', async () => {
        const client = createClient({
            listMarketCatalogue: jest.fn(async () => matchDetailsCatalog()),
            listMarketBook: jest.fn(async () => marketBooks()),
        });
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'session' });

        const details = await adapter.getMatchDetails('3001', 'soccer');

        expect(details.H.TeamHome).toBe('Arsenal');
        expect(details.M).toHaveLength(5);
        expect(adapter.findOutcome(details, '1')).toMatchObject({ marketId: '1.100', selectionId: 11, oddVal: 1.95 });
        expect(adapter.findOutcome(details, 'T> 2.5')).toMatchObject({ marketId: '1.101', selectionId: 21, oddVal: 1.82 });
        expect(adapter.findOutcome(details, 'H1 -1.5')).toMatchObject({ marketId: '1.103', selectionId: 41, handicap: -1.5 });
        expect(adapter.findOutcome(details, 'CS 1:0')).toMatchObject({ marketId: '1.102', selectionId: 31, oddVal: 8.6 });
        expect(adapter.findOutcome(details, 'DC 1X')).toMatchObject({ marketId: '1.104', selectionId: 51, oddVal: 1.2 });
        expect(adapter.findOutcome(details, 'DC X2')).toMatchObject({ marketId: '1.104', selectionId: 52, oddVal: 1.55 });
        expect(adapter.findOutcome(details, 'DC 12')).toMatchObject({ marketId: '1.104', selectionId: 53, oddVal: 1.3 });
    });

    test('does not submit real orders unless Betfair real submit is explicitly enabled', async () => {
        const client = createClient();
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'session' });

        const result = await adapter.placeBet({
            outcome: { marketId: '1.100', selectionId: 11, oddVal: 1.95 },
            stake: 5,
        });

        expect(result.success).toBe(false);
        expect(result.realSubmitDisabled).toBe(true);
        expect(result.orderPayload).toMatchObject({
            marketId: '1.100',
            instructions: [expect.objectContaining({
                selectionId: 11,
                side: 'BACK',
                orderType: 'LIMIT',
            })],
        });
        expect(client.placeOrders).not.toHaveBeenCalled();
    });

    test('normalizes fully matched placeOrders response when real submit is enabled', async () => {
        const client = createClient();
        const adapter = new BetfairAdapter({
            client,
            appKey: 'app',
            sessionToken: 'session',
            allowRealSubmit: true,
        });

        const result = await adapter.placeBet({
            outcome: { marketId: '1.100', selectionId: 11, oddVal: 1.95 },
            stake: 5,
        });

        expect(result).toMatchObject({
            success: true,
            ticketId: 'bet-1',
            matchedSize: 5,
        });
        expect(client.placeOrders).toHaveBeenCalledWith(expect.objectContaining({
            marketId: '1.100',
            instructions: [expect.objectContaining({
                limitOrder: expect.objectContaining({
                    timeInForce: 'FILL_OR_KILL',
                    minFillSize: 5,
                }),
            })],
        }));
    });

    test('rejects accepted but not fully matched exchange orders by default', async () => {
        const client = createClient({
            placeOrders: jest.fn(async () => ({
                status: 'SUCCESS',
                instructionReports: [{ status: 'SUCCESS', betId: 'bet-2', sizeMatched: 2 }],
            })),
        });
        const adapter = new BetfairAdapter({
            client,
            appKey: 'app',
            sessionToken: 'session',
            allowRealSubmit: true,
        });

        const result = await adapter.placeBet({
            outcome: { marketId: '1.100', selectionId: 11, oddVal: 1.95 },
            stake: 5,
        });

        expect(result).toMatchObject({
            success: false,
            orderAcceptedUnmatched: true,
            submitReached: true,
        });
    });

    test('v2 adapter reports disabled real submit as a Telegram design stop', async () => {
        const legacyAdapter = {
            getMatchDetails: jest.fn(async () => ({ M: [] })),
            findOutcome: jest.fn(() => ({ marketId: '1.100', selectionId: 11, oddVal: 1.95 })),
            placeBet: jest.fn(async () => ({
                success: false,
                error: 'Betfair real submit disabled',
                realSubmitDisabled: true,
            })),
        };
        const adapter = new BetfairV2Adapter({ legacyAdapter });

        const result = await adapter.submitBet({
            matchId: '3001',
            outcome: '1',
            stake: 5,
        });

        expect(result).toMatchObject({
            ok: false,
            status: 'design_stop',
            designStopReason: 'Betfair real submit disabled',
            oddsTaken: 1.95,
        });
    });

    test('classifies insufficient funds as a non-retryable balance error', () => {
        const adapter = new BetfairAdapter({});
        expect(adapter.parseError({ error: 'APINGException: INSUFFICIENT_FUNDS' })).toMatchObject({
            type: 'insufficient_balance',
            retryable: false,
        });
    });

    test('preserves top-level insufficient funds when instruction says generic order error', () => {
        const adapter = new BetfairAdapter({});

        const result = adapter._normalizePlaceOrdersResponse({
            status: 'FAILURE',
            errorCode: 'INSUFFICIENT_FUNDS',
            instructionReports: [{ status: 'FAILURE', errorCode: 'ERROR_IN_ORDER' }],
        }, { oddVal: 2.0 }, 6);

        expect(result).toMatchObject({
            success: false,
            submitReached: true,
            bookmakerRejected: true,
            failureClass: 'insufficient_balance',
            error: 'INSUFFICIENT_FUNDS: ERROR_IN_ORDER',
        });
        expect(adapter.parseError(result)).toMatchObject({ type: 'insufficient_balance' });
    });
});

describe('BetfairClient', () => {
    function jsonResponse(payload, status = 200) {
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
            headers: new Map(),
            text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
        };
    }

    test('sends official JSON-RPC headers and body', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ jsonrpc: '2.0', result: [{ marketId: '1.100' }] }));
        const client = new BetfairClient({
            appKey: 'app-key',
            sessionToken: 'session-token',
            fetchImpl,
        });

        const result = await client.listMarketCatalogue({ filter: {}, maxResults: '1' });

        expect(result).toEqual([{ marketId: '1.100' }]);
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.betfair.com/exchange/betting/json-rpc/v1',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Application': 'app-key',
                    'X-Authentication': 'session-token',
                    'Content-Type': 'application/json',
                }),
            })
        );
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body).toMatchObject({
            jsonrpc: '2.0',
            method: 'SportsAPING/v1.0/listMarketCatalogue',
            params: { filter: {}, maxResults: '1' },
        });
    });

    test('discovers Linux web app key before password login when app key is not configured', async () => {
        const html = '<script>angular.module("EDS.Global").constant("App.environment.CONFIG", {"appKey":{"br":{"Linux":"LINUX_WEB_KEY"},"default":{"EDSKey":"DEFAULT_WEB_KEY"}}});</script>';
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(jsonResponse(html))
            .mockResolvedValueOnce(jsonResponse({ status: 'SUCCESS', token: 'fresh-token' }));
        const client = new BetfairClient({
            fetchImpl,
            appConfigUrl: 'https://www.betfair.com/exchange/plus/football',
        });

        const result = await client.login({ username: 'user', password: 'pass' });

        expect(result).toMatchObject({ status: 'SUCCESS', token: 'fresh-token' });
        expect(client.appKey).toBe('LINUX_WEB_KEY');
        expect(fetchImpl.mock.calls[0][0]).toBe('https://www.betfair.com/exchange/plus/football');
        expect(fetchImpl.mock.calls[1][1].headers['X-Application']).toBe('LINUX_WEB_KEY');
    });

    test('raw Betfair proxy values default to socks5 for client runtime', () => {
        const client = new BetfairClient({
            appKey: 'app-key',
            sessionToken: 'session-token',
            proxyUrl: '127.0.0.1:2080:user:pass',
        });

        expect(client.proxyUrl).toBe('socks5://user:pass@127.0.0.1:2080');
    });

    test('force refresh ignores a stale session token and performs password login', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ status: 'SUCCESS', token: 'fresh-token' }));
        const client = new BetfairClient({
            appKey: 'app-key',
            sessionToken: 'stale-token',
            fetchImpl,
        });

        const result = await client.login({
            username: 'user',
            password: 'pass',
            forceRefresh: true,
        });

        expect(result).toMatchObject({ status: 'SUCCESS', token: 'fresh-token' });
        expect(client.sessionToken).toBe('fresh-token');
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://identitysso.betfair.com/api/login',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Application': 'app-key' }),
                body: 'username=user&password=pass',
            })
        );
    });

    test('adapter refreshes password login after keepAlive marks token invalid', async () => {
        const client = createClient({
            keepAlive: jest.fn(async () => {
                throw new Error('INVALID_SESSION_INFORMATION');
            }),
            login: jest.fn(async () => ({ status: 'SUCCESS', token: 'fresh-token' })),
        });
        const adapter = new BetfairAdapter({ client, appKey: 'app', sessionToken: 'stale-token' });

        await expect(adapter.isSessionValid()).resolves.toBe(false);
        await expect(adapter.login()).resolves.toBe(true);

        expect(client.login).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    });

    test('raises BetfairClientError with APING error details', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({
            jsonrpc: '2.0',
            error: {
                code: -32099,
                data: {
                    exceptionname: 'APINGException',
                    APINGException: {
                        errorCode: 'INVALID_SESSION_INFORMATION',
                        errorDetails: 'token expired',
                    },
                },
            },
        }));
        const client = new BetfairClient({
            appKey: 'app-key',
            sessionToken: 'session-token',
            fetchImpl,
        });

        await expect(client.listMarketBook({ marketIds: ['1.100'] }))
            .rejects
            .toThrow(/APINGException: INVALID_SESSION_INFORMATION: token expired/);
    });
});
