/**
 * Logger Tests
 * Story 2.5: Full implementation
 */

const { Logger } = require('../utils/logger.js');

describe('Logger', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  
  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });
  
  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
  
  describe('Basic logging', () => {
    test('should log info message with timestamp and level', () => {
      const logger = new Logger();
      logger.info('Test info message');
      
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logMessage = consoleLogSpy.mock.calls[0][0];
      
      expect(logMessage).toMatch(/\[INFO\]/);
      expect(logMessage).toMatch(/Test info message/);
      expect(logMessage).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/); // ISO timestamp
    });
    
    test('should log warn message with correct level', () => {
      const logger = new Logger();
      logger.warn('Test warning');
      
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const logMessage = consoleWarnSpy.mock.calls[0][0];
      
      expect(logMessage).toMatch(/\[WARN\]/);
      expect(logMessage).toMatch(/Test warning/);
    });
    
    test('should log error message with correct level', () => {
      const logger = new Logger();
      logger.error('Test error');
      
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const logMessage = consoleErrorSpy.mock.calls[0][0];
      
      expect(logMessage).toMatch(/\[ERROR\]/);
      expect(logMessage).toMatch(/Test error/);
    });
    
    test('should log debug message when level is debug', () => {
      const logger = new Logger({ level: 'debug' });
      logger.debug('Debug message');
      
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logMessage = consoleLogSpy.mock.calls[0][0];
      
      expect(logMessage).toMatch(/\[DEBUG\]/);
      expect(logMessage).toMatch(/Debug message/);
    });
  });
  
  describe('Log levels filtering', () => {
    test('should not log debug when level is info', () => {
      const logger = new Logger({ level: 'info' });
      logger.debug('Should not appear');
      
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
    
    test('should log info and above when level is info', () => {
      const logger = new Logger({ level: 'info' });
      
      logger.debug('Should not appear');
      logger.info('Should appear');
      logger.warn('Should appear');
      logger.error('Should appear');
      
      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // info
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warn
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error
    });
    
    test('should log only error when level is error', () => {
      const logger = new Logger({ level: 'error' });
      
      logger.debug('Should not appear');
      logger.info('Should not appear');
      logger.warn('Should not appear');
      logger.error('Should appear');
      
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('Prefix support', () => {
    test('should include prefix in log messages', () => {
      const logger = new Logger({ prefix: 'SansabetDriver' });
      logger.info('Test message');
      
      const logMessage = consoleLogSpy.mock.calls[0][0];
      expect(logMessage).toMatch(/\[SansabetDriver\]/);
    });
    
    test('should work without prefix', () => {
      const logger = new Logger();
      logger.info('Test message');
      
      const logMessage = consoleLogSpy.mock.calls[0][0];
      expect(logMessage).not.toMatch(/\[\w+Driver\]/);
      expect(logMessage).toMatch(/\[INFO\] Test message/);
    });
  });
});
