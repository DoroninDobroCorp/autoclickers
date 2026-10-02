/**
 * Regression tests for tg_review iteration 4 findings (F1–F4).
 *
 * F1 — TelegramNotifier._collectTargetChatIds must NOT inject the bookmaker
 *      default chat for sourceReadOnly tasks (or any Telegram-scoped task with
 *      explicit feedbackChatIds). Empty feedback list = fail closed (no targets).
 *
 * F2 — STOP from a feedback chat must work for queued/executing tasks that
 *      never had a clarification stage. Notifier-sent anchors (queued notice)
 *      must register into the ingress draft index.
 *
 * F3 — Pre-check failure notification must route through _getRoutingOptionsForTask
 *      so sourceReadOnly clusters get the failure notice in their feedback chat
 *      and NOT in the global bookmaker default chat.
 *
 * F4 — STOP authorization must default fail-closed for sourceReadOnly cluster
 *      profiles that ship without an explicit allowedSenders list.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TelegramNotifier } = require('../integrations/telegram-notifier.js');
const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { BaseBettor } = require('../betting/BaseBettor.js');

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

function createBotClient() {
  return {
    getUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async (_chatId, _text, _options) => ({
      ok: true,
      result: { message_id: 9001 }
    })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true }))
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

class SansabetNamedAdapter extends FakeAdapter {
  constructor() {
    super();
    this.bookmakerName = 'Sansabet';
  }
}

// -----------------------------------------------------------------------------
// F1
// -----------------------------------------------------------------------------
describe('F1 — _collectTargetChatIds bookmaker fallback gating', () => {
  const notifier = new TelegramNotifier({
    botToken: 'fake',
    logsChatId: '-1000',
    bookmakerChatIds: { Sansabet: '-2000' }
  });

  test('sourceReadOnly task with feedbackChatIds → only feedback chats (no bookmaker fan-out)', () => {
    const targets = notifier._collectTargetChatIds({
      bookmaker: 'Sansabet',
      chatIds: ['-3000'],
      originChatId: '-4000',
      sourceReadOnly: true
    });
    expect(targets).toEqual(['-3000']);
    expect(targets).not.toContain('-2000');
    expect(targets).not.toContain('-4000');
    expect(targets).not.toContain('-1000');
  });

  test('sourceReadOnly task with EMPTY feedbackChatIds → fail-closed (no targets)', () => {
    const targets = notifier._collectTargetChatIds({
      bookmaker: 'Sansabet',
      chatIds: [],
      originChatId: '-4000',
      sourceReadOnly: true
    });
    expect(targets).toEqual([]);
  });

  test('non-readonly Telegram task with feedbackChatIds → bookmaker chat suppressed', () => {
    const targets = notifier._collectTargetChatIds({
      bookmaker: 'Sansabet',
      chatIds: ['-3000']
    });
    expect(targets).toContain('-3000');
    expect(targets).not.toContain('-2000');
  });

  test('legacy non-Telegram task (no chatIds, no sourceReadOnly) → bookmaker chat included', () => {
    const targets = notifier._collectTargetChatIds({ bookmaker: 'Sansabet' });
    expect(targets).toEqual(['-2000']);
  });

  test('explicit includeBookmakerChat:true overrides Telegram-scope suppression', () => {
    const targets = notifier._collectTargetChatIds({
      bookmaker: 'Sansabet',
      chatIds: ['-3000'],
      includeBookmakerChat: true
    });
    expect(targets).toContain('-3000');
    expect(targets).toContain('-2000');
  });
});

// -----------------------------------------------------------------------------
// F2
// -----------------------------------------------------------------------------
describe('F2 — notifier-sent anchor messages index back to draft', () => {
  function buildIngress() {
    const profiles = {
      ro: {
        sourceChatIds: [-9001],
        feedbackChatIds: [-9002],
        allowedSenders: [{ userId: 7777 }],
        sourceReadOnly: true,
        liveEnabled: true
      }
    };
    return new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: new ChatProfileManager({ telegram: { enabled: true, profiles } }),
      signalParser: {
        detectMessageIntent: jest.fn(async () => ({ intentType: 'signal', confidence: 0.9 })),
        parseSession: jest.fn(async () => ({ state: 'ready', queueDecision: 'enqueue' }))
      },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });
  }

  test('indexTaskAnchorMessage registers feedback-chat msgId → draft for STOP-by-reply', () => {
    const ingress = buildIngress();
    const draft = {
      id: 'sig-1',
      session: { chatId: -9001, topicId: null },
      indexedClarificationMessageIds: new Set()
    };
    ingress.activeDrafts.set('sig-1', draft);

    const ok = ingress.indexTaskAnchorMessage('sig-1', {
      chatId: -9002,
      topicId: null,
      messageId: 4242
    });
    expect(ok).toBe(true);

    const found = ingress._findDraftByClarificationRef(-9002, null, 4242);
    expect(found).toBe(draft);
  });

  test('TelegramNotifier.sendToAll with _anchorSignalId calls ingress.indexTaskAnchorMessage', async () => {
    const indexCalls = [];
    const notifier = new TelegramNotifier({
      botToken: 'fake',
      logsChatId: '-1000',
      bookmakerChatIds: { Sansabet: '-2000' }
    });
    // Avoid hitting real Telegram API.
    notifier.sendMessage = jest.fn(async (chatId) => ({
      ok: true,
      result: { message_id: 555, chat: { id: Number(chatId) } }
    }));
    notifier.setIngress({
      indexTaskAnchorMessage: (sigId, anchor) => {
        indexCalls.push({ sigId, ...anchor });
        return true;
      }
    });

    await notifier.sendToAll('hi', {
      bookmaker: 'Sansabet',
      chatIds: ['-3000'],
      sourceReadOnly: true,
      _anchorSignalId: 'sig-99'
    });

    expect(indexCalls).toEqual([
      { sigId: 'sig-99', chatId: -3000, topicId: null, messageId: 555 }
    ]);
  });

  test('_archiveDraft tears down anchor index entries', () => {
    const ingress = buildIngress();
    const draft = {
      id: 'sig-2',
      profile: { id: 'ro' },
      session: { chatId: -9001, topicId: null, toLLMPayload: () => ({ messageIds: [] }) },
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set(),
      taskId: null,
      taskState: null
    };
    ingress.activeDrafts.set('sig-2', draft);
    ingress.indexTaskAnchorMessage('sig-2', { chatId: -9002, topicId: null, messageId: 9999 });
    expect(ingress._findDraftByClarificationRef(-9002, null, 9999)).toBe(draft);

    ingress._archiveDraft(draft, 'cancelled');
    expect(ingress._findDraftByClarificationRef(-9002, null, 9999)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// F3
// -----------------------------------------------------------------------------
describe('F3 — pre-check failure notification routes via _getRoutingOptionsForTask', () => {
  test('BaseBettor maps legacy Sansabet bookmaker chat to runtime logsChatId', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-sansabet-chat-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');
    try {
      const bettor = new BaseBettor(new SansabetNamedAdapter(), {
        executionMode: 'analyzer-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        telegram: {
          logsChatId: '-9090909090'
        }
      });

      expect(bettor.telegram.logsChatId).toBe('-9090909090');
      expect(bettor.telegram.getBookmakerChatId('Sansabet')).toBe('-9090909090');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('sourceReadOnly cluster failure notice goes ONLY to feedback chats, not bookmaker default', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-iter4-f3-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');
    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: false,
        telegram: {
          profiles: {
            ro_cluster: {
              id: 'ro_cluster',
              clusterId: 'ro_cluster',
              sourceReadOnly: true,
              sourceChatIds: ['-100100100'],
              feedbackChatIds: ['-200200200'],
              brm: { stake: 5 }
            }
          }
        }
      });

      // Fake notifier: capture every sendToAll call with options snapshot.
      const sendToAllCalls = [];
      const collectCalls = [];
      bettor.telegram = {
        bookmakerName: 'Sansabet',
        sendToAll: jest.fn(async (text, options) => {
          sendToAllCalls.push({ text, options });
          return [];
        }),
        notifySkipped: jest.fn(async () => []),
        notifyTaskFailed: jest.fn(async () => []),
        _getRoutingOptionsForTask: (task, bookmaker) => {
          const feedback = [
            ...(task.feedbackChatIds || []),
            ...(task.telegramContext?.feedbackChatIds || [])
          ];
          const sourceReadOnly = task.telegramContext?.sourceReadOnly === true;
          return {
            bookmaker,
            chatIds: feedback,
            originChatId: sourceReadOnly ? null : (task.telegramContext?.originChatId || task.originChatId || null),
            sourceReadOnly,
            _anchorSignalId: task.signalId || task.telegramContext?.signalId || null
          };
        },
        _collectTargetChatIds: (opts) => {
          collectCalls.push(opts);
          // Mirror real implementation enough to assert the gating outcome.
          const ids = Array.isArray(opts.chatIds) ? [...opts.chatIds] : [];
          const isTelegramScoped = opts.sourceReadOnly === true || ids.length > 0;
          if (opts.bookmaker && !isTelegramScoped) ids.push('BOOKMAKER_DEFAULT_CHAT');
          return ids.map(String);
        }
      };

      // Seed a queued telegram task that has not yet sent a "started" notice.
      const enqueue = await bettor.enqueueTelegramTask({
        home: 'A',
        away: 'B',
        outcome: '1',
        originChatId: '-100100100',
        chatId: '-100100100',
        sourceProfileId: 'ro_cluster',
        telegramContext: { profileId: 'ro_cluster' }
      });
      expect(enqueue.accepted).toBe(true);

      const task = bettor.tasksManager.getCurrentTask('fakebook');
      expect(task.telegramContext.sourceReadOnly).toBe(true);
      task._lastError = 'pinnacle stale';
      task._telegramStartSent = false;

      // Reset call log to focus on the failure-path send.
      sendToAllCalls.length = 0;

      await bettor._finalizeTaskFailure(task);

      // Find the pre-check failure notice
      const failCall = sendToAllCalls.find(c => /pre-check/i.test(c.text || ''));
      expect(failCall).toBeDefined();
      expect(failCall.options).toMatchObject({
        bookmaker: 'FakeBook',
        sourceReadOnly: true
      });
      expect(failCall.options.chatIds).toEqual(expect.arrayContaining(['-200200200']));
      // Compute targets via the (faked) collector to assert the routing outcome.
      const targets = bettor.telegram._collectTargetChatIds(failCall.options);
      expect(targets).toContain('-200200200');
      expect(targets).not.toContain('BOOKMAKER_DEFAULT_CHAT');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// F4
// -----------------------------------------------------------------------------
describe('F4 — sourceReadOnly cluster STOP fails closed without explicit allowedSenders', () => {
  function buildClusterProfileManager() {
    return new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          // Mirrors live vova_cluster / supernova_cluster shape:
          // feedbackChatIds is set, sourceReadOnly is true, but NO allowedSenders.
          vova_cluster: {
            sourceReadOnly: true,
            sourceChatIds: [-1002010985531],
            feedbackChatIds: [-1003717712631],
            liveEnabled: true
          }
        }
      }
    });
  }

  test('isSenderAllowed returns false for sourceReadOnly profile without allowlist', () => {
    const mgr = buildClusterProfileManager();
    const profile = mgr.getProfile('vova_cluster');
    expect(profile.sourceReadOnly).toBe(true);
    expect(profile.hasSenderAllowlist).toBe(false);
    expect(mgr.isSenderAllowed(profile, { authorId: 12345, authorUsername: 'random_user' })).toBe(false);
  });

  test('non-author STOP from feedback chat is rejected (override branch fails closed)', async () => {
    const mgr = buildClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: mgr,
      signalParser: {
        detectMessageIntent: jest.fn(async () => ({ intentType: 'stop', confidence: 0.9 })),
        parseSession: jest.fn()
      },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onStopSignal: jest.fn(async () => ({ accepted: true, cancelled: true }))
    });

    // Inject a queued draft authored by user 1111, target the cluster profile.
    const profile = mgr.getProfile('vova_cluster');
    const draft = {
      id: 'sig-stop',
      profile,
      authorId: 1111,
      session: { chatId: -1002010985531, topicId: null, toLLMPayload: () => ({ messageIds: [] }) },
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set(),
      taskId: 'task-1',
      taskState: 'queued'
    };
    ingress.activeDrafts.set('sig-stop', draft);

    // Hijack _resolveStopTarget to return the draft for this synthetic msg.
    ingress._resolveStopTarget = () => draft;

    // Track _sendSourceChatMessage to capture rejection text.
    const sentMessages = [];
    ingress._sendSourceChatMessage = jest.fn(async (_, text) => {
      sentMessages.push(text);
      return { ok: true, result: { message_id: 1 } };
    });

    await ingress._handleStopMessage(
      {
        chatId: -1003717712631,
        topicId: null,
        messageId: 9000,
        replyToMessageId: 8000,
        authorId: 99999,
        authorUsername: 'rando'
      },
      profile,
      { intentType: 'stop' }
    );

    expect(ingress.onStopSignal).not.toHaveBeenCalled();
    expect(sentMessages.some(t => /только автору/.test(t))).toBe(true);
  });

  test('author-id STOP still works for the cluster profile', async () => {
    const mgr = buildClusterProfileManager();
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: mgr,
      signalParser: {
        detectMessageIntent: jest.fn(async () => ({ intentType: 'stop', confidence: 0.9 })),
        parseSession: jest.fn()
      },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onStopSignal
    });

    const profile = mgr.getProfile('vova_cluster');
    const draft = {
      id: 'sig-author',
      profile,
      authorId: 1111,
      session: { chatId: -1002010985531, topicId: null, toLLMPayload: () => ({ messageIds: [] }) },
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set(),
      taskId: 'task-2',
      taskState: 'queued'
    };
    ingress.activeDrafts.set('sig-author', draft);
    ingress._resolveStopTarget = () => draft;
    ingress._sendSourceChatMessage = jest.fn(async () => ({ ok: true, result: { message_id: 2 } }));
    ingress._archiveDraft = jest.fn();

    await ingress._handleStopMessage(
      {
        chatId: -1002010985531,
        topicId: null,
        messageId: 9001,
        authorId: 1111,
        authorUsername: 'author'
      },
      profile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).toHaveBeenCalledTimes(1);
  });
});
