const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramIntakeSession } = require('../telegram/TelegramIntakeSession.js');
const { CandidateLadderBuilder } = require('../telegram/CandidateLadderBuilder.js');

describe('telegram layer foundation', () => {
  test('ChatProfileManager should merge defaults, bookmaker and account overrides', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        defaults: {
          defaultMinOdds: 1.7,
          brm: { mode: 'fixed', stake: 10 },
          expansion: { allowSoftTotals: true }
        },
        profiles: {
          vip: {
            chatIds: [-1001],
            bookmakers: {
              sansabet: {
                brm: { stake: 12 },
                accounts: {
                  acc_main: {
                    brm: { stake: 15 }
                  }
                }
              }
            }
          }
        }
      }
    });

    const policy = manager.resolveExecutionPolicy({
      profileId: 'vip',
      bookmakerId: 'sansabet',
      accountId: 'acc_main',
      mode: 'prematch'
    });

    expect(policy.enabled).toBe(true);
    expect(policy.minOdds).toBe(1.7);
    expect(policy.brm.stake).toBe(15);
    expect(policy.feedbackChatIds).toEqual(['-1001']);
  });

  test('ChatProfileManager should resolve ingress profile by chat and mode filters', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          live_main: {
            sourceChatIds: [-2001],
            liveEnabled: true,
            prematchEnabled: false,
            allowedBookmakers: ['sansabet']
          },
          prematch_main: {
            sourceChatIds: [-2001],
            liveEnabled: false,
            prematchEnabled: true,
            allowedBookmakers: ['sansabet']
          }
        }
      }
    });

    const liveProfile = manager.resolveIngressProfile(-2001, {
      bookmakerId: 'sansabet',
      mode: 'live'
    });
    const prematchProfile = manager.resolveIngressProfile(-2001, {
      bookmakerId: 'sansabet',
      mode: 'prematch'
    });

    expect(liveProfile?.id).toBe('live_main');
    expect(prematchProfile?.id).toBe('prematch_main');
  });

  test('ChatProfileManager should keep tgshot cluster profiles reachable by source target', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          default: {
            sourceChatIds: [-1003348760186],
            feedbackChatIds: [-1003348760186]
          },
          vova_cluster: {
            sourceReadOnly: true,
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'bet20_online' },
              { chatId: -1002097397120, topicId: null, label: 'bet20_ex' },
              { chatId: -1002201691237, topicId: null, label: 'vova_root' }
            ],
            feedbackChatIds: [-1003348760186]
          },
          supernova_cluster: {
            sourceReadOnly: true,
            sourceTargets: [
              { chatId: -1002009104562, topicId: 4, label: 'supernova_topic4' },
              { chatId: -1002069845466, topicId: null, label: 'bet20_supernova' }
            ],
            feedbackChatIds: [-1003348760186]
          }
        }
      }
    });

    expect(manager.resolveIngressProfile({ chatId: -1002009104562, topicId: 4 })?.id).toBe('supernova_cluster');
    expect(manager.resolveIngressProfile({ chatId: -1002069845466, topicId: null })?.id).toBe('supernova_cluster');
    expect(manager.resolveIngressProfile({ chatId: -1002201691237, topicId: null })?.id).toBe('vova_cluster');
    expect(manager.resolveIngressProfile({ chatId: -1002010985531, topicId: null })?.id).toBe('vova_cluster');
    expect(manager.resolveIngressProfile({ chatId: -1002097397120, topicId: null })?.id).toBe('vova_cluster');
  });

  test('ChatProfileManager should support directions alias and sender username fallback', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        directions: {
          alpha: {
            sourceChatIds: [-5001],
            allowedSenders: [
              { userId: 101, usernames: ['alpha_capper'] }
            ]
          }
        },
        profiles: {
          fallback: {
            sourceChatIds: [-5001]
          }
        }
      }
    });

    const byId = manager.resolveIngressProfile({
      chatId: -5001,
      authorId: 101,
      authorUsername: 'alpha_capper'
    });
    const byUsername = manager.resolveIngressProfile({
      chatId: -5001,
      authorUsername: 'alpha_capper'
    });
    const fallback = manager.resolveIngressProfile({
      chatId: -5001,
      authorId: 999,
      authorUsername: 'random_user'
    });

    expect(byId?.id).toBe('alpha');
    expect(byUsername?.id).toBe('alpha');
    expect(fallback?.id).toBe('fallback');
  });

  test('TelegramIntakeSession should aggregate caption, texts and images', () => {
    const session = new TelegramIntakeSession({
      sessionId: 'sig-1',
      chatId: -1001,
      topicId: 42
    });

    session.addMessage({
      messageId: 10,
      chatId: -1001,
      topicId: 42,
      caption: 'ТБ 3.5',
      image: '/tmp/shot-1.png',
      timestamp: 1000
    });

    session.addMessage({
      messageId: 11,
      chatId: -1001,
      topicId: 42,
      text: 'если ниже 1.85 не брать',
      timestamp: 2000
    });

    const payload = session.toLLMPayload();
    expect(payload.primaryImage).toBe('/tmp/shot-1.png');
    expect(payload.textContext).toContain('ТБ 3.5');
    expect(payload.textContext).toContain('если ниже 1.85 не брать');
    expect(payload.messageIds).toEqual([10, 11]);
  });

  test('CandidateLadderBuilder should soften totals and derive exact score families', () => {
    const builder = new CandidateLadderBuilder({
      totals: { maxSoftenSteps: 2, allowPushLine: true },
      exactScore: { allowDerivedFamilies: true }
    });

    const totalCandidates = builder.build({
      family: 'totals',
      direction: 'over',
      line: 3.5,
      normalizedOutcome: 'T> 3.5'
    });

    expect(totalCandidates.map((candidate) => candidate.outcome)).toEqual([
      'T> 3.5',
      'T> 3',
      'T> 2.5'
    ]);

    const scoreCandidates = builder.build({
      family: 'exact_score',
      normalizedOutcome: 'CS 2:1',
      homeScore: 2,
      awayScore: 1
    });

    expect(scoreCandidates.some((candidate) => candidate.family === 'totals')).toBe(true);
    expect(scoreCandidates.some((candidate) => candidate.family === 'team_total')).toBe(true);
    expect(scoreCandidates.some((candidate) => candidate.family === 'btts')).toBe(true);
    expect(scoreCandidates.some((candidate) => candidate.family === 'winning_margin')).toBe(true);
  });

  test('CandidateLadderBuilder should normalize HOME handicap sides to H1 ladder outcomes', () => {
    const builder = new CandidateLadderBuilder({
      handicap: { maxSoftenSteps: 2 }
    });

    const handicapCandidates = builder.build({
      sport: 'basketball',
      family: 'handicap',
      marketFamily: 'handicap',
      normalizedOutcome: 'H1 -22.5',
      selection: '1',
      side: 'HOME',
      team: '1',
      line: -22.5
    });

    expect(handicapCandidates.slice(0, 3).map((candidate) => candidate.outcome)).toEqual([
      'H1 -22.5',
      'H1 -22',
      'H1 -21.5'
    ]);
    expect(handicapCandidates[0].normalizedIntent.side).toBe('1');
  });

  test('CandidateLadderBuilder should derive 3WH equivalents for soccer half-handicaps and keep period prefix', () => {
    const builder = new CandidateLadderBuilder({
      handicap: { maxSoftenSteps: 2 },
      crossMarket: { candidateBudget: 20 }
    });

    const handicapCandidates = builder.build({
      sport: 'soccer',
      family: 'handicap',
      marketFamily: 'handicap',
      normalizedOutcome: 'P1 H1 -2.5',
      side: '1',
      line: -2.5,
      period: 1
    });

    expect(handicapCandidates.slice(0, 3).map((candidate) => candidate.outcome)).toEqual([
      'P1 H1 -2.5',
      'P1 H1 -2',
      'P1 H1 -1.5'
    ]);
    expect(handicapCandidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['P1 3WH -2 1'])
    );
  });

  test('CandidateLadderBuilder should expand deterministic cross-market mappings with budget guard', () => {
    const builder = new CandidateLadderBuilder({
      candidateBudget: 30,
      totals: { maxSoftenSteps: 1 }
    });

    const oneXTwoCandidates = builder.build({
      family: '1x2',
      normalizedOutcome: '1',
      selection: '1',
      sport: 'soccer'
    });
    const winningMarginCandidates = builder.build({
      family: 'winning_margin',
      normalizedOutcome: 'WM Home By 2',
      selection: 'Home By 2',
      sport: 'soccer'
    });

    expect(oneXTwoCandidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['1', 'DC 1X', 'DNB 1', 'H1 -0.5', '3WH +0 1'])
    );
    expect(winningMarginCandidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['WM Home By 2', '1', 'H1 -1.5'])
    );
    expect(oneXTwoCandidates.length).toBeLessThanOrEqual(30);
  });

  test('CandidateLadderBuilder should build wider Telegram total ladders for basketball', () => {
    const builder = new CandidateLadderBuilder();

    const candidates = builder.build({
      sport: 'basketball',
      family: 'totals',
      direction: 'over',
      line: 135,
      normalizedOutcome: 'T> 135'
    });

    expect(candidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['T> 135', 'T> 134.5', 'T> 134', 'T> 133.5', 'T> 133'])
    );
  });

  test('CandidateLadderBuilder should keep basketball quarter period from Q-prefixed outcomes', () => {
    const builder = new CandidateLadderBuilder();

    const candidates = builder.build({
      sport: 'basketball',
      normalizedOutcome: 'Q1 T< 56.5'
    });

    expect(candidates.slice(0, 3).map((candidate) => candidate.outcome)).toEqual([
      'P1 T< 56.5',
      'P1 T< 57',
      'P1 T< 57.5'
    ]);
    expect(candidates[0].normalizedIntent.period).toBe(1);
  });

  test('CandidateLadderBuilder should not produce impossible negative over lines', () => {
    const builder = new CandidateLadderBuilder();

    const candidates = builder.build({
      sport: 'soccer',
      normalizedOutcome: 'IT1> 1.5'
    });

    expect(candidates.map((candidate) => candidate.outcome)).toEqual([
      'IT1> 1.5',
      'IT1> 1',
      'IT1> 0.5'
    ]);
  });

  test('CandidateLadderBuilder should derive zero-zero family from soccer under 0.5', () => {
    const builder = new CandidateLadderBuilder({
      crossMarket: { candidateBudget: 20 }
    });

    const candidates = builder.build({
      sport: 'soccer',
      family: 'totals',
      direction: 'under',
      line: 0.5,
      normalizedOutcome: 'T< 0.5'
    });

    expect(candidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['T< 0.5', 'T< 1.5', 'CS 0:0', 'IT1< 0.5', 'IT2< 0.5', 'BTTS No'])
    );
  });

  test('CandidateLadderBuilder should expand exact scores into broader safe bounds', () => {
    const builder = new CandidateLadderBuilder({
      crossMarket: { candidateBudget: 40 }
    });

    const candidates = builder.build({
      sport: 'soccer',
      family: 'exact_score',
      normalizedOutcome: 'CS 0:0',
      homeScore: 0,
      awayScore: 0
    });

    expect(candidates.map((candidate) => candidate.outcome)).toEqual(
      expect.arrayContaining(['CS 0:0', 'X', 'T< 0.5', 'T< 1.5', 'T< 2.5', 'IT1< 0.5', 'IT2< 0.5', 'BTTS No'])
    );
  });
});
