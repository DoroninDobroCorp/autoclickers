const { applyExecutionModeConfig } = require('../runtime-mode.js');

describe('runtime mode shared task runner', () => {
  test('analyzer-only keeps task runner enabled when tasks storage is configured', () => {
    const config = {
      tasksFilePath: '/tmp/autobetting-tasks.json',
    };

    const mode = applyExecutionModeConfig(config, ['--analyzer-only'], {});

    expect(mode).toBe('analyzer-only');
    expect(config.enableAnalyzerPolling).toBe(true);
    expect(config.enableTelegramQueue).toBe(false);
    expect(config.enableTaskRunner).toBe(true);
    expect(config.enableTaskQueueApi).toBe(false);
  });
});
