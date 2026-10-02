const fs = require('fs');
const os = require('os');
const path = require('path');
const { TasksManager } = require('../tasks/tasks-manager.js');

describe('TasksManager source-aware priority', () => {
  let tempDir;
  let tasksFilePath;
  let manager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-source-'));
    tasksFilePath = path.join(tempDir, 'bet_tasks.json');
    manager = new TasksManager({
      tasksFilePath,
      betting: {
        stake: 6,
        minOdds: 1.7,
        maxOdds: 4.0,
        highROI: { threshold: 15, stake: 7, maxTotalPerMatch: 20 },
        telegram: { stake: 10, minOdds: 1.7, maxOdds: 10, maxTotalPerMatch: 30 },
        protection: { maxFailedAttempts: 3, blockDurationMinutes: 15 }
      }
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  test('analyzer_fast should still behave as low-priority analyzer', () => {
    const first = manager.addTask({
      id: 1,
      bookmakerId: 'sansabet',
      home: 'Team A',
      away: 'Team B',
      outcome: 'T> 2.5',
      source: 'analyzer_fast',
      expectedROI: 9
    });

    const second = manager.addTask({
      id: 2,
      bookmakerId: 'sansabet',
      home: 'Team C',
      away: 'Team D',
      outcome: '1',
      source: 'analyzer_slow',
      expectedROI: 8
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(manager.getCurrentTask('sansabet').id).toBe(1);
  });

  test('telegram should replace analyzer_fast in current slot', () => {
    manager.addTask({
      id: 1,
      bookmakerId: 'sansabet',
      home: 'Team A',
      away: 'Team B',
      outcome: 'T> 2.5',
      source: 'analyzer_fast',
      expectedROI: 9
    });

    const replaced = manager.addTask({
      id: 2,
      bookmakerId: 'sansabet',
      home: 'Team A',
      away: 'Team B',
      outcome: 'T> 3.5',
      sourceType: 'telegram',
      sourceProfileId: 'vip',
      expectedROI: null
    });

    const current = manager.getCurrentTask('sansabet');
    expect(replaced).toBe(true);
    expect(current.id).toBe(2);
    expect(current.source).toBe('telegram_vip');
    expect(current.sourceType).toBe('telegram');
  });

  test('telegram profiles should use separate match limit buckets', () => {
    const vipTask = {
      id: 'tg-vip-1',
      bookmakerId: 'sansabet',
      home: 'Team A',
      away: 'Team B',
      outcome: 'T> 2.5',
      sourceType: 'telegram',
      sourceProfileId: 'vip',
      mode: 'live',
      stake: 6,
      telegramPolicy: {
        stake: 6,
        limits: {
          maxTotalPerMatch: 10
        }
      }
    };

    expect(manager.addTask(vipTask)).toBe(true);
    expect(manager.recordTaskResult(vipTask, 'completed', { odds: 1.9, stake: 6 })).toBe(true);

    const vipSecond = {
      ...vipTask,
      id: 'tg-vip-2',
      outcome: 'T> 3.5'
    };

    expect(manager.addTask(vipSecond)).toBe(false);

    const regularTask = {
      ...vipTask,
      id: 'tg-regular-1',
      sourceProfileId: 'regular',
      outcome: '1',
      limitProfileKey: undefined
    };

    expect(manager.addTask(regularTask)).toBe(true);
    const current = manager.getCurrentTask('sansabet');
    expect(current.limitProfileKey).toBe('telegram:regular:sansabet:default:live');
  });
});
