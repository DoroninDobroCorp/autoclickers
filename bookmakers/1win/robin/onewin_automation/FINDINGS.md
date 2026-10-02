# Findings outside the isolated 1win module

Date: 2026-07-22. These observations were recorded as requested; existing application logic was not
edited.

## Existing resolver can return financially different markets

A diagnostic comparison used current Forted Pinnacle × 1win forks and the raw public 1win snapshot.
The legacy resolver reported 41 resolved, four unavailable and one unsupported across 46 forks,
but inspection found false-positive mappings, including:

- Forted `Раунды, 3 карта` resolving to `Map 1. Total`;
- a map-2 moneyline resolving to the full-match `Winner` group;
- a hockey two-way `Match Winner` away outcome at 3.78 resolving to a three-way
  `Full Time Result` away outcome at 5.40.

The new package addresses these cases only inside its isolated strict snapshot path. No changes
were made to `backend/onewin_sportsbook.py` or its existing consumers.

## Catalogue/context disagreement must remain a hard failure

Two current League of Legends forks described `Убийства, весь матч` with handicap 1 (10.5) and
total under (32.5), while the corresponding 1win snapshots exposed kills only for maps 2 and 3.
Substituting a child-map market would create a different bet. The new resolver therefore returned
unavailable/fail-closed for both rows.

## Regional access blocks authenticated contract discovery

- The existing Betfair/Paddy proxy had Great Britain egress.
- The Forted SOCKS proxy at `127.0.0.1:1080` had Netherlands egress.
- 1win returned a licence-region HTTP 403 through both paths.
- The anonymous top-parser WebSocket feed remained reachable without either site route.

Consequently the authenticated add-to-betslip and submit request contracts were not captured. A
proxy in an allowed 1win jurisdiction is required before requesting the final test account.

## Live coverage is availability-dependent

The observed dedicated 1win fork stream contained Australian football, baseball, volleyball, MMA,
esports, tennis, football and ice hockey. Basketball and table tennis were absent during the probe,
so they are reported as unavailable and not counted as passes. A future acceptance run must repeat
the matrix when those sports and both sides of their base outcome families are present.

After the first independent review, the stricter resolver stopped inferring two-way market arity
from the two arbitrage legs. The repeated live probe consequently reported ambiguous map/hockey
moneylines instead of choosing between simultaneous two-way and three-way 1win groups. Forted must
provide an authoritative arity/market-family field before those rows can pass safely.

## Deployment state

The development server was on an older deployed revision than the local repository. Its Forted
service already referenced `config_pin_6mix.toml`, which contained 1win forks alongside other
sources. No remote repository, service, config, parser or deployment state was modified.
