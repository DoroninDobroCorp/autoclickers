"use strict";

// Pure, browser/localStorage-free helpers for Betfair Sportsbook betslip
// market/runner identity checks (Story 2.2b fix-1, P1 "wrong market"
// finding). Kept dependency-free -- like betfair_sportsbook_button_match.cjs
// -- so the actual matching algorithm (not a reimplementation of it) can be
// unit tested with node:test against synthetic sportsbookBettingState-shaped
// fixtures, including the ambiguous-market and duplicate-selectionId cases
// the cross-family review found untested.

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function eventParticipantsFromUrl(rawUrl) {
  let pathname = "";
  try { pathname = new URL(rawUrl, "https://www.betfair.com").pathname; } catch { return null; }
  const parts = pathname.split("/").filter(Boolean);
  const eventIndex = parts.findIndex((part) => /^e-\d+$/.test(part));
  if (eventIndex < 1) return null;
  let matchSlug = parts[eventIndex - 1];
  try { matchSlug = decodeURIComponent(matchSlug); } catch {}
  const splitAt = matchSlug.indexOf("-v-");
  if (splitAt < 1) return null;
  const tokens = (value) => value.split("-")
    .map((token) => token.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  return {
    home: tokens(matchSlug.slice(0, splitAt)),
    away: tokens(matchSlug.slice(splitAt + 3)),
  };
}

function eventSearchScore(requestedUrl, candidateUrl) {
  const requested = eventParticipantsFromUrl(requestedUrl);
  const candidate = eventParticipantsFromUrl(candidateUrl);
  if (!requested || !candidate) return 0;
  const coverage = (source, target) => {
    if (!source.length || !target.length) return 0;
    const targetSet = new Set(target);
    return source.filter((token) => targetSet.has(token)).length / source.length;
  };
  const direct = coverage(requested.home, candidate.home) + coverage(requested.away, candidate.away);
  const reverse = coverage(requested.home, candidate.away) + coverage(requested.away, candidate.home);
  return Math.max(direct, reverse);
}

// Recursively collects every object in `value` that looks like a betfair
// runner leaf (has both marketId and selectionId). Same DFS-over-Object.values
// traversal the worker used inline before this fix.
function collectRunnerObjects(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "marketId")
      && Object.prototype.hasOwnProperty.call(value, "selectionId")) {
    output.push(value);
  }
  for (const child of Object.values(value)) collectRunnerObjects(child, output, seen);
  return output;
}

// Candidate key names for a human-readable market label on an ancestor of a
// runner leaf. The real sportsbookBettingState schema has never been
// captured raw in this repo (see reference/vovka-localstorage-probes/), so
// this is deliberately best-effort: if none of these keys are found as a
// string anywhere on the path to a runner, `marketNameHint` is null and the
// caller must treat identity as "unknown", never as "confirmed mismatch".
const MARKET_NAME_KEYS = ["marketName", "market", "marketTitle", "name", "title"];

// Recursively collects {runner, marketNameHint} pairs -- marketNameHint is
// the nearest ancestor's market-name-like string field on the path down to
// that runner, or null if none of MARKET_NAME_KEYS was found on any
// ancestor.
function collectRunnerContexts(value, ancestorHint = null, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  let hint = ancestorHint;
  for (const key of MARKET_NAME_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) {
      hint = value[key];
      break;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "marketId")
      && Object.prototype.hasOwnProperty.call(value, "selectionId")) {
    output.push({ runner: value, marketNameHint: hint });
  }
  for (const child of Object.values(value)) collectRunnerContexts(child, hint, output, seen);
  return output;
}

// Suffixes that do not change what the market IS -- e.g. "Match Odds" and
// "Match Odds - Full Time" both mean the plain full-match market, so these
// are stripped before comparison rather than treated as a real qualifier.
const NEUTRAL_MARKET_SUFFIXES = [
  " - full time", " full time", " (full time)",
  " - 90 minutes", " 90 minutes",
  " - regular time", " regular time",
];

function stripNeutralSuffixes(normalized) {
  let result = normalized;
  for (const suffix of NEUTRAL_MARKET_SUFFIXES) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length).trim();
    }
  }
  return result;
}

// Explicit whitelist of full-match market-name synonyms (Story 2.2b fix-2,
// P1). Membership is checked by EXACT normalized-string equality only --
// never substring/includes -- so this can never accidentally swallow a
// period/segment-qualified market name the way the old `includes()` check
// did ("Match Odds" as a substring of "First Half Match Odds").
// Story 2.2b fix-3 (P1): "Handicap Betting" and "Asian Handicap" used to
// share one synonym group, but they do NOT have the same settlement
// semantics -- (European) Handicap Betting can be a three-outcome market
// (draw possible, settled like Match Odds with a virtual goal adjustment)
// while Asian Handicap is always a two-outcome market (no draw; it can
// itself push/void on a quarter line). A hint that only weakly confirmed
// one of these must never be treated as confirming the other -- keeping
// them in separate groups is what makes marketIdentityPlausible() actually
// refuse cross-settlement-type clicks instead of silently allowing them.
// Reconcile Фаза1 task 4: MARKET_SYNONYM_GROUPS is now DERIVED from a
// {family, aliases} registry -- the actual single source of truth --
// instead of being maintained as a bare array-of-arrays. MARKET_SYNONYM_GROUPS
// itself is kept, unchanged in shape, for backward compatibility with the
// string-tier code below and with betfair_sportsbook_market_match.cjs (which
// imports it to derive its own moneyline alias set). The negative invariant
// this registry exists to protect -- Asian Handicap/Spread is NEVER the same
// settlement family as Handicap/Handicap Betting -- is enforced by keeping
// them as separate registry entries, exactly as before.
const MARKET_SYNONYM_REGISTRY = [
  {
    family: "moneyline",
    aliases: [
      "match odds", "moneyline", "money line", "match betting", "match result",
      "to win match", "1x2", "full time result", "full-time result", "3way", "3-way",
    ],
  },
  { family: "handicap_euro", aliases: ["handicap", "handicap betting"] },
  { family: "handicap_asian", aliases: ["asian handicap", "spread"] },
  { family: "double_chance", aliases: ["double chance"] },
  { family: "draw_no_bet", aliases: ["draw no bet", "dnb"] },
  { family: "btts", aliases: ["both teams to score", "btts"] },
];
const MARKET_SYNONYM_GROUPS = MARKET_SYNONYM_REGISTRY.map((entry) => entry.aliases);

function familyForAlias(normalized) {
  const entry = MARKET_SYNONYM_REGISTRY.find((candidate) => candidate.aliases.includes(normalized));
  return entry ? entry.family : null;
}

function findSynonymGroup(normalized) {
  return MARKET_SYNONYM_GROUPS.find((group) => group.includes(normalized)) || null;
}

// Qualifiers that change what market a name refers to even when the base
// wording overlaps -- Story 2.2b fix-2 (P1): substring matching previously
// let "Match Odds" pass as the same market as "First Half Match Odds", and
// "Handicap" as "Corners Handicap". A qualifier present on exactly one side
// is always a mismatch.
const MARKET_PERIOD_QUALIFIERS = [
  "first half", "1st half", "second half", "2nd half", "half time", "halftime",
  "first period", "second period", "third period",
  "1st set", "2nd set", "3rd set", "4th set", "5th set",
  "1st quarter", "2nd quarter", "3rd quarter", "4th quarter", "extra time",
];
const MARKET_SEGMENT_QUALIFIERS = [
  "corners", "cards", "bookings", "throw ins", "throw-ins", "offsides", "shots on target", "fouls",
];
const MARKET_QUALIFIERS = [...MARKET_PERIOD_QUALIFIERS, ...MARKET_SEGMENT_QUALIFIERS];

function qualifierSet(normalized) {
  return new Set(MARKET_QUALIFIERS.filter((q) => normalized.includes(q)));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

// Story 2.5/Reconcile Фаза1 P2-1: betfair_sportsbook_market_match.cjs's
// find-phase (matchMarketHeader) recognizes structural equivalences (half-
// totals, set-winner, "Match Odds 90", "Alternative Game Handicap N", ...)
// that this module's OWN (older, string-tier-only) marketIdentityPlausible
// does not know about. Fix: give marketIdentityPlausible a Tier 2 that runs
// the shared structural parser -- a `require` of market_match.cjs, deferred
// to CALL time (never at module-load time, because market_match.cjs itself
// requires THIS module at ITS top level for MARKET_SYNONYM_GROUPS/PERIOD/
// SEGMENT -- a top-level require here would be a genuine circular load).
let _marketMatchModule = null;
function getMarketMatchModule() {
  if (!_marketMatchModule) {
    _marketMatchModule = require("./betfair_sportsbook_market_match.cjs");
  }
  return _marketMatchModule;
}

// The first numeric handicap/total-line value in the text, if any -- Story
// 2.2b fix-2 (P1): "Handicap -1.5" and "Handicap -2.5" must never be treated
// as the same market just because the non-numeric wording is identical.
function extractNumericLine(normalized) {
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

// The base name with the numeric line removed -- used to canonicalize e.g.
// "Handicap -1.5" and "Handicap Betting -1.5" down to comparable base
// wording ("handicap" / "handicap betting") before checking synonym-group
// membership (Story 2.2b fix-3, P2).
function stripNumericLine(normalized) {
  return normalized.replace(/-?\d+(?:\.\d+)?/, "").replace(/\s+/g, " ").trim();
}

// True when the clicked market header text and a runner's ancestor
// market-name hint plausibly refer to the same market. An absent hint
// (schema doesn't expose one for this runner) is treated as "cannot
// disprove" -- true -- never as a mismatch: a false-closed failure here
// would break every real placement until the real key name is confirmed
// against live traffic, which this repo does not have.
//
// Story 2.2b fix-2 (P1): once a hint IS present, the comparison is strict --
// exact normalized equality (after stripping neutral suffixes), or explicit
// whitelist synonym-group membership, or an identical numeric line AND a
// canonicalized base name in the SAME whitelisted synonym group. The
// previous `includes()` substring fallback is gone entirely: it let "Match
// Odds" pass as "First Half Match Odds" and "Handicap" as "Corners
// Handicap".
//
// Story 2.2b fix-3 (P2): the final "same numeric line" branch used to end in
// an unconditional `return false`, making the line-equality check dead code
// no matter what it found -- every same-line-different-wording pair was
// rejected regardless of whether the base wording was actually the same
// market. Fixed by canonicalizing both sides' base name (numeric line
// stripped) and requiring it to land in the SAME whitelisted synonym group
// (MARKET_SYNONYM_GROUPS, exact-equality membership only) as the other
// side. A base wording that is not a recognized member of any group -- even
// if both sides are textually identical after stripping the line -- is
// treated as "cannot prove same market" and fails closed to false, never a
// bare `return true`.
function marketIdentityPlausible(clickedMarketText, marketNameHint) {
  if (!marketNameHint) return true;
  let clicked = normalizeText(clickedMarketText);
  let hint = normalizeText(marketNameHint);
  if (!clicked || !hint) return true;

  clicked = stripNeutralSuffixes(clicked);
  hint = stripNeutralSuffixes(hint);
  if (clicked === hint) return true;

  const clickedGroup = findSynonymGroup(clicked);
  if (clickedGroup && clickedGroup.includes(hint)) return true;

  // Reconcile Фаза1 task 5 (spec-A "Направленность Tier2" money-safety fix):
  // Tier 2 uses compareResolvedMarketEvidence -- a DISTINCT, explicitly
  // directional post-click comparator (clicked-header is authoritative,
  // runner-hint is secondary/weaker corroboration) -- NEVER the generic,
  // FIND-phase marketsEquivalent(source, header) predicate. The two were
  // conflated in an earlier draft of this merge (calling
  // marketsEquivalent(clickedId, hintId) directly): that happened to produce
  // a safe answer for the audited example pairs, but its safety was never
  // independently provable from the verify side, and a future change to the
  // FIND-phase's one-directional line-deferral semantics could have silently
  // changed post-click verification behaviour since both call sites would
  // have shared one function. See betfair_sportsbook_market_match.cjs's
  // compareResolvedMarketEvidence doc comment for the full reasoning.
  const { parseMarketIdentity, compareResolvedMarketEvidence } = getMarketMatchModule();
  const clickedId = parseMarketIdentity(clicked);
  const hintId = parseMarketIdentity(hint);
  if (compareResolvedMarketEvidence(clickedId, hintId)) return true;

  if (!sameSet(qualifierSet(clicked), qualifierSet(hint))) return false;

  const clickedLine = extractNumericLine(clicked);
  const hintLine = extractNumericLine(hint);
  if (!clickedLine || !hintLine || clickedLine !== hintLine) return false;

  const clickedBase = stripNumericLine(clicked);
  const hintBase = stripNumericLine(hint);
  const baseGroup = findSynonymGroup(clickedBase);
  if (!baseGroup || !baseGroup.includes(hintBase)) return false;

  return true;
}

// Indices of ALL header texts that normalize to one of `fallbacks`. The
// caller must fail closed when this returns more than one match instead of
// silently taking the first (Story 2.2b P1: "резолвер берёт первый
// совпавший market header, не отклоняя несколько одинаковых").
function marketNameFallbacks(marketName, selection = "") {
  const target = normalizeText(marketName);
  const wanted = new Set([target]);
  const add = (...values) => values.filter(Boolean).forEach((value) => wanted.add(normalizeText(value)));

  if (["match odds", "moneyline", "match betting", "match result", "money line", "to win match"].includes(target)) {
    add("match odds", "moneyline", "match betting", "match result", "money line", "to win match");
  } else if (target.includes("handicap")) {
    add(target.replace("handicap", "handicap betting"), target.replace("handicap betting", "handicap"));
  }

  let match = target.match(/^over\/under\s+([0-9.]+)\s+goals$/);
  if (match) add(`over/under total goals ${match[1]}`, `over/under ${match[1]} goals`);
  match = target.match(/^over\/under\s+total\s+goals\s+([0-9.]+)$/);
  if (match) add(`over/under ${match[1]} goals`, `over/under total goals ${match[1]}`);

  match = target.match(/^(?:1st|first) half over\/under ([0-9.]+) goals$/);
  if (match) add(
    `first half goals ${match[1]}`,
    `over/under first half ${match[1]}`,
    `first half total goals ${match[1]}`
  );
  match = target.match(/^first half goals ([0-9.]+)$/);
  if (match) add(
    `1st half over/under ${match[1]} goals`,
    `over/under first half ${match[1]}`,
    `first half total goals ${match[1]}`
  );
  match = target.match(/^(?:2nd|second) half over\/under ([0-9.]+) goals$/);
  if (match) add(
    `second half goals ${match[1]}`,
    `over/under second half ${match[1]}`,
    `second half total goals ${match[1]}`
  );
  match = target.match(/^second half goals ([0-9.]+)$/);
  if (match) add(
    `2nd half over/under ${match[1]} goals`,
    `over/under second half ${match[1]}`,
    `second half total goals ${match[1]}`
  );

  match = target.match(/^to win (\d+)(?:st|nd|rd|th) set$/);
  if (match) add(`set ${match[1]} winner`, `${match[1]}st set winner`);
  match = target.match(/^set (\d+) winner$/);
  if (match) add(`to win ${match[1]}st set`, `${match[1]}st set winner`);

  const lineMatch = normalizeText(selection).match(/[+-]?\d+(?:\.\d+)?/);
  const line = lineMatch ? String(Math.abs(Number(lineMatch[0]))) : "";
  if (line && target === "match total games") {
    add(`match total games ${line}`, `total match games ${line}`, `total games ${line}`);
  }
  if (line && target === "game handicap") add(`game handicap ${line}`);
  match = target.match(/^set (\d+) total games over\/under ([0-9.]+)$/);
  if (match) add(`set ${match[1]} total games ${match[2]}`);

  return [...wanted];
}


function findExactMarketHeaderIndices(headerTexts, fallbacks) {
  const wanted = new Set((fallbacks || []).map(normalizeText));
  const indices = [];
  (headerTexts || []).forEach((text, i) => {
    if (wanted.has(normalizeText(text))) indices.push(i);
  });
  return indices;
}

function runnerKey(runner) {
  return `${runner && runner.marketId}:${runner && runner.selectionId}`;
}

// Runners present in `afterRunners` but absent (by marketId:selectionId) from
// `beforeRunners`, further filtered to the wanted selectionId. Story 2.2b
// P1: the original readMatchingRunner filtered the WHOLE betslip state by
// selectionId only -- a stale leftover runner from an earlier action (if
// resetBetslip ever left one) could satisfy the "exactly one match" check
// even though it was never produced by the click just made.
function selectFreshMatchingRunners(beforeRunners, afterRunners, selectionId) {
  const beforeKeys = new Set((beforeRunners || []).map(runnerKey));
  const fresh = (afterRunners || []).filter((runner) => !beforeKeys.has(runnerKey(runner)));
  return fresh.filter((runner) => String(runner.selectionId) === String(selectionId));
}

// Reconcile Фаза2 (spec-B "Строгий numeric parser" money-risk item 6): a
// shared "is this actually a usable number" test for handicapPlausible AND
// the all-blind line-verification guard below. `Number("")` coerces to `0`
// -- FINITE -- so a naive `Number.isFinite(Number(x))` check would treat a
// blank/garbage/whitespace runner.handicap field as if it had confirmed a
// real line of 0, which is exactly backwards when expectedLine is itself 0
// (a pick'em/scratch line): a genuinely empty field must count as NO
// signal, never as "confirms zero". Only an actual finite number, or a
// string that (after trimming) is a plain signed/unsigned decimal, counts
// as usable; "", whitespace, booleans, hex ("0x10") and other garbage do
// not.
function isUsableNumeric(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (!/^[-+]?\d+(?:[.,]\d+)?$/.test(trimmed)) return false;
    return Number.isFinite(Number(trimmed.replace(",", ".")));
  }
  return false;
}

// Story 2.4 (AC-5): the live diagnosis (2026-07-15) confirmed the runner
// schema exposes a `handicap` field -- but ALSO confirmed it can be `null`
// even for a genuine Game Handicap runner (the diagnosed dump: selectionId
// 65047966, "James Kent Trotter (+4.5)", had `"handicap": null`). Absence
// (null/undefined) must therefore still be treated as "no signal" -- the
// same fail-open the pre-2.4 code applied to a missing marketNameHint --
// never as a mismatch. Only an ACTUAL numeric contradiction (the field IS
// present and DISAGREES with the expected line) now fails closed, so this
// hardens the check strictly on top of the previous unconditional fail-open:
// it can only ever catch MORE bad clicks, never reject a good one that would
// have passed before.
//
// Reconcile Фаза2 fix (spec-B item 6): "no signal" is now determined by
// isUsableNumeric() rather than a bare null/undefined + Number.isFinite
// check -- closes the `Number("") === 0` gap described in that helper's own
// doc comment (a blank/garbage handicap field could otherwise be
// misread as a confirmed line of exactly 0).
function handicapPlausible(expectedLine, runnerHandicap) {
  if (expectedLine === null || expectedLine === undefined) return true;
  if (!isUsableNumeric(runnerHandicap)) return true;
  const numeric = Number(String(runnerHandicap).replace(",", "."));
  return Math.abs(numeric - expectedLine) < 0.001;
}

// Reconcile Фаза2 (spec-B "Что взять из MINE" / all-blind rejection, ported
// from the independent MINE implementation, /tmp/reconcile/mine-betfair_
// sportsbook_basket_worker.cjs.diff): Story 2.5's lineCheckPasses() lets an
// UNLINED betfair market header (e.g. real basketball "Handicap Betting", no
// line in the header text) match a LINED forted source, on the
// understanding that the line gets independently re-verified DOWNSTREAM at
// the runner level once the click resolves an actual runner
// (handicapPlausible above / canonicalOutcomeKey's own-text line in
// betfair_sportsbook_selection_match.cjs). That promise silently breaks in
// one confirmed-live combination: selectionId 65047966 ("James Kent Trotter
// (+4.5)") had `runner.handicap: null` even for a genuine handicap runner --
// handicapPlausible therefore fails OPEN (true) on it, by design (Story
// 2.4). If the CLICKED NAME/LINE BUTTON *also* rendered with no line of its
// own (canonicalOutcomeKey's `lineFromText === false`), then NONE of the
// three signals that could have confirmed the line -- header text, button
// text, runner.handicap -- ever actually did. The bet would go on whatever
// runner freshly appeared, with its line taken entirely on faith.
//
// This predicate is true exactly in that narrow all-three-blind combination
// (the caller must ALSO independently confirm runner.handicap is unusable
// via isUsableNumeric before treating this as a reject -- this function only
// knows about the header/button signals). It can only ever ADD a new
// fail-closed case on top of the existing handicapPlausible fail-open -- it
// never fires (returns false) when expectedLine is null (no line was ever
// expected, e.g. Moneyline) or when either the header or the button DID
// commit to an explicit line, so it cannot reject any placement that was
// already independently verified by an earlier layer.
function lineVerificationRequired({ expectedLine, headerHasExplicitLine, buttonHasExplicitLine }) {
  if (expectedLine === null || expectedLine === undefined) return false;
  if (headerHasExplicitLine) return false;
  if (buttonHasExplicitLine) return false;
  return true;
}

module.exports = {
  normalizeText,
  eventParticipantsFromUrl,
  eventSearchScore,
  collectRunnerObjects,
  collectRunnerContexts,
  marketIdentityPlausible,
  handicapPlausible,
  isUsableNumeric,
  lineVerificationRequired,
  marketNameFallbacks,
  findExactMarketHeaderIndices,
  runnerKey,
  selectFreshMatchingRunners,
  MARKET_NAME_KEYS,
  // Reconcile Фаза1 task 4: exported so betfair_sportsbook_market_match.cjs
  // can reuse the SAME period/segment qualifier lists and settlement-family
  // registry instead of maintaining a second, driftable copy --
  // MARKET_SYNONYM_REGISTRY (and its derived MARKET_SYNONYM_GROUPS) is the
  // single source of truth for which market-name wordings belong to the same
  // settlement family (Story 2.2b fix-3 / Фаза1 task 4).
  MARKET_SYNONYM_REGISTRY,
  MARKET_SYNONYM_GROUPS,
  familyForAlias,
  MARKET_PERIOD_QUALIFIERS,
  MARKET_SEGMENT_QUALIFIERS,
};
