const fs = require('fs');
const path = require('path');
const { TelegramIntakeSession } = require('./TelegramIntakeSession.js');
const { buildSourceTargetKey } = require('./ChatProfileManager.js');

const CODE_REPLY_REGEX_DEFAULT = /^[A-Za-z0-9]{10}$/;
const PRE_SIGNAL_WINDOW_MS_DEFAULT = 90000;
const POST_CODE_FOLLOWUP_WINDOW_MS_DEFAULT = 12000;
const DEDUPE_ENTRY_TTL_MS = 3600000; // 1 hour
// F2 (review_8): bumped from 50 → 200 so a 90 s pre-signal window in a busy
// upstream chat doesn't evict a legitimate signal anchor before its code reply
// arrives. Combined with the codeBotUserIds filter below (status messages from
// the activation bot are no longer admitted at all), this keeps the buffer
// dominated by plausible signal anchors.
const PRE_ACTIVATION_BUFFER_MAX_MESSAGES = 200;
const SIGNAL_BURST_MAX_GAP_MS = 10000; // max gap between adjacent messages in one signal burst
const REVIEW_REJECTION_STATES = new Set([
  'match_ambiguous',
  'match_not_found',
  'outcome_ambiguous',
  'rejected_low_confidence'
]);

class TelegramPollingIngress {
  constructor(options = {}) {
    this.botClient = options.botClient;
    this.chatProfileManager = options.chatProfileManager;
    this.signalParser = options.signalParser;
    this.onResolvedSignal = options.onResolvedSignal;
    this.onStopSignal = options.onStopSignal || null;
    this.notifier = options.notifier || null;
    this.logger = options.logger || console;
    this.bookmakerName = options.bookmakerName || 'Unknown';
    this.bookmakerId = options.bookmakerId || null;
    this.accountId = options.accountId || null;
    this.runtimeMode = options.runtimeMode || 'live';
    this.defaultProfileId = options.defaultProfileId || null;
    this.allowUnmappedChats = options.allowUnmappedChats === true;
    this.pollTimeoutSeconds = Number.isFinite(options.pollTimeoutSeconds) ? options.pollTimeoutSeconds : 25;
    this.pollRetryMs = Number.isFinite(options.pollRetryMs) ? options.pollRetryMs : 3000;
    this.externalUpdatesOnly = options.externalUpdatesOnly === true;
    this.sessionWindowMs = Number.isFinite(options.sessionWindowMs) ? options.sessionWindowMs : 45000;
    this.finalizeAfterMs = Number.isFinite(options.finalizeAfterMs) ? options.finalizeAfterMs : 12000;
    this.clarificationTimeoutMs = Number.isFinite(options.clarificationTimeoutMs)
      ? options.clarificationTimeoutMs
      : 120000;
    this.allowedUpdates = Array.isArray(options.allowedUpdates) && options.allowedUpdates.length > 0
      ? options.allowedUpdates
      : ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'];
    this.downloadsDir = options.downloadsDir || null;
    this.stateFilePath = options.stateFilePath || null;
    this.recentSignalsLimit = Number.isFinite(options.recentSignalsLimit) ? options.recentSignalsLimit : 50;
    this.sourceTopicDiscoveryTtlMs = Number.isFinite(options.sourceTopicDiscoveryTtlMs)
      ? options.sourceTopicDiscoveryTtlMs
      : 15 * 60 * 1000;
    this.quiet = options.quiet === true;

    this.running = false;
    this.offset = 0;
    this.lastPollAt = null;
    this.lastError = null;
    this._loopPromise = null;
    this._finalizeTimer = null;
    this._signalSeq = 0;
    this.activeDrafts = new Map();
    this.activeSessions = this.activeDrafts;
    this.messageDraftIndex = new Map();
    this.clarificationDraftIndex = new Map();
    this.childSignalParents = new Map();
    this.recentSignals = [];
    this._sourceTopicDiscoveryAlerts = new Map();
    this._knownSourceRoutingAlerts = new Map();
    this.sourceAccessAudit = {
      startedAt: null,
      completedAt: null,
      warningCount: 0,
      entries: []
    };
    this.sourceRoutingHealth = {
      autoNormalizedTopicCount: 0,
      knownSourceMismatchCount: 0,
      lastAutoNormalizedAt: null,
      lastAutoNormalized: null,
      lastKnownSourceMismatchAt: null,
      lastKnownSourceMismatch: null
    };

    // Code-reply activation: pre-activation buffers per chat+topic
    this.preActivationBuffers = new Map();
    // F6: cache the maximum preSignalWindowMs across enabled profiles so the
    // pre-activation purge respects per-profile activation windows. Computed
    // once on construction (profiles are static for the runner lifetime).
    this._maxPreSignalWindowMs = this._computeMaxPreSignalWindowMs();
    // Cross-chat deduplication registry
    this.dedupeRegistry = new Map();
    this.dedupeFilePath = options.dedupeFilePath || null;
    // F7: optional path to active tasks file used during dedupe load to drop
    // accepted entries whose taskId is no longer active.
    this.tasksFilePath = options.tasksFilePath || null;
    // F7: shorter TTL for restored entries that weren't terminal
    // (i.e. status not in {'failed'}), to avoid suppressing legitimate
    // re-issued signals across runner restarts.
    this.restoredDedupeTtlMs = Number.isFinite(options.restoredDedupeTtlMs)
      ? Number(options.restoredDedupeTtlMs)
      : 5 * 60 * 1000;
    // Photo download retry configuration. Defaults are tuned to recover from
    // Telegram's transient 400 "file_id temporarily unavailable" without
    // changing caller semantics: a permanent failure still yields no image.
    this.photoDownloadAttempts = Number.isFinite(options.photoDownloadAttempts)
      ? Number(options.photoDownloadAttempts)
      : 3;
    this.photoDownloadBackoffMs = Number.isFinite(options.photoDownloadBackoffMs)
      ? Number(options.photoDownloadBackoffMs)
      : 250;
    // Optional directory for raw envelope dumps (full Telegram update JSON +
    // any downloaded artefacts). Used for offline replay of edge cases such
    // as anonymous-admin code activations. Pure side-effect: no logic relies
    // on the dump succeeding.
    this.envelopeDumpDir = options.envelopeDumpDir || null;
    // Structured runtime counters for observability. Surface via getStatus().
    this.metrics = {
      message_received_total: 0,
      message_dropped_no_profile: 0,
      message_buffered_pre_activation: 0,
      buffer_evictions_total: 0,
      code_received_total: 0,
      code_accepted_total: 0,
      code_dropped_no_reply: 0,
      code_dropped_orphan_reply: 0,
      code_dropped_unknown_author: 0,
      code_recognized_via_sender_chat: 0,
      code_recognized_via_via_bot: 0,
      code_recognized_via_forward: 0,
      file_download_attempts_failed: 0,
      file_download_failed_total: 0,
      file_download_succeeded: 0,
      file_download_succeeded_after_retry: 0,
      envelope_dumps_written: 0,
      envelope_dumps_failed: 0,
      signal_ready_total: 0,
      signal_enqueued_total: 0,
      signal_match_not_found_total: 0,
      signal_match_ambiguous_total: 0,
      signal_outcome_ambiguous_total: 0,
      signal_rejected_low_confidence_total: 0
    };
    // Post-code follow-up timers
    this._postCodeTimers = new Map();
  }

  _computeMaxPreSignalWindowMs() {
    let maxMs = PRE_SIGNAL_WINDOW_MS_DEFAULT;
    try {
      const profiles = this.chatProfileManager?.getEnabledProfiles?.() || [];
      for (const profile of profiles) {
        const ms = Number(profile?.activation?.preSignalWindowMs);
        if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      }
    } catch (e) { /* defensive */ }
    return maxMs;
  }

  async start() {
    if (this.running) {
      return;
    }

    if (!this.botClient) {
      throw new Error('TelegramPollingIngress requires botClient');
    }

    if (!this.signalParser) {
      throw new Error('TelegramPollingIngress requires signalParser');
    }

    this._loadState();
    this._loadDedupeRegistry();
    if (this.downloadsDir) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }

    await this._runSourceAccessAudit();

    this.running = true;
    this._finalizeTimer = setInterval(() => {
      this._purgeExpiredPreActivationBuffers();
      this._purgeExpiredDedupeEntries();
      this.flushExpiredSessions().catch((error) => {
        this.lastError = error.message;
        this.logger.error(`Telegram ingress timeout error: ${error.message}`);
      });
    }, 1000);

    if (this.externalUpdatesOnly) {
      this._loopPromise = null;
      this.logger.log(`📨 Telegram ingress started (${this.runtimeMode}, external updates)`);
      return;
    }

    this._loopPromise = this._pollLoop();
    this.logger.log(`📨 Telegram ingress started (${this.runtimeMode})`);
  }

  async stop() {
    this.running = false;
    if (this._finalizeTimer) {
      clearInterval(this._finalizeTimer);
      this._finalizeTimer = null;
    }

    if (this._loopPromise) {
      try {
        await this._loopPromise;
      } catch (error) {}
      this._loopPromise = null;
    }

    await this.flushExpiredSessions(Date.now(), true);
    this._saveState();
    this._saveDedupeRegistry();
    for (const timer of this._postCodeTimers.values()) {
      clearTimeout(timer);
    }
    this._postCodeTimers.clear();
    this.logger.log('📨 Telegram ingress stopped');
  }

  async processUpdates(updates = []) {
    for (const update of updates) {
      if (Number.isFinite(update.update_id) && update.update_id > this.offset) {
        this.offset = update.update_id;
      }

      const event = await this._extractUpdateEvent(update);
      if (!event) {
        continue;
      }

      if (event.type === 'callback_query') {
        await this._handleCallbackQuery(event.callback);
      } else {
        await this._handleMessage(event.message);
      }
    }

    this._saveState();
    this._saveDedupeRegistry();
    await this.flushExpiredSessions();
  }

  async flushExpiredSessions(now = Date.now(), force = false) {
    const drafts = Array.from(this.activeDrafts.values());

    for (const draft of drafts) {
      if (draft.processing) {
        continue;
      }

      if (force) {
        if (!draft.taskState || ['draft', 'match_ambiguous', 'match_not_found', 'outcome_ambiguous', 'ready'].includes(draft.stage)) {
          this._archiveDraft(draft, 'shutdown');
        }
        continue;
      }

      // F4: inactivity-driven finalize. Drafts that never produced a
      // clarification and never reached `ready` would otherwise sit in
      // activeDrafts forever, occupying messageDraftIndex slots and
      // potentially merging unrelated later signals via
      // _findContinuableDraftForAuthor. After finalizeAfterMs of inactivity,
      // try one final _processDraft and archive on still-not-ready.
      if (!draft.clarification && draft.stage === 'draft' && !draft.taskState) {
        const lastUpdated = draft.session?.lastUpdatedAt || 0;
        if (this.finalizeAfterMs > 0 && lastUpdated > 0 && (now - lastUpdated) > this.finalizeAfterMs) {
          try {
            await this._processDraft(draft);
          } catch (err) {
            this.logger.log?.(`⚠️ finalize-timeout _processDraft failed for ${draft.id}: ${err.message}`);
          }
          if (this.activeDrafts.has(draft.id) && draft.stage === 'draft' && !draft.taskState) {
            this._archiveDraft(draft, 'finalize_timeout');
          }
          continue;
        }
      }

      if (!draft.clarification || draft.clarification.waitForTextOnly === false && !draft.clarification.expiresAt) {
        continue;
      }

      if (draft.clarification.expiresAt && now < draft.clarification.expiresAt) {
        continue;
      }

      await this._clearClarificationMarkup(draft);
      await this._sendSourceChatMessage(draft, '⏱️ Сигнал закрыт: время на уточнение истекло.', {
        replyToMessageId: draft.lastSourceMessageId || undefined
      });
      this._archiveDraft(draft, 'clarification_timeout');
    }
  }

  applyTaskLifecycle(signalId, lifecycle = {}) {
    const resolved = this._resolveDraftForSignalId(signalId);
    const draft = resolved?.draft || null;
    if (!draft) {
      return false;
    }

    const childId = resolved.childSignalId || null;
    if (childId) {
      draft.childSignals = draft.childSignals || new Map();
      const current = draft.childSignals.get(childId) || {};
      draft.childSignals.set(childId, {
        ...current,
        signalId: childId,
        taskId: lifecycle.taskId || current.taskId || null,
        state: lifecycle.state || current.state || null,
        executionState: lifecycle.executionState || current.executionState || null,
        lastTaskUpdateAt: Date.now()
      });
    }

    draft.taskId = lifecycle.taskId || draft.taskId || null;
    draft.taskState = lifecycle.state || draft.taskState || null;
    draft.taskExecutionState = lifecycle.executionState || draft.taskExecutionState || null;
    draft.lastTaskUpdateAt = Date.now();

    if (draft.taskState === 'queued') {
      draft.stage = 'queued';
      return true;
    }

    if (draft.taskState === 'executing') {
      draft.stage = 'executing';
      return true;
    }

    if (['completed', 'failed', 'cancelled'].includes(draft.taskState)) {
      if (childId && !this._allChildSignalsTerminal(draft)) {
        draft.stage = 'executing';
        return true;
      }
      this._archiveDraft(draft, this._archiveReasonForTaskLifecycle(lifecycle));
      return true;
    }

    return true;
  }

  _resolveDraftForSignalId(signalId) {
    if (!signalId) return null;
    const direct = this.activeDrafts.get(signalId);
    if (direct) {
      return { draft: direct, childSignalId: null };
    }
    const parentId = this.childSignalParents.get(signalId);
    const parent = parentId ? this.activeDrafts.get(parentId) : null;
    return parent ? { draft: parent, childSignalId: signalId } : null;
  }

  _allChildSignalsTerminal(draft) {
    if (!draft?.childSignals || draft.childSignals.size === 0) return true;
    for (const child of draft.childSignals.values()) {
      if (!['completed', 'failed', 'cancelled'].includes(child.state)) {
        return false;
      }
    }
    return true;
  }

  _archiveReasonForTaskLifecycle(lifecycle = {}) {
    if (lifecycle.state !== 'failed') {
      return lifecycle.state || 'failed';
    }

    const step = String(lifecycle.step || '').toLowerCase();
    const failureStage = String(lifecycle.failureStage || '').toLowerCase();
    const message = String(lifecycle.error || lifecycle.message || '').toLowerCase();
    const businessStopSteps = new Set([
      'insufficient_balance',
      'balance_low',
      'bookmaker_max_stake',
      'safe_max_stake',
      'max_stake'
    ]);

    if (failureStage === 'design_stop' || /real submit disabled|submit disabled|design_stop/.test(message)) {
      return 'design_stop';
    }

    if (businessStopSteps.has(step) || /insufficient balance|balance.*<|max[- ]?stake|safe max/i.test(message)) {
      return 'business_stop';
    }
    return 'failed';
  }

  getStatus() {
    return {
      enabled: true,
      running: this.running,
      bookmakerId: this.bookmakerId,
      runtimeMode: this.runtimeMode,
      offset: this.offset,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      externalUpdatesOnly: this.externalUpdatesOnly,
      activeSessions: this.getActiveSessions(),
      recentSignals: this.recentSignals.slice(0, 10),
      preActivationBufferCount: this.preActivationBuffers.size,
      dedupeRegistrySize: this.dedupeRegistry.size,
      sourceAccessAudit: this.sourceAccessAudit,
      sourceRoutingHealth: this.sourceRoutingHealth,
      metrics: this.metrics ? { ...this.metrics } : null
    };
  }

  getRecentSignals(limit = 20) {
    return this.recentSignals.slice(0, limit);
  }

  getActiveSessions() {
    return Array.from(this.activeDrafts.values()).map((draft) => ({
      sessionId: draft.id,
      profileId: draft.profile.id,
      chatId: draft.session.chatId,
      topicId: draft.session.topicId,
      createdAt: draft.createdAt,
      lastUpdatedAt: draft.session.lastUpdatedAt,
      messages: draft.session.messages.length,
      textPreview: draft.session.getTextContext().slice(0, 300),
      stage: draft.stage,
      authorId: draft.authorId,
      clarification: draft.clarification ? {
        type: draft.clarification.type,
        expiresAt: draft.clarification.expiresAt,
        waitForTextOnly: draft.clarification.waitForTextOnly === true
      } : null
    }));
  }

  async _pollLoop() {
    while (this.running) {
      try {
        const updates = await this.botClient.getUpdates({
          offset: this.offset + 1,
          timeout: this.pollTimeoutSeconds,
          allowedUpdates: this.allowedUpdates
        });
        this.lastPollAt = Date.now();
        this.lastError = null;
        await this.processUpdates(updates);
      } catch (error) {
        this.lastError = error.message;
        this.logger.error(`Telegram ingress poll error: ${error.message}`);
        if (!this.running) {
          break;
        }
        await this._sleep(this.pollRetryMs);
      }
    }
  }

  async _extractUpdateEvent(update = {}) {
    if (update.callback_query) {
      return {
        type: 'callback_query',
        callback: this._normalizeCallbackQuery(update.callback_query, update.update_id)
      };
    }

    const message = await this._normalizeMessageUpdate(update);
    if (!message) {
      return null;
    }

    return {
      type: 'message',
      message
    };
  }

  async _normalizeMessageUpdate(update = {}) {
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!message) {
      return null;
    }

    const text = message.text || '';
    const caption = message.caption || '';
    const photo = Array.isArray(message.photo) ? message.photo : [];

    if (!text && !caption && photo.length === 0) {
      return null;
    }

    const images = [];
    let photoDownloadFailures = 0;
    if (photo.length > 0 && this.downloadsDir) {
      const photoFileId = photo[photo.length - 1].file_id;
      // Local-image short-circuit: an external relay (e.g. Telethon-as-user
      // bridge for sandbox/test environments where Bot API can't see other
      // bots' messages) saves the photo to disk and tags it with file_id
      // prefix `local:`. In that case we skip the Bot API download path
      // entirely and use the prepared local path provided alongside.
      // Pure additive: production messages never produce `local:` file_ids,
      // so all existing behaviour is unchanged.
      if (typeof photoFileId === 'string' && photoFileId.startsWith('local:')) {
        const localPath = message._local_image_path
          || message.localImagePath
          || photo[photo.length - 1]._local_image_path
          || photo[photo.length - 1].localImagePath
          || null;
        if (localPath && fs.existsSync(localPath)) {
          images.push(localPath);
          if (this.metrics) this.metrics.file_download_succeeded += 1;
          this.logger?.log?.(`📸 Local photo accepted: ${localPath} (file_id=${photoFileId})`);
        } else {
          photoDownloadFailures += 1;
          if (this.metrics) this.metrics.file_download_failed_total += 1;
          this.logger?.log?.(`⚠️ local: file_id ${photoFileId} but no readable local path on message`);
        }
      } else {
        const baseName = `${message.chat?.id || 'chat'}_${message.message_id}_${photoFileId}`;
        const downloaded = await this._downloadPhotoWithRetry(photoFileId, baseName);
        if (downloaded?.destinationPath) {
          images.push(downloaded.destinationPath);
        } else {
          photoDownloadFailures += 1;
        }
      }
    }

    // Robust identity extraction: Telegram does NOT always populate `from.id`.
    // For anonymous group admins, channel_post forwards, or messages signed as
    // the chat itself, `from` is omitted and identity must be reconstructed
    // from `sender_chat`, forwards, or `via_bot`. The matcher in
    // _handleCodeReplyMessage checks codeBotUserIds against ANY of these
    // identity fields so an authorized activation bot is recognized regardless
    // of which envelope shape Telegram used.
    const senderChatId = message.sender_chat?.id ?? null;
    const viaBotId = message.via_bot?.id ?? null;
    const forwardFromId = message.forward_from?.id ?? null;
    const forwardFromChatId = message.forward_from_chat?.id ?? null;

    return {
      updateId: update.update_id || null,
      messageId: message.message_id || null,
      chatId: message.chat?.id || null,
      topicId: message.message_thread_id || null,
      mediaGroupId: message.media_group_id || null,
      timestamp: (message.date ? message.date * 1000 : Date.now()),
      text,
      caption,
      images,
      photoDownloadFailures,
      isEdit: Boolean(update.edited_message || update.edited_channel_post),
      authorId: message.from?.id ?? null,
      authorUsername: message.from?.username || null,
      senderChatId,
      viaBotId,
      forwardFromId,
      forwardFromChatId,
      replyToMessageId: message.reply_to_message?.message_id || null,
      metadata: {
        chatType: message.chat?.type || null,
        chatTitle: message.chat?.title || null,
        replyText: message.reply_to_message?.text || message.reply_to_message?.caption || '',
        authorIsBot: message.from?.is_bot === true,
        senderChatId
      }
    };
  }

  /**
   * Download a Telegram photo by file_id with bounded retries and structured
   * failure metrics. Telegram occasionally returns 400 "wrong file_id or the
   * file is temporarily unavailable" for fresh updates when the file server
   * has not yet replicated the binary. A short bounded retry recovers most of
   * those cases without changing any caller semantics: caller still receives
   * either { destinationPath } or null on failure.
   *
   * Logic-preserving: behaviour on permanent failure is identical to the
   * pre-fix version — best-effort, no exception bubbles up.
   */
  async _downloadPhotoWithRetry(fileId, baseFileName) {
    if (!this.botClient?.downloadFileById || !this.downloadsDir) {
      return null;
    }
    const attempts = Number.isFinite(this.photoDownloadAttempts) ? this.photoDownloadAttempts : 3;
    const baseDelayMs = Number.isFinite(this.photoDownloadBackoffMs) ? this.photoDownloadBackoffMs : 250;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const file = await this.botClient.downloadFileById(fileId, this.downloadsDir, {
          fileName: baseFileName
        });
        if (this.metrics) {
          this.metrics.file_download_succeeded += 1;
          if (attempt > 1) this.metrics.file_download_succeeded_after_retry += 1;
        }
        return file;
      } catch (error) {
        lastError = error;
        const transient = /file is temporarily unavailable|wrong file_id|429|5\d\d/i.test(error?.message || '');
        if (this.metrics) {
          this.metrics.file_download_attempts_failed += 1;
        }
        this.logger?.log?.(`⚠️ Photo download attempt ${attempt}/${attempts} failed (fileId=${fileId} transient=${transient}): ${error.message}`);
        if (attempt < attempts && transient) {
          // Exponential backoff: 250ms, 750ms, 2250ms…
          const delay = baseDelayMs * (3 ** (attempt - 1));
          await this._sleep(delay);
          continue;
        }
        break;
      }
    }
    if (this.metrics) {
      this.metrics.file_download_failed_total += 1;
    }
    this.logger?.log?.(`❌ Photo download permanently failed after ${attempts} attempts (fileId=${fileId}): ${lastError?.message || 'unknown'}`);
    return null;
  }

  _normalizeCallbackQuery(callbackQuery = {}, updateId = null) {
    return {
      updateId,
      callbackId: callbackQuery.id,
      data: callbackQuery.data || '',
      timestamp: Date.now(),
      authorId: callbackQuery.from?.id ?? null,
      authorUsername: callbackQuery.from?.username || null,
      chatId: callbackQuery.message?.chat?.id ?? null,
      topicId: callbackQuery.message?.message_thread_id || null,
      messageId: callbackQuery.message?.message_id || null,
      metadata: {
        chatType: callbackQuery.message?.chat?.type || null,
        chatTitle: callbackQuery.message?.chat?.title || null
      }
    };
  }

  async _handleMessage(message) {
    if (this.metrics) this.metrics.message_received_total += 1;
    if (this._isOwnBotMessage(message)) {
      this.logger?.log(`↩️ Ignoring own bot message chatId=${message.chatId} msgId=${message.messageId}`);
      return;
    }
    this._autoNormalizeKnownSourceTopic(message);
    this.logger?.log(`📩 _handleMessage: chatId=${message.chatId} topicId=${message.topicId} authorId=${message.authorId} text=${(message.text || message.caption || '').slice(0, 30)} hasImages=${!!(message.images?.length)} imgPaths=${JSON.stringify(message.images || [])}`);
    const profile = this._resolveProfileForMessage(message);
    await this._maybeReportSourceTopicDiscovery(message, profile);
    if (!profile) {
      if (this.metrics) this.metrics.message_dropped_no_profile += 1;
      await this._reportKnownSourceRoutingMismatch(message);
      this.logger?.log(`⚠️ No profile matched for chatId=${message.chatId} authorId=${message.authorId}`);
      return;
    }
    this.logger?.log(`✅ Profile matched: ${profile.id}`);
    if (this._isIgnoredByProfile(message, profile)) {
      this.logger?.log(`↩️ Ignoring profile-muted message chatId=${message.chatId} msgId=${message.messageId} profile=${profile.id}`);
      return;
    }

    // Code-reply activation mode: buffer messages, activate only on code
    if (profile.activation?.mode === 'code_reply') {
      await this._handleCodeReplyMessage(message, profile);
      return;
    }

    // Standard (immediate) activation mode
    await this._handleImmediateMessage(message, profile);
  }

  _isOwnBotMessage(message = {}) {
    const botUserId = this.botClient?.getBotUserId?.();
    if (!botUserId || message.authorId === null || message.authorId === undefined) {
      return false;
    }
    return String(message.authorId) === String(botUserId) && message.metadata?.authorIsBot === true;
  }

  _isIgnoredByProfile(message = {}, profile = {}) {
    const prefixes = [
      ...(Array.isArray(profile.ignoredTextPrefixes) ? profile.ignoredTextPrefixes : []),
      ...(Array.isArray(profile.ignoreTextPrefixes) ? profile.ignoreTextPrefixes : [])
    ]
      .map((prefix) => String(prefix || ''))
      .filter(Boolean);
    if (prefixes.length === 0) return false;
    const text = String(message.text || message.caption || '').trimStart();
    if (!text) return false;
    return prefixes.some((prefix) => text.startsWith(prefix));
  }

  _matchesActivationCodeRegex(codeRegex, text) {
    if (!codeRegex || !text) {
      return false;
    }
    codeRegex.lastIndex = 0;
    return codeRegex.test(text);
  }

  _isSuspiciousUnknownAuthorCodeText(message = {}, text = '', codeTextMatches = false) {
    if (!codeTextMatches) {
      return false;
    }
    const hasAlpha = /[A-Za-z]/.test(text);
    const hasDigit = /\d/.test(text);
    return (hasAlpha && hasDigit) || Boolean(message.replyToMessageId);
  }

  async _runSourceAccessAudit() {
    const targets = this._collectSourceAccessAuditTargets();
    if (targets.length === 0 || !this.botClient?.getChat) {
      this.sourceAccessAudit = {
        startedAt: Date.now(),
        completedAt: Date.now(),
        warningCount: 0,
        entries: []
      };
      return;
    }

    const startedAt = Date.now();

    if (this.externalUpdatesOnly) {
      const entries = targets.map((target) => ({
        chatId: target.chatId,
        expectedTopicIds: target.expectedTopicIds,
        profiles: target.profiles,
        ok: true,
        skipped: true,
        skipReason: 'external_updates_only',
        title: null,
        type: null,
        isForum: null,
        membershipStatus: null,
        error: null
      }));
      this.sourceAccessAudit = {
        startedAt,
        completedAt: Date.now(),
        warningCount: 0,
        entries
      };
      for (const entry of entries) {
        const topicsLabel = entry.expectedTopicIds.length > 0
          ? entry.expectedTopicIds.join(',')
          : '*';
        this.logger?.log?.(
          `🧭 Source access audit skipped (external updates relay): chatId=${entry.chatId} profiles=${entry.profiles.join(',')} topics=${topicsLabel}`
        );
      }
      return;
    }

    const entries = [];
    const botUserId = this.botClient?.getBotUserId?.() || null;

    for (const target of targets) {
      const entry = {
        chatId: target.chatId,
        expectedTopicIds: target.expectedTopicIds,
        profiles: target.profiles,
        ok: false,
        title: null,
        type: null,
        isForum: null,
        membershipStatus: null,
        error: null
      };

      try {
        const chat = await this.botClient.getChat(target.chatId);
        entry.ok = true;
        entry.title = chat?.title || null;
        entry.type = chat?.type || null;
        entry.isForum = chat?.is_forum === true;

        if (botUserId && this.botClient?.getChatMember) {
          try {
            const membership = await this.botClient.getChatMember(target.chatId, botUserId);
            entry.membershipStatus = membership?.status || null;
          } catch (error) {
            entry.membershipStatus = null;
            entry.membershipError = error.message;
          }
        }
      } catch (error) {
        entry.error = error.message;
      }

      entries.push(entry);

      const topicsLabel = entry.expectedTopicIds.length > 0
        ? entry.expectedTopicIds.join(',')
        : '*';
      if (entry.ok) {
        this.logger?.log(
          `🧭 Source access audit OK: chatId=${entry.chatId} profiles=${entry.profiles.join(',')} topics=${topicsLabel} title=${entry.title || 'unknown'} type=${entry.type || 'unknown'} forum=${entry.isForum === true} member=${entry.membershipStatus || 'unknown'}`
        );
      } else {
        this.logger?.error(
          `🧭 Source access audit FAILED: chatId=${entry.chatId} profiles=${entry.profiles.join(',')} topics=${topicsLabel} error=${entry.error}`
        );
      }
    }

    const warningCount = entries.filter((entry) => !entry.ok).length;
    this.sourceAccessAudit = {
      startedAt,
      completedAt: Date.now(),
      warningCount,
      entries
    };

    if (warningCount > 0 && !this.externalUpdatesOnly) {
      const feedbackProfile = targets.find((target) => target.feedbackProfile)?.feedbackProfile || null;
      if (feedbackProfile) {
        const lines = ['🧭 Source access audit'];
        for (const entry of entries) {
          const topicsLabel = entry.expectedTopicIds.length > 0
            ? entry.expectedTopicIds.join(',')
            : '*';
          if (entry.ok) {
            lines.push(`OK chat=${entry.chatId} topics=${topicsLabel} title=${entry.title || 'unknown'} forum=${entry.isForum === true} member=${entry.membershipStatus || 'unknown'}`);
          } else {
            lines.push(`FAIL chat=${entry.chatId} topics=${topicsLabel} profiles=${entry.profiles.join(',')} error=${entry.error}`);
          }
        }
        await this._sendToFeedbackChat(feedbackProfile, lines.join('\n'), { parse_mode: null });
      }
    }
  }

  _collectSourceAccessAuditTargets() {
    const profiles = this.chatProfileManager?.getEnabledProfiles?.({
      bookmakerId: this.bookmakerId,
      accountId: this.accountId,
      mode: this.runtimeMode
    }) || [];
    const targets = new Map();

    for (const profile of profiles) {
      if (!profile?.sourceReadOnly) {
        continue;
      }

      const sourceTargets = Array.isArray(profile.sourceTargets) && profile.sourceTargets.length > 0
        ? profile.sourceTargets
        : (profile.sourceChatIds || []).map((chatId) => ({ chatId, topicId: null }));

      for (const sourceTarget of sourceTargets) {
        if (sourceTarget?.chatId === null || sourceTarget?.chatId === undefined || sourceTarget?.chatId === '') {
          continue;
        }

        const chatId = String(sourceTarget.chatId);
        if (!targets.has(chatId)) {
          targets.set(chatId, {
            chatId,
            profiles: new Set(),
            expectedTopicIds: new Set(),
            feedbackProfile: profile?.feedbackChatIds?.length ? profile : null
          });
        }

        const entry = targets.get(chatId);
        entry.profiles.add(profile.id);
        if (sourceTarget.topicId !== null && sourceTarget.topicId !== undefined) {
          entry.expectedTopicIds.add(String(sourceTarget.topicId));
        }
        if (!entry.feedbackProfile && profile?.feedbackChatIds?.length) {
          entry.feedbackProfile = profile;
        }
      }
    }

    return Array.from(targets.values()).map((entry) => ({
      chatId: entry.chatId,
      profiles: Array.from(entry.profiles),
      expectedTopicIds: Array.from(entry.expectedTopicIds),
      feedbackProfile: entry.feedbackProfile || null
    }));
  }


  async _maybeReportSourceTopicDiscovery(message, matchedProfile = null) {
    if (!message || message.chatId === null || message.chatId === undefined || !message.topicId) {
      return;
    }

    const discoveryProfile = this._resolveSourceTopicDiscoveryProfile(message, matchedProfile);
    if (!discoveryProfile || discoveryProfile.sourceReadOnly !== true) {
      return;
    }

    const exactTarget = this.chatProfileManager?.resolveSourceTarget?.(discoveryProfile, message.chatId, message.topicId) || null;
    const chatTargets = Array.isArray(discoveryProfile.sourceTargets)
      ? discoveryProfile.sourceTargets.filter((target) => String(target.chatId) === String(message.chatId))
      : [];
    const hasExactTopicTarget = chatTargets.some((target) => target.topicId !== null && target.topicId !== undefined && String(target.topicId) === String(message.topicId));
    const hasGenericChatTarget = chatTargets.some((target) => target.topicId === null || target.topicId === undefined);

    let reason = null;
    if (!matchedProfile && chatTargets.length > 0) {
      reason = 'unconfigured_topic';
    } else if (matchedProfile && exactTarget && (exactTarget.topicId === null || exactTarget.topicId === undefined) && hasGenericChatTarget) {
      reason = 'generic_source_chat';
    } else if (matchedProfile && !hasExactTopicTarget && hasGenericChatTarget) {
      reason = 'generic_source_chat';
    }

    if (!reason) {
      return;
    }

    const alertKey = `${discoveryProfile.id}|${String(message.chatId)}|${String(message.topicId)}|${reason}`;
    const now = Date.now();
    const lastSentAt = this._sourceTopicDiscoveryAlerts.get(alertKey) || 0;
    if ((now - lastSentAt) < this.sourceTopicDiscoveryTtlMs) {
      return;
    }
    this._sourceTopicDiscoveryAlerts.set(alertKey, now);

    const preview = String(message.text || message.caption || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const sourceLabel = exactTarget?.label || this._resolveSourceTargetLabel(discoveryProfile, message.chatId, message.topicId) || discoveryProfile.clusterId || discoveryProfile.id;
    const lines = [
      '🧭 Topic discovery',
      `profile=${discoveryProfile.id}`,
      `sourceLabel=${sourceLabel}`,
      message.chatTitle ? `chatTitle=${message.chatTitle}` : null,
      `chatId=${message.chatId}`,
      `topicId=${message.topicId}`,
      `reason=${reason}`,
      preview ? `text=${preview}` : null
    ].filter(Boolean);

    await this._sendToFeedbackChat(discoveryProfile, lines.join('\n'), {
      sourceChatId: message.chatId,
      sourceMessageId: message.messageId
    });
  }

  _resolveSourceTopicDiscoveryProfile(message, matchedProfile = null) {
    if (matchedProfile?.sourceReadOnly === true) {
      return matchedProfile;
    }

    if (!this.chatProfileManager?.getEnabledProfilesByChatId) {
      return null;
    }

    const filters = {
      bookmakerId: this.bookmakerId,
      accountId: this.accountId,
      mode: this.runtimeMode,
      ...message
    };

    const candidates = this.chatProfileManager
      .getEnabledProfilesByChatId(message.chatId, filters)
      .filter((profile) => profile?.sourceReadOnly === true);

    return candidates[0] || null;
  }

  _buildRoutingFilters(message = {}) {
    return {
      bookmakerId: this.bookmakerId,
      accountId: this.accountId,
      mode: this.runtimeMode,
      ...message
    };
  }

  _getKnownSourceProfilesForMessage(message, filters = null) {
    if (!message || message.chatId === null || message.chatId === undefined || !this.chatProfileManager?.getEnabledProfilesByChatId) {
      return [];
    }

    const resolvedFilters = filters || this._buildRoutingFilters(message);
    return this.chatProfileManager
      .getEnabledProfilesByChatId(message.chatId, resolvedFilters)
      .filter((profile) => profile?.sourceReadOnly === true);
  }

  _autoNormalizeKnownSourceTopic(message, filters = null) {
    if (!message) {
      return message;
    }

    const resolvedFilters = filters || this._buildRoutingFilters(message);
    const candidates = this._getKnownSourceProfilesForMessage(message, resolvedFilters);
    if (candidates.length !== 1) {
      return message;
    }

    const profile = candidates[0];
    const canonicalTopicId = this.chatProfileManager?.getCanonicalSourceTopicId?.(profile, message.chatId, message.topicId);
    if (canonicalTopicId === null || canonicalTopicId === undefined) {
      return message;
    }

    if (String(canonicalTopicId) === String(message.topicId || '')) {
      return message;
    }

    const target = this.chatProfileManager?.resolveSourceTarget?.(profile, message.chatId, canonicalTopicId) || null;
    if (!target || target.topicId === null || target.topicId === undefined) {
      return message;
    }

    const incomingTopicId = message.topicId ?? null;
    message.topicId = canonicalTopicId;
    this._recordSourceTopicAutoNormalization(profile, message, incomingTopicId, canonicalTopicId, target);
    return message;
  }

  _recordSourceTopicAutoNormalization(profile, message, incomingTopicId, canonicalTopicId, target = null) {
    const entry = {
      profileId: profile?.id || null,
      chatId: message?.chatId !== undefined && message?.chatId !== null ? String(message.chatId) : null,
      incomingTopicId: incomingTopicId ?? null,
      canonicalTopicId: canonicalTopicId ?? null,
      sourceLabel: target?.label || this._resolveSourceTargetLabel(profile, message?.chatId, canonicalTopicId) || null,
      messageId: message?.messageId || null,
      ts: Date.now()
    };

    this.sourceRoutingHealth.autoNormalizedTopicCount += 1;
    this.sourceRoutingHealth.lastAutoNormalizedAt = entry.ts;
    this.sourceRoutingHealth.lastAutoNormalized = entry;
    this.logger?.log(`🩹 Source topic auto-normalized: profile=${entry.profileId} chatId=${entry.chatId} incomingTopicId=${entry.incomingTopicId ?? 'null'} canonicalTopicId=${entry.canonicalTopicId}`);

    const alertKey = `auto_normalized|${entry.profileId}|${entry.chatId}|${entry.incomingTopicId ?? 'null'}|${entry.canonicalTopicId}`;
    const lastSentAt = this._knownSourceRoutingAlerts.get(alertKey) || 0;
    if ((entry.ts - lastSentAt) < this.sourceTopicDiscoveryTtlMs) {
      return;
    }
    this._knownSourceRoutingAlerts.set(alertKey, entry.ts);

    const lines = [
      '🩹 Source topic auto-normalized',
      `profile=${entry.profileId}`,
      entry.sourceLabel ? `sourceLabel=${entry.sourceLabel}` : null,
      `chatId=${entry.chatId}`,
      `incomingTopicId=${entry.incomingTopicId ?? 'null'}`,
      `canonicalTopicId=${entry.canonicalTopicId}`
    ].filter(Boolean);

    void this._sendToFeedbackChat(profile, lines.join('\n'), {
      parse_mode: null,
      sourceChatId: message?.chatId ?? null,
      sourceMessageId: message?.messageId ?? null
    });
  }

  async _reportKnownSourceRoutingMismatch(message, filters = null) {
    const resolvedFilters = filters || this._buildRoutingFilters(message);
    const candidates = this._getKnownSourceProfilesForMessage(message, resolvedFilters);
    if (candidates.length === 0) {
      return;
    }

    const expectedTopicIds = Array.from(new Set(
      candidates.flatMap((profile) => (profile.sourceTargets || [])
        .filter((target) => String(target.chatId) === String(message.chatId))
        .map((target) => target.topicId)
        .filter((topicId) => topicId !== null && topicId !== undefined)
        .map(String))
    ));

    const entry = {
      chatId: String(message.chatId),
      topicId: message.topicId ?? null,
      authorId: message.authorId ?? null,
      profileIds: candidates.map((profile) => profile.id),
      expectedTopicIds,
      textPreview: String(message.text || message.caption || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
      ts: Date.now()
    };

    this.sourceRoutingHealth.knownSourceMismatchCount += 1;
    this.sourceRoutingHealth.lastKnownSourceMismatchAt = entry.ts;
    this.sourceRoutingHealth.lastKnownSourceMismatch = entry;

    this.logger?.error(
      `🚨 Known source routing mismatch: chatId=${entry.chatId} topicId=${entry.topicId ?? 'null'} profiles=${entry.profileIds.join(',')} expectedTopics=${entry.expectedTopicIds.join(',') || '*'}`
    );

    const alertKey = `routing_mismatch|${entry.profileIds.join(',')}|${entry.chatId}|${entry.topicId ?? 'null'}`;
    const lastSentAt = this._knownSourceRoutingAlerts.get(alertKey) || 0;
    if ((entry.ts - lastSentAt) < this.sourceTopicDiscoveryTtlMs) {
      return;
    }
    this._knownSourceRoutingAlerts.set(alertKey, entry.ts);

    const feedbackProfile = candidates.find((profile) => profile?.feedbackChatIds?.length > 0) || candidates[0];
    const lines = [
      '🚨 Known source routing mismatch',
      `profiles=${entry.profileIds.join(',')}`,
      `chatId=${entry.chatId}`,
      `topicId=${entry.topicId ?? 'null'}`,
      `expectedTopicIds=${entry.expectedTopicIds.join(',') || '*'}`,
      entry.textPreview ? `text=${entry.textPreview}` : null
    ].filter(Boolean);

    await this._sendToFeedbackChat(feedbackProfile, lines.join('\n'), {
      parse_mode: null,
      sourceChatId: message.chatId,
      sourceMessageId: message.messageId
    });
  }

  async _handleCodeReplyMessage(message, profile) {
    const activation = profile.activation || {};
    const codeBotUserIds = (activation.codeBotUserIds || []).map(String);
    const codeRegex = activation.codeRegex
      ? new RegExp(activation.codeRegex)
      : CODE_REPLY_REGEX_DEFAULT;
    const preSignalWindowMs = activation.preSignalWindowMs || PRE_SIGNAL_WINDOW_MS_DEFAULT;

    const msgText = (message.text || message.caption || '').trim();
    const authorId = String(message.authorId || '');
    // Robust activation-bot identification. Telegram does NOT always populate
    // `from.id` for messages produced by a bot — in particular when the bot
    // posts as anonymous group admin, when the chat signs messages as the
    // chat itself (sender_chat), when the message arrives as a forward from
    // the activation bot, or when the message is sent via inline (via_bot).
    // Any of these identity fields matching the configured codeBotUserIds is
    // sufficient to recognize an authorized activation event. We do NOT relax
    // the reply-linkage requirement, the regex check, or the in-buffer target
    // check — only the bot identity match is broadened.
    const senderChatId = String(message.senderChatId || '');
    const viaBotId = String(message.viaBotId || '');
    const forwardFromId = String(message.forwardFromId || '');
    const forwardFromChatId = String(message.forwardFromChatId || '');

    let codeBotIdentitySource = null;
    if (authorId && codeBotUserIds.includes(authorId)) {
      codeBotIdentitySource = 'authorId';
    } else if (senderChatId && codeBotUserIds.includes(senderChatId)) {
      codeBotIdentitySource = 'senderChatId';
    } else if (viaBotId && codeBotUserIds.includes(viaBotId)) {
      codeBotIdentitySource = 'viaBotId';
    } else if (forwardFromId && codeBotUserIds.includes(forwardFromId)) {
      codeBotIdentitySource = 'forwardFromId';
    } else if (forwardFromChatId && codeBotUserIds.includes(forwardFromChatId)) {
      codeBotIdentitySource = 'forwardFromChatId';
    }
    const isCodeBot = codeBotIdentitySource !== null;
    const codeTextMatches = this._matchesActivationCodeRegex(codeRegex, msgText);
    const isCodeMessage = isCodeBot && codeTextMatches;

    // Observability: record cases where the text matches the code regex but no
    // configured bot identity field matched. This is the dominant failure mode
    // in Supernova-style chats where the activation bot posts as anonymous
    // admin and `from.id` is omitted. Pure metric — no behavioural change.
    if (!isCodeMessage && !isCodeBot && this._isSuspiciousUnknownAuthorCodeText(message, msgText, codeTextMatches)) {
      if (this.metrics) this.metrics.code_dropped_unknown_author += 1;
      this.logger?.log?.(`ℹ️ Code-shaped text dropped (no recognized activation-bot identity): chatId=${message.chatId} authorId=${authorId || 'null'} senderChatId=${senderChatId || 'null'} viaBotId=${viaBotId || 'null'} forwardFromId=${forwardFromId || 'null'} forwardFromChatId=${forwardFromChatId || 'null'}`);
    }

    const bufferKey = this._buildPreActivationBufferKey(message.chatId, message.topicId, profile.id);

    if (isCodeMessage) {
      if (this.metrics) {
        this.metrics.code_received_total += 1;
        if (codeBotIdentitySource === 'senderChatId') this.metrics.code_recognized_via_sender_chat += 1;
        else if (codeBotIdentitySource === 'viaBotId') this.metrics.code_recognized_via_via_bot += 1;
        else if (codeBotIdentitySource === 'forwardFromId' || codeBotIdentitySource === 'forwardFromChatId') {
          this.metrics.code_recognized_via_forward += 1;
        }
      }
      // Dump the raw activation envelope for offline replay regardless of
      // whether activation succeeds. Pure side-effect.
      void this._dumpActivationEnvelope(message, profile, codeBotIdentitySource);

      // Require reply linkage — stray bot code posts without reply must not activate
      if (!message.replyToMessageId) {
        if (this.metrics) this.metrics.code_dropped_no_reply += 1;
        this.logger?.log(`⚠️ Code from bot ignored (not a reply): code=${msgText} chatId=${message.chatId}`);
        return;
      }

      const activationCode = msgText;
      this.logger?.log(`🔑 Code activation detected: code=${activationCode} chatId=${message.chatId} topicId=${message.topicId}`);

      // Attach code as alias to existing dedupe entry if present (metadata only, not a hard duplicate gate)
      const existingByCode = this._findDedupeEntryByCode(activationCode, profile.clusterId);
      if (existingByCode) {
        existingByCode.codeAliases = existingByCode.codeAliases || [];
        if (!existingByCode.codeAliases.includes(activationCode) && existingByCode.primaryCode !== activationCode) {
          existingByCode.codeAliases.push(activationCode);
        }
        existingByCode.lastSeenAt = Date.now();
        this.logger?.log(`🔗 Code alias attached to existing dedupe entry: fingerprint=${existingByCode.fingerprint} code=${activationCode}`);
      }

      // Gather pre-activation buffer
      const buffer = this.preActivationBuffers.get(bufferKey) || { messages: [], createdAt: Date.now() };
      const codeTimestamp = message.timestamp || Date.now();
      const windowMessages = buffer.messages.filter((m) =>
        (codeTimestamp - (m.timestamp || codeTimestamp)) < preSignalWindowMs
      );

      // Reply target MUST exist in the active buffer — reject orphan activations.
      // BUT: in real-world ingest (Bot API getUpdates batches, multi-source
      // relays) the activation code can land in our pipeline a few hundred
      // ms BEFORE the photo it replies to, simply because the bot's text
      // reply is shorter than the photo's download/upload chain. Drop only
      // after a few short retries so this race is healed without changing
      // the hard "reply must exist" rule.
      let replyTarget = windowMessages.find((m) => m.messageId === message.replyToMessageId);
      if (!replyTarget) {
        const claimedDraft = this._findDraftByMessageRef(message.chatId, message.topicId, message.replyToMessageId);
        if (claimedDraft?.activationCode && claimedDraft.profile?.id === profile.id) {
          claimedDraft.codeAliases = claimedDraft.codeAliases || [];
          if (!claimedDraft.codeAliases.includes(activationCode) && claimedDraft.activationCode !== activationCode) {
            claimedDraft.codeAliases.push(activationCode);
          }
          this.logger?.log(`🔗 Code reply msgId=${message.messageId} treated as alias for active draft ${claimedDraft.id} (target msgId=${message.replyToMessageId})`);
          return;
        }

        const retryDelayMs = Number.isFinite(activation.replyTargetRetryMs) ? Number(activation.replyTargetRetryMs) : 4000;
        const retryAttempts = Number.isFinite(activation.replyTargetRetryAttempts) ? Number(activation.replyTargetRetryAttempts) : 3;
        for (let attempt = 0; attempt < retryAttempts && !replyTarget; attempt += 1) {
          // Geometric backoff: 1×, 1.5×, 2× of retryDelayMs across attempts
          const wait = Math.round(retryDelayMs * (1 + 0.5 * attempt));
          if (wait > 0) await this._sleep(wait);
          const refreshedBuffer = this.preActivationBuffers.get(bufferKey) || { messages: [] };
          const refreshedWindow = refreshedBuffer.messages.filter((m) =>
            (codeTimestamp - (m.timestamp || codeTimestamp)) < preSignalWindowMs
          );
          replyTarget = refreshedWindow.find((m) => m.messageId === message.replyToMessageId);
          if (replyTarget) {
            // Re-bind buffer + windowMessages references to the refreshed snapshot
            buffer.messages = refreshedBuffer.messages;
            windowMessages.length = 0;
            for (const m of buffer.messages) {
              if ((codeTimestamp - (m.timestamp || codeTimestamp)) < preSignalWindowMs) {
                windowMessages.push(m);
              }
            }
            this.logger?.log(`✅ Code reply target msgId=${message.replyToMessageId} found after retry ${attempt + 1}/${retryAttempts}`);
            break;
          }
        }
        if (!replyTarget) {
          const claimedDraftAfterRetry = this._findDraftByMessageRef(message.chatId, message.topicId, message.replyToMessageId);
          if (claimedDraftAfterRetry?.activationCode && claimedDraftAfterRetry.profile?.id === profile.id) {
            claimedDraftAfterRetry.codeAliases = claimedDraftAfterRetry.codeAliases || [];
            if (!claimedDraftAfterRetry.codeAliases.includes(activationCode) && claimedDraftAfterRetry.activationCode !== activationCode) {
              claimedDraftAfterRetry.codeAliases.push(activationCode);
            }
            this.logger?.log(`🔗 Code reply msgId=${message.messageId} treated as alias for active draft ${claimedDraftAfterRetry.id} (target msgId=${message.replyToMessageId})`);
            return;
          }
          if (this.metrics) this.metrics.code_dropped_orphan_reply += 1;
          this.logger?.log(`⚠️ Code reply target msgId=${message.replyToMessageId} not found in buffer (after ${retryAttempts} retries), ignoring: code=${activationCode}`);
          return;
        }
      }
      if (this.metrics) this.metrics.code_accepted_total += 1;

      // Partition: only take messages belonging to this signal's group
      const sessionMessages = this._partitionSignalGroup(windowMessages, replyTarget);
      const groupPreview = sessionMessages
        .map((m) => `${m.messageId}:${String(m.text || m.caption || '').replace(/\s+/g, ' ').slice(0, 40)}`)
        .join(' | ');
      this.logger?.log(`🧩 Code activation group: code=${activationCode} anchor=${replyTarget.messageId} messages=${groupPreview}`);

      // Snapshot consumed messages — remove from buffer optimistically, but keep
      // a reference so they can be restored if activation fails (read-only source
      // chats cannot re-send the signal, so the buffer is the only copy).
      const consumedIds = new Set(sessionMessages.map((m) => m.messageId));
      const consumedSnapshot = buffer.messages.filter((m) => consumedIds.has(m.messageId));
      buffer.messages = buffer.messages.filter((m) => !consumedIds.has(m.messageId));
      if (buffer.messages.length === 0) {
        this.preActivationBuffers.delete(bufferKey);
      }

      // Don't include the code message itself in signal context — it's just an activation event
      // But we do need any follow-up outcome text that might come after
      const postCodeWindowMs = activation.postCodeFollowupWindowMs ?? POST_CODE_FOLLOWUP_WINDOW_MS_DEFAULT;

      // Create draft with buffered messages
      const draft = this._createDraft(sessionMessages[0] || message, profile);
      draft.activationCode = activationCode;
      draft.activationTimestamp = codeTimestamp;
      draft.sourceTargetLabel = this._resolveSourceTargetLabel(profile, message.chatId, message.topicId);
      // Stash consumed snapshot + buffer key on draft for failure-path restoration
      draft._consumedSnapshot = consumedSnapshot;
      draft._bufferKey = bufferKey;

      for (const bufferedMsg of sessionMessages) {
        this._appendMessageToDraft(draft, bufferedMsg);
      }

      // If postCodeFollowupWindowMs > 0, schedule delayed processing
      if (postCodeWindowMs > 0) {
        draft._postCodeActivatedAt = codeTimestamp;
        draft._postCodeWindowMs = postCodeWindowMs;
        draft.stage = 'awaiting_followup';

        // F4 (review_7): bind the timer closure to the draft only and
        // resolve `profile` at-time-of-fire from `draft.profile` (set
        // deterministically at draft creation). Capturing the outer-scope
        // `profile` here allowed cross-profile leaks when overlapping
        // cluster profiles share a source chat: the dedupe key in
        // `_processDraftWithDedupe` would be tagged with the outer profile
        // while downstream `_processDraft` reads `draft.profile`. Binding
        // both to `draft.profile` keeps the dedupe cluster key and the
        // routing target consistent for the lifetime of the draft.
        const draftRef = draft;
        const timerId = setTimeout(async () => {
          try {
            this._postCodeTimers.delete(draftRef.id);
            if (this.activeDrafts.has(draftRef.id) && draftRef.stage === 'awaiting_followup') {
              this._mergeSafePendingCandidates(draftRef);
              draftRef.stage = 'draft';
              await this._processDraftWithDedupe(draftRef, draftRef.profile);
            }
          } catch (error) {
            this.lastError = error.message;
            this.logger.error(`Telegram ingress post-code timer error: ${error.message}`);
          }
        }, postCodeWindowMs);
        this._postCodeTimers.set(draft.id, timerId);
      } else {
        await this._processDraftWithDedupe(draft, draft.profile);
      }

      return;
    }

    // Check if there's an active draft awaiting follow-up text for this chat+topic+author.
    // Only attach follow-up content when there is explicit evidence it belongs to that
    // draft (reply linkage to one of the draft's messages, or tight burst continuity).
    // Ambiguous same-author messages are left as independent buffer entries to avoid
    // contaminating the first signal's parse with unrelated content.
    const awaitingDraft = this._findAwaitingFollowupDraft(message.chatId, message.topicId, profile.id, message.authorId, message.replyToMessageId, message.metadata?.senderChatId);
    if (awaitingDraft) {
      const isReplyToDraft = message.replyToMessageId && awaitingDraft.indexedMessageIds.has(
        this._buildMessageIndexKey(message.chatId, message.topicId, message.replyToMessageId)
      );
      if (isReplyToDraft) {
        // Track as pending candidate — do NOT merge into draft immediately.
        // If this message later becomes the anchor of a separate activation,
        // it must not have polluted this draft's parse context.
        awaitingDraft.pendingFollowupCandidates = awaitingDraft.pendingFollowupCandidates || [];
        awaitingDraft.pendingFollowupCandidates.push(message);
        this.logger?.log(`📎 Tracked reply-linked follow-up as pending candidate for draft ${awaitingDraft.id} (deferred merge)`);
        // Fall through to buffering below — do NOT return early
      } else if (this._shouldAppendPostCodeContinuation(awaitingDraft, message)) {
        this._appendMessageToDraft(awaitingDraft, message);
        this._reschedulePostCodeProcessing(awaitingDraft);
        this.logger?.log(`📎 Appended same-author post-code continuation msgId=${message.messageId} to draft ${awaitingDraft.id}`);
        return;
      } else {
        this.logger?.log(`📌 Same-author message during follow-up window NOT appended to draft ${awaitingDraft.id} (no reply linkage — buffered independently)`);
        // Do NOT append — leave the awaiting draft untouched; message goes to buffer only
      }
    }

    // Not a code message, not consumed by active draft — buffer it.
    // F2 (review_8): never admit messages authored by the activation code bot
    // (heartbeat / status posts that match codeBotUserIds but fail the code
    // regex). They can't be the reply target for a future code activation and
    // were the dominant source of buffer pressure that evicted real anchors.
    if (codeBotUserIds.includes(authorId)) {
      return;
    }

    if (!this.preActivationBuffers.has(bufferKey)) {
      this.preActivationBuffers.set(bufferKey, { messages: [], createdAt: Date.now() });
    }
    const buffer = this.preActivationBuffers.get(bufferKey);
    buffer.messages.push(message);
    if (this.metrics) this.metrics.message_buffered_pre_activation += 1;
    if (buffer.messages.length === 1 && (message.images?.length || msgText.length > 0)) {
      const sourceLabel = this._resolveSourceTargetLabel(profile, message.chatId, message.topicId) || profile.clusterId || profile.id;
      await this._sendToFeedbackChat(profile, `👀 ${sourceLabel}: сигнал получен, жду код активации.`, {
        sourceChatId: message.chatId,
        sourceMessageId: message.messageId
      });
    }
    if (buffer.messages.length > PRE_ACTIVATION_BUFFER_MAX_MESSAGES) {
      const evicted = buffer.messages.length - PRE_ACTIVATION_BUFFER_MAX_MESSAGES;
      if (this.metrics) this.metrics.buffer_evictions_total += evicted;
      buffer.messages = buffer.messages.slice(-PRE_ACTIVATION_BUFFER_MAX_MESSAGES);
    }
  }

  async _processDraftWithDedupe(draft, profile) {
    // Provisional fingerprint is advisory-only: used for alias tracking and tracing,
    // but NEVER blocks activation. Actual duplicate suppression is deferred to the
    // final semantic fingerprint (after parse) so that coarse text similarity cannot
    // suppress signals that parse into different outcomes/lines.
    const clusterId = profile.clusterId || profile.id;
    const provisionalFp = this._buildProvisionalFingerprint(draft, clusterId);

    if (provisionalFp) {
      const existing = this._findDedupeEntryByFingerprint(provisionalFp);
      if (existing && existing.status !== 'failed') {
        existing.codeAliases = existing.codeAliases || [];
        if (draft.activationCode && !existing.codeAliases.includes(draft.activationCode) && existing.primaryCode !== draft.activationCode) {
          existing.codeAliases.push(draft.activationCode);
        }
        existing.lastSeenAt = Date.now();
        if (existing.draftId && draft.activationCode) {
          this._attachCodeAliasToDraftEntries(existing.draftId, draft.activationCode);
        }
        this.logger?.log(`ℹ️ Provisional dedupe advisory match (not blocking): fp=${provisionalFp} code=${draft.activationCode} → existing=${existing.primaryCode}`);
        // Advisory only — fall through to full parse for semantic dedupe
      }
    }

    // Register provisional dedupe entry for alias/trace tracking
    if (provisionalFp) {
      this._registerDedupeEntry({
        clusterId,
        fingerprint: provisionalFp,
        primaryCode: draft.activationCode || null,
        codeAliases: [],
        originChatId: String(draft.session.chatId),
        originTopicId: draft.session.topicId || null,
        sourceLabel: draft.sourceTargetLabel || null,
        status: 'processing',
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        draftId: draft.id,
        taskId: null
      });
    }

    await this._processDraft(draft);
  }

  async _handleImmediateMessage(message, profile) {
    // Fast-path: image + short outcome caption → skip LLM intent detection
    const caption = (message.caption || message.text || '').trim();
    const hasImages = Boolean(message.images?.length);
    const isObviousSignal = hasImages && /^([1X2]|T[><]\s*[\d.]+|H[12]\s*[+-]?[\d.]+|IT[12][><]\s*[\d.]+|P[12]\s*.+|Over\s+[\d.]+|Under\s+[\d.]+)$/i.test(caption);

    let intent;
    if (isObviousSignal) {
      this.logger?.log(`⚡ Fast-path: image + outcome caption "${caption}" → signal`);
      intent = { intentType: 'signal', confidence: 1.0, notes: 'fast-path: image + outcome caption' };
    } else {
      this.logger?.log(`🔍 Calling detectMessageIntent...`);
      intent = await this.signalParser.detectMessageIntent(message, this._buildParserContext(profile));
    }
    this.logger?.log(`🎯 Intent result: type=${intent.intentType} confidence=${intent.confidence} notes=${intent.notes}`);
    if (intent.intentType === 'stop') {
      await this._handleStopMessage(message, profile, intent);
      return;
    }

    const targetDraft = this._routeMessageToDraft(message, profile);
    const shouldAppendIgnoredMessage = Boolean(
      targetDraft && (
        message.isEdit ||
        message.replyToMessageId ||
        targetDraft.clarification ||
        ['match_ambiguous', 'match_not_found', 'outcome_ambiguous'].includes(targetDraft.stage)
      )
    );

    if (intent.intentType === 'ignore' && !shouldAppendIgnoredMessage) {
      return;
    }

    // F1 (review_17): Gate new-draft creation for messages arriving via a
    // feedback-chat path. Without this gate, _resolveProfileViaFeedbackChat
    // can resolve a profile via reply linkage for an unauthorized sender,
    // _routeMessageToDraft correctly rejects the merge, but the fall-through
    // to _createDraft below would originate a NEW signal draft without any
    // sender gate. Non-allowlisted users in a feedback group chat must not
    // be able to create drafts by replying to a bot anchor.
    if (!targetDraft) {
      const isFeedbackChat = Array.isArray(profile.feedbackChatIds) &&
        profile.feedbackChatIds.map(String).includes(String(message.chatId));
      if (isFeedbackChat) {
        let senderOk = false;
        if (profile.sourceReadOnly && !profile.hasSenderAllowlist) {
          // Cluster profile with no own allowlist — resolve auth against the
          // feedback-chat governing profile (mirrors _routeMessageToDraft
          // feedback-chat auth pattern at lines ~959-971).
          const authProfile = this._resolveProfileForMessage(message) || profile;
          senderOk = !!authProfile.hasSenderAllowlist &&
            !!this.chatProfileManager?.isSenderAllowed(authProfile, message);
        } else if (profile.hasSenderAllowlist) {
          senderOk = !!this.chatProfileManager?.isSenderAllowed(profile, message);
        } else {
          senderOk = true;
        }
        if (!senderOk) {
          this.logger?.log(`⛔ F1: sender not authorized for new draft creation via feedback chat. chatId=${message.chatId} authorId=${message.authorId} profile=${profile.id}`);
          return;
        }
      }
    }

    const draft = targetDraft || this._createDraft(message, profile);
    this._appendMessageToDraft(draft, message);

    if (draft.clarification && draft.clarification.awaitingText === true) {
      draft.clarification = null;
    }

    await this._processDraft(draft);
  }

  async _handleStopMessage(message, profile, intent) {
    const draft = this._resolveStopTarget(message);
    if (!draft) {
      await this._sendSourceChatMessage({ session: { chatId: message.chatId, topicId: message.topicId }, profile }, '🛑 STOP: нет активного сигнала для остановки.');
      return;
    }

    // F4: if the source draft has no authorId (channel-post / anonymous-as-
    // channel signal), require an explicit allowlist match before honoring
    // STOP. Otherwise any sender in a sourceReadOnly cluster chat could
    // cancel a queued bet by replying to the bot's notice. Ordinary author-
    // matching path remains in effect when both ids are known.
    const draftAuthorId = draft.authorId != null ? String(draft.authorId) : null;
    const requesterId = message.authorId != null ? String(message.authorId) : null;
    const draftProfile = draft.profile || profile;

    // F1 (review_5): mirror the _handleCallbackQuery feedback-chat re-auth
    // pattern. STOP messages that arrive in a feedback chat of a
    // sourceReadOnly cluster profile must authorise against the governing
    // profile of THAT feedback chat (e.g. testbets `default` profile with
    // its own allowedSenders list) — not against the cluster source profile,
    // which by design has no allowedSenders. Source-chat STOP attempts keep
    // the existing cluster-profile auth path and fail-closed semantics.
    const isFeedbackChatStop = !!draftProfile?.sourceReadOnly &&
      Array.isArray(draftProfile?.feedbackChatIds) &&
      draftProfile.feedbackChatIds.map(String).includes(String(message.chatId));
    const resolvedFeedbackProfile = isFeedbackChatStop
      ? (this._resolveProfileForMessage(message) || null)
      : null;
    const authProfile = isFeedbackChatStop
      ? (resolvedFeedbackProfile || draftProfile)
      : draftProfile;

    const allowlistOk = this.chatProfileManager?.isSenderAllowed
      ? this.chatProfileManager.isSenderAllowed(authProfile, message)
      : false;
    const stopMode = draftProfile?.activation?.stopMode || null;

    // F3 (review_7): when the STOP arrives in a feedback chat, the
    // operator's STOP message id is NOT a valid id in the cluster source
    // chat — using it as `replyToMessageId` (which the source-readonly
    // reroute path forwards as `sourceMessageId` provenance) produces a
    // misleading "(chat=<source> msg=<feedback_msg_id>)" header AND drops
    // the intra-feedback-chat reply linkage. Pass it as
    // `feedbackReplyToMessageId` instead so the bot replies to the STOP in
    // the same feedback chat and the cross-chat provenance line is omitted.
    // For source-chat STOPs, the existing `replyToMessageId` semantics are
    // preserved.
    const stopReplyOptions = isFeedbackChatStop
      ? { feedbackReplyToMessageId: message.messageId || undefined }
      : { replyToMessageId: message.messageId || undefined };

    if (draftAuthorId === null) {
      // Anonymous source: only operators on the explicit allowlist may STOP,
      // and (for sourceReadOnly profiles) only when the operator opts into
      // open-stop mode for that profile.
      // F1 (review_6): when STOP arrives via a feedback chat of a
      // sourceReadOnly cluster profile, the operator was already re-authed
      // against the feedback-chat profile (authProfile). In that case use
      // authProfile's allowlist as the gate — the cluster profile by design
      // has no allowedSenders and is not the relevant authority for
      // operator-side STOPs. Source-chat-side STOP attempts continue to be
      // gated by the cluster profile (no privilege escalation).
      const profileHasAllowlist = !!authProfile?.hasSenderAllowlist;
      let accepted;
      if (isFeedbackChatStop && authProfile !== draftProfile) {
        accepted = allowlistOk && profileHasAllowlist;
      } else {
        const isSourceReadOnly = !!draftProfile?.sourceReadOnly;
        accepted = allowlistOk && profileHasAllowlist &&
          (!isSourceReadOnly || stopMode === 'open');
      }
      if (!accepted) {
        await this._sendSourceChatMessage(draft, '⛔️ STOP отклонён: источник анонимный, требуется оператор из allowlist.', {
          ...stopReplyOptions
        });
        return;
      }
    } else if (requesterId && draftAuthorId !== requesterId) {
      // Both ids known and don't match — the existing allowlist-aware
      // override lets an explicit operator STOP another's draft.
      // F4 (review_4): require profile.hasSenderAllowlist === true so a
      // missing/empty allowedSenders list (the live vova/supernova shape)
      // fails closed instead of treating "no allowlist" as "everyone is an
      // operator". `isSenderAllowed` itself fails closed for sourceReadOnly
      // profiles without allowlist, but defense-in-depth guards future code
      // paths that might bypass that helper.
      // F1 (review_5): when the STOP arrives via a feedback chat, evaluate
      // hasSenderAllowlist against the resolved feedback-chat profile so
      // that the testbets `default` profile's operator allowlist authorises
      // STOP on cluster drafts.
      const profileHasAllowlist = !!authProfile?.hasSenderAllowlist;
      if (!allowlistOk || !profileHasAllowlist) {
        await this._sendSourceChatMessage(draft, '⛔️ STOP доступен только автору исходного сигнала.', {
          ...stopReplyOptions
        });
        return;
      }
    } else if (requesterId == null && draftAuthorId != null) {
      // F1 (review_14): anonymous requester (channel post with no authorId)
      // targeting a known-author draft — require explicit allowlist match.
      // Without this guard the null requesterId falls through both earlier
      // branches and silently cancels another user's draft.
      const profileHasAllowlist = !!authProfile?.hasSenderAllowlist;
      if (!allowlistOk || !profileHasAllowlist) {
        await this._sendSourceChatMessage(draft, '⛔️ STOP отклонён: анонимный запрос, требуется оператор из allowlist.', {
          ...stopReplyOptions
        });
        return;
      }
    }

    if (!draft.taskId && !draft.taskState) {
      this._archiveDraft(draft, 'stopped_before_queue');
      await this._sendSourceChatMessage(draft, '🛑 Сигнал остановлен.', {
        ...stopReplyOptions
      });
      return;
    }

    if (!this.onStopSignal) {
      await this._sendSourceChatMessage(draft, '⚠️ STOP сейчас недоступен.', {
        ...stopReplyOptions
      });
      return;
    }

    const result = await this.onStopSignal({
      signalId: draft.id,
      taskId: draft.taskId,
      originChatId: String(draft.session.chatId),
      requesterUserId: message.authorId,
      requesterUsername: message.authorUsername
    }, {
      profile,
      draft,
      message,
      intent
    });

    if (result?.accepted && result.cancelled) {
      this._archiveDraft(draft, 'cancelled');
      await this._sendSourceChatMessage(draft, '🛑 Сигнал остановлен.', {
        ...stopReplyOptions
      });
      return;
    }

    if (result?.accepted && result.stopRequested) {
      draft.stage = 'stop_requested';
      draft.taskState = 'executing';
      await this._sendSourceChatMessage(draft, '🛑 STOP принят. Пытаюсь остановить до отправки ставки.', {
        ...stopReplyOptions
      });
      return;
    }

    await this._sendSourceChatMessage(draft, `⚠️ STOP не выполнен: ${result?.error || 'неизвестная причина'}.`, {
      ...stopReplyOptions
    });
  }

  async _handleCallbackQuery(callback) {
    const draft = this._findDraftByClarificationRef(callback.chatId, callback.topicId, callback.messageId) ||
      this.activeDrafts.get(this._decodeCallbackData(callback.data)?.draftId || '');
    if (!draft) {
      await this._answerCallback(callback, 'Уточнение уже неактуально.');
      return;
    }

    const resolvedProfile = this._resolveProfileForMessage(callback);
    const isFeedbackChatCallback = draft.profile.sourceReadOnly &&
      draft.profile.feedbackChatIds?.map(String).includes(String(callback.chatId));

    let callbackAuthorized = false;
    if (isFeedbackChatCallback) {
      // Feedback-chat callbacks: authorize against the feedback chat's governing
      // profile (e.g. testbets_default), not the cluster source profile.
      // If no dedicated profile resolves, fall back to draft.profile but still
      // require an explicit sender allowlist — open profiles must not grant access.
      const authProfile = resolvedProfile || draft.profile;
      callbackAuthorized = !!authProfile.hasSenderAllowlist &&
        !!this.chatProfileManager?.isSenderAllowed(authProfile, callback);
    } else {
      const profile = resolvedProfile || draft.profile;
      const profileMatch = profile && profile.id === draft.profile.id;
      callbackAuthorized = profileMatch &&
        !!this.chatProfileManager?.isSenderAllowed(profile, callback);
    }
    if (!callbackAuthorized) {
      await this._answerCallback(callback, 'Нет доступа к этому уточнению.', true);
      return;
    }

    if (!draft.clarification) {
      await this._answerCallback(callback, 'Уточнение уже закрыто.');
      return;
    }

    const decoded = this._decodeCallbackData(callback.data);
    if (!decoded || decoded.draftId !== draft.id || decoded.type !== draft.clarification.type) {
      await this._answerCallback(callback, 'Уточнение уже устарело.');
      return;
    }

    if (decoded.action === 'reject') {
      draft.clarification.awaitingText = true;
      draft.clarification.expiresAt = Date.now() + this.clarificationTimeoutMs;
      await this._clearClarificationMarkup(draft);
      await this._answerCallback(callback, 'Ок, жду текстовое уточнение.');
      // F3: when the callback comes from the feedback chat (sourceReadOnly
      // routing already moved the clarification there), the message id is
      // valid in the feedback chat — pass as feedbackReplyToMessageId so the
      // rerouted send preserves the intra-chat reply. Otherwise it's a
      // source-chat message id and must be stripped on cross-chat rerouting.
      const callbackInFeedback = !!isFeedbackChatCallback;
      const rejectPrompt = await this._sendSourceChatMessage(draft, decoded.type === 'match'
        ? 'Ок, уточните матч текстом или реплаем.'
        : 'Ок, уточните исход текстом или реплаем.', {
        replyToMessageId: callbackInFeedback ? undefined : (callback.messageId || undefined),
        feedbackReplyToMessageId: callbackInFeedback ? (callback.messageId || undefined) : undefined
      });
      // Index reject follow-up prompt so text replies resolve back to the draft
      const rejectPromptMsgId = rejectPrompt?.result?.message_id || rejectPrompt?.message_id || null;
      if (rejectPromptMsgId) {
        const isSourceRerouted = draft.profile?.sourceReadOnly &&
          this.chatProfileManager?.isSourceTarget(draft.profile, draft.session.chatId, draft.session.topicId);
        const promptChatId = isSourceRerouted
          ? (draft.profile.feedbackChatIds?.[0] || draft.session.chatId)
          : draft.session.chatId;
        const promptTopicId = String(promptChatId) !== String(draft.session.chatId) ? null : draft.session.topicId;
        this._indexClarificationMessage(draft, rejectPromptMsgId, promptChatId, promptTopicId);

        // F2: index every feedback-chat fanout message so operator replies
        // typed in the secondary feedback chat resolve back to this draft.
        const fanout = rejectPrompt?.result?.__feedbackFanout || rejectPrompt?.__feedbackFanout || null;
        if (Array.isArray(fanout)) {
          for (const entry of fanout) {
            const fanoutMsgId = entry?.result?.result?.message_id
              ?? entry?.result?.message_id
              ?? null;
            if (!fanoutMsgId) continue;
            this._indexClarificationMessage(draft, fanoutMsgId, entry.chatId, entry.topicId || null);
          }
        }
      }
      return;
    }

    const option = draft.clarification.options?.[decoded.optionIndex] || null;
    if (!option) {
      await this._answerCallback(callback, 'Вариант уже недоступен.');
      return;
    }

    if (decoded.type === 'match') {
      draft.manualMatch = option;
    } else {
      draft.manualOutcome = option.normalizedIntent || { normalizedOutcome: option.outcome };
    }
    await this._clearClarificationMarkup(draft);
    draft.clarification = null;
    await this._answerCallback(callback, 'Принято.');
    await this._processDraft(draft);
  }

  _routeMessageToDraft(message, profile) {
    const directDraft = this._findDraftByMessageRef(message.chatId, message.topicId, message.messageId);
    if (directDraft) {
      return directDraft;
    }

    if (message.replyToMessageId) {
      const replyDraft = this._findDraftByMessageRef(message.chatId, message.topicId, message.replyToMessageId) ||
        this._findDraftByClarificationRef(message.chatId, message.topicId, message.replyToMessageId);
      if (replyDraft) {
        const profileMatch = profile.id === replyDraft.profile.id ||
          (replyDraft.profile.sourceReadOnly && replyDraft.profile.feedbackChatIds?.map(String).includes(String(message.chatId)));
        if (profileMatch) {
          // F3 (review_13): reply-linkage alone must not bypass sender allowlist.
          // A non-allowlisted user replying to an anchor in a feedback chat must
          // be rejected from appending to the draft.
          // F1 (review_15): For sourceReadOnly cluster drafts reached via a feedback
          // chat, resolve auth against the feedback-chat governing profile — the
          // cluster profile itself may have no allowedSenders so isSenderAllowed
          // always fails for it.
          const isFeedbackChatReply = replyDraft.profile.sourceReadOnly &&
            replyDraft.profile.feedbackChatIds?.map(String).includes(String(message.chatId));
          let senderOk = false;
          if (isFeedbackChatReply) {
            const resolvedAuthProfile = this._resolveProfileForMessage(message);
            const authProfile = resolvedAuthProfile || replyDraft.profile;
            senderOk = !!authProfile.hasSenderAllowlist &&
              !!this.chatProfileManager?.isSenderAllowed(authProfile, message);
          } else {
            senderOk = this.chatProfileManager?.isSenderAllowed
              ? this.chatProfileManager.isSenderAllowed(replyDraft.profile, message)
              : false;
          }
          if (senderOk) {
            return replyDraft;
          }
        }
      }
    }

    if (message.authorId) {
      const sameChatDraft = this._findContinuableDraftForAuthor(message.chatId, message.authorId, message.topicId, message.metadata?.senderChatId);
      if (sameChatDraft) {
        return sameChatDraft;
      }
      // F1 (review_8): an operator may type a clarification answer as a fresh
      // message in a feedback chat without using Telegram's reply-quote on the
      // bot's prompt. The cluster draft lives on a different (source) chat, so
      // the same-chat author lookup misses it. Probe sourceReadOnly cluster
      // drafts whose `profile.feedbackChatIds` contains this chat and that
      // are awaiting a text-only clarification, scoped by author allowlist on
      // the governing cluster profile (fail-closed when the author is not
      // explicitly authorised — `isSenderAllowed` already fail-closes for
      // sourceReadOnly profiles without an `allowedSenders` list).
      const clusterDraft = this._findClusterDraftViaFeedbackChat(message.chatId, message.authorId, message);
      if (clusterDraft) {
        return clusterDraft;
      }
    }

    return null;
  }

  _findClusterDraftViaFeedbackChat(chatId, authorId, message) {
    if (chatId == null || authorId == null) return null;
    const chatIdStr = String(chatId);
    const candidates = [];
    for (const draft of this.activeDrafts.values()) {
      const dProfile = draft.profile;
      if (!dProfile?.sourceReadOnly) continue;
      const fbIds = (dProfile.feedbackChatIds || []).map(String);
      if (!fbIds.includes(chatIdStr)) continue;
      // Only target drafts that are actually awaiting a text-only
      // clarification — otherwise a casual operator message in the feedback
      // chat would be silently merged into an unrelated in-flight draft.
      if (!draft.clarification || draft.clarification.awaitingText !== true) continue;
      // F1 (review_15): Resolve auth against the feedback-chat governing profile
      // instead of the sourceReadOnly cluster profile, which may have no
      // allowedSenders. Fall back to the cluster profile (fail-closed when it
      // has no allowedSenders list).
      const resolvedAuthProfile = this._resolveProfileForMessage(message);
      const authProfile = resolvedAuthProfile || dProfile;
      const allowed = this.chatProfileManager?.isSenderAllowed
        ? (!!authProfile.hasSenderAllowlist && this.chatProfileManager.isSenderAllowed(authProfile, message))
        : false;
      if (!allowed) continue;
      candidates.push(draft);
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.session.lastUpdatedAt - left.session.lastUpdatedAt);
    return candidates[0];
  }

  _resolveStopTarget(message) {
    if (message.replyToMessageId) {
      const replyDraft = this._findDraftByMessageRef(message.chatId, message.topicId, message.replyToMessageId) ||
        this._findDraftByClarificationRef(message.chatId, message.topicId, message.replyToMessageId);
      if (replyDraft) {
        return replyDraft;
      }
    }

    if (message.authorId) {
      return this._findLatestDraftForAuthor(message.chatId, message.authorId, message.topicId, message.metadata?.senderChatId);
    }

    // F4 (review_13): when authorId is null (anonymous channel post) and no
    // replyToMessageId, blindly targeting the latest draft may cancel the wrong
    // one. Only auto-target if exactly one anonymous draft exists; otherwise
    // return null and log a warning prompting the operator to use reply-quote.
    const anonymousDrafts = Array.from(this.activeDrafts.values())
      .filter((d) => (
        String(d.session.chatId) === String(message.chatId) &&
        String(d.session.topicId || '') === String(message.topicId || '') &&
        d.authorId == null
      ));
    if (anonymousDrafts.length === 1) {
      return anonymousDrafts[0];
    }
    if (anonymousDrafts.length > 1) {
      this.logger?.log('⚠️ STOP: multiple anonymous drafts active in chat — use reply-quote to disambiguate');
      return null;
    }
    return this._findLatestDraftInChat(message.chatId, message.topicId);
  }

  _buildMessageIndexKey(chatId, topicId, messageId) {
    if (messageId === null || messageId === undefined) {
      return null;
    }

    return `${String(chatId)}|${String(topicId || '')}|${String(messageId)}`;
  }

  _findDraftByMessageRef(chatId, topicId, messageId) {
    const key = this._buildMessageIndexKey(chatId, topicId, messageId);
    const draftId = key ? this.messageDraftIndex.get(key) : null;
    return draftId ? this.activeDrafts.get(draftId) || null : null;
  }

  _findDraftByClarificationRef(chatId, topicId, messageId) {
    const key = this._buildMessageIndexKey(chatId, topicId, messageId);
    const draftId = key ? this.clarificationDraftIndex.get(key) : null;
    if (draftId) {
      return this.activeDrafts.get(draftId) || null;
    }
    // Fallback: feedback-chat clarifications are indexed with topicId=null,
    // but forum replies may arrive with the General topic id — retry without topicId.
    if (topicId) {
      const fallbackKey = this._buildMessageIndexKey(chatId, null, messageId);
      const fallbackId = fallbackKey ? this.clarificationDraftIndex.get(fallbackKey) : null;
      return fallbackId ? this.activeDrafts.get(fallbackId) || null : null;
    }
    return null;
  }

  _findLatestDraftForAuthor(chatId, authorId, topicId = null, senderChatId = null) {
    const drafts = Array.from(this.activeDrafts.values())
      .filter((draft) => {
        if (String(draft.session.chatId) !== String(chatId)) return false;
        if (String(draft.session.topicId || '') !== String(topicId || '')) return false;
        // F2 (review_13): when authorId is null, "null" === "null" would merge
        // unrelated anonymous channel posts. Use senderChatId as discriminator.
        if (authorId == null) {
          if (draft.authorId != null) return false;
          if (senderChatId == null) return false;
          return String(draft.senderChatId || '') === String(senderChatId);
        }
        return String(draft.authorId) === String(authorId);
      })
      .sort((left, right) => right.session.lastUpdatedAt - left.session.lastUpdatedAt);
    return drafts[0] || null;
  }

  _findContinuableDraftForAuthor(chatId, authorId, topicId = null, senderChatId = null) {
    const draft = this._findLatestDraftForAuthor(chatId, authorId, topicId, senderChatId);
    if (!draft) {
      return null;
    }

    if (draft.clarification) {
      return draft;
    }

    if (!draft.taskState && draft.stage === 'draft') {
      return draft;
    }

    return null;
  }

  _findLatestDraftInChat(chatId, topicId = null) {
    const drafts = Array.from(this.activeDrafts.values())
      .filter((draft) => (
        String(draft.session.chatId) === String(chatId) &&
        String(draft.session.topicId || '') === String(topicId || '')
      ))
      .sort((left, right) => right.session.lastUpdatedAt - left.session.lastUpdatedAt);
    return drafts[0] || null;
  }

  _createDraft(message, profile) {
    this._signalSeq += 1;
    const sessionId = `tgd_${Date.now().toString(36)}_${this._signalSeq.toString(36)}`;
    const session = new TelegramIntakeSession({
      sessionId,
      chatId: message.chatId,
      topicId: message.topicId,
      mediaGroupId: message.mediaGroupId,
      createdAt: message.timestamp
    }, {
      windowMs: this.sessionWindowMs
    });

    const draft = {
      id: sessionId,
      session,
      profile,
      authorId: message.authorId || null,
      senderChatId: message.metadata?.senderChatId || null,
      authorUsername: message.authorUsername || null,
      createdAt: message.timestamp,
      stage: 'draft',
      parsedSignal: null,
      clarification: null,
      processing: false,
      needsReprocess: false,
      lastTaskSignature: null,
      lastClarificationSignature: null,
      taskId: null,
      taskState: null,
      taskExecutionState: null,
      lastSourceMessageId: null,
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set(),
      manualMatch: null,
      manualOutcome: null,
      activationCode: null,
      activationTimestamp: null,
      codeAliases: [],
      pendingFollowupCandidates: [],
      sourceTargetLabel: null
    };

    this.activeDrafts.set(draft.id, draft);
    return draft;
  }

  _appendMessageToDraft(draft, message) {
    const addedMessage = draft.session.addMessage(message);
    draft.lastSourceMessageId = addedMessage.messageId || draft.lastSourceMessageId;
    this._indexDraftMessage(draft, addedMessage.messageId);
    if (draft.stage !== 'awaiting_followup') {
      draft.stage = draft.taskState === 'executing' ? 'executing' : 'draft';
    }
    return addedMessage;
  }

  _indexDraftMessage(draft, messageId) {
    const key = this._buildMessageIndexKey(draft.session.chatId, draft.session.topicId, messageId);
    if (!key) {
      return;
    }
    this.messageDraftIndex.set(key, draft.id);
    draft.indexedMessageIds.add(key);
  }

  _indexClarificationMessage(draft, messageId, targetChatId, targetTopicId) {
    const chatId = targetChatId != null ? targetChatId : draft.session.chatId;
    const topicId = targetTopicId !== undefined ? targetTopicId : draft.session.topicId;
    const key = this._buildMessageIndexKey(chatId, topicId, messageId);
    if (!key) {
      return;
    }
    this.clarificationDraftIndex.set(key, draft.id);
    draft.indexedClarificationMessageIds.add(key);
  }

  /**
   * F2 (review_4): index a notifier-sent anchor message (queued notice,
   * lifecycle status update, etc.) so a STOP reply targeting that message in
   * any feedback chat resolves back to the originating draft. Uses the same
   * clarificationDraftIndex as text-uplift prompts so existing draft cleanup
   * (_archiveDraft) tears the entries down on cancellation/completion.
   *
   * Returns true iff the draft is still active and the index entry was added.
   */
  indexTaskAnchorMessage(signalId, anchor = {}) {
    if (!signalId || !anchor || anchor.messageId == null) {
      return false;
    }
    const draft = this._resolveDraftForSignalId(signalId)?.draft || null;
    if (!draft) {
      return false;
    }
    this._indexClarificationMessage(
      draft,
      anchor.messageId,
      anchor.chatId != null ? anchor.chatId : draft.session.chatId,
      anchor.topicId !== undefined ? anchor.topicId : null
    );
    return true;
  }

  _recordRejectedSignalMetric(state) {
    if (!this.metrics) {
      return;
    }
    if (state === 'match_not_found') this.metrics.signal_match_not_found_total += 1;
    else if (state === 'match_ambiguous') this.metrics.signal_match_ambiguous_total += 1;
    else if (state === 'outcome_ambiguous') this.metrics.signal_outcome_ambiguous_total += 1;
    else if (state === 'rejected_low_confidence') this.metrics.signal_rejected_low_confidence_total += 1;
  }

  async _processDraft(draft) {
    if (!draft || !this.activeDrafts.has(draft.id)) {
      return;
    }

    if (draft.processing) {
      draft.needsReprocess = true;
      return;
    }

    draft.processing = true;
    try {
      const parsed = await this.signalParser.parseSession(draft.session, this._buildParserContext(draft.profile, draft));
      draft.parsedSignal = parsed;
      if (parsed.state === 'multi_signal' && Array.isArray(parsed.signals)) {
        this.logger?.log(`📋 Parsed multi-signal: count=${parsed.signals.length} ready=${parsed.signals.filter((signal) => signal.state === 'ready').length} confidence=${parsed.confidence}`);
        await this._processMultiParsedDraft(draft, parsed);
        return;
      }
      this.logger?.log(`📋 Parsed signal: intent=${parsed.intentType} state=${parsed.state} sport=${parsed.sport} home=${parsed.home} away=${parsed.away} outcome=${parsed.normalizedOutcome} matchId=${parsed.bookmakerMatchId} confidence=${parsed.confidence}`);

      if (parsed.intentType === 'ignore') {
        this._archiveDraft(draft, 'ignored');
        return;
      }

      if (REVIEW_REJECTION_STATES.has(parsed.state)) {
        this._recordRejectedSignalMetric(parsed.state);
        draft.stage = parsed.state;
        if (parsed.clarification) {
          await this._sendClarificationPrompt(draft, parsed);
        } else {
          if (draft.clarification) {
            await this._clearClarificationMarkup(draft);
          }
          draft.clarification = null;
          draft.lastClarificationSignature = null;
          this.logger?.log?.(`🧹 Telegram signal terminal reject: signalId=${draft.id} state=${parsed.state} reason=${parsed.reason || 'n/a'}`);
          this._archiveDraft(draft, parsed.state);
        }
        return;
      }

      if (draft.clarification) {
        await this._clearClarificationMarkup(draft);
      }
      draft.clarification = null;
      draft.lastClarificationSignature = null;

      if (parsed.state !== 'ready') {
        draft.stage = parsed.state || 'rejected';
        this.logger?.log?.(`🧹 Telegram signal non-ready terminal state: signalId=${draft.id} state=${draft.stage} reason=${parsed.reason || parsed.error || 'n/a'}`);
        this._archiveDraft(draft, draft.stage === 'stop_requested' ? 'stopped_before_queue' : draft.stage);
        return;
      }
      if (this.metrics) this.metrics.signal_ready_total += 1;

      const payload = draft.session.toLLMPayload();
      const taskPayload = this._buildTaskPayload(draft, parsed, payload);

      // Final dedupe check returned null — this is a duplicate
      if (!taskPayload) {
        this._archiveDraft(draft, 'dedupe_final');
        if (draft.profile?.feedbackChatIds?.length) {
          await this._sendToFeedbackChat(draft.profile, `🔁 Дубль: ${parsed.home} vs ${parsed.away} ${parsed.normalizedOutcome} (code=${draft.activationCode || 'none'})`, {
            draftId: draft.id,
            sourceChatId: draft.session?.chatId || null,
            sourceMessageId: draft.lastSourceMessageId || null
          });
        }
        return;
      }

      const taskSignature = this._buildTaskSignature(taskPayload);
      if (draft.taskState === 'queued' && draft.lastTaskSignature === taskSignature) {
        draft.stage = 'queued';
        return;
      }

      let enqueueResult = null;
      if (this.onResolvedSignal) {
        enqueueResult = await this.onResolvedSignal(taskPayload, {
          draft,
          session: draft.session,
          profile: draft.profile,
          parsedSignal: parsed
        });
      }

      if (enqueueResult?.accepted) {
        if (this.metrics) this.metrics.signal_enqueued_total += 1;
        draft.taskId = enqueueResult.taskId || draft.taskId || taskPayload.id || null;
        draft.taskState = enqueueResult.executing ? 'executing' : 'queued';
        draft.stage = enqueueResult.executing ? 'executing' : 'queued';
        draft.lastTaskSignature = taskSignature;
        // Promote dedupe entries to 'accepted' so they survive restart filtering
        this._updateDedupeStatusForDraft(draft.id, 'accepted', draft.taskId);
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: parsed.home,
          away: parsed.away,
          outcome: parsed.normalizedOutcome,
          queueDecision: parsed.queueDecision,
          confidence: parsed.confidence,
          accepted: true,
          updated: enqueueResult.updated === true,
          taskId: draft.taskId,
          activationCode: draft.activationCode || null,
          dedupeFingerprint: taskPayload.dedupeFingerprint || null
        });
        return;
      }

      draft.stage = 'ready';
      if (enqueueResult?.error) {
        // F4 (review_8): only purge the dedupe entry on enqueue rejection when
        // there is no existing task to protect. The most dangerous path is
        // `_updateExistingTelegramTask` returning "Telegram task is already
        // executing" — in that case `enqueueResult.taskId` references the
        // in-flight task, and the dedupe entry is precisely what guards
        // against a follow-up signal with the same fingerprint slipping past
        // and producing a duplicate paid stake. For transient rejections
        // (e.g. "queue full") with no existing task, retain the historical
        // behaviour and clear the entry so the operator's retry can succeed.
        const existingTaskActive = !!enqueueResult.taskId;
        draft._preserveDedupeOnArchive = existingTaskActive;
        if (!existingTaskActive) {
          this._removeDedupeEntriesForDraft(draft.id);
        }
        // Restore consumed messages to buffer so the signal is re-activatable
        this._restoreConsumedMessages(draft._bufferKey, draft._consumedSnapshot);
        draft._consumedSnapshot = null; // prevent double-restore in _archiveDraft
        this.logger?.log(`♻️ Restored consumed messages after enqueue rejection: ${enqueueResult.error} (preserveDedupe=${existingTaskActive})`);
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: draft.id,
          profileId: draft.profile.id,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: parsed.home,
          away: parsed.away,
          outcome: parsed.normalizedOutcome,
          queueDecision: parsed.queueDecision,
          confidence: parsed.confidence,
          accepted: false,
          error: enqueueResult.error
        });
        // Archive the failed draft to free the signal for re-activation
        this._archiveDraft(draft, 'enqueue_rejected');
      }
    } catch (error) {
      this.lastError = error.message;
      this.logger.error(`Telegram ingress draft error: ${error.message}`);
      await this._notifySessionError(draft, error);
      // Error — remove dedupe entries so retries are not blocked
      this._removeDedupeEntriesForDraft(draft.id);
      // Restore consumed messages to buffer so the signal is re-activatable
      this._restoreConsumedMessages(draft._bufferKey, draft._consumedSnapshot);
      draft._consumedSnapshot = null; // prevent double-restore in _archiveDraft
      this.logger?.log(`♻️ Restored consumed messages after parse/processing error`);
      this._pushRecentSignal({
        processedAt: Date.now(),
        sessionId: draft.id,
        profileId: draft.profile.id,
        chatId: draft.session.chatId,
        messageIds: draft.session.toLLMPayload().messageIds,
        queueDecision: 'error',
        accepted: false,
        error: error.message
      });
      // Archive the failed draft to free the signal for re-activation
      this._archiveDraft(draft, 'parse_error');
    } finally {
      draft.processing = false;
      if (draft.needsReprocess) {
        draft.needsReprocess = false;
        await this._processDraft(draft);
      }
    }
  }

  async _processMultiParsedDraft(draft, parsed) {
    if (!draft || !this.activeDrafts.has(draft.id)) return;
    if (draft.clarification) {
      await this._clearClarificationMarkup(draft);
    }
    draft.clarification = null;
    draft.lastClarificationSignature = null;

    const payload = draft.session.toLLMPayload();
    const signals = Array.isArray(parsed.signals) ? parsed.signals : [];
    let acceptedCount = 0;
    let terminalRejectCount = 0;
    const enqueueErrors = [];

    for (let i = 0; i < signals.length; i += 1) {
      const child = signals[i];
      const childSignalId = `${draft.id}#${i + 1}`;
      this.logger?.log(`📋 Multi child ${i + 1}/${signals.length}: state=${child.state} sport=${child.sport} home=${child.home} away=${child.away} outcome=${child.normalizedOutcome} matchId=${child.bookmakerMatchId}`);

      if (REVIEW_REJECTION_STATES.has(child.state)) {
        this._recordRejectedSignalMetric(child.state);
        terminalRejectCount += 1;
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: childSignalId,
          parentSessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: child.home,
          away: child.away,
          outcome: child.normalizedOutcome,
          queueDecision: child.queueDecision,
          confidence: child.confidence,
          accepted: false,
          activationCode: draft.activationCode || null,
          reason: child.reason || child.state
        });
        continue;
      }

      if (child.state !== 'ready') {
        terminalRejectCount += 1;
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: childSignalId,
          parentSessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: child.home,
          away: child.away,
          outcome: child.normalizedOutcome,
          queueDecision: child.queueDecision || 'rejected',
          confidence: child.confidence,
          accepted: false,
          activationCode: draft.activationCode || null,
          reason: child.reason || child.state
        });
        continue;
      }

      if (this.metrics) this.metrics.signal_ready_total += 1;
      this._registerChildSignal(draft, childSignalId, i + 1, signals.length);
      const taskPayload = this._buildTaskPayload(draft, child, payload, {
        signalId: childSignalId,
        parentSignalId: draft.id,
        childIndex: i + 1,
        childTotal: signals.length
      });

      if (!taskPayload) {
        this._unregisterChildSignal(draft, childSignalId);
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: childSignalId,
          parentSessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: child.home,
          away: child.away,
          outcome: child.normalizedOutcome,
          queueDecision: 'dedupe_final',
          confidence: child.confidence,
          accepted: false,
          activationCode: draft.activationCode || null
        });
        continue;
      }

      let enqueueResult = null;
      if (this.onResolvedSignal) {
        enqueueResult = await this.onResolvedSignal(taskPayload, {
          draft,
          session: draft.session,
          profile: draft.profile,
          parsedSignal: child,
          parentParsedSignal: parsed,
          childSignalId,
          childIndex: i + 1,
          childTotal: signals.length
        });
      }

      if (enqueueResult?.accepted) {
        acceptedCount += 1;
        if (this.metrics) this.metrics.signal_enqueued_total += 1;
        const childMeta = draft.childSignals.get(childSignalId) || {};
        draft.childSignals.set(childSignalId, {
          ...childMeta,
          signalId: childSignalId,
          taskId: enqueueResult.taskId || taskPayload.id || null,
          state: enqueueResult.executing ? 'executing' : 'queued',
          executionState: enqueueResult.executing ? 'started' : childMeta.executionState || null,
          lastTaskUpdateAt: Date.now()
        });
        draft.taskId = draft.taskId || enqueueResult.taskId || taskPayload.id || null;
        draft.taskState = enqueueResult.executing ? 'executing' : 'queued';
        draft.stage = enqueueResult.executing ? 'executing' : 'queued';
        this._updateDedupeStatusForDraft(childSignalId, 'accepted', enqueueResult.taskId || taskPayload.id || null);
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: childSignalId,
          parentSessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: child.home,
          away: child.away,
          outcome: child.normalizedOutcome,
          queueDecision: child.queueDecision,
          confidence: child.confidence,
          accepted: true,
          updated: enqueueResult.updated === true,
          taskId: enqueueResult.taskId || taskPayload.id || null,
          activationCode: draft.activationCode || null,
          dedupeFingerprint: taskPayload.dedupeFingerprint || null
        });
      } else {
        enqueueErrors.push(enqueueResult?.error || 'enqueue_rejected');
        this._unregisterChildSignal(draft, childSignalId);
        this._removeDedupeEntriesForDraft(childSignalId);
        this._pushRecentSignal({
          processedAt: Date.now(),
          sessionId: childSignalId,
          parentSessionId: draft.id,
          profileId: draft.profile.id,
          clusterId: draft.profile.clusterId || null,
          chatId: draft.session.chatId,
          messageIds: payload.messageIds,
          home: child.home,
          away: child.away,
          outcome: child.normalizedOutcome,
          queueDecision: child.queueDecision,
          confidence: child.confidence,
          accepted: false,
          error: enqueueResult?.error || 'enqueue_rejected'
        });
      }
    }

    if (acceptedCount > 0) {
      this.logger?.log(`📦 Multi-signal accepted ${acceptedCount}/${signals.length} child task(s), rejected=${terminalRejectCount}, enqueueErrors=${enqueueErrors.length}`);
      return;
    }

    if (enqueueErrors.length > 0) {
      this._restoreConsumedMessages(draft._bufferKey, draft._consumedSnapshot);
      draft._consumedSnapshot = null;
      this.logger?.log(`♻️ Restored consumed messages after multi-signal enqueue rejection: ${enqueueErrors.join('; ')}`);
      this._archiveDraft(draft, 'enqueue_rejected');
      return;
    }

    const archiveReason = terminalRejectCount > 0 ? 'rejected_low_confidence' : 'match_not_found';
    this.logger?.log(`🧹 Telegram multi-signal terminal reject: signalId=${draft.id} reason=${archiveReason}`);
    this._archiveDraft(draft, archiveReason);
  }

  _registerChildSignal(draft, childSignalId, childIndex, childTotal) {
    if (!draft || !childSignalId) return;
    draft.childSignals = draft.childSignals || new Map();
    draft.childSignals.set(childSignalId, {
      signalId: childSignalId,
      parentSignalId: draft.id,
      childIndex,
      childTotal,
      state: 'ready',
      taskId: null,
      executionState: null,
      lastTaskUpdateAt: Date.now()
    });
    this.childSignalParents.set(childSignalId, draft.id);
  }

  _unregisterChildSignal(draft, childSignalId) {
    if (!childSignalId) return;
    this.childSignalParents.delete(childSignalId);
    if (draft?.childSignals) {
      draft.childSignals.delete(childSignalId);
    }
  }

  _buildTaskPayload(draft, parsed, payload, options = {}) {
    const outcomeData = Number.isFinite(Number(parsed.betNum))
      ? {
        score2: {
          value: parsed.expectedOdds || undefined,
          raw: {
            bet_num: Number(parsed.betNum)
          }
        }
      }
      : undefined;

    const clusterId = draft.profile?.clusterId || null;
    const activationCode = draft.activationCode || null;
    const sourceTargetLabel = draft.sourceTargetLabel || null;
    const signalId = options.signalId || draft.id;
    const parentSignalId = options.parentSignalId || null;
    const childIndex = options.childIndex || null;
    const childTotal = options.childTotal || null;

    // Build final fingerprint for dedupe.
    // F3 (review_8): namespace by `profile.id` (not the literal "default") so
    // two profiles without an explicit clusterId don't share a dedupe bucket.
    // For the live `default` profile this still produces `final:default:...`,
    // preserving backward compatibility with restored entries.
    const dedupeFingerprint = this._buildFinalFingerprint(parsed, clusterId, draft.profile?.id);

    // Check final fingerprint dedupe
    // F2: dedupe must run for ALL modes — immediate-mode profiles (no
    // activation block) have draft.activationCode === null, but the final
    // fingerprint is still a sound dedupe key. Gating on activationCode
    // disabled dedupe entirely for the live default profile.
    if (dedupeFingerprint) {
      const existing = this._findDedupeEntryByFingerprint(dedupeFingerprint);
      if (existing && existing.draftId !== signalId && existing.status !== 'failed') {
        if (activationCode && !existing.codeAliases?.includes(activationCode) && existing.primaryCode !== activationCode) {
          existing.codeAliases = existing.codeAliases || [];
          existing.codeAliases.push(activationCode);
        }
        existing.lastSeenAt = Date.now();
        this.logger?.log(`🔁 Final dedupe hit: fp=${dedupeFingerprint} code=${activationCode}`);
        return null; // Signal to caller that this is a duplicate
      }

      // Update or register final fingerprint
      this._registerDedupeEntry({
        clusterId,
        fingerprint: dedupeFingerprint,
        primaryCode: activationCode,
        codeAliases: [],
        originChatId: String(draft.session.chatId),
        originTopicId: draft.session.topicId || null,
        sourceLabel: sourceTargetLabel,
        status: 'ready',
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        draftId: signalId,
        taskId: null
      });
    }

    return {
      home: parsed.home,
      away: parsed.away,
      sport: parsed.sport,
      mode: parsed.mode,
      outcome: parsed.normalizedOutcome,
      outcomeCandidates: parsed.outcomeCandidates,
      candidateLadder: parsed.candidateLadder,
      normalizedIntent: parsed.normalizedIntent,
      stake: parsed.stake || undefined,
      minOdds: parsed.minOdds || undefined,
      maxOdds: parsed.maxOdds || undefined,
      expectedOdds: parsed.expectedOdds || undefined,
      explicitMinOdds: parsed.explicitMinOdds || undefined,
      bookmakerMatchId: parsed.bookmakerMatchId || undefined,
      outcomeData,
      matchDate: parsed.matchDate || undefined,
      profileId: draft.profile.id,
      sourceProfileId: draft.profile.id,
      clusterId,
      originChatId: String(draft.session.chatId),
      chatId: String(draft.session.chatId),
      topicId: draft.session.topicId || undefined,
      messageIds: payload.messageIds,
      textContext: payload.textContext,
      signalId,
      parentSignalId: parentSignalId || undefined,
      multiSignalIndex: childIndex || undefined,
      multiSignalTotal: childTotal || undefined,
      activationCode,
      codeAliases: draft.codeAliases || [],
      dedupeFingerprint: dedupeFingerprint || undefined,
      originTargetLabel: sourceTargetLabel,
      telegramContext: {
        profileId: draft.profile.id,
        clusterId,
        originChatId: String(draft.session.chatId),
        chatId: String(draft.session.chatId),
        topicId: draft.session.topicId || null,
        messageIds: payload.messageIds,
        textContext: payload.textContext,
        feedbackChatIds: draft.profile.feedbackChatIds,
        signalId,
        parentSignalId,
        multiSignalIndex: childIndex,
        multiSignalTotal: childTotal,
        authorId: draft.authorId || null,
        authorUsername: draft.authorUsername || null,
        activationCode,
        dedupeFingerprint: dedupeFingerprint || null,
        originTargetLabel: sourceTargetLabel
      },
      feedbackChatIds: draft.profile.feedbackChatIds,
      authorId: draft.authorId || null,
      authorUsername: draft.authorUsername || null
    };
  }

  _buildTaskSignature(taskPayload) {
    return JSON.stringify({
      home: taskPayload.home,
      away: taskPayload.away,
      sport: taskPayload.sport,
      mode: taskPayload.mode,
      outcome: taskPayload.outcome,
      stake: taskPayload.stake || null,
      minOdds: taskPayload.minOdds || null,
      bookmakerMatchId: taskPayload.bookmakerMatchId || null,
      matchDate: taskPayload.matchDate || null,
      candidateLadder: (taskPayload.candidateLadder || []).map((candidate) => candidate.outcome)
    });
  }

  async _sendClarificationPrompt(draft, parsed) {
    if (!parsed.clarification) {
      return;
    }

    const signature = JSON.stringify({
      type: parsed.clarification.type,
      prompt: parsed.clarification.prompt,
      options: (parsed.clarification.options || []).map((option) => option.label || option.outcome || option.bookmakerMatchId || option.matchIndex)
    });

    if (draft.lastClarificationSignature === signature && draft.clarification) {
      draft.clarification.expiresAt = Date.now() + this.clarificationTimeoutMs;
      return;
    }

    if (draft.clarification?.messageId) {
      await this._clearClarificationMarkup(draft);
    }
    draft.lastClarificationSignature = signature;
    draft.clarification = {
      ...parsed.clarification,
      expiresAt: Date.now() + this.clarificationTimeoutMs,
      awaitingText: parsed.clarification.waitForTextOnly === true,
      messageId: null
    };

    const lines = [
      parsed.clarification.prompt,
      parsed.home && parsed.away ? `${parsed.home} vs ${parsed.away}` : null,
      parsed.notes || null
    ].filter(Boolean);

    const replyMarkup = parsed.clarification.waitForTextOnly
      ? undefined
      : {
        inline_keyboard: [
          ...(parsed.clarification.options || []).map((option, index) => ([{
            text: option.label || option.outcome,
            callback_data: this._encodeCallbackData({
              draftId: draft.id,
              type: parsed.clarification.type,
              action: 'confirm',
              optionIndex: index
            })
          }])),
          [{
            text: parsed.clarification.rejectLabel,
            callback_data: this._encodeCallbackData({
              draftId: draft.id,
              type: parsed.clarification.type,
              action: 'reject',
              optionIndex: -1
            })
          }]
        ]
      };

    const sent = await this._sendSourceChatMessage(draft, lines.join('\n'), {
      replyMarkup,
      replyToMessageId: draft.lastSourceMessageId || undefined
    });
    const clarificationMessageId = sent?.result?.message_id || sent?.message_id || null;
    draft.clarification.messageId = clarificationMessageId;
    // Track actual chat where clarification was delivered (may be feedback chat for sourceReadOnly)
    if (draft.profile?.sourceReadOnly && this.chatProfileManager?.isSourceTarget(draft.profile, draft.session.chatId, draft.session.topicId)) {
      draft.clarification.targetChatId = draft.profile.feedbackChatIds?.[0] || draft.session.chatId;
    } else {
      draft.clarification.targetChatId = draft.session.chatId;
    }
    const clTargetChatId = draft.clarification.targetChatId;
    const clTargetTopicId = (String(clTargetChatId) !== String(draft.session.chatId)) ? null : draft.session.topicId;
    this._indexClarificationMessage(draft, clarificationMessageId, clTargetChatId, clTargetTopicId);

    // F2: when the clarification was rerouted into one or more feedback
    // chats (sourceReadOnly profile), index the message_id returned from
    // every feedback chat so operator callbacks/replies in the secondary
    // chat (DM backup, mirror group) resolve back to the same draft.
    const fanout = sent?.result?.__feedbackFanout || sent?.__feedbackFanout || null;
    const targets = [];
    if (Array.isArray(fanout) && fanout.length > 0) {
      for (const entry of fanout) {
        // entry.result is the raw send response which itself wraps a .result
        // payload (Telegram bot API: { ok, result: { message_id, ... } }).
        // Some test doubles return { message_id } directly — accept both.
        const fanoutMsgId = entry?.result?.result?.message_id
          ?? entry?.result?.message_id
          ?? null;
        if (!fanoutMsgId) continue;
        // For feedback chats topicId is null (or the configured forum topic);
        // use the entry's topicId so cross-chat lookups stay consistent.
        this._indexClarificationMessage(draft, fanoutMsgId, entry.chatId, entry.topicId || null);
        targets.push({ chatId: entry.chatId, messageId: fanoutMsgId, topicId: entry.topicId || null });
      }
    }
    if (targets.length === 0 && clarificationMessageId) {
      targets.push({ chatId: clTargetChatId, messageId: clarificationMessageId, topicId: clTargetTopicId });
    }
    draft.clarification.targets = targets;
  }

  async _clearClarificationMarkup(draft) {
    if (!draft?.clarification || !this.botClient?.editMessageReplyMarkup) {
      return;
    }

    // F2: clear keyboards in EVERY feedback chat the prompt was posted in
    // (operators with primary group + DM backup) — otherwise stale buttons
    // remain in the secondary chats and confuse operators.
    const targets = Array.isArray(draft.clarification.targets) && draft.clarification.targets.length > 0
      ? draft.clarification.targets
      : (draft.clarification.messageId
        ? [{ chatId: draft.clarification.targetChatId || draft.session.chatId, messageId: draft.clarification.messageId }]
        : []);

    for (const target of targets) {
      if (!target?.messageId) continue;
      try {
        await this.botClient.editMessageReplyMarkup(target.chatId, target.messageId, { inline_keyboard: [] });
      } catch (error) {
        this.logger.log(`⚠️ Failed to clear clarification markup chat=${target.chatId} msg=${target.messageId}: ${error.message}`);
      }
    }
  }

  _encodeCallbackData(payload) {
    return [
      'tg2',
      payload.type === 'match' ? 'm' : 'o',
      payload.action === 'reject' ? 'r' : 'c',
      payload.draftId,
      String(payload.optionIndex ?? -1)
    ].join('|');
  }

  _decodeCallbackData(data) {
    const parts = String(data || '').split('|');
    if (parts.length !== 5 || parts[0] !== 'tg2') {
      return null;
    }

    return {
      type: parts[1] === 'm' ? 'match' : 'outcome',
      action: parts[2] === 'r' ? 'reject' : 'confirm',
      draftId: parts[3],
      optionIndex: Number(parts[4])
    };
  }

  async _answerCallback(callback, text, showAlert = false) {
    if (!this.botClient?.answerCallbackQuery || !callback.callbackId) {
      return;
    }

    try {
      await this.botClient.answerCallbackQuery(callback.callbackId, text, { show_alert: showAlert });
    } catch (error) {
      this.logger.log(`⚠️ Failed to answer callback query: ${error.message}`);
    }
  }

  _resolveProfileForMessage(message) {
    const filters = this._buildRoutingFilters(message);

    this._autoNormalizeKnownSourceTopic(message, filters);

    let profile = this.chatProfileManager?.resolveIngressProfile(message, filters) || null;
    if (!profile && this.allowUnmappedChats && this.defaultProfileId) {
      const defaultProfile = this.chatProfileManager?.getProfile(this.defaultProfileId) || null;
      if (defaultProfile && this.chatProfileManager?.isSenderAllowed(defaultProfile, message)) {
        const policy = this.chatProfileManager?.resolveExecutionPolicy({
          profileId: this.defaultProfileId,
          bookmakerId: this.bookmakerId,
          accountId: this.accountId,
          mode: this.runtimeMode
        });
        if (policy?.enabled) {
          profile = defaultProfile;
        }
      }
    }

    // F1 (review_9): feedback-chat fallback. The live `default` profile shape
    // (sourceChatIds=[TESTBETS], feedbackChatIds=[ELENA DM]) does NOT match
    // resolveIngressProfile when the operator types in their DM, because that
    // chat is not in any sourceChatIds set. Without this fallback,
    // _handleMessage short-circuits and STOP / free-text-uplift messages are
    // silently dropped. Match against profiles whose feedbackChatIds contains
    // this chatId AND that authorise the sender (explicit allowlist match OR
    // an explicit reply linkage to a known anchor message owned by that
    // profile's draft). When multiple candidates qualify, prefer the profile
    // owning the draft referenced by the operator's reply, then the most
    // recently active draft owned by an authorised cluster, then the first.
    if (!profile) {
      profile = this._resolveProfileViaFeedbackChat(message, filters);
    }

    return profile;
  }

  _resolveProfileViaFeedbackChat(message, filters) {
    if (!this.chatProfileManager || message?.chatId == null) {
      return null;
    }
    const chatIdStr = String(message.chatId);
    const enabled = (typeof this.chatProfileManager.getEnabledProfiles === 'function')
      ? this.chatProfileManager.getEnabledProfiles(filters)
      : [];
    if (!enabled.length) {
      return null;
    }

    const allowlistCandidates = [];
    const replyLinkedCandidates = [];

    let replyDraft = null;
    if (message.replyToMessageId) {
      replyDraft = this._findDraftByMessageRef(message.chatId, message.topicId, message.replyToMessageId)
        || this._findDraftByClarificationRef(message.chatId, message.topicId, message.replyToMessageId)
        || null;
    }

    for (const candidate of enabled) {
      const fbIds = (candidate.feedbackChatIds || []).map(String);
      if (!fbIds.includes(chatIdStr)) continue;

      const senderAllowed = !!candidate.hasSenderAllowlist
        && !!this.chatProfileManager.isSenderAllowed(candidate, message);

      if (senderAllowed) {
        allowlistCandidates.push(candidate);
        continue;
      }

      // Reply linkage to an anchor owned by a draft of this profile is
      // sufficient evidence that the sender is engaging with this profile's
      // workflow. Required for cluster profiles which by design have no
      // operator allowlist (sourceReadOnly + no allowedSenders → fail-closed
      // in isSenderAllowed). Without reply linkage we keep the strict
      // sender-allowlist gate.
      if (replyDraft && replyDraft.profile && replyDraft.profile.id === candidate.id) {
        replyLinkedCandidates.push(candidate);
      }
    }

    if (replyLinkedCandidates.length === 0 && allowlistCandidates.length === 0) {
      return null;
    }

    if (replyDraft && replyDraft.profile) {
      const replyMatch = [...allowlistCandidates, ...replyLinkedCandidates]
        .find((c) => c.id === replyDraft.profile.id);
      if (replyMatch) return replyMatch;
    }

    if (allowlistCandidates.length === 1) return allowlistCandidates[0];
    if (allowlistCandidates.length > 1) {
      // Disambiguate by most-recently active draft owned by one of the
      // allowlisted candidates; fall back to the first candidate.
      let best = null;
      let bestTs = -Infinity;
      for (const draft of this.activeDrafts.values()) {
        if (!draft?.profile) continue;
        if (!allowlistCandidates.some((c) => c.id === draft.profile.id)) continue;
        const ts = draft.session?.lastUpdatedAt || 0;
        if (ts > bestTs) {
          bestTs = ts;
          best = draft.profile;
        }
      }
      return best || allowlistCandidates[0];
    }

    return replyLinkedCandidates[0] || null;
  }

  _buildParserContext(profile, draft = null) {
    return {
      bookmakerName: this.bookmakerName,
      bookmakerId: this.bookmakerId,
      accountId: this.accountId,
      runtimeMode: this.runtimeMode,
      profileId: profile.id,
      manualMatch: draft?.manualMatch || null,
      manualOutcome: draft?.manualOutcome || null,
      activationCode: draft?.activationCode || null
    };
  }

  async _sendSourceChatMessage(draftOrContext, text, options = {}) {
    if (this.quiet || !this.botClient?.sendMessage) {
      return null;
    }

    const session = draftOrContext.session || draftOrContext;
    const profile = draftOrContext.profile || null;

    // FAIL-CLOSED: Block writes to sourceReadOnly source targets
    if (profile?.sourceReadOnly) {
      const isSource = this.chatProfileManager?.isSourceTarget(profile, session.chatId, session.topicId);
      if (isSource) {
        this.logger.error(`🚫 BLOCKED source write to read-only chat=${session.chatId} topic=${session.topicId} profile=${profile.id}`);
        // Reroute to feedback chat — pass provenance context so operator
        // can correlate the rerouted notice with the originating signal.
        return this._sendToFeedbackChat(profile, text, {
          ...options,
          sourceChatId: session.chatId,
          sourceMessageId: options.replyToMessageId || null,
          draftId: draftOrContext?.id || null
        });
      }
    }

    const payload = {
      parse_mode: null,
      reply_markup: options.replyMarkup,
      reply_to_message_id: options.replyToMessageId,
      message_thread_id: session.topicId || undefined,
      allow_sending_without_reply: true
    };

    try {
      return await this.botClient.sendMessage(session.chatId, text, payload);
    } catch (error) {
      this.logger.log(`⚠️ Failed to send source-chat Telegram message: ${error.message}`);
      return null;
    }
  }

  async _sendToFeedbackChat(profile, text, options = {}) {
    if (!this.botClient?.sendMessage || !profile?.feedbackChatIds?.length) {
      return null;
    }

    // Forward feedback-chat thread (forum topic) id from the profile config or
    // the caller's options. Without this, messages land in the chat's General
    // topic instead of the operator's cluster topic.
    const feedbackTopicId = options.feedbackTopicId
      ?? profile.feedbackTopicId
      ?? profile.feedbackChatTopicId
      ?? null;

    // Strip cross-chat reply id: the source-chat message_id is invalid in the
    // destination feedback chat. Build a one-line provenance header instead so
    // the operator can still see which source message / signal triggered the
    // notice. Replies that target a message already in the feedback chat
    // (options.feedbackReplyToMessageId) are forwarded as-is.
    const sourceChatId = options.sourceChatId ?? null;
    const sourceMessageId = options.sourceMessageId ?? null;
    const draftId = options.draftId ?? null;
    const provenanceParts = [];
    if (draftId) provenanceParts.push(`Signal ${draftId}`);
    if (sourceChatId || sourceMessageId) {
      const inner = [];
      if (sourceChatId) inner.push(`chat=${sourceChatId}`);
      if (sourceMessageId) inner.push(`msg=${sourceMessageId}`);
      provenanceParts.push(`(${inner.join(' ')})`);
    }
    const finalText = provenanceParts.length > 0
      ? `${provenanceParts.join(' ')}\n${text}`
      : text;

    const payload = {
      parse_mode: options.parse_mode || null,
      reply_markup: options.replyMarkup || undefined,
      reply_to_message_id: options.feedbackReplyToMessageId || undefined,
      message_thread_id: feedbackTopicId || undefined,
      allow_sending_without_reply: true
    };

    // F2: iterate every configured feedback chat (operators may configure a
    // primary group + DM backup). Returns an array of { chatId, result } for
    // every successful send so callers can index callbacks/STOP routes per
    // chat. The `firstSuccess` shortcut is preserved on the array via a
    // `.firstResult` property to keep legacy single-message_id callers
    // working without breaking the multi-chat indexing.
    let firstResult = null;
    const successes = [];
    for (const rawChatId of profile.feedbackChatIds) {
      if (rawChatId === null || rawChatId === undefined || rawChatId === '') continue;
      try {
        const result = await this.botClient.sendMessage(rawChatId, finalText, payload);
        if (result) {
          successes.push({ chatId: rawChatId, topicId: feedbackTopicId || null, result });
          if (firstResult === null) firstResult = result;
        }
      } catch (error) {
        this.logger.log(`⚠️ Failed to send feedback-chat Telegram message to ${rawChatId}: ${error.message}`);
      }
    }
    if (firstResult) {
      // Attach multi-chat fanout so callers (clarification/reject indexer,
      // markup clearer) can iterate per-chat message_ids.
      try {
        Object.defineProperty(firstResult, '__feedbackFanout', {
          value: successes,
          enumerable: false,
          configurable: true
        });
      } catch (_err) {
        // best effort; objects from telegram lib should accept defineProperty
      }
    }
    return firstResult;
  }

  async _notifySessionError(draft, error) {
    if (!this.notifier || this.quiet) {
      return;
    }

    const message = [
      '🔴 TG СИГНАЛ ОШИБКА ОБРАБОТКИ',
      `Профиль: ${draft.profile.id}`,
      `Причина: ${error.message}`,
      `Signal: ${draft.id}`
    ].join('\n');

    try {
      await this.notifier.sendToAll(message, {
        bookmaker: this.bookmakerName,
        chatIds: draft.profile.feedbackChatIds,
        originChatId: draft.session.chatId,
        sourceReadOnly: !!draft.profile?.sourceReadOnly,
        parse_mode: null
      });
    } catch (notifyError) {
      this.logger.log(`⚠️ Failed to send ingress error notification: ${notifyError.message}`);
    }
  }

  _archiveDraft(draft, reason) {
    if (!draft || !this.activeDrafts.has(draft.id)) {
      return;
    }

    // F3: clear any pending post-code follow-up timer keyed by this draft so
    // archived drafts do not leak Node timers (and pinned closures over the
    // draft + _consumedSnapshot) until natural timeout expiry.
    const pendingTimer = this._postCodeTimers.get(draft.id);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this._postCodeTimers.delete(draft.id);
    }

    for (const messageId of draft.indexedMessageIds || []) {
      this.messageDraftIndex.delete(String(messageId));
    }
    for (const messageId of draft.indexedClarificationMessageIds || []) {
      this.clarificationDraftIndex.delete(String(messageId));
    }
    // Clean up dedupe entries owned by this draft on failure/rejection reasons.
    // F4 (review_8): for `enqueue_rejected`, defer to the rejection branch — it
    // sets `_preserveDedupeOnArchive=true` only when an existing task is still
    // in flight (the entry is the very protection against duplicate fires).
    const DEDUPE_KEEP_REASONS = new Set(['queued', 'executing', 'completed']);
    const preserveByFlag = reason === 'enqueue_rejected' && draft._preserveDedupeOnArchive === true;
    for (const childSignalId of draft.childSignals?.keys?.() || []) {
      this.childSignalParents.delete(childSignalId);
      if (!DEDUPE_KEEP_REASONS.has(reason) && !preserveByFlag) {
        this._removeDedupeEntriesForDraft(childSignalId);
      }
    }
    if (!DEDUPE_KEEP_REASONS.has(reason) && !preserveByFlag) {
      this._removeDedupeEntriesForDraft(draft.id);
    }

    // Restore consumed pre-activation messages on failure so the signal remains
    // activatable by a later code reply (source chats are read-only — the buffer
    // is the only copy of the original signal).
    const NO_RESTORE_REASONS = new Set([
      'queued',
      'executing',
      'completed',
      'dedupe_final',
      'stopped_before_queue',
      'cancelled',
      'design_stop',
      'business_stop',
      'match_ambiguous',
      'match_not_found',
      'outcome_ambiguous',
      'rejected_low_confidence',
      'rejected_vision_error',
      'rejected_catalog_error'
    ]);
    if (!NO_RESTORE_REASONS.has(reason) && draft._consumedSnapshot?.length && draft._bufferKey) {
      this._restoreConsumedMessages(draft._bufferKey, draft._consumedSnapshot);
      this.logger?.log(`♻️ Restored ${draft._consumedSnapshot.length} consumed message(s) to buffer after activation failure (reason=${reason})`);
    }

    this.activeDrafts.delete(draft.id);
    this._pushRecentSignal({
      processedAt: Date.now(),
      sessionId: draft.id,
      profileId: draft.profile.id,
      chatId: draft.session.chatId,
      messageIds: draft.session.toLLMPayload().messageIds,
      queueDecision: reason,
      accepted: draft.taskState === 'queued' || reason === 'business_stop' || reason === 'design_stop',
      taskId: draft.taskId || null
    });
  }

  _pushRecentSignal(entry) {
    this.recentSignals.unshift(entry);
    if (this.recentSignals.length > this.recentSignalsLimit) {
      this.recentSignals.length = this.recentSignalsLimit;
    }
  }

  _loadState() {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
      this.offset = Number.isFinite(data.offset) ? data.offset : 0;
    } catch (error) {
      this.logger.log(`⚠️ Failed to load Telegram ingress state: ${error.message}`);
    }
  }

  _saveState() {
    if (!this.stateFilePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      // F5: atomic write via tmp + rename so a SIGTERM mid-write cannot leave a
      // truncated state file (which would either silently lose offset or fail
      // to parse on next start).
      const tmpPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ offset: this.offset }, null, 2));
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (error) {
      this.logger.log(`⚠️ Failed to save Telegram ingress state: ${error.message}`);
    }
  }

  // === Pre-activation buffer helpers ===

  _buildPreActivationBufferKey(chatId, topicId, profileId) {
    return `${String(chatId)}|${String(topicId || '')}|${profileId}`;
  }

  _findAwaitingFollowupDraft(chatId, topicId, profileId, authorId, replyToMessageId, senderChatId = null) {
    const candidates = [];
    for (const draft of this.activeDrafts.values()) {
      if (draft.stage === 'awaiting_followup' &&
          String(draft.session.chatId) === String(chatId) &&
          String(draft.session.topicId || '') === String(topicId || '') &&
          draft.profile.id === profileId &&
          String(draft.authorId ?? '') === String(authorId ?? '') &&
          (authorId != null || (senderChatId != null && String(draft.senderChatId || '') === String(senderChatId)))) {
        candidates.push(draft);
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.session.lastUpdatedAt - left.session.lastUpdatedAt);

    // Prefer explicit reply linkage: if the follow-up message replies to a
    // message that belongs to a specific draft, return that draft regardless
    // of ordering.  This prevents a later draft's follow-up from being
    // attached to an earlier one simply because it was found first.
    if (replyToMessageId != null) {
      for (const draft of candidates) {
        const key = this._buildMessageIndexKey(chatId, topicId, replyToMessageId);
        if (key && draft.indexedMessageIds.has(key)) {
          return draft;
        }
      }
    }

    // Fallback: first match (preserves existing behavior for messages
    // without reply linkage), after newest-first sort above.
    return candidates[0];
  }

  _shouldAppendPostCodeContinuation(draft, message) {
    if (!draft || !message) return false;
    if (draft.stage !== 'awaiting_followup') return false;
    if (message.replyToMessageId != null && this._replyTargetsKnownSignalContext(draft, message)) return false;
    if (String(draft.session.chatId) !== String(message.chatId)) return false;
    if (String(draft.session.topicId || '') !== String(message.topicId || '')) return false;
    if (String(draft.authorId ?? '') !== String(message.authorId ?? '')) return false;
    if (message.authorId == null && String(draft.senderChatId || '') !== String(message.metadata?.senderChatId || '')) return false;

    const messageTs = Number(message.timestamp || Date.now());
    const lastTs = Number(draft.session.lastUpdatedAt || draft.activationTimestamp || draft.createdAt || messageTs);
    const windowMs = Number.isFinite(Number(draft._postCodeWindowMs)) && Number(draft._postCodeWindowMs) > 0
      ? Number(draft._postCodeWindowMs)
      : POST_CODE_FOLLOWUP_WINDOW_MS_DEFAULT;
    const maxGapMs = Math.min(Math.max(windowMs, 1000), SIGNAL_BURST_MAX_GAP_MS);
    if (Math.abs(messageTs - lastTs) > maxGapMs) return false;

    const text = String(message.text || message.caption || '').trim();
    if (!text) return false;
    return !this._looksLikeStandaloneSignalText(text);
  }

  _replyTargetsKnownSignalContext(draft, message) {
    if (!draft || !message || message.replyToMessageId == null) return false;

    const replyKey = this._buildMessageIndexKey(message.chatId, message.topicId, message.replyToMessageId);
    const claimedDraftId = replyKey ? this.messageDraftIndex.get(replyKey) : null;
    if (claimedDraftId) {
      return true;
    }

    const buffer = draft._bufferKey ? this.preActivationBuffers.get(draft._bufferKey) : null;
    if (buffer?.messages?.some((entry) => String(entry.messageId) === String(message.replyToMessageId))) {
      return true;
    }

    // Telegram forum relays may set reply_to_message_id to the topic/root
    // anchor for every source message. If that id is not known to any active
    // draft or pending signal buffer, treat it like "no reply" and let the
    // strict same-chat/topic/author/time/text gates decide.
    return false;
  }

  _looksLikeStandaloneSignalText(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return false;
    const hasTeamSeparator = /\bvs\b| v | - |:|—|–/.test(normalized);
    const hasOutcome = /\b(п1|п2|w1|w2|win\s*1|win\s*2|over|under|тотал|т[бм]|tb|tm|фора|handicap|draw|ничья|x)\b|[+-]\d+(?:[.,]\d+)?/.test(normalized);
    return hasTeamSeparator && (hasOutcome || normalized.length >= 18);
  }

  _reschedulePostCodeProcessing(draft) {
    if (!draft || draft.stage !== 'awaiting_followup') return;
    const delayMs = Number.isFinite(Number(draft._postCodeWindowMs)) && Number(draft._postCodeWindowMs) > 0
      ? Number(draft._postCodeWindowMs)
      : POST_CODE_FOLLOWUP_WINDOW_MS_DEFAULT;
    const existingTimer = this._postCodeTimers.get(draft.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this._postCodeTimers.delete(draft.id);
    }
    const draftRef = draft;
    const timerId = setTimeout(async () => {
      try {
        this._postCodeTimers.delete(draftRef.id);
        if (this.activeDrafts.has(draftRef.id) && draftRef.stage === 'awaiting_followup') {
          this._mergeSafePendingCandidates(draftRef);
          draftRef.stage = 'draft';
          await this._processDraftWithDedupe(draftRef, draftRef.profile);
        }
      } catch (error) {
        this.lastError = error.message;
        this.logger.error(`Telegram ingress post-code timer error: ${error.message}`);
      }
    }, delayMs);
    this._postCodeTimers.set(draft.id, timerId);
  }

  _mergeSafePendingCandidates(draft) {
    const candidates = draft.pendingFollowupCandidates || [];
    draft.pendingFollowupCandidates = [];
    for (const candidate of candidates) {
      // Reply-linked candidates may be independent second signals — never
      // auto-merge them into the first draft.  They stay in the pre-activation
      // buffer and can activate independently when their own code reply arrives.
      if (candidate.replyToMessageId && draft.indexedMessageIds.has(
        this._buildMessageIndexKey(draft.session.chatId, draft.session.topicId, candidate.replyToMessageId)
      )) {
        this.logger?.log(`🛡️ Reply-linked pending candidate msgId=${candidate.messageId} NOT merged into draft ${draft.id} (may be independent signal)`);
        continue;
      }
      const key = this._buildMessageIndexKey(draft.session.chatId, draft.session.topicId, candidate.messageId);
      const claimedByDraftId = key ? this.messageDraftIndex.get(key) : null;
      if (claimedByDraftId && claimedByDraftId !== draft.id) {
        this.logger?.log(`🚫 Pending candidate msgId=${candidate.messageId} claimed by draft ${claimedByDraftId}, not merging into ${draft.id}`);
        continue;
      }
      this._appendMessageToDraft(draft, candidate);
      this.logger?.log(`✅ Merged safe pending candidate msgId=${candidate.messageId} into draft ${draft.id}`);
    }
  }

  _restoreConsumedMessages(bufferKey, snapshot) {
    if (!bufferKey || !snapshot?.length) return;
    if (!this.preActivationBuffers.has(bufferKey)) {
      this.preActivationBuffers.set(bufferKey, { messages: [], createdAt: Date.now() });
    }
    const buffer = this.preActivationBuffers.get(bufferKey);
    const existingIds = new Set(buffer.messages.map((m) => m.messageId));
    for (const msg of snapshot) {
      if (!existingIds.has(msg.messageId)) {
        buffer.messages.push(msg);
        existingIds.add(msg.messageId);
      }
    }
    // Re-sort by timestamp for consistent ordering
    buffer.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  _partitionSignalGroup(windowMessages, replyTarget) {
    const sorted = [...windowMessages].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const anchorIndex = sorted.findIndex((m) => m.messageId === replyTarget.messageId);
    if (anchorIndex === -1) return [replyTarget];

    const anchorAuthorKey = this._messageAuthorKey(replyTarget);
    const backward = [];

    // Backward walk: recover earlier messages from the same partner-burst.
    //
    // 15 s gap is sized to real Supernova-style text-only bursts where the
    // partner manually types one short message at a time:
    //   "DA Sportivo 2 Mayo"   (team name)
    //   ↓ ~5-10 s typing pause
    //   "Over5.5"              (outcome)
    //   ↓ ~3-5 s
    //   "Football"
    //   ↓ ~3-5 s
    //   "Paraguay"
    //   ↓ ...
    //   id-bot reply with activation code → reply_to=Over5.5
    //
    // The earlier 3 s threshold lost the team-name message in such bursts,
    // leaving the parser without home/away → Vision could not identify the
    // match → signal rejected with confidence<0.5. Logged on 2026-05-31:
    // msg=19185 ("DA Sportivo 2 Mayo") at 19:53:40 vs anchor msg=19186
    // ("Over5.5") at 19:53:48 — 8 s gap dropped under the old 3 s ceiling.
    //
    // 15 s is a balance: catches normal-speed manual partner typing while
    // still excluding obviously separate signals (≥30 s pause between
    // distinct bets is the realistic baseline).
    const BACKWARD_BURST_MAX_GAP_MS = 15000;
    for (let i = anchorIndex - 1; i >= 0; i--) {
      if (!anchorAuthorKey || this._messageAuthorKey(sorted[i]) !== anchorAuthorKey) break;
      const nextInChain = backward.length > 0 ? backward[backward.length - 1] : sorted[anchorIndex];
      const gap = Math.abs((nextInChain.timestamp || 0) - (sorted[i].timestamp || 0));
      if (gap > BACKWARD_BURST_MAX_GAP_MS) break;
      backward.push(sorted[i]);
    }
    backward.reverse();

    const group = [...backward, sorted[anchorIndex]];

    // Forward walk: tighter gap (5 s) — once the activation code arrives, any
    // subsequent same-author message that's >5 s later is more likely a
    // brand-new signal than a continuation of the previous burst.
    const FORWARD_CONTINUATION_MAX_GAP_MS = 5000;
    for (let i = anchorIndex + 1; i < sorted.length; i++) {
      if (!anchorAuthorKey || this._messageAuthorKey(sorted[i]) !== anchorAuthorKey) break;
      const gap = Math.abs((sorted[i].timestamp || 0) - (sorted[i - 1].timestamp || 0));
      if (gap > FORWARD_CONTINUATION_MAX_GAP_MS) break;
      group.push(sorted[i]);
    }

    return group;
  }

  _messageAuthorKey(message = {}) {
    if (message.authorId !== null && message.authorId !== undefined && message.authorId !== '') {
      return `user:${String(message.authorId)}`;
    }
    const senderChatId = message.senderChatId ?? message.metadata?.senderChatId ?? null;
    if (senderChatId !== null && senderChatId !== undefined && senderChatId !== '') {
      return `sender_chat:${String(senderChatId)}`;
    }
    return null;
  }

  _purgeExpiredPreActivationBuffers() {
    const now = Date.now();
    // F6: use the cached max preSignalWindowMs across profiles (×2 safety
    // margin) instead of the global default, so profiles with larger
    // activation windows do not lose pre-activation messages prematurely.
    const maxAge = (this._maxPreSignalWindowMs || PRE_SIGNAL_WINDOW_MS_DEFAULT) * 2;
    for (const [key, buffer] of this.preActivationBuffers.entries()) {
      // Purge individual expired messages first
      buffer.messages = buffer.messages.filter((m) =>
        (now - (m.timestamp || buffer.createdAt)) < maxAge
      );
      if (buffer.messages.length === 0) {
        this.preActivationBuffers.delete(key);
        continue;
      }
      // Expire buffer based on newest retained message, not buffer creation time
      const newestMessageTs = Math.max(...buffer.messages.map((m) => m.timestamp || 0), buffer.createdAt);
      if (now - newestMessageTs > maxAge) {
        this.preActivationBuffers.delete(key);
      }
    }
  }

  // === Dedupe registry helpers ===

  _registerDedupeEntry(entry) {
    if (!entry.fingerprint) return;
    // Also index by code
    this.dedupeRegistry.set(entry.fingerprint, entry);
  }

  _findDedupeEntryByFingerprint(fingerprint) {
    return fingerprint ? this.dedupeRegistry.get(fingerprint) || null : null;
  }

  _removeDedupeEntriesForDraft(draftId) {
    if (!draftId) return;
    for (const [key, entry] of this.dedupeRegistry.entries()) {
      if (entry.draftId === draftId) {
        this.dedupeRegistry.delete(key);
      }
    }
  }

  _attachCodeAliasToDraftEntries(draftId, code) {
    if (!draftId || !code) return;
    for (const entry of this.dedupeRegistry.values()) {
      if (entry.draftId === draftId && entry.primaryCode !== code) {
        entry.codeAliases = entry.codeAliases || [];
        if (!entry.codeAliases.includes(code)) {
          entry.codeAliases.push(code);
        }
      }
    }
  }

  _updateDedupeStatusForDraft(draftId, status, taskId) {
    if (!draftId) return;
    for (const entry of this.dedupeRegistry.values()) {
      if (entry.draftId === draftId) {
        entry.status = status;
        if (taskId) entry.taskId = taskId;
        entry.lastSeenAt = Date.now();
      }
    }
  }

  _findDedupeEntryByCode(code, clusterId) {
    if (!code) return null;
    for (const entry of this.dedupeRegistry.values()) {
      if (clusterId && entry.clusterId !== clusterId) continue;
      if (entry.primaryCode === code) return entry;
      if (entry.codeAliases?.includes(code)) return entry;
    }
    return null;
  }

  _purgeExpiredDedupeEntries() {
    const now = Date.now();
    for (const [key, entry] of this.dedupeRegistry.entries()) {
      if (now - (entry.lastSeenAt || entry.firstSeenAt) > DEDUPE_ENTRY_TTL_MS) {
        this.dedupeRegistry.delete(key);
      }
    }
  }

  _buildProvisionalFingerprint(draft, clusterId) {
    const textContext = draft.session.getTextContext().trim();
    const hasImages = draft.session.getImages().length > 0;
    if (!textContext && !hasImages) return null;

    // Provisional: cluster + normalized text snippet + image presence
    const normalizedText = textContext.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-zа-яё0-9\s.><=+-]/gi, '')
      .slice(0, 200);

    return `prov:${clusterId}:${hasImages ? 'img' : 'txt'}:${normalizedText}`;
  }

  _buildFinalFingerprint(parsed, clusterId, profileId = null) {
    if (!parsed || parsed.state !== 'ready') return null;
    if (!parsed.home && !parsed.bookmakerMatchId) return null;

    // F3 (review_8): when a profile has no explicit clusterId, fall back to
    // its own profile id so two non-cluster profiles (e.g. `default` + `vip`)
    // do not collide in the same dedupe namespace. Legacy entries persisted
    // when this fell back to the literal "default" remain compatible because
    // the only profile in production at that time was `default`, which still
    // resolves to the `default` namespace under the new logic.
    const namespace = clusterId || profileId || 'default';

    // F2 (review_11): include matchDate bucket so two same-team fixtures on
    // different dates are not dedupe-collapsed when bookmakerMatchId is null.
    // F1 (review_12): guard against unparseable matchDate (e.g. "tomorrow")
    // to avoid RangeError: Invalid time value from toISOString().
    let dateBucket = '';
    if (parsed.matchDate) {
      const ms = Date.parse(parsed.matchDate);
      dateBucket = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
    }

    const parts = [
      namespace,
      parsed.mode || 'live',
      parsed.sport || 'unknown',
      parsed.bookmakerMatchId || `${(parsed.home || '').toLowerCase()}_${(parsed.away || '').toLowerCase()}`,
      (parsed.normalizedOutcome || '').toLowerCase(),
      parsed.normalizedIntent?.family || '',
      String(parsed.normalizedIntent?.line ?? ''),
      String(parsed.betNum ?? ''),
      dateBucket
    ];

    return `final:${parts.join(':')}`;
  }

  _resolveSourceTargetLabel(profile, chatId, topicId) {
    if (!profile?.sourceTargets) return null;
    const target = profile.sourceTargets.find((t) =>
      String(t.chatId) === String(chatId) &&
      (t.topicId === null || t.topicId === undefined || String(t.topicId) === String(topicId || ''))
    );
    return target?.label || null;
  }

  // === Dedupe persistence ===

  _loadDedupeRegistry() {
    if (!this.dedupeFilePath || !fs.existsSync(this.dedupeFilePath)) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.dedupeFilePath, 'utf8'));
      const NON_TERMINAL_DEDUPE_STATUSES = new Set(['processing', 'ready']);
      // F7: drop accepted/completed entries whose taskId is no longer present
      // in the active tasks file. Without this guard, a legitimate re-issued
      // signal posted after a runner restart can be silently suppressed by a
      // stale dedupe entry pointing at a task that no longer exists.
      let activeTaskIds = null;
      try {
        if (this.tasksFilePath && fs.existsSync(this.tasksFilePath)) {
          const raw = JSON.parse(fs.readFileSync(this.tasksFilePath, 'utf8'));
          const collected = new Set();
          const pushTask = (t) => { if (t?.id) collected.add(String(t.id)); };
          if (Array.isArray(raw?.tasks)) raw.tasks.forEach(pushTask);
          if (Array.isArray(raw?.queue)) raw.queue.forEach(pushTask);
          if (raw?.currentTasks && typeof raw.currentTasks === 'object') {
            for (const t of Object.values(raw.currentTasks)) pushTask(t);
          }
          if (Array.isArray(raw?.history)) raw.history.forEach(pushTask);
          activeTaskIds = collected;
        }
      } catch (e) {
        this.logger?.log?.(`⚠️ Failed to load tasks file for dedupe pruning: ${e.message}`);
      }

      const now = Date.now();
      const restoredTtl = this.restoredDedupeTtlMs;
      if (Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          if (!entry.fingerprint) continue;
          if (NON_TERMINAL_DEDUPE_STATUSES.has(entry.status)) {
            this.logger?.log?.(`🧹 Discarding non-terminal dedupe entry on load: fp=${entry.fingerprint} status=${entry.status}`);
            continue;
          }

          // F7: drop accepted entries whose taskId is no longer active.
          if (entry.status === 'accepted' && activeTaskIds && entry.taskId
              && !activeTaskIds.has(String(entry.taskId))) {
            this.logger?.log?.(`🧹 Discarding orphan accepted dedupe entry on load: fp=${entry.fingerprint} taskId=${entry.taskId}`);
            continue;
          }

          // F7: apply a shorter TTL to non-failed restored entries so a
          // restart doesn't suppress legitimate re-issued signals for the
          // full 1h window.
          if (entry.status !== 'failed' && restoredTtl > 0) {
            const lastSeen = entry.lastSeenAt || entry.firstSeenAt || 0;
            if (lastSeen && (now - lastSeen) > restoredTtl) {
              this.logger?.log?.(`🧹 Discarding restored dedupe entry beyond restoredDedupeTtlMs: fp=${entry.fingerprint} status=${entry.status} ageMs=${now - lastSeen}`);
              continue;
            }
            // Mark restored so future code can shorten subsequent checks if
            // needed, but keep the original lastSeenAt for accurate aging.
            entry._restoredFromDisk = true;
          }

          this.dedupeRegistry.set(entry.fingerprint, entry);
        }
      }
    } catch (error) {
      this.logger.log(`⚠️ Failed to load dedupe registry: ${error.message}`);
    }
  }

  _saveDedupeRegistry() {
    if (!this.dedupeFilePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.dedupeFilePath), { recursive: true });
      const entries = Array.from(this.dedupeRegistry.values());
      // F5: atomic write via tmp + rename so a SIGTERM mid-write cannot
      // truncate the dedupe registry (a torn file is silently treated as
      // empty by _loadDedupeRegistry, allowing previously-deduped signals
      // to fire again after an abrupt restart).
      const tmpPath = `${this.dedupeFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ entries }, null, 2));
      fs.renameSync(tmpPath, this.dedupeFilePath);
    } catch (error) {
      this.logger.log(`⚠️ Failed to save dedupe registry: ${error.message}`);
    }
  }

  /**
   * Persist a JSON envelope of the activation event for offline replay.
   * Best-effort: any IO error is swallowed (counter is bumped) and never
   * affects activation logic. Storing the envelope is the only way to
   * reconstruct an edge-case Supernova/Vova bundle for parser regression
   * testing once the upstream chat has rotated past the message.
   */
  async _dumpActivationEnvelope(message, profile, identitySource) {
    if (!this.envelopeDumpDir) return;
    try {
      fs.mkdirSync(this.envelopeDumpDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeProfile = String(profile?.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${ts}_${safeProfile}_${message.chatId || 'chat'}_${message.messageId || 'msg'}.json`;
      const target = path.join(this.envelopeDumpDir, fileName);
      const envelope = {
        ts: Date.now(),
        profileId: profile?.id || null,
        clusterId: profile?.clusterId || null,
        identitySource,
        message
      };
      fs.writeFileSync(target, JSON.stringify(envelope, null, 2));
      if (this.metrics) this.metrics.envelope_dumps_written += 1;
    } catch (error) {
      if (this.metrics) this.metrics.envelope_dumps_failed += 1;
      this.logger?.log?.(`⚠️ Failed to dump activation envelope: ${error.message}`);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { TelegramPollingIngress };
