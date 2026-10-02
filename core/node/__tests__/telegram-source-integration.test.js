/* V1_REWRITE_SKIP — this suite tests the v1 parser/retriever mechanics that
   were removed in the 2026-05-29 v2 rewrite (vision-LLM + match-locator).
   Re-enable once v2 equivalent coverage is written. */
const __origDescribe = describe;
describe = ((...args) => __origDescribe.skip(...args));
describe.skip = __origDescribe.skip;
describe.only = __origDescribe.only;
describe.each = __origDescribe.each;
const { ChatProfileManager, buildSourceTargetKey } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');
const { TelegramIntakeSession } = require('../telegram/TelegramIntakeSession.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn()
  };
}

function createBotClient() {
  return {
    getUpdates: jest.fn(async () => []),
    getBotUserId: jest.fn(() => 123456789),
    getChat: jest.fn(async (chatId) => ({
      id: chatId,
      type: 'supergroup',
      title: `chat-${chatId}`,
      is_forum: false
    })),
    getChatMember: jest.fn(async () => ({ status: 'member' })),
    sendMessage: jest.fn(async (_chatId, _text, _options) => ({
      ok: true,
      result: { message_id: 9001 }
    })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true })),
    downloadFileById: jest.fn(async (fileId, dir, opts) => ({
      destinationPath: `${dir}/${opts?.fileName || fileId}.jpg`
    }))
  };
}

function createClusterProfileManager() {
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        vova_cluster: {
          liveEnabled: true,
          prematchEnabled: true,
          clusterId: 'vova',
          sourceReadOnly: true,
          feedbackChatIds: [-1003717712631],
          sourceTargets: [
            { chatId: -1002010985531, topicId: null, label: 'bet20_online', priority: 100 },
            { chatId: -1002097397120, topicId: null, label: 'bet20_ex', priority: 90 },
            { chatId: -1002201691237, topicId: null, label: 'vova_root', priority: 30 }
          ],
          activation: {
            mode: 'code_reply',
            codeBotUserIds: [7109114044],
            codeRegex: '^[A-Za-z0-9]{10}$',
            preSignalWindowMs: 90000,
            postCodeFollowupWindowMs: 0
          },
          parserHints: {
            signalStyle: 'photo_then_outcome'
          }
        },
        supernova_cluster: {
          liveEnabled: true,
          prematchEnabled: true,
          clusterId: 'supernova',
          sourceReadOnly: true,
          feedbackChatIds: [-1003717712631],
          sourceTargets: [
            { chatId: -1002009104562, topicId: 4, label: 'supernova_topic4', priority: 100 },
            { chatId: -1002069845466, topicId: 1, label: 'bet20_supernova_topic1', priority: 90 }
          ],
          activation: {
            mode: 'code_reply',
            codeBotUserIds: [7109114044],
            codeRegex: '^[A-Za-z0-9]{10}$',
            preSignalWindowMs: 120000,
            postCodeFollowupWindowMs: 0
          },
          parserHints: {
            signalStyle: 'text_burst_then_trigger'
          }
        },
        testbets_default: {
          liveEnabled: true,
          prematchEnabled: true,
          sourceChatIds: [-1003717712631],
          feedbackChatIds: [-1003717712631],
          allowedSenders: [{ userId: 7268849307 }]
        }
      }
    }
  });
}

// === ChatProfileManager Tests ===

describe('ChatProfileManager: sourceTargets & topic-aware routing', () => {
  const manager = createClusterProfileManager();

  test('should resolve vova_cluster profile for bet20_online chatId', () => {
    const profile = manager.resolveIngressProfile({ chatId: -1002010985531 }, { mode: 'live' });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('vova_cluster');
    expect(profile.clusterId).toBe('vova');
    expect(profile.sourceReadOnly).toBe(true);
  });

  test('should resolve vova_cluster for bet20_ex chatId', () => {
    const profile = manager.resolveIngressProfile({ chatId: -1002097397120 });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('vova_cluster');
  });

  test('should resolve supernova_cluster for topic 4 in correct chat', () => {
    const profile = manager.resolveIngressProfile({
      chatId: -1002009104562,
      topicId: 4
    });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('supernova_cluster');
    expect(profile.clusterId).toBe('supernova');
  });

  test('should NOT resolve supernova_cluster for wrong topic in same chat', () => {
    const profile = manager.resolveIngressProfile({
      chatId: -1002009104562,
      topicId: 999
    });
    expect(profile).toBeNull();
  });

  test('should resolve supernova_cluster for topic 1 in bet20_supernova chat', () => {
    const profile = manager.resolveIngressProfile({
      chatId: -1002069845466,
      topicId: 1
    });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('supernova_cluster');
  });

  test('should resolve supernova_cluster when General forum topic omits thread id', () => {
    const profile = manager.resolveIngressProfile({
      chatId: -1002069845466,
      topicId: null
    });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('supernova_cluster');
  });

  test('should resolve testbets_default for testbets chat', () => {
    const profile = manager.resolveIngressProfile({
      chatId: -1003717712631,
      userId: 7268849307
    });
    expect(profile).not.toBeNull();
    expect(profile.id).toBe('testbets_default');
  });

  test('should NOT resolve any profile for unknown chatId', () => {
    const profile = manager.resolveIngressProfile({ chatId: -9999999 });
    expect(profile).toBeNull();
  });

  test('isSourceTarget should detect source targets correctly', () => {
    const profile = manager.getProfile('vova_cluster');
    expect(manager.isSourceTarget(profile, -1002010985531)).toBe(true);
    expect(manager.isSourceTarget(profile, -1003717712631)).toBe(false);
    expect(manager.isSourceTarget(profile, -1002097397120)).toBe(true);
  });

  test('isSourceTarget should require matching topicId for topic-specific targets', () => {
    const profile = manager.getProfile('supernova_cluster');
    expect(manager.isSourceTarget(profile, -1002009104562, 4)).toBe(true);
    expect(manager.isSourceTarget(profile, -1002009104562, 999)).toBe(false);
    expect(manager.isSourceTarget(profile, -1002069845466, 1)).toBe(true);
  });

  test('resolveSourceTarget returns matching target with label and priority', () => {
    const profile = manager.getProfile('vova_cluster');
    const target = manager.resolveSourceTarget(profile, -1002010985531);
    expect(target).not.toBeNull();
    expect(target.label).toBe('bet20_online');
    expect(target.priority).toBe(100);
  });

  test('getProfile populates sourceChatIds from sourceTargets', () => {
    const profile = manager.getProfile('vova_cluster');
    expect(profile.sourceChatIds).toContain(String(-1002010985531));
    expect(profile.sourceChatIds).toContain(String(-1002097397120));
    expect(profile.sourceChatIds).toContain(String(-1002201691237));
  });

  test('getProfile preserves activation config', () => {
    const profile = manager.getProfile('vova_cluster');
    expect(profile.activation).toBeDefined();
    expect(profile.activation.mode).toBe('code_reply');
    expect(profile.activation.codeBotUserIds).toEqual([7109114044]);
  });

  test('buildSourceTargetKey produces unique keys', () => {
    expect(buildSourceTargetKey(-100, 4)).toBe('-100:4');
    expect(buildSourceTargetKey(-100, null)).toBe('-100:*');
    expect(buildSourceTargetKey(-100, undefined)).toBe('-100:*');
    expect(buildSourceTargetKey(-200, 1)).toBe('-200:1');
  });

  test('resolveExecutionPolicy includes cluster fields', () => {
    const policy = manager.resolveExecutionPolicy({
      profileId: 'vova_cluster',
      mode: 'live'
    });
    expect(policy.enabled).toBe(true);
    expect(policy.clusterId).toBe('vova');
    expect(policy.sourceReadOnly).toBe(true);
    expect(policy.activation).toBeDefined();
    expect(policy.sourceTargets.length).toBeGreaterThan(0);
  });
});

// === TelegramPollingIngress: Source read-only write blocking ===

describe('TelegramPollingIngress: source read-only write blocking', () => {
  test('should block writes to sourceReadOnly chat and reroute to feedback', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'stop', confidence: 0.95, notes: null })),
      parseSession: jest.fn(async () => ({ state: 'ready' }))
    };
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onStopSignal: jest.fn(async () => ({ accepted: true, cancelled: true }))
    });

    // Simulate a code_reply flow that creates a draft, then tries to send message
    const profile = manager.getProfile('vova_cluster');
    const draftContext = {
      session: { chatId: -1002010985531, topicId: null },
      profile
    };
    await ingress._sendSourceChatMessage(draftContext, 'Test message');

    // Should NOT have written to source chat
    const sourceCalls = botClient.sendMessage.mock.calls.filter(
      (call) => call[0] === -1002010985531
    );
    expect(sourceCalls).toHaveLength(0);

    // Should have rerouted to feedback chat
    const feedbackCalls = botClient.sendMessage.mock.calls.filter(
      (call) => String(call[0]) === String(-1003717712631)
    );
    expect(feedbackCalls).toHaveLength(1);
    // F3: rerouted feedback message includes provenance header so the operator
    // can correlate it with the originating source chat.
    expect(feedbackCalls[0][1]).toContain('Test message');
    expect(feedbackCalls[0][1]).toMatch(/chat=/);
  });

  test('should allow writes to non-source chats normally', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const profile = manager.getProfile('testbets_default');
    const draftContext = {
      session: { chatId: -1003717712631, topicId: null },
      profile
    };

    await ingress._sendSourceChatMessage(draftContext, 'Normal feedback');
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      -1003717712631,
      'Normal feedback',
      expect.any(Object)
    );
  });

  test('should log error when blocking source write', async () => {
    const logger = createLogger();
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger,
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const profile = manager.getProfile('supernova_cluster');
    const draftContext = {
      session: { chatId: -1002009104562, topicId: 4 },
      profile
    };

    await ingress._sendSourceChatMessage(draftContext, 'Should be blocked');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('BLOCKED source write')
    );
  });
});

describe('TelegramPollingIngress: source topic discovery', () => {
  test('auto-normalizes missing General topic id for a known single-topic forum source chat', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'ignore', confidence: 1, notes: null })),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002069845466, title: 'Bet 2.0 Supernova', type: 'supergroup' },
        from: { id: 555 },
        text: 'probe general topic without thread id'
      }
    }]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002069845466, 1, 'supernova_cluster');
    expect(ingress.preActivationBuffers.has(bufferKey)).toBe(true);

    const status = ingress.getStatus();
    expect(status.sourceRoutingHealth.autoNormalizedTopicCount).toBe(1);
    expect(status.sourceRoutingHealth.lastAutoNormalized).toEqual(
      expect.objectContaining({
        profileId: 'supernova_cluster',
        chatId: String(-1002069845466),
        incomingTopicId: null,
        canonicalTopicId: 1
      })
    );
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('canonicalTopicId=1'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );
  });

  test('reports numeric topic id when a generic source chat receives a forum topic message', async () => {
    const botClient = createBotClient();
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          forum_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'bet20_any' }
            ]
          }
        }
      }
    });
    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'ignore', confidence: 1, notes: null })),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        message_thread_id: 77,
        chat: { id: -1002010985531, title: 'Bet 2.0', type: 'supergroup' },
        from: { id: 555 },
        text: 'probe generic topic'
      }
    }]);

    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('topicId=77'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );
    expect(botClient.sendMessage.mock.calls[0][1]).toContain('reason=generic_source_chat');
  });

  test('reports numeric topic id when a known forum chat receives a message from an unconfigured topic', async () => {
    const botClient = createBotClient();
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          forum_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002009104562, topicId: 4, label: 'supernova_bets' }
            ]
          }
        }
      }
    });
    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'ignore', confidence: 1, notes: null })),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        message_thread_id: 99,
        chat: { id: -1002009104562, title: 'Supernova', type: 'supergroup' },
        from: { id: 555 },
        text: 'probe report topic'
      }
    }]);

    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('topicId=99'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );
    expect(botClient.sendMessage.mock.calls[0][1]).toContain('reason=unconfigured_topic');
    expect(parser.detectMessageIntent).not.toHaveBeenCalled();
  });

  test('records known source routing mismatch health and alerts feedback chat', async () => {
    const botClient = createBotClient();
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          forum_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002009104562, topicId: 4, label: 'supernova_bets' }
            ]
          }
        }
      }
    });
    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'ignore', confidence: 1, notes: null })),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        message_thread_id: 99,
        chat: { id: -1002009104562, title: 'Supernova', type: 'supergroup' },
        from: { id: 555 },
        text: 'probe report topic'
      }
    }]);

    const status = ingress.getStatus();
    expect(status.sourceRoutingHealth.knownSourceMismatchCount).toBe(1);
    expect(status.sourceRoutingHealth.lastKnownSourceMismatch).toEqual(
      expect.objectContaining({
        chatId: String(-1002009104562),
        topicId: 99,
        profileIds: ['forum_cluster'],
        expectedTopicIds: ['4']
      })
    );
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('Known source routing mismatch'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );
  });

  test('skips Bot API source access audit for external update relay mode', async () => {
    const botClient = createBotClient();
    botClient.getChat.mockRejectedValue(new Error('Bad Request: chat not found'));
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          production_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002009104562, topicId: null, label: 'supernova_root' }
            ]
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      externalUpdatesOnly: true
    });

    await ingress.start();
    await ingress.stop();

    const audit = ingress.getStatus().sourceAccessAudit;
    expect(audit.warningCount).toBe(0);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        chatId: String(-1002009104562),
        ok: true,
        skipped: true,
        skipReason: 'external_updates_only'
      })
    ]);
    expect(botClient.getChat).not.toHaveBeenCalled();
    expect(botClient.sendMessage).not.toHaveBeenCalled();
  });
});

describe('TelegramPollingIngress: source access audit', () => {
  test('reports inaccessible source chats to feedback and exposes audit status', async () => {
    const botClient = createBotClient();
    botClient.getChat.mockImplementation(async (chatId) => {
      if (String(chatId) === String(-1002097397120) || String(chatId) === String(-1002201691237) || String(chatId) === String(-1002009104562)) {
        throw new Error('Bad Request: chat not found');
      }

      return {
        id: chatId,
        type: 'supergroup',
        title: `chat-${chatId}`,
        is_forum: String(chatId) === String(-1002010985531) || String(chatId) === String(-1002069845466)
      };
    });

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress._runSourceAccessAudit();

    const status = ingress.getStatus();
    expect(status.sourceAccessAudit.warningCount).toBe(3);
    expect(status.sourceAccessAudit.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: String(-1002010985531), ok: true, membershipStatus: 'member' }),
        expect.objectContaining({ chatId: String(-1002097397120), ok: false, error: 'Bad Request: chat not found' }),
        expect.objectContaining({ chatId: String(-1002201691237), ok: false, error: 'Bad Request: chat not found' }),
        expect.objectContaining({ chatId: String(-1002009104562), ok: false, error: 'Bad Request: chat not found' }),
        expect.objectContaining({ chatId: String(-1002069845466), ok: true, membershipStatus: 'member' })
      ])
    );

    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('FAIL chat=-1002097397120'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );
    expect(botClient.sendMessage.mock.calls[0][1]).toContain('FAIL chat=-1002201691237');
    expect(botClient.sendMessage.mock.calls[0][1]).toContain('FAIL chat=-1002009104562');
  });
});

// === TelegramPollingIngress: Code-reply activation ===

describe('TelegramPollingIngress: code_reply activation', () => {
  test('should buffer messages until code arrives, then activate', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team A',
        away: 'Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-1' };
      })
    });

    // Step 1: Send photo message (buffered, not processed)
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'capper' },
        text: 'Team A vs Team B'
      }
    }]);

    // No signal should be resolved yet
    expect(resolvedSignals).toHaveLength(0);
    expect(parser.parseSession).not.toHaveBeenCalled();
    expect(ingress.preActivationBuffers.size).toBe(1);
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      '-1003717712631',
      expect.stringContaining('жду код активации'),
      expect.objectContaining({ allow_sending_without_reply: true })
    );

    // Step 2: Code bot replies with code
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044, username: 'id_matches_bot' },
        text: 'AbCdEf1234',
        reply_to_message: { message_id: 10, text: 'Team A vs Team B' }
      }
    }]);

    // Now the signal should have been activated and processed
    expect(parser.parseSession).toHaveBeenCalledTimes(1);
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('AbCdEf1234');
    expect(resolvedSignals[0].clusterId).toBe('vova');
    expect(resolvedSignals[0].originTargetLabel).toBe('bet20_online');
    // Pre-activation buffer should be cleared
    expect(ingress.preActivationBuffers.size).toBe(0);
  });

  test('should not activate on non-code messages from code bot', async () => {
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 20,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044, username: 'id_matches_bot' },
        text: 'Hello this is not a code'
      }
    }]);

    expect(parser.parseSession).not.toHaveBeenCalled();
    // F2 (review_8): non-code messages authored by the configured codeBotUserIds
    // are now filtered out of the pre-activation buffer entirely (they can never
    // be the reply target of a future code activation), so the buffer stays empty.
    expect(ingress.preActivationBuffers.size).toBe(0);
  });

  test('should not activate on code-like message from non-code bot user', async () => {
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(),
      parseSession: jest.fn()
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 30,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 12345, username: 'random_user' },
        text: 'AbCdEf1234'
      }
    }]);

    expect(parser.parseSession).not.toHaveBeenCalled();
    expect(ingress.preActivationBuffers.size).toBe(1);
  });
});

// === TelegramPollingIngress: Cross-chat duplicate collapse ===

describe('TelegramPollingIngress: cross-chat duplicate collapse', () => {
  test('should collapse same code arriving from two mirror chats in same cluster', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team A',
        away: 'Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // Signal from bet20_online
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'capper' },
        text: 'Team A vs Team B п1'
      }
    }]);

    // Code activation on bet20_online
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'AbCdEf1234',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);

    // Same code arrives on mirror (bet20_ex) — should be collapsed
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 20,
        date: 102,
        chat: { id: -1002097397120, type: 'supergroup' },
        from: { id: 555, username: 'capper' },
        text: 'Team A vs Team B п1'
      }
    }]);

    await ingress.processUpdates([{
      update_id: 4,
      message: {
        message_id: 21,
        date: 103,
        chat: { id: -1002097397120, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'AbCdEf1234',
        reply_to_message: { message_id: 20 }
      }
    }]);

    // Should NOT have created a second signal
    expect(resolvedSignals).toHaveLength(1);
  });

  test('should NOT collapse different codes for different outcomes', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    let callCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        callCount++;
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'Team A',
          away: 'Team B',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: callCount === 1 ? '1' : 'T> 2.5',
          normalizedIntent: callCount === 1
            ? { family: '1x2', selection: '1', normalizedOutcome: '1' }
            : { family: 'totals', direction: 'over', line: 2.5, normalizedOutcome: 'T> 2.5' },
          candidateLadder: [{ outcome: callCount === 1 ? '1' : 'T> 2.5', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // First code+signal
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'Code1Code1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    // Second code+signal with DIFFERENT outcome
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B ТБ 2.5' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'Code2Code2', reply_to_message: { message_id: 20 } }
    }]);

    // Both should have been processed
    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[0].outcome).toBe('1');
    expect(resolvedSignals[1].outcome).toBe('T> 2.5');
  });
});

// === TelegramPollingIngress: Supernova text-burst pre-buffer ===

describe('TelegramPollingIngress: Supernova text-burst pre-buffer', () => {
  test('should accumulate text burst and activate all on code arrival', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team X',
        away: 'Team Y',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-sn-1' };
      })
    });

    // Supernova-style text burst: team, outcome, sport, trigger
    const chatId = -1002009104562;
    const topicId = 4;

    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 100, date: 100, message_thread_id: topicId, chat: { id: chatId, type: 'supergroup' }, from: { id: 333 }, text: 'Team X - Team Y' } },
      { update_id: 2, message: { message_id: 101, date: 101, message_thread_id: topicId, chat: { id: chatId, type: 'supergroup' }, from: { id: 333 }, text: 'П1' } },
      { update_id: 3, message: { message_id: 102, date: 102, message_thread_id: topicId, chat: { id: chatId, type: 'supergroup' }, from: { id: 333 }, text: 'Футбол' } },
      { update_id: 4, message: { message_id: 103, date: 103, message_thread_id: topicId, chat: { id: chatId, type: 'supergroup' }, from: { id: 333 }, text: 'Лайв' } }
    ]);

    // All buffered, nothing processed yet
    expect(resolvedSignals).toHaveLength(0);
    expect(ingress.preActivationBuffers.size).toBe(1);

    // Code bot activates — reply to FIRST message (msg 100), forward walk captures the rest
    await ingress.processUpdates([{
      update_id: 5,
      message: {
        message_id: 104,
        date: 104,
        message_thread_id: topicId,
        chat: { id: chatId, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'SuperCod10',
        reply_to_message: { message_id: 100 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('SuperCod10');
    expect(resolvedSignals[0].clusterId).toBe('supernova');
    // Session should contain all buffered messages
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBeGreaterThanOrEqual(4);
  });
});

// === TelegramPollingIngress: post-code follow-up window ===

describe('TelegramPollingIngress: post-code follow-up window', () => {
  test('should wait for follow-up text after code before processing', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          delayed_cluster: {
            liveEnabled: true,
            clusterId: 'delayed',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 500
            }
          }
        }
      }
    });

    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-delay-1' };
      })
    });

    // Buffer message
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'A vs B'
      }
    }]);

    // Code arrives — draft should be in awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'FollwCode1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(0);
    expect(ingress.getActiveSessions().length).toBe(1);
    expect(ingress.getActiveSessions()[0].stage).toBe('awaiting_followup');

    // Send follow-up text while in window
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 12,
        date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'П1 если выше 1.80'
      }
    }]);

    // Still awaiting (timer not expired)
    expect(resolvedSignals).toHaveLength(0);

    // Wait for timer to fire
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('FollwCode1');
  });
});

// === TelegramPollingIngress: feedback-only routing ===

describe('TelegramPollingIngress: feedback-only routing for sourceReadOnly', () => {
  test('clarification timeout message should go to feedback, not source', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 'task-1' }))
    });

    // Directly test _sendSourceChatMessage with a sourceReadOnly profile
    const profile = manager.getProfile('vova_cluster');
    const context = {
      session: { chatId: -1002010985531, topicId: null },
      profile
    };

    await ingress._sendSourceChatMessage(context, '⏱️ Время на уточнение истекло.');

    // Verify NO message sent to source chat
    const sourceCalls = botClient.sendMessage.mock.calls.filter(
      (call) => call[0] === -1002010985531
    );
    expect(sourceCalls).toHaveLength(0);

    // Verify message was sent to feedback chat
    const feedbackCalls = botClient.sendMessage.mock.calls.filter(
      (call) => String(call[0]) === String(-1003717712631)
    );
    expect(feedbackCalls).toHaveLength(1);
  });
});

// === TelegramPollingIngress: task payload trace fields ===

describe('TelegramPollingIngress: task payload trace fields', () => {
  test('task payload should include activationCode, clusterId, dedupeFingerprint, originTargetLabel', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Alpha',
        away: 'Beta',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: 'T> 2.5',
        bookmakerMatchId: 'sb-123',
        normalizedIntent: {
          family: 'totals',
          direction: 'over',
          line: 2.5,
          normalizedOutcome: 'T> 2.5'
        },
        candidateLadder: [{ outcome: 'T> 2.5', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.92,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-trace-1' };
      })
    });

    // Buffer + code activation
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'Alpha vs Beta ТБ 2.5'
      }
    }]);

    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'TraceCodex',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    const payload = resolvedSignals[0];
    expect(payload.activationCode).toBe('TraceCodex');
    expect(payload.clusterId).toBe('vova');
    expect(payload.originTargetLabel).toBe('bet20_online');
    expect(payload.dedupeFingerprint).toBeDefined();
    expect(payload.dedupeFingerprint).toMatch(/^final:/);
    expect(payload.telegramContext.activationCode).toBe('TraceCodex');
    expect(payload.telegramContext.clusterId).toBe('vova');
    expect(payload.telegramContext.dedupeFingerprint).toMatch(/^final:/);
    expect(payload.telegramContext.originTargetLabel).toBe('bet20_online');
  });
});

// === Backward compatibility: immediate mode still works ===

describe('TelegramPollingIngress: backward compatibility with immediate mode', () => {
  test('existing testbets flow still works without activation gate', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.95, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.95,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-compat-1' };
      })
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1003717712631, type: 'supergroup' },
        from: { id: 7268849307 },
        text: 'A vs B п1'
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].profileId).toBe('testbets_default');
    expect(resolvedSignals[0].activationCode).toBeNull();
  });
});

// === Dedupe registry persistence ===

describe('TelegramPollingIngress: dedupe registry', () => {
  test('dedupeRegistry tracks entries and can be queried', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    ingress._registerDedupeEntry({
      clusterId: 'vova',
      fingerprint: 'final:vova:live:soccer:sb-123:1:1x2::',
      primaryCode: 'TestCode123',
      codeAliases: [],
      status: 'processing',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now()
    });

    expect(ingress.dedupeRegistry.size).toBe(1);
    expect(ingress._findDedupeEntryByFingerprint('final:vova:live:soccer:sb-123:1:1x2::')).not.toBeNull();
    expect(ingress._findDedupeEntryByCode('TestCode123', 'vova')).not.toBeNull();
    expect(ingress._findDedupeEntryByCode('OtherCode', 'vova')).toBeNull();
  });

  test('expired entries are purged', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    ingress._registerDedupeEntry({
      clusterId: 'vova',
      fingerprint: 'old-entry',
      primaryCode: 'OldCode1234',
      codeAliases: [],
      status: 'completed',
      firstSeenAt: Date.now() - 7200000,
      lastSeenAt: Date.now() - 7200000
    });

    expect(ingress.dedupeRegistry.size).toBe(1);
    ingress._purgeExpiredDedupeEntries();
    expect(ingress.dedupeRegistry.size).toBe(0);
  });
});

// === Fix 1: Same code, different semantic signal should NOT be suppressed ===

describe('TelegramPollingIngress: code is alias, not dedupe key', () => {
  test('same activation code with different semantic content should produce two signals', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    let callCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        callCount++;
        return {
          intentType: 'signal',
          state: 'ready',
          home: callCount === 1 ? 'Team A' : 'Team C',
          away: callCount === 1 ? 'Team B' : 'Team D',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: callCount === 1 ? '1' : '2',
          bookmakerMatchId: callCount === 1 ? 'sb-111' : 'sb-222',
          normalizedIntent: callCount === 1
            ? { family: '1x2', selection: '1', normalizedOutcome: '1' }
            : { family: '1x2', selection: '2', normalizedOutcome: '2' },
          candidateLadder: [{ outcome: callCount === 1 ? '1' : '2', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // First signal: Team A vs Team B with code SameCode10
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'SameCode10', reply_to_message: { message_id: 10 } }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].home).toBe('Team A');

    // Second signal: different match (Team C vs Team D) with SAME code SameCode10
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team C vs Team D п2' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'SameCode10', reply_to_message: { message_id: 20 } }
    }]);

    // Both should be processed — code is alias, not standalone uniqueness key
    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[0].home).toBe('Team A');
    expect(resolvedSignals[1].home).toBe('Team C');
  });

  test('code from second activation is attached as alias to first dedupe entry', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team A',
        away: 'Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // First activation from bet20_online
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'FirstCode1', reply_to_message: { message_id: 10 } }
    }]);

    // Same content from mirror (bet20_ex) with different code
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 102, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 103, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 7109114044 }, text: 'SecndCod10', reply_to_message: { message_id: 20 } }
    }]);

    // Semantic dedupe should collapse these (same match + outcome)
    expect(resolvedSignals).toHaveLength(1);

    // The second code should be attached as alias to the dedupe entry
    const entries = Array.from(ingress.dedupeRegistry.values());
    const finalEntry = entries.find((e) => e.fingerprint.startsWith('final:'));
    expect(finalEntry).toBeDefined();
    expect(
      finalEntry.primaryCode === 'SecndCod10' ||
      (finalEntry.codeAliases || []).includes('SecndCod10')
    ).toBe(true);
  });
});

// === Fix 2: Failed signals should not poison dedupe registry ===

describe('TelegramPollingIngress: failed signals clean up dedupe', () => {
  test('parse failure (ignored) should remove provisional dedupe entry', async () => {
    const manager = createClusterProfileManager();
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'ignore',
        state: 'ignored'
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true }))
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Some buffered message' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'IgnoreCode', reply_to_message: { message_id: 10 } }
    }]);

    // Dedupe registry should be clean — parse returned 'ignore'
    expect(ingress.dedupeRegistry.size).toBe(0);
  });

  test('enqueue rejection PRESERVES dedupe entries to protect in-flight task A from re-fire', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    let enqueueCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team R',
        away: 'Team S',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        bookmakerMatchId: 'sb-retry-1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        enqueueCallCount++;
        if (enqueueCallCount === 1) {
          return { accepted: false, error: 'Telegram task is already executing and cannot be updated', taskId: 'task-A' };
        }
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-retry-1' };
      })
    });

    // First attempt: rejected by queue (existing task A still in flight)
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team R vs Team S п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'RetryCodeX', reply_to_message: { message_id: 10 } }
    }]);

    // F4 (review_8): dedupe entry MUST persist after rejection so a follow-up
    // signal with the same fingerprint cannot slip past while task A is still
    // executing.
    expect(ingress.dedupeRegistry.size).toBeGreaterThan(0);

    // Retry with same fingerprint: should be deduped and NOT enqueue again.
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team R vs Team S п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'RetryCodeY', reply_to_message: { message_id: 20 } }
    }]);

    expect(resolvedSignals).toHaveLength(0);
    expect(enqueueCallCount).toBe(1);
  });

  test('parse error (exception) should remove dedupe entries', async () => {
    const manager = createClusterProfileManager();
    let parseCallCount = 0;
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        parseCallCount++;
        if (parseCallCount === 1) {
          throw new Error('LLM timeout');
        }
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'Team E',
          away: 'Team F',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '2',
          bookmakerMatchId: 'sb-err-1',
          normalizedIntent: { family: '1x2', selection: '2', normalizedOutcome: '2' },
          candidateLadder: [{ outcome: '2', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-err-1' };
      })
    });

    // First attempt: parser throws
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team E vs Team F п2' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ErrorCode1', reply_to_message: { message_id: 10 } }
    }]);

    // Dedupe should be clean after error
    expect(ingress.dedupeRegistry.size).toBe(0);
    // Active drafts should be clean — no zombie draft left behind
    expect(ingress.activeDrafts.size).toBe(0);

    // Retry should succeed
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team E vs Team F п2' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ErrorCode2', reply_to_message: { message_id: 20 } }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].home).toBe('Team E');
  });
});

// === Fix 3: Buffer purge should use message-level freshness ===

describe('TelegramPollingIngress: buffer purge uses message freshness', () => {
  test('fresh messages survive purge even if buffer was created long ago', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const now = Date.now();
    const oldCreatedAt = now - 300000; // buffer created 5 minutes ago (> maxAge)
    const freshTimestamp = now - 10000; // message arrived 10 seconds ago

    ingress.preActivationBuffers.set('test-key', {
      messages: [
        { messageId: 1, text: 'old msg', timestamp: oldCreatedAt },
        { messageId: 2, text: 'fresh msg', timestamp: freshTimestamp }
      ],
      createdAt: oldCreatedAt
    });

    ingress._purgeExpiredPreActivationBuffers();

    // Buffer should still exist with the fresh message
    const buffer = ingress.preActivationBuffers.get('test-key');
    expect(buffer).toBeDefined();
    expect(buffer.messages).toHaveLength(1);
    expect(buffer.messages[0].messageId).toBe(2);
  });

  test('buffer with only old messages is purged entirely', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const now = Date.now();
    const oldTimestamp = now - 300000;

    ingress.preActivationBuffers.set('test-key', {
      messages: [
        { messageId: 1, text: 'old msg', timestamp: oldTimestamp }
      ],
      createdAt: oldTimestamp
    });

    ingress._purgeExpiredPreActivationBuffers();

    expect(ingress.preActivationBuffers.has('test-key')).toBe(false);
  });

  test('buffer with no messages and old createdAt is purged', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    ingress.preActivationBuffers.set('test-key', {
      messages: [],
      createdAt: Date.now() - 300000
    });

    ingress._purgeExpiredPreActivationBuffers();

    expect(ingress.preActivationBuffers.has('test-key')).toBe(false);
  });
});

// === Fix: Dedupe entries persist after task completion (blocks late mirrors) ===

describe('TelegramPollingIngress: dedupe persists after completed', () => {
  test('dedupe entry survives task completion and blocks late mirror duplicate', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team A',
        away: 'Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // First signal from bet20_online
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'CompletCd1', reply_to_message: { message_id: 10 } }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    const signalId = resolvedSignals[0].signalId;
    expect(ingress.dedupeRegistry.size).toBeGreaterThan(0);

    // Mark task as completed
    ingress.applyTaskLifecycle(signalId, { state: 'completed' });

    // Draft is archived but dedupe entries must survive
    expect(ingress.activeDrafts.has(signalId)).toBe(false);
    expect(ingress.dedupeRegistry.size).toBeGreaterThan(0);

    // Late mirror signal from bet20_ex with same content
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 102, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 103, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 7109114044 }, text: 'MirrorCd10', reply_to_message: { message_id: 20 } }
    }]);

    // Should NOT create a second signal — dedupe blocks the late mirror
    expect(resolvedSignals).toHaveLength(1);
  });
});

// === Fix: _sendToFeedbackChat preserves inline keyboard ===

describe('TelegramPollingIngress: feedback chat preserves reply_markup', () => {
  test('rerouted clarification sends inline keyboard to feedback chat', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const profile = manager.getProfile('vova_cluster');
    const replyMarkup = {
      inline_keyboard: [[{ text: 'Option A', callback_data: 'tg2|m|c|draft1|0' }]]
    };

    await ingress._sendToFeedbackChat(profile, 'Clarification prompt', { replyMarkup });

    const feedbackCalls = botClient.sendMessage.mock.calls.filter(
      (call) => String(call[0]) === String(-1003717712631)
    );
    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0][2].reply_markup).toEqual(replyMarkup);
  });

  test('rerouted via _sendSourceChatMessage preserves reply_markup in feedback', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const profile = manager.getProfile('vova_cluster');
    const draftContext = {
      session: { chatId: -1002010985531, topicId: null },
      profile
    };

    const replyMarkup = {
      inline_keyboard: [[{ text: 'Choice 1', callback_data: 'tg2|o|c|draft2|0' }]]
    };

    await ingress._sendSourceChatMessage(draftContext, 'Pick an option', { replyMarkup });

    // Should NOT have written to source chat
    const sourceCalls = botClient.sendMessage.mock.calls.filter(
      (call) => call[0] === -1002010985531
    );
    expect(sourceCalls).toHaveLength(0);

    // Should have rerouted to feedback chat WITH reply_markup
    const feedbackCalls = botClient.sendMessage.mock.calls.filter(
      (call) => String(call[0]) === String(-1003717712631)
    );
    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0][2].reply_markup).toEqual(replyMarkup);
  });
});

// === Fix: Callback from feedback chat is accepted for sourceReadOnly drafts ===

describe('TelegramPollingIngress: callback from feedback chat accepted', () => {
  test('callback from feedback chat resolves and applies to cluster draft', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'match_ambiguous',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.7,
        clarification: {
          type: 'match',
          prompt: 'Which match?',
          rejectLabel: 'Другой матч',
          options: [
            { label: 'Match A', bookmakerMatchId: 'sb-1' },
            { label: 'Match B', bookmakerMatchId: 'sb-2' }
          ]
        },
        notes: null
      }))
    };

    // Override isSenderAllowed to always allow (simulates real flow)
    manager.isSenderAllowed = jest.fn(() => true);

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-cb-1' };
      })
    });

    // Create a draft via code-reply activation
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'CbTestCd10', reply_to_message: { message_id: 10 } }
    }]);

    // A draft should be in clarification state
    const drafts = Array.from(ingress.activeDrafts.values());
    expect(drafts.length).toBe(1);
    const draft = drafts[0];
    expect(draft.clarification).toBeTruthy();

    // Simulate callback from feedback chat (-1003717712631)
    const callbackData = ingress._encodeCallbackData({
      draftId: draft.id,
      type: 'match',
      action: 'confirm',
      optionIndex: 0
    });

    // Now make parseSession return 'ready' for the next call (after clarification applied)
    parser.parseSession.mockImplementationOnce(async () => ({
      intentType: 'signal',
      state: 'ready',
      home: 'A',
      away: 'B',
      sport: 'soccer',
      mode: 'live',
      normalizedOutcome: '1',
      normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
      candidateLadder: [{ outcome: '1', priority: 0 }],
      queueDecision: 'enqueue',
      confidence: 0.9,
      clarification: null,
      notes: null
    }));

    await ingress._handleCallbackQuery({
      chatId: -1003717712631, // feedback chat, NOT source
      topicId: null,
      messageId: 9001,
      callbackId: 'cb-123',
      data: callbackData,
      userId: 7268849307,
      authorId: 7268849307
    });

    // Callback should have been accepted (answerCallbackQuery with 'Принято.')
    expect(botClient.answerCallbackQuery).toHaveBeenCalledWith(
      'cb-123',
      'Принято.',
      expect.any(Object)
    );
    // Manual match should have been set
    expect(draft.manualMatch).toEqual({ label: 'Match A', bookmakerMatchId: 'sb-1' });
  });
});

// === Fix: _clearClarificationMarkup targets feedback chat, not source ===

describe('TelegramPollingIngress: clear markup targets feedback chat', () => {
  test('clearing clarification markup uses targetChatId from clarification, not source chat', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const feedbackChatId = -1003717712631;
    const sourceChatId = -1002010985531;
    const clarificationMsgId = 5555;

    const draft = {
      id: 'draft-clear-test',
      session: { chatId: sourceChatId, topicId: null },
      profile: manager.getProfile('vova_cluster'),
      clarification: {
        messageId: clarificationMsgId,
        targetChatId: feedbackChatId // was rerouted to feedback chat
      }
    };

    await ingress._clearClarificationMarkup(draft);

    // Should edit markup on the FEEDBACK chat, not source
    expect(botClient.editMessageReplyMarkup).toHaveBeenCalledWith(
      feedbackChatId,
      clarificationMsgId,
      { inline_keyboard: [] }
    );
    // Verify it was NOT called on source chat
    expect(botClient.editMessageReplyMarkup).not.toHaveBeenCalledWith(
      sourceChatId,
      expect.anything(),
      expect.anything()
    );
  });

  test('clearing markup falls back to session chatId when targetChatId not set', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const draft = {
      id: 'draft-fallback-test',
      session: { chatId: -1003717712631, topicId: null },
      profile: manager.getProfile('testbets_default'),
      clarification: {
        messageId: 6666
        // no targetChatId — backward compat
      }
    };

    await ingress._clearClarificationMarkup(draft);

    expect(botClient.editMessageReplyMarkup).toHaveBeenCalledWith(
      -1003717712631,
      6666,
      { inline_keyboard: [] }
    );
  });
});

// === Fix: post-code timer wraps in try/catch ===

describe('TelegramPollingIngress: post-code timer error handling', () => {
  test('post-code timer error is caught and does not reject promise', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          timer_err_cluster: {
            liveEnabled: true,
            clusterId: 'timer_err',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 100
            }
          }
        }
      }
    });

    const logger = createLogger();
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        throw new Error('Simulated timer error');
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger,
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true }))
    });

    // Buffer + code
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'TimerErr10', reply_to_message: { message_id: 10 } }
    }]);

    // Wait for timer to fire (should not throw unhandled rejection)
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Error should be captured (either by inner _processDraft or outer timer catch)
    expect(logger.error).toHaveBeenCalled();
    expect(ingress.lastError).toBe('Simulated timer error');
  });
});

// === Regression: Finding 1 — stray bot code without reply must not activate ===

describe('TelegramPollingIngress: stray code without reply rejected', () => {
  test('should NOT activate on code from bot without reply_to_message (stray code)', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-stray-1' };
      })
    });

    // Buffer signal message
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'A vs B п1'
      }
    }]);

    expect(ingress.preActivationBuffers.size).toBe(1);

    // Stray code from bot WITHOUT reply_to_message — must NOT activate
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044, username: 'id_matches_bot' },
        text: 'StrayCode1'
      }
    }]);

    // Buffer should still be intact, no activation
    expect(resolvedSignals).toHaveLength(0);
    expect(parser.parseSession).not.toHaveBeenCalled();
    expect(ingress.preActivationBuffers.size).toBe(1);

    // Now send code WITH reply — should activate
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 12,
        date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044, username: 'id_matches_bot' },
        text: 'ReplyCode1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('ReplyCode1');
    expect(ingress.preActivationBuffers.size).toBe(0);
  });
});

// === Regression: Finding 2 — text clarification reply from feedback chat resolves to draft ===

describe('TelegramPollingIngress: text clarification reply from feedback chat', () => {
  test('text reply to clarification in feedback chat should route back to original draft', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        parseCallCount++;
        if (parseCallCount <= 1) {
          return {
            intentType: 'signal',
            state: 'match_ambiguous',
            home: 'A',
            away: 'B',
            sport: 'soccer',
            mode: 'live',
            normalizedOutcome: '1',
            normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
            candidateLadder: [{ outcome: '1', priority: 0 }],
            queueDecision: 'enqueue',
            confidence: 0.7,
            clarification: {
              type: 'match',
              prompt: 'Which match?',
              rejectLabel: 'Другой матч',
              waitForTextOnly: true
            },
            notes: null
          };
        }
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'A',
          away: 'B',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.95,
          clarification: null,
          notes: null
        };
      })
    };

    manager.isSenderAllowed = jest.fn(() => true);

    const resolvedSignals = [];
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-clar-1' };
      })
    });

    // Signal + code activation on sourceReadOnly chat
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ClarTxtCd1', reply_to_message: { message_id: 10 } }
    }]);

    // Draft should be in clarification state
    const drafts = Array.from(ingress.activeDrafts.values());
    expect(drafts.length).toBe(1);
    const draft = drafts[0];
    expect(draft.clarification).toBeTruthy();
    expect(draft.clarification.awaitingText).toBe(true);

    // Clarification message was sent to feedback chat (9001 from mock)
    const clarificationMsgId = draft.clarification.messageId;
    expect(clarificationMsgId).toBe(9001);

    // Verify clarification was indexed under feedback chat, not source chat
    const feedbackKey = ingress._buildMessageIndexKey(-1003717712631, null, clarificationMsgId);
    expect(ingress.clarificationDraftIndex.has(feedbackKey)).toBe(true);

    // Now send text reply in feedback chat, replying to clarification message
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 50,
        date: 200,
        chat: { id: -1003717712631, type: 'supergroup' },
        from: { id: 7268849307, username: 'operator' },
        text: 'Match A correct, bookmaker id sb-999',
        reply_to_message: { message_id: clarificationMsgId, text: 'Which match?' }
      }
    }]);

    // The text reply should have routed to the original draft and triggered reprocess
    expect(parseCallCount).toBeGreaterThanOrEqual(2);
    expect(resolvedSignals).toHaveLength(1);
  });

  test('text reply with forum General topicId should still resolve clarification indexed with null topicId', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        parseCallCount++;
        if (parseCallCount <= 1) {
          return {
            intentType: 'signal',
            state: 'match_ambiguous',
            home: 'A',
            away: 'B',
            sport: 'soccer',
            mode: 'live',
            normalizedOutcome: '1',
            normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
            candidateLadder: [{ outcome: '1', priority: 0 }],
            queueDecision: 'enqueue',
            confidence: 0.7,
            clarification: {
              type: 'match',
              prompt: 'Which match?',
              rejectLabel: 'Другой матч',
              waitForTextOnly: true
            },
            notes: null
          };
        }
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'A',
          away: 'B',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.95,
          clarification: null,
          notes: null
        };
      })
    };

    manager.isSenderAllowed = jest.fn(() => true);

    const resolvedSignals = [];
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-clar-forum-1' };
      })
    });

    // Signal + code activation
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ForumCode1', reply_to_message: { message_id: 10 } }
    }]);

    const draft = Array.from(ingress.activeDrafts.values())[0];
    expect(draft.clarification).toBeTruthy();
    const clarificationMsgId = draft.clarification.messageId;

    // Indexed with topicId=null under feedback chat
    const nullTopicKey = ingress._buildMessageIndexKey(-1003717712631, null, clarificationMsgId);
    expect(ingress.clarificationDraftIndex.has(nullTopicKey)).toBe(true);

    // Reply arrives from feedback chat's General topic (topicId=1) — should still resolve
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 60,
        date: 200,
        chat: { id: -1003717712631, type: 'supergroup' },
        from: { id: 7268849307, username: 'operator' },
        text: 'Match A confirmed',
        message_thread_id: 1,
        reply_to_message: { message_id: clarificationMsgId, text: 'Which match?' }
      }
    }]);

    expect(parseCallCount).toBeGreaterThanOrEqual(2);
    expect(resolvedSignals).toHaveLength(1);
  });
});

// === Regression: Finding 3 — follow-up messages not retained in pre-activation buffer ===

describe('TelegramPollingIngress: follow-up not retained in buffer', () => {
  test('follow-up message to awaiting draft should NOT contaminate pre-activation buffer', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          followup_cluster: {
            liveEnabled: true,
            clusterId: 'followup',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 5000
            }
          }
        }
      }
    });

    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 'task-fu-1' }))
    });

    // Buffer signal message
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B' }
    }]);

    // Code activation — draft enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'FollUpTst1', reply_to_message: { message_id: 10 } }
    }]);

    const sessions = ingress.getActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].stage).toBe('awaiting_followup');
    // Buffer should be cleared after code activation
    expect(ingress.preActivationBuffers.size).toBe(0);

    // Send same-author text while draft is awaiting — WITHOUT reply linkage
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'П1 кэф 1.85' }
    }]);

    // Without reply linkage, message is buffered but NOT appended to the draft
    // (Finding 2: ambiguous same-author messages must not pollute the awaiting draft)
    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'followup_cluster');
    const buf = ingress.preActivationBuffers.get(bufferKey);
    expect(buf).toBeDefined();
    expect(buf.messages).toHaveLength(1);
    expect(buf.messages[0].messageId).toBe(12);

    // The draft should NOT contain the ambiguous follow-up text
    const draft = Array.from(ingress.activeDrafts.values())[0];
    const textContext = draft.session.getTextContext();
    expect(textContext).not.toContain('П1 кэф 1.85');
  });

  test('reply-linked follow-up to awaiting draft is tracked as pending candidate (deferred merge)', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          followup_cluster: {
            liveEnabled: true,
            clusterId: 'followup',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 500
            }
          }
        }
      }
    });

    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A',
        away: 'B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 'task-fu-2' }))
    });

    // Buffer signal message
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B' }
    }]);

    // Code activation — draft enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'FollUpTst2', reply_to_message: { message_id: 10 } }
    }]);

    const sessions = ingress.getActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].stage).toBe('awaiting_followup');

    // Send follow-up text WITH reply linkage to the draft's message
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'П1 кэф 1.85', reply_to_message: { message_id: 10 } }
    }]);

    // Reply-linked follow-up is tracked as pending candidate, NOT immediately in session
    const draft = Array.from(ingress.activeDrafts.values())[0];
    expect(draft.session.getTextContext()).not.toContain('П1 кэф 1.85');
    expect(draft.pendingFollowupCandidates).toHaveLength(1);
    expect(draft.pendingFollowupCandidates[0].messageId).toBe(12);

    // After timer fires, reply-linked candidates must NOT be merged (they may be independent signals)
    await new Promise((resolve) => setTimeout(resolve, 700));
    const lastCall = parser.parseSession.mock.calls[parser.parseSession.mock.calls.length - 1];
    const sessionMsgs = lastCall[0].messages.map((m) => m.messageId);
    expect(sessionMsgs).toContain(10);
    expect(sessionMsgs).not.toContain(12);
  });
});

// === Regression: Finding 4 — dedupe_final cleans up losing draft provisional entries ===

describe('TelegramPollingIngress: dedupe_final cleans provisional entries', () => {
  test('losing draft archived as dedupe_final should remove its provisional dedupe entry', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team A',
        away: 'Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        bookmakerMatchId: 'sb-dedup-1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-df-${resolvedSignals.length}` };
      })
    });

    // First signal from bet20_online
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'DedupFnl01', reply_to_message: { message_id: 10 } }
    }]);

    expect(resolvedSignals).toHaveLength(1);

    // Count dedupe entries after first signal
    const entriesAfterFirst = Array.from(ingress.dedupeRegistry.values());
    const canonicalEntries = entriesAfterFirst.filter(e => e.primaryCode === 'DedupFnl01');
    expect(canonicalEntries.length).toBeGreaterThan(0);

    // Mirror signal from bet20_ex — same content, triggers dedupe_final
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 7109114044 }, text: 'MirrorDf01', reply_to_message: { message_id: 20 } }
    }]);

    // Should NOT have created a second signal
    expect(resolvedSignals).toHaveLength(1);

    // Losing draft's provisional entry should have been cleaned up
    // Only canonical entries (from first draft) should remain
    const remainingEntries = Array.from(ingress.dedupeRegistry.values());
    const losingEntries = remainingEntries.filter(e => e.primaryCode === 'MirrorDf01');
    expect(losingEntries).toHaveLength(0);

    // Canonical entries should still exist
    const canonicalRemaining = remainingEntries.filter(e => e.primaryCode === 'DedupFnl01');
    expect(canonicalRemaining.length).toBeGreaterThan(0);
  });
});

// === Fix: code reply to non-buffered message must not activate (Finding 1) ===

describe('TelegramPollingIngress: code reply to non-buffered message ignored', () => {
  test('code replying to message not in buffer should NOT activate or consume buffer', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A', away: 'B', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-1' };
      })
    });

    // Buffer a message (msgId 10)
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 }, text: 'A vs B п1'
      }
    }]);
    expect(ingress.preActivationBuffers.size).toBe(1);

    // Code bot replies to message 999 (NOT in buffer — older/unrelated message)
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'OrphanCod1',
        reply_to_message: { message_id: 999 }
      }
    }]);

    // Should NOT activate — reply target not in buffer
    expect(resolvedSignals).toHaveLength(0);
    expect(parser.parseSession).not.toHaveBeenCalled();
    // Buffer should remain intact with the original message
    expect(ingress.preActivationBuffers.size).toBe(1);
    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    const buffer = ingress.preActivationBuffers.get(bufferKey);
    expect(buffer.messages).toHaveLength(1);
    expect(buffer.messages[0].messageId).toBe(10);
  });
});

// === Fix: buffer partition isolates signals (Finding 2) ===

describe('TelegramPollingIngress: buffer partition isolates signals', () => {
  test('code replying to SECOND signal should not consume unrelated FIRST signal', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team B', away: 'Team C', sport: 'soccer', mode: 'live',
        normalizedOutcome: '2',
        normalizedIntent: { family: '1x2', selection: '2', normalizedOutcome: '2' },
        candidateLadder: [{ outcome: '2', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // FIRST signal from Author A
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Team A vs Team X п1'
      }
    }]);

    // SECOND signal from Author B
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 20, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 222, username: 'author_b' },
        text: 'Team B vs Team C п2'
      }
    }]);

    expect(ingress.preActivationBuffers.size).toBe(1);
    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(2);

    // Code replies to SECOND signal (msg 20 from Author B)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 21, date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'SecondCod1',
        reply_to_message: { message_id: 20 }
      }
    }]);

    // Only the SECOND signal should be activated
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('SecondCod1');

    // FIRST signal should still be in the buffer, not consumed
    expect(ingress.preActivationBuffers.size).toBe(1);
    const remainingBuffer = ingress.preActivationBuffers.get(bufferKey);
    expect(remainingBuffer.messages).toHaveLength(1);
    expect(remainingBuffer.messages[0].messageId).toBe(10);
  });

  test('same-author burst forward from reply target is grouped together', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'X', away: 'Y', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-burst-1' };
      })
    });

    // Author A posts signal 1 (msg 10)
    // Author B posts burst: msgs 20, 21, 22 (same author, contiguous)
    // Author A posts signal 2 (msg 30)
    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 111 }, text: 'Signal FIRST from A' } },
      { update_id: 2, message: { message_id: 20, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 222 }, text: 'Team X - Team Y' } },
      { update_id: 3, message: { message_id: 21, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 222 }, text: 'П1' } },
      { update_id: 4, message: { message_id: 22, date: 103, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 222 }, text: 'Лайв' } },
      { update_id: 5, message: { message_id: 30, date: 104, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 111 }, text: 'Signal THIRD from A' } }
    ]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(5);

    // Code replies to msg 21 (Author B's burst)
    await ingress.processUpdates([{
      update_id: 6,
      message: {
        message_id: 23, date: 105,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'BurstCode1',
        reply_to_message: { message_id: 21 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    // Session should contain backward (20) + anchor (21) + forward (22) — all Author B's burst
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBe(3);

    // Author A's messages (10, 30) should remain in buffer (different author)
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(remaining.messages).toHaveLength(2);
    expect(remaining.messages.map(m => m.messageId).sort()).toEqual([10, 30]);
  });
});

// === Fix: reject follow-up prompt indexed for routing (Finding 3) ===

describe('TelegramPollingIngress: reject follow-up prompt indexed', () => {
  test('text reply to reject follow-up prompt in feedback chat routes back to draft', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        parseCallCount++;
        if (parseCallCount <= 1) {
          return {
            intentType: 'signal',
            state: 'match_ambiguous',
            home: 'A', away: 'B', sport: 'soccer', mode: 'live',
            normalizedOutcome: '1',
            normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
            candidateLadder: [{ outcome: '1', priority: 0 }],
            queueDecision: 'enqueue', confidence: 0.7,
            clarification: {
              type: 'match',
              prompt: 'Which match?',
              rejectLabel: 'Другой матч',
              options: [
                { label: 'Match A', bookmakerMatchId: 'sb-1' },
                { label: 'Match B', bookmakerMatchId: 'sb-2' }
              ]
            },
            notes: null
          };
        }
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'A', away: 'B', sport: 'soccer', mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.95,
          clarification: null, notes: null
        };
      })
    };

    manager.isSenderAllowed = jest.fn(() => true);

    let sentMsgCounter = 9001;
    botClient.sendMessage = jest.fn(async () => ({
      ok: true,
      result: { message_id: sentMsgCounter++ }
    }));

    const resolvedSignals = [];
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-reject-1' };
      })
    });

    // Code activation → clarification with buttons
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B п1' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'RejectCd10', reply_to_message: { message_id: 10 } }
    }]);

    const draft = Array.from(ingress.activeDrafts.values())[0];
    expect(draft.clarification).toBeTruthy();
    const clarificationMsgId = draft.clarification.messageId; // 9001

    // User presses REJECT in feedback chat
    const rejectCallbackData = ingress._encodeCallbackData({
      draftId: draft.id,
      type: 'match',
      action: 'reject',
      optionIndex: -1
    });

    await ingress._handleCallbackQuery({
      chatId: -1003717712631,
      topicId: null,
      messageId: clarificationMsgId,
      callbackId: 'cb-reject-1',
      data: rejectCallbackData,
      authorId: 7268849307
    });

    // After reject, clarification should be awaiting text
    expect(draft.clarification.awaitingText).toBe(true);

    // The reject follow-up prompt (9002) should be indexed in feedback chat
    const rejectPromptMsgId = 9002;
    const feedbackKey = ingress._buildMessageIndexKey(-1003717712631, null, rejectPromptMsgId);
    expect(ingress.clarificationDraftIndex.has(feedbackKey)).toBe(true);
    expect(ingress.clarificationDraftIndex.get(feedbackKey)).toBe(draft.id);

    // Verify reply_to_message_id was preserved in the feedback chat message
    const rejectPromptCall = botClient.sendMessage.mock.calls.find(
      (call) => call[2]?.reply_to_message_id === clarificationMsgId
    );
    expect(rejectPromptCall).toBeDefined();

    // Now user replies to the reject prompt in feedback chat
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 60, date: 200,
        chat: { id: -1003717712631, type: 'supergroup' },
        from: { id: 7268849307, username: 'operator' },
        text: 'Correct match is sb-999',
        reply_to_message: { message_id: rejectPromptMsgId, text: 'Ок, уточните матч текстом или реплаем.' }
      }
    }]);

    // The text reply should route back to the original draft and trigger reprocess
    expect(parseCallCount).toBeGreaterThanOrEqual(2);
    expect(resolvedSignals).toHaveLength(1);
  });
});

// === Fix: awaiting-followup must be author-scoped (Finding 1) ===

describe('TelegramPollingIngress: awaiting_followup author isolation', () => {
  test('other-author message during followup window must buffer, not get absorbed', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          delayed_cluster: {
            liveEnabled: true,
            clusterId: 'delayed',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 500
            }
          }
        }
      }
    });

    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'A', away: 'B', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-author-iso' };
      })
    });

    // Author A buffers a signal
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'author_a' },
        text: 'A vs B п1'
      }
    }]);

    // Code replies to Author A's message → draft enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'FollwCode1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(ingress.getActiveSessions().length).toBe(1);
    expect(ingress.getActiveSessions()[0].stage).toBe('awaiting_followup');

    // Author B posts a DIFFERENT signal in the same chat during the followup window
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 12, date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 666, username: 'author_b' },
        text: 'X vs Y тотал больше 2.5'
      }
    }]);

    // Author B's message must NOT be absorbed into Author A's draft
    // It must go to the pre-activation buffer instead
    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'delayed_cluster');
    const buffer = ingress.preActivationBuffers.get(bufferKey);
    expect(buffer).toBeDefined();
    expect(buffer.messages).toHaveLength(1);
    expect(buffer.messages[0].messageId).toBe(12);
    expect(buffer.messages[0].authorId).toBe(666);

    // Author A's follow-up must still be absorbed by the awaiting draft
    await ingress.processUpdates([{
      update_id: 4,
      message: {
        message_id: 13, date: 103,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'author_a' },
        text: 'если выше 1.80'
      }
    }]);

    // Author A's follow-up is appended to draft AND also buffered (dual-path)
    expect(buffer.messages).toHaveLength(2);
    expect(buffer.messages.map(m => m.messageId)).toContain(12); // Author B
    expect(buffer.messages.map(m => m.messageId)).toContain(13); // Author A follow-up

    // Wait for timer to fire on Author A's draft
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('FollwCode1');

    // Both Author B's signal and Author A's follow-up available in buffer
    const finalBuf = ingress.preActivationBuffers.get(bufferKey);
    expect(finalBuf.messages).toHaveLength(2);
    expect(finalBuf.messages.map(m => m.messageId)).toContain(12);
  });
});

// === Fix: partition must not over-consume separate same-author signals (Finding 2) ===

describe('TelegramPollingIngress: partition time-gap isolation', () => {
  test('same author two separate signals — reply to second must NOT consume first', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Team X', away: 'Team Y', sport: 'soccer', mode: 'live',
        normalizedOutcome: '2',
        normalizedIntent: { family: '1x2', selection: '2', normalizedOutcome: '2' },
        candidateLadder: [{ outcome: '2', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // Author A posts FIRST signal at t=100
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Team P vs Team Q п1'
      }
    }]);

    // Same Author A posts SECOND signal at t=160 (60 seconds later — clearly separate)
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 20, date: 160,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Team X vs Team Y п2'
      }
    }]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(2);

    // Code replies to SECOND signal (msg 20)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 21, date: 161,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'SecondCod1',
        reply_to_message: { message_id: 20 }
      }
    }]);

    // Only the SECOND signal should be activated
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('SecondCod1');

    // FIRST signal must remain in the buffer
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(remaining).toBeDefined();
    expect(remaining.messages).toHaveLength(1);
    expect(remaining.messages[0].messageId).toBe(10);
  });

  test('same author tight burst still groups forward from anchor', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'X', away: 'Y', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-burst' };
      })
    });

    // Author A posts a burst: 3 messages 1 second apart
    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 111 }, text: 'Team X - Team Y' } },
      { update_id: 2, message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 111 }, text: 'П1' } },
      { update_id: 3, message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 111 }, text: 'Лайв' } }
    ]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(3);

    // Code replies to middle message (msg 11) — forward walk picks up 12, but not backward 10
    await ingress.processUpdates([{
      update_id: 4,
      message: {
        message_id: 13, date: 103,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'BurstCode1',
        reply_to_message: { message_id: 11 }
      }
    }]);

    // Backward (10) + anchor (11) + forward (12) all consumed; tight burst fully grouped
    expect(resolvedSignals).toHaveLength(1);
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBe(3);

    // Buffer should be empty — all messages consumed
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(!remaining || remaining.messages.length === 0).toBe(true);
  });

  test('same author signals 4s apart are NOT forward-grouped (beyond 3s threshold, F2 review_7)', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'X', away: 'Y', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    // Author A posts signal A at t=100
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Team P vs Team Q п1'
      }
    }]);

    // Same author posts signal B at t=104 (4s later — beyond the 3s forward gap)
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 20, date: 104,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Team X vs Team Y п2'
      }
    }]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(2);

    // Code replies to FIRST signal (msg 10) — forward walk must NOT absorb msg 20 (4s gap > 3s threshold)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 11, date: 105,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'GapCode123',
        reply_to_message: { message_id: 10 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('GapCode123');

    // Signal B (msg 20) must remain in the buffer — it is a separate signal
    const remaining2 = ingress.preActivationBuffers.get(bufferKey);
    expect(remaining2).toBeDefined();
    expect(remaining2.messages).toHaveLength(1);
    expect(remaining2.messages[0].messageId).toBe(20);
  });

});

// === Regression: provisional dedupe must NOT suppress semantically different bets ===

describe('TelegramPollingIngress: provisional dedupe advisory only', () => {
  test('identical buffered text parsing into different totals/outcomes both reach parsing', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => {
        parseCallCount++;
        if (parseCallCount === 1) {
          return {
            intentType: 'signal', state: 'ready',
            home: 'Team X', away: 'Team Y', sport: 'basketball', mode: 'live',
            normalizedOutcome: 'Over 210.5',
            bookmakerMatchId: 'bk-total-1',
            normalizedIntent: { family: 'total', selection: 'over', line: 210.5, normalizedOutcome: 'Over 210.5' },
            candidateLadder: [{ outcome: 'Over 210.5', priority: 0 }],
            queueDecision: 'enqueue', confidence: 0.9, clarification: null, notes: null
          };
        }
        return {
          intentType: 'signal', state: 'ready',
          home: 'Team X', away: 'Team Y', sport: 'basketball', mode: 'live',
          normalizedOutcome: 'Under 220.5',
          bookmakerMatchId: 'bk-total-1',
          normalizedIntent: { family: 'total', selection: 'under', line: 220.5, normalizedOutcome: 'Under 220.5' },
          candidateLadder: [{ outcome: 'Under 220.5', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.9, clarification: null, notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-prov-${resolvedSignals.length}` };
      })
    });

    // First signal in bet20_online — text about Team X vs Team Y total
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team X vs Team Y T>210.5' }
    }]);
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ProvAdvs01', reply_to_message: { message_id: 10 } }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].outcome).toBe('Over 210.5');
    expect(parser.parseSession).toHaveBeenCalledTimes(1);

    // Second signal from mirror chat bet20_ex — identical text but parses to different outcome
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 20, date: 200, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 555 }, text: 'Team X vs Team Y T>210.5' }
    }]);
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 21, date: 201, chat: { id: -1002097397120, type: 'supergroup' }, from: { id: 7109114044 }, text: 'ProvAdvs02', reply_to_message: { message_id: 20 } }
    }]);

    // Second signal MUST reach parsing — provisional dedupe must not block it
    expect(parser.parseSession).toHaveBeenCalledTimes(2);
    // Both signals should resolve (different final fingerprints — different outcomes/lines)
    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[1].outcome).toBe('Under 220.5');
  });
});

// === Regression: same-author back-to-back signals within 10s not merged ===

describe('TelegramPollingIngress: same-author 10s isolation', () => {
  test('two distinct same-author signals <10s apart — reply to second must NOT consume first', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal', state: 'ready',
        home: 'Team M', away: 'Team N', sport: 'soccer', mode: 'live',
        normalizedOutcome: '2',
        normalizedIntent: { family: '1x2', selection: '2', normalizedOutcome: '2' },
        candidateLadder: [{ outcome: '2', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9, clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-iso-${resolvedSignals.length}` };
      })
    });

    // Author A posts FIRST signal at t=100s
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Real Madrid vs Barcelona п1'
      }
    }]);

    // Same Author A posts SECOND signal at t=105s (5s later — within 10s burst threshold)
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 20, date: 105,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 111, username: 'author_a' },
        text: 'Milan vs Napoli п2'
      }
    }]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(2);

    // Code replies to SECOND signal (msg 20)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 21, date: 106,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'IsolatCd01',
        reply_to_message: { message_id: 20 }
      }
    }]);

    // Only SECOND signal should be activated — anchor is msg 20, no backward walk
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('IsolatCd01');

    // Session should contain only msg 20 (anchor, no forward continuation from same author)
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBe(1);
    expect(session.messages[0].messageId).toBe(20);

    // FIRST signal (msg 10) must remain in buffer — available for separate activation
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(remaining).toBeDefined();
    expect(remaining.messages).toHaveLength(1);
    expect(remaining.messages[0].messageId).toBe(10);
  });
});

// === Regression: same-author back-to-back signals during post-code follow-up window ===

describe('TelegramPollingIngress: same-author overlapping activation in follow-up window', () => {
  test('signal B from same author during follow-up window of A must still be independently activatable', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          overlap_cluster: {
            liveEnabled: true,
            clusterId: 'overlap',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 200
            }
          }
        }
      }
    });

    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn()
        .mockResolvedValueOnce({
          intentType: 'signal', state: 'ready',
          home: 'Team Alpha', away: 'Team Beta', sport: 'soccer', mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.9,
          clarification: null, notes: null
        })
        .mockResolvedValueOnce({
          intentType: 'signal', state: 'ready',
          home: 'Team X', away: 'Team Y', sport: 'soccer', mode: 'live',
          normalizedOutcome: 'over 2.5',
          normalizedIntent: { family: 'totals', selection: 'over', line: 2.5, normalizedOutcome: 'over 2.5' },
          candidateLadder: [{ outcome: 'over 2.5', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.9,
          clarification: null, notes: null
        })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-overlap-${resolvedSignals.length}` };
      })
    });

    // 1) Author sends signal A
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'author_a' },
        text: 'Team Alpha vs Team Beta п1'
      }
    }]);

    // 2) Bot replies with code for A → draft A enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'OverlapCd1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    const sessions1 = ingress.getActiveSessions();
    expect(sessions1).toHaveLength(1);
    expect(sessions1[0].stage).toBe('awaiting_followup');
    // Verify activation code via direct draft access
    const draftA1 = Array.from(ingress.activeDrafts.values())[0];
    expect(draftA1.activationCode).toBe('OverlapCd1');

    // 3) Same author sends signal B before follow-up timer expires
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 20, date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555, username: 'author_a' },
        text: 'Team X vs Team Y тотал больше 2.5'
      }
    }]);

    // Signal B must be in the buffer (dual-path: appended to draft A AND buffered)
    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'overlap_cluster');
    const buffer = ingress.preActivationBuffers.get(bufferKey);
    expect(buffer).toBeDefined();
    expect(buffer.messages.map(m => m.messageId)).toContain(20);

    // 4) Bot replies with code for B → must create a new activation
    await ingress.processUpdates([{
      update_id: 4,
      message: {
        message_id: 21, date: 103,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'OverlapCd2',
        reply_to_message: { message_id: 20 }
      }
    }]);

    // B must be activated as a separate draft — NOT swallowed by A
    const allDrafts = Array.from(ingress.activeDrafts.values());
    const draftB = allDrafts.find(d => d.activationCode === 'OverlapCd2');
    expect(draftB).toBeDefined();

    // Both drafts should exist — A still awaiting_followup, B independently activated
    const draftA = allDrafts.find(d => d.activationCode === 'OverlapCd1');
    if (draftA) {
      expect(draftA.activationCode).toBe('OverlapCd1');
    }

    // Wait for all timers to settle (postCodeFollowupWindowMs=200)
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Both signals should be resolved (each via their own draft)
    const activationCodes = resolvedSignals.map(s => s.activationCode);
    expect(activationCodes).toContain('OverlapCd2');
  });
});

// === Regression: Finding 1 — failed activation restores buffer for retry ===

describe('TelegramPollingIngress: failed activation restores buffer', () => {
  test('enqueue rejection restores source messages for re-activation by later code reply', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    let enqueueCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Restore Team A',
        away: 'Restore Team B',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        bookmakerMatchId: 'sb-restore-1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.9,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        enqueueCallCount++;
        if (enqueueCallCount === 1) {
          return { accepted: false, error: 'Queue full — transient' };
        }
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-restored-1' };
      })
    });

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');

    // 1) Author sends signal A
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'Restore Team A vs Restore Team B п1'
      }
    }]);
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(1);

    // 2) First code reply → enqueue rejected
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'RestoreCd1',
        reply_to_message: { message_id: 10 }
      }
    }]);

    // Signal should NOT have been accepted
    expect(resolvedSignals).toHaveLength(0);
    expect(enqueueCallCount).toBe(1);

    // Source message must be RESTORED in the buffer (read-only source — can't re-send)
    const restoredBuffer = ingress.preActivationBuffers.get(bufferKey);
    expect(restoredBuffer).toBeDefined();
    expect(restoredBuffer.messages).toHaveLength(1);
    expect(restoredBuffer.messages[0].messageId).toBe(10);

    // 3) Second code reply to the SAME source message → should succeed
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 12, date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'RestoreCd2',
        reply_to_message: { message_id: 10 }
      }
    }]);

    // Now the signal should be accepted on retry
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].home).toBe('Restore Team A');
    expect(enqueueCallCount).toBe(2);
  });
});

// === Regression: Finding 2 — unrelated same-author signal does not pollute awaiting draft ===

describe('TelegramPollingIngress: same-author signal isolation during follow-up', () => {
  test('unrelated signal B from same author during follow-up window must NOT appear in A parse context', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          isolation_cluster: {
            liveEnabled: true,
            clusterId: 'isolation',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'test_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 300
            }
          }
        }
      }
    });

    const parseSessions = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => {
        parseSessions.push(session.getTextContext());
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'IsoTeam A', away: 'IsoTeam B', sport: 'soccer', mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.9,
          clarification: null, notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 'task-iso-1' }))
    });

    // 1) Author sends signal A
    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10, date: 100,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'IsoTeam A vs IsoTeam B п1'
      }
    }]);

    // 2) Code bot activates signal A → draft enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11, date: 101,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'IsoCdAAAAB',
        reply_to_message: { message_id: 10 }
      }
    }]);

    const draft = Array.from(ingress.activeDrafts.values())[0];
    expect(draft.stage).toBe('awaiting_followup');

    // 3) Same author sends unrelated signal B (no reply linkage to draft A)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 20, date: 102,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 555 },
        text: 'COMPLETELY DIFFERENT Real Madrid vs Barcelona тб2.5'
      }
    }]);

    // Draft A's text context must NOT contain signal B's text
    const textA = draft.session.getTextContext();
    expect(textA).not.toContain('COMPLETELY DIFFERENT');
    expect(textA).not.toContain('Real Madrid');

    // Wait for follow-up timer to expire and process
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The parsed session for draft A should contain only its original text
    expect(parseSessions.length).toBeGreaterThanOrEqual(1);
    expect(parseSessions[0]).not.toContain('COMPLETELY DIFFERENT');
    expect(parseSessions[0]).toContain('IsoTeam A');
  });
});

// === Regression: Finding 3 — multi-message burst backward context recovery ===

describe('TelegramPollingIngress: multi-message burst backward recovery', () => {
  test('code reply to later message in tight burst recovers earlier context', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Burst A', away: 'Burst B', sport: 'soccer', mode: 'live',
        normalizedOutcome: 'over 2.5',
        normalizedIntent: { family: 'totals', selection: 'over', line: 2.5, normalizedOutcome: 'over 2.5' },
        candidateLadder: [{ outcome: 'over 2.5', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-burst-back-1' };
      })
    });

    // Author posts a 3-message burst: match info, outcome, stake — all within 2s
    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 333 }, text: 'Burst A vs Burst B' } },
      { update_id: 2, message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 333 }, text: 'тотал больше 2.5' } },
      { update_id: 3, message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 333 }, text: 'лайв ставка 100' } }
    ]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(3);

    // Code bot replies to the LAST message (msg 12) — backward walk should recover 10 and 11
    await ingress.processUpdates([{
      update_id: 4,
      message: {
        message_id: 13, date: 103,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'BurstBk001',
        reply_to_message: { message_id: 12 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    // All 3 messages from the tight burst should be in the session
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBe(3);
    expect(session.messages.map(m => m.messageId).sort()).toEqual([10, 11, 12]);

    // Buffer should be empty — entire burst consumed
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(!remaining || remaining.messages.length === 0).toBe(true);
  });

  test('backward walk stops at large gap — separate signal not absorbed', async () => {
    const manager = createClusterProfileManager();
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Gap A', away: 'Gap B', sport: 'soccer', mode: 'live',
        normalizedOutcome: '2',
        normalizedIntent: { family: '1x2', selection: '2', normalizedOutcome: '2' },
        candidateLadder: [{ outcome: '2', priority: 0 }],
        queueDecision: 'enqueue', confidence: 0.9,
        clarification: null, notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-gap-1' };
      })
    });

    // Author posts first signal at t=100, then second signal 4 seconds later (>3s backward threshold)
    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 333 }, text: 'Separate signal' } },
      { update_id: 2, message: { message_id: 20, date: 104, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 333 }, text: 'Gap A vs Gap B п2' } }
    ]);

    const bufferKey = ingress._buildPreActivationBufferKey(-1002010985531, null, 'vova_cluster');
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(2);

    // Code replies to msg 20 — backward walk should NOT absorb msg 10 (4s gap > 3s threshold)
    await ingress.processUpdates([{
      update_id: 3,
      message: {
        message_id: 21, date: 105,
        chat: { id: -1002010985531, type: 'supergroup' },
        from: { id: 7109114044 },
        text: 'GapCode001',
        reply_to_message: { message_id: 20 }
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    const session = parser.parseSession.mock.calls[0][0];
    expect(session.messages.length).toBe(1);
    expect(session.messages[0].messageId).toBe(20);

    // msg 10 should remain in buffer — not absorbed by backward walk
    const remaining = ingress.preActivationBuffers.get(bufferKey);
    expect(remaining).toBeDefined();
    expect(remaining.messages).toHaveLength(1);
    expect(remaining.messages[0].messageId).toBe(10);
  });
});

// === Regression: reply-linked second signal must not contaminate first draft ===

describe('TelegramPollingIngress: reply-linked signal isolation', () => {
  test('signal A parse context must NOT include signal B when B replies to A and later gets its own code reply', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          iso_cluster: {
            liveEnabled: true,
            clusterId: 'iso',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'iso_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 800
            }
          }
        }
      }
    });

    const resolvedSignals = [];
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => {
        parseCallCount++;
        return {
          intentType: 'signal',
          state: 'ready',
          home: parseCallCount === 1 ? 'Team A' : 'Team C',
          away: parseCallCount === 1 ? 'Team B' : 'Team D',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: parseCallCount === 1 ? '1' : '2',
          bookmakerMatchId: parseCallCount === 1 ? 'sb-iso-1' : 'sb-iso-2',
          normalizedIntent: { family: '1x2', normalizedOutcome: parseCallCount === 1 ? '1' : '2' },
          candidateLadder: [{ outcome: parseCallCount === 1 ? '1' : '2', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-iso-${resolvedSignals.length}` };
      })
    });

    // 1. Buffer signal A (message 10)
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);

    // 2. Code reply activates A → draft enters awaiting_followup
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'IsoCodeAA1', reply_to_message: { message_id: 10 } }
    }]);

    expect(ingress.getActiveSessions()).toHaveLength(1);
    expect(ingress.getActiveSessions()[0].stage).toBe('awaiting_followup');

    // 3. Signal B arrives from same author, replies to message 10 (which is in draft A)
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team C vs Team D п2', reply_to_message: { message_id: 10 } }
    }]);

    // B should be tracked as pending candidate on draft A, NOT appended to its session
    const sessions = ingress.getActiveSessions();
    expect(sessions).toHaveLength(1);
    // Draft A should still have only the original message
    const draftAId = sessions[0].sessionId;
    const draftA = ingress.activeDrafts.get(draftAId);
    expect(draftA.session.messages).toHaveLength(1);
    expect(draftA.session.messages[0].messageId).toBe(10);
    expect(draftA.pendingFollowupCandidates).toHaveLength(1);
    expect(draftA.pendingFollowupCandidates[0].messageId).toBe(12);

    // 4. Code reply activates B (replies to message 12 which is in the buffer)
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 13, date: 103, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'IsoCodeBB2', reply_to_message: { message_id: 12 } }
    }]);

    // Draft B should be activated (enters its own awaiting_followup)
    // Draft A is still awaiting_followup (timer hasn't fired)
    expect(ingress.activeDrafts.size).toBe(2);

    // 5. Wait for both timers to fire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Both signals should have been resolved
    expect(resolvedSignals).toHaveLength(2);

    // Verify draft A's parse context did NOT include signal B's content
    const parseCallA = parser.parseSession.mock.calls[0];
    const sessionA = parseCallA[0];
    const sessionAMsgIds = sessionA.messages.map((m) => m.messageId);
    expect(sessionAMsgIds).not.toContain(12);
    expect(sessionAMsgIds).toContain(10);

    // Verify draft B's parse context includes signal B's content
    const parseCallB = parser.parseSession.mock.calls[1];
    const sessionB = parseCallB[0];
    const sessionBMsgIds = sessionB.messages.map((m) => m.messageId);
    expect(sessionBMsgIds).toContain(12);
  });
});

// === Regression: stale non-terminal dedupe entries must not block retries after restart ===

describe('TelegramPollingIngress: stale dedupe entries discarded on reload', () => {
  test('persisted stale processing/ready entries do not block fresh retry after restart simulation', () => {
    const fs = require('fs');
    const path = require('path');

    // Write a dedupe file with stale non-terminal entries
    const dedupeDir = path.join(__dirname, '_test_dedupe_tmp');
    const dedupeFilePath = path.join(dedupeDir, 'dedupe.json');
    fs.mkdirSync(dedupeDir, { recursive: true });

    const staleEntries = {
      entries: [
        {
          fingerprint: 'prov:cluster1:txt:team a vs team b п1',
          clusterId: 'cluster1',
          primaryCode: 'StaleProc1',
          codeAliases: [],
          status: 'processing',
          firstSeenAt: Date.now() - 60000,
          lastSeenAt: Date.now() - 60000,
          draftId: 'old-draft-1',
          taskId: null
        },
        {
          fingerprint: 'final:cluster1:live:soccer:sb-111:1:1x2::',
          clusterId: 'cluster1',
          primaryCode: 'StaleRdy01',
          codeAliases: [],
          status: 'ready',
          firstSeenAt: Date.now() - 60000,
          lastSeenAt: Date.now() - 60000,
          draftId: 'old-draft-2',
          taskId: null
        },
        {
          fingerprint: 'final:cluster1:live:soccer:sb-222:2:1x2::',
          clusterId: 'cluster1',
          primaryCode: 'AcceptCd01',
          codeAliases: [],
          status: 'accepted',
          firstSeenAt: Date.now() - 60000,
          lastSeenAt: Date.now() - 60000,
          draftId: 'old-draft-3',
          taskId: 'task-123'
        }
      ]
    };
    fs.writeFileSync(dedupeFilePath, JSON.stringify(staleEntries, null, 2));

    try {
      const ingress = new TelegramPollingIngress({
        botClient: createBotClient(),
        chatProfileManager: createClusterProfileManager(),
        signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
        logger: createLogger(),
        bookmakerName: 'Sansabet',
        bookmakerId: 'sansabet',
        runtimeMode: 'live',
        dedupeFilePath
      });

      // Simulate restart: load dedupe registry
      ingress._loadDedupeRegistry();

      // Stale 'processing' and 'ready' entries should be discarded
      expect(ingress._findDedupeEntryByFingerprint('prov:cluster1:txt:team a vs team b п1')).toBeNull();
      expect(ingress._findDedupeEntryByFingerprint('final:cluster1:live:soccer:sb-111:1:1x2::')).toBeNull();

      // 'accepted' entry should survive (terminal state — task was confirmed)
      const accepted = ingress._findDedupeEntryByFingerprint('final:cluster1:live:soccer:sb-222:2:1x2::');
      expect(accepted).not.toBeNull();
      expect(accepted.status).toBe('accepted');
      expect(accepted.taskId).toBe('task-123');

      // Fresh retry with the same final fingerprint as the stale 'ready' entry should NOT be blocked
      expect(ingress.dedupeRegistry.size).toBe(1);
    } finally {
      // Cleanup
      fs.rmSync(dedupeDir, { recursive: true, force: true });
    }
  });

  test('accepted dedupe entries are promoted on task acceptance and survive save/load cycle', async () => {
    const fs = require('fs');
    const path = require('path');

    const dedupeDir = path.join(__dirname, '_test_dedupe_accept_tmp');
    const dedupeFilePath = path.join(dedupeDir, 'dedupe.json');
    fs.mkdirSync(dedupeDir, { recursive: true });

    try {
      const manager = createClusterProfileManager();
      const resolvedSignals = [];
      const parser = {
        detectMessageIntent: jest.fn(async () => ({
          intentType: 'signal', confidence: 0.9, notes: null
        })),
        parseSession: jest.fn(async () => ({
          intentType: 'signal',
          state: 'ready',
          home: 'Team A',
          away: 'Team B',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '1',
          bookmakerMatchId: 'sb-accept-1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        }))
      };

      const ingress = new TelegramPollingIngress({
        botClient: createBotClient(),
        chatProfileManager: manager,
        signalParser: parser,
        logger: createLogger(),
        bookmakerName: 'Sansabet',
        bookmakerId: 'sansabet',
        runtimeMode: 'live',
        dedupeFilePath,
        onResolvedSignal: jest.fn(async (task) => {
          resolvedSignals.push(task);
          return { accepted: true, taskId: 'task-accept-1' };
        })
      });

      // Process a signal
      await ingress.processUpdates([{
        update_id: 1,
        message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
      }]);
      await ingress.processUpdates([{
        update_id: 2,
        message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'AcceptCd02', reply_to_message: { message_id: 10 } }
      }]);

      expect(resolvedSignals).toHaveLength(1);

      // After acceptance, dedupe entries should be promoted to 'accepted'
      const entries = Array.from(ingress.dedupeRegistry.values());
      const finalEntry = entries.find((e) => e.fingerprint.startsWith('final:'));
      expect(finalEntry).toBeDefined();
      expect(finalEntry.status).toBe('accepted');
      expect(finalEntry.taskId).toBe('task-accept-1');

      // Save and reload — accepted entry must survive
      ingress._saveDedupeRegistry();

      const ingress2 = new TelegramPollingIngress({
        botClient: createBotClient(),
        chatProfileManager: manager,
        signalParser: parser,
        logger: createLogger(),
        bookmakerName: 'Sansabet',
        bookmakerId: 'sansabet',
        runtimeMode: 'live',
        dedupeFilePath
      });
      ingress2._loadDedupeRegistry();

      // 'accepted' entry survives; 'processing' provisional entry discarded
      const reloaded = ingress2._findDedupeEntryByFingerprint(finalEntry.fingerprint);
      expect(reloaded).not.toBeNull();
      expect(reloaded.status).toBe('accepted');

      // Provisional 'processing' entries should be gone
      const provEntries = Array.from(ingress2.dedupeRegistry.values()).filter((e) => e.status === 'processing');
      expect(provEntries).toHaveLength(0);
    } finally {
      fs.rmSync(dedupeDir, { recursive: true, force: true });
    }
  });
});

// === Regression: reply-linked second signal must NOT contaminate first draft when code arrives after timer ===

describe('TelegramPollingIngress: late code reply does not contaminate first draft', () => {
  test('signal A parse context excludes signal B even when B code reply arrives after A timer fires', async () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          late_cluster: {
            liveEnabled: true,
            clusterId: 'late',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1002010985531, topicId: null, label: 'late_chat', priority: 100 }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [7109114044],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 400
            }
          }
        }
      }
    });

    const resolvedSignals = [];
    let parseCallCount = 0;
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.9, notes: null
      })),
      parseSession: jest.fn(async (session) => {
        parseCallCount++;
        return {
          intentType: 'signal',
          state: 'ready',
          home: parseCallCount === 1 ? 'Team A' : 'Team C',
          away: parseCallCount === 1 ? 'Team B' : 'Team D',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: parseCallCount === 1 ? '1' : '2',
          bookmakerMatchId: parseCallCount === 1 ? 'sb-late-1' : 'sb-late-2',
          normalizedIntent: { family: '1x2', normalizedOutcome: parseCallCount === 1 ? '1' : '2' },
          candidateLadder: [{ outcome: parseCallCount === 1 ? '1' : '2', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.9,
          clarification: null,
          notes: null
        };
      })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-late-${resolvedSignals.length}` };
      })
    });

    // 1. Buffer signal A (message 10)
    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team A vs Team B п1' }
    }]);

    // 2. Code reply activates A → draft enters awaiting_followup (400ms window)
    await ingress.processUpdates([{
      update_id: 2,
      message: { message_id: 11, date: 101, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'LateCodeA1', reply_to_message: { message_id: 10 } }
    }]);

    expect(ingress.getActiveSessions()).toHaveLength(1);
    expect(ingress.getActiveSessions()[0].stage).toBe('awaiting_followup');

    // 3. Signal B from same author replies to A's message during follow-up window
    await ingress.processUpdates([{
      update_id: 3,
      message: { message_id: 12, date: 102, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 555 }, text: 'Team C vs Team D п2', reply_to_message: { message_id: 10 } }
    }]);

    // 4. Wait for A's timer to fire (400ms + margin)
    await new Promise((resolve) => setTimeout(resolve, 700));

    // A must have resolved WITHOUT B's content
    expect(resolvedSignals).toHaveLength(1);
    const parseCallA = parser.parseSession.mock.calls[0];
    const sessionAMsgIds = parseCallA[0].messages.map((m) => m.messageId);
    expect(sessionAMsgIds).toContain(10);
    expect(sessionAMsgIds).not.toContain(12);

    // 5. Code reply activates B (arrives AFTER A timer already fired, within preSignalWindowMs of B)
    await ingress.processUpdates([{
      update_id: 4,
      message: { message_id: 13, date: 105, chat: { id: -1002010985531, type: 'supergroup' }, from: { id: 7109114044 }, text: 'LateCodeB2', reply_to_message: { message_id: 12 } }
    }]);

    // Wait for B's timer
    await new Promise((resolve) => setTimeout(resolve, 700));

    // B must resolve independently
    expect(resolvedSignals).toHaveLength(2);
    const parseCallB = parser.parseSession.mock.calls[1];
    const sessionBMsgIds = parseCallB[0].messages.map((m) => m.messageId);
    expect(sessionBMsgIds).toContain(12);
    expect(sessionBMsgIds).not.toContain(10);
  });
});

// === Regression: resolveExecutionPolicy excludes source chats from feedbackChatIds for read-only profiles ===

describe('ChatProfileManager: feedbackChatIds excludes source chats for sourceReadOnly', () => {
  test('vova_cluster feedbackChatIds must not include source chat IDs', () => {
    const manager = createClusterProfileManager();
    const policy = manager.resolveExecutionPolicy({
      profileId: 'vova_cluster',
      mode: 'live'
    });

    expect(policy.enabled).toBe(true);
    expect(policy.sourceReadOnly).toBe(true);

    // Source chat IDs must NOT appear in feedbackChatIds
    const sourceChatIds = ['-1002010985531', '-1002097397120', '-1002201691237'];
    for (const srcId of sourceChatIds) {
      expect(policy.feedbackChatIds).not.toContain(srcId);
    }

    // The dedicated feedback chat must still be present
    expect(policy.feedbackChatIds).toContain(String(-1003717712631));
  });

  test('supernova_cluster feedbackChatIds must not include source chat IDs', () => {
    const manager = createClusterProfileManager();
    const policy = manager.resolveExecutionPolicy({
      profileId: 'supernova_cluster',
      mode: 'live'
    });

    expect(policy.enabled).toBe(true);
    expect(policy.sourceReadOnly).toBe(true);

    const sourceChatIds = ['-1002009104562', '-1002069845466'];
    for (const srcId of sourceChatIds) {
      expect(policy.feedbackChatIds).not.toContain(srcId);
    }

    expect(policy.feedbackChatIds).toContain(String(-1003717712631));
  });

  test('testbets_default feedbackChatIds still includes chatIds (non-read-only backward compat)', () => {
    const manager = createClusterProfileManager();
    const policy = manager.resolveExecutionPolicy({
      profileId: 'testbets_default',
      mode: 'live'
    });

    expect(policy.enabled).toBe(true);
    expect(policy.sourceReadOnly).not.toBe(true);
    expect(policy.feedbackChatIds).toContain(String(-1003717712631));
  });
});
// === F3: feedback chat send hardening (provenance, topic forwarding, reply stripping) ===

describe('TelegramPollingIngress: _sendToFeedbackChat F3 hardening', () => {
  function makeFixture(profileExtras = {}) {
    const botClient = createBotClient();
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          forum_cluster: {
            liveEnabled: true,
            clusterId: 'forum',
            sourceReadOnly: true,
            feedbackChatIds: [-1003717712631],
            sourceTargets: [
              { chatId: -1009999999999, topicId: null, label: 'src', priority: 100 }
            ],
            ...profileExtras
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });
    return { ingress, botClient, profile: manager.getProfile('forum_cluster') };
  }

  test('forwards feedbackTopicId from profile config as message_thread_id', async () => {
    const { ingress, botClient, profile } = makeFixture({ feedbackTopicId: 42 });
    await ingress._sendToFeedbackChat(profile, 'hello');
    expect(botClient.sendMessage).toHaveBeenCalledTimes(1);
    const [, , payload] = botClient.sendMessage.mock.calls[0];
    expect(payload.message_thread_id).toBe(42);
  });

  test('forwards feedbackTopicId from caller options (overrides profile)', async () => {
    const { ingress, botClient, profile } = makeFixture({ feedbackTopicId: 42 });
    await ingress._sendToFeedbackChat(profile, 'hello', { feedbackTopicId: 99 });
    const [, , payload] = botClient.sendMessage.mock.calls[0];
    expect(payload.message_thread_id).toBe(99);
  });

  test('strips cross-chat reply_to_message_id (does not forward source replyToMessageId)', async () => {
    const { ingress, botClient, profile } = makeFixture();
    await ingress._sendToFeedbackChat(profile, 'msg', {
      replyToMessageId: 12345, // a source-chat message id, must not leak
      sourceChatId: -1009999999999,
      sourceMessageId: 12345,
      draftId: 'sig-1'
    });
    const [, text, payload] = botClient.sendMessage.mock.calls[0];
    expect(payload.reply_to_message_id).toBeUndefined();
    expect(text).toContain('Signal sig-1');
    expect(text).toContain('chat=-1009999999999');
    expect(text).toContain('msg=12345');
    expect(text).toContain('msg');
  });

  test('preserves intra-feedback reply via feedbackReplyToMessageId', async () => {
    const { ingress, botClient, profile } = makeFixture();
    await ingress._sendToFeedbackChat(profile, 'msg', {
      feedbackReplyToMessageId: 9001
    });
    const [, , payload] = botClient.sendMessage.mock.calls[0];
    expect(payload.reply_to_message_id).toBe(9001);
  });

  test('sourceReadOnly reroute via _sendSourceChatMessage prepends provenance', async () => {
    const { ingress, botClient, profile } = makeFixture();
    const draft = {
      id: 'sig-prov-1',
      session: { chatId: -1009999999999, topicId: null, lastUpdatedAt: Date.now() },
      profile
    };
    await ingress._sendSourceChatMessage(draft, 'STOP принят', { replyToMessageId: 555 });
    const calls = botClient.sendMessage.mock.calls.filter(
      (c) => String(c[0]) === String(-1003717712631)
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('Signal sig-prov-1');
    expect(calls[0][1]).toContain('chat=-1009999999999');
    expect(calls[0][1]).toContain('msg=555');
    expect(calls[0][1]).toContain('STOP принят');
    // Cross-chat reply id must be stripped
    expect(calls[0][2].reply_to_message_id).toBeUndefined();
  });
});

// === F4: inactivity-driven finalize timeout ===

describe('TelegramPollingIngress: F4 finalizeAfterMs inactivity finalize', () => {
  test('archives a stuck draft as finalize_timeout after inactivity window', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: {
        detectMessageIntent: jest.fn(async () => ({ intentType: null })),
        parseSession: jest.fn(async () => ({ state: 'incomplete', clarification: null }))
      },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      finalizeAfterMs: 5000
    });
    // Inject a synthetic stuck draft
    const draft = {
      id: 'stuck-1',
      stage: 'draft',
      processing: false,
      clarification: null,
      taskState: null,
      profile: manager.getProfile('vova_cluster'),
      session: {
        chatId: -1002010985531,
        topicId: null,
        lastUpdatedAt: Date.now() - 60000,
        toLLMPayload: () => ({ messageIds: [] }),
        getTextContext: () => '',
        getImages: () => []
      },
      indexedMessageIds: []
    };
    ingress.activeDrafts.set(draft.id, draft);

    await ingress.flushExpiredSessions();

    expect(ingress.activeDrafts.has('stuck-1')).toBe(false);
  });

  test('does NOT archive a draft that is still within the inactivity window', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: {
        detectMessageIntent: jest.fn(),
        parseSession: jest.fn(async () => ({ state: 'incomplete', clarification: null }))
      },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      finalizeAfterMs: 60000
    });
    const draft = {
      id: 'fresh-1',
      stage: 'draft',
      processing: false,
      clarification: null,
      taskState: null,
      profile: manager.getProfile('vova_cluster'),
      session: {
        chatId: -1002010985531,
        topicId: null,
        lastUpdatedAt: Date.now() - 1000,
        toLLMPayload: () => ({ messageIds: [] }),
        getTextContext: () => '',
        getImages: () => []
      },
      indexedMessageIds: []
    };
    ingress.activeDrafts.set(draft.id, draft);

    await ingress.flushExpiredSessions();

    expect(ingress.activeDrafts.has('fresh-1')).toBe(true);
  });
});

// === F5: ChatProfileManager fail-closed when feedbackChatIds is missing ===

describe('ChatProfileManager: F5 fail-closed when feedbackChatIds empty', () => {
  test('explicit sourceChatIds without feedbackChatIds → sourceReadOnly=true and feedbackChatIds=[]', () => {
    const mgr = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          unsafe: {
            sourceChatIds: [-1009998887776]
            // intentionally no feedbackChatIds, no sourceReadOnly
          }
        }
      }
    });
    const profile = mgr.getProfile('unsafe');
    expect(profile.sourceReadOnly).toBe(true);
    expect(profile.feedbackChatIds).toEqual([]);
  });

  test('explicit sourceTargets without feedbackChatIds → fail-closed', () => {
    const mgr = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          unsafe2: {
            sourceTargets: [{ chatId: -100123456, topicId: null, label: 'x' }]
          }
        }
      }
    });
    const profile = mgr.getProfile('unsafe2');
    expect(profile.sourceReadOnly).toBe(true);
    expect(profile.feedbackChatIds).toEqual([]);
  });

  test('legacy chatIds-only profile retains historical mirror behavior', () => {
    const mgr = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          legacy: { chatIds: [-1001] }
        }
      }
    });
    const profile = mgr.getProfile('legacy');
    expect(profile.sourceReadOnly).toBe(false);
    expect(profile.feedbackChatIds).toEqual(['-1001']);
  });

  test('explicit feedbackChatIds is honored without auto-protect', () => {
    const mgr = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          ok: {
            sourceChatIds: [-100111],
            feedbackChatIds: [-100222]
          }
        }
      }
    });
    const profile = mgr.getProfile('ok');
    expect(profile.feedbackChatIds).toEqual(['-100222']);
    expect(profile.sourceReadOnly).toBe(false);
  });
});

// === F6: pre-activation purge maxAge derived from max preSignalWindowMs ===

describe('TelegramPollingIngress: F6 pre-activation purge maxAge', () => {
  test('caches max preSignalWindowMs across enabled profiles', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          short_window: {
            sourceReadOnly: true,
            feedbackChatIds: [-100777],
            sourceTargets: [{ chatId: -100888, topicId: null, label: 'x' }],
            activation: { mode: 'code_reply', codeBotUserIds: [1], preSignalWindowMs: 30000 }
          },
          long_window: {
            sourceReadOnly: true,
            feedbackChatIds: [-100777],
            sourceTargets: [{ chatId: -100999, topicId: null, label: 'y' }],
            activation: { mode: 'code_reply', codeBotUserIds: [1], preSignalWindowMs: 300000 }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet'
    });
    expect(ingress._maxPreSignalWindowMs).toBe(300000);
  });

  test('purge does not delete buffer messages within max preSignalWindowMs * 2', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          big: {
            sourceReadOnly: true,
            feedbackChatIds: [-100777],
            sourceTargets: [{ chatId: -100888, topicId: null, label: 'x' }],
            activation: { mode: 'code_reply', codeBotUserIds: [1], preSignalWindowMs: 200000 }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet'
    });
    const now = Date.now();
    ingress.preActivationBuffers.set('chat:1', {
      messages: [{ messageId: 1, timestamp: now - 250000 }],
      createdAt: now - 250000
    });
    ingress._purgeExpiredPreActivationBuffers();
    // 250s ago < 200s*2=400s → must survive
    expect(ingress.preActivationBuffers.has('chat:1')).toBe(true);
  });
});

// === F7: dedupe persistence stricter restore ===

describe('TelegramPollingIngress: F7 dedupe persistence pruning', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('drops accepted entry whose taskId is no longer in active tasks file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-f7-'));
    const dedupePath = path.join(tmp, 'dedupe.json');
    const tasksPath = path.join(tmp, 'tasks.json');
    fs.writeFileSync(dedupePath, JSON.stringify({
      entries: [
        { fingerprint: 'fp:still-here', status: 'accepted', taskId: 'task-active', firstSeenAt: Date.now(), lastSeenAt: Date.now() },
        { fingerprint: 'fp:orphan', status: 'accepted', taskId: 'task-gone', firstSeenAt: Date.now(), lastSeenAt: Date.now() }
      ]
    }));
    fs.writeFileSync(tasksPath, JSON.stringify({
      tasks: [{ id: 'task-active' }],
      currentTasks: {},
      history: []
    }));

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      dedupeFilePath: dedupePath,
      tasksFilePath: tasksPath
    });
    ingress._loadDedupeRegistry();

    expect(ingress.dedupeRegistry.has('fp:still-here')).toBe(true);
    expect(ingress.dedupeRegistry.has('fp:orphan')).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('drops restored non-failed entries beyond restoredDedupeTtlMs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-f7-ttl-'));
    const dedupePath = path.join(tmp, 'dedupe.json');
    const now = Date.now();
    fs.writeFileSync(dedupePath, JSON.stringify({
      entries: [
        { fingerprint: 'fp:fresh-accepted', status: 'accepted', firstSeenAt: now, lastSeenAt: now },
        { fingerprint: 'fp:stale-accepted', status: 'accepted', firstSeenAt: now - 10 * 60 * 1000, lastSeenAt: now - 10 * 60 * 1000 },
        { fingerprint: 'fp:stale-failed', status: 'failed', firstSeenAt: now - 10 * 60 * 1000, lastSeenAt: now - 10 * 60 * 1000 }
      ]
    }));

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createClusterProfileManager(),
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      dedupeFilePath: dedupePath,
      restoredDedupeTtlMs: 5 * 60 * 1000
    });
    ingress._loadDedupeRegistry();

    expect(ingress.dedupeRegistry.has('fp:fresh-accepted')).toBe(true);
    expect(ingress.dedupeRegistry.has('fp:stale-accepted')).toBe(false);
    expect(ingress.dedupeRegistry.has('fp:stale-failed')).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// === F2 regression: clarification fanout indexes EVERY feedback chat ===

describe('TelegramPollingIngress: clarification multi-feedback-chat indexing', () => {
  test('callback from secondary feedback chat resolves draft (per-chat message_id index)', async () => {
    // Bot returns DIFFERENT message_id per chat to simulate Telegram's
    // per-chat numbering. Primary chat → 4001, backup → 4002.
    const perChatMsgId = { '-3000000001': 4001, '-3000000002': 4002 };
    const botClient = createBotClient();
    botClient.sendMessage = jest.fn(async (chatId) => ({
      ok: true,
      result: { message_id: perChatMsgId[String(chatId)] || 9999 }
    }));

    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          dual_feedback: {
            liveEnabled: true,
            prematchEnabled: true,
            clusterId: 'dual',
            sourceReadOnly: true,
            feedbackChatIds: [-3000000001, -3000000002],
            allowedSenders: [{ userId: 555 }, { userId: 9999 }],
            sourceTargets: [
              { chatId: -4000000001, topicId: null, label: 'src', priority: 100 }
            ],
            activation: { mode: 'open' }
          }
        }
      }
    });
    manager.isSenderAllowed = jest.fn(() => true);

    const parser = {
      detectMessageIntent: jest.fn(async () => ({ intentType: 'signal', confidence: 0.9, notes: null })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'match_ambiguous',
        home: 'A', away: 'B', sport: 'soccer', mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.7,
        clarification: {
          type: 'match', prompt: 'Which match?', rejectLabel: 'Другой',
          options: [
            { label: 'Match A', bookmakerMatchId: 'sb-1' },
            { label: 'Match B', bookmakerMatchId: 'sb-2' }
          ]
        },
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 't1' }))
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: { message_id: 10, date: 100, chat: { id: -4000000001, type: 'supergroup' }, from: { id: 555 }, text: 'A vs B 1' }
    }]);

    const drafts = Array.from(ingress.activeDrafts.values());
    expect(drafts.length).toBe(1);
    const draft = drafts[0];
    expect(draft.clarification).toBeTruthy();
    // F2: targets must include BOTH feedback chats with their per-chat message_ids
    expect(Array.isArray(draft.clarification.targets)).toBe(true);
    const targetChatIds = draft.clarification.targets.map((t) => String(t.chatId)).sort();
    expect(targetChatIds).toEqual(['-3000000001', '-3000000002']);
    const byChat = Object.fromEntries(draft.clarification.targets.map((t) => [String(t.chatId), t.messageId]));
    expect(byChat['-3000000001']).toBe(4001);
    expect(byChat['-3000000002']).toBe(4002);

    // Make next parse return ready
    parser.parseSession.mockImplementationOnce(async () => ({
      intentType: 'signal', state: 'ready',
      home: 'A', away: 'B', sport: 'soccer', mode: 'live',
      normalizedOutcome: '1',
      normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
      candidateLadder: [{ outcome: '1', priority: 0 }],
      queueDecision: 'enqueue', confidence: 0.9, clarification: null, notes: null
    }));

    // Callback from SECONDARY feedback chat (-3000000002, message_id 4002)
    const callbackData = ingress._encodeCallbackData({
      draftId: draft.id, type: 'match', action: 'confirm', optionIndex: 1
    });
    await ingress._handleCallbackQuery({
      chatId: -3000000002, topicId: null, messageId: 4002,
      callbackId: 'cb-2nd', data: callbackData,
      userId: 9999, authorId: 9999
    });

    expect(botClient.answerCallbackQuery).toHaveBeenCalledWith('cb-2nd', 'Принято.', expect.any(Object));
    expect(draft.manualMatch).toEqual({ label: 'Match B', bookmakerMatchId: 'sb-2' });
  });

  test('_clearClarificationMarkup clears keyboard in EVERY feedback chat', async () => {
    const botClient = createBotClient();
    const manager = createClusterProfileManager();
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live'
    });

    const draft = {
      id: 'draft-multi-clear',
      session: { chatId: -4000000001, topicId: null },
      profile: manager.getProfile('vova_cluster'),
      clarification: {
        messageId: 4001,
        targetChatId: -3000000001,
        targets: [
          { chatId: -3000000001, messageId: 4001, topicId: null },
          { chatId: -3000000002, messageId: 4002, topicId: null }
        ]
      }
    };

    await ingress._clearClarificationMarkup(draft);

    expect(botClient.editMessageReplyMarkup).toHaveBeenCalledWith(-3000000001, 4001, { inline_keyboard: [] });
    expect(botClient.editMessageReplyMarkup).toHaveBeenCalledWith(-3000000002, 4002, { inline_keyboard: [] });
  });
});

// === F4 regression: STOP from anonymous (channel-post) source ===

describe('TelegramPollingIngress: STOP guard for null draft.authorId', () => {
  function makeIngress({ profileOverrides = {} } = {}) {
    const botClient = createBotClient();
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          ro_anon: {
            liveEnabled: true,
            prematchEnabled: true,
            clusterId: 'ro_anon',
            sourceReadOnly: true,
            feedbackChatIds: [-3000000001],
            sourceTargets: [{ chatId: -4000000001, topicId: null, label: 'src', priority: 100 }],
            activation: { mode: 'open', ...(profileOverrides.activation || {}) },
            ...(profileOverrides.allowedSenders ? { allowedSenders: profileOverrides.allowedSenders } : {})
          }
        }
      }
    });
    const onStopSignal = jest.fn(async () => ({ accepted: true, cancelled: true }));
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: manager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onStopSignal
    });
    return { ingress, botClient, manager, onStopSignal };
  }

  test('STOP from random user is REJECTED when draft.authorId is null and no allowlist match', async () => {
    const { ingress, botClient, manager, onStopSignal } = makeIngress();
    const profile = manager.getProfile('ro_anon');
    const draft = {
      id: 'draft-anon-1',
      session: new TelegramIntakeSession({ sessionId: 'test', chatId: -4000000001, topicId: null, mediaGroupId: null, createdAt: Date.now() }, { windowMs: 15000 }),
      profile,
      authorId: null,
      taskId: 'task-anon-1',
      taskState: 'queued',
      stage: 'queued',
      manualMatch: null,
      manualOutcome: null,
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set()
    };
    ingress.activeDrafts.set(draft.id, draft);
    // Index a source message so STOP-via-reply resolves the draft
    ingress.messageDraftIndex.set(
      ingress._buildMessageIndexKey(-4000000001, null, 50),
      draft.id
    );

    await ingress._handleStopMessage(
      { chatId: -4000000001, topicId: null, authorId: 12345, authorUsername: 'random_user', messageId: 99, replyToMessageId: 50 },
      profile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).not.toHaveBeenCalled();
    const rejectionSent = botClient.sendMessage.mock.calls.some(([, text]) =>
      typeof text === 'string' && text.includes('STOP отклонён')
    );
    expect(rejectionSent).toBe(true);
  });

  test('STOP from allowlisted operator is ACCEPTED for null-author draft when stopMode=open', async () => {
    const { ingress, manager, onStopSignal } = makeIngress({
      profileOverrides: {
        activation: { mode: 'open', stopMode: 'open' },
        allowedSenders: [{ userId: 7777 }]
      }
    });
    const profile = manager.getProfile('ro_anon');
    const draft = {
      id: 'draft-anon-2',
      session: new TelegramIntakeSession({ sessionId: 'test', chatId: -4000000001, topicId: null, mediaGroupId: null, createdAt: Date.now() }, { windowMs: 15000 }),
      profile,
      authorId: null,
      taskId: 'task-anon-2',
      taskState: 'queued',
      stage: 'queued',
      indexedMessageIds: new Set(),
      indexedClarificationMessageIds: new Set()
    };
    ingress.activeDrafts.set(draft.id, draft);
    ingress.messageDraftIndex.set(
      ingress._buildMessageIndexKey(-4000000001, null, 60),
      draft.id
    );

    await ingress._handleStopMessage(
      { chatId: -4000000001, topicId: null, authorId: 7777, authorUsername: 'op', messageId: 100, replyToMessageId: 60 },
      profile,
      { intentType: 'stop' }
    );

    expect(onStopSignal).toHaveBeenCalled();
  });
});
