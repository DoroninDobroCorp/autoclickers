const { TelegramSignalParserV2 } = require('../telegram/TelegramSignalParserV2.js');
const { OutcomeResolverLLM } = require('../llm/OutcomeResolverLLM.js');

function createParser(overrides = {}) {
  const match = {
    matchId: '5121029',
    sport: 'soccer',
    home: 'Albania',
    away: 'Israel',
    league: 'Friendly International',
    mode: 'prematch'
  };

  return new TelegramSignalParserV2({
    visionClient: {
      parsePhoto: jest.fn().mockResolvedValue({
        provider: 'test',
        model: 'mock',
        sport: 'soccer',
        home: 'Албания',
        away: 'Израиль',
        league: null,
        score: null,
        isLive: false,
        outcomeRaw: null,
        intent: 'bet',
        confidence: 0.55,
        notes: 'low OCR confidence'
      })
    },
    matchLocator: {
      locate: jest.fn().mockResolvedValue({
        matchId: match.matchId,
        confidence: 0.99,
        reason: 'exact catalog match'
      })
    },
    adapter: {
      getCatalog: jest.fn().mockResolvedValue([match])
    },
    outcomeResolver: {
      resolve: jest.fn().mockResolvedValue({
        canonical: 'CS 1:3',
        confidence: 0.97,
        reason: 'caption correct score shorthand'
      })
    },
    logger: { log: jest.fn(), error: jest.fn() },
    lowConfGate: 0.5,
    highConfGate: 0.85,
    ...overrides
  });
}

describe('TelegramSignalParserV2 alert-band corroboration', () => {
  test('queues low-vision-confidence signal when match and outcome are strongly corroborated', async () => {
    const parser = createParser();

    const result = await parser.parseSignal({
      imagePath: '/tmp/signal.jpg',
      caption: '1:3 тс',
      activationCode: 'QmiRNUeZuB'
    });

    expect(result.state).toBe('ready');
    expect(result.matchId).toBe('5121029');
    expect(result.outcome).toBe('CS 1:3');
    expect(result.confidence).toBe(0.55);
  });

  test('keeps alert review when match confidence is not strong enough', async () => {
    const parser = createParser({
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: '5121029',
          confidence: 0.9,
          reason: 'weak fuzzy match'
        })
      }
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/signal.jpg',
      caption: '1:3 тс',
      activationCode: 'QmiRNUeZuB'
    });

    expect(result.state).toBe('alert_review');
    expect(result.outcome).toBe('CS 1:3');
  });

  test('queues alert-band vision when strong match and LLM outcome clears min resolved confidence', async () => {
    const parser = createParser({
      outcomeResolver: {
        resolve: jest.fn().mockResolvedValue({
          canonical: 'T> 135',
          confidence: 0.72,
          reason: 'basketball total over',
          candidates: [
            { outcome: 'T> 134.5', confidence: 0.7, reason: 'lower over line', relationType: 'one_way_safe' }
          ]
        })
      },
      minResolvedConfidence: 0.65
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/signal.jpg',
      caption: 'верх 135',
      activationCode: 'AlertBand01'
    });

    expect(result.state).toBe('ready');
    expect(result.outcome).toBe('T> 135');
    expect(result.normalizedIntent).toMatchObject({
      family: 'totals',
      direction: 'over',
      line: 135
    });
    expect(result.outcomeCandidates.map((candidate) => candidate.outcome)).toContain('T> 134.5');
  });
});

describe('TelegramSignalParserV2 text-owned outcome parsing', () => {
  test('does not let vision outcome override explicit caption shorthand', async () => {
    const match = {
      matchId: '5121806',
      sport: 'basketball',
      home: 'San Antonio Spurs',
      away: 'New York Knicks',
      league: 'Basketball NBA Play Offs',
      mode: 'prematch'
    };
    const parser = createParser({
      visionClient: {
        parsePhoto: jest.fn().mockResolvedValue({
          provider: 'test',
          model: 'mock',
          sport: 'basketball',
          home: 'Сан-Антонио',
          away: 'Нью-Йорк',
          league: 'НБА',
          score: '0:0',
          isLive: false,
          outcomeRaw: 'Q1 T> 56.5',
          intent: 'bet',
          confidence: 0.72,
          notes: 'vision flipped m to over'
        })
      },
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: match.matchId,
          confidence: 0.97,
          reason: 'catalog match'
        })
      },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/basketball.jpg',
      caption: '1 четверть 56.5м',
      activationCode: '067hciEzxc'
    });

    expect(result.state).toBe('ready');
    expect(result.outcome).toBe('Q1 T< 56.5');
    expect(parser.outcomeResolver.resolve).not.toHaveBeenCalled();
  });

  test('does not let non-outcome caption suppress the parsed vision outcome', async () => {
    const match = {
      matchId: '5121042',
      sport: 'soccer',
      home: 'Sweden',
      away: 'Greece',
      league: 'Friendly International',
      mode: 'live'
    };
    const parser = createParser({
      visionClient: {
        parsePhoto: jest.fn().mockResolvedValue({
          provider: 'test',
          model: 'mock',
          sport: 'soccer',
          home: 'Sweden',
          away: 'Greece',
          league: 'Friendly International',
          score: '0-1',
          isLive: true,
          outcomeRaw: 'X',
          intent: 'bet',
          confidence: 0.95,
          notes: 'draw selection visible on screenshot'
        })
      },
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: match.matchId,
          confidence: 1,
          reason: 'exact match'
        })
      },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/sweden-greece.jpg',
      caption: 'Friendly International Live',
      activationCode: 'NoCapOut01'
    });

    expect(result.state).toBe('ready');
    expect(result.outcome).toBe('X');
    expect(parser.outcomeResolver.resolve).not.toHaveBeenCalled();
  });

  test('uses a single text-only team line as match hint and normalizes outcome from text', async () => {
    const match = {
      matchId: '777',
      sport: 'soccer',
      home: 'Confianca EC U20',
      away: 'Sergipe U20',
      league: 'Brazil U20',
      mode: 'live'
    };
    const locate = jest.fn().mockResolvedValue({
      matchId: match.matchId,
      confidence: 0.92,
      reason: 'single-team hint matched catalog'
    });
    const parser = createParser({
      textSignalClient: {
        isReady: () => true,
        parseText: jest.fn().mockResolvedValue({
          provider: 'text-only:test',
          model: 'mock',
          sport: 'soccer',
          home: null,
          away: null,
          league: 'Brazil U20',
          score: null,
          isLive: true,
          outcomeRaw: 'Over 4.5',
          intent: 'bet',
          confidence: 0.55,
          notes: 'only one team extracted'
        })
      },
      matchLocator: { locate },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      caption: 'U20 Confianca EC\n\nOver4.5\n\nBrazil\n\nFootball\n\nLive',
      activationCode: 'NSgH3ytdF2'
    });

    expect(locate).toHaveBeenCalledWith(expect.objectContaining({
      parsedSignal: expect.objectContaining({
        home: 'U20 Confianca EC',
        away: null
      }),
      catalog: [match]
    }));
    expect(result.state).toBe('ready');
    expect(result.matchId).toBe('777');
    expect(result.outcome).toBe('T> 4.5');
  });

  test('normalizes W1 from a multi-line text-only burst without LLM outcome fallback', async () => {
    const match = {
      matchId: '5047835',
      sport: 'soccer',
      home: 'Austria',
      away: 'Jordan',
      league: 'FIFA World Cup',
      mode: 'prematch'
    };
    const parser = createParser({
      textSignalClient: {
        isReady: () => true,
        parseText: jest.fn().mockResolvedValue({
          provider: 'text-only:test',
          model: 'mock',
          sport: 'soccer',
          home: 'Jordan (W)',
          away: null,
          league: 'Friendly International',
          score: null,
          isLive: true,
          outcomeRaw: 'W1',
          intent: 'bet',
          confidence: 0.82,
          notes: 'single-team live burst'
        })
      },
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: match.matchId,
          confidence: 0.96,
          reason: 'unique single-team token match'
        })
      },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      caption: 'Jordan (W)\n\nW1\n\nFootball\n\nFriendly International\n\nLive',
      activationCode: 'DknNeOeoc0'
    });

    expect(result.state).toBe('ready');
    expect(result.matchId).toBe('5047835');
    expect(result.outcome).toBe('1');
    expect(parser.outcomeResolver.resolve).not.toHaveBeenCalled();
  });

  test('resolves multiple confident text-only signals independently', async () => {
    const matches = [
      {
        matchId: 'm-soccer-1',
        sport: 'soccer',
        home: 'Alpha FC',
        away: 'Beta FC',
        league: 'Friendly',
        mode: 'live'
      },
      {
        matchId: 'm-basket-1',
        sport: 'basketball',
        home: 'Gamma BC',
        away: 'Delta BC',
        league: 'National League',
        mode: 'live'
      }
    ];
    const locate = jest.fn(async ({ parsedSignal }) => {
      const match = matches.find((entry) => entry.home === parsedSignal.home);
      return {
        matchId: match?.matchId || null,
        confidence: match ? 0.99 : 0,
        reason: match ? 'exact child match' : 'not found'
      };
    });
    const parser = createParser({
      textSignalClient: {
        isReady: () => true,
        parseText: jest.fn().mockResolvedValue({
          provider: 'text-only:test',
          model: 'mock',
          intent: 'multi',
          confidence: 0.93,
          notes: 'two independent signals',
          signals: [
            {
              provider: 'text-only:test',
              model: 'mock',
              sport: 'soccer',
              home: 'Alpha FC',
              away: 'Beta FC',
              league: 'Friendly',
              score: null,
              isLive: true,
              outcomeRaw: 'W1',
              intent: 'bet',
              confidence: 0.94,
              notes: 'first signal',
              sourceText: 'Alpha FC / Beta FC\n\nW1\n\nFootball\n\nLive'
            },
            {
              provider: 'text-only:test',
              model: 'mock',
              sport: 'basketball',
              home: 'Gamma BC',
              away: 'Delta BC',
              league: 'National League',
              score: null,
              isLive: true,
              outcomeRaw: 'тб135',
              intent: 'bet',
              confidence: 0.93,
              notes: 'second signal',
              sourceText: 'Gamma BC / Delta BC\n\nтб135\n\nBasketball\n\nLive'
            }
          ]
        })
      },
      matchLocator: { locate },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue(matches)
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      caption: 'Alpha FC / Beta FC\n\nW1\n\nFootball\n\nLive\n\nGamma BC / Delta BC\n\nтб135\n\nBasketball\n\nLive',
      activationCode: 'MultiCd001'
    });

    expect(result.state).toBe('multi_signal');
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0]).toMatchObject({
      state: 'ready',
      matchId: 'm-soccer-1',
      outcome: '1'
    });
    expect(result.signals[1]).toMatchObject({
      state: 'ready',
      matchId: 'm-basket-1',
      outcome: 'T> 135'
    });
    expect(locate).toHaveBeenCalledTimes(2);
    expect(parser.outcomeResolver.resolve).not.toHaveBeenCalled();
  });

  test('accepts simple 1x2 caption without LLM outcome fallback', async () => {
    const match = {
      matchId: '5121042',
      sport: 'soccer',
      home: 'Sweden',
      away: 'Greece',
      league: 'Friendly International',
      mode: 'live'
    };
    const parser = createParser({
      visionClient: {
        parsePhoto: jest.fn().mockResolvedValue({
          provider: 'test',
          model: 'mock',
          sport: 'soccer',
          home: 'Sweden',
          away: 'Greece',
          league: 'Friendly International',
          score: '0-1',
          isLive: true,
          outcomeRaw: 'X',
          intent: 'bet',
          confidence: 0.95,
          notes: 'match and selected draw are visible'
        })
      },
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: match.matchId,
          confidence: 1,
          reason: 'exact match'
        })
      },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: {
        resolve: jest.fn()
      }
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/sweden-greece.jpg',
      caption: 'X',
      activationCode: 'Draw001'
    });

    expect(result.state).toBe('ready');
    expect(result.matchId).toBe('5121042');
    expect(result.outcome).toBe('X');
    expect(result.normalizedIntent).toMatchObject({
      family: '1x2',
      selection: 'X',
      normalizedOutcome: 'X'
    });
    expect(parser.outcomeResolver.resolve).not.toHaveBeenCalled();
  });

  test('rejects unsupported nth-goal caption instead of queuing a coerced team total', async () => {
    const match = {
      matchId: '5125140',
      sport: 'soccer',
      home: 'Sweden U21',
      away: 'Finland U21',
      league: 'Friendly International Youth',
      mode: 'live',
      score: '1-1'
    };
    const textClient = {
      complete: jest.fn().mockResolvedValue(JSON.stringify({
        canonical: 'IT2> 2.5',
        confidence: 0.95,
        reason: 'incorrect closest allowed form'
      }))
    };
    const parser = createParser({
      visionClient: {
        parsePhoto: jest.fn().mockResolvedValue({
          provider: 'test',
          model: 'mock',
          sport: 'soccer',
          home: 'Швеция U21',
          away: 'Финляндия U21',
          league: 'Сборные U21',
          score: '1-1',
          isLive: true,
          outcomeRaw: null,
          intent: 'bet',
          confidence: 0.92,
          notes: 'match is clear'
        })
      },
      matchLocator: {
        locate: jest.fn().mockResolvedValue({
          matchId: match.matchId,
          confidence: 0.99,
          reason: 'exact live match'
        })
      },
      adapter: {
        getCatalog: jest.fn().mockResolvedValue([match])
      },
      outcomeResolver: new OutcomeResolverLLM({
        textClient,
        logger: { log: jest.fn() }
      })
    });

    const result = await parser.parseSignal({
      imagePath: '/tmp/sweden-finland.jpg',
      caption: '3 гол 2 команда',
      activationCode: 'JkEyFZE0V2'
    });

    expect(result.state).toBe('rejected_no_outcome');
    expect(result.reason).toContain('unsupported_nth_goal_market');
    expect(textClient.complete).not.toHaveBeenCalled();
  });
});
