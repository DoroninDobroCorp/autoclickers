"use strict";

// Pure text-matching helpers for the Betfair Sportsbook "Place Bet" button
// and the placement result (receipt/error) messages. Kept dependency-free
// and Playwright-free so they can be unit tested with node:test and reused
// verbatim (same regex object) both in tests and in the live worker locator.
//
// Betfair renders the stake amount *inside* the button label, e.g.
// "Place €1.00 Bet" or "Place 2 Bets €2.00" — the old locator looked for a
// literal "Place bet" substring, which never matches once a stake is set.

// Anchored to the full normalized CTA label — NOT just "place ... bet
// somewhere nearby" (that looser shape false-matched unrelated buttons like
// "Place Bet Limit", "Place Holder Bet", "Place Free Bet", "Place Another
// Bet" and "Do not Place Bet", per gpt-5.5 review finding). The only tokens
// allowed between "place" and the end of the label are an optional bet
// count and an optional currency amount (before and/or after bet(s)),
// covering every observed Betfair stake-in-label shape:
//   "Place Bet", "Place Bets", "Place €1.00 Bet", "Place £5.00 Bet",
//   "Place $2 Bet", "Place 2 Bets €2.00".
const CURRENCY_AMOUNT = "(?:[€£$]\\s?[\\d,.]+|[\\d,.]+\\s?(?:eur|gbp|usd))";
const placeBetButtonRegex = new RegExp(
  `^place(?:\\s+\\d+)?(?:\\s+${CURRENCY_AMOUNT})?\\s+bets?(?:\\s+${CURRENCY_AMOUNT})?$`,
  "i"
);

// Betfair's innerText can contain line breaks / repeated whitespace around
// the stake (e.g. "Place\n  €1.00  \nBet"); Playwright's own accessible-name
// matching normalizes whitespace the same way before testing a regex name,
// so normalizing here keeps isPlaceBetLabel and the live getByRole locator
// consistent with each other.
function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPlaceBetLabel(text) {
  if (text === null || text === undefined) return false;
  const value = normalizeWhitespace(text);
  if (!value) return false;
  return placeBetButtonRegex.test(value);
}

// Positive placement result ("Bet Placed" / "Bets placed" / a receipt panel).
const receiptTextRegex = /\bbets?\s+placed\b|\breceipt\b/i;

function isReceiptText(text) {
  if (text === null || text === undefined) return false;
  const value = String(text);
  if (!value.trim()) return false;
  return receiptTextRegex.test(value);
}

// Known Betfair Sportsbook betslip rejection reasons.
const betslipErrorTextRegex = /insufficient\s+funds|odds\s+(?:have\s+)?changed|suspended/i;

function isBetslipErrorText(text) {
  if (text === null || text === undefined) return false;
  const value = String(text);
  if (!value.trim()) return false;
  return betslipErrorTextRegex.test(value);
}

module.exports = {
  placeBetButtonRegex,
  isPlaceBetLabel,
  receiptTextRegex,
  isReceiptText,
  betslipErrorTextRegex,
  isBetslipErrorText,
};
