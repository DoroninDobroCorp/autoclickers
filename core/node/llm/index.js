/**
 * llm/index.js — factory and index for vision-LLM clients.
 *
 * Construction order (first ready wins):
 *   1. ANTHROPIC_API_KEY → AnthropicClaudeClient
 *   2. OPENAI_API_KEY    → OpenAIVisionClient
 *   3. MOCK_VISION=1     → MockVisionClient (dev / dry-run)
 *   4. throw — no provider configured
 *
 * Usage:
 *   const { buildVisionClient } = require('./core/llm');
 *   const vision = buildVisionClient({ logger });
 *
 * Env:
 *   ANTHROPIC_API_KEY     — Claude
 *   ANTHROPIC_MODEL       — optional override
 *   OPENAI_API_KEY        — GPT-4o
 *   OPENAI_MODEL          — optional override
 *   MOCK_VISION=1         — force mock
 *   VISION_PROVIDER       — explicit choice: 'anthropic'|'openai'|'mock'
 */
'use strict';

const { VisionLLMClient } = require('./VisionLLMClient.js');
const { AnthropicClaudeClient } = require('./AnthropicClaudeClient.js');
const { OpenAIVisionClient } = require('./OpenAIVisionClient.js');
const { MockVisionClient } = require('./MockVisionClient.js');

function buildVisionClient(opts = {}) {
    const logger = opts.logger || console;
    const log = (msg) => {
        if (logger && typeof logger.log === 'function') logger.log(msg);
        else console.log(msg);
    };
    const explicit = (opts.provider || process.env.VISION_PROVIDER || '').toLowerCase();

    if (explicit === 'anthropic' || (!explicit && process.env.ANTHROPIC_API_KEY)) {
        const c = new AnthropicClaudeClient({ logger, ...opts });
        if (c.isReady()) {
            log(`✅ Vision provider: Anthropic (${c.model})`);
            return c;
        }
    }
    if (explicit === 'openai' || (!explicit && process.env.OPENAI_API_KEY)) {
        const c = new OpenAIVisionClient({ logger, ...opts });
        if (c.isReady()) {
            log(`✅ Vision provider: OpenAI (${c.model})`);
            return c;
        }
    }
    if (explicit === 'mock' || process.env.MOCK_VISION === '1') {
        log('⚠️  Vision provider: MOCK (no real API call will be made)');
        return new MockVisionClient({ logger, result: opts.mockResult });
    }
    throw new Error(
        'No vision-LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in env, ' +
        'or set MOCK_VISION=1 for development.'
    );
}

module.exports = {
    VisionLLMClient,
    AnthropicClaudeClient,
    OpenAIVisionClient,
    MockVisionClient,
    buildVisionClient,
};
