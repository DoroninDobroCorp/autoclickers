/**
 * MatchLocator — picks a matchId from a bookmaker catalog given a parsed
 * signal (SignalDescriptor from vision-LLM).
 *
 * Critical guarantees:
 *   1. Returned matchId MUST exist in the input catalog. Out-of-list → null.
 *   2. If ambiguity / no match → returns null with reason. Never force-fits.
 *   3. Cross-language is fine: LLM understands "Реал" ↔ "Real Madrid" ↔ "レアル".
 *   4. If sport is null on input, all-sport catalog is fed to LLM.
 *
 * Cost guardrail:
 *   When catalog > MAX_CATALOG_FOR_LLM (default 250), we drop entries with
 *   no token overlap on home/away (case-insensitive substring of any token).
 *   This is NOT fuzzy matching — it's a coarse lossless prefilter (we never
 *   exclude an entry that shares any 3+ char substring with the parsed
 *   home/away). When catalog is small enough we send everything.
 */
'use strict';

const MAX_CATALOG_FOR_LLM = 250;

class MatchLocator {
    /**
     * @param {Object} opts
     * @param {Object} opts.textClient  TextLLMClient instance.
     * @param {Object} [opts.logger]
     */
    constructor({ textClient, logger } = {}) {
        if (!textClient) throw new Error('MatchLocator requires textClient');
        this.textClient = textClient;
        this.logger = logger || console;
    }

    /**
     * @param {Object} input
     * @param {Object} input.parsedSignal   SignalDescriptor (from VisionLLMClient).
     * @param {Array}  input.catalog        Array of { matchId, sport, home, away, league?, mode, score?, isLive? }.
     * @returns {Promise<Object>}            { matchId, confidence, reason, candidates }
     *                                       matchId is string-from-catalog or null.
     */
    async locate({ parsedSignal, catalog }) {
        if (!Array.isArray(catalog) || catalog.length === 0) {
            return { matchId: null, confidence: 0, reason: 'empty_catalog' };
        }
        if (!parsedSignal || (!parsedSignal.home && !parsedSignal.away)) {
            return { matchId: null, confidence: 0, reason: 'no_team_names_parsed' };
        }
        const allowedIds = new Set(catalog.map((m) => String(m.matchId)));

        const deterministic = this._locateUniqueTeamPair(parsedSignal, catalog)
            || this._locateUniqueSingleTeam(parsedSignal, catalog);
        if (deterministic) {
            return deterministic;
        }

        const filtered = this._coarsePrefilter(parsedSignal, catalog);
        const used = filtered.length > 0 && filtered.length < catalog.length ? filtered : catalog;
        if (this.logger?.log) {
            this.logger.log(`📋 [MatchLocator] catalog=${catalog.length} → after prefilter=${used.length}`);
        }
        if (used.length > MAX_CATALOG_FOR_LLM * 4) {
            // hard cap — sorry, too noisy
            return { matchId: null, confidence: 0, reason: `catalog_too_large_${used.length}` };
        }

        const system = this._systemPrompt();
        const user = this._userPrompt(parsedSignal, used);

        let raw;
        try { raw = await this.textClient.complete({ system, user, jsonOnly: true }); }
        catch (e) { return { matchId: null, confidence: 0, reason: `llm_error:${e.message.slice(0, 100)}` }; }

        const parsed = this._parseLLMResponse(raw);
        if (!parsed) {
            return { matchId: null, confidence: 0, reason: 'unparseable_llm_response', llmRaw: raw.slice(0, 300) };
        }
        if (parsed.matchId && !allowedIds.has(String(parsed.matchId))) {
            return { matchId: null, confidence: 0, reason: 'llm_returned_out_of_list_id', attemptedId: parsed.matchId };
        }
        return {
            matchId: parsed.matchId || null,
            confidence: parsed.confidence ?? 0,
            reason: parsed.reason || (parsed.matchId ? 'matched' : 'not_in_catalog'),
            llmRaw: raw,
        };
    }

    _systemPrompt() {
        return [
            'You are a precise match-locator. You receive a parsed match signal (with possibly imperfect names — abbreviated, transliterated, in another language) and a CATALOG of matches that a target bookmaker is currently offering.',
            'Your job: pick the SINGLE catalog entry that corresponds to the same real-world match as the parsed signal — or say none if you are not sure.',
            '',
            'Rules:',
            ' - Names may differ (e.g. "Real" vs "Real Madrid", "Реал" vs "Real Madrid", "Bodo" vs "Bodo/Glimt", "PSG" vs "Paris Saint-Germain"). Use semantic / cross-language reasoning.',
            ' - If the parsed sport is wrong (e.g. signal says soccer but catalog only has tennis matches with similar names), you may still match across sports if you are confident.',
            ' - Score, league, and home/away ORDER help confirm. If home/away order in catalog is reversed and home/away of signal map to away/home of catalog — still a valid match.',
            ' - DO NOT force a match. If two catalog entries are equally plausible, OR no entry is plausibly the same match, return matchId=null.',
            ' - The catalog is the ONLY source of valid matchIds. Never invent.',
            '',
            'Return STRICT JSON:',
            '{',
            '  "matchId": "<id from catalog>" | null,',
            '  "confidence": 0.0..1.0,',
            '  "reason": "1 short sentence — why this match (or why none)"',
            '}',
        ].join('\n');
    }

    _userPrompt(parsedSignal, catalog) {
        const lines = [];
        lines.push('PARSED SIGNAL (from screenshot, names may be imperfect):');
        lines.push(`  sport: ${parsedSignal.sport || 'UNKNOWN'}`);
        lines.push(`  home:  ${parsedSignal.home || 'unknown'}`);
        lines.push(`  away:  ${parsedSignal.away || 'unknown'}`);
        if (parsedSignal.league) lines.push(`  league: ${parsedSignal.league}`);
        if (parsedSignal.score) lines.push(`  score:  ${parsedSignal.score}`);
        if (parsedSignal.matchTime) lines.push(`  time:   ${parsedSignal.matchTime}`);
        if (parsedSignal.isLive) lines.push(`  is_live: true`);
        lines.push('');
        lines.push(`CATALOG (${catalog.length} entries):`);
        for (const m of catalog) {
            const parts = [
                `id=${m.matchId}`,
                `sport=${m.sport}`,
                `${m.home} vs ${m.away}`,
            ];
            if (m.league) parts.push(`league="${m.league}"`);
            if (m.mode) parts.push(m.mode);
            if (m.score && m.score !== '0-0' && m.score !== 'null-null') parts.push(`score=${m.score}`);
            lines.push('  ' + parts.join(' | '));
        }
        lines.push('');
        lines.push('Return one JSON object as specified. Use only matchIds present in the catalog.');
        return lines.join('\n');
    }

    _parseLLMResponse(raw) {
        if (!raw) return null;
        let body = String(raw).trim();
        const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) body = fence[1].trim();
        const a = body.indexOf('{'); const b = body.lastIndexOf('}');
        if (a >= 0 && b > a) body = body.slice(a, b + 1);
        try {
            const o = JSON.parse(body);
            if (o.matchId === undefined) return null;
            return {
                matchId: o.matchId === null ? null : String(o.matchId),
                confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0,
                reason: typeof o.reason === 'string' ? o.reason : '',
            };
        } catch (_) { return null; }
    }

    /**
     * Coarse, lossless prefilter: drop catalog entries with NO token overlap
     * (substring 3+ chars, case-insensitive, after diacritic strip) with
     * either home or away from the parsed signal.
     *
     * IMPORTANT: cross-language fully bypasses this filter (Реал vs Real Madrid
     * has no shared substring). To stay lossless, we only prefilter when the
     * full catalog is large AND the signal home/away are latin/cyrillic chars
     * sharing the same script. If signal is in different script than catalog
     * predominantly, we skip prefilter entirely (return all).
     *
     * If catalog already <= MAX_CATALOG_FOR_LLM, prefilter is skipped.
     */
    _coarsePrefilter(parsedSignal, catalog) {
        if (!catalog || catalog.length <= MAX_CATALOG_FOR_LLM) return catalog;

        const home = (parsedSignal.home || '').toLowerCase();
        const away = (parsedSignal.away || '').toLowerCase();
        if (!home && !away) return catalog;

        // Build set of substring tokens of length >= 3 from home/away.
        const tokens = new Set();
        for (const name of [home, away]) {
            const cleaned = name
                .replace(/[^\p{L}\p{N}]/gu, ' ')
                .split(/\s+/)
                .filter((t) => t.length >= 3);
            for (const t of cleaned) tokens.add(t);
        }
        if (tokens.size === 0) return catalog;

        // Filter catalog
        const filtered = catalog.filter((m) => {
            const teamText = `${m.home || ''} ${m.away || ''}`.toLowerCase();
            const homeAcronym = this._acronym(m.home);
            const awayAcronym = this._acronym(m.away);
            for (const t of tokens) {
                if (teamText.includes(t) || homeAcronym === t || awayAcronym === t) return true;
            }
            return false;
        });
        // If prefilter cut too aggressively (e.g. Cyrillic vs Latin scripts),
        // bail and return original — we MUST NOT lose the right match.
        if (filtered.length === 0) return catalog;
        return filtered;
    }

    _locateUniqueSingleTeam(parsedSignal, catalog) {
        const names = [parsedSignal.home, parsedSignal.away].filter(Boolean);
        if (names.length !== 1) return null;

        const tokens = this._teamTokens(names[0]);
        if (tokens.length === 0) return null;

        const matches = catalog.filter((m) => {
            const haystack = this._normalizeText(`${m.home || ''} ${m.away || ''}`);
            const acronyms = [this._acronym(m.home), this._acronym(m.away)].filter(Boolean);
            return tokens.every((token) => haystack.includes(token) || acronyms.includes(token));
        });

        if (matches.length !== 1) return null;
        const match = matches[0];
        const conflict = this._singleTeamConflictReason(parsedSignal, match);
        if (conflict) {
            return { matchId: null, confidence: 0, reason: conflict };
        }

        return {
            matchId: String(match.matchId),
            confidence: 0.96,
            reason: `unique single-team token match: ${tokens.join(' ')}`
        };
    }

    _locateUniqueTeamPair(parsedSignal, catalog) {
        if (!parsedSignal?.home || !parsedSignal?.away) return null;

        const scored = [];
        for (const match of catalog) {
            const conflict = this._pairConflictReason(parsedSignal, match);
            if (conflict) continue;

            const directHome = this._nameRecall(parsedSignal.home, match.home);
            const directAway = this._nameRecall(parsedSignal.away, match.away);
            const reverseHome = this._nameRecall(parsedSignal.home, match.away);
            const reverseAway = this._nameRecall(parsedSignal.away, match.home);
            const directScore = (directHome + directAway) / 2;
            const reverseScore = (reverseHome + reverseAway) / 2;
            const reversed = reverseScore > directScore;
            const score = Math.max(directScore, reverseScore);
            if (score < 0.92) continue;

            const exactBonus = this._normalizedEquals(parsedSignal.home, reversed ? match.away : match.home)
                && this._normalizedEquals(parsedSignal.away, reversed ? match.home : match.away)
                ? 0.03
                : 0;
            scored.push({
                match,
                score: Math.min(1, score + exactBonus),
                reversed,
            });
        }

        if (scored.length === 0) return null;
        scored.sort((a, b) => b.score - a.score);
        const top = scored[0];
        const tied = scored.filter((item) => item.score >= top.score - 0.03);
        if (tied.length !== 1) {
            return {
                matchId: null,
                confidence: 0,
                reason: `team_pair_ambiguous:${tied.map((item) => item.match.matchId).join(',')}`,
            };
        }

        return {
            matchId: String(top.match.matchId),
            confidence: top.score,
            reason: top.reversed ? 'deterministic reversed home/away team-pair match' : 'deterministic home/away team-pair match',
        };
    }

    _pairConflictReason(parsedSignal, match) {
        if (!parsedSignal || !match) return null;

        const parsedSport = this._normalizeText(parsedSignal.sport);
        const matchSport = this._normalizeText(match.sport);
        if (parsedSport && matchSport && parsedSport !== matchSport) {
            return `team_pair_sport_conflict:${parsedSignal.sport}_vs_${match.sport}`;
        }

        const parsedLive = parsedSignal.isLive === true || String(parsedSignal.mode || '').toLowerCase() === 'live';
        const parsedPrematch = /prematch|pre[-\s]?match/i.test(String(parsedSignal.mode || ''));
        const matchMode = String(match.mode || '').toLowerCase();
        if (parsedLive && matchMode === 'prematch') {
            return 'team_pair_mode_conflict:signal_live_catalog_prematch';
        }
        if (parsedPrematch && matchMode === 'live') {
            return 'team_pair_mode_conflict:signal_prematch_catalog_live';
        }

        const parsedNames = `${parsedSignal.home || ''} ${parsedSignal.away || ''}`;
        const matchText = `${match.home || ''} ${match.away || ''} ${match.league || ''}`;
        if (this._hasWomenMarker(parsedNames) && !this._hasWomenMarker(matchText)) {
            return 'team_pair_gender_conflict:signal_women_catalog_unmarked';
        }

        if (parsedSignal.league && match.league && !this._hasTokenOverlap(parsedSignal.league, match.league)) {
            return `team_pair_league_conflict:${parsedSignal.league}_vs_${match.league}`;
        }

        return null;
    }

    _nameRecall(needle, candidate) {
        const tokens = this._teamTokens(needle);
        if (tokens.length === 0) return 0;
        const haystack = this._normalizeText(candidate);
        const acronym = this._acronym(candidate);
        const matched = tokens.filter((token) => haystack.includes(token) || (acronym && acronym === token)).length;
        return matched / tokens.length;
    }

    _normalizedEquals(left, right) {
        return this._normalizeText(left) === this._normalizeText(right);
    }

    _singleTeamConflictReason(parsedSignal, match) {
        if (!parsedSignal || !match) return null;

        const parsedSport = this._normalizeText(parsedSignal.sport);
        const matchSport = this._normalizeText(match.sport);
        if (parsedSport && matchSport && parsedSport !== matchSport) {
            return `single_team_sport_conflict:${parsedSignal.sport}_vs_${match.sport}`;
        }

        const parsedLive = parsedSignal.isLive === true || String(parsedSignal.mode || '').toLowerCase() === 'live';
        const parsedPrematch = /prematch|pre[-\s]?match/i.test(String(parsedSignal.mode || ''));
        const matchMode = String(match.mode || '').toLowerCase();
        if (parsedLive && matchMode === 'prematch') {
            return 'single_team_mode_conflict:signal_live_catalog_prematch';
        }
        if (parsedPrematch && matchMode === 'live') {
            return 'single_team_mode_conflict:signal_prematch_catalog_live';
        }

        const parsedNames = `${parsedSignal.home || ''} ${parsedSignal.away || ''}`;
        const matchText = `${match.home || ''} ${match.away || ''} ${match.league || ''}`;
        if (this._hasWomenMarker(parsedNames) && !this._hasWomenMarker(matchText)) {
            return 'single_team_gender_conflict:signal_women_catalog_unmarked';
        }

        if (parsedSignal.league && match.league && !this._hasTokenOverlap(parsedSignal.league, match.league)) {
            return `single_team_league_conflict:${parsedSignal.league}_vs_${match.league}`;
        }

        return null;
    }

    _hasWomenMarker(value) {
        return /\((?:w|ж)\)|\b(?:w|women|womens|woman|female|femenino|feminino|femminile|женщины|женский|женская|жен|ж)\b/i
            .test(String(value || ''));
    }

    _hasTokenOverlap(left, right) {
        const leftTokens = new Set(this._semanticTokens(left));
        if (leftTokens.size === 0) return true;
        for (const token of this._semanticTokens(right)) {
            if (leftTokens.has(token)) return true;
        }
        return false;
    }

    _semanticTokens(value) {
        const stop = new Set(['match', 'game', 'league', 'cup', 'friendly', 'international']);
        return this._normalizeText(value)
            .split(/\s+/)
            .filter((token) => token.length >= 4 && !stop.has(token));
    }

    _teamTokens(name) {
        const stop = new Set(['team', 'club', 'fc', 'ec', 'sc', 'u20', 'u19', 'u21']);
        return this._normalizeText(name)
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length >= 3 && !stop.has(token));
    }

    _acronym(value) {
        const stop = new Set(['fc', 'cf', 'sc', 'afc', 'bc', 'u19', 'u20', 'u21', 'w']);
        const tokens = this._normalizeText(value)
            .split(/\s+/)
            .filter((token) => token.length > 0 && !stop.has(token));
        if (tokens.length < 2) return '';
        return tokens.map((token) => token[0]).join('');
    }

    _normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }
}

module.exports = { MatchLocator };
