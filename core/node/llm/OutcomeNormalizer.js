/**
 * OutcomeNormalizer — converts free-text outcome strings (from caption or
 * vision-LLM output) into the canonical labels used by BetProcessor /
 * adapter._findOutcomeOnBookmaker:
 *
 *   1, 2, X            (1X2)
 *   1X, X2, 12         (Double chance — DC variants)
 *   DNB 1, DNB 2       (Draw No Bet)
 *   T> N, T< N         (Total over/under)
 *   IT1> N, IT2> N     (Individual total Team-1/2)
 *   IT1< N, IT2< N     (Individual total under)
 *   H1 -1.5, H2 +1.5   (Asian handicap)
 *   BTTS Yes, BTTS No  (Both teams to score)
 *   CS X:Y             (Correct score)
 *   P1 ..., P2 ...     (First / second half — soccer)
 *   Q1 ..., Q2 ...     (Quarters — basketball)
 *   S1 1, S1 2, ...    (Set winners — tennis/volleyball)
 *
 * Pure regex / dictionary, no LLM. Falls back to original string if it can't
 * normalize (BetProcessor will attempt its own match — keeps backwards compat).
 *
 * intent detection: returns intent='stop' for stop-words.
 */
'use strict';

const STOP_WORDS = [
    'стоп', 'stop', 'отмена', 'не ставь', 'не ставить', 'не стави', 'cancel',
    'отбой', 'отменить', 'not bet', 'no bet',
];

const NORMALIZE_LANG = {
    // map various RU/IT/EN words to canonical token
    'тб': 'T>', 'тм': 'T<', 'тотал больше': 'T>', 'тотал меньше': 'T<',
    'over': 'T>', 'under': 'T<',
    'ит1': 'IT1', 'ит2': 'IT2', 'ит 1': 'IT1', 'ит 2': 'IT2',
    'individual total 1': 'IT1', 'individual total 2': 'IT2',
    'ф1': 'H1', 'ф2': 'H2', 'ф 1': 'H1', 'ф 2': 'H2',
    'фора 1': 'H1', 'фора 2': 'H2',
    'handicap 1': 'H1', 'handicap 2': 'H2', 'ah1': 'H1', 'ah2': 'H2',
};

const PERIOD_PREFIXES = {
    'первый тайм': 'P1', '1 тайм': 'P1', '1тайм': 'P1', '1й тайм': 'P1', 'first half': 'P1', '1h': 'P1',
    'второй тайм': 'P2', '2 тайм': 'P2', '2тайм': 'P2', '2й тайм': 'P2', 'second half': 'P2', '2h': 'P2',
    '1 четверть': 'Q1', '1четверть': 'Q1', '1 quarter': 'Q1', 'q1': 'Q1',
    '2 четверть': 'Q2', '2 quarter': 'Q2', 'q2': 'Q2',
    '3 четверть': 'Q3', '3 quarter': 'Q3', 'q3': 'Q3',
    '4 четверть': 'Q4', '4 quarter': 'Q4', 'q4': 'Q4',
    '1 сет': 'S1', '1сет': 'S1', '1 set': 'S1', 's1': 'S1', 'first set': 'S1',
    '2 сет': 'S2', '2 set': 'S2', 's2': 'S2',
    '3 сет': 'S3', '3 set': 'S3', 's3': 'S3',
};

function detectStop(text) {
    if (!text) return false;
    const t = String(text).toLowerCase().trim();
    if (!t) return false;
    return STOP_WORDS.some((w) => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w));
}

function stripPeriodPrefix(text) {
    let s = String(text).toLowerCase();
    for (const [phrase, code] of Object.entries(PERIOD_PREFIXES)) {
        const re = new RegExp('^\\s*' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:.\\s,-]*', 'i');
        if (re.test(s)) {
            return { period: code, rest: s.replace(re, '').trim() };
        }
    }
    return { period: null, rest: s.trim() };
}

function normalizeLineLiteral(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    return raw
        .replace(',', '.')
        .replace(/^(\d+)\s+(\d)$/, '$1.$2');
}

function isUnsupportedNthGoalMarket(text) {
    const s = String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .trim();
    if (!s) return false;

    const teamMarker = '(?:команд[аы]?\\s*[12]|[12]\\s*(?:команд[аы]?|к(?:ом)?\\.?|team)|т\\s*[12]|team\\s*[12]|home|away|хозя(?:ева|ев)?|гост(?:и|ей)|первая\\s+команда|вторая\\s+команда|first\\s+team|second\\s+team)';
    const nthGoal = '(?:[2-9]\\d*|2\\s*-?\\s*(?:й|ои|ой|го)|3\\s*-?\\s*(?:й|ии|ий|го)|4\\s*-?\\s*(?:й|ии|ий|го)|5\\s*-?\\s*(?:й|ии|ий|го)|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)';
    const nextGoal = '(?:next|следующ(?:ий|его|ая|ую)|след\\.)';
    const goalWord = '(?:гол(?:а|ов)?|goal)';
    const goalIndex = `(?:${nthGoal}|${nextGoal})`;
    const goalThenTeam = new RegExp(`${goalIndex}\\s*${goalWord}[\\s\\S]*${teamMarker}`, 'i');
    const teamThenGoal = new RegExp(`${teamMarker}[\\s\\S]*${goalIndex}\\s*${goalWord}`, 'i');
    return goalThenTeam.test(s) || teamThenGoal.test(s);
}

function normalize(rawOutcome, captionText, sport) {
    // Caption is usually the cleanest source ("1", "2", "ТБ 2.5") because the
    // partner typed it explicitly. The screen-grabbed outcomeRaw can have
    // odds appended ("2 2.75") or other noise. Prefer caption first.
    //
    // Both inputs may be multi-line (getTextContext concatenates message
    // bodies). Scan every non-empty line: in Telegram bursts the match/team
    // often arrives first and the outcome ("W1", "56.5м") arrives on a later
    // line. Dedup if the same line is repeated.
    function lines(s) {
        if (!s) return null;
        return String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    }
    const sources = [...(lines(captionText) || []), ...(lines(rawOutcome) || [])].filter(Boolean);
    // Dedup
    const seen = new Set();
    const uniq = [];
    for (const s of sources) {
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); uniq.push(s);
    }
    if (uniq.length === 0) return { intent: 'unclear', outcome: null };

    // STOP detection across all sources
    for (const s of uniq) if (detectStop(s)) return { intent: 'stop', outcome: null };

    // Try each source; first one that produces a canonical (not pass-through) wins.
    let best = null;
    for (const s of uniq) {
        if (isUnsupportedNthGoalMarket(s)) continue;
        const o = normalizeSingle(s, sport);
        if (o && o.canonical) {
            if (o.canonical !== o.original) {
                best = o; break;
            }
            if (!best) best = o;
        }
    }
    if (!best) return { intent: 'unclear', outcome: null };
    return { intent: 'bet', outcome: best };
}

function normalizeSingle(input, sport) {
    let text = String(input).trim();
    if (!text) return null;
    const original = text;

    // Strip period prefix
    const periodResult = stripPeriodPrefix(text);
    text = periodResult.rest;

    let canonical = null;

    if (isUnsupportedNthGoalMarket(original)) {
        return null;
    }

    // Lone X / Х (Cyrillic) = draw
    if (/^[xх]$/i.test(text)) canonical = 'X';
    // Lone 1 / 2
    else if (/^[12]$/.test(text)) canonical = text;
    // Russian shorthand: П1 = home win = 1, П2 = away win = 2 (П = победа)
    else if (/^[пp]\s*1$/i.test(text)) canonical = '1';
    else if (/^[пp]\s*2$/i.test(text)) canonical = '2';
    // Partner/English shorthand: W1 = win team 1, W2 = win team 2.
    else if (/^w\s*1$/i.test(text)) canonical = '1';
    else if (/^w\s*2$/i.test(text)) canonical = '2';
    // Russian натуральные
    else if (/^ничья$/i.test(text)) canonical = 'X';
    else if (/^победа\s*хозяев$/i.test(text)) canonical = '1';
    else if (/^победа\s*гостей$/i.test(text)) canonical = '2';
    else if (/^home\s*win$/i.test(text)) canonical = '1';
    else if (/^away\s*win$/i.test(text)) canonical = '2';
    else if (/^pareggio$/i.test(text)) canonical = 'X';

    // DC: 1X / Х2 / 12
    else if (/^1[xх]$/i.test(text)) canonical = 'DC 1X';
    else if (/^[xх]2$/i.test(text)) canonical = 'DC X2';
    else if (/^12$/i.test(text)) canonical = 'DC 12';
    else if (/^DC\s+(1X|X2|12)$/i.test(text)) {
        canonical = 'DC ' + text.match(/(1X|X2|12)/i)[1].toUpperCase();
    }

    // BTTS — check NO first to avoid the YES regex eating "BTTS No"
    else if (/^(btts\s*no|both\s*to\s*score\s*no|обе\s*не\s*забьют)/i.test(text)) canonical = 'BTTS No';
    else if (/^(обе\s*забьют|btts(\s*(yes|да))?|both\s*to\s*score(\s*yes)?)/i.test(text)) canonical = 'BTTS Yes';

    // DNB
    else if (/^dnb\s*[12]/i.test(text)) {
        const n = text.match(/[12]/)[0]; canonical = `DNB ${n}`;
    }
    else if (/^с\s*возвратом\s*(если\s*ничья\s*)?[12]/i.test(text)) {
        const n = text.match(/[12]/)[0]; canonical = `DNB ${n}`;
    }

    // Total: ТБ 2.5, ТМ 2.5, Over 2.5, Under 2.5, Тб(2.5), Тб2.5, ТБ 2,5, T> 2.5
    else if (/^(тб|тм|over|under|t>|t<|т>|т<)\s*\(?\s*(\d+(?:[.,]\d+|\s+\d)?)/i.test(text)) {
        const m = text.match(/^(тб|тм|over|under|t>|t<|т>|т<)\s*\(?\s*(\d+(?:[.,]\d+|\s+\d)?)/i);
        const op = /тб|over|t>|т>/i.test(m[1]) ? 'T>' : 'T<';
        const num = normalizeLineLiteral(m[2]);
        canonical = `${op} ${num}`;
    }
    // Russian partner-shorthand "Nб" / "Nм" — N goals/points over/under.
    // Decimal lines are exact bookmaker lines: "56.5м" -> T< 56.5.
    else if (/^(\d+(?:[.,]\d+|\s+\d))\s*[бb]$/i.test(text)) {
        const n = normalizeLineLiteral(text.match(/^(\d+(?:[.,]\d+|\s+\d))\s*[бb]$/i)[1]);
        canonical = `T> ${n}`;
    }
    else if (/^(\d+(?:[.,]\d+|\s+\d))\s*[мm]$/i.test(text)) {
        const n = normalizeLineLiteral(text.match(/^(\d+(?:[.,]\d+|\s+\d))\s*[мm]$/i)[1]);
        canonical = `T< ${n}`;
    }
    // Russian partner-shorthand "Nб" / "Nм" — N goals over/under.
    // Partner writes "6б" meaning "тотал больше 6" → bookmaker line is
    // typically 5.5 (T> 5.5). For "5б" → T> 4.5. Subtract 0.5 from N.
    // Symmetric: "5м" = "тотал меньше 5" → T< 5.5 → add 0.5.
    else if (/^(\d+)\s*[бb]$/i.test(text)) {
        const n = parseInt(text.match(/^(\d+)\s*[бb]$/i)[1]);
        canonical = `T> ${n - 0.5}`;
    }
    else if (/^(\d+)\s*[мm]$/i.test(text)) {
        const n = parseInt(text.match(/^(\d+)\s*[мm]$/i)[1]);
        canonical = `T< ${n + 0.5}`;
    }

    // Individual totals: ИТ1>0.5, ИТ2<2.5, ИТ2М 0.5, IT1B1.5
    else if (/^(?:ит|it)\s*[12]\s*(?:[><]|тб|тм|over|under|[бмbm])\s*\d+(?:[.,]\d+|\s+\d)?/i.test(text)) {
        const m = text.match(/(?:ит|it)\s*([12])\s*([><]|тб|тм|over|under|[бмbm])\s*(\d+(?:[.,]\d+|\s+\d)?)/i);
        const directionToken = String(m[2] || '').toLowerCase();
        const team = m[1], num = normalizeLineLiteral(m[3]);
        const resolvedOp = /^(>|тб|over|[бb])$/.test(directionToken) ? '>' : '<';
        canonical = `IT${team}${resolvedOp} ${num}`;
    }

    // Handicap: Ф1 -1.5, Ф2 +1.5, H1 -1.5, AH1 -1.5
    else if (/^(?:[фh]|ah)\s*[12]\s*[+-]?\s*\d+(?:[.,]\d+|\s+\d)?/i.test(text)) {
        const m = text.match(/^(?:[фh]|ah)\s*([12])\s*([+-]?)\s*(\d+(?:[.,]\d+|\s+\d)?)/i);
        const team = m[1], sign = m[2] || '+', num = normalizeLineLiteral(m[3]);
        canonical = `H${team} ${sign}${num}`;
    }
    // Partner-style handicap: "-2.5 first team" / "+1.5 second team" / "-1 home" / "+2 away"
    else if (/^[+-]?\s*\d+(?:[.,]\d+|\s+\d)?\s+(first\s*team|second\s*team|home|away|первая\s*команда|вторая\s*команда|т1|т2)/i.test(text)) {
        const m = text.match(/^([+-]?)\s*(\d+(?:[.,]\d+|\s+\d)?)\s+(first\s*team|second\s*team|home|away|первая\s*команда|вторая\s*команда|т1|т2)/i);
        const sign = m[1] || '+';
        const num = normalizeLineLiteral(m[2]);
        const sideRaw = m[3].toLowerCase();
        const team = /first\s*team|home|первая\s*команда|т1/.test(sideRaw) ? '1' : '2';
        canonical = `H${team} ${sign}${num}`;
    }
    // Lone signed number: "-2.5" / "+1.5" — partner shorthand for handicap on
    // the home team (the most common pattern when no side is specified).
    // Normalize to H1 with explicit sign.
    else if (/^[+-]\s*\d+(?:[.,]\d+|\s+\d)?$/.test(text)) {
        const m = text.match(/^([+-])\s*(\d+(?:[.,]\d+|\s+\d)?)$/);
        const sign = m[1];
        const num = normalizeLineLiteral(m[2]);
        canonical = `H1 ${sign}${num}`;
    }

    // Correct score: 1:0, счет 1-0, 0:0, 1:3 тс
    else if (/^(счет\s*)?\d+\s*[:\-]\s*\d+(?:\s*тс)?$/i.test(text)) {
        const nums = text.match(/\d+/g);
        canonical = `CS ${nums[0]}:${nums[1]}`;
    }

    // If still nothing, try interpretation by sport (basketball lone X is nonsense)
    if (!canonical && sport === 'basketball' && /^[xх]$/i.test(text)) {
        canonical = null; // basketball has no X (draw) outcome
    }

    if (canonical && periodResult.period) {
        canonical = `${periodResult.period} ${canonical}`;
    }
    return canonical
        ? { original, canonical }
        : { original, canonical: original };  // fall back to passing through
}

module.exports = { normalize, detectStop, isUnsupportedNthGoalMarket };
