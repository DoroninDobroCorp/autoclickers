/**
 * TelegramSignalParserV2 — v2 signal pipeline orchestrator.
 *
 * Replaces the old TelegramSignalParser (Tesseract + DeepSeek + fuzzy retriever).
 *
 * Flow:
 *   1. visionClient.parsePhoto(imagePath, caption) → SignalDescriptor
 *   2. Confidence gate:
 *        intent='stop'         → return { state: 'stop' }
 *        confidence < lowGate  → return { state: 'rejected_low_confidence' }
 *        else                   → continue
 *   3. adapter.getCatalog(parsedSignal.sport)  // sport=null → all sports
 *   4. matchLocator.locate({ parsedSignal, catalog }) → { matchId or null }
 *      If matchId is null               → { state: 'match_not_found' }
 *   5. OutcomeNormalizer.normalize(outcomeRaw, caption, sport) →
 *      either { intent: 'stop' } (caption STOP overrides) or canonical outcome
 *   6. Return { state: 'ready', sport, home, away, league, matchId, outcome, ... }
 *
 * The result is consumed by TelegramPollingIngress → BaseBettor → BetProcessor.
 */
'use strict';

const { normalize: normalizeOutcome, isUnsupportedNthGoalMarket } = require('../llm/OutcomeNormalizer.js');
const { isAllowedCanonical } = require('../llm/OutcomeResolverLLM.js');
const { canonicalizeIntent } = require('./CrossMarketOutcomeMapper.js');

const DEFAULT_LOW_CONF_GATE = 0.5;
const DEFAULT_HIGH_CONF_GATE = 0.85;

class TelegramSignalParserV2 {
    /**
     * @param {Object} opts
     * @param {Object} opts.visionClient    VisionLLMClient
     * @param {Object} opts.matchLocator    MatchLocator
     * @param {Object} opts.adapter         BookmakerAdapter
     * @param {Object} [opts.textSignalClient]  TextSignalClient (used when no
     *                                          screenshot but caption present —
     *                                          common in Supernova cluster).
     * @param {Object} [opts.outcomeResolver]   OutcomeResolverLLM — fallback
     *                                          when regex normalizer cannot
     *                                          map an ambiguous caption.
     * @param {number} [opts.lowConfGate]   Below this → reject signal entirely.
     * @param {number} [opts.highConfGate]  Below this AND ≥ lowConfGate → alert (no bet).
     * @param {Object} [opts.logger]
     */
    constructor({ visionClient, matchLocator, adapter, textSignalClient, outcomeResolver, lowConfGate, highConfGate, minResolvedConfidence, logger } = {}) {
        if (!visionClient) throw new Error('TelegramSignalParserV2 requires visionClient');
        if (!matchLocator) throw new Error('TelegramSignalParserV2 requires matchLocator');
        if (!adapter) throw new Error('TelegramSignalParserV2 requires adapter');
        this.visionClient = visionClient;
        this.matchLocator = matchLocator;
        this.adapter = adapter;
        this.textSignalClient = textSignalClient || null;
        this.outcomeResolver = outcomeResolver || null;
        this.lowConfGate = typeof lowConfGate === 'number' ? lowConfGate : DEFAULT_LOW_CONF_GATE;
        this.highConfGate = typeof highConfGate === 'number' ? highConfGate : DEFAULT_HIGH_CONF_GATE;
        this.minResolvedConfidence = typeof minResolvedConfidence === 'number' ? minResolvedConfidence : 0.65;
        this.logger = logger || console;
    }

    /**
     * @param {Object} input
     * @param {string} input.imagePath          Local image path.
     * @param {string} [input.caption]          Caption text.
     * @param {string} [input.activationCode]   Telegram code linking this signal.
     * @param {Object} [input.hint]             Vision hint (e.g. { language: 'ru' }).
     * @returns {Promise<Object>}                Signal record (see Signal States).
     *
     * Signal States (signal.state values):
     *   'stop'                       → user requested cancel
     *   'rejected_low_confidence'    → vision didn't read screen well, drop
     *   'alert_review'               → confidence in alert band, save not bet
     *   'match_not_found'            → bookmaker doesn't trade this match
     *   'ready'                      → all good, proceed to bet
     */
    async parseSignal({ imagePath, caption, activationCode, hint, preparsedSignal = null, multiIndex = null, multiTotal = null } = {}) {
        const t0 = Date.now();
        const effectiveCaption = String(caption || '').trim();
        const audit = {
            kind: 'tg_signal_audit',
            ts: new Date(t0).toISOString(),
            activationCode: activationCode || null,
            multiIndex,
            multiTotal,
            input: {
                imagePath: imagePath || null,
                caption: effectiveCaption || null,
            },
            vision: null,
            confidenceGate: null,
            catalog: null,
            matchLocator: null,
            outcomeNormalizer: null,
            finalState: null,
            durationMs: null,
        };
        const writeAudit = (state) => {
            audit.finalState = state;
            audit.durationMs = Date.now() - t0;
            // single-line JSON for log scanning (replay tool reads these).
            try { this.logger?.log?.(`📝 [audit] ${JSON.stringify(audit)}`); }
            catch (_) { /* never fail signal flow on audit error */ }
        };

        let parsed;
        try {
            if (preparsedSignal) {
                parsed = { ...preparsedSignal };
                audit.input.mode = 'text-only:multi-child';
            } else if (imagePath) {
                // Vision branch — partner sent a screenshot.
                parsed = await this.visionClient.parsePhoto({ imagePath, caption: effectiveCaption, hint });
                audit.input.mode = 'vision';
            } else if (effectiveCaption && this.textSignalClient && this.textSignalClient.isReady()) {
                // Text-only branch — partner sent caption / multi-line text without
                // any screenshot (common in Supernova cluster).
                parsed = await this.textSignalClient.parseText({ text: effectiveCaption });
                audit.input.mode = 'text-only';
            } else {
                audit.vision = { error: imagePath ? null : 'no_image_no_text_or_no_text_client' };
                writeAudit('rejected_vision_error');
                return {
                    state: 'rejected_vision_error',
                    error: imagePath ? 'parsePhoto returned nothing' : 'no_image_and_no_text_or_no_text_client',
                    activationCode, parsed: null, ts: t0,
                };
            }
        } catch (e) {
            audit.vision = { error: e.message?.slice(0, 200) };
            writeAudit('rejected_vision_error');
            return {
                state: 'rejected_vision_error',
                error: e.message || String(e),
                activationCode, parsed: null, ts: t0,
            };
        }

        if (!preparsedSignal && Array.isArray(parsed?.signals) && parsed.signals.length > 1) {
            audit.vision = {
                provider: parsed.provider,
                model: parsed.model,
                intent: parsed.intent,
                confidence: parsed.confidence,
                notes: parsed.notes,
                signalCount: parsed.signals.length,
            };

            const childResults = [];
            for (let i = 0; i < parsed.signals.length; i += 1) {
                const childParsed = parsed.signals[i];
                const childCaption = this._buildChildCaption(childParsed, effectiveCaption);
                const child = await this.parseSignal({
                    caption: childCaption,
                    activationCode,
                    hint,
                    preparsedSignal: childParsed,
                    multiIndex: i + 1,
                    multiTotal: parsed.signals.length,
                });
                childResults.push(child);
            }

            audit.multi = {
                total: childResults.length,
                ready: childResults.filter((signal) => signal.state === 'ready').length,
                states: childResults.map((signal) => signal.state),
            };
            writeAudit('multi_signal');
            return {
                state: 'multi_signal',
                activationCode,
                parsed,
                signals: childResults,
                confidence: childResults.length > 0
                    ? Math.min(...childResults.map((signal) => Number(signal.confidence ?? signal.parsed?.confidence) || 0))
                    : 0,
                ts: t0,
            };
        }

        if (!preparsedSignal && Array.isArray(parsed?.signals) && parsed.signals.length === 1) {
            parsed = parsed.signals[0];
        }

        audit.vision = {
            provider: parsed.provider,
            model: parsed.model,
            sport: parsed.sport,
            home: parsed.home,
            away: parsed.away,
            league: parsed.league,
            score: parsed.score,
            isLive: parsed.isLive,
            outcomeRaw: parsed.outcomeRaw,
            intent: parsed.intent,
            confidence: parsed.confidence,
            notes: parsed.notes,
            latencyMs: parsed.raw?.latencyMs ?? null,
            costUSD: parsed.raw?.usage?.cost ?? null,
            tokens: parsed.raw?.usage ? {
                prompt: parsed.raw.usage.prompt_tokens,
                completion: parsed.raw.usage.completion_tokens,
            } : null,
        };

        // STOP detection
        if (parsed.intent === 'stop' || normalizeOutcome(null, effectiveCaption, parsed.sport).intent === 'stop') {
            writeAudit('stop');
            return {
                state: 'stop',
                activationCode,
                parsed,
                ts: t0,
            };
        }

        const textHints = this._extractTextHints(effectiveCaption, parsed);
        if (!parsed.home && !parsed.away && textHints.teamHint) {
            parsed.home = textHints.teamHint;
            audit.vision.home = parsed.home;
            audit.vision.notes = [audit.vision.notes, `team_hint_from_text=${textHints.teamHint}`]
                .filter(Boolean)
                .join('; ');
        }

        // Confidence band
        audit.confidenceGate = {
            confidence: parsed.confidence,
            lowGate: this.lowConfGate,
            highGate: this.highConfGate,
            band: parsed.confidence < this.lowConfGate ? 'rejected'
                : parsed.confidence < this.highConfGate ? 'alert' : 'ok',
        };
        if (parsed.confidence < this.lowConfGate || (!parsed.home && !parsed.away)) {
            writeAudit('rejected_low_confidence');
            return {
                state: 'rejected_low_confidence',
                reason: `confidence=${parsed.confidence.toFixed(2)} home=${parsed.home} away=${parsed.away}`,
                activationCode, parsed, ts: t0,
            };
        }

        const inAlertBand = parsed.confidence < this.highConfGate;

        // Catalog
        let catalog = [];
        try { catalog = await this.adapter.getCatalog(parsed.sport); }
        catch (e) {
            audit.catalog = { error: e.message?.slice(0, 200) };
            writeAudit('rejected_catalog_error');
            return {
                state: 'rejected_catalog_error',
                error: e.message || String(e),
                activationCode, parsed, ts: t0,
            };
        }
        audit.catalog = { size: catalog.length, sport: parsed.sport };

        if (!catalog.length) {
            writeAudit('match_not_found');
            return {
                state: 'match_not_found',
                reason: 'empty_catalog',
                activationCode, parsed, ts: t0,
            };
        }

        // Match locator
        const locT0 = Date.now();
        const located = await this.matchLocator.locate({ parsedSignal: parsed, catalog });
        audit.matchLocator = {
            decision: located.matchId,
            confidence: located.confidence,
            reason: located.reason,
            latencyMs: Date.now() - locT0,
        };
        if (!located.matchId) {
            writeAudit('match_not_found');
            return {
                state: 'match_not_found',
                reason: located.reason,
                activationCode, parsed, located, ts: t0,
            };
        }
        const match = catalog.find((m) => String(m.matchId) === String(located.matchId));
        if (!match) {
            audit.matchLocator.error = 'matched_id_not_in_catalog_after_lookup';
            writeAudit('match_not_found');
            return {
                state: 'match_not_found',
                reason: 'matched_id_not_in_catalog_after_lookup',
                activationCode, parsed, located, ts: t0,
            };
        }
        audit.matchLocator.match = {
            matchId: match.matchId,
            sport: match.sport,
            home: match.home,
            away: match.away,
            league: match.league,
            mode: match.mode,
            score: match.score,
        };

        // Outcome normalize. If partner text/caption contains an outcome, it is
        // the authority; otherwise keep the parsed vision/text outcome. A
        // caption such as team/league/comment must not suppress the outcome
        // that vision read from the screenshot.
        const outcomeText = textHints.outcomeText || null;
        const rawOutcomeInput = outcomeText ? null : parsed.outcomeRaw;
        const outcomeNorm = normalizeOutcome(rawOutcomeInput, outcomeText, parsed.sport);
        audit.outcomeNormalizer = {
            inputs: {
                raw: rawOutcomeInput,
                caption: outcomeText || null,
                fullText: effectiveCaption || null,
                sport: parsed.sport
            },
            intent: outcomeNorm.intent,
            outcome: outcomeNorm.outcome ? {
                original: outcomeNorm.outcome.original,
                canonical: outcomeNorm.outcome.canonical,
            } : null,
        };
        if (outcomeNorm.intent === 'stop') {
            writeAudit('stop');
            return { state: 'stop', activationCode, parsed, ts: t0 };
        }

        // LLM-resolver fallback — kick in when regex couldn't canonicalize.
        // Triggers if intent='unclear' OR canonical === original (passthrough).
        let canonicalOutcome = outcomeNorm.outcome?.canonical || null;
        let outcomeConfidence = null;
        let outcomeRejectReason = null;
        let outcomeCandidates = [];
        let llmResolvedCanonical = false;
        const canonicalLooksAllowed = canonicalOutcome && isAllowedCanonical(canonicalOutcome);
        const regexFailed = !canonicalOutcome
            || outcomeNorm.intent === 'unclear'
            || (outcomeNorm.outcome && outcomeNorm.outcome.canonical === outcomeNorm.outcome.original && !canonicalLooksAllowed);
        if (regexFailed && this.outcomeResolver && this.outcomeResolver.resolve) {
            try {
                const llmRes = await this.outcomeResolver.resolve({
                    captionText: outcomeText || effectiveCaption,
                    visionOutcomeRaw: rawOutcomeInput,
                    sport: parsed.sport,
                    home: match.home,
                    away: match.away,
                    score: parsed.score,
                    matchTime: parsed.matchTime,
                });
                audit.outcomeNormalizer.llmFallback = {
                    canonical: llmRes.canonical,
                    confidence: llmRes.confidence,
                    reason: llmRes.reason,
                    candidates: Array.isArray(llmRes.candidates)
                        ? llmRes.candidates.map((candidate) => candidate.outcome || candidate.canonical).filter(Boolean).slice(0, 12)
                        : [],
                };
                outcomeCandidates = this._normalizeOutcomeCandidates(llmRes.candidates, match.sport);
                if (!llmRes.canonical && llmRes.reason) {
                    outcomeRejectReason = llmRes.reason;
                }
                if (llmRes.canonical) {
                    canonicalOutcome = llmRes.canonical;
                    llmResolvedCanonical = true;
                    outcomeConfidence = Number.isFinite(Number(llmRes.confidence)) ? Number(llmRes.confidence) : null;
                    audit.outcomeNormalizer.outcome = {
                        original: outcomeNorm.outcome?.original || outcomeText || effectiveCaption || parsed.outcomeRaw || '',
                        canonical: canonicalOutcome,
                    };
                    if (this.logger?.log) this.logger.log(
                        `🧠 Outcome resolved by LLM fallback: "${outcomeText || effectiveCaption}"+raw="${rawOutcomeInput || ''}" → "${canonicalOutcome}" (${llmRes.confidence})`
                    );
                }
            } catch (e) {
                audit.outcomeNormalizer.llmFallbackError = e.message?.slice(0, 200);
                outcomeRejectReason = `llm_error:${e.message?.slice(0, 100)}`;
            }
        }
        if (!regexFailed && canonicalOutcome) {
            outcomeConfidence = 1;
        }

        if (regexFailed && !llmResolvedCanonical && outcomeNorm.outcome && canonicalOutcome === outcomeNorm.outcome.original && !isAllowedCanonical(canonicalOutcome) && this.outcomeResolver) {
            canonicalOutcome = null;
            if (!outcomeRejectReason) outcomeRejectReason = 'regex_passthrough_not_canonical';
        }

        if (!canonicalOutcome) {
            writeAudit('rejected_no_outcome');
            return {
                state: 'rejected_no_outcome',
                reason: `could_not_normalize: raw=${rawOutcomeInput} caption=${outcomeText || effectiveCaption}${outcomeRejectReason ? ` reason=${outcomeRejectReason}` : ''}`,
                activationCode, parsed, ts: t0,
            };
        }

        const normalizedIntent = canonicalizeIntent({
            normalizedOutcome: canonicalOutcome,
            sport: match.sport || parsed.sport || null,
        });

        // Alert band — return ready-but-flagged
        if (inAlertBand) {
            const matchConfidence = Number(located.confidence);
            const stronglyCorroborated = Number.isFinite(matchConfidence)
                && matchConfidence >= 0.92
                && Number.isFinite(outcomeConfidence)
                && outcomeConfidence >= this.minResolvedConfidence;
            if (stronglyCorroborated) {
                audit.confidenceGate.override = 'ready_strong_match_and_outcome';
                audit.confidenceGate.matchConfidence = matchConfidence;
                audit.confidenceGate.outcomeConfidence = outcomeConfidence;
                audit.confidenceGate.minResolvedConfidence = this.minResolvedConfidence;
            } else {
                writeAudit('alert_review');
                return {
                    state: 'alert_review',
                    reason: `confidence=${parsed.confidence.toFixed(2)} (alert band)`,
                    activationCode, parsed, located, match,
                    outcome: canonicalOutcome,
                    normalizedIntent,
                    outcomeCandidates,
                    outcomeRawNote: outcomeNorm.outcome?.original || outcomeText || parsed.outcomeRaw || effectiveCaption,
                    ts: t0,
                };
            }
        }

        writeAudit('ready');
        return {
            state: 'ready',
            activationCode,
            parsed,
            located,
            match,
            sport: match.sport,
            home: match.home,
            away: match.away,
            league: match.league,
            mode: match.mode,
            matchId: String(match.matchId),
            outcome: canonicalOutcome,
            normalizedIntent,
            outcomeCandidates,
            outcomeRawNote: outcomeNorm.outcome?.original || outcomeText || parsed.outcomeRaw || effectiveCaption,
            confidence: parsed.confidence,
            ts: t0,
        };
    }

    _buildChildCaption(parsed = {}, fallbackText = '') {
        if (typeof parsed.sourceText === 'string' && parsed.sourceText.trim()) {
            return parsed.sourceText.trim();
        }

        const lines = [];
        const home = typeof parsed.home === 'string' ? parsed.home.trim() : '';
        const away = typeof parsed.away === 'string' ? parsed.away.trim() : '';
        if (home && away) lines.push(`${home} / ${away}`);
        else if (home) lines.push(home);
        else if (away) lines.push(away);
        if (typeof parsed.outcomeRaw === 'string' && parsed.outcomeRaw.trim()) {
            lines.push(parsed.outcomeRaw.trim());
        }
        if (typeof parsed.sport === 'string' && parsed.sport.trim()) {
            lines.push(parsed.sport.trim());
        }
        if (typeof parsed.league === 'string' && parsed.league.trim()) {
            lines.push(parsed.league.trim());
        }
        if (parsed.isLive === true) lines.push('Live');
        else if (parsed.isLive === false) lines.push('Prematch');

        return lines.filter(Boolean).join('\n\n') || String(fallbackText || '').trim();
    }

    _normalizeOutcomeCandidates(candidates, sport) {
        if (!Array.isArray(candidates)) return [];
        const normalized = [];
        const seen = new Set();
        for (const candidate of candidates) {
            const outcome = String(candidate?.outcome || candidate?.canonical || candidate?.normalizedOutcome || '').trim();
            if (!outcome || seen.has(outcome)) continue;
            seen.add(outcome);
            const normalizedIntent = canonicalizeIntent({
                normalizedOutcome: outcome,
                sport,
            });
            normalized.push({
                outcome,
                canonical: outcome,
                priority: normalized.length + 1,
                reason: candidate.reason || 'llm_outcome_candidate',
                relationType: candidate.relationType || 'llm_suggested',
                confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
                normalizedIntent,
            });
        }
        return normalized;
    }

    _extractTextHints(text, parsed = {}) {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const sportWords = new Set([
            'football', 'футбол', 'soccer', 'basketball', 'баскетбол',
            'tennis', 'теннис', 'volleyball', 'волейбол', 'hockey', 'хоккей',
            'handball', 'гандбол', 'esports', 'киберспорт'
        ]);
        const modeWords = new Set(['live', 'лайв', 'в игре', 'prematch', 'прематч']);
        const countryWords = new Set([
            'brazil', 'brasil', 'бразилия', 'vietnam', 'england', 'russia',
            'france', 'italy', 'spain', 'germany', 'turkey', 'lebanon'
        ]);

        const looksLikeOutcome = (line) => {
            const s = line.toLowerCase();
            return /^(?:over|under|тб|тм|t[<>]|[тt][<>])\s*\(?\s*\d/i.test(s)
                || /^\d+(?:[.,]\d+)?\s*[бмbm]$/i.test(s)
                || isUnsupportedNthGoalMarket(line)
                || /^(?:\d+\s+)?(?:четверть|quarter|тайм|half)(?:\s|$).*\d/i.test(s)
                || /^\d+\s*[:\-]\s*\d+(?:\s*тс)?$/i.test(s)
                || /^[12xх]$/i.test(s)
                || /^(?:w|win|[пp])\s*[12]$/i.test(s)
                || /^(?:1[xх]|[xх]2|12)$/i.test(s)
                || /^(?:dnb|без\s+ничьи|с\s+возвратом)/i.test(s)
                || /^(?:btts|both\s+to\s+score|обе\s+забьют|обе\s+не\s+забьют)/i.test(s)
                || /^(?:ит|it)\s*[12]\s*(?:[><]|тб|тм|over|under|[бмbm])\s*\d/i.test(s)
                || /^[+-]?\s*\d+(?:[.,]\d+)?\s+(?:first|second|home|away|первая|вторая|т1|т2)/i.test(s)
                || /^(?:ф|h|ah)\s*[12]\s*[+-]?\s*\d/i.test(s);
        };

        const outcomeText = lines.find(looksLikeOutcome) || null;
        const teamHint = lines.find((line) => {
            const s = line.toLowerCase();
            if (line === outcomeText) return false;
            if (sportWords.has(s) || modeWords.has(s) || countryWords.has(s)) return false;
            if (looksLikeOutcome(line)) return false;
            return /[\p{L}]/u.test(line);
        }) || null;

        return {
            outcomeText,
            teamHint
        };
    }
}

module.exports = { TelegramSignalParserV2 };
