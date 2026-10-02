const { TextSignalClient } = require('../llm/TextSignalClient.js');

describe('TextSignalClient', () => {
  test('parses complete multiline Telegram text without calling LLM', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn(async () => {
        throw new Error('should_not_call_llm');
      })
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Franca BC vs Pinheiros\n1\nBasketball Brazil NBB Play Off\nLive'
    });

    expect(textClient.complete).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      intent: 'bet',
      sport: 'basketball',
      home: 'Franca BC',
      away: 'Pinheiros',
      league: 'Brazil NBB Play Off',
      isLive: true,
      outcomeRaw: '1',
      confidence: 0.93,
      provider: 'text-only:deterministic-text',
      model: 'telegram-text-rules'
    });
  });

  test('falls back to deterministic one-team hint when LLM quota fails', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn(async () => {
        throw new Error('OpenAI text 403: Key limit exceeded');
      })
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Redencao\nOver5.5\nFootball Brazil\nLive'
    });

    expect(textClient.complete).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({
      intent: 'bet',
      sport: 'soccer',
      home: 'Redencao',
      away: null,
      league: 'Brazil',
      isLive: true,
      outcomeRaw: 'Over5.5',
      confidence: 0.62,
      provider: 'text-only:deterministic-text'
    });
    expect(parsed.notes).toContain('llm_error_fallback');
  });

  test('recognizes Russian sport and live markers in deterministic path', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn()
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Спартак vs Динамо\nТБ 2.5\nФутбол Россия\nв игре'
    });

    expect(textClient.complete).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      intent: 'bet',
      sport: 'soccer',
      home: 'Спартак',
      away: 'Динамо',
      league: 'Россия',
      isLive: true,
      outcomeRaw: 'ТБ 2.5',
      confidence: 0.93
    });
  });

  test('treats blank-separated burst lines as one signal when there is one match', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn()
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Franca BC vs Pinheiros\n\n1\n\nBasketball\n\nBasketball Brazil NBB Play Off\n\nLive'
    });

    expect(textClient.complete).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      intent: 'bet',
      sport: 'basketball',
      home: 'Franca BC',
      away: 'Pinheiros',
      league: 'Brazil NBB Play Off',
      outcomeRaw: '1',
      confidence: 0.93
    });
  });

  test('leaves live mode unknown when text has no explicit live or prematch marker', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn()
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Redencao\nOver5.5\nFootball Brazil'
    });

    expect(textClient.complete).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({
      intent: 'bet',
      sport: 'soccer',
      home: 'Redencao',
      away: null,
      league: 'Brazil',
      isLive: null,
      outcomeRaw: 'Over5.5',
      confidence: 0.62
    });
  });

  test('parses confident multi-signal JSON responses', async () => {
    const textClient = {
      providerName: 'test',
      model: 'mock',
      isReady: () => true,
      complete: jest.fn(async () => JSON.stringify({
        intent: 'multi',
        confidence: 0.91,
        notes: 'two independent signals',
        signals: [
          {
            sport: 'football',
            home: 'Alpha FC',
            away: 'Beta FC',
            league: 'Friendly',
            isLive: true,
            outcomeRaw: 'W1',
            intent: 'bet',
            confidence: 0.94,
            notes: 'first',
            sourceText: 'Alpha FC / Beta FC\nW1\nFootball\nLive'
          },
          {
            sport: 'basketball',
            home: 'Gamma BC',
            away: 'Delta BC',
            league: 'National',
            isLive: true,
            outcomeRaw: 'тб135',
            intent: 'bet',
            confidence: 0.91,
            notes: 'second',
            sourceText: 'Gamma BC / Delta BC\nтб135\nBasketball\nLive'
          }
        ]
      }))
    };

    const client = new TextSignalClient({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const parsed = await client.parseText({
      text: 'Alpha FC / Beta FC\nW1\nFootball\nLive\n\nGamma BC / Delta BC\nтб135\nBasketball\nLive'
    });

    expect(parsed.intent).toBe('multi');
    expect(parsed.confidence).toBe(0.91);
    expect(parsed.signals).toHaveLength(2);
    expect(parsed.signals[0]).toMatchObject({
      sport: 'soccer',
      home: 'Alpha FC',
      away: 'Beta FC',
      outcomeRaw: 'W1',
      sourceText: 'Alpha FC / Beta FC\nW1\nFootball\nLive'
    });
    expect(parsed.signals[1]).toMatchObject({
      sport: 'basketball',
      home: 'Gamma BC',
      away: 'Delta BC',
      outcomeRaw: 'тб135'
    });
  });
});
