"""BIA + 1win common signals, durable dry-run tasks and executor reconciliation.

No account transport is provided. Provider parser IDs are evidence only; an
executor must independently verify selection identity and current conditions.
"""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any

class CommonTaskError(ValueError): pass

_GUESSED_UNITS = frozenset({
    "", "unknown", "unverified", "match_base_unit", "unverified_from_dom_only", "guessed",
})
_REQUIRED_AXIS_KEYS = frozenset({"period", "scope", "unit", "market", "side"})

def instant(value):
    if isinstance(value, bool): raise CommonTaskError('invalid clock')
    try:
        if isinstance(value, (int,float)): result=float(value)/1000 if abs(value)>1e11 else float(value)
        else:
            date=datetime.fromisoformat(str(value).replace('Z','+00:00'))
            if date.tzinfo is None: raise ValueError()
            result=date.timestamp()
    except (ValueError,TypeError,OverflowError) as exc: raise CommonTaskError('invalid clock') from exc
    if not math.isfinite(result) or result<=0: raise CommonTaskError('invalid clock')
    return result

def confirmed(quote):
    if quote.get('source_ts') is not None: return instant(quote['source_ts'])
    if quote.get('observed_at_origin') not in {'source','aggregator'} or quote.get('observed_at_semantics')!='provider_confirmation':
        raise CommonTaskError('quote provenance missing')
    observed=instant(quote.get('observed_at'))
    proof=quote.get('state_confirmation')
    if proof is None:return observed
    if not isinstance(proof,dict):raise CommonTaskError('invalid state proof')
    sequence=proof.get('sequence')
    initial,current=instant(proof.get('initialized_at')),instant(proof.get('confirmed_at'))
    if (proof.get('method')!='ordered_delta_pong' or not proof.get('session_id') or not proof.get('subscription_id')
        or not isinstance(sequence,int) or isinstance(sequence,bool) or sequence<=0 or initial>min(observed,current)):
        raise CommonTaskError('invalid state proof')
    return max(observed,current)

def _validate_axes_dict(axes: Any, label: str = "axes") -> dict[str, Any]:
    if not isinstance(axes, dict) or not axes:
        raise CommonTaskError(f"verified {label} required")
    for key in _REQUIRED_AXIS_KEYS:
        val = axes.get(key)
        if not isinstance(val, str) or not val.strip():
            raise CommonTaskError(f"incomplete {label}: missing {key}")
    unit = str(axes.get("unit") or "").strip().lower()
    if unit in _GUESSED_UNITS:
        raise CommonTaskError(f"guessed or unverified market unit in {label}: {unit}")
    return dict(axes)

def task_from_value(pair:dict[str,Any], outcome:dict[str,Any], *, stake:float, idempotency_key:str, now:float):
    if pair.get('first',{}).get('bookmaker','').lower()!='bia' or pair.get('second',{}).get('bookmaker','').lower() not in {'1win','onewin'}:
        raise CommonTaskError('explicit BIA reference + 1win donor required')
    if not pair.get('event_id') or not outcome.get('outcome') or not idempotency_key or len(idempotency_key)>128:
        raise CommonTaskError('event, outcome and idempotency identity required')
    if not isinstance(stake,(int,float)) or isinstance(stake,bool) or not math.isfinite(stake) or stake<=0:
        raise CommonTaskError('positive finite stake required')
    ref,donor=outcome.get('reference_quote'),outcome.get('donor_quote')
    margins=outcome.get('margin_quotes')
    if not isinstance(ref,dict) or not isinstance(donor,dict) or not isinstance(margins,list) or not margins:
        raise CommonTaskError('absolute price and margin evidence required')
    if ref.get('source','').lower()!='bia' or donor.get('source','').lower() not in {'1win','onewin'}:
        raise CommonTaskError('quote source mismatch')
    for quote,match,score in ((ref,pair['first'],outcome.get('score1',{})),(donor,pair['second'],outcome.get('score2',{}))):
        if str(quote.get('source_event_key')) != str(match.get('matchId')) or not quote.get('source_market'):
            raise CommonTaskError('native source event or market mismatch')
        price=quote.get('odds')
        if isinstance(price,bool) or not isinstance(price,(int,float)) or not math.isfinite(price) or price<=1 or price!=score.get('value'):
            raise CommonTaskError('selected price mismatch')
    roi_basis=outcome.get('roi_basis','unknown')
    margin_basis=outcome.get('margin_basis','unknown')
    if roi_basis not in {'unknown','non_void_stake.v1'} or margin_basis not in {'unknown','outcome_partition','non_void_exposure'}:
        raise CommonTaskError('unknown valuation basis')
    if margin_basis=='non_void_exposure' and roi_basis!='non_void_stake.v1':
        raise CommonTaskError('conditional value requires explicit exposure basis')
    ttl=5 if pair.get('isLive') else 60
    clocks=[]
    for quote in [ref,donor,*margins]:
        if quote is not donor and (quote.get('source','').lower()!='bia' or str(quote.get('source_event_key'))!=str(ref.get('source_event_key'))):
            raise CommonTaskError('margin identity mismatch')
        clock=confirmed(quote)
        if clock>now or now-clock>=ttl:raise CommonTaskError('expired or future quote')
        clocks.append(clock)
    return {'schema_version':'automation-task.v1','kind':'value','mode':'dry_run','idempotency_key':idempotency_key,
            'event_id':pair['event_id'],'sport':pair.get('sportName'),'is_live':bool(pair.get('isLive')),
            'outcome_key':outcome['outcome'],'reference_source':'BIA','reference_role':'reference',
            'pinnacle_attributed':False,'donor_source':'1win','quote':dict(donor),
            'reference_quote':dict(ref),'margin_quotes':list(margins),'stake':stake,
            'axes':dict(donor.get('axes') or outcome.get('axes') or {}),
            'valuation_basis':{'roi_basis':roi_basis,'margin_basis':margin_basis},
            'expires_at':min(clocks)+ttl,'execution_ready':False,'execution_blockers':['executor_identity_and_conditions_unverified']}

class DurableDryRunStore:
    def __init__(self,path):
        self._lock=threading.RLock()
        target=Path(path)
        target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        fd=os.open(target,os.O_CREAT|os.O_WRONLY,0o600);os.close(fd);target.chmod(0o600)
        self._db=sqlite3.connect(str(path),check_same_thread=False,isolation_level=None)
        self._db.execute('PRAGMA busy_timeout=5000')
        self._db.execute('CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL)')
    def close(self):self._db.close()
    def prepare(self,task,*,now):
        if task.get('mode')!='dry_run' or task.get('execution_ready') is not False:raise CommonTaskError('dry-run boundary required')
        if now>=task['expires_at']:raise CommonTaskError('expired task')
        raw=json.dumps(task,sort_keys=True,allow_nan=False,separators=(',',':'))
        digest=hashlib.sha256(raw.encode()).hexdigest();key=task['idempotency_key']
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                existing=self._db.execute('SELECT fingerprint,status FROM tasks WHERE key=?',(key,)).fetchone()
                if existing and existing[0]!=digest:raise CommonTaskError('idempotency key changed payload')
                if not existing:self._db.execute('INSERT INTO tasks VALUES (?,?,?,?,?)',(key,digest,raw,'DRY_RUN_READY',0))
                self._db.execute('COMMIT')
                return {'status':existing[1] if existing else 'DRY_RUN_READY','duplicate':existing is not None,'task':task}
            except Exception:self._db.execute('ROLLBACK');raise
    def reconcile(self,key,*,status,revision):
        if status not in {'WITHDRAWN','EXPIRED','INDETERMINATE','DRY_RUN_VERIFIED','REJECTED'} or isinstance(revision,bool) or not isinstance(revision,int) or revision<1:
            raise CommonTaskError('explicit reconciliation revision required')
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                old=self._db.execute('SELECT status,revision FROM tasks WHERE key=?',(key,)).fetchone()
                if old is None:raise CommonTaskError('unknown task')
                if revision<old[1] or (revision==old[1] and status!=old[0]):raise CommonTaskError('stale reconciliation')
                if old[0] in {'WITHDRAWN','EXPIRED','INDETERMINATE','REJECTED'} and old[0]!=status:raise CommonTaskError('terminal task cannot be rearmed')
                self._db.execute('UPDATE tasks SET status=?,revision=? WHERE key=?',(status,revision,key));self._db.execute('COMMIT')
                return status
            except Exception:self._db.execute('ROLLBACK');raise

def verify_executor_quote(task,quote,*,now):
    if now>=task['expires_at']:raise CommonTaskError('expired task')
    expected=task['quote']
    # A parser snapshot cannot self-certify bookmaker execution identity.
    if quote.get('identity_verified_by')!='onewin-executor' or quote.get('verified') is not True:
        raise CommonTaskError('independent executor verification required')
    if any(not isinstance(quote.get(k),str) or not quote[k] for k in ('native_event_id','native_market_id','native_selection_id','currency')):
        raise CommonTaskError('execution identity and currency required')
    if (quote.get('provider_id_namespace')!='top-parser:1win' or quote.get('provider_event_key')!=str(expected['source_event_key'])
            or quote.get('source_market')!=expected['source_market'] or quote.get('odds')!=expected['odds']):
        raise CommonTaskError('executor quote differs from signal')
    expected_axes = expected.get('axes') if expected.get('axes') is not None else task.get('axes')
    quote_axes = quote.get('axes')
    if expected_axes or quote_axes:
        if not isinstance(expected_axes, dict) or not isinstance(quote_axes, dict):
            raise CommonTaskError('executor quote axes mismatch')
        _validate_axes_dict(expected_axes, "expected axes")
        _validate_axes_dict(quote_axes, "executor quote axes")
        if quote_axes != expected_axes:
            raise CommonTaskError('executor quote axes mismatch')
    if confirmed(quote)>now or now-confirmed(quote)>=(5 if task['is_live'] else 60):raise CommonTaskError('executor quote expired')
    commission=quote.get('commission');limit=quote.get('max_stake')
    if isinstance(commission,bool) or not isinstance(commission,(int,float)) or not math.isfinite(commission) or not 0<=commission<1:
        raise CommonTaskError('verified commission required')
    if isinstance(limit,bool) or not isinstance(limit,(int,float)) or not math.isfinite(limit) or limit<task['stake']:
        raise CommonTaskError('verified capacity required')
    return {'schema_version':'automation-dry-run.v1','dry_run':True,'idempotency_key':task['idempotency_key'],
            'event_id':quote['native_event_id'],'market_id':quote['native_market_id'],'selection_id':quote['native_selection_id'],
            'expected_odds':quote['odds'],'currency':quote['currency'],'stake':task['stake'],
            'reference_source':'BIA','pinnacle_attributed':False,'expires_at':task['expires_at']}

def jev_review_payload(task, executor_evidence=None):
    """Jev gateway wire contract for auxiliary review; never placement approval."""
    return {'state':{'task':task,'executor_evidence':executor_evidence,'dry_run':True},
            'questions':{'decision':{'type':'choice',
                'prompt':'Review a dry-run BIA reference and 1win donor task. BIA is an aggregate reference. Parser IDs do not prove bookmaker IDs. Use INVESTIGATE if any identity, freshness, payout or account condition is unknown. This review cannot authorize a bet.',
                'options':{'PASS':'All supplied evidence is consistent for dry-run review only.',
                           'INVESTIGATE':'Required evidence is absent or ambiguous.',
                           'FAIL':'Supplied evidence contradicts the requested task.'}}}}

async def review_with_jev(task, client, question_factory, *, clock):
    """Use the existing injected Jev client; model advice never arms execution."""
    if task.get('mode')!='dry_run' or task.get('execution_ready') is not False:
        raise CommonTaskError('dry-run task required for Jev review')
    if clock()>=task['expires_at']:raise CommonTaskError('expired task before review')
    payload=jev_review_payload(task)
    questions={key:question_factory(prompt=value['prompt'],options=value['options'])
               for key,value in payload['questions'].items()}
    try:
        result=await client.system_one(payload['state'],questions)
        answer=result.choices.get('decision')
        decision=getattr(answer,'choice',None);confidence=getattr(answer,'confidence',None)
        if (decision not in {'PASS','INVESTIGATE','FAIL'} or isinstance(confidence,bool)
                or not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or not 0<=confidence<=1):
            raise CommonTaskError('invalid Jev decision')
        if clock()>=task['expires_at']:raise CommonTaskError('expired task after review')
        return {'schema_version':'automation-review.v1','status':decision,'execution_ready':False,
                'prompt_version':'common-quote-review/2026-10-12','provider':'jev-typesafe',
                'model':getattr(result,'model',''),'confidence':confidence,'confidence_is_calibrated':False}
    except Exception as exc:
        return {'schema_version':'automation-review.v1','status':'INVESTIGATE','execution_ready':False,
                'reason':'review_unavailable_or_invalid','error_type':type(exc).__name__}

class DurableAttemptStore:
    """Atomic, SQLite-backed durable attempt store implementing the placement attempt protocol."""

    is_durable = True

    def __init__(self, path: str | Path, *, max_stake: float | None = None):
        self._lock = threading.RLock()
        self.max_stake = float(max_stake) if max_stake is not None else None
        target = Path(path)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(target, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        target.chmod(0o600)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS attempts ("
            "  key TEXT PRIMARY KEY,"
            "  status TEXT NOT NULL,"
            "  stake REAL NOT NULL,"
            "  currency TEXT NOT NULL,"
            "  event_id TEXT,"
            "  market_id TEXT,"
            "  selection_id TEXT,"
            "  expected_odds REAL,"
            "  payload TEXT NOT NULL,"
            "  receipt TEXT,"
            "  error TEXT,"
            "  created_at REAL NOT NULL,"
            "  updated_at REAL NOT NULL"
            ")"
        )

    def close(self):
        self._db.close()

    def claim(
        self,
        idempotency_key: str,
        *,
        stake: float,
        currency: str = "USDT",
        payload: dict[str, Any],
        max_stake: float | None = None,
        now: float | None = None,
    ) -> bool:
        """Atomically claim an idempotency key with verified stake, currency, and payload."""
        if not isinstance(idempotency_key, str):
            raise CommonTaskError("valid idempotency_key required")
        key = idempotency_key.strip()
        if not key or len(key) > 128:
            raise CommonTaskError("valid idempotency_key required")

        if stake is None or isinstance(stake, bool) or not isinstance(stake, (int, float)) or not math.isfinite(stake) or stake <= 0:
            raise CommonTaskError("stake must be a positive finite number")
        stake_val = float(stake)

        limit = max_stake if max_stake is not None else self.max_stake
        if limit is not None and stake_val > float(limit):
            raise CommonTaskError(f"stake {stake_val:g} exceeds maximum allowed stake {float(limit):g}")

        if currency is None or isinstance(currency, bool) or not isinstance(currency, str):
            raise CommonTaskError("valid currency string required")
        clean_currency = currency.strip().upper()
        if not re.match(r"^[A-Z]{3,6}$", clean_currency):
            raise CommonTaskError("invalid currency code")

        if not isinstance(payload, dict) or not payload:
            raise CommonTaskError("non-empty payload dictionary required")

        if "idempotency_key" in payload and str(payload.get("idempotency_key") or "").strip() != key:
            raise CommonTaskError("payload idempotency_key does not match claim key")
        if "stake" in payload:
            p_stake = payload.get("stake")
            if isinstance(p_stake, bool) or not isinstance(p_stake, (int, float)) or not math.isfinite(p_stake) or abs(float(p_stake) - stake_val) > 1e-9:
                raise CommonTaskError("payload stake does not match claim stake")
        if "currency" in payload and str(payload.get("currency") or "").strip().upper() != clean_currency:
            raise CommonTaskError("payload currency does not match claim currency")

        try:
            raw_payload = json.dumps(payload, sort_keys=True, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise CommonTaskError("payload must be JSON-serializable without NaN") from exc

        sel = payload.get("selection") if isinstance(payload.get("selection"), dict) else {}
        event_id = str(payload.get("event_id") or sel.get("event_id") or "") or None
        market_id = str(payload.get("market_id") or payload.get("odds_group_id") or sel.get("market_id") or "") or None
        selection_id = str(payload.get("selection_id") or sel.get("selection_id") or "") or None
        raw_odds = payload.get("expected_odds") or payload.get("odds") or sel.get("price")
        expected_odds = float(raw_odds) if isinstance(raw_odds, (int, float)) and not isinstance(raw_odds, bool) and math.isfinite(raw_odds) else None

        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts <= 0:
            raise CommonTaskError("invalid claim clock")

        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute("SELECT status FROM attempts WHERE key = ?", (key,)).fetchone()
                if row is not None:
                    self._db.execute("ROLLBACK")
                    return False
                self._db.execute(
                    "INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
                    (key, "CLAIMED", stake_val, clean_currency, event_id, market_id, selection_id, expected_odds, raw_payload, float(ts), float(ts)),
                )
                self._db.execute("COMMIT")
                return True
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def record_status(self, key: str, status: str, *, receipt: dict[str, Any] | None = None, error: str | None = None, now: float | None = None) -> str:
        terminal_statuses = {"ACCEPTED", "REJECTED", "INDETERMINATE", "WITHDRAWN"}
        valid_statuses = {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING", *terminal_statuses}
        if status not in valid_statuses:
            raise CommonTaskError(f"invalid attempt status: {status}")
        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        raw_receipt = json.dumps(receipt, sort_keys=True, allow_nan=False) if receipt is not None else None
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute("SELECT status FROM attempts WHERE key = ?", (key,)).fetchone()
                if row is None:
                    raise CommonTaskError("unknown attempt key")
                current = row[0]
                if current in terminal_statuses and current != status:
                    raise CommonTaskError(f"terminal attempt ({current}) cannot transition to {status}")
                self._db.execute(
                    "UPDATE attempts SET status = ?, receipt = COALESCE(?, receipt), error = COALESCE(?, error), updated_at = ? WHERE key = ?",
                    (status, raw_receipt, error, float(ts), key),
                )
                self._db.execute("COMMIT")
                return status
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def get_attempt(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT key, status, stake, currency, event_id, market_id, selection_id, expected_odds, payload, receipt, error, created_at, updated_at FROM attempts WHERE key = ?",
                (key,),
            ).fetchone()
            if not row:
                return None
            return {
                "key": row[0],
                "status": row[1],
                "stake": row[2],
                "currency": row[3],
                "event_id": row[4],
                "market_id": row[5],
                "selection_id": row[6],
                "expected_odds": row[7],
                "payload": json.loads(row[8]),
                "receipt": json.loads(row[9]) if row[9] else None,
                "error": row[10],
                "created_at": row[11],
                "updated_at": row[12],
            }


def assess_live_readiness(
    task: dict[str, Any],
    quote: dict[str, Any] | None = None,
    account_state: dict[str, Any] | None = None,
    *,
    now: float | None = None,
    max_stake: float | None = None,
    diagnostic_only: bool = False,
) -> dict[str, Any]:
    """Evaluate live execution readiness and return explicit blockers without inventing conditions."""
    blockers: list[str] = []
    ts = now if now is not None else datetime.now(timezone.utc).timestamp()

    if not isinstance(task, dict):
        return {"execution_ready": False, "execution_blockers": ["invalid_task"]}

    expires_at = task.get("expires_at")
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at) or ts >= expires_at:
        blockers.append("task_expired_or_missing_expiry")

    stake = task.get("stake")
    if isinstance(stake, bool) or not isinstance(stake, (int, float)) or not math.isfinite(stake) or stake <= 0:
        blockers.append("invalid_stake")
    else:
        if diagnostic_only and abs(float(stake) - 1.0) > 1e-9:
            blockers.append("diagnostic_stake_must_be_1_usdt")
        if max_stake is not None and float(stake) > float(max_stake):
            blockers.append("stake_exceeds_max_stake")

    if not isinstance(account_state, dict) or account_state.get("logged_in") is not True:
        blockers.append("account_not_authenticated")
    else:
        if account_state.get("currency") != "USDT":
            blockers.append("unsupported_account_currency")
        if account_state.get("account_identity_verified") is False or account_state.get("email_matches_expected") is False:
            blockers.append("account_identity_mismatch")
        elif account_state.get("account_identity_verified") is not True and account_state.get("email_matches_expected") is not True:
            blockers.append("account_identity_unverified")
        avail = account_state.get("available_balance")
        if isinstance(avail, bool) or not isinstance(avail, (int, float)) or not math.isfinite(avail) or (isinstance(stake, (int, float)) and avail < stake):
            blockers.append("insufficient_or_unverified_wallet_balance")

    if not isinstance(quote, dict) or quote.get("identity_verified_by") != "onewin-executor" or quote.get("verified") is not True:
        blockers.append("executor_identity_unverified")
    else:
        if quote.get("live_submit_contract_verified") is not True:
            blockers.append("unverified_live_submit_wire_contract")
        commission = quote.get("commission")
        if isinstance(commission, bool) or not isinstance(commission, (int, float)) or not math.isfinite(commission) or not 0 <= commission < 1:
            blockers.append("unverified_commission")
        limit = quote.get("max_stake")
        if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit) or (isinstance(stake, (int, float)) and limit < stake):
            blockers.append("unverified_or_insufficient_capacity")
        try:
            expected_axes = (task.get("quote") or {}).get("axes") or task.get("axes")
            _validate_axes_dict(expected_axes, "expected axes")
            _validate_axes_dict(quote.get("axes"), "executor quote axes")
            if quote.get("axes") != expected_axes:
                blockers.append("axes_mismatch")
        except CommonTaskError:
            blockers.append("missing_or_unverified_axes")

    return {
        "execution_ready": len(blockers) == 0,
        "execution_blockers": blockers,
    }


def verify_live_execution_conditions(
    task: dict[str, Any],
    quote: dict[str, Any],
    account_state: dict[str, Any],
    *,
    now: float,
    max_stake: float | None = None,
    diagnostic_only: bool = False,
) -> dict[str, Any]:
    """Strict pre-execution conditions verifier for live execution.

    Fails closed if the quote is stale, prices or axes drifted, axes or units
    are missing/guessed, account is not authenticated or verified, currency is
    not USDT, commission or capacity is unverified, or stake exceeds the
    configured budget (1.0 USDT when diagnostic_only=True).
    """
    if isinstance(now, bool) or not isinstance(now, (int, float)) or not math.isfinite(now) or now <= 0:
        raise CommonTaskError("invalid clock")
    if not isinstance(account_state, dict) or account_state.get("logged_in") is not True:
        raise CommonTaskError("account is not logged in")
    if account_state.get("account_identity_verified") is False or account_state.get("email_matches_expected") is False:
        raise CommonTaskError("account identity mismatch")
    if account_state.get("currency") != "USDT":
        raise CommonTaskError("account currency must be USDT")

    stake = task.get("stake")
    if stake is None or isinstance(stake, bool) or not isinstance(stake, (int, float)) or not math.isfinite(stake) or stake <= 0:
        raise CommonTaskError("invalid stake")
    stake_val = float(stake)

    if diagnostic_only and abs(stake_val - 1.0) > 1e-9:
        raise CommonTaskError("diagnostic test budget is exactly 1.0 USDT")
    if max_stake is not None and stake_val > float(max_stake):
        raise CommonTaskError(f"stake {stake_val:g} exceeds maximum allowed stake {float(max_stake):g}")

    avail_balance = account_state.get("available_balance")
    if (
        isinstance(avail_balance, bool)
        or not isinstance(avail_balance, (int, float))
        or not math.isfinite(avail_balance)
        or avail_balance < stake_val
    ):
        raise CommonTaskError("insufficient or unverified wallet balance")

    expected = task.get("quote") if isinstance(task.get("quote"), dict) else {}
    expected_axes = expected.get("axes") if expected.get("axes") is not None else task.get("axes")
    quote_axes = quote.get("axes") if isinstance(quote, dict) else None
    _validate_axes_dict(expected_axes, "expected axes")
    _validate_axes_dict(quote_axes, "executor quote axes")

    verified = verify_executor_quote(task, quote, now=now)
    if verified["currency"] != "USDT":
        raise CommonTaskError("executor quote currency must be USDT")

    return {
        "schema_version": "automation-live-order.v1",
        "live": True,
        "execution_ready": True,
        "execution_blockers": [],
        "idempotency_key": verified["idempotency_key"],
        "event_id": verified["event_id"],
        "market_id": verified["market_id"],
        "selection_id": verified["selection_id"],
        "odds": verified["expected_odds"],
        "stake": stake_val,
        "currency": "USDT",
        "axes": dict(quote_axes),
        "commission": float(quote["commission"]),
        "max_stake": float(quote["max_stake"]),
        "expires_at": verified["expires_at"],
    }
