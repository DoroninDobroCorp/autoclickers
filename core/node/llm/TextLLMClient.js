/**
 * TextLLMClient — text-only LLM provider for match-locator and outcome
 * normalizer. Same providers as VisionLLMClient but no image payload.
 *
 * Implementations:
 *   - AnthropicTextClient (Claude)
 *   - OpenAITextClient    (GPT-4o / GPT-4o-mini)
 *   - MockTextClient      (deterministic, dev / tests)
 *
 * Contract:
 *   complete({ system, user, jsonOnly }) → string
 */
'use strict';

class TextLLMClient {
    constructor({ apiKey, model, logger, timeoutMs } = {}) {
        this.apiKey = apiKey || null;
        this.model = model || null;
        this.logger = logger || console;
        this.timeoutMs = timeoutMs || 20000;
    }

    isReady() { return Boolean(this.apiKey); }
    get providerName() { return 'abstract'; }

    /**
     * @param {Object} input
     * @param {string} input.system    System prompt.
     * @param {string} input.user      User content.
     * @param {boolean} [input.jsonOnly]  Hint to provider for JSON-only mode.
     * @returns {Promise<string>}      Raw model text.
     */
    async complete(_input) {
        throw new Error('TextLLMClient.complete must be implemented');
    }
}

class AnthropicTextClient extends TextLLMClient {
    constructor(opts = {}) {
        super({
            apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY || null,
            model: opts.model || process.env.ANTHROPIC_TEXT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
            logger: opts.logger,
        });
    }
    get providerName() { return 'anthropic-text'; }

    async complete({ system, user, jsonOnly }) {
        if (!this.isReady()) throw new Error('AnthropicTextClient: ANTHROPIC_API_KEY not set');
        const body = {
            model: this.model,
            max_tokens: 1500,
            system,
            messages: [{ role: 'user', content: user }],
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let resp;
        try {
            resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally { clearTimeout(timer); }
        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(`Anthropic text ${resp.status}: ${err.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data?.content?.[0]?.text || '';
    }
}

class OpenAITextClient extends TextLLMClient {
    constructor(opts = {}) {
        super({
            apiKey: opts.apiKey || process.env.OPENAI_API_KEY || null,
            model: opts.model || process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
            logger: opts.logger,
        });
        this.baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com';
    }
    get providerName() { return 'openai-text'; }

    async complete({ system, user, jsonOnly }) {
        if (!this.isReady()) throw new Error('OpenAITextClient: OPENAI_API_KEY not set');
        const body = {
            model: this.model,
            max_tokens: 1500,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        };
        if (jsonOnly) body.response_format = { type: 'json_object' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let resp;
        try {
            resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${this.apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally { clearTimeout(timer); }
        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(`OpenAI text ${resp.status}: ${err.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data?.choices?.[0]?.message?.content || '';
    }
}

class MockTextClient extends TextLLMClient {
    constructor(opts = {}) {
        super({ apiKey: 'MOCK', model: 'mock-text-v1', logger: opts.logger });
        this.responder = opts.responder || (({ user }) => mockAutoMatchFromPrompt(user));
        this.callLog = [];
    }
    get providerName() { return 'mock-text'; }
    isReady() { return true; }
    async complete({ system, user, jsonOnly }) {
        this.callLog.push({ system, user, jsonOnly, ts: Date.now() });
        return await this.responder({ system, user, jsonOnly });
    }
}

/**
 * Default mock responder: parses the parsed-signal home/away and the catalog
 * block from the MatchLocator prompt, then returns the first catalog entry
 * whose home or away substring-matches (case-insensitive) the signal.
 *
 * This is intentionally permissive — for offline E2E smoke, not for
 * production. Real LLM matcher does cross-language semantic matching.
 */
function mockAutoMatchFromPrompt(user) {
    if (!user) return '{"matchId":null,"confidence":0,"reason":"empty_prompt"}';
    const homeM = user.match(/home:\s*([^\n]+)/i);
    const awayM = user.match(/away:\s*([^\n]+)/i);
    const sportM = user.match(/sport:\s*(\w+)/i);
    if (!homeM && !awayM) return '{"matchId":null,"confidence":0,"reason":"no_team_in_prompt"}';
    const sh = (homeM ? homeM[1] : '').toLowerCase().trim();
    const sa = (awayM ? awayM[1] : '').toLowerCase().trim();
    const sport = (sportM ? sportM[1] : '').toLowerCase();

    // Parse catalog block lines: "  id=X sport=Y H vs A | league=... | mode | ..."
    const lines = user.split('\n');
    let bestId = null;
    for (const line of lines) {
        const m = line.match(/^\s+id=(\S+)\s+sport=(\S+)\s+(.+?)\s+vs\s+(.+?)(?:\s+\||\s*$)/);
        if (!m) continue;
        const [, id, csport, ch, ca] = m;
        if (sport && sport !== 'unknown' && sport !== 'null' && csport.toLowerCase() !== sport) continue;
        const cha = ch.toLowerCase(); const caa = ca.toLowerCase();
        const matches =
            (sh && (cha.includes(sh) || sh.includes(cha) || caa.includes(sh) || sh.includes(caa))) ||
            (sa && (cha.includes(sa) || sa.includes(cha) || caa.includes(sa) || sa.includes(caa)));
        if (matches) { bestId = id; break; }
    }
    if (bestId) return JSON.stringify({ matchId: bestId, confidence: 0.9, reason: 'mock_substring_match' });
    return JSON.stringify({ matchId: null, confidence: 0, reason: 'mock_no_match' });
}

function buildTextClient(opts = {}) {
    const logger = opts.logger || console;
    const explicit = (opts.provider || process.env.TEXT_LLM_PROVIDER || process.env.VISION_PROVIDER || '').toLowerCase();
    if (explicit === 'anthropic' || (!explicit && process.env.ANTHROPIC_API_KEY)) {
        const c = new AnthropicTextClient({ logger, ...opts });
        if (c.isReady()) return c;
    }
    if (explicit === 'openai' || (!explicit && process.env.OPENAI_API_KEY)) {
        const c = new OpenAITextClient({ logger, ...opts });
        if (c.isReady()) return c;
    }
    if (explicit === 'mock' || process.env.MOCK_VISION === '1') {
        return new MockTextClient({ logger, responder: opts.mockResponder });
    }
    throw new Error('No text LLM provider configured (need ANTHROPIC_API_KEY or OPENAI_API_KEY)');
}

module.exports = {
    TextLLMClient, AnthropicTextClient, OpenAITextClient, MockTextClient,
    buildTextClient,
};
