/**
 * VisionLLMClient — abstract base for vision-LLM providers.
 *
 * Concrete implementations:
 *   - AnthropicClaudeClient (Claude 3.5 Sonnet)
 *   - OpenAIVisionClient    (GPT-4o)
 *   - MockVisionClient      (offline / dry-run / tests)
 *
 * Contract:
 *   parsePhoto({ imagePath, caption, hint }) → SignalDescriptor
 *
 * SignalDescriptor schema:
 *   {
 *     sport:       'soccer' | 'basketball' | 'tennis' | 'volleyball' |
 *                  'hockey' | 'handball' | 'esports' | null,
 *     home:        string | null,        // team name as visible on screen
 *     away:        string | null,        // team name as visible on screen
 *     league:      string | null,        // optional, helps match-locator
 *     score:       string | null,        // 'X-Y' or null
 *     matchTime:   string | null,        // '67:12' / 'Q2 03:45' / 'S1' / null
 *     isLive:      boolean,              // explicit live indicator on screen
 *     outcomeRaw:  string | null,        // outcome highlighted on screen, e.g. '1', 'ТБ 2.5'
 *     intent:      'bet' | 'stop' | 'unclear',
 *     confidence:  number,               // 0..1, model's own self-rating
 *     notes:       string,               // free-form why-this-confidence
 *     raw:         object | null,        // raw provider response for audit
 *     provider:    string,               // 'anthropic' | 'openai' | 'mock'
 *     model:       string,
 *   }
 *
 * Errors:
 *   parsePhoto throws on transport / auth failures.
 *   For "model couldn't read the image" the result is returned with
 *   confidence=0 and intent='unclear' instead of throwing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

class VisionLLMClient {
    constructor({ apiKey, model, logger, timeoutMs } = {}) {
        this.apiKey = apiKey || null;
        this.model = model || null;
        this.logger = logger || console;
        this.timeoutMs = timeoutMs || 30000;
    }

    isReady() {
        return Boolean(this.apiKey);
    }

    /** Provider name — override in subclass. */
    get providerName() { return 'abstract'; }

    /**
     * @param {Object} input
     * @param {string} input.imagePath  Path to local image file (.png / .jpg).
     * @param {string} [input.caption]  Text caption sent with the photo.
     * @param {Object} [input.hint]     Optional context hint, e.g. { language: 'ru' }.
     * @returns {Promise<Object>}       SignalDescriptor (see file header).
     */
    async parsePhoto(_input) {
        throw new Error('VisionLLMClient.parsePhoto must be implemented by subclass');
    }

    /** Read image file and return { base64, mimeType, sizeBytes }. */
    _loadImageBase64(imagePath) {
        if (!imagePath || !fs.existsSync(imagePath)) {
            throw new Error(`Image file not found: ${imagePath}`);
        }
        const buf = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType =
            ext === '.png' ? 'image/png' :
            ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
            ext === '.webp' ? 'image/webp' :
            ext === '.gif' ? 'image/gif' :
            'application/octet-stream';
        return { base64: buf.toString('base64'), mimeType, sizeBytes: buf.length };
    }

    /** Standard system+user prompt used by all real providers. */
    _systemPrompt() {
        return [
            'You are a precise extractor of sport-betting signals from screenshots.',
            'A user sends a phone screenshot from some bookmaker app and (optionally) a short text caption.',
            'Your task: identify the SINGLE primary match the user is signalling about. Outcome extraction from screenshots is secondary and must be conservative.',
            '',
            'Output STRICT JSON only, no prose, no markdown fences:',
            '{',
            '  "sport": "soccer"|"basketball"|"tennis"|"volleyball"|"hockey"|"handball"|"esports"|null,',
            '  "home": string|null,        // team name as visible on the screenshot',
            '  "away": string|null,        // team name as visible on the screenshot',
            '  "league": string|null,      // league/country/competition name if visible',
            '  "score": string|null,       // "X-Y" if shown, else null',
            '  "matchTime": string|null,   // "67:12", "Q2 03:45", "1st set", "Set 2", or null',
            '  "isLive": true|false,       // explicit live indicator (red dot, "LIVE" badge, ticking clock, score)',
            '  "outcomeRaw": string|null,  // ONLY an outcome visibly highlighted/selected on screen. Do NOT infer outcome from caption text.',
            '  "intent": "bet"|"stop"|"unclear",  // "stop" only if caption says СТОП/STOP/отмена/не ставь',
            '  "confidence": 0.0..1.0,     // your honest self-rating; <0.5 if anything is unclear',
            '  "notes": string             // 1-3 short sentences explaining what you saw and any uncertainty',
            '}',
            '',
            'Canonical outcomeRaw forms (USE THESE WHENEVER POSSIBLE):',
            '   "1" | "2" | "X"                          — home win / away win / draw',
            '   "1X" | "X2" | "12"                       — double chance',
            '   "DNB 1" | "DNB 2"                        — Draw No Bet',
            '   "T> 2.5" | "T< 2.5"                      — total over/under (use the actual line)',
            '   "IT1> 0.5" | "IT2< 1.5"                  — individual total (team 1 / team 2)',
            '   "H1 -1.5" | "H2 +2.5"                    — handicap (team 1 = HOME, team 2 = AWAY; sign explicit)',
            '   "BTTS Yes" | "BTTS No"                   — both teams to score',
            '   "CS 1:0" | "CS 2:1"                      — correct score',
            '   "P1 1" | "P1 X" | "P1 T> 1.5"            — first-half-only outcome',
            '   "P2 ..." | "Q1 ..." | "Q2 ..."           — period (P) / quarter (Q) prefixes',
            '   "S1 1" | "S1 2"                          — set winner (tennis/volleyball)',
            'If a screenshot only shows "Фора (-2.5)" highlighted next to the home team and the home team is "Germany" → outcomeRaw = "H1 -2.5".',
            'If the caption is just "-2.5" and the screenshot visibly highlights the home-team handicap → outcomeRaw = "H1 -2.5".',
            'If nothing is visibly highlighted/selected on the screenshot, set outcomeRaw=null even if caption contains an outcome. Downstream text logic handles caption outcomes.',
            '',
            'Rules:',
            ' - The PRIMARY match is the dominant block in the screenshot, NOT promotional banners, recommended-matches lists, ticker bars, or footer text.',
            ' - If a screenshot shows a multi-match list and no single match dominates, set home/away=null and confidence<0.5.',
            ' - Names must be transcribed AS YOU SEE THEM, do NOT translate or "fix" them.',
            ' - Caption is auxiliary for sport/teams and stop intent only. Do NOT use caption to infer outcomeRaw; downstream text parsing owns partner-caption outcomes.',
            ' - Russian shorthand in captions: "м" means under/less, "б" means over/more, "тс" means correct score. Since caption outcomes are handled downstream, do not convert these into outcomeRaw unless the same outcome is visibly selected on the screenshot.',
            ' - "stop" intent: caption is exactly one of СТОП, STOP, отмена, "не ставь", "stop bet", or similar unambiguous cancel command. Otherwise intent="bet".',
            ' - confidence reflects YOUR uncertainty: tilted screen, OCR-grade image, language you cannot read, partial cropping, multiple competing matches → drop to 0.3-0.6.',
            ' - If the image is purely a chat-bot UI / receipt / something not a bookmaker match card → confidence=0.0, home=away=null, notes="not a match screenshot".',
        ].join('\n');
    }

    _userMessage(caption, hint) {
        const parts = [];
        if (caption && String(caption).trim()) {
            parts.push(`Caption from partner: ${String(caption).trim()}`);
        }
        if (hint && hint.language) parts.push(`Hint: language likely ${hint.language}`);
        if (hint && hint.bookmakerHint) parts.push(`Hint: source bookmaker may be ${hint.bookmakerHint}`);
        if (parts.length === 0) parts.push('No caption supplied. Use the screenshot only.');
        return parts.join('\n');
    }

    /** Parse the JSON the model returned. Strict — throws on garbage. */
    _parseModelResponse(text) {
        if (!text || typeof text !== 'string') {
            throw new Error(`Empty model response: ${text}`);
        }
        // Strip markdown fences if model added them despite being told not to.
        let body = text.trim();
        const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fenceMatch) body = fenceMatch[1].trim();
        // Some models wrap with explanation. Try to find first { ... } block.
        const braceStart = body.indexOf('{');
        const braceEnd = body.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) {
            body = body.slice(braceStart, braceEnd + 1);
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { throw new Error(`Model returned non-JSON: ${e.message}: ${text.slice(0, 200)}`); }
        return this._normalizeDescriptor(parsed);
    }

    _normalizeDescriptor(d) {
        const out = {
            sport: d && typeof d.sport === 'string' ? d.sport.toLowerCase() : null,
            home: d && typeof d.home === 'string' ? d.home.trim() : null,
            away: d && typeof d.away === 'string' ? d.away.trim() : null,
            league: d && typeof d.league === 'string' ? d.league.trim() : null,
            score: d && typeof d.score === 'string' ? d.score.trim() : null,
            matchTime: d && typeof d.matchTime === 'string' ? d.matchTime.trim() : null,
            isLive: d && typeof d.isLive === 'boolean' ? d.isLive : false,
            outcomeRaw: d && typeof d.outcomeRaw === 'string' ? d.outcomeRaw.trim() : null,
            intent: d && typeof d.intent === 'string'
                ? (['bet', 'stop', 'unclear'].includes(d.intent) ? d.intent : 'unclear')
                : 'unclear',
            confidence: typeof d?.confidence === 'number'
                ? Math.max(0, Math.min(1, d.confidence))
                : 0,
            notes: d && typeof d.notes === 'string' ? d.notes.trim() : '',
            raw: null,
            provider: this.providerName,
            model: this.model,
        };
        // Empty strings → null for cleaner downstream handling
        for (const k of ['sport', 'home', 'away', 'league', 'score', 'matchTime', 'outcomeRaw']) {
            if (out[k] === '') out[k] = null;
        }
        // Sport whitelist
        const allowedSports = new Set([
            'soccer', 'football', 'basketball', 'tennis', 'volleyball',
            'hockey', 'handball', 'esports',
        ]);
        if (out.sport && !allowedSports.has(out.sport)) out.sport = null;
        // football → soccer
        if (out.sport === 'football') out.sport = 'soccer';
        return out;
    }
}

module.exports = { VisionLLMClient };
