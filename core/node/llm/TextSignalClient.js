/**
 * TextSignalClient — fallback parser when the partner sends a TEXT-ONLY
 * signal (no screenshot, common for the Supernova / Bet 2.0 Supernova
 * cluster). Same SignalDescriptor contract as VisionLLMClient so downstream
 * (confidence-gate → match-locator → outcome normalizer) stays unchanged.
 *
 * Real-world examples partners send:
 *   "Atlantis 2 / -1.5 second team / Football"
 *   "Binh Phuoc / -2.5 first team / Football / Vietnam / Live"
 *   "Реал / Барса / 1"
 *   "ПСЖ Арсенал X"
 *   "100 1.6"          (numeric signal — usually meaningless w/o screenshot)
 *
 * The text LLM (Claude / GPT-4o text mode) extracts:
 *   sport, home, away, league, outcomeRaw, isLive, intent, confidence, notes
 * and returns the SAME shape VisionLLMClient.parsePhoto returns, so the
 * orchestrator doesn't care which one ran.
 */
'use strict';

const { normalize: normalizeOutcome, detectStop, isUnsupportedNthGoalMarket } = require('./OutcomeNormalizer.js');

class TextSignalClient {
    /**
     * @param {Object} opts
     * @param {Object} opts.textClient  TextLLMClient (Anthropic/OpenAI text).
     * @param {Object} [opts.logger]
     */
    constructor({ textClient, logger } = {}) {
        if (!textClient) throw new Error('TextSignalClient requires textClient');
        this.textClient = textClient;
        this.logger = logger || console;
    }

    isReady() { return this.textClient && this.textClient.isReady && this.textClient.isReady(); }
    get providerName() { return `text-only:${this.textClient.providerName || 'unknown'}`; }
    get model() { return this.textClient.model || null; }

    /**
     * Same shape as VisionLLMClient.parsePhoto so it's a drop-in alternative.
     * @param {Object} input
     * @param {string} input.text         The full text (multi-line OK).
     * @returns {Promise<Object>}          SignalDescriptor (see VisionLLMClient).
     */
    async parseText({ text }) {
        const t0 = Date.now();
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return this._unclear('empty_text');
        }

        const deterministicSingle = this._tryDeterministicParse(trimmed, { allowMulti: false });
        if (deterministicSingle && deterministicSingle.confidence >= 0.85) {
            const ms = Date.now() - t0;
            const desc = this._withRaw(deterministicSingle, {
                provider: 'deterministic-text',
                model: 'telegram-text-rules',
                latencyMs: ms,
            });
            if (this.logger?.log) {
                this.logger.log(`🧠 Text parse [deterministic]: confidence=${desc.confidence} sport=${desc.sport} home=${desc.home} away=${desc.away} (${ms}ms)`);
            }
            return desc;
        }

        const system = this._systemPrompt();
        const user = `PARTNER TEXT-ONLY SIGNAL (each line is a separate message — concatenated):\n\n${trimmed}`;

        let raw;
        try {
            raw = await this.textClient.complete({ system, user, jsonOnly: true });
        } catch (e) {
            const deterministic = deterministicSingle || this._tryDeterministicParse(trimmed, { allowMulti: true });
            if (deterministic && deterministic.confidence >= 0.5) {
                const ms = Date.now() - t0;
                return this._withRaw({
                    ...deterministic,
                    notes: [deterministic.notes, `llm_error_fallback:${e.message?.slice(0, 100)}`]
                        .filter(Boolean)
                        .join('; '),
                }, {
                    provider: 'deterministic-text',
                    model: 'telegram-text-rules',
                    latencyMs: ms,
                    llmError: e.message?.slice(0, 200) || String(e).slice(0, 200),
                });
            }
            return this._unclear(`text_llm_error:${e.message?.slice(0, 120)}`);
        }
        const ms = Date.now() - t0;
        const desc = this._parseResponse(raw);
        if ((desc.intent === 'unclear' || desc.confidence < 0.5 || (!desc.home && !desc.away)) && deterministicSingle?.confidence >= 0.5) {
            return this._withRaw({
                ...deterministicSingle,
                notes: [deterministicSingle.notes, `llm_unclear_fallback:${desc.notes || 'unclear'}`]
                    .filter(Boolean)
                    .join('; '),
            }, {
                provider: 'deterministic-text',
                model: 'telegram-text-rules',
                latencyMs: ms,
                llmProvider: this.textClient.providerName,
                llmModel: this.textClient.model,
            });
        }
        desc.raw = { provider: this.textClient.providerName, model: this.textClient.model, latencyMs: ms };
        if (this.logger?.log) {
            this.logger.log(`🧠 Text parse [${this.textClient.model || 'unknown'}]: confidence=${desc.confidence} sport=${desc.sport} home=${desc.home} away=${desc.away} (${ms}ms)`);
        }
        return desc;
    }

    _unclear(reason) {
        return {
            sport: null, home: null, away: null, league: null,
            score: null, matchTime: null, isLive: null,
            outcomeRaw: null, intent: 'unclear',
            confidence: 0,
            notes: reason,
            raw: null,
            provider: this.providerName,
            model: this.model,
        };
    }

    _systemPrompt() {
        return [
            'You extract sport-betting signals from short Telegram text-only partner messages (no screenshot was sent).',
            'These messages are typically one or several short lines, e.g. team names + outcome + sport.',
            '',
            'Your job: identify sport, home/away team, league (if mentioned), outcome the partner is signalling, and live/prematch flag.',
            '',
            'Output STRICT JSON only (no prose, no markdown).',
            'For one signal, output:',
            '{',
            '  "sport": "soccer"|"basketball"|"tennis"|"volleyball"|"hockey"|"handball"|"esports"|null,',
            '  "home": string|null,',
            '  "away": string|null,',
            '  "league": string|null,',
            '  "score": null,',
            '  "matchTime": null,',
            '  "isLive": true|false|null,   // true/false only when explicitly marked; null when unknown',
            '  "outcomeRaw": string|null,   // outcome verbatim ("1", "ТБ 2.5", "-1.5 second team", "X")',
            '  "intent": "bet"|"stop"|"unclear",',
            '  "confidence": 0.0..1.0,',
            '  "notes": string',
            '}',
            '',
            'For two or more clearly independent signals in the grouped text, output instead:',
            '{',
            '  "intent": "multi",',
            '  "confidence": 0.0..1.0,',
            '  "notes": string,',
            '  "signals": [',
            '    { same fields as one signal, plus "sourceText": string }',
            '  ]',
            '}',
            '',
            'Rules:',
            ' - The input is a grouped burst from one chat/source. Treat it as ONE betting signal only when the lines are coherent for one match.',
            ' - If the grouped text contains multiple independent matches/bets and each is clear enough, return them in signals[]. Each sourceText must contain only the lines used for that signal.',
            ' - If the grouped text appears to contain multiple independent matches/bets but at least one cannot be separated confidently, do NOT merge them; return intent=unclear with confidence<=0.45 and explain the ambiguity in notes.',
            ' - Partner often writes the SECOND team\'s outcome with side hint, e.g. "-2.5 first team" → outcome on team 1 with handicap -2.5; "Atlantis 2" → bet on team 2 (away).',
            ' - "Live" or "В игре" anywhere → isLive=true. "Prematch"/"прематч" anywhere → isLive=false. If there is no explicit marker → isLive=null.',
            ' - Sport keyword: "Football"/"Футбол"=soccer, "Volleyball"=volleyball, "Hockey"=hockey, "Basketball"=basketball.',
            ' - Country tokens (Vietnam, England, Russia, etc.) → put in league.',
            ' - Partner outcome shorthand: "м" / "M" after a line means under/less; "б" / "B" means over/more. Examples: "56.5м" = Under 56.5, "56.5б" = Over 56.5, "Over4.5" = Over 4.5.',
            ' - "тс" means correct score: "1:3 тс" = correct score 1:3.',
            ' - "стоп"/"СТОП"/"отмена"/"не ставь" → intent=stop, everything else null.',
            ' - If only one team name is present, put it in home and leave away=null; keep intent=bet if outcome/sport are clear. The match locator can find the opponent from the bookmaker catalog.',
            ' - If you cannot extract any team or match hint at all → home/away=null, confidence<0.5, intent=unclear.',
            ' - confidence reflects YOUR uncertainty: short ambiguous texts ("100 1.6") = 0.0-0.3.',
        ].join('\n');
    }

    _parseResponse(text) {
        if (!text) return this._unclear('empty_response');
        let body = String(text).trim();
        const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) body = fence[1].trim();
        const a = body.indexOf('{'); const b = body.lastIndexOf('}');
        if (a >= 0 && b > a) body = body.slice(a, b + 1);
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (_) { return this._unclear('non_json_response'); }
        if (Array.isArray(parsed.signals) && parsed.signals.length > 0) {
            const signals = parsed.signals
                .map((signal, index) => this._coerceSignalDescriptor(signal, { signalIndex: index + 1 }))
                .filter((signal) => signal.intent !== 'unclear' || signal.home || signal.away || signal.outcomeRaw);
            if (signals.length === 1) {
                return signals[0];
            }
            if (signals.length > 1) {
                return {
                    sport: null,
                    home: null,
                    away: null,
                    league: null,
                    score: null,
                    matchTime: null,
                    isLive: signals.some((signal) => signal.isLive === true)
                        ? true
                        : signals.some((signal) => signal.isLive === false)
                            ? false
                            : null,
                    outcomeRaw: null,
                    intent: 'multi',
                    confidence: Math.min(...signals.map((signal) => Number(signal.confidence) || 0)),
                    notes: typeof parsed.notes === 'string' ? parsed.notes : `multi_signal:${signals.length}`,
                    signals,
                    raw: null,
                    provider: this.providerName,
                    model: this.model,
                };
            }
        }
        return this._coerceSignalDescriptor(parsed);
    }

    _coerceSignalDescriptor(parsed = {}, extra = {}) {
        const allowedSports = new Set(['soccer','football','basketball','tennis','volleyball','hockey','handball','esports']);
        let sport = parsed.sport ? String(parsed.sport).toLowerCase() : null;
        if (sport === 'football') sport = 'soccer';
        if (sport && !allowedSports.has(sport)) sport = null;
        return {
            sport,
            home: typeof parsed.home === 'string' && parsed.home.trim() ? parsed.home.trim() : null,
            away: typeof parsed.away === 'string' && parsed.away.trim() ? parsed.away.trim() : null,
            league: typeof parsed.league === 'string' && parsed.league.trim() ? parsed.league.trim() : null,
            score: null,
            matchTime: null,
            isLive: parsed.isLive === true ? true : parsed.isLive === false ? false : null,
            outcomeRaw: typeof parsed.outcomeRaw === 'string' && parsed.outcomeRaw.trim() ? parsed.outcomeRaw.trim() : null,
            intent: ['bet', 'stop', 'unclear', 'multi'].includes(parsed.intent) ? parsed.intent : 'unclear',
            confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
            notes: typeof parsed.notes === 'string' ? parsed.notes : '',
            sourceText: typeof parsed.sourceText === 'string' && parsed.sourceText.trim() ? parsed.sourceText.trim() : null,
            raw: null,
            provider: this.providerName,
            model: this.model,
            ...extra,
        };
    }

    _withRaw(desc, raw) {
        const provider = `text-only:${raw.provider || 'deterministic-text'}`;
        const model = raw.model || 'telegram-text-rules';
        return {
            ...desc,
            signals: Array.isArray(desc.signals)
                ? desc.signals.map((signal) => ({
                    ...signal,
                    raw,
                    provider,
                    model,
                }))
                : desc.signals,
            raw,
            provider,
            model,
        };
    }

    _tryDeterministicParse(text, { allowMulti = false } = {}) {
        const groups = this._splitLineGroups(text);
        if (groups.length > 1) {
            const combinedLines = groups.flatMap((group) => group.lines);
            const combined = this._parseLineGroup(combinedLines, { sourceText: text });
            const combinedMatchLines = this._countMatchLines(combinedLines);
            if (!allowMulti) {
                return combinedMatchLines <= 1 ? combined : null;
            }
            const signals = groups
                .map((group, index) => this._parseLineGroup(group.lines, {
                    sourceText: group.sourceText,
                    signalIndex: index + 1,
                }))
                .filter(Boolean);
            if (signals.length === groups.length && signals.length > 1 && signals.every((signal) => signal.confidence >= 0.5)) {
                return {
                    sport: null,
                    home: null,
                    away: null,
                    league: null,
                    score: null,
                    matchTime: null,
                    isLive: signals.some((signal) => signal.isLive === true)
                        ? true
                        : signals.some((signal) => signal.isLive === false)
                            ? false
                            : null,
                    outcomeRaw: null,
                    intent: 'multi',
                    confidence: Math.min(...signals.map((signal) => signal.confidence)),
                    notes: `deterministic_multi:${signals.length}`,
                    signals,
                };
            }
            return combinedMatchLines <= 1 ? combined : null;
        }
        return this._parseLineGroup(groups[0]?.lines || [], { sourceText: groups[0]?.sourceText || text });
    }

    _splitLineGroups(text) {
        const groups = [];
        let current = [];
        for (const rawLine of String(text || '').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) {
                if (current.length > 0) {
                    groups.push(this._makeLineGroup(current));
                    current = [];
                }
                continue;
            }
            current.push(line);
        }
        if (current.length > 0) groups.push(this._makeLineGroup(current));
        return groups.length ? groups : [this._makeLineGroup([])];
    }

    _makeLineGroup(lines) {
        return {
            lines,
            sourceText: lines.join('\n'),
        };
    }

    _parseLineGroup(lines, { sourceText = null, signalIndex = null } = {}) {
        const cleanLines = (lines || [])
            .map((line) => String(line || '').trim())
            .filter(Boolean);
        if (cleanLines.length === 0) return null;

        if (cleanLines.some((line) => detectStop(line))) {
            return this._coerceSignalDescriptor({
                intent: 'stop',
                confidence: 1,
                notes: 'deterministic_stop',
                sourceText: sourceText || cleanLines.join('\n'),
            }, signalIndex ? { signalIndex } : {});
        }

        const used = new Set();
        const sportInfo = this._extractSport(cleanLines);
        if (sportInfo.index >= 0) used.add(sportInfo.index);

        const modeInfo = this._extractMode(cleanLines);
        if (modeInfo.index >= 0) used.add(modeInfo.index);

        let matchInfo = null;
        for (let i = 0; i < cleanLines.length; i += 1) {
            const split = this._splitMatchLine(cleanLines[i]);
            if (split) {
                matchInfo = { ...split, index: i };
                used.add(i);
                break;
            }
        }

        let outcomeInfo = null;
        for (let i = 0; i < cleanLines.length; i += 1) {
            if (used.has(i)) continue;
            if (this._looksLikeOutcome(cleanLines[i], sportInfo.sport)) {
                outcomeInfo = { text: cleanLines[i], index: i };
                used.add(i);
                break;
            }
        }

        let home = matchInfo?.home || null;
        let away = matchInfo?.away || null;
        if (!home && !away) {
            const singleTeamIndex = cleanLines.findIndex((line, index) => (
                !used.has(index)
                && !this._looksLikeOutcome(line, sportInfo.sport)
                && !this._lineIsMode(line)
                && !this._lineHasSport(line)
                && /[\p{L}]/u.test(line)
            ));
            if (singleTeamIndex >= 0) {
                home = cleanLines[singleTeamIndex];
                used.add(singleTeamIndex);
            }
        }

        const leagueParts = [];
        if (sportInfo.leagueRemainder) leagueParts.push(sportInfo.leagueRemainder);
        for (let i = 0; i < cleanLines.length; i += 1) {
            if (used.has(i)) continue;
            const line = cleanLines[i];
            if (!/[\p{L}]/u.test(line)) continue;
            if (this._looksLikeOutcome(line, sportInfo.sport) || this._lineIsMode(line)) continue;
            const embeddedSport = this._sportFromLine(line);
            if (embeddedSport.sport) {
                if (embeddedSport.leagueRemainder) leagueParts.push(embeddedSport.leagueRemainder);
                continue;
            }
            leagueParts.push(line);
        }
        const league = leagueParts.length ? leagueParts.join(' ').replace(/\s+/g, ' ').trim() : null;

        const outcomeRaw = outcomeInfo?.text || null;
        if (!outcomeRaw || (!home && !away)) return null;

        let confidence = 0.45;
        if (home && away && outcomeRaw && sportInfo.sport) confidence = 0.93;
        else if (home && away && outcomeRaw) confidence = 0.86;
        else if ((home || away) && outcomeRaw && sportInfo.sport) confidence = 0.62;

        return this._coerceSignalDescriptor({
            sport: sportInfo.sport,
            home,
            away,
            league,
            score: null,
            matchTime: null,
            isLive: modeInfo.isLive,
            outcomeRaw,
            intent: confidence >= 0.5 ? 'bet' : 'unclear',
            confidence,
            notes: 'deterministic_text_parse',
            sourceText: sourceText || cleanLines.join('\n'),
        }, signalIndex ? { signalIndex } : {});
    }

    _extractSport(lines) {
        for (let i = 0; i < lines.length; i += 1) {
            const found = this._sportFromLine(lines[i]);
            if (found.sport) return { ...found, index: i };
        }
        return { sport: null, leagueRemainder: null, index: -1 };
    }

    _sportFromLine(line) {
        const raw = String(line || '').trim();
        const normalized = raw.toLowerCase().replace(/ё/g, 'е');
        const patterns = [
            { re: /(?:^|[\s,/|;:-])(?:football|soccer|футбол)(?=$|[\s,/|;:-])/i, sport: 'soccer' },
            { re: /(?:^|[\s,/|;:-])(?:basketball|баскетбол)(?=$|[\s,/|;:-])/i, sport: 'basketball' },
            { re: /(?:^|[\s,/|;:-])(?:tennis|теннис)(?=$|[\s,/|;:-])/i, sport: 'tennis' },
            { re: /(?:^|[\s,/|;:-])(?:volleyball|волейбол)(?=$|[\s,/|;:-])/i, sport: 'volleyball' },
            { re: /(?:^|[\s,/|;:-])(?:hockey|хоккей)(?=$|[\s,/|;:-])/i, sport: 'hockey' },
            { re: /(?:^|[\s,/|;:-])(?:handball|гандбол)(?=$|[\s,/|;:-])/i, sport: 'handball' },
            { re: /(?:^|[\s,/|;:-])(?:esports|e-?sports|киберспорт)(?=$|[\s,/|;:-])/i, sport: 'esports' },
        ];
        for (const { re, sport } of patterns) {
            const match = normalized.match(re);
            if (!match) continue;
            const sportToken = match[0].trim();
            const leagueRemainder = raw
                .replace(new RegExp(sportToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ')
                .replace(/(?:^|[\s,/|;:-])(?:live|prematch|pre-match|лайв|прематч|в игре)(?=$|[\s,/|;:-])/ig, ' ')
                .replace(/[|,/]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim() || null;
            return { sport, leagueRemainder };
        }
        return { sport: null, leagueRemainder: null };
    }

    _lineHasSport(line) {
        return Boolean(this._sportFromLine(line).sport);
    }

    _extractMode(lines) {
        for (let i = 0; i < lines.length; i += 1) {
            if (/(?:^|[\s,/|;:-])(?:live|лайв|в игре)(?=$|[\s,/|;:-])/i.test(lines[i])) return { isLive: true, index: i };
            if (/(?:^|[\s,/|;:-])(?:prematch|pre-match|прематч)(?=$|[\s,/|;:-])/i.test(lines[i])) return { isLive: false, index: i };
        }
        return { isLive: null, index: -1 };
    }

    _lineIsMode(line) {
        return /(?:^|[\s,/|;:-])(?:live|лайв|в игре|prematch|pre-match|прематч)(?=$|[\s,/|;:-])/i.test(String(line || ''));
    }

    _splitMatchLine(line) {
        const raw = String(line || '').trim();
        if (!raw || this._looksLikeOutcome(raw, null) || this._lineHasSport(raw)) return null;
        const separators = [
            /\s+vs\.?\s+/i,
            /\s+v\.?\s+/i,
            /\s+x\s+/i,
            /\s+[-–—]\s+/,
            /\s+\/\s+/,
            /\s+\|\s+/,
        ];
        for (const sep of separators) {
            const parts = raw.split(sep).map((part) => part.trim()).filter(Boolean);
            if (parts.length !== 2) continue;
            const [home, away] = parts;
            if (this._looksLikeTeamName(home) && this._looksLikeTeamName(away)) {
                return { home, away };
            }
        }
        return null;
    }

    _looksLikeTeamName(value) {
        const text = String(value || '').trim();
        if (!text || text.length < 2) return false;
        if (!/[\p{L}]/u.test(text)) return false;
        if (this._lineIsMode(text) || this._lineHasSport(text) || this._looksLikeOutcome(text, null)) return false;
        return true;
    }

    _looksLikeOutcome(line, sport) {
        const text = String(line || '').trim();
        if (!text) return false;
        const s = text.toLowerCase();
        if (detectStop(text) || isUnsupportedNthGoalMarket(text)) return true;
        if (/^(?:over|under|тб|тм|t[<>]|[тt][<>])\s*\(?\s*\d/i.test(s)) return true;
        if (/^\d+(?:[.,]\d+|\s+\d)?\s*[бмbm]$/i.test(s)) return true;
        if (/^(?:\d+\s+)?(?:четверть|quarter|тайм|half|сет|set)(?:\s|$).*(?:\d|[12xх])/i.test(s)) return true;
        if (/^\d+\s*[:\-]\s*\d+(?:\s*тс)?$/i.test(s)) return true;
        if (/^[12xх]$/i.test(s)) return true;
        if (/^(?:w|win|[пp])\s*[12]$/i.test(s)) return true;
        if (/^(?:1[xх]|[xх]2|12)$/i.test(s)) return true;
        if (/^(?:dnb|без\s+ничьи|с\s+возвратом)/i.test(s)) return true;
        if (/^(?:btts|both\s+to\s+score|обе\s+забьют|обе\s+не\s+забьют)/i.test(s)) return true;
        if (/^(?:ит|it)\s*[12]\s*(?:[><]|тб|тм|over|under|[бмbm])\s*\d/i.test(s)) return true;
        if (/^[+-]?\s*\d+(?:[.,]\d+|\s+\d)?\s+(?:first|second|home|away|первая|вторая|т1|т2)/i.test(s)) return true;
        if (/^(?:ф|h|ah)\s*[12]\s*[+-]?\s*\d/i.test(s)) return true;
        if (/^[+-]\s*\d+(?:[.,]\d+|\s+\d)?$/.test(s)) return true;
        if (/^s[1-5]\s+[12]$/i.test(s)) return true;

        const normalized = normalizeOutcome(null, text, sport);
        return normalized.intent === 'stop'
            || Boolean(normalized.outcome && normalized.outcome.canonical !== normalized.outcome.original);
    }

    _countMatchLines(lines) {
        return (lines || []).filter((line) => this._splitMatchLine(line)).length;
    }
}

module.exports = { TextSignalClient };
