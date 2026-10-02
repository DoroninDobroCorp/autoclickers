function normalizeSourceValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIdentifier(value) {
  return normalizeSourceValue(value).replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function inferSourceType(task = {}) {
  const explicit = normalizeSourceValue(task.sourceType);
  if (explicit) return explicit;

  const source = normalizeSourceValue(task.source);
  if (source.startsWith('telegram')) return 'telegram';
  if (source.startsWith('analyzer')) return 'analyzer';

  if (task.telegramContext || task.originChatId || task.sourceProfileId) {
    return 'telegram';
  }

  return source || 'analyzer';
}

function inferSourceVariant(task = {}) {
  const explicit = normalizeIdentifier(task.sourceVariant);
  if (explicit) return explicit;

  const source = normalizeSourceValue(task.source);
  if (source.startsWith('analyzer_')) {
    return normalizeIdentifier(source.slice('analyzer_'.length));
  }
  if (source.startsWith('telegram_')) {
    return normalizeIdentifier(source.slice('telegram_'.length));
  }

  return '';
}

function getResolvedSource(task = {}) {
  const sourceType = inferSourceType(task);
  const sourceVariant = inferSourceVariant(task);
  const rawSource = normalizeSourceValue(task.source);
  const sourceKey = rawSource || (sourceType === 'telegram' ? 'telegram' : 'analyzer');

  return {
    rawSource,
    sourceKey,
    sourceType,
    sourceVariant,
    isTelegram: sourceType === 'telegram',
    isAnalyzer: sourceType === 'analyzer'
  };
}

function getAnalyzerSourceKey(task = {}, options = {}) {
  const existing = normalizeSourceValue(task.source);
  if (existing.startsWith('analyzer')) {
    return existing;
  }

  const highROIThreshold = options.highROIThreshold ?? 15;
  const type = normalizeIdentifier(task.type || task.sourceVariant) || 'single';
  const isHighROI = task.isHighROI || Number(task.expectedROI || 0) >= highROIThreshold;
  return `analyzer_${type}${isHighROI ? '_high' : ''}`;
}

function getTelegramSourceKey(task = {}) {
  const existing = normalizeSourceValue(task.source);
  if (existing.startsWith('telegram')) {
    return existing;
  }

  const profileId = normalizeIdentifier(task.sourceProfileId || task.telegramContext?.profileId);
  return profileId ? `telegram_${profileId}` : 'telegram';
}

function getTaskSourceKey(task = {}, options = {}) {
  const meta = getResolvedSource(task);

  if (meta.isTelegram) {
    return getTelegramSourceKey(task);
  }

  if (meta.isAnalyzer) {
    return getAnalyzerSourceKey(task, options);
  }

  return meta.sourceKey;
}

module.exports = {
  normalizeSourceValue,
  normalizeIdentifier,
  inferSourceType,
  inferSourceVariant,
  getResolvedSource,
  getAnalyzerSourceKey,
  getTelegramSourceKey,
  getTaskSourceKey
};
