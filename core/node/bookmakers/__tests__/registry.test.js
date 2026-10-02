const {
  createBookmakerAdapter,
  getRegisteredBookmakerIds,
  normalizeBookmakerId,
} = require('../registry.js');
const { SansabetV2Adapter } = require('../../../../bookmakers/sansabet/node-adapter/SansabetV2Adapter.js');
const { VBetV2Adapter } = require('../../../../bookmakers/vbet/node-adapter/VBetV2Adapter.js');
const { BetfairV2Adapter } = require('../../../../bookmakers/betfair/node-adapter/BetfairV2Adapter.js');

describe('bookmaker v2 adapter registry', () => {
  test('normalizes bookmaker ids consistently', () => {
    expect(normalizeBookmakerId('Sansabet')).toBe('sansabet');
    expect(normalizeBookmakerId('New Bookmaker!')).toBe('new_bookmaker');
  });

  test('creates registered Sansabet v2 adapter without BaseBettor knowing the class', () => {
    const legacyAdapter = {
      bookmakerName: 'Sansabet',
      placeBet: jest.fn(),
      getMatchOdds: jest.fn(),
      getMatchDetails: jest.fn()
    };

    const adapter = createBookmakerAdapter({
      legacyAdapter,
      telegramConfig: {
        analyzerLiveUrl: 'http://127.0.0.1/live',
        analyzerPrematchUrl: 'http://127.0.0.1/prematch'
      },
      logger: { log: jest.fn(), error: jest.fn() }
    });

    expect(adapter).toBeInstanceOf(SansabetV2Adapter);
    expect(adapter.bookmakerId).toBe('sansabet');
    expect(adapter.liveUrl).toBe('http://127.0.0.1/live');
    expect(adapter.prematchUrl).toBe('http://127.0.0.1/prematch');
    expect(getRegisteredBookmakerIds()).toContain('sansabet');
  });

  test('creates registered VBet v2 adapter without parser-specific branches', () => {
    const legacyAdapter = {
      bookmakerName: 'VBet',
      getCatalog: jest.fn(),
      getMatchOdds: jest.fn(),
      getMatchDetails: jest.fn(),
      findOutcome: jest.fn(),
      placeBet: jest.fn()
    };

    const adapter = createBookmakerAdapter({
      legacyAdapter,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    expect(adapter).toBeInstanceOf(VBetV2Adapter);
    expect(adapter.bookmakerId).toBe('vbet');
    expect(getRegisteredBookmakerIds()).toContain('vbet');
  });

  test('creates registered Betfair v2 adapter without parser-specific branches', () => {
    const legacyAdapter = {
      bookmakerName: 'Betfair',
      getCatalog: jest.fn(),
      getMatchOdds: jest.fn(),
      getMatchDetails: jest.fn(),
      findOutcome: jest.fn(),
      placeBet: jest.fn()
    };

    const adapter = createBookmakerAdapter({
      legacyAdapter,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    expect(adapter).toBeInstanceOf(BetfairV2Adapter);
    expect(adapter.bookmakerId).toBe('betfair');
    expect(getRegisteredBookmakerIds()).toContain('betfair');
  });

  test('uses explicit configured adapter before registry lookup', () => {
    const explicit = { bookmakerId: 'custom', getCatalog: jest.fn() };

    expect(createBookmakerAdapter({
      telegramConfig: { bookmakerAdapter: explicit }
    })).toBe(explicit);
  });

  test('throws actionable error for unregistered bookmaker', () => {
    expect(() => createBookmakerAdapter({
      legacyAdapter: { bookmakerName: 'MysteryBook' }
    })).toThrow(/No v2 bookmaker adapter registered for "mysterybook"/);
  });
});
