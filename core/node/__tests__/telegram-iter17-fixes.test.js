/**
 * Regression tests for tg_review iteration 17 findings.
 *
 * F1 — Reply-linkage profile resolution via _resolveProfileViaFeedbackChat
 *      bypasses sender allowlist for new draft creation. When _routeMessageToDraft
 *      correctly rejects an unauthorized sender's merge, _handleImmediateMessage
 *      falls through to _createDraft — creating a NEW draft without any sender
 *      gate. The fix gates _createDraft on isSenderAllowed when the message
 *      arrives via a feedback-chat path.
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
    stopPolling: jest.fn(),
    answerCallbackQuery: jest.fn().mockResolvedValue({ ok: true }),
    editMessageReplyMarkup: jest.fn().mockResolvedValue({ ok: true })
  };
}

/**
 * Build a ChatProfileManager with a multi-profile cluster setup:
 *  - cluster_src: sourceReadOnly, NO allowedSenders (hasSenderAllowlist=false),
 *    feedbackChatIds includes the feedback chat
 *  - feedback_default: normal (immediate-activation) profile covering the
 *    feedback chat as a sourceChatId, with allowedSenders
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

/**
 * Build a profile manager with a single profile that has hasSenderAllowlist
 * and uses the feedback chat as both source and feedback.
 */
function makeSingleProfileManager() {
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        default: {
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
    signalParser: {
      parseSession: jest.fn(),
      detectMessageIntent: jest.fn().mockResolvedValue({
        intentType: 'signal', confidence: 1.0, notes: 'test-mock'
      })
    },
    logger: createLogger(),
    bookmakerName: 'Sansabet'
  });
}

// ─── F1 (review_17): feedback-chat sender gate on new draft creation ─────────

describe('F1 (review_17) — _handleImmediateMessage gates new draft creation via feedback-chat sender auth', () => {
  describe('cluster (sourceReadOnly) profile resolved via reply linkage', () => {
    let manager;
    let ingress;
    let clusterProfile;

    beforeEach(() => {
      manager = makeClusterProfileManager();
      ingress = makeIngress(manager);
      clusterProfile = manager.getProfile('cluster_src');
    });

    test('unauthorized sender replies to anchor in group feedback chat → draft NOT created', async () => {
      expect(clusterProfile.hasSenderAllowlist).toBe(false);
      expect(clusterProfile.sourceReadOnly).toBe(true);

      // Create an existing draft on the cluster profile (from the source chat)
      const signalMsg = {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 5001,
        authorId: null,
        authorUsername: null,
        timestamp: Date.now(),
        text: 'Signal from source',
        metadata: { senderChatId: SOURCE_CHAT_ID }
      };
      const existingDraft = ingress._createDraft(signalMsg, clusterProfile);
      ingress._appendMessageToDraft(existingDraft, signalMsg);
      // Index a clarification anchor in the feedback chat
      ingress._indexClarificationMessage(existingDraft, 6001, FEEDBACK_CHAT_ID, null);

      const draftCountBefore = ingress.activeDrafts.size;

      // Stranger replies to the anchor in the feedback chat
      const strangerReply = {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 6010,
        authorId: STRANGER_USER_ID,
        authorUsername: 'stranger',
        replyToMessageId: 6001,
        timestamp: Date.now(),
        text: 'Over 2.5',
        metadata: {}
      };

      // Stub _processDraft to avoid side-effects
      const processSpy = jest.spyOn(ingress, '_processDraft').mockResolvedValue();

      await ingress._handleImmediateMessage(strangerReply, clusterProfile);

      // No new draft should have been created
      expect(ingress.activeDrafts.size).toBe(draftCountBefore);
      // _processDraft should NOT have been called for a new draft
      expect(processSpy).not.toHaveBeenCalled();

      // Verify the warning log was emitted
      const logCalls = ingress.logger.log.mock.calls.map(c => c[0]);
      expect(logCalls.some(l => l.includes('F1') && l.includes('not authorized'))).toBe(true);

      processSpy.mockRestore();
    });

    test('authorized sender replies to anchor in group feedback chat → draft IS created', async () => {
      expect(clusterProfile.hasSenderAllowlist).toBe(false);

      const signalMsg = {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 5101,
        authorId: null,
        authorUsername: null,
        timestamp: Date.now(),
        text: 'Signal from source',
        metadata: { senderChatId: SOURCE_CHAT_ID }
      };
      const existingDraft = ingress._createDraft(signalMsg, clusterProfile);
      ingress._appendMessageToDraft(existingDraft, signalMsg);
      ingress._indexClarificationMessage(existingDraft, 6101, FEEDBACK_CHAT_ID, null);

      const draftCountBefore = ingress.activeDrafts.size;

      // Operator replies to the anchor in the feedback chat — but
      // _routeMessageToDraft returns null because there is no direct
      // reply-linkage match (the operator is authorized, but the draft's
      // auth happens inside _routeMessageToDraft, and if that returns the
      // existing draft, _createDraft won't be called). To specifically
      // exercise the new-draft path, we test with NO existing draft anchor.
      // Remove the existing anchor so _routeMessageToDraft returns null.
      ingress._indexClarificationMessage.call
        ? ingress.clarificationIndex?.clear?.()
        : null;

      // Actually, let's use a fresh ingress with no existing drafts to test
      // the pure new-draft creation path.
      const freshIngress = makeIngress(manager);
      const freshDraftCountBefore = freshIngress.activeDrafts.size;

      const operatorMsg = {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 6110,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator',
        timestamp: Date.now(),
        text: 'Over 2.5',
        metadata: {}
      };

      const processSpy = jest.spyOn(freshIngress, '_processDraft').mockResolvedValue();
      await freshIngress._handleImmediateMessage(operatorMsg, clusterProfile);

      // New draft SHOULD be created (authorized sender)
      expect(freshIngress.activeDrafts.size).toBe(freshDraftCountBefore + 1);
      expect(processSpy).toHaveBeenCalledTimes(1);

      processSpy.mockRestore();
    });
  });

  describe('single profile with hasSenderAllowlist', () => {
    let manager;
    let ingress;
    let profile;

    beforeEach(() => {
      manager = makeSingleProfileManager();
      ingress = makeIngress(manager);
      profile = manager.getProfile('default');
    });

    test('unauthorized sender in feedback chat → draft NOT created', async () => {
      expect(profile.hasSenderAllowlist).toBe(true);

      const draftCountBefore = ingress.activeDrafts.size;

      const strangerMsg = {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 7010,
        authorId: STRANGER_USER_ID,
        authorUsername: 'stranger',
        timestamp: Date.now(),
        text: 'Over 2.5',
        metadata: {}
      };

      const processSpy = jest.spyOn(ingress, '_processDraft').mockResolvedValue();
      await ingress._handleImmediateMessage(strangerMsg, profile);

      expect(ingress.activeDrafts.size).toBe(draftCountBefore);
      expect(processSpy).not.toHaveBeenCalled();

      const logCalls = ingress.logger.log.mock.calls.map(c => c[0]);
      expect(logCalls.some(l => l.includes('F1') && l.includes('not authorized'))).toBe(true);

      processSpy.mockRestore();
    });

    test('authorized sender in feedback chat → draft IS created normally', async () => {
      expect(profile.hasSenderAllowlist).toBe(true);

      const draftCountBefore = ingress.activeDrafts.size;

      const operatorMsg = {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 7020,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator',
        timestamp: Date.now(),
        text: 'Under 3.5',
        metadata: {}
      };

      const processSpy = jest.spyOn(ingress, '_processDraft').mockResolvedValue();
      await ingress._handleImmediateMessage(operatorMsg, profile);

      expect(ingress.activeDrafts.size).toBe(draftCountBefore + 1);
      expect(processSpy).toHaveBeenCalledTimes(1);

      processSpy.mockRestore();
    });
  });

  describe('existing paths still work — authorized user creating drafts from source chat', () => {
    test('signal from source chat creates draft without sender gate (no feedbackChat match)', async () => {
      const manager = makeClusterProfileManager();
      const ingress = makeIngress(manager);
      const clusterProfile = manager.getProfile('cluster_src');

      const draftCountBefore = ingress.activeDrafts.size;

      // Message from source chat (not feedback chat)
      const sourceMsg = {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 8001,
        authorId: null,
        authorUsername: null,
        timestamp: Date.now(),
        text: '1X2 signal',
        metadata: { senderChatId: SOURCE_CHAT_ID }
      };

      const processSpy = jest.spyOn(ingress, '_processDraft').mockResolvedValue();
      await ingress._handleImmediateMessage(sourceMsg, clusterProfile);

      // Draft should be created — source chat is not gated by this fix
      expect(ingress.activeDrafts.size).toBe(draftCountBefore + 1);
      expect(processSpy).toHaveBeenCalledTimes(1);

      processSpy.mockRestore();
    });

    test('authorized user merges into existing draft via _routeMessageToDraft (targetDraft path)', async () => {
      const manager = makeClusterProfileManager();
      const ingress = makeIngress(manager);
      const clusterProfile = manager.getProfile('cluster_src');

      // Seed a draft from the source chat
      const signalMsg = {
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        messageId: 8101,
        authorId: null,
        authorUsername: null,
        timestamp: Date.now(),
        text: 'Signal',
        metadata: { senderChatId: SOURCE_CHAT_ID }
      };
      const draft = ingress._createDraft(signalMsg, clusterProfile);
      ingress._appendMessageToDraft(draft, signalMsg);
      ingress._indexClarificationMessage(draft, 8201, FEEDBACK_CHAT_ID, null);

      const draftCountBefore = ingress.activeDrafts.size;

      // Operator replies to the anchor — _routeMessageToDraft should find the draft
      const operatorReply = {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        messageId: 8210,
        authorId: OPERATOR_USER_ID,
        authorUsername: 'operator',
        replyToMessageId: 8201,
        timestamp: Date.now(),
        text: 'Confirmed',
        metadata: {}
      };

      const processSpy = jest.spyOn(ingress, '_processDraft').mockResolvedValue();
      // Use the feedback_default profile (resolved by _resolveProfileForMessage for this chat)
      const feedbackProfile = manager.getProfile('feedback_default');
      await ingress._handleImmediateMessage(operatorReply, feedbackProfile);

      // Should merge, not create new draft
      expect(ingress.activeDrafts.size).toBe(draftCountBefore);
      expect(processSpy).toHaveBeenCalledTimes(1);

      processSpy.mockRestore();
    });
  });
});
