#!/usr/bin/env python3
"""Resolve a selected Forted leg using the existing strict 1win adapter.

JSON stdin/stdout only. No credentials, browser mutation or placement API.
"""

import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from onewin_automation.identity import resolved_selection
from onewin_automation.transport import OneWinPublicQuoteSource
import server


async def resolve(arb):
    source = OneWinPublicQuoteSource()
    quote = await source.resolve_live_quote(arb)
    if quote.get("verified") is not True:
        return {"ok": False, "quote": quote}
    selection = resolved_selection(arb, quote)
    snapshot = source._client._cache[selection.event_id][1]
    group = next(
        g for g in snapshot["oddsGroups"] if str(g["id"]) == selection.market_id
    )
    odd = next(o for o in group["oddsList"] if str(o["id"]) == selection.selection_id)

    # Check match limits
    limits_allowed = True
    limits_reason = None
    tracker = getattr(server, "_match_limits", None)
    if tracker is not None:
        match_key = server._arb_match_key(arb)
        chk = tracker.check_local_limits(
            match_key,
            source="1win",
            stake=1.0,
            outcome=odd["name"],
        )
        if not chk.get("allowed"):
            limits_allowed = False
            limits_reason = chk.get("reason")

    return {
        "ok": True,
        "selection": asdict(selection),
        "quote": quote,
        "ui_selection_name": odd["name"],
        "limits_allowed": limits_allowed,
        "limits_reason": limits_reason,
    }


if __name__ == "__main__":
    try:
        print(
            json.dumps(asyncio.run(resolve(json.load(sys.stdin))), ensure_ascii=False)
        )
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": type(exc).__name__, "detail": str(exc)[:400]}
            )
        )
