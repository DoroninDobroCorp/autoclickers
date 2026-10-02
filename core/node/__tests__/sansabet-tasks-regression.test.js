/**
 * Regression test for Sansabet TasksManager integration (Story 2.4)
 * 
 * Tests that auto_sansa wrapper works correctly with core TasksManager:
 * - bookmakerId is added automatically
 * - All existing workflows continue to function
 * - Migration from old format works correctly
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Import auto_sansa wrapper
const TasksManager = require('../../../bookmakers/sansabet/legacy-tasks/manager');

describe('Sansabet TasksManager Regression', () => {
  let tempDir;
  let tempConfigPath;
  let tempTasksPath;
  let originalDir;
  let manager;
  let originalBetTasksPath;
  let backupBetTasks;
  
  beforeEach(() => {
    // Save original directory
    originalDir = process.cwd();
    
    // Backup real bet_tasks.json (wrapper uses __dirname, not temp dir)
    originalBetTasksPath = null;
    if (originalBetTasksPath && fs.existsSync(originalBetTasksPath)) {
      backupBetTasks = fs.readFileSync(originalBetTasksPath, 'utf8');
    }
    
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sansabet-test-'));
    originalBetTasksPath = path.join(tempDir, 'bet_tasks.json');
    
    // Create minimal config.json
    const config = {
      betting: {
        stake: 6,
        maxTotalPerMatch: 15,
        minROI: 5.0,
        minOdds: 1.7,
        maxOdds: 4.0,
        highROI: {
          threshold: 15,
          stake: 7,
          maxTotalPerMatch: 20
        },
        telegram: {
          stake: 10,
          maxTotalPerMatch: 30,
          minOdds: 1.4,
          maxOdds: 10.0
        },
        protection: {
          maxFailedAttempts: 3,
          blockDurationMinutes: 15,
          historyRetentionDays: 3
        }
      }
    };
    
    tempConfigPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));
    
    // Create bet_tasks.json path
    tempTasksPath = path.join(tempDir, 'bet_tasks.json');
    
    // Clear real bet_tasks.json for clean test environment
    const emptyTasks = {
      currentTasks: {},
      pendingTasks: {},
      processing: {},
      history: []
    };
    fs.writeFileSync(originalBetTasksPath, JSON.stringify(emptyTasks, null, 2));
    
    // Mock __dirname for TasksManager
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    
    Module.prototype.require = function(id) {
      // Redirect config.json and bet_tasks.json to temp directory
      if (id.endsWith('config.json')) {
        return JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
      }
      return originalRequire.apply(this, arguments);
    };
    
    // Change to temp directory
    process.chdir(tempDir);
    
    // Create manager
    manager = new TasksManager();
    
    // Restore require
    Module.prototype.require = originalRequire;
  });
  
  afterEach(() => {
    // Restore directory
    process.chdir(originalDir);
    
    // Restore original bet_tasks.json
    if (backupBetTasks) {
      fs.writeFileSync(originalBetTasksPath, backupBetTasks);
    }
    
    // Cleanup temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
  
  describe('Basic workflow', () => {
    test('should add task without explicit bookmakerId', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram', // Use telegram to ensure it gets added
        expectedROI: 10
      };
      
      const result = manager.addTask(task);
      expect(result).toBe(true);
      
      const current = manager.getCurrentTask();
      expect(current).toBeDefined();
      expect(current.bookmakerId).toBe('sansabet');
      expect(current.home).toBe('Team A');
    });
    
    test('should get current task for Sansabet', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram' // Use telegram to ensure it gets added
      };
      
      manager.addTask(task);
      
      const current = manager.getCurrentTask();
      expect(current).toBeDefined();
      expect(current.bookmakerId).toBe('sansabet');
    });
    
    test('should handle processing flags', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram'
      };
      
      manager.addTask(task);
      
      expect(manager.isProcessing()).toBe(false);
      
      manager.startProcessing();
      expect(manager.isProcessing()).toBe(true);
      
      manager.stopProcessing();
      expect(manager.isProcessing()).toBe(false);
    });
    
    test('should mark task completed and add to history', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram'
      };
      
      manager.addTask(task);
      manager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      
      const stats = manager.getStats();
      expect(stats.completed).toBeGreaterThanOrEqual(1);
      
      const history = manager.getHistory({ limit: 10 });
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].bookmakerId).toBe('sansabet');
    });
    
    test('should mark task failed and add to history', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram'
      };
      
      manager.addTask(task);
      manager.markFailed(task.id, { message: 'Test error', step: 'find_match' });
      
      const stats = manager.getStats();
      expect(stats.failed).toBeGreaterThanOrEqual(1);
      
      const history = manager.getHistory({ limit: 10 });
      const failedTasks = history.filter(h => h.status === 'failed');
      expect(failedTasks.length).toBeGreaterThanOrEqual(1);
      expect(failedTasks[0].bookmakerId).toBe('sansabet');
    });
  });
  
  describe('Priority logic (backward compatibility)', () => {
    test('analyzer should not replace telegram', () => {
      const telegramTask = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram'
      };
      
      const analyzerTask = {
        id: Date.now() + 1,
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer'
      };
      
      manager.addTask(telegramTask);
      const result = manager.addTask(analyzerTask);
      
      expect(result).toBe(false);
      
      const current = manager.getCurrentTask();
      expect(current.source).toBe('telegram');
    });
    
    test('telegram should replace analyzer', () => {
      const analyzerTask = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer'
      };
      
      const telegramTask = {
        id: Date.now() + 1,
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'telegram'
      };
      
      manager.addTask(analyzerTask);
      manager.addTask(telegramTask);
      
      const current = manager.getCurrentTask();
      expect(current.source).toBe('telegram');
    });
  });
  
  describe('Migration from old format', () => {
    test('should migrate old bet_tasks.json without bookmakerId', () => {
      // Create old-format tasks file
      const oldData = {
        current: {
          id: 123,
          home: 'Team A',
          away: 'Team B',
          outcome: 'T> 2.5',
          source: 'analyzer',
          createdAt: Date.now()
          // NO bookmakerId
        },
        pending: null,
        processing: false,
        history: [
          {
            matchKey: 'team_a_team_b',
            outcome: 'T> 2.5',
            timestamp: Date.now() - 1000,
            status: 'completed',
            stake: 6,
            odds: 2.5
            // NO bookmakerId
          }
        ]
      };
      
      // Write to real bet_tasks.json (wrapper uses __dirname)
      fs.writeFileSync(originalBetTasksPath, JSON.stringify(oldData, null, 2));
      
      // Create new manager - should trigger migration
      const newManager = new TasksManager();
      
      const current = newManager.getCurrentTask();
      expect(current).toBeDefined();
      expect(current.bookmakerId).toBe('sansabet');
      
      const history = newManager.getHistory({ limit: 10 });
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].bookmakerId).toBe('sansabet');
    });
  });
  
  describe('read() API compatibility', () => {
    test('should return old format for backward compatibility', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram'
      };
      
      manager.addTask(task);
      
      const data = manager.read();
      
      // Should have old format structure
      expect(data).toHaveProperty('current');
      expect(data).toHaveProperty('pending');
      expect(data).toHaveProperty('processing');
      expect(data).toHaveProperty('history');
      
      // Current should be a task object with bookmakerId
      expect(data.current).toBeDefined();
      expect(data.current.bookmakerId).toBe('sansabet');
      expect(data.current.home).toBeDefined(); // Any home is fine
    });
  });
});
