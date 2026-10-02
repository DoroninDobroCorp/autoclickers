/**
 * ScreenshotManager — управление скриншотами для всех драйверов
 * 
 * Extracted from backend/autobetting/auto_sansa/playwright_automation.js
 * Original implementation: playwright_automation.js lines ~133-195
 * Enhanced in Story 2.5
 * Implements CORE-REQ-04 from Story 1.5
 * 
 * Provides screenshot management:
 * - Unique filenames with timestamp and taskId
 * - Automatic directory creation
 * - Cleanup of old screenshots
 * - Last screenshot path tracking
 * 
 * Usage:
 *   const { ScreenshotManager } = require('@autobetting/core/utils');
 *   const sm = new ScreenshotManager({ screenshotDir: './screenshots' });
 *   const path = await sm.capture(page, 'ERROR_bet_submit', task);
 *   await sm.cleanup(72); // Remove screenshots older than 72 hours
 * 
 * @see Story 2.5 (extraction and cleanup story)
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class ScreenshotManager {
  constructor(config = {}) {
    this.screenshotDir = config.screenshotDir || './debug_screenshots';
    this.maxAgeHours = config.maxAgeHours || 72;
    this.lastScreenshot = null;
    this.screenshotCount = 0;
  }
  
  /**
   * Capture screenshot from Playwright page
   * @param {Page} page - Playwright page object
   * @param {string} label - Screenshot label (e.g., "ERROR_bet_submit")
   * @param {Object} task - Optional task object with id/taskId property
   * @returns {Promise<string|null>} Path to screenshot or null on error
   */
  async capture(page, label, task = null) {
    try {
      // Create directory if not exists
      await fs.mkdir(this.screenshotDir, { recursive: true });
      
      // Unique filename: label + timestamp + taskId
      const timestamp = Date.now();
      const taskId = task?.id || task?.taskId || 'notask';
      const sanitizedLabel = label.replace(/[^a-z0-9]/gi, '_');
      
      // Format: ERROR_bet_submit_1731340800000_12345.png
      const filename = `${sanitizedLabel}_${timestamp}_${taskId}.png`;
      const filepath = path.join(this.screenshotDir, filename);
      
      await page.screenshot({ path: filepath, fullPage: true });
      
      // Save for later retrieval (e.g., Telegram)
      this.lastScreenshot = filepath;
      this.screenshotCount++;
      
      return filepath;
    } catch (e) {
      console.error('Screenshot error:', e.message);
      return null;
    }
  }
  
  /**
   * Cleanup old screenshots
   * @param {number} maxAgeHours - Maximum age in hours (default: from constructor)
   * @returns {Promise<number>} Number of deleted files
   */
  async cleanup(maxAgeHours = null) {
    try {
      const maxAge = (maxAgeHours || this.maxAgeHours) * 60 * 60 * 1000; // hours to ms
      const now = Date.now();
      
      // Check if directory exists
      if (!fsSync.existsSync(this.screenshotDir)) {
        return 0;
      }
      
      const files = await fs.readdir(this.screenshotDir);
      let deletedCount = 0;
      
      for (const file of files) {
        // Only process PNG files
        if (!file.endsWith('.png')) continue;
        
        const filepath = path.join(this.screenshotDir, file);
        const stats = await fs.stat(filepath);
        const age = now - stats.mtimeMs;
        
        if (age > maxAge) {
          await fs.unlink(filepath);
          deletedCount++;
        }
      }
      
      return deletedCount;
    } catch (e) {
      console.error('Cleanup error:', e.message);
      return 0;
    }
  }
  
  /**
   * Get path to last screenshot
   * @returns {string|null} Path to last screenshot or null
   */
  getLastPath() {
    return this.lastScreenshot;
  }
  
  /**
   * Get screenshot count
   * @returns {number} Number of screenshots taken
   */
  getCount() {
    return this.screenshotCount;
  }
}

module.exports = { ScreenshotManager };
