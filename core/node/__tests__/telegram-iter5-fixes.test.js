/**
 * Regression tests for tg_review iteration 5 finding F1.
 *
 * F1 — STOP-by-reply on enqueue/lifecycle anchors must work when an operator
 *      replies in a feedback chat to a sourceReadOnly cluster bet. The
 *      cluster source profile has no allowedSenders by design; authorisation
 *      must therefore re-resolve against the feedback chat's governing
 *      profile (e.g. testbets `default` profile with its own allowlist).
 *      Strangers must still be rejected; existing source-chat fail-closed
 *      semantics for cluster profiles remain.
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
        // Feedback-chat profile: explicit operator allowlist.
        default: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceChatIds: [FEEDBACK_CHAT_ID],
          feedbackChatIds: [FEEDBACK_CHAT_ID],
          allowedSenders: [{ userId: OPERATOR_USER_ID }]
        },
        // Cluster source profile mirrors live vova_cluster: sourceReadOnly,
        // feedbackChatIds set, NO allowedSenders.
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

function buildClusterDraft(profile, overrides = {}) {
  return {
    id: 'sig-cluster-1',
    profile,
    authorId: null,
    session: {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      toLLMPayload: () => ({ messageIds: [] })
    },
    indexedMessageIds: new Set(),
    indexedClarificationMessageIds: new Set(),
    taskId: 'task-cluster-1',
    taskState: 'queued',
    ...overrides
  };
}

describe('F1 (review_5) — feedback-chat STOP re-auth on sourceReadOnly cluster drafts', () => {
  test('preconditions: cluster profile has no allowlist; default profile has operator allowlist', () => {
    const mgr = buildProfileManager();
    const cluster = mgr.getProfile('vova_cluster');
    const def = mgr.getProfile('default');
    expect(cluster.sourceReadOnly).toBe(true);
    expect(cluster.hasSenderAllowlist).toBe(false);
    expect(def.hasSenderAllowlist).toBe(true);
    expect(mgr.isSenderAllowed(def, { authorId: OPERATOR_USER_ID })).toBe(true);
    expect(mgr.isSenderAllowed(def, { authorId: STRANGER_USER_ID })).toBe(false);
  });

  test('operator reply-STOP in feedback chat to bot anchor cancels cluster draft', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildClusterDraft(clusterProfile, { authorId: 555 });
    ingress.activeDrafts.set(draft.id, draft);

    // Notifier published the "🟡 TG СИГНАЛ В ОЧЕРЕДИ" notice in the feedback
    // chat and indexed the anchor msgId → draft (mirrors the F2 path).
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
    ingress._archiveDraft = jest.fn();

    // Operator replies STOP in the feedback chat to the bot's anchor msg.
    await ingress._handleStopMessage(
      {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 9100,
        replyToMessageId: 4242,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).toHaveBeenCalledTimes(1);
    expect(sentMessages.some(t => /остановлен/i.test(t))).toBe(true);
    expect(sentMessages.some(t => /только автору/.test(t))).toBe(false);
    expect(sentMessages.some(t => /allowlist/.test(t))).toBe(false);
  });

  test('stranger reply-STOP in feedback chat is rejected', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildClusterDraft(clusterProfile, { authorId: 555 });
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
        messageId: 9101,
        replyToMessageId: 4242,
        authorId: STRANGER_USER_ID,
        authorUsername: 'rando'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).not.toHaveBeenCalled();
    expect(sentMessages.some(t => /только автору/.test(t))).toBe(true);
  });

  test('source-chat STOP from a stranger on cluster profile remains fail-closed', async () => {
    const mgr = buildProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = buildIngress(mgr, { onStopSignal });
    const clusterProfile = mgr.getProfile('vova_cluster');
    const draft = buildClusterDraft(clusterProfile, { authorId: 555 });
    ingress.activeDrafts.set(draft.id, draft);

    const sentMessages = [];
    ingress._sendSourceChatMessage = jest.fn(async (_, text) => {
      sentMessages.push(text);
      return { ok: true, result: { message_id: 1 } };
    });
    // Force resolution to the cluster draft for any STOP message.
    ingress._resolveStopTarget = () => draft;

    // Even the operator (allowlisted only on `default`) must be rejected
    // when the STOP arrives directly in the cluster source chat — the
    // cluster profile has no allowedSenders and we never re-auth in the
    // source-chat path.
    await ingress._handleStopMessage(
      {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 9102,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator'
      },
      clusterProfile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).not.toHaveBeenCalled();
    expect(sentMessages.some(t => /только автору/.test(t))).toBe(true);
  });
});
