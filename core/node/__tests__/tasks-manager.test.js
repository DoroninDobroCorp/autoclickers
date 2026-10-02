/**
 * Tests for TasksManager (Story 2.4)
 * 
 * Coverage: bookmakerId support, priority logic, match limits, migration
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TasksManager } = require('../tasks/tasks-manager.js');

describe('TasksManager', () => {
  let tempDir;
  let tasksFilePath;
  let manager;
  
  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
    tasksFilePath = path.join(tempDir, 'bet_tasks.json');
    
    manager = new TasksManager({
      tasksFilePath,
      maxHistoryAge: 3 * 24 * 60 * 60 * 1000,
      betting: {
        stake: 6,
        maxTotalPerMatch: 15,
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
          blockDurationMinutes: 15
        }
      }
    });
  });
  
  afterEach(() => {
    // Cleanup temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
  
  describe('bookmakerId validation and filtering', () => {
    test('should require bookmakerId field', () => {
      const task = {
        id: Date.now(),
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer'
      };
      
      expect(() => manager.addTask(task)).toThrow('bookmakerId');
    });
    
    test('should add task with bookmakerId', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      const result = manager.addTask(task);
      expect(result).toBe(true);
      
      const current = manager.getCurrentTask('sansabet');
      expect(current).toBeDefined();
      expect(current.bookmakerId).toBe('sansabet');
      expect(current.home).toBe('Team A');
    });
    
    test('should isolate tasks by bookmakerId', () => {
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'pinnacle',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.addTask(task2);
      
      const sansabetTask = manager.getCurrentTask('sansabet');
      const pinnacleTask = manager.getCurrentTask('pinnacle');
      
      expect(sansabetTask).toBeDefined();
      expect(sansabetTask.home).toBe('Team A');
      
      expect(pinnacleTask).toBeDefined();
      expect(pinnacleTask.home).toBe('Team C');
    });
    
    test('should migrate old tasks without bookmakerId', () => {
      // Manually create old-format file
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
            matchKey: 'old_match',
            outcome: 'T> 2.5',
            timestamp: Date.now() - 1000,
            status: 'completed',
            stake: 6
            // NO bookmakerId
          }
        ]
      };
      
      fs.writeFileSync(tasksFilePath, JSON.stringify(oldData, null, 2));
      
      // Create new manager - should auto-migrate
      const newManager = new TasksManager({
        tasksFilePath,
        betting: {}
      });
      
      const task = newManager.getCurrentTask('sansabet');
      expect(task).toBeDefined();
      expect(task.bookmakerId).toBe('sansabet'); // Auto-added
      
      const history = newManager.getHistory('sansabet');
      expect(history).toHaveLength(1);
      expect(history[0].bookmakerId).toBe('sansabet'); // Auto-added
    });
  });
  
  describe('getCurrentTask and getPendingTask filtering', () => {
    test('should return null for unknown bookmakerId', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      
      const result = manager.getCurrentTask('pinnacle');
      expect(result).toBeNull();
    });
    
    test('should return task for correct bookmakerId', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      
      const result = manager.getCurrentTask('sansabet');
      expect(result).toBeDefined();
      expect(result.bookmakerId).toBe('sansabet');
      expect(result.home).toBe('Team A');
    });
    
    test('should filter pending task by bookmakerId', () => {
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.startProcessing('sansabet');
      
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      manager.addTask(task2); // Should go to pending
      
      const pending = manager.getPendingTask('sansabet');
      expect(pending).toBeDefined();
      expect(pending.home).toBe('Team C');
      
      const pinnPending = manager.getPendingTask('pinnacle');
      expect(pinnPending).toBeNull();
    });
  });
  
  describe('markCompleted and markFailed with bookmakerId', () => {
    test('should mark task as completed and preserve bookmakerId', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      manager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      
      const history = manager.getHistory('sansabet');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
      expect(history[0].odds).toBe(2.5);
      expect(history[0].bookmakerId).toBe('sansabet');
    });
    
    test('should mark task as failed and preserve bookmakerId', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      manager.markFailed(task.id, { message: 'Test error', step: 'find_match', stepNumber: 1 });
      
      const history = manager.getHistory('sansabet');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toBe('Test error');
      expect(history[0].bookmakerId).toBe('sansabet');
    });
    
    test('should filter history by bookmakerId', () => {
      // Add tasks for different bookmakers
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'pinnacle',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.markCompleted(task1.id, { odds: 2.5, stake: 6 });
      
      manager.addTask(task2);
      manager.markCompleted(task2.id, { odds: 3.0, stake: 6 });
      
      const sansabetHistory = manager.getHistory('sansabet');
      const pinnacleHistory = manager.getHistory('pinnacle');
      
      expect(sansabetHistory).toHaveLength(1);
      expect(sansabetHistory[0].home).toBe('Team A');
      expect(sansabetHistory[0].bookmakerId).toBe('sansabet');
      
      expect(pinnacleHistory).toHaveLength(1);
      expect(pinnacleHistory[0].home).toBe('Team C');
      expect(pinnacleHistory[0].bookmakerId).toBe('pinnacle');
    });
  });
  
  describe('Priority logic (analyzer vs telegram)', () => {
    test('analyzer task should not replace telegram task in current', () => {
      const telegramTask = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      const analyzerTask = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(telegramTask);
      const result = manager.addTask(analyzerTask);
      
      expect(result).toBe(false); // Should be rejected
      
      const current = manager.getCurrentTask('sansabet');
      expect(current.source).toBe('telegram'); // Still telegram
      expect(current.home).toBe('Team A');
    });
    
    test('telegram task should replace analyzer task in current', () => {
      const analyzerTask = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      const telegramTask = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      manager.addTask(analyzerTask);
      const result = manager.addTask(telegramTask);
      
      expect(result).toBe(true);
      
      const current = manager.getCurrentTask('sansabet');
      expect(current.source).toBe('telegram'); // Replaced
      expect(current.home).toBe('Team C');
    });
    
    test('telegram task should wait in pending if processing', () => {
      const analyzerTask = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(analyzerTask);
      manager.startProcessing('sansabet');
      
      const telegramTask = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      const result = manager.addTask(telegramTask);
      expect(result).toBe(true);
      
      const pending = manager.getPendingTask('sansabet');
      expect(pending).toBeDefined();
      expect(pending.source).toBe('telegram');
      expect(pending.home).toBe('Team C');
    });
    
    test('analyzer should not replace another analyzer in current', () => {
      const analyzer1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      const analyzer2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(analyzer1);
      const result = manager.addTask(analyzer2);
      
      expect(result).toBe(false); // Should be rejected
      
      const current = manager.getCurrentTask('sansabet');
      expect(current.home).toBe('Team A'); // Still first analyzer
    });
  });
  
  describe('Match limits', () => {
    test('should enforce analyzer_normal limit per match', () => {
      const matchKey = 'team_a_team_b';
      
      // First task - 6 EUR
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.markCompleted(task1.id, { odds: 2.5, stake: 6 });
      
      // Second task - 6 EUR (total 12 < 15)
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'IT1> 0.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      const result2 = manager.addTask(task2);
      expect(result2).toBe(true);
      
      manager.markCompleted(task2.id, { odds: 3.0, stake: 6 });
      
      // Third task - 6 EUR (total would be 18 > 15)
      const task3 = {
        id: Date.now() + 2,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'H1 -1.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      const result3 = manager.addTask(task3);
      expect(result3).toBe(false); // Rejected - limit exceeded
    });
    
    test('should have separate limits for analyzer_high and telegram', () => {
      const matchKey = 'team_a_team_b';
      
      // Analyzer normal - 6 EUR
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.markCompleted(task1.id, { odds: 2.5, stake: 6 });
      
      // Analyzer high ROI - 7 EUR (separate limit!)
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'IT1> 0.5',
        source: 'analyzer',
        expectedROI: 20, // High ROI!
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      const result2 = manager.addTask(task2);
      expect(result2).toBe(true); // Allowed (separate limit)
      
      manager.markCompleted(task2.id, { odds: 3.0, stake: 7 });
      
      // Telegram - 10 EUR (separate limit!)
      const task3 = {
        id: Date.now() + 2,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'H1 -1.5',
        source: 'telegram',
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      const result3 = manager.addTask(task3);
      expect(result3).toBe(true); // Allowed (separate limit)
      
      // Total on match: 6 + 7 + 10 = 23 EUR (but limits are separate!)
    });

    test('should enforce global telegram hard-cap per match even when profile limit is higher', () => {
      const matchKey = 'team_a_team_b';
      const firstTask = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram',
        stake: 495,
        limitPolicy: { maxTotalPerMatch: 600 },
        matchKey,
        timestamp: Date.now()
      };
      const secondTask = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: '1',
        source: 'telegram',
        stake: 10,
        limitPolicy: { maxTotalPerMatch: 600 },
        matchKey,
        timestamp: Date.now()
      };

      expect(manager.addTask(firstTask)).toBe(true);
      expect(manager.markCompleted(firstTask.id, { odds: 2.5, stake: 495 })).toBe(true);
      expect(manager.addTask(secondTask)).toBe(false);
    });
    
    test('should not count testMode bets in limits', () => {
      const matchKey = 'team_a_team_b';
      
      // Test mode bet - should not count
      const testTask = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        testMode: true,
        timestamp: Date.now()
      };
      
      manager.addTask(testTask);
      manager.markCompleted(testTask.id, { odds: 2.5, stake: 6 });
      
      // Real bet - should be allowed (test bet doesn't count)
      const realTask = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'IT1> 0.5',
        source: 'analyzer',
        stake: 6,
        expectedROI: 10,
        matchKey: matchKey,
        testMode: false,
        timestamp: Date.now()
      };
      
      const result = manager.addTask(realTask);
      expect(result).toBe(true); // Allowed
    });
  });
  
  describe('Match blocking after failures', () => {
    test('should block match after 3 failures', () => {
      const matchKey = 'team_a_team_b';
      
      // Add 3 failed tasks
      for (let i = 0; i < 3; i++) {
        const task = {
          id: Date.now() + i,
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: 'T> 2.5',
          source: 'analyzer',
          matchKey: matchKey,
          timestamp: Date.now()
        };
        
        manager.addTask(task);
        manager.markFailed(task.id, { message: `Error ${i}`, step: 'find_match' });
      }
      
      // Fourth task should be blocked
      const task4 = {
        id: Date.now() + 100,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        matchKey: matchKey,
        timestamp: Date.now()
      };
      
      const result = manager.addTask(task4);
      expect(result).toBe(false); // Blocked
    });

    test('should not block match after approved telegram singles-blocked failures', () => {
      const matchKey = 'team_a_team_b';

      for (let i = 0; i < 3; i++) {
        const task = {
          id: Date.now() + i,
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: `${i + 1}`,
          source: 'telegram',
          sourceType: 'telegram',
          matchKey,
          timestamp: Date.now()
        };

        manager.addTask(task);
        manager.markFailed(task.id, {
          message: 'Singles blocked, no alternative outcomes',
          step: 'singles_blocked'
        });
      }

      const task4 = {
        id: Date.now() + 100,
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram',
        sourceType: 'telegram',
        matchKey,
        timestamp: Date.now()
      };

      const result = manager.addTask(task4);
      expect(result).toBe(true);
    });

    test('should not block match after approved telegram max-stake failures', () => {
      const matchKey = 'team_a_team_b';

      for (let i = 0; i < 3; i++) {
        const task = {
          id: Date.now() + i,
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: `${i + 1}`,
          source: 'telegram',
          sourceType: 'telegram',
          matchKey,
          timestamp: Date.now()
        };

        manager.addTask(task);
        manager.markFailed(task.id, {
          message: 'Maksimalna uplata za ovaj tiket je : 5,00 EUR',
          step: 'bet_submit'
        });
      }

      expect(manager.isMatchBlocked(matchKey)).toBe(false);
      expect(manager.getRecentlyFailedOutcomes(matchKey)).toEqual(new Set());
    });
  });
  
  describe('Atomic writes and race conditions', () => {
    test('should handle atomic writes correctly', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      
      // Verify file can be read without JSON parse errors
      const data = manager.read();
      expect(data).toHaveProperty('currentTasks');
      expect(data).toHaveProperty('pendingTasks');
      expect(data).toHaveProperty('history');
      expect(data.currentTasks['sansabet']).toBeDefined();
    });
    
    test('should preserve processing flag correctly', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task);
      manager.startProcessing('sansabet');
      
      // Verify processing flag
      let processing = manager.isProcessing('sansabet');
      expect(processing).toBe(true);
      
      // Try to add new task - should wait in pending
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task2);
      
      const pending = manager.getPendingTask('sansabet');
      expect(pending).toBeDefined();
      
      // Stop processing
      manager.stopProcessing('sansabet');
      processing = manager.isProcessing('sansabet');
      expect(processing).toBe(false);
    });
  });
  
  describe('Edge cases', () => {
    test('should handle empty task file gracefully', () => {
      // Remove the tasks file
      if (fs.existsSync(tasksFilePath)) {
        fs.unlinkSync(tasksFilePath);
      }
      
      const newManager = new TasksManager({
        tasksFilePath,
        betting: {}
      });
      
      const current = newManager.getCurrentTask('sansabet');
      expect(current).toBeNull();
    });
    
    test('should handle adding task without optional fields', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer'
        // No timestamp, no expectedROI, etc.
      };
      
      const result = manager.addTask(task);
      expect(result).toBe(true);
      
      const current = manager.getCurrentTask('sansabet');
      expect(current).toBeDefined();
      expect(current.createdAt).toBeDefined();
      expect(current.stake).toBeDefined();
    });
    
    test('should reject task with missing required fields', () => {
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A'
        // Missing away, outcome
      };
      
      const result = manager.addTask(task);
      expect(result).toBe(false);
    });
    
    test('should handle removeTask for non-existent task', () => {
      const result = manager.removeTask(999999);
      expect(result).toBe(false);
    });
    
    test('should remove task and move pending to current', () => {
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.startProcessing('sansabet');
      
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'telegram',
        timestamp: Date.now()
      };
      
      manager.addTask(task2); // Goes to pending
      manager.stopProcessing('sansabet');
      
      // Remove current task
      manager.removeTask(task1.id);
      
      // Pending should have moved to current
      const current = manager.getCurrentTask('sansabet');
      expect(current).toBeDefined();
      expect(current.id).toBe(task2.id);
    });
  });
  
  describe('Utility methods', () => {
    test('should get statistics correctly', () => {
      const task1 = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task1);
      manager.markCompleted(task1.id, { odds: 2.5, stake: 6 });
      
      const task2 = {
        id: Date.now() + 1,
        bookmakerId: 'sansabet',
        home: 'Team C',
        away: 'Team D',
        outcome: '1',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      manager.addTask(task2);
      manager.markFailed(task2.id, { message: 'Error' });
      
      const stats = manager.getStats();
      expect(stats.historyTotal).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(parseFloat(stats.successRate)).toBe(50.0);
    });
    
    test('should cleanup old history entries', (done) => {
      // Create manager with short history age
      const shortManager = new TasksManager({
        tasksFilePath,
        maxHistoryAge: 100, // 100ms
        betting: {}
      });
      
      const task = {
        id: Date.now(),
        bookmakerId: 'sansabet',
        home: 'Team A',
        away: 'Team B',
        outcome: 'T> 2.5',
        source: 'analyzer',
        timestamp: Date.now()
      };
      
      shortManager.addTask(task);
      shortManager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      
      // Wait for history to age
      setTimeout(() => {
        shortManager.cleanup();
        
        const history = shortManager.getHistory('sansabet');
        expect(history).toHaveLength(0); // Should be cleaned
        done();
      }, 150);
    });
    
    test('should clear all history', () => {
      // Add some tasks to history
      for (let i = 0; i < 3; i++) {
        const task = {
          id: Date.now() + i,
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: 'T> 2.5',
          source: 'analyzer',
          timestamp: Date.now()
        };
        
        manager.addTask(task);
        manager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      }
      
      let history = manager.getHistory('sansabet');
      expect(history.length).toBeGreaterThan(0);
      
      // Clear history
      manager.clearHistory();
      
      history = manager.getHistory('sansabet');
      expect(history).toHaveLength(0);
    });
    
    test('should get recent history', () => {
      // Add some tasks to history using telegram (high priority) to ensure all are added
      for (let i = 0; i < 5; i++) {
        const task = {
          id: Date.now() + i * 10, // Ensure unique IDs
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: 'T> 2.5',
          source: 'telegram', // Use telegram so they replace each other
          timestamp: Date.now()
        };
        
        manager.addTask(task);
        manager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      }
      
      const recent = manager.getRecentHistory(3);
      expect(recent).toHaveLength(3);
      // Should be in reverse order (most recent first)
      expect(recent[0].taskId).toBeGreaterThan(recent[1].taskId);
    });
    
    test('should handle history pagination', () => {
      // Add some tasks using telegram (high priority) to ensure all are added
      for (let i = 0; i < 5; i++) {
        const task = {
          id: Date.now() + i * 10, // Ensure unique IDs
          bookmakerId: 'sansabet',
          home: 'Team A',
          away: 'Team B',
          outcome: 'T> 2.5',
          source: 'telegram', // Use telegram so they replace each other
          timestamp: Date.now()
        };
        
        manager.addTask(task);
        manager.markCompleted(task.id, { odds: 2.5, stake: 6 });
      }
      
      const page1 = manager.getHistory('sansabet', { limit: 2, offset: 0 });
      const page2 = manager.getHistory('sansabet', { limit: 2, offset: 2 });
      
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].taskId).not.toBe(page2[0].taskId);
    });
  });

  describe('Error handling (coverage boost)', () => {
    test('should handle corrupted JSON gracefully', () => {
      // Write invalid JSON to file
      fs.writeFileSync(tasksFilePath, '{invalid json}');
      
      // Should return default structure without throwing
      const data = manager.read();
      
      expect(data).toEqual({
        currentTasks: {},
        pendingTasks: {},
        processing: {},
        history: []
      });
    });

    test('should handle atomicWrite errors gracefully', () => {
      // Create manager with invalid file path (cannot write)
      const invalidManager = new TasksManager({
        tasksFilePath: '/invalid/path/that/does/not/exist/tasks.json',
        maxHistoryAge: 3 * 24 * 60 * 60 * 1000,
        betting: {}
      });
      
      const data = {
        currentTasks: {},
        pendingTasks: {},
        processing: {},
        history: []
      };
      
      // Should not throw, just return false
      const result = invalidManager.atomicWrite(data);
      expect(result).toBe(false);
    });

    test('should handle cleanup with empty history', () => {
      // Ensure empty history
      manager.clearHistory();
      
      // Should not fail with empty history
      const result = manager.cleanup();
      
      expect(result).toBe(true);
      
      const history = manager.getHistory('sansabet');
      expect(history).toHaveLength(0);
    });
  });
});
