const { TelegramIntakeSession } = require('../telegram/TelegramIntakeSession.js');
const { TelegramSignalParser } = require('../telegram/TelegramSignalParser.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn()
  };
}

describe('TelegramSignalParser v2 facade', () => {
  test('preserves rejected_low_confidence instead of remapping it to match_not_found', async () => {
    const parser = new TelegramSignalParser({
      visionClient: {
        parsePhoto: jest.fn()
      },
      textSignalClient: {
        isReady: () => true,
        parseText: jest.fn(async () => ({
          provider: 'test',
          model: 'mock',
          sport: null,
          home: null,
          away: null,
          league: null,
          score: null,
          isLive: false,
          outcomeRaw: null,
          intent: 'bet',
          confidence: 0.2,
          notes: 'not enough signal text'
        }))
      },
      matchLocator: {
        locate: jest.fn()
      },
      adapter: {
        getCatalog: jest.fn()
      },
      logger: createLogger(),
      lowConfGate: 0.5
    });
    const session = new TelegramIntakeSession({ sessionId: 'low-conf-1', chatId: -1001 });
    session.addMessage({
      messageId: 1,
      chatId: -1001,
      text: 'Prematch',
      timestamp: 1000
    });

    const result = await parser.parseSession(session, { runtimeMode: 'live' });

    expect(result.state).toBe('rejected_low_confidence');
    expect(result.queueDecision).toBe('rejected');
    expect(result.confidence).toBe(0.2);
  });
});
