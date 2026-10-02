/**
 * Logger — унифицированное логирование для всех драйверов
 * 
 * Created in Story 2.5 (greenfield)
 * Implements CORE-REQ-04 from Story 1.5
 * 
 * Provides logging with levels:
 * - DEBUG: Detailed debugging info (lowest priority)
 * - INFO: General informational messages
 * - WARN: Warning messages
 * - ERROR: Error messages (highest priority)
 * 
 * Usage:
 *   const { Logger } = require('@autobetting/core/utils');
 *   const logger = new Logger({ prefix: 'SansabetDriver' });
 *   logger.info('Starting bet placement');
 *   logger.error('Failed to find outcome');
 */

class Logger {
  constructor(options = {}) {
    this.level = options.level || process.env.LOG_LEVEL || 'info';
    this.prefix = options.prefix || '';
    
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
  }
  
  /**
   * Log debug message (lowest priority)
   * @param {string} message - Message to log
   */
  debug(message) {
    if (this._shouldLog('debug')) {
      this._log('DEBUG', message, console.log);
    }
  }
  
  /**
   * Log info message
   * @param {string} message - Message to log
   */
  info(message) {
    if (this._shouldLog('info')) {
      this._log('INFO', message, console.log);
    }
  }
  
  /**
   * Log warning message
   * @param {string} message - Message to log
   */
  warn(message) {
    if (this._shouldLog('warn')) {
      this._log('WARN', message, console.warn);
    }
  }
  
  /**
   * Log error message (highest priority)
   * @param {string} message - Message to log
   */
  error(message) {
    if (this._shouldLog('error')) {
      this._log('ERROR', message, console.error);
    }
  }
  
  /**
   * Check if message should be logged based on level
   * @private
   */
  _shouldLog(level) {
    const currentLevelValue = this.levels[this.level] !== undefined 
      ? this.levels[this.level] 
      : this.levels.info;
    const messageLevelValue = this.levels[level];
    return messageLevelValue >= currentLevelValue;
  }
  
  /**
   * Internal log method
   * @private
   */
  _log(level, message, logFn) {
    const timestamp = new Date().toISOString();
    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    const logMessage = `[${timestamp}] [${level}] ${prefix}${message}`;
    logFn(logMessage);
  }
}

module.exports = { Logger };
