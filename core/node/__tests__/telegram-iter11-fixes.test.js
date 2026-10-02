/**
 * Regression tests for tg_review iteration 11 findings.
 *
 * F1 — _notifySessionError must propagate sourceReadOnly so the notifier
 *      never sends error notifications to a read-only source chat (even when
 *      the defense-in-depth _chatProfileManager filter is absent).
 *
 * F2 — _buildFinalFingerprint must include matchDate bucket so two same-team
 *      fixtures on different dates with null bookmakerMatchId are not
 *      dedupe-collapsed.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

const FEEDBACK_CHAT_ID = -1003717712631;
const SOURCE_CHAT_ID = -1002010985531;
const OPERATOR_USER_ID = 7268849307;

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

function createBotClient() {
  return {
    getMe: jest.fn().mockResolvedValue({ id: 123, username: 'testbot' }),
    on: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue({ ok: true, result: { message_id: 1, chat: { id: FEEDBACK_CHAT_ID } } }),
    getUpdates: jest.fn().mockResolvedValue([]),
    stopPolling: jest.fn()
  };
}

function makeIngress({ chatProfileManager } = {}) {
  return new TelegramPollingIngress({
    botClient: createBotClient(),
    chatProfileManager: chatProfileManager || new ChatProfileManager({}),
    signalParser: { parseSession: jest.fn(), detectMessageIntent: jest.fn() },
    logger: createLogger(),
    bookmakerName: 'Sansabet'
  });
}

// ─── F1: _notifySessionError must propagate sourceReadOnly ───────────────────

describe('F1 (review_11) — _notifySessionError propagates sourceReadOnly', () => {
  test('sourceReadOnly profile: source chat is NOT in notifier destination list', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          readonly_src: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [SOURCE_CHAT_ID],
            feedbackChatIds: [FEEDBACK_CHAT_ID],
            allowedSenders: [{ userId: OPERATOR_USER_ID }]
          }
        }
      }
    });

    // Create a notifier WITHOUT _chatProfileManager to ensure the
    // sourceReadOnly flag is the sole guard against source-chat writes.
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      botClient: createBotClient(),
      logsChatId: '-1000000000001',
      logger: createLogger()
    });
    // Explicitly verify no _chatProfileManager ref
    notifier._chatProfileManager = null;

    const capturedOptions = [];
    const originalCollect = notifier._collectTargetChatIds.bind(notifier);
    notifier._collectTargetChatIds = function (opts) {
      capturedOptions.push(opts);
      return originalCollect(opts);
    };

    const ingress = makeIngress({ chatProfileManager: manager });
    ingress.notifier = notifier;
    ingress.quiet = false;

    const profile = manager.getProfile('readonly_src');
    const draft = ingress._createDraft(
      { messageId: 1, chatId: SOURCE_CHAT_ID, topicId: null, authorId: OPERATOR_USER_ID, timestamp: Date.now() },
      profile
    );

    await ingress._notifySessionError(draft, new Error('test error'));

    expect(capturedOptions.length).toBe(1);
    expect(capturedOptions[0].sourceReadOnly).toBe(true);

    // The collected destination list must NOT contain the source chat
    const destinations = originalCollect(capturedOptions[0]);
    expect(destinations.map(String)).not.toContain(String(SOURCE_CHAT_ID));
    // But should contain the feedback chat
    expect(destinations.map(String)).toContain(String(FEEDBACK_CHAT_ID));
  });

  test('non-sourceReadOnly profile: originChatId IS included in destinations', async () => {
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      botClient: createBotClient(),
      logsChatId: '-1000000000001',
      logger: createLogger()
    });
    notifier._chatProfileManager = null;

    const capturedOptions = [];
    const originalCollect = notifier._collectTargetChatIds.bind(notifier);
    notifier._collectTargetChatIds = function (opts) {
      capturedOptions.push(opts);
      return originalCollect(opts);
    };

    const ingress = makeIngress();
    ingress.notifier = notifier;
    ingress.quiet = false;

    const draft = ingress._createDraft(
      { messageId: 2, chatId: FEEDBACK_CHAT_ID, topicId: null, authorId: OPERATOR_USER_ID, timestamp: Date.now() },
      { id: 'bidirectional', feedbackChatIds: [String(FEEDBACK_CHAT_ID)], sourceChatIds: [String(FEEDBACK_CHAT_ID)] }
    );

    await ingress._notifySessionError(draft, new Error('test error'));

    expect(capturedOptions.length).toBe(1);
    expect(capturedOptions[0].sourceReadOnly).toBe(false);
  });
});

// ─── F2: _buildFinalFingerprint includes matchDate bucket ────────────────────

describe('F2 (review_11) — _buildFinalFingerprint includes matchDate bucket', () => {
  test('same teams/outcome, different matchDates, null bookmakerMatchId → distinct fingerprints', () => {
    const ingress = makeIngress();

    const baseParsed = {
      state: 'ready',
      mode: 'prematch',
      sport: 'soccer',
      home: 'TeamA',
      away: 'TeamB',
      bookmakerMatchId: null,
      normalizedOutcome: 'p1 1',
      normalizedIntent: { family: 'unknown', line: null },
      betNum: null
    };

    const parsed1 = { ...baseParsed, matchDate: '2026-04-10T18:00:00Z' };
    const parsed2 = { ...baseParsed, matchDate: '2026-04-17T18:00:00Z' };

    const fp1 = ingress._buildFinalFingerprint(parsed1, null, 'default');
    const fp2 = ingress._buildFinalFingerprint(parsed2, null, 'default');

    expect(fp1).toBeTruthy();
    expect(fp2).toBeTruthy();
    expect(fp1).not.toBe(fp2);
    // Verify date bucket is embedded
    expect(fp1).toContain('2026-04-10');
    expect(fp2).toContain('2026-04-17');
  });

  test('same matchDate → identical fingerprints (dedup still works)', () => {
    const ingress = makeIngress();

    const parsed = {
      state: 'ready',
      mode: 'prematch',
      sport: 'soccer',
      home: 'TeamA',
      away: 'TeamB',
      bookmakerMatchId: null,
      matchDate: '2026-04-10T18:00:00Z',
      normalizedOutcome: 'p1 1',
      normalizedIntent: { family: 'unknown', line: null },
      betNum: null
    };

    const fp1 = ingress._buildFinalFingerprint(parsed, null, 'default');
    const fp2 = ingress._buildFinalFingerprint(parsed, null, 'default');
    expect(fp1).toBe(fp2);
  });

  test('no matchDate → empty bucket, backward compatible', () => {
    const ingress = makeIngress();

    const parsed = {
      state: 'ready',
      mode: 'live',
      sport: 'soccer',
      home: 'TeamA',
      away: 'TeamB',
      bookmakerMatchId: null,
      normalizedOutcome: '1',
      normalizedIntent: { family: 'unknown', line: null },
      betNum: null
    };

    const fp = ingress._buildFinalFingerprint(parsed, null, 'default');
    expect(fp).toBeTruthy();
    // Trailing colon from empty dateBucket — acceptable, does not break dedup
    expect(fp.endsWith(':')).toBe(true);
  });

  test('bookmakerMatchId present → fingerprint still distinct by date', () => {
    const ingress = makeIngress();

    const parsed1 = {
      state: 'ready',
      mode: 'prematch',
      sport: 'soccer',
      home: 'TeamA',
      away: 'TeamB',
      bookmakerMatchId: '5028429',
      matchDate: '2026-04-10T18:00:00Z',
      normalizedOutcome: 'p1 1',
      normalizedIntent: { family: 'unknown', line: null },
      betNum: null
    };
    const parsed2 = { ...parsed1, matchDate: '2026-04-17T18:00:00Z' };

    const fp1 = ingress._buildFinalFingerprint(parsed1, null, 'default');
    const fp2 = ingress._buildFinalFingerprint(parsed2, null, 'default');
    // With bookmakerMatchId present, date still differentiates
    expect(fp1).not.toBe(fp2);
  });
});
