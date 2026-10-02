process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const { BetProcessor } = require('../BetProcessor.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
  };
}

describe('BetProcessor telegram finished live matches', () => {
  test('fails immediately when the matched live event is already finished', async () => {
    const adapter = {
      findOutcome: jest.fn(() => null),
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: { tgQuiet: true, highROIThreshold: 10 },
    });

    const task = {
      home: 'Krajicek A./Mektic N.',
      away: 'Arevalo M./Pavic M.',
      outcome: '1',
      candidateLadder: [],
      sourceType: 'telegram',
    };

    const match = {
      H: { PID: 5055105, MS: 'F', ES: 'C', marketcounter: 0 },
      odds: {
        H: { PID: 5055105, MS: 'F', ES: 'C', marketcounter: 0 },
        M: [],
      },
      M: [],
      sport: 'tennis',
    };

    const result = await processor._findAndValidateTelegramOutcome(task, match);

    expect(result).toEqual({
      success: false,
      result: {
        success: false,
        shouldRetry: false,
        step: 'market_closed',
      },
    });
    expect(task._lastError).toContain('live match already finished on bookmaker');
    expect(task._lastError).toContain('MS=F');
    expect(adapter.findOutcome).not.toHaveBeenCalled();
  });

  test('stops telegram outcome recheck once refreshed live data shows the match finished', async () => {
    const adapter = {
      findOutcome: jest.fn(() => null),
      getMatchDetails: jest.fn(async () => ({
        odds: {
          H: { PID: 5055105, MS: 'F', ES: 'C', marketcounter: 0 },
          M: [],
        },
        markets: [],
        sport: 'tennis',
      })),
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: {
        tgQuiet: true,
        highROIThreshold: 10,
        telegram: {
          outcomeRecheck: {
            enabled: true,
            intervalMs: 1,
            totalWindowMs: 20,
          },
        },
      },
    });

    const task = {
      home: 'Krajicek A./Mektic N.',
      away: 'Arevalo M./Pavic M.',
      outcome: '1',
      candidateLadder: [],
      sourceType: 'telegram',
      pair: { sportName: 'tennis' },
      bookmakerMatchId: 5055105,
    };

    const match = {
      H: { PID: 5055105, MS: 'LIVE', ES: 'A', marketcounter: 1 },
      odds: {
        H: { PID: 5055105, MS: 'LIVE', ES: 'A', marketcounter: 1 },
        M: [],
      },
      M: [],
      sport: 'tennis',
    };

    const result = await processor._findAndValidateTelegramOutcome(task, match);

    expect(result).toEqual({
      success: false,
      result: {
        success: false,
        shouldRetry: false,
        step: 'market_closed',
      },
    });
    expect(adapter.getMatchDetails).toHaveBeenCalledWith(5055105, 'tennis');
    expect(adapter.findOutcome).toHaveBeenCalledTimes(1);
    expect(task._lastError).toContain('live match already finished on bookmaker');
  });

  test('notifies feedback routing when telegram outcome enters recheck wait', async () => {
    const adapter = {
      findOutcome: jest.fn(() => null),
    };
    const telegram = {
      sendToAll: jest.fn(async () => []),
      notifyTaskFailed: jest.fn(async () => []),
      escapeHtml: (value) => String(value),
      _getRoutingOptionsForTask: jest.fn(() => ({
        chatIds: ['-9001'],
        sourceReadOnly: true,
      })),
    };

    const processor = new BetProcessor({
      adapter,
      telegram,
      logger: createLogger(),
      config: {
        tgQuiet: false,
        highROIThreshold: 10,
        telegram: {
          outcomeRecheck: {
            enabled: true,
            intervalMs: 1,
            totalWindowMs: 3,
          },
        },
      },
    });

    const task = {
      id: 'tg-1',
      home: 'Real Madrid',
      away: 'Alaves',
      outcome: 'H1 -2.5',
      candidateLadder: [
        { outcome: 'H1 -2.5' },
        { outcome: '3WH -2 1' },
      ],
      sourceType: 'telegram',
      feedbackChatIds: ['-9001'],
      telegramContext: {
        sourceReadOnly: true,
        feedbackChatIds: ['-9001'],
      },
    };
    const match = {
      H: { PID: 5063122, MS: 'LIVE', ES: 'A', marketcounter: 1 },
      odds: {
        H: { PID: 5063122, MS: 'LIVE', ES: 'A', marketcounter: 1 },
        M: [],
      },
      M: [],
      sport: 'soccer',
    };

    const result = await processor._findAndValidateTelegramOutcome(task, match);

    // After the 2026-05-29 fast-fail patch in BetProcessor.js, when the
    // bookmaker entry has zero markets throughout marketMissingWindowMs we
    // emit a more specific step name instead of the generic timeout. The
    // user-facing semantic (could not find outcome) is identical.
    expect(result).toEqual({
      success: false,
      result: {
        success: false,
        shouldRetry: false,
        step: 'outcome_recheck_no_markets',
      },
    });
    expect(telegram.sendToAll).toHaveBeenCalledWith(
      expect.stringContaining('ИСХОД ПОКА НЕ ДОСТУПЕН'),
      expect.objectContaining({
        chatIds: ['-9001'],
        sourceReadOnly: true,
      })
    );
    expect(telegram.sendToAll.mock.calls[0][0]).toContain('3WH -2 1');
    expect(telegram.notifyTaskFailed).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ step: 'outcome_not_found' })
    );
  });
});
