const { MatchLocator } = require('../llm/MatchLocator.js');

describe('MatchLocator deterministic team-pair hints', () => {
  test('returns exact catalog pair without calling LLM', async () => {
    const textClient = {
      complete: jest.fn(async () => {
        throw new Error('should_not_call_llm');
      })
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'Godoy Cruz',
        away: 'CA Mitre',
        league: 'Argentina Primera Nacional',
        isLive: true
      },
      catalog: [
        {
          matchId: '5123797',
          sport: 'soccer',
          home: 'Godoy Cruz',
          away: 'CA Mitre',
          league: 'Argentina Primera Nacional',
          mode: 'live'
        }
      ]
    });

    expect(result).toMatchObject({
      matchId: '5123797',
      confidence: 1,
      reason: 'deterministic home/away team-pair match'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('returns reversed catalog pair without calling LLM', async () => {
    const textClient = {
      complete: jest.fn()
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'basketball',
        home: 'Franca BC',
        away: 'Pinheiros',
        league: 'Brazil NBB Play Off',
        isLive: true
      },
      catalog: [
        {
          matchId: 'bb-1',
          sport: 'basketball',
          home: 'Pinheiros',
          away: 'Franca BC',
          league: 'Brazil NBB Play Off',
          mode: 'live'
        }
      ]
    });

    expect(result).toMatchObject({
      matchId: 'bb-1',
      confidence: 1,
      reason: 'deterministic reversed home/away team-pair match'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('keeps short acronym away-team tokens for deterministic pair matching', async () => {
    const textClient = {
      complete: jest.fn(async () => {
        throw new Error('should_not_call_llm');
      })
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'basketball',
        home: 'Ville de Dakar',
        away: 'USO',
        league: 'Senegal Division 1',
        isLive: true
      },
      catalog: [
        {
          matchId: '5128922',
          sport: 'basketball',
          home: 'Ville de Dakar',
          away: 'USO',
          league: 'Basketball Senegal Division 1',
          mode: 'live'
        }
      ]
    });

    expect(result).toMatchObject({
      matchId: '5128922',
      confidence: 1,
      reason: 'deterministic home/away team-pair match'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('matches common acronym to expanded catalog team name without LLM', async () => {
    const textClient = {
      complete: jest.fn(async () => {
        throw new Error('should_not_call_llm');
      })
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'PSG',
        away: 'Arsenal',
        isLive: null
      },
      catalog: [
        {
          matchId: 'psg-ars',
          sport: 'soccer',
          home: 'Paris Saint Germain',
          away: 'Arsenal',
          league: 'Club Friendly',
          mode: 'live'
        }
      ]
    });

    expect(result).toMatchObject({
      matchId: 'psg-ars',
      confidence: 1,
      reason: 'deterministic home/away team-pair match'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });
});

describe('MatchLocator deterministic single-team hints', () => {
  test('returns the unique catalog match containing the single parsed team token without calling LLM', async () => {
    const textClient = {
      complete: jest.fn()
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'U20 Confianca EC',
        away: null
      },
      catalog: [
        {
          matchId: '5124639',
          sport: 'soccer',
          home: 'Confianca U20',
          away: 'Spartax U20',
          league: 'Brazil Campeonato Paraibano U20',
          mode: 'live'
        },
        {
          matchId: 'other',
          sport: 'soccer',
          home: 'Cruzeiro U20',
          away: 'Bahia U20',
          league: 'Brazil U20',
          mode: 'live'
        }
      ]
    });

    expect(result).toEqual({
      matchId: '5124639',
      confidence: 0.96,
      reason: 'unique single-team token match: confianca'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('falls back to LLM when the single team token is not unique', async () => {
    const textClient = {
      complete: jest.fn().mockResolvedValue(JSON.stringify({
        matchId: null,
        confidence: 0,
        reason: 'ambiguous'
      }))
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'U20 Confianca EC',
        away: null
      },
      catalog: [
        { matchId: 'a', sport: 'soccer', home: 'Confianca U20', away: 'Spartax U20' },
        { matchId: 'b', sport: 'soccer', home: 'Confianca PB U20', away: 'Auto Esporte U20' }
      ]
    });

    expect(result.matchId).toBeNull();
    expect(textClient.complete).toHaveBeenCalled();
  });

  test('rejects single-team deterministic match on live women vs prematch unmarked conflict', async () => {
    const textClient = {
      complete: jest.fn()
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'Jordan (W)',
        away: null,
        league: 'Friendly International',
        isLive: true
      },
      catalog: [
        {
          matchId: '5047835',
          sport: 'soccer',
          home: 'Austria',
          away: 'Jordan',
          league: 'FIFA World Cup',
          mode: 'prematch'
        }
      ]
    });

    expect(result).toEqual({
      matchId: null,
      confidence: 0,
      reason: 'single_team_mode_conflict:signal_live_catalog_prematch'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });

  test('does not treat unknown live mode as prematch for single-team deterministic match', async () => {
    const textClient = {
      complete: jest.fn()
    };
    const locator = new MatchLocator({
      textClient,
      logger: { log: jest.fn(), error: jest.fn() }
    });

    const result = await locator.locate({
      parsedSignal: {
        sport: 'soccer',
        home: 'Redencao',
        away: null,
        isLive: null
      },
      catalog: [
        {
          matchId: 'redencao-live',
          sport: 'soccer',
          home: 'Redencao EC',
          away: 'Independente PA',
          league: 'Brazil Paraense',
          mode: 'live'
        }
      ]
    });

    expect(result).toEqual({
      matchId: 'redencao-live',
      confidence: 0.96,
      reason: 'unique single-team token match: redencao'
    });
    expect(textClient.complete).not.toHaveBeenCalled();
  });
});
