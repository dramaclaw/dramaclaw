"""Produce and bind trusted egress identity on the HTTP／WS request path.

`_MODEL_GATEWAY_CONTEXT`（`model_gateway_runtime.py:30-33`）是全系统唯一的
「当前出网请求属于谁」的载体，而它的全部生产 set 点都在 worker 侧
（`task_backend/run_core.py:710`、5 个 runner、`freezone/text_node.py`）。
请求路径上一个都没有，于是出网闸门读到 `None` 并当作「平台身份，放行」——
组织用户从 chat／freezone 发起的模型调用因此由平台的 Key 垫付真实算力。

本模块只补那个缺失的基础设施：在请求进程里就地产生可信身份、并把它绑上
ContextVar。它**不接任何路由**；接线是 OI-54 族 S1／S2／S4／S5 的事。

信任链：身份**只能**来自 `get_authz_port().admit_model_task`
（抽象 `ports/authz.py:191`；EE 侧 authz port 实现走 PG
`product_admit_model_task`；CE 单机降级 `ports/local/__init__.py:64-79` 产
`kind="local"`）。这里不另发明身份解析——第二条信任链就是第二个漏洞面。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator
from uuid import uuid4

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import AdmissionContext, AuthzError


async def build_request_egress_context(
    *,
    requester_user_id: str,
    project_id: str,
    task_type: str,
) -> TrustedEgressContext | None:
    """Return this request's organization identity, or `None` if it has none.

    三个入参全部由调用方显式传：工厂内不猜、不解析、不回落。

    返回 `None` 的语义**有且只有一个**：本请求不是组织身份（平台／个人／CE
    local／灰度未开）。它绝不表示「出错了」——出错一律上抛。给 `None` 增加
    第二种语义，就是把 OI-48 那个 fail-open 原样再造一遍。
    """

    # 端口在函数体内惰性取，照 `generators/video_generator.py:2733` 的先例：
    # 进程启动顺序与 bootstrap 无关，且调用点可被独立替换。
    from novelvideo.ports import get_authz_port

    # 先生成一次性 id 再喂给 admit_model_task，照 `ports/local/tasks.py:139-150`
    # 的既定形状（那里先有 `state.task_id` 才调 `sign_top_level`）。
    root_task_id = uuid4().hex

    # 照抄 `task_backend/producer.py:124-141`：在 except 块内只记 `exc.code`，
    # 退出 except 块之后才 raise ... from None。`from None` 是刻意断异常链——
    # EE `authz/admission_repository.py:53-54` 把任何 PostgresError 映射成
    # ORG_AUTHZ_STALE，原始 PG 错误文本会挂在异常上下文里随之外泄。
    authz_error_code: str | None = None
    admission: AdmissionContext | None = None
    try:
        admission = await get_authz_port().admit_model_task(
            user_id=requester_user_id,
            root_task_id=root_task_id,
        )
    except AuthzError as exc:
        authz_error_code = exc.code
        admission = None
    if authz_error_code is not None:
        # 分支 1：灰度关＝平台语义，路径逐字节不变。
        # `ST_P0_GRAY_ENABLED` 缺省关时 `admit_model_task` 首句 require_enabled()
        # 就抛这个码（EE 侧 authz port 实现与其灰度开关配置）。
        if authz_error_code == "P0_GRAY_DISABLED":
            return None
        # 分支 2：其余任何 AuthzError 原样上抛，fail-closed。
        #
        # 不得压成 `None`。EE `0038:405-449` 的**平台分支就有四个拒绝出口**
        # （user_missing／membership_changed／user_inactive／entitlement_mismatch），
        # 「平台用户不会被拒」是错的；压成 None 会把真拒绝读成「非组织，放行」。
        # ORG_AUTHZ_STALE 上抛确实会波及平台用户，但这已经是今天的生产语义：
        # `producer.sign_top_level` 对所有用户在同样情形下就是这么抛的。
        raise AuthzError(authz_error_code) from None

    # 非 AuthzError 的异常不在这里兜。producer 那里把它们转成 `_invalid()`，
    # 是因为它必须交出一个信封；这里没有信封可交，让它原样上抛即 fail-closed。
    # 兜成 `None` 会给 `None` 添第二种语义，正是上面禁止的事。

    # 校验照 `run_core.py:210-218` 的形状。任一不符即抛，不返回 `None`。
    # 放在身份分支之前：对不上说明 authz 实现本身坏了，那时任何身份判读都不可信。
    # 复用既有词汇 ORG_AUTHZ_STALE，不新造错误码——同一形状的先例见
    # `generators/video_generator.py:2736-2747`（重新 admit 后字段对不上即判 stale）。
    if (
        admission.requester_user_id != requester_user_id
        or admission.root_task_id != root_task_id
    ):
        raise AuthzError("ORG_AUTHZ_STALE") from None

    # 分支 3：非组织身份 → None。平台／个人／CE local 路径逐字节不变。
    if admission.billing_principal.kind != "organization":
        return None

    # 字段映射逐字段照抄 `run_core.py:220-231`，不重新设计。
    # envelope_id 每请求唯一：下游 `egress_operations` 的 claim 靠它做重放保护，
    # 因此不得按连接或按会话复用（见 `model_gateway_runtime.py:164`）。
    return TrustedEgressContext(
        envelope_id=f"req-{root_task_id}",
        project_id=project_id,
        task_type=task_type,
        requester_user_id=requester_user_id,
        root_task_id=admission.root_task_id,
        admission_id=admission.admission_id,
        admitted_at=admission.admitted_at,
        membership_id=admission.membership_id,
        authz_version=admission.authz_version,
        billing_principal=admission.billing_principal,
        credential=admission.credential,
    )


@asynccontextmanager
async def request_egress_scope(
    *,
    requester_user_id: str,
    project_id: str,
    task_type: str,
) -> AsyncIterator[TrustedEgressContext | None]:
    """Bind this request's organization identity for the duration of the block.

    非组织身份下**什么都不绑**（ambient 保持 `None`）并 yield `None`，
    平台路径逐字节不变。
    """

    context = await build_request_egress_context(
        requester_user_id=requester_user_id,
        project_id=project_id,
        task_type=task_type,
    )
    if context is None:
        yield None
        return
    # `model_gateway_request_scope` 是**同步** `@contextmanager`
    # （`model_gateway_runtime.py:100-114`），所以这里是 `with` 而不是
    # `async with`。它的 finally 负责 reset ContextVar，作用域内抛异常时
    # 也不会泄漏。**不得**改用 `model_gateway_scope_for_runner`
    # （`:117-130`）——那个只收 `TrustedRunnerEnvelope`，是 worker 侧的入口。
    with model_gateway_request_scope(context):
        yield context
