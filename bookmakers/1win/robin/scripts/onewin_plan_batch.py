#!/usr/bin/env python3
"""Resolve a batch of Forted arbs using single-round WebSocket prefetch and strict 1win adapter.

JSON stdin (list of arbs) / stdout (list of resolved plans).
"""

import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from onewin_automation.identity import resolved_selection
from onewin_automation.transport import OneWinPublicQuoteSource
import onewin_sportsbook
import server


async def resolve_batch(arbs: list[dict]):
    t0 = time.monotonic()
    source = OneWinPublicQuoteSource()

    # 1. Prefetch ALL arbs in ONE WebSocket subscription round
    try:
        await source.prefetch(arbs)
    except Exception as exc:
        pass
    prefetch_ms = round((time.monotonic() - t0) * 1000, 1)

    tracker = getattr(server, "_match_limits", None)
    results = []
    cache = getattr(source._client, "_cache", {})

    # 2. In-memory resolution of every arb whose snapshot is in cache
    for arb in arbs:
        try:
            event_id = onewin_sportsbook.extract_event_id(arb)
            if not event_id or event_id not in cache:
                continue
            cached = cache[event_id]
            if not cached or len(cached) < 2:
                continue
            snapshot = cached[1]
            elapsed_ms = cached[2] if len(cached) > 2 else 0.0

            quote = onewin_sportsbook.resolve_quote_from_snapshot(
                arb, str(event_id), snapshot, elapsed_ms=elapsed_ms
            )
            if quote.get("verified") is not True:
                continue
            selection = resolved_selection(arb, quote)

            group = next(
                (g for g in snapshot.get("oddsGroups", []) if str(g.get("id")) == selection.market_id),
                None
            )
            if not group:
                continue
            odd = next(
                (o for o in group.get("oddsList", []) if str(o.get("id")) == selection.selection_id),
                None
            )
            if not odd:
                continue

            limits_allowed = True
            limits_reason = None
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

            results.append({
                "ok": True,
                "arb_id": arb.get("id"),
                "match": arb.get("match"),
                "sport": arb.get("sport"),
                "selection": asdict(selection),
                "quote": quote,
                "ui_selection_name": odd["name"],
                "limits_allowed": limits_allowed,
                "limits_reason": limits_reason,
            })
        except Exception:
            continue

    total_ms = round((time.monotonic() - t0) * 1000, 1)
    return {
        "ok": True,
        "prefetch_ms": prefetch_ms,
        "total_ms": total_ms,
        "candidates_count": len(results),
        "plans": results,
    }


if __name__ == "__main__":
    try:
        input_data = json.load(sys.stdin)
        if isinstance(input_data, dict):
            input_data = [input_data]
        res = asyncio.run(resolve_batch(input_data))
        print(json.dumps(res, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)[:400]}))
