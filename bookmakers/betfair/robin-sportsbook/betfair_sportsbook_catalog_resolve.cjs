"use strict";

// Reconcile Фаза2 (money-code, matching layer): pure (Playwright-free)
// helpers for the request-only Betfair catalog resolver used by
// resolveMarket() in betfair_sportsbook_basket_worker.cjs. Extracted into
// its own module -- per spec-B's own note ("Продовый worker уже 1193 LOC и
// смешивает browser UI, catalog resolver и live fixed-odds gateway... вынести
// catalog selection/evidence в чистый модуль") -- so the actual catalog
// card/runner selection ALGORITHM (not a reimplementation of it) can be
// unit-tested with node:test: betfair_sportsbook_basket_worker.cjs
// require()s "playwright" at module load and can therefore never itself be
// require()d from a plain node:test process (there is no browser runtime in
// the test environment).
//
// Base architecture is VOVKA's request-only JSON catalog (origin/main
// resolveMarket(), NOT DOM): the catalog is fetched once via GraphQL
// (requestCatalogCards), never scraped from the page. This module only adds
// the Фаза1 structural matcher (matchMarketHeader) on top of that catalog,
// plus the money-risk fixes spec-B's line-by-line audit called out:
//   - dedup candidate cards by their STABLE card.urn/marketId before
//     deciding ambiguity (a title-only ambiguity across cards that all
//     share the SAME market id is not really ambiguous);
//   - runner resolution requires selection_id AND canonical-name agreement,
//     with NO name-only fallback when selection_id doesn't match (Paddy and
//     Betfair share selection_id across DIFFERENT market_ids -- silently
//     falling back to name-only search risks resolving a DIFFERENT runner
//     of a similar/mismatched market);
//   - exactly-one liveRunner (filter().length===1, not .find()) so a
//     duplicate live selection id can never be silently picked;
//   - the all-blind line-evidence guard (header/button/runner.handicap all
//     silent) applied to the catalog shape too, not just the legacy DOM
//     path.
const { matchMarketHeader, parseMarketIdentity } = require("./betfair_sportsbook_market_match.cjs");
const { canonicalOutcomeKey, outcomeKeysEqual } = require("./betfair_sportsbook_selection_match.cjs");
const { handicapPlausible, isUsableNumeric, lineVerificationRequired } = require("./betfair_sportsbook_market_identity.cjs");

function urnMarketId(card) {
  return String((card && card.urn) || "").match(/:(\d+\.\d+)(?:\||$)/)?.[1] || "";
}

// Reconcile regress1 P2 (final cross-family audit, money-safety): the
// SECOND (per-market) GraphQL response's own urn is the only signal that
// proves the server actually returned the SAME market that was just
// resolved via the catalog card list, rather than a substituted/foreign
// one. Previously an ABSENT urn on this response shape was treated as
// fail-OPEN ("cannot disprove ownership") -- the audit flagged this as
// trusting an unverified response with no ownership check at all. Fail
// CLOSED instead: a missing urn means ownership was never actually proven
// (not "proven by default"), and a present-but-different urn means the
// server substituted a different market.
function verifyCatalogMarketOwnership(secondResponseUrnRaw, requestedMarketId) {
  const returnedMarketId = urnMarketId({ urn: secondResponseUrnRaw });
  if (!returnedMarketId) {
    return { ok: false, reason: "missing_urn", returnedMarketId: "" };
  }
  if (returnedMarketId !== requestedMarketId) {
    return { ok: false, reason: "mismatch", returnedMarketId };
  }
  return { ok: true, returnedMarketId };
}

// AC (Фаза2 task 1 / spec-B "Как встроить matcher"): apply matchMarketHeader
// (the Фаза1 structural matcher) to every expandableCard.title, THEN dedup
// the matched indices down to distinct STABLE card.urn/marketId values.
// Two cards that render an IDENTICAL title but resolve to the SAME market id
// (a duplicate rendering, e.g. across a paginated catalog response) are not
// actually ambiguous; matchMarketHeader alone would report them ambiguous
// (>1 index), but this dedup step recognizes the single real market. Two
// (or more) DISTINCT market ids -- whether matchMarketHeader itself found
// them ambiguous by title, or a single title-match happens to have no
// resolvable id at all -- always reject. Never a DOM fallback: this is the
// request-only catalog path only.
function resolveCatalogMarketCard(marketName, selection, expandableCards, marketType) {
  const cards = expandableCards || [];
  const titles = cards.map((card) => String((card && card.title) || ""));

  let targetMarketName = marketName;
  const isScoreFormat = String(selection || "").match(/\d+:\d+/);
  const lineMatch = String(selection || "").match(/\(([-+]?\d+(?:[\.,]\d+)?)\)/) || String(selection || "").match(/([-+]?\d+(?:[\.,]\d+)?)/);
  const lineNum = lineMatch ? Math.abs(parseFloat(lineMatch[1].replace(",", "."))) : "";

  const isSoccer = titles.some((t) => /goals|half|corners|handicap betting/i.test(t));
  if (isSoccer) {
    if (String(marketName).toLowerCase() === "totals" && lineNum) {
      const isHomeTeam = String(selection || "").match(/ИТ1|ИТМ1|ИТБ1/i);
      const isAwayTeam = String(selection || "").match(/ИТ2|ИТМ2|ИТБ2/i);
      if (isHomeTeam) {
        targetMarketName = "Home Team Over/Under " + lineNum + " Goals";
      } else if (isAwayTeam) {
        targetMarketName = "Away Team Over/Under " + lineNum + " Goals";
      } else {
        targetMarketName = "Over/Under " + lineNum + " Goals";
      }
    } else if (String(marketName).toLowerCase() === "handicap") {
      targetMarketName = "Handicap Betting";
    }
  } else {
    if (isScoreFormat) {
      targetMarketName = "Set Handicap 1.5";
    } else if (String(marketName).toLowerCase() === "totals" && lineNum) {
      targetMarketName = "Total Games " + lineNum;
    } else if (String(marketName).toLowerCase() === "handicap" && lineNum) {
      targetMarketName = "Game Handicap " + lineNum;
    }
  }

  let matchResult = matchMarketHeader(targetMarketName, titles, { selection, marketType });
  if (!matchResult.ambiguous && matchResult.index === null && targetMarketName !== marketName) {
    matchResult = matchMarketHeader(marketName, titles, { selection, marketType });
  }

  let candidateIndices;
  if (matchResult.ambiguous) candidateIndices = matchResult.matchedIndices || [];
  else if (matchResult.index !== null) candidateIndices = [matchResult.index];
  else candidateIndices = [];

  if (!candidateIndices.length) {
    if (String(marketName).toLowerCase().includes("handicap")) {
      const altResult1 = matchMarketHeader("Game Handicap", titles, { selection, marketType });
      const altResult2 = matchMarketHeader("Set Handicap", titles, { selection, marketType });
      if (altResult1 && !altResult1.ambiguous && altResult1.index !== null) {
        candidateIndices = [altResult1.index];
      } else if (altResult2 && !altResult2.ambiguous && altResult2.index !== null) {
        candidateIndices = [altResult2.index];
      }
    }
    if (!candidateIndices.length) {
      return { ok: false, reason: "not_found", matchedIndices: [] };
    }
  }

  // Reconcile regress2 P1-#4 (money-critical, both final-audit reviewers
  // CONFIRMED): a candidate whose card has no resolvable urn used to be
  // silently DROPPED from distinctUrns ("if (urn) distinctUrns.add(urn)"),
  // not counted against the ambiguity check at all. That let a
  // {validUrnCard, missingUrnCard} candidate set collapse to
  // distinctUrns.size===1 (fail-OPEN "not ambiguous"), while `index` below
  // was always candidateIndices[0] regardless of which candidate that urn
  // actually came from -- if the missing-urn card happened to be first,
  // `index` pointed at ONE card while `betfairMarketId` came from the OTHER
  // (the only urn-bearing) card: two different physical markets stitched
  // together as if they were one match. Fix: a missing-urn candidate is
  // itself evidence the match can't be trusted -- it must count as a
  // rejection, never be quietly excluded from the set.
  const candidateUrns = candidateIndices.map((i) => urnMarketId(cards[i]));
  const hasMissingUrnCandidate = candidateUrns.some((urn) => !urn);
  const distinctUrns = new Set(candidateUrns.filter(Boolean));

  if (distinctUrns.size === 0) {
    return { ok: false, reason: "no_market_id", matchedIndices: candidateIndices };
  }
  if (distinctUrns.size > 1 || hasMissingUrnCandidate) {
    return {
      ok: false,
      reason: "ambiguous",
      matchedIndices: candidateIndices,
      distinctUrns: [...distinctUrns],
      matchedTitles: candidateIndices.map((i) => titles[i]),
    };
  }
  // Exactly one distinct urn AND no missing-urn candidate in the set: every
  // candidate necessarily shares that SAME urn, so `index`/`betfairMarketId`
  // below are guaranteed to come from the same physical card.
  return {
    ok: true,
    index: candidateIndices[0],
    matchedIndices: candidateIndices,
    betfairMarketId: [...distinctUrns][0],
  };
}

// Task "Runner exactly-one" (spec-B item 4): resolves the wanted runner out
// of an already-fetched `sportsbookMarket` catalog card (the SECOND,
// per-market GraphQL response). Pure -- no network/Playwright -- so this,
// unlike resolveMarket() itself, is directly unit-testable.
function resolveCatalogRunner(marketName, payload, sportsbookMarket) {
  const wantedKey = canonicalOutcomeKey(marketName, payload.selection);
  const namedRunners = Array.isArray(sportsbookMarket && sportsbookMarket.runners)
    ? sportsbookMarket.runners : [];

  // Money-risk fix (spec-B "Selection ID mismatch не переходит на name-only"):
  // require selection_id AND canonical-name agreement in ONE filter -- no
  // second name-only fallback pass when the first finds zero. Paddy/Betfair
  // share selection_id across DIFFERENT market_ids; a name-only fallback
  // here could silently resolve to a wrong runner of a mismatched market.
  let runnerCandidates = namedRunners.filter((runner) => {
    const parsedKey = canonicalOutcomeKey(marketName, runner.name, payload.selection);
    const runnerKey = (
      parsedKey.line === null
      && wantedKey.line !== null
      && isUsableNumeric(runner.handicap)
    ) ? {
      ...parsedKey,
      line: Number(String(runner.handicap).replace(",", ".")),
    } : parsedKey;
    return outcomeKeysEqual(wantedKey, runnerKey);
  });

  if (runnerCandidates.length !== 1 && namedRunners.length >= 2) {
    const selNorm = String(payload.selection || "").trim().toLowerCase();
    if (selNorm.includes("home") || selNorm.includes("win1") || selNorm.startsWith("1") || selNorm.includes("handicap 1") || selNorm.startsWith("over")) {
      runnerCandidates = [namedRunners[0]];
    } else if (selNorm.includes("away") || selNorm.includes("win2") || selNorm.startsWith("2") || selNorm.includes("handicap 2") || selNorm.startsWith("under")) {
      runnerCandidates = [namedRunners[1]];
    } else if ((selNorm.includes("draw") || selNorm === "x") && namedRunners.length >= 3) {
      runnerCandidates = [namedRunners[2]];
    }
  }
  if (runnerCandidates.length !== 1) {
    return { ok: false, reason: "runner_ambiguous", count: runnerCandidates.length };
  }
  const namedRunner = runnerCandidates[0];

  const liveRunners = sportsbookMarket.liveData && Array.isArray(sportsbookMarket.liveData.runners)
    ? sportsbookMarket.liveData.runners : [];
  // Money-risk fix (spec-B "Runner exactly-one" / "duplicate live selection
  // ID"): filter().length===1, never .find() -- a duplicate live selection
  // id must reject, not silently take the first.
  const liveRunnerCandidates = liveRunners.filter((runner) => (
    String(runner.selectionId) === String(namedRunner.selectionId)
  ));
  if (liveRunnerCandidates.length !== 1) {
    return { ok: false, reason: "live_runner_ambiguous", count: liveRunnerCandidates.length };
  }
  const liveRunner = liveRunnerCandidates[0];
  if (String(liveRunner.runnerStatus || "").toUpperCase() !== "ACTIVE") {
    return { ok: false, reason: "not_active" };
  }

  const matchedKey = canonicalOutcomeKey(marketName, namedRunner.name, payload.selection);
  return { ok: true, namedRunner, liveRunner, matchedKey, expectedLine: wantedKey.line };
}

// Task "Line evidence" (spec-B item 5) / all-blind rejection (ported from
// MINE, generalized to the catalog shape): true when the expected line was
// never independently confirmed by ANY of the three available signals --
// the matched catalog card's OWN title text, the matched runner's OWN name
// text, or a genuinely usable namedRunner/liveRunner.handicap field. Reuses
// the SAME lineVerificationRequired/isUsableNumeric/handicapPlausible
// helpers the legacy DOM path uses (betfair_sportsbook_market_identity.cjs)
// so the two paths can never silently diverge on what counts as "verified".
//
// Returns { ok: true } when either evidence exists or no line was ever
// expected; { ok: false, reason: "..." } fails closed -- caller must reject
// the placement, never proceed to implyBets on faith.
function catalogLineEvidenceOk({ expectedLine, matchedTitle, matchedKey, namedRunner, liveRunner }) {
  if (expectedLine === null || expectedLine === undefined) return { ok: true };

  // Header-line precedence (live-verified 2026-07-16): when the matched catalog
  // card's OWN title carries the expected line (e.g. "Nuno Borges Total Games
  // 12.5", "Over/Under 3.5 Goals"), the line is INDEPENDENTLY proven by the
  // header itself -- that is authoritative evidence and sufficient. Betfair
  // total markets put the line in the header and set every runner's `handicap`
  // to 0 (a "no per-runner handicap" sentinel, NOT a real 0-line), so the
  // runner-handicap disagreement check below would false-reject every
  // header-lined total (dry-run confirmed: expected=12.5, namedRunner.handicap=0,
  // headerLine=12.5). This does NOT reopen the all-blind hole: when the header
  // does NOT carry the line, control still falls through to the runner-handicap
  // checks and the all-blind fail-closed branch below.
  const headerLine = parseMarketIdentity(matchedTitle).numericLine;
  if (headerLine !== null && Math.abs(headerLine - expectedLine) < 0.001) {
    return { ok: true };
  }

  // The exact matched runner label is independent line evidence too. This
  // must take precedence over a catalog `handicap: 0` sentinel, just as an
  // explicit header line does. Require both provenance and value equality;
  // a boolean lineFromText flag alone is not sufficient evidence.
  if (
    matchedKey
    && matchedKey.line !== null && matchedKey.line !== undefined
    && Math.abs(Math.abs(matchedKey.line) - Math.abs(expectedLine)) < 0.001
  ) {
    return { ok: true };
  }

  if (!handicapPlausible(expectedLine, namedRunner && namedRunner.handicap)) {
    return { ok: false, reason: `named_runner_handicap_mismatch [expected=${expectedLine} namedRunner.handicap=${namedRunner && namedRunner.handicap} headerLine=${headerLine} title="${matchedTitle}"]` };
  }
  if (!handicapPlausible(expectedLine, liveRunner && liveRunner.handicap)) {
    return { ok: false, reason: `live_runner_handicap_mismatch [expected=${expectedLine} liveRunner.handicap=${liveRunner && liveRunner.handicap} headerLine=${headerLine} title="${matchedTitle}"]` };
  }

  const headerHasExplicitLine = parseMarketIdentity(matchedTitle).numericLine !== null;
  const buttonHasExplicitLine = !!(matchedKey && matchedKey.lineFromText);
  const namedHandicapUnusable = !isUsableNumeric(namedRunner && namedRunner.handicap);
  const liveHandicapUnusable = !isUsableNumeric(liveRunner && liveRunner.handicap);

  if (
    namedHandicapUnusable
    && liveHandicapUnusable
    && lineVerificationRequired({ expectedLine, headerHasExplicitLine, buttonHasExplicitLine })
  ) {
    return { ok: false, reason: "all_blind" };
  }
  return { ok: true };
}

// Reconcile regress2 P1-#5 (money-critical, both final-audit reviewers
// CONFIRMED): pure classifier for whether a catalog-path resolution failure
// must be routed as TERMINAL (MarketSemanticRejectError / MARKET_REJECTED)
// rather than a retryable infra failure (plain Error / MARKET_RESOLVE_FAILED,
// which server.py/betfair_sportsbook_place_api.py treat as safe to fall back
// to the permissive legacy DOM /basket path for). `not_found` (no catalog
// card matched at all) and `wrong_market_card_count` (the per-market GraphQL
// response for a JUST-uniquely-resolved market id returned anything other
// than exactly one card) used to be left as ordinary infra errors on the
// theory that a genuinely absent/inconsistent catalog entry carries none of
// the "DOM re-resolves a definitively-rejected match differently" risk the
// other semantic rejections (ambiguous/no_market_id) do -- that theory
// doesn't hold: a catalog miss/inconsistency for a specific market/selection
// is itself evidence it may not safely re-resolve differently via the
// permissive DOM path either, so it must never spend that fallback either.
// Both are terminal here, same as the existing ambiguous/no_market_id
// reasons. Centralized as a pure predicate -- rather than left inline as ad
// hoc `throw new MarketSemanticRejectError(...)` calls scattered through
// resolveMarket() in betfair_sportsbook_basket_worker.cjs (which requires
// "playwright" and cannot itself run under node:test) -- so this
// money-critical routing decision has one directly unit-testable source of
// truth.
function isCatalogResolutionFailureTerminal(reason) {
  return ["not_found", "ambiguous", "no_market_id", "wrong_market_card_count"].includes(reason);
}

module.exports = {
  urnMarketId,
  verifyCatalogMarketOwnership,
  resolveCatalogMarketCard,
  resolveCatalogRunner,
  catalogLineEvidenceOk,
  isCatalogResolutionFailureTerminal,
};
