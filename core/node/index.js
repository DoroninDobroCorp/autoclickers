/**
 * Core Layer Entry Point
 * Exports all core modules for easy import
 * 
 * @see docs/stories/2.1.story.md
 */

module.exports = {
  // Parsers
  OutcomeParser: require('./parsers/outcome-parser.js'),
  
  // Integrations
  AnalyzerClient: require('./integrations/analyzer-client.js'),
  CalculatorClient: require('./integrations/calculator-client.js'),
  TelegramNotifier: require('./integrations/telegram-notifier.js'),
  
  // Tasks
  TasksManager: require('./tasks/tasks-manager.js'),
  TaskSource: require('./tasks/task-source.js'),
  
  // Telegram layer
  Telegram: require('./telegram'),
  
  // Utils
  Logger: require('./utils/logger.js'),
  ScreenshotManager: require('./utils/screenshot-manager.js'),
  
  // Interfaces
  BookmakerAutomationInterface: require('./interfaces/bookmaker-automation.js'),
  TaskSchema: require('./interfaces/task-schema.js')
};
