/**
 * Regression tests for tg_review iteration 15 findings.
 *
 * F1 — Reply-linkage text-auth asymmetry for cluster profiles.
 *      _routeMessageToDraft and _findClusterDraftViaFeedbackChat must resolve
 *      the auth profile from the feedback-chat governing profile when the
 *      cluster profile is sourceReadOnly and has no allowedSenders.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');

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

/**
 * Build a ChatProfileManager with a multi-profile cluster setup:
 *  - cluster_src: sourceReadOnly, NO allowedSenders (hasSenderAllowlist=false)
 *  - feedback_default: normal profile covering the feedback chat, with allowedSenders
 */
function makeClusterProfileManager() {
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        cluster_src: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceReadOnly: true,
          sourceChatIds: [SOURCE_CHAT_ID],
          feedbackChatIds: [FEEDBACK_CHAT_ID]
          // No allowedSenders → hasSenderAllowlist = false
        },
        feedback_default: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceReadOnly: false,
          sourceChatIds: [FEEDBACK_CHAT_ID],
          feedbackChatIds: [FEEDBACK_CHAT_ID],
          allowedSenders: [{ userId: OPERATOR_USER_ID }]
        }
      }
    }
  });
}

function makeIngress(chatProfileManager) {
  return new TelegramPollingIngress({
    botClient: createBotClient(),
    chatProfileManager,
    signalParser: { parseSession: jest.fn(), detectMessageIntent: jest.fn() },
    logger: createLogger(),
    bookmakerName: 'Sansabet'
  });
}

// ─── F1: _routeMessageToDraft cluster auth via feedback profile ──────────────

describe('F1 (review_15) — _routeMessageToDraft resolves feedback-chat auth profile for sourceReadOnly cluster drafts', () => {
  let manager;
  let ingress;
  let clusterProfile;

  beforeEach(() => {
    manager = makeClusterProfileManager();
    ingress = makeIngress(manager);
    clusterProfile = manager.getProfile('cluster_src');
  });

  test('operator reply to cluster draft via feedback chat is authorized via feedback profile', () => {
    // Cluster profile must have no allowedSenders
    expect(clusterProfile.hasSenderAllowlist).toBe(false);

    // Create a draft on the sourceReadOnly cluster profile
    const signalMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 8001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal text',
      metadata: { senderChatId: SOURCE_CHAT_ID }
    };
    const draft = ingress._createDraft(signalMsg, clusterProfile);
    ingress._appendMessageToDraft(draft, signalMsg);

    // Index a clarification anchor in the feedback chat
    ingress._indexClarificationMessage(draft, 9001, FEEDBACK_CHAT_ID, null);

    // Operator replies to the anchor from the feedback chat
    const operatorReply = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 9010,
      authorId: OPERATOR_USER_ID,
      authorUsername: 'operator',
      replyToMessageId: 9001,
      timestamp: Date.now(),
      text: 'Confirmed',
      metadata: {}
    };

    // The feedback_default profile covers FEEDBACK_CHAT_ID and has the operator allowed
    const feedbackProfile = manager.getProfile('feedback_default');
    expect(feedbackProfile.hasSenderAllowlist).toBe(true);

    const routed = ingress._routeMessageToDraft(operatorReply, feedbackProfile);
    expect(routed).not.toBeNull();
    expect(routed.id).toBe(draft.id);
  });

  test('unauthorized user reply to cluster draft via feedback chat is rejected', () => {
    const signalMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 8101,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal text',
      metadata: { senderChatId: SOURCE_CHAT_ID }
    };
    const draft = ingress._createDraft(signalMsg, clusterProfile);
    ingress._appendMessageToDraft(draft, signalMsg);
    ingress._indexClarificationMessage(draft, 9101, FEEDBACK_CHAT_ID, null);

    const strangerReply = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 9110,
      authorId: STRANGER_USER_ID,
      authorUsername: 'stranger',
      replyToMessageId: 9101,
      timestamp: Date.now(),
      text: 'I want in',
      metadata: {}
    };

    const feedbackProfile = manager.getProfile('feedback_default');
    const routed = ingress._routeMessageToDraft(strangerReply, feedbackProfile);
    expect(routed).toBeNull();
  });
});

// ─── F1: _findClusterDraftViaFeedbackChat cluster auth via feedback profile ──

describe('F1 (review_15) — _findClusterDraftViaFeedbackChat resolves feedback-chat auth profile', () => {
  let manager;
  let ingress;
  let clusterProfile;

  beforeEach(() => {
    manager = makeClusterProfileManager();
    ingress = makeIngress(manager);
    clusterProfile = manager.getProfile('cluster_src');
  });

  test('operator fresh message in feedback chat authorized via feedback profile routes to awaiting cluster draft', () => {
    expect(clusterProfile.hasSenderAllowlist).toBe(false);

    const signalMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 7001,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal',
      metadata: { senderChatId: SOURCE_CHAT_ID }
    };
    const draft = ingress._createDraft(signalMsg, clusterProfile);
    ingress._appendMessageToDraft(draft, signalMsg);

    // Set clarification with awaitingText (required by _findClusterDraftViaFeedbackChat)
    draft.clarification = { awaitingText: true, prompt: 'Which team?' };

    const operatorMsg = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 7010,
      authorId: OPERATOR_USER_ID,
      authorUsername: 'operator',
      timestamp: Date.now(),
      text: 'Team A',
      metadata: {}
    };

    const found = ingress._findClusterDraftViaFeedbackChat(
      FEEDBACK_CHAT_ID, OPERATOR_USER_ID, operatorMsg
    );
    expect(found).not.toBeNull();
    expect(found.id).toBe(draft.id);
  });

  test('unauthorized user fresh message in feedback chat is rejected from awaiting cluster draft', () => {
    const signalMsg = {
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      messageId: 7101,
      authorId: null,
      authorUsername: null,
      timestamp: Date.now(),
      text: 'Signal',
      metadata: { senderChatId: SOURCE_CHAT_ID }
    };
    const draft = ingress._createDraft(signalMsg, clusterProfile);
    ingress._appendMessageToDraft(draft, signalMsg);
    draft.clarification = { awaitingText: true, prompt: 'Which team?' };

    const strangerMsg = {
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      messageId: 7110,
      authorId: STRANGER_USER_ID,
      authorUsername: 'stranger',
      timestamp: Date.now(),
      text: 'Some answer',
      metadata: {}
    };

    const found = ingress._findClusterDraftViaFeedbackChat(
      FEEDBACK_CHAT_ID, STRANGER_USER_ID, strangerMsg
    );
    expect(found).toBeNull();
  });
});
