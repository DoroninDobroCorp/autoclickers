const fs = require('fs');
const os = require('os');
const path = require('path');
const { TasksManager } = require('../tasks/tasks-manager.js');

describe('TasksManager recordTaskResult', () => {
  test('should persist updated queued task fields before completion', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        id: 'tg-1',
        bookmakerId: 'fakebook',
        home: 'Home',
        away: 'Away',
        outcome: 'T> 3.5',
        sourceType: 'telegram',
        stake: 10
      };

      expect(manager.addTask(task)).toBe(true);

      const runtimeTask = {
        ...task,
        outcome: 'T> 2.5',
        stake: 12
      };

      expect(manager.recordTaskResult(runtimeTask, 'completed', { odds: 1.88, stake: 12 })).toBe(true);

      const history = manager.getHistory('fakebook', { limit: 10 });
      expect(history).toHaveLength(1);
      expect(history[0].outcome).toBe('T> 2.5');
      expect(history[0].stake).toBe(12);
      expect(manager.getCurrentTask('fakebook')).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should mark safe max stake telegram failure as non-blocking', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-safe-max-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        id: 'tg-safe-1',
        bookmakerId: 'sansabet',
        home: 'PSG',
        away: 'Liverpool',
        outcome: 'P1 1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 10,
        mode: 'live'
      };

      expect(manager.recordBetResult(task, 'failed', {
        message: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR',
        step: 'bet_submit'
      })).toBe(true);

      const history = manager.getHistory('sansabet', { limit: 10 });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: 'failed',
        nonBlockingFailure: true,
        failureClass: 'safe_max_stake_reject',
        step: 'bet_submit'
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should mark singles blocked telegram failure as non-blocking', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-singles-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        id: 'tg-safe-2',
        bookmakerId: 'sansabet',
        home: 'Chapecoense',
        away: 'Avai',
        outcome: '1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 10,
        mode: 'live'
      };

      expect(manager.recordBetResult(task, 'failed', {
        message: 'Singles not allowed',
        step: 'singles_blocked'
      })).toBe(true);

      const history = manager.getHistory('sansabet', { limit: 10 });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: 'failed',
        nonBlockingFailure: true,
        failureClass: 'singles_blocked',
        step: 'singles_blocked'
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should persist bookmaker-submit balance metadata for queued failures', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-balance-stage-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        id: 'tg-balance-1',
        bookmakerId: 'sansabet',
        home: 'Argentina',
        away: 'Honduras',
        outcome: '1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 5,
        mode: 'live'
      };

      expect(manager.addTask(task)).toBe(true);
      expect(manager.recordTaskResult(task, 'failed', {
        message: 'Nemate dovoljno sredstva na računu',
        step: 'insufficient_balance',
        failureClass: 'insufficient_balance',
        failureStage: 'bookmaker_submit',
        submitReached: true,
        bookmakerRejected: true
      })).toBe(true);

      const history = manager.getHistory('sansabet', { limit: 10 });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: 'failed',
        error: 'Nemate dovoljno sredstva na računu',
        step: 'insufficient_balance',
        failureClass: 'insufficient_balance',
        failureStage: 'bookmaker_submit',
        submitReached: true,
        bookmakerRejected: true,
        nonBlockingFailure: true
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should not block a match after repeated telegram insufficient balance submit rejects', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-balance-nonblock-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        bookmakerId: 'sansabet',
        matchKey: 'argentina_honduras',
        home: 'Argentina',
        away: 'Honduras',
        outcome: '1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 5,
        mode: 'live'
      };

      for (let index = 0; index < 3; index += 1) {
        expect(manager.recordBetResult({ ...task, id: `tg-balance-${index}` }, 'failed', {
          message: 'Nemate dovoljno sredstva na računu',
          step: 'insufficient_balance',
          failureClass: 'insufficient_balance',
          failureStage: 'bookmaker_submit',
          submitReached: true,
          bookmakerRejected: true
        })).toBe(true);
      }

      expect(manager.isMatchBlocked('argentina_honduras')).toBe(false);
      expect(manager.isOutcomeBlocked('argentina_honduras', '1')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should not block a match after repeated telegram account-limit submit rejects', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-account-limit-nonblock-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        bookmakerId: 'vbet',
        matchKey: 'argentina_honduras',
        home: 'Argentina',
        away: 'Honduras',
        outcome: '1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 99999999,
        mode: 'live'
      };

      for (let index = 0; index < 3; index += 1) {
        expect(manager.recordBetResult({ ...task, id: `tg-vbet-limit-${index}` }, 'failed', {
          message: 'RequiredSessionLimitsDoesNotSet',
          step: 'bet_submit',
          failureClass: 'account_limits_required',
          failureStage: 'bookmaker_submit',
          submitReached: true,
          bookmakerRejected: true
        })).toBe(true);
      }

      expect(manager.isMatchBlocked('argentina_honduras')).toBe(false);
      expect(manager.isOutcomeBlocked('argentina_honduras', '1')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should not block a match after repeated telegram selection-not-allowed submit rejects', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-manager-selection-not-allowed-'));
    const tasksFilePath = path.join(tmpDir, 'tasks.json');

    try {
      const manager = new TasksManager({ tasksFilePath });
      const task = {
        bookmakerId: 'sansabet',
        matchKey: 'supra_du_quebec_pacific_fc',
        home: 'Supra du Quebec',
        away: 'Pacific FC',
        outcome: '1',
        source: 'telegram_default',
        sourceType: 'telegram',
        betCategory: 'telegram',
        stake: 5,
        mode: 'live'
      };

      for (let index = 0; index < 3; index += 1) {
        expect(manager.recordBetResult({ ...task, id: `tg-selection-${index}` }, 'failed', {
          message: 'Tip nije dozvoljen za klađenje Supra du Quebec : Pacific FC<br/> [PK.4]',
          step: 'bet_submit',
          failureStage: 'bookmaker_submit',
          submitReached: true,
          bookmakerRejected: true
        })).toBe(true);
      }

      const history = manager.getHistory('sansabet', { limit: 10 });
      expect(history[0]).toMatchObject({
        nonBlockingFailure: true,
        failureClass: 'selection_not_allowed'
      });
      expect(manager.isMatchBlocked('supra_du_quebec_pacific_fc')).toBe(false);
      expect(manager.isOutcomeBlocked('supra_du_quebec_pacific_fc', '1')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
