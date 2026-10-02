process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';
process.env.MOCK_VISION = process.env.MOCK_VISION || '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseBettor } = require('../betting/BaseBettor.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
  };
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

describe('BaseBettor telegram queue', () => {
  test('final task failure preserves specific non-code failure step', async () => {
    const bettor = Object.create(BaseBettor.prototype);
    bettor.config = { tgQuiet: true, maxBets: Infinity };
    bettor.limitsManager = { getState: jest.fn(() => ({ betAttempts: 1 })) };
    bettor.tasksManager = { recordTaskResult: jest.fn() };
    bettor.telegram = { notifyTaskFailed: jest.fn(), sendToAll: jest.fn() };

    const task = {
      id: 'tg1',
      taskId: 'tg1',
      sourceType: 'telegram',
      source: 'telegram_sandbox_cluster',
      _telegramStartSent: true,
      _lastError: 'Insufficient balance: 0.00 < 5.00 EUR (min stake)',
      _lastFailureStep: 'insufficient_balance',
      home: 'Austria',
      away: 'Jordan',
      outcome: '1'
    };

    await bettor._finalizeTaskFailure(task);

    expect(bettor.tasksManager.recordTaskResult).toHaveBeenCalledWith(task, 'failed', {
      message: 'Insufficient balance: 0.00 < 5.00 EUR (min stake)',
      step: 'insufficient_balance'
    });
  });

  test('should use dedicated Telegram ingress token when notifier token is different', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-ingress-token-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');
    const previousIngressToken = process.env.TELEGRAM_INGRESS_BOT_TOKEN;
    const previousTgToken = process.env.TG_TOKEN;
    const previousNotifierToken = process.env.TELEGRAM_BOT_TOKEN;

    try {
      process.env.TELEGRAM_INGRESS_BOT_TOKEN = '999000111:ingress-token';
      delete process.env.TG_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = '888000111:notifier-token';

      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
        telegram: {
          ingress: {
            enabled: true,
            bookmakerAdapter: createFakeBookmakerAdapter()
          }
        }
      });

      expect(bettor._telegramIngressInitError).toBeNull();
      expect(bettor.telegramBotClient.botToken).toBe('999000111:ingress-token');
    } finally {
      if (previousIngressToken === undefined) delete process.env.TELEGRAM_INGRESS_BOT_TOKEN;
      else process.env.TELEGRAM_INGRESS_BOT_TOKEN = previousIngressToken;
      if (previousTgToken === undefined) delete process.env.TG_TOKEN;
      else process.env.TG_TOKEN = previousTgToken;
      process.env.TELEGRAM_BOT_TOKEN = previousNotifierToken;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should fail closed when only generic notifier token is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-ingress-failclosed-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');
    const previousIngressToken = process.env.TELEGRAM_INGRESS_BOT_TOKEN;
    const previousTgToken = process.env.TG_TOKEN;
    const previousNotifierToken = process.env.TELEGRAM_BOT_TOKEN;

    try {
      delete process.env.TELEGRAM_INGRESS_BOT_TOKEN;
      delete process.env.TG_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = '888000111:notifier-token';

      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
        telegram: {
          ingress: { enabled: true }
        }
      });

      expect(bettor.telegramBotClient).toBeNull();
      expect(bettor._telegramIngressInitError).toContain('TELEGRAM_INGRESS_BOT_TOKEN');
    } finally {
      if (previousIngressToken === undefined) delete process.env.TELEGRAM_INGRESS_BOT_TOKEN;
      else process.env.TELEGRAM_INGRESS_BOT_TOKEN = previousIngressToken;
      if (previousTgToken === undefined) delete process.env.TG_TOKEN;
      else process.env.TG_TOKEN = previousTgToken;
      process.env.TELEGRAM_BOT_TOKEN = previousNotifierToken;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should enqueue telegram task with implicit default policy in telegram-only mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
        telegram: {
          defaults: {
            defaultMinOdds: 1.8,
            brm: { stake: 12 },
            limits: { maxTotalPerMatch: 14, maxStakePerStrategy: 9 }
          }
        }
      });

      const result = await bettor.enqueueTelegramTask({
        home: 'Home',
        away: 'Away',
        outcome: '1',
        originChatId: '-2002'
      });

      expect(result.accepted).toBe(true);
      expect(bettor.config.enableAnalyzerPolling).toBe(false);
      expect(bettor.config.enableTelegramQueue).toBe(true);

      const current = bettor.tasksManager.getCurrentTask('fakebook');
      expect(current).toMatchObject({
        home: 'Home',
        away: 'Away',
        outcome: '1',
        sourceType: 'telegram',
        sourceProfileId: 'default',
        minOdds: 1.8,
        stake: 12,
        originChatId: '-2002',
        limitProfileKey: 'telegram:default:fakebook:default:live'
      });
      expect(current.telegramPolicy.limits).toMatchObject({
        maxTotalPerMatch: 14,
        maxStakePerStrategy: 9
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should update existing queued telegram task by signalId', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-update-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true
      });

      const first = await bettor.enqueueTelegramTask({
        signalId: 'sig-1',
        home: 'Home',
        away: 'Away',
        outcome: '1',
        originChatId: '-2002'
      });
      const second = await bettor.enqueueTelegramTask({
        signalId: 'sig-1',
        home: 'Home',
        away: 'Away',
        outcome: 'X',
        minOdds: 1.95,
        originChatId: '-2002'
      });

      expect(first.accepted).toBe(true);
      expect(second).toMatchObject({
        accepted: true,
        updated: true,
        taskId: first.taskId
      });

      const current = bettor.tasksManager.getCurrentTask('fakebook');
      expect(current).toMatchObject({
        id: first.taskId,
        signalId: 'sig-1',
        outcome: 'X',
        minOdds: 1.95
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should cancel queued telegram task by signalId before execution', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-stop-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true
      });

      const queued = await bettor.enqueueTelegramTask({
        signalId: 'sig-stop',
        home: 'Home',
        away: 'Away',
        outcome: '1',
        originChatId: '-2002'
      });
      const stopped = await bettor.stopTelegramSignal({
        signalId: 'sig-stop',
        requesterUserId: 101,
        requesterUsername: 'capper_one'
      });

      expect(queued.accepted).toBe(true);
      expect(stopped).toMatchObject({
        accepted: true,
        cancelled: true,
        taskId: queued.taskId
      });
      expect(bettor.tasksManager.getCurrentTask('fakebook')).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should preserve prematch telegram mode even on live runtime', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-prematch-mode-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');
    const logger = createLogger();

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger,
        tgQuiet: true
      });

      const result = await bettor.enqueueTelegramTask({
        home: 'Kobori M./Saito S.',
        away: 'Bassols Ribera M./Lazaro Garcia A.',
        outcome: '2',
        sport: 'tennis',
        mode: 'prematch',
        bookmakerMatchId: '5052936',
        originChatId: '-2002'
      });

      expect(result.accepted).toBe(true);
      expect(bettor.tasksManager.getCurrentTask('fakebook')).toMatchObject({
        home: 'Kobori M./Saito S.',
        away: 'Bassols Ribera M./Lazaro Garcia A.',
        outcome: '2',
        sport: 'tennis',
        mode: 'prematch',
        isPrematch: true,
        pair: { sportName: 'tennis' },
        limitProfileKey: 'telegram:default:fakebook:default:prematch'
      });
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Telegram task mode differs from runtime'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('sourceReadOnly profile must NOT add originChatId into feedbackChatIds', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-readonly-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
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

      const result = await bettor.enqueueTelegramTask({
        home: 'A',
        away: 'B',
        outcome: '1',
        originChatId: '-100100100',
        chatId: '-100100100',
        sourceProfileId: 'ro_cluster',
        telegramContext: { profileId: 'ro_cluster' }
      });

      expect(result.accepted).toBe(true);
      const task = bettor.tasksManager.getCurrentTask('fakebook');
      expect(task.telegramContext.sourceReadOnly).toBe(true);
      // Source chat must not appear in feedbackChatIds (top-level or context)
      expect(task.feedbackChatIds).not.toContain('-100100100');
      expect(task.telegramContext.feedbackChatIds).not.toContain('-100100100');
      // The dedicated feedback chat must remain
      expect(task.feedbackChatIds).toContain('-200200200');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // F1 regression: implicit policy fallback (profile id renamed/removed)
  // must NOT add originChatId into feedbackChatIds when the upstream
  // ingress already marked the signal as sourceReadOnly.
  test('implicit policy with unknown sourceReadOnly profile must fail-closed (no source chat in feedback)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-implicit-readonly-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
        telegram: {
          // ro_cluster_v2 deliberately NOT registered — simulates rename/typo
          defaults: {
            feedbackChatIds: ['-200200200'],
            brm: { stake: 7 }
          }
        }
      });

      const result = await bettor.enqueueTelegramTask({
        home: 'A',
        away: 'B',
        outcome: '1',
        originChatId: '-100100100',
        chatId: '-100100100',
        sourceProfileId: 'ro_cluster_v2',
        telegramContext: {
          profileId: 'ro_cluster_v2',
          sourceReadOnly: true,
          originChatId: '-100100100'
        }
      });

      expect(result.accepted).toBe(true);
      const task = bettor.tasksManager.getCurrentTask('fakebook');
      // Implicit policy must preserve sourceReadOnly so notifier guards stay armed
      expect(task.telegramContext.sourceReadOnly).toBe(true);
      // originChatId must NOT have leaked into feedbackChatIds at any layer
      expect(task.feedbackChatIds).not.toContain('-100100100');
      expect(task.telegramContext.feedbackChatIds).not.toContain('-100100100');
      // Configured fallback feedback chat is still present
      expect(task.feedbackChatIds).toContain('-200200200');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // F1 regression: even without an explicit sourceReadOnly hint, an unknown
  // non-default profile id must be treated as fail-closed (originChatId
  // dropped). Otherwise a deploy-time rename re-opens the source-chat leak.
  test('implicit policy with unknown non-default profile drops originChatId from feedback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-implicit-unknown-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');
    const stateFilePath = path.join(tmpDir, 'state.json');

    try {
      const bettor = new BaseBettor(new FakeAdapter(), {
        executionMode: 'telegram-only',
        tasksFilePath,
        stateFilePath,
        logger: createLogger(),
        tgQuiet: true,
        telegram: {
          defaults: {
            feedbackChatIds: ['-200200200'],
            brm: { stake: 7 }
          }
        }
      });

      const result = await bettor.enqueueTelegramTask({
        home: 'A',
        away: 'B',
        outcome: '1',
        originChatId: '-100100100',
        chatId: '-100100100',
        sourceProfileId: 'renamed_cluster_v9'
      });

      expect(result.accepted).toBe(true);
      const task = bettor.tasksManager.getCurrentTask('fakebook');
      expect(task.telegramContext.sourceReadOnly).toBe(true);
      expect(task.feedbackChatIds).not.toContain('-100100100');
      expect(task.telegramContext.feedbackChatIds).not.toContain('-100100100');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
