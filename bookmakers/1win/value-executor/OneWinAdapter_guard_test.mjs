// The legacy BaseBettor adapter must not be a second, contract-free way to place a live 1win bet.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { OneWinAdapter } = require('./OneWinAdapter.js');

function adapter(config = {}) {
  const logs = [];
  const a = new OneWinAdapter({ logger: { log: (m) => logs.push(String(m)) }, sessionStatePath: '/nonexistent/session.json', ...config });
  let ensureCalls = 0;
  a._ensureContext = async () => { ensureCalls += 1; throw new Error('browser must not be touched'); };
  return { a, logs, ensureCalls: () => ensureCalls };
}
const call = { outcome: { outcome: 'T< 2.5', marketName: 'Total', selectionName: 'Under 2.5', oddVal: 1.87 },
  stake: 1, match: { matchId: '40021999' }, task: { expectedOdds: 1.87 } };

test('live placement is refused by default and never touches the browser', async () => {
  delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;
  const { a, ensureCalls } = adapter();
  const result = await a.placeBet({ ...call, dryRun: false });
  assert.equal(result.success, false);
  assert.match(String(result.error), /LEGACY_LIVE_PLACEMENT_DISABLED/);
  assert.equal(result.retryable, false);
  assert.equal(ensureCalls(), 0);
});

test('neither the environment switch nor the former legacy opt-in can enable a live placement', async () => {
  process.env.ONEWIN_AUTOMATION_LIVE_ENABLED = 'true';
  for (const config of [{}, { allowLegacyLivePlacement: true }, { allowLegacyLivePlacement: true, dryRun: false, mode: 'live' }]) {
    const { a, ensureCalls } = adapter(config);
    const result = await a.placeBet({ ...call, dryRun: false });
    assert.equal(result.success, false, JSON.stringify(config));
    assert.match(String(result.error), /LEGACY_LIVE_PLACEMENT_DISABLED/);
    assert.equal(result.retryable, false);
    assert.equal(ensureCalls(), 0, 'the browser is never touched by this adapter for a live placement');
  }
  delete process.env.ONEWIN_AUTOMATION_LIVE_ENABLED;
});

test('dry run keeps working and stays a dry run', async () => {
  const { a } = adapter();
  const result = await a.placeBet({ ...call, dryRun: true });
  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
});

test('an unknown wallet balance is zero (fail closed), not a made-up 100', async () => {
  const { a } = adapter();
  assert.equal(await a.getBalance(), 0);
});
