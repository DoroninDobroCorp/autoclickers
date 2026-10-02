'use strict';

const factories = new Map();

function normalizeBookmakerId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function registerBookmakerAdapter(bookmakerId, factory) {
    const id = normalizeBookmakerId(bookmakerId);
    if (!id) throw new Error('registerBookmakerAdapter requires bookmakerId');
    if (typeof factory !== 'function') throw new Error(`Bookmaker adapter factory for "${id}" must be a function`);
    factories.set(id, factory);
}

function getRegisteredBookmakerIds() {
    return Array.from(factories.keys()).sort();
}

function createBookmakerAdapter({
    bookmakerId,
    legacyAdapter,
    config = {},
    telegramConfig = {},
    ingressConfig = {},
    logger
} = {}) {
    const explicit = ingressConfig.bookmakerAdapter || telegramConfig.bookmakerAdapter;
    if (explicit) {
        return explicit;
    }

    const id = normalizeBookmakerId(
        bookmakerId ||
        legacyAdapter?.bookmakerId ||
        legacyAdapter?.bookmakerName ||
        config.bookmakerId ||
        config.bookmakerName
    );

    if (!id) {
        throw new Error('Cannot resolve bookmaker adapter: missing bookmakerId/bookmakerName');
    }

    const factory = factories.get(id);
    if (!factory) {
        const known = getRegisteredBookmakerIds().join(', ') || 'none';
        throw new Error(`No v2 bookmaker adapter registered for "${id}" (registered: ${known}).`);
    }

    return factory({
        bookmakerId: id,
        legacyAdapter,
        config,
        telegramConfig,
        ingressConfig,
        logger
    });
}

// Register 1win
registerBookmakerAdapter('1win', ({ legacyAdapter }) => legacyAdapter);

// Lazy register legacy bookmakers if dependencies exist
try {
    const { SansabetV2Adapter } = require('../../../bookmakers/sansabet/node-adapter/SansabetV2Adapter.js');
    registerBookmakerAdapter('sansabet', ({ legacyAdapter, telegramConfig = {}, ingressConfig = {}, logger }) => (
        new SansabetV2Adapter({
            legacyAdapter,
            liveUrl: ingressConfig.analyzerLiveUrl || telegramConfig.analyzerLiveUrl,
            prematchUrl: ingressConfig.analyzerPrematchUrl || telegramConfig.analyzerPrematchUrl,
            catalogTimeoutMs: ingressConfig.catalogTimeoutMs || telegramConfig.catalogTimeoutMs,
            logger,
        })
    ));
} catch (e) {}

try {
    const { VBetV2Adapter } = require('../../../bookmakers/vbet/node-adapter/VBetV2Adapter.js');
    registerBookmakerAdapter('vbet', ({ legacyAdapter, logger }) => (
        new VBetV2Adapter({ legacyAdapter, logger })
    ));
} catch (e) {}

try {
    const { BetfairV2Adapter } = require('../../../bookmakers/betfair/node-adapter/BetfairV2Adapter.js');
    registerBookmakerAdapter('betfair', ({ legacyAdapter, config, logger }) => (
        new BetfairV2Adapter({ legacyAdapter, config, logger })
    ));
} catch (e) {}

module.exports = {
    normalizeBookmakerId,
    registerBookmakerAdapter,
    getRegisteredBookmakerIds,
    createBookmakerAdapter,
};
