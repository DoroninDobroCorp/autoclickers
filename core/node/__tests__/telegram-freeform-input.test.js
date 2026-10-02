/* V1_REWRITE_SKIP — this suite tests the v1 parser/retriever mechanics that
   were removed in the 2026-05-29 v2 rewrite (vision-LLM + match-locator).
   Re-enable once v2 equivalent coverage is written. */
const __origDescribe = describe;
describe = ((...args) => __origDescribe.skip(...args));
describe.skip = __origDescribe.skip;
describe.only = __origDescribe.only;
describe.each = __origDescribe.each;
/**
 * Tests for free-form user input parsing.
 * Covers casual Russian/English phrases that users send instead of structured signals.
 */
const { TelegramIntakeSession } = require('../telegram/TelegramIntakeSession.js');
const { TelegramSignalParser } = require('../telegram/TelegramSignalParser.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn()
  };
}

function makeParser(options = {}) {
  return new TelegramSignalParser({
    logger: createLogger(),
    llmClient: null,
    matchRetriever: null,
    ...options
  });
}

// ─── unit tests on internal helpers ──────────────────────────────────────────

describe('_extractOutcomeShortcutCandidatesFromLine', () => {
  let parser;
  beforeAll(() => {
    parser = makeParser();
  });

  const cases = [
    // totals Russian shorthand
    ['тб2.5', {}, 'T> 2.5'],
    ['тм2.5', {}, 'T< 2.5'],
    ['тб 3', {}, 'T> 3'],
    ['тм 1.5', {}, 'T< 1.5'],
    // English totals
    ['over 2.5', {}, 'T> 2.5'],
    ['under 1.5', {}, 'T< 1.5'],
    ['tb 2.5', {}, 'T> 2.5'],
    // 1X2 shorthand
    ['п1', {}, '1'],
    ['п2', {}, '2'],
    ['х', {}, 'X'],
    ['ничья', {}, 'X'],
    // win phrases
    ['победа хозяев', {}, '1'],
    ['победа гостей', {}, '2'],
    ['победа home', {}, '1'],
    ['победа away', {}, '2'],
    // first half totals
    ['тб 1.5 в 1 тайме', { sport: 'soccer' }, 'P1 T> 1.5'],
    ['тм 0.5 1 тайм', { sport: 'soccer' }, 'P1 T< 0.5'],
    ['тб 2.5 2 тайм', { sport: 'soccer' }, 'P2 T> 2.5'],
    ['1h тб 1.5', { sport: 'soccer' }, 'P1 T> 1.5'],
    ['2h тм 0.5', { sport: 'soccer' }, 'P2 T< 0.5'],
    // first half 1X2
    ['п1 в 1 тайме', { sport: 'soccer' }, 'P1 1'],
    ['п2 во 2 тайме', { sport: 'soccer' }, 'P2 2'],
    // team totals
    ['ит1 б 1.5', {}, 'IT1> 1.5'],
    ['ит2 м 0.5', {}, 'IT2< 0.5'],
    ['it1 > 1.5', {}, 'IT1> 1.5'],
    // handicap
    ['фора 1 (-1.5)', {}, 'H1 -1.5'],
    ['фора 2 (+1.5)', {}, 'H2 +1.5'],
    ['h1 -0.5', {}, 'H1 -0.5'],
    // double chance
    ['1x', {}, 'DC 1X'],
    ['x2', {}, 'DC X2'],
    ['12', {}, 'DC 12'],
    // BTTS
    ['обе забьют да', {}, 'BTTS Yes'],
    ['обе забьют нет', {}, 'BTTS No'],
    ['btts yes', {}, 'BTTS Yes'],
    ['btts no', {}, 'BTTS No'],
    ['GG', {}, 'BTTS Yes'],
    ['NG', {}, 'BTTS No'],
  ];

  test.each(cases)('"%s" → "%s"', (line, context, expected) => {
    const results = parser._extractOutcomeShortcutCandidatesFromLine(line, context);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].normalizedOutcome).toBe(expected);
  });

  test('returns empty array for very long lines (>120 chars)', () => {
    const longLine = 'a'.repeat(121);
    expect(parser._extractOutcomeShortcutCandidatesFromLine(longLine)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parser._extractOutcomeShortcutCandidatesFromLine('')).toEqual([]);
  });

  test('does not duplicate the same outcome', () => {
    const results = parser._extractOutcomeShortcutCandidatesFromLine('тб2.5 over 2.5');
    const outcomes = results.map((r) => r.normalizedOutcome);
    const unique = new Set(outcomes);
    expect(outcomes.length).toBe(unique.size);
  });
});

// ─── team-pair extraction ─────────────────────────────────────────────────────

describe('_extractTeamPairFromLine', () => {
  let parser;
  beforeAll(() => {
    parser = makeParser();
  });

  const cases = [
    ['Интер - Комо', 'Интер', 'Комо'],
    ['Arsenal vs Chelsea', 'Arsenal', 'Chelsea'],
    ['Real Madrid v Barcelona', 'Real Madrid', 'Barcelona'],
    ['PSG – Lyon', 'PSG', 'Lyon'],
    ['Bayern — Dortmund', 'Bayern', 'Dortmund'],
    // double-space separator
    ['Team A  Team B', 'Team A', 'Team B'],
    // outcome noise stripped from away segment
    ['Arsenal vs Chelsea п1', 'Arsenal', 'Chelsea'],
    ['Интер - Комо победа гостей', 'Интер', 'Комо'],
  ];

  test.each(cases)('"%s" → home="%s" away="%s"', (line, expectedHome, expectedAway) => {
    const pair = parser._extractTeamPairFromLine(line);
    expect(pair).not.toBeNull();
    expect(pair.home).toBe(expectedHome);
    expect(pair.away).toBe(expectedAway);
  });

  test('returns null for single-word line', () => {
    expect(parser._extractTeamPairFromLine('Chelsea')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parser._extractTeamPairFromLine('')).toBeNull();
  });
});

// ─── integration: structured text fallback ────────────────────────────────────

describe('TelegramSignalParser free-form text fallback (no LLM)', () => {
  test('parses standard structured signal without LLM', async () => {
    const parser = makeParser();
    const session = new TelegramIntakeSession({ sessionId: 'ff-1', chatId: -1 });
    session.addMessage({
      messageId: 1,
      chatId: -1,
      text: 'home: Arsenal\naway: Chelsea\nsport: soccer\nmode: live\noutcome: 1',
      timestamp: 1000
    });
    const result = await parser.parseSession(session, { runtimeMode: 'live' });
    expect(result.normalizedOutcome).toBe('1');
    expect(result.home).toBe('Arsenal');
    expect(result.away).toBe('Chelsea');
  });

  test('parses tб shorthand from caption line', async () => {
    const parser = makeParser();
    const session = new TelegramIntakeSession({ sessionId: 'ff-2', chatId: -1 });
    session.addMessage({
      messageId: 2,
      chatId: -1,
      text: 'home: Arsenal\naway: Chelsea\nsport: soccer\nmode: live\noutcome: тб2.5',
      timestamp: 1000
    });
    const result = await parser.parseSession(session, { runtimeMode: 'live' });
    expect(result.normalizedOutcome).toBe('T> 2.5');
  });

  test('parses first-half totals from structured text', async () => {
    const parser = makeParser();
    const session = new TelegramIntakeSession({ sessionId: 'ff-3', chatId: -1 });
    session.addMessage({
      messageId: 3,
      chatId: -1,
      text: 'home: Arsenal\naway: Chelsea\nsport: soccer\nmode: prematch\noutcome: P1 T> 1.5',
      timestamp: 1000
    });
    const result = await parser.parseSession(session, { runtimeMode: 'prematch' });
    expect(result.normalizedOutcome).toBe('P1 T> 1.5');
    expect(result.mode).toBe('prematch');
  });

  test('parses handicap from structured text', async () => {
    const parser = makeParser();
    const session = new TelegramIntakeSession({ sessionId: 'ff-4', chatId: -1 });
    session.addMessage({
      messageId: 4,
      chatId: -1,
      text: 'home: Bayern\naway: Dortmund\nsport: soccer\nmode: live\noutcome: H1 -1.5',
      timestamp: 1000
    });
    const result = await parser.parseSession(session, { runtimeMode: 'live' });
    expect(result.normalizedOutcome).toBe('H1 -1.5');
  });

  test('parses BTTS from structured text', async () => {
    const parser = makeParser();
    const session = new TelegramIntakeSession({ sessionId: 'ff-5', chatId: -1 });
    session.addMessage({
      messageId: 5,
      chatId: -1,
      text: 'home: Flamengo\naway: Corinthians\nsport: soccer\nmode: live\noutcome: BTTS Yes',
      timestamp: 1000
    });
    const result = await parser.parseSession(session, { runtimeMode: 'live' });
    expect(result.normalizedOutcome).toBe('BTTS Yes');
  });
});
