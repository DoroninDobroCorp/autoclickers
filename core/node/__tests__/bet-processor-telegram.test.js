process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { BetProcessor } = require('../betting/BetProcessor.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
  };
}

describe('BetProcessor telegram outcome flow', () => {
  test('should treat zero balance as verified insufficient funds', async () => {
    const adapter = {
      getBalance: jest.fn(async () => 0)
    };
    const processor = new BetProcessor({
      adapter,
      logger: createLogger()
    });

    const result = await processor._checkBalanceSufficient(1);

    expect(result).toEqual({ ok: false, balance: 0, stake: 1 });
  });

  test('should skip balance checks in dry-run mode', async () => {
    const adapter = {
      getBalance: jest.fn(async () => 0)
    };
    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: { dryRun: true }
    });

    const result = await processor._checkBalanceSufficient(5);

    expect(result).toEqual({ ok: true, dryRun: true });
    expect(adapter.getBalance).not.toHaveBeenCalled();
  });

  test('should stop before match lookup on zero balance by default', async () => {
    const adapter = {
      getBalance: jest.fn(async () => 0),
      parseError: jest.fn(() => ({ retryable: false }))
    };
    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: {
        dryRun: false,
        tgQuiet: true,
        stake: 5
      }
    });

    processor._runPreChecks = jest.fn(async () => ({ ok: true }));
    processor._findMatch = jest.fn(async () => ({ success: true, match: { id: 'match-1' } }));

    const result = await processor.process({
      id: 'tg-early-balance',
      bookmakerId: 'sansabet',
      home: 'Home',
      away: 'Away',
      outcome: '1',
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 5,
      pair: { sportName: 'soccer' }
    });

    expect(result).toEqual({
      success: false,
      shouldRetry: false,
      step: 'insufficient_balance',
      message: 'Insufficient balance: 0.00 < 5.00 EUR (min stake)'
    });
    expect(processor._findMatch).not.toHaveBeenCalled();
  });

  test('should defer zero-balance smoke tests until bookmaker submit when configured', async () => {
    const calls = [];
    const tasksManager = {
      recordTaskResult: jest.fn(),
      getRecentlyFailedOutcomes: jest.fn(() => new Set())
    };
    const adapter = {
      getBalance: jest.fn(async () => 0),
      prepareBet: jest.fn(async () => { calls.push('prepareBet'); }),
      placeBet: jest.fn(async () => {
        calls.push('placeBet');
        return { success: false, error: 'Nemate dovoljno sredstva na računu' };
      }),
      parseError: jest.fn((result) => {
        if (/sredstva/i.test(result.error || '')) {
          return { type: 'insufficient_balance', message: result.error, retryable: false };
        }
        return { type: 'unknown', message: result.error, retryable: false };
      })
    };
    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      tasksManager,
      bookmakerName: 'Sansabet',
      config: {
        balanceCheckMode: 'bookmaker-submit',
        dryRun: false,
        tgQuiet: true,
        stake: 5
      }
    });

    processor._runPreChecks = jest.fn(async () => {
      calls.push('preChecks');
      return { ok: true };
    });
    processor._findMatch = jest.fn(async () => {
      calls.push('findMatch');
      return { success: true, match: { id: 'match-1' } };
    });
    processor._findAndValidateOutcome = jest.fn(async () => {
      calls.push('findOutcome');
      return { success: true, outcome: { pick: 'DC X2', oddVal: 1.9 } };
    });
    processor._determineStake = jest.fn(async () => {
      calls.push('determineStake');
      return { success: true, stake: 5, strategy: 'sansabet_telegram_default', source: 'telegram' };
    });

    const task = {
      id: 'tg-post-submit-balance',
      bookmakerId: 'sansabet',
      home: 'England',
      away: 'New Zealand',
      outcome: 'DC X2',
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 5,
      pair: { sportName: 'soccer' },
      matchKey: 'england_new_zealand'
    };

    const result = await processor.process(task);

    expect(result).toEqual({
      success: false,
      shouldRetry: false,
      step: 'insufficient_balance'
    });
    expect(adapter.getBalance).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'preChecks',
      'findMatch',
      'findOutcome',
      'determineStake',
      'prepareBet',
      'placeBet'
    ]);
    expect(task._lastFailureStep).toBe('insufficient_balance');
    expect(task._lastFailureStage).toBe('bookmaker_submit');
    expect(tasksManager.recordTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tg-post-submit-balance' }),
      'failed',
      expect.objectContaining({
        message: 'Nemate dovoljno sredstva na računu',
        step: 'insufficient_balance',
        failureClass: 'insufficient_balance',
        failureStage: 'bookmaker_submit',
        submitReached: true,
        bookmakerRejected: true
      })
    );
  });

  test('should select softened telegram candidate within odds range', async () => {
    const adapter = {
      findOutcome: jest.fn((match, outcome) => {
        if (outcome === 'T> 3.5') {
          return { pick: outcome, oddVal: 1.55 };
        }
        if (outcome === 'T> 2.5') {
          return { pick: outcome, oddVal: 1.85 };
        }
        return null;
      })
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: { highROIThreshold: 10 }
    });

    const task = {
      home: 'Home',
      away: 'Away',
      outcome: 'T> 3.5',
      candidateLadder: [
        { outcome: 'T> 2.5', reason: 'softened_line', priority: 1 }
      ],
      minOdds: 1.7,
      maxOdds: 2.1,
      sourceType: 'telegram'
    };

    const result = await processor._findAndValidateOutcome(task, { id: 'match-1' });

    expect(result.success).toBe(true);
    expect(result.outcome.oddVal).toBe(1.85);
    expect(task.outcome).toBe('T> 2.5');
    expect(task._originalOutcome).toBe('T> 3.5');
    expect(task.expectedOdds).toBe(1.85);
    expect(task.selectedCandidate.reason).toBe('softened_line');
  });

  test('should prefer exact telegram bet context when bet_num is provided even if odds drift', async () => {
    const adapter = {
      findOutcomeByBetNum: jest.fn(() => ({ pick: 'T> 133.5', oddVal: 1.95 })),
      findOutcome: jest.fn(() => ({ pick: 'T> 132.5', oddVal: 1.85 }))
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: { highROIThreshold: 10, tgQuiet: true }
    });

    const task = {
      home: 'Home',
      away: 'Away',
      outcome: 'T> 133.5',
      candidateLadder: [
        { outcome: 'T> 132.5', reason: 'softened_line', priority: 1 }
      ],
      expectedOdds: 1.85,
      minOdds: 1.0,
      maxOdds: 50,
      outcomeData: {
        score2: {
          raw: { bet_num: 105 }
        }
      },
      sourceType: 'telegram'
    };

    const result = await processor._findAndValidateOutcome(task, { id: 'match-1' });

    expect(result.success).toBe(true);
    expect(result.outcome.oddVal).toBe(1.95);
    expect(adapter.findOutcomeByBetNum).toHaveBeenCalled();
    expect(adapter.findOutcome).not.toHaveBeenCalled();
    expect(task.outcome).toBe('T> 133.5');
    expect(task.expectedOdds).toBe(1.95);
  });

  test('should recheck missing telegram outcome without LLM and succeed when markets appear', async () => {
    const adapter = {
      findOutcome: jest.fn((match, outcome) => {
        const markets = match?.odds?.M || match?.M || [];
        if (outcome === '1' && markets.length > 0) {
          return { pick: outcome, oddVal: 1.91 };
        }
        return null;
      }),
      getMatchDetails: jest.fn(async () => ({
        id: 'match-1',
        odds: {
          M: [{
            B: '',
            S: [{ N: 1, O: 1.91 }]
          }]
        },
        M: [{
          B: '',
          S: [{ N: 1, O: 1.91 }]
        }],
        sport: 'soccer'
      }))
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
            intervalMs: 5,
            totalWindowMs: 40
          }
        }
      }
    });

    const task = {
      home: 'China',
      away: 'New Zealand',
      outcome: '1',
      candidateLadder: [],
      pair: { sportName: 'soccer' },
      bookmakerMatchId: 'match-1',
      sourceType: 'telegram'
    };

    const result = await processor._findAndValidateOutcome(task, {
      id: 'match-1',
      odds: { M: [] },
      M: [],
      sport: 'soccer'
    });

    expect(result.success).toBe(true);
    expect(result.outcome.oddVal).toBe(1.91);
    expect(adapter.getMatchDetails).toHaveBeenCalledWith('match-1', 'soccer');
  });

  test('should keep explicit telegram alternatives even when primary bet_num is exact', async () => {
    const adapter = {
      findOutcomeByBetNum: jest.fn(() => null),
      findOutcome: jest.fn((match, outcome) => {
        if (outcome === 'T> 1.5') {
          return { pick: outcome, oddVal: 1.9 };
        }
        return null;
      })
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: { highROIThreshold: 10, tgQuiet: true }
    });

    const task = {
      home: 'Home',
      away: 'Away',
      outcome: '1',
      outcomeCandidates: [
        { outcome: 'P1 1', reason: 'text_context_candidate' },
        { outcome: 'T> 1.5', reason: 'text_context_candidate' }
      ],
      candidateLadder: [
        { outcome: 'T> 0.5', reason: 'softened_line', priority: 1 }
      ],
      minOdds: 1.0,
      maxOdds: 50,
      outcomeData: {
        score2: {
          raw: { bet_num: 105 }
        }
      },
      sourceType: 'telegram'
    };

    const result = await processor._findAndValidateOutcome(task, { id: 'match-1' });

    expect(result.success).toBe(true);
    expect(adapter.findOutcomeByBetNum).toHaveBeenCalledTimes(1);
    expect(adapter.findOutcome).toHaveBeenCalledWith(expect.anything(), 'P1 1', null);
    expect(adapter.findOutcome).toHaveBeenCalledWith(expect.anything(), 'T> 1.5', null);
    expect(task.outcome).toBe('T> 1.5');
    expect(task.selectedCandidate.reason).toBe('text_context_candidate');
  });

  test('should stop after max stake rejection instead of switching telegram ladder candidates', async () => {
    const logger = createLogger();
    const tasksManager = {
      recordTaskResult: jest.fn(),
      getRecentlyFailedOutcomes: jest.fn(() => new Set())
    };
    const telegram = {
      notifyTaskCompleted: jest.fn(async () => []),
      notifyTaskFailed: jest.fn(async () => []),
      notifySkipped: jest.fn(async () => []),
      sendToAll: jest.fn(async () => []),
      escapeHtml: (value) => String(value)
    };
    const limitsManager = {
      recordBet: jest.fn()
    };
    const calculator = {
      logBetAccept: jest.fn(async () => true)
    };
    const adapter = {
      findOutcome: jest.fn((match, outcome) => {
        if (outcome === '1') {
          return { pick: '1', oddVal: 2.3 };
        }
        if (outcome === 'DC 1X') {
          return { pick: 'DC 1X', oddVal: 1.72 };
        }
        return null;
      }),
      prepareBet: jest.fn(async () => true),
      placeBet: jest
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR' }),
      getBalance: jest.fn(async () => 100),
      parseError: jest.fn(() => ({ retryable: false }))
    };

    const processor = new BetProcessor({
      adapter,
      logger,
      tasksManager,
      telegram,
      limitsManager,
      calculator,
      bookmakerName: 'Sansabet',
      config: {
        dryRun: false,
        tgQuiet: true,
        stake: 10
      }
    });

    processor._runPreChecks = jest.fn(async () => ({ ok: true }));
    processor._findMatch = jest.fn(async () => ({ success: true, match: { id: 'match-1', sport: 'soccer' } }));
    processor._determineStake = jest.fn(async () => ({
      success: true,
      stake: 10,
      strategy: 'sansabet_telegram_default',
      source: 'telegram_default'
    }));

    const task = {
      id: 'tg-task-max-stake',
      bookmakerId: 'sansabet',
      home: 'Al Wakrah',
      away: 'Al Gharafa',
      outcome: '1',
      sport: 'soccer',
      pair: { sportName: 'soccer' },
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 10,
      minOdds: 1.7,
      maxOdds: 2.5,
      matchKey: 'al_wakrah_al_gharafa',
      candidateLadder: [
        { outcome: '1', reason: 'primary_signal', priority: 0 },
        { outcome: 'DC 1X', reason: 'cross_market_mapping', priority: 1 }
      ]
    };

    const result = await processor.process(task);

    expect(result).toEqual({ success: false, shouldRetry: false, step: 'bet_submit' });
    expect(task.outcome).toBe('1');
    expect(task.selectedCandidate).toEqual(expect.objectContaining({
      outcome: '1',
      reason: 'primary_task_outcome',
      priority: 0
    }));
    expect(adapter.placeBet).toHaveBeenCalledTimes(1);
    expect(adapter.placeBet.mock.calls[0][0]).toEqual(expect.objectContaining({
      stake: 10,
      task: expect.objectContaining({ id: 'tg-task-max-stake', outcome: '1' }),
      outcome: expect.objectContaining({ pick: '1', oddVal: 2.3 })
    }));
    expect(adapter.findOutcome).not.toHaveBeenCalledWith(expect.anything(), 'DC 1X', null);
    expect(limitsManager.recordBet).not.toHaveBeenCalled();
  });

  test('should switch telegram ladder candidate when singles are blocked', async () => {
    const logger = createLogger();
    const tasksManager = {
      recordTaskResult: jest.fn(),
      getRecentlyFailedOutcomes: jest.fn(() => new Set())
    };
    const telegram = {
      notifyTaskCompleted: jest.fn(async () => []),
      notifyTaskFailed: jest.fn(async () => []),
      notifySkipped: jest.fn(async () => []),
      sendToAll: jest.fn(async () => []),
      escapeHtml: (value) => String(value)
    };
    const limitsManager = {
      recordBet: jest.fn()
    };
    const calculator = {
      logBetAccept: jest.fn(async () => true)
    };
    const adapter = {
      findOutcome: jest.fn((match, outcome) => {
        if (outcome === '1') {
          return { pick: '1', oddVal: 1.72 };
        }
        if (outcome === 'DC 1X') {
          return { pick: 'DC 1X', oddVal: 1.28 };
        }
        return null;
      }),
      prepareBet: jest.fn(async () => true),
      placeBet: jest
        .fn()
        .mockResolvedValueOnce({ success: false, singlesBlocked: true })
        .mockResolvedValueOnce({ success: true, odds: 1.28, ticketId: 'ticket-1' }),
      getBalance: jest.fn(async () => 100),
      parseError: jest.fn(() => ({ retryable: false }))
    };

    const processor = new BetProcessor({
      adapter,
      logger,
      tasksManager,
      telegram,
      limitsManager,
      calculator,
      bookmakerName: 'Sansabet',
      config: {
        dryRun: false,
        tgQuiet: true,
        stake: 10
      }
    });

    processor._runPreChecks = jest.fn(async () => ({ ok: true }));
    processor._findMatch = jest.fn(async () => ({ success: true, match: { id: 'match-1', sport: 'soccer' } }));
    processor._determineStake = jest.fn(async () => ({
      success: true,
      stake: 10,
      strategy: 'sansabet_telegram_default',
      source: 'telegram_default'
    }));

    const task = {
      id: 'tg-task-singles-switch',
      bookmakerId: 'sansabet',
      home: 'Chapecoense',
      away: 'Avai',
      outcome: '1',
      sport: 'soccer',
      pair: { sportName: 'soccer' },
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 10,
      minOdds: 1.0,
      maxOdds: 50,
      matchKey: 'chapecoense_avai',
      candidateLadder: [
        { outcome: '1', reason: 'primary_signal', priority: 0 },
        { outcome: 'DC 1X', reason: 'cross_market_mapping', priority: 1 }
      ]
    };

    const result = await processor.process(task);

    expect(result.success).toBe(true);
    expect(task.outcome).toBe('DC 1X');
    expect(task.selectedCandidate).toEqual(expect.objectContaining({
      outcome: 'DC 1X',
      reason: 'cross_market_mapping',
      priority: 1
    }));
    expect(adapter.placeBet).toHaveBeenCalledTimes(2);
    expect(adapter.placeBet.mock.calls[0][0]).toMatchObject({
      stake: 10,
      outcome: { pick: '1', oddVal: 1.72 }
    });
    expect(adapter.placeBet.mock.calls[0][0].task.id).toBe('tg-task-singles-switch');
    expect(adapter.placeBet.mock.calls[1][0]).toMatchObject({
      stake: 10,
      outcome: { pick: 'DC 1X', oddVal: 1.28 }
    });
    expect(adapter.placeBet.mock.calls[1][0].task.id).toBe('tg-task-singles-switch');
    expect(adapter.findOutcome).toHaveBeenCalledWith(expect.anything(), 'DC 1X', null);
  });

  test('should finalize dry-run telegram task as completed', async () => {
    const logger = createLogger();
    const tasksManager = {
      recordTaskResult: jest.fn(),
      getRecentlyFailedOutcomes: jest.fn(() => new Set())
    };
    const telegram = {
      notifyTaskCompleted: jest.fn(async () => []),
      notifyTaskFailed: jest.fn(async () => []),
      notifySkipped: jest.fn(async () => []),
      sendToAll: jest.fn(async () => []),
      escapeHtml: (value) => String(value)
    };
    const limitsManager = {
      recordBet: jest.fn()
    };
    const calculator = {
      logBetAccept: jest.fn(async () => true)
    };
    const adapter = {
      prepareBet: jest.fn(async () => true),
      getBalance: jest.fn(async () => 100)
    };

    const processor = new BetProcessor({
      adapter,
      logger,
      tasksManager,
      telegram,
      limitsManager,
      calculator,
      bookmakerName: 'Sansabet',
      config: {
        dryRun: true,
        tgQuiet: false,
        stake: 1
      }
    });

    processor._runPreChecks = jest.fn(async () => ({ ok: true }));
    processor._findMatch = jest.fn(async () => ({ success: true, match: { id: 'match-1' } }));
    processor._findAndValidateOutcome = jest.fn(async () => ({
      success: true,
      outcome: { pick: 'T> 164.5', oddVal: 1.88 }
    }));
    processor._determineStake = jest.fn(async () => ({
      success: true,
      stake: 1,
      strategy: 'sansabet_telegram_default',
      source: 'telegram_default'
    }));

    const task = {
      id: 'tg-task-1',
      bookmakerId: 'sansabet',
      home: 'Aonps Posidon',
      away: 'Oion Ag. Stefanoy',
      outcome: 'T> 164.5',
      sport: 'basketball',
      pair: { sportName: 'basketball' },
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 1,
      matchKey: 'aonpsposidon_oionagstefanoy',
      feedbackChatIds: ['-1003717712631']
    };

    const result = await processor.process(task);

    expect(result).toEqual({ success: true });
    expect(task._dryRunCompleted).toBe(true);
    expect(tasksManager.recordTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tg-task-1', _dryRunCompleted: true }),
      'completed',
      expect.objectContaining({
        odds: 1.88,
        stake: 1,
        ticketId: 'dry-run',
        dryRun: true
      })
    );
    expect(telegram.notifyTaskCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tg-task-1' }),
      expect.objectContaining({
        odds: 1.88,
        stake: 1,
        dryRun: true,
        debugMode: true
      })
    );
    expect(limitsManager.recordBet).not.toHaveBeenCalled();
  });

  test('should cancel telegram task before submit when STOP was requested', async () => {
    const logger = createLogger();
    const tasksManager = {
      getCurrentTask: jest.fn(() => ({
        id: 'tg-task-2',
        bookmakerId: 'sansabet',
        signalId: 'sig-stop',
        stopRequested: true
      })),
      findTaskBySignalId: jest.fn(() => ({
        task: {
          id: 'tg-task-2',
          bookmakerId: 'sansabet',
          signalId: 'sig-stop',
          stopRequested: true
        }
      }))
    };
    const telegram = {
      notifySkipped: jest.fn(async () => []),
      notifyTaskCompleted: jest.fn(async () => []),
      notifyTaskFailed: jest.fn(async () => []),
      sendToAll: jest.fn(async () => []),
      escapeHtml: (value) => String(value)
    };
    const processor = new BetProcessor({
      adapter: {
        prepareBet: jest.fn(async () => true),
        placeBet: jest.fn(async () => ({ success: true })),
        getBalance: jest.fn(async () => 100)
      },
      logger,
      tasksManager,
      telegram,
      bookmakerName: 'Sansabet',
      config: {
        dryRun: false,
        tgQuiet: false,
        stake: 1
      }
    });

    processor._runPreChecks = jest.fn(async () => ({ ok: true }));
    processor._findMatch = jest.fn(async () => ({ success: true, match: { id: 'match-1' } }));
    processor._findAndValidateOutcome = jest.fn(async () => ({
      success: true,
      outcome: { pick: 'T> 2.5', oddVal: 1.88 }
    }));
    processor._determineStake = jest.fn(async () => ({
      success: true,
      stake: 1,
      strategy: 'sansabet_telegram_default',
      source: 'telegram_default'
    }));

    const result = await processor.process({
      id: 'tg-task-2',
      bookmakerId: 'sansabet',
      signalId: 'sig-stop',
      home: 'Home',
      away: 'Away',
      outcome: 'T> 2.5',
      sport: 'soccer',
      pair: { sportName: 'soccer' },
      sourceType: 'telegram',
      expectedROI: 20,
      stake: 1,
      matchKey: 'home_away'
    });

    expect(result).toMatchObject({
      success: false,
      shouldRetry: false,
      cancelled: true,
      step: 'telegram_stop'
    });
    expect(telegram.notifySkipped).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tg-task-2' }),
      'STOP принят до отправки ставки'
    );
  });

  test('should continue telegram task as live when prematch cue points to already-live match', async () => {
    const adapter = {
      isPrematch: false,
      getSportId: jest.fn(() => 1),
      getLiveMatches: jest.fn(async () => ([{
        H: {
          PID: 5051933,
          MS: 'IP'
        },
        id: 5051933
      }])),
      findMatch: jest.fn(() => ({
        H: {
          PID: 5051933,
          MS: 'IP'
        },
        id: 5051933
      })),
      getMatches: jest.fn(async () => []),
      getMatchDetails: jest.fn(async () => ({
        odds: { M: [] },
        markets: [],
        sport: 'soccer'
      }))
    };

    const processor = new BetProcessor({
      adapter,
      logger: createLogger(),
      config: {
        tgQuiet: true
      }
    });

    const task = {
      home: 'Botev Plovdiv',
      away: 'Lokomotiv Plovdiv',
      bookmakerMatchId: 5051933,
      isPrematch: true,
      mode: 'prematch',
      sourceType: 'telegram',
      pair: { sportName: 'soccer' }
    };

    const result = await processor._findMatch(task);

    expect(result.success).toBe(true);
    expect(task.isPrematch).toBe(false);
    expect(task.mode).toBe('live');
    expect(adapter.getMatchDetails).toHaveBeenCalledWith(5051933, 'soccer');
  });
});
