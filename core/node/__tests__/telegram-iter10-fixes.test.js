/**
 * Regression tests for tg_review iteration 10 findings.
 *
 * F1 — getKnownSourceChatIds over-collects for legacy chatIds-only profiles.
 *      A legacy profile shaped { chatIds: [CHAT_A] } (no explicit sourceChatIds
 *      or sourceReadOnly) should NOT have CHAT_A added to the write-protected
 *      set — otherwise notifications for that profile are silently blocked.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const { ChatProfileManager } = require('../telegram/ChatProfileManager.js');
const { TelegramNotifier } = require('../integrations/telegram-notifier.js');

const LEGACY_BIDIRECTIONAL_CHAT = -1009999999999;
const READONLY_SOURCE_CHAT = -1002010985531;
const FEEDBACK_CHAT = 7268849307;

function createLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

describe('F1 (review_10) — getKnownSourceChatIds only collects sourceReadOnly profiles', () => {
  test('legacy chatIds-only profile does NOT appear in the write-protected set', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          legacy_bidirectional: {
            liveEnabled: true,
            prematchEnabled: true,
            chatIds: [LEGACY_BIDIRECTIONAL_CHAT],
            allowedSenders: [{ userId: FEEDBACK_CHAT }]
          }
        }
      }
    });

    // The profile derives sourceChatIds from chatIds internally…
    const profile = manager.getProfile('legacy_bidirectional');
    expect(profile.sourceChatIds.map(String)).toContain(String(LEGACY_BIDIRECTIONAL_CHAT));
    expect(profile.feedbackChatIds.map(String)).toContain(String(LEGACY_BIDIRECTIONAL_CHAT));

    // …but getKnownSourceChatIds must NOT include it (sourceReadOnly is false)
    const known = manager.getKnownSourceChatIds();
    expect(known.has(String(LEGACY_BIDIRECTIONAL_CHAT))).toBe(false);
  });

  test('sourceReadOnly profile IS collected in the write-protected set', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          readonly_source: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [READONLY_SOURCE_CHAT],
            feedbackChatIds: [FEEDBACK_CHAT]
          }
        }
      }
    });
    const known = manager.getKnownSourceChatIds();
    expect(known.has(String(READONLY_SOURCE_CHAT))).toBe(true);
    expect(known.has(String(FEEDBACK_CHAT))).toBe(false);
  });

  test('mixed profiles: only sourceReadOnly contributes to protected set', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          legacy_bidirectional: {
            liveEnabled: true,
            prematchEnabled: true,
            chatIds: [LEGACY_BIDIRECTIONAL_CHAT],
            allowedSenders: [{ userId: FEEDBACK_CHAT }]
          },
          readonly_source: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [READONLY_SOURCE_CHAT],
            feedbackChatIds: [FEEDBACK_CHAT]
          }
        }
      }
    });
    const known = manager.getKnownSourceChatIds();
    expect(known.has(String(READONLY_SOURCE_CHAT))).toBe(true);
    expect(known.has(String(LEGACY_BIDIRECTIONAL_CHAT))).toBe(false);
    expect(known.has(String(FEEDBACK_CHAT))).toBe(false);
  });

  test('notifications reach legacy chatIds-only profile (not write-blocked)', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          legacy_bidirectional: {
            liveEnabled: true,
            prematchEnabled: true,
            chatIds: [LEGACY_BIDIRECTIONAL_CHAT],
            allowedSenders: [{ userId: FEEDBACK_CHAT }]
          }
        }
      }
    });

    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000000000001'
    });
    notifier.setChatProfileManager(manager);

    const dest = notifier._collectTargetChatIds({
      chatIds: [LEGACY_BIDIRECTIONAL_CHAT]
    });
    // Legacy bidirectional chat must NOT be filtered out
    expect(dest).toContain(String(LEGACY_BIDIRECTIONAL_CHAT));
  });

  test('notifications to sourceReadOnly chat are still blocked', () => {
    const manager = new ChatProfileManager({
      telegram: {
        enabled: true,
        profiles: {
          readonly_source: {
            liveEnabled: true,
            prematchEnabled: true,
            sourceReadOnly: true,
            sourceChatIds: [READONLY_SOURCE_CHAT],
            feedbackChatIds: [FEEDBACK_CHAT]
          }
        }
      }
    });

    const notifier = new TelegramNotifier({
      botToken: 'test-token',
      logsChatId: '-1000000000001'
    });
    notifier.setChatProfileManager(manager);

    const dest = notifier._collectTargetChatIds({
      chatIds: [READONLY_SOURCE_CHAT, FEEDBACK_CHAT]
    });
    expect(dest).not.toContain(String(READONLY_SOURCE_CHAT));
    expect(dest).toContain(String(FEEDBACK_CHAT));
  });
});
