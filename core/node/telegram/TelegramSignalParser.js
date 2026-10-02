/**
 * TelegramSignalParser (v2 façade) — keeps the v1 API surface that
 * TelegramPollingIngress consumes (`detectMessageIntent`, `parseSession`)
 * while the implementation routes through TelegramSignalParserV2 (vision-LLM
 * + match-locator + adapter catalog).
 *
 * This is the single integration point between the old polling ingress
 * machinery (which still owns transport, dedupe, draft sessions, code-linkage)
 * and the new pure-LLM signal pipeline.
 */
'use strict';

const { TelegramSignalParserV2 } = require('./TelegramSignalParserV2.js');
const { detectStop } = require('../llm/OutcomeNormalizer.js');

class TelegramSignalParser {
    /**
     * @param {Object} opts
     * @param {Object} opts.visionClient   VisionLLMClient (Anthropic / OpenAI / Mock).
     * @param {Object} opts.matchLocator   MatchLocator instance.
     * @param {Object} opts.adapter        v2 BookmakerAdapter (SansabetV2Adapter, ...).
     * @param {Object} [opts.textSignalClient]  Optional TextSignalClient for
     *                                          text-only signals (no screenshot).
     * @param {number} [opts.lowConfGate]
     * @param {number} [opts.highConfGate]
     * @param {Object} [opts.logger]
     */
    constructor(opts = {}) {
        this.v2 = new TelegramSignalParserV2(opts);
        this.logger = opts.logger || console;
    }

    /** v1-API: very fast pre-parse intent check on a single message. */
    async detectMessageIntent(message, _context) {
        const t = (message?.text || message?.caption || '').trim();
        if (!t) return { intentType: 'unknown' };
        return detectStop(t)
            ? { intentType: 'stop', reason: 'stop_keyword_in_text' }
            : { intentType: 'unknown' };
    }

    /** v1-API: full parse of an accumulated session (photos + texts). */
    async parseSession(session, context) {
        const images = (typeof session.getImages === 'function' ? session.getImages() : (session.images || []));
        const caption = (typeof session.getTextContext === 'function' ? session.getTextContext() : '').trim();
        const photo = [...images].reverse().find((p) => {
            if (!p) return false;
            if (typeof p === 'string') return p.length > 0;
            return Boolean(p.localPath || p._local_image_path || p.localImagePath || p.path);
        }) || null;
        const imagePath = photo == null
            ? null
            : (typeof photo === 'string'
                ? photo
                : (photo.localPath || photo._local_image_path || photo.localImagePath || photo.path));
        // Activation code lives on the draft, not the session. The ingress
        // passes it through context now (TelegramPollingIngress._buildParserContext).
        const activationCode = (context && context.activationCode) || session.activationCode || null;

        if (!imagePath && !caption) {
            return this._packV1({
                state: 'match_not_found',
                reason: 'no_image_no_caption_in_session',
                parsed: null,
            });
        }

        let v2;
        try {
            v2 = await this.v2.parseSignal({ imagePath, caption, activationCode });
        } catch (e) {
            this.logger?.log?.(`⚠️ [v2-parser] vision threw: ${e.message?.slice(0, 200)}`);
            return this._packV1({
                state: 'match_not_found',
                reason: `parser_error:${e.message?.slice(0, 120)}`,
                parsed: null,
            });
        }
        return this._packV1(v2);
    }

    _packV1(v2) {
        if (v2.state === 'multi_signal') {
            const signals = Array.isArray(v2.signals)
                ? v2.signals.map((signal) => this._packV1(signal))
                : [];
            return {
                intentType: 'signal',
                state: 'multi_signal',
                signals,
                readySignals: signals.filter((signal) => signal.state === 'ready'),
                rejectedSignals: signals.filter((signal) => signal.state !== 'ready'),
                confidence: typeof v2.confidence === 'number' ? v2.confidence : 0,
                queueDecision: signals.some((signal) => signal.state === 'ready') ? 'multi_enqueue' : 'rejected',
                reason: v2.reason || null,
                _v2: v2,
            };
        }

        const intentType = v2.state === 'stop' ? 'stop' : 'signal';
        const state = (() => {
            if (v2.state === 'ready') return 'ready';
            if (v2.state === 'stop') return 'stop_requested';
            if (v2.state === 'alert_review') {
                if (!v2.located?.matchId) return 'match_ambiguous';
                if (!v2.outcome) return 'outcome_ambiguous';
                return 'match_ambiguous';
            }
            if (v2.state === 'rejected_low_confidence') return 'rejected_low_confidence';
            if (v2.state === 'rejected_no_outcome') return 'outcome_ambiguous';
            if (v2.state === 'rejected_vision_error') return 'match_not_found';
            if (v2.state === 'rejected_catalog_error') return 'match_not_found';
            if (v2.state === 'match_not_found') return 'match_not_found';
            return 'match_not_found';
        })();

        const queueDecision = (() => {
            if (state === 'ready') return 'enqueue';
            if (state === 'match_ambiguous') return 'alert';
            if (state === 'stop_requested') return 'stop';
            return 'rejected';
        })();

        return {
            intentType,
            state,
            sport: v2.sport || v2.parsed?.sport || 'unknown',
            home: v2.home || v2.parsed?.home || null,
            away: v2.away || v2.parsed?.away || null,
            league: v2.league || v2.parsed?.league || null,
            normalizedOutcome: v2.outcome || null,
            normalizedIntent: v2.normalizedIntent || null,
            outcomeCandidates: Array.isArray(v2.outcomeCandidates) ? v2.outcomeCandidates : [],
            candidateLadder: Array.isArray(v2.candidateLadder) ? v2.candidateLadder : [],
            outcomeRaw: v2.parsed?.outcomeRaw || null,
            bookmakerMatchId: v2.matchId || null,
            confidence: typeof v2.parsed?.confidence === 'number' ? v2.parsed.confidence : (v2.confidence || 0),
            queueDecision,
            mode: v2.mode || (v2.parsed?.isLive ? 'live' : 'prematch'),
            score: v2.parsed?.score || null,
            reason: v2.reason || null,
            _v2: v2,  // for audit / envelope dump
        };
    }
}

module.exports = { TelegramSignalParser };
