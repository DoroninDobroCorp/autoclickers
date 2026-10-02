/**
 * Tests for TelegramNotifier
 * TODO: Implement in Story 2.3
 */

const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

describe('TelegramNotifier', () => {
  test.skip('should notify task started', async () => {
    // TODO: Implement when module is complete in Story 2.3
    const notifier = new TelegramNotifier({ botToken: 'fake', chatId: '123' });
    await notifier.notifyTaskStarted({ id: 1, home: 'Team A', away: 'Team B' });
  });
  
  test.skip('should notify task completed', async () => {
    // TODO: Implement when module is complete in Story 2.3
  });
  
  test.skip('should notify task failed', async () => {
    // TODO: Implement when module is complete in Story 2.3
  });

  describe('_getRoutingOptionsForTask (sourceReadOnly leak guard)', () => {
    const notifier = new TelegramNotifier({ botToken: 'fake', logsChatId: '-100' });

    test('drops originChatId for read-only source profiles', () => {
      const task = {
        id: 'tg-1',
        feedbackChatIds: ['-1003717712631'],
        originChatId: -1002010985531,
        telegramContext: {
          sourceReadOnly: true,
          originChatId: -1002010985531,
          feedbackChatIds: ['-1003717712631']
        }
      };

      const opts = notifier._getRoutingOptionsForTask(task, 'Sansabet');
      expect(opts.originChatId).toBeNull();
      expect(opts.chatIds).toEqual(expect.arrayContaining(['-1003717712631']));

      const targets = notifier._collectTargetChatIds(opts);
      expect(targets).not.toContain('-1002010985531');
      expect(targets).toContain('-1003717712631');
    });

    test('preserves originChatId for non-read-only profiles', () => {
      const task = {
        id: 'tg-2',
        feedbackChatIds: ['-100777'],
        originChatId: -100888,
        telegramContext: {
          sourceReadOnly: false,
          originChatId: -100888,
          feedbackChatIds: ['-100777']
        }
      };

      const opts = notifier._getRoutingOptionsForTask(task, 'Sansabet');
      expect(opts.originChatId).toBe(-100888);
    });
  });
});
