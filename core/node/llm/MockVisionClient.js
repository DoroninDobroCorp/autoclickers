/**
 * MockVisionClient — deterministic stub for dry-run, smoke tests, and the
 * `no API key yet` development phase.
 *
 * Two modes:
 *   1. Static result: pass `{ result: { ... } }` in constructor → always returns it.
 *   2. From caption: parses caption text for hints (e.g. "Brescia vs Milano | 1")
 *      and constructs a SignalDescriptor.
 *
 * Useful so the pipeline can be exercised end-to-end without hitting a paid API.
 */
'use strict';

const { VisionLLMClient } = require('./VisionLLMClient.js');

class MockVisionClient extends VisionLLMClient {
    constructor(opts = {}) {
        super({ apiKey: 'MOCK', model: opts.model || 'mock-vision-v1', logger: opts.logger });
        this.staticResult = opts.result || null;
        this.callLog = [];
    }

    get providerName() { return 'mock'; }

    isReady() { return true; }

    async parsePhoto({ imagePath, caption, hint } = {}) {
        this.callLog.push({ imagePath, caption, hint, ts: Date.now() });

        if (this.staticResult) {
            return this._normalizeDescriptor({
                ...this.staticResult,
                provider: 'mock', model: this.model,
            });
        }

        // Heuristic: try each non-empty caption line, accept first that
        // matches "Home vs Away" or "Home — Away" or "Home - Away" pattern,
        // optionally followed by " | outcome" or " outcome".
        const captionRaw = String(caption || '').trim();
        const lines = captionRaw.split('\n').map((l) => l.trim()).filter(Boolean);
        const stopWords = ['стоп', 'stop', 'отмена', 'не ставь', 'не ставить'];
        let intent = 'bet';
        let home = null, away = null, outcomeRaw = null;

        for (const ln of lines) {
            if (stopWords.includes(ln.toLowerCase())) { intent = 'stop'; break; }
            const m = ln.match(/^(.+?)\s+(?:vs\.?|против|—|-)\s+(.+?)(?:\s*[|│]\s*(.+))?$/i);
            if (m) {
                home = m[1].trim();
                away = m[2].trim();
                outcomeRaw = m[3]?.trim() || null;
                break;
            }
        }
        if (intent !== 'stop' && !outcomeRaw && lines.length > 0) {
            // Maybe the first line was teams and subsequent line is outcome on its own.
            const last = lines[lines.length - 1];
            if (last && (!home || !away) === false && /^[\dA-Za-zА-Яа-я+\-< >.,]+$/.test(last)) {
                outcomeRaw = last;
            } else if (!home && !away && last) {
                outcomeRaw = last;
            }
        }

        const desc = {
            sport: hint?.sport || null,
            home,
            away,
            league: null,
            score: null,
            matchTime: null,
            isLive: false,
            outcomeRaw,
            intent,
            confidence: home && away ? 0.9 : 0.3,
            notes: 'MOCK client — heuristic parse from caption',
            raw: { mock: true, imagePath, caption },
            provider: 'mock',
            model: this.model,
        };
        if (this.logger?.log) this.logger.log(`🧪 Mock vision parse: home=${desc.home} away=${desc.away} outcome=${desc.outcomeRaw} conf=${desc.confidence}`);
        return desc;
    }
}

module.exports = { MockVisionClient };
