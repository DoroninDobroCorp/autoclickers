#!/usr/bin/env python3
"""Record a placed 1win bet in the MatchLimitsTracker history."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import server
from limits import MatchLimitsTracker


def main():
    try:
        data = json.load(sys.stdin)
        tracker = getattr(server, "_match_limits", None)
        if tracker is not None:
            arb = data.get("arb") or {}
            match_key = server._arb_match_key(arb)
            selection = data.get("selection")
            stake = float(data.get("stake", 1.0))
            odds = float(data.get("odds", 1.0))
            tracker.record_bet(
                match_key,
                outcome=selection,
                source="1win",
                stake=stake,
                odds=odds,
                extra={
                    "bookmaker": "1win",
                    "market": data.get("market"),
                    "balance_after": data.get("balance_after"),
                },
            )
            print(json.dumps({"ok": True, "match_key": match_key, "recorded": True}))
        else:
            print(json.dumps({"ok": True, "recorded": False, "note": "limits_disabled"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
