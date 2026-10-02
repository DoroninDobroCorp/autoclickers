# Bookmaker Boundary

Common pipeline code must not import a concrete bookmaker implementation.

New bookmaker checklist:

1. Implement the legacy execution adapter used by `BaseBettor`/`BetProcessor`
   for login, match search, outcome search and `placeBet`.
2. Implement a v2 catalog adapter that extends `BookmakerAdapter` and exposes:
   `bookmakerId`, `getCatalog(sport)`, and optional `getMatchOdds` /
   `getMatchStatus` / `submitBet`.
3. Register the v2 adapter in `registry.js` with `registerBookmakerAdapter`.
4. Configure Telegram profiles with the new bookmaker id. The Telegram parser,
   match locator, queue, limits and task runner stay bookmaker-agnostic.

If a bookmaker needs a one-off adapter during rollout, pass
`telegram.bookmakerAdapter` or `telegram.ingress.bookmakerAdapter` in config.
