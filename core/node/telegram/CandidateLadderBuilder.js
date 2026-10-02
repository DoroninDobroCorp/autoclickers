const { CrossMarketOutcomeMapper } = require('./CrossMarketOutcomeMapper.js');

class CandidateLadderBuilder {
  constructor(config = {}) {
    const exactScoreConfig = {
      safeExtraSteps: 2,
      ...(config.exactScore || {})
    };
    this.config = {
      totals: {
        softenStep: 0.5,
        maxSoftenSteps: 6,
        allowPushLine: true,
        ...(config.totals || {})
      },
      handicap: {
        softenStep: 0.5,
        maxSoftenSteps: 4,
        ...(config.handicap || {})
      },
      exactScore: exactScoreConfig,
      crossMarket: {
        candidateBudget: Number.isFinite(config.candidateBudget) ? config.candidateBudget : 40,
        exactScore: exactScoreConfig,
        ...(config.crossMarket || {})
      }
    };

    this.crossMarketMapper = config.crossMarketMapper || new CrossMarketOutcomeMapper(this.config.crossMarket);
  }

  build(intent = {}, options = {}) {
    const budget = Number.isFinite(options.candidateBudget)
      ? options.candidateBudget
      : this.config.crossMarket.candidateBudget;
    const canonicalIntent = this.crossMarketMapper.canonicalizeIntent({
      ...intent,
      sport: intent.sport || options.sport || null
    });

    const candidates = [];
    const seenOutcomes = new Set();
    const sameMarketSeeds = [];
    const pushCandidate = (candidate) => {
      if (!candidate || !candidate.outcome || seenOutcomes.has(candidate.outcome) || candidates.length >= budget) {
        return false;
      }
      seenOutcomes.add(candidate.outcome);
      candidates.push(candidate);
      return true;
    };

    const primaryOutcome = canonicalIntent.normalizedOutcome || this.crossMarketMapper.formatOutcome(canonicalIntent);
    if (primaryOutcome) {
      canonicalIntent.normalizedOutcome = primaryOutcome;
      pushCandidate({
        priority: 0,
        family: canonicalIntent.family,
        reason: 'primary_signal',
        relationType: 'equivalent',
        outcome: primaryOutcome,
        normalizedIntent: canonicalIntent
      });
    }

    if (canonicalIntent.family === 'totals' || canonicalIntent.family === 'team_total') {
      sameMarketSeeds.push(...this._buildTotalsCandidates(canonicalIntent, options));
    } else if (canonicalIntent.family === 'handicap') {
      sameMarketSeeds.push(...this._buildHandicapCandidates(canonicalIntent));
    }

    for (const candidate of sameMarketSeeds) {
      pushCandidate(candidate);
    }

    const crossMarketSeedCandidates = [
      { normalizedIntent: canonicalIntent },
      ...sameMarketSeeds.map((candidate) => ({ normalizedIntent: candidate.normalizedIntent || candidate }))
    ];
    const crossMarketSeenOutcomes = new Set(seenOutcomes);
    const crossMarketCandidates = this.crossMarketMapper.expand(crossMarketSeedCandidates, {
      sport: canonicalIntent.sport,
      budget: Math.max(0, budget - candidates.length),
      seenOutcomes: crossMarketSeenOutcomes
    });

    for (const candidate of crossMarketCandidates) {
      pushCandidate({
        ...candidate,
        priority: candidates.length
      });
    }

    return candidates.slice(0, budget);
  }

  _buildTotalsCandidates(intent, options = {}) {
    const direction = String(intent.direction || '').toLowerCase();
    const line = Number(intent.line);
    if (!direction || !Number.isFinite(line)) return [];

    const cfg = this.config.totals;
    const minLine = Number.isFinite(options.minLine)
      ? options.minLine
      : (direction === 'over' ? 0.5 : null);
    const team = intent.family === 'team_total'
      ? String(intent.team || '').toUpperCase()
      : null;
    const candidates = [];

    for (let step = 1; step <= cfg.maxSoftenSteps; step++) {
      const nextLine = direction === 'over'
        ? line - (cfg.softenStep * step)
        : line + (cfg.softenStep * step);

      if (minLine !== null && nextLine < minLine) {
        break;
      }

      if (!cfg.allowPushLine && Number.isInteger(nextLine)) {
        continue;
      }

      const normalizedIntent = this.crossMarketMapper.canonicalizeIntent({
        ...intent,
        line: nextLine,
        team,
        normalizedOutcome: null
      });
      normalizedIntent.normalizedOutcome = this.crossMarketMapper.formatOutcome(normalizedIntent);
      if (!normalizedIntent.normalizedOutcome) {
        continue;
      }

      candidates.push({
        priority: step,
        family: normalizedIntent.family,
        reason: 'same_market_softened',
        relationType: 'one_way_safe',
        outcome: normalizedIntent.normalizedOutcome,
        normalizedIntent
      });
    }

    return candidates;
  }

  _buildHandicapCandidates(intent) {
    const side = String(intent.side || '').toUpperCase();
    const line = Number(intent.line);
    if (!side || !Number.isFinite(line) || line === 0) return [];

    const cfg = this.config.handicap;
    const candidates = [];
    for (let step = 1; step <= cfg.maxSoftenSteps; step++) {
      const nextLine = line > 0
        ? line - (cfg.softenStep * step)
        : line + (cfg.softenStep * step);

      if (Math.abs(nextLine) >= Math.abs(line)) {
        continue;
      }

      const normalizedIntent = this.crossMarketMapper.canonicalizeIntent({
        ...intent,
        line: nextLine,
        normalizedOutcome: null
      });
      normalizedIntent.normalizedOutcome = this.crossMarketMapper.formatOutcome(normalizedIntent);
      if (!normalizedIntent.normalizedOutcome) {
        continue;
      }

      candidates.push({
        priority: step,
        family: normalizedIntent.family,
        reason: 'same_market_softened',
        relationType: 'one_way_safe',
        outcome: normalizedIntent.normalizedOutcome,
        normalizedIntent
      });
    }

    return candidates;
  }
}

module.exports = { CandidateLadderBuilder };
