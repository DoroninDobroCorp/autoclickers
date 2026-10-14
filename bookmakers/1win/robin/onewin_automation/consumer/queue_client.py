"""Client of ``scripts/onewin/queue_worker.mjs``: the Node queue code (TasksManager) behind JSON lines."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

WORKER = Path(__file__).resolve().parents[2] / "scripts" / "onewin" / "queue_worker.mjs"


class QueueError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code


class QueueClient:
    def __init__(self, tasks_file: str, *, bookmaker: str = "1win", producer_ops: bool = False,
                 node: str | None = None, timeout_s: float = 20.0):
        self._node = node or os.environ.get("NODE") or shutil.which("node")
        if not self._node:
            raise QueueError("NODE_UNAVAILABLE", "node is required for the queue worker")
        command = [self._node, str(WORKER), "--tasks-file", tasks_file, "--bookmaker", bookmaker]
        if producer_ops:
            command.append("--producer-ops")
        self._timeout = timeout_s
        self._lock = threading.Lock()
        self._seq = 0
        self._proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      text=True, bufsize=1)
        self.pid = self._proc.pid
        self.request("ping")

    def request(self, op: str, **args: Any) -> Any:
        with self._lock:
            if self._proc.poll() is not None:
                raise QueueError("WORKER_EXITED", f"rc={self._proc.returncode}")
            self._seq += 1
            line = json.dumps({"id": self._seq, "op": op, "args": args}, allow_nan=False)
            try:
                assert self._proc.stdin is not None and self._proc.stdout is not None
                self._proc.stdin.write(line + "\n")
                self._proc.stdin.flush()
                timer = threading.Timer(self._timeout, self._proc.kill)
                timer.start()
                try:
                    reply = self._proc.stdout.readline()
                finally:
                    timer.cancel()
            except (BrokenPipeError, OSError) as exc:
                raise QueueError("WORKER_IO", str(exc)) from exc
            if not reply:
                raise QueueError("WORKER_NO_REPLY", f"op {op}")
            message = json.loads(reply)
            if message.get("id") != self._seq:
                raise QueueError("WORKER_OUT_OF_SYNC", f"op {op}")
            if not message.get("ok"):
                error = message.get("error") or {}
                raise QueueError(error.get("code", "OP_FAILED"), error.get("message", ""))
            return message.get("result")

    def close(self) -> None:
        proc = self._proc
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    def __enter__(self) -> "QueueClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
