import os, sys, time, json, httpx

from autoplace_guard import AutoplaceGuard, singleton_runner_lock

BASE_URL = "http://127.0.0.1:8899"

def run():
    username = os.environ.get("ROBINARB_USERNAME", "owner")
    password = os.environ.get("ROBINARB_PASSWORD", "owner123")
    client = httpx.Client(base_url=BASE_URL, timeout=None)
    guard = AutoplaceGuard()
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    if r.status_code != 200:
        print("[ERROR] Login failed:", r.status_code)
        return
    token = r.json()["token"]
    headers = {"Authorization": "Bearer " + token}
    print("[INIT] Starting Sequential Two-Leg Placement (1 Arb per Match, Profit >= -3.0%)...", flush=True)

    placed_matches = set()
    placed_count = 0
    errors_count = 0

    arbs_resp = client.get("/api/arbs", headers=headers).json()
    arbs = arbs_resp.get("arbs", []) if isinstance(arbs_resp, dict) else arbs_resp
    bf_arbs = [a for a in arbs if "paddypower" in a.get("bk2", "").lower() or "betfair" in a.get("bk2", "").lower() or "betfair" in a.get("bk1", "").lower()]
    
    # Filter profit >= -3.0%
    valid_arbs = [a for a in bf_arbs if float(a.get("profit_pct") or a.get("robin_profit_pct") or 0) >= -3.0]
    print(f"[FEED] Found {len(valid_arbs)} Betfair candidates with profit >= -3.0%.", flush=True)

    for cand in valid_arbs:
        should_stop, reason = guard.check_limits()
        if should_stop:
            print(reason, flush=True)
            return

        arb_id = cand["id"]
        match_name = cand.get("match", "Unknown")
        market_type = cand.get("market_type") or cand.get("market") or "Unknown"
        profit_pct = float(cand.get("profit_pct") or cand.get("robin_profit_pct") or 0)
        
        # Enforce 1 arb per match limit locally
        if match_name in placed_matches:
            continue

        try:
            v_resp = client.post("/api/verify", json={"arb_id": arb_id, "verify_mode": "betslip"}, headers=headers).json()
        except Exception as e:
            print(f"[VERIFY ERR] {arb_id}: {e}", flush=True)
            continue
            
        quote_id = v_resp.get("quote_id")
        verified = v_resp.get("verified", False)
        
        if not (verified and quote_id):
            continue
            
        pin_odds = float(v_resp.get("odds") or cand.get("bk1_odds", 0))
        snapshot = v_resp.get("arb_snapshot") if isinstance(v_resp.get("arb_snapshot"), dict) else {}
        
        # --- Live Betfair odds check via /api/counter/verify ---
        try:
            c_resp = client.post("/api/counter/verify", json={"arb_id": arb_id, "verify_mode": "betslip"}, headers=headers).json()
        except Exception as e:
            print(f"[COUNTER VERIFY ERR] Arb {arb_id}: {e}", flush=True)
            continue

        c_verified = c_resp.get("verified", False)
        c_status = str(c_resp.get("status") or "").upper()
        live_robin_odds = float(c_resp.get("current_odds") or 0)
        snapshot_robin_odds = float(c_resp.get("feed_odds") or v_resp.get("robin_odds") or snapshot.get("robin_odds") or cand.get("bk2_odds", 0))

        if not c_verified or c_status in ("STALE", "UNAVAILABLE") or live_robin_odds <= 0:
            print(f"[COUNTER VERIFY REJECTED] Arb {arb_id}: verified={c_verified}, status={c_status}, live_odds={live_robin_odds}", flush=True)
            continue

        slippage_tol = float(os.environ.get("ROBINARB_SLIPPAGE_TOLERANCE", "0.02"))
        if live_robin_odds < snapshot_robin_odds - slippage_tol:
            print(f"[SKIP SLIPPAGE] Arb {arb_id}: Betfair live odds {live_robin_odds:.3f} < snapshot {snapshot_robin_odds:.3f} (tol={slippage_tol})", flush=True)
            continue

        robin_odds = live_robin_odds
        
        print(f"\n==================================================", flush=True)
        print(f"[MATCH VERIFIED] #{placed_count+1} | {match_name} | Market: {market_type} | Profit: {profit_pct:.2f}%", flush=True)
        print(f"                 Arb ID: {arb_id} | Quote: {quote_id}", flush=True)
        print(f"                 Pin Odds: {pin_odds} | Betfair Odds: {robin_odds}", flush=True)
        
        # --- Leg 1: Betfair ($1.0) ---
        print(f"---> [LEG 1: BETFAIR] Placing $1.0 @ {robin_odds}...", flush=True)
        p_payload = {"arb_id": arb_id, "side": "robinbet", "stake": 1.0, "odds": robin_odds, "quote_id": quote_id, "verify_mode": "betslip"}
        try:
            p_resp = client.post("/api/bet", json=p_payload, headers=headers)
            if p_resp.status_code == 429:
                print("[RATE LIMIT] Sleeping 1.2s and retrying Betfair...", flush=True)
                time.sleep(1.2)
                p_resp = client.post("/api/bet", json=p_payload, headers=headers)
        except Exception as exc:
            guard.record_error()
            errors_count += 1
            print(f"[LEG 1 EXCEPTION]: {exc}", flush=True)
            print(f"[EMERGENCY STOP] UNKNOWN LEG 1 STATE, ручное вмешательство! Leg 1 (Betfair) POST raised an exception -- whether the Betfair position was placed is unknown. Arb {arb_id} | Quote {quote_id} | {match_name}: {exc}", flush=True)
            return
            
        if p_resp.status_code != 200:
            guard.record_error()
            errors_count += 1
            print(f"[LEG 1 REJECTED] HTTP {p_resp.status_code}: {p_resp.text[:300]}", flush=True)
            continue
            
        p_data = p_resp.json()
        st = p_data.get("status")
        bid = p_data.get("bet_id")
        print(f"[LEG 1 SUCCESS] Status: {st} | Bet ID: {bid}", flush=True)
        
        if st in ("pending_reconciliation", "UNKNOWN", "pending"):
            print(f"[LEG 1 PENDING] Status is {st}, reconciling bet {bid}...", flush=True)
            for _rec in range(5):
                time.sleep(1.0)
                try:
                    rec_resp = client.post("/api/bet/reconcile", params={"bet_id": bid}, headers=headers)
                    if rec_resp.status_code == 200:
                        st = rec_resp.json().get("status", st)
                        if st == "accepted":
                            break
                        elif st in ("failed", "rejected", "cancelled"):
                            break
                except Exception:
                    pass
                    
        if st not in ("accepted", "SUCCESS", "OK", True):
            guard.record_error()
            print(f"[LEG 1 REJECTED/UNCONFIRMED] Status is '{st}'. Aborting Leg 2 placement.", flush=True)
            continue
        
        # --- Leg 2: Pinnacle (Hedged Stake) ---
        stake1 = 1.0
        stake2 = max(0.1, round((stake1 * robin_odds) / max(pin_odds, 1.01), 2))
        time.sleep(0.5)
        print(f"---> [LEG 2: PINNACLE] Placing ${stake2:.2f} @ {pin_odds} (hedged)...", flush=True)
        t0 = time.time()
        b_payload = {"arb_id": arb_id, "side": "pinnacle", "stake": stake2, "odds": pin_odds, "quote_id": quote_id, "verify_mode": "betslip"}
        try:
            b_resp = client.post("/api/bet", json=b_payload, headers=headers)
        except Exception as exc:
            guard.record_error()
            errors_count += 1
            dt = time.time() - t0
            print(f"[LEG 2 EXCEPTION] ({dt:.2f}s): {exc}", flush=True)
            print(f"[EMERGENCY STOP] NAKED, ручное вмешательство! Leg 1 (Betfair bet_id={bid}) succeeded, but Leg 2 (Pinnacle) raised exception: {exc}", flush=True)
            return
            
        dt = time.time() - t0
        
        if b_resp.status_code != 200:
            guard.record_error()
            errors_count += 1
            err_msg = b_resp.text
            print(f"[LEG 2 ERR] ({dt:.2f}s) Status {b_resp.status_code}: {err_msg[:400]}", flush=True)
            print(f"[EMERGENCY STOP] NAKED, ручное вмешательство! Leg 1 (Betfair bet_id={bid}) succeeded, but Leg 2 (Pinnacle) failed (HTTP {b_resp.status_code})", flush=True)
            if "INSUFFICIENT_FUNDS" in err_msg or "balance" in err_msg.lower() or "ACCOUNT_RESTRICTED" in err_msg:
                print(f"[STOP] Pinnacle account balance/limit reached: {err_msg[:200]}", flush=True)
            return
        else:
            b_data = b_resp.json()
            bst = b_data.get("status")
            bbid = b_data.get("bet_id")
            placed_count += 1
            guard.record_success(stake1 + stake2)
            placed_matches.add(match_name)
            print(f"[LEG 2 SUCCESS] ({dt:.2f}s) Status: {bst} | Bet ID: {bbid}", flush=True)
            print(f"[PROGRESS] Successfully placed live two-leg arb pair #{placed_count} for {match_name}!", flush=True)
        
        time.sleep(1.0)
        
    print(f"\n=== PLACEMENT FINISHED. Placed {placed_count} new two-leg arbs (1 per match) ===")

if __name__ == "__main__":
    with singleton_runner_lock():
        run()
