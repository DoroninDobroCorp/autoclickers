# 1win automation boundary

This package is an isolated, request-first 1win counter-bookmaker module. It converts a current
Pinnacle × 1win Forted fork into a strict selection identity, refreshes the anonymous 1win quote
through the public WebSocket feed, and produces a **local dry-run payload**.

It does not mutate a remote 1win betslip and contains no authenticated submit endpoint. The name
`BASKET_READY` means that event, market, outcome, context, line, state, price, stake and identifiers
passed the local preparation boundary. It must not be represented as a server-side basket receipt.

## Request path

1. `forted.arb_from_forted_fork` accepts exactly one Pinnacle and one 1win source and preserves the
   bookmaker order, raw stake pair, signed line and period/map metadata.
2. `transport.OneWinPublicQuoteSource` uses the existing anonymous
   `wss://api-gateway.top-parser.com/push-server-v2/` Socket.IO contract.
3. `snapshot.resolve_strict_quote` narrows the raw snapshot to the exact map, set, half, period,
   inning, property, participant and two-way/three-way family before resolving an outcome. Plain
   moneylines fail closed unless Forted supplies authoritative `market_arity`.
4. `identity.resolved_selection` freezes stable event, market and selection identifiers only for an
   open, verified quote after independently rechecking family, participant direction, every context
   coordinate, outcome and signed line.
5. `basket.BasketPreparer` refreshes the price and emits a `dry_run: true` payload. Price drift,
   missing identity, suspension, ambiguity and invalid stake fail closed.

The new code wraps the existing anonymous client but does not change existing RobinArb, Betfair,
Pinnacle or Forted behavior.

## Configuration

All values are read from the environment or injected in tests:

| Variable | Default | Meaning |
|---|---:|---|
| `ONEWIN_AUTOMATION_PROXY` | empty | Preferred proxy URL; may contain credentials and is never included in config repr |
| `ONEWIN_SPORTSBOOK_PROXY` | empty | Existing 1win public-feed fallback |
| `BETFAIR_PROXY` | empty | Last proxy fallback requested by operations |
| `ONEWIN_AUTOMATION_TIMEOUT_SEC` | `15` | Public request timeout, minimum 3 seconds |
| `ONEWIN_SPORTSBOOK_CACHE_TTL_SEC` | `0.75` | Maximum accepted raw-snapshot cache age |
| `ONEWIN_AUTOMATION_PRICE_TOLERANCE` | `0.001` | Maximum accepted decimal-odds drift |
| `ONEWIN_AUTOMATION_MAX_STAKE` | `50` | Local preparation stake ceiling |
| `ONEWIN_AUTOMATION_LIVE_ENABLED` | `false` | Required environment authorization for the future live-placement gate |

Never put account credentials, cookies, bearer tokens or proxy passwords in source, fixtures,
diagnostic reports or command output. Use `redact_url` and `redact_mapping` for evidence.

## Example: anonymous dry-run preparation

```python
from onewin_automation.basket import BasketPreparer
from onewin_automation.forted import arb_from_forted_fork
from onewin_automation.transport import OneWinPublicQuoteSource

arb = arb_from_forted_fork(forted_fork)
receipt = await BasketPreparer(OneWinPublicQuoteSource()).prepare(
    arb,
    stake=10,
    idempotency_key="ow-dry-unique-reference",
)
assert receipt.status == "BASKET_READY"
assert receipt.payload["dry_run"] is True
```

## Money-safety boundary

`PlacementGate` exists to freeze the semantics of a future authenticated transport:

- disabled by default;
- requires both an explicit caller enable and `ONEWIN_AUTOMATION_LIVE_ENABLED=true`;
- requires a unique idempotency key;
- refuses live mode unless an injected durable `AttemptStore` can atomically claim the key across
  workers and restarts;
- treats every timeout or exception after handing the request to transport as indeterminate;
- never retries an indeterminate placement;
- treats incomplete/unrecognized post-send responses as indeterminate;
- recognizes rejection only from an explicit rejected/declined status or code;
- accepts success only with a structured `ok` response and a receipt identifier.

Identity and price failures expose a redacted structured `quote`, `observed_state` and
`observed_price` on the typed exception for reconciliation without leaking credentials.

There is deliberately no concrete submit transport yet. Capturing that contract requires an
allowed-region proxy and a test account and belongs only to the final, explicitly authorized stage.
The repository also contains no durable attempt-store implementation; live mode therefore remains
unusable until operations selects the shared ledger and reconciliation contract.

## Verification and current external limit

On 2026-07-22 the anonymous WebSocket feed was reachable and supplied complete raw market groups.
The available Betfair proxy exited in Great Britain and the Forted SOCKS proxy exited in the
Netherlands; both 1win website requests returned a licence-region HTTP 403. Therefore actual remote
betslip mutation could not be verified with the available network routes. No real account was
requested and no bet was sent.

The redacted live matrix is in
`_bmad-output/diagnostics/3.1-onewin-outcome-matrix.md`. Unit and contract tests:

```bash
cd backend
python3 -m unittest test_onewin_automation.py test_onewin_automation_snapshot.py -v
python3 -m unittest discover -p 'test_onewin*.py' -v
```

## Final operational handoff (not executed)

After an allowed-region proxy and test account are supplied, the remaining work is to capture the
authenticated add-to-betslip and placement contracts, add redacted contract tests, exercise the
full currently available outcome matrix, and only then authorize a minimal real stake. Starting the
distributed parser, changing Forted to dedicated `pin_1win`, deploying/restarting services and
placing both legs are operational changes and were not performed by this development cycle.

---

## Live Automation & Execution Status (Updated: 2026-09-05)

The live automation gate and operational handoff have been successfully verified:

1. **Proxy & Regional Egress**: Geo-restriction (Cloudflare 403) was overcome using a dedicated reverse SOCKS5 proxy tunnel (`socks5://127.0.0.1:10800`).
2. **Session Authentication**: Authenticated session state saved via `scripts/onewin_login.mjs` to `backend/stats_data/onewin-session-state.json` with forced `project_locale=en-US`.
3. **Odds Matching & Resolution**: `scripts/onewin_plan.py` strictly matches `feed_odds == current_odds` against the live 1win snapshot.
4. **Limits Verification**: Checks `MatchLimitsTracker` before navigating to the betslip (enforcing default 1 bet per match and configured budget/count limits).
5. **Verified Live Bet Execution**: On 2026-09-04, the first real bet of 1 USDT was placed on *Maccabi Petah Tikva U19 vs Hapoel Haifa U19* (Total 1 Over 1.5, odds 1.85, Bet ID `311687190`, balance after: 9.00 USDT).
6. **Captured Production API Contract**:
   - `POST https://1win.pro/microservice/bets/api/v1/user/bets/express-ordinary`
   - Payload: `{"betType":"SINGLE","orders":[{"coefficient":1.85,"gameId":39391033,"marketId":"total_1_o_1.5","oddsGroup":"total","oddsGroupId":5,"outcome":"1.5","source":"LINE","sportId":1}],"amount":1}`
   - Result: `{"success":true,"payload":{"id":311687190,"amount":1,"coefficient":1.85,"type":"SINGLE","state":"PENDING",...}}`
7. **Post-Placement Recording**: Automated persistence via `scripts/onewin_record_bet.py` into `.bet_match_history.json`.
