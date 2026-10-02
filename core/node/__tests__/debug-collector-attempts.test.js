const fs = require('fs');
const os = require('os');
const path = require('path');

const { DebugCollector } = require('../debug/DebugCollector.js');

describe('DebugCollector attempt bundles', () => {
  test('writes summary, events, and artifacts for a bet attempt', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-collector-'));
    const collector = new DebugCollector('sansabet', {
      enabled: true,
      runDurationMs: 0,
      logDir: tempDir,
      maxInlineStringLength: 1000
    });

    const attemptId = collector.startAttempt({
      id: 'task-1',
      home: 'Team A',
      away: 'Team B',
      password: 'secret-pass'
    }, {
      source: 'telegram'
    });

    expect(attemptId).toBeTruthy();

    collector.captureAttempt(attemptId, 'match_catalog_loaded', {
      totalMatches: 321,
      authorization: 'Bearer hidden-token'
    });
    const artifact = collector.writeAttemptArtifact(attemptId, 'match_catalog', {
      total: 321,
      headers: { cookie: 'session-cookie' },
      matches: [{ id: 1, home: 'Team A', away: 'Team B' }]
    });
    const bundle = collector.finishAttempt(attemptId, 'failed', {
      success: false,
      error: 'Selection not found'
    });

    expect(artifact).toBeTruthy();
    expect(bundle.status).toBe('failed');
    expect(bundle.task.password).toBe('[REDACTED]');
    expect(bundle.events.map((event) => event.eventType)).toEqual([
      'attempt_started',
      'match_catalog_loaded',
      'attempt_finished'
    ]);

    const dayDirs = fs.readdirSync(path.join(tempDir, 'attempts'));
    expect(dayDirs).toHaveLength(1);
    const attemptRoot = path.join(tempDir, 'attempts', dayDirs[0], attemptId);
    const storedBundle = JSON.parse(fs.readFileSync(path.join(attemptRoot, 'bundle.json'), 'utf8'));
    const storedEvents = fs.readFileSync(path.join(attemptRoot, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const artifactPath = path.join(attemptRoot, storedBundle.artifacts[0].relativePath);
    const artifactText = fs.readFileSync(artifactPath, 'utf8');

    expect(storedBundle.result.error).toBe('Selection not found');
    expect(storedEvents).toHaveLength(3);
    expect(artifactText).toContain('[REDACTED]');
  });
});