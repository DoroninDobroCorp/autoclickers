import os, sys, time, json, asyncio, httpx

from autoplace_guard import AutoplaceGuard, singleton_runner_lock

BASE_URL = "http://127.0.0.1:8899"

async def verify_cand(client, cand, headers, sem):
    arb_id = cand["id"]
    min_interval = float(os.environ.get("ROBINARB_PINNACLE_CLIENT_MIN_INTERVAL_SEC", "0.3"))
    async with sem:
        try:
            r = await client.post("/api/verify", json={"arb_id": arb_id, "verify_mode": "betslip"}, headers=headers)
            await asyncio.sleep(min_interval)
            if r.status_code == 200:
                v_data = r.json()
                if v_data.get("verified") and v_data.get("quote_id"):
                    try:
                        cr = await client.post("/api/counter/verify", json={"arb_id": arb_id, "verify_mode": "betslip"}, headers=headers)
                        if cr.status_code == 200:
                            c_data = cr.json()
                            c_verified = c_data.get("verified", False)
                            c_status = str(c_data.get("status") or "").upper()
                            live_robin_odds = float(c_data.get("current_odds") or 0)
                            snapshot_robin_odds = float(c_data.get("feed_odds") or v_data.get("robin_odds") or cand.get("bk2_odds", 0))

                            if not c_verified or c_status in ("STALE", "UNAVAILABLE") or live_robin_odds <= 0:
                                print(f"[COUNTER VERIFY REJECTED] Arb {arb_id}: verified={c_verified}, status={c_status}, live_odds={live_robin_odds}", flush=True)
                                return cand, None

                            slippage_tol = float(os.environ.get("ROBINARB_SLIPPAGE_TOLERANCE", "0.02"))
                            if live_robin_odds < snapshot_robin_odds - slippage_tol:
                                print(f"[SKIP SLIPPAGE] Arb {arb_id}: Betfair live odds {live_robin_odds:.3f} < snapshot {snapshot_robin_odds:.3f} (tol={slippage_tol})", flush=True)
                                return cand, None

                            v_data["robin_odds"] = live_robin_odds
                            return cand, v_data
                    except Exception as ce:
                        print(f"[COUNTER VERIFY ERR] Arb {arb_id}: {ce}", flush=True)
                        return cand, None
        except Exception:
            pass
    return cand, None

async def main():
    username = os.environ.get("ROBINARB_USERNAME", "owner")
    password = os.environ.get("ROBINARB_PASSWORD", "owner123")
    max_concurrency = int(os.environ.get("ROBINARB_ASYNC_CONCURRENCY", "3"))
    sem = asyncio.Semaphore(max_concurrency) # Bounded rate-limited verify requests
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=40.0) as client:
        r = await client.post("/api/auth/login", json={"username": username, "password": password})
        if r.status_code != 200:
            print("[ERROR] Login failed:", r.status_code)
            return
        token = r.json()["token"]
        headers = {"Authorization": "Bearer " + token}
        print("[INIT] Async Auto Placement Runner started across ALL candidates.")
        
        placed_count = 0
        errors_count = 0
        seen_keys = set()
        guard = AutoplaceGuard()
        
        for loop in range(1, 100):
            should_stop, reason = guard.check_limits()
            if should_stop:
                print(reason, flush=True)
                return

            print(f"\n=== [Loop #{loop}] Fetching Arbs ===", flush=True)
            try:
                arbs_resp = (await client.get("/api/arbs", headers=headers)).json()
            except Exception as e:
                print(f"[ERROR] Fetch arbs failed: {e}", flush=True)
                await asyncio.sleep(2)
                continue
                
            arbs = arbs_resp.get("arbs", []) if isinstance(arbs_resp, dict) else arbs_resp
            bf_arbs = [
                a for a in arbs
                if "paddypower" in a.get("bk2", "").lower()
                or "betfair" in a.get("bk2", "").lower()
                or "betfair" in a.get("bk1", "").lower()
            ]
            print(f"[SCAN] Checking ALL {len(bf_arbs)} candidates with concurrency {max_concurrency}...", flush=True)
            
            tasks = [verify_cand(client, c, headers, sem) for c in bf_arbs]
            results = await asyncio.gather(*tasks)
            
            verified_pairs = [res for res in results if res[1] is not None]
            print(f"[VERIFIED] Found {len(verified_pairs)} verified active candidate(s) in entire feed.", flush=True)
            
            for cand, v_resp in verified_pairs:
                arb_id = cand["id"]
                quote_id = v_resp["quote_id"]
                match_name = cand.get("match", "Unknown")
                market_type = cand.get("market_type", "Unknown")
                
                dedup_key = (match_name, market_type, str(arb_id))
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)
                
                pin_odds = float(v_resp.get("odds") or cand.get("bk1_odds", 0))
                snapshot = v_resp.get("arb_snapshot") if isinstance(v_resp.get("arb_snapshot"), dict) else {}
                robin_odds = float(v_resp.get("robin_odds") or snapshot.get("robin_odds") or cand.get("bk2_odds", 0))
                
                print(f"\n[TARGET FOUND] Arb {arb_id} | {match_name} | {market_type}", flush=True)
                print(f"               Quote: {quote_id} | Pin: {pin_odds} | Betfair: {robin_odds}", flush=True)
                
                # --- Leg 1: Betfair ($1.0) ---
                print(f"---> [LEG 1: BETFAIR] Placing $1.0 @ {robin_odds}...", flush=True)
                p_payload = {"arb_id": arb_id, "side": "robinbet", "stake": 1.0, "odds": robin_odds, "quote_id": quote_id, "verify_mode": "betslip"}
                try:
                    p_resp = await client.post("/api/bet", json=p_payload, headers=headers)
                    if p_resp.status_code == 429:
                        print("[RATE LIMIT] Sleeping 1.2s and retrying Betfair...", flush=True)
                        await asyncio.sleep(1.2)
                        p_resp = await client.post("/api/bet", json=p_payload, headers=headers)
                except Exception as exc:
                    guard.record_error()
                    errors_count += 1
                    print(f"[LEG 1 EXCEPTION] Arb {arb_id}: {exc}", flush=True)
                    print(f"[EMERGENCY STOP] UNKNOWN LEG 1 STATE, ручное вмешательство! Leg 1 (Betfair) POST raised an exception -- whether the Betfair position was placed is unknown. Arb {arb_id} | Quote {quote_id} | {match_name}: {exc}", flush=True)
                    return

                if p_resp.status_code != 200:
                    guard.record_error()
                    errors_count += 1
                    print(f"[LEG 1 ERR] Status {p_resp.status_code}: {p_resp.text[:300]}", flush=True)
                    continue
                    
                p_data = p_resp.json()
                st = p_data.get("status")
                bid = p_data.get("bet_id")
                print(f"[LEG 1 OK] Status: {st} | Bet ID: {bid}", flush=True)
                
                if st in ("pending_reconciliation", "UNKNOWN", "pending"):
                    print(f"[LEG 1 PENDING] Status is {st}, reconciling bet {bid}...", flush=True)
                    for _rec in range(5):
                        await asyncio.sleep(1.0)
                        try:
                            rec_resp = await client.post("/api/bet/reconcile", params={"bet_id": bid}, headers=headers)
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
                
                # --- Leg 2: Pinnacle ---
                stake1 = 1.0
                stake2 = max(0.1, round((stake1 * robin_odds) / max(pin_odds, 1.01), 2))
                await asyncio.sleep(0.5)
                print(f"---> [LEG 2: PINNACLE] Placing ${stake2:.2f} @ {pin_odds} (hedged)...", flush=True)
                t0 = time.time()
                b_payload = {"arb_id": arb_id, "side": "pinnacle", "stake": stake2, "odds": pin_odds, "quote_id": quote_id, "verify_mode": "betslip"}
                try:
                    b_resp = await client.post("/api/bet", json=b_payload, headers=headers)
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
                        print(f"[STOP] Pinnacle limit hit: {err_msg[:200]}", flush=True)
                    return
                else:
                    b_data = b_resp.json()
                    bst = b_data.get("status")
                    bbid = b_data.get("bet_id")
                    placed_count += 1
                    guard.record_success(1.0 + stake2)
                    print(f"[LEG 2 SUCCESS] ({dt:.2f}s) Status: {bst} | Bet ID: {bbid}", flush=True)
                    print(f"[PROGRESS] Successfully placed live two-leg arb pair #{placed_count}! Total OK: {placed_count}, Errors: {errors_count}", flush=True)
                
                await asyncio.sleep(1.0)
                
            await asyncio.sleep(2.0)

if __name__ == "__main__":
    with singleton_runner_lock():
        asyncio.run(main())
