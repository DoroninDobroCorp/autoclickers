import contextlib
import fcntl
import os
import sys

_SINGLETON_LOCK_PATH = os.environ.get(
    "ROBINARB_AUTOPLACE_LOCK_PATH",
    os.path.join(os.path.dirname(__file__), ".autoplace_runner.lock"),
)


@contextlib.contextmanager
def singleton_runner_lock(path: str = _SINGLETON_LOCK_PATH):
    """Refuse to run if another autoplace runner already holds this lock.

    Five separate scripts (fast_auto_place.py, auto_place_runner.py,
    place_sequential_arbs.py, daemon_autoplace.py, async_auto_place.py) can
    all place real bets against the same account, and none of them know
    about each other -- two started by accident could both act on the same
    arb concurrently. ``flock`` rather than a hand-written PID file
    deliberately: the OS releases the lock the instant the holding process
    exits for *any* reason, including a crash, so there is no stale-lock
    state to clean up by hand.
    """
    handle = open(path, "a+")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print(
                f"[REFUSED] Another autoplace runner already holds {path} -- "
                "refusing to start a second one against the same account.",
                flush=True,
            )
            sys.exit(1)
        yield
    finally:
        handle.close()


class AutoplaceGuard:
    def __init__(
        self,
        max_consecutive_errors: int | None = None,
        max_total_stake: float | None = None,
        max_pairs_per_run: int | None = None,
    ):
        self.consecutive_errors = 0
        self.total_stake_placed = 0.0
        self.pairs_placed = 0

        self.max_consecutive_errors = (
            max_consecutive_errors
            if max_consecutive_errors is not None
            else int(os.environ.get("ROBINARB_MAX_CONSECUTIVE_ERRORS", "5"))
        )
        self.max_total_stake = (
            max_total_stake
            if max_total_stake is not None
            else float(os.environ.get("ROBINARB_MAX_TOTAL_STAKE", "100.0"))
        )
        self.max_pairs_per_run = (
            max_pairs_per_run
            if max_pairs_per_run is not None
            else int(os.environ.get("ROBINARB_MAX_PAIRS_PER_RUN", "20"))
        )

    def record_success(self, stake_placed: float):
        self.consecutive_errors = 0
        self.total_stake_placed += stake_placed
        self.pairs_placed += 1

    def record_error(self):
        self.consecutive_errors += 1

    def check_limits(self) -> tuple[bool, str | None]:
        """Returns (should_stop, reason)"""
        if self.consecutive_errors >= self.max_consecutive_errors:
            reason = f"[GLOBAL KILL-SWITCH] Consecutive error limit reached ({self.consecutive_errors}/{self.max_consecutive_errors}). Halting autoplace runner."
            return True, reason

        if self.total_stake_placed >= self.max_total_stake:
            reason = f"[GLOBAL KILL-SWITCH] Max total stake limit reached (${self.total_stake_placed:.2f} >= ${self.max_total_stake:.2f}). Halting autoplace runner."
            return True, reason

        if self.pairs_placed >= self.max_pairs_per_run:
            reason = f"[GLOBAL KILL-SWITCH] Max pairs limit reached ({self.pairs_placed}/{self.max_pairs_per_run}). Halting autoplace runner."
            return True, reason

        return False, None
