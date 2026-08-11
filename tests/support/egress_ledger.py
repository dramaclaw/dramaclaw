"""Key-addressed stand-in for the durable egress operation authority.

The ledger keys an operation by {org, project, root_task, business_task,
capability} and deliberately leaves request_digest out, so that the same key
arriving with a different payload is reported as a conflict rather than
silently becoming a second operation. A caller therefore owes the ledger one
key per side effect.

This double models the claim verdict an EgressOperationPort implementation is
required to return, rather than a fixed verdict, because a stateless double
cannot express the very behaviour the ledger exists to provide.
"""

from __future__ import annotations

import asyncio

from novelvideo.ports.egress_operations import (
    EgressOperationError,
    OperationClaimResult,
    OperationSnapshot,
    OperationSpec,
    OperationState,
)


# `0039_p0_gray_egress_operations.py:296-318` 的 SECURITY DEFINER 函数所判的前置态，
# 逐条照抄。替身不建这台状态机，服务路径里「从 dispatching 直接 completed」这种在真
# 库上必抛 P0001 的写法在测试里就永远看不见——OI-49 正是这么活下来的。
TRANSITION_ALLOWED_FROM: dict[OperationState, frozenset[OperationState]] = {
    OperationState.ACCEPTED: frozenset({OperationState.DISPATCHING}),
    OperationState.COMPLETED: frozenset({OperationState.ACCEPTED}),
    OperationState.REJECTED_BEFORE_SUBMIT: frozenset({OperationState.DISPATCHING}),
    OperationState.UNKNOWN: frozenset(
        {OperationState.DISPATCHING, OperationState.ACCEPTED}
    ),
}


def assert_transition_allowed(
    *,
    current: OperationState,
    target: OperationState,
    expected_version: int,
    row_version: int,
) -> None:
    """真 definer 的判据：前置态与乐观锁版本。不合就是 INVALID_TRANSITION。"""

    if current not in TRANSITION_ALLOWED_FROM[target]:
        raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
    if expected_version != row_version:
        raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")


class LedgerDouble:
    """First claim on a key inserts and wins; a later claim on the same key
    replays when the request digest matches and raises
    EGRESS_OPERATION_CONFLICT when it does not.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.claims: list[OperationSpec] = []

    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult:
        self.claims.append(spec)
        # The round trip is the only await. The get-or-insert below must stay
        # await-free: in production it is one atomic INSERT ... ON CONFLICT.
        await asyncio.sleep(0)
        key = spec.operation_key
        existing = self.rows.get(key)
        if existing is None:
            row = {
                "operation_id": f"op-{len(self.rows) + 1}",
                "request_digest": spec.request_digest,
                "state": OperationState.DISPATCHING,
                "version": 1,
                "transition_token": f"token-{len(self.rows) + 1}",
            }
            self.rows[key] = row
            return OperationClaimResult(
                won=True,
                operation=OperationSnapshot(
                    operation_id=row["operation_id"],
                    operation_key=key,
                    state=row["state"],
                    version=row["version"],
                ),
                transition_token=row["transition_token"],
            )
        if existing["request_digest"] != spec.request_digest:
            raise EgressOperationError("EGRESS_OPERATION_CONFLICT")
        return OperationClaimResult(
            won=False,
            operation=OperationSnapshot(
                operation_id=existing["operation_id"],
                operation_key=key,
                state=existing["state"],
                version=existing["version"],
            ),
            transition_token=None,
        )

    def _transition(self, kwargs, state: OperationState) -> OperationSnapshot:
        for key, row in self.rows.items():
            if row["operation_id"] == kwargs["operation_id"]:
                assert_transition_allowed(
                    current=row["state"],
                    target=state,
                    expected_version=kwargs["expected_version"],
                    row_version=row["version"],
                )
                row["state"] = state
                row["version"] = kwargs["expected_version"] + 1
                return OperationSnapshot(
                    operation_id=row["operation_id"],
                    operation_key=key,
                    state=state,
                    version=row["version"],
                )
        raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")

    async def mark_rejected_before_submit(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.REJECTED_BEFORE_SUBMIT)

    async def mark_accepted(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.ACCEPTED)

    async def mark_completed(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.COMPLETED)

    async def mark_unknown(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.UNKNOWN)
