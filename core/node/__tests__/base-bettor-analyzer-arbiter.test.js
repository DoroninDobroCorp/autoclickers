process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

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

class FakeAdapter {
  constructor() {
    this.bookmakerName = 'FakeBook';
    this.isPrematch = false;
  }

  async login() { return true; }
  async close() { return true; }
  async isSessionValid() { return true; }
  getSportId() { return 1; }
  parseError() {
    return { retryable: false };
  }
}

function createAnalyzerTracker(overrides = {}) {
  const nowIso = new Date().toISOString();
  const pair = overrides.pair || {
    first: {
      bookmaker: 'FakeBook',
      homeName: 'Team A',
      awayName: 'Team B',
      leagueName: 'Premier League',
      matchId: 'fb-match-1',
      matchDate: '2026-03-24T18:00:00.000Z',
      createdAt: nowIso,
    },
    second: {
      bookmaker: 'Pinnacle',
      homeName: 'Team A',
      awayName: 'Team B',
      leagueName: 'Premier League',
      matchId: 'pin-match-1',
      createdAt: nowIso,
    },
    sportName: 'Soccer',
    isLive: true,
  };

  const outcomeData = overrides.outcomeData || {
    outcome: 'T> 2.5',
    roi: 8.5,
    score1: { value: 1.92 },
    score2: { value: 1.95 },
  };

  const matchId = `${pair.first.matchId}_${pair.second.matchId}`;
  const tracker = {
    key: overrides.key || `${matchId}_${outcomeData.outcome}_single`,
    matchId,
    pair,
    outcomeData,
    type: overrides.type || 'single',
    outcome: overrides.outcome || outcomeData.outcome,
    lastROI: overrides.lastROI ?? outcomeData.roi,
    lastSeenAt: overrides.lastSeenAt || Date.now(),
    accumulatedStabilityMs: overrides.accumulatedStabilityMs || 6000,
    allowLowROI: overrides.allowLowROI || false,
    betPlaced: overrides.betPlaced || false,
  };

  return tracker;
}

describe('BaseBettor analyzer arbiter', () => {
  let tmpDir;
  let tasksFilePath;
  let stateFilePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-bettor-analyzer-'));
    tasksFilePath = path.join(tmpDir, 'tasks.json');
    stateFilePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should enable shared task runner in analyzer-only mode when tasks file is configured', () => {
    const bettor = new BaseBettor(new FakeAdapter(), {
      executionMode: 'analyzer-only',
      tasksFilePath,
      stateFilePath,
      logger: createLogger(),
      tgQuiet: true,
      singleStrategy: true,
      stake: 1,
    });

    expect(bettor.config.enableAnalyzerPolling).toBe(true);
    expect(bettor.config.enableTelegramQueue).toBe(false);
    expect(bettor.config.enableTaskRunner).toBe(true);
    expect(bettor.tasksManager).not.toBeNull();
  });

  test('should queue analyzer task and allow telegram to replace it before execution starts', async () => {
    const bettor = new BaseBettor(new FakeAdapter(), {
      executionMode: 'hybrid',
      tasksFilePath,
      stateFilePath,
      logger: createLogger(),
      tgQuiet: true,
      singleStrategy: true,
      stake: 1,
    });
    const tracker = createAnalyzerTracker();
    bettor.stabilityTracker.trackers.set(tracker.key, tracker);

    await bettor._processStableTracker(tracker);

    const analyzerCurrent = bettor.tasksManager.getCurrentTask('fakebook');
    expect(analyzerCurrent).toMatchObject({
      sourceType: 'analyzer',
      outcome: 'T> 2.5',
    });
    expect(tracker.betPlaced).toBe(false);

    const tgResult = await bettor.enqueueTelegramTask({
      home: 'TG Home',
      away: 'TG Away',
      outcome: '1',
      originChatId: '-2002',
    });

    expect(tgResult.accepted).toBe(true);
    expect(bettor.tasksManager.getCurrentTask('fakebook')).toMatchObject({
      sourceType: 'telegram',
      home: 'TG Home',
      away: 'TG Away',
    });
    expect(tracker.betPlaced).toBe(false);
  });

  test('should mark analyzer tracker as placed when execution actually starts', async () => {
    const bettor = new BaseBettor(new FakeAdapter(), {
      executionMode: 'analyzer-only',
      tasksFilePath,
      stateFilePath,
      logger: createLogger(),
      tgQuiet: true,
      singleStrategy: true,
      stake: 1,
    });
    const tracker = createAnalyzerTracker();
    bettor.stabilityTracker.trackers.set(tracker.key, tracker);

    await bettor._processStableTracker(tracker);
    const queuedTask = bettor.tasksManager.getCurrentTask('fakebook');

    bettor.betProcessor.process = jest.fn(async (runtimeTask) => {
      runtimeTask._betSucceeded = true;
      runtimeTask._betDetails = {
        odds: 1.91,
        stake: runtimeTask.stake,
        ticketId: 'ticket-1',
      };
      bettor.tasksManager.recordTaskResult(runtimeTask, 'completed', {
        odds: 1.91,
        stake: runtimeTask.stake,
        ticketId: 'ticket-1',
      });
      return { success: true };
    });

    await bettor._executeQueuedTask(queuedTask);

    expect(tracker.betPlaced).toBe(true);
    expect(bettor.tasksManager.getCurrentTask('fakebook')).toBeNull();
    expect(bettor.tasksManager.getHistory('fakebook', { limit: 10 })).toHaveLength(1);
    expect(bettor.tasksManager.getHistory('fakebook', { limit: 10 })[0].status).toBe('completed');
  });
});
