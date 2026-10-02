/**
 * Core Betting Module
 * 
 * Модульная архитектура:
 * - BaseBettor - оркестрация (~920 строк)
 * - BetProcessor - обработка одной ставки
 * - LimitsManager - управление лимитами
 * - BettorAdapter - базовый адаптер букмекера
 * - StabilityTracker - трекинг стабильности ROI
 * - FreshDataManager - управление свежими данными
 * 
 * Extracted modules:
 * - HealthServer - HTTP health endpoint
 * - StateManager - state persistence
 * - PollingManager - analyzer polling + filtering
 * - SessionManager - login, session refresh
 * - TaskBuilder - task object creation
 * - LockManager - process lock files
 * - constants - all magic numbers centralized
 */

const { BaseBettor } = require('./BaseBettor.js');
const { BettorAdapter, BetErrorTypes } = require('./BettorAdapter.js');
const { BetProcessor } = require('./BetProcessor.js');
const { LimitsManager } = require('./LimitsManager.js');
const { StabilityTracker } = require('./StabilityTracker.js');
const { FreshDataManager } = require('./FreshDataManager.js');

// Extracted modules
const { HealthServer } = require('./HealthServer.js');
const { StateManager } = require('./StateManager.js');
const { PollingManager } = require('./PollingManager.js');
const { SessionManager } = require('./SessionManager.js');
const { TaskBuilder } = require('./TaskBuilder.js');
const { acquireLock, releaseLock } = require('./LockManager.js');

const { CopilotSelfHealManager } = require('./CopilotSelfHealManager.js');

// Config
const constants = require('../config/constants.js');

module.exports = {
    // Core
    BaseBettor,
    BettorAdapter,
    BetErrorTypes,
    BetProcessor,
    LimitsManager,
    StabilityTracker,
    FreshDataManager,
    CopilotSelfHealManager,
    
    // Extracted
    HealthServer,
    StateManager,
    PollingManager,
    SessionManager,
    TaskBuilder,
    acquireLock,
    releaseLock,
    
    // Config
    constants
};
