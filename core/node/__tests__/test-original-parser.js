// Quick test of original parseOutcome from auto_sansa
const fs = require('fs');
const path = require('path');

// Read and extract parseOutcome from original file
const originalFile = path.join(__dirname, '../../auto_sansa/playwright_task_executor.js');
const code = fs.readFileSync(originalFile, 'utf8');

// Create a mock class with parseOutcome method
class TestExecutor {
  parseOutcome(task) {
    const outcome = task.outcome;
    
    // Period parsing (recursive)
    const periodMatch = outcome.match(/^(?:P([12])|([12])H|First Half|Second Half)\s+(.+)/i);
    if (periodMatch) {
      const period = parseInt(periodMatch[1] || periodMatch[2] || '1');
      const remainingOutcome = periodMatch[3].trim();
      const parsed = this.parseOutcome({ ...task, outcome: remainingOutcome, period });
      if (parsed) {
        parsed.period = period;
        return parsed;
      }
    }
    
    // 1X2 market
    if (/^[1X2]$/.test(outcome)) {
      return {
        marketHint: '1x2',
        oneXtwo: outcome,
        period: task.period || null
      };
    }

    // Totals
    const totalsMatch = outcome.match(/T\s*([><])\s*([0-9.]+)|(over|under|više|manje)\s*([0-9.]+)|([0-9.]+)\s*([+\-])/i);
    if (totalsMatch) {
      let overUnder, line;
      if (totalsMatch[1]) {
        overUnder = totalsMatch[1] === '>' ? 'over' : 'under';
        line = parseFloat(totalsMatch[2]);
      } else if (totalsMatch[3]) {
        overUnder = /over|više/i.test(totalsMatch[3]) ? 'over' : 'under';
        line = parseFloat(totalsMatch[4]);
      } else {
        overUnder = totalsMatch[6] === '+' ? 'over' : 'under';
        line = parseFloat(totalsMatch[5]);
      }
      return {
        marketHint: 'totals',
        line,
        overUnder,
        period: task.period || null
      };
    }

    // Individual Totals
    const individualTotalsMatch = outcome.match(/IT\s*([12])\s*([><])\s*([0-9.]+)/i);
    if (individualTotalsMatch) {
      const teamIndex = parseInt(individualTotalsMatch[1]);
      const overUnder = individualTotalsMatch[2] === '>' ? 'over' : 'under';
      const line = parseFloat(individualTotalsMatch[3]);
      
      return {
        marketHint: 'teamtotals',
        teamIndex,
        line,
        overUnder,
        period: task.period || null
      };
    }
    
    // Team Totals
    const teamTotalsMatch = outcome.match(/(?:T|Team)\s*([12])\s*(?:over|under|više|manje)?\s*([0-9.]+)\s*([+\-])?|(?:T|Team)\s*([12])\s*([0-9.]+)\s*([+\-])/i);
    if (teamTotalsMatch) {
      const teamIndex = parseInt(teamTotalsMatch[1] || teamTotalsMatch[4]);
      let line, overUnder;
      
      if (teamTotalsMatch[3] || teamTotalsMatch[6]) {
        const sign = teamTotalsMatch[3] || teamTotalsMatch[6];
        overUnder = sign === '+' ? 'over' : 'under';
        line = parseFloat(teamTotalsMatch[2] || teamTotalsMatch[5]);
      } else {
        const text = outcome.toLowerCase();
        overUnder = /over|više/.test(text) ? 'over' : 'under';
        line = parseFloat(teamTotalsMatch[2]);
      }
      
      return {
        marketHint: 'teamtotals',
        teamIndex,
        line,
        overUnder,
        period: task.period || null
      };
    }

    // Handicap
    const handicapMatch = outcome.match(/(?:H|Handicap)?\s*([12])\s*\(?\s*([+\-]?[0-9.]+)\s*\)?/i);
    if (handicapMatch) {
      const handicapTeam = parseInt(handicapMatch[1]);
      const handicapLine = parseFloat(handicapMatch[2]);
      return {
        marketHint: 'handicap',
        handicapTeam,
        handicapLine,
        period: task.period || null
      };
    }

    // Fallback
    return {
      outcomePattern: outcome,
      marketHint: null
    };
  }
}

const executor = new TestExecutor();

// Test problematic cases
const testCases = [
  'H1 -0.5',
  'H2 +1.5',
  'T1 Over 1.5',
  'T2 Under 0.5',
  'T> 2.5',
  'IT1< 1.5',
  'P3 T> 9.5'
];

console.log('=== TESTING ORIGINAL parseOutcome LOGIC ===\n');
testCases.forEach(outcome => {
  const result = executor.parseOutcome({ outcome });
  console.log(`Outcome: "${outcome}"`);
  console.log(`Result:`, JSON.stringify(result, null, 2));
  console.log('');
});
