/**
 * Regression tests for tg_review iteration 12 findings.
 *
 * F1 — _buildFinalFingerprint must not throw RangeError on truthy but
 *      unparseable matchDate values (e.g. "tomorrow", "2pm", malformed ISO).
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

function createBotClient() {
  return {
    getMe: jest.fn().mockResolvedValue({ id: 123, username: 'testbot' }),
    on: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue({ ok: true, result: { message_id: 1, chat: { id: -1003717712631 } } }),
    getUpdates: jest.fn().mockResolvedValue([]),
    stopPolling: jest.fn()
  };
}

function makeIngress() {
  return new TelegramPollingIngress({
    botClient: createBotClient(),
    chatProfileManager: new ChatProfileManager({}),
    signalParser: { parseSession: jest.fn(), detectMessageIntent: jest.fn() },
    logger: createLogger(),
    bookmakerName: 'Sansabet'
  });
}

function baseParsed(overrides = {}) {
  return {
    state: 'ready',
    home: 'TeamA',
    away: 'TeamB',
    mode: 'live',
    sport: 'soccer',
    normalizedOutcome: '1',
    normalizedIntent: { family: 'moneyline', line: null },
    betNum: 1,
    ...overrides
  };
}

// ─── F1: _buildFinalFingerprint handles unparseable matchDate ────────────────

describe('F1 (review_12) — _buildFinalFingerprint unparseable matchDate', () => {
  let ingress;

  beforeAll(() => {
    ingress = makeIngress();
  });

  test.each([
    'tomorrow',
    '2pm',
    'not-a-date',
    'June maybe',
    '2025-13-45',
    '???'
  ])('does NOT throw on unparseable matchDate "%s" and returns a fingerprint', (badDate) => {
    const parsed = baseParsed({ matchDate: badDate });
    let fp;
    expect(() => {
      fp = ingress._buildFinalFingerprint(parsed, null, 'default');
    }).not.toThrow();
    expect(fp).toBeTruthy();
    expect(typeof fp).toBe('string');
    expect(fp).toMatch(/^final:/);
    // dateBucket portion should be empty for unparseable dates
    const parts = fp.replace('final:', '').split(':');
    const dateBucketPart = parts[parts.length - 1];
    expect(dateBucketPart).toBe('');
  });

  test('still produces correct dateBucket for valid ISO date', () => {
    const parsed = baseParsed({ matchDate: '2025-07-15T18:00:00Z' });
    const fp = ingress._buildFinalFingerprint(parsed, null, 'default');
    expect(fp).toMatch(/2025-07-15/);
  });

  test('still produces empty dateBucket when matchDate is falsy', () => {
    const parsed = baseParsed({ matchDate: null });
    const fp = ingress._buildFinalFingerprint(parsed, null, 'default');
    expect(fp).toBeTruthy();
    // last segment empty
    expect(fp.endsWith(':')).toBe(true);
  });
});
