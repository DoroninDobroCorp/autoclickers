/**
 * Regression tests for tg_review iteration 9 findings on the Telegram-source
 * betting contour.
 *
 * F1 — feedback-chat-only DM (live `default` profile shape with
 *      sourceChatIds=[TESTBETS], feedbackChatIds=[ELENA DM]) must resolve to
 *      the operator's profile so STOP and free-text uplift handlers actually
 *      run. Strangers (no profile match) must still be rejected.
 * F2 — chat-level "do-not-write" invariant. Any chat that is in any enabled
 *      profile's sourceChatIds/sourceTargets must be filtered out of the
 *      destination list, even when task.telegramContext.sourceReadOnly is
 *      false. Defense-in-depth on top of the per-task flag.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

const TESTBETS_GROUP_ID = -1003717712631;
const ELENA_USER_ID = 7268849307;
const STRANGER_USER_ID = 99999;
const CLUSTER_SOURCE_CHAT_ID = -1002010985531;

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

function createBotClient() {
  return {
    getUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async () => ({ ok: true, result: { message_id: 9001 } })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true }))
  };
}

function buildLiveLikeManager() {
  // Mirrors the production sansabet-tgshot-launcher.js shape:
  // sourceChatIds=[TESTBETS], feedbackChatIds=[ELENA DM].
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        default: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceChatIds: [TESTBETS_GROUP_ID],
          feedbackChatIds: [ELENA_USER_ID],
          allowedSenders: [{ userId: ELENA_USER_ID }]
        }
      }
    }
  });
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

describe('F1 (review_9) — feedback-chat DM resolves to operator profile (live default shape)', () => {
  test('operator DM message in feedback-only chat resolves to default profile', () => {
    const manager = buildLiveLikeManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    const message = {
      messageId: 1,
      chatId: ELENA_USER_ID,
      topicId: null,
      authorId: ELENA_USER_ID,
      text: 'STOP'
    };
    const profile = ingress._resolveProfileForMessage(message);
    expect(profile).toBeTruthy();
    expect(profile.id).toBe('default');
  });

  test('stranger DM (not in allowedSenders) is rejected — no profile match', () => {
    const manager = buildLiveLikeManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    const message = {
      messageId: 2,
      chatId: ELENA_USER_ID,
      topicId: null,
      authorId: STRANGER_USER_ID,
      text: 'STOP'
    };
    const profile = ingress._resolveProfileForMessage(message);
    expect(profile).toBeNull();
  });

  test('operator DM reply-STOP is handled (not silently dropped at the front door)', async () => {
    const manager = buildLiveLikeManager();
    const ingress = makeIngress({ chatProfileManager: manager });

    // Stub intent detection to declare STOP without invoking LLMs.
    ingress.signalParser.detectMessageIntent = jest.fn(async () => ({
      intentType: 'stop', confidence: 1.0, notes: 'test'
    }));

    // Seed a draft owned by the default profile — the operator's "queued"
    // signal that the STOP reply targets. We index its anchor message id in
    // the feedback chat so _resolveStopTarget can find it via reply linkage.
    const profile = manager.getProfile('default');
    const anchor = {
      messageId: 1001,
      chatId: TESTBETS_GROUP_ID,
      topicId: null,
      authorId: ELENA_USER_ID,
      timestamp: Date.now()
    };
    const draft = ingress._createDraft(anchor, profile);
    draft.taskId = 'task-stop-target';
    draft.taskState = 'queued';
    draft.session.lastUpdatedAt = Date.now();
    // Anchor in the feedback chat (queued notice id) — STOP reply targets it.
    ingress._indexClarificationMessage(draft, 7777, ELENA_USER_ID, null);

    const stopMsg = {
      messageId: 9000,
      chatId: ELENA_USER_ID,
      topicId: null,
      authorId: ELENA_USER_ID,
      replyToMessageId: 7777,
      text: 'STOP'
    };

    const stopSpy = jest.spyOn(ingress, '_handleStopMessage').mockImplementation(async () => {});
    await ingress._handleMessage(stopMsg);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy.mock.calls[0][0]).toBe(stopMsg);
    stopSpy.mockRestore();
  });

  test('stranger DM STOP is dropped — _handleStopMessage never invoked', async () => {
    const manager = buildLiveLikeManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    ingress.signalParser.detectMessageIntent = jest.fn(async () => ({
      intentType: 'stop', confidence: 1.0, notes: 'test'
    }));
    const stopSpy = jest.spyOn(ingress, '_handleStopMessage').mockImplementation(async () => {});
    await ingress._handleMessage({
      messageId: 9001,
      chatId: ELENA_USER_ID,
      topicId: null,
      authorId: STRANGER_USER_ID,
      replyToMessageId: 7777,
      text: 'STOP'
    });
    expect(stopSpy).not.toHaveBeenCalled();
    stopSpy.mockRestore();
  });

  test('operator DM free-text "пакет 50" attaches to the awaiting draft', () => {
    const manager = buildLiveLikeManager();
    const ingress = makeIngress({ chatProfileManager: manager });

    const profile = manager.getProfile('default');
    const anchor = {
      messageId: 2001,
      chatId: TESTBETS_GROUP_ID,
      topicId: null,
      authorId: ELENA_USER_ID,
      timestamp: Date.now()
    };
    const draft = ingress._createDraft(anchor, profile);
    draft.clarification = { awaitingText: true, type: 'outcome', options: [] };
    // Index a clarification anchor message in the feedback chat that the
    // operator's free-text reply targets.
    ingress._indexClarificationMessage(draft, 8888, ELENA_USER_ID, null);
    draft.session.lastUpdatedAt = Date.now();

    const freeText = {
      messageId: 9100,
      chatId: ELENA_USER_ID,
      topicId: null,
      authorId: ELENA_USER_ID,
      replyToMessageId: 8888,
      text: 'пакет 50'
    };

    const resolvedProfile = ingress._resolveProfileForMessage(freeText);
    expect(resolvedProfile).toBeTruthy();
    expect(resolvedProfile.id).toBe('default');

    const routed = ingress._routeMessageToDraft(freeText, resolvedProfile);
    expect(routed).toBe(draft);
  });
});

describe('F2 (review_9) — chat-level do-not-write invariant', () => {
  test('ChatProfileManager.getKnownSourceChatIds aggregates across enabled sourceReadOnly profiles', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          default: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [TESTBETS_GROUP_ID],
            feedbackChatIds: [ELENA_USER_ID],
            allowedSenders: [{ userId: ELENA_USER_ID }]
          },
          vova_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            clusterId: 'vova',
            sourceReadOnly: true,
            sourceChatIds: [CLUSTER_SOURCE_CHAT_ID],
            feedbackChatIds: [ELENA_USER_ID]
          }
        }
      }
    });
    const known = manager.getKnownSourceChatIds();
    expect(known.has(String(TESTBETS_GROUP_ID))).toBe(true);
    expect(known.has(String(CLUSTER_SOURCE_CHAT_ID))).toBe(true);
    // Feedback-only chat must NOT be in the protected set.
    expect(known.has(String(ELENA_USER_ID))).toBe(false);
  });

  test('_collectTargetChatIds filters out source chat from sourceReadOnly profile', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          default: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [TESTBETS_GROUP_ID],
            feedbackChatIds: [ELENA_USER_ID],
            allowedSenders: [{ userId: ELENA_USER_ID }]
          }
        }
      }
    });

    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000000000001'
    });
    notifier.setChatProfileManager(manager);

    // Forge the routing options the way _getRoutingOptionsForTask would
    // produce them for a (regressed) Telegram task whose sourceReadOnly flag
    // is false: originChatId is the upstream signal chat.
    const fakeTask = {
      telegramContext: {
        sourceReadOnly: false,
        originChatId: TESTBETS_GROUP_ID,
        feedbackChatIds: [ELENA_USER_ID]
      }
    };
    const routing = notifier._getRoutingOptionsForTask(fakeTask, 'Sansabet');
    expect(routing.sourceReadOnly).toBe(false);
    expect(routing.originChatId).toBe(TESTBETS_GROUP_ID);

    const dest = notifier._collectTargetChatIds(routing);
    // The upstream signal chat must be filtered out by the chat-level
    // invariant, regardless of the per-task sourceReadOnly flag.
    expect(dest).not.toContain(String(TESTBETS_GROUP_ID));
    // The feedback chat (operator DM) is still a valid destination.
    expect(dest).toContain(String(ELENA_USER_ID));
  });

  test('explicit allowSourceChatWrite:true bypass is honoured (not used in production)', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          default: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [TESTBETS_GROUP_ID],
            feedbackChatIds: [ELENA_USER_ID],
            allowedSenders: [{ userId: ELENA_USER_ID }]
          }
        }
      }
    });
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000000000001'
    });
    notifier.setChatProfileManager(manager);

    const dest = notifier._collectTargetChatIds({
      chatIds: [TESTBETS_GROUP_ID, ELENA_USER_ID],
      allowSourceChatWrite: true
    });
    expect(dest).toContain(String(TESTBETS_GROUP_ID));
    expect(dest).toContain(String(ELENA_USER_ID));
  });

  test('without ChatProfileManager wired, behaviour is unchanged (back-compat)', () => {
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000000000001'
    });
    const dest = notifier._collectTargetChatIds({
      chatIds: [TESTBETS_GROUP_ID, ELENA_USER_ID]
    });
    expect(dest).toContain(String(TESTBETS_GROUP_ID));
    expect(dest).toContain(String(ELENA_USER_ID));
  });
});
