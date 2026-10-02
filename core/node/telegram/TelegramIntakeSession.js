class TelegramIntakeSession {
  constructor(seed = {}, options = {}) {
    this.id = seed.sessionId || seed.id || null;
    this.chatId = seed.chatId || null;
    this.topicId = seed.topicId || seed.threadId || null;
    this.mediaGroupId = seed.mediaGroupId || null;
    this.windowMs = options.windowMs || seed.windowMs || 45000;
    this.messages = [];
    this.createdAt = seed.createdAt || Date.now();
    this.lastUpdatedAt = this.createdAt;

    if (seed.message) {
      this.addMessage(seed.message);
    }
    if (Array.isArray(seed.messages)) {
      for (const message of seed.messages) {
        this.addMessage(message);
      }
    }
  }

  canAccept(message = {}) {
    if (!message.chatId || String(message.chatId) !== String(this.chatId)) {
      return false;
    }

    const incomingTopicId = message.topicId || message.threadId || null;
    if (String(incomingTopicId || '') !== String(this.topicId || '')) {
      return false;
    }

    const incomingMediaGroupId = message.mediaGroupId || null;
    if (this.mediaGroupId && incomingMediaGroupId && String(this.mediaGroupId) !== String(incomingMediaGroupId)) {
      return false;
    }

    const messageTs = message.timestamp || message.date || Date.now();
    return Math.abs(messageTs - this.lastUpdatedAt) <= this.windowMs;
  }

  addMessage(message = {}) {
    const normalized = {
      messageId: message.messageId ?? message.id ?? null,
      chatId: message.chatId ?? this.chatId ?? null,
      topicId: message.topicId ?? message.threadId ?? this.topicId ?? null,
      mediaGroupId: message.mediaGroupId ?? this.mediaGroupId ?? null,
      timestamp: message.timestamp ?? message.date ?? Date.now(),
      text: message.text || '',
      caption: message.caption || '',
      images: Array.isArray(message.images)
        ? [...message.images]
        : (message.image ? [message.image] : []),
      isEdit: Boolean(message.isEdit),
      authorId: message.authorId ?? message.userId ?? null,
      authorUsername: message.authorUsername || message.username || null,
      replyToMessageId: message.replyToMessageId ?? null,
      metadata: message.metadata || {}
    };

    if (!this.chatId) this.chatId = normalized.chatId;
    if (!this.topicId) this.topicId = normalized.topicId;
    if (!this.mediaGroupId) this.mediaGroupId = normalized.mediaGroupId;

    if (this.messages.length === 0) {
      this.createdAt = normalized.timestamp;
      this.lastUpdatedAt = normalized.timestamp;
    }

    const existingIndex = normalized.messageId === null
      ? -1
      : this.messages.findIndex((entry) => String(entry.messageId) === String(normalized.messageId));

    if (existingIndex >= 0) {
      const existing = this.messages[existingIndex];
      this.messages[existingIndex] = {
        ...existing,
        ...normalized,
        images: normalized.images.length > 0 ? normalized.images : existing.images,
        metadata: {
          ...(existing.metadata || {}),
          ...(normalized.metadata || {})
        }
      };
    } else {
      this.messages.push(normalized);
    }

    this.messages.sort((a, b) => a.timestamp - b.timestamp);
    this.lastUpdatedAt = Math.max(
      this.createdAt,
      ...this.messages.map((entry) => entry.timestamp || this.createdAt)
    );
    return this.getMessageById(normalized.messageId) || normalized;
  }

  hasMessageId(messageId) {
    return this.getMessageById(messageId) !== null;
  }

  getMessageById(messageId) {
    if (messageId === null || messageId === undefined) {
      return null;
    }

    return this.messages.find((entry) => String(entry.messageId) === String(messageId)) || null;
  }

  getLatestMessage() {
    return this.messages[this.messages.length - 1] || null;
  }

  getTextContext() {
    return this.messages
      .map((message) => {
        const chunks = [];
        if (message.caption) chunks.push(message.caption.trim());
        if (message.text) chunks.push(message.text.trim());
        return chunks.filter(Boolean).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
  }

  getImages() {
    return this.messages.flatMap((message) => message.images || []);
  }

  getPrimaryImage() {
    return this.getImages()[0] || null;
  }

  toLLMPayload() {
    return {
      sessionId: this.id,
      chatId: this.chatId,
      topicId: this.topicId,
      mediaGroupId: this.mediaGroupId,
      createdAt: this.createdAt,
      lastUpdatedAt: this.lastUpdatedAt,
      textContext: this.getTextContext(),
      primaryImage: this.getPrimaryImage(),
      images: this.getImages(),
      messageIds: this.messages.map((message) => message.messageId).filter((value) => value !== null),
      messages: this.messages.map((message) => ({
        messageId: message.messageId,
        timestamp: message.timestamp,
        text: message.text,
        caption: message.caption,
        authorId: message.authorId,
        authorUsername: message.authorUsername,
        replyToMessageId: message.replyToMessageId,
        isEdit: message.isEdit
      }))
    };
  }
}

module.exports = { TelegramIntakeSession };
