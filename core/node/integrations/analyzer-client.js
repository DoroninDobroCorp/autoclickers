/**
 * Analyzer Client — HTTP client для получения value-пар от Analyzer
 * 
 * Extracted from auto_sansa/analyzer_poller.js (Story 2.3 / AUTO-CORE-3)
 * Original implementation: analyzer_poller.js (method fetchPairs, lines 58-95)
 * 
 * Implements CORE-REQ-02 from Story 1.5
 * 
 * @see docs/stories/1.5.story.md (CORE-REQ-02)
 * @see docs/stories/2.3.story.md (extraction story)
 * @see backend/autobetting/auto_sansa/analyzer_poller.js (original implementation)
 */

const http = require('http');

class AnalyzerClient {
  constructor(config = {}) {
    if (!config.url) {
      throw new Error('AnalyzerClient requires config.url');
    }
    this.url = config.url;
    this.timeout = config.timeout || 5000;
  }
  
  /**
   * Fetch value pairs from Analyzer API
   * 
   * Extracted from analyzer_poller.js (lines 58-95)
   * 
   * @param {Object} options - Optional query parameters (unused for now, URL contains query)
   * @returns {Promise<Object>} Response data object with outcomes array
   * @throws {Error} If request fails, times out, or response is invalid
   * 
   * @example
   * const client = new AnalyzerClient({ url: 'http://localhost:7005/pairs?min_roi=3' });
   * const result = await client.fetchPairs();
   * // => { outcomes: [{ pairFull: {...}, outcome: {...} }, ...] }
   */
  async fetchPairs(options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url);
      
      const requestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: this.timeout
      };
      
      const req = http.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.data || {});
          } catch (e) {
            reject(new Error(`Failed to parse Analyzer response: ${e.message}`));
          }
        });
      });
      
      req.on('error', (e) => {
        reject(new Error(`Analyzer request failed: ${e.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Analyzer request timeout (${this.timeout}ms)`));
      });
      
      req.end();
    });
  }
}

module.exports = { AnalyzerClient };
