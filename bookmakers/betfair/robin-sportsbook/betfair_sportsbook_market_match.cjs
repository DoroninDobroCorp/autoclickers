"use strict";

// Reconciliation Фаза 1 (money-code, matching layer): structural
// forted<->betfair MARKET HEADER matcher. Pure, Playwright-free
// (unit-testable with node:test). MERGE result of two independent
// implementations audited line-by-line by gpt-5.6-sol/ultra
// (_bmad-output/reconcile/spec-A.md, "MARKET MATCHING"):
//
//   - MINE's structural core (parseMarketIdentity/marketsEquivalent/
//     matchMarketHeader): family/unit/period/segment/participant identity,
//     noise filter, unlined-header defer, confirmed-over-deferred dominance.
//   - VOVKA's production grammar (half-totals in all four textual forms,
//     set-winner, match/set total games with line taken from the selection
//     text, neutral moneyline suffixes) ported as STRUCTURAL rules, not his
//     original string-fallback code.
//
// Two money-risk bugs found in the audit are fixed here:
//   1. VOVKA's line extraction took the FIRST number in the text and applied
//      an unconditional Math.abs() -- "Team 1 (+4.5)" extracted line "1"
//      (the participant ordinal), always discarding the sign. Fixed by
//      extractStrictLine() below: a line is only ever taken from a
//      parenthesized number, a number immediately following
//      Over/Under/Handicap, or an explicitly SIGNED trailing number -- never
//      a bare unsigned number (which is how a participant index like
//      "Team 1" is excluded by construction) -- and only when EXACTLY one
//      such candidate value exists in the text.
//   2. MINE's post-click marketIdentityPlausible Tier 2 reused the FIND-phase
//      marketsEquivalent(sourceId, headerId) comparator (clicked/hint in the
//      source/header argument slots) as if it were a generic symmetric
//      predicate. compareResolvedMarketEvidence() below is its OWN,
//      explicitly directional post-click comparator: "clicked" (the header
//      actually resolved/clicked) is authoritative, "hint" (a secondary
//      ancestor-name lookup) may defer ONLY when its own line is absent; the
//      reverse (clicked unlined, hint asserting a specific line) always fails
//      closed. Kept as a distinct function -- never swappable with
//      marketsEquivalent -- so a future change to the FIND-phase's
//      line-deferral semantics can never silently change POST-CLICK
//      verification behaviour.
//
// Design: parse BOTH the forted `source` market name and every betfair
// header text into the same structural shape --
//   { marketType, unit, numericLine, participant, period, segment, isNoise, raw }
// -- and consider two parses "the same market" only when their structural
// keys are provably equivalent (see marketsEquivalent). Never guess: any
// header whose type/line/participant cannot be confidently derived stays
// marketType=null and can therefore never satisfy an equivalence check.
const {
  MARKET_SYNONYM_GROUPS,
  MARKET_PERIOD_QUALIFIERS,
  MARKET_SEGMENT_QUALIFIERS,
} = require("./betfair_sportsbook_market_identity.cjs");

function normalizeText(value) {
  return String(value || "")
    .replace(/−/g, "-") // Unicode minus sign -> ASCII hyphen-minus
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// --- AC-6: noise / non-market headers -------------------------------------
// Explicit list from the live diagnostic -- these page elements render
// inside the same market-container selector as real markets but are never
// betting markets themselves (cookie/consent UI, bet-builder promo tiles,
// search/nav chrome). Listed here so they can NEVER satisfy
// marketsEquivalent (isNoise short-circuits it to false), regardless of what
// a future structural regex might otherwise (mis)parse them as.
const NOISE_EXACT = new Set([
  "search",
  "popular",
  "featured bet builders",
  "policies and assistance",
  "about your privacy",
  "manage consent preferences",
  "vendors list",
]);
const NOISE_PREFIXES = ["bet builder", "#oddsonthat"];

function isNoiseHeader(normalized) {
  if (!normalized) return false;
  if (NOISE_EXACT.has(normalized)) return true;
  return NOISE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// Reconcile regress1 P2 (final cross-family audit, money-safety): a bare
// "Handicap <line>" source string (no "Betting"/"Asian"/"Game"/"Set"
// qualifier at all) carries NO textual proof of settlement arity -- it could
// be a 2-outcome (Asian-style, push-on-exact-line) or 3-outcome (European,
// draw possible) market depending on the sport/bookmaker. The bare-word
// regex branch below used to default this straight to "handicap_euro"
// (3-way), which could silently bind a genuinely 2-outcome source to a real
// Betfair "Handicap Betting" (3-way) header sharing the same numeric line --
// a settlement mismatch, not just a naming one. `marketType` here is the raw
// Paddy `market.marketType` tag threaded all the way from the quote
// (paddy_sportsbook._runner_selection... / server.py quote["market_type"])
// through matchMarketHeader's options -- used ONLY to look for explicit
// arity evidence (3-way/draw vs Asian/spread/2-way tokens); anything else
// (including a marketType tag that says nothing about arity, e.g. a bare
// "HANDICAP") must fail closed to unknown rather than guess.
function inferHandicapArity(marketTypeRaw) {
  // Normalize underscores/hyphens to spaces before the \b word-boundary
  // checks below -- "_"/"-" are WORD characters in regex terms, so
  // "DRAW_NO_BET"/"HANDICAP_DRAW" would otherwise never satisfy \bDRAW\b
  // (no boundary between "_" and "D"/"W").
  const raw = String(marketTypeRaw || "").toUpperCase().replace(/[_-]/g, " ");
  if (!raw.trim()) return null;
  // "BETTING" mirrors Betfair's own "Handicap Betting" naming for its
  // European/3-outcome family -- a reasonable, non-guessed signal when
  // Paddy's own marketType tag echoes it (e.g. "HANDICAP_BETTING").
  if (/(3\s?WAY|THREE\s?WAY|\bDRAW\b|BETTING)/.test(raw)) return 3;
  if (/(ASIAN|SPREAD|\b2\s?WAY\b|TWO\s?WAY)/.test(raw)) return 2;
  return null;
}

// --- Reconcile Фаза1 task 4: MARKET_SYNONYM_GROUPS -> registry ------------
// betfair_sportsbook_market_identity.cjs now exposes MARKET_SYNONYM_GROUPS as
// a plain array-of-arrays (for backward compatibility with its own
// string-tier fallback code and existing tests), DERIVED from a
// {family, aliases} registry that is the actual single source of truth. This
// module only needs the moneyline group out of it (the other groups --
// handicap_euro/handicap_asian/double_chance/draw_no_bet/btts -- are used by
// market_identity.cjs's own lower-tier string fallback, not by the
// structural parser below, which classifies those families independently via
// dedicated regexes so the settlement-family invariant -- Asian
// Handicap/Spread is NEVER the same family as Handicap/Handicap Betting --
// can never be violated by a shared-string-list refactor).
//
// P3-b (Opus+gpt-5.6-sol premium audit, 2026-07-15, carried over from the
// pre-merge version of this module): MONEYLINE_GROUP is DERIVED from the
// shared registry instead of duplicating the moneyline synonym list, so both
// modules can never disagree on which wordings belong to the moneyline
// family.
const MONEYLINE_GROUP = MARKET_SYNONYM_GROUPS.find((group) => group.includes("match odds")) || [];

// Reconcile Фаза1 task 2 bullet 1: VOVKA's neutral full-match suffixes
// (Full Time / 90 / 90 Minutes / Regular Time) are moneyline-ONLY structural
// aliases -- explicit whole-string membership in MONEYLINE_SYNONYMS, never a
// generic suffix-strip applied to arbitrary market text (that would risk
// silently equating e.g. a "Corners Handicap -1.5 Full Time" with a plain
// "Corners Handicap -1.5"). These can only ever equate two moneyline headers
// to each other, never leak into any lined/settlement-sensitive family.
const MONEYLINE_SYNONYMS = new Set([
  ...MONEYLINE_GROUP,
  "match odds 90",
  "match odds - full time",
  "match odds full time",
  "match odds (full time)",
  "match odds - 90 minutes",
  "match odds 90 minutes",
  "match odds - regular time",
  "match odds regular time",
]);

// Reconcile Фаза1 task 2 bullet 2/item 8: canonical period/segment values --
// "1st half"/"first half" (and analogous ordinal/word-form pairs) used to be
// DIFFERENT literal qualifier strings, so a period-qualified market rendered
// with one wording could never be proven equivalent to the same market
// rendered with the other. Canonicalized once here, fixing the drift for
// every family that goes through extractQualifiers, not just totals.
const PERIOD_CANONICAL = {
  "first half": "half:1",
  "1st half": "half:1",
  "second half": "half:2",
  "2nd half": "half:2",
  "half time": "halftime",
  halftime: "halftime",
  "first period": "period:1",
  "second period": "period:2",
  "third period": "period:3",
  "1st set": "set:1",
  "2nd set": "set:2",
  "3rd set": "set:3",
  "4th set": "set:4",
  "5th set": "set:5",
  "1st quarter": "quarter:1",
  "2nd quarter": "quarter:2",
  "3rd quarter": "quarter:3",
  "4th quarter": "quarter:4",
  "extra time": "extra_time",
};
const SEGMENT_CANONICAL = {
  "throw ins": "throw_ins",
  "throw-ins": "throw_ins",
};

function canonicalPeriod(raw) {
  return PERIOD_CANONICAL[raw] || raw;
}
function canonicalSegment(raw) {
  return SEGMENT_CANONICAL[raw] || raw;
}

// P2-1: period/segment qualifiers a header/source text can carry -- a
// "1st Half Match Odds" or "Corners Handicap -1.5" is NEVER the same market
// as its unqualified counterpart. Reuses the SAME lists
// betfair_sportsbook_market_identity.cjs gates marketIdentityPlausible() on,
// so the two modules can never drift apart on what counts as a qualifier.
// Note: Over/Under, Odd/Even, home/away are RUNNER-level attributes within a
// single market header, resolved elsewhere (selection_match.cjs) -- out of
// scope for this module, which only matches market HEADERS.
function extractQualifiers(normalized) {
  let text = normalized;
  let period = null;
  let segment = null;
  for (const q of MARKET_PERIOD_QUALIFIERS) {
    if (text.includes(q)) {
      period = canonicalPeriod(q);
      text = text.split(q).join(" ").replace(/\s+/g, " ").trim();
      break;
    }
  }
  for (const q of MARKET_SEGMENT_QUALIFIERS) {
    if (text.includes(q)) {
      segment = canonicalSegment(q);
      text = text.split(q).join(" ").replace(/\s+/g, " ").trim();
      break;
    }
  }
  return { text, period, segment };
}

function identity(marketType, unit, numericLine, participant, raw, period, segment) {
  return {
    marketType,
    unit: unit || null,
    numericLine: numericLine === undefined ? null : numericLine,
    participant: participant || null,
    period: period || null,
    segment: segment || null,
    isNoise: false,
    raw,
  };
}

const NULL_IDENTITY_RAW = (raw) => ({
  marketType: null,
  unit: null,
  numericLine: null,
  participant: null,
  period: null,
  segment: null,
  isNoise: false,
  raw,
});

// Half-total forms (Reconcile Фаза1 task 2 bullet 2, VOVKA marketNameFallbacks
// 256-279 ported as STRUCTURAL rules, not his original regex-and-string-add
// code): all four textual forms Betfair/forted render half-goals-totals in
// canonicalize to ONE identity {family: total, unit: goals, period: half:N,
// line}. Run on the RAW normalized text (before the generic extractQualifiers
// pass), same as set_winner below, so the half number (1 or 2) is captured
// as a first-class identity component from a single auditable regex table,
// matching how VOVKA's original fallback table read.
const HALF_WORDS = { 1: "(?:first|1st)", 2: "(?:second|2nd)" };
function matchHalfTotal(normalized) {
  for (const half of [1, 2]) {
    const w = HALF_WORDS[half];
    const num = "([0-9]+(?:[.,][0-9]+)?)";
    let m = normalized.match(new RegExp(`^${w} half over/under ${num} goals$`));
    if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, `half:${half}`, null);
    m = normalized.match(new RegExp(`^over/under ${w} half ${num}$`));
    if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, `half:${half}`, null);
    m = normalized.match(new RegExp(`^${w} half goals ${num}$`));
    if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, `half:${half}`, null);
    m = normalized.match(new RegExp(`^${w} half total goals ${num}$`));
    if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, `half:${half}`, null);
  }
  return null;
}

// Set-winner (Reconcile Фаза1 task 2 bullet 2, VOVKA 281-284): "To Win Nth
// Set" <-> "Set N Winner" is one identity {family: set_winner, period:
// set:N}. Deliberately does NOT build an ordinal suffix itself (VOVKA's
// original `${n}st` generated the wrong suffix for n=2/3 -- "2st"/"3st");
// both regexes only ever READ an existing ordinal suffix (st/nd/rd/th) or a
// bare digit out of the text, so this can never mis-render one.
function matchSetWinner(normalized) {
  let m = normalized.match(/^to win (\d+)(?:st|nd|rd|th) set$/);
  if (m) return identity("set_winner", null, null, null, normalized, `set:${m[1]}`, null);
  m = normalized.match(/^set (\d+) winner$/);
  if (m) return identity("set_winner", null, null, null, normalized, `set:${m[1]}`, null);
  return null;
}

// Parses one market-name/header string (source OR betfair header -- the
// function is deliberately symmetric, see module doc comment) into the
// structural shape used by marketsEquivalent(). Never throws; an
// unrecognized string parses to marketType=null (fail-closed: can never
// satisfy an equivalence check).
function parseMarketIdentity(text, options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return NULL_IDENTITY_RAW(normalized);
  if (isNoiseHeader(normalized)) {
    return {
      marketType: null, unit: null, numericLine: null, participant: null,
      period: null, segment: null, isNoise: true, raw: normalized,
    };
  }

  // Self-period families -- parsed on the RAW normalized text, before the
  // generic period/segment qualifier stripper runs, because their own
  // regex is what supplies the period (set:N / half:N) as a first-class
  // identity component.
  const setWinner = matchSetWinner(normalized);
  if (setWinner) return setWinner;
  const halfTotal = matchHalfTotal(normalized);
  if (halfTotal) return halfTotal;

  // P2-1: strip period ("1st Half", "2nd Set", ...) and segment ("Corners",
  // "Cards", ...) qualifiers up front -- every marketType regex below runs
  // against the REMAINING base text, and the qualifiers themselves become
  // first-class identity components checked by marketsEquivalent (a
  // period/segment-qualified market is never equivalent to its plain form,
  // nor to a DIFFERENT period/segment).
  const { text: base, period, segment } = extractQualifiers(normalized);
  const NUM = "([-+]?\\d+(?:[.,]\\d+)?)";

  // AC-2: Handicap 3-Way is a DISTINCT settlement family from 2-outcome
  // handicap (draw possible / virtual-goal-adjusted vs strictly 2-outcome).
  let m = base.match(new RegExp(`^(game\\s+)?handicap\\s+3-?way(?:\\s+${NUM})?$`));
  if (m) return identity("handicap3way", m[1] ? "game" : null, parseNumber(m[2]), null, normalized, period, segment);

  // P1-a: Game/Set handicaps are inherently 2-outcome -- SAME settlement
  // semantics as Asian Handicap/Spread, never the 3-outcome European
  // "Handicap"/"Handicap Betting" family below. Grouped as
  // marketType="handicap_asian". Ordinal "N" in "Alternative Game/Set
  // Handicap <N> <line>" is a purely presentational prefix and is discarded.
  m = base.match(new RegExp(`^alternative\\s+(game|set)\\s+handicap\\s+(?:(\\d+)\\s+)?${NUM}$`));
  if (m) return identity("handicap_asian", m[1], parseNumber(m[3]), null, normalized, period, segment);

  // AC-2: plain "Game Handicap <line>" / "Set Handicap <line>".
  m = base.match(new RegExp(`^(game|set)\\s+handicap\\s+${NUM}$`));
  if (m) return identity("handicap_asian", m[1], parseNumber(m[2]), null, normalized, period, segment);

  // Reconcile Фаза1 task 2 bullet 5 / VOVKA 286-293: bare "Game Handicap" /
  // "Set Handicap" with NO line in the header/source text at all -- the
  // ONLY source of the line is the selection text (see
  // enrichWithSelectionLine below). Unit is still a hard identity component.
  m = base.match(/^(game|set)\s+handicap$/);
  if (m) return identity("handicap_asian", m[1], null, null, normalized, period, segment);

  // AC-5: basketball "Handicap Betting [<line>]" -- European/3-outcome
  // family, NEVER equivalent to Asian Handicap/Spread/Game-Set handicap.
  m = base.match(new RegExp(`^handicap\\s+betting(?:\\s+${NUM})?$`));
  if (m) return identity("handicap_euro", null, parseNumber(m[1]), null, normalized, period, segment);

  // Live Betfair request-catalog synonym for the same football 3-way
  // handicap settlement family used by Paddy's "Handicap Betting".
  if (base === "handicap match result") {
    return identity("handicap_euro", null, null, null, normalized, period, segment);
  }

  // Betfair disambiguates repeated Alternative Handicaps cards by appending
  // periods to the title: base = variant 1, "." = variant 2, ".." =
  // variant 3. Paddy exposes the same stable ordinal as a trailing number.
  // Preserve that ordinal as a hard unit key so parallel cards never become
  // an ambiguous/fuzzy match.
  m = base.match(/^alternative\s+handicaps(?:\s+(\d+)|(\.*))$/);
  if (m) {
    const variant = m[1] ? Number(m[1]) : String(m[2] || "").length + 1;
    return identity("handicap_euro", `variant:${variant}`, null, null, normalized, period, segment);
  }

  // P1-a: source-side "Asian Handicap <line>" / "Spread <line>" -- 2-outcome
  // family, same settlement semantics as Game/Set handicap above, DISTINCT
  // marketType from bare "Handicap"/"Handicap Betting" below.
  m = base.match(new RegExp(`^(?:asian\\s+handicap|spread)\\s+${NUM}$`));
  if (m) return identity("handicap_asian", null, parseNumber(m[1]), null, normalized, period, segment);

  // Reconcile regress1 P2 (money-safety): generic source-side bare
  // "Handicap <line>" has NO textual arity evidence at all -- it is NOT
  // safe to auto-assume the European/3-outcome "Handicap Betting" family
  // (see inferHandicapArity doc comment above). Only classify it when the
  // caller-supplied `options.marketType` (the Paddy quote's raw
  // marketType/family tag) actually proves the arity; otherwise fail closed
  // to unknown (marketType=null) rather than silently binding a possibly
  // 2-outcome source to a 3-outcome header or vice versa.
  m = base.match(new RegExp(`^handicap\\s+${NUM}$`));
  if (m) {
    const arity = inferHandicapArity(options.marketType);
    if (arity === 3) return identity("handicap_euro", null, parseNumber(m[1]), null, normalized, period, segment);
    if (arity === 2) return identity("handicap_asian", null, parseNumber(m[1]), null, normalized, period, segment);
    // Reconcile regress2 P1 (money-critical, both final-audit reviewers
    // CONFIRMED): tag this fail-closed-to-unknown identity so
    // matchMarketHeader's exact-string tier (below) can refuse to bypass the
    // arity gate for it -- see that tier's own comment for why an identical
    // bare-string match is NOT sufficient proof of settlement arity either.
    return { ...NULL_IDENTITY_RAW(normalized), period, segment, isUnknownArityHandicap: true };
  }

  // AC-3: totals flicker -- "Over/Under Total Goals X.X" and
  // "Over/Under X.X Goals" are the SAME market rendered two different ways.
  m = base.match(new RegExp(`^over/under\\s+total\\s+goals\\s+${NUM}$`));
  if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, period, segment);
  m = base.match(new RegExp(`^over/under\\s+${NUM}\\s+goals$`));
  if (m) return identity("total", "goals", parseNumber(m[1]), null, normalized, period, segment);

  // Football participant totals. Paddy omits the neutral "Goals" suffix in
  // some responses while Betfair's request catalog keeps it, so match the
  // two renderings structurally while preserving home/away as a hard market
  // identity component.
  m = base.match(new RegExp(`^(home|away)\\s+team\\s+over/under\\s+${NUM}(?:\\s+goals)?$`));
  if (m) return identity("teamTotal", "goals", parseNumber(m[2]), m[1], normalized, period, segment);

  // AC-5: basketball "Total points [<line>]".
  m = base.match(new RegExp(`^total\\s+points(?:\\s+${NUM})?$`));
  if (m) return identity("total", "points", parseNumber(m[1]), null, normalized, period, segment);

  // Reconcile Фаза1 task 2 bullet 5 / VOVKA 286-293: "Set N Total Games
  // [Over/Under] X" -- both the plain and Over/Under-qualified renderings
  // canonicalize to ONE identity {family: setTotal, unit: games,
  // period: set:N, line: X}. Checked BEFORE matchTotal/playerTotal so the
  // digit-first "set N" prefix can never be mistaken for a player name.
  m = base.match(new RegExp(`^set\\s+(\\d+)\\s+total\\s+games(?:\\s+over/under)?\\s+${NUM}$`));
  if (m) return identity("setTotal", "games", parseNumber(m[2]), null, normalized, `set:${m[1]}`, segment);

  // Reconcile Фаза1 task 2 bullet 5 / VOVKA 286-293 + spec-A fix (item 3 "Что
  // взять из MINE"): "Match Total Games"/"Total Match Games"/"Total Games"
  // bare or lined -- a TEAM/MATCH-level total, never a per-player one (the
  // MINE bug this fixes: a bare "Total Games <line>" used to be classified
  // as playerTotal with participant=null, which could never legitimately
  // equal any REAL player-total header per the hard participant gate below,
  // silently making this whole market class unmatchable). Line may be
  // absent from the header/source text entirely -- enrichWithSelectionLine
  // fills it from the selection text (e.g. "Over 22.5") when so.
  m = base.match(new RegExp(`^(?:match\\s+total\\s+games|total\\s+match\\s+games|total\\s+games)(?:\\s+${NUM})?$`));
  if (m) return identity("matchTotal", "games", parseNumber(m[1]), null, normalized, period, segment);

  // Betfair prefixes alternative match-game totals with a presentation-only
  // ordinal ("Alternative Total Games 1 20.5"). The ordinal selects a UI
  // bucket, not a participant or period; the actual settlement line is the
  // final number.
  m = base.match(new RegExp(`^alternative\\s+total\\s+games\\s+\\d+\\s+${NUM}$`));
  if (m) return identity("matchTotal", "games", parseNumber(m[1]), null, normalized, period, segment);

  // AC-4: player-prefixed totals (tennis) -- "<Player Name> Total Games
  // <line>" (also generalized to Total Points/Double Faults). A
  // player-prefixed total is never the same market as the team/match-level
  // total even when the line matches (distinct marketType).
  m = base.match(new RegExp(`^(.+?)\\s+total\\s+(games|points|double faults)\\s+${NUM}$`));
  if (m) return identity("playerTotal", m[2].replace(" ", "-"), parseNumber(m[3]), m[1].trim(), normalized, period, segment);

  // AC-5/AC-8: moneyline family, whole-string exact synonym membership only
  // (never substring).
  if (MONEYLINE_SYNONYMS.has(base)) return identity("moneyline", null, null, null, normalized, period, segment);

  return { ...NULL_IDENTITY_RAW(normalized), period, segment };
}

function linesCompatible(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 1e-3;
}

// P1 fix (Opus+gpt-5.6-sol premium audit, 2026-07-15): some real betfair
// headers for line-bearing markets never render the numeric line in the
// HEADER text at all (basketball "Handicap Betting"/"Total points"); the
// line lives on the RUNNER buttons underneath. Requiring linesCompatible()
// unconditionally would make every lined forted source PERMANENTLY unable
// to match its own real unlined betfair header. The downstream runner-level
// gates (handicapPlausible/canonicalOutcomeKey, unmodified) independently
// re-verify the numeric line against the ACTUAL clicked runner before any bet
// is placed -- deferring here cannot let a wrong-line bet through, it only
// lets the right header be FOUND so the downstream check gets a chance to
// run at all.
//
// Deliberately ONE-DIRECTIONAL: only `b` (the HEADER side, in
// matchMarketHeader's usage) carrying NO numeric line at all defers to a
// lined `a` (the SOURCE side). The reverse -- an unlined source vs a header
// that DOES commit to an explicit line -- is never deferred. This is the
// FIND-phase-specific asymmetry that compareResolvedMarketEvidence below is
// deliberately a SEPARATE function from, per the Money-safety audit
// ("Направленность Tier2") -- see that function's doc comment.
function lineCheckPasses(a, b) {
  if (b.numericLine === null && a.numericLine !== null) return true; // P1: deferred to downstream runner-gate
  return linesCompatible(a.numericLine, b.numericLine);
}

// True only when `a` (the SOURCE/requested identity) and `b` (a candidate
// betfair HEADER identity) provably refer to the SAME betting market. Fails
// closed (false) whenever identity cannot be confidently established.
function marketsEquivalent(a, b) {
  if (!a || !b) return false;
  if (a.isNoise || b.isNoise) return false;
  if (!a.marketType || !b.marketType) return false;
  if (a.marketType !== b.marketType) return false;
  // P2-1: a period/segment-qualified market is never equivalent to its
  // unqualified form or to a DIFFERENT period/segment.
  if (a.period !== b.period) return false;
  if (a.segment !== b.segment) return false;
  // P1-b: unit is a HARD gate, never a wildcard.
  if (a.unit !== b.unit) return false;
  if (a.marketType === "moneyline") return true;
  // European/3-way handicap catalog headers sometimes render the virtual
  // goal magnitude without the selected runner's sign. Header matching may
  // compare magnitudes only inside this proven settlement family; the exact
  // signed outcome is still independently enforced downstream by
  // selection_id + canonical runner + runner.handicap evidence.
  const euroMagnitudeMatch = a.marketType === "handicap_euro"
    && a.numericLine !== null && b.numericLine !== null
    && Math.abs(Math.abs(a.numericLine) - Math.abs(b.numericLine)) < 1e-3;
  if (!euroMagnitudeMatch && !lineCheckPasses(a, b)) return false;
  if (a.marketType === "playerTotal" || a.marketType === "teamTotal") {
    // A source that cannot name its participant can never be proven
    // equivalent to ANY player-total header (two different players commonly
    // share the identical line -- "exactly one header of that line" does
    // NOT reliably mean "exactly one candidate player").
    if (!a.participant || !b.participant) return false;
    if (a.participant !== b.participant) return false;
  }
  return true;
}

// Reconcile Фаза1 task 5 (spec-A "Направленность Tier2" money-safety fix):
// a DISTINCT, explicitly directional post-click/post-resolve evidence
// comparator -- deliberately NOT the same function as marketsEquivalent
// (the FIND phase, where the SOURCE side is authoritative and the HEADER
// side may legitimately lack a line). Reusing that FIND-phase comparator for
// POST-CLICK verification was the exact bug the Фаза1 audit flagged: it
// happens to produce a safe answer for the audited example pairs, but its
// safety was never independently provable from the verify side, since both
// call sites would share one function.
//
// Roles are fixed and asymmetric: `clickedId` is the identity of the market
// header ACTUALLY clicked/resolved -- the strongest, most authoritative
// signal (literally what the bet is placed on). `hintId` is a SECONDARY
// ancestor-name lookup -- weaker corroboration whose own line, if any, never
// overrides what was actually clicked.
//
// Line evidence is therefore directional: a hint carrying NO line at all
// cannot disprove a clicked header that DOES commit to one (defers) -- but
// the REVERSE (clicked header carries no line, hint asserts one) is NEVER
// deferred: an unlined actual click cannot be excused by a hint's stronger
// claim. Keeping this as its own function makes that direction impossible
// to accidentally invert via a future refactor of the FIND-phase helper.
function compareResolvedMarketEvidence(clickedId, hintId) {
  if (!clickedId || !hintId) return false;
  if (clickedId.isNoise || hintId.isNoise) return false;
  if (!clickedId.marketType || !hintId.marketType) return false;
  if (clickedId.marketType !== hintId.marketType) return false;
  if (clickedId.period !== hintId.period) return false;
  if (clickedId.segment !== hintId.segment) return false;
  if (clickedId.unit !== hintId.unit) return false;
  if (clickedId.marketType === "moneyline") return true;

  const hintDefers = hintId.numericLine === null && clickedId.numericLine !== null;
  if (!hintDefers && !linesCompatible(clickedId.numericLine, hintId.numericLine)) return false;

  if (clickedId.marketType === "playerTotal" || clickedId.marketType === "teamTotal") {
    if (!clickedId.participant || !hintId.participant) return false;
    if (clickedId.participant !== hintId.participant) return false;
  }
  return true;
}

// Reconcile Фаза1 task 3: strict, standalone line extractor. Fixes VOVKA's
// two money-risk bugs in one place: taking the FIRST number in the text
// (which can be a participant ordinal, e.g. "Team 1") and an unconditional
// Math.abs() that silently discards the sign.
//
// A numeric candidate is only ever recognized in exactly THREE shapes:
//   1. inside parentheses -- "(+4.5)", "(-1.5)", "(4.5)";
//   2. immediately after the word over/under/handicap -- "Over 22.5",
//      "Handicap -1.5";
//   3. a SIGNED number at the very end of the string with nothing after it --
//      a BARE unsigned trailing number (e.g. the "1" in "Team 1") never
//      qualifies: only an explicit +/- sign lets a bare trailing number be
//      trusted as a line rather than an ordinal/participant index.
//
// Returns null when zero candidates are found, OR when more than one
// DISTINCT numeric value is found (ambiguous -- never guesses which one is
// the real line). Decimal commas and the Unicode minus sign are normalized
// before matching (via normalizeText/parseNumber).
function extractStrictLine(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const candidates = [];
  let m;

  const parenRe = /\(\s*([-+]?\d+(?:[.,]\d+)?)\s*\)/g;
  while ((m = parenRe.exec(normalized)) !== null) candidates.push(parseNumber(m[1]));

  const keywordRe = /\b(?:over|under|handicap)\s+([-+]?\d+(?:[.,]\d+)?)/g;
  while ((m = keywordRe.exec(normalized)) !== null) candidates.push(parseNumber(m[1]));

  const trailing = normalized.match(/([-+]\d+(?:[.,]\d+)?)\s*$/);
  if (trailing) candidates.push(parseNumber(trailing[1]));

  const distinct = [...new Set(candidates.filter((v) => v !== null))];
  if (distinct.length !== 1) return null;
  const value = distinct[0];
  return { value, sign: value > 0 ? 1 : value < 0 ? -1 : 0 };
}

// Families whose header/source text can legitimately omit the numeric line
// entirely, with the real value only ever available from the SELECTION text
// (Reconcile Фаза1 task 2 bullet 5: "Match Total Games" + line from
// selection, "Game Handicap" + line from selection).
const SELECTION_ENRICHABLE_FAMILIES = new Set([
  "matchTotal", "setTotal", "handicap_asian", "handicap_euro", "handicap3way", "total", "teamTotal", "playerTotal",
]);

// Fills in a parsed identity's numericLine from the selection text when (and
// only when) the identity's OWN text carried no line at all and its family
// is known to sometimes rely on the selection for the line. Never overrides
// an already-known line, never invents a family, never runs when
// extractStrictLine finds zero or >1 candidates (fails closed to the
// original, still-unlined identity).
function enrichWithSelectionLine(id, selection) {
  if (!id || id.numericLine !== null || !id.marketType) return id;
  if (!SELECTION_ENRICHABLE_FAMILIES.has(id.marketType)) return id;
  if (selection === undefined || selection === null || selection === "") return id;
  const extracted = extractStrictLine(selection);
  if (!extracted) return id;
  return { ...id, numericLine: extracted.value };
}

// AC-1: matches `sourceMarketName` (forted market name) against
// `headerTexts` (every betfair market-container header text currently on
// the page). `options.selection` (optional) is the forted selection/runner
// text -- used ONLY to fill in a missing numeric line on the SOURCE side for
// families known to omit it from the market name itself (matchTotal/
// setTotal/handicap*), never to invent a family or override an existing
// line. Returns EXACTLY the shape the worker needs to fail closed:
//   { index: <int>, ambiguous: false }                 -- exactly one match
//   { index: null, ambiguous: false }                  -- zero matches
//   { index: null, ambiguous: true, matchedIndices }    -- >1 matches
//
// Two tiers, unioned:
//   1. exact normalized-string equality (backward-compatible base case);
//   2. structural equivalence via parseMarketIdentity + marketsEquivalent.
// Never picks a "best" candidate when both tiers disagree on count.
//
// P2-2 (money-risk fix, carried over): the noise-filter (AC-6) runs BEFORE
// either tier, including the exact-string tier.
function matchMarketHeader(sourceMarketName, headerTexts, options = {}) {
  const { selection, marketType } = options;
  const texts = headerTexts || [];
  const sourceNorm = normalizeText(sourceMarketName);
  // Reconcile regress1 P2: `marketType` (Paddy's raw quote arity tag) is
  // ONLY meaningful as evidence about what the SOURCE (forted/Paddy) market
  // actually is -- it says nothing about how any given Betfair HEADER text
  // should be classified, so it is never passed to the header-side parse
  // below. A Betfair header must always be judged on its own rendered text.
  const sourceId = enrichWithSelectionLine(parseMarketIdentity(sourceMarketName, { marketType }), selection);

  // Story 2.5 P3-1 (regress3, carried over): candidates are split into
  // `confirmed` (exact normalized-string equality, OR a structural match
  // whose OWN header text commits to an explicit line / carries no line
  // requirement at all) and `deferred` (a structural match that only passed
  // via lineCheckPasses's deferred-unlined-header branch). A `deferred`
  // candidate is real information but strictly WEAKER than a `confirmed`
  // one.
  const confirmed = new Set();
  const deferred = new Set();
  texts.forEach((text, i) => {
    const headerNorm = normalizeText(text);
    if (isNoiseHeader(headerNorm)) return; // P2-2: filtered out before any tier
    // Reconcile regress2 P1 (money-critical, both final-audit reviewers
    // CONFIRMED): the exact-string tier used to run unconditionally BEFORE
    // parseMarketIdentity/arity was ever checked, so an identical bare
    // "Handicap <line>" string (unknown 2-outcome-vs-3-outcome settlement
    // arity, per inferHandicapArity above) would `confirmed.add(i)` on
    // string equality alone -- completely bypassing the fail-closed arity
    // gate parseMarketIdentity enforces for exactly this shape. Exact
    // string equality is NOT proof of settlement arity: `sourceId` already
    // carries `isUnknownArityHandicap: true` for this shape (set above), so
    // gate the exact-string tier on it too -- an identical unknown-arity
    // bare handicap header now falls through to the structural tier below,
    // where marketsEquivalent's `!a.marketType || !b.marketType` hard gate
    // (both sides parse to marketType=null here) fails closed exactly like
    // any other unproven-arity case.
    // FINAL3 P1 (gpt-5.6-sol) — header-side symmetry: parse the header identity
    // BEFORE the exact-string tier so its own arity can gate the match too. A
    // byte-identical bare "Handicap <line>" HEADER (marketType=null, unproven
    // 2-way/3-way arity) must NOT be confirmed on string equality even when the
    // SOURCE has proven arity -- the header's own settlement arity is unproven,
    // so it falls through to marketsEquivalent's `!marketType` hard gate and
    // fails closed. Symmetric to the source-side gate regress2 already added.
    const headerId = parseMarketIdentity(text);
    if (sourceNorm && headerNorm && headerNorm === sourceNorm
        && !sourceId.isUnknownArityHandicap && !headerId.isUnknownArityHandicap) {
      confirmed.add(i);
      return;
    }
    if (!marketsEquivalent(sourceId, headerId)) return;
    const isDeferredMatch = headerId.numericLine === null && sourceId.numericLine !== null;
    if (isDeferredMatch) deferred.add(i);
    else confirmed.add(i);
  });

  // P3-1: exactly one confirmed (lined/exact) candidate alongside one-or-more
  // deferred-only candidates is not ambiguous -- prefer the confirmed one.
  if (confirmed.size === 1 && deferred.size >= 1) {
    return { index: Array.from(confirmed)[0], ambiguous: false };
  }

  const list = Array.from(new Set([...confirmed, ...deferred])).sort((x, y) => x - y);
  if (list.length === 0) return { index: null, ambiguous: false };
  if (list.length > 1) return { index: null, ambiguous: true, matchedIndices: list };
  return { index: list[0], ambiguous: false };
}

module.exports = {
  normalizeText,
  isNoiseHeader,
  inferHandicapArity,
  parseMarketIdentity,
  marketsEquivalent,
  compareResolvedMarketEvidence,
  extractStrictLine,
  enrichWithSelectionLine,
  matchMarketHeader,
  // Reconcile Фаза2 task 5 ("Resolve contract"): exported so the worker can
  // tell whether a market_name's family is a LINE-BEARING one (handicap*/
  // total*/playerTotal) without duplicating a second, driftable family list
  // -- used to gate the split selection/selection_label/expected_line
  // contract's payload-validation requirement (a line-bearing market MUST
  // supply expected_line once selection_label is used).
  SELECTION_ENRICHABLE_FAMILIES,
};
