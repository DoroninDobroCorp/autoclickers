"""BIA + 1win common signals, durable dry-run tasks and executor reconciliation.

No account transport is provided. Provider parser IDs are evidence only; an
executor must independently verify selection identity and current conditions.
"""
from __future__ import annotations
import copy
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

from .axes import (
    ADAPTER_VERSION as AXES_ADAPTER_VERSION,
    AxesContractError,
    compare_facts,
    normalise_axes,
    public_facts,
)

class CommonTaskError(ValueError):
    """A task, quote or attempt record violates the common execution contract.

    ``blockers`` carries the machine-readable reasons when the error comes from
    the strict live-conditions engine.
    """

    def __init__(self, message: str = "", blockers: list[str] | None = None):
        super().__init__(message)
        self.blockers = list(blockers or [])

LIVE_TTL_SECONDS = 5
PREMATCH_TTL_SECONDS = 60

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

def _donor_axes(quote: Any, fallback: Any = None) -> Any:
    """Platform serialises axes as ``market_axes``; legacy fixtures used ``axes``."""
    if isinstance(quote, dict):
        for key in ("market_axes", "axes"):
            value = quote.get(key)
            if isinstance(value, dict) and value:
                return value
    return fallback if isinstance(fallback, dict) and fallback else None


def _normalised_axes(axes: Any, contexts: tuple[Any, ...] = (), label: str = "axes") -> dict[str, Any]:
    try:
        return normalise_axes(axes, contexts=contexts)
    except AxesContractError as exc:
        raise CommonTaskError(f"{label}: {exc}", [exc.code]) from exc


def _valid_clock_argument(value: Any) -> bool:
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value > 0)


def _finite_positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _ttl(is_live: Any) -> int:
    return LIVE_TTL_SECONDS if is_live else PREMATCH_TTL_SECONDS


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
    ttl=_ttl(pair.get('isLive'))
    clocks=[]
    for quote in [ref,donor,*margins]:
        if quote is not donor and (quote.get('source','').lower()!='bia' or str(quote.get('source_event_key'))!=str(ref.get('source_event_key'))):
            raise CommonTaskError('margin identity mismatch')
        clock=confirmed(quote)
        if clock>now or now-clock>=ttl:raise CommonTaskError('expired or future quote')
        clocks.append(clock)
    # Executability follows the donor leg only.  The BIA reference may express
    # the same outcome through a different family (e.g. DC X2 as handicap +0.5),
    # so reference axes are retained for audit and never compared here.
    donor_axes=_donor_axes(donor,outcome.get('axes'))
    reference_axes=_donor_axes(ref)
    blockers=['executor_identity_and_conditions_unverified']
    contract={'adapter_version':AXES_ADAPTER_VERSION}
    try:
        if donor_axes is None:raise AxesContractError('axes_missing','verified axes required')
        normalised=normalise_axes(donor_axes,contexts=(ref,donor))
        contract.update(status='complete',schema=normalised['schema'],facts=public_facts(normalised))
        if normalised['facts']['payout_rule']['status']!='proven':blockers.append('payout_rule_unverified')
    except AxesContractError as exc:
        contract.update(status='incomplete',reason=exc.code)
        blockers.append(exc.code if exc.code.startswith('axes_') else f'axes_incomplete:{exc.code}')
    return {'schema_version':'automation-task.v1','kind':'value','mode':'dry_run','idempotency_key':idempotency_key,
            'event_id':pair['event_id'],'sport':pair.get('sportName'),'is_live':bool(pair.get('isLive')),
            'outcome_key':outcome['outcome'],'reference_source':'BIA','reference_role':'reference',
            'pinnacle_attributed':False,'donor_source':'1win','quote':dict(donor),
            'reference_quote':dict(ref),'margin_quotes':list(margins),'stake':stake,
            'axes':copy.deepcopy(donor_axes) if donor_axes else {},
            'axes_contract':contract,
            'reference_axes':copy.deepcopy(reference_axes) if reference_axes else None,
            'valuation_basis':{'roi_basis':roi_basis,'margin_basis':margin_basis},
            'expires_at':min(clocks)+ttl,'execution_ready':False,'execution_blockers':blockers}


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


_NON_EMPTY_ID_KEYS=('native_event_id','native_market_id','native_selection_id')


def _non_empty_text(value:Any)->bool:
    return isinstance(value,str) and bool(value.strip())


def _task_expected_axes(task:dict[str,Any]):
    expected=task.get('quote') if isinstance(task.get('quote'),dict) else {}
    return _donor_axes(expected,task.get('axes'))


def _quote_checks(task:dict[str,Any],quote:Any,*,now:float,ttl:int,stake:float|None):
    """Pure decision about the independent executor evidence.

    Returns ``(blockers, info)``; never raises.  Shared by the dry-run verifier
    and the live engine so that both views cannot diverge.
    """
    blockers:list[str]=[];info:dict[str,Any]={}
    # A parser snapshot cannot self-certify bookmaker execution identity.
    if not isinstance(quote,dict) or quote.get('identity_verified_by')!='onewin-executor' or quote.get('verified') is not True:
        return ['executor_identity_unverified'],info
    expected=task.get('quote') if isinstance(task.get('quote'),dict) else {}
    if any(not _non_empty_text(quote.get(k)) for k in _NON_EMPTY_ID_KEYS) or not _non_empty_text(quote.get('currency')):
        blockers.append('native_identity_incomplete')
    execution=expected.get('execution') if isinstance(expected.get('execution'),dict) else {}
    binding=[]
    if quote.get('provider_id_namespace')!='top-parser:1win':binding.append('namespace')
    if expected.get('source_event_key') is None or quote.get('provider_event_key')!=str(expected.get('source_event_key')):binding.append('event')
    if not _non_empty_text(expected.get('source_market')) or quote.get('source_market')!=expected.get('source_market'):binding.append('market')
    expected_odds=_finite_number(expected.get('odds'));quoted_odds=_finite_number(quote.get('odds'))
    if expected_odds is None or quoted_odds is None or quoted_odds!=expected_odds:binding.append('price')
    # The parser may name the market/selection it saw; the executor's own native
    # identity has to be the same object, otherwise the market identity changed.
    for parser_key,native_key,label in (('provider_market_key','native_market_id','market_id'),
                                        ('provider_selection_key','native_selection_id','selection_id')):
        claimed=execution.get(parser_key)
        if claimed is not None and str(claimed)!=str(quote.get(native_key)):binding.append(label)
    if binding:
        blockers.append('executor_binding_mismatch');info['binding_mismatch']=binding
    try:
        expected_axes=_task_expected_axes(task)
        if expected_axes is None:raise AxesContractError('axes_missing','verified expected axes required')
        quote_axes=quote.get('market_axes') if isinstance(quote.get('market_axes'),dict) and quote.get('market_axes') else quote.get('axes')
        if not isinstance(quote_axes,dict) or not quote_axes:raise AxesContractError('axes_missing','executor axes required')
        contexts=(task.get('reference_quote'),expected)
        expected_n=normalise_axes(expected_axes,contexts=contexts)
        actual_n=normalise_axes(quote_axes,contexts=(quote,))
        differing=compare_facts(expected_n,actual_n)
        if differing:
            blockers.append('axes_mismatch');info['axes_mismatch']=differing
        if expected_n['facts']['payout_rule']['status']!='proven':blockers.append('payout_rule_unverified')
        info['expected_axes']=expected_n;info['actual_axes']=actual_n
    except AxesContractError as exc:
        blockers.append('missing_or_unverified_axes');info['axes_error']=exc.code
    clock=None
    try:
        clock=confirmed(quote)
    except CommonTaskError:
        blockers.append('executor_quote_clock_unproven')
    if clock is not None:
        info['executor_clock']=clock
        if clock>now:blockers.append('executor_quote_in_future')
        elif now-clock>=ttl:blockers.append('executor_quote_expired')
    commission=_finite_number(quote.get('commission'))
    if commission is None or not 0<=commission<1:blockers.append('unverified_commission')
    limit=_finite_number(quote.get('max_stake'))
    if limit is None or stake is None or limit<stake:blockers.append('unverified_or_insufficient_capacity')
    return blockers,info


def verify_executor_quote(task,quote,*,now):
    if not _valid_clock_argument(now):raise CommonTaskError('invalid clock',['invalid_clock'])
    if not isinstance(task,dict):raise CommonTaskError('invalid task',['invalid_task'])
    expires=_finite_positive(task.get('expires_at'))
    if expires is None or now>=expires:raise CommonTaskError('expired task',['task_expired_or_missing_expiry'])
    stake=_finite_positive(task.get('stake'))
    blockers,info=_quote_checks(task,quote,now=now,ttl=_ttl(task.get('is_live')),stake=stake)
    if blockers:raise CommonTaskError('executor quote rejected: '+','.join(blockers),blockers)
    return {'schema_version':'automation-dry-run.v1','dry_run':True,'idempotency_key':task['idempotency_key'],
            'event_id':quote['native_event_id'],'market_id':quote['native_market_id'],'selection_id':quote['native_selection_id'],
            'expected_odds':quote['odds'],'currency':quote['currency'],'stake':task['stake'],
            'reference_source':'BIA','pinnacle_attributed':False,'expires_at':task['expires_at'],
            'axes_adapter_version':AXES_ADAPTER_VERSION,
            'settlement_facts':public_facts(info['actual_axes'])}


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


_TERMINAL_STATUSES=frozenset({'ACCEPTED','REJECTED','INDETERMINATE','WITHDRAWN'})
_VALID_STATUSES=frozenset({'CLAIMED','PRE_CHECK_PASSED','SUBMITTING'})|_TERMINAL_STATUSES
# Legal phase changes.  Terminal states have no outgoing edge; a potential
# submit (SUBMITTING) can only resolve into a bookmaker outcome or into
# INDETERMINATE, never back and never to WITHDRAWN without proof.
_TRANSITIONS={
    'CLAIMED':frozenset({'PRE_CHECK_PASSED','SUBMITTING','WITHDRAWN'}),
    'PRE_CHECK_PASSED':frozenset({'SUBMITTING','WITHDRAWN'}),
    'SUBMITTING':frozenset({'ACCEPTED','REJECTED','INDETERMINATE'}),
}
_CURRENCY_RE=re.compile(r'^[A-Z]{3,6}$')
_ATTEMPT_COLUMNS=('key','status','stake','currency','event_id','market_id','selection_id','expected_odds',
                  'payload','receipt','error','created_at','updated_at')


def _receipt_identifier(receipt:Any)->str|None:
    if not isinstance(receipt,dict):return None
    for key in ('bet_id','receipt_id'):
        value=receipt.get(key)
        if isinstance(value,str) and value.strip():return value.strip()
        if isinstance(value,int) and not isinstance(value,bool) and value>0:return str(value)
    return None


def _canonical_json(value:Any)->str:
    return json.dumps(value,sort_keys=True,allow_nan=False,separators=(',',':'))


class DurableAttemptStore:
    """Atomic, SQLite-backed durable attempt store implementing the placement attempt protocol.

    Terminal attempts are sealed: neither the status nor the receipt, error,
    stake, currency or payload can change.  Repeating an identical terminal
    record is an idempotent no-op; a conflicting one is refused.  Corrections
    are appended through :meth:`add_revision` and never rewrite the attempt.
    Persisted rows are validated when the store is opened and on every read,
    and a corrupt row makes the store fail closed without modifying the file.
    """

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
        try:
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
            # Validate before any schema change so that a corrupt store is not touched.
            self._validate_all_rows()
            self._db.execute("PRAGMA synchronous=FULL")
            if self._db.execute("PRAGMA synchronous").fetchone()[0] != 2:
                raise CommonTaskError("durable store cannot use synchronous=FULL")
            self._install_seals()
        except BaseException:
            self._db.close()
            raise

    # -- integrity ---------------------------------------------------------
    def _install_seals(self) -> None:
        statements = (
            "CREATE TABLE IF NOT EXISTS attempt_revisions ("
            "  key TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,"
            "  created_at REAL NOT NULL, PRIMARY KEY (key, seq))",
            "CREATE TRIGGER IF NOT EXISTS attempts_sealed_update BEFORE UPDATE ON attempts "
            "WHEN OLD.status IN ('ACCEPTED','REJECTED','INDETERMINATE','WITHDRAWN') "
            "BEGIN SELECT RAISE(ABORT,'sealed terminal attempt'); END",
            "CREATE TRIGGER IF NOT EXISTS attempts_identity_immutable BEFORE UPDATE ON attempts "
            "WHEN NEW.key IS NOT OLD.key OR NEW.stake IS NOT OLD.stake OR NEW.currency IS NOT OLD.currency "
            "OR NEW.payload IS NOT OLD.payload OR NEW.created_at IS NOT OLD.created_at "
            "OR NEW.event_id IS NOT OLD.event_id OR NEW.market_id IS NOT OLD.market_id "
            "OR NEW.selection_id IS NOT OLD.selection_id OR NEW.expected_odds IS NOT OLD.expected_odds "
            "BEGIN SELECT RAISE(ABORT,'attempt identity is immutable'); END",
            "CREATE TRIGGER IF NOT EXISTS attempts_append_only BEFORE DELETE ON attempts "
            "BEGIN SELECT RAISE(ABORT,'attempts are append-only'); END",
            "CREATE TRIGGER IF NOT EXISTS attempt_revisions_append_only_update BEFORE UPDATE ON attempt_revisions "
            "BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END",
            "CREATE TRIGGER IF NOT EXISTS attempt_revisions_append_only_delete BEFORE DELETE ON attempt_revisions "
            "BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END",
        )
        for statement in statements:
            self._db.execute(statement)

    @staticmethod
    def _corrupt(key: Any, reason: str) -> CommonTaskError:
        return CommonTaskError(f"corrupt durable attempt store: attempt {key!r}: {reason}", ["corrupt_attempt_store"])

    def _validate_row(self, row: tuple) -> dict[str, Any]:
        record = dict(zip(_ATTEMPT_COLUMNS, row))
        key = record['key']
        if not isinstance(key, str) or not key.strip() or len(key) > 128 or key != key.strip():
            raise self._corrupt(key, 'invalid key')
        if record['status'] not in _VALID_STATUSES:
            raise self._corrupt(key, f"unknown status {record['status']!r}")
        stake = record['stake']
        if isinstance(stake, bool) or not isinstance(stake, (int, float)) or not math.isfinite(stake) or stake <= 0:
            raise self._corrupt(key, 'stake must be a positive finite number')
        if not isinstance(record['currency'], str) or not _CURRENCY_RE.match(record['currency']):
            raise self._corrupt(key, 'invalid currency')
        for name in ('event_id', 'market_id', 'selection_id', 'error'):
            if record[name] is not None and not isinstance(record[name], str):
                raise self._corrupt(key, f'{name} must be text')
        odds = record['expected_odds']
        if odds is not None and (isinstance(odds, bool) or not isinstance(odds, (int, float))
                                 or not math.isfinite(odds) or odds <= 0):
            raise self._corrupt(key, 'invalid expected_odds')
        try:
            payload = json.loads(record['payload'])
        except (TypeError, ValueError):
            raise self._corrupt(key, 'payload is not JSON') from None
        if not isinstance(payload, dict) or not payload:
            raise self._corrupt(key, 'payload must be a non-empty object')
        if 'idempotency_key' in payload and str(payload.get('idempotency_key') or '').strip() != key:
            raise self._corrupt(key, 'payload idempotency_key mismatch')
        if 'stake' in payload:
            p_stake = payload['stake']
            if isinstance(p_stake, bool) or not isinstance(p_stake, (int, float)) or abs(float(p_stake) - float(stake)) > 1e-9:
                raise self._corrupt(key, 'payload stake mismatch')
        if 'currency' in payload and str(payload.get('currency') or '').strip().upper() != record['currency']:
            raise self._corrupt(key, 'payload currency mismatch')
        receipt = None
        if record['receipt'] is not None:
            try:
                receipt = json.loads(record['receipt'])
            except (TypeError, ValueError):
                raise self._corrupt(key, 'receipt is not JSON') from None
            if not isinstance(receipt, dict):
                raise self._corrupt(key, 'receipt must be an object')
        if record['status'] == 'ACCEPTED' and _receipt_identifier(receipt) is None:
            raise self._corrupt(key, 'accepted attempt without receipt identifier')
        created, updated = record['created_at'], record['updated_at']
        for clock in (created, updated):
            if isinstance(clock, bool) or not isinstance(clock, (int, float)) or not math.isfinite(clock) or clock <= 0:
                raise self._corrupt(key, 'invalid clock')
        if updated < created:
            raise self._corrupt(key, 'updated_at precedes created_at')
        record['payload'] = payload
        record['receipt'] = receipt
        return record

    def _validate_all_rows(self) -> None:
        for row in self._db.execute(
            "SELECT key, status, stake, currency, event_id, market_id, selection_id, expected_odds, payload, receipt, error, created_at, updated_at FROM attempts"
        ).fetchall():
            self._validate_row(row)

    def close(self):
        self._db.close()

    # -- claim -------------------------------------------------------------
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
        if not _CURRENCY_RE.match(clean_currency):
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
                row = self._db.execute(
                    "SELECT key, status, stake, currency, event_id, market_id, selection_id, expected_odds, payload, receipt, error, created_at, updated_at FROM attempts WHERE key = ?",
                    (key,),
                ).fetchone()
                if row is not None:
                    self._validate_row(row)
                    self._db.execute("ROLLBACK")
                    return False
                if event_id and market_id and selection_id:
                    # One live intent per native selection: another key for the same
                    # selection that is in flight, accepted or unresolved blocks this
                    # claim (a rejected or withdrawn attempt does not).
                    other = self._db.execute(
                        "SELECT key FROM attempts WHERE event_id = ? AND market_id = ? AND selection_id = ? "
                        "AND currency = ? AND status NOT IN ('WITHDRAWN','REJECTED') LIMIT 1",
                        (event_id, market_id, selection_id, clean_currency),
                    ).fetchone()
                    if other is not None:
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

    # -- phase changes -----------------------------------------------------
    def record_status(self, key: str, status: str, *, receipt: dict[str, Any] | None = None, error: str | None = None,
                      now: float | None = None, not_sent_proof: dict[str, Any] | None = None) -> str:
        if status not in _VALID_STATUSES:
            raise CommonTaskError(f"invalid attempt status: {status}")
        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts <= 0:
            raise CommonTaskError("invalid status clock")
        try:
            raw_receipt = _canonical_json(receipt) if receipt is not None else None
        except (TypeError, ValueError) as exc:
            raise CommonTaskError("receipt must be JSON-serializable without NaN") from exc
        if receipt is not None and not isinstance(receipt, dict):
            raise CommonTaskError("receipt must be an object")
        if error is not None and not isinstance(error, str):
            raise CommonTaskError("error must be text")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute(
                    "SELECT key, status, stake, currency, event_id, market_id, selection_id, expected_odds, payload, receipt, error, created_at, updated_at FROM attempts WHERE key = ?",
                    (key,),
                ).fetchone()
                if row is None:
                    raise CommonTaskError("unknown attempt key")
                current = self._validate_row(row)
                state = current['status']
                if state in _TERMINAL_STATUSES:
                    if state != status:
                        raise CommonTaskError(f"terminal attempt ({state}) cannot transition to {status}")
                    stored_receipt = row[9]
                    if raw_receipt is not None and (stored_receipt is None or _canonical_json(json.loads(stored_receipt)) != raw_receipt):
                        raise CommonTaskError("terminal attempt receipt conflict; append a revision instead")
                    if error is not None and error != row[10]:
                        raise CommonTaskError("terminal attempt error conflict; append a revision instead")
                    self._db.execute("ROLLBACK")
                    return state
                if status == state:
                    self._db.execute("ROLLBACK")
                    return state
                allowed = set(_TRANSITIONS.get(state, ()))
                if state == 'SUBMITTING' and status == 'WITHDRAWN':
                    if not (isinstance(not_sent_proof, dict) and not_sent_proof.get('forwarded_requests') == 0):
                        raise CommonTaskError("a potential submit cannot be withdrawn without proof that nothing was forwarded")
                    allowed.add('WITHDRAWN')
                if status not in allowed:
                    raise CommonTaskError(f"illegal attempt transition {state} -> {status}")
                if status == 'ACCEPTED' and _receipt_identifier(receipt) is None:
                    raise CommonTaskError("accepted attempt requires a receipt with bet_id or receipt_id")
                self._db.execute(
                    "UPDATE attempts SET status = ?, receipt = COALESCE(?, receipt), error = COALESCE(?, error), updated_at = ? WHERE key = ?",
                    (status, raw_receipt, error, max(float(ts), float(current['created_at'])), key),
                )
                self._db.execute("COMMIT")
                return status
            except Exception:
                try:
                    self._db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise

    def add_revision(self, key: str, *, kind: str, data: dict[str, Any], now: float | None = None) -> int:
        """Append an audit revision to an attempt without touching the attempt itself."""
        if not isinstance(kind, str) or not kind.strip():
            raise CommonTaskError("revision kind required")
        if not isinstance(data, dict) or not data:
            raise CommonTaskError("revision data must be a non-empty object")
        try:
            raw = _canonical_json(data)
        except (TypeError, ValueError) as exc:
            raise CommonTaskError("revision data must be JSON-serializable without NaN") from exc
        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts <= 0:
            raise CommonTaskError("invalid revision clock")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                if self._db.execute("SELECT 1 FROM attempts WHERE key = ?", (key,)).fetchone() is None:
                    raise CommonTaskError("unknown attempt key")
                seq = self._db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM attempt_revisions WHERE key = ?", (key,)).fetchone()[0]
                self._db.execute("INSERT INTO attempt_revisions VALUES (?, ?, ?, ?, ?)", (key, seq, kind.strip(), raw, float(ts)))
                self._db.execute("COMMIT")
                return seq
            except Exception:
                try:
                    self._db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise

    def get_attempt(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT key, status, stake, currency, event_id, market_id, selection_id, expected_odds, payload, receipt, error, created_at, updated_at FROM attempts WHERE key = ?",
                (key,),
            ).fetchone()
            if not row:
                return None
            record = self._validate_row(row)
            record['revisions'] = [
                {"seq": seq, "kind": kind, "data": json.loads(data), "created_at": created}
                for seq, kind, data, created in self._db.execute(
                    "SELECT seq, kind, data, created_at FROM attempt_revisions WHERE key = ? ORDER BY seq", (key,))
            ]
            return record


# --------------------------------------------------------------------------
# Strict live-conditions engine: one decision for presentation and permission.
# --------------------------------------------------------------------------

def _evidence_clock(quote:Any):
    if not isinstance(quote,dict):raise CommonTaskError('evidence quote missing')
    return confirmed(quote)


def _task_blockers(task:dict[str,Any],*,now:float,ttl:int):
    """Task level checks plus absolute expiry of every embedded evidence."""
    blockers:list[str]=[];expiries:dict[str,float]={}
    expires=_finite_positive(task.get('expires_at'))
    if task.get('schema_version')!='automation-task.v1' or task.get('kind')!='value' or not _non_empty_text(task.get('idempotency_key')):
        blockers.append('invalid_task')
    if expires is None or now>=expires:blockers.append('task_expired_or_missing_expiry')
    if expires is not None:expiries['task']=expires
    if task.get('reference_source')!='BIA' or task.get('donor_source')!='1win':blockers.append('invalid_task')
    unproven=False;future=False
    def clock_of(quote):
        nonlocal unproven
        try:
            return _evidence_clock(quote)
        except CommonTaskError:
            unproven=True;return None
    donor=clock_of(task.get('quote'));reference=clock_of(task.get('reference_quote'))
    margins=task.get('margin_quotes')
    margin_clocks=[]
    if isinstance(margins,list) and margins:
        for item in margins:
            value=clock_of(item)
            if value is not None:margin_clocks.append(value)
    else:unproven=True
    for name,value in (('donor',donor),('reference',reference)):
        if value is not None:
            expiries[name]=value+ttl
            future=future or value>now
    if margin_clocks:
        expiries['margins']=min(margin_clocks)+ttl;future=future or max(margin_clocks)>now
    if unproven:blockers.append('task_evidence_unproven')
    if future:blockers.append('task_evidence_in_future')
    evidence_expiry=[expiries[k] for k in ('donor','reference','margins') if k in expiries]
    if evidence_expiry:
        earliest=min(evidence_expiry)
        if now>=earliest:blockers.append('task_evidence_expired')
        if expires is not None and expires>earliest+1e-9:blockers.append('task_expiry_exceeds_evidence')
    return blockers,expiries


def _account_blockers(account:Any,*,stake:float|None,now:float,ttl:int):
    blockers:list[str]=[];expiry=None
    if not isinstance(account,dict) or account.get('logged_in') is not True:
        return ['account_not_authenticated'],expiry
    if account.get('currency')!='USDT':blockers.append('unsupported_account_currency')
    if account.get('account_identity_verified') is False or account.get('email_matches_expected') is False:
        blockers.append('account_identity_mismatch')
    elif not ((account.get('account_identity_verified') is True or account.get('email_matches_expected') is True)
              and _non_empty_text(account.get('account_identity_source'))):
        blockers.append('account_identity_unverified')
    available=_finite_number(account.get('available_balance'))
    if available is None or stake is None or available<stake:blockers.append('insufficient_or_unverified_wallet_balance')
    observed=account.get('observed_at')
    if observed is None:
        blockers.append('account_state_clock_unproven')
    else:
        try:
            clock=instant(observed)
        except CommonTaskError:
            blockers.append('account_state_clock_unproven')
        else:
            if clock>now:blockers.append('account_state_in_future')
            elif now-clock>=ttl:blockers.append('account_state_expired')
            expiry=clock+ttl
    return blockers,expiry


def evaluate_live_conditions(task:Any,quote:Any,account_state:Any,*,now:float|None=None,max_stake:float|None=None,
                             diagnostic_only:bool=False)->dict[str,Any]:
    """The only decision function behind readiness and permission.  Never raises."""
    clock=datetime.now(timezone.utc).timestamp() if now is None else now
    if not _valid_clock_argument(clock):
        return {'execution_ready':False,'execution_blockers':['invalid_clock'],'details':{}}
    if not isinstance(task,dict):
        return {'execution_ready':False,'execution_blockers':['invalid_task'],'details':{}}
    ttl=_ttl(task.get('is_live'))
    blockers:list[str]=[];details:dict[str,Any]={'now':clock,'ttl':ttl}
    task_blockers,expiries=_task_blockers(task,now=clock,ttl=ttl)
    blockers.extend(task_blockers)
    stake=_finite_positive(task.get('stake'))
    if stake is None:blockers.append('invalid_stake')
    else:
        if diagnostic_only and abs(stake-1.0)>1e-9:blockers.append('diagnostic_stake_must_be_1_usdt')
        if max_stake is not None:
            limit=_finite_positive(max_stake)
            if limit is None or stake>limit:blockers.append('stake_exceeds_max_stake')
    account_blockers,account_expiry=_account_blockers(account_state,stake=stake,now=clock,ttl=ttl)
    blockers.extend(account_blockers)
    if account_expiry is not None:expiries['account']=account_expiry
    quote_blockers,info=_quote_checks(task,quote,now=clock,ttl=ttl,stake=stake)
    blockers.extend(quote_blockers)
    if isinstance(quote,dict) and quote.get('identity_verified_by')=='onewin-executor' and quote.get('verified') is True:
        if quote.get('live_submit_contract_verified') is not True or not _non_empty_text(quote.get('live_submit_contract_source')):
            blockers.append('unverified_live_submit_wire_contract')
        if quote.get('currency')!='USDT' or (isinstance(account_state,dict) and quote.get('currency')!=account_state.get('currency')):
            blockers.append('executor_currency_mismatch')
    if 'executor_clock' in info:expiries['executor_quote']=info['executor_clock']+ttl
    details.update(info);details['expiries']=expiries
    deduplicated=list(dict.fromkeys(blockers))
    return {'execution_ready':not deduplicated,'execution_blockers':deduplicated,'details':details}


def assess_live_readiness(task:Any,quote:Any=None,account_state:Any=None,*,now:float|None=None,max_stake:float|None=None,
                          diagnostic_only:bool=False)->dict[str,Any]:
    """Presentation view of :func:`evaluate_live_conditions` (same decision)."""
    verdict=evaluate_live_conditions(task,quote,account_state,now=now,max_stake=max_stake,diagnostic_only=diagnostic_only)
    return {'execution_ready':verdict['execution_ready'],'execution_blockers':verdict['execution_blockers']}


_REQUIRED_EXPIRIES=('task','donor','reference','margins','executor_quote','account')


def verify_live_execution_conditions(task:dict[str,Any],quote:dict[str,Any],account_state:dict[str,Any],*,now:float,
                                     max_stake:float|None=None,diagnostic_only:bool=False)->dict[str,Any]:
    """Permission view of :func:`evaluate_live_conditions`.

    Raises ``CommonTaskError`` carrying the same blockers that
    :func:`assess_live_readiness` reports for the same inputs.
    """
    if not _valid_clock_argument(now):raise CommonTaskError('invalid clock',['invalid_clock'])
    verdict=evaluate_live_conditions(task,quote,account_state,now=now,max_stake=max_stake,diagnostic_only=diagnostic_only)
    if not verdict['execution_ready']:
        raise CommonTaskError('live execution conditions not met: '+','.join(verdict['execution_blockers']),
                              verdict['execution_blockers'])
    details=verdict['details'];expiries=details['expiries']
    if any(name not in expiries for name in _REQUIRED_EXPIRIES):
        raise CommonTaskError('evidence expiry missing',['task_evidence_unproven'])
    actual=details['actual_axes'];expected=details['expected_axes']
    execution=task['quote'].get('execution') if isinstance(task['quote'].get('execution'),dict) else {}
    executor_fields=('identity_verified_by','provider_id_namespace','provider_event_key','native_event_id','native_market_id',
                     'native_selection_id','source_market','odds','currency','evidence')
    return {
        'schema_version':'automation-live-order.v1','live':True,'execution_ready':True,'execution_blockers':[],
        'idempotency_key':task['idempotency_key'],'event_id':quote['native_event_id'],'market_id':quote['native_market_id'],
        'selection_id':quote['native_selection_id'],'odds':quote['odds'],'stake':float(task['stake']),'currency':'USDT',
        'axes':copy.deepcopy(quote.get('market_axes') or quote.get('axes')),
        'expected_axes':copy.deepcopy(_task_expected_axes(task)),
        'axes_adapter_version':AXES_ADAPTER_VERSION,'axes_schema':actual['schema'],
        'settlement_facts':public_facts(actual),'expected_settlement_facts':public_facts(expected),
        'commission':float(quote['commission']),'max_stake':float(quote['max_stake']),
        'expires_at':min(expiries[name] for name in _REQUIRED_EXPIRIES),
        'valuation_basis':copy.deepcopy(task.get('valuation_basis')),
        'reference':{'source':'BIA','role':'reference','executable':False},
        'evidence':{
            'expiries':{name:expiries[name] for name in _REQUIRED_EXPIRIES},
            'donor_parser_claim':copy.deepcopy(execution),
            'executor_quote':{key:copy.deepcopy(quote.get(key)) for key in executor_fields if key in quote}
                             |{'clock':details['executor_clock']},
            'account':{key:copy.deepcopy(account_state.get(key)) for key in
                       ('logged_in','account_identity_verified','email_matches_expected','account_identity_source',
                        'currency','available_balance','observed_at') if key in account_state},
            'live_submit_contract_source':quote['live_submit_contract_source'],
        },
    }
