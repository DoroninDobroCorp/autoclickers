process.env.MOCK_VISION = '1';
// Test notifications never touch source files or a consuming product's runtime.
process.env.AUTOMATION_COUNTERS_FILE = require('path').join(
  require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'betting-notifier-test-')),
  'counters.json'
);
