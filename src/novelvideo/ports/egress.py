"""Persistent egress claim contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class EgressOperationSpec:
    operation_id: str
    workflow_version: str
    stable_step_path: str
    logical_sequence: int
    input_digest: str

    def __post_init__(self) -> None:
        if not self.operation_id:
            raise ValueError("operation_id is required")
        if not self.workflow_version:
            raise ValueError("workflow_version is required")
        if not self.stable_step_path:
            raise ValueError("stable_step_path is required")
        if self.logical_sequence < 0:
            raise ValueError("logical_sequence cannot be negative")
        if not self.input_digest:
            raise ValueError("input_digest is required")


@dataclass(frozen=True)
class EgressClaim:
    operation_id: str
    attempt_id: str
    status: str
    claim_deadline: str


@dataclass(frozen=True)
class EgressResultReference:
    operation_id: str
    result_ref: str
    gateway_request_id: str | None = None


class EgressPort(Protocol):
    async def claim(self, *, admission, spec: EgressOperationSpec) -> EgressClaim: ...

    async def record_success(
        self,
        *,
        claim: EgressClaim,
        result: EgressResultReference,
    ) -> None: ...
