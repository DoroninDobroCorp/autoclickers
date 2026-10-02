const { getResolvedSource, normalizeIdentifier } = require('./task-source.js');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  if (!isPlainObject(extra)) {
    return output;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      output[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      output[key] = deepMerge(isPlainObject(output[key]) ? output[key] : {}, value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function resolveTaskMode(task = {}) {
  const rawMode = String(task.mode || (task.isPrematch ? 'prematch' : 'live')).trim().toLowerCase();
  return rawMode === 'prematch' ? 'prematch' : 'live';
}

function normalizeLimitSegment(value, fallback = 'default') {
  return normalizeIdentifier(value) || fallback;
}

function resolveTaskLimitPolicy(task = {}) {
  const mode = resolveTaskMode(task);
  let merged = {};

  for (const candidate of [task.sourcePolicy?.limits, task.telegramPolicy?.limits, task.limitPolicy]) {
    if (isPlainObject(candidate)) {
      merged = deepMerge(merged, candidate);
    }
  }

  if (isPlainObject(merged.modes?.[mode])) {
    merged = deepMerge(merged, merged.modes[mode]);
  }

  if (isPlainObject(merged[mode])) {
    merged = deepMerge(merged, merged[mode]);
  }

  return merged;
}

function getTaskLimitProfileKey(task = {}) {
  if (typeof task.limitProfileKey === 'string' && task.limitProfileKey.trim()) {
    return task.limitProfileKey.trim();
  }

  const sourceMeta = getResolvedSource(task);
  if (sourceMeta.isTelegram) {
    const profileId = normalizeLimitSegment(task.sourceProfileId || task.telegramContext?.profileId, 'default');
    const bookmakerId = normalizeLimitSegment(task.bookmakerId, 'bookmaker');
    const accountId = normalizeLimitSegment(task.accountId, 'default');
    const mode = normalizeLimitSegment(resolveTaskMode(task), 'live');
    return `telegram:${profileId}:${bookmakerId}:${accountId}:${mode}`;
  }

  return String(task.betCategory || sourceMeta.sourceKey || sourceMeta.sourceType || 'analyzer');
}

function getTaskLimitContext(task = {}, betting = {}) {
  const sourceMeta = getResolvedSource(task);
  const mode = resolveTaskMode(task);
  const limitPolicy = resolveTaskLimitPolicy(task);

  if (sourceMeta.isTelegram) {
    const profileId = normalizeLimitSegment(task.sourceProfileId || task.telegramContext?.profileId, 'default');
    const accountId = normalizeLimitSegment(task.accountId, 'default');
    const bookmakerId = normalizeLimitSegment(task.bookmakerId, 'bookmaker');
    const maxTotalPerMatch = pickFiniteNumber(
      limitPolicy.maxTotalPerMatch,
      betting.telegram?.maxTotalPerMatch,
      30
    );
    const maxStakePerStrategy = pickFiniteNumber(
      limitPolicy.maxStakePerStrategy,
      limitPolicy.maxStake,
      betting.telegram?.maxStakePerStrategy,
      betting.telegram?.maxStake
    );
    const maxStakePerBet = pickFiniteNumber(
      limitPolicy.maxStakePerBet,
      betting.telegram?.maxStakePerBet
    );
    const maxBetsPerMatch = pickFiniteNumber(
      limitPolicy.maxBetsPerMatch,
      betting.telegram?.maxBetsPerMatch
    );

    return {
      sourceType: 'telegram',
      betCategory: 'telegram',
      limitProfileKey: getTaskLimitProfileKey(task),
      limitPolicy,
      mode,
      maxTotalPerMatch,
      maxStakePerBet,
      maxStakePerStrategy,
      maxBetsPerMatch,
      label: `TELEGRAM/${profileId}/${bookmakerId}/${accountId}/${mode}`
    };
  }

  const highROIThreshold = betting.highROI?.threshold ?? 15;
  const isHighROI = Boolean(task.isHighROI) || Number(task.expectedROI || 0) >= highROIThreshold;
  const betCategory = isHighROI ? 'analyzer_high' : 'analyzer_normal';

  return {
    sourceType: sourceMeta.sourceType,
    betCategory,
    limitProfileKey: getTaskLimitProfileKey({ ...task, betCategory }),
    limitPolicy,
    mode,
    maxTotalPerMatch: isHighROI
      ? pickFiniteNumber(betting.highROI?.maxTotalPerMatch, 20)
      : pickFiniteNumber(betting.maxTotalPerMatch, 15),
    maxStakePerStrategy: pickFiniteNumber(
      limitPolicy.maxStakePerStrategy,
      limitPolicy.maxStake,
      betting.maxStakePerStrategy
    ),
    maxBetsPerMatch: pickFiniteNumber(limitPolicy.maxBetsPerMatch, betting.maxBetsPerMatch, 4),
    label: isHighROI ? 'ANALYZER HIGH ROI' : 'ANALYZER ОБЫЧНЫЕ'
  };
}

function getTaskLocalLimitOverrides(task = {}) {
  const limitPolicy = resolveTaskLimitPolicy(task);
  const overrides = {
    limitProfileKey: getTaskLimitProfileKey(task)
  };

  const maxStakePerBet = pickFiniteNumber(limitPolicy.maxStakePerBet);
  if (Number.isFinite(maxStakePerBet)) {
    overrides.maxStakePerBet = maxStakePerBet;
  }

  const maxStakePerStrategy = pickFiniteNumber(limitPolicy.maxStakePerStrategy, limitPolicy.maxStake);
  if (Number.isFinite(maxStakePerStrategy)) {
    overrides.maxStakePerStrategy = maxStakePerStrategy;
  }

  const maxBetsPerMatch = pickFiniteNumber(limitPolicy.maxBetsPerMatch);
  if (Number.isFinite(maxBetsPerMatch)) {
    overrides.maxBetsPerMatch = maxBetsPerMatch;
  }

  return overrides;
}

module.exports = {
  resolveTaskMode,
  resolveTaskLimitPolicy,
  getTaskLimitProfileKey,
  getTaskLimitContext,
  getTaskLocalLimitOverrides
};
