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
    if any(not quote.get(k) for k in ('native_event_id','native_market_id','native_selection_id','currency')):
        raise CommonTaskError('execution identity and currency required')
    if str(quote['native_event_id'])!=str(expected['source_event_key']) or quote.get('source_market')!=expected['source_market'] or quote.get('odds')!=expected['odds']:
        raise CommonTaskError('executor quote differs from signal')
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
