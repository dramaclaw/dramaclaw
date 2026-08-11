"""Request-scoped, secret-free identity for egress adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

TRUSTED_EGRESS_CONTEXT_KEY = "__trusted_egress_context"


class TrustedRunnerEnvelope(dict[str, Any]):
    """Internal runner envelope constructed by the verified task core."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class TrustedEgressContext:
    """Identity copied only from a verified task delivery by the task core."""

    envelope_id: str
    project_id: str
    task_type: str
    requester_user_id: str
    root_task_id: str
    admission_id: str
    admitted_at: str
    membership_id: str | None
    authz_version: int
    billing_principal: BillingPrincipal
    credential: CredentialReference

    def __post_init__(self) -> None:
        for field_name in (
            "envelope_id",
            "project_id",
            "task_type",
            "requester_user_id",
            "root_task_id",
            "admission_id",
        ):
            value = getattr(self, field_name)
            if type(value) is not str or not value:
                raise ValueError(f"{field_name} is required")
        if type(self.admitted_at) is not str:
            raise TypeError("admitted_at must be a string")
        if not self.admitted_at:
            raise ValueError("admitted_at is required")
        if self.membership_id is not None and (
            type(self.membership_id) is not str or not self.membership_id
        ):
            raise ValueError("membership_id must be a non-empty string or None")
        if type(self.authz_version) is not int or self.authz_version < 1:
            raise ValueError("authz_version must be positive")
        if type(self.billing_principal) is not BillingPrincipal:
            raise TypeError("billing_principal must be a BillingPrincipal")
        if type(self.credential) is not CredentialReference:
            raise TypeError("credential must be a CredentialReference")

    @property
    def is_organization(self) -> bool:
        return self.billing_principal.kind == "organization"


def ambient_egress_context() -> TrustedEgressContext | None:
    """本次请求作用域上绑定的身份，供调用点漏传 `egress_context=` 时兜底。

    出网闸门通过可选参数携带身份，于是「平台任务，允许」和「调用点忘了穿参数」
    被压成同一个 `None`，闸门无法区分——组织流量因此拿平台凭据直连上游、记到
    平台账上，正是这套闸门要防的事。任务派发点（`task_backend/run_core.py`）
    已把身份绑定在请求作用域上，闸门在 kwargs 无上下文时回落到这里即可区分。

    只在 kwargs 无上下文时才回落；显式传入的仍然优先，语义不变。CLI 等非任务
    路径本就没有绑定，这里返回 `None`，调用点各自决定是放行还是拒绝。

    导入必须惰性：`model_gateway_runtime` 在模块级导入本模块。
    """

    from novelvideo.model_gateway_runtime import current_model_gateway_context

    return current_model_gateway_context()


def ambient_organization_egress_context() -> TrustedEgressContext | None:
    """同上，但只在作用域身份是**组织**时回落，否则仍返回 `None`。

    多数闸门只分「组织 / 其余」两支，平台身份在那里与 `None` 同义；但有几处
    把「有身份且非组织」当作错误（如 `generators/indextts2_fal.py` 的 `generate`
    在 `self.egress_context` 非组织时直接判 `ORG_EGRESS_DENIED`）。若回落把平台
    身份塞进去，平台流量会被自己的组织闸门拒掉——修 fail-open 反倒修出 fail-closed
    的误伤。回落只补组织这一支，平台与个人路径逐字不变。
    """

    context = ambient_egress_context()
    if context is not None and context.is_organization:
        return context
    return None
