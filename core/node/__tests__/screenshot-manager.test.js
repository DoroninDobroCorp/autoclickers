/**
 * ScreenshotManager Tests
 * Story 2.5: Full implementation
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { ScreenshotManager } = require('../utils/screenshot-manager.js');

describe('ScreenshotManager', () => {
  let tempDir;
  let manager;
  let mockPage;
  
  beforeEach(async () => {
    // Create temp directory for test screenshots
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
    
    manager = new ScreenshotManager({
      screenshotDir: tempDir,
      maxAgeHours: 72
    });
    
    // Mock Playwright page
    mockPage = {
      screenshot: jest.fn().mockResolvedValue(undefined)
    };
  });
  
  afterEach(async () => {
    // Cleanup temp files
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });
  
  describe('capture()', () => {
    test('should create screenshot with correct filename format', async () => {
      const task = { id: 12345 };
      const filepath = await manager.capture(mockPage, 'ERROR_bet_submit', task);
      
      expect(filepath).toBeTruthy();
      expect(filepath).toMatch(/ERROR_bet_submit_\d+_12345\.png$/);
      expect(mockPage.screenshot).toHaveBeenCalledWith({
        path: filepath,
        fullPage: true
      });
    });
    
    test('should create directory if not exists', async () => {
      const nonExistentDir = path.join(tempDir, 'nested', 'screenshots');
      const manager2 = new ScreenshotManager({ screenshotDir: nonExistentDir });
      
      const filepath = await manager2.capture(mockPage, 'test', { id: 1 });
      
      expect(filepath).toBeTruthy();
      const dirExists = fsSync.existsSync(nonExistentDir);
      expect(dirExists).toBe(true);
    });
    
    test('should sanitize label (remove special chars)', async () => {
      const filepath = await manager.capture(mockPage, 'ERROR: bet/submit!', { id: 1 });
      
      expect(filepath).toMatch(/ERROR__bet_submit__\d+_1\.png$/);
    });
    
    test('should use "notask" if task is null', async () => {
      const filepath = await manager.capture(mockPage, 'test_label', null);
      
      expect(filepath).toMatch(/test_label_\d+_notask\.png$/);
    });
    
    test('should update lastScreenshot and count', async () => {
      expect(manager.getCount()).toBe(0);
      expect(manager.getLastPath()).toBeNull();
      
      const filepath = await manager.capture(mockPage, 'test', { id: 1 });
      
      expect(manager.getCount()).toBe(1);
      expect(manager.getLastPath()).toBe(filepath);
    });
    
    test('should handle screenshot errors gracefully', async () => {
      mockPage.screenshot = jest.fn().mockRejectedValue(new Error('Screenshot failed'));
      
      const filepath = await manager.capture(mockPage, 'test', { id: 1 });
      
      expect(filepath).toBeNull();
      expect(manager.getCount()).toBe(0); // Count should not increment on error
    });
    
    test('should support task.taskId property', async () => {
      const task = { taskId: 'task-67890' };
      const filepath = await manager.capture(mockPage, 'test', task);
      
      expect(filepath).toMatch(/test_\d+_task-67890\.png$/);
    });
  });
  
  describe('cleanup()', () => {
    test('should delete old files', async () => {
      // Create old file
      const oldFile = path.join(tempDir, 'old_screenshot.png');
      await fs.writeFile(oldFile, 'fake image data');
      
      // Set file modification time to 100 hours ago
      const hundredHoursAgo = Date.now() - (100 * 60 * 60 * 1000);
      await fs.utimes(oldFile, new Date(hundredHoursAgo), new Date(hundredHoursAgo));
      
      const deletedCount = await manager.cleanup(72); // 72 hours max age
      
      expect(deletedCount).toBe(1);
      
      const fileExists = fsSync.existsSync(oldFile);
      expect(fileExists).toBe(false);
    });
    
    test('should keep new files', async () => {
      // Create new file
      const newFile = path.join(tempDir, 'new_screenshot.png');
      await fs.writeFile(newFile, 'fake image data');
      
      const deletedCount = await manager.cleanup(72);
      
      expect(deletedCount).toBe(0);
      
      const fileExists = fsSync.existsSync(newFile);
      expect(fileExists).toBe(true);
    });
    
    test('should ignore non-png files', async () => {
      // Create non-PNG files
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'text');
      await fs.writeFile(path.join(tempDir, 'file.html'), '<html></html>');
      
      // Set old modification time
      const hundredHoursAgo = Date.now() - (100 * 60 * 60 * 1000);
      await fs.utimes(path.join(tempDir, 'file.txt'), new Date(hundredHoursAgo), new Date(hundredHoursAgo));
      
      const deletedCount = await manager.cleanup(72);
      
      expect(deletedCount).toBe(0); // Should not delete non-PNG files
    });
    
    test('should use constructor maxAgeHours by default', async () => {
      const manager2 = new ScreenshotManager({
        screenshotDir: tempDir,
        maxAgeHours: 48 // 48 hours
      });
      
      // Create file older than 48 hours but younger than 72 hours
      const oldFile = path.join(tempDir, 'mid_age.png');
      await fs.writeFile(oldFile, 'fake image data');
      const fiftyHoursAgo = Date.now() - (50 * 60 * 60 * 1000);
      await fs.utimes(oldFile, new Date(fiftyHoursAgo), new Date(fiftyHoursAgo));
      
      const deletedCount = await manager2.cleanup(); // No arg = use constructor value (48h)
      
      expect(deletedCount).toBe(1); // Should delete (older than 48h)
    });
    
    test('should return 0 if directory does not exist', async () => {
      const manager2 = new ScreenshotManager({
        screenshotDir: '/tmp/nonexistent-dir-12345'
      });
      
      const deletedCount = await manager2.cleanup();
      
      expect(deletedCount).toBe(0);
    });
  });
  
  describe('getLastPath() and getCount()', () => {
    test('should return null/0 initially', () => {
      expect(manager.getLastPath()).toBeNull();
      expect(manager.getCount()).toBe(0);
    });
    
    test('should return last screenshot path after capture', async () => {
      const path1 = await manager.capture(mockPage, 'first', { id: 1 });
      expect(manager.getLastPath()).toBe(path1);
      expect(manager.getCount()).toBe(1);
      
      const path2 = await manager.capture(mockPage, 'second', { id: 2 });
      expect(manager.getLastPath()).toBe(path2); // Updated to latest
      expect(manager.getCount()).toBe(2);
    });
  });
});
