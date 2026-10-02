/**
 * Regression tests for tg_review iteration 8 findings F1–F4 on the
 * Telegram-source betting contour.
 *
 * F1 — text-uplift clarification typed in a feedback chat without an explicit
 *      reply linkage must still resolve to the awaiting cluster draft (whose
 *      session.chatId is the upstream source chat). Author must pass the
 *      governing cluster profile's allowlist (fail-closed otherwise).
 * F2 — pre-activation buffer must not admit messages authored by the
 *      configured codeBotUserIds (status posts), and the LRU cap must be
 *      large enough that ≥ 50 status messages followed by other chatter do
 *      not evict a real signal anchor that arrived 90 s ago.
 * F3 — _buildFinalFingerprint must namespace by the actual profile id when
 *      no clusterId is set, so two non-cluster profiles do not share a
 *      dedupe bucket.
 * F4 — _archiveDraft('enqueue_rejected', ...) must NOT prune the dedupe
 *      registry entry — the originating task is still in queued/executing
 *      and the entry is the very thing protecting against re-fire.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');

const FEEDBACK_CHAT_ID = -1003717712631;
const SOURCE_CHAT_ID = -1002010985531;
const OPERATOR_USER_ID = 7268849307;
const STRANGER_USER_ID = 99999;
const CODE_BOT_USER_ID = 7109114044;

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

function buildClusterManager() {
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
          feedbackChatIds: [FEEDBACK_CHAT_ID],
          allowedSenders: [{ userId: OPERATOR_USER_ID }]
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

describe('F1 (review_8) — feedback-chat clarification text resolves to cluster draft', () => {
  function seedClusterDraftAwaitingClarification(ingress, manager) {
    const clusterProfile = manager.getProfile('vova_cluster');
    expect(clusterProfile).toBeTruthy();
    expect(clusterProfile.sourceReadOnly).toBe(true);
    expect(clusterProfile.feedbackChatIds.map(String)).toContain(String(FEEDBACK_CHAT_ID));
    const anchor = {
      messageId: 1001,
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      authorId: OPERATOR_USER_ID,
      timestamp: Date.now()
    };
    const draft = ingress._createDraft(anchor, clusterProfile);
    draft.clarification = { awaitingText: true, type: 'outcome', options: [] };
    draft.session.lastUpdatedAt = Date.now();
    return draft;
  }

  test('typed-in-feedback message (no reply) resolves to awaiting cluster draft when author is allow-listed', () => {
    const manager = buildClusterManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    const draft = seedClusterDraftAwaitingClarification(ingress, manager);

    const fbProfile = manager.getProfile('default');
    const msg = {
      messageId: 5555,
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      authorId: OPERATOR_USER_ID,
      replyToMessageId: null,
      text: 'первый'
    };

    const routed = ingress._routeMessageToDraft(msg, fbProfile);
    expect(routed).toBe(draft);
  });

  test('fail-closed when author is not on the cluster allowlist', () => {
    const manager = buildClusterManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    seedClusterDraftAwaitingClarification(ingress, manager);

    const fbProfile = manager.getProfile('default');
    const msg = {
      messageId: 5556,
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      authorId: STRANGER_USER_ID,
      replyToMessageId: null,
      text: 'первый'
    };

    const routed = ingress._routeMessageToDraft(msg, fbProfile);
    expect(routed).toBeNull();
  });

  test('cluster draft NOT awaiting clarification is not picked up via feedback chat', () => {
    const manager = buildClusterManager();
    const ingress = makeIngress({ chatProfileManager: manager });
    const draft = seedClusterDraftAwaitingClarification(ingress, manager);
    draft.clarification = null; // no longer awaiting

    const fbProfile = manager.getProfile('default');
    const msg = {
      messageId: 5557,
      chatId: FEEDBACK_CHAT_ID,
      topicId: null,
      authorId: OPERATOR_USER_ID,
      replyToMessageId: null,
      text: 'первый'
    };

    const routed = ingress._routeMessageToDraft(msg, fbProfile);
    expect(routed).toBeNull();
  });
});

describe('F2 (review_8) — pre-activation buffer rejects code-bot status spam and survives ≥ 50 noise messages', () => {
  function makeProfile() {
    return {
      id: 'vova_cluster',
      clusterId: 'vova',
      sourceReadOnly: true,
      activation: {
        mode: 'code_reply',
        codeBotUserIds: [CODE_BOT_USER_ID],
        codeRegex: '^[A-Za-z0-9]{10}$',
        preSignalWindowMs: 120000
      }
    };
  }

  test('messages authored by codeBotUserIds (non-code text) are NOT admitted to the pre-activation buffer', async () => {
    const ingress = makeIngress();
    const profile = makeProfile();
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) {
      await ingress._handleCodeReplyMessage({
        messageId: 100 + i,
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        authorId: CODE_BOT_USER_ID,
        text: 'heartbeat ok',
        timestamp: now + i * 100
      }, profile);
    }

    const bufferKey = ingress._buildPreActivationBufferKey(SOURCE_CHAT_ID, null, profile.id);
    const buf = ingress.preActivationBuffers.get(bufferKey);
    expect(buf == null || buf.messages.length === 0).toBe(true);
  });

  test('real anchor 90 s old survives 60 noise messages from non-code authors (cap raised to 200)', async () => {
    const ingress = makeIngress();
    const profile = makeProfile();
    const now = Date.now();
    const anchorTs = now - 90000;

    // Real anchor: human author posts the signal
    await ingress._handleCodeReplyMessage({
      messageId: 1,
      chatId: SOURCE_CHAT_ID,
      topicId: null,
      authorId: OPERATOR_USER_ID,
      text: 'Real Madrid - Barcelona\nP1',
      timestamp: anchorTs
    }, profile);

    // 60 unrelated chatter messages from another non-code human
    for (let i = 0; i < 60; i += 1) {
      await ingress._handleCodeReplyMessage({
        messageId: 200 + i,
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        authorId: 222222 + i,
        text: `noise #${i}`,
        timestamp: anchorTs + 1000 + i * 500
      }, profile);
    }

    // 60 status posts from the code bot (must be filtered)
    for (let i = 0; i < 60; i += 1) {
      await ingress._handleCodeReplyMessage({
        messageId: 1000 + i,
        chatId: SOURCE_CHAT_ID,
        topicId: null,
        authorId: CODE_BOT_USER_ID,
        text: `status ping ${i}`,
        timestamp: anchorTs + 30000 + i * 100
      }, profile);
    }

    const bufferKey = ingress._buildPreActivationBufferKey(SOURCE_CHAT_ID, null, profile.id);
    const buf = ingress.preActivationBuffers.get(bufferKey);
    expect(buf).toBeTruthy();
    const ids = buf.messages.map((m) => m.messageId);
    expect(ids).toContain(1); // anchor still in buffer
    // No code-bot id leaked into the buffer
    expect(buf.messages.every((m) => String(m.authorId) !== String(CODE_BOT_USER_ID))).toBe(true);
  });
});

describe('F3 (review_8) — final fingerprint namespaces by profile.id when no clusterId', () => {
  test('two non-cluster profiles produce DISTINCT fingerprints for the same outcome', () => {
    const ingress = makeIngress();
    const parsed = {
      state: 'ready',
      mode: 'prematch',
      sport: 'soccer',
      home: 'A',
      away: 'B',
      bookmakerMatchId: '5028429',
      normalizedOutcome: 'p1 1',
      normalizedIntent: { family: 'unknown', line: null },
      betNum: null
    };

    const fpDefault = ingress._buildFinalFingerprint(parsed, null, 'default');
    const fpVip = ingress._buildFinalFingerprint(parsed, null, 'vip');
    expect(fpDefault).toBeTruthy();
    expect(fpVip).toBeTruthy();
    expect(fpDefault).not.toBe(fpVip);
    // Backward compatibility: legacy entries used 'default' literal — the
    // default profile id resolves to the same namespace for parity.
    expect(fpDefault.startsWith('final:default:')).toBe(true);
    expect(fpVip.startsWith('final:vip:')).toBe(true);
  });

  test('explicit clusterId still wins over profile.id', () => {
    const ingress = makeIngress();
    const parsed = {
      state: 'ready',
      mode: 'live',
      sport: 'soccer',
      home: 'A', away: 'B',
      bookmakerMatchId: 'X',
      normalizedOutcome: '1'
    };
    const fp = ingress._buildFinalFingerprint(parsed, 'vova', 'vova_cluster');
    expect(fp.startsWith('final:vova:')).toBe(true);
  });
});

describe('F4 (review_8) — enqueue_rejected preserves dedupe entry while originating task is in flight', () => {
  test('archive(reason=enqueue_rejected, _preserveDedupeOnArchive=true) does NOT remove dedupe entries belonging to the draft', () => {
    const ingress = makeIngress();
    const profile = { id: 'default', clusterId: null, feedbackChatIds: [String(FEEDBACK_CHAT_ID)] };
    const draft = {
      id: 'draft-B',
      profile,
      session: {
        chatId: FEEDBACK_CHAT_ID,
        topicId: null,
        toLLMPayload: () => ({ messageIds: [1] })
      },
      indexedMessageIds: [],
      indexedClarificationMessageIds: [],
      taskState: null,
      _consumedSnapshot: null,
      _bufferKey: null,
      _preserveDedupeOnArchive: true
    };
    ingress.activeDrafts.set(draft.id, draft);

    ingress._registerDedupeEntry({
      clusterId: null,
      fingerprint: 'final:default:live:soccer:X:1::',
      primaryCode: null,
      codeAliases: [],
      originChatId: String(FEEDBACK_CHAT_ID),
      originTopicId: null,
      sourceLabel: null,
      status: 'ready',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      draftId: draft.id,
      taskId: null
    });

    expect(ingress._findDedupeEntryByFingerprint('final:default:live:soccer:X:1::')).toBeTruthy();

    ingress._archiveDraft(draft, 'enqueue_rejected');

    // Entry MUST still be present so a third signal with the same fingerprint
    // is deduped rather than re-enqueued behind the still-executing task A.
    const stillThere = ingress._findDedupeEntryByFingerprint('final:default:live:soccer:X:1::');
    expect(stillThere).toBeTruthy();
    expect(stillThere.fingerprint).toBe('final:default:live:soccer:X:1::');
  });

  test('archive(reason=enqueue_rejected) WITHOUT preserve flag DOES remove dedupe (transient queue-full path)', () => {
    const ingress = makeIngress();
    const profile = { id: 'default', clusterId: null, feedbackChatIds: [String(FEEDBACK_CHAT_ID)] };
    const draft = {
      id: 'draft-T',
      profile,
      session: { chatId: FEEDBACK_CHAT_ID, topicId: null, toLLMPayload: () => ({ messageIds: [1] }) },
      indexedMessageIds: [],
      indexedClarificationMessageIds: [],
      taskState: null
    };
    ingress.activeDrafts.set(draft.id, draft);
    ingress._registerDedupeEntry({
      fingerprint: 'final:default:live:soccer:Q:1::',
      status: 'ready',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      draftId: draft.id
    });
    ingress._archiveDraft(draft, 'enqueue_rejected');
    // Without the preserve flag (transient rejection, no in-flight task) the
    // historical retry-friendly behaviour is preserved.
    expect(ingress._findDedupeEntryByFingerprint('final:default:live:soccer:Q:1::')).toBeNull();
  });

  test('end-to-end: third signal with same fingerprint hits dedupe after enqueue_rejected', () => {
    const ingress = makeIngress();
    // Task A holds the dedupe entry (simulated): registered by the first
    // accepted draft on this fingerprint.
    const fp = 'final:default:live:soccer:matchA:1::';
    ingress._registerDedupeEntry({
      clusterId: null,
      fingerprint: fp,
      primaryCode: null,
      codeAliases: [],
      originChatId: String(FEEDBACK_CHAT_ID),
      originTopicId: null,
      sourceLabel: null,
      status: 'accepted',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      draftId: 'draft-A',
      taskId: 'task-A'
    });

    // Second draft B was rejected as 'already executing' and archived as
    // enqueue_rejected. Per F4 fix, the dedupe entry must remain.
    const draftB = {
      id: 'draft-B',
      profile: { id: 'default', clusterId: null, feedbackChatIds: [String(FEEDBACK_CHAT_ID)] },
      session: { chatId: FEEDBACK_CHAT_ID, topicId: null, toLLMPayload: () => ({ messageIds: [2] }) },
      indexedMessageIds: [],
      indexedClarificationMessageIds: [],
      taskState: null,
      _preserveDedupeOnArchive: true
    };
    ingress.activeDrafts.set(draftB.id, draftB);
    ingress._archiveDraft(draftB, 'enqueue_rejected');

    // Third signal C: lookup must still resolve and indicate active dedupe.
    const hit = ingress._findDedupeEntryByFingerprint(fp);
    expect(hit).toBeTruthy();
    expect(hit.status).not.toBe('failed');
    expect(hit.taskId).toBe('task-A');
  });
});
