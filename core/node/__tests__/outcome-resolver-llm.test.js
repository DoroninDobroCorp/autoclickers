const { OutcomeResolverLLM } = require('../llm/OutcomeResolverLLM.js');

describe('OutcomeResolverLLM', () => {
  test('rejects unsupported nth-goal markets before calling the model', async () => {
    const textClient = {
      complete: jest.fn().mockResolvedValue(JSON.stringify({
        canonical: 'IT2> 2.5',
        confidence: 0.95,
        reason: 'incorrect closest allowed form'
      }))
    };
    const resolver = new OutcomeResolverLLM({
      textClient,
      logger: { log: jest.fn() }
    });

    const result = await resolver.resolve({
      captionText: '3 гол 2 команда',
      sport: 'soccer',
      home: 'Sweden U21',
      away: 'Finland U21',
      score: '1-1'
    });

    expect(result).toMatchObject({
      canonical: null,
      confidence: 0,
      reason: 'unsupported_nth_goal_market'
    });
    expect(result.candidates).toEqual([]);
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('returns validated fallback candidates from model response', async () => {
    const textClient = {
      complete: jest.fn().mockResolvedValue(JSON.stringify({
        canonical: 'T> 135',
        confidence: 0.8,
        reason: 'basketball total over',
        candidates: [
          { canonical: 'T> 134.5', confidence: 0.78, reason: 'lower over line', relationType: 'one_way_safe' },
          { canonical: 'T< 135', confidence: 0.99, reason: 'opposite direction must be filtered' },
          { canonical: 'Next Goal Away', confidence: 0.9, reason: 'not whitelisted' }
        ]
      }))
    };
    const resolver = new OutcomeResolverLLM({
      textClient,
      logger: { log: jest.fn() }
    });

    const result = await resolver.resolve({
      captionText: 'тб135',
      sport: 'basketball'
    });

    expect(result.canonical).toBe('T> 135');
    expect(result.candidates.map((candidate) => candidate.outcome)).toEqual([
      'T> 134.5'
    ]);
  });
});
