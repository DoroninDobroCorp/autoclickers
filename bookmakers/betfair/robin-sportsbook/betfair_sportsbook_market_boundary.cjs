"use strict";

// Pure, DOM-shape-only helper for the "climb from a market header to find its
// unique selection button" step of clickExactSelection() in
// betfair_sportsbook_basket_worker.cjs (Story 2.2b fix-3, P1 "DOM boundary
// climb doesn't match candidate selector"). Kept dependency-free -- like
// betfair_sportsbook_market_identity.cjs / betfair_sportsbook_button_match.cjs
// -- so the ACTUAL climb algorithm (not a reimplementation of it) can be
// unit tested with node:test against a synthetic fake-DOM tree, and also
// passed as-is into Playwright's evaluateHandle() to run for real in the
// browser: climbToMarketContainer() only touches its own arguments
// (node.parentElement, current.querySelectorAll(), .contains(), .innerText,
// .getAttribute()) -- it never closes over anything from the outer module
// scope, so its source is safe to serialize into the page.
//
// The bug this fixes: the candidate market-header selector (used to find
// ALL market containers on the page) included `.accordion` and
// `.market-accordion`, but the climb-boundary selector used to decide when
// the upward walk has left the current market's container did NOT -- so if
// a market's ONLY header-shaped element was its `.accordion`/
// `.market-accordion` wrapper itself (no separate h2/h3/.market-title child),
// climbing past a COLLAPSED target market's own container failed to detect
// a neighboring EXPANDED market's container as "another market header", let
// the walk continue into the shared ancestor, and could return the
// neighbor's uniquely-named button as if it belonged to the target market.
// Fix: both the candidate selector and the climb-boundary selector are now
// the exact same string (MARKET_CONTAINER_SELECTOR) -- any element that can
// serve as a market candidate also stops the climb.
const MARKET_CONTAINER_SELECTOR =
  "h2, h3, .accordion, .market-accordion, .market-title, .market-header, " +
  ".accordion__header, .accordion-header, .market-header__title, .accordion-trigger";

// `node` is the market header element the caller already unambiguously
// resolved (via findExactMarketHeaderIndices). `arg.wanted` is the runner
// selection text to find; `arg.headerSelector` is the market-container
// selector used both to enumerate candidates AND to stop the climb --
// callers must pass MARKET_CONTAINER_SELECTOR so the two never drift apart.
function climbToMarketContainer(node, arg) {
  const wanted = arg.wanted;
  const headerSelector = arg.headerSelector;
  const clean = (val) => String(val || "").replace(/,/g, ".").replace(/\s+/g, " ").replace(/[()]/g, "").replace(/([+-])\s+/g, "$1").trim().toLowerCase().replace(/\s+-\s+/g, " -");
  const extractLineNum = (str) => {
    const m = String(str || "").match(/(?:over|under|yes|no|[+-])\s*([+-]?\d+(?:\.\d+)?)/i) || String(str || "").match(/\b(\d+(?:\.\d+)?)\b/);
    return m ? parseFloat(m[1]) : null;
  };
  const isWantedButton = (button) => {
    const rawText = clean(button.innerText || button.getAttribute("aria-label"));
    const text = rawText.replace(/\s+(?:\d+(?:\.\d+)?|\d+\/\d+)$/, "");
    const want = clean(wanted);
    if (text === want || text.startsWith(want + " ") || rawText === want || rawText.startsWith(want + " ")) return true;
    
    const wantLine = extractLineNum(want);
    const rawLine = extractLineNum(rawText);
    if (wantLine !== null && rawLine !== null && Math.abs(wantLine - rawLine) > 1e-5) {
      return false;
    }

    if ((want.startsWith("over ") || want === "over") && (text === "over" || rawText === "over")) {
      return wantLine === null || rawLine === null || Math.abs(wantLine - rawLine) < 1e-5;
    }
    if ((want.startsWith("under ") || want === "under") && (text === "under" || rawText === "under")) {
      return wantLine === null || rawLine === null || Math.abs(wantLine - rawLine) < 1e-5;
    }
    if ((want.startsWith("yes ") || want === "yes") && (text === "yes" || rawText === "yes")) return true;
    if ((want.startsWith("no ") || want === "no") && (text === "no" || rawText === "no")) return true;
    return false;
  };

  // Story 2.2b fix-4 (P2): `node` itself is often the resolved market
  // container (e.g. an expanded `.accordion`), and the wanted button can
  // already be sitting inside it. Search node's OWN subtree first, scoped
  // strictly to node -- before ever climbing to a shared ancestor. Climbing
  // first is what caused the bug: the first ancestor inspected could contain
  // a neighboring `.accordion` as an "other market header" and break
  // immediately, aborting placement even though the button was right there
  // inside node all along (over-rejection, not a money-loss regression).
  const ownMatches = Array.from(node.querySelectorAll("button")).filter(isWantedButton);
  if (ownMatches.length === 1) return ownMatches[0];

  let current = node.parentElement;
  for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
    const headersInside = Array.from(current.querySelectorAll(headerSelector));
    const otherMarketHeaders = headersInside.filter(
      (h) => h !== node && !node.contains(h) && !h.contains(node)
    );
    if (otherMarketHeaders.length > 0) break;
    const matches = Array.from(current.querySelectorAll("button")).filter(isWantedButton);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Reconcile regress2 P0 (money-critical, final cross-family audit CONFIRMED):
// builds a CSS selector that finds ONLY the one physical DOM node tagged
// with `scanId` by scanCurrentMarketRows() in betfair_sportsbook_basket_worker.cjs,
// scoped to the market-container shape.
//
// The bug this fixes: MARKET_CONTAINER_SELECTOR is a COMMA-SEPARATED list of
// 10 alternative selectors ("h2, h3, .accordion, ..., .accordion-trigger").
// The worker used to build its winning-node selector by naively
// concatenating `${MARKET_CONTAINER_SELECTOR}[data-robin-arb-scan-id="..."]`.
// In CSS, a compound qualifier appended after a comma-separated selector
// LIST only binds to the LAST term before the string ends -- it does NOT
// distribute across every comma-separated alternative. That string therefore
// parsed as "h2, OR h3, OR .accordion, OR ... OR (.accordion-trigger AND has
// that exact data attribute)" -- i.e. an UNQUALIFIED `h2` (and 8 other
// unqualified terms) plus one correctly-qualified `.accordion-trigger` term.
// `target.locator(winningSelector).first()` then matched the FIRST h2 (or
// h3/.accordion/etc.) anywhere in the whole document -- NOT the specific
// scan-tagged winner -- on every market except the rare case where the
// winner's own tag happened to be `.accordion-trigger`. `.first()` silently
// swallowed the wrong-node selection instead of surfacing it as "not found".
//
// Fix: qualify EVERY comma-separated term individually with the scan-id
// attribute, then re-join with commas, so the compiled selector can only
// ever match the ONE physical node carrying that exact scan id, regardless
// of which of the 10 alternative shapes it happens to be.
function buildScanIdSelector(containerSelector, scanId) {
  return String(containerSelector || "")
    .split(",")
    .map((term) => `${term.trim()}[data-robin-arb-scan-id="${scanId}"]`)
    .join(", ");
}

module.exports = { MARKET_CONTAINER_SELECTOR, climbToMarketContainer, buildScanIdSelector };
