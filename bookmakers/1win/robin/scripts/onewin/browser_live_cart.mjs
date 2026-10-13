// Explicit live cart executor with durable disk attempt store, strict condition checks, and receipt verification.
// OneWinDryRunCart in browser_cart.mjs remains strictly read-only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAmount, eventIdFromUrl } from './browser_cart.mjs';

const TERMINAL_STATUSES = new Set(['ACCEPTED', 'REJECTED', 'INDETERMINATE', 'WITHDRAWN']);
const VALID_STATUSES = new Set(['CLAIMED', 'PRE_CHECK_PASSED', 'SUBMITTING', ...TERMINAL_STATUSES]);
// Legal phase changes. Terminal states have no outgoing edge. A potential submit
// (SUBMITTING) resolves only into a bookmaker outcome or INDETERMINATE; it can be
// WITHDRAWN only with proof that nothing was forwarded (see record()).
const TRANSITIONS = new Map([
  ['CLAIMED', new Set(['PRE_CHECK_PASSED', 'SUBMITTING', 'WITHDRAWN'])],
  ['PRE_CHECK_PASSED', new Set(['SUBMITTING', 'WITHDRAWN'])],
  ['SUBMITTING', new Set(['ACCEPTED', 'REJECTED', 'INDETERMINATE'])],
]);
const GUESSED_UNITS = new Set(['', 'unknown', 'unverified', 'match_base_unit', 'unverified_from_dom_only', 'guessed']);
const REQUIRED_AXIS_KEYS = ['period', 'scope', 'unit', 'market', 'side'];
const REQUIRED_EXPIRIES = ['task', 'donor', 'reference', 'margins', 'executor_quote', 'account'];
// Directory fsync results that mean "this filesystem cannot do it" rather than
// "the write failed". They are accepted only through an explicit opt-in and the
// resulting durability level is recorded; EIO and everything else is fatal.
const UNSUPPORTED_DIR_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const BET_API_HOSTS = new Set(['api-gateway.top-parser.com']);
const KNOWN_REJECTIONS = new Set([
  'not_enough_funds', 'zero_bet', 'odd_closed', 'odd_not_found',
  'currency_not_supported', 'odd_cf_changed', 'min_bet_amount',
  'min_bet_amount_v2', 'max_bet_amount', 'max_bet_amount_v2',
  'events_bet_limit_reached', 'express_not_enough_outcomes',
  'freebet_not_found', 'express_not_allowed', 'freebet_cf_limit',
  'freebet_not_valid_currency', 'validation_error', 'bad_request_error',
]);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function deepEqual(a, b) {
  return stable(a) === stable(b);
}

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function receiptIdentifier(receipt) {
  if (!isPlainObject(receipt)) return null;
  for (const name of ['bet_id', 'receipt_id']) {
    const value = receipt[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value);
  }
  return null;
}

function isReconciledNotPlaced(entry) {
  return Array.isArray(entry.revisions) && entry.revisions.some((rev) => rev.kind === 'reconciled_not_placed'
    && isPlainObject(rev.data) && typeof rev.data.operator === 'string' && rev.data.operator.trim()
    && typeof rev.data.evidence === 'string' && rev.data.evidence.trim());
}

// Lock files are mutual-exclusion state between live processes (stale ones are
// reaped by PID liveness). Their directory durability is irrelevant, so this
// helper is best effort and is never used for attempt data.
function fsyncDirBestEffort(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {}
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// Attempt data: every error is reported to the caller.
function fsyncDirStrict(dirPath) {
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function corrupt(reason) {
  return new Error(`CORRUPT_DURABLE_ATTEMPT_STORE:${reason}`);
}

function validateEntry(key, entry) {
  const bad = (field) => corrupt(`INVALID_ENTRY:${field}`);
  if (typeof key !== 'string' || !key.trim() || key !== key.trim() || key.length > 128) throw bad('map_key');
  if (!isPlainObject(entry)) throw bad('entry');
  if (entry.key !== key) throw bad('key');
  if (!VALID_STATUSES.has(entry.status)) throw bad('status');
  if (!isFinitePositive(entry.stake)) throw bad('stake');
  if (typeof entry.currency !== 'string' || !/^[A-Z]{3,6}$/.test(entry.currency)) throw bad('currency');
  for (const field of ['event_id', 'market_id', 'selection_id']) {
    if (entry[field] !== null && typeof entry[field] !== 'string') throw bad(field);
  }
  if (entry.expected_odds !== null && !isFinitePositive(entry.expected_odds)) throw bad('expected_odds');
  if (!isPlainObject(entry.payload) || Object.keys(entry.payload).length === 0) throw bad('payload');
  if (entry.payload.idempotency_key !== undefined && String(entry.payload.idempotency_key).trim() !== key) throw bad('payload_key');
  if (entry.payload.stake !== undefined && (typeof entry.payload.stake !== 'number' || Math.abs(entry.payload.stake - entry.stake) > 1e-9)) {
    throw bad('payload_stake');
  }
  if (entry.payload.currency !== undefined && String(entry.payload.currency).trim().toUpperCase() !== entry.currency) {
    throw bad('payload_currency');
  }
  if (entry.receipt !== null && !isPlainObject(entry.receipt)) throw bad('receipt');
  if (entry.status === 'ACCEPTED' && receiptIdentifier(entry.receipt) === null) throw bad('accepted_receipt');
  if (entry.error !== null && typeof entry.error !== 'string') throw bad('error');
  if (!Array.isArray(entry.condition_mismatches) || !entry.condition_mismatches.every((m) => typeof m === 'string')) {
    throw bad('condition_mismatches');
  }
  if (!isFinitePositive(entry.created_at) || !isFinitePositive(entry.updated_at) || entry.updated_at < entry.created_at) {
    throw bad('clocks');
  }
  if (entry.withdrawal_requested !== undefined && entry.withdrawal_requested !== null) {
    const w = entry.withdrawal_requested;
    if (!isPlainObject(w) || !isFinitePositive(w.at) || typeof w.reason !== 'string') throw bad('withdrawal_requested');
  }
  if (entry.revisions !== undefined) {
    if (!Array.isArray(entry.revisions)) throw bad('revisions');
    for (const rev of entry.revisions) {
      if (!isPlainObject(rev) || !Number.isInteger(rev.seq) || rev.seq < 1 || typeof rev.kind !== 'string' || !rev.kind
        || !isPlainObject(rev.data) || !isFinitePositive(rev.created_at)) throw bad('revisions');
    }
  }
}

export class InMemoryAttemptStore {
  constructor() {
    this.isDurable = false;
    this.attempts = new Map();
  }
  async claim(key, meta = {}) {
    const clean = String(key || '').trim();
    if (!clean || this.attempts.has(clean)) return false;
    this.attempts.set(clean, { status: 'CLAIMED', ...meta, claimed_at: Date.now() });
    return true;
  }
  async record(key, status, detail = {}) {
    const entry = this.attempts.get(key);
    if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
    if (TERMINAL_STATUSES.has(entry.status) && entry.status !== status) {
      throw new Error('TERMINAL_ATTEMPT_IMMUTABLE');
    }
    Object.assign(entry, { status, ...detail, updated_at: Date.now() });
    return entry;
  }
  getAttempt(key) {
    return this.attempts.get(key) || null;
  }
}

export class DurableAttemptStore {
  constructor(filePath, { maxStake = null, allowUnsupportedDirectorySync = false } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('DURABLE_STORE_PATH_REQUIRED');
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.reapPath = `${this.filePath}.reap`;
    this.journalPath = `${this.filePath}.receipts.jsonl`;
    this.maxStake = maxStake !== null && maxStake !== undefined ? Number(maxStake) : null;
    if (this.maxStake !== null && (!Number.isFinite(this.maxStake) || this.maxStake <= 0)) {
      throw new Error('INVALID_MAX_STAKE');
    }
    this.allowUnsupportedDirectorySync = Boolean(allowUnsupportedDirectorySync);
    this.durabilityLevel = 'directory_fsync';
    this.syncFailure = null;
    this._legacyRaw = null;
    this._tombstones = new Map();
    this._submitTokens = new Map(); // capability of the live process only; never persisted
    this._initialized = false;
    this.isDurable = false;
    try {
      this._initOnDisk();
    } catch (err) {
      // An unsupported directory sync leaves a valid file behind; the store is
      // simply not durable. Every other failure aborts construction.
      if (!(this.syncFailure && this.syncFailure.unsupported)) throw err;
    }
    this._initialized = true;
    this.isDurable = this.syncFailure === null;
    this._cleanTemporaryLocks();
  }

  _assertUsable() {
    if (this.syncFailure) {
      const f = this.syncFailure;
      throw new Error(`DURABLE_STORE_UNAVAILABLE:${f.stage}:${f.code}`);
    }
  }

  _markSyncFailure(stage, err, unsupported = false) {
    this.isDurable = false;
    this.syncFailure = { stage, code: err && err.code ? String(err.code) : 'ERR', message: String(err && err.message || err).slice(0, 200), unsupported, at: Date.now() };
    return new Error(`DURABLE_STORE_SYNC_FAILED:${stage}:${this.syncFailure.code}`);
  }

  _acquireLock(timeoutMs = 5000) {
    const token = crypto.randomUUID();
    const deadline = Date.now() + timeoutMs;
    const tempLockPath = `${this.lockPath}.${process.pid}.${token}`;
    const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), token, created_at: Date.now() }) + '\n';

    // Write temp lock file first so the lock file is born already populated
    const fdTmp = fs.openSync(tempLockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      // The lock only excludes live processes (stale ones are reaped by PID
      // liveness), so its content needs no fsync; attempt data is synced strictly
      // in _writeDataUnlocked.
      fs.writeFileSync(fdTmp, payload, 'utf8');
    } finally {
      fs.closeSync(fdTmp);
    }

    try {
      while (true) {
        try {
          fs.linkSync(tempLockPath, this.lockPath);
          fsyncDirBestEffort(path.dirname(this.lockPath));
          const stat = fs.statSync(this.lockPath);
          return { token, ino: stat.ino };
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;

          // Inspect existing lock owner
          let isAlive = false;
          let ownerPid = null;
          let lockData = null;
          let stat = null;
          try {
            stat = fs.statSync(this.lockPath);
            const content = fs.readFileSync(this.lockPath, 'utf8');
            lockData = JSON.parse(content);
            ownerPid = Number(lockData.pid);
            if (typeof lockData.host === 'string' && lockData.host && lockData.host !== os.hostname()) {
              // Another machine (shared filesystem): its PID means nothing here. Never steal.
              isAlive = true;
            } else if (Number.isInteger(ownerPid) && ownerPid > 0) {
              if (ownerPid === process.pid) {
                // Store operations are synchronous inside one process, so a lock carrying our
                // own PID can only be left over from a failed release: it is stale.
                isAlive = false;
              } else {
                try {
                  process.kill(ownerPid, 0);
                  isAlive = true;
                } catch (killErr) {
                  isAlive = killErr.code === 'EPERM';
                }
              }
            }
          } catch {}

          if (isAlive) {
            // Live writer is still running. NEVER steal or delete a live owner's lock regardless of age!
            if (Date.now() >= deadline) {
              throw new Error('DURABLE_STORE_LOCK_TIMEOUT');
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            continue;
          }

          // Owner process is dead (ESRCH): safely reap lock using serialized reap guard
          this._clearOrphanedReapGuard();
          let reapFd = null;
          try {
            reapFd = fs.openSync(this.reapPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
            fs.writeFileSync(reapFd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
            try {
              const currentStat = fs.statSync(this.lockPath);
              if (stat && currentStat.ino === stat.ino) {
                fs.unlinkSync(this.lockPath);
                fsyncDirBestEffort(path.dirname(this.lockPath));
              }
            } catch {}
          } catch {
            // Another process is already reaping or competing; wait and retry
          } finally {
            if (reapFd !== null) {
              try { fs.closeSync(reapFd); } catch {}
              try { fs.unlinkSync(this.reapPath); } catch {}
            }
          }

          if (Date.now() >= deadline) {
            throw new Error('DURABLE_STORE_LOCK_TIMEOUT');
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    } finally {
      try { fs.unlinkSync(tempLockPath); } catch {}
    }
  }

  // A reap guard whose writer died (or that is simply old) must not block reaping forever.
  _clearOrphanedReapGuard() {
    try {
      const stat = fs.statSync(this.reapPath);
      let writerAlive = false;
      try {
        const data = JSON.parse(fs.readFileSync(this.reapPath, 'utf8'));
        if (typeof data.host === 'string' && data.host && data.host !== os.hostname()) writerAlive = true;
        else if (Number.isInteger(data.pid) && data.pid > 0 && data.pid !== process.pid) {
          try { process.kill(data.pid, 0); writerAlive = true; } catch (e) { writerAlive = e.code === 'EPERM'; }
        }
      } catch {}
      if (!writerAlive || Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(this.reapPath);
    } catch {}
  }

  // Temporary lock files left by a killed process (name carries its PID).
  _cleanTemporaryLocks() {
    try {
      const dir = path.dirname(this.lockPath);
      const prefix = `${path.basename(this.lockPath)}.`;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const match = name.slice(prefix.length).match(/^(\d+)\.[0-9a-f-]{8,}$/);
        if (!match) continue;
        const full = path.join(dir, name);
        try {
          if (Date.now() - fs.statSync(full).mtimeMs < 60000) continue;
          const pid = Number(match[1]);
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
          if (!alive) fs.unlinkSync(full);
        } catch {}
      }
    } catch {}
  }

  _releaseLock(lockHandle) {
    if (!lockHandle || !lockHandle.token) return;
    try {
      const stat = fs.statSync(this.lockPath);
      if (stat.ino !== lockHandle.ino) {
        throw new Error('LOCK_OWNERSHIP_LOST');
      }
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.token !== lockHandle.token || parsed.pid !== process.pid) {
        throw new Error('LOCK_OWNERSHIP_LOST');
      }
      fs.unlinkSync(this.lockPath);
      fsyncDirBestEffort(path.dirname(this.lockPath));
    } catch (err) {
      if (err.message === 'LOCK_OWNERSHIP_LOST') throw err;
      // If file was already gone
    }
  }

  _withLock(fn) {
    let handle;
    try {
      handle = this._acquireLock();
    } catch (err) {
      // A system I/O error while taking the lock means the filesystem cannot be
      // trusted for attempt data either. Contention (LOCK_TIMEOUT) is not one.
      if (err && typeof err.code === 'string' && /^E[A-Z0-9]+$/.test(err.code) && err.code !== 'EEXIST') {
        throw this._markSyncFailure('lock', err);
      }
      throw err;
    }
    try {
      return fn();
    } finally {
      this._releaseLock(handle);
    }
  }

  _readDataUnlocked() {
    this._legacyRaw = null;
    if (!fs.existsSync(this.filePath)) {
      // After a successful initialisation the file is the only history there is: its
      // absence is corruption (deleted, rolled back or replaced), never "no attempts".
      if (this._initialized) throw corrupt('MISSING_AFTER_INIT');
      return new Map();
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:EMPTY_EXISTING_FILE');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_JSON');
    }
    if (!isPlainObject(parsed) || parsed.version !== 1) {
      throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_SCHEMA');
    }

    const attemptsMap = new Map();
    this._tombstones = new Map();
    if (parsed.tombstones !== undefined) {
      if (!Array.isArray(parsed.tombstones)) throw corrupt('INVALID_TOMBSTONES');
      for (const item of parsed.tombstones) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !item[0].trim()
          || !isPlainObject(item[1]) || !isFinitePositive(item[1].at) || typeof item[1].reason !== 'string') {
          throw corrupt('INVALID_TOMBSTONE');
        }
        this._tombstones.set(item[0], item[1]);
      }
    }
    if (Array.isArray(parsed.entries)) {
      for (const item of parsed.entries) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !item[0].trim() || !isPlainObject(item[1])) {
          throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_ENTRY');
        }
        if (attemptsMap.has(item[0])) throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:DUPLICATE_KEY');
        validateEntry(item[0], item[1]);
        attemptsMap.set(item[0], item[1]);
      }
    } else if (isPlainObject(parsed.attempts)) {
      // Legacy v1 layout. Entries are validated with the same rules; nothing is
      // invented for missing financial facts. The original bytes are backed up
      // before the first rewrite (see _writeDataUnlocked).
      for (const [k, v] of Object.entries(parsed.attempts)) {
        if (!k.trim() || !isPlainObject(v)) throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_LEGACY_ENTRY');
        validateEntry(k, v);
        attemptsMap.set(k, v);
      }
      this._legacyRaw = raw;
    } else {
      throw new Error('CORRUPT_DURABLE_ATTEMPT_STORE:INVALID_SCHEMA');
    }
    return attemptsMap;
  }

  _backupLegacyUnlocked() {
    if (this._legacyRaw === null) return;
    const digest = crypto.createHash('sha256').update(this._legacyRaw).digest('hex').slice(0, 12);
    const backup = `${this.filePath}.legacy-v1.${digest}.bak`;
    if (!fs.existsSync(backup)) {
      const fd = fs.openSync(backup, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, this._legacyRaw, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fsyncDirStrict(path.dirname(backup));
    }
    this._legacyRaw = null;
  }

  _writeDataUnlocked(attemptsMap) {
    this._assertUsable();
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`;
    let stage = 'serialize';
    let tmpCreated = false;
    try {
      const entries = Array.from(attemptsMap.entries());
      const document = { version: 1, entries };
      if (this._tombstones.size > 0) document.tombstones = Array.from(this._tombstones.entries());
      const raw = JSON.stringify(document, null, 2) + '\n';
      stage = 'backup_legacy';
      this._backupLegacyUnlocked();
      stage = 'open_tmp';
      const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
      tmpCreated = true;
      try {
        stage = 'write_tmp';
        fs.writeFileSync(fd, raw, 'utf8');
        stage = 'fsync_file';
        fs.fsyncSync(fd);
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
      stage = 'chmod_tmp';
      fs.chmodSync(tmpPath, 0o600);
      stage = 'rename';
      fs.renameSync(tmpPath, this.filePath);
      tmpCreated = false;
      stage = 'chmod';
      fs.chmodSync(this.filePath, 0o600);
      stage = 'fsync_dir';
      try {
        fsyncDirStrict(dir);
      } catch (dirErr) {
        if (UNSUPPORTED_DIR_SYNC_CODES.has(dirErr && dirErr.code) && this.allowUnsupportedDirectorySync) {
          this.durabilityLevel = 'file_fsync_only';
        } else {
          dirErr.unsupported = UNSUPPORTED_DIR_SYNC_CODES.has(dirErr && dirErr.code);
          throw dirErr;
        }
      }
    } catch (err) {
      if (tmpCreated) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      if (err && typeof err.message === 'string' && err.message.startsWith('CORRUPT_DURABLE_ATTEMPT_STORE')) throw err;
      throw this._markSyncFailure(stage, err, Boolean(err && err.unsupported));
    }
  }

  _initOnDisk() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this._withLock(() => {
      if (!fs.existsSync(this.filePath)) {
        this._writeDataUnlocked(new Map());
      } else {
        // Must validate existing store without overwriting or deleting
        this._readDataUnlocked();
      }
    });
  }

  async claim(key, { stake, currency = 'USDT', payload = null, maxStake = null } = {}) {
    this._assertUsable();
    if (typeof key !== 'string' || !key.trim() || key.trim().length > 128) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }
    const cleanKey = key.trim();
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
      throw new Error('INVALID_STAKE');
    }
    const limit = maxStake !== null && maxStake !== undefined ? Number(maxStake) : this.maxStake;
    if (limit !== null && stake > limit) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3,6}$/.test(currency.trim().toUpperCase())) {
      throw new Error('UNSUPPORTED_CURRENCY');
    }
    const cleanCurrency = currency.trim().toUpperCase();
    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      throw new Error('VALID_PAYLOAD_REQUIRED');
    }
    if (payload.idempotency_key !== undefined && String(payload.idempotency_key).trim() !== cleanKey) {
      throw new Error('PAYLOAD_KEY_MISMATCH');
    }
    if (payload.stake !== undefined && (typeof payload.stake !== 'number' || Math.abs(payload.stake - stake) > 1e-9)) {
      throw new Error('PAYLOAD_STAKE_MISMATCH');
    }
    if (payload.currency !== undefined && String(payload.currency).trim().toUpperCase() !== cleanCurrency) {
      throw new Error('PAYLOAD_CURRENCY_MISMATCH');
    }

    const sel = isPlainObject(payload.selection) ? payload.selection : {};
    const eventId = String(payload.event_id || sel.event_id || '').trim() || null;
    const marketId = String(payload.market_id || sel.market_id || '').trim() || null;
    const selectionId = String(payload.selection_id || sel.selection_id || '').trim() || null;
    const rawOdds = payload.expected_odds ?? payload.odds ?? sel.price;
    const expectedOdds = typeof rawOdds === 'number' && Number.isFinite(rawOdds) && rawOdds > 0 ? rawOdds : null;

    return this._withLock(() => {
      this._assertUsable();
      const attemptsMap = this._readDataUnlocked();
      if (this._tombstones.has(cleanKey)) {
        throw new Error('WITHDRAWN_BEFORE_CLAIM');
      }
      if (attemptsMap.has(cleanKey)) {
        return false;
      }
      if (eventId && marketId && selectionId) {
        // One live intent per native selection: another key for the same selection
        // that is in flight, accepted or unresolved blocks this claim. Only a rejected or
        // withdrawn attempt, or one an operator reconciled as "not placed" with evidence,
        // releases it. (The currency label is deliberately not part of the identity.)
        for (const other of attemptsMap.values()) {
          if (other.event_id === eventId && other.market_id === marketId && other.selection_id === selectionId
            && other.status !== 'WITHDRAWN' && other.status !== 'REJECTED' && !isReconciledNotPlaced(other)) {
            return false;
          }
        }
      }
      const now = Date.now();
      attemptsMap.set(cleanKey, {
        key: cleanKey,
        status: 'CLAIMED',
        stake,
        currency: cleanCurrency,
        event_id: eventId,
        market_id: marketId,
        selection_id: selectionId,
        expected_odds: expectedOdds,
        payload: JSON.parse(JSON.stringify(payload)),
        receipt: null,
        error: null,
        condition_mismatches: [],
        withdrawal_requested: null,
        revisions: [],
        created_at: now,
        updated_at: now,
      });
      this._writeDataUnlocked(attemptsMap);
      return true;
    });
  }

  async record(key, status, { receipt = null, error = null, condition_mismatches = null, not_sent_proof = null } = {}) {
    this._assertUsable();
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('UNKNOWN_ATTEMPT_KEY');
    }
    const cleanKey = key.trim();
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`INVALID_ATTEMPT_STATUS:${status}`);
    }
    if (receipt !== null && receipt !== undefined && !isPlainObject(receipt)) {
      throw new Error('RECEIPT_MUST_BE_OBJECT');
    }
    return this._withLock(() => {
      this._assertUsable();
      const attemptsMap = this._readDataUnlocked();
      const entry = attemptsMap.get(cleanKey);
      if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
      const hasReceipt = receipt !== null && receipt !== undefined;
      const hasError = error !== null && error !== undefined;
      const hasMismatches = Array.isArray(condition_mismatches);

      if (TERMINAL_STATUSES.has(entry.status)) {
        if (entry.status !== status) throw new Error('TERMINAL_ATTEMPT_IMMUTABLE');
        // Same terminal status: only an identical repeat is accepted and it
        // does not touch the sealed entry. A different value never replaces it.
        if ((hasReceipt && !deepEqual(entry.receipt, receipt))
          || (hasError && entry.error !== String(error))
          || (hasMismatches && !deepEqual(entry.condition_mismatches, condition_mismatches))) {
          throw new Error('TERMINAL_ATTEMPT_CONFLICT');
        }
        return JSON.parse(JSON.stringify(entry));
      }
      if (entry.status === status) {
        return JSON.parse(JSON.stringify(entry));
      }
      let allowed = TRANSITIONS.get(entry.status) || new Set();
      if (entry.status === 'SUBMITTING' && status === 'WITHDRAWN') {
        // Only the process that holds the in-flight submission can say "nothing was forwarded".
        const held = this._submitTokens.get(cleanKey);
        if (!isPlainObject(not_sent_proof) || not_sent_proof.forwarded_requests !== 0
          || typeof held !== 'string' || not_sent_proof.submit_token !== held) {
          throw new Error('NOT_SENT_PROOF_REQUIRED');
        }
        allowed = new Set([...allowed, 'WITHDRAWN']);
      }
      if (!allowed.has(status)) {
        throw new Error(`ILLEGAL_TRANSITION:${entry.status}->${status}`);
      }
      if (status === 'ACCEPTED' && receiptIdentifier(receipt) === null) {
        throw new Error('RECEIPT_REQUIRED');
      }
      entry.status = status;
      if (hasReceipt) entry.receipt = JSON.parse(JSON.stringify(receipt));
      if (hasError) entry.error = String(error);
      if (hasMismatches) entry.condition_mismatches = [...condition_mismatches];
      if (status === 'WITHDRAWN' && isPlainObject(not_sent_proof)) {
        entry.not_sent_proof = JSON.parse(JSON.stringify(not_sent_proof));
      }
      entry.updated_at = Math.max(Date.now(), entry.created_at);
      validateEntry(cleanKey, entry);
      this._writeDataUnlocked(attemptsMap);
      if (status === 'SUBMITTING') this._submitTokens.set(cleanKey, crypto.randomUUID());
      else if (TERMINAL_STATUSES.has(status)) this._submitTokens.delete(cleanKey);
      return JSON.parse(JSON.stringify(entry));
    });
  }

  submitToken(key) {
    return this._submitTokens.get(typeof key === 'string' ? key.trim() : '') ?? null;
  }

  // A withdrawal request is a flag, not a phase change: the owner of a running
  // attempt reads it at the POST boundary. A terminal attempt cannot be
  // withdrawn any more.
  async requestWithdrawal(key, reason = 'withdrawn') {
    this._assertUsable();
    if (typeof key !== 'string' || !key.trim()) throw new Error('UNKNOWN_ATTEMPT_KEY');
    const cleanKey = key.trim();
    return this._withLock(() => {
      this._assertUsable();
      const attemptsMap = this._readDataUnlocked();
      const entry = attemptsMap.get(cleanKey);
      if (!entry) {
        // Withdrawn before it was ever claimed: remember it so that the claim is refused.
        if (!this._tombstones.has(cleanKey)) {
          this._tombstones.set(cleanKey, { at: Date.now(), reason: String(reason).slice(0, 200) });
          this._writeDataUnlocked(attemptsMap);
        }
        return true;
      }
      if (TERMINAL_STATUSES.has(entry.status)) return false;
      if (!entry.withdrawal_requested) {
        entry.withdrawal_requested = { at: Date.now(), reason: String(reason).slice(0, 200) };
        entry.updated_at = Math.max(Date.now(), entry.created_at);
        this._writeDataUnlocked(attemptsMap);
      }
      return true;
    });
  }

  // Explicit audit mechanism: corrections never rewrite the sealed attempt.
  async addRevision(key, { kind, data }) {
    this._assertUsable();
    if (typeof kind !== 'string' || !kind.trim() || !isPlainObject(data) || Object.keys(data).length === 0) {
      throw new Error('REVISION_KIND_AND_DATA_REQUIRED');
    }
    const cleanKey = String(key || '').trim();
    return this._withLock(() => {
      this._assertUsable();
      const attemptsMap = this._readDataUnlocked();
      const entry = attemptsMap.get(cleanKey);
      if (!entry) throw new Error('UNKNOWN_ATTEMPT_KEY');
      if (kind.trim() === 'reconciled_not_placed') {
        // Releases the selection, so it needs a named operator, a concrete evidence
        // reference and an attempt that was not accepted.
        if (typeof data.operator !== 'string' || !data.operator.trim()
          || typeof data.evidence !== 'string' || !data.evidence.trim()) {
          throw new Error('REVISION_EVIDENCE_REQUIRED');
        }
        if (entry.status === 'ACCEPTED') throw new Error('REVISION_REFUSED_FOR_ACCEPTED');
      }
      const revisions = Array.isArray(entry.revisions) ? entry.revisions : [];
      const seq = revisions.length + 1;
      entry.revisions = [...revisions, { seq, kind: kind.trim(), data: JSON.parse(JSON.stringify(data)), created_at: Date.now() }];
      validateEntry(cleanKey, entry);
      this._writeDataUnlocked(attemptsMap);
      return seq;
    });
  }

  // Last-resort fact preservation when the store cannot be written after the
  // bookmaker already answered. Best effort by design; the caller reports it.
  appendEmergencyJournal(record) {
    let fd = null;
    try {
      fd = fs.openSync(this.journalPath, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ...record, journaled_at: Date.now() }) + '\n', 'utf8');
      fs.fsyncSync(fd);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  getAttempt(key) {
    if (typeof key !== 'string' || !key.trim()) return null;
    const cleanKey = key.trim();
    return this._withLock(() => {
      const attemptsMap = this._readDataUnlocked();
      const entry = attemptsMap.get(cleanKey);
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    });
  }

  close() {}
}

export class OneWinLiveCart {
  constructor(page, { attemptStore, liveEnabled = false, maxBudgetUsdt = 1.0, diagnosticMode = true } = {}) {
    this.page = page;
    this.attemptStore = attemptStore || null;
    this.liveEnabled = Boolean(liveEnabled);
    this.maxBudgetUsdt = Number(maxBudgetUsdt);
    this.diagnosticMode = Boolean(diagnosticMode);
    if (!Number.isFinite(this.maxBudgetUsdt) || this.maxBudgetUsdt <= 0) {
      throw new Error('INVALID_MAX_BUDGET');
    }
    if (this.liveEnabled) {
      if (
        !this.attemptStore ||
        !(this.attemptStore instanceof DurableAttemptStore) ||
        this.attemptStore.isDurable !== true ||
        typeof this.attemptStore.claim !== 'function' ||
        typeof this.attemptStore.record !== 'function'
      ) {
        throw new Error('DURABLE_ATTEMPT_STORE_REQUIRED');
      }
    }
    this.busy = false;
    this.guarded = false;
    this.submitArmed = false;
    this.armedExpectation = null;
    this.submitSentCount = 0;
    this.blocked = [];
    this.blocked_reasons = [];
    this._runtime = null;
    this._signalGuardAbort = null;
    this._guardHandler = null;
    this._guardedPage = null;
    this.unexpectedMutations = 0;
  }

  // Asynchronous part of the boundary decision. It runs BEFORE the synchronous
  // freshness check so that nothing awaited can age the evidence afterwards.
  async _cancelledAtBoundary() {
    const runtime = this._runtime;
    if (!runtime || typeof runtime.cancelled !== 'function') return true;
    try {
      return Boolean(await runtime.cancelled());
    } catch {
      return true; // fail closed
    }
  }

  // Synchronous: no await between the clock read and the caller forwarding the
  // request. Re-reads the clock, the minimum expiry of ALL evidence and the
  // durable attempt state (withdrawal / terminal / store health).
  _postBoundaryCheck(expected) {
    const runtime = this._runtime;
    if (!runtime || typeof runtime.now !== 'function') return { ok: false, reason: 'runtime_context_missing' };
    const store = this.attemptStore;
    if (!store || store.isDurable !== true) return { ok: false, reason: 'store_not_durable_at_post_boundary' };
    let attempt;
    try {
      attempt = store.getAttempt(expected.idempotencyKey);
    } catch {
      return { ok: false, reason: 'attempt_state_unreadable_at_post_boundary' };
    }
    if (!attempt || attempt.status !== 'SUBMITTING') {
      return { ok: false, reason: 'attempt_state_not_submitting_at_post_boundary' };
    }
    if (attempt.withdrawal_requested) return { ok: false, reason: 'withdrawal_requested_at_post_boundary' };
    const current = runtime.now();
    if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
      return { ok: false, reason: 'invalid_clock_at_post_boundary' };
    }
    if (!(current < expected.expiresAt)) return { ok: false, reason: 'expired_at_post_boundary' };
    return { ok: true };
  }

  _validateMakeBetRequestBody(body, expected) {
    if (!isPlainObject(body)) {
      return { ok: false, reason: 'body_not_an_object' };
    }
    if (body.currencyCode !== expected.currency) {
      return { ok: false, reason: `currency_code_mismatch:${body.currencyCode}!=${expected.currency}` };
    }
    if (typeof body.amount !== 'number' || Math.abs(body.amount - expected.stake) > 1e-9) {
      return { ok: false, reason: `amount_mismatch:${body.amount}!=${expected.stake}` };
    }
    if (body.freebetId !== undefined && body.freebetId !== null) {
      return { ok: false, reason: 'freebet_substitution_forbidden' };
    }
    if (body.bonusPercent || (Array.isArray(body.bonuses) && body.bonuses.length > 0)) {
      return { ok: false, reason: 'bonus_substitution_forbidden' };
    }
    if (body.wallet) {
      if (body.wallet.type !== 'real' || body.wallet.bonusId) {
        return { ok: false, reason: 'non_real_wallet_forbidden' };
      }
    }
    if (!isPlainObject(body.coupon)) {
      return { ok: false, reason: 'coupon_not_an_object' };
    }
    if (typeof body.coupon.amount !== 'number' || Math.abs(body.coupon.amount - expected.stake) > 1e-9) {
      return { ok: false, reason: `coupon_amount_mismatch:${body.coupon.amount}!=${expected.stake}` };
    }
    if (body.coupon.freebetId !== undefined && body.coupon.freebetId !== null) {
      return { ok: false, reason: 'coupon_freebet_forbidden' };
    }
    if (!Array.isArray(body.coupon.selections) || body.coupon.selections.length !== 1) {
      return { ok: false, reason: `selections_count_must_be_one:${body.coupon?.selections?.length}` };
    }
    const sel = body.coupon.selections[0];
    if (!isPlainObject(sel)) {
      return { ok: false, reason: 'selection_not_an_object' };
    }
    if (String(sel.oddId || '') !== expected.selectionId) {
      return { ok: false, reason: `odd_id_mismatch:${sel.oddId}!=${expected.selectionId}` };
    }
    if (String(sel.matchId || '') !== expected.eventId) {
      return { ok: false, reason: `match_id_mismatch:${sel.matchId}!=${expected.eventId}` };
    }
    if (typeof sel.cf !== 'number' || Math.abs(sel.cf - expected.price) > 1e-9) {
      return { ok: false, reason: `price_mismatch:${sel.cf}!=${expected.price}` };
    }
    if (sel.marketId !== undefined && sel.marketId !== null && String(sel.marketId) !== expected.marketId) {
      return { ok: false, reason: `market_id_mismatch:${sel.marketId}!=${expected.marketId}` };
    }
    return { ok: true };
  }

  async installGuard() {
    if (this.guarded && typeof this._guardHandler === 'function' && this._guardedPage === this.page) return;
    // The flag is derived from a handler that really is installed on this page.
    this.guarded = false;
    this._guardHandler = null;
    const handler = (route) => this._handleRoute(route);
    await this.page.route('**/*', handler);
    this._guardHandler = handler;
    this._guardedPage = this.page;
    this.guarded = true;
  }

  async _handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = String(request.method()).toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const refuse = (reason, signal = true) => {
      this.blocked.push(pathName);
      this.blocked_reasons.push(reason);
      if (signal) this._signalGuardAbort?.(reason);
      return route.abort();
    };

    const isForbiddenMutation = /\/bets\/(?:refund|cashout|sell)(?:\/|$)/i.test(pathName)
      || /(?:place.?bet|bet.?place|create.?bet|bets?\/create|bets?\/submit|wager|express-ordinary|\/ordinary(?:\/|$))/i.test(pathName);
    if (!isRead && isForbiddenMutation) return refuse('forbidden_mutation_path', false);

    const isMakeBet = /\/bets\/make-bet-v2(?:\/|$)/i.test(pathName);
    // Any other placement endpoint (another version, another verb, another host) is unknown
    // territory: it is stopped instead of being waved through.
    if (!isRead && !isMakeBet && /make-?bet/i.test(pathName)) return refuse('unknown_bet_endpoint');

    if (isMakeBet && !isRead) {
      const expected = this.armedExpectation;
      this.submitArmed = false;
      this.armedExpectation = null;

      if (method !== 'POST' || !BET_API_HOSTS.has(url.hostname)) {
        return refuse(`make_bet_request_not_expected:${method}:${url.hostname}`);
      }
      if (!expected || this.submitSentCount >= 1) return refuse('unarmed_or_duplicate_make_bet_post', false);

      let postBody = null;
      try {
        if (typeof request.postDataJSON === 'function') {
          postBody = request.postDataJSON();
        } else {
          postBody = JSON.parse(request.postData() || '{}');
        }
      } catch {
        return refuse('invalid_json_in_post_body', false);
      }

      const validation = this._validateMakeBetRequestBody(postBody, expected);
      if (!validation.ok) return refuse(validation.reason);

      // Freshness is decided at the moment of permission, not at an earlier
      // await: withdrawal first (awaited), then one synchronous check of the
      // clock, the earliest evidence expiry and the durable attempt state.
      let boundary;
      if (await this._cancelledAtBoundary()) {
        boundary = { ok: false, reason: 'cancelled_at_post_boundary' };
      } else {
        boundary = this._postBoundaryCheck(expected);
      }
      if (!boundary.ok) return refuse(boundary.reason);

      this.submitSentCount += 1;
      return route.fallback();
    }

    if (!isRead && this.armedExpectation) {
      // While the submit is armed nothing but the expected POST may mutate anything.
      this.unexpectedMutations += 1;
      return refuse('unexpected_mutation_while_armed');
    }
    return route.fallback();
  }

  slip() {
    return this.page.getByText('Betslip', { exact: true }).locator('xpath=ancestor::aside[1]');
  }

  async clear() {
    const slip = this.slip();
    const empty = slip.getByText('Select an outcome', { exact: false });
    if (await empty.isVisible()) return true;
    const trash = slip.getByRole('button').filter({ has: this.page.locator('[style*="trash.svg"]') });
    if (await trash.count() === 1 && await trash.isVisible()) await trash.click({ timeout: 5000 });
    await empty.waitFor({ state: 'visible', timeout: 8000 });
    return true;
  }

  _validateLivePlan(plan, nowFn) {
    if (!isPlainObject(plan) || !isPlainObject(plan.selection) || typeof plan.ui_selection_name !== 'string' || !plan.ui_selection_name.trim()) {
      throw new Error('EXACT_PLAN_REQUIRED');
    }
    if (plan.execution_ready !== true || (Array.isArray(plan.execution_blockers) && plan.execution_blockers.length > 0)) {
      throw new Error('EXECUTION_NOT_READY');
    }
    if (plan.live_submit_contract_verified !== true && plan.account_conditions?.live_submit_contract_verified !== true) {
      throw new Error('LIVE_SUBMIT_CONTRACT_UNVERIFIED');
    }
    if (typeof plan.live_submit_contract_source !== 'string' || !plan.live_submit_contract_source.trim()) {
      throw new Error('LIVE_SUBMIT_CONTRACT_UNVERIFIED');
    }

    const idempotencyKey = typeof plan.idempotency_key === 'string' ? plan.idempotency_key.trim() : '';
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }

    const currentNow = nowFn();
    if (typeof currentNow !== 'number' || !Number.isFinite(currentNow) || currentNow <= 0) {
      throw new Error('INVALID_CLOCK');
    }
    const planExpiry = plan.expires_at;
    if (typeof planExpiry !== 'number' || !Number.isFinite(planExpiry) || planExpiry <= 0) {
      throw new Error('EXPIRES_AT_REQUIRED');
    }
    if (currentNow >= planExpiry) {
      throw new Error('TASK_EXPIRED');
    }
    // Every piece of evidence the order rests on carries its own absolute
    // expiry; the plan may never outlive the earliest of them.
    const expiries = plan.evidence?.expiries;
    if (!isPlainObject(expiries)) {
      throw new Error('EVIDENCE_EXPIRIES_REQUIRED');
    }
    for (const name of REQUIRED_EXPIRIES) {
      if (!isFinitePositive(expiries[name])) throw new Error(`EVIDENCE_EXPIRY_REQUIRED:${name}`);
    }
    const earliestEvidence = Math.min(...REQUIRED_EXPIRIES.map((name) => expiries[name]));
    if (planExpiry > earliestEvidence + 1e-9) {
      throw new Error('PLAN_EXPIRY_EXCEEDS_EVIDENCE');
    }
    if (currentNow >= earliestEvidence) {
      throw new Error('EVIDENCE_EXPIRED');
    }
    const expiresAt = Math.min(planExpiry, earliestEvidence);

    if (typeof plan.currency !== 'string' || plan.currency.trim() !== 'USDT') {
      throw new Error('UNSUPPORTED_CURRENCY');
    }

    const stake = plan.stake;
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (this.diagnosticMode && (stake !== 1 || this.maxBudgetUsdt > 1)) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }
    if (stake > this.maxBudgetUsdt) {
      throw new Error('STAKE_BUDGET_VIOLATION');
    }

    const expectedAxes = plan.expected_axes;
    const selectionAxes = plan.selection.axes;
    if (!isPlainObject(expectedAxes) || !isPlainObject(selectionAxes)) {
      throw new Error('AXES_REQUIRED');
    }
    for (const reqKey of REQUIRED_AXIS_KEYS) {
      if (typeof expectedAxes[reqKey] !== 'string' || !expectedAxes[reqKey].trim()) {
        throw new Error(`AXES_INCOMPLETE:${reqKey}`);
      }
      if (typeof selectionAxes[reqKey] !== 'string' || !selectionAxes[reqKey].trim()) {
        throw new Error(`AXES_INCOMPLETE:${reqKey}`);
      }
    }
    const expUnit = expectedAxes.unit.trim().toLowerCase();
    const selUnit = selectionAxes.unit.trim().toLowerCase();
    if (GUESSED_UNITS.has(expUnit) || GUESSED_UNITS.has(selUnit)) {
      throw new Error('UNVERIFIED_AXES_UNIT');
    }
    const expKeys = Object.keys(expectedAxes).sort();
    const selKeys = Object.keys(selectionAxes).sort();
    if (expKeys.length !== selKeys.length || !expKeys.every((k, i) => k === selKeys[i])) {
      throw new Error('AXES_MISMATCH:keys');
    }
    for (const k of expKeys) {
      if (!deepEqual(expectedAxes[k], selectionAxes[k])) {
        throw new Error(`AXES_MISMATCH:${k}`);
      }
    }
    for (const facts of [expectedAxes, selectionAxes]) {
      // 'proven' = declared by the sources, 'not_declared' = nothing declared (recorded as
      // such); a missing or unverified rule never reaches the bookmaker.
      if (!isPlainObject(facts.payout_rule) || !['proven', 'not_declared'].includes(facts.payout_rule.status)) {
        throw new Error('PAYOUT_RULE_UNVERIFIED');
      }
    }

    const acct = plan.account_conditions;
    if (!isPlainObject(acct)) {
      throw new Error('ACCOUNT_CONDITIONS_REQUIRED');
    }
    if (acct.logged_in !== true) {
      throw new Error('ACCOUNT_NOT_LOGGED_IN');
    }
    if (acct.account_identity_verified !== true
      || typeof acct.account_identity_source !== 'string' || !acct.account_identity_source.trim()) {
      throw new Error('ACCOUNT_IDENTITY_UNVERIFIED');
    }
    if (acct.currency !== 'USDT') {
      throw new Error('ACCOUNT_CURRENCY_MISMATCH');
    }
    if (typeof acct.available_balance !== 'number' || !Number.isFinite(acct.available_balance) || acct.available_balance < stake) {
      throw new Error('INSUFFICIENT_WALLET_BALANCE');
    }
    if (typeof acct.commission !== 'number' || !Number.isFinite(acct.commission) || acct.commission < 0 || acct.commission >= 1) {
      throw new Error('UNVERIFIED_COMMISSION');
    }
    if (typeof acct.max_stake !== 'number' || !Number.isFinite(acct.max_stake) || acct.max_stake < stake) {
      throw new Error('INSUFFICIENT_CAPACITY');
    }

    const selection = plan.selection;
    if (
      typeof selection.event_id !== 'string' || !/^\d+$/.test(selection.event_id) ||
      typeof selection.market_id !== 'string' || !selection.market_id.trim() ||
      typeof selection.selection_id !== 'string' || !/^\d+:\d+:\d+$/.test(selection.selection_id) ||
      typeof selection.market_name !== 'string' || !selection.market_name.trim() ||
      typeof selection.price !== 'number' || !Number.isFinite(selection.price) || selection.price <= 1
    ) {
      throw new Error('EXACT_SELECTION_IDENTITY_REQUIRED');
    }

    let url;
    try {
      url = new URL(selection.event_url);
    } catch {
      throw new Error('UNSAFE_EVENT_URL');
    }
    if (url.protocol !== 'https:' || url.hostname !== '1win.pro'
      || url.pathname !== `/betting/match/sport/${selection.event_id}`) {
      throw new Error('UNSAFE_EVENT_URL');
    }

    return { idempotencyKey, stake, expiresAt, selection };
  }

  // Persist a post-send outcome. A recording failure never hides the bookmaker's
  // answer: the receipt is kept in the result and in the emergency journal, the
  // attempt key stays claimed and the failure is flagged for the caller.
  async recordPostSend(result, key, status, detail) {
    try {
      await this.attemptStore.record(key, status, detail);
    } catch (recordError) {
      result.durable_record_failed = true;
      result.durable_record_error = String(recordError.message || recordError).slice(0, 300);
      const journaled = typeof this.attemptStore.appendEmergencyJournal === 'function'
        ? this.attemptStore.appendEmergencyJournal({ key, status, receipt: detail.receipt ?? null, error: detail.error ?? null })
        : false;
      result.emergency_journal_written = journaled;
    }
  }

  async run(plan, { now = () => Date.now() / 1000, screenshotPre, screenshotPost, cancelled = async () => false } = {}) {
    if (this.busy) throw new Error('ONEWIN_LIVE_CART_BUSY');
    if (!this.liveEnabled || process.env.ONEWIN_AUTOMATION_LIVE_ENABLED !== 'true') {
      throw new Error('LIVE_PLACEMENT_DISABLED');
    }
    if (
      !this.attemptStore ||
      !(this.attemptStore instanceof DurableAttemptStore) ||
      this.attemptStore.isDurable !== true ||
      typeof this.attemptStore.claim !== 'function' ||
      typeof this.attemptStore.record !== 'function'
    ) {
      throw new Error('DURABLE_ATTEMPT_STORE_REQUIRED');
    }

    // The single diagnostic test bet is spent per cart: refuse before anything is claimed.
    if (this.diagnosticMode && this.submitSentCount >= 1) {
      const replayKey = typeof plan?.idempotency_key === 'string' ? plan.idempotency_key.trim() : '';
      throw new Error(replayKey && this.attemptStore.getAttempt(replayKey)
        ? 'DUPLICATE_IDEMPOTENCY_KEY' : 'DIAGNOSTIC_BUDGET_SPENT');
    }

    const { idempotencyKey, stake, expiresAt, selection } = this._validateLivePlan(plan, now);

    // Busy is taken before the first await so that two concurrent runs cannot both pass.
    this.busy = true;
    this.blocked = [];
    this.blocked_reasons = [];
    this.unexpectedMutations = 0;
    this.submitArmed = false;
    this.armedExpectation = null;
    if (!this.diagnosticMode) this.submitSentCount = 0; // counters are per run in production mode
    let claimed = false;
    try {
      claimed = await this.attemptStore.claim(idempotencyKey, {
        stake,
        currency: 'USDT',
        payload: plan,
        maxStake: this.maxBudgetUsdt,
      });
    } catch (claimError) {
      this.busy = false;
      throw claimError;
    }
    if (!claimed) {
      this.busy = false;
      // Same key: replay of a known attempt. Different key: another live intent
      // already owns this native selection.
      throw new Error(this.attemptStore.getAttempt(idempotencyKey)
        ? 'DUPLICATE_IDEMPOTENCY_KEY' : 'DUPLICATE_SELECTION_ATTEMPT');
    }

    this._runtime = { now, cancelled };
    const started = performance.now();
    const result = {
      ok: false,
      dry_run: false,
      live: true,
      idempotency_key: idempotencyKey,
      status: 'INITIATED',
      cart_cleared: false,
      event_id: selection.event_id,
      market_id: selection.market_id,
      selection_id: selection.selection_id,
      market: selection.market_name,
      selection: plan.ui_selection_name,
      stake,
      currency: 'USDT',
      phases: {},
    };

    const phase = async (name, action) => {
      result.stage = name;
      const start = performance.now();
      try { return await action(); } finally { result.phases[name] = Math.round(performance.now() - start); }
    };

    try {
      await this.installGuard();
      if (!this.guarded || typeof this._guardHandler !== 'function') throw new Error('GUARD_NOT_INSTALLED');
      if (await cancelled()) throw new Error('CANCELLED');

      await phase('navigation', async () => {
        if (eventIdFromUrl(this.page.url()) !== selection.event_id) {
          await this.page.goto(selection.event_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        await this.slip().getByText('Betslip', { exact: true }).waitFor({ timeout: 10000 });
      });

      await phase('initial_cleanup', () => this.clear());
      if (await cancelled()) throw new Error('CANCELLED');

      await phase('exact_selection', async () => {
        const title = this.page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({ has: this.page.getByText(plan.ui_selection_name, { exact: true }) });
        await button.first().waitFor({ state: 'visible', timeout: 8000 });
        if (await button.count() !== 1) throw new Error('AMBIGUOUS_EXACT_OUTCOME');
        result.market_title_candidates = await group.count();
        result.board_price = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (!(result.board_price > 1)) throw new Error('INVALID_BOARD_PRICE');
        if (Math.abs(selection.price - result.board_price) > 1e-9) {
          throw new Error('BOARD_PRICE_CHANGED');
        }
        await button.click({ timeout: 5000 });
      });

      await phase('basket_readback', async () => {
        const slip = this.slip();
        const expected = `${selection.market_name}, ${plan.ui_selection_name}`;
        await slip.getByText(expected, { exact: true }).waitFor({ timeout: 5000 });
        const amount = slip.locator('input[data-qa="amount"]:visible');
        await amount.click();
        await amount.press('ControlOrMeta+A');
        await amount.press('Backspace');
        await amount.pressSequentially(String(stake));
        await amount.press('Tab');
        result.amount = parseAmount(await amount.inputValue());
        if (result.amount === null || Math.abs(result.amount - stake) > 1e-9) {
          throw new Error('AMOUNT_READBACK_MISMATCH');
        }
        const title = this.page.getByText(selection.market_name, { exact: true }).filter({ visible: true });
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({ has: this.page.getByText(plan.ui_selection_name, { exact: true }) });
        const recheckPrice = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (recheckPrice === null || Math.abs(recheckPrice - selection.price) > 1e-9) {
          throw new Error('PRICE_DRIFT_BEFORE_SUBMIT');
        }
        const submitNow = now();
        if (typeof submitNow !== 'number' || !Number.isFinite(submitNow) || submitNow >= expiresAt) {
          throw new Error('TASK_EXPIRED_BEFORE_SUBMIT');
        }
        if (await cancelled()) throw new Error('CANCELLED');
        await this.attemptStore.record(idempotencyKey, 'PRE_CHECK_PASSED');
        if (screenshotPre) await slip.screenshot({ path: screenshotPre });
      });

      await phase('submit_and_reconcile', async () => {
        const slip = this.slip();
        const submitBtn = slip.getByRole('button', { name: 'Place a bet', exact: true });
        if (!await submitBtn.isVisible() || !await submitBtn.isEnabled()) {
          throw new Error('SUBMIT_BUTTON_UNAVAILABLE');
        }
        await this.attemptStore.record(idempotencyKey, 'SUBMITTING');
        const responsePromise = this.page.waitForResponse(
          res => /\/bets\/make-bet-v2(?:\/|$)/i.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
          { timeout: 15000 }
        );
        responsePromise.catch(() => {});
        const guardAborted = new Promise((resolve) => { this._signalGuardAbort = resolve; });

        // Bind exact expected body parameters to route handler before clicking submit.
        // The expiry carried here is the earliest of ALL evidence expiries; the
        // route guard re-reads the clock against it at the moment of permission.
        this.armedExpectation = {
          idempotencyKey,
          eventId: selection.event_id,
          marketId: selection.market_id,
          selectionId: selection.selection_id,
          stake,
          currency: 'USDT',
          price: selection.price,
          expiresAt,
        };
        this.submitArmed = true;

        let response;
        try {
          await submitBtn.click({ timeout: 5000 });
          response = await Promise.race([
            responsePromise,
            guardAborted.then((reason) => { throw new Error(`GUARD_ABORT:${reason}`); }),
          ]);
        } catch (sendErr) {
          this.submitArmed = false;
          this.armedExpectation = null;
          this._signalGuardAbort = null;
          if (this.submitSentCount === 0) {
            // Nothing was forwarded: the guard (or the page) stopped the request.
            const reason = this.blocked_reasons.length ? this.blocked_reasons[this.blocked_reasons.length - 1]
              : String(sendErr.message || sendErr).slice(0, 200);
            result.status = 'ABORTED_PRE_SUBMIT';
            await this.attemptStore.record(idempotencyKey, 'WITHDRAWN', {
              error: `SUBMIT_ABORTED_BEFORE_SEND:${reason}`,
              not_sent_proof: { forwarded_requests: 0, reason, submit_token: this.attemptStore.submitToken(idempotencyKey) },
            });
            throw new Error(`SUBMIT_ABORTED_BEFORE_SEND:${reason}`);
          }
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: String(sendErr.message || sendErr) });
          throw sendErr;
        }
        this.submitArmed = false;
        this.armedExpectation = null;
        this._signalGuardAbort = null;

        const body = await response.json().catch(() => null);
        if (!isPlainObject(body)) {
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: 'INVALID_RESPONSE_BODY' });
          throw new Error('PLACEMENT_INDETERMINATE:INVALID_RESPONSE_BODY');
        }

        const carriedSuccess = isPlainObject(body.result) && isPlainObject(body.result.success) ? body.result.success : null;
        const carriedId = carriedSuccess?.betId;
        const carriesBet = carriedSuccess !== null && ((typeof carriedId === 'number' && Number.isFinite(carriedId) && carriedId > 0)
          || (typeof carriedId === 'string' && carriedId.trim().length > 0));
        if (Array.isArray(body.errors) && body.errors.length > 0 && (carriesBet || carriedSuccess !== null)) {
          // An error next to a (possible) bet is not a rejection: the bet may exist.
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: 'MIXED_ERROR_AND_SUCCESS', receipt: body });
          throw new Error('PLACEMENT_INDETERMINATE:MIXED_ERROR_AND_SUCCESS');
        }
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          const errObj = isPlainObject(body.errors[0]) ? body.errors[0] : {};
          const errCode = typeof errObj.code === 'string' && errObj.code.trim() ? errObj.code.trim() : '';
          if (errCode && KNOWN_REJECTIONS.has(errCode)) {
            result.status = 'REJECTED';
            result.rejection_code = errCode;
            result.rejection_meta = errObj.meta || null;
            await this.recordPostSend(result, idempotencyKey, 'REJECTED', { error: errCode, receipt: body });
            throw new Error(`BOOKMAKER_REJECTED:${errCode}`);
          }
          const indCode = errCode || 'UNKNOWN_ERROR_CODE';
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: indCode, receipt: body });
          throw new Error(`PLACEMENT_INDETERMINATE:${indCode}`);
        }

        const success = isPlainObject(body.result) && isPlainObject(body.result.success) ? body.result.success : null;
        const rawBetId = success?.betId;
        const validBetId = (typeof rawBetId === 'number' && Number.isFinite(rawBetId) && rawBetId > 0)
          || (typeof rawBetId === 'string' && rawBetId.trim().length > 0);
        if (!success || !validBetId) {
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: 'MISSING_BET_ID', receipt: body });
          throw new Error('PLACEMENT_INDETERMINATE:MISSING_BET_ID');
        }

        const rawCf = success.cf;
        const acceptedCf = typeof rawCf !== 'boolean' && rawCf !== null && rawCf !== undefined ? Number(rawCf) : Number.NaN;
        const rawAmount = success.amount;
        const acceptedAmount = typeof rawAmount !== 'boolean' && rawAmount !== null && rawAmount !== undefined ? Number(rawAmount) : Number.NaN;
        const acceptedCurrency = typeof success.currencyCode === 'string' ? success.currencyCode.trim().toUpperCase() : '';
        const rawProfit = success.possibleProfitAmount;
        const possibleProfitAmount = typeof rawProfit !== 'boolean' && rawProfit !== null && rawProfit !== undefined && Number.isFinite(Number(rawProfit))
          ? Number(rawProfit)
          : null;
        const rejectedAmount = typeof success.rejectedAmount === 'number' && Number.isFinite(success.rejectedAmount)
          ? success.rejectedAmount
          : 0;

        const mismatches = [];
        if (!Number.isFinite(acceptedCf) || acceptedCf <= 1) {
          mismatches.push('invalid_accepted_cf');
        } else if (Math.abs(acceptedCf - selection.price) > 1e-9) {
          mismatches.push('accepted_cf_mismatch');
        }
        if (!Number.isFinite(acceptedAmount) || acceptedAmount <= 0) {
          mismatches.push('invalid_accepted_amount');
        } else if (Math.abs(acceptedAmount - stake) > 1e-9) {
          mismatches.push('accepted_amount_mismatch');
        }
        if (!acceptedCurrency) {
          mismatches.push('missing_accepted_currency');
        } else if (acceptedCurrency !== plan.currency) {
          mismatches.push('accepted_currency_mismatch');
        }
        if (rejectedAmount > 0) {
          mismatches.push('partial_rejection_amount');
        }

        result.receipt = {
          bet_id: String(rawBetId).trim(),
          accepted_cf: Number.isFinite(acceptedCf) ? acceptedCf : null,
          amount: Number.isFinite(acceptedAmount) ? acceptedAmount : null,
          currency: acceptedCurrency || null,
          possible_profit_amount: possibleProfitAmount,
          rejected_amount: rejectedAmount,
          condition_mismatch: mismatches.length > 0,
          condition_mismatches: mismatches,
          raw_success: success,
        };
        result.status = 'ACCEPTED';
        result.condition_mismatch = mismatches.length > 0;
        result.condition_mismatches = mismatches;
        result.ok = mismatches.length === 0;
        if (mismatches.length > 0) {
          result.error = `ACCEPTED_CONDITION_MISMATCH:${mismatches.join(',')}`;
        }

        await this.recordPostSend(result, idempotencyKey, 'ACCEPTED', {
          receipt: result.receipt,
          condition_mismatches: mismatches,
          error: result.error || null,
        });

        if (screenshotPost) {
          try {
            await this.page.screenshot({ path: screenshotPost });
          } catch (shotErr) {
            result.screenshot_post_error = String(shotErr.message || shotErr).slice(0, 300);
          }
        }
      });
    } catch (error) {
      this.submitArmed = false;
      this.armedExpectation = null;
      if (!['ACCEPTED', 'REJECTED', 'INDETERMINATE', 'ABORTED_PRE_SUBMIT'].includes(result.status)) {
        if (this.submitSentCount > 0) {
          result.status = 'INDETERMINATE';
          await this.recordPostSend(result, idempotencyKey, 'INDETERMINATE', { error: String(error.message || error) });
        } else {
          result.status = 'ABORTED_PRE_SUBMIT';
          // Nothing was forwarded. A potential-submit attempt (SUBMITTING) can only
          // be withdrawn with that proof; earlier phases need none.
          await this.attemptStore.record(idempotencyKey, 'WITHDRAWN', {
            error: String(error.message || error),
            not_sent_proof: { forwarded_requests: this.submitSentCount, reason: 'aborted_before_send',
              submit_token: this.attemptStore.submitToken(idempotencyKey) },
          }).catch(() => {});
        }
      }
      if (!result.error) {
        result.error = String(error.message || error).slice(0, 600);
      }
    } finally {
      this.submitArmed = false;
      this.armedExpectation = null;
      const terminalReached = result.status === 'ACCEPTED' || result.status === 'REJECTED' || result.status === 'INDETERMINATE';
      const failedStage = result.stage;
      try {
        result.cart_cleared = await phase('cleanup', () => this.clear());
      } catch (cleanupError) {
        result.cleanup_error = String(cleanupError.message || cleanupError).slice(0, 400);
        if (result.status !== 'ACCEPTED') {
          result.ok = false;
        }
      }
      if (!terminalReached && result.error) {
        result.stage = failedStage;
      } else if (result.status === 'ACCEPTED') {
        result.stage = 'completed';
      }
      result.elapsed_ms = Math.round(performance.now() - started);
      result.submit_sent_count = this.submitSentCount;
      result.blocked_submit_requests = this.blocked.length;
      result.blocked_reasons = [...this.blocked_reasons];
      this._runtime = null;
      this._signalGuardAbort = null;
      this.busy = false;
    }
    return result;
  }
}
