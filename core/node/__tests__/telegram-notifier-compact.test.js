process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

describe('TelegramNotifier compact routing', () => {
  test('allowedTargetChatIds restrict outbound sendToAll destinations', async () => {
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000',
      allowedTargetChatIds: ['-3000']
    });

    notifier.sendMessage = jest.fn(async () => ({
      ok: true,
      result: { message_id: 1, chat: { id: -3000 } }
    }));

    await notifier.sendToAll('hello', {
      chatIds: ['-3000', '-4000'],
      includeLogsChat: true
    });

    expect(notifier.sendMessage).toHaveBeenCalledTimes(1);
    expect(notifier.sendMessage).toHaveBeenCalledWith(
      '-3000',
      'hello',
      expect.objectContaining({
        chatIds: ['-3000', '-4000'],
        includeLogsChat: true
      })
    );
  });

  test('compactMode emits short started and failed messages', async () => {
    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000',
      compactMode: true
    });

    notifier.sendToAll = jest.fn(async () => []);

    const task = {
      id: 'tg-1',
      home: 'Inter Milan',
      away: 'Como',
      outcome: '2',
      stake: 10,
      bookmaker: 'Sansabet',
      isPrematch: true
    };

    await notifier.notifyTaskStarted(task);
    expect(notifier.sendToAll).toHaveBeenNthCalledWith(
      1,
      '🔵 Inter Milan vs Como\n2 | 10 EUR | prematch',
      expect.objectContaining({ bookmaker: 'Sansabet' })
    );

    await notifier.notifyTaskFailed(task, {
      message: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR',
      step: 'bet_submit'
    });
    expect(notifier.sendToAll).toHaveBeenNthCalledWith(
      2,
      '❌ Inter Milan vs Como\n2 | bet_submit | Maksimalna uplata za ovaj tiket je : 5,00 EUR',
      expect.objectContaining({ bookmaker: 'Sansabet' })
    );
  });
});