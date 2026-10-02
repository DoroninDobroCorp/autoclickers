/**
 * Sansabet Regression Test
 * 
 * Story 2.2 (AUTO-CORE-2): Verify OutcomeParser maintains same behavior as original
 * 
 * Tests that OutcomeParser.parse() produces IDENTICAL results to the original
 * parseOutcome() function extracted from auto_sansa/playwright_task_executor.js
 * 
 * Uses real outcome examples from bet_tasks.json history to ensure no regressions.
 */

const { OutcomeParser } = require('../../parsers/outcome-parser.js');

describe('Sansabet Regression Test', () => {
  // Real examples from bet_tasks.json history
  const realExamples = [
    // Handicaps (with parentheses - supported)
    {
      outcome: 'H1(-1.5)',
      expected: { marketHint: 'handicap', handicapTeam: 1, handicapLine: -1.5, period: null }
    },
    {
      outcome: 'H2(+1.5)',
      expected: { marketHint: 'handicap', handicapTeam: 2, handicapLine: 1.5, period: null }
    },
    {
      outcome: '1 (-1.5)',  // Handicap without H prefix
      expected: { marketHint: 'handicap', handicapTeam: 1, handicapLine: -1.5, period: null }
    },

    // General Totals
    {
      outcome: 'T> 16.5',
      expected: { marketHint: 'totals', line: 16.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'T< 3.5',
      expected: { marketHint: 'totals', line: 3.5, overUnder: 'under', period: null }
    },
    {
      outcome: 'T> 17.5',
      expected: { marketHint: 'totals', line: 17.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'T< 23.5',
      expected: { marketHint: 'totals', line: 23.5, overUnder: 'under', period: null }
    },
    {
      outcome: 'T> 1.5',
      expected: { marketHint: 'totals', line: 1.5, overUnder: 'over', period: null }
    },

    // Individual Totals
    {
      outcome: 'IT2> 0.5',
      expected: { marketHint: 'teamtotals', teamIndex: 2, line: 0.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'IT1< 0.5',
      expected: { marketHint: 'teamtotals', teamIndex: 1, line: 0.5, overUnder: 'under', period: null }
    },
    {
      outcome: 'IT1> 0.5',
      expected: { marketHint: 'teamtotals', teamIndex: 1, line: 0.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'IT1> 1.5',
      expected: { marketHint: 'teamtotals', teamIndex: 1, line: 1.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'IT1> 2.5',
      expected: { marketHint: 'teamtotals', teamIndex: 1, line: 2.5, overUnder: 'over', period: null }
    },
    {
      outcome: 'IT1< 1.5',
      expected: { marketHint: 'teamtotals', teamIndex: 1, line: 1.5, overUnder: 'under', period: null }
    },

    // Period markets (P1/P2)
    {
      outcome: 'P2 T> 6.5',
      expected: { marketHint: 'totals', line: 6.5, overUnder: 'over', period: 2 }
    },
    {
      outcome: 'P2 T> 8.5',
      expected: { marketHint: 'totals', line: 8.5, overUnder: 'over', period: 2 }
    },
    {
      outcome: 'P1 T> 8.5',
      expected: { marketHint: 'totals', line: 8.5, overUnder: 'over', period: 1 }
    },
    {
      outcome: 'P2 T> 12.5',
      expected: { marketHint: 'totals', line: 12.5, overUnder: 'over', period: 2 }
    },
    {
      outcome: 'P1 T> 2.5',
      expected: { marketHint: 'totals', line: 2.5, overUnder: 'over', period: 1 }
    },
    {
      outcome: 'P2 T> 9.5',
      expected: { marketHint: 'totals', line: 9.5, overUnder: 'over', period: 2 }
    },
    {
      outcome: 'P1 T> 9.5',
      expected: { marketHint: 'totals', line: 9.5, overUnder: 'over', period: 1 }
    },
    {
      outcome: 'P1 T< 10.5',
      expected: { marketHint: 'totals', line: 10.5, overUnder: 'under', period: 1 }
    },
    {
      outcome: 'P2 T< 8.5',
      expected: { marketHint: 'totals', line: 8.5, overUnder: 'under', period: 2 }
    },
    {
      outcome: 'P1 T> 1.5',
      expected: { marketHint: 'totals', line: 1.5, overUnder: 'over', period: 1 }
    },
    {
      outcome: 'P2 T< 7.5',
      expected: { marketHint: 'totals', line: 7.5, overUnder: 'under', period: 2 }
    },
    {
      outcome: 'P1 H1 0.5',
      expected: { marketHint: 'handicap', handicapTeam: 1, handicapLine: 0.5, period: 1 }
    },

    // 1X2 (basic)
    {
      outcome: '1',
      expected: { marketHint: '1x2', oneXtwo: '1', period: null }
    },
    {
      outcome: 'X',
      expected: { marketHint: '1x2', oneXtwo: 'X', period: null }
    },
    {
      outcome: '2',
      expected: { marketHint: '1x2', oneXtwo: '2', period: null }
    },

    // Period with 1X2
    {
      outcome: 'P1 1',
      expected: { marketHint: '1x2', oneXtwo: '1', period: 1 }
    },
    {
      outcome: 'P2 X',
      expected: { marketHint: '1x2', oneXtwo: 'X', period: 2 }
    }
  ];

  test.each(realExamples)(
    'should parse "$outcome" same as original parseOutcome',
    ({ outcome, expected }) => {
      const result = OutcomeParser.parse({ outcome });
      expect(result).toEqual(expected);
    }
  );

  // Test that the integration works (auto_sansa can use OutcomeParser)
  test('auto_sansa integration: OutcomeParser is importable from auto_sansa directory', () => {
    // This test verifies the import path works from auto_sansa perspective
    const { OutcomeParser: ImportedParser } = require('../../parsers/outcome-parser.js');
    expect(ImportedParser).toBeDefined();
    expect(typeof ImportedParser.parse).toBe('function');
    
    // Quick sanity check
    const result = ImportedParser.parse({ outcome: 'T> 2.5' });
    expect(result.marketHint).toBe('totals');
    expect(result.line).toBe(2.5);
    expect(result.overUnder).toBe('over');
  });
});
