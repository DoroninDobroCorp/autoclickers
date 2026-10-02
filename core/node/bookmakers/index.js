'use strict';

const { BookmakerAdapter } = require('./BookmakerAdapter.js');
let SansabetV2Adapter = null;
let VBetV2Adapter = null;
let BetfairV2Adapter = null;

try { SansabetV2Adapter = require('../../../bookmakers/sansabet/node-adapter/SansabetV2Adapter.js').SansabetV2Adapter; } catch (e) {}
try { VBetV2Adapter = require('../../../bookmakers/vbet/node-adapter/VBetV2Adapter.js').VBetV2Adapter; } catch (e) {}
try { BetfairV2Adapter = require('../../../bookmakers/betfair/node-adapter/BetfairV2Adapter.js').BetfairV2Adapter; } catch (e) {}

const {
    normalizeBookmakerId,
    registerBookmakerAdapter,
    getRegisteredBookmakerIds,
    createBookmakerAdapter,
} = require('./registry.js');

module.exports = {
    BookmakerAdapter,
    SansabetV2Adapter,
    VBetV2Adapter,
    BetfairV2Adapter,
    normalizeBookmakerId,
    registerBookmakerAdapter,
    getRegisteredBookmakerIds,
    createBookmakerAdapter,
};
