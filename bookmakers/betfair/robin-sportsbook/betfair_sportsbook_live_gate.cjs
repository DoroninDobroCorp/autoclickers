"use strict";

// Reconcile regress1 P2 (final cross-family audit, money-safety): pure,
// unit-testable env-gate check for the worker's own defense-in-depth
// live-placement guard (betfair_sportsbook_basket_worker.cjs's
// fixedOddsRequest, stage=place/dryRun=false loopback path). Extracted so
// the exact truthy/falsy parsing this gate relies on can be tested without
// requiring the Playwright-dependent worker module (which cannot be
// require()d from a plain node:test process at all).
const LIVE_PLACE_ENV_VAR = "ROBINARB_BETFAIR_LIVE_PLACE_ENABLED";

function isLivePlaceEnabledValue(rawValue) {
  return ["1", "true", "yes", "on"].includes(String(rawValue ?? "0").trim().toLowerCase());
}

function liveBetfairPlaceEnabled(env) {
  const source = env || process.env;
  return isLivePlaceEnabledValue(source[LIVE_PLACE_ENV_VAR]);
}

module.exports = {
  LIVE_PLACE_ENV_VAR,
  isLivePlaceEnabledValue,
  liveBetfairPlaceEnabled,
};
