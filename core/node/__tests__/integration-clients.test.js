/**
 * Integration Clients Tests — HTTP mock tests for Analyzer, Calculator, and Telegram clients
 * 
 * Story 2.3 / AUTO-CORE-3: Extract Integration clients from auto_sansa to core
 * 
 * Uses nock for HTTP mocking to test:
 * - AnalyzerClient (5+ tests)
 * - CalculatorClient (5+ tests)
 * - TelegramNotifier (8+ tests)
 * 
 * Total: 18+ tests
 */

const nock = require('nock');
const { AnalyzerClient } = require('../integrations/analyzer-client.js');
const { CalculatorClient } = require('../integrations/calculator-client.js');
const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

describe('AnalyzerClient', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('should fetch pairs successfully', async () => {
    nock('http://localhost:7005')
      .get('/pairs')
      .query(true)
      .reply(200, {
        data: {
          outcomes: [
            { pairFull: { first: {}, second: {} }, outcome: { outcome: 'T> 2.5' } }
          ]
        }
      });

    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs?min_roi=3' });
    const result = await client.fetchPairs();

    expect(result).toHaveProperty('outcomes');
    expect(result.outcomes).toHaveLength(1);
  });

  test('should handle timeout', async () => {
    nock('http://localhost:7005')
      .get('/pairs')
      .query(true)
      .delay(6000)
      .reply(200, { data: {} });

    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs', timeout: 1000 });

    await expect(client.fetchPairs()).rejects.toThrow('timeout');
  });

  test('should handle parse error', async () => {
    nock('http://localhost:7005')
      .get('/pairs')
      .query(true)
      .reply(200, 'INVALID JSON');

    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs' });

    await expect(client.fetchPairs()).rejects.toThrow('parse');
  });

  test('should handle empty response', async () => {
    nock('http://localhost:7005')
      .get('/pairs')
      .query(true)
      .reply(200, { data: {} });

    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs' });
    const result = await client.fetchPairs();

    expect(result).toEqual({});
  });

  test('should handle network error', async () => {
    nock('http://localhost:7005')
      .get('/pairs')
      .query(true)
      .replyWithError('Network error');

    const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs' });

    await expect(client.fetchPairs()).rejects.toThrow('Network error');
  });

  test('should require config.url', () => {
    expect(() => new AnalyzerClient({})).toThrow('requires config.url');
  });
});

describe('CalculatorClient', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  const mockTask = {
    home: 'Team A',
    away: 'Team B',
    outcome: 'T> 2.5',
    pairFull: {
      first: {
        bookmaker: 'Sansabet',
        leagueName: 'Premier League',
        homeName: 'Team A',
        awayName: 'Team B',
        matchId: '123',
        homeScore: 0,
        awayScore: 0,
        createdAt: '2025-01-01T00:00:00Z'
      },
      second: {
        bookmaker: 'Pinnacle',
        leagueName: 'Premier League',
        homeName: 'Team A',
        awayName: 'Team B',
        matchId: '456',
        homeScore: 0,
        awayScore: 0,
        createdAt: '2025-01-01T00:00:00Z'
      },
      outcome: { outcome: 'T> 2.5' },
      sportName: 'Football',
      isLive: true
    }
  };

  test('should log bet successfully', async () => {
    nock('http://localhost:7010')
      .post('/log-bet-accept')
      .reply(200, { success: true });

    const client = new CalculatorClient({ port: 7010 });
    const result = await client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10
    });

    expect(result.success).toBe(true);
  });

  test('should handle server error', async () => {
    nock('http://localhost:7010')
      .post('/log-bet-accept')
      .reply(500, 'Internal Server Error');

    const client = new CalculatorClient({ port: 7010 });

    await expect(client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10
    })).rejects.toThrow('500');
  });

  test('should require task.pairFull', async () => {
    const client = new CalculatorClient({ port: 7010 });

    await expect(client.logBetAccept({
      task: { home: 'A', away: 'B' },
      odds: 2.5,
      stake: 10
    })).rejects.toThrow('pairFull');
  });

  test('should reject retired test-bet flow', async () => {
    const client = new CalculatorClient({ port: 7010 });

    await expect(client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10,
      isTest: true
    })).rejects.toThrow('retired');
  });

  test('should handle network error', async () => {
    nock('http://localhost:7010')
      .post('/log-bet-accept')
      .replyWithError('Connection refused');

    const client = new CalculatorClient({ port: 7010 });

    await expect(client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10
    })).rejects.toThrow('Connection refused');
  });

  test('should handle timeout', async () => {
    nock('http://localhost:7010')
      .post('/log-bet-accept')
      .delay(6000)
      .reply(200, {});

    const client = new CalculatorClient({ port: 7010, timeout: 1000 });

    await expect(client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10
    })).rejects.toThrow('timeout');
  });

  test('should use custom URL format', async () => {
    nock('http://custom-host:8080')
      .post('/log-bet-accept')
      .reply(200, {});

    const client = new CalculatorClient({ url: 'http://custom-host:8080' });
    const result = await client.logBetAccept({
      task: mockTask,
      odds: 2.5,
      stake: 10
    });

    expect(result.success).toBe(true);
  });
});

describe('TelegramNotifier', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  const mockConfig = {
    botToken: 'test_token_123',
    logsChatId: -123456
  };

  const mockTask = {
    id: 999,
    home: 'Team A',
    away: 'Team B',
    outcome: 'T> 2.5',
    stake: 10,
    minOdds: 1.7,
    maxOdds: 10.0,
    source: 'analyzer'
  };

  test('should send message successfully', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true, result: { message_id: 123 } });

    const notifier = new TelegramNotifier(mockConfig);
    const result = await notifier.sendMessage(-123456, 'Test message');

    expect(result.ok).toBe(true);
    expect(result.result.message_id).toBe(123);
  });

  test('should notify task started', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier(mockConfig);
    const results = await notifier.notifyTaskStarted(mockTask);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  test('should notify task completed', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier(mockConfig);
    const results = await notifier.notifyTaskCompleted(mockTask, { odds: 2.5, stake: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  test('should notify task completed with debugMode', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier(mockConfig);
    const results = await notifier.notifyTaskCompleted(mockTask, { odds: 2.5, stake: 10, debugMode: true });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  test('should notify task failed', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier(mockConfig);
    const results = await notifier.notifyTaskFailed(mockTask, { message: 'Test error', step: 'find_match' });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  test('should notify task failed with popupText', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier(mockConfig);
    const results = await notifier.notifyTaskFailed(mockTask, {
      message: 'Bet rejected',
      step: 'bet_submit',
      stepNumber: 5,
      popupText: 'Недостаточно средств на балансе',
      attempts: 3
    });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  test('should send to all subscribers', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .times(3)
      .reply(200, { ok: true });

    const notifier = new TelegramNotifier({
      botToken: 'test_token',
      logsChatId: -123456,
      subscribers: [-111111, -222222]
    });

    const results = await notifier.sendToAll('Test message');

    expect(results).toHaveLength(3);
    expect(results.every(r => r.ok)).toBe(true);
  });

  test('should handle API error gracefully', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .reply(500, 'Server error');

    const notifier = new TelegramNotifier(mockConfig);
    const result = await notifier.sendMessage(-123456, 'Test');

    expect(result.ok).toBe(false);
  });

  test('should handle network error gracefully', async () => {
    nock('https://api.telegram.org')
      .post(/\/bot.*\/sendMessage/)
      .times(3)
      .replyWithError('Network timeout');

    const notifier = new TelegramNotifier(mockConfig);
    const result = await notifier.sendMessage(-123456, 'Test');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  test('disables optional notification transport without project credentials', () => {
    expect(new TelegramNotifier({}).enabled).toBe(false);
    expect(new TelegramNotifier({ botToken: 'test' }).enabled).toBe(false);
  });

  test('should return step description', () => {
    const notifier = new TelegramNotifier(mockConfig);
    
    expect(notifier.getStepDescription('team_search')).toContain('Поиск матча');
    expect(notifier.getStepDescription('bet_submit')).toContain('Подтверждение ставки');
    expect(notifier.getStepDescription('unknown')).toContain('Финальный этап');
    expect(notifier.getStepDescription('undefined')).toContain('Финальный этап');
  });
});
