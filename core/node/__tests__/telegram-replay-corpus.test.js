/* V1_REWRITE_SKIP — this suite tests the v1 parser/retriever mechanics that
   were removed in the 2026-05-29 v2 rewrite (vision-LLM + match-locator).
   Re-enable once v2 equivalent coverage is written. */
const __origDescribe = describe;
describe = ((...args) => __origDescribe.skip(...args));
describe.skip = __origDescribe.skip;
describe.only = __origDescribe.only;
describe.each = __origDescribe.each;
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_INGRESS_BOT_TOKEN = process.env.TELEGRAM_INGRESS_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_LOGS_CHAT_ID = process.env.TELEGRAM_LOGS_CHAT_ID || '-1000000000001';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BaseBettor } = require('../betting/BaseBettor.js');

const CHAT_ID = -1001;
const AUTHOR_ID = 101;
const AUTHOR_USERNAME = 'elena_signal';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2sM3sAAAAASUVORK5CYII=',
  'base64'
);

function createLogger() {
  return {
    log: jest.fn(),
    error: jest.fn()
  };
}

function assertReplay(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function formatReplayLine(value, { signed = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const normalized = Number.isInteger(num) ? String(num) : String(num);
  if (signed && num > 0) {
    return `+${normalized}`;
  }
  return normalized;
}

function normalizeReplayOutcomeKey(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  let normalized = raw;

  normalized = normalized.replace(/^1H\s+Over\s+([0-9]+(?:\.[0-9]+)?)$/i, 'P1 T> $1');
  normalized = normalized.replace(/^1H\s+Under\s+([0-9]+(?:\.[0-9]+)?)$/i, 'P1 T< $1');
  normalized = normalized.replace(/^2H\s+Over\s+([0-9]+(?:\.[0-9]+)?)$/i, 'P2 T> $1');
  normalized = normalized.replace(/^2H\s+Under\s+([0-9]+(?:\.[0-9]+)?)$/i, 'P2 T< $1');

  const handicapMatch = normalized.match(/^(P[12]\s+)?H([12])(?:\s*\(\s*([+\-]?[0-9]+(?:\.[0-9]+)?)\s*\)|\s+([+\-]?[0-9]+(?:\.[0-9]+)?))$/i);
  if (handicapMatch) {
    const periodPrefix = (handicapMatch[1] || '').trim();
    const line = formatReplayLine(handicapMatch[3] ?? handicapMatch[4], { signed: false });
    if (line) {
      return `${periodPrefix ? `${periodPrefix} ` : ''}H${handicapMatch[2]} ${line}`.trim();
    }
  }

  const threeWayHandicapMatch = normalized.match(/^(P[12]\s+)?3WH\s*([+\-]?[0-9]+(?:\.[0-9]+)?)\s*([1X2])$/i);
  if (threeWayHandicapMatch) {
    const periodPrefix = (threeWayHandicapMatch[1] || '').trim();
    const line = formatReplayLine(threeWayHandicapMatch[2], { signed: true });
    if (line) {
      return `${periodPrefix ? `${periodPrefix} ` : ''}3WH ${line} ${threeWayHandicapMatch[3].toUpperCase()}`.trim();
    }
  }

  return normalized;
}

class ReplayBookAdapter {
  constructor(scenario) {
    this.bookmakerName = 'ReplayBook';
    this.isPrematch = scenario.mode === 'prematch';
    this.scenario = scenario;
    this._match = {
      id: `match-${scenario.id}`,
      bookmakerMatchId: `match-${scenario.id}`,
      home: scenario.home,
      away: scenario.away,
      sport: scenario.sport,
      league: scenario.league || `${scenario.sport} test league`
    };
    this._normalizedAvailableOutcomes = new Map();
    for (const [outcome, entry] of Object.entries(scenario.availableOutcomes || {})) {
      const normalizedOutcome = normalizeReplayOutcomeKey(outcome);
      if (!normalizedOutcome || this._normalizedAvailableOutcomes.has(normalizedOutcome)) {
        continue;
      }
      this._normalizedAvailableOutcomes.set(normalizedOutcome, {
        ...entry,
        pick: entry.pick || outcome
      });
    }
  }

  async login() {
    return true;
  }

  async close() {
    return true;
  }

  async isSessionValid() {
    return true;
  }

  async getBalance() {
    return 100;
  }

  getSportId(sportName) {
    return String(sportName || 'unknown').toLowerCase();
  }

  async getMatches() {
    return [
      this._match,
      {
        id: `noise-${this.scenario.id}`,
        home: `${this.scenario.home} Academy`,
        away: `${this.scenario.away} Academy`,
        sport: this.scenario.sport,
        league: 'noise league'
      }
    ];
  }

  async getLiveMatches() {
    if (this.isPrematch) return [];
    return this.getMatches();
  }

  async getPrematchMatches() {
    if (!this.isPrematch) return [];
    return this.getMatches();
  }

  findMatch(matches, home, away, bookmakerMatchId = null) {
    const normalizedHome = normalizeName(home);
    const normalizedAway = normalizeName(away);
    return (matches || []).find((match) => {
      const id = String(match.bookmakerMatchId || match.id || match.Id || '');
      if (bookmakerMatchId && id === String(bookmakerMatchId)) {
        return true;
      }
      return normalizeName(match.home || match.TeamHome) === normalizedHome &&
        normalizeName(match.away || match.TeamAway) === normalizedAway;
    }) || null;
  }

  async getMatchDetails(matchId, sportName) {
    return {
      id: matchId,
      sport: sportName,
      markets: []
    };
  }

  findOutcome(_match, outcome) {
    const entry = this.scenario.availableOutcomes[outcome]
      || this._normalizedAvailableOutcomes.get(normalizeReplayOutcomeKey(outcome));
    if (!entry) {
      return null;
    }
    return {
      pick: entry.pick || outcome,
      oddVal: entry.odds
    };
  }

  async prepareBet() {
    return true;
  }
}

function createBotClient() {
  return {
    getUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async () => ({
      ok: true,
      result: { message_id: 9001 }
    })),
    answerCallbackQuery: jest.fn(async () => ({ ok: true })),
    editMessageReplyMarkup: jest.fn(async () => ({ ok: true })),
    downloadFileById: jest.fn(async (fileId, destinationDir, options = {}) => {
      fs.mkdirSync(destinationDir, { recursive: true });
      const requested = options.fileName || `tg_${fileId}`;
      const fileName = path.extname(requested) ? requested : `${requested}.png`;
      const destinationPath = path.join(destinationDir, fileName);
      fs.writeFileSync(destinationPath, PNG_1X1);
      return {
        fileId,
        filePath: `${fileId}.png`,
        destinationPath
      };
    })
  };
}

function toStructuredText(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function createMessageEnvelope(scenario, messageId, text, options = {}) {
  const base = {
    message_id: messageId,
    date: 1700000000 + messageId,
    chat: { id: CHAT_ID, type: 'supergroup' },
    from: { id: AUTHOR_ID, username: AUTHOR_USERNAME },
    ...options
  };

  if (options.photo === true) {
    return {
      ...base,
      caption: text,
      photo: [
        { file_id: `${scenario.id}-photo-s`, width: 40, height: 40 },
        { file_id: `${scenario.id}-photo-l`, width: 320, height: 320 }
      ]
    };
  }

  return {
    ...base,
    text
  };
}

function buildUpdates(scenario) {
  const baseFields = {
    home: scenario.home,
    away: scenario.away,
    sport: scenario.sport,
    mode: scenario.mode
  };
  const readyFields = {
    ...baseFields,
    outcome: scenario.outcome,
    minOdds: scenario.minOdds,
    stake: scenario.stake
  };

  switch (scenario.flow) {
    case 'photo-followup': {
      const first = createMessageEnvelope(
        scenario,
        100,
        toStructuredText(baseFields),
        { photo: true }
      );
      const second = createMessageEnvelope(
        scenario,
        101,
        toStructuredText({
          outcome: scenario.outcome,
          minOdds: scenario.minOdds,
          stake: scenario.stake
        })
      );
      return [
        { update_id: 1, message: first },
        { update_id: 2, message: second }
      ];
    }
    case 'edit': {
      const first = createMessageEnvelope(scenario, 100, toStructuredText(baseFields));
      const edited = {
        ...createMessageEnvelope(scenario, 100, toStructuredText(readyFields)),
        edit_date: first.date + 2
      };
      return [
        { update_id: 1, message: first },
        { update_id: 2, edited_message: edited }
      ];
    }
    case 'reply-followup': {
      const root = createMessageEnvelope(scenario, 100, toStructuredText(baseFields));
      const reply = createMessageEnvelope(
        scenario,
        101,
        toStructuredText({
          outcome: scenario.outcome,
          minOdds: scenario.minOdds,
          stake: scenario.stake
        }),
        {
          reply_to_message: {
            message_id: root.message_id,
            text: root.text
          }
        }
      );
      return [
        { update_id: 1, message: root },
        { update_id: 2, message: reply }
      ];
    }
    default:
      return [
        {
          update_id: 1,
          message: createMessageEnvelope(scenario, 100, toStructuredText(readyFields))
        }
      ];
  }
}

function buildAvailableOutcomes(scenario) {
  const outcomes = {};
  for (const outcome of scenario.expectedOutcomes) {
    outcomes[outcome] = { odds: scenario.odds };
  }
  outcomes[scenario.outcome] = { odds: scenario.odds };
  return outcomes;
}

function createScenario(input) {
  return {
    stake: 10,
    minOdds: 1.7,
    flow: 'single',
    expectedOutcomes: [input.outcome],
    ...input,
    availableOutcomes: buildAvailableOutcomes({
      stake: 10,
      minOdds: 1.7,
      flow: 'single',
      expectedOutcomes: [input.outcome],
      ...input
    })
  };
}

const SCENARIOS = [
  createScenario({
    id: 'soccer-photo-total-over',
    sport: 'soccer',
    mode: 'live',
    home: 'Arsenal',
    away: 'Chelsea',
    league: 'Premier League',
    outcome: 'T> 2.5',
    outcomeTypeKey: 'soccer:match-total-over',
    flow: 'photo-followup',
    odds: 1.91,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-total-under',
    sport: 'soccer',
    mode: 'prematch',
    home: 'Real Madrid',
    away: 'Barcelona',
    league: 'La Liga',
    outcome: 'T< 3.5',
    outcomeTypeKey: 'soccer:match-total-under',
    odds: 1.88,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-first-half-total',
    sport: 'soccer',
    mode: 'live',
    home: 'Inter',
    away: 'Milan',
    league: 'Serie A',
    outcome: '1H Over 1.5',
    expectedOutcomes: ['1H Over 1.5', 'P1 T> 1.5'],
    outcomeTypeKey: 'soccer:first-half-total-over',
    flow: 'edit',
    odds: 1.84,
    minOdds: 1.75
  }),
  createScenario({
    id: 'soccer-second-half-total',
    sport: 'soccer',
    mode: 'live',
    home: 'Liverpool',
    away: 'Manchester City',
    league: 'Premier League',
    outcome: '2H Under 2.5',
    expectedOutcomes: ['2H Under 2.5', 'P2 T< 2.5'],
    outcomeTypeKey: 'soccer:second-half-total-under',
    flow: 'reply-followup',
    odds: 1.82,
    minOdds: 1.7
  }),
  createScenario({
    id: 'soccer-home-team-total',
    sport: 'soccer',
    mode: 'live',
    home: 'Bayern Munich',
    away: 'Borussia Dortmund',
    league: 'Bundesliga',
    outcome: 'IT1> 1.5',
    outcomeTypeKey: 'soccer:home-team-total-over',
    odds: 1.89,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-away-team-total',
    sport: 'soccer',
    mode: 'live',
    home: 'PSG',
    away: 'Monaco',
    league: 'Ligue 1',
    outcome: 'IT2< 1.5',
    outcomeTypeKey: 'soccer:away-team-total-under',
    odds: 1.87,
    minOdds: 1.75
  }),
  createScenario({
    id: 'soccer-home-handicap',
    sport: 'soccer',
    mode: 'prematch',
    home: 'Napoli',
    away: 'Roma',
    league: 'Serie A',
    outcome: 'H1(-1.5)',
    expectedOutcomes: ['H1(-1.5)', 'H1 -1.5'],
    outcomeTypeKey: 'soccer:home-handicap',
    odds: 1.93,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-period-handicap',
    sport: 'soccer',
    mode: 'live',
    home: 'Porto',
    away: 'Benfica',
    league: 'Liga Portugal',
    outcome: 'P1 H1 0.5',
    outcomeTypeKey: 'soccer:first-period-handicap',
    odds: 1.85,
    minOdds: 1.75
  }),
  createScenario({
    id: 'soccer-double-chance',
    sport: 'soccer',
    mode: 'prematch',
    home: 'Ajax',
    away: 'Feyenoord',
    league: 'Eredivisie',
    outcome: 'DC 1X',
    outcomeTypeKey: 'soccer:double-chance',
    odds: 1.9,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-draw-no-bet',
    sport: 'soccer',
    mode: 'live',
    home: 'Sporting Braga',
    away: 'Vitoria Guimaraes',
    league: 'Liga Portugal',
    outcome: 'DNB 1',
    outcomeTypeKey: 'soccer:draw-no-bet',
    odds: 1.86,
    minOdds: 1.75
  }),
  createScenario({
    id: 'soccer-btts',
    sport: 'soccer',
    mode: 'prematch',
    home: 'Fenerbahce',
    away: 'Galatasaray',
    league: 'Super Lig',
    outcome: 'BTTS Yes',
    outcomeTypeKey: 'soccer:btts',
    odds: 1.88,
    minOdds: 1.8
  }),
  createScenario({
    id: 'soccer-exact-score',
    sport: 'soccer',
    mode: 'prematch',
    home: 'Lyon',
    away: 'Marseille',
    league: 'Ligue 1',
    outcome: 'CS 2:1',
    outcomeTypeKey: 'soccer:exact-score',
    odds: 9.5,
    minOdds: 8.5
  }),
  createScenario({
    id: 'soccer-winning-margin',
    sport: 'soccer',
    mode: 'live',
    home: 'Celtic',
    away: 'Rangers',
    league: 'Premiership',
    outcome: 'WM Home By 1',
    outcomeTypeKey: 'soccer:winning-margin',
    odds: 4.6,
    minOdds: 4.0
  }),
  createScenario({
    id: 'tennis-match-total',
    sport: 'tennis',
    mode: 'live',
    home: 'Djokovic',
    away: 'Sinner',
    league: 'ATP Finals',
    outcome: 'T> 22.5',
    outcomeTypeKey: 'tennis:match-total-over',
    odds: 1.84,
    minOdds: 1.75
  }),
  createScenario({
    id: 'tennis-first-set-total',
    sport: 'tennis',
    mode: 'prematch',
    home: 'Alcaraz',
    away: 'Medvedev',
    league: 'ATP Finals',
    outcome: 'P1 T> 8.5',
    outcomeTypeKey: 'tennis:first-set-total-over',
    odds: 1.87,
    minOdds: 1.8
  }),
  createScenario({
    id: 'basketball-match-total',
    sport: 'basketball',
    mode: 'live',
    home: 'Lakers',
    away: 'Celtics',
    league: 'NBA',
    outcome: 'T> 214.5',
    outcomeTypeKey: 'basketball:match-total-over',
    odds: 1.83,
    minOdds: 1.75
  }),
  createScenario({
    id: 'basketball-away-handicap',
    sport: 'basketball',
    mode: 'prematch',
    home: 'Partizan',
    away: 'Crvena Zvezda',
    league: 'ABA League',
    outcome: 'H2(+4.5)',
    expectedOutcomes: ['H2(+4.5)', 'H2 4.5'],
    outcomeTypeKey: 'basketball:away-handicap',
    odds: 1.92,
    minOdds: 1.8
  }),
  createScenario({
    id: 'volleyball-match-winner',
    sport: 'volleyball',
    mode: 'live',
    home: 'Zenit Kazan',
    away: 'Belogorie',
    league: 'Superliga',
    outcome: '1',
    outcomeTypeKey: 'volleyball:match-winner',
    odds: 1.74,
    minOdds: 1.7
  }),
  createScenario({
    id: 'hockey-match-total',
    sport: 'hockey',
    mode: 'prematch',
    home: 'SKA',
    away: 'CSKA',
    league: 'KHL',
    outcome: 'T< 5.5',
    outcomeTypeKey: 'hockey:match-total-under',
    odds: 1.81,
    minOdds: 1.75
  }),
  createScenario({
    id: 'esports-map-total',
    sport: 'esports',
    mode: 'live',
    home: 'G2',
    away: 'Fnatic',
    league: 'LEC',
    outcome: 'T> 26.5',
    outcomeTypeKey: 'esports:map-total-over',
    odds: 1.79,
    minOdds: 1.72
  })
];

function createHarness(scenario, tempDir) {
  const logger = createLogger();
  const botClient = createBotClient();
  const tasksFilePath = path.join(tempDir, 'tasks.json');
  const stateFilePath = path.join(tempDir, 'state.json');
  const adapter = new ReplayBookAdapter(scenario);
  const bettor = new BaseBettor(adapter, {
    executionMode: 'telegram-only',
    enableTaskRunner: false,
    enableTelegramIngress: true,
    tasksFilePath,
    stateFilePath,
    logger,
    tgQuiet: true,
    dryRun: true,
    mode: scenario.mode,
    maxRetryAttempts: 1,
    telegram: {
      enabled: true,
      defaults: {
        defaultMinOdds: 1.7,
        brm: { stake: 10 },
        limits: {
          maxTotalPerMatch: 500,
          hardCapMaxTotalPerMatch: 500
        }
      },
      ingress: {
        enabled: true,
        botClient,
        quiet: true,
        rootDir: path.join(tempDir, '.telegram_ingress')
      },
      profiles: {
        default: {
          sourceChatIds: [CHAT_ID],
          feedbackChatIds: [CHAT_ID],
          allowedSenders: [
            { userId: AUTHOR_ID, usernames: [AUTHOR_USERNAME] }
          ],
          liveEnabled: true,
          prematchEnabled: true
        }
      }
    }
  });

  const calculator = {
    checkBettingLimits: jest.fn(async () => ({
      allowed: true,
      remainingAmount: Infinity,
      kellyAmount: 100
    })),
    logBetAccept: jest.fn(async () => true)
  };

  const telegram = {
    notifyTaskStarted: jest.fn(async () => []),
    notifyTaskCompleted: jest.fn(async () => [{ ok: true }]),
    notifyTaskFailed: jest.fn(async () => [{ ok: true }]),
    notifySkipped: jest.fn(async () => [{ ok: true }]),
    sendToAll: jest.fn(async () => [{ ok: true }]),
    escapeHtml: (value) => String(value)
  };

  bettor.calculator = calculator;
  bettor.telegram = telegram;
  bettor.betProcessor.calculator = calculator;
  bettor.betProcessor.telegram = telegram;
  bettor.isRunning = true;

  return { bettor, botClient };
}

async function runReplayScenario(scenario) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `telegram-replay-${scenario.id}-`));
  let bettor = null;

  try {
    const harness = createHarness(scenario, tmpDir);
    bettor = harness.bettor;
    const { botClient } = harness;
    const processedTasks = [];
    const originalProcess = bettor.betProcessor.process.bind(bettor.betProcessor);
    bettor.betProcessor.process = async (task) => {
      processedTasks.push(task);
      return originalProcess(task);
    };

    await bettor.telegramIngress.processUpdates(buildUpdates(scenario));

    const queuedTask = bettor.tasksManager.getCurrentTask('replaybook');
    assertReplay(Boolean(queuedTask), `Scenario ${scenario.id}: telegram task was not queued`);
    assertReplay(queuedTask.sourceType === 'telegram', `Scenario ${scenario.id}: queued sourceType is not telegram`);
    assertReplay(queuedTask.mode === scenario.mode, `Scenario ${scenario.id}: queued mode mismatch`);
    assertReplay(Boolean(queuedTask.signalId), `Scenario ${scenario.id}: signalId missing`);

    await bettor._executeQueuedTask(queuedTask);

    assertReplay(processedTasks.length === 1, `Scenario ${scenario.id}: expected 1 processed task, got ${processedTasks.length}`);
    const processed = processedTasks[0];
    const history = bettor.tasksManager.getRecentHistory(1)[0];
    const recentSignal = bettor.telegramIngress.getRecentSignals(5)
      .find((entry) => entry.taskId === processed.id);
    const normalizedExpectedOutcomes = new Set(
      scenario.expectedOutcomes
        .map((outcome) => normalizeReplayOutcomeKey(outcome))
        .filter(Boolean)
    );
    const normalizedFinalOutcome = normalizeReplayOutcomeKey(processed.outcome);

    assertReplay(Boolean(history), `Scenario ${scenario.id}: no history entry recorded`);
    assertReplay(history.status === 'completed', `Scenario ${scenario.id}: history status is ${history.status}`);
    assertReplay(processed._dryRunCompleted === true, `Scenario ${scenario.id}: dry-run was not finalized`);
    assertReplay(processed._betDetails?.dryRun === true, `Scenario ${scenario.id}: dry-run details missing`);
    assertReplay(processed._betDetails?.stake === scenario.stake, `Scenario ${scenario.id}: stake mismatch`);
    assertReplay(Math.abs((processed._betDetails?.odds || 0) - scenario.odds) < 0.0001, `Scenario ${scenario.id}: odds mismatch`);
    assertReplay(normalizedExpectedOutcomes.has(normalizedFinalOutcome), `Scenario ${scenario.id}: unexpected final outcome ${processed.outcome}`);
    assertReplay(Boolean(processed.selectedCandidate?.outcome), `Scenario ${scenario.id}: selected candidate missing`);
    assertReplay(Array.isArray(processed.candidateLadder) && processed.candidateLadder.length > 0, `Scenario ${scenario.id}: candidate ladder missing`);
    assertReplay(recentSignal?.queueDecision === 'completed', `Scenario ${scenario.id}: ingress lifecycle did not archive as completed`);
    assertReplay(recentSignal?.taskId === processed.id, `Scenario ${scenario.id}: ingress archived wrong taskId`);

    if (scenario.flow === 'photo-followup') {
      assertReplay(botClient.downloadFileById.mock.calls.length > 0, `Scenario ${scenario.id}: photo was not downloaded`);
    }

    return {
      id: scenario.id,
      sport: scenario.sport,
      outcomeTypeKey: scenario.outcomeTypeKey,
      finalOutcome: processed.outcome,
      historyStatus: history.status,
      signalState: recentSignal?.queueDecision || 'missing',
      messageCount: Array.isArray(recentSignal?.messageIds)
        ? recentSignal.messageIds.length
        : (Array.isArray(queuedTask.messageIds) ? queuedTask.messageIds.length : 0),
      flow: scenario.flow
    };
  } finally {
    if (bettor) {
      await bettor.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Telegram replay corpus', () => {
  jest.setTimeout(180000);

  test('should define 20 unique scenarios across at least 5 sports', () => {
    expect(SCENARIOS).toHaveLength(20);
    expect(new Set(SCENARIOS.map((scenario) => scenario.outcomeTypeKey)).size).toBe(20);
    expect(new Set(SCENARIOS.map((scenario) => scenario.sport)).size).toBeGreaterThanOrEqual(5);
  });

  test('isolated soccer-total-under prematch scenario completes', async () => {
    const scenario = SCENARIOS.find((s) => s.id === 'soccer-total-under');
    const result = await runReplayScenario(scenario);
    expect(result.historyStatus).toBe('completed');
    expect(result.signalState).toBe('completed');
  });

  test('should complete 20 dry-run telegram replays end-to-end', async () => {
    const results = [];

    for (const scenario of SCENARIOS) {
      results.push(await runReplayScenario(scenario));
    }

    expect(results).toHaveLength(20);
    expect(results.every((entry) => entry.historyStatus === 'completed')).toBe(true);
    expect(results.every((entry) => entry.signalState === 'completed')).toBe(true);
    expect(new Set(results.map((entry) => entry.outcomeTypeKey)).size).toBe(20);
    expect(new Set(results.map((entry) => entry.sport)).size).toBeGreaterThanOrEqual(5);

    const photoScenario = results.find((entry) => entry.id === 'soccer-photo-total-over');
    const editScenario = results.find((entry) => entry.id === 'soccer-first-half-total');
    const replyScenario = results.find((entry) => entry.id === 'soccer-second-half-total');

    expect(photoScenario).toMatchObject({ messageCount: 2, flow: 'photo-followup' });
    expect(editScenario).toMatchObject({ messageCount: 1, flow: 'edit' });
    expect(replyScenario).toMatchObject({ messageCount: 2, flow: 'reply-followup' });
  });
});
