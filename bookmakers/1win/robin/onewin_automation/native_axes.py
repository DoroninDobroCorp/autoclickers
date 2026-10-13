"""Independent derivation of canonical bet facts from native 1win market data (interface only).

The derivation is added together with its implementation in the next commit;
this stub fixes the public interface so the contract tests fail on behaviour,
not on import errors.
"""
from __future__ import annotations

NATIVE_DERIVER_VERSION = "onewin-native-axes.v1"


class NativeAxesUnknown(ValueError):
    """The native selection cannot be turned into proven canonical facts."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(f"{code}: {message}" if message else code)


def derive_native_axes(*, sport_id, group_name: str, selection_name: str, points: float | None,
                       home_name: str | None = None, away_name: str | None = None,
                       outcome_code: str | None = None) -> dict:
    raise NativeAxesUnknown("not_implemented")


def facts_from_native_evidence(evidence: dict) -> dict:
    raise NativeAxesUnknown("not_implemented")
