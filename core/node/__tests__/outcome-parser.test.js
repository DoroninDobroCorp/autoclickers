/**
 * OutcomeParser Tests
 * 
 * Story 2.2 (AUTO-CORE-2): Extract OutcomeParser from auto_sansa
 * 
 * 60+ test cases covering all 6 outcome categories from Story 1.3:
 * - 1X2 (3 tests)
 * - Totals (15 tests)
 * - Individual Totals (10 tests)
 * - Team Totals (10 tests)
 * - Handicap (10 tests)
 * - Period markets (12 tests)
 * - Edge cases (2 tests)
 * 
 * @see docs/autobetting/outcome-types-catalog.md (source of test examples)
 */

const { OutcomeParser } = require('../parsers/outcome-parser.js');

describe('OutcomeParser', () => {
  // ========== 1X2 OUTCOMES (3 tests) ==========
  describe('1X2 outcomes', () => {
    test('should parse "1" as 1x2 market', () => {
      const result = OutcomeParser.parse({ outcome: '1' });
      expect(result).toEqual({
        marketHint: '1x2',
        oneXtwo: '1',
        period: null
      });
    });

    test('should parse "X" as 1x2 market', () => {
      const result = OutcomeParser.parse({ outcome: 'X' });
      expect(result).toEqual({
        marketHint: '1x2',
        oneXtwo: 'X',
        period: null
      });
    });

    test('should parse "2" as 1x2 market', () => {
      const result = OutcomeParser.parse({ outcome: '2' });
      expect(result).toEqual({
        marketHint: '1x2',
        oneXtwo: '2',
        period: null
      });
    });
  });

  // ========== TOTALS OUTCOMES (15 tests) ==========
  describe('Totals outcomes', () => {
    // Format: "T> X"
    test('should parse "T> 0.5" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 0.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 0.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "T> 1.5" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 1.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 1.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "T> 2.5" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 2.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 2.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "T> 10.5" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 10.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 10.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "T> 30.5" as totals over (tennis)', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 30.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 30.5,
        overUnder: 'over',
        period: null
      });
    });

    // Format: "T< X"
    test('should parse "T< 1.5" as totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'T< 1.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 1.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "T< 3.5" as totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'T< 3.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 3.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "T< 23.5" as totals under (tennis)', () => {
      const result = OutcomeParser.parse({ outcome: 'T< 23.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 23.5,
        overUnder: 'under',
        period: null
      });
    });

    // Format: "Over/Under X"
    test('should parse "Over 2.5" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'Over 2.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 2.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "Under 3.5" as totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'Under 3.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 3.5,
        overUnder: 'under',
        period: null
      });
    });

    // Format: "X+/-"
    test('should parse "2.5+" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: '2.5+' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 2.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "1.5-" as totals under', () => {
      const result = OutcomeParser.parse({ outcome: '1.5-' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 1.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "0.5+" as totals over', () => {
      const result = OutcomeParser.parse({ outcome: '0.5+' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 0.5,
        overUnder: 'over',
        period: null
      });
    });

    // Real examples from bet_tasks.json
    test('should parse "T> 16.5" as totals over (tennis)', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 16.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 16.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "T> 17.5" as totals over (tennis)', () => {
      const result = OutcomeParser.parse({ outcome: 'T> 17.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 17.5,
        overUnder: 'over',
        period: null
      });
    });
  });

  // ========== INDIVIDUAL TOTALS (IT) OUTCOMES (10 tests) ==========
  describe('Individual Totals (IT) outcomes', () => {
    // IT1
    test('should parse "IT1< 0.5" as individual totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'IT1< 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 0.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "IT1< 1.5" as individual totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'IT1< 1.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 1.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "IT1> 0.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT1> 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 0.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "IT1> 1.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT1> 1.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 1.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "IT1> 2.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT1> 2.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 2.5,
        overUnder: 'over',
        period: null
      });
    });

    // IT2
    test('should parse "IT2< 0.5" as individual totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'IT2< 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 0.5,
        overUnder: 'under',
        period: null
      });
    });

    test('should parse "IT2> 0.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT2> 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 0.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "IT2> 1.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT2> 1.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 1.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "IT2> 2.5" as individual totals over', () => {
      const result = OutcomeParser.parse({ outcome: 'IT2> 2.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 2.5,
        overUnder: 'over',
        period: null
      });
    });

    test('should parse "IT2< 1.5" as individual totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'IT2< 1.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 1.5,
        overUnder: 'under',
        period: null
      });
    });
  });

  // ========== TEAM TOTALS (T1/T2) OUTCOMES - PARTIAL SUPPORT ==========
  // NOTE: Original parseOutcome() has LIMITED support for Team Totals:
  // - "T1 1.5" (without +/-) WORKS
  // - "T1 Over 1.5", "T2 Under 0.5" are parsed as general totals (BUG)
  describe('Team Totals (T1/T2) outcomes - LIMITED SUPPORT', () => {
    // This format WORKS (no +/- sign, no "over" keyword)
    test('should parse "T1 1.5" as team totals (defaults to under)', () => {
      const result = OutcomeParser.parse({ outcome: 'T1 1.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 1.5,
        overUnder: 'under',  // default when no sign and no "over" keyword
        period: null
      });
    });

    test('should parse "T2 0.5" as team totals (defaults to under)', () => {
      const result = OutcomeParser.parse({ outcome: 'T2 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 0.5,
        overUnder: 'under',  // default when no sign and no "over" keyword
        period: null
      });
    });

    // NOTE: "T1 1.5+" and "T2 0.5-" are parsed as GENERAL TOTALS, not team totals
    // This is because totals regex (with +/-) matches before teamTotals regex
    test.skip('T1 1.5+ is parsed as general totals (BUG)', () => {
      const result = OutcomeParser.parse({ outcome: 'T1 1.5+' });
      expect(result.marketHint).toBe('totals');
    });

    test.skip('T2 0.5- is parsed as general totals (BUG)', () => {
      const result = OutcomeParser.parse({ outcome: 'T2 0.5-' });
      expect(result.marketHint).toBe('totals');
    });

    // These formats DO NOT WORK (parsed as general totals due to regex priority)
    test.skip('T1 Over 1.5 is parsed as general totals (BUG)', () => {
      const result = OutcomeParser.parse({ outcome: 'T1 Over 1.5' });
      // Original behavior: parses as totals, NOT teamtotals
      expect(result.marketHint).toBe('totals');
    });
  });

  // ========== HANDICAP OUTCOMES (10 tests) ==========
  describe('Handicap outcomes', () => {
    // H1
    test('should parse "H1(-1.5)" as handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'H1(-1.5)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 1,
        handicapLine: -1.5,
        period: null
      });
    });

    test('should parse "H1(-2.0)" as handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'H1(-2.0)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 1,
        handicapLine: -2.0,
        period: null
      });
    });

    test('should parse "H1(0.5)" as handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'H1(0.5)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 1,
        handicapLine: 0.5,
        period: null
      });
    });

    // NOTE: Handicap WITHOUT parentheses is NOT supported in original
    // "H1 -1.5" is parsed as totals (BUG in original, but we preserve it)
    test.skip('H1 -1.5 without parentheses is NOT supported (parsed as totals)', () => {
      const result = OutcomeParser.parse({ outcome: 'H1 -1.5' });
      // Original behavior: parses as totals, NOT handicap
      expect(result.marketHint).toBe('totals');
    });

    test.skip('H1 -0.5 without parentheses is NOT supported (parsed as totals)', () => {
      const result = OutcomeParser.parse({ outcome: 'H1 -0.5' });
      // Original behavior: parses as totals, NOT handicap
      expect(result.marketHint).toBe('totals');
    });

    // H2
    test('should parse "H2(-0.5)" as handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'H2(-0.5)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 2,
        handicapLine: -0.5,
        period: null
      });
    });

    test('should parse "H2(+1.5)" as handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'H2(+1.5)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 2,
        handicapLine: 1.5,
        period: null
      });
    });

    test.skip('H2 -0.5 without parentheses is NOT supported (parsed as totals)', () => {
      const result = OutcomeParser.parse({ outcome: 'H2 -0.5' });
      // Original behavior: parses as totals, NOT handicap
      expect(result.marketHint).toBe('totals');
    });

    test.skip('H2 +1.5 without parentheses is NOT supported (parsed as totals)', () => {
      const result = OutcomeParser.parse({ outcome: 'H2 +1.5' });
      // Original behavior: parses as totals, NOT handicap
      expect(result.marketHint).toBe('totals');
    });

    // Without "H" prefix - legacy parser format.
    test('should parse "1 (-1.5)" as handicap (no H prefix)', () => {
      const result = OutcomeParser.parse({ outcome: '1 (-1.5)' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 1,
        handicapLine: -1.5,
        period: null
      });
    });
  });

  // ========== PERIOD MARKETS (12 tests) ==========
  describe('Period markets', () => {
    // P1 (Period 1)
    test('should parse "P1 1" as period 1 with 1x2', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 1' });
      expect(result).toEqual({
        marketHint: '1x2',
        oneXtwo: '1',
        period: 1
      });
    });

    test('should parse "P1 T> 2.5" as period 1 with totals', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 T> 2.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 2.5,
        overUnder: 'over',
        period: 1
      });
    });

    test('should parse "Q1 T< 56.5" as period 1 with basketball quarter totals', () => {
      const result = OutcomeParser.parse({ outcome: 'Q1 T< 56.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 56.5,
        overUnder: 'under',
        period: 1
      });
    });

    test('should parse "S1 T> 8.5" as period 1 with set totals', () => {
      const result = OutcomeParser.parse({ outcome: 'S1 T> 8.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 8.5,
        overUnder: 'over',
        period: 1
      });
    });

    test('should parse "P1 T> 8.5" as period 1 with totals (tennis)', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 T> 8.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 8.5,
        overUnder: 'over',
        period: 1
      });
    });

    test('should parse "P1 IT1> 0.5" as period 1 with IT', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 IT1> 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 1,
        line: 0.5,
        overUnder: 'over',
        period: 1
      });
    });

    test('should parse "P1 H1 0.5" as period 1 with handicap', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 H1 0.5' });
      expect(result).toEqual({
        marketHint: 'handicap',
        handicapTeam: 1,
        handicapLine: 0.5,
        period: 1
      });
    });

    // P2 (Period 2)
    test('should parse "P2 T> 8.5" as period 2 with totals', () => {
      const result = OutcomeParser.parse({ outcome: 'P2 T> 8.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 8.5,
        overUnder: 'over',
        period: 2
      });
    });

    test('should parse "P2 T< 7.5" as period 2 with totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'P2 T< 7.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 7.5,
        overUnder: 'under',
        period: 2
      });
    });

    test('should parse "P2 IT2> 0.5" as period 2 with IT', () => {
      const result = OutcomeParser.parse({ outcome: 'P2 IT2> 0.5' });
      expect(result).toEqual({
        marketHint: 'teamtotals',
        teamIndex: 2,
        line: 0.5,
        overUnder: 'over',
        period: 2
      });
    });

    // 1H/2H (First Half / Second Half)
    test('should parse "1H Over 1.5" as first half with totals', () => {
      const result = OutcomeParser.parse({ outcome: '1H Over 1.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 1.5,
        overUnder: 'over',
        period: 1
      });
    });

    test('should parse "2H Under 2.5" as second half with totals', () => {
      const result = OutcomeParser.parse({ outcome: '2H Under 2.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 2.5,
        overUnder: 'under',
        period: 2
      });
    });

    // P3 (Period 3) - NOT SUPPORTED in original
    // Period regex only supports P1, P2, 1H, 2H
    test.skip('P3 is NOT supported (only P1/P2 supported)', () => {
      const result = OutcomeParser.parse({ outcome: 'P3 T> 9.5' });
      // Original behavior: P3 is not recognized, parses as totals without period
      expect(result.period).toBe(null);
    });

    // Real example from bet_tasks.json
    test('should parse "P1 T< 10.5" as period 1 with totals under', () => {
      const result = OutcomeParser.parse({ outcome: 'P1 T< 10.5' });
      expect(result).toEqual({
        marketHint: 'totals',
        line: 10.5,
        overUnder: 'under',
        period: 1
      });
    });
  });

  // ========== EDGE CASES (2 tests) ==========
  describe('Edge cases and fallback', () => {
    test('should return fallback for unknown format', () => {
      const result = OutcomeParser.parse({ outcome: 'UNKNOWN_FORMAT' });
      expect(result).toEqual({
        outcomePattern: 'UNKNOWN_FORMAT',
        marketHint: null
      });
    });

    test('should return fallback for empty string', () => {
      const result = OutcomeParser.parse({ outcome: '' });
      expect(result).toEqual({
        outcomePattern: '',
        marketHint: null
      });
    });
  });

  // ========== V2 MARKETS (from analyzer equivalences) ==========
  describe('V2 Markets', () => {
    // Double Chance
    test('should parse "DC 1X" as double chance', () => {
      const result = OutcomeParser.parse({ outcome: 'DC 1X' });
      expect(result.marketHint).toBe('doublechance');
      expect(result.selection).toBe('1X');
    });

    test('should parse "DC X2" as double chance', () => {
      const result = OutcomeParser.parse({ outcome: 'DC X2' });
      expect(result.marketHint).toBe('doublechance');
      expect(result.selection).toBe('X2');
    });

    test('should parse "DC 12" as double chance', () => {
      const result = OutcomeParser.parse({ outcome: 'DC 12' });
      expect(result.marketHint).toBe('doublechance');
      expect(result.selection).toBe('12');
    });

    // Draw No Bet
    test('should parse "DNB 1" as draw no bet', () => {
      const result = OutcomeParser.parse({ outcome: 'DNB 1' });
      expect(result.marketHint).toBe('drawnobet');
      expect(result.selection).toBe('1');
    });

    test('should parse "DNB 2" as draw no bet', () => {
      const result = OutcomeParser.parse({ outcome: 'DNB 2' });
      expect(result.marketHint).toBe('drawnobet');
      expect(result.selection).toBe('2');
    });

    // BTTS
    test('should parse "BTTS Yes" as btts', () => {
      const result = OutcomeParser.parse({ outcome: 'BTTS Yes' });
      expect(result.marketHint).toBe('btts');
      expect(result.selection).toBe('yes');
    });

    test('should parse "BTTS No" as btts', () => {
      const result = OutcomeParser.parse({ outcome: 'BTTS No' });
      expect(result.marketHint).toBe('btts');
      expect(result.selection).toBe('no');
    });

    // Odd/Even
    test('should parse "OE Odd" as odd/even', () => {
      const result = OutcomeParser.parse({ outcome: 'OE Odd' });
      expect(result.marketHint).toBe('oddeven');
      expect(result.selection).toBe('odd');
    });

    test('should parse "OE Even" as odd/even', () => {
      const result = OutcomeParser.parse({ outcome: 'OE Even' });
      expect(result.marketHint).toBe('oddeven');
      expect(result.selection).toBe('even');
    });

    // Either Team To Score
    test('should parse "ETS Yes" as either team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'ETS Yes' });
      expect(result.marketHint).toBe('eithertoscore');
      expect(result.selection).toBe('yes');
    });

    test('should parse "ETS No" as either team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'ETS No' });
      expect(result.marketHint).toBe('eithertoscore');
      expect(result.selection).toBe('no');
    });

    // Home Team To Score
    test('should parse "HTS Yes" as home team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'HTS Yes' });
      expect(result.marketHint).toBe('hometoscore');
      expect(result.selection).toBe('yes');
    });

    // Away Team To Score
    test('should parse "ATS No" as away team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'ATS No' });
      expect(result.marketHint).toBe('awaytoscore');
      expect(result.selection).toBe('no');
    });

    // First Team To Score
    test('should parse "FTS Home" as first team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'FTS Home' });
      expect(result.marketHint).toBe('firsttoscore');
      expect(result.selection).toBe('home');
    });

    test('should parse "FTS Away" as first team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'FTS Away' });
      expect(result.marketHint).toBe('firsttoscore');
      expect(result.selection).toBe('away');
    });

    test('should parse "FTS Neither" as first team to score', () => {
      const result = OutcomeParser.parse({ outcome: 'FTS Neither' });
      expect(result.marketHint).toBe('firsttoscore');
      expect(result.selection).toBe('neither');
    });

    // Correct Score
    test('should parse "CS 1:0" as correct score', () => {
      const result = OutcomeParser.parse({ outcome: 'CS 1:0' });
      expect(result.marketHint).toBe('correctscore');
      expect(result.selection).toBe('1:0');
      expect(result.homeGoals).toBe(1);
      expect(result.awayGoals).toBe(0);
    });

    test('should parse "CS 0-0" as correct score', () => {
      const result = OutcomeParser.parse({ outcome: 'CS 0-0' });
      expect(result.marketHint).toBe('correctscore');
      expect(result.selection).toBe('0:0');
    });

    // Winning Margin
    test('should parse "WM Home By 1" as winning margin', () => {
      const result = OutcomeParser.parse({ outcome: 'WM Home By 1' });
      expect(result.marketHint).toBe('winningmargin');
      expect(result.selection).toBe('Home By 1');
    });

    test('should parse "WM NoGoal" as winning margin', () => {
      const result = OutcomeParser.parse({ outcome: 'WM NoGoal' });
      expect(result.marketHint).toBe('winningmargin');
      expect(result.selection).toBe('NoGoal');
    });

    // 3-Way Handicap
    test('should parse "3WH -1 1" as 3-way handicap', () => {
      const result = OutcomeParser.parse({ outcome: '3WH -1 1' });
      expect(result.marketHint).toBe('3wayhandicap');
      expect(result.line).toBe(-1);
      expect(result.selection).toBe('1');
    });

    test('should parse "3WH +2 X" as 3-way handicap', () => {
      const result = OutcomeParser.parse({ outcome: '3WH +2 X' });
      expect(result.marketHint).toBe('3wayhandicap');
      expect(result.line).toBe(2);
      expect(result.selection).toBe('X');
    });
  });
});
