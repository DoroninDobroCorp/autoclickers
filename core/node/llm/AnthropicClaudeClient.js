/**
 * AnthropicClaudeClient — vision-LLM impl using Claude 3.5 Sonnet.
 *
 * API: POST https://api.anthropic.com/v1/messages
 * Auth: x-api-key header
 *
 * Recommended models for vision: claude-3-5-sonnet-20241022 (best),
 *                                claude-3-5-haiku-latest (cheaper).
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required to run
 *   ANTHROPIC_MODEL    — optional override (default 'claude-3-5-sonnet-20241022')
 */
'use strict';

const { VisionLLMClient } = require('./VisionLLMClient.js');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const MAX_TOKENS = 1000;

class AnthropicClaudeClient extends VisionLLMClient {
    constructor(opts = {}) {
        super({
            apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY || null,
            model: opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
            logger: opts.logger,
            timeoutMs: opts.timeoutMs || 30000,
        });
    }

    get providerName() { return 'anthropic'; }

    async parsePhoto({ imagePath, caption, hint } = {}) {
        if (!this.isReady()) {
            throw new Error('AnthropicClaudeClient: ANTHROPIC_API_KEY not set');
        }
        const { base64, mimeType, sizeBytes } = this._loadImageBase64(imagePath);

        const body = {
            model: this.model,
            max_tokens: MAX_TOKENS,
            system: this._systemPrompt(),
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: { type: 'base64', media_type: mimeType, data: base64 },
                        },
                        { type: 'text', text: this._userMessage(caption, hint) },
                    ],
                },
            ],
        };

        const t0 = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let resp;
        try {
            resp = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally { clearTimeout(timer); }
        const ms = Date.now() - t0;

        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(`Anthropic ${resp.status}: ${err.slice(0, 300)}`);
        }
        const data = await resp.json();
        const text = (data?.content?.[0]?.text) || '';
        const desc = this._parseModelResponse(text);
        desc.raw = { provider: 'anthropic', model: this.model, latencyMs: ms,
                     stop_reason: data?.stop_reason, usage: data?.usage,
                     imageBytes: sizeBytes };
        if (this.logger?.log) this.logger.log(`🧠 Vision parse [${this.model}]: confidence=${desc.confidence} sport=${desc.sport} home=${desc.home} away=${desc.away} (${ms}ms)`);
        return desc;
    }
}

module.exports = { AnthropicClaudeClient };
