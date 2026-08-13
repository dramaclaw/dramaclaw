"""C1 for the request-path trusted egress context factory (OI-54 S0).

这是**工厂层**单测，按交接 prompt §4 允许使用假 `AuthzPort`；链路层
（S1／S2／S4／S5）禁止 mock authz，那不在本片范围内。

本文件刻意**不出现** `model_gateway_request_scope`：绑定必须由产品代码完成，
测试只通过 `current_model_gateway_context()` 观察结果。测试自己绑上下文正是
OI-54 记录的假绿写法之一（EE `tests/b2b/test_p0g4k_grid_family_egress_integration.py:305`）。

假 port 一律**回显**调用方传入的 `user_id` / `root_task_id`，与两个真实实现一致：
EE 侧 authz port 实现的 `_context_from_facts(..., user_id=, root_task_id=)`、
CE `src/novelvideo/ports/local/__init__.py:67-79` 的 `LocalAuthz`。
只有 C1-9／C1-10 两条刻意打破回显，用来钉住校验分支。
"""

from __future__ import annotations

import pytest

from novelvideo import ports
from novelvideo.api.egress_binding import (
    build_request_egress_context,
    request_egress_scope,
)
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.local import LocalAuthz
from novelvideo.ports.model_credentials import CredentialReference

_USER_ID = "user-1"
_PROJECT_ID = "project-9"
_TASK_TYPE = "freezone_image_mark_detect"


def _admission(
    *,
    kind: str,
    user_id: str,
    root_task_id: str,
) -> AdmissionContext:
    organization = kind == "organization"
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-7" if organization else user_id,
        ),
        credential=CredentialReference(
            source="organization" if organization else kind,
            credential_id="credential-3",
            key_version=4,
            org_id="org-7" if organization else None,
        ),
        admission_id="admission-42",
        root_task_id=root_task_id,
        admitted_at="2026-08-13T02:03:04Z",
        membership_id="membership-5" if organization else None,
        authz_version=11,
    )


class _RecordingAuthz:
    """Echoes the caller's identity back, like both production implementations."""

    def __init__(self, *, kind: str = "organization") -> None:
        self.kind = kind
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        self.calls.append((user_id, root_task_id))
        return _admission(kind=self.kind, user_id=user_id, root_task_id=root_task_id)


class _RaisingAuthz:
    def __init__(self, code: str) -> None:
        self.code = code

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        # 模拟真实实现：底层错误在 except 块内被转成 AuthzError，
        # 于是 `__context__` 上挂着原始异常（EE `admission_repository.py:53-54`
        # 把任何 PostgresError 映射成 ORG_AUTHZ_STALE 就是这个形状）。
        try:
            raise RuntimeError("relation \"users\" does not exist -- raw pg detail")
        except RuntimeError as exc:
            raise AuthzError(self.code) from exc


class _MismatchingAuthz:
    """Returns an admission that disagrees with what was asked for."""

    def __init__(self, *, user_id: str | None = None, root_task_id: str | None = None):
        self._user_id = user_id
        self._root_task_id = root_task_id

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        return _admission(
            kind="organization",
            user_id=self._user_id or user_id,
            root_task_id=self._root_task_id or root_task_id,
        )


def _use(monkeypatch: pytest.MonkeyPatch, port: object) -> None:
    # 与 `tests/test_p0g4c_video_egress.py:803` 同一写法；被测模块按
    # `generators/video_generator.py:2733` 的先例在函数体内惰性取端口。
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


async def _build() -> TrustedEgressContext | None:
    return await build_request_egress_context(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    )


# --- C1-1 ------------------------------------------------------------------


async def test_c1_01_organization_admission_maps_every_field(monkeypatch):
    port = _RecordingAuthz(kind="organization")
    _use(monkeypatch, port)

    context = await _build()

    assert type(context) is TrustedEgressContext
    assert len(port.calls) == 1
    called_user_id, root_task_id = port.calls[0]
    assert called_user_id == _USER_ID
    admission = _admission(
        kind="organization", user_id=_USER_ID, root_task_id=root_task_id
    )
    # 11 个必填字段逐个对应（`egress_context.py:24-34` 的字段表）。
    assert context.envelope_id == f"req-{root_task_id}"
    assert context.project_id == _PROJECT_ID
    assert context.task_type == _TASK_TYPE
    assert context.requester_user_id == admission.requester_user_id
    assert context.root_task_id == admission.root_task_id
    assert context.admission_id == admission.admission_id
    assert context.admitted_at == admission.admitted_at
    assert context.membership_id == admission.membership_id
    assert context.authz_version == admission.authz_version
    assert context.billing_principal == admission.billing_principal
    assert context.credential == admission.credential
    assert context.is_organization is True


# --- C1-2 ------------------------------------------------------------------


async def test_c1_02_platform_admission_returns_none(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="platform"))

    assert await _build() is None


# --- C1-3 ------------------------------------------------------------------


async def test_c1_03_ce_local_admission_returns_none(monkeypatch):
    # 真的 CE 单机降级实现，不是手搓的假 port。
    _use(monkeypatch, LocalAuthz())

    assert await _build() is None


# --- C1-4 ------------------------------------------------------------------


async def test_c1_04_gray_disabled_returns_none(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("P0_GRAY_DISABLED"))

    assert await _build() is None


# --- C1-5 ------------------------------------------------------------------


async def test_c1_05_membership_inactive_is_raised(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "ORG_MEMBERSHIP_INACTIVE"


# --- C1-6 ------------------------------------------------------------------


async def test_c1_06_model_access_denied_is_raised_not_admitted(monkeypatch):
    # 压成 None 就是又造一个 OI-48 形状的 fail-open：真拒绝被读成「非组织，放行」。
    _use(monkeypatch, _RaisingAuthz("MODEL_ACCESS_DENIED"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "MODEL_ACCESS_DENIED"


# --- C1-7 ------------------------------------------------------------------


async def test_c1_07_authz_stale_is_raised_not_downgraded(monkeypatch):
    # 与 `task_backend/producer.py:137-138` 今天对所有用户的语义一致，不得「体贴地」降级。
    _use(monkeypatch, _RaisingAuthz("ORG_AUTHZ_STALE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    assert excinfo.value.code == "ORG_AUTHZ_STALE"


# --- C1-8 ------------------------------------------------------------------


async def test_c1_08_raised_authz_error_carries_no_exception_chain(monkeypatch):
    _use(monkeypatch, _RaisingAuthz("ORG_AUTHZ_STALE"))

    with pytest.raises(AuthzError) as excinfo:
        await _build()

    exc = excinfo.value
    # `__cause__` 单独不足以判别：在 except 块内 `raise AuthzError(code)`（无 from None）
    # 同样是 `__cause__ is None`，但原始 PG 错误文本会挂在 `__context__` 上随异常外泄。
    # 两条一起断言才真正钉住 `producer.py:137-138` 的「退出 except 块后 raise ... from None」。
    assert exc.__cause__ is None
    assert exc.__context__ is None
    assert exc.__suppress_context__ is True
    assert "does not exist" not in str(exc)


# --- C1-9 ------------------------------------------------------------------


async def test_c1_09_requester_mismatch_raises_instead_of_none(monkeypatch):
    _use(monkeypatch, _MismatchingAuthz(user_id="someone-else"))

    with pytest.raises(Exception) as excinfo:
        await _build()

    # `None` 的语义只有一个：非组织身份。它绝不表示「出错了」。
    assert excinfo.value is not None


# --- C1-10 -----------------------------------------------------------------


async def test_c1_10_root_task_id_mismatch_raises_instead_of_none(monkeypatch):
    _use(monkeypatch, _MismatchingAuthz(root_task_id="not-the-generated-id"))

    with pytest.raises(Exception) as excinfo:
        await _build()

    assert excinfo.value is not None


# --- C1-11 -----------------------------------------------------------------


async def test_c1_11_envelope_id_is_derived_and_unique_per_request(monkeypatch):
    port = _RecordingAuthz(kind="organization")
    _use(monkeypatch, port)

    first = await _build()
    second = await _build()

    assert first is not None and second is not None
    assert first.envelope_id == f"req-{first.root_task_id}"
    assert second.envelope_id == f"req-{second.root_task_id}"
    # 下游 `egress_operations` 的 claim 靠 envelope_id 做重放保护，
    # 因此不得按连接或按会话复用。
    assert first.envelope_id != second.envelope_id
    assert first.root_task_id != second.root_task_id
    assert len(port.calls) == 2


# --- C1-12 -----------------------------------------------------------------


async def test_c1_12_scope_binds_organization_identity_and_unbinds_on_exit(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="organization"))
    assert current_model_gateway_context() is None

    async with request_egress_scope(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    ) as context:
        assert type(context) is TrustedEgressContext
        assert current_model_gateway_context() is context

    assert current_model_gateway_context() is None

    # 平台路径必须逐字节不变：非组织身份下什么都不绑。
    _use(monkeypatch, _RecordingAuthz(kind="platform"))
    async with request_egress_scope(
        requester_user_id=_USER_ID,
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
    ) as platform_context:
        assert platform_context is None
        assert current_model_gateway_context() is None

    assert current_model_gateway_context() is None


# --- C1-13 -----------------------------------------------------------------


async def test_c1_13_scope_does_not_leak_context_var_on_exception(monkeypatch):
    _use(monkeypatch, _RecordingAuthz(kind="organization"))
    assert current_model_gateway_context() is None

    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with request_egress_scope(
            requester_user_id=_USER_ID,
            project_id=_PROJECT_ID,
            task_type=_TASK_TYPE,
        ) as context:
            # 必须断言「确实绑上了组织身份」，不能只写 `is context`：
            # 什么都不绑时 `None is None` 也成立，那样这条用例对不泄漏一事
            # 一行证据都提供不了（同义反复）。
            assert type(context) is TrustedEgressContext
            assert current_model_gateway_context() is context
            raise _Boom("caller blew up inside the scope")

    assert current_model_gateway_context() is None
