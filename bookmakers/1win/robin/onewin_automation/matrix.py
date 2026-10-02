"""Deterministic sports/outcome acceptance matrix runner."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .basket import BasketValidationError, PriceDriftError


@dataclass(frozen=True)
class MatrixCase:
    sport: str
    outcome: str
    arb: dict[str, Any]
    stake: float


@dataclass(frozen=True)
class MatrixRow:
    sport: str
    outcome: str
    status: str
    detail: str


@dataclass(frozen=True)
class MatrixReport:
    rows: tuple[MatrixRow, ...]

    @property
    def counts(self) -> dict[str, int]:
        return {
            name: sum(row.status == name for row in self.rows)
            for name in ("pass", "unavailable", "fail")
        }


async def run_matrix(cases: list[MatrixCase], preparer: Any) -> MatrixReport:
    rows: list[MatrixRow] = []
    for index, case in enumerate(cases):
        try:
            receipt = await preparer.prepare(
                case.arb,
                stake=case.stake,
                idempotency_key=f"ow-matrix-{index}",
            )
        except PriceDriftError as exc:
            rows.append(MatrixRow(case.sport, case.outcome, "fail", str(exc)))
        except BasketValidationError as exc:
            detail = str(exc)
            unavailable = "UNAVAILABLE" in detail.upper() or "NO CURRENT EVENT" in detail.upper()
            rows.append(MatrixRow(
                case.sport, case.outcome,
                "unavailable" if unavailable else "fail",
                detail,
            ))
        except Exception as exc:  # diagnostic runner must preserve the remaining cases
            rows.append(MatrixRow(case.sport, case.outcome, "fail", str(exc)))
        else:
            rows.append(MatrixRow(case.sport, case.outcome, "pass", str(receipt.status)))
    return MatrixReport(tuple(rows))
