"""Minimal durable egress operation contracts."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

_ERROR_MESSAGES = {
    "EGRESS_OPERATION_CONFLICT": "egress operation conflicts with an existing claim",
    "EGRESS_OPERATION_INVALID_TRANSITION": "egress operation transition is invalid",
}


def _require_non_empty_string(value: Any, field_name: str) -> None:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string")
    if not value.strip():
        raise ValueError(f"{field_name} is required")


def _validate_json_value(value: Any) -> None:
    if value is None or type(value) in {str, bool, int}:
        return
    if type(value) is float:
        if math.isfinite(value):
            return
        raise ValueError("request must be canonical JSON")
    if type(value) is list:
        for item in value:
            _validate_json_value(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("request must be canonical JSON")
            _validate_json_value(item)
        return
    raise ValueError("request must be canonical JSON")


def _canonical_json(value: Any) -> bytes:
    _validate_json_value(value)
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError):
        raise ValueError("request must be canonical JSON") from None
    return encoded.encode("utf-8")


def canonical_request_digest(request: Any) -> str:
    """Return a deterministic SHA-256 digest for an exact JSON request."""

    return hashlib.sha256(_canonical_json(request)).hexdigest()


class OperationState(str, Enum):
    DISPATCHING = "dispatching"
    REJECTED_BEFORE_SUBMIT = "rejected_before_submit"
    ACCEPTED = "accepted"
    COMPLETED = "completed"
    UNKNOWN = "unknown"


class HandleKind(str, Enum):
    """一次出网操作**能拿到什么样的句柄**——由调用方在 claim 时声明。

    这是判别式：终态里 `provider_job_id` / `result_ref` 各自允许什么形状，由类别
    决定，DB 侧的 `egress_operations_output_check` 照此判。原先只有一条「非空」
    检查，占位串就能满足它，等于没有保证。
    """

    PROVIDER_JOB = "provider_job"
    """有上游异步作业：accepted 起就必须留下上游作业号，completed 还要有结果引用。"""

    LOCAL_RESULT = "local_result"
    """没有上游作业，但有真实结果引用（如同步音频落盘的路径）。"""

    NONE = "none"
    """纯服务内部副作用：两列都没有真值可填，于是要求两列都是 NULL。"""


class EgressOperationError(RuntimeError):
    """Stable operation failure without database or provider details."""

    def __init__(self, code: str, _unsafe_detail: str | None = None) -> None:
        if code not in _ERROR_MESSAGES:
            raise ValueError("unsupported egress operation error")
        super().__init__(_ERROR_MESSAGES[code])
        self.code = code


@dataclass(frozen=True)
class OperationSpec:
    organization_id: str
    project_id: str
    root_task_id: str
    business_task_id: str
    capability: str
    credential_id: str
    credential_version: int
    request_digest: str
    # 必填、无默认值：给默认值就把「我声明它没有句柄」和「我忘了写」压回同一个
    # 值，新约束会重新退化成 OI-49 那种「读上去像保证」的东西。
    handle_kind: HandleKind

    def __post_init__(self) -> None:
        for field_name in (
            "organization_id",
            "project_id",
            "root_task_id",
            "business_task_id",
            "capability",
            "credential_id",
            "request_digest",
        ):
            _require_non_empty_string(getattr(self, field_name), field_name)
        if type(self.credential_version) is not int:
            raise TypeError("credential_version must be a positive integer")
        if self.credential_version < 1:
            raise ValueError("credential_version must be positive")
        if type(self.handle_kind) is not HandleKind:
            raise TypeError("handle_kind must be a HandleKind")

    @property
    def operation_key(self) -> str:
        # handle_kind 刻意**不在**身份里：它描述的是这次操作留什么句柄，不是它
        # 是哪一次操作。放进来会让存量行的 replay 整体失配。
        identity = {
            "organization_id": self.organization_id,
            "project_id": self.project_id,
            "root_task_id": self.root_task_id,
            "business_task_id": self.business_task_id,
            "capability": self.capability,
        }
        return hashlib.sha256(_canonical_json(identity)).hexdigest()


@dataclass(frozen=True)
class OperationSnapshot:
    operation_id: str
    operation_key: str
    state: OperationState
    version: int

    def __post_init__(self) -> None:
        _require_non_empty_string(self.operation_id, "operation_id")
        _require_non_empty_string(self.operation_key, "operation_key")
        if type(self.state) is not OperationState:
            raise TypeError("state must be an OperationState")
        if type(self.version) is not int or self.version < 1:
            raise ValueError("version must be positive")


@dataclass(frozen=True)
class OperationClaimResult:
    won: bool
    operation: OperationSnapshot
    transition_token: str | None = None

    def __post_init__(self) -> None:
        if type(self.won) is not bool:
            raise TypeError("won must be a boolean")
        if type(self.operation) is not OperationSnapshot:
            raise TypeError("operation must be an OperationSnapshot")
        if self.won:
            _require_non_empty_string(self.transition_token, "transition_token")
        elif self.transition_token is not None:
            raise ValueError("existing operations cannot expose transition_token")


class EgressOperationPort(Protocol):
    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult: ...

    async def mark_rejected_before_submit(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
    ) -> OperationSnapshot: ...

    async def mark_accepted(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
        # None 不是「忘了传」：类别写在行上，DB 是权威，`local_result` 与 `none`
        # 本来就没有上游作业号可填。这与 OI-48 谴责的「用可选参数当身份载体」不是
        # 一回事——那里 None 意味着信息丢失，这里 None 是一个被约束校验的声明。
        provider_job_id: str | None,
    ) -> OperationSnapshot: ...

    async def mark_completed(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
        result_ref: str | None,
    ) -> OperationSnapshot: ...

    async def mark_unknown(
        self,
        *,
        operation_id: str,
        transition_token: str,
        expected_version: int,
    ) -> OperationSnapshot: ...
