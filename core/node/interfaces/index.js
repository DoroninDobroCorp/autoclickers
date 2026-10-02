/**
 * Core Interfaces
 * 
 * Exports all interface definitions for autobetting system
 */

const { BookmakerAutomation, BetErrorCode } = require('./bookmaker-automation.js');
const { validateTask } = require('./task-schema.js');

module.exports = {
  BookmakerAutomation,
  BetErrorCode,
  validateTask
};
