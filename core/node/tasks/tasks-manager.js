/**
 * Tasks Manager — управление состоянием задач для всех букмекеров
 * 
 * Extracted from backend/autobetting/auto_sansa/bet_tasks_manager.js (Story 2.4)
 * Enhanced with multi-bookmaker support via task.bookmakerId field
 * 
 * Implements CORE-REQ-03 from Story 1.5 (TasksManager as common module)
 * Implements EXECUTOR-REQ-02 from Story 1.5 (task.bookmakerId support)
 * 
 * ЛОГИКА (from auto_sansa):
 * 1. НЕТ ОЧЕРЕДИ - только ОДНА текущая задача PER BOOKMAKER
 * 2. Новая задача ЗАМЕНЯЕТ старую (live betting = быстрые изменения)
 * 3. НО: Если задача обрабатывается - новая ждет в pending
 * 4. НЕСКОЛЬКО СТАВОК НА МАТЧ - разрешено (разные исходы)
 * 5. ЛИМИТ НА МАТЧ - общая сумма не более maxTotalPerMatch EUR
 * 
 * ЛОГИКА ПРИОРИТЕТОВ:
 * - ANALYZER (низкий приоритет): ставится ТОЛЬКО если processing=false И pending=null
 * - TELEGRAM (высокий приоритет): ЗАМЕНЯЕТ current или ждет в pending
 * 
 * NEW in Story 2.4: Multi-bookmaker support
 * - Каждая задача ОБЯЗАТЕЛЬНО имеет task.bookmakerId (валидация)
 * - getCurrentTask(bookmakerId) фильтрует по букмекеру
 * - История разделена по букмекерам
 * - Old tasks without bookmakerId auto-migrated to 'sansabet'
 * 
 * @see backend/autobetting/auto_sansa/bet_tasks_manager.js (original implementation)
 * @see docs/stories/2.4.story.md (extraction story)
 * @see docs/stories/1.5.story.md (architecture requirements)
 */

const fs = require('fs');
const path = require('path');
const { getResolvedSource, getTaskSourceKey } = require('./task-source.js');
const { getTaskLimitContext } = require('./task-limits.js');

class TasksManager {
  /**
   * @param {Object} config - Configuration object
   * @param {string} config.tasksFilePath - Path to tasks JSON file
   * @param {number} [config.maxHistoryAge] - Max age for history entries (ms), default 3 days
   * @param {Object} [config.betting] - Betting limits configuration
   */
  constructor(config) {
    if (!config || !config.tasksFilePath) {
      throw new Error('TasksManager requires config.tasksFilePath');
    }
    this.tasksFilePath = config.tasksFilePath;
    this.maxHistoryAge = config.maxHistoryAge || 3 * 24 * 60 * 60 * 1000; // 3 days
    this.betting = config.betting || {};
    
    this.ensureFileExists();
  }

  /**
   * Ensure tasks file exists with initial structure
   */
  ensureFileExists() {
    if (!fs.existsSync(this.tasksFilePath)) {
      this.atomicWrite({
        currentTasks: {},    // { bookmakerId: task | null }
        pendingTasks: {},    // { bookmakerId: task | null }
        processing: {},      // { bookmakerId: boolean }
        history: []
      });
    } else {
      // Migration and cleanup on startup
      const data = this.read();
      let needUpdate = false;
      
      // Check and clean stale tasks per bookmaker
      const now = Date.now();
      
      for (const bookmakerId in data.currentTasks) {
        const task = data.currentTasks[bookmakerId];
        if (task) {
          const age = now - (task.createdAt || 0);
          if (age > 30000) {
            console.log(`🧹 Clearing stale current task for ${bookmakerId}: ${task.id} (age: ${(age/1000).toFixed(1)}s)`);
            data.currentTasks[bookmakerId] = null;
            needUpdate = true;
          }
        }
        
        // Reset processing flags
        if (data.processing[bookmakerId]) {
          console.log(`🔓 Resetting processing flag for ${bookmakerId} (stuck from previous run)`);
          data.processing[bookmakerId] = false;
          needUpdate = true;
        }
      }
      
      for (const bookmakerId in data.pendingTasks) {
        const task = data.pendingTasks[bookmakerId];
        if (task) {
          const age = now - (task.createdAt || 0);
          if (age > 30000) {
            console.log(`🧹 Clearing stale pending task for ${bookmakerId}: ${task.id}`);
            data.pendingTasks[bookmakerId] = null;
            needUpdate = true;
          }
        }
      }
      
      if (needUpdate) {
        this.atomicWrite(data);
      }
    }
  }

  /**
   * Atomic file read with format migration
   * @returns {Object} Tasks data structure
   */
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tasksFilePath, 'utf8'));
      let migrated = false;
      
      // MIGRATION: Old single-bookmaker format → multi-bookmaker format
      if (data.current !== undefined || data.pending !== undefined || typeof data.processing === 'boolean') {
        console.log('🔄 Migrating from old single-bookmaker format to multi-bookmaker format');
        
        const newData = {
          currentTasks: {},
          pendingTasks: {},
          processing: {},
          history: data.history || []
        };
        
        // Migrate current task
        if (data.current) {
          const bookmakerId = data.current.bookmakerId || 'sansabet';
          if (!data.current.bookmakerId) {
            console.log('🔄 Adding bookmakerId=sansabet to current task');
            data.current.bookmakerId = bookmakerId;
          }
          newData.currentTasks[bookmakerId] = data.current;
          newData.processing[bookmakerId] = data.processing || false;
        }
        
        // Migrate pending task
        if (data.pending) {
          const bookmakerId = data.pending.bookmakerId || 'sansabet';
          if (!data.pending.bookmakerId) {
            console.log('🔄 Adding bookmakerId=sansabet to pending task');
            data.pending.bookmakerId = bookmakerId;
          }
          newData.pendingTasks[bookmakerId] = data.pending;
        }
        
        // Migrate history
        let historyMigrated = 0;
        newData.history = data.history.map(task => {
          if (!task.bookmakerId) {
            historyMigrated++;
            return { ...task, bookmakerId: 'sansabet' };
          }
          return task;
        });
        
        if (historyMigrated > 0) {
          console.log(`🔄 Migrated ${historyMigrated} history tasks: adding bookmakerId=sansabet`);
        }
        
        this.atomicWrite(newData);
        return newData;
      }
      
      // Already new format - just ensure structure
      data.currentTasks = data.currentTasks || {};
      data.pendingTasks = data.pendingTasks || {};
      data.processing = data.processing || {};
      data.history = data.history || [];
      
      return data;
    } catch (e) {
      console.error('❌ Failed to read tasks:', e.message);
      return { currentTasks: {}, pendingTasks: {}, processing: {}, history: [] };
    }
  }

  /**
   * Atomic file write using temp file + rename pattern
   * @param {Object} data - Tasks data structure
   * @returns {boolean} Success status
   */
  atomicWrite(data) {
    const tmpFile = this.tasksFilePath + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, this.tasksFilePath); // Atomic operation!
      return true;
    } catch (e) {
      console.error('❌ Failed to write tasks:', e.message);
      try { fs.unlinkSync(tmpFile); } catch {}
      return false;
    }
  }

  _isNonBlockingFailure(entry = {}) {
    if (!entry || entry.status !== 'failed' || entry.testMode) {
      return false;
    }

    const sourceType = entry.sourceType || null;
    const step = String(entry.step || '');
    const errorMessage = String(entry.error || '');
    const failureClass = String(entry.failureClass || '');
    const failureStage = String(entry.failureStage || '');

    if (sourceType !== 'telegram') {
      return false;
    }

    if (failureStage === 'design_stop' || /real submit disabled|submit disabled/i.test(errorMessage)) {
      return true;
    }

    if (failureClass === 'insufficient_balance' ||
        failureClass === 'account_limits_required' ||
        failureClass === 'selection_not_allowed' ||
        step === 'insufficient_balance' ||
        (failureStage === 'bookmaker_submit' && /insufficient balance|nemate dovoljno|dovoljno sred|requiredsessionlimits|tip nije dozvoljen|nije dozvoljen za klađenje|not allowed for betting/i.test(errorMessage))) {
      return true;
    }

    return step === 'singles_blocked' ||
      (step === 'bet_submit' && errorMessage.includes('Maksimalna uplata za ovaj tiket je : 5,00 EUR'));
  }

  _annotateFailureEntry(entry = {}) {
    if (!entry || entry.status !== 'failed') {
      return entry;
    }

    const annotated = { ...entry };
    const isNonBlockingFailure = this._isNonBlockingFailure(annotated);
    annotated.nonBlockingFailure = isNonBlockingFailure;

    if (!isNonBlockingFailure) {
      return annotated;
    }

    const step = String(annotated.step || '');
    const errorMessage = String(annotated.error || '');

    if (step === 'singles_blocked') {
      annotated.failureClass = 'singles_blocked';
    } else if (step === 'bet_submit' && errorMessage.includes('Maksimalna uplata za ovaj tiket je : 5,00 EUR')) {
      annotated.failureClass = 'safe_max_stake_reject';
    } else if (step === 'bet_submit' && /tip nije dozvoljen|nije dozvoljen za klađenje|not allowed for betting/i.test(errorMessage)) {
      annotated.failureClass = 'selection_not_allowed';
    } else if (!annotated.failureClass && step === 'insufficient_balance') {
      annotated.failureClass = 'insufficient_balance';
    }

    return annotated;
  }

  /**
   * ✅ FIX: Check if OUTCOME is blocked after failed attempts
   * NEW: Block specific outcome (matchKey + outcome), not entire match
   * @param {string} matchKey - Match identifier
   * @param {string} outcome - Outcome string (e.g., 'T> 2.5', '1', 'H1 -1.5')
   * @returns {boolean} True if outcome is blocked
   */
  isOutcomeBlocked(matchKey, outcome) {
    const data = this.read();
    const now = Date.now();
    const blockDuration = (this.betting.protection?.blockDurationMinutes || 15) * 60 * 1000;
    const maxAttempts = (this.betting.protection?.maxFailedAttempts || 3);
    
    // Find failed attempts for THIS SPECIFIC OUTCOME
    const recentFailures = data.history.filter(h => {
      const age = now - h.timestamp;
      return h.matchKey === matchKey && 
             h.outcome === outcome &&
             h.status === 'failed' && 
             !h.testMode &&
             !this._isNonBlockingFailure(h) &&
             age < blockDuration;
    });

    if (recentFailures.length >= maxAttempts) {
      const oldestFailure = Math.min(...recentFailures.map(f => f.timestamp));
      const timeLeft = Math.ceil((blockDuration - (now - oldestFailure)) / 60000);
      console.log(`🚫 OUTCOME ${matchKey} | ${outcome} blocked: ${recentFailures.length} failures in last ${this.betting.protection?.blockDurationMinutes}min (${timeLeft}min left)`);
      return true;
    }

    return false;
  }

  /**
   * Get outcomes that recently failed for a given match (for anti-circular-switch)
   * @param {string} matchKey - Match identifier
   * @param {number} windowMs - Time window to look back (default: 5 min)
   * @returns {Set<string>} Set of recently failed outcome names
   */
  getRecentlyFailedOutcomes(matchKey, windowMs = 5 * 60 * 1000) {
    const data = this.read();
    const now = Date.now();
    const failed = new Set();
    for (const h of data.history) {
      if (
        h.matchKey === matchKey &&
        h.status === 'failed' &&
        !h.testMode &&
        !this._isNonBlockingFailure(h) &&
        (now - h.timestamp) < windowMs
      ) {
        if (h.outcome) failed.add(h.outcome);
      }
    }
    return failed;
  }

  /**
   * Check if MATCH is blocked after ANY 3 failures (not necessarily different outcomes)
   * @param {string} matchKey - Match identifier
   * @returns {boolean} True if match is blocked
   */
  isMatchBlocked(matchKey) {
    const data = this.read();
    const now = Date.now();
    const matchBlockDuration = (this.betting.protection?.matchBlockDurationMinutes || 30) * 60 * 1000;
    const maxAttempts = (this.betting.protection?.maxFailedAttempts || 3);
    
    // Find ALL failed attempts on this match
    const recentFailures = data.history.filter(h => {
      const age = now - h.timestamp;
      return h.matchKey === matchKey && 
             h.status === 'failed' && 
             !h.testMode &&
             !this._isNonBlockingFailure(h) &&
             age < matchBlockDuration;
    });
    
    // Block if ANY 3 failures on the match (regardless of outcome)
    if (recentFailures.length >= maxAttempts) {
      const oldestFailure = Math.min(...recentFailures.map(f => f.timestamp));
      const timeLeft = Math.ceil((matchBlockDuration - (now - oldestFailure)) / 60000);
      const uniqueOutcomes = new Set(recentFailures.map(f => f.outcome));
      console.log(`🚫 MATCH ${matchKey} blocked: ${recentFailures.length} failures in last ${this.betting.protection?.matchBlockDurationMinutes || 30}min (${timeLeft}min left)`);
      console.log(`   Failed outcomes: ${Array.from(uniqueOutcomes).join(', ')}`);
      return true;
    }

    return false;
  }

  /**
   * Calculate total staked on match for specific limit bucket
   * @param {string} matchKey - Match identifier
   * @param {Object|string} limitContextOrCategory - Limit context or legacy bet category
   * @returns {number} Total staked amount
   */
  calculateMatchTotal(matchKey, limitContextOrCategory) {
    const data = this.read();
    const now = Date.now();
    const limitContext = this.resolveLimitContext(limitContextOrCategory);

    const completedBets = data.history.filter(h => {
      const age = now - h.timestamp;
      return h.matchKey === matchKey && 
             h.status === 'completed' && 
             age < this.maxHistoryAge &&
             !h.testMode &&
             this._getHistoryLimitProfileKey(h) === limitContext.limitProfileKey;
    });

    return completedBets.reduce((sum, h) => sum + (h.stake || 0), 0);
  }

  /**
   * Check match total limit for specific task/category
   * @param {string} matchKey - Match identifier
   * @param {number} newStake - New stake amount
   * @param {Object|string} limitContextOrCategory - Limit context or legacy bet category
   * @returns {boolean} True if within limit
   */
  checkMatchTotalLimit(matchKey, newStake, limitContextOrCategory) {
    const limitContext = this.resolveLimitContext(limitContextOrCategory);
    const maxTotal = limitContext.maxTotalPerMatch;
    const categoryName = limitContext.label;

    const totalStaked = this.calculateMatchTotal(matchKey, limitContext);
    const newTotal = totalStaked + newStake;

    if (newTotal > maxTotal) {
      console.log(`🚫 Match limit exceeded [${categoryName}]: ${matchKey}`);
      console.log(`   Category: ${categoryName}`);
      console.log(`   Total staked: ${totalStaked.toFixed(2)} EUR`);
      console.log(`   New stake: ${newStake.toFixed(2)} EUR`);
      console.log(`   Would be: ${newTotal.toFixed(2)} EUR > ${maxTotal} EUR (limit for ${categoryName})`);
      if (limitContext.limitProfileKey && limitContext.limitProfileKey !== limitContext.betCategory) {
        console.log(`   Limit bucket: ${limitContext.limitProfileKey}`);
      }
      return false;
    }

    // Log current state
    if (totalStaked > 0) {
      console.log(`💰 Match ${matchKey} [${categoryName}]: ${totalStaked.toFixed(2)} EUR staked`);
      console.log(`   New stake: ${newStake.toFixed(2)} EUR → Total: ${newTotal.toFixed(2)} EUR / ${maxTotal} EUR`);
      if (limitContext.limitProfileKey && limitContext.limitProfileKey !== limitContext.betCategory) {
        console.log(`   Limit bucket: ${limitContext.limitProfileKey}`);
      }
    }

    return true;
  }

  resolveLimitContext(taskOrCategory) {
    if (typeof taskOrCategory === 'string') {
      const betCategory = taskOrCategory;
      if (betCategory === 'telegram') {
        return {
          betCategory,
          limitProfileKey: 'telegram',
          maxTotalPerMatch: this.betting.telegram?.maxTotalPerMatch || 30,
          label: 'TELEGRAM'
        };
      }

      if (betCategory === 'analyzer_high') {
        return {
          betCategory,
          limitProfileKey: betCategory,
          maxTotalPerMatch: this.betting.highROI?.maxTotalPerMatch || 20,
          label: 'ANALYZER HIGH ROI'
        };
      }

      return {
        betCategory: 'analyzer_normal',
        limitProfileKey: 'analyzer_normal',
        maxTotalPerMatch: this.betting.maxTotalPerMatch || 15,
        label: 'ANALYZER ОБЫЧНЫЕ'
      };
    }

    if (taskOrCategory &&
        typeof taskOrCategory === 'object' &&
        taskOrCategory.limitProfileKey &&
        Number.isFinite(taskOrCategory.maxTotalPerMatch) &&
        taskOrCategory.label) {
      return taskOrCategory;
    }

    return getTaskLimitContext(taskOrCategory || {}, this.betting);
  }

  _getHistoryLimitProfileKey(entry = {}) {
    return entry.limitProfileKey || entry.betCategory || 'analyzer_normal';
  }

  /**
   * Check if high ROI bet
   * @param {number} roi - Expected ROI
   * @returns {boolean} True if high ROI
   */
  isHighROI(roi) {
    return roi >= (this.betting.highROI?.threshold || 15);
  }

  /**
   * Get stake amount based on task source and ROI
   * @param {Object} task - Task object
   * @returns {number} Stake amount
   */
  getStakeAmount(task) {
    const sourceMeta = getResolvedSource(task);

    if (sourceMeta.isTelegram) {
      return task.telegramPolicy?.stake ||
        task.sourcePolicy?.stake ||
        this.betting.telegram?.stake ||
        10;
    }
    
    if (this.isHighROI(task.expectedROI)) {
      return this.betting.highROI?.stake || 7;
    }
    return task.stake || this.betting.stake || 6;
  }
  
  /**
   * Determine bet category for limits
   * @param {Object} task - Task object
   * @returns {string} Bet category
   */
  getBetCategory(task) {
    const sourceMeta = getResolvedSource(task);

    if (sourceMeta.isTelegram) {
      return 'telegram';
    }
    
    if (this.isHighROI(task.expectedROI)) {
      return 'analyzer_high';
    }
    
    return 'analyzer_normal';
  }

  /**
   * Get min odds for task
   * @param {Object} task - Task object
   * @returns {number} Min odds
   */
  getMinOdds(task) {
    const sourceMeta = getResolvedSource(task);
    if (sourceMeta.isTelegram) {
      return task.telegramPolicy?.minOdds ||
        task.sourcePolicy?.minOdds ||
        this.betting.telegram?.minOdds ||
        1.7;
    }
    return this.betting.minOdds || 1.1;
  }

  /**
   * Get max odds for task
   * @param {Object} task - Task object
   * @returns {number} Max odds
   */
  getMaxOdds(task) {
    const sourceMeta = getResolvedSource(task);
    if (sourceMeta.isTelegram) {
      return task.telegramPolicy?.maxOdds ||
        task.sourcePolicy?.maxOdds ||
        this.betting.telegram?.maxOdds ||
        10.0;
    }
    return this.betting.maxOdds || 4.0;
  }

  _getTaskSignalId(task = {}) {
    return task.signalId || task.telegramContext?.signalId || null;
  }

  _findTaskLocation(data, predicate) {
    for (const [bookmakerId, task] of Object.entries(data.currentTasks || {})) {
      if (task && predicate(task, bookmakerId, 'current')) {
        return { slot: 'current', bookmakerId, task };
      }
    }

    for (const [bookmakerId, task] of Object.entries(data.pendingTasks || {})) {
      if (task && predicate(task, bookmakerId, 'pending')) {
        return { slot: 'pending', bookmakerId, task };
      }
    }

    return null;
  }

  getTaskLocationBySignalId(bookmakerId, signalId) {
    if (!signalId) {
      return null;
    }

    const data = this.read();
    return this._findTaskLocation(
      data,
      (task, taskBookmakerId) => taskBookmakerId === bookmakerId && this._getTaskSignalId(task) === signalId
    );
  }

  getTaskBySignalId(bookmakerId, signalId) {
    return this.getTaskLocationBySignalId(bookmakerId, signalId)?.task || null;
  }

  calculateTelegramExposure(matchKey, options = {}) {
    if (!matchKey) {
      return 0;
    }

    const data = options.data || this.read();
    const excludeTaskId = options.excludeTaskId || null;
    let total = 0;

    for (const entry of data.history || []) {
      if (
        entry.matchKey !== matchKey ||
        entry.sourceType !== 'telegram' ||
        entry.status !== 'completed' ||
        entry.testMode
      ) {
        continue;
      }
      total += Number(entry.stake || 0);
    }

    const currentAndPending = [
      ...Object.values(data.currentTasks || {}),
      ...Object.values(data.pendingTasks || {})
    ];

    for (const task of currentAndPending) {
      if (!task || task.id === excludeTaskId || task.matchKey !== matchKey) {
        continue;
      }

      if (!getResolvedSource(task).isTelegram) {
        continue;
      }

      if (task.testMode) {
        continue;
      }

      total += Number(task.stake || this.getStakeAmount(task) || 0);
    }

    return total;
  }

  checkTelegramExposureHardCap(matchKey, newStake, options = {}) {
    const hardCap = options.hardCap ??
      this.betting.telegram?.hardCapMaxTotalPerMatch ??
      this.betting.telegram?.maxExposureHardCap ??
      500;
    const stake = Number(newStake || 0);
    if (!Number.isFinite(stake) || stake <= 0) {
      return true;
    }

    const exposure = this.calculateTelegramExposure(matchKey, options);
    if (exposure + stake > hardCap) {
      console.log(`🚫 Telegram hard-cap exceeded: ${matchKey}`);
      console.log(`   Reserved exposure: ${exposure.toFixed(2)} EUR`);
      console.log(`   New stake: ${stake.toFixed(2)} EUR`);
      console.log(`   Would be: ${(exposure + stake).toFixed(2)} EUR > ${hardCap} EUR`);
      return false;
    }

    return true;
  }

  updateTask(taskId, updatedTask, options = {}) {
    const data = this.read();
    const location = this._findTaskLocation(data, (task) => task.id === taskId);
    if (!location) {
      return { updated: false, reason: 'task_not_found' };
    }

    if (location.slot === 'current' && data.processing[location.bookmakerId] && options.allowProcessingUpdate !== true) {
      return { updated: false, reason: 'task_processing' };
    }

    const currentTask = location.task;
    const nextTask = typeof updatedTask === 'function'
      ? updatedTask({ ...currentTask })
      : updatedTask;

    if (!nextTask || typeof nextTask !== 'object') {
      return { updated: false, reason: 'invalid_task_update' };
    }

    const mergedTask = {
      ...currentTask,
      ...nextTask,
      id: currentTask.id,
      bookmakerId: currentTask.bookmakerId,
      createdAt: currentTask.createdAt,
      updatedAt: Date.now(),
      sourcePolicy: {
        ...(currentTask.sourcePolicy || {}),
        ...(nextTask.sourcePolicy || {})
      },
      telegramPolicy: {
        ...(currentTask.telegramPolicy || {}),
        ...(nextTask.telegramPolicy || {})
      },
      limitPolicy: {
        ...(currentTask.limitPolicy || {}),
        ...(nextTask.limitPolicy || {})
      },
      telegramContext: {
        ...(currentTask.telegramContext || {}),
        ...(nextTask.telegramContext || {})
      }
    };

    const sourceMeta = getResolvedSource(mergedTask);
    mergedTask.sourceType = sourceMeta.sourceType;
    mergedTask.sourceVariant = mergedTask.sourceVariant || sourceMeta.sourceVariant || null;
    mergedTask.sourceProfileId = mergedTask.sourceProfileId || mergedTask.telegramContext?.profileId || null;
    mergedTask.source = getTaskSourceKey(mergedTask, {
      highROIThreshold: this.betting.highROI?.threshold || 15
    });
    mergedTask.matchKey = mergedTask.matchKey || currentTask.matchKey || `${mergedTask.home}_${mergedTask.away}`.toLowerCase().replace(/\s+/g, '_');
    mergedTask.signalId = this._getTaskSignalId(mergedTask);
    mergedTask.betCategory = this.resolveLimitContext(mergedTask).betCategory;
    mergedTask.limitProfileKey = mergedTask.limitProfileKey || this.resolveLimitContext(mergedTask).limitProfileKey;
    mergedTask.stake = mergedTask.stake || this.getStakeAmount(mergedTask);
    mergedTask.minOdds = mergedTask.minOdds || this.getMinOdds(mergedTask);
    mergedTask.maxOdds = mergedTask.maxOdds || this.getMaxOdds(mergedTask);

    if (
      sourceMeta.isTelegram &&
      !this.checkTelegramExposureHardCap(mergedTask.matchKey, mergedTask.stake, {
        data,
        excludeTaskId: mergedTask.id
      })
    ) {
      return { updated: false, reason: 'telegram_hard_cap_exceeded' };
    }

    if (location.slot === 'current') {
      data.currentTasks[location.bookmakerId] = mergedTask;
    } else {
      data.pendingTasks[location.bookmakerId] = mergedTask;
    }

    if (!this.atomicWrite(data)) {
      return { updated: false, reason: 'write_failed' };
    }

    return {
      updated: true,
      slot: location.slot,
      task: mergedTask
    };
  }

  markStopRequested(taskId, meta = {}) {
    return this.updateTask(taskId, (task) => ({
      ...task,
      stopRequested: true,
      stopRequestedAt: meta.timestamp || Date.now(),
      stopRequestedBy: meta.requestedBy || meta.requesterUserId || null,
      stopRequestedUsername: meta.requestedUsername || meta.requesterUsername || null
    }), { allowProcessingUpdate: true });
  }

  setTaskExecutionState(taskId, executionState, extra = {}) {
    return this.updateTask(taskId, (task) => ({
      ...task,
      executionState,
      ...extra,
      executionStateUpdatedAt: Date.now()
    }), { allowProcessingUpdate: true });
  }

  /**
   * Add task to queue (with bookmakerId validation and priority logic)
   * @param {Object} task - Task object (MUST have bookmakerId field)
   * @returns {boolean} True if added, false if rejected
   */
  addTask(task) {
    const data = this.read();
    
    // VALIDATION: bookmakerId is REQUIRED
    if (!task.bookmakerId) {
      throw new Error('Task must have bookmakerId field');
    }
    
    // Validate basic fields
    if (!task.id || !task.home || !task.away || !task.outcome) {
      console.error('❌ Invalid task:', task);
      return false;
    }

    // Generate matchKey
    task.matchKey = task.matchKey || `${task.home}_${task.away}`.toLowerCase().replace(/\s+/g, '_');
    task.createdAt = task.createdAt || Date.now();
    const sourceMeta = getResolvedSource(task);
    task.sourceType = sourceMeta.sourceType;
    task.sourceVariant = task.sourceVariant || sourceMeta.sourceVariant || null;
    task.sourceProfileId = task.sourceProfileId || task.telegramContext?.profileId || null;
    task.signalId = this._getTaskSignalId(task);
    task.source = getTaskSourceKey(task, {
      highROIThreshold: this.betting.highROI?.threshold || 15
    });
    
    // Set ROI for telegram tasks
    if (task.sourceType === 'telegram' && (task.expectedROI === null || task.expectedROI === undefined)) {
      task.expectedROI = 20;
    }
    
    // Determine category
    const limitContext = this.resolveLimitContext(task);
    task.betCategory = limitContext.betCategory;
    task.limitProfileKey = task.limitProfileKey || limitContext.limitProfileKey;
    task.limitPolicy = task.limitPolicy || limitContext.limitPolicy || {};
    task.isHighROI = this.isHighROI(task.expectedROI);
    // Don't override stake if already set by caller
    task.stake = task.stake || this.getStakeAmount(task);
    task.minOdds = task.minOdds || this.getMinOdds(task);
    task.maxOdds = task.maxOdds || this.getMaxOdds(task);
    const bookmakerId = task.bookmakerId;
    const current = data.currentTasks[bookmakerId];
    const pending = data.pendingTasks[bookmakerId];
    const processing = data.processing[bookmakerId] || false;

    // Check if MATCH is blocked (any 3 failures on the match)
    if (this.isMatchBlocked(task.matchKey)) {
      return false;
    }

    // Check match total limit
    if (!this.checkMatchTotalLimit(task.matchKey, task.stake, limitContext)) {
      return false;
    }

    if (sourceMeta.isTelegram) {
      const replaceableCurrentTaskId = !processing ? current?.id || null : null;
      if (!this.checkTelegramExposureHardCap(task.matchKey, task.stake, { data, excludeTaskId: replaceableCurrentTaskId })) {
        return false;
      }
      task.executionState = task.executionState || 'queued';
      task.stopRequestedAt = task.stopRequestedAt || null;
    }

    // Log category
    const categoryLabels = {
      'analyzer_normal': 'ANALYZER ОБЫЧНЫЕ',
      'analyzer_high': 'ANALYZER HIGH ROI',
      'telegram': 'TELEGRAM'
    };
    const categoryLabel = categoryLabels[task.betCategory] || task.betCategory;
    
    console.log(`💼 [${categoryLabel}] [${task.bookmakerId}] ${task.home} vs ${task.away} | ${task.outcome}`);
    const roiLabel = Number.isFinite(task.expectedROI) ? task.expectedROI.toFixed(2) : 'N/A';
    console.log(`   Source: ${task.source}, Stake: ${task.stake} EUR, ROI: ${roiLabel}%`);

    // PRIORITY LOGIC (per bookmaker)
    if (task.sourceType === 'analyzer') {
      // ANALYZER = LOW PRIORITY
      // ✅ FIX: NEVER add if there's ANY current task (regardless of source)
      // No queue, no replacement - only add if slot is empty
      
      if (processing) {
        console.log(`❌ [ANALYZER] Task ${task.id} rejected: system is busy processing ${current?.id || 'unknown'}`);
        return false;
      }
      
      if (pending) {
        console.log(`❌ [ANALYZER] Task ${task.id} rejected: pending task ${pending.id} from ${pending.source} is waiting`);
        return false;
      }
      
      // ✅ NEW LOGIC: Reject if ANY current task exists (analyzer NEVER replaces)
      if (current) {
        console.log(`❌ [ANALYZER] Task ${task.id} rejected: current task ${current.id} from ${current.source} is active (analyzer NEVER replaces anything)`);
        return false;
      }
      
      // Only if current === null - slot is empty
      console.log(`✅ [ANALYZER] Task ${task.id} set as current (slot was empty)`);
      data.currentTasks[bookmakerId] = task;
      
    } else {
      // TELEGRAM/other = HIGH PRIORITY
      // Can replace analyzer, waits in pending if processing
      const sourceLabel = (task.sourceType || task.source || 'task').toUpperCase();
      
      if (processing) {
        // Processing - wait in pending
        if (pending) {
          console.log(`🔄 [${sourceLabel}] Replacing pending task ${pending.id} with new task ${task.id} (keeping latest)`);
        } else {
          console.log(`⏳ [${sourceLabel}] Current task is processing, new task ${task.id} will wait in pending`);
        }
        data.pendingTasks[bookmakerId] = task;
        
      } else {
        // Not processing - replace current (even analyzer!)
        if (current) {
          const replacingSource = current.source || 'unknown';
          console.log(`🔄 [${sourceLabel}] Replacing current ${replacingSource} task ${current.id} with new task ${task.id}`);
        } else {
          console.log(`✅ [${sourceLabel}] Setting new task ${task.id} as current`);
        }
        data.currentTasks[bookmakerId] = task;
      }
    }

    return this.atomicWrite(data);
  }

  /**
   * Get current task for specific bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   * @returns {Object|null} Current task or null
   */
  getCurrentTask(bookmakerId) {
    const data = this.read();
    return data.currentTasks[bookmakerId] || null;
  }

  /**
   * Get pending task for specific bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   * @returns {Object|null} Pending task or null
   */
  getPendingTask(bookmakerId) {
    const data = this.read();
    return data.pendingTasks[bookmakerId] || null;
  }

  findTaskBySignalId(signalId, bookmakerId = null) {
    if (!signalId) {
      return null;
    }

    const data = this.read();
    const matchesBookmaker = (bkId) => !bookmakerId || bkId === bookmakerId;
    const hasSignalId = (task) => (
      task?.signalId === signalId ||
      task?.telegramContext?.signalId === signalId
    );

    for (const [bkId, task] of Object.entries(data.currentTasks)) {
      if (matchesBookmaker(bkId) && task && hasSignalId(task)) {
        return { bookmakerId: bkId, location: 'current', task };
      }
    }

    for (const [bkId, task] of Object.entries(data.pendingTasks)) {
      if (matchesBookmaker(bkId) && task && hasSignalId(task)) {
        return { bookmakerId: bkId, location: 'pending', task };
      }
    }

    return null;
  }

  updateTaskById(taskId, updates = {}) {
    return this.updateTask(taskId, updates).updated === true;
  }

  updateTaskBySignalId(signalId, updates = {}, bookmakerId = null) {
    const found = this.findTaskBySignalId(signalId, bookmakerId);
    if (!found?.task?.id) {
      return false;
    }

    return this.updateTaskById(found.task.id, updates);
  }

  removeTaskById(taskId) {
    if (!taskId) {
      return false;
    }

    const data = this.read();

    for (const [bookmakerId, task] of Object.entries(data.currentTasks)) {
      if (task?.id === taskId) {
        const pending = data.pendingTasks[bookmakerId];
        if (pending) {
          data.currentTasks[bookmakerId] = pending;
          data.pendingTasks[bookmakerId] = null;
        } else {
          data.currentTasks[bookmakerId] = null;
        }
        data.processing[bookmakerId] = false;
        return this.atomicWrite(data);
      }
    }

    for (const [bookmakerId, task] of Object.entries(data.pendingTasks)) {
      if (task?.id === taskId) {
        data.pendingTasks[bookmakerId] = null;
        return this.atomicWrite(data);
      }
    }

    return false;
  }

  /**
   * Start processing a task for bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   */
  startProcessing(bookmakerId = 'sansabet') {
    const data = this.read();
    data.processing[bookmakerId] = true;
    return this.atomicWrite(data);
  }

  /**
   * Stop processing a task for bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   */
  stopProcessing(bookmakerId = 'sansabet') {
    const data = this.read();
    data.processing[bookmakerId] = false;
    return this.atomicWrite(data);
  }

  /**
   * Check if currently processing for bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   * @returns {boolean} Processing status
   */
  isProcessing(bookmakerId = 'sansabet') {
    const data = this.read();
    return data.processing[bookmakerId] || false;
  }

  /**
   * Mark task as completed and move to history
   * @param {number} taskId - Task ID
   * @param {Object} result - Result object { odds, stake, attempts, ... }
   * @returns {boolean} Success status
   */
  markCompleted(taskId, result = {}) {
    const data = this.read();
    
    // Find task in currentTasks
    let task = null;
    let bookmakerId = null;
    
    for (const [bkId, t] of Object.entries(data.currentTasks)) {
      if (t && t.id === taskId) {
        task = t;
        bookmakerId = bkId;
        break;
      }
    }
    
    if (!task) {
      console.warn(`⚠️ Task ${taskId} not found or already removed`);
      return false;
    }

    const timestamp = Date.now();

    // Add to history
    data.history.push({
      matchKey: task.matchKey,
      outcome: task.outcome,
      timestamp: timestamp,
      status: 'completed',
      odds: result.odds,
      stake: result.stake || task.stake,
      ticketId: result.ticketId,
      dryRun: result.dryRun === true || task._dryRunCompleted === true,
      home: task.home,
      away: task.away,
      taskId: task.id,
      source: task.source || 'analyzer',
      sourceType: task.sourceType || getResolvedSource(task).sourceType,
      sourceVariant: task.sourceVariant || null,
      sourceProfileId: task.sourceProfileId || null,
      betCategory: task.betCategory || 'analyzer_normal',
      limitProfileKey: task.limitProfileKey || this.resolveLimitContext(task).limitProfileKey,
      isHighROI: task.isHighROI || false,
      expectedROI: task.expectedROI,
      testMode: task.testMode || false,
      bookmakerId: task.bookmakerId,
      accountId: task.accountId || null,
      mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
      originChatId: task.telegramContext?.originChatId || task.originChatId || null,
      signalId: task.telegramContext?.signalId || null
    });

    // Move pending to current (if exists)
    const pending = data.pendingTasks[bookmakerId];
    if (pending) {
      console.log(`📥 Moving pending task ${pending.id} to current`);
      data.currentTasks[bookmakerId] = pending;
      data.pendingTasks[bookmakerId] = null;
    } else {
      data.currentTasks[bookmakerId] = null;
    }
    
    data.processing[bookmakerId] = false;

    console.log(`✅ Task ${taskId} marked as completed, added to history`);
    return this.atomicWrite(data);
  }

  /**
   * Mark task as failed and move to history
   * @param {number} taskId - Task ID
   * @param {Object} error - Error object { message, step, stepNumber, ... }
   * @returns {boolean} Success status
   */
  markFailed(taskId, error = {}) {
    const data = this.read();
    
    // Find task in currentTasks
    let task = null;
    let bookmakerId = null;
    
    for (const [bkId, t] of Object.entries(data.currentTasks)) {
      if (t && t.id === taskId) {
        task = t;
        bookmakerId = bkId;
        break;
      }
    }
    
    if (!task) {
      console.warn(`⚠️ Task ${taskId} not found or already removed`);
      return false;
    }

    const timestamp = Date.now();

    // Add to history
    data.history.push(this._annotateFailureEntry({
      matchKey: task.matchKey,
      outcome: task.outcome,
      timestamp: timestamp,
      status: 'failed',
      error: error.message,
      step: error.step,
      stepNumber: error.stepNumber,
      failureClass: error.failureClass || null,
      failureStage: error.failureStage || null,
      submitReached: error.submitReached === true,
      bookmakerRejected: error.bookmakerRejected === true,
      home: task.home,
      away: task.away,
      taskId: task.id,
      source: task.source || 'analyzer',
      sourceType: task.sourceType || getResolvedSource(task).sourceType,
      sourceVariant: task.sourceVariant || null,
      sourceProfileId: task.sourceProfileId || null,
      betCategory: task.betCategory || 'analyzer_normal',
      limitProfileKey: task.limitProfileKey || this.resolveLimitContext(task).limitProfileKey,
      isHighROI: task.isHighROI || false,
      expectedROI: task.expectedROI,
      testMode: task.testMode || false,
      bookmakerId: task.bookmakerId,
      accountId: task.accountId || null,
      mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
      originChatId: task.telegramContext?.originChatId || task.originChatId || null,
      signalId: task.telegramContext?.signalId || null
    }));

    // Move pending to current (if exists)
    const pending = data.pendingTasks[bookmakerId];
    if (pending) {
      console.log(`📥 Moving pending task ${pending.id} to current`);
      data.currentTasks[bookmakerId] = pending;
      data.pendingTasks[bookmakerId] = null;
    } else {
      data.currentTasks[bookmakerId] = null;
    }
    
    data.processing[bookmakerId] = false;

    console.log(`❌ Task ${taskId} marked as failed, added to history`);
    return this.atomicWrite(data);
  }

  markCancelled(taskId, info = {}) {
    const data = this.read();

    const location = this._findTaskLocation(data, (task) => task.id === taskId);
    if (!location) {
      console.warn(`⚠️ Task ${taskId} not found or already removed`);
      return false;
    }

    if (location.slot === 'pending') {
      const pendingTask = location.task;
      data.history.push({
        matchKey: pendingTask.matchKey,
        outcome: pendingTask.outcome,
        timestamp: Date.now(),
        status: 'cancelled',
        error: info.message || info.reason || 'Cancelled',
        step: info.step || 'cancelled',
        home: pendingTask.home,
        away: pendingTask.away,
        taskId: pendingTask.id,
        source: pendingTask.source || 'telegram',
        sourceType: pendingTask.sourceType || getResolvedSource(pendingTask).sourceType,
        sourceVariant: pendingTask.sourceVariant || null,
        sourceProfileId: pendingTask.sourceProfileId || null,
        betCategory: pendingTask.betCategory || 'telegram',
        limitProfileKey: pendingTask.limitProfileKey || this.resolveLimitContext(pendingTask).limitProfileKey,
        isHighROI: pendingTask.isHighROI || false,
        expectedROI: pendingTask.expectedROI,
        testMode: pendingTask.testMode || false,
        bookmakerId: pendingTask.bookmakerId,
        accountId: pendingTask.accountId || null,
        mode: pendingTask.mode || (pendingTask.isPrematch ? 'prematch' : 'live'),
        originChatId: pendingTask.telegramContext?.originChatId || pendingTask.originChatId || null,
        signalId: this._getTaskSignalId(pendingTask),
        stopRequestedBy: info.requestedBy || info.requesterUserId || null
      });
      data.pendingTasks[location.bookmakerId] = null;
      console.log(`🛑 Pending task ${taskId} cancelled`);
      return this.atomicWrite(data);
    }

    const task = location.task;
    data.history.push({
      matchKey: task.matchKey,
      outcome: task.outcome,
      timestamp: Date.now(),
      status: 'cancelled',
      error: info.message || info.reason || 'Cancelled',
      step: info.step || 'cancelled',
      home: task.home,
      away: task.away,
      taskId: task.id,
      source: task.source || 'telegram',
      sourceType: task.sourceType || getResolvedSource(task).sourceType,
      sourceVariant: task.sourceVariant || null,
      sourceProfileId: task.sourceProfileId || null,
      betCategory: task.betCategory || 'telegram',
      limitProfileKey: task.limitProfileKey || this.resolveLimitContext(task).limitProfileKey,
      isHighROI: task.isHighROI || false,
      expectedROI: task.expectedROI,
      testMode: task.testMode || false,
      bookmakerId: task.bookmakerId,
      accountId: task.accountId || null,
      mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
      originChatId: task.telegramContext?.originChatId || task.originChatId || null,
      signalId: this._getTaskSignalId(task),
      stopRequestedBy: info.requestedBy || info.requesterUserId || null
    });

    const pending = data.pendingTasks[location.bookmakerId];
    if (pending && pending.id !== taskId) {
      console.log(`📥 Moving pending task ${pending.id} to current`);
      data.currentTasks[location.bookmakerId] = pending;
      data.pendingTasks[location.bookmakerId] = null;
    } else {
      data.currentTasks[location.bookmakerId] = null;
      if (pending && pending.id === taskId) {
        data.pendingTasks[location.bookmakerId] = null;
      }
    }

    data.processing[location.bookmakerId] = false;
    console.log(`🛑 Task ${taskId} marked as cancelled`);
    return this.atomicWrite(data);
  }

  cancelTask(taskId, info = {}) {
    const data = this.read();
    const location = this._findTaskLocation(data, (task) => task.id === taskId);
    if (!location) {
      console.warn(`⚠️ Task ${taskId} not found`);
      return { cancelled: false, reason: 'task_not_found' };
    }

    if (location.slot === 'current' && data.processing[location.bookmakerId] && info.forceCurrent !== true) {
      return { cancelled: false, reason: 'task_processing', task: location.task };
    }

    const ok = this.markCancelled(taskId, info);
    return {
      cancelled: ok,
      task: location.task
    };
  }

  /**
   * Remove task from queue (e.g., user skipped)
   * @param {number} taskId - Task ID
   * @returns {boolean} Success status
   */
  removeTask(taskId) {
    const data = this.read();
    
    // Find task in currentTasks
    let task = null;
    let bookmakerId = null;
    
    for (const [bkId, t] of Object.entries(data.currentTasks)) {
      if (t && t.id === taskId) {
        task = t;
        bookmakerId = bkId;
        break;
      }
    }
    
    if (!task) {
      console.log(`⚠️ Task ${taskId} not found in current`);
      return false;
    }
    
    console.log(`🗑️ Removing task ${taskId} (skipped by user)`);
    
    // Move pending to current (if exists)
    const pending = data.pendingTasks[bookmakerId];
    if (pending) {
      console.log(`📥 Moving pending task ${pending.id} to current`);
      data.currentTasks[bookmakerId] = pending;
      data.pendingTasks[bookmakerId] = null;
    } else {
      data.currentTasks[bookmakerId] = null;
    }
    
    data.processing[bookmakerId] = false;
    return this.atomicWrite(data);
  }

  /**
   * Get history for bookmaker
   * @param {string} bookmakerId - Bookmaker identifier
   * @param {Object} options - Options { limit, offset }
   * @returns {Array} History tasks
   */
  getHistory(bookmakerId, options = {}) {
    const data = this.read();
    const { limit = 100, offset = 0 } = options;
    
    // Filter history by bookmakerId
    const filtered = data.history.filter(task => task.bookmakerId === bookmakerId);
    
    return filtered.slice(offset, offset + limit);
  }

  /**
   * Cleanup old history entries
   * @returns {boolean} Success status
   */
  cleanup() {
    const data = this.read();
    const now = Date.now();
    
    const oldHistoryCount = data.history.length;
    
    // Remove entries older than maxHistoryAge
    data.history = data.history.filter(h => {
      const age = now - h.timestamp;
      return age < this.maxHistoryAge;
    });

    const cleaned = oldHistoryCount - data.history.length;

    if (cleaned > 0) {
      console.log(`🗑️ Cleaned ${cleaned} old history entries (>${this.maxHistoryAge/1000/60/60}h)`);
      return this.atomicWrite(data);
    }

    return true;
  }

  /**
   * Clear all history (for testing)
   * @returns {boolean} Success status
   */
  clearHistory() {
    const data = this.read();
    const count = data.history.length;
    data.history = [];
    console.log(`🗑️ История очищена: удалено ${count} записей`);
    return this.atomicWrite(data);
  }

  /**
   * Record bet result directly to history (for BaseBettor integration)
   * Unlike markCompleted/markFailed, this doesn't require task to be in currentTasks
   * @param {Object} task - Full task object
   * @param {string} status - 'completed' or 'failed'
   * @param {Object} result - Result details { odds, stake, ticketId, error, step }
   * @returns {boolean} Success status
   */
  recordBetResult(task, status, result = {}) {
    if (!task || !task.bookmakerId) {
      console.warn('⚠️ recordBetResult: invalid task (missing bookmakerId)');
      return false;
    }
    
    const data = this.read();
    const timestamp = Date.now();
    
    const historyEntry = {
      matchKey: task.matchKey,
      outcome: task.outcome,
      timestamp: timestamp,
      status: status,
      home: task.home,
      away: task.away,
      taskId: task.id,
      source: task.source || 'analyzer',
      sourceType: task.sourceType || getResolvedSource(task).sourceType,
      sourceVariant: task.sourceVariant || null,
      sourceProfileId: task.sourceProfileId || null,
      betCategory: task.betCategory || 'analyzer_normal',
      limitProfileKey: task.limitProfileKey || this.resolveLimitContext(task).limitProfileKey,
      isHighROI: task.isHighROI || false,
      expectedROI: task.expectedROI,
      testMode: task.testMode || false,
      bookmakerId: task.bookmakerId,
      accountId: task.accountId || null,
      mode: task.mode || (task.isPrematch ? 'prematch' : 'live'),
      originChatId: task.telegramContext?.originChatId || task.originChatId || null,
      signalId: task.telegramContext?.signalId || null
    };
    
    if (status === 'completed') {
      historyEntry.odds = result.odds;
      historyEntry.stake = result.stake || task.stake;
      historyEntry.ticketId = result.ticketId;
      historyEntry.dryRun = result.dryRun === true || task._dryRunCompleted === true;
    } else if (status === 'cancelled') {
      historyEntry.error = result.message || result.error || 'Cancelled';
      historyEntry.step = result.step || 'cancelled';
    } else {
      historyEntry.error = result.message || result.error;
      historyEntry.step = result.step;
      if (result.failureClass) historyEntry.failureClass = result.failureClass;
      if (result.failureStage) historyEntry.failureStage = result.failureStage;
      if (result.submitReached === true) historyEntry.submitReached = true;
      if (result.bookmakerRejected === true) historyEntry.bookmakerRejected = true;
    }
    
    data.history.push(this._annotateFailureEntry(historyEntry));
    
    console.log(`📝 Recorded ${status} bet: ${task.home} vs ${task.away} | ${task.outcome}`);
    return this.atomicWrite(data);
  }

  /**
   * Record task result and auto-finalize queue state when task is current.
   * Falls back to plain history record for non-queued/direct tasks.
   * @param {Object} task - Full task object
   * @param {string} status - 'completed' or 'failed'
   * @param {Object} result - Result details
   * @returns {boolean} Success status
   */
  recordTaskResult(task, status, result = {}) {
    if (!task || !task.bookmakerId) {
      console.warn('⚠️ recordTaskResult: invalid task (missing bookmakerId)');
      return false;
    }

    const data = this.read();
    const current = data.currentTasks[task.bookmakerId];
    if (current && current.id === task.id) {
      data.currentTasks[task.bookmakerId] = {
        ...current,
        ...task
      };

      if (!this.atomicWrite(data)) {
        return false;
      }

      const finalized = status === 'completed'
        ? this.markCompleted(task.id, result)
        : (status === 'cancelled'
          ? this.markCancelled(task.id, result)
          : this.markFailed(task.id, result));

      if (finalized) {
        return true;
      }
    }

    return this.recordBetResult(task, status, result);
  }

  /**
   * Get statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const data = this.read();
    const completed = data.history.filter(h => h.status === 'completed').length;
    const failed = data.history.filter(h => h.status === 'failed').length;
    
    // Count current and pending tasks across all bookmakers
    const currentCount = Object.values(data.currentTasks).filter(t => t !== null).length;
    const pendingCount = Object.values(data.pendingTasks).filter(t => t !== null).length;
    const processingCount = Object.values(data.processing).filter(p => p === true).length;
    
    return {
      current: currentCount,
      pending: pendingCount,
      processing: processingCount > 0,
      historyTotal: data.history.length,
      completed: completed,
      failed: failed,
      successRate: (completed + failed > 0) ? ((completed / (completed + failed)) * 100).toFixed(1) : 0
    };
  }

  /**
   * Get recent history entries (all bookmakers)
   * @param {number} limit - Max number of entries
   * @returns {Array} Recent history entries
   */
  getRecentHistory(limit = 10) {
    const data = this.read();
    return data.history.slice(-limit).reverse();
  }
}

module.exports = { TasksManager };
