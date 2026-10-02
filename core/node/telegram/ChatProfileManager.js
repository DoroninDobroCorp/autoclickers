const { normalizeIdentifier } = require('../tasks/task-source.js');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  if (!isPlainObject(extra)) {
    return output;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      output[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      output[key] = deepMerge(isPlainObject(output[key]) ? output[key] : {}, value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function buildSourceTargetKey(chatId, topicId) {
  return `${String(chatId)}:${topicId !== null && topicId !== undefined ? String(topicId) : '*'}`;
}

function matchesSourceTargetTopic(targetTopicId, incomingTopicId) {
  if (targetTopicId === null || targetTopicId === undefined) {
    return true;
  }

  if (String(targetTopicId) === String(incomingTopicId || '')) {
    return true;
  }

  // Telegram forum General topic is commonly configured as topic 1, but some
  // incoming updates omit message_thread_id for that same thread.
  return String(targetTopicId) === '1' && (incomingTopicId === null || incomingTopicId === undefined || incomingTopicId === '');
}

function uniqueChatIds(chatIds = []) {
  const seen = new Set();
  const result = [];

  for (const chatId of chatIds) {
    if (chatId === null || chatId === undefined || chatId === '') continue;
    const normalized = String(chatId);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeTelegramUserId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value).trim();
}

function normalizeTelegramUsername(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return String(value)
    .trim()
    .replace(/^@+/, '')
    .toLowerCase() || null;
}

function normalizeSenderContext(source = {}) {
  if (!source || typeof source !== 'object') {
    return {
      userId: normalizeTelegramUserId(source),
      username: null
    };
  }

  return {
    userId: normalizeTelegramUserId(
      source.userId ??
      source.senderUserId ??
      source.senderId ??
      source.authorId ??
      source.from?.id ??
      source.user_id
    ),
    username: normalizeTelegramUsername(
      source.username ??
      source.senderUsername ??
      source.authorUsername ??
      source.from?.username
    )
  };
}

function normalizeAllowedSenders(entries = []) {
  const seenEntries = new Set();
  const userIds = new Set();
  const usernames = new Set();
  const normalizedEntries = [];

  const pushEntry = (entry) => {
    const normalizedUserId = normalizeTelegramUserId(entry.userId);
    const normalizedUsernames = Array.from(new Set(
      (entry.usernames || [])
        .map((username) => normalizeTelegramUsername(username))
        .filter(Boolean)
    ));

    if (!normalizedUserId && normalizedUsernames.length === 0) {
      return;
    }

    const key = `${normalizedUserId || 'none'}|${normalizedUsernames.join(',')}`;
    if (seenEntries.has(key)) {
      return;
    }
    seenEntries.add(key);

    if (normalizedUserId) {
      userIds.add(normalizedUserId);
    }
    for (const username of normalizedUsernames) {
      usernames.add(username);
    }

    normalizedEntries.push({
      userId: normalizedUserId,
      usernames: normalizedUsernames
    });
  };

  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (entry === null || entry === undefined || entry === '') {
      continue;
    }

    if (typeof entry === 'number') {
      pushEntry({ userId: entry, usernames: [] });
      continue;
    }

    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      if (/^-?\d+$/.test(trimmed)) {
        pushEntry({ userId: trimmed, usernames: [] });
      } else {
        pushEntry({ userId: null, usernames: [trimmed] });
      }
      continue;
    }

    if (!isPlainObject(entry)) {
      continue;
    }

    const usernamesList = [];
    const aliasFields = [
      entry.username,
      ...(Array.isArray(entry.usernames) ? entry.usernames : []),
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ...(Array.isArray(entry.usernameAliases) ? entry.usernameAliases : [])
    ];

    for (const username of aliasFields) {
      if (username !== null && username !== undefined && username !== '') {
        usernamesList.push(username);
      }
    }

    pushEntry({
      userId: entry.userId ?? entry.user_id ?? entry.id ?? entry.telegramUserId ?? null,
      usernames: usernamesList
    });
  }

  return {
    entries: normalizedEntries,
    userIds,
    usernames
  };
}

class ChatProfileManager {
  constructor(config = {}) {
    const telegram = config.telegram || config;
    this.enabled = telegram.enabled !== false;
    this.defaults = telegram.defaults || {};
    this.logger = config.logger || telegram.logger || null;
    this.profiles = new Map();
    this._sourceTargetIndex = new Map();

    const profiles = {
      ...(telegram.profiles || {}),
      ...(telegram.directions || {})
    };

    for (const [profileId, profileConfig] of Object.entries(profiles)) {
      const id = normalizeIdentifier(profileId);
      this.profiles.set(id, profileConfig || {});
      this._indexSourceTargets(id, profileConfig || {});
    }
  }

  _indexSourceTargets(profileId, profileConfig) {
    const targets = profileConfig.sourceTargets || [];
    for (const target of targets) {
      if (!target || target.chatId === undefined || target.chatId === null) continue;
      const key = buildSourceTargetKey(target.chatId, target.topicId);
      if (!this._sourceTargetIndex.has(key)) {
        this._sourceTargetIndex.set(key, []);
      }
      this._sourceTargetIndex.get(key).push({ profileId, target });
    }
  }

  hasProfile(profileId) {
    return this.profiles.has(normalizeIdentifier(profileId));
  }

  hasDirection(profileId) {
    return this.hasProfile(profileId);
  }

  getProfile(profileId) {
    const id = normalizeIdentifier(profileId);
    if (!id || !this.profiles.has(id)) {
      return null;
    }

    const rawProfile = this.profiles.get(id);
    const profile = deepMerge(this.defaults, rawProfile);
    const allowlist = normalizeAllowedSenders(
      profile.allowedSenders ||
      profile.senders ||
      profile.allowedAuthors ||
      profile.authors ||
      []
    );

    profile.id = id;
    profile.enabled = profile.enabled !== false;
    const explicitFeedbackChatIds = Array.isArray(rawProfile?.feedbackChatIds) && rawProfile.feedbackChatIds.length > 0;
    const explicitSourceChatIds = Array.isArray(rawProfile?.sourceChatIds) && rawProfile.sourceChatIds.length > 0;
    const explicitSourceTargets = Array.isArray(rawProfile?.sourceTargets) && rawProfile.sourceTargets.length > 0;
    const explicitSourceReadOnly = typeof rawProfile?.sourceReadOnly === 'boolean';
    profile.sourceChatIds = uniqueChatIds(profile.sourceChatIds || profile.chatIds || []);
    profile.chatIds = uniqueChatIds(profile.chatIds || profile.sourceChatIds || []);
    profile.feedbackChatIds = uniqueChatIds(profile.feedbackChatIds || profile.chatIds || []);
    profile.allowedSenders = allowlist.entries;
    profile.allowedSenderUserIds = Array.from(allowlist.userIds);
    profile.allowedSenderUsernames = Array.from(allowlist.usernames);
    profile.hasSenderAllowlist = allowlist.userIds.size > 0 || allowlist.usernames.size > 0;
    profile.senderAllowlist = allowlist;

    // Source targets (topic-aware)
    profile.sourceTargets = Array.isArray(profile.sourceTargets) ? profile.sourceTargets : [];
    profile.clusterId = profile.clusterId || null;
    profile.sourceReadOnly = profile.sourceReadOnly === true;
    profile.activation = profile.activation || null;
    profile.parserHints = profile.parserHints || null;

    // Build sourceChatIds from sourceTargets if not explicitly set
    if (profile.sourceTargets.length > 0 && profile.sourceChatIds.length === 0) {
      profile.sourceChatIds = uniqueChatIds(
        profile.sourceTargets.map((t) => t.chatId)
      );
      profile.chatIds = uniqueChatIds([...profile.chatIds, ...profile.sourceChatIds]);
    }

    // F5 fail-closed safety: when feedbackChatIds was NOT explicitly provided
    // but the profile explicitly declares source chats (sourceChatIds or
    // sourceTargets), either:
    //   (a) the legacy normalization above silently copied source -> feedback
    //       (mirror) — making the operator's read-only chat the bot's
    //       outbound chat. This is a foot-gun.
    //   (b) feedbackChatIds ended up empty (sourceTargets-only config).
    // In both cases, when sourceReadOnly was not explicitly declared, we
    // auto-set sourceReadOnly=true and clear feedbackChatIds so the layered
    // fail-closed guards do NOT leak writes back into the source chat.
    // We only do this when source-ness was explicit (not derived from a
    // legacy `chatIds`-only config which historically meant "operate in
    // these chats" and is allowed to mirror).
    const explicitSource = explicitSourceChatIds || explicitSourceTargets;
    if (!explicitFeedbackChatIds && explicitSource && !explicitSourceReadOnly && profile.sourceChatIds.length > 0) {
      const looksLikeSourceMirror = profile.feedbackChatIds.length > 0
        && profile.feedbackChatIds.length === profile.sourceChatIds.length
        && profile.feedbackChatIds.every((id) => profile.sourceChatIds.includes(id));
      const feedbackEmpty = profile.feedbackChatIds.length === 0;
      if (looksLikeSourceMirror || feedbackEmpty) {
        try {
          (this.logger?.warn || this.logger?.log)?.call(
            this.logger,
            `⚠️ [ChatProfileManager] profile=${id} fail-closed auto-protect: sourceChatIds set without explicit feedbackChatIds → sourceReadOnly=true, feedbackChatIds=[]`
          );
        } catch (e) { /* logger optional */ }
        profile.sourceReadOnly = true;
        profile.feedbackChatIds = [];
      }
    }

    return profile;
  }

  getDirection(profileId) {
    return this.getProfile(profileId);
  }

  getEnabledProfiles(filters = {}) {
    const profiles = [];
    for (const profileId of this.profiles.keys()) {
      const profile = this.getProfile(profileId);
      if (!profile?.enabled) continue;
      if (!this._matchesFilters(profile, filters)) continue;
      profiles.push(profile);
    }
    return profiles;
  }

  getEnabledProfilesForChat(chatId, filters = {}) {
    const normalizedChatId = chatId === null || chatId === undefined || chatId === ''
      ? null
      : String(chatId);

    if (!normalizedChatId) {
      return [];
    }

    const topicId = filters.topicId !== undefined ? filters.topicId : null;

    return this.getEnabledProfiles(filters).filter((profile) => {
      // Topic-aware sourceTargets match
      if (profile.sourceTargets && profile.sourceTargets.length > 0) {
        const matched = profile.sourceTargets.some((target) => {
          if (String(target.chatId) !== normalizedChatId) return false;
          // If target specifies topicId, incoming must match
          if (target.topicId !== null && target.topicId !== undefined) {
            return matchesSourceTargetTopic(target.topicId, topicId);
          }
          // Target with null topicId matches any topicId in that chat
          return true;
        });
        if (matched) {
          return this._matchesSender(profile, filters);
        }
        // sourceTargets exist but none matched — do NOT fall through to legacy
        return false;
      }

      // Legacy sourceChatIds match (no topic awareness)
      const sourceChatIds = uniqueChatIds(profile.sourceChatIds || profile.chatIds || []);
      if (!sourceChatIds.includes(normalizedChatId)) {
        return false;
      }

      return this._matchesSender(profile, filters);
    });
  }

  getEnabledProfilesByChatId(chatId, filters = {}) {
    const normalizedChatId = chatId === null || chatId === undefined || chatId === ''
      ? null
      : String(chatId);

    if (!normalizedChatId) {
      return [];
    }

    return this.getEnabledProfiles(filters).filter((profile) => {
      if (profile.sourceTargets && profile.sourceTargets.length > 0) {
        const matched = profile.sourceTargets.some((target) => String(target.chatId) === normalizedChatId);
        if (!matched) {
          return false;
        }
        return this._matchesSender(profile, filters);
      }

      const sourceChatIds = uniqueChatIds(profile.sourceChatIds || profile.chatIds || []);
      if (!sourceChatIds.includes(normalizedChatId)) {
        return false;
      }

      return this._matchesSender(profile, filters);
    });
  }

  resolveIngressProfile(chatIdOrContext, filters = {}) {
    const ingressContext = typeof chatIdOrContext === 'object' && chatIdOrContext !== null
      ? {
        ...filters,
        ...chatIdOrContext,
        chatId: chatIdOrContext.chatId ?? chatIdOrContext.id ?? null,
        topicId: chatIdOrContext.topicId ?? chatIdOrContext.threadId ?? filters.topicId ?? null
      }
      : {
        ...filters,
        chatId: chatIdOrContext,
        topicId: filters.topicId ?? null
      };

    const matches = this.getEnabledProfilesForChat(ingressContext.chatId, ingressContext)
      .sort((left, right) => {
        // Prefer sourceTargets with explicit topicId match over generic
        const leftHasTopicTarget = left.sourceTargets?.some((t) =>
          String(t.chatId) === String(ingressContext.chatId) && t.topicId !== null && t.topicId !== undefined
        ) ? 1 : 0;
        const rightHasTopicTarget = right.sourceTargets?.some((t) =>
          String(t.chatId) === String(ingressContext.chatId) && t.topicId !== null && t.topicId !== undefined
        ) ? 1 : 0;
        if (leftHasTopicTarget !== rightHasTopicTarget) {
          return rightHasTopicTarget - leftHasTopicTarget;
        }
        return Number(right.hasSenderAllowlist) - Number(left.hasSenderAllowlist);
      });
    return matches[0] || null;
  }

  resolveIngressDirection(chatIdOrContext, filters = {}) {
    return this.resolveIngressProfile(chatIdOrContext, filters);
  }

  isSenderAllowed(profileOrId, sender = {}) {
    const profile = typeof profileOrId === 'string'
      ? this.getProfile(profileOrId)
      : profileOrId;

    if (!profile) {
      return false;
    }

    // F4 (review_4): fail-closed default for sourceReadOnly cluster profiles
    // (vova_cluster, supernova_cluster, etc.). When ops have not enumerated
    // an explicit `allowedSenders` list, any non-author requester (e.g. an
    // arbitrary participant in the feedback chat -1003717712631) would
    // otherwise be implicitly authorized via `_matchesSender` returning true.
    // For STOP authorization the contract is "author OR explicit operator",
    // so an unset allowlist must NOT silently grant access.
    if (profile.sourceReadOnly === true && !profile.hasSenderAllowlist) {
      return false;
    }

    return this._matchesSender(profile, sender);
  }

  resolveExecutionPolicy(options = {}) {
    const {
      profileId,
      bookmakerId,
      accountId,
      mode = 'live',
      explicitMinOdds
    } = options;

    const profile = this.getProfile(profileId);
    if (!this.enabled || !profile?.enabled) {
      return { enabled: false, reason: 'telegram disabled', profileId: normalizeIdentifier(profileId) || null };
    }

    if (!this._matchesFilters(profile, { bookmakerId, accountId, mode })) {
      return { enabled: false, reason: 'profile filters rejected request', profileId: profile.id };
    }

    let merged = deepMerge({}, profile);
    const bookmakerOverride = merged.bookmakers?.[bookmakerId] || merged.bookmakerOverrides?.[bookmakerId];
    if (bookmakerOverride) {
      merged = deepMerge(merged, bookmakerOverride);
    }

    const accountOverride = bookmakerOverride?.accounts?.[accountId] ||
      bookmakerOverride?.accountOverrides?.[accountId] ||
      merged.accounts?.[accountId] ||
      merged.accountOverrides?.[accountId];

    if (accountOverride) {
      merged = deepMerge(merged, accountOverride);
    }

    const defaultMinOdds = merged.defaultMinOdds ?? merged.minOdds ?? 1.7;

    // For read-only source profiles, chatIds includes source ingress chats that
    // must never receive outbound feedback.  Only fall back to chatIds for
    // non-source-read-only profiles to preserve backward compatibility (e.g.
    // testbets_default where chatIds == feedbackChatIds by design).
    const sourceChatIdSet = merged.sourceReadOnly
      ? new Set((merged.sourceChatIds || []).map(String))
      : new Set();
    const baseFeedback = merged.feedbackChatIds || [];
    const extraFeedback = merged.sourceReadOnly
      ? (merged.chatIds || []).filter((id) => !sourceChatIdSet.has(String(id)))
      : (merged.chatIds || []);
    const feedbackChatIds = uniqueChatIds([...baseFeedback, ...extraFeedback]);

    return {
      enabled: true,
      profileId: merged.id || profile.id,
      clusterId: merged.clusterId || profile.clusterId || null,
      mode,
      bookmakerId: bookmakerId || null,
      accountId: accountId || null,
      minOdds: explicitMinOdds ?? defaultMinOdds,
      maxOdds: merged.maxOdds ?? null,
      brm: merged.brm || {},
      limits: merged.limits || {},
      preemption: merged.preemption || { allowReplaceUntil: 'submit_started' },
      expansion: merged.expansion || {},
      feedbackChatIds,
      chatIds: uniqueChatIds(merged.chatIds || []),
      sourceReadOnly: merged.sourceReadOnly === true,
      activation: merged.activation || null,
      sourceTargets: merged.sourceTargets || [],
      llmHints: merged.llmHints || {},
      parserHints: merged.parserHints || null,
      raw: merged
    };
  }

  isSourceTarget(profileOrId, chatId, topicId = null) {
    const profile = typeof profileOrId === 'string'
      ? this.getProfile(profileOrId)
      : profileOrId;
    if (!profile || !profile.sourceTargets || profile.sourceTargets.length === 0) {
      return false;
    }
    return profile.sourceTargets.some((t) =>
      String(t.chatId) === String(chatId) &&
      matchesSourceTargetTopic(t.topicId, topicId)
    );
  }

  resolveSourceTarget(profileOrId, chatId, topicId = null) {
    const profile = typeof profileOrId === 'string'
      ? this.getProfile(profileOrId)
      : profileOrId;
    if (!profile || !profile.sourceTargets || profile.sourceTargets.length === 0) {
      return null;
    }
    return profile.sourceTargets.find((t) =>
      String(t.chatId) === String(chatId) &&
      matchesSourceTargetTopic(t.topicId, topicId)
    ) || null;
  }

  getCanonicalSourceTopicId(profileOrId, chatId, topicId = null) {
    const target = this.resolveSourceTarget(profileOrId, chatId, topicId);
    if (target && target.topicId !== null && target.topicId !== undefined) {
      return target.topicId;
    }
    return topicId ?? null;
  }

  /**
   * F2 (review_9): aggregate every chat id that ANY enabled profile classifies
   * as a `sourceChatIds` / `sourceTargets` member. Consumed by
   * telegram-notifier.js as a chat-level "do-not-write-to" invariant — defense
   * in depth on top of the per-task `sourceReadOnly` flag, so that a future
   * config edit that flips `sourceReadOnly:false` (or omits it) cannot leak
   * lifecycle messages back into the upstream signal channel.
   *
   * Returns a Set<string> of normalized chat ids.
   *
   * F1 (review_10): only collect from profiles where sourceReadOnly === true.
   * Legacy bidirectional profiles (chatIds-only, no explicit sourceReadOnly)
   * derive sourceChatIds from chatIds — including those here would silently
   * block notifications for the very same chat the profile uses for feedback.
   */
  getKnownSourceChatIds(filters = {}) {
    const result = new Set();
    const profiles = this.getEnabledProfiles(filters);
    for (const profile of profiles) {
      if (!profile.sourceReadOnly) continue;
      for (const id of (profile.sourceChatIds || [])) {
        if (id === null || id === undefined || id === '') continue;
        result.add(String(id));
      }
      for (const target of (profile.sourceTargets || [])) {
        if (!target || target.chatId === null || target.chatId === undefined || target.chatId === '') continue;
        result.add(String(target.chatId));
      }
    }
    return result;
  }

  _matchesFilters(profile, filters = {}) {
    const bookmakerId = normalizeIdentifier(filters.bookmakerId);
    const accountId = normalizeIdentifier(filters.accountId);
    const mode = normalizeIdentifier(filters.mode);

    if (mode === 'live' && profile.liveEnabled === false) return false;
    if (mode === 'prematch' && profile.prematchEnabled === false) return false;

    if (bookmakerId) {
      const allowedBookmakers = (profile.allowedBookmakers || []).map(normalizeIdentifier);
      if (allowedBookmakers.length > 0 && !allowedBookmakers.includes(bookmakerId)) {
        return false;
      }
    }

    if (accountId) {
      const allowedAccounts = (profile.allowedAccounts || []).map(normalizeIdentifier);
      if (allowedAccounts.length > 0 && !allowedAccounts.includes(accountId)) {
        return false;
      }
    }

    return true;
  }

  _matchesSender(profile, sender = {}) {
    if (!profile?.hasSenderAllowlist) {
      return true;
    }

    const normalizedSender = normalizeSenderContext(sender);
    if (!normalizedSender.userId && !normalizedSender.username) {
      return false;
    }

    if (normalizedSender.userId && profile.senderAllowlist.userIds.has(normalizedSender.userId)) {
      return true;
    }

    if (normalizedSender.username && profile.senderAllowlist.usernames.has(normalizedSender.username)) {
      return true;
    }

    return false;
  }
}

module.exports = {
  ChatProfileManager,
  buildSourceTargetKey,
  deepMerge,
  matchesSourceTargetTopic,
  uniqueChatIds,
  normalizeTelegramUserId,
  normalizeTelegramUsername,
  normalizeAllowedSenders,
  normalizeSenderContext
};
