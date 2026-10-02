"use strict";

// Pure helpers for Story 2.3's read-only Sportsbook reconciliation path.
// Betfair exposes the same accepted bet under several identifiers:
//   entryServiceId: "2674780218"
//   betId:          "O/23359578/0000004"
//   receiptBetId:   233595780000004
// Treat these as aliases, but never infer NOT_PLACED from an absent record.

function identifierTokens(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return new Set();
  const tokens = new Set([raw]);
  if (/^(?:O[\s/_-]*)?\d[\d\s/_-]*$/.test(raw)) {
    const digits = raw.replace(/\D/g, "");
    if (digits) tokens.add(digits);
  }
  return tokens;
}

function recordIdentifierTokens(record) {
  const tokens = new Set();
  for (const key of ["entryServiceId", "betId", "receiptBetId"]) {
    for (const token of identifierTokens(record && record[key])) tokens.add(token);
  }
  return tokens;
}

function recordMatchesIdentifier(record, identifier) {
  const wanted = identifierTokens(identifier);
  if (!wanted.size) return false;
  const actual = recordIdentifierTokens(record);
  return [...wanted].some((token) => actual.has(token));
}

function findUniqueBetRecord(records, identifier) {
  const matches = (records || []).filter((record) => recordMatchesIdentifier(record, identifier));
  if (matches.length === 1) return { outcome: "found", record: matches[0] };
  if (matches.length > 1) return { outcome: "ambiguous", count: matches.length };
  return { outcome: "not_found", count: 0 };
}

function recordMatchesIntent(record, intent) {
  const eventId = String(intent && intent.event_id || "").trim();
  const selectionId = String(intent && intent.selection_id || "").trim();
  const stake = Number(intent && intent.stake);
  if (!eventId || !selectionId || !Number.isFinite(stake) || stake <= 0) return false;
  if (String(record && record.eventId || "").trim() !== eventId) return false;
  if (String(record && record.selectionId || "").trim() !== selectionId) return false;
  const recordStake = Number(record && (record.rawStake ?? record.stake));
  if (!Number.isFinite(recordStake) || Math.abs(recordStake - stake) > 0.001) return false;

  const expectedOdds = Number(intent && intent.expected_odds);
  if (Number.isFinite(expectedOdds) && expectedOdds > 1) {
    const actualOdds = decimalOdds(record);
    if (actualOdds === null || Math.abs(actualOdds - expectedOdds) > 0.011) return false;
  }
  return true;
}

function findUniqueBetByIntent(records, intent) {
  const matches = (records || []).filter((record) => recordMatchesIntent(record, intent));
  if (matches.length === 1) return { outcome: "found", record: matches[0] };
  if (matches.length > 1) return { outcome: "ambiguous", count: matches.length };
  return { outcome: "not_found", count: 0 };
}

function decimalOdds(record) {
  const raw = record && record.originalOdds && record.originalOdds.decimal;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function placedResult(record) {
  return {
    status: "PLACED",
    provider: "betfair-sportsbook",
    order_id: String(record.entryServiceId || record.betId || record.receiptBetId || ""),
    entry_service_id: record.entryServiceId == null ? null : String(record.entryServiceId),
    bet_id: record.betId == null ? null : String(record.betId),
    receipt_bet_id: record.receiptBetId == null ? null : String(record.receiptBetId),
    odds: decimalOdds(record),
    bookmaker_status: String(record.status || record.result || "").toUpperCase() || null,
    selection_id: record.selectionId == null ? null : String(record.selectionId),
    market_id: record.marketId == null ? null : String(record.marketId),
    placed_date: record.placedDate || null,
    settled_date: record.settledDate || null,
  };
}

function unknownResult(identifier, reason, extra = {}) {
  return {
    status: "UNKNOWN",
    provider: "betfair-sportsbook",
    order_id: String(identifier || ""),
    error_code: reason,
    reconciliation_required: true,
    ...extra,
  };
}

module.exports = {
  identifierTokens,
  recordIdentifierTokens,
  recordMatchesIdentifier,
  findUniqueBetRecord,
  recordMatchesIntent,
  findUniqueBetByIntent,
  placedResult,
  unknownResult,
};
