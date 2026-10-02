/**
 * Calculator Client — HTTP client для отправки результатов ставок в Calculator
 * 
 * Extracted from auto_sansa/playwright_automation.js (Story 2.3 / AUTO-CORE-3)
 * Original implementation: playwright_automation.js (method sendToCalculatorAPI, lines 3625-3715)
 * 
 * Implements CORE-REQ-02 from Story 1.5
 * 
 * @see docs/stories/1.5.story.md (CORE-REQ-02)
 * @see docs/stories/2.3.story.md (extraction story)
 * @see backend/autobetting/auto_sansa/playwright_automation.js (original implementation)
 */

const http = require('http');

class CalculatorClient {
  constructor(config = {}) {
    this.baseUrl = config.url || `http://${config.baseUrl || 'localhost'}:${config.port || 7010}`;
    this.endpoint = '/log-bet-accept';
    this.timeout = config.timeout || 5000;
    this.userId = config.userId || 999;
  }
  
  /**
   * Log bet acceptance to Calculator API
   * 
   * Extracted from playwright_automation.js (lines 3625-3715)
   * 
   * @param {Object} betData - Bet result data
   * @param {Object} betData.task - Original task with pairFull
   * @param {number} betData.odds - Final odds (renamed from finalOdds)
   * @param {number} betData.stake - Actual stake (renamed from actualStake)
   * @returns {Promise<void>}
   * @throws {Error} If request fails or returns non-200 status
   * 
   * @example
   * const client = new CalculatorClient({ port: 7010 });
   * await client.logBetAccept({
   *   task: { 
   *     pairFull: { first: {...}, second: {...}, outcome: {...}, sportName: 'Football' },
   *     home: 'Team A',
   *     away: 'Team B'
   *   },
   *   odds: 2.5,
   *   stake: 10
   * });
   */
  async logBetAccept(betData = {}) {
    if (betData.isTest) {
      throw new Error('Calculator test-bet flow has been retired');
    }

    const { task, odds, stake, rawSnapshot } = betData;
    
    if (!task || !task.pairFull) {
      throw new Error('Calculator requires task.pairFull');
    }

    const resolveBetClock = () => {
      // FIX (2025-12-06): Use current time, not analyzer's createdAt
      // Old code used task.pairFull?.second?.createdAt which was stale
      const date = new Date();
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const seconds = String(date.getUTCSeconds()).padStart(2, '0');
      return `${minutes}:${seconds}`;
    };
    const betClock = resolveBetClock();
    
    // Calculator API expects nested structure: pair + bet + sum/coef/time/userId
    // FIX: task.pairFull.outcome is sorted by ROI desc — outcome[0] may differ from the actual bet outcome.
    // Use task.outcomeData (set by _updateTaskFromAnalyzer for the correct outcome) or find matching outcome.
    const outcomes = Array.isArray(task.pairFull.outcome) ? task.pairFull.outcome : [task.pairFull.outcome];
    const outcomeData = task.outcomeData
      || outcomes.find(o => o.outcome === task.outcome)
      || outcomes[0];
    
    const payload = {
      pair: {
        first: {
          bookmaker: task.pairFull.first.bookmaker || 'Unknown',
          leagueName: task.pairFull.first.leagueName || 'Unknown League',
          homeName: task.pairFull.first.homeName || task.home || 'Unknown',
          awayName: task.pairFull.first.awayName || task.away || 'Unknown',
          matchId: task.pairFull.first.matchId || task.pairFull.first.MatchID || '0',
          homeScore: task.pairFull.first.homeScore || 0,
          awayScore: task.pairFull.first.awayScore || 0,
          createdAt: task.pairFull.first.createdAt || new Date().toISOString(),
          matchDate: task.pairFull.first.matchDate || task.matchDate || null
        },
        second: {
          bookmaker: task.pairFull.second.bookmaker || 'Unknown',
          leagueName: task.pairFull.second.leagueName || 'Unknown League',
          homeName: task.pairFull.second.homeName || task.home || 'Unknown',
          awayName: task.pairFull.second.awayName || task.away || 'Unknown',
          matchId: task.pairFull.second.matchId || task.pairFull.second.MatchID || '0',
          homeScore: task.pairFull.second.homeScore || 0,
          awayScore: task.pairFull.second.awayScore || 0,
          createdAt: task.pairFull.second.createdAt || new Date().toISOString(),
          matchDate: task.pairFull.second.matchDate || null
        },
        outcome: {
          outcome: task.outcome || outcomeData?.outcome || 'Unknown',
          roi: outcomeData?.roi || 0,
          margin: outcomeData?.margin || 0,
          score1: {
            value: outcomeData?.score1?.value || odds,
            raw: outcomeData?.score1?.raw || null
          },
          score2: {
            value: outcomeData?.score2?.value || odds,
            raw: outcomeData?.score2?.raw || null
          },
          marketType: outcomeData?.marketType || 0
        },
        isLive: task.pairFull.isLive !== undefined ? task.pairFull.isLive : true,
        sportName: task.pairFull.sportName || task.sport || 'Unknown',
        createdAt: task.pairFull.createdAt || new Date().toISOString()
      },
      bet: {
        calcBet: {
          originalAmount: stake,
          adjustedAmount: stake,
          percentage: 100
        },
        usersCount: 1
      },
      sum: stake,
      coef: odds,
      time: betClock,
      userId: this.userId,
      strategy: betData.strategy || 'autobetting',
      rawSnapshot: rawSnapshot || null
    };
    
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      

      
      const url = new URL(this.baseUrl + this.endpoint);
      
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: this.timeout
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true });
          } else {
            reject(new Error(`Calculator API returned ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(new Error(`Calculator request failed: ${err.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Calculator request timeout (${this.timeout}ms)`));
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  /**
   * Check if strategy limit allows betting on this match
   * 
   * @param {Object} data - Check request
   * @param {string} data.keyMatch - Match key (Pinnacle-based)
   * @param {string} data.strategy - Strategy name (fast/slow/fast_high/slow_high)
   * @returns {Promise<Object>} { allowed: boolean, keyMatch: string, strategy: string }
   */
  async checkStrategyLimit(data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      
      const url = new URL(this.baseUrl + '/check-strategy-limit');
      
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: this.timeout
      };
      
      const req = http.request(options, (res) => {
        let responseData = '';
        
        res.on('data', chunk => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(responseData);
              resolve(result);
            } catch (e) {
              // On parse error, allow bet (fail-open)
              console.error(`[CalculatorClient.checkStrategyLimit] Parse error: ${e.message}`);
              resolve({ allowed: true, keyMatch: data.keyMatch, strategy: data.strategy });
            }
          } else {
            // On API error, allow bet (fail-open)
            console.error(`[CalculatorClient.checkStrategyLimit] API error ${res.statusCode}: ${responseData}`);
            resolve({ allowed: true, keyMatch: data.keyMatch, strategy: data.strategy });
          }
        });
      });
      
      req.on('error', (err) => {
        // On network error, allow bet (fail-open)
        console.error(`[CalculatorClient.checkStrategyLimit] Network error: ${err.message}`);
        resolve({ allowed: true, keyMatch: data.keyMatch, strategy: data.strategy });
      });
      
      req.on('timeout', () => {
        req.destroy();
        // On timeout, allow bet (fail-open)
        console.error(`[CalculatorClient.checkStrategyLimit] Timeout (${this.timeout}ms)`);
        resolve({ allowed: true, keyMatch: data.keyMatch, strategy: data.strategy });
      });
      
      req.write(postData);
      req.end();
    });
  }

  /**
   * Check comprehensive betting limits (global + bookmaker + strategy)
   * 
   * @param {Object} data - Limit check request
   * @param {string} data.keyMatch - Match key (Pinnacle-based)
   * @param {string} data.bookmaker - Bookmaker name (required, e.g. "Sansabet")
   * @param {string} data.strategy - Strategy name (optional, e.g. "fast", "slow")
   * @param {string} data.homeName - Home team (optional, for keyMatch generation)
   * @param {string} data.awayName - Away team (optional, for keyMatch generation)
   * @param {string} data.leagueName - League name (optional)
   * @param {string} data.sportName - Sport name (optional)
   * @param {number} data.odds - Odds for Kelly calculation (optional)
   * @param {number} data.expectedROI - Expected ROI for Kelly calculation (optional)
   * @returns {Promise<Object>} { allowed, reason, globalPercentUsed, remainingPercent, remainingAmount, kellyAmount, bookmakerBetsCount }
   */
  async checkBettingLimits(data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      
      const url = new URL(this.baseUrl + '/check-betting-limits');
      
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: this.timeout
      };
      
      const req = http.request(options, (res) => {
        let responseData = '';
        
        res.on('data', chunk => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(responseData);
              resolve(result);
            } catch (e) {
              // On parse error, allow bet (fail-open)
              console.error(`[CalculatorClient.checkBettingLimits] Parse error: ${e.message}`);
              resolve({ allowed: true, reason: 'parse_error', keyMatch: data.keyMatch, bookmaker: data.bookmaker });
            }
          } else {
            // On API error, allow bet (fail-open)
            console.error(`[CalculatorClient.checkBettingLimits] API error ${res.statusCode}: ${responseData}`);
            resolve({ allowed: true, reason: 'api_error', keyMatch: data.keyMatch, bookmaker: data.bookmaker });
          }
        });
      });
      
      req.on('error', (err) => {
        // On network error, allow bet (fail-open)
        console.error(`[CalculatorClient.checkBettingLimits] Network error: ${err.message}`);
        resolve({ allowed: true, reason: 'network_error', keyMatch: data.keyMatch, bookmaker: data.bookmaker });
      });
      
      req.on('timeout', () => {
        req.destroy();
        // On timeout, allow bet (fail-open)
        console.error(`[CalculatorClient.checkBettingLimits] Timeout (${this.timeout}ms)`);
        resolve({ allowed: true, reason: 'timeout', keyMatch: data.keyMatch, bookmaker: data.bookmaker });
      });
      
      req.write(postData);
      req.end();
    });
  }

  /**
   * Calculate suggested bet amount for match (check per-match limits)
   * 
   * @param {Object} data - Bet calculation request
   * @param {string} data.userId - User ID
   * @param {Object} data.pair - Pair data with first, second, outcome
   * @returns {Promise<Object>} Calculator response with calcBet.adjustedAmount
   */
  async calcBet(data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      
      const options = {
        hostname: new URL(this.baseUrl).hostname,
        port: new URL(this.baseUrl).port,
        path: '/calc-bet',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: this.timeout
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', chunk => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(data);
              resolve(result);
            } catch (e) {
              reject(new Error(`Calculator parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`Calculator returned ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(new Error(`Calculator request failed: ${err.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Calculator timeout (${this.timeout}ms)`));
      });
      
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { CalculatorClient };
