process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const { BetProcessor } = require('../BetProcessor.js');

describe('BetProcessor._handleBetResult', () => {
    function createContext(overrides = {}) {
        return {
            logger: {
                log: jest.fn(),
                error: jest.fn()
            },
            adapter: {
                parseError: jest.fn().mockReturnValue({
                    retryable: false
                })
            },
            calculator: {
                logBetAccept: jest.fn()
            },
            telegram: {
                notifyTaskFailed: jest.fn().mockResolvedValue(undefined)
            },
            tasksManager: {
                recordTaskResult: jest.fn()
            },
            limitsManager: {
                recordBet: jest.fn()
            },
            config: {
                tgQuiet: true,
                skipFailCsv: false,
                isTest: false,
                dryRun: false,
                postBetDelayMs: 0
            },
            bookmakerName: 'Sansabet',
            ...overrides
        };
    }

    test('returns bet_submit step and skips fail calculator logging when pairFull is missing', async () => {
        const context = createContext();
        const task = {};
        const outcome = { oddVal: 17 };

        const result = await BetProcessor.prototype._handleBetResult.call(
            context,
            task,
            outcome,
            10,
            'sansabet_telegram_default',
            'telegram',
            { success: false, error: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR' }
        );

        expect(result).toEqual({
            success: false,
            shouldRetry: false,
            step: 'bet_submit'
        });
        expect(task._lastFailureStep).toBe('bet_submit');
        expect(context.calculator.logBetAccept).not.toHaveBeenCalled();
        expect(context.tasksManager.recordTaskResult).toHaveBeenCalledWith(task, 'failed', {
            message: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR',
            step: 'bet_submit',
            failureStage: 'bookmaker_submit',
            submitReached: true,
            bookmakerRejected: true,
            failureClass: undefined
        });
    });

    test('skips success calculator logging when pairFull is missing', async () => {
        const context = createContext({
            telegram: {
                notifyTaskCompleted: jest.fn().mockResolvedValue(undefined)
            }
        });
        const task = {
            matchKey: 'home_away',
            outcome: '2'
        };
        const outcome = { oddVal: 17 };

        const result = await BetProcessor.prototype._handleBetResult.call(
            context,
            task,
            outcome,
            10,
            'sansabet_telegram_default',
            'telegram',
            { success: true, ticketId: 'T-1', odds: 17, stake: 10 }
        );

        expect(result).toEqual({ success: true });
        expect(context.calculator.logBetAccept).not.toHaveBeenCalled();
        expect(context.tasksManager.recordTaskResult).toHaveBeenCalledWith(task, 'completed', {
            odds: 17,
            stake: 10,
            ticketId: 'T-1',
            dryRun: false
        });
    });
});
