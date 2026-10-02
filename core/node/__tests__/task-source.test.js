const {
  inferSourceType,
  getTaskSourceKey,
  getResolvedSource
} = require('../tasks/task-source.js');

describe('task-source utils', () => {
  test('should classify analyzer_fast as analyzer source', () => {
    const meta = getResolvedSource({ source: 'analyzer_fast' });
    expect(meta.isAnalyzer).toBe(true);
    expect(meta.sourceType).toBe('analyzer');
    expect(meta.sourceVariant).toBe('fast');
  });

  test('should classify telegram source by telegram context', () => {
    const meta = getResolvedSource({
      sourceProfileId: 'vip_live',
      telegramContext: { originChatId: -100123 }
    });

    expect(meta.isTelegram).toBe(true);
    expect(meta.sourceType).toBe('telegram');
  });

  test('should derive analyzer source key from task type and roi', () => {
    const source = getTaskSourceKey({
      type: 'fast',
      expectedROI: 18
    }, { highROIThreshold: 15 });

    expect(source).toBe('analyzer_fast_high');
  });

  test('should derive telegram source key from profile id', () => {
    const source = getTaskSourceKey({
      sourceType: 'telegram',
      sourceProfileId: 'VIP Live'
    });

    expect(source).toBe('telegram_vip_live');
  });

  test('should prefer explicit sourceType over raw source guess', () => {
    expect(inferSourceType({ sourceType: 'telegram', source: 'analyzer_fast' })).toBe('telegram');
  });
});
