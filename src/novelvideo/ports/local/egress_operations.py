"""In-memory egress-operation ledger for standalone CE."""

from __future__ import annotations

import asyncio
from uuid import uuid4

from novelvideo.ports.egress_operations import (
    EgressOperationError,
    OperationClaimResult,
    OperationSnapshot,
    OperationSpec,
    OperationState,
)


class LocalEgressOperations:
    """Process-local implementation of the common egress operation protocol."""

    def __init__(self) -> None:
        self._rows: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult:
        async with self._lock:
            row = self._rows.get(spec.operation_key)
            if row is None:
                row = {
                    "operation_id": f"local-{uuid4().hex}",
                    "request_digest": spec.request_digest,
                    "state": OperationState.DISPATCHING,
                    "version": 1,
                    "token": uuid4().hex,
                }
                self._rows[spec.operation_key] = row
                return OperationClaimResult(
                    won=True,
                    operation=self._snapshot(spec.operation_key, row),
                    transition_token=row["token"],
                )
            if row["request_digest"] != spec.request_digest:
                raise EgressOperationError("EGRESS_OPERATION_CONFLICT")
            return OperationClaimResult(
                won=False, operation=self._snapshot(spec.operation_key, row)
            )

    async def mark_rejected_before_submit(self, **kwargs) -> OperationSnapshot:
        return await self._transition(OperationState.REJECTED_BEFORE_SUBMIT, kwargs)

    async def mark_accepted(self, **kwargs) -> OperationSnapshot:
        return await self._transition(OperationState.ACCEPTED, kwargs)

    async def mark_completed(self, **kwargs) -> OperationSnapshot:
        return await self._transition(OperationState.COMPLETED, kwargs)

    async def mark_unknown(self, **kwargs) -> OperationSnapshot:
        return await self._transition(OperationState.UNKNOWN, kwargs)

    @staticmethod
    def _snapshot(key: str, row: dict) -> OperationSnapshot:
        return OperationSnapshot(
            operation_id=row["operation_id"],
            operation_key=key,
            state=row["state"],
            version=row["version"],
        )

    async def _transition(self, target: OperationState, kwargs: dict) -> OperationSnapshot:
        async with self._lock:
            for key, row in self._rows.items():
                if row["operation_id"] != kwargs["operation_id"]:
                    continue
                allowed = {
                    OperationState.REJECTED_BEFORE_SUBMIT: {OperationState.DISPATCHING},
                    OperationState.ACCEPTED: {OperationState.DISPATCHING},
                    OperationState.COMPLETED: {OperationState.ACCEPTED},
                    OperationState.UNKNOWN: {
                        OperationState.DISPATCHING,
                        OperationState.ACCEPTED,
                    },
                }
                if (
                    row["token"] != kwargs["transition_token"]
                    or row["version"] != kwargs["expected_version"]
                    or row["state"] not in allowed[target]
                ):
                    raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
                row["state"] = target
                row["version"] += 1
                return self._snapshot(key, row)
            raise EgressOperationError("EGRESS_OPERATION_NOT_FOUND")
