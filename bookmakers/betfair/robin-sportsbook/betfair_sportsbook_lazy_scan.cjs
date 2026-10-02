"use strict";

// Reconcile regress1 P1-1 (money-critical, final cross-family audit fix):
// pure (Playwright-free) accumulation helper for the DOM `/basket`
// lazy-scroll market scan (clickExactSelection in
// betfair_sportsbook_basket_worker.cjs).
//
// The bug this closes: the OLD scan loop broke out as soon as ANY single
// viewport snapshot produced an exactly-one match via matchMarketHeader --
// it never proved that match was unique across the WHOLE lazily-rendered
// list. Betfair renders long all-markets lists lazily; a later, not-yet-
// rendered viewport can hold an identity-duplicate market (same header
// text, a DIFFERENT underlying market/DOM node -- Paddy/Betfair share
// selection_id across different market_ids) that would make the true
// page-wide answer ambiguous. Stopping at the first viewport's "exactly
// one" therefore does not prove global exactly-one, and a wrong same-named
// duplicate could be placed on live.
//
// The fix requires an EXHAUSTIVE scan (scroll to the true end before any
// match/ambiguity decision) whose results are merged by STABLE PER-NODE
// IDENTITY, not by header text: two different rounds seeing the SAME
// physical DOM node (recognized by a scan-id tag set once, on first sight,
// via a dataset attribute -- see clickExactSelection) must count as ONE
// candidate; two DIFFERENT nodes that happen to render IDENTICAL text (a
// genuine duplicate market) must count as TWO. A plain `Set<headerText>`
// (VOVKA's original `seenHeaders`) cannot make this distinction -- it
// collapses real duplicates into one, which is exactly the bug.
//
// `rounds` is an array (one entry per scroll/viewport scan) of arrays of
// `{ scanId, text }` rows (scanId: a stable, non-empty string identifying
// the DOM node; text: its innerText at the time it was read). Returns the
// deduped candidates in FIRST-SEEN order, ready to feed straight into
// matchMarketHeader (betfair_sportsbook_market_match.cjs) as the
// `headerTexts` array -- `scanIds[i]` is what the caller re-locates in the
// live DOM to click index `i`.
function mergeLazyScanRounds(rounds) {
  const scanIds = [];
  const texts = [];
  const seen = new Set();
  (rounds || []).forEach((round) => {
    (round || []).forEach((row) => {
      const scanId = row && row.scanId;
      if (!scanId || seen.has(scanId)) return;
      seen.add(scanId);
      scanIds.push(scanId);
      texts.push((row && row.text) || "");
    });
  });
  return { scanIds, texts };
}

// Convenience wrapper: merges the rounds, then applies matchMarketHeader
// (imported by the caller, not re-required here, to keep this module
// dependency-light and avoid a circular require) to the merged candidate
// set. Exposed separately so a caller that already has matchMarketHeader in
// scope can pass it in without this module depending on Playwright-adjacent
// modules at all.
function resolveLazyScanMatch(matchMarketHeaderFn, marketName, rounds, options) {
  const { scanIds, texts } = mergeLazyScanRounds(rounds);
  const matchResult = matchMarketHeaderFn(marketName, texts, options);
  return { ...matchResult, scanIds, texts };
}

// Reconcile regress2 P1 (money-critical, both final-audit reviewers
// CONFIRMED): pure fail-closed gate for the round-capped exhaustive scan in
// clickExactSelection (betfair_sportsbook_basket_worker.cjs). The scan loop
// there stops for one of two reasons: (a) scrollLazyMarketList genuinely
// reported no further movement -- the real end of the lazily-rendered list
// -- or (b) the hard 64-round cap was hit while the list was STILL moving.
// Only (a) proves the scan is exhaustive; the OLD code treated both the same
// way (fell out of the `for` loop either way) and let everything downstream
// silently match against a PARTIAL scan as if it were the complete,
// page-wide answer -- defeating the entire point of the exhaustive-scan fix
// this module's mergeLazyScanRounds/resolveLazyScanMatch implement (see
// their own doc comment): a duplicate market sitting in the unscanned tail
// could go undetected. `reachedEnd` must be exactly the boolean the caller's
// loop set to true ONLY on the `!moved` break -- this function does not (and
// cannot, being Playwright-free) re-derive it; it only enforces that a
// `false` value is never silently allowed to proceed.
function assertScanReachedEnd(reachedEnd, marketName) {
  if (!reachedEnd) {
    throw new Error(
      `Market list scan hit the 64-round cap without reaching the end (list still scrolling) -- refusing to match on a partial scan: ${marketName}`
    );
  }
}

module.exports = {
  mergeLazyScanRounds,
  resolveLazyScanMatch,
  assertScanReachedEnd,
};
