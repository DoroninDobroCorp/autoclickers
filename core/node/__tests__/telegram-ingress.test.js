const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramPollingIngress } = require('../telegram/TelegramPollingIngress.js');

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn()
  };
}

function createBotClient() {
  return {
    getUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async (_chatId, _text, _options) => ({
      ok: true,
      result: { message_id: 9001 }
    })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true }))
  };
}

function createProfileManager() {
  return new ChatProfileManager({
    telegram: {
      enabled: true,
      profiles: {
        vip: {
          sourceChatIds: [-1001],
          feedbackChatIds: [-1002],
          allowedSenders: [
            { userId: 101, usernames: ['capper_one'] },
            { userId: 202, usernames: ['capper_two'] }
          ],
          liveEnabled: true
        }
      }
    }
  });
}

describe('TelegramPollingIngress', () => {
  test('should ignore messages sent by its own outbound bot', async () => {
    const botClient = createBotClient();
    botClient.getBotUserId = jest.fn(() => 8759397781);
    const parser = {
      detectMessageIntent: jest.fn(),
      parseSession: jest.fn()
    };
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger()
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 1185,
        date: 100,
        chat: { id: -1001, type: 'supergroup', title: 'Source' },
        from: { id: 8759397781, is_bot: true, username: 'betsofvovka_bot' },
        text: '🚀 SANSABET BETTOR запущен'
      }
    }]);

    expect(parser.detectMessageIntent).not.toHaveBeenCalled();
    expect(botClient.sendMessage).not.toHaveBeenCalled();
    expect(ingress.getStatus().metrics.message_received_total).toBe(1);
    expect(ingress.getStatus().metrics.message_buffered_pre_activation).toBe(0);
  });

  test('should ignore profile-muted self-improvement messages before code buffer', async () => {
    const botClient = createBotClient();
    const parser = {
      detectMessageIntent: jest.fn(),
      parseSession: jest.fn()
    };
    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          sandbox_cluster: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            ignoredTextPrefixes: ['!SHI '],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              codeRegex: '^[A-Za-z0-9]{10}$'
            }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger()
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 1285,
        date: 100,
        chat: { id: -1001, type: 'supergroup', title: 'Source' },
        from: { id: 8918115803, is_bot: true, username: 'smart_autobetting_vovka_bot' },
        text: '!SHI Self-improvement: analyzing telegram_metric_anomaly'
      }
    }]);

    expect(parser.detectMessageIntent).not.toHaveBeenCalled();
    expect(botClient.sendMessage).not.toHaveBeenCalled();
    expect(ingress.getActiveSessions()).toHaveLength(0);
    expect(ingress.getStatus().preActivationBufferCount).toBe(0);
    expect(ingress.getStatus().metrics.message_buffered_pre_activation).toBe(0);
  });

  test('should process first message immediately and update same draft on follow-up from same author', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.9,
        notes: null
      })),
      parseSession: jest.fn()
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'outcome_ambiguous',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: null,
          normalizedIntent: {
            family: 'totals',
            line: 3.5
          },
          candidateLadder: [],
          minOdds: null,
          explicitMinOdds: null,
          confidence: 0.7,
          queueDecision: 'hold',
          clarification: {
            type: 'outcome',
            prompt: 'Уточните исход',
            options: [],
            rejectLabel: 'not this outcome',
            waitForTextOnly: true
          },
          notes: null
        })
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'ready',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: 'T> 3.5',
          normalizedIntent: {
            family: 'totals',
            direction: 'over',
            line: 3.5,
            normalizedOutcome: 'T> 3.5'
          },
          candidateLadder: [
            { outcome: 'T> 3.5', priority: 0 },
            { outcome: 'T> 3', priority: 1 }
          ],
          minOdds: 1.85,
          explicitMinOdds: 1.85,
          confidence: 0.92,
          queueDecision: 'enqueue',
          clarification: null,
          notes: null
        })
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return {
          accepted: true,
          taskId: `tg_task_${resolvedSignals.length}`,
          updated: resolvedSignals.length > 1
        };
      })
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          caption: 'ТБ 3.5'
        }
      }
    ]);

    await ingress.processUpdates([
      {
        update_id: 2,
        message: {
          message_id: 11,
          date: 105,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'если ниже 1.85 не брать'
        }
      }
    ]);

    expect(parser.parseSession).toHaveBeenCalledTimes(2);
    expect(resolvedSignals).toHaveLength(1);
    expect(ingress.getActiveSessions()).toHaveLength(1);
    expect(resolvedSignals[0]).toMatchObject({
      home: 'Alpha',
      away: 'Beta',
      outcome: 'T> 3.5',
      profileId: 'vip',
      sourceProfileId: 'vip',
      originChatId: '-1001'
    });
    expect(resolvedSignals[0].messageIds).toEqual([10, 11]);
    expect(resolvedSignals[0].minOdds).toBe(1.85);
  });

  test('should create a new draft for a fresh standalone signal from the same author after queueing', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: session.getTextContext().includes('Signal B') ? 'Gamma' : 'Alpha',
        away: session.getTextContext().includes('Signal B') ? 'Delta' : 'Beta',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: {
          family: '1x2',
          selection: '1',
          normalizedOutcome: '1'
        },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.95,
        clarification: null,
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
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

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 30,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 31,
          date: 101,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal B'
        }
      }
    ]);

    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[0].signalId).not.toBe(resolvedSignals[1].signalId);
    expect(resolvedSignals[0].messageIds).toEqual([30]);
    expect(resolvedSignals[1].messageIds).toEqual([31]);
  });

  test('does not merge anonymous pre-activation messages from different sender chats', () => {
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
      signalParser: { parseSession: jest.fn() },
      logger: createLogger()
    });

    const windowMessages = [
      {
        messageId: 40,
        timestamp: 100000,
        authorId: null,
        senderChatId: -2001,
        metadata: { senderChatId: -2001 },
        text: 'Unrelated Team vs Other Team'
      },
      {
        messageId: 41,
        timestamp: 104000,
        authorId: null,
        senderChatId: -2002,
        metadata: { senderChatId: -2002 },
        text: 'Target Team vs Opponent'
      },
      {
        messageId: 42,
        timestamp: 107000,
        authorId: null,
        senderChatId: -2001,
        metadata: { senderChatId: -2001 },
        text: 'Unrelated follow-up'
      }
    ];

    const group = ingress._partitionSignalGroup(windowMessages, windowMessages[1]);

    expect(group.map((message) => message.messageId)).toEqual([41]);
  });

  test('should send clarification buttons and resolve draft from callback query', async () => {
    const botClient = createBotClient();
    botClient.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { message_id: 777 }
    });

    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn()
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'match_ambiguous',
          home: null,
          away: null,
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: null,
          normalizedIntent: { family: 'totals', direction: 'over', line: 2.5 },
          candidateLadder: [],
          queueDecision: 'hold',
          confidence: 0.7,
          clarification: {
            type: 'match',
            prompt: 'Уточните матч',
            options: [
              {
                label: 'Alpha vs Beta',
                matchIndex: 0,
                bookmakerMatchId: 'sb-1',
                home: 'Alpha',
                away: 'Beta'
              }
            ],
            rejectLabel: 'not this match',
            waitForTextOnly: false
          },
          notes: null
        })
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'ready',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          bookmakerMatchId: 'sb-1',
          normalizedOutcome: 'T> 2.5',
          normalizedIntent: {
            family: 'totals',
            direction: 'over',
            line: 2.5,
            normalizedOutcome: 'T> 2.5'
          },
          candidateLadder: [{ outcome: 'T> 2.5', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.94,
          clarification: null,
          notes: null
        })
    };

    const onResolvedSignal = jest.fn(async () => ({
      accepted: true,
      taskId: 'tg_task_1'
    }));

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Матч Alpha или Beta? ТБ 2.5'
        }
      }
    ]);

    const draft = ingress.getActiveSessions()[0];
    expect(draft.stage).toBe('match_ambiguous');
    expect(botClient.sendMessage).toHaveBeenCalledWith(
      -1001,
      expect.stringContaining('Уточните матч'),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array)
        })
      })
    );

    const callbackData = botClient.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data;

    await ingress.processUpdates([
      {
        update_id: 2,
        callback_query: {
          id: 'cb-1',
          data: callbackData,
          from: { id: 202, username: 'capper_two' },
          message: {
            message_id: 777,
            chat: { id: -1001, type: 'supergroup' }
          }
        }
      }
    ]);

    expect(botClient.answerCallbackQuery).toHaveBeenCalledWith('cb-1', 'Принято.', { show_alert: false });
    expect(botClient.editMessageReplyMarkup).toHaveBeenCalledWith(-1001, 777, { inline_keyboard: [] });
    expect(onResolvedSignal).toHaveBeenCalledTimes(1);
    expect(onResolvedSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        home: 'Alpha',
        away: 'Beta',
        bookmakerMatchId: 'sb-1',
        outcome: 'T> 2.5'
      }),
      expect.any(Object)
    );
  });

  test('should keep separate drafts for different authors without reply and allow reply-based cross-author updates', async () => {
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => {
        // F2: dedupe is now content-fingerprint based across all modes, so
        // two truly distinct signals from different authors must produce
        // different fingerprints. Differentiate by first-message text.
        const isB = session.messages.some((m) => /Signal B/i.test(m.text || ''));
        const isUpdate = session.messages.length > 1;
        const outcome = isUpdate ? 'X' : (isB ? '2' : '1');
        return {
        intentType: 'signal',
        state: 'ready',
        home: 'Alpha',
        away: 'Beta',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: outcome,
        normalizedIntent: {
          family: '1x2',
          selection: outcome,
          normalizedOutcome: outcome
        },
        candidateLadder: [{ outcome, priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.95,
        clarification: null,
        notes: null
        };
      })
    };

    const resolvedSignals = [];
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}`, updated: resolvedSignals.length > 2 };
      })
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 20,
          date: 101,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 202, username: 'capper_two' },
          text: 'Signal B'
        }
      },
      {
        update_id: 3,
        message: {
          message_id: 21,
          date: 102,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 202, username: 'capper_two' },
          reply_to_message: { message_id: 10, text: 'Signal A' },
          text: 'Update by reply'
        }
      }
    ]);

    expect(ingress.getActiveSessions()).toHaveLength(2);
    expect(resolvedSignals[0].signalId).not.toBe(resolvedSignals[1].signalId);
    expect(resolvedSignals[2].signalId).toBe(resolvedSignals[0].signalId);
  });

  test('should route STOP without reply to latest draft of the same author', async () => {
    const parser = {
      detectMessageIntent: jest.fn(async (message) => ({
        intentType: /^stop$/i.test(message.text || '') ? 'stop' : 'signal',
        confidence: 0.9,
        notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: `Home-${session.messages[0].authorId}`,
        away: `Away-${session.messages[0].authorId}`,
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: '1',
        normalizedIntent: {
          family: '1x2',
          selection: '1',
          normalizedOutcome: '1'
        },
        candidateLadder: [{ outcome: '1', priority: 0 }],
        queueDecision: 'enqueue',
        confidence: 0.95,
        clarification: null,
        notes: null
      }))
    };

    const stoppedSignals = [];
    const queuedSignals = [];
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        queuedSignals.push(task);
        return { accepted: true, taskId: `task-${queuedSignals.length}` };
      }),
      onStopSignal: jest.fn(async (payload) => {
        stoppedSignals.push(payload.signalId);
        return { accepted: true, cancelled: true };
      })
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 11,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 12,
          date: 101,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 202, username: 'capper_two' },
          text: 'Signal B'
        }
      },
      {
        update_id: 3,
        message: {
          message_id: 13,
          date: 102,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'STOP'
        }
      }
    ]);

    expect(queuedSignals).toHaveLength(2);
    expect(stoppedSignals).toEqual([queuedSignals[0].signalId]);
  });

  test('should ignore unmapped chats when fallback profile is disabled', async () => {
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.9,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        state: 'ready',
        queueDecision: 'enqueue'
      }))
    };
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: new ChatProfileManager({
        telegram: {
          enabled: true,
          profiles: {
            only_one: {
              sourceChatIds: [-3001],
              allowedSenders: [101]
            }
          }
        }
      }),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async () => ({ accepted: true }))
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 50,
          date: 100,
          chat: { id: -9999, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'ignored'
        }
      }
    ]);

    expect(parser.parseSession).not.toHaveBeenCalled();
    expect(ingress.getActiveSessions()).toEqual([]);
  });

  test('should archive clarification draft on timeout and send closure message', async () => {
    const botClient = createBotClient();
    botClient.sendMessage
      .mockResolvedValueOnce({ ok: true, result: { message_id: 501 } })
      .mockResolvedValueOnce({ ok: true, result: { message_id: 502 } });

    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'outcome_ambiguous',
        home: 'Alpha',
        away: 'Beta',
        sport: 'soccer',
        mode: 'live',
        normalizedOutcome: null,
        normalizedIntent: { family: '1x2' },
        candidateLadder: [],
        queueDecision: 'hold',
        confidence: 0.6,
        clarification: {
          type: 'outcome',
          prompt: 'Уточните исход',
          options: [
            { label: '1', outcome: '1', normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' } },
            { label: 'X', outcome: 'X', normalizedIntent: { family: '1x2', selection: 'X', normalizedOutcome: 'X' } }
          ],
          rejectLabel: 'not this outcome',
          waitForTextOnly: false
        },
        notes: null
      }))
    };

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      clarificationTimeoutMs: 10,
      onResolvedSignal: jest.fn(async () => ({ accepted: true, taskId: 'task-1' }))
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Нужен исход'
        }
      }
    ]);

    const activeBeforeTimeout = ingress.getActiveSessions();
    expect(activeBeforeTimeout).toHaveLength(1);

    await ingress.flushExpiredSessions(Date.now() + 50, false);

    expect(ingress.getActiveSessions()).toHaveLength(0);
    expect(botClient.sendMessage).toHaveBeenNthCalledWith(
      2,
      -1001,
      expect.stringContaining('время на уточнение истекло'),
      expect.objectContaining({ parse_mode: null })
    );
  });

  test('should archive terminal low-confidence reject without counting it as match not found', async () => {
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'rejected_low_confidence',
        home: null,
        away: null,
        sport: 'unknown',
        mode: 'live',
        normalizedOutcome: null,
        normalizedIntent: null,
        candidateLadder: [],
        queueDecision: 'rejected',
        confidence: 0.2,
        clarification: null,
        reason: 'single status word'
      }))
    };
    const onResolvedSignal = jest.fn();
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: createProfileManager(),
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 80,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        text: 'Prematch'
      }
    }]);

    const status = ingress.getStatus();
    expect(onResolvedSignal).not.toHaveBeenCalled();
    expect(status.activeSessions).toHaveLength(0);
    expect(status.metrics.signal_rejected_low_confidence_total).toBe(1);
    expect(status.metrics.signal_match_not_found_total).toBe(0);
    expect(status.recentSignals[0]).toMatchObject({
      queueDecision: 'rejected_low_confidence',
      accepted: false
    });
  });

  test('should not count ordinary ten-letter sport words as unknown-author activation codes', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Alpha',
        away: 'Beta',
        sport: 'basketball',
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
    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_cluster: {
            sourceReadOnly: true,
            sourceTargets: [{ chatId: -1001, topicId: null, label: 'code_cluster' }],
            feedbackChatIds: [-1002],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              codeRegex: '^[A-Za-z0-9]{10}$',
              preSignalWindowMs: 90000,
              postCodeFollowupWindowMs: 0
            }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-code-1' };
      })
    });

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 90,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        text: 'Basketball'
      }
    }]);

    expect(ingress.getStatus().metrics.code_dropped_unknown_author).toBe(0);

    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 91,
        date: 101,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 999, username: 'code_bot' },
        reply_to_message: { message_id: 90 },
        text: 'QmiRNUeZuB'
      }
    }]);

    const status = ingress.getStatus();
    expect(status.metrics.code_received_total).toBe(1);
    expect(status.metrics.code_accepted_total).toBe(1);
    expect(status.metrics.code_dropped_unknown_author).toBe(0);
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].activationCode).toBe('QmiRNUeZuB');
  });

  test('should skip Bot API source access audit in external update relay mode', async () => {
    const botClient = createBotClient();
    botClient.getBotUserId = jest.fn(() => 8759397781);
    botClient.getChat = jest.fn(async () => {
      throw new Error('Bad Request: chat not found');
    });
    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          production_cluster: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            feedbackChatIds: [-1002],
            sourceTargets: [
              { chatId: -1002009104562, topicId: null, label: 'supernova_root' }
            ],
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              codeRegex: '^[A-Za-z0-9]{10}$'
            }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: profileManager,
      signalParser: { detectMessageIntent: jest.fn(), parseSession: jest.fn() },
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      externalUpdatesOnly: true
    });

    await ingress._runSourceAccessAudit();

    const audit = ingress.getStatus().sourceAccessAudit;
    expect(botClient.getChat).not.toHaveBeenCalled();
    expect(audit.warningCount).toBe(0);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        chatId: String(-1002009104562),
        ok: true,
        skipped: true,
        skipReason: 'external_updates_only'
      })
    ]);
  });

  test('should reject clarification callback from unauthorized feedback-chat member (sourceReadOnly)', async () => {
    const botClient = createBotClient();
    botClient.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { message_id: 777 }
    });

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          readonly_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] }
            ],
            liveEnabled: true
          }
        }
      }
    });

    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn()
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'match_ambiguous',
          home: null,
          away: null,
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: null,
          normalizedIntent: { family: 'totals', direction: 'over', line: 2.5 },
          candidateLadder: [],
          queueDecision: 'hold',
          confidence: 0.7,
          clarification: {
            type: 'match',
            prompt: 'Уточните матч',
            options: [
              {
                label: 'Alpha vs Beta',
                matchIndex: 0,
                bookmakerMatchId: 'sb-1',
                home: 'Alpha',
                away: 'Beta'
              }
            ],
            rejectLabel: 'not this match',
            waitForTextOnly: false
          },
          notes: null
        })
        .mockResolvedValueOnce({
          intentType: 'signal',
          state: 'ready',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          bookmakerMatchId: 'sb-1',
          normalizedOutcome: 'T> 2.5',
          normalizedIntent: {
            family: 'totals',
            direction: 'over',
            line: 2.5,
            normalizedOutcome: 'T> 2.5'
          },
          candidateLadder: [{ outcome: 'T> 2.5', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.94,
          clarification: null,
          notes: null
        })
    };

    const onResolvedSignal = jest.fn(async () => ({
      accepted: true,
      taskId: 'tg_task_1'
    }));

    const ingress = new TelegramPollingIngress({
      botClient,
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal
    });

    // Signal from read-only source chat
    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Матч Alpha или Beta? ТБ 2.5'
        }
      }
    ]);

    const draft = ingress.getActiveSessions()[0];
    expect(draft.stage).toBe('match_ambiguous');

    const callbackData = botClient.sendMessage.mock.calls[0][2].reply_markup
      .inline_keyboard[0][0].callback_data;

    // Unauthorized user clicks clarification button from feedback chat
    await ingress.processUpdates([
      {
        update_id: 2,
        callback_query: {
          id: 'cb-unauth',
          data: callbackData,
          from: { id: 999, username: 'random_member' },
          message: {
            message_id: 777,
            chat: { id: -1002, type: 'supergroup' }
          }
        }
      }
    ]);

    expect(botClient.answerCallbackQuery).toHaveBeenCalledWith(
      'cb-unauth',
      'Нет доступа к этому уточнению.',
      { show_alert: true }
    );
    expect(onResolvedSignal).not.toHaveBeenCalled();

    // Authorized user clicks the same button from feedback chat
    await ingress.processUpdates([
      {
        update_id: 3,
        callback_query: {
          id: 'cb-auth',
          data: callbackData,
          from: { id: 101, username: 'capper_one' },
          message: {
            message_id: 777,
            chat: { id: -1002, type: 'supergroup' }
          }
        }
      }
    ]);

    expect(botClient.answerCallbackQuery).toHaveBeenCalledWith(
      'cb-auth',
      'Принято.',
      { show_alert: false }
    );
    expect(onResolvedSignal).toHaveBeenCalledTimes(1);
    expect(onResolvedSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        home: 'Alpha',
        away: 'Beta',
        bookmakerMatchId: 'sb-1',
        outcome: 'T> 2.5'
      }),
      expect.any(Object)
    );
  });

  test('forward burst grouping absorbs same-author 2 s gap (F2 review_7: forward mirrors backward 3 s)', async () => {
    // Regression for F2 (review_7): msg10 then msg20 from same author 2 s apart.
    // Code replies to msg10 — msg20 is part of the same burst and MUST be
    // absorbed into the same draft so signal text is not silently dropped
    // when the operator's burst spans 2 s (Telegram timestamps are second-
    // resolution). Independent later signals with a real authoring pause
    // (≥4 s) are still excluded by the 3 s threshold.
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: session.getTextContext().includes('Signal B') ? 'Gamma' : 'Alpha',
        away: session.getTextContext().includes('Signal B') ? 'Delta' : 'Beta',
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

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 0
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
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

    // Buffer two same-author messages 2 s apart — burst continuation
    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A part 1'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 20,
          date: 102,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A part 2'
        }
      }
    ]);

    // No drafts yet — code_reply mode buffers only
    expect(ingress.getActiveSessions()).toHaveLength(0);

    // Code bot replies to msg10 → forward walk absorbs msg20 (2 s gap < 3 s)
    await ingress.processUpdates([
      {
        update_id: 3,
        message: {
          message_id: 30,
          date: 104,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 999, username: 'code_bot' },
          reply_to_message: { message_id: 10 },
          text: 'AB12CD34EF'
        }
      }
    ]);

    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].messageIds.sort()).toEqual([10, 20]);
  });

  test('business-stop task failure does not restore already accepted source messages', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Balance Team A',
        away: 'Balance Team B',
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

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 0
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-balance-stop-1' };
      })
    });

    const bufferKey = ingress._buildPreActivationBufferKey(-1001, null, 'code_vip');

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        text: 'Balance Team A vs Balance Team B p1'
      }
    }]);
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(1);

    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 999, username: 'code_bot' },
        reply_to_message: { message_id: 10 },
        text: 'BALANCE123'
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    const signalId = resolvedSignals[0].signalId;
    expect(ingress.activeDrafts.has(signalId)).toBe(true);
    expect(ingress.preActivationBuffers.get(bufferKey)?.messages || []).toHaveLength(0);

    ingress.applyTaskLifecycle(signalId, {
      taskId: 'task-balance-stop-1',
      state: 'failed',
      step: 'insufficient_balance',
      error: 'Insufficient balance: 0.00 < 5.00 EUR (min stake)'
    });

    expect(ingress.activeDrafts.has(signalId)).toBe(false);
    expect(ingress.preActivationBuffers.get(bufferKey)?.messages || []).toHaveLength(0);
    expect(ingress.recentSignals[0]).toEqual(expect.objectContaining({
      queueDecision: 'business_stop',
      accepted: true,
      taskId: 'task-balance-stop-1'
    }));
  });

  test('design-stop task failure does not restore already accepted source messages', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Design Team A',
        away: 'Design Team B',
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

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 0
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Betfair',
      bookmakerId: 'betfair',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: 'task-design-stop-1' };
      })
    });

    const bufferKey = ingress._buildPreActivationBufferKey(-1001, null, 'code_vip');

    await ingress.processUpdates([{
      update_id: 1,
      message: {
        message_id: 10,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        text: 'Design Team A vs Design Team B p1'
      }
    }]);
    expect(ingress.preActivationBuffers.get(bufferKey).messages).toHaveLength(1);

    await ingress.processUpdates([{
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 999, username: 'code_bot' },
        reply_to_message: { message_id: 10 },
        text: 'DESIGN1234'
      }
    }]);

    expect(resolvedSignals).toHaveLength(1);
    const signalId = resolvedSignals[0].signalId;
    expect(ingress.activeDrafts.has(signalId)).toBe(true);
    expect(ingress.preActivationBuffers.get(bufferKey)?.messages || []).toHaveLength(0);

    ingress.applyTaskLifecycle(signalId, {
      taskId: 'task-design-stop-1',
      state: 'failed',
      step: 'bet_submit',
      failureStage: 'design_stop',
      error: 'Betfair real submit disabled'
    });

    expect(ingress.activeDrafts.has(signalId)).toBe(false);
    expect(ingress.preActivationBuffers.get(bufferKey)?.messages || []).toHaveLength(0);
    expect(ingress.recentSignals[0]).toEqual(expect.objectContaining({
      queueDecision: 'design_stop',
      accepted: true,
      taskId: 'task-design-stop-1'
    }));
  });

  test('forward burst grouping does NOT consume same-author signal beyond 5 s gap', async () => {
    // Independence regression: a real later signal with a clear authoring
    // pause (6 s) is still excluded from the prior burst.
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal', confidence: 0.95, notes: null
      })),
      parseSession: jest.fn(async (session) => {
        const isB = session.getTextContext().includes('Signal B');
        return ({
          intentType: 'signal', state: 'ready',
          home: isB ? 'Gamma' : 'Alpha', away: isB ? 'Delta' : 'Beta',
          sport: 'soccer', mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue', confidence: 0.95,
          clarification: null, notes: null
        });
      })
    };
    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001], feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: { mode: 'code_reply', codeBotUserIds: [999], postCodeFollowupWindowMs: 0 }
          }
        }
      }
    });
    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet', bookmakerId: 'sansabet', runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    await ingress.processUpdates([
      { update_id: 1, message: { message_id: 10, date: 100, chat: { id: -1001, type: 'supergroup' }, from: { id: 101, username: 'capper_one' }, text: 'Signal A' } },
      { update_id: 2, message: { message_id: 20, date: 106, chat: { id: -1001, type: 'supergroup' }, from: { id: 101, username: 'capper_one' }, text: 'Signal B' } }
    ]);
    expect(ingress.getActiveSessions()).toHaveLength(0);

    await ingress.processUpdates([
      { update_id: 3, message: { message_id: 30, date: 107, chat: { id: -1001, type: 'supergroup' }, from: { id: 999, username: 'code_bot' }, reply_to_message: { message_id: 10 }, text: 'AB12CD34EF' } }
    ]);
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].messageIds).toEqual([10]);

    await ingress.processUpdates([
      { update_id: 4, message: { message_id: 40, date: 109, chat: { id: -1001, type: 'supergroup' }, from: { id: 999, username: 'code_bot' }, reply_to_message: { message_id: 20 }, text: 'XY98ZW76QR' } }
    ]);
    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[1].messageIds).toEqual([20]);
    expect(resolvedSignals[0].signalId).not.toBe(resolvedSignals[1].signalId);
  });

  test('reply-linked follow-up must attach to the correct later awaiting draft, not the earlier one', async () => {
    // Regression: draft A and draft B both in awaiting_followup from same author.
    // A reply-linked follow-up targeting draft B's message must track on B.
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => ({
        intentType: 'signal',
        state: 'ready',
        home: 'Alpha',
        away: 'Beta',
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

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 5000
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
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

    // Buffer two signals from the same author (gap >15 s — beyond the
    // partner-burst threshold, so they MUST stay independent).
    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal A'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 20,
          date: 116,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal B'
        }
      }
    ]);

    // Code bot activates Signal A (with follow-up window)
    await ingress.processUpdates([
      {
        update_id: 3,
        message: {
          message_id: 30,
          date: 106,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 999, username: 'code_bot' },
          reply_to_message: { message_id: 10 },
          text: 'AB12CD34EF'
        }
      }
    ]);

    // Code bot activates Signal B (with follow-up window)
    await ingress.processUpdates([
      {
        update_id: 4,
        message: {
          message_id: 40,
          date: 107,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 999, username: 'code_bot' },
          reply_to_message: { message_id: 20 },
          text: 'XY98ZW76QR'
        }
      }
    ]);

    // Both drafts should now be in awaiting_followup
    const drafts = ingress.getActiveSessions();
    expect(drafts).toHaveLength(2);
    expect(drafts.every(d => d.stage === 'awaiting_followup')).toBe(true);

    // Reply-linked follow-up that replies to msg20 (draft B's message)
    await ingress.processUpdates([
      {
        update_id: 5,
        message: {
          message_id: 50,
          date: 108,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          reply_to_message: { message_id: 20 },
          text: 'коэф минимум 1.9'
        }
      }
    ]);

    // Access internal drafts to verify pending follow-up ownership
    const internalDrafts = Array.from(ingress.activeDrafts.values());
    const draftA = internalDrafts.find(d => d.session.messages.some(m => m.messageId === 10));
    const draftB = internalDrafts.find(d => d.session.messages.some(m => m.messageId === 20));
    expect(draftA).toBeDefined();
    expect(draftB).toBeDefined();
    expect(draftA.pendingFollowupCandidates || []).toHaveLength(0);
    expect(draftB.pendingFollowupCandidates.length).toBeGreaterThanOrEqual(1);
    expect(draftB.pendingFollowupCandidates[0].messageId).toBe(50);
  });

  test('code replies to each line still keep one same-author post-code burst', async () => {
    // Real relay regression: id-matches can reply with a code to every line
    // in a manual test burst. Once the first line is activated, later same-
    // author fragments must extend that active draft; their own code replies
    // are aliases, not separate one-line signals.
    const resolvedSignals = [];
    const textContexts = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => {
        textContexts.push(session.getTextContext());
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'Jordan (W)',
          away: 'Malaysia (W)',
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

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 50,
              replyTargetRetryMs: 1,
              replyTargetRetryAttempts: 1
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
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

    const sourceLine = (updateId, messageId, text) => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        text
      }
    });
    const codeReply = (updateId, messageId, replyToMessageId, text) => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 999, username: 'code_bot' },
        reply_to_message: { message_id: replyToMessageId },
        text
      }
    });

    await ingress.processUpdates([
      sourceLine(1, 10, 'Jordan (W)'),
      codeReply(2, 11, 10, 'FirstCod01'),
      sourceLine(3, 12, 'W1'),
      codeReply(4, 13, 12, 'SecondCd02'),
      sourceLine(5, 14, 'Football'),
      codeReply(6, 15, 14, 'ThirdCod03'),
      sourceLine(7, 16, 'Friendly International'),
      codeReply(8, 17, 16, 'FourthCd04'),
      sourceLine(9, 18, 'Live'),
      codeReply(10, 19, 18, 'FifthCod05')
    ]);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(parser.parseSession).toHaveBeenCalledTimes(1);
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].messageIds.sort((a, b) => a - b)).toEqual([10, 12, 14, 16, 18]);
    expect(textContexts[0]).toContain('Jordan (W)');
    expect(textContexts[0]).toContain('W1');
    expect(textContexts[0]).toContain('Football');
    expect(textContexts[0]).toContain('Friendly International');
    expect(textContexts[0]).toContain('Live');
    const status = ingress.getStatus();
    expect(status.metrics.code_accepted_total).toBe(1);
    expect(status.metrics.code_dropped_orphan_reply).toBe(0);
    expect(status.metrics.signal_enqueued_total).toBe(1);
  });

  test('topic-root reply_to messages still form one full text-only signal burst', async () => {
    // Real production relay regression: forum/topic exports may set
    // reply_to_message_id to the root topic anchor on every source message.
    // That root id is not a signal reply and must not prevent a same-author
    // post-code continuation such as country/league from joining the draft.
    const resolvedSignals = [];
    const textContexts = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async (session) => {
        textContexts.push(session.getTextContext());
        return {
          intentType: 'signal',
          state: 'ready',
          home: 'Hamza B.A.',
          away: 'Runi Lazaar',
          sport: 'volleyball',
          mode: 'live',
          normalizedOutcome: 'H2(-4.5) set2',
          normalizedIntent: { family: 'handicap', selection: 'away', line: -4.5, period: 'set2', normalizedOutcome: 'H2(-4.5) set2' },
          candidateLadder: [{ outcome: 'H2(-4.5) set2', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.95,
          clarification: null,
          notes: null
        };
      })
    };

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 50,
              replyTargetRetryMs: 1,
              replyTargetRetryAttempts: 1
            }
          }
        }
      }
    });

    const ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
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

    const rootReply = { message_id: 4, text: 'Topic root' };
    const sourceLine = (updateId, messageId, text) => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 100,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 101, username: 'capper_one' },
        reply_to_message: rootReply,
        text
      }
    });

    await ingress.processUpdates([
      sourceLine(1, 10, 'Hamza B.A. / Runi Lazaar'),
      sourceLine(2, 11, '-4.5 second team second set'),
      sourceLine(3, 12, '-11.5'),
      sourceLine(4, 13, 'Beach volleyball'),
      sourceLine(5, 14, 'Live'),
      {
        update_id: 6,
        message: {
          message_id: 15,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 999, username: 'code_bot' },
          reply_to_message: { message_id: 14 },
          text: 'RootCode01'
        }
      },
      sourceLine(7, 16, 'Bulgaria')
    ]);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(parser.parseSession).toHaveBeenCalledTimes(1);
    expect(resolvedSignals).toHaveLength(1);
    expect(resolvedSignals[0].messageIds.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 16]);
    expect(textContexts[0]).toContain('Hamza B.A. / Runi Lazaar');
    expect(textContexts[0]).toContain('-4.5 second team second set');
    expect(textContexts[0]).toContain('-11.5');
    expect(textContexts[0]).toContain('Beach volleyball');
    expect(textContexts[0]).toContain('Live');
    expect(textContexts[0]).toContain('Bulgaria');
  });

  test('multi-signal parser result enqueues independent child tasks', async () => {
    const resolvedSignals = [];
    const parser = {
      detectMessageIntent: jest.fn(async () => ({
        intentType: 'signal',
        confidence: 0.95,
        notes: null
      })),
      parseSession: jest.fn(async () => ({
        intentType: 'signal',
        state: 'multi_signal',
        confidence: 0.93,
        queueDecision: 'multi_enqueue',
        signals: [
          {
            intentType: 'signal',
            state: 'ready',
            home: 'Alpha FC',
            away: 'Beta FC',
            sport: 'soccer',
            mode: 'live',
            normalizedOutcome: '1',
            normalizedIntent: { family: '1x2', selection: '1', normalizedOutcome: '1' },
            candidateLadder: [{ outcome: '1', priority: 0 }],
            queueDecision: 'enqueue',
            confidence: 0.94,
            bookmakerMatchId: 'm-soccer-1',
            clarification: null,
            notes: null
          },
          {
            intentType: 'signal',
            state: 'ready',
            home: 'Gamma BC',
            away: 'Delta BC',
            sport: 'basketball',
            mode: 'live',
            normalizedOutcome: 'T> 135',
            normalizedIntent: { family: 'totals', direction: 'over', line: 135, normalizedOutcome: 'T> 135' },
            candidateLadder: [{ outcome: 'T> 135', priority: 0 }],
            queueDecision: 'enqueue',
            confidence: 0.93,
            bookmakerMatchId: 'm-basket-1',
            clarification: null,
            notes: null
          }
        ]
      }))
    };

    const profileManager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          code_vip: {
            sourceChatIds: [-1001],
            feedbackChatIds: [-1002],
            sourceReadOnly: true,
            allowedSenders: [
              { userId: 101, usernames: ['capper_one'] },
              { userId: 999, usernames: ['code_bot'] }
            ],
            liveEnabled: true,
            activation: {
              mode: 'code_reply',
              codeBotUserIds: [999],
              postCodeFollowupWindowMs: 0
            }
          }
        }
      }
    });

    let ingress;
    ingress = new TelegramPollingIngress({
      botClient: createBotClient(),
      chatProfileManager: profileManager,
      signalParser: parser,
      logger: createLogger(),
      bookmakerName: 'Sansabet',
      bookmakerId: 'sansabet',
      runtimeMode: 'live',
      onResolvedSignal: jest.fn(async (task) => {
        resolvedSignals.push(task);
        ingress.applyTaskLifecycle(task.signalId, {
          taskId: `task-${resolvedSignals.length}`,
          state: 'queued'
        });
        return { accepted: true, taskId: `task-${resolvedSignals.length}` };
      })
    });

    await ingress.processUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 100,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Alpha FC / Beta FC\nW1\n\nGamma BC / Delta BC\nтб135'
        }
      },
      {
        update_id: 2,
        message: {
          message_id: 11,
          date: 101,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 999, username: 'code_bot' },
          reply_to_message: { message_id: 10 },
          text: 'MultiCd001'
        }
      }
    ]);

    expect(parser.parseSession).toHaveBeenCalledTimes(1);
    expect(resolvedSignals).toHaveLength(2);
    expect(resolvedSignals[0]).toMatchObject({
      home: 'Alpha FC',
      away: 'Beta FC',
      outcome: '1',
      signalId: expect.stringMatching(/#1$/),
      parentSignalId: expect.any(String)
    });
    expect(resolvedSignals[1]).toMatchObject({
      home: 'Gamma BC',
      away: 'Delta BC',
      outcome: 'T> 135',
      signalId: expect.stringMatching(/#2$/),
      parentSignalId: resolvedSignals[0].parentSignalId
    });
    expect(resolvedSignals[0].signalId).not.toBe(resolvedSignals[1].signalId);
    expect(ingress.getStatus().metrics.signal_enqueued_total).toBe(2);
  });

  // F1 (review_14) regression: anonymous STOP targeting non-anonymous draft
  describe('anonymous STOP auth bypass (F1 review_14)', () => {
    function buildAnonymousStopIngress({ allowedSenders = [] } = {}) {
      const botClient = createBotClient();
      const profileManager = new ChatProfileManager({
        telegram: {
          enabled: true,
          profiles: {
            chan: {
              sourceChatIds: [-1001],
              feedbackChatIds: [],
              allowedSenders,
              liveEnabled: true
            }
          }
        }
      });

      const parser = {
        detectMessageIntent: jest.fn(async (message) => ({
          intentType: /^stop$/i.test(message.text || '') ? 'stop' : 'signal',
          confidence: 0.95,
          notes: null
        })),
        parseSession: jest.fn(async () => ({
          intentType: 'signal',
          state: 'ready',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: {
            family: '1x2',
            selection: '1',
            normalizedOutcome: '1'
          },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.95,
          clarification: null,
          notes: null
        }))
      };

      const queuedSignals = [];
      const stoppedSignals = [];
      const ingress = new TelegramPollingIngress({
        botClient,
        chatProfileManager: profileManager,
        signalParser: parser,
        logger: createLogger(),
        bookmakerName: 'TestBet',
        bookmakerId: 'testbet',
        runtimeMode: 'live',
        onResolvedSignal: jest.fn(async (task) => {
          queuedSignals.push(task);
          return { accepted: true, taskId: `task-${queuedSignals.length}` };
        }),
        onStopSignal: jest.fn(async (payload) => {
          stoppedSignals.push(payload.signalId);
          return { accepted: true, cancelled: true };
        })
      });

      return { ingress, botClient, queuedSignals, stoppedSignals };
    }

    test('anonymous STOP targeting non-anonymous draft WITHOUT allowlist → rejected', async () => {
      const { ingress, botClient, queuedSignals, stoppedSignals } = buildAnonymousStopIngress({
        allowedSenders: []
      });

      // Known-author signal
      await ingress.processUpdates([{
        update_id: 1,
        message: {
          message_id: 100,
          date: 200,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal from real user'
        }
      }]);
      expect(queuedSignals).toHaveLength(1);

      // Anonymous STOP (channel_post, no from field → authorId is null)
      await ingress.processUpdates([{
        update_id: 2,
        channel_post: {
          message_id: 101,
          date: 201,
          chat: { id: -1001, type: 'channel' },
          text: 'STOP'
        }
      }]);

      // Draft must NOT be stopped
      expect(stoppedSignals).toHaveLength(0);
      // Bot should have sent rejection message
      const sendCalls = botClient.sendMessage.mock.calls;
      const rejectionCall = sendCalls.find(c =>
        typeof c[1] === 'string' && c[1].includes('анонимный запрос')
      );
      expect(rejectionCall).toBeDefined();
    });

    test('anonymous STOP targeting non-anonymous draft WITH allowlist pass → allowed', async () => {
      // Use a mock chatProfileManager where isSenderAllowed returns true
      // to simulate an anonymous requester whose metadata matches allowlist.
      const botClient = createBotClient();
      const mockProfile = {
          id: 'chan',
          hasSenderAllowlist: true,
          enabled: true,
          liveEnabled: true,
          sourceReadOnly: false,
          sourceChatIds: [-1001],
          feedbackChatIds: []
        };
      const mockProfileManager = {
        resolveProfileForChat: jest.fn(() => mockProfile),
        resolveIngressProfile: jest.fn(() => mockProfile),
        isSenderAllowed: jest.fn(() => true),
        getProfile: jest.fn(() => mockProfile),
        isSourceTarget: jest.fn(() => true),
        getEnabledProfiles: jest.fn(() => [mockProfile]),
        resolveExecutionPolicy: jest.fn(() => ({ enabled: true }))
      };

      const parser = {
        detectMessageIntent: jest.fn(async (message) => ({
          intentType: /^stop$/i.test(message.text || '') ? 'stop' : 'signal',
          confidence: 0.95,
          notes: null
        })),
        parseSession: jest.fn(async () => ({
          intentType: 'signal',
          state: 'ready',
          home: 'Alpha',
          away: 'Beta',
          sport: 'soccer',
          mode: 'live',
          normalizedOutcome: '1',
          normalizedIntent: {
            family: '1x2',
            selection: '1',
            normalizedOutcome: '1'
          },
          candidateLadder: [{ outcome: '1', priority: 0 }],
          queueDecision: 'enqueue',
          confidence: 0.95,
          clarification: null,
          notes: null
        }))
      };

      const queuedSignals = [];
      const stoppedSignals = [];
      const ingress = new TelegramPollingIngress({
        botClient,
        chatProfileManager: mockProfileManager,
        signalParser: parser,
        logger: createLogger(),
        bookmakerName: 'TestBet',
        bookmakerId: 'testbet',
        runtimeMode: 'live',
        onResolvedSignal: jest.fn(async (task) => {
          queuedSignals.push(task);
          return { accepted: true, taskId: `task-${queuedSignals.length}` };
        }),
        onStopSignal: jest.fn(async (payload) => {
          stoppedSignals.push(payload.signalId);
          return { accepted: true, cancelled: true };
        })
      });

      // Known-author signal
      await ingress.processUpdates([{
        update_id: 1,
        message: {
          message_id: 100,
          date: 200,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 303, username: 'operator_x' },
          text: 'Signal from operator'
        }
      }]);
      expect(queuedSignals).toHaveLength(1);

      // Anonymous STOP — isSenderAllowed mocked to true (allowlist pass)
      await ingress.processUpdates([{
        update_id: 2,
        channel_post: {
          message_id: 101,
          date: 201,
          chat: { id: -1001, type: 'channel' },
          text: 'STOP'
        }
      }]);

      // With allowlist pass, draft should be stopped
      expect(stoppedSignals).toHaveLength(1);
      expect(stoppedSignals[0]).toBe(queuedSignals[0].signalId);
    });

    test('existing STOP auth: same-author STOP still works', async () => {
      const { ingress, queuedSignals, stoppedSignals } = buildAnonymousStopIngress({
        allowedSenders: [{ userId: 101, usernames: ['capper_one'] }]
      });

      // Known-author signal
      await ingress.processUpdates([{
        update_id: 1,
        message: {
          message_id: 100,
          date: 200,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'Signal from user'
        }
      }]);
      expect(queuedSignals).toHaveLength(1);

      // Same author sends STOP
      await ingress.processUpdates([{
        update_id: 2,
        message: {
          message_id: 101,
          date: 201,
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 101, username: 'capper_one' },
          text: 'STOP'
        }
      }]);

      // Should be stopped normally (same author)
      expect(stoppedSignals).toHaveLength(1);
      expect(stoppedSignals[0]).toBe(queuedSignals[0].signalId);
    });
  });
});
