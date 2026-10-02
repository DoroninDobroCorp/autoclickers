/**
 * 1win Outcome Tester (big_value architecture)
 * Tests outcome resolution and dry-run validation against live/prematch analyzer pairs.
 */

const fs = require('fs');
const path = require('path');
const { OneWinAdapter } = require('./OneWinAdapter.js');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.dryRun = true;

async function testOutcomes() {
    console.log('🧪 1win Outcome Tester starting...');
    const adapter = new OneWinAdapter(config);
    
    // Test outcome mapping
    const sampleOutcomes = [
        '1', 'X', '2',
        '1X', 'X2', '12',
        'T> 2.5', 'T< 2.5', 'T> 1.5', 'T< 3.5',
        'H1 -1.5', 'H2 +1.5', 'H1 0', 'H2 -0.5',
        'BTTS Yes', 'BTTS No'
    ];

    console.log('\n--- Testing Canonical Outcome Mappings ---');
    for (const outStr of sampleOutcomes) {
        const resolved = adapter.findOutcome({ matchId: '12345' }, outStr, 1.95);
        console.log(`Outcome "${outStr.padEnd(9)}" -> Market: "${resolved.marketName}", Selection: "${resolved.selectionName}", GroupId: ${resolved.oddsGroupId}, Line: ${resolved.line}`);
    }

    console.log('\n--- Testing Dry-Run Bet Placement ---');
    const dummyTask = {
        bookmakerMatchId: '39711836',
        expectedOdds: 1.85,
        expectedROI: 5.2,
        home: 'Arsenal',
        away: 'Chelsea'
    };
    const res = await adapter.placeBet({
        outcome: adapter.findOutcome(dummyTask, '1', 1.85),
        stake: 10,
        match: { matchId: dummyTask.bookmakerMatchId },
        task: dummyTask,
        dryRun: true
    });
    console.log('Dry run placement result:', res);
    console.log('\n✅ Outcome tester completed successfully');
}

testOutcomes().catch(console.error);
