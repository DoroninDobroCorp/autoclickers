import os, sys, time, json, httpx

from autoplace_guard import AutoplaceGuard, singleton_runner_lock

BASE_URL = "http://127.0.0.1:8899"

def run():
    username = os.environ.get("ROBINARB_USERNAME", "owner")
    password = os.environ.get("ROBINARB_PASSWORD", "owner123")
    client = httpx.Client(base_url=BASE_URL, timeout=60.0)
    # Explicit fallbacks match this script's historical (stricter) defaults --
    # AutoplaceGuard's own bare defaults are 5/$100/20, not 3/$50/20. Both read
    # the same env vars, so an operator override already applied to both; this
    # removes the duplicate tracking state without changing effective behavior.
    guard = AutoplaceGuard(
        max_consecutive_errors=int(os.environ.get("ROBINARB_MAX_CONSECUTIVE_ERRORS", "3")),
        max_total_stake=float(os.environ.get("ROBINARB_MAX_TOTAL_STAKE", "50.0")),
    )
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    if r.status_code != 200:
        print("[ERROR] Failed to login: " + str(r.status_code) + " " + r.text)
        return
    token = r.json()["token"]
    headers = {"Authorization": "Bearer " + token}
    print("[INIT] Logged in successfully.")
    
    placed_count = 0
    errors_count = 0

    seen_keys = set()

    for loop in range(1, 50):
        should_stop, reason = guard.check_limits()
        if should_stop:
            print(reason, flush=True)
            return

        print(f"\n--- [Cycle #{loop}] Fetching active arbs ---", flush=True)
        try:
            arbs_resp = client.get("/api/arbs", headers=headers).json()
        except Exception as e:
            print(f"[ERROR] Failed to fetch arbs: {e}", flush=True)
            time.sleep(2)
            continue
            
        arbs = arbs_resp.get("arbs", []) if isinstance(arbs_resp, dict) else arbs_resp
        bf_arbs = [
            a for a in arbs
            if "paddypower" in a.get("bk2", "").lower()
            or "betfair" in a.get("bk2", "").lower()
            or "betfair" in a.get("bk1", "").lower()
        ]
        
        print(f"[INFO] Found {len(bf_arbs)} Betfair/PaddyPower arbs candidate(s).", flush=True)
        
        min_profit_pct = float(os.environ.get("ROBINARB_MIN_PROFIT_THRESHOLD", os.environ.get("ROBINARB_FEED_MIN_PROFIT", "0.0")))
        
        for cand in bf_arbs:
            should_stop, reason = guard.check_limits()
            if should_stop:
                print(reason, flush=True)
                return

            arb_id = cand["id"]
            match_name = cand.get("match", "Unknown")
            market_type = cand.get("market_type", "Unknown")
            profit_pct = float(cand.get("profit_pct") or 0.0)
            
            if profit_pct < min_profit_pct:
                print(f"[SKIP] Arb {arb_id} profit {profit_pct:.2f}% is below min threshold {min_profit_pct:.2f}%", flush=True)
                continue
            
            dedup_key = (match_name, market_type, str(arb_id))
            if dedup_key in seen_keys:
                print(f"[DEDUP] Skipping already processed arb {dedup_key}", flush=True)
                continue
            seen_keys.add(dedup_key)
            
            try:
                v_resp = client.post("/api/verify", json={"arb_id": arb_id, "verify_mode": "betslip"}, headers=headers).json()
            except Exception as e:
                print(f"[VERIFY ERR] Arb {arb_id}: {e}", flush=True)
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

            if guard.total_stake_placed + 2.0 > guard.max_total_stake:
                print(f"[GLOBAL KILL-SWITCH] Stake limit reached (${guard.total_stake_placed:.2f} + $2.00 > ${guard.max_total_stake:.2f}). Stopping runner.", flush=True)
                return

            print(f"\n[TARGET FOUND] Arb {arb_id} | Match: {match_name} | Market: {market_type}", flush=True)
            print(f"               Quote ID: {quote_id} | Pin Odds: {pin_odds} | Robin Odds: {robin_odds}", flush=True)
            
            print(f"---> [LEG 1: BETFAIR] Placing $1.0 @ {robin_odds}...", flush=True)
            p_payload = {
                "arb_id": arb_id,
                "side": "robinbet",
                "stake": 1.0,
                "odds": robin_odds,
                "quote_id": quote_id,
                "verify_mode": "betslip"
            }
            try:
                p_resp = client.post("/api/bet", json=p_payload, headers=headers)

                if p_resp.status_code == 429:
                    print("[RATE LIMIT] Betfair 429 received, sleeping 1.2s and retrying Leg 1...", flush=True)
                    time.sleep(1.2)
                    p_resp = client.post("/api/bet", json=p_payload, headers=headers)
            except Exception as exc:
                guard.record_error()
                errors_count += 1
                print(f"[LEG 1 EXCEPTION] Arb {arb_id}: {exc}", flush=True)
                print(f"[EMERGENCY STOP] UNKNOWN LEG 1 STATE, ручное вмешательство! Leg 1 (Betfair) POST raised an exception -- whether the Betfair position was placed is unknown. Arb {arb_id} | Quote {quote_id} | {match_name}: {exc}", flush=True)
                return

            if p_resp.status_code != 200:
                guard.record_error()
                errors_count += 1
                print(f"[LEG 1 FAILED] HTTP {p_resp.status_code}: {p_resp.text[:300]}", flush=True)
                should_stop, reason = guard.check_limits()
                if should_stop:
                    print(reason, flush=True)
                    return
                continue
                
            p_data = p_resp.json()
            st = p_data.get("status")
            bid = p_data.get("bet_id")
            print(f"[LEG 1 OK] Status: {st} | Bet ID: {bid}", flush=True)
            
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
                should_stop, reason = guard.check_limits()
                if should_stop:
                    print(reason, flush=True)
                    return
                continue
            
            stake1 = 1.0
            stake2 = max(0.1, round((stake1 * robin_odds) / max(pin_odds, 1.01), 2))
            time.sleep(0.5)
            print(f"---> [LEG 2: PINNACLE] Placing ${stake2:.2f} @ {pin_odds} (hedged)...", flush=True)
            t0 = time.time()
            b_payload = {
                "arb_id": arb_id,
                "side": "pinnacle",
                "stake": stake2,
                "odds": pin_odds,
                "quote_id": quote_id,
                "verify_mode": "betslip"
            }
            try:
                b_resp = None
                for leg2_attempt in range(3):
                    b_resp = client.post("/api/bet", json=b_payload, headers=headers)
                    if b_resp.status_code == 429:
                        print(f"[RETRY 429] Leg 2 rate limited (attempt {leg2_attempt+1}/3). Waiting 1.2s...", flush=True)
                        time.sleep(1.2)
                        continue
                    break
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
                print(f"[LEG 2 FAILED] ({dt:.2f}s) HTTP {b_resp.status_code}: {err_msg[:400]}", flush=True)
                print(f"[EMERGENCY STOP] NAKED, ручное вмешательство! Leg 1 (Betfair bet_id={bid}) succeeded, but Leg 2 (Pinnacle) failed (HTTP {b_resp.status_code})", flush=True)
                try:
                    b_err_json = b_resp.json() if isinstance(b_resp.json(), dict) else {}
                except Exception:
                    b_err_json = {}
                err_code = str(b_err_json.get("error") or b_err_json.get("code") or "").upper()
                if err_code in ("INSUFFICIENT_FUNDS", "ACCOUNT_RESTRICTED", "INVALID_BALANCE") or "INSUFFICIENT_FUNDS" in err_msg or "ACCOUNT_RESTRICTED" in err_msg:
                    print(f"[STOP] Pinnacle constraint ({err_code}): {err_msg[:200]}", flush=True)
                return
            else:
                b_data = b_resp.json()
                bst = b_data.get("status")
                bbid = b_data.get("bet_id")
                placed_count += 1
                guard.record_success(1.0 + stake2)
                print(f"[LEG 2 SUCCESS] ({dt:.2f}s) Status: {bst} | Bet ID: {bbid}", flush=True)
                print(f"[PROGRESS] Placed live two-leg arb pair #{placed_count}! Total placed: {placed_count}, errors: {errors_count}, total stake: ${guard.total_stake_placed:.2f}", flush=True)
                
            time.sleep(1.5)

        time.sleep(2.0)

if __name__ == "__main__":
    with singleton_runner_lock():
        run()
