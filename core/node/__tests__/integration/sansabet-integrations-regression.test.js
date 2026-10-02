/**
 * Sansabet Integrations Regression Test
 * 
 * Story 2.3 / AUTO-CORE-3: Regression test для проверки интеграции
 * 
 * Проверяет что:
 * 1. Все integration clients экспортируются из core
 * 2. Все клиенты могут быть инстанцированы
 * 3. auto_sansa файлы могут импортировать и использовать клиенты
 */

const core = require('../../index.js');
const { AnalyzerClient } = core.AnalyzerClient;
const { CalculatorClient } = core.CalculatorClient;
const { TelegramNotifier } = core.TelegramNotifier;

describe('Story 2.3: Integration Clients Regression', () => {
  test('should export all integration clients from core', () => {
    expect(core.AnalyzerClient).toBeDefined();
    expect(core.CalculatorClient).toBeDefined();
    expect(core.TelegramNotifier).toBeDefined();
  });

  test('AnalyzerClient should be instantiable', () => {
    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs' });
    expect(client).toBeDefined();
    expect(client.url).toBe('http://localhost:7005/pairs');
    expect(typeof client.fetchPairs).toBe('function');
  });

  test('CalculatorClient should be instantiable', () => {
    const client = new CalculatorClient({ port: 7010 });
    expect(client).toBeDefined();
    expect(typeof client.logBetAccept).toBe('function');
  });

  test('TelegramNotifier should be instantiable', () => {
    const notifier = new TelegramNotifier({
      botToken: 'test_token',
      logsChatId: -123456
    });
    expect(notifier).toBeDefined();
    expect(typeof notifier.notifyTaskStarted).toBe('function');
    expect(typeof notifier.notifyTaskCompleted).toBe('function');
    expect(typeof notifier.notifyTaskFailed).toBe('function');
  });

  test('should maintain API compatibility for auto_sansa', () => {
    const analyzerClient = new AnalyzerClient({ url: 'http://localhost:7005/pairs' });
    const calculatorClient = new CalculatorClient({ port: 7010 });
    const telegramNotifier = new TelegramNotifier({
      botToken: 'test',
      logsChatId: -123
    });

    expect(analyzerClient.fetchPairs).toBeDefined();
    expect(calculatorClient.logBetAccept).toBeDefined();
    expect(telegramNotifier.notifyTaskStarted).toBeDefined();
    expect(telegramNotifier.notifyTaskCompleted).toBeDefined();
    expect(telegramNotifier.notifyTaskFailed).toBeDefined();
    expect(telegramNotifier.sendMessage).toBeDefined();
    expect(telegramNotifier.sendToAll).toBeDefined();
  });
});
