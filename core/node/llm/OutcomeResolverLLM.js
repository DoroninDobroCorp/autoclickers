/**
 * OutcomeResolverLLM — fallback resolver that uses a text-LLM (Claude/GPT-4o)
 * to map ambiguous partner-style outcome captions into the canonical forms
 * BetProcessor expects.
 *
 * Pipeline integration:
 *   OutcomeNormalizer (regex, deterministic) — 95% of cases resolved here.
 *   ↓ (if intent='unclear' OR canonical===original passthrough)
 *   OutcomeResolverLLM (this module) — handles novel partner shortcuts
 *   ↓
 *   Strict whitelist validation — drop hallucinated forms.
 *   ↓
 *   BetProcessor.findOutcome / placeBet
 *
 * Whitelist (only forms BetProcessor's OutcomeParser + selection-finder
 * recognize):
 *   1, 2, X, 1X, X2, 12, DC 1X, DC X2, DC 12,
 *   T> N, T< N, IT1> N, IT2> N, IT1< N, IT2< N,
 *   H1 ±N, H2 ±N,
 *   BTTS Yes, BTTS No,
 *   DNB 1, DNB 2,
 *   CS X:Y,
 *   P1 ..., P2 ..., Q1 ..., Q2 ..., Q3 ..., Q4 ..., S1 1, S1 2, S2 1, S2 2, S3 1, S3 2,
 *   HT/FT 1/X, HT/FT X/2, etc.
 *
 * Returns:
 *   { canonical: 'T> 5.5', confidence: 0.0..1.0, reason: '...' }   on success
 *   { canonical: null,     confidence: 0,         reason: '...' }   on no match
 */
'use strict';

const { isUnsupportedNthGoalMarket } = require('./OutcomeNormalizer.js');
const { CrossMarketOutcomeMapper, canonicalizeIntent } = require('../telegram/CrossMarketOutcomeMapper.js');

const ALLOWED_SIMPLE = new Set([
    '1', '2', 'X',
    '1X', 'X2', '12',
    'DC 1X', 'DC X2', 'DC 12',
    'BTTS Yes', 'BTTS No',
    'DNB 1', 'DNB 2',
    'OE Odd', 'OE Even',
]);

// Patterns that accept a numeric line / score / period
const ALLOWED_PATTERNS = [
    /^T>\s+\d+(\.\d+)?$/,                                 // T> N
    /^T<\s+\d+(\.\d+)?$/,                                 // T< N
    /^IT[12][<>]\s+\d+(\.\d+)?$/,                         // IT1> 0.5 etc.
    /^H[12]\s+[+-]?\d+(\.\d+)?$/,                         // H1 -1.5
    /^CS\s+\d+:\d+$/,                                     // CS 1:0
    /^HT\/FT\s+[1X2]\/[1X2]$/,                            // HT/FT 1/X
    /^P[12]\s+.+$/,                                       // period prefix
    /^Q[1-4]\s+.+$/,                                      // basketball quarters
    /^S[1-5]\s+.+$/,                                      // tennis sets
    /^3WH\s+[+-]?\d+(\.\d+)?\s+[1X2]$/,                   // 3-way handicap
];

const ALLOWED_DESCRIPTION = `
  Single tokens: "1", "2", "X"
  Double chance: "DC 1X", "DC X2", "DC 12"
  Total: "T> 2.5", "T< 2.5"
  Individual total: "IT1> 0.5", "IT2< 1.5"
  Handicap: "H1 -1.5", "H2 +2.5"  (sign explicit; team1=home, team2=away)
  Both teams to score: "BTTS Yes", "BTTS No"
  Draw No Bet: "DNB 1", "DNB 2"
  Correct score: "CS 1:0", "CS 2:1"
  Half-time/full-time: "HT/FT 1/X" / "HT/FT X/2"
  Odd/Even: "OE Odd", "OE Even"
  3-way handicap: "3WH -1.5 2"
  Period prefix: "P1 1" (1st half), "P2 X", "P1 T> 1.5"
  Basketball quarters: "Q1 1", "Q1 T> 50.5"
  Tennis sets: "S1 1", "S2 2"
  Unsupported: team to score the Nth/next goal, e.g. "3 гол 2 команда" / "3rd goal team 2"
`.trim();

function isAllowedCanonical(value) {
    const cleaned = String(value || '').trim();
    if (!cleaned || isUnsupportedNthGoalMarket(cleaned)) return false;
    return ALLOWED_SIMPLE.has(cleaned) || ALLOWED_PATTERNS.some((re) => re.test(cleaned));
}

function isCandidateSafeForPrimary(primaryOutcome, candidateOutcome) {
    const primary = canonicalizeIntent({ normalizedOutcome: primaryOutcome });
    const candidate = canonicalizeIntent({ normalizedOutcome: candidateOutcome });
    if (!primary.family || !candidate.family) return false;

    if (primary.family === 'totals') {
        if (candidate.family !== 'totals' || candidate.direction !== primary.direction) return false;
        if (!Number.isFinite(primary.line) || !Number.isFinite(candidate.line)) return false;
        return primary.direction === 'over'
            ? candidate.line <= primary.line
            : candidate.line >= primary.line;
    }

    if (primary.family === 'team_total') {
        if (candidate.family !== 'team_total' || candidate.team !== primary.team || candidate.direction !== primary.direction) return false;
        if (!Number.isFinite(primary.line) || !Number.isFinite(candidate.line)) return false;
        return primary.direction === 'over'
            ? candidate.line <= primary.line
            : candidate.line >= primary.line;
    }

    const mapper = new CrossMarketOutcomeMapper({
        candidateBudget: 80,
        exactScore: { safeExtraSteps: 3 }
    });
    const primaryOutcomeNormalized = primary.normalizedOutcome || primaryOutcome;
    const safeOutcomes = mapper.expand([{ normalizedIntent: primary }], {
        sport: primary.sport,
        budget: 80,
        seenOutcomes: new Set([primaryOutcomeNormalized])
    });
    return safeOutcomes.some((safe) => safe.outcome === (candidate.normalizedOutcome || candidateOutcome));
}

function normalizeCandidate(candidate, fallbackReason = 'llm_candidate', primaryOutcome = null) {
    if (!candidate) return null;
    const rawCanonical = typeof candidate === 'string'
        ? candidate
        : (candidate.canonical || candidate.outcome || candidate.normalizedOutcome);
    const canonical = String(rawCanonical || '').trim();
    if (!isAllowedCanonical(canonical)) return null;
    if (primaryOutcome && !isCandidateSafeForPrimary(primaryOutcome, canonical)) return null;
    return {
        outcome: canonical,
        canonical,
        confidence: typeof candidate.confidence === 'number'
            ? Math.max(0, Math.min(1, candidate.confidence))
            : null,
        reason: typeof candidate.reason === 'string' && candidate.reason.trim()
            ? candidate.reason.trim().slice(0, 160)
            : fallbackReason,
        relationType: typeof candidate.relationType === 'string' && candidate.relationType.trim()
            ? candidate.relationType.trim()
            : 'llm_suggested',
    };
}

class OutcomeResolverLLM {
    /**
     * @param {Object} opts
     * @param {Object} opts.textClient  TextLLMClient (Anthropic / OpenAI / Mock).
     * @param {Object} [opts.logger]
     */
    constructor({ textClient, logger } = {}) {
        if (!textClient) throw new Error('OutcomeResolverLLM requires textClient');
        this.textClient = textClient;
        this.logger = logger || console;
    }

    /**
     * @param {Object} input
     * @param {string} input.captionText        Raw partner caption text.
     * @param {string} [input.visionOutcomeRaw] Vision-LLM's outcomeRaw extraction.
     * @param {string} input.sport              'soccer'|'basketball'|...|null
     * @param {string} [input.home]
     * @param {string} [input.away]
     * @param {string} [input.score]
     * @param {string} [input.matchTime]
     * @returns {Promise<{ canonical: string|null, confidence: number, reason: string }>}
     */
    async resolve({ captionText, visionOutcomeRaw, sport, home, away, score, matchTime } = {}) {
        const cap = String(captionText || '').trim();
        const vis = String(visionOutcomeRaw || '').trim();
        if (!cap && !vis) {
            return { canonical: null, confidence: 0, reason: 'no_input' };
        }
        if (isUnsupportedNthGoalMarket(cap) || isUnsupportedNthGoalMarket(vis)) {
            return {
                canonical: null,
                confidence: 0,
                reason: 'unsupported_nth_goal_market',
                candidates: [],
            };
        }

        const system = this._systemPrompt();
        const user = this._userPrompt({ captionText: cap, visionOutcomeRaw: vis, sport, home, away, score, matchTime });

        const t0 = Date.now();
        let raw;
        try {
            raw = await this.textClient.complete({ system, user, jsonOnly: true });
        } catch (e) {
            return { canonical: null, confidence: 0, reason: `llm_error:${e.message?.slice(0, 100)}` };
        }
        const ms = Date.now() - t0;

        const parsed = this._parseLLMResponse(raw);
        if (!parsed) {
            return { canonical: null, confidence: 0, reason: 'unparseable_response' };
        }
        if (!parsed.canonical) {
            return { canonical: null, confidence: parsed.confidence, reason: parsed.reason || 'llm_no_match', candidates: parsed.candidates || [] };
        }

        // Strict whitelist validation — protect against hallucinated forms
        // BetProcessor's OutcomeParser cannot recognize.
        const cleaned = parsed.canonical.trim();
        if (!isAllowedCanonical(cleaned)) {
            this.logger?.log?.(`⚠️ [OutcomeResolverLLM] rejected non-whitelist canonical: "${cleaned}"`);
            return {
                canonical: null,
                confidence: 0,
                reason: `not_in_whitelist:${cleaned.slice(0, 30)}`,
                candidates: parsed.candidates || [],
            };
        }
        this.logger?.log?.(`🧠 OutcomeResolverLLM: caption="${cap}"+raw="${vis}" → "${cleaned}" conf=${parsed.confidence} (${ms}ms)`);
        const candidates = [];
        const seen = new Set([cleaned]);
        for (const candidate of parsed.candidates || []) {
            const normalized = normalizeCandidate(candidate, 'llm_candidate', cleaned);
            if (!normalized || seen.has(normalized.outcome)) continue;
            seen.add(normalized.outcome);
            candidates.push(normalized);
        }
        return { canonical: cleaned, confidence: parsed.confidence, reason: parsed.reason, candidates };
    }

    _systemPrompt() {
        return [
            'You translate ambiguous sports-betting partner shorthand into one canonical outcome label.',
            'You are a fallback called only after the deterministic regex normalizer cannot decide.',
            '',
            'INPUT: caption typed by partner + outcome string vision-LLM read off the screenshot + sport + (optional) match info.',
            '',
            'OUTPUT: STRICT JSON only:',
            '{ "canonical": string|null, "confidence": 0.0..1.0, "reason": "1 short sentence", "candidates": [{"canonical": string, "confidence": 0.0..1.0, "reason": "short", "relationType": "equivalent|one_way_safe"}] }',
            '',
            'ALLOWED canonical forms (and ONLY these — anything outside this list will be rejected downstream):',
            ALLOWED_DESCRIPTION,
            '',
            'Rules:',
            ' - Partner caption text is the primary source for outcome. Vision outcome is optional context only.',
            ' - If caption agrees with vision outcome — they corroborate. Set high confidence.',
            ' - If caption contradicts vision (e.g. caption says "м"/under but vision says over), prefer the caption and lower confidence only if the caption itself is ambiguous.',
            ' - Russian partner shorthand: decimal "N.5б"/"N,5б" = "T> N.5"; decimal "N.5м"/"N,5м" = "T< N.5". Integer football shorthand still means threshold wording: "6б" → "T> 5.5", "5м" → "T< 5.5". "П1"/"П2" = home/away win = "1"/"2"; "Х" (cyrillic) = draw = "X"; "тс" = correct score.',
            ' - Sport context matters: in basketball/tennis there is no "X" outcome, so a lone "X" caption + basketball sport → confidence<0.5.',
            ' - "first team", "home" → team 1; "second team", "away" → team 2.',
            ' - Period prefixes ("первый тайм", "1st half", "1 четверть", "1 сет") become P1/P2/Q1-Q4/S1-S5 prefix.',
            ' - Nth/next goal markets are NOT individual totals. For "3 гол 2 команда", "3rd goal team 2", "next goal away", return canonical=null unless an explicit allowed first-to-score form applies.',
            ' - Do not choose the closest allowed form when the requested market is unsupported.',
            ' - candidates are optional Telegram-only fallbacks. Include only outcomes logically implied by the requested bet or safer one-way alternatives that keep the same direction:',
            '     • Total over N: candidates may include lower over lines, e.g. "T> 135" → "T> 134.5", "T> 134", "T> 133.5", "T> 133".',
            '     • Total under N: candidates may include higher under lines, e.g. "T< 0.5" → "T< 1.5", "T< 2.5".',
            '     • Exact score X:Y: candidates may include 1/X/2, CS X:Y, total bounds, individual team total bounds, BTTS Yes/No.',
            '     • For "T< 0.5" in soccer, candidates may include "CS 0:0", "IT1< 0.5", "IT2< 0.5", "BTTS No".',
            ' - Do not include opposite-direction candidates ("T> 2.5" must not suggest "T< 2.5").',
            ' - If you cannot match ANY allowed form with confidence ≥ 0.5, return canonical=null.',
            ' - DO NOT invent forms outside the allowed list. Common mistakes to avoid:',
            '     • Returning "Total Over 2.5" — must be "T> 2.5"',
            '     • Returning "Фора (-1.5)" — must be "H1 -1.5"',
            '     • Returning "1st half X" — must be "P1 X"',
        ].join('\n');
    }

    _userPrompt({ captionText, visionOutcomeRaw, sport, home, away, score, matchTime }) {
        const lines = [];
        lines.push(`Caption from partner: "${captionText || '(empty)'}"`);
        if (visionOutcomeRaw) lines.push(`Vision read off the screenshot: "${visionOutcomeRaw}"`);
        if (sport) lines.push(`Sport: ${sport}`);
        if (home) lines.push(`Home: ${home}`);
        if (away) lines.push(`Away: ${away}`);
        if (score) lines.push(`Current score: ${score}`);
        if (matchTime) lines.push(`Match time: ${matchTime}`);
        lines.push('');
        lines.push('Return one canonical from the allowed list, or null. JSON only.');
        return lines.join('\n');
    }

    _parseLLMResponse(text) {
        if (!text) return null;
        let body = String(text).trim();
        const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) body = fence[1].trim();
        const a = body.indexOf('{'); const b = body.lastIndexOf('}');
        if (a >= 0 && b > a) body = body.slice(a, b + 1);
        try {
            const o = JSON.parse(body);
            if (!('canonical' in o)) return null;
            return {
                canonical: typeof o.canonical === 'string' && o.canonical.trim() ? o.canonical.trim() : null,
                confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0,
                reason: typeof o.reason === 'string' ? o.reason : '',
                candidates: Array.isArray(o.candidates)
                    ? o.candidates.map((candidate) => normalizeCandidate(candidate)).filter(Boolean)
                    : [],
            };
        } catch (_) { return null; }
    }
}

module.exports = { OutcomeResolverLLM, ALLOWED_SIMPLE, ALLOWED_PATTERNS, isAllowedCanonical };
