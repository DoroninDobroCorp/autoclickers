process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const { BaseBettor } = require('../betting/BaseBettor.js');

describe('BaseBettor attempt debug wiring', () => {
  test('starts and finishes adapter attempt diagnostics around bet processing', async () => {
    const bettor = Object.create(BaseBettor.prototype);
    bettor.bookmakerName = 'Sansabet';
    bettor.bookmakerId = 'sansabet';
    bettor.analyzerAvailable = true;
    bettor.state = { errors: 0 };
    bettor.logger = { log: jest.fn() };
    bettor.adapter = {
      beginAttemptDebug: jest.fn(),
      finishAttemptDebug: jest.fn(),
      captureAttemptDebug: jest.fn()
    };
    bettor.betProcessor = {
      analyzerAvailable: false,
      process: jest.fn(async () => ({ success: false, shouldRetry: false }))
    };

    const task = { id: 'tg-1', home: 'A', away: 'B', isPrematch: false };
    const result = await bettor._processBetAttempt(task, 2);

    expect(result).toEqual({ success: false, shouldRetry: false });
    expect(bettor.betProcessor.analyzerAvailable).toBe(true);
    expect(bettor.adapter.beginAttemptDebug).toHaveBeenCalledWith(task, expect.objectContaining({
      attempt: 2,
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    }));
    expect(bettor.adapter.finishAttemptDebug).toHaveBeenCalledWith(task, 'failed', expect.objectContaining({
      attempt: 2,
      result: { success: false, shouldRetry: false }
    }));
    expect(bettor.state.errors).toBe(1);
  });
});