"""Test support for the consumer integration tests: real queue code, the product consumer entrypoint,
the product executor in front of a local TLS stand.  The stand is the ONLY stub; its evidence is
synthetic and labelled so."""
from __future__ import annotations

import json
import os
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from native_fixture_support import RECORDED, recorded_native_market
from onewin_automation.common import instant
from onewin_automation.consumer.queue_client import QueueClient

HERE = Path(__file__).resolve().parent
ONEWIN_SCRIPTS = HERE / "scripts" / "onewin"
LAUNCHER = ONEWIN_SCRIPTS / "executor_stand_launcher.mjs"
NODE = os.environ.get("NODE") or shutil.which("node")
REPLAY_NOW = instant(RECORDED["replay_now_iso"])


def replay_offset(at: float | None = None) -> float:
    """Offset that makes the wall clock read ``at`` (default: just after the recorded frame) right now."""
    return (REPLAY_NOW + 0.5 if at is None else at) - time.time()
TOKEN = "stand-executor-token-" + uuid.uuid4().hex
MARKER = f"onewin-consumer-drill-{uuid.uuid4().hex[:12]}"


def case(name: str = "P1 T< 1") -> dict[str, Any]:
    return json.loads(json.dumps(next(c for c in RECORDED["cases"] if c["name"] == name)))


def live_case(name: str = "P1 T< 1") -> dict[str, Any]:
    """A COPY of the recorded event with isLive=true and the three quote clocks aligned to the donor
    clock (synthetic variation, labelled as such): the recorded frame is prematch."""
    out = case(name)
    out["pair"]["isLive"] = True
    donor = out["outcome"]["donor_quote"]
    t0 = instant(donor["observed_at"]) if donor.get("source_ts") is None else instant(donor["source_ts"])
    for quote in [out["outcome"]["reference_quote"], donor, *out["outcome"]["margin_quotes"]]:
        quote["source_ts"] = t0
        quote.pop("state_confirmation", None)
    out["t0"] = t0
    return out


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Stand:
    """executor_stand_launcher.mjs as a subprocess: product executor + local bookmaker stand."""

    def __init__(self, state_dir: Path, *, mode: str = "real", clock_offset: float | None = None, env: dict[str, str] | None = None):
        self.state_dir = Path(state_dir)
        self.mode = mode
        self.clock_offset = clock_offset
        self.env = {**os.environ, "ONEWIN_EXECUTOR_TOKEN": TOKEN, "ONEWIN_AUTOMATION_LIVE_ENABLED": "true",
                    "ONEWIN_STAND_MARKER": MARKER, **(env or {})}
        self.proc: subprocess.Popen | None = None
        # fixed for the life of the Stand object: a restarted executor is found at the same address
        self.executor_port, self.control_port = _free_port(), _free_port()
        self.orphans_killed: list[int] = []
        self.orphans_after_restart: list[int] = []
        self.ready: dict[str, Any] = {}
        self.stderr = tempfile.NamedTemporaryFile("w+", suffix=".stand.err", delete=False)

    def start(self) -> "Stand":
        if self.stderr.closed:
            self.stderr = tempfile.NamedTemporaryFile("w+", suffix=".stand.err", delete=False)
        command = [NODE, str(LAUNCHER), "--state-dir", str(self.state_dir), "--mode", self.mode, "--token-env", "ONEWIN_EXECUTOR_TOKEN",
                   "--executor-port", str(self.executor_port), "--control-port", str(self.control_port)]
        if self.clock_offset is not None:
            command += ["--clock-offset", repr(self.clock_offset)]
        self.proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=self.stderr, text=True, env=self.env)
        holder: dict[str, str] = {}

        def read() -> None:
            holder["line"] = self.proc.stdout.readline()  # type: ignore[union-attr]

        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        thread.join(60)
        if not holder.get("line"):
            self.stderr.flush()
            self.stderr.seek(0)
            detail = self.stderr.read()[-1500:]
            self.stop(force=True)
            raise RuntimeError(f"stand did not start: {detail}")
        self.ready = json.loads(holder["line"])
        return self

    def restart(self, **config: Any) -> "Stand":
        """A new executor process on the same attempt store and the same address."""
        previous = self.proc.pid if self.proc else None
        self.kill()                     # the process is gone; its browser may not be
        self.start()                    # a successor on the same store finds and removes it by the recorded marker
        needle = f"{MARKER}-{previous}-"
        out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True).stdout
        self.orphans_after_restart = [int(l.split(None, 1)[0]) for l in out.splitlines() if needle in l and "ps -eo" not in l]
        if config:
            self.config(**config)
        return self

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.executor_port}"

    def _control(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.control_port}{path}", data=data, method=method,
                                         headers={"content-type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as reply:  # noqa: S310
            return json.loads(reply.read())

    def log(self) -> dict[str, Any]:
        return self._control("GET", "/stand/log")

    def config(self, **patch: Any) -> None:
        self._control("POST", "/stand/config", patch)

    def reset(self) -> None:
        self._control("POST", "/stand/reset", {})

    @property
    def money(self) -> int:
        return self.log()["money_requests"]

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(timeout=10)

    def _kill_own_orphans(self) -> list[int]:
        """A launcher that was SIGKILLed leaves its browser behind (the drill's crash points do exactly
        that): the owner of the drill removes it by the marker of THAT launcher, nothing else."""
        if not self.proc:
            return []
        needle = f"{MARKER}-{self.proc.pid}-"
        out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True).stdout
        killed = []
        for line in out.splitlines():
            if needle in line and "ps -eo" not in line:
                pid = int(line.split(None, 1)[0])
                try:
                    os.kill(pid, signal.SIGKILL)
                    killed.append(pid)
                except OSError:
                    pass
        return killed

    def stop(self, force: bool = False) -> None:
        if not self.proc:
            return
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL if force else signal.SIGTERM)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        if self.proc.stdout:
            self.proc.stdout.close()
        self.orphans_killed = self._kill_own_orphans()
        try:
            self.stderr.close()
        except OSError:
            pass


def leftover_browsers() -> list[int]:
    """Processes of this test session that outlived their owner (matched by the session marker only)."""
    out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True).stdout
    return [int(line.split(None, 1)[0]) for line in out.splitlines() if MARKER in line and "ps -eo" not in line
            and int(line.split(None, 1)[0]) != os.getpid()]


def write_policy(directory: Path, *, mode: str, stand_url: str, tasks_file: Path, state_dir: Path, account_id: str = "acct-1",
                 consumer_id: str | None = None, jev: dict[str, Any] | None = None, **overrides: Any) -> Path:
    policy = {
        "schema": "onewin-consumer-policy.v1", "mode": mode, "account_id": account_id, "currency": "USDT", "stake": 1.0, "max_stake": 1.0,
        "purpose": "diagnostic_test", "environment": "local_stand", "bookmaker_id": "1win", "tasks_file": str(tasks_file),
        "state_dir": str(state_dir), "consumer_id": consumer_id or f"consumer-{account_id}",
        "executor": {"url": stand_url, "token_env": "ONEWIN_EXECUTOR_TOKEN", "timeout_s": 10},
        "poll_interval_ms": 100, "executor_deadline_s": 25, "evidence_deadline_s": 5, "lease_ms": 20000,
    }
    if jev:
        policy["jev"] = jev
    policy.update(overrides)
    path = directory / f"policy-{account_id}-{policy['consumer_id']}-{mode}.json"
    path.write_text(json.dumps(policy, indent=2))
    return path


def run_consumer(policy: Path, *extra: str, env: dict[str, str] | None = None, timeout: int = 120, command: str = "run") -> tuple[int, list[dict[str, Any]]]:
    full_env = {**os.environ, "ONEWIN_EXECUTOR_TOKEN": TOKEN, "PYTHONPATH": str(HERE), **(env or {})}
    proc = subprocess.run([sys.executable, "-m", "onewin_automation.consumer", command, "--policy", str(policy), *extra],
                          cwd=str(HERE), env=full_env, capture_output=True, text=True, timeout=timeout)
    lines = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                lines.append(json.loads(line))
            except ValueError:
                pass
    return proc.returncode, lines


def reports(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [l for l in lines if l.get("schema") == "onewin-consumer-report.v1"]


class Producer:
    """The producer side of the queue: the REAL TaskBuilder + TasksManager.addTask, in another process."""

    def __init__(self, tasks_file: Path):
        self.tasks_file = tasks_file
        self.queue = QueueClient(str(tasks_file), producer_ops=True)

    def add(self, spec: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
        spec = spec or case()
        out = self.queue.request("produce", pair=spec["pair"], outcome=spec["outcome"], stake=kw.pop("stake", 1), **kw)
        assert out["added"] is True, out
        return out["item"]

    def state(self, task_id: Any) -> dict[str, Any]:
        return self.queue.request("task_state", task_id=task_id)

    def current(self) -> dict[str, Any]:
        return self.queue.request("current")

    def history(self) -> list[dict[str, Any]]:
        return json.loads(self.tasks_file.read_text())["history"]

    def raw(self) -> dict[str, Any]:
        return json.loads(self.tasks_file.read_text())

    def close(self) -> None:
        self.queue.close()


def native_market_for(name: str = "P1 T< 1") -> dict[str, Any]:
    market = recorded_native_market(name)
    assert market is not None
    return market


def configure_stand(stand: Stand, name: str = "P1 T< 1") -> None:
    market = native_market_for(name)
    stand.config(native_market=market, ui={"market_name": market["group_name"], "ui_selection_name": market["selection_name"]})


def start_consumer(policy: Path, *extra: str, env: dict[str, str] | None = None, command: str = "run") -> subprocess.Popen:
    full_env = {**os.environ, "ONEWIN_EXECUTOR_TOKEN": TOKEN, "PYTHONPATH": str(HERE), **(env or {})}
    return subprocess.Popen([sys.executable, "-m", "onewin_automation.consumer", command, "--policy", str(policy), *extra],
                            cwd=str(HERE), env=full_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def finish_consumer(proc: subprocess.Popen, timeout: int = 120) -> tuple[int, list[dict[str, Any]]]:
    out, _ = proc.communicate(timeout=timeout)
    lines = []
    for line in out.splitlines():
        if line.strip().startswith("{"):
            try:
                lines.append(json.loads(line))
            except ValueError:
                pass
    return proc.returncode, lines


def drive(policy: Path, point: str, offset: float | None, timeout: int = 120) -> tuple[int, str]:
    """Run the product consumer with a hook that kills it at a named durable point."""
    env = {**os.environ, "ONEWIN_EXECUTOR_TOKEN": TOKEN, "PYTHONPATH": str(HERE)}
    proc = subprocess.run([sys.executable, str(HERE / "consumer_driver.py"), str(policy), point, "none" if offset is None else repr(offset)],
                          cwd=str(HERE), env=env, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout
