const { OutcomeParser } = require('../parsers/outcome-parser.js');

const SUPPORTED_SPORTS = ['soccer', 'basketball', 'tennis', 'volleyball', 'handball', 'hockey', 'esports', 'unknown'];
const SPORT_ALIASES = {
  football: 'soccer',
  soccer: 'soccer',
  basketball: 'basketball',
  tennis: 'tennis',
  volleyball: 'volleyball',
  handball: 'handball',
  hockey: 'hockey',
  ice_hockey: 'hockey',
  esports: 'esports',
  esport: 'esports',
  e_sports: 'esports'
};
const FAMILY_ALIASES = {
  '1x2': '1x2',
  'total': 'totals',
  totals: 'totals',
  team_total: 'team_total',
  team_totals: 'team_total',
  teamtotals: 'team_total',
  handicap: 'handicap',
  exact_score: 'exact_score',
  correctscore: 'exact_score',
  correct_score: 'exact_score',
  exactscore: 'exact_score',
  btts: 'btts',
  doublechance: 'double_chance',
  double_chance: 'double_chance',
  drawnobet: 'draw_no_bet',
  draw_no_bet: 'draw_no_bet',
  winningmargin: 'winning_margin',
  winning_margin: 'winning_margin',
  '3wh': 'three_way_handicap',
  '3_way_handicap': 'three_way_handicap',
  '3wayhandicap': 'three_way_handicap',
  'threewayhandicap': 'three_way_handicap',
  'three_way_handicap': 'three_way_handicap',
  'europeanhandicap': 'three_way_handicap',
  'european_handicap': 'three_way_handicap'
};

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSport(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const canonical = SPORT_ALIASES[normalized] || normalized;
  return SUPPORTED_SPORTS.includes(canonical) ? canonical : 'unknown';
}

function normalizeFamily(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return FAMILY_ALIASES[normalized] || (normalized || 'unknown');
}

function normalizeSelection(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value).trim();
}

function normalizeDirection(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'over' || normalized === '>') return 'over';
  if (normalized === 'under' || normalized === '<') return 'under';
  return normalized || null;
}

function normalizeTeam(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalized = String(value).trim().toUpperCase();
  if (normalized === 'HOME') return '1';
  if (normalized === 'AWAY') return '2';
  if (normalized === '1' || normalized === 'IT1') return '1';
  if (normalized === '2' || normalized === 'IT2') return '2';
  return normalized;
}

function normalizePeriod(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function formatLine(value) {
  return Number(value).toFixed(1).replace(/\.0$/, '');
}

function formatSignedLine(value) {
  const formatted = formatLine(value);
  return formatted.startsWith('-') ? formatted : `+${formatted}`;
}

function withPeriodPrefix(outcome, period) {
  const normalizedPeriod = normalizePeriod(period);
  if (!normalizedPeriod || !outcome) {
    return outcome;
  }
  return `P${normalizedPeriod} ${outcome}`;
}

function isNearlyInteger(value) {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-9;
}

function roundNormalizedNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function capitalize(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatWinningMarginSelection(selection) {
  const parsed = parseWinningMarginSelection(selection);
  if (parsed) {
    if (parsed.side === 'draw') {
      return 'Draw';
    }
    return `${capitalize(parsed.side)} By ${parsed.margin}`;
  }

  return String(selection || '').trim();
}

function parseWinningMarginSelection(selection) {
  const normalized = String(selection || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'draw' || normalized === 'tie') {
    return { side: 'draw', margin: 0, raw: normalized };
  }

  const match = normalized.match(/^(home|away)\s+by\s+(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    side: match[1].toLowerCase(),
    margin: Number(match[2]),
    raw: normalized
  };
}

function deriveThreeWayHandicapFromAsian(intent = {}) {
  const side = normalizeTeam(intent.side);
  const line = toNumber(intent.line);
  if (!side || line === null || (side !== '1' && side !== '2')) {
    return null;
  }

  const derivedLine = side === '1'
    ? line + 0.5
    : -line - 0.5;
  if (!isNearlyInteger(derivedLine)) {
    return null;
  }

  return {
    family: 'three_way_handicap',
    selection: side,
    line: roundNormalizedNumber(derivedLine),
    period: normalizePeriod(intent.period)
  };
}

function deriveAsianHandicapFromThreeWay(intent = {}) {
  const line = toNumber(intent.line);
  const selection = String(intent.selection || '').trim().toUpperCase();
  if (line === null || (selection !== '1' && selection !== '2')) {
    return null;
  }

  const derivedLine = selection === '1'
    ? line - 0.5
    : -line - 0.5;
  return {
    family: 'handicap',
    side: selection,
    line: roundNormalizedNumber(derivedLine),
    period: normalizePeriod(intent.period)
  };
}

function formatOutcome(intent = {}) {
  const family = normalizeFamily(intent.family || intent.marketFamily);
  const selection = normalizeSelection(intent.selection);
  const line = toNumber(intent.line);
  const direction = normalizeDirection(intent.direction);
  const side = normalizeTeam(intent.side);
  const team = normalizeTeam(intent.team);
  const homeScore = toNumber(intent.homeScore);
  const awayScore = toNumber(intent.awayScore);
  const period = normalizePeriod(intent.period);
  let baseOutcome = null;

  if (family === '1x2') {
    const normalized = String(selection || side || '').trim().toUpperCase();
    if (normalized === 'HOME') baseOutcome = '1';
    if (normalized === 'AWAY') baseOutcome = '2';
    if (normalized === 'DRAW') baseOutcome = 'X';
    if (['1', '2', 'X'].includes(normalized)) baseOutcome = normalized;
  }

  if (!baseOutcome && family === 'totals' && line !== null && direction) {
    baseOutcome = `T${direction === 'under' ? '<' : '>'} ${formatLine(line)}`;
  }

  if (!baseOutcome && family === 'team_total' && line !== null && direction && team) {
    baseOutcome = `IT${team}${direction === 'under' ? '<' : '>'} ${formatLine(line)}`;
  }

  if (!baseOutcome && family === 'handicap' && line !== null && side) {
    baseOutcome = `H${side} ${formatLine(line)}`;
  }

  if (!baseOutcome && family === 'three_way_handicap' && line !== null) {
    const normalizedSelection = String(selection || side || '').trim().toUpperCase();
    if (['1', 'X', '2'].includes(normalizedSelection)) {
      baseOutcome = `3WH ${formatSignedLine(line)} ${normalizedSelection}`;
    }
  }

  if (!baseOutcome && family === 'exact_score' && homeScore !== null && awayScore !== null) {
    baseOutcome = `CS ${homeScore}:${awayScore}`;
  }

  if (!baseOutcome && family === 'double_chance' && selection) {
    baseOutcome = `DC ${selection.toUpperCase()}`;
  }

  if (!baseOutcome && family === 'draw_no_bet' && selection) {
    baseOutcome = `DNB ${selection.toUpperCase()}`;
  }

  if (!baseOutcome && family === 'btts' && selection) {
    baseOutcome = `BTTS ${capitalize(selection)}`;
  }

  if (!baseOutcome && family === 'winning_margin' && selection) {
    baseOutcome = `WM ${formatWinningMarginSelection(selection)}`;
  }

  if (baseOutcome) {
    return withPeriodPrefix(baseOutcome, period);
  }

  return String(intent.normalizedOutcome || intent.outcome || '').trim() || null;
}

function mapParsedOutcome(parsed) {
  if (!parsed || !parsed.marketHint) {
    return {};
  }

  switch (parsed.marketHint) {
    case '1x2':
      return {
        family: '1x2',
        selection: parsed.oneXtwo || null
      };
    case 'totals':
      return {
        family: 'totals',
        direction: parsed.overUnder,
        line: parsed.line
      };
    case 'teamtotals':
      return {
        family: 'team_total',
        direction: parsed.overUnder,
        line: parsed.line,
        team: parsed.teamIndex ? String(parsed.teamIndex) : null,
        teamPrefix: parsed.teamIndex ? `IT${parsed.teamIndex}` : null
      };
    case 'handicap':
      return {
        family: 'handicap',
        side: parsed.handicapTeam ? String(parsed.handicapTeam) : null,
        line: parsed.handicapLine
      };
    case 'correctscore':
      return {
        family: 'exact_score',
        homeScore: parsed.homeScore,
        awayScore: parsed.awayScore
      };
    case 'doublechance':
      return {
        family: 'double_chance',
        selection: String(parsed.selection || '').toUpperCase() || null
      };
    case 'drawnobet':
      return {
        family: 'draw_no_bet',
        selection: parsed.selection ? String(parsed.selection).toUpperCase() : null
      };
    case 'btts':
      return {
        family: 'btts',
        selection: parsed.selection || null
      };
    case 'winningmargin':
      return {
        family: 'winning_margin',
        selection: formatWinningMarginSelection(parsed.selection)
      };
    case '3wayhandicap':
      return {
        family: 'three_way_handicap',
        selection: String(parsed.selection || '').toUpperCase() || null,
        line: parsed.line
      };
    default:
      return {};
  }
}

function canonicalizeIntent(intent = {}) {
  const rawOutcome = String(intent.normalizedOutcome || intent.outcome || '').trim() || null;
  const parsed = rawOutcome ? OutcomeParser.parse({ outcome: rawOutcome }) : null;
  const parsedFields = mapParsedOutcome(parsed);
  const family = normalizeFamily(intent.family || intent.marketFamily || parsedFields.family);
  const canonical = {
    sport: normalizeSport(intent.sport),
    family,
    marketFamily: family,
    normalizedOutcome: rawOutcome,
    selection: normalizeSelection(intent.selection ?? parsedFields.selection),
    direction: normalizeDirection(intent.direction ?? parsedFields.direction),
    side: normalizeTeam(intent.side ?? parsedFields.side),
    team: normalizeTeam(intent.team ?? parsedFields.team),
    line: toNumber(intent.line ?? parsedFields.line),
    homeScore: toNumber(intent.homeScore ?? parsedFields.homeScore),
    awayScore: toNumber(intent.awayScore ?? parsedFields.awayScore),
    period: normalizePeriod(intent.period ?? parsed?.period)
  };
  const hasCanonicalParts = Boolean(
    parsedFields.family ||
    (family !== 'unknown' && (
      canonical.selection ||
      canonical.direction ||
      canonical.side ||
      canonical.team ||
      canonical.line !== null ||
      canonical.homeScore !== null ||
      canonical.awayScore !== null
    ))
  );

  if (canonical.team) {
    canonical.teamPrefix = `IT${canonical.team}`;
  }

  if (hasCanonicalParts) {
    canonical.normalizedOutcome = formatOutcome(canonical);
  } else if (!canonical.normalizedOutcome) {
    canonical.normalizedOutcome = formatOutcome(canonical);
  }

  return canonical;
}

function getExactScoreSafeExtraSteps(config = {}) {
  const raw = config.exactScore?.safeExtraSteps ?? config.exactScoreSafeExtraSteps;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}

function buildExactScoreTotalBounds(total, safeExtraSteps) {
  const result = [];
  if (!Number.isFinite(total) || total < 0) return result;

  if (total > 0) {
    for (let step = 0; step <= safeExtraSteps; step++) {
      const line = total - 0.5 - step;
      if (line < 0.5) break;
      result.push({ family: 'totals', direction: 'over', line });
    }
  }

  for (let step = 0; step <= safeExtraSteps; step++) {
    result.push({ family: 'totals', direction: 'under', line: total + 0.5 + step });
  }

  return result;
}

function buildExactScoreTeamTotalBounds(team, score, safeExtraSteps) {
  const result = [];
  if (!team || !Number.isFinite(score) || score < 0) return result;

  if (score > 0) {
    for (let step = 0; step <= safeExtraSteps; step++) {
      const line = score - 0.5 - step;
      if (line < 0.5) break;
      result.push({ family: 'team_total', team, direction: 'over', line });
    }
  }

  for (let step = 0; step <= safeExtraSteps; step++) {
    result.push({ family: 'team_total', team, direction: 'under', line: score + 0.5 + step });
  }

  return result;
}

function buildRuleSet(config = {}) {
  const exactScoreSafeExtraSteps = getExactScoreSafeExtraSteps(config);
  return [
    {
      id: 'exact-score-to-1x2',
      sourceFamily: 'exact_score',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.homeScore === null || intent.awayScore === null) return [];
        if (intent.homeScore > intent.awayScore) return [{ family: '1x2', selection: '1' }];
        if (intent.homeScore < intent.awayScore) return [{ family: '1x2', selection: '2' }];
        return [{ family: '1x2', selection: 'X' }];
      }
    },
    {
      id: 'exact-score-to-totals-bounds',
      sourceFamily: 'exact_score',
      relationType: 'one_way_safe',
      derive(intent) {
        if (intent.homeScore === null || intent.awayScore === null) return [];
        const total = intent.homeScore + intent.awayScore;
        return buildExactScoreTotalBounds(total, exactScoreSafeExtraSteps);
      }
    },
    {
      id: 'exact-score-to-team-totals-bounds',
      sourceFamily: 'exact_score',
      relationType: 'one_way_safe',
      derive(intent) {
        if (intent.homeScore === null || intent.awayScore === null) return [];
        const sides = [
          { team: '1', score: intent.homeScore },
          { team: '2', score: intent.awayScore }
        ];

        const result = [];
        for (const side of sides) {
          result.push(...buildExactScoreTeamTotalBounds(side.team, side.score, exactScoreSafeExtraSteps));
        }

        return result;
      }
    },
    {
      id: 'exact-score-to-btts',
      sourceFamily: 'exact_score',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.homeScore === null || intent.awayScore === null) return [];
        return [{
          family: 'btts',
          selection: intent.homeScore > 0 && intent.awayScore > 0 ? 'Yes' : 'No'
        }];
      }
    },
    {
      id: 'exact-score-to-winning-margin',
      sourceFamily: 'exact_score',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.homeScore === null || intent.awayScore === null) return [];
        if (intent.homeScore > intent.awayScore) {
          return [{ family: 'winning_margin', selection: `Home By ${intent.homeScore - intent.awayScore}` }];
        }
        if (intent.homeScore < intent.awayScore) {
          return [{ family: 'winning_margin', selection: `Away By ${intent.awayScore - intent.homeScore}` }];
        }
        return [{ family: 'winning_margin', selection: 'Draw' }];
      }
    },
    {
      id: 'winning-margin-to-1x2',
      sourceFamily: 'winning_margin',
      relationType: 'equivalent',
      derive(intent) {
        const parsed = parseWinningMarginSelection(intent.selection);
        if (!parsed) return [];
        if (parsed.side === 'home') return [{ family: '1x2', selection: '1' }];
        if (parsed.side === 'away') return [{ family: '1x2', selection: '2' }];
        if (parsed.side === 'draw') return [{ family: '1x2', selection: 'X' }];
        return [];
      }
    },
    {
      id: 'winning-margin-to-handicap',
      sourceFamily: 'winning_margin',
      relationType: 'one_way_safe',
      derive(intent) {
        const parsed = parseWinningMarginSelection(intent.selection);
        if (!parsed || parsed.side === 'draw' || !Number.isFinite(parsed.margin) || parsed.margin <= 0) {
          return [];
        }

        const side = parsed.side === 'home' ? '1' : '2';
        return [{
          family: 'handicap',
          side,
          line: -(parsed.margin - 0.5)
        }];
      }
    },
    {
      id: '1x2-to-double-chance',
      sourceFamily: '1x2',
      relationType: 'one_way_safe',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1') return [{ family: 'double_chance', selection: '1X' }];
        if (selection === '2') return [{ family: 'double_chance', selection: 'X2' }];
        if (selection === 'X') {
          return [
            { family: 'double_chance', selection: '1X' },
            { family: 'double_chance', selection: 'X2' }
          ];
        }
        return [];
      }
    },
    {
      id: '1x2-to-draw-no-bet',
      sourceFamily: '1x2',
      relationType: 'one_way_safe',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1' || selection === '2') {
          return [{ family: 'draw_no_bet', selection }];
        }
        return [];
      }
    },
    {
      id: '1x2-to-three-way-handicap',
      sourceFamily: '1x2',
      relationType: 'equivalent',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (!['1', 'X', '2'].includes(selection)) return [];
        return [{ family: 'three_way_handicap', line: 0, selection }];
      }
    },
    {
      id: '1x2-to-handicap',
      sourceFamily: '1x2',
      relationType: 'equivalent',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1') return [{ family: 'handicap', side: '1', line: -0.5 }];
        if (selection === '2') return [{ family: 'handicap', side: '2', line: -0.5 }];
        return [];
      }
    },
    {
      id: 'draw-no-bet-to-double-chance',
      sourceFamily: 'draw_no_bet',
      relationType: 'one_way_safe',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1') return [{ family: 'double_chance', selection: '1X' }];
        if (selection === '2') return [{ family: 'double_chance', selection: 'X2' }];
        return [];
      }
    },
    {
      id: 'draw-no-bet-to-handicap',
      sourceFamily: 'draw_no_bet',
      relationType: 'equivalent',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1' || selection === '2') {
          return [{ family: 'handicap', side: selection, line: 0 }];
        }
        return [];
      }
    },
    {
      id: 'double-chance-to-handicap',
      sourceFamily: 'double_chance',
      relationType: 'equivalent',
      derive(intent) {
        const selection = String(intent.selection || '').toUpperCase();
        if (selection === '1X') return [{ family: 'handicap', side: '1', line: 0.5 }];
        if (selection === 'X2') return [{ family: 'handicap', side: '2', line: 0.5 }];
        return [];
      }
    },
    {
      id: 'soccer-under-0.5-to-zero-zero-family',
      sourceFamily: 'totals',
      relationType: 'equivalent',
      derive(intent, { sport } = {}) {
        if (sport !== 'soccer') return [];
        if (intent.direction !== 'under' || intent.line === null || intent.line > 0.5) return [];
        return [
          { family: 'exact_score', homeScore: 0, awayScore: 0 },
          { family: 'team_total', team: '1', direction: 'under', line: 0.5 },
          { family: 'team_total', team: '2', direction: 'under', line: 0.5 },
          { family: 'btts', selection: 'No' }
        ];
      }
    },
    {
      id: 'three-way-handicap-to-1x2',
      sourceFamily: 'three_way_handicap',
      relationType: 'equivalent',
      derive(intent) {
        const line = toNumber(intent.line);
        const selection = String(intent.selection || '').toUpperCase();
        if (line !== 0 || !['1', 'X', '2'].includes(selection)) return [];
        return [{ family: '1x2', selection }];
      }
    },
    {
      id: 'three-way-handicap-to-handicap',
      sourceFamily: 'three_way_handicap',
      relationType: 'equivalent',
      derive(intent) {
        const mapped = deriveAsianHandicapFromThreeWay(intent);
        return mapped ? [mapped] : [];
      }
    },
    {
      id: 'handicap-to-1x2',
      sourceFamily: 'handicap',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.line === null || !intent.side) return [];
        if (intent.side === '1' && intent.line === -0.5) return [{ family: '1x2', selection: '1' }];
        if (intent.side === '2' && intent.line === -0.5) return [{ family: '1x2', selection: '2' }];
        return [];
      }
    },
    {
      id: 'handicap-to-double-chance',
      sourceFamily: 'handicap',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.line === null || !intent.side) return [];
        if (intent.side === '1' && intent.line === 0.5) return [{ family: 'double_chance', selection: '1X' }];
        if (intent.side === '2' && intent.line === 0.5) return [{ family: 'double_chance', selection: 'X2' }];
        return [];
      }
    },
    {
      id: 'handicap-to-draw-no-bet',
      sourceFamily: 'handicap',
      relationType: 'equivalent',
      derive(intent) {
        if (intent.line === null || !intent.side) return [];
        if (intent.line === 0 && (intent.side === '1' || intent.side === '2')) {
          return [{ family: 'draw_no_bet', selection: intent.side }];
        }
        return [];
      }
    },
    {
      id: 'handicap-to-three-way-handicap',
      sourceFamily: 'handicap',
      relationType: 'equivalent',
      derive(intent) {
        const mapped = deriveThreeWayHandicapFromAsian(intent);
        return mapped ? [mapped] : [];
      }
    }
  ];
}

class CrossMarketOutcomeMapper {
  constructor(config = {}) {
    this.config = {
      candidateBudget: Number.isFinite(config.candidateBudget) ? config.candidateBudget : 30,
      ...config
    };
    this.rules = buildRuleSet(this.config);
  }

  canonicalizeIntent(intent = {}) {
    return canonicalizeIntent(intent);
  }

  formatOutcome(intent = {}) {
    return formatOutcome(canonicalizeIntent(intent));
  }

  expand(seedCandidates = [], options = {}) {
    const sport = normalizeSport(options.sport || seedCandidates[0]?.sport);
    const budget = Number.isFinite(options.budget) ? options.budget : this.config.candidateBudget;
    const seenOutcomes = options.seenOutcomes || new Set();
    const visited = new Set();
    const queue = [];
    const results = [];

    for (const seed of seedCandidates) {
      const canonical = canonicalizeIntent(seed.normalizedIntent || seed);
      const outcome = canonical.normalizedOutcome || formatOutcome(canonical);
      if (!outcome) {
        continue;
      }
      queue.push({
        intent: canonical,
        path: [outcome]
      });
    }

    while (queue.length > 0 && results.length < budget) {
      const current = queue.shift();
      const currentOutcome = current.intent.normalizedOutcome || formatOutcome(current.intent);
      if (!currentOutcome) {
        continue;
      }

      const visitKey = `${sport}|${current.intent.family}|${currentOutcome}`;
      if (visited.has(visitKey)) {
        continue;
      }
      visited.add(visitKey);

      for (const rule of this.rules) {
        if (rule.sourceFamily !== current.intent.family) {
          continue;
        }

        const derived = Array.isArray(rule.derive(current.intent, { sport }))
          ? rule.derive(current.intent, { sport })
          : [];

        for (const nextIntentInput of derived) {
          const nextIntent = canonicalizeIntent({
            ...nextIntentInput,
            sport,
            period: nextIntentInput.period ?? current.intent.period ?? null
          });
          const outcome = nextIntent.normalizedOutcome || formatOutcome(nextIntent);
          if (!outcome || seenOutcomes.has(outcome)) {
            continue;
          }

          seenOutcomes.add(outcome);
          const candidate = {
            priority: results.length + 1,
            family: nextIntent.family,
            reason: 'cross_market_mapping',
            relationType: rule.relationType,
            mappingRuleId: rule.id,
            outcome,
            normalizedIntent: nextIntent,
            sourceOutcome: currentOutcome,
            mappingPath: [...current.path, outcome]
          };
          results.push(candidate);

          if (results.length >= budget) {
            break;
          }

          queue.push({
            intent: nextIntent,
            path: candidate.mappingPath
          });
        }

        if (results.length >= budget) {
          break;
        }
      }
    }

    return results;
  }
}

module.exports = {
  CrossMarketOutcomeMapper,
  canonicalizeIntent,
  formatOutcome,
  normalizeFamily,
  normalizeSport,
  parseWinningMarginSelection
};
