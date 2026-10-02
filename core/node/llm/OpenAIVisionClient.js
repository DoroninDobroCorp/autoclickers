/**
 * OpenAIVisionClient — vision-LLM impl using GPT-4o (or any OpenAI vision model).
 *
 * API: POST https://api.openai.com/v1/chat/completions
 *
 * Recommended models:
 *   - gpt-4o          — best quality
 *   - gpt-4o-mini     — cheaper, almost as good for structured extraction
 *
 * Env:
 *   OPENAI_API_KEY   — required
 *   OPENAI_MODEL     — optional override (default 'gpt-4o')
 *   OPENAI_BASE_URL  — optional (for self-hosted / proxy / Azure)
 */
'use strict';

const { VisionLLMClient } = require('./VisionLLMClient.js');

const DEFAULT_BASE = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4o';
const MAX_TOKENS = 1000;

class OpenAIVisionClient extends VisionLLMClient {
    constructor(opts = {}) {
        super({
            apiKey: opts.apiKey || process.env.OPENAI_API_KEY || null,
            model: opts.model || process.env.OPENAI_MODEL || DEFAULT_MODEL,
            logger: opts.logger,
            timeoutMs: opts.timeoutMs || 30000,
        });
        this.baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE;
    }

    get providerName() { return 'openai'; }

    async parsePhoto({ imagePath, caption, hint } = {}) {
        if (!this.isReady()) {
            throw new Error('OpenAIVisionClient: OPENAI_API_KEY not set');
        }
        const { base64, mimeType, sizeBytes } = this._loadImageBase64(imagePath);
        const dataUri = `data:${mimeType};base64,${base64}`;

        const body = {
            model: this.model,
            max_tokens: MAX_TOKENS,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: this._systemPrompt() },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: this._userMessage(caption, hint) },
                        { type: 'image_url', image_url: { url: dataUri, detail: 'high' } },
                    ],
                },
            ],
        };

        const t0 = Date.now();
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
        const ms = Date.now() - t0;

        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 300)}`);
        }
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || '';
        const desc = this._parseModelResponse(text);
        desc.raw = { provider: 'openai', model: this.model, latencyMs: ms,
                     finish_reason: data?.choices?.[0]?.finish_reason,
                     usage: data?.usage, imageBytes: sizeBytes };
        if (this.logger?.log) this.logger.log(`🧠 Vision parse [${this.model}]: confidence=${desc.confidence} sport=${desc.sport} home=${desc.home} away=${desc.away} (${ms}ms)`);
        return desc;
    }
}

module.exports = { OpenAIVisionClient };
