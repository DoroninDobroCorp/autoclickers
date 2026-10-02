/**
 * Telegram Notifier — отправка уведомлений о ставках в Telegram
 * 
 * Extracted from auto_sansa/telegram_notifier.js (Story 2.3 / AUTO-CORE-3)
 * Original implementation: telegram_notifier.js (methods sendMessage, notifyTask*, lines 33-210)
 * 
 * Implements CORE-REQ-02 from Story 1.5
 * 
 * @see docs/stories/1.5.story.md (CORE-REQ-02)
 * @see docs/stories/2.3.story.md (extraction story)
 * @see backend/autobetting/auto_sansa/telegram_notifier.js (original implementation)
 */

const https = require('https');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Bookmaker chat IDs for separate notification groups
// Fallback to main group if bookmaker-specific chat not accessible
const BOOKMAKER_CHAT_IDS = {
  'Volcano': -1003258349845,
  'Sansabet': -1003258349845,
  'Zlatnik': -1003258349845,
  'Lobbet': -1003258349845
};

// Bookmaker code prefixes for hashtags
const BOOKMAKER_CODES = {
  'Volcano': 'V',
  'Sansabet': 'S',
  'Zlatnik': 'Z',
  'Lobbet': 'L'
};

// Sport emoji mapping
function getSportEmoji(sportName) {
  if (!sportName) return '⚽';
  const s = sportName.toLowerCase();
  if (s.includes('basketball')) return '🏀';
  if (s.includes('tennis') && !s.includes('table')) return '🎾';
  if (s.includes('table tennis') || s.includes('tabletennis')) return '🏓';
  if (s.includes('handball')) return '🤾';
  if (s.includes('hockey')) return '🏒';
  if (s.includes('volleyball')) return '🏐';
  if (s.includes('esport')) return '🎮';
  if (s.includes('baseball')) return '⚾';
  if (s.includes('american football')) return '🏈';
  if (s.includes('futsal')) return '⚽';
  return '⚽';
}

// Path to persistent bet counters
const BET_COUNTERS_FILE = path.join(__dirname, '../../.bet_counters.json');

function normalizeChatIdList(chatIds = []) {
  const seen = new Set();
  const result = [];

  for (const chatId of Array.isArray(chatIds) ? chatIds : [chatIds]) {
    if (chatId === null || chatId === undefined || chatId === '') continue;
    const normalized = String(chatId);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

class TelegramNotifier {
  constructor(config = {}) {
    this.enabled = !!(config.botToken && config.logsChatId);
    if (!this.enabled) {
      this.botToken = config.botToken || '';
      this.logsChatId = config.logsChatId || '';
      this.subscribers = [];
      this.bookmakerChatIds = {};
      this.compactMode = false;
      this.allowedTargetChatIds = new Set();
      this.betCounters = {};
      this._skipCooldowns = new Map();
      return;
    }
    this.botToken = config.botToken;
    this.logsChatId = config.logsChatId;
    this.subscribers = config.subscribers || [];
    this.bookmakerChatIds = { ...BOOKMAKER_CHAT_IDS, ...(config.bookmakerChatIds || {}) };
    this.compactMode = config.compactMode === true;
    this.allowedTargetChatIds = new Set(normalizeChatIdList(
      config.allowedTargetChatIds || config.allowedChatIds || []
    ));
    this.betCounters = this._loadBetCounters();
    // 15-min cooldown per match for skip notifications
    this._skipCooldowns = new Map();
  }
  
  /**
   * Load bet counters from file
   * @private
   */
  _loadBetCounters() {
    try {
      if (fsSync.existsSync(BET_COUNTERS_FILE)) {
        return JSON.parse(fsSync.readFileSync(BET_COUNTERS_FILE, 'utf8'));
      }
    } catch (e) {
      console.warn('Failed to load bet counters, starting fresh:', e.message);
    }
    return {};
  }
  
  /**
   * Save bet counters to file
   * Re-reads file first to merge with other services' data (each bookmaker runs separately)
   * @private
   */
  _saveBetCounters() {
    try {
      // Re-read file to merge with other services' data
      let existing = {};
      if (fsSync.existsSync(BET_COUNTERS_FILE)) {
        try {
          existing = JSON.parse(fsSync.readFileSync(BET_COUNTERS_FILE, 'utf8'));
        } catch (e) {
          // File corrupted, start fresh
        }
      }
      // Merge: take max of each counter to avoid race conditions
      const merged = { ...existing };
      for (const [key, value] of Object.entries(this.betCounters)) {
        merged[key] = Math.max(merged[key] || 0, value);
      }
      // Update local counters with merged values
      this.betCounters = merged;
      // F1 (review_13): atomic write via tmp + rename so mid-write SIGKILL
      // cannot truncate the shared counters file.
      const tmpPath = BET_COUNTERS_FILE + '.tmp';
      fsSync.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
      fsSync.renameSync(tmpPath, BET_COUNTERS_FILE);
    } catch (e) {
      console.error('Failed to save bet counters:', e.message);
    }
  }
  
  /**
   * Get next bet number for bookmaker and increment counter
   * @param {string} bookmaker - Bookmaker name
   * @returns {number} Next bet number
   */
  getNextBetNumber(bookmaker) {
    const key = bookmaker || 'Unknown';
    if (!this.betCounters[key]) {
      this.betCounters[key] = 0;
    }
    this.betCounters[key]++;
    this._saveBetCounters();
    return this.betCounters[key];
  }
  
  /**
   * Get hashtag for bet (e.g., #Z00001 for Zlatnik bet #1)
   * @param {string} bookmaker - Bookmaker name
   * @param {number} betNumber - Bet number (if not provided, gets next)
   * @returns {string} Hashtag like #Z00001
   */
  getBetHashtag(bookmaker, betNumber = null) {
    const code = BOOKMAKER_CODES[bookmaker] || bookmaker?.charAt(0)?.toUpperCase() || 'X';
    const num = betNumber !== null ? betNumber : this.getNextBetNumber(bookmaker);
    return `#${code}${String(num).padStart(5, '0')}`;
  }
  
  /**
   * Get chat ID for bookmaker
   * @param {string} bookmaker - Bookmaker name
   * @returns {number} Chat ID or default logsChatId
   */
  getBookmakerChatId(bookmaker) {
    return this.bookmakerChatIds[bookmaker] || this.logsChatId;
  }

  _normalizeChatId(chatId) {
    if (chatId === null || chatId === undefined || chatId === '') return null;
    return String(chatId);
  }

  _isChatAllowed(chatId) {
    const normalized = this._normalizeChatId(chatId);
    if (!normalized) {
      return false;
    }
    if (!this.allowedTargetChatIds || this.allowedTargetChatIds.size === 0) {
      return true;
    }
    return this.allowedTargetChatIds.has(normalized);
  }

  _filterAllowedTargetChatIds(chatIds = []) {
    if (!this.allowedTargetChatIds || this.allowedTargetChatIds.size === 0) {
      return chatIds;
    }
    return chatIds.filter((chatId) => this.allowedTargetChatIds.has(String(chatId)));
  }

  _truncateCompactText(text, maxLength = 120) {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return '';
    }
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  _getCompactModeLabel(task = {}) {
    const normalizedMode = String(task.mode || '').trim().toLowerCase();
    if (task.isPrematch === true || normalizedMode === 'prematch') {
      return 'prematch';
    }
    if (task.isPrematch === false || normalizedMode === 'live') {
      return 'live';
    }
    return null;
  }

  _getCompactMatchLabel(task = {}) {
    const home = this.escapeHtml(task.home || '?');
    const away = this.escapeHtml(task.away || '?');
    return `${home} vs ${away}`;
  }

  _buildCompactDetailLine(parts = []) {
    return parts
      .map((part) => this._truncateCompactText(part))
      .filter(Boolean)
      .join(' | ');
  }

  _buildCompactStartedMessage(task = {}) {
    const detailParts = [
      this.escapeHtml(task.outcome || '?'),
      task.stake || 6.0 ? `${task.stake || 6.0} EUR` : null,
      this._getCompactModeLabel(task)
    ];
    return `🔵 ${this._getCompactMatchLabel(task)}\n${this._buildCompactDetailLine(detailParts)}`;
  }

  _buildCompactCompletedMessage(task = {}, result = {}) {
    const odds = result.odds || task.bookmakerOdds || task.expectedOdds || null;
    const stake = result.stake || task.stake || 6.0;
    const icon = result?.dryRun === true ? '🧪' : '✅';
    const detailParts = [
      this.escapeHtml(task.outcome || '?'),
      `${stake} EUR`,
      odds ? `@ ${odds}` : null
    ];
    return `${icon} ${this._getCompactMatchLabel(task)}\n${this._buildCompactDetailLine(detailParts)}`;
  }

  _buildCompactFailedMessage(task = {}, error = {}) {
    const detailParts = [
      this.escapeHtml(task.outcome || '?'),
      this.escapeHtml(error.step || 'failed'),
      this.escapeHtml(this._truncateCompactText(error.message || 'Unknown error', 90))
    ];
    return `❌ ${this._getCompactMatchLabel(task)}\n${this._buildCompactDetailLine(detailParts)}`;
  }

  _buildCompactSkippedMessage(task = {}, reason = '') {
    const detailParts = [
      this.escapeHtml(task.outcome || '?'),
      this.escapeHtml(this._truncateCompactText(reason || 'Skipped', 90))
    ];
    return `⏭️ ${this._getCompactMatchLabel(task)}\n${this._buildCompactDetailLine(detailParts)}`;
  }

  _collectTargetChatIds(options = {}) {
    const chatIds = [];
    const seen = new Set();
    const push = (chatId) => {
      const normalized = this._normalizeChatId(chatId);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      chatIds.push(normalized);
    };

    const explicitChatIds = Array.isArray(options.chatIds) ? options.chatIds : [];
    for (const chatId of explicitChatIds) push(chatId);
    // F1 defense-in-depth: when the caller declares the task is sourceReadOnly,
    // never inject the originChatId (which IS the read-only source chat) into
    // the outbound destination list, regardless of how the option was built.
    if (options.sourceReadOnly !== true) {
      push(options.originChatId);
    }

    // F1 (review_4): bookmaker default chat is a *legacy* destination for non-
    // Telegram-sourced tasks. For Telegram-scoped tasks (sourceReadOnly OR any
    // explicit feedback chat list) the per-profile feedback chats are the sole
    // operator surface; the global bookmaker chat would silently fan signals
    // out across cluster boundaries (vova/supernova → global Sansabet log).
    // Gate behind `includeBookmakerChat: true` opt-in for Telegram tasks; legacy
    // (non-Telegram) callers without feedback chats keep the previous default.
    const isTelegramScoped = options.sourceReadOnly === true || explicitChatIds.length > 0;
    const includeBookmakerChat = options.includeBookmakerChat === true ||
      (!isTelegramScoped && options.includeBookmakerChat !== false);
    if (options.bookmaker && includeBookmakerChat) {
      push(this.getBookmakerChatId(options.bookmaker));
    } else if (!options.bookmaker && explicitChatIds.length === 0 && !options.originChatId) {
      push(this.logsChatId);
    }

    if (options.includeLogsChat) {
      push(this.logsChatId);
    }

    for (const chatId of this.subscribers) {
      push(chatId);
    }

    // F2 (review_9): chat-level "do-not-write" invariant. Any chat that ANY
    // enabled profile classifies as a sourceChat / sourceTarget is filtered
    // out of the destination list, regardless of `task.telegramContext.
    // sourceReadOnly`. Defense-in-depth on top of the per-task flag — a
    // future profile config edit that flips sourceReadOnly off (or omits it)
    // can no longer cause lifecycle messages to leak back into the upstream
    // signal channel. Bypass requires an explicit `allowSourceChatWrite:
    // true` opt-in (which production code never passes).
    if (options.allowSourceChatWrite === true) {
      return chatIds;
    }
    const protectedSet = (this._chatProfileManager && typeof this._chatProfileManager.getKnownSourceChatIds === 'function')
      ? this._chatProfileManager.getKnownSourceChatIds()
      : null;
    if (protectedSet && protectedSet.size > 0) {
      return this._filterAllowedTargetChatIds(chatIds.filter((id) => !protectedSet.has(id)));
    }
    return this._filterAllowedTargetChatIds(chatIds);
  }

  _getRoutingOptionsForTask(task, bookmaker) {
    const feedbackChatIds = [
      ...(task.feedbackChatIds || []),
      ...(task.telegramContext?.feedbackChatIds || [])
    ];

    // Read-only source profiles (e.g. vova_cluster, supernova_cluster) ingest
    // signals from upstream operator channels we MUST NOT write to. For those
    // tasks the originChatId is the source chat itself, so suppress it from
    // outbound notification routing.
    const sourceReadOnly = task.telegramContext?.sourceReadOnly === true;
    const originChatId = sourceReadOnly
      ? null
      : (task.telegramContext?.originChatId || task.originChatId || null);

    // F2 (review_4): propagate the signalId so sendToAll can register the
    // resulting bot anchor message_ids back into the ingress draft index. This
    // makes "STOP" replies typed in the feedback chat against the queued/started
    // notice resolve to the draft even when no clarification was ever sent.
    const anchorSignalId = task.signalId || task.telegramContext?.signalId || null;

    return {
      bookmaker,
      chatIds: feedbackChatIds,
      originChatId,
      // F1 defense-in-depth: surface the flag to _collectTargetChatIds so any
      // future caller passing this options object (or shallow-merging extra
      // fields) cannot regress the source-chat suppression.
      sourceReadOnly,
      _anchorSignalId: anchorSignalId
    };
  }

  /**
   * Attach a TelegramPollingIngress reference so outbound task notices can
   * register their message_ids back into the draft index (F2). When set, every
   * successful sendToAll for a Telegram-sourced task creates an anchor that
   * a feedback-chat STOP reply can resolve, even before any clarification.
   */
  setIngress(ingress) {
    this._ingress = ingress || null;
    // F2 (review_9): if the ingress carries a chatProfileManager, latch it
    // for the chat-level "do-not-write" invariant in _collectTargetChatIds.
    // Explicit setChatProfileManager() still wins if called.
    if (ingress?.chatProfileManager && !this._chatProfileManager) {
      this._chatProfileManager = ingress.chatProfileManager;
    }
  }

  /**
   * F2 (review_9): supply the ChatProfileManager whose enabled profiles'
   * `sourceChatIds` / `sourceTargets` form the "do-not-write" set used by
   * `_collectTargetChatIds`. Defense-in-depth on top of the per-task
   * `sourceReadOnly` flag.
   */
  setChatProfileManager(chatProfileManager) {
    this._chatProfileManager = chatProfileManager || null;
  }
  
  /**
   * Escape HTML special characters for Telegram
   * @private
   */
  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  /**
   * Send message to specific chat with retry logic
   * 
   * Extracted from telegram_notifier.js (lines 33-67)
   * FIX (2025-11-16 23:30): Add retry logic for failed sends
   * 
   * @param {number|string} chatId - Telegram chat ID
   * @param {string} text - Message text (supports HTML)
   * @param {Object} options - { parse_mode: 'HTML', retries: 2 }
   * @returns {Promise<Object>} Telegram API response
   */
  async sendMessage(chatId, text, options = {}) {
    if (!this.enabled) return { ok: false, error: 'telegram_disabled' };
    if (!this._isChatAllowed(chatId)) {
      console.warn(`🚫 Telegram: blocked outbound message to disallowed chat ${chatId}`);
      return { ok: false, error: 'chat_not_allowed', description: `Chat ${chatId} is not in allowedTargetChatIds` };
    }
    const maxRetries = options.retries !== undefined ? options.retries : 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this._sendMessageOnce(chatId, text, options);
      
      if (result.ok) {
        if (attempt > 0) {
          console.log(`✅ Telegram: Message sent successfully after ${attempt} retries`);
        }
        return result;
      }
      
      lastError = result;
      
      // If rate limited, wait before retry
      if (result.error_code === 429 && attempt < maxRetries) {
        const retryAfter = result.parameters?.retry_after || 3;
        console.warn(`⏳ Telegram: Rate limited, waiting ${retryAfter}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt < maxRetries) {
        // For other errors, wait 1 second before retry
        console.warn(`⏳ Telegram: Retrying (${attempt + 1}/${maxRetries}) after error...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // All retries failed
    console.error(`❌ Telegram: Failed to send message after ${maxRetries} retries`);
    return lastError;
  }
  
  /**
   * Internal method: Send message once (no retry)
   * @private
   */
  async _sendMessageOnce(chatId, text, options = {}) {
    return new Promise((resolve) => {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: (options.parse_mode === null) ? undefined : (options.parse_mode || 'HTML'),
        disable_web_page_preview: true
      };

      if (options.reply_markup) {
        payload.reply_markup = options.reply_markup;
      }

      if (Number.isFinite(options.reply_to_message_id)) {
        payload.reply_to_message_id = options.reply_to_message_id;
      }

      if (Number.isFinite(options.message_thread_id)) {
        payload.message_thread_id = options.message_thread_id;
      }

      const data = JSON.stringify(payload);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            // FIX (2025-11-16 23:30): Log Telegram API errors
            if (!result.ok) {
              console.error(`❌ Telegram API error (chat ${chatId}): ${result.description || result.error_code || 'Unknown'}`);
              console.error(`   Message preview: ${text.substring(0, 100)}...`);
            }
            resolve(result);
          } catch (e) {
            console.error(`❌ Telegram parse error: ${e.message}`);
            resolve({ ok: false, error: e.message });
          }
        });
      });

      req.on('error', (e) => {
        console.error('Telegram send error:', e.message);
        resolve({ ok: false, error: e.message });
      });

      req.write(data);
      req.end();
    });
  }
  
  /**
   * Send message to all subscribers (logs chat + subscribers)
   * If bookmaker is specified, sends to bookmaker-specific chat instead of default
   * 
   * Extracted from telegram_notifier.js (lines 69-82)
   * FIX (2025-11-16 23:30): Add results logging
   * FIX (2025-11-30): Add bookmaker-specific chat routing
   * 
   * @param {string} text - Message text
   * @param {Object} options - Message options (including bookmaker for routing)
   * @returns {Promise<Array>} Array of results
   */
  async sendToAll(text, options = {}) {
    if (!this.enabled) return [];
    const results = [];
    const targetChatIds = this._collectTargetChatIds(options);

    for (const chatId of targetChatIds) {
      const result = await this.sendMessage(chatId, text, options);
      results.push(result);

      // F2 (review_4): index notifier-sent anchors back into the ingress
      // so a STOP reply typed against the queued/lifecycle notice in any
      // feedback chat resolves to the originating draft. We rely on the
      // Telegram API echo (result.result.chat.id, message_id, message_thread_id)
      // rather than the destination iterator to be robust to any per-chat
      // address normalization (-100... prefix, topic threads).
      const anchorSignalId = options._anchorSignalId || null;
      const indexer = this._ingress?.indexTaskAnchorMessage;
      if (anchorSignalId && indexer && result?.ok && result.result) {
        try {
          this._ingress.indexTaskAnchorMessage(anchorSignalId, {
            chatId: result.result.chat?.id ?? chatId,
            topicId: result.result.message_thread_id ?? null,
            messageId: result.result.message_id
          });
        } catch (_) { /* indexing is best-effort */ }
      }
    }
    
    // FIX (2025-11-16 23:30): Log summary of send results
    const failedCount = results.filter(r => !r.ok).length;
    if (failedCount > 0) {
      console.error(`⚠️ Telegram: ${failedCount}/${results.length} messages failed to send`);
    }
    
    return results;
  }
  
  /**
   * Send short notification to all chats
   * Used by BaseBettor for quick bet confirmations
   * 
   * @param {string} text - Short message text
   * @returns {Promise<Array>} Array of send results
   */
  async notifyShort(text) {
    return this.sendToAll(text);
  }
  
  /**
   * Send message to a specific chat ID
   * Used for targeted notifications (e.g., HIGH_ROI chat)
   * 
   * @param {number|string} chatId - Telegram chat ID
   * @param {string} text - Message text (HTML supported)
   * @param {Object} options - { parse_mode: 'HTML' }
   * @returns {Promise<Object>} Telegram API response
   */
  async sendToChat(chatId, text, options = {}) {
    return this.sendMessage(chatId, text, options);
  }
  
  /**
   * Notify about skipped bet (with 15-min per-match cooldown to avoid spam)
   */
  async notifySkipped(task, reason) {
    if (this.compactMode) {
      const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
      return this.sendToAll(this._buildCompactSkippedMessage(task, reason), this._getRoutingOptionsForTask(task, bookmaker));
    }
    const matchKey = task.matchKey || `${task.home}_${task.away}`;
    const now = Date.now();
    const lastNotify = this._skipCooldowns.get(matchKey) || 0;
    if (now - lastNotify < 15 * 60 * 1000) return []; // 15-min cooldown
    this._skipCooldowns.set(matchKey, now);
    
    // Cleanup old cooldowns (older than 30 min)
    for (const [key, ts] of this._skipCooldowns) {
      if (now - ts > 30 * 60 * 1000) this._skipCooldowns.delete(key);
    }
    
    const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
    const betType = task.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
    const sportEmoji = getSportEmoji(task.pair?.sportName || task.sport);
    
    const message = [
      `⏭️ <b>ПРОПУСК</b> [${betType}]`,
      `📋 Причина: <code>${this.escapeHtml(reason)}</code>`,
    ];
    
    if (task.pairFull?.first && task.pairFull?.second) {
      const first = task.pairFull.first;
      const second = task.pairFull.second;
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(first.bookmaker || 'Pinnacle')}:</b> ${this.escapeHtml(first.homeName)} vs ${this.escapeHtml(first.awayName)}`);
      message.push(`${sportEmoji} <b>${this.escapeHtml(second.bookmaker || 'Bookmaker')}:</b> ${this.escapeHtml(second.homeName)} vs ${this.escapeHtml(second.awayName)}`);
    } else if (task.home && task.away) {
      message.push(`${sportEmoji} ${this.escapeHtml(task.home)} vs ${this.escapeHtml(task.away)}`);
    }
    
    if (task.outcome) message.push(`🎯 Исход: <code>${this.escapeHtml(task.outcome)}</code>`);
    if (task.expectedROI) message.push(`📈 ROI: ${task.expectedROI.toFixed(2)}%`);
    
    return this.sendToAll(message.join('\n'), this._getRoutingOptionsForTask(task, bookmaker));
  }

  /**
   * Notify about task started
   * 
   * Extracted from telegram_notifier.js (lines 85-110)
   * FIX (2025-11-16 23:45): Show both bookmakers' match names and leagues
   * 
   * @param {Object} task - Task object
   * @returns {Promise<Array>} Array of send results
   */
  async notifyTaskStarted(task) {
    if (this.compactMode) {
      const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
      return this.sendToAll(this._buildCompactStartedMessage(task), this._getRoutingOptionsForTask(task, bookmaker));
    }
    // Determine bookmaker for routing
    const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
    const betType = task.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
    const sportEmoji = getSportEmoji(task.pair?.sportName || task.sport);
    
    const message = [
      `🔵 <b>ЗАДАЧА ПОЛУЧЕНА</b> [${betType}]`,
      '',
      `📋 ID: <code>${task.id}</code>`
    ];
    
    // FIX (2025-11-16 23:45): Show match names from BOTH bookmakers
    if (task.pairFull && task.pairFull.first && task.pairFull.second) {
      const first = task.pairFull.first;
      const second = task.pairFull.second;
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(first.bookmaker || 'Первая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(first.homeName)} vs ${this.escapeHtml(first.awayName)}`);
      if (first.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(first.leagueName)}`);
      }
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(second.bookmaker || 'Вторая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(second.homeName)} vs ${this.escapeHtml(second.awayName)}`);
      if (second.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(second.leagueName)}`);
      }
    } else {
      // Fallback: old format (if pairFull not available)
      message.push(`${sportEmoji} Матч: <b>${this.escapeHtml(task.home)}</b> vs <b>${this.escapeHtml(task.away)}</b>`);
      if (task.league) {
        message.push(`🏆 Лига: ${this.escapeHtml(task.league)}`);
      }
    }
    
    message.push('');
    message.push(`🎯 Исход: <code>${this.escapeHtml(task.outcome)}</code>`);
    message.push(`💰 Ставка: <b>${task.stake || 6.0} EUR</b>`);
    
    // Show both odds (Pinnacle and bookmaker)
    if (task.pinnacleOdds) {
      message.push(`📊 Pinnacle: <b>${task.pinnacleOdds}</b>`);
    }
    if (task.bookmakerOdds || task.expectedOdds) {
      message.push(`📊 Букмекер: <b>${task.bookmakerOdds || task.expectedOdds}</b>`);
    }
    if (task.margin !== undefined && task.margin !== null) {
      const marginMultiplier = typeof task.margin === 'number' ? (1 + task.margin / 100).toFixed(2) : task.margin;
      message.push(`📉 Маржа: <b>${marginMultiplier}</b>`);
    }
    if (task.expectedROI) {
      message.push(`📈 ROI: <b>${task.expectedROI.toFixed(2)}%</b>`);
    }

    message.push('');
    message.push(`🕐 ${new Date().toLocaleString('ru-RU')}`);
    message.push('⏳ <i>Обработка...</i>');

    return this.sendToAll(message.join('\n'), this._getRoutingOptionsForTask(task, bookmaker));
  }
  
  /**
   * Notify about task completed successfully
   * 
   * Extracted from telegram_notifier.js (lines 113-145)
   * FIX (2025-11-16 23:45): Show both bookmakers' match names and leagues
   * 
   * @param {Object} task - Task object
   * @param {Object} result - Result object with odds and stake
   * @returns {Promise<Array>} Array of send results
   */
  async notifyTaskCompleted(task, result) {
    if (this.compactMode) {
      const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
      return this.sendToAll(this._buildCompactCompletedMessage(task, result), this._getRoutingOptionsForTask(task, bookmaker));
    }
    // Determine bookmaker for routing and hashtag
    const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
    const hashtag = this.getBetHashtag(bookmaker);
    const betType = task.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
    const sportEmoji = getSportEmoji(task.pair?.sportName || task.sport);
    const isDryRun = result?.dryRun === true;
    
    const message = [
      isDryRun
        ? `🧪 <b>DRY RUN</b> ${hashtag} [${betType}]`
        : `✅ <b>СТАВКА РАЗМЕЩЕНА</b> ${hashtag} [${betType}]`,
      '',
      `📋 ID: <code>${task.id}</code>`
    ];

    if (isDryRun) {
      message.push('⚠️ <i>Тестовый прогон — ставка букмекеру не отправлялась</i>');
    }
    
    // FIX (2025-11-16 23:45): Show match names from BOTH bookmakers
    if (task.pairFull && task.pairFull.first && task.pairFull.second) {
      const first = task.pairFull.first;
      const second = task.pairFull.second;
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(first.bookmaker || 'Первая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(first.homeName)} vs ${this.escapeHtml(first.awayName)}`);
      if (first.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(first.leagueName)}`);
      }
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(second.bookmaker || 'Вторая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(second.homeName)} vs ${this.escapeHtml(second.awayName)}`);
      if (second.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(second.leagueName)}`);
      }
    } else {
      // Fallback: old format (if pairFull not available)
      message.push(`${sportEmoji} Матч: <b>${this.escapeHtml(task.home)}</b> vs <b>${this.escapeHtml(task.away)}</b>`);
      if (task.league) {
        message.push(`🏆 Лига: ${this.escapeHtml(task.league)}`);
      }
    }
    
    message.push('');
    message.push(`🎯 Исход: <code>${this.escapeHtml(task.outcome)}</code>`);
    message.push(`💰 Сумма: <b>${result.stake || task.stake || 6.0} EUR</b>`);
    
    // Show both odds (Pinnacle and actual placed)
    if (task.pinnacleOdds) {
      message.push(`📊 Pinnacle: <b>${task.pinnacleOdds}</b>`);
    }
    message.push(`📊 Коэф. ставки: <b>${result.odds || task.bookmakerOdds || task.expectedOdds || 'N/A'}</b>`);
    
    if (task.margin !== undefined && task.margin !== null) {
      const marginMultiplier = typeof task.margin === 'number' ? (1 + task.margin / 100).toFixed(2) : task.margin;
      message.push(`📉 Маржа: <b>${marginMultiplier}</b>`);
    }
    if (task.expectedROI) {
      message.push(`📈 ROI: <b>${task.expectedROI.toFixed(2)}%</b>`);
    }

    const actualOdds = result.odds || task.bookmakerOdds || task.expectedOdds;
    const actualStake = result.stake || task.stake || 6.0;
    if (actualOdds && actualStake) {
      const potentialWin = (actualOdds * actualStake).toFixed(2);
      const potentialProfit = (potentialWin - actualStake).toFixed(2);
      message.push(`💵 Возможный выигрыш: <b>${potentialWin} EUR</b> (прибыль: ${potentialProfit} EUR)`);
    }

    if (result.debugMode && !isDryRun) {
      message.push('');
      message.push('⚠️ <i>DEBUG режим - ставка не подтверждена</i>');
    }

    message.push('');
    message.push(`🕐 ${new Date().toLocaleString('ru-RU')}`);
    message.push('');
    message.push(isDryRun ? '🧪 <i>Ставка не отправлялась букмекеру</i>' : '✨ <i>Успешно!</i>');

    return this.sendToAll(message.join('\n'), this._getRoutingOptionsForTask(task, bookmaker));
  }

  /**
   * Get human-readable step description
   * 
   * Extracted from telegram_notifier.js (lines 148-161)
   * 
   * @param {string} step - Step identifier
   * @returns {string} Human-readable description
   */
  getStepDescription(step) {
    const descriptions = {
      'team_search': '🔍 Поиск матча в API букмекера',
      'page_load': '⏳ Загрузка страницы матча',
      'click_outcome': '🎯 Поиск и клик по исходу',
      'odds_validation': '📊 Проверка коэффициента (мин/макс лимиты)',
      'pinnacle_odds_filter': '📊 Фильтр коэффициента Pinnacle (мин/макс)',
      'pinnacle_verify': '🔒 Верификация PS3838 betslip (реальная цена)',
      'pinnacle_unavailable': '🚫 Pinnacle линия UNAVAILABLE — исход не найден в betslip',
      'singles_blocked': '🚫 Букмекер не разрешает синглы на этот исход',
      'stake_input': '💰 Ввод суммы ставки',
      'bet_submit': '🎰 Подтверждение ставки букмекером',
      'insufficient_balance': '🚫 Недостаточно средств',
      'payment': '💳 Оплата ставки',
      'payment_confirmation': '📝 Подтверждение оплаты',
      'fresh_data_validation': '📡 Проверка свежих данных',
      'data_stale': '⏰ Данные устарели перед ставкой',
      'roi_dropped': '📉 ROI упал ниже порога',
      'stale_data': '🔄 Анализатор вернул устаревшие данные',
      'outcome_not_found': '❓ Исход не найден у букмекера',
      'odds_mismatch': '💱 Коэфф. букмекера ≠ анализатора',
      'pre_flight_check': '🔐 Предварительная проверка (сессия/блокировка)',
      'bet_attempt_exception': '💥 Ошибка в процессе размещения ставки',
      'unknown': '🏁 Финальный этап',
      'undefined': '🏁 Финальный этап'
    };
    return descriptions[step] || `📍 ${step}`;
  }
  
  /**
   * Notify about task failed
   * 
   * Extracted from telegram_notifier.js (lines 163-210)
   * FIX (2025-11-16 23:45): Show both bookmakers' match names and leagues
   * 
   * @param {Object} task - Task object
   * @param {Error|Object} error - Error object with message, step, popupText, attempts
   * @returns {Promise<Array>} Array of send results
   */
  async notifyTaskFailed(task, error) {
    if (this.compactMode) {
      const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
      return this.sendToAll(this._buildCompactFailedMessage(task, error), this._getRoutingOptionsForTask(task, bookmaker));
    }
    // Use the same format as notifyTaskCompleted, but with failure header
    const bookmaker = task.pairFull?.second?.bookmaker || task.bookmaker || 'Unknown';
    const code = BOOKMAKER_CODES[bookmaker] || bookmaker?.charAt(0)?.toUpperCase() || 'X';
    const betType = task.isPrematch ? '⏰ PREMATCH' : '🔴 LIVE';
    const errorMsg = error.message || 'Unknown error';
    const sportEmoji = getSportEmoji(task.pair?.sportName || task.sport);
    
    const message = [
      `❌ <b>НЕУДАЧНАЯ ПОПЫТКА</b> #${code}_FAIL [${betType}]`,
      `⚠️ <code>${this.escapeHtml(errorMsg)}</code>`,
      '',
      `📋 ID: <code>${task.id}</code>`
    ];
    
    if (task.pairFull && task.pairFull.first && task.pairFull.second) {
      const first = task.pairFull.first;
      const second = task.pairFull.second;
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(first.bookmaker || 'Первая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(first.homeName)} vs ${this.escapeHtml(first.awayName)}`);
      if (first.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(first.leagueName)}`);
      }
      
      message.push('');
      message.push(`${sportEmoji} <b>${this.escapeHtml(second.bookmaker || 'Вторая контора')}:</b>`);
      message.push(`   ${this.escapeHtml(second.homeName)} vs ${this.escapeHtml(second.awayName)}`);
      if (second.leagueName) {
        message.push(`   🏆 ${this.escapeHtml(second.leagueName)}`);
      }
    } else {
      message.push(`${sportEmoji} Матч: <b>${this.escapeHtml(task.home)}</b> vs <b>${this.escapeHtml(task.away)}</b>`);
      if (task.league) {
        message.push(`🏆 Лига: ${this.escapeHtml(task.league)}`);
      }
    }
    
    message.push('');
    message.push(`🎯 Исход: <code>${this.escapeHtml(task.outcome)}</code>`);
    message.push(`💰 Сумма: <b>${task.stake || 6.0} EUR</b>`);
    
    if (task.pinnacleOdds) {
      message.push(`📊 Pinnacle: <b>${task.pinnacleOdds}</b>`);
    }
    message.push(`📊 Коэф. ставки: <b>${task.bookmakerOdds || task.expectedOdds || 'N/A'}</b>`);
    
    if (task.margin !== undefined && task.margin !== null) {
      const marginMultiplier = typeof task.margin === 'number' ? (1 + task.margin / 100).toFixed(2) : task.margin;
      message.push(`📉 Маржа: <b>${marginMultiplier}</b>`);
    }
    if (task.expectedROI) {
      message.push(`📈 ROI: <b>${task.expectedROI.toFixed(2)}%</b>`);
    }

    const actualOdds = task.bookmakerOdds || task.expectedOdds;
    const actualStake = task.stake || 6.0;
    if (actualOdds && actualStake) {
      const potentialWin = (actualOdds * actualStake).toFixed(2);
      const potentialProfit = (potentialWin - actualStake).toFixed(2);
      message.push(`💵 Возможный выигрыш: <b>${potentialWin} EUR</b> (прибыль: ${potentialProfit} EUR)`);
    }

    message.push('');
    message.push(`🕐 ${new Date().toLocaleString('ru-RU')}`);
    message.push('');
    message.push('❌ <i>Не удалось разместить</i>');

    return this.sendToAll(message.join('\n'), this._getRoutingOptionsForTask(task, bookmaker));
  }
}

// Singleton instance for getTelegramNotifier()
let instance = null;

// Default config (must be set via env vars)
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[TelegramNotifier] TELEGRAM_BOT_TOKEN env var is required');
}
const DEFAULT_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '';

/**
 * Get singleton TelegramNotifier instance
 * Uses default config or env vars
 */
function getTelegramNotifier(config = {}) {
  if (!instance) {
    instance = new TelegramNotifier({
      botToken: config.botToken || process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN,
      logsChatId: config.logsChatId || process.env.TELEGRAM_LOGS_CHAT_ID || DEFAULT_LOGS_CHAT_ID,
      subscribers: config.subscribers || [],
      bookmakerChatIds: config.bookmakerChatIds || {},
      compactMode: config.compactMode === true,
      allowedTargetChatIds: config.allowedTargetChatIds || config.allowedChatIds || []
    });
  } else {
    if (config.logsChatId !== undefined) {
      instance.logsChatId = config.logsChatId;
    }
    if (config.botToken !== undefined) {
      instance.botToken = config.botToken;
    }
    if (config.subscribers) {
      instance.subscribers = config.subscribers;
    }
    if (config.bookmakerChatIds) {
      instance.bookmakerChatIds = { ...instance.bookmakerChatIds, ...config.bookmakerChatIds };
    }
    if (config.compactMode !== undefined) {
      instance.compactMode = config.compactMode === true;
    }
    if (config.allowedTargetChatIds || config.allowedChatIds) {
      instance.allowedTargetChatIds = new Set(normalizeChatIdList(
        config.allowedTargetChatIds || config.allowedChatIds || []
      ));
    }
  }
  return instance;
}

module.exports = { TelegramNotifier, getTelegramNotifier, getSportEmoji };
