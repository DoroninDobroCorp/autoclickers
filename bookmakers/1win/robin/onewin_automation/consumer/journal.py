"""Consumer journal and instance lock.

The journal is the consumer's own record of how far each queue item got: an append-only JSON-lines
file, every record fsynced before the consumer goes on.  It is what makes a restart exact: the
executor's durable attempt says what happened to the money, the journal says what this consumer
still owes the queue and the export.  A torn last line (a crash in the middle of a write) is ignored;
a corrupt line in the middle is an error, never silently skipped.

Phases of one item, in order (each is a journal record):

  claimed        the queue lease was taken; the queue item is snapshotted (the task may vanish later)
  built          order/plan built; its digest, provenance and the advisory are recorded
  handed_off     the order was given to the executor (real) / dry-run requested
  observed       the executor reported a terminal state of the attempt
  decided        what goes to the queue (accepted/rejected/not_sent/unresolved/dry_run) and why
  queue_written  the queue history holds the decision
  exported       the receipt export was written
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from pathlib import Path
from typing import Any, Iterable

PHASES = ("claimed", "built", "handed_off", "observed", "decided", "queue_written", "exported")


class JournalError(RuntimeError):
    pass


class InstanceLockError(RuntimeError):
    pass


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class Journal:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fresh = not self.path.exists()
        self._fd = os.open(str(self.path), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        if fresh:
            _fsync_dir(self.path.parent)
        self._lock = threading.Lock()
        self._truncate_torn_tail()

    def _truncate_torn_tail(self) -> None:
        raw = self.path.read_bytes()
        if raw and not raw.endswith(b"\n"):
            # a record is complete only with its newline: the partial last write is cut off
            cut = raw.rfind(b"\n") + 1
            with open(self.path, "r+b") as handle:
                handle.truncate(cut)
                handle.flush()
                os.fsync(handle.fileno())

    def append(self, record: dict[str, Any]) -> dict[str, Any]:
        entry = {"at": time.time(), **record}
        line = json.dumps(entry, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n"
        with self._lock:
            os.write(self._fd, line.encode())
            os.fsync(self._fd)
        return entry

    def records(self) -> list[dict[str, Any]]:
        return read_records(self.path)

    def items(self) -> dict[str, dict[str, Any]]:
        """key -> {phase records by name, snapshot, last phase}"""
        return group_items(self.records())

    def close(self) -> None:
        try:
            os.close(self._fd)
        except OSError:
            pass


def read_records(path: str | Path) -> list[dict[str, Any]]:
    """The records of a journal file WITHOUT opening it for writing (a torn tail is ignored, a corrupt line is an error)."""
    out: list[dict[str, Any]] = []
    raw = Path(path).read_bytes()
    lines = raw.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    elif lines:
        lines.pop()  # a torn tail
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError as exc:
            raise JournalError(f"journal line {number} is corrupt") from exc
    return out


def group_items(records: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    state: dict[str, dict[str, Any]] = {}
    for record in records:
        key = record.get("key")
        if not isinstance(key, str):
            continue
        item = state.setdefault(key, {"key": key, "phases": {}, "order": []})
        phase = record.get("phase")
        if phase in PHASES:
            item["phases"][phase] = record
            item["order"].append(phase)
    for item in state.values():
        item["last"] = max((PHASES.index(p) for p in item["phases"]), default=-1)
        item["phase"] = PHASES[item["last"]] if item["last"] >= 0 else None
    return state


def open_exposures(items: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """What the journal still owes: items that are not exported, and items whose decision is ``unresolved`` and
    that nothing resolved afterwards.  Read-only; this is the list an operator needs before a rollback."""
    out = []
    for key, item in items.items():
        decided = ((item["phases"].get("decided") or {}).get("decision") or {})
        exported = item["phases"].get("exported") or {}
        unfinished_item = item["phase"] != "exported"
        unresolved = decided.get("status") == "unresolved" and not exported.get("late_resolution")
        if unfinished_item or unresolved:
            out.append({"key": key, "task_id": (item["phases"].get("claimed") or {}).get("task_id"), "phase": item["phase"],
                        "handed_off": "handed_off" in item["phases"], "decision": decided.get("status"),
                        "reasons": decided.get("reasons")})
    return out


def unfinished(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in items if item.get("phase") not in ("exported",)]


class InstanceLock:
    """One consumer per account state directory.  A holder that beats keeps it; a dead one is taken over."""

    def __init__(self, path: str | Path, *, stale_s: float = 20.0):
        self.path = Path(path)
        self.stale_s = stale_s
        self._held = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.token = f"{os.getpid()}-{time.time_ns()}"

    def _body(self) -> bytes:
        return json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "token": self.token, "heartbeat_at": time.time()}).encode()

    def acquire(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        for _ in range(3):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                try:
                    holder = json.loads(self.path.read_text())
                except (OSError, ValueError):
                    holder = None
                if holder and self._holder_alive(holder):
                    raise InstanceLockError(f"another consumer (pid {holder.get('pid')}) owns this account state")
                try:
                    self.path.unlink()
                except OSError:
                    pass
                continue
            try:
                os.write(fd, self._body())
                os.fsync(fd)
            finally:
                os.close(fd)
            self._held = True
            break
        else:
            raise InstanceLockError("instance lock could not be taken")
        self._thread = threading.Thread(target=self._beat, daemon=True)
        self._thread.start()

    def _holder_alive(self, holder: dict[str, Any]) -> bool:
        """A holder whose process is gone (same host) is stale at once; otherwise it must keep beating."""
        pid = holder.get("pid")
        if holder.get("host") == socket.gethostname() and isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return False
            except PermissionError:
                pass
        return time.time() - float(holder.get("heartbeat_at", 0)) < self.stale_s

    def _beat(self) -> None:
        while not self._stop.wait(self.stale_s / 4):
            try:
                tmp = self.path.with_suffix(".lock.tmp")
                tmp.write_bytes(self._body())
                os.replace(tmp, self.path)
            except OSError:
                pass

    def release(self) -> None:
        self._stop.set()
        if self._held:
            try:
                holder = json.loads(self.path.read_text())
                if holder.get("token") == self.token:
                    self.path.unlink()
            except (OSError, ValueError):
                pass
            self._held = False
