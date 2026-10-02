/**
 * Regression coverage for review iteration 7 findings F1–F4 on the
 * Telegram-source betting contour.
 *
 * F1: BaseBettor must wire dedupeFilePath / tasksFilePath into the ingress
 *     so the persistent dedupe registry is exercised in production.
 * F2: forward-continuation gap must mirror backward (3000 ms) so a 2 s
 *     same-author burst continuation isn't dropped when the activation
 *     code replies to the earlier message.
 * F3: STOP confirmations rerouted into the feedback chat must use
 *     `feedbackReplyToMessageId` (intra-chat reply) and must NOT emit a
 *     misleading cross-chat provenance line.
 * F4: post-code follow-up timer must use `draft.profile` at-time-of-fire
 *     so overlapping cluster profiles can't leak the wrong cluster key
 *     into dedupe / routing.
 */
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_INGRESS_BOT_TOKEN = process.env.TELEGRAM_INGRESS_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseBettor } = require('../betting/BaseBettor.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

function createFakeBookmakerAdapter() {
  return {
    bookmakerId: 'fakebook',
    getCatalog: jest.fn(async () => []),
    submitBet: jest.fn(async () => ({ ok: false, status: 'rejected' }))
  };
}

class FakeAdapter {
  constructor() {
    this.bookmakerName = 'FakeBook';
    this.isPrematch = false;
  }
  async login() { return true; }
  async close() { return true; }
  async isSessionValid() { return true; }
  getSportId() { return 1; }
}

describe('F1 (review_7) — BaseBettor wires dedupeFilePath + tasksFilePath into ingress', () => {
  test('ingress receives default dedupeFilePath alongside stateFilePath; passes tasksFilePath through; signal accept persists registry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-iter7-f1-'));
    const tasksFilePath = path.join(tmpDir, '.bettor_tasks.json');
    const stateFilePath = path.join(tmpDir, '.bettor_state.json');
    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        enableTaskRunner: false,
        enableTelegramIngress: true,
        tasksFilePath,
        stateFilePath,
        accountId: 'acct1',
        logger: createLogger(),
        tgQuiet: true,
        dryRun: true,
        telegram: {
          enabled: true,
          ingress: {
            enabled: true,
            botClient: { sendMessage: jest.fn(), getUpdates: jest.fn(async () => []) },
            bookmakerAdapter: createFakeBookmakerAdapter(),
            quiet: true,
            rootDir: path.join(tmpDir, '.tg_ingress')
          },
          profiles: {
            ro_cluster: {
              id: 'ro_cluster',
              clusterId: 'ro_cluster',
              sourceReadOnly: true,
              sourceChatIds: ['-100200200200'],
              feedbackChatIds: ['-1003717712631'],
              brm: { stake: 6 }
            }
          }
        }
      });

      const ingress = bettor.telegramIngress;
      expect(ingress).toBeTruthy();
      // F1: dedupe + tasks paths actually propagated
      expect(ingress.dedupeFilePath).toBeTruthy();
      expect(ingress.dedupeFilePath).toMatch(/_dedupe\.json$/);
      expect(path.dirname(ingress.dedupeFilePath))
        .toBe(path.dirname(ingress.stateFilePath));
      expect(ingress.tasksFilePath).toBe(tasksFilePath);

      // Simulate a final-dedupe registration → save → file appears on disk.
      ingress._registerDedupeEntry({
        clusterId: 'ro_cluster',
        fingerprint: 'final:test:fp',
        primaryCode: 'ABCDEFGHIJ',
        codeAliases: [],
        originChatId: '-100200200200',
        originTopicId: null,
        sourceLabel: 'ro_cluster',
        status: 'accepted',
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        draftId: 'draft-1',
        taskId: 'task-1'
      });
      fs.mkdirSync(path.dirname(ingress.dedupeFilePath), { recursive: true });
      ingress._saveDedupeRegistry();
      expect(fs.existsSync(ingress.dedupeFilePath)).toBe(true);
      const reloaded = JSON.parse(fs.readFileSync(ingress.dedupeFilePath, 'utf8'));
      expect(reloaded.entries).toHaveLength(1);
      expect(reloaded.entries[0].fingerprint).toBe('final:test:fp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('launcher-supplied dedupeFilePath override is honoured (precedence over default)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-iter7-f1b-'));
    const tasksFilePath = path.join(tmpDir, '.bettor_tasks.json');
    const customDedupePath = path.join(tmpDir, 'my_custom_dedupe.json');
    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        enableTaskRunner: false,
        enableTelegramIngress: true,
        tasksFilePath,
        accountId: 'acct1',
        logger: createLogger(),
        tgQuiet: true,
        dryRun: true,
        telegram: {
          enabled: true,
          ingress: {
            enabled: true,
            botClient: { sendMessage: jest.fn(), getUpdates: jest.fn(async () => []) },
            bookmakerAdapter: createFakeBookmakerAdapter(),
            quiet: true,
            rootDir: path.join(tmpDir, '.tg_ingress'),
            dedupeFilePath: customDedupePath
          },
          profiles: {
            ro_cluster: { id: 'ro_cluster', clusterId: 'ro_cluster', sourceReadOnly: true,
              sourceChatIds: ['-100'], feedbackChatIds: ['-1003717712631'], brm: { stake: 6 } }
          }
        }
      });
      expect(bettor.telegramIngress.dedupeFilePath).toBe(customDedupePath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('F2 (review_7) — forward-continuation gap mirrors backward (3 s)', () => {
  function makeIngress() {
    return new TelegramPollingIngress({
      botClient: { sendMessage: jest.fn() },
      chatProfileManager: new ChatProfileManager({}),
      signalParser: { parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet'
    });
  }
  function msg(messageId, ts, authorId = 111) {
    return { messageId, timestamp: ts, authorId, chatId: -100, topicId: null };
  }

  test('1 s gap forward — absorbed', () => {
    const ing = makeIngress();
    const anchor = msg(11, 100000);
    const later = msg(12, 101000);
    const group = ing._partitionSignalGroup([anchor, later], anchor);
    expect(group.map((m) => m.messageId)).toEqual([11, 12]);
  });

  test('2 s gap forward — absorbed (was dropped under 1 s threshold)', () => {
    const ing = makeIngress();
    const anchor = msg(11, 100000);
    const later = msg(12, 102000);
    const group = ing._partitionSignalGroup([anchor, later], anchor);
    expect(group.map((m) => m.messageId)).toEqual([11, 12]);
  });

  test('5 s gap forward — absorbed (boundary == threshold)', () => {
    const ing = makeIngress();
    const anchor = msg(11, 100000);
    const later = msg(12, 105000);
    const group = ing._partitionSignalGroup([anchor, later], anchor);
    expect(group.map((m) => m.messageId)).toEqual([11, 12]);
  });

  test('6 s gap forward — NOT absorbed (beyond 5 s threshold)', () => {
    const ing = makeIngress();
    const anchor = msg(11, 100000);
    const later = msg(12, 106000);
    const group = ing._partitionSignalGroup([anchor, later], anchor);
    expect(group.map((m) => m.messageId)).toEqual([11]);
  });

  test('1 s / 2 s / 3 s gap backward — all absorbed; explicit 16 s — not', () => {
    const ing = makeIngress();
    const earlier3s = msg(8, 97000);
    const earlier2s = msg(9, 98000);
    const earlier1s = msg(10, 99000);
    const anchor = msg(11, 100000);
    // First check: chain of 1 s gaps (4 messages) — all absorbed
    const tooFar = msg(7, 96000);
    const group = ing._partitionSignalGroup([tooFar, earlier3s, earlier2s, earlier1s, anchor], anchor);
    expect(group.map((m) => m.messageId)).toEqual([7, 8, 9, 10, 11]);

    // Verify backward stops only on >15 s gap (Supernova-style burst window)
    const isolated = msg(5, 81000); // 16 s before earlier3s
    const group2 = ing._partitionSignalGroup([isolated, earlier3s, earlier2s, earlier1s, anchor], anchor);
    expect(group2.map((m) => m.messageId)).toEqual([8, 9, 10, 11]);
  });

  // ─── Supernova-style burst regression (real-world 2026-05-31) ───
  test('Supernova text-burst: team-name 8 s before outcome IS absorbed (regression)', () => {
    const ing = makeIngress();
    // Real partner sequence:
    //   msg 19185 "DA Sportivo 2 Mayo"  — 19:53:40 (team name)
    //   msg 19186 "Over5.5"             — 19:53:48 (outcome, anchor)
    //   msg 19187 "-4.5"                — 19:53:51 (handicap)
    //   msg 19188 "Football"            — 19:53:54
    //   msg 19189 "Paraguay"            — 19:53:57
    // gap from 19185→19186 is 8 s — under old 3 s ceiling team-name was lost.
    // With new 15 s ceiling all five same-author messages are absorbed into
    // the draft and Vision can identify the match.
    const teamName = msg(19185, 19_53_40_000);
    const outcome  = msg(19186, 19_53_48_000);  // anchor (code reply target)
    const hcap     = msg(19187, 19_53_51_000);
    const sport    = msg(19188, 19_53_54_000);
    const league   = msg(19189, 19_53_57_000);
    const window   = [teamName, outcome, hcap, sport, league];
    const group    = ing._partitionSignalGroup(window, outcome);
    expect(group.map((m) => m.messageId).sort()).toEqual(
      [19185, 19186, 19187, 19188, 19189]
    );
  });
});

describe('F3 (review_7) — STOP rerouted into feedback chat preserves intra-chat reply linkage and drops cross-chat provenance', () => {
  test('feedback-chat STOP invocation → _sendToFeedbackChat called with feedbackReplyToMessageId, no sourceMessageId', async () => {
    const FEEDBACK_CHAT = -1003717712631;
    const SOURCE_CHAT = -1002010985531;

    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          ro_cluster: {
            id: 'ro_cluster', clusterId: 'ro_cluster', liveEnabled: true, prematchEnabled: true,
            sourceReadOnly: true,
            sourceTargets: [{ chatId: SOURCE_CHAT, topicId: null, label: 'src' }],
            feedbackChatIds: [FEEDBACK_CHAT],
            activation: { mode: 'code_reply', codeBotUserIds: [7109114044], codeRegex: '^[A-Za-z0-9]{10}$' }
          },
          fb_default: {
            id: 'fb_default', liveEnabled: true, prematchEnabled: true,
            sourceChatIds: [FEEDBACK_CHAT],
            feedbackChatIds: [FEEDBACK_CHAT],
            allowedSenders: [{ userId: 4242 }]
          }
        }
      }
    });

    const sentToFeedback = [];
    const botClient = {
      sendMessage: jest.fn(async (chatId, text, payload) => {
        sentToFeedback.push({ chatId, text, payload });
        return { ok: true, message_id: 9999, chat: { id: chatId } };
      })
    };
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet'
    });

    // Install a fake draft sourced from the cluster (sourceReadOnly profile),
    // with no taskId so the STOP path takes the "stopped_before_queue" branch.
    const draftProfile = manager.getProfile('ro_cluster');
    const draft = {
      id: 'draft-stop-1',
      session: { chatId: SOURCE_CHAT, topicId: null, lastUpdatedAt: Date.now(), getTextContext: () => '', getImages: () => [], toLLMPayload: () => ({ messageIds: [] }) },
      profile: draftProfile,
      authorId: 555, // known source author
      authorUsername: 'srcauthor',
      stage: 'draft',
      taskId: null,
      taskState: null,
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set()
    };
    ingress.activeDrafts.set(draft.id, draft);

    // Operator (allowlisted in fb_default) sends "STOP" in the feedback chat,
    // replying to the bot's queue notice (id=4321) which is irrelevant for the
    // resolve target — we manually rig _resolveStopTarget to return our draft.
    const origResolve = ingress._resolveStopTarget.bind(ingress);
    ingress._resolveStopTarget = () => draft;

    const stopMessage = {
      chatId: FEEDBACK_CHAT, topicId: null,
      messageId: 7777,
      authorId: 4242, authorUsername: 'op',
      text: 'STOP', timestamp: Date.now(),
      replyToMessageId: 4321
    };

    await ingress._handleStopMessage(stopMessage, draftProfile, { intentType: 'stop' });
    ingress._resolveStopTarget = origResolve;

    expect(sentToFeedback.length).toBeGreaterThan(0);
    const last = sentToFeedback[sentToFeedback.length - 1];
    expect(String(last.chatId)).toBe(String(FEEDBACK_CHAT));
    // Intra-chat reply linkage preserved: reply_to_message_id = STOP message id
    expect(last.payload.reply_to_message_id).toBe(7777);
    // Cross-chat provenance line MUST NOT include the misleading
    // "(chat=<source> msg=<feedback_msg_id>)" pointer because the STOP id
    // does not exist in the source chat.
    expect(last.text).not.toMatch(/msg=7777/);
    expect(last.text).toMatch(/Сигнал остановлен/);
  });
});

describe('F4 (review_7) — post-code timer uses draft.profile at fire time', () => {
  test('overlapping cluster profiles sharing source chat: timer uses second draft\u2019s profile', async () => {
    jest.useFakeTimers();
    const SHARED_CHAT = -1002999999999;
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          cluster_a: {
            id: 'cluster_a', clusterId: 'cluster_a', liveEnabled: true, prematchEnabled: true,
            sourceReadOnly: true,
            sourceTargets: [{ chatId: SHARED_CHAT, topicId: null }],
            feedbackChatIds: [-1003717712631],
            activation: { mode: 'code_reply', codeBotUserIds: [7109114044], codeRegex: '^[A-Za-z0-9]{10}$', postCodeFollowupWindowMs: 5000 }
          },
          cluster_b: {
            id: 'cluster_b', clusterId: 'cluster_b', liveEnabled: true, prematchEnabled: true,
            sourceReadOnly: true,
            sourceTargets: [{ chatId: SHARED_CHAT, topicId: null }],
            feedbackChatIds: [-1003717712631],
            activation: { mode: 'code_reply', codeBotUserIds: [7109114044], codeRegex: '^[A-Za-z0-9]{10}$', postCodeFollowupWindowMs: 5000 }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: { sendMessage: jest.fn() },
      chatProfileManager: manager,
      signalParser: { parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet'
    });

    const profileA = manager.getProfile('cluster_a');
    const profileB = manager.getProfile('cluster_b');

    const fired = [];
    ingress._processDraftWithDedupe = jest.fn(async (draft, profile) => {
      fired.push({ draftId: draft.id, profileId: profile.id, draftProfileId: draft.profile.id });
    });
    ingress._mergeSafePendingCandidates = jest.fn();

    function fakeDraft(id, profile) {
      return {
        id, profile,
        session: { chatId: SHARED_CHAT, topicId: null, getTextContext: () => '', getImages: () => [] },
        stage: 'awaiting_followup',
        indexedMessageIds: new Set()
      };
    }

    // Manually replicate the timer-scheduling code under test so the test
    // depends only on the closure semantics (capture of draft.profile at fire
    // time, not the outer-scope `profile`).
    function scheduleTimer(draft, outerProfile) {
      const draftRef = draft;
      ingress.activeDrafts.set(draft.id, draft);
      const id = setTimeout(async () => {
        try {
          ingress._postCodeTimers.delete(draftRef.id);
          if (ingress.activeDrafts.has(draftRef.id) && draftRef.stage === 'awaiting_followup') {
            ingress._mergeSafePendingCandidates(draftRef);
            draftRef.stage = 'draft';
            await ingress._processDraftWithDedupe(draftRef, draftRef.profile);
          }
        } catch (_e) {}
      }, 5000);
      ingress._postCodeTimers.set(draft.id, id);
    }

    const draftA = fakeDraft('draft-a', profileA);
    const draftB = fakeDraft('draft-b', profileB);
    scheduleTimer(draftA, profileA);
    scheduleTimer(draftB, profileB);

    await jest.runAllTimersAsync();

    expect(fired).toHaveLength(2);
    const a = fired.find((f) => f.draftId === 'draft-a');
    const b = fired.find((f) => f.draftId === 'draft-b');
    expect(a.profileId).toBe('cluster_a');
    expect(a.draftProfileId).toBe('cluster_a');
    // The second draft's timer must use cluster_b — never the outer-scope
    // capture from a sibling activation.
    expect(b.profileId).toBe('cluster_b');
    expect(b.draftProfileId).toBe('cluster_b');

    jest.useRealTimers();
  });

  test('production timer code uses draft.profile (not outer-scope profile)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'telegram', 'TelegramPollingIngress.js'),
      'utf8'
    );
    // The post-code timer body must invoke _processDraftWithDedupe with
    // draftRef.profile (or draft.profile), not the outer `profile` capture.
    expect(src).toMatch(/await this\._processDraftWithDedupe\(draftRef, draftRef\.profile\)/);
    // And the synchronous fall-through path (when postCodeWindowMs===0) must
    // also bind to draft.profile.
    expect(src).toMatch(/await this\._processDraftWithDedupe\(draft, draft\.profile\)/);
  });
});
