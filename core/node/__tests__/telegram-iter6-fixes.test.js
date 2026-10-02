/**
 * Regression tests for tg_review iteration 6 finding F1.
 *
 * F1 — The review_5 feedback-chat STOP re-auth path silently regresses to the
 *      review_4 fail-closed gate when the source draft has `authorId === null`
 *      (Telegram channel-post shape feeding the live `vova_cluster` /
 *      `supernova_cluster` profiles). Operators on the feedback-chat
 *      allowlist must be able to STOP such queued cluster drafts; the gate
 *      must be keyed off the resolved feedback-chat profile (`authProfile`)
 *      rather than the cluster source profile (`draftProfile`). Source-chat
 *      side STOPs keep the existing fail-closed semantics — no privilege
 *      escalation from the anonymous source chat.
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
    getUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async () => ({ ok: true, result: { message_id: 9001 } })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true }))
  };
}

const FEEDBACK_CHAT_ID = -1003717712631;
const SOURCE_CHAT_ID = -1002010985531;
const OPERATOR_USER_ID = 7268849307;
const STRANGER_USER_ID = 99999;

function buildProfileManager() {
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        default: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceChatIds: [FEEDBACK_CHAT_ID],
          feedbackChatIds: [FEEDBACK_CHAT_ID],
          allowedSenders: [{ userId: OPERATOR_USER_ID }]
        },
        vova_cluster: {
          liveEnabled: true,
          prematchEnabled: true,
          clusterId: 'vova',
          sourceReadOnly: true,
          sourceChatIds: [SOURCE_CHAT_ID],
          feedbackChatIds: [FEEDBACK_CHAT_ID]
        }
      }
    }
  });
}

function buildIngress(mgr, { onStopSignal } = {}) {
  return new TelegramPollingIngress({
    botClient: createBotClient(),
    chatProfileManager: mgr,
    signalParser: {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'stop', confidence: 0.99 })),
      parseSession: jest.fn()
    },
    logger: createLogger(),
    bookmakerName: 'Sansabet',
    bookmakerId: 'sansabet',
    runtimeMode: 'live',
    defaultProfileId: 'default',
    onStopSignal: onStopSignal || jest.fn(async () => ({ accepted: true, cancelled: true }))
  });
}

function buildAnonymousClusterDraft(profile, overrides = {}) {
  return {
    id: 'sig-cluster-anon-1',
    profile,
    authorId: null,
    session: {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      toLLMPayload: () => ({ messageIds: [] })
    },
    indexedMessageIds: new Set(),
    indexedClarificationMessageIds: new Set(),
    taskId: 'task-cluster-anon-1',
    taskState: 'queued',
    ...overrides
  };
}

describe('F1 (review_6) — anonymous-author cluster drafts: feedback-chat STOP re-auth', () => {
  test('operator reply-STOP in feedback chat cancels anonymous-author cluster draft', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildAnonymousClusterDraft(clusterProfile);
    ingress.activeDrafts.set(draft.id, draft);

    const indexed = ingress.indexTaskAnchorMessage(draft.id, {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 4242
    });
    expect(indexed).toBe(true);

    const sentMessages = [];
    ingress._sendSourceChatMessage = jest.fn(async (_, text) => {
      sentMessages.push(text);
      return { ok: true, result: { message_id: 1 } };
    });

    await ingress._handleStopMessage(
      {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 9200,
        replyToMessageId: 4242,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).toHaveBeenCalledTimes(1);
    expect(sentMessages.some(t => /остановлен/i.test(t))).toBe(true);
    expect(sentMessages.some(t => /источник анонимный/.test(t))).toBe(false);
    expect(sentMessages.some(t => /только автору/.test(t))).toBe(false);
  });

  test('stranger reply-STOP in feedback chat is rejected for anonymous-author cluster draft', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildAnonymousClusterDraft(clusterProfile);
    ingress.activeDrafts.set(draft.id, draft);
    ingress.indexTaskAnchorMessage(draft.id, {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 4242
    });

    const sentMessages = [];
    ingress._sendSourceChatMessage = jest.fn(async (_, text) => {
      sentMessages.push(text);
      return { ok: true, result: { message_id: 1 } };
    });

    await ingress._handleStopMessage(
      {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 9201,
        replyToMessageId: 4242,
        authorId: STRANGER_USER_ID,
        authorUsername: 'rando'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).not.toHaveBeenCalled();
    expect(sentMessages.some(t => /источник анонимный/.test(t))).toBe(true);
  });

  test('source-chat STOP on anonymous-author cluster draft remains fail-closed (no privilege escalation)', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildAnonymousClusterDraft(clusterProfile);
    ingress.activeDrafts.set(draft.id, draft);

    const sentMessages = [];
    ingress._sendSourceChatMessage = jest.fn(async (_, text) => {
      sentMessages.push(text);
      return { ok: true, result: { message_id: 1 } };
    });
    // Resolve any STOP in the source chat to this draft.
    ingress._resolveStopTarget = () => draft;

    // Even the operator allow-listed on `default` must be rejected when the
    // STOP arrives in the cluster source chat — cluster profile has no
    // allowedSenders and we never re-auth in the source-chat path.
    await ingress._handleStopMessage(
      {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 9202,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).not.toHaveBeenCalled();
    expect(sentMessages.some(t => /источник анонимный/.test(t))).toBe(true);
  });
});
