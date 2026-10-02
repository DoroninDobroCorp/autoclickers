/**
 * Regression tests for tg_review iteration 13 findings.
 *
 * F1 — _saveBetCounters uses atomic tmp+rename write pattern.
 * F2 — _findLatestDraftForAuthor / _findContinuableDraftForAuthor must not
 *      merge anonymous drafts from different sender_chat ids.
 * F3 — _routeMessageToDraft must enforce isSenderAllowed for reply-linked
 *      drafts in feedback chats.
 * F4 — _resolveStopTarget must not blindly target the latest draft when
 *      authorId is null and multiple anonymous drafts exist.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const fsSync = require('fs');
const path = require('path');
const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

const FEEDBACK_CHAT_ID = -1003717712631;
const SOURCE_CHAT_ID = -1002010985531;
const OPERATOR_USER_ID = 7268849307;
const STRANGER_USER_ID = 9999999999;

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

function makeProfile(overrides = {}) {
  return {
    id: 'test-profile',
    liveEnabled: true,
    prematchEnabled: true,
    sourceReadOnly: false,
    sourceChatIds: [SOURCE_CHAT_ID],
    feedbackChatIds: [FEEDBACK_CHAT_ID],
    allowedSenders: [{ userId: OPERATOR_USER_ID }],
    ...overrides
  };
}

// ─── F1: _saveBetCounters atomic write via tmp+rename ────────────────────────

describe('F1 (review_13) — _saveBetCounters atomic write', () => {
  const countersDir = path.join(__dirname, '..', '..', '_test_counters_f1');
  const countersFile = path.join(countersDir, '.bet_counters.json');

  beforeAll(() => {
    fsSync.mkdirSync(countersDir, { recursive: true });
  });

  afterAll(() => {
    try { fsSync.unlinkSync(countersFile); } catch (_) {}
    try { fsSync.unlinkSync(countersFile + '.tmp'); } catch (_) {}
    try { fsSync.rmdirSync(countersDir); } catch (_) {}
  });

  test('writes via tmp+rename pattern (verified in source)', () => {
    const source = fsSync.readFileSync(
      path.join(__dirname, '..', 'integrations', 'telegram-notifier.js'),
      'utf8'
    );
    // The atomic-write pattern: write to tmpPath, then rename tmpPath → final
    expect(source).toMatch(/tmpPath\s*=.*\.tmp/);
    expect(source).toMatch(/writeFileSync\(tmpPath/);
    expect(source).toMatch(/renameSync\(tmpPath/);
  });

  test('_saveBetCounters source uses tmp+rename pattern (not bare writeFileSync)', () => {
    const source = fsSync.readFileSync(
      path.join(__dirname, '..', 'integrations', 'telegram-notifier.js'),
      'utf8'
    );
    const startIdx = source.indexOf('_saveBetCounters()');
    const endIdx = source.indexOf('\n  }', startIdx + 10);
    const saveMethod = source.slice(startIdx, endIdx + 4);
    // Must write to .tmp first
    expect(saveMethod).toContain('.tmp');
    // Must rename .tmp to final path
    expect(saveMethod).toContain('renameSync');
    // Must NOT have a bare writeFileSync to the final path (only to .tmp)
    const writeLines = saveMethod.split('\n').filter(l => l.includes('writeFileSync') && !l.includes('readFileSync'));
    for (const line of writeLines) {
      expect(line).toMatch(/tmp/);
    }
  });
});

// ─── F2: anonymous sender_chat disambiguation ───────────────────────────────

describe('F2 (review_13) — anonymous draft merge prevention via senderChatId', () => {
  let ingress;
  const profile = makeProfile();

  beforeEach(() => {
    ingress = makeIngress();
  });

  test('two anonymous signals from different sender_chat ids should NOT merge', () => {
    // Create draft from channel A (authorId=null, senderChatId=-100A)
    const msg1 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 1001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 5000,
      text: 'Signal from channel A',
      metadata: { senderChatId: -100111 }
    };
    const draftA = ingress._createDraft(msg1, profile);
    ingress._appendMessageToDraft(draftA, msg1);

    // Create draft from channel B (authorId=null, senderChatId=-100B)
    const msg2 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 1002,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 3000,
      text: 'Signal from channel B',
      metadata: { senderChatId: -100222 }
    };
    const draftB = ingress._createDraft(msg2, profile);
    ingress._appendMessageToDraft(draftB, msg2);

    // Look up continuable draft for channel A — should find draftA, not draftB
    const foundA = ingress._findContinuableDraftForAuthor(
      SOURCE_CHAT_ID, null, null, -100111
    );
    expect(foundA).not.toBeNull();
    expect(foundA.id).toBe(draftA.id);

    // Look up continuable draft for channel B — should find draftB
    const foundB = ingress._findContinuableDraftForAuthor(
      SOURCE_CHAT_ID, null, null, -100222
    );
    expect(foundB).not.toBeNull();
    expect(foundB.id).toBe(draftB.id);

    // Look up with a third senderChatId — should find nothing
    const foundC = ingress._findContinuableDraftForAuthor(
      SOURCE_CHAT_ID, null, null, -100333
    );
    expect(foundC).toBeNull();
  });

  test('null authorId + null senderChatId should NOT match any draft', () => {
    const msg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 2001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Anonymous',
      metadata: { senderChatId: -100444 }
    };
    ingress._createDraft(msg, profile);

    const found = ingress._findLatestDraftForAuthor(
      SOURCE_CHAT_ID, null, null, null
    );
    expect(found).toBeNull();
  });
});

// ─── F3: reply-linked draft sender allowlist check ──────────────────────────

describe('F3 (review_13) — _routeMessageToDraft enforces isSenderAllowed for reply-linked drafts', () => {
  test('non-allowlisted user replying to anchor in group feedback chat is rejected', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          cluster_src: {
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

    const ingress = makeIngress({ chatProfileManager: manager });
    const profile = manager.getProfile('cluster_src');

    // Create a draft and index a clarification message in the feedback chat
    const msg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 3001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal text',
      metadata: { senderChatId: SOURCE_CHAT_ID }
    };
    const draft = ingress._createDraft(msg, profile);
    ingress._appendMessageToDraft(draft, msg);
    // Index an anchor message in feedback chat (e.g. bot's clarification)
    ingress._indexClarificationMessage(draft, 5001, FEEDBACK_CHAT_ID, null);

    // Allowed operator replies to anchor — should be routed
    const operatorReply = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 5010,
      authorId: OPERATOR_USER_ID,
      authorUsername: 'operator',
      replyToMessageId: 5001,
      timestamp: Date.now(),
      text: 'OK go',
      metadata: {}
    };
    const routedOp = ingress._routeMessageToDraft(operatorReply, profile);
    expect(routedOp).not.toBeNull();
    expect(routedOp.id).toBe(draft.id);

    // Non-allowlisted stranger replies to same anchor — must be rejected
    const strangerReply = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 5011,
      authorId: STRANGER_USER_ID,
      authorUsername: 'stranger',
      replyToMessageId: 5001,
      timestamp: Date.now(),
      text: 'I want in',
      metadata: {}
    };
    const routedStranger = ingress._routeMessageToDraft(strangerReply, profile);
    expect(routedStranger).toBeNull();
  });
});

// ─── F4: _resolveStopTarget multi-anonymous-draft disambiguation ────────────

describe('F4 (review_13) — _resolveStopTarget multi-anonymous-draft disambiguation', () => {
  let ingress;
  const profile = makeProfile();

  beforeEach(() => {
    ingress = makeIngress();
  });

  test('single anonymous draft → targets it correctly', () => {
    const msg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal',
      metadata: { senderChatId: -100555 }
    };
    ingress._createDraft(msg, profile);

    const stopMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4010,
      authorId: null,
      replyToMessageId: null,
      metadata: {}
    };
    const target = ingress._resolveStopTarget(stopMsg);
    expect(target).not.toBeNull();
  });

  test('multiple anonymous drafts + no replyToMessageId → returns null', () => {
    const msg1 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4101,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 3000,
      text: 'Signal A',
      metadata: { senderChatId: -100666 }
    };
    ingress._createDraft(msg1, profile);

    const msg2 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4102,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 1000,
      text: 'Signal B',
      metadata: { senderChatId: -100777 }
    };
    ingress._createDraft(msg2, profile);

    const stopMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4110,
      authorId: null,
      replyToMessageId: null,
      metadata: {}
    };
    const target = ingress._resolveStopTarget(stopMsg);
    expect(target).toBeNull();

    // Should have logged a warning
    expect(ingress.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('multiple anonymous drafts')
    );
  });

  test('multiple anonymous drafts + replyToMessageId → targets the right one', () => {
    const msg1 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4201,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 3000,
      text: 'Signal A',
      metadata: { senderChatId: -100888 }
    };
    const draftA = ingress._createDraft(msg1, profile);
    ingress._appendMessageToDraft(draftA, msg1);

    const msg2 = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4202,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now() - 1000,
      text: 'Signal B',
      metadata: { senderChatId: -100999 }
    };
    const draftB = ingress._createDraft(msg2, profile);
    ingress._appendMessageToDraft(draftB, msg2);

    // STOP with reply pointing to draftA's message
    const stopMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 4210,
      authorId: null,
      replyToMessageId: 4201,
      metadata: {}
    };
    const target = ingress._resolveStopTarget(stopMsg);
    expect(target).not.toBeNull();
    expect(target.id).toBe(draftA.id);
  });
});
