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
import sqlite3
import threading
from typing import Any

class CommonTaskError(ValueError): pass

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
    expected_axes = expected.get('axes') or task.get('axes') or {}
    quote_axes = quote.get('axes') or {}
    if expected_axes and quote_axes != expected_axes:
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
    """Atomic, durable attempt store implementing the placement attempt protocol."""

    def __init__(self, path: str | Path):
        self._lock = threading.RLock()
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
            "  payload TEXT NOT NULL,"
            "  receipt TEXT,"
            "  error TEXT,"
            "  created_at REAL NOT NULL,"
            "  updated_at REAL NOT NULL"
            ")"
        )

    def close(self):
        self._db.close()

    def claim(self, idempotency_key: str, *, stake: float = 1.0, currency: str = "USDT", payload: dict[str, Any] | None = None, now: float | None = None) -> bool:
        """Atomically claim an idempotency key. Returns False if already claimed."""
        key = str(idempotency_key or "").strip()
        if not key or len(key) > 128:
            raise CommonTaskError("valid idempotency_key required")
        if stake > 1.0 or stake <= 0:
            raise CommonTaskError("stake exceeds single test budget of 1.0 USDT")
        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        raw_payload = json.dumps(payload or {}, sort_keys=True, allow_nan=False, separators=(",", ":"))
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute("SELECT status FROM attempts WHERE key = ?", (key,)).fetchone()
                if row is not None:
                    self._db.execute("ROLLBACK")
                    return False
                self._db.execute(
                    "INSERT INTO attempts VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
                    (key, "CLAIMED", float(stake), currency, raw_payload, ts, ts),
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
        raw_receipt = json.dumps(receipt, sort_keys=True, allow_nan=False) if receipt else None
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
                    (status, raw_receipt, error, ts, key),
                )
                self._db.execute("COMMIT")
                return status
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def get_attempt(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT key, status, stake, currency, payload, receipt, error, created_at, updated_at FROM attempts WHERE key = ?",
                (key,),
            ).fetchone()
            if not row:
                return None
            return {
                "key": row[0],
                "status": row[1],
                "stake": row[2],
                "currency": row[3],
                "payload": json.loads(row[4]),
                "receipt": json.loads(row[5]) if row[5] else None,
                "error": row[6],
                "created_at": row[7],
                "updated_at": row[8],
            }


def verify_live_execution_conditions(
    task: dict[str, Any],
    quote: dict[str, Any],
    account_state: dict[str, Any],
    *,
    now: float,
) -> dict[str, Any]:
    """Strict pre-execution conditions verifier for the single 1 USDT diagnostic test.

    Fails closed if the quote is stale, prices drifted, account is not authenticated,
    currency is not USDT, or stake exceeds the 1 USDT budget.
    """
    if now >= task["expires_at"]:
        raise CommonTaskError("task expired")
    if not account_state.get("logged_in"):
        raise CommonTaskError("account is not logged in")
    if account_state.get("currency") != "USDT":
        raise CommonTaskError("account currency must be USDT")

    stake = task.get("stake")
    if isinstance(stake, bool) or not isinstance(stake, (int, float)) or not math.isfinite(stake):
        raise CommonTaskError("invalid stake")
    if stake > 1.0 or stake <= 0:
        raise CommonTaskError("stake exceeds 1.0 USDT diagnostic test budget")

    avail_balance = account_state.get("available_balance")
    if isinstance(avail_balance, (int, float)) and avail_balance < stake:
        raise CommonTaskError("insufficient wallet balance")

    if quote.get("identity_verified_by") != "onewin-executor" or quote.get("verified") is not True:
        raise CommonTaskError("independent executor verification required")

    expected = task["quote"]
    if (
        quote.get("provider_id_namespace") != "top-parser:1win"
        or quote.get("provider_event_key") != str(expected["source_event_key"])
        or quote.get("source_market") != expected["source_market"]
        or quote.get("odds") != expected["odds"]
    ):
        raise CommonTaskError("executor quote differs from signal")
    expected_axes = expected.get("axes") or task.get("axes") or {}
    quote_axes = quote.get("axes") or {}
    if expected_axes and quote_axes != expected_axes:
        raise CommonTaskError("executor quote axes mismatch")

    if confirmed(quote) > now or now - confirmed(quote) >= (5 if task["is_live"] else 60):
        raise CommonTaskError("executor quote expired")

    limit = quote.get("max_stake")
    if isinstance(limit, (int, float)) and limit < stake:
        raise CommonTaskError("market capacity below stake")

    return {
        "schema_version": "automation-live-order.v1",
        "live": True,
        "idempotency_key": task["idempotency_key"],
        "event_id": quote.get("native_event_id"),
        "market_id": quote.get("native_market_id"),
        "selection_id": quote.get("native_selection_id"),
        "odds": quote["odds"],
        "stake": stake,
        "currency": "USDT",
        "expires_at": task["expires_at"],
    }
