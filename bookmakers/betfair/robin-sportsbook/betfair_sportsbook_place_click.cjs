"use strict";

// Pure orchestration for the "click Place Bet, then read the outcome" step
// of a live Betfair Sportsbook placement (Story 2.2b fix-2, P1
// "screenshot-fail -> refund живой ставки"). Kept dependency-free -- like
// betfair_sportsbook_market_identity.cjs / betfair_sportsbook_button_match.cjs
// -- by taking the actual click/poll/screenshot steps as injected async
// functions, so the money-safety classification logic (not Playwright
// itself) can be unit tested with node:test.
//
// The bug this fixes: the worker used to take a post-click screenshot
// *between* determining the placement outcome (via pollPlacementResult) and
// acting on it. If that screenshot call threw for any reason (page closed,
// unexpected navigation, disk error -- anything AFTER a real receipt may
// already have been seen), the exception propagated as a generic, untagged
// error. server.py's fallback path only recognizes an indeterminate outcome
// via the literal substring "PLACE_INDETERMINATE" in the error message (see
// server.py's _place_betfair_via_service) -- a generic error was therefore
// read as a clean, definitive reject and the caller refunded the reserved
// stake even though the bet may already be live.
//
// Fix: the outcome is now classified from click()/poll() ALONE, before the
// screenshot is even attempted; the screenshot is strictly best-effort
// (never allowed to change or mask the already-determined outcome); and any
// exception raised by click()/poll() itself -- not just an explicit
// poll-timeout -- is reported as PLACE_INDETERMINATE. Only a poll result
// that is a clean, explicit Betfair betslip error text (outcome === "error")
// is ever treated as a definitive, safe-to-refund reject.

/**
 * @param {object} steps
 * @param {() => Promise<any>} steps.click - Sends the Place Bet click. May
 *   throw (e.g. the element went stale mid-click).
 * @param {() => Promise<{outcome: "success"|"error"|"indeterminate", text?: string}>} steps.poll
 *   - Resolves the placement outcome after the click. May itself throw on an
 *   unexpected condition (not just resolve "indeterminate" on a clean
 *   timeout) -- both cases must be treated the same way: indeterminate.
 *   The RESOLVED VALUE is validated with a strict allowlist too (Story 2.2b
 *   fix-3, P1): only an explicit outcome === "success" ever returns
 *   BET_PLACED, and only an explicit outcome === "error" is a definitive
 *   reject -- null/undefined, a missing `.outcome`, or any unrecognized
 *   outcome string is treated as indeterminate, never assumed placed.
 * @param {() => Promise<string|null>} steps.screenshot - Best-effort;
 *   whatever it throws is swallowed and never surfaces to the caller.
 * @returns {Promise<{status: "BET_PLACED", screenshot: string|null}>}
 * @throws {Error} with a message starting "PLACE_INDETERMINATE: " when the
 *   outcome cannot be proven safe to refund, or a plain rejection message
 *   when Betfair cleanly rejected the bet before any money moved.
 */
async function runPlaceBetClick({ click, poll, screenshot }) {
  let placeResult;
  try {
    await click();
    placeResult = await poll();
  } catch (error) {
    // Any exception once the click has been sent -- including one raised by
    // poll() itself, not just its own "indeterminate" timeout result -- must
    // never be reported as a clean, refundable failure.
    throw new Error(
      `PLACE_INDETERMINATE: exception after Place Bet click: ${
        error && error.message ? error.message : error
      }`
    );
  }

  // Best-effort only, and AFTER the outcome above is already fixed -- a
  // screenshot failure here must never override or mask it.
  let screenshotPath = null;
  try {
    screenshotPath = await screenshot();
  } catch (_screenshotError) {
    screenshotPath = null;
  }

  // Story 2.2b fix-3 (P1): strict allowlist, not a two-case special-case
  // with an unconditional BET_PLACED fallthrough. A null/undefined
  // placeResult (poll() resolving without throwing) or an outcome string
  // that isn't recognized must NEVER fall through to BET_PLACED -- the old
  // code only special-cased "error" and "indeterminate" explicitly and
  // returned BET_PLACED for literally everything else, including reading
  // `.outcome` off null/undefined, which threw an unmarked TypeError that
  // server.py's fallback path (matching only the literal substring
  // "PLACE_INDETERMINATE") could not recognize -- it read that as a clean,
  // definitive reject and refunded a stake that may already be a live bet.
  const outcome = placeResult && typeof placeResult === "object" ? placeResult.outcome : undefined;

  if (outcome === "error") {
    throw new Error(`Betfair Sportsbook rejected bet: ${placeResult.text}`);
  }
  if (outcome === "success") {
    return { status: "BET_PLACED", screenshot: screenshotPath };
  }
  // Everything else -- "indeterminate", null/undefined placeResult, a
  // missing outcome field, or any unrecognized outcome value -- fails
  // closed to indeterminate.
  throw new Error(
    "PLACE_INDETERMINATE: bet may have been placed — verify in My Bets before any retry"
  );
}

module.exports = { runPlaceBetClick };
