"""C1 for OI-54 S1: the mark-detect HTTP endpoint must bind its own egress identity.

`_MODEL_GATEWAY_CONTEXT`（`model_gateway_runtime.py:30-33`）的全部生产 set 点都在
worker 侧，于是同步 HTTP 端点 `freezone_mark_detect`（`api/routes/freezone.py:7517`）
在组织用户点击时：积分照扣，出网却读到 `None` 而整段跳过组织分支
（`freezone/presets.py:85-88`），真实算力落到平台的 Key 上。

本文件**从 HTTP 入口进**。现状的病恰恰是「单元绿、链路漏」——
`tests/test_p0_gray_execution_boundaries.py:89-220` 直接调底层函数并自造上下文，
证不到生产调用方是否给上下文。测试自己绑 `model_gateway_request_scope` 是 OI-54
记录的假绿写法，本文件刻意不出现它：绑定必须由产品代码完成。

**范围声明**：CE 单机不注册 `egress_operations` 端口
（`ports/local/__init__.py:130-146` 的 ports 元组里没有它），所以「`egress_operations`
真有一行」在本仓只能钉到端口边界——C1-02 用仓内既有的 `tests/support/egress_ledger.py`
替身断言 claim 确实发生并走到 COMPLETED。**真库落行的纵向由 EE `tests/b2b/` 补**。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo import ports
from novelvideo.egress_context import ambient_organization_egress_context
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.egress_operations import OperationState
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from novelvideo.task_backend.subprocesses import EgressBoundaryError
from support.egress_ledger import LedgerDouble

_USER_ID = "user-mark-7"
_PROJECT_ID = "project-mark-59"
_TASK_TYPE = "freezone_image_mark_detect"
_ROUTE = f"/api/v1/projects/{_PROJECT_ID}/freezone/marks/detect"

PLATFORM_KEY_CANARY = "PLATFORM_KEY_CANARY"
ORG_KEY_CANARY = "ORG_KEY_CANARY"
_PLATFORM_BASE_URL = "https://platform.canary.invalid/v1"
_ORG_BASE_URL = "https://org.canary.invalid/v1"

_MARK_JSON = '{"label":"老人","note":"主体人物"}'


# --- doubles ---------------------------------------------------------------


def _admission(*, kind: str, user_id: str, root_task_id: str) -> AdmissionContext:
    """Echoes the caller's identity back, like both production implementations
    (EE `authz/port.py:169`, CE `ports/local/__init__.py:67-79`)."""
    organization = kind == "organization"
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-mark-3" if organization else user_id,
        ),
        credential=CredentialReference(
            source="organization" if organization else kind,
            credential_id="credential-mark-1",
            key_version=4,
            org_id="org-mark-3" if organization else None,
        ),
        admission_id="admission-mark-42",
        root_task_id=root_task_id,
        admitted_at="2026-08-13T02:03:04Z",
        membership_id="membership-mark-5" if organization else None,
        authz_version=11,
    )


class _Authz:
    def __init__(self, *, kind: str = "organization") -> None:
        self.kind = kind
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append((user_id, root_task_id))
        return _admission(kind=self.kind, user_id=user_id, root_task_id=root_task_id)


class _RaisingAuthz:
    def __init__(self, code: str) -> None:
        self.code = code
        self.calls: list[tuple[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append((user_id, root_task_id))
        raise AuthzError(self.code)


class _OrgCredentials:
    """Stands in for the control-plane resolver: CE's `LocalModelCredentials`
    refuses any non-`local` credential source (`ports/local/__init__.py:36-39`)."""

    def __init__(self) -> None:
        self.admissions: list[AdmissionContext] = []

    async def resolve(self, admission) -> RequestCredential:
        self.admissions.append(admission)
        return RequestCredential(
            reference=admission.credential,
            api_key=ORG_KEY_CANARY,
            base_url=_ORG_BASE_URL,
        )


class _Meter:
    def __init__(self) -> None:
        self.reserve: list[dict] = []
        self.confirm: list[tuple] = []
        self.cancelled: list[str] = []
        self.set_context: list[tuple] = []
        self.clear_context: list[bool] = []

    async def reserve_feature_start_credits(self, **kwargs):
        self.reserve.append(kwargs)
        return {"id": "reservation_mark", "cost": 6}

    async def settle_feature_credit_reservation(self, reservation_id, *, action, **kw):
        self.confirm.append((reservation_id, action, kw))

    async def settle_cancelled_feature_credit_reservation(self, reservation_id, **kw):
        self.cancelled.append(reservation_id)

    def set_llm_usage_context(self, *args, **kwargs):
        self.set_context.append((args, kwargs))

    def clear_llm_usage_context(self):
        self.clear_context.append(True)


# --- harness ---------------------------------------------------------------


@pytest.fixture()
def harness(monkeypatch, tmp_path):
    """A real `create_app()` client wired to this project, plus the doubles.

    `create_app()` rather than a bare `FastAPI()`: §2.4 的翻译只有经过
    `app.py:210-232` 注册的 `AuthzError` handler 才渲染成契约信封，自己搭的 app
    会把那段产品行为一起换成测试自己的实现。
    """
    from novelvideo.api.app import create_app
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone as freezone_routes

    image_path = tmp_path / "mark.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    ctx = SimpleNamespace(
        project_id=_PROJECT_ID,
        requester_user_id=_USER_ID,
        requester_username="mark-login-name",
        owner_username="alice",
        project_name="demo",
        output_dir=str(tmp_path),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    meter = _Meter()
    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(
        freezone_routes, "_resolve_url_list", lambda *_a: [str(image_path)]
    )
    monkeypatch.setattr(freezone_routes, "get_usage_meter", lambda: meter)

    app = create_app()
    app.dependency_overrides[get_api_user] = lambda: {
        "id": _USER_ID,
        # 登录名与 user_id 刻意不同：出网工厂拿到 username 就是 OI-61 那条
        # 身份口径错配，C1-01 靠这个差别把它钉死。
        "username": "mark-login-name",
    }
    client = TestClient(app, raise_server_exceptions=False)

    return SimpleNamespace(
        client=client,
        ctx=ctx,
        meter=meter,
        image_path=image_path,
        routes=freezone_routes,
        monkeypatch=monkeypatch,
    )


def _use_authz(monkeypatch, port) -> None:
    # `egress_binding.py:46` 在函数体内惰性取端口，所以打模块属性即可。
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


def _post(harness, **overrides) -> tuple[int, dict]:
    body = {"source_url": "/static/mark.png", "point_x": 0.5, "point_y": 0.5}
    body.update(overrides)
    response = harness.client.post(_ROUTE, json=body)
    return response.status_code, response.json()


def _spy_detect(harness, observer):
    """Replace only the vision leaf, so the observer sees what it would have seen."""

    async def fake_detect(**_kwargs):
        observer.append(
            (ambient_organization_egress_context(), current_model_gateway_context())
        )
        return {
            "label": "老人",
            "note": "主体人物",
            "provider": "newapi",
            "model": "DC-freezone-vision-LLM",
        }

    harness.monkeypatch.setattr(harness.routes, "detect_freezone_mark", fake_detect)


def _raise_from_detect(harness, exc: BaseException):
    async def failing_detect(**_kwargs):
        raise exc

    harness.monkeypatch.setattr(harness.routes, "detect_freezone_mark", failing_detect)


# --- C1-01 -----------------------------------------------------------------


def test_c1_01_organization_identity_is_visible_inside_the_vision_leaf(harness):
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    observed: list[tuple] = []
    _spy_detect(harness, observed)

    status, payload = _post(harness)

    assert status == 200, payload
    assert len(observed) == 1
    ambient, raw = observed[0]
    # `presets.py:85-88` 读的就是这个 ambient 回落；今天它是 None，组织分支整段被跳过。
    assert ambient is not None
    assert ambient is raw
    assert ambient.is_organization is True
    assert ambient.project_id == harness.ctx.project_id
    assert ambient.requester_user_id == harness.ctx.requester_user_id
    assert ambient.task_type == _TASK_TYPE
    # 喂给 admit_model_task 的必须是 user_id，不是登录名（OI-61 的病）。
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert harness.ctx.requester_username != harness.ctx.requester_user_id


# --- C1-02 -----------------------------------------------------------------


def test_c1_02_organization_egress_uses_the_org_key_not_the_platform_key(
    harness, monkeypatch
):
    """canary 对照：真实 transport 拿到的必须是组织的 Key。

    这条**不 mock** `detect_freezone_mark`／`presets`／`nanobanana_grid`——只把
    最外层的网络调用（`Agent.run`）换掉，其余从路由到 transport 构造全跑真的。
    """
    from novelvideo import config
    from pydantic_ai import Agent

    _use_authz(monkeypatch, _Authz(kind="organization"))
    credentials = _OrgCredentials()
    ledger = LedgerDouble()
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credentials)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: ledger)
    # 平台侧的 Key：若组织分支被跳过，transport 就会拿到它。
    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda **_kwargs: (PLATFORM_KEY_CANARY, _PLATFORM_BASE_URL),
    )

    used: list[object] = []

    async def fake_run(self, *_args, **_kwargs):
        used.append(self.model)
        return SimpleNamespace(output=_MARK_JSON)

    monkeypatch.setattr(Agent, "run", fake_run)

    status, payload = _post(harness)

    assert status == 200, payload
    assert len(used) == 1
    model = used[0]
    # 组织分支被跳过时这里是平台的 `_RequestScopedGatewayModel`（无 `.client`），
    # 那样只会炸出 AttributeError，读不出「用了平台 Key」这件事——先断言形状。
    assert getattr(model, "client", None) is not None, (
        f"transport fell back to the platform gateway: {type(model).__name__}"
    )
    assert model.client.api_key == ORG_KEY_CANARY
    assert str(model.client.base_url).startswith(_ORG_BASE_URL)
    assert PLATFORM_KEY_CANARY not in str(model.client.api_key)
    assert PLATFORM_KEY_CANARY not in str(model.client.base_url)
    # 组织凭证是经 admission 解析出来的，不是测试硬塞的。
    assert len(credentials.admissions) == 1
    assert credentials.admissions[0].requester_user_id == _USER_ID

    # 出网必须留痕：claim 走到 COMPLETED。CE 无 `egress_operations` 端口实现，
    # 这里钉的是端口边界；真库落行由 EE `tests/b2b/` 纵向补。
    assert len(ledger.claims) == 1
    spec = ledger.claims[0]
    assert spec.capability == "freezone.vision.analyze"
    assert spec.organization_id == "org-mark-3"
    assert spec.project_id == _PROJECT_ID
    assert [row["state"] for row in ledger.rows.values()] == [OperationState.COMPLETED]


# --- C1-03 -----------------------------------------------------------------


def test_c1_03_platform_identity_path_is_unchanged(harness):
    """看门测试：非组织身份下什么都不绑，调用序列与改动前一致。"""
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    observed: list[tuple] = []
    _spy_detect(harness, observed)

    status, payload = _post(harness)

    assert status == 200, payload
    assert payload["ok"] is True
    assert len(observed) == 1
    assert observed[0] == (None, None)
    # 预留照发、口径一字不变（与 `test_freezone_mark_backend.py:152-169` 同一张表）。
    assert harness.meter.reserve == [
        {
            "user_id": _USER_ID,
            "feature_key": "freezone.image_mark_detect",
            "product_surface": "freezone",
            "project_id": _PROJECT_ID,
            "resource_kind": "image",
            "task_type": _TASK_TYPE,
            "metadata": {
                "source": "sync_api",
                "endpoint": "freezone_mark_detect",
                "selection": "point",
            },
            "params": {"operation": "point"},
            "require_price_rule": True,
            "require_positive_cost": True,
        }
    ]
    assert [call[1] for call in harness.meter.confirm] == ["confirm"]
    assert harness.meter.cancelled == []
    assert harness.meter.clear_context == [True]


# --- C1-04 -----------------------------------------------------------------


def test_c1_04_scope_does_not_leak_into_later_requests(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    observed: list[tuple] = []
    _spy_detect(harness, observed)
    assert current_model_gateway_context() is None

    assert _post(harness)[0] == 200

    assert observed[0][0] is not None
    assert current_model_gateway_context() is None
    assert ambient_organization_egress_context() is None

    # 第二次请求拿到的是新 envelope，不是上一次残留的那个。
    assert _post(harness)[0] == 200
    assert observed[1][0] is not None
    assert observed[1][0].envelope_id != observed[0][0].envelope_id
    assert current_model_gateway_context() is None


# --- C1-05 -----------------------------------------------------------------


def test_c1_05_denial_happens_before_the_credit_reservation(harness):
    """§2.2 的顺序证明：拒绝时不得留下一笔已扣未退的预留。"""
    authz = _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE")
    _use_authz(harness.monkeypatch, authz)
    observed: list[tuple] = []
    _spy_detect(harness, observed)

    status, payload = _post(harness)

    assert status == 403, payload
    assert payload["ok"] is False
    assert payload["data"]["error_code"] == "ORG_MEMBERSHIP_INACTIVE"
    assert len(authz.calls) == 1
    assert harness.meter.reserve == []
    assert harness.meter.cancelled == []
    assert harness.meter.confirm == []
    assert observed == []


# --- C1-06 -----------------------------------------------------------------


def test_c1_06_gray_disabled_behaves_like_the_platform_path(harness):
    _use_authz(harness.monkeypatch, _RaisingAuthz("P0_GRAY_DISABLED"))
    observed: list[tuple] = []
    _spy_detect(harness, observed)

    status, payload = _post(harness)

    assert status == 200, payload
    assert payload["ok"] is True
    assert observed[0] == (None, None)
    assert len(harness.meter.reserve) == 1
    assert [call[1] for call in harness.meter.confirm] == ["confirm"]


# --- C1-07 -----------------------------------------------------------------


def test_c1_07_egress_boundary_denial_renders_as_the_contracted_4xx(harness):
    """`EgressBoundaryError` 是 `RuntimeError` 子类，原来被吞成裸 500。"""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _raise_from_detect(harness, EgressBoundaryError("ORG_EGRESS_DENIED"))

    status, payload = _post(harness)

    # `ORG_EGRESS_DENIED` 不在 `AUTHZ_ERROR_HTTP_STATUS` 表内，
    # 按设计回落 403（`ports/authz.py:47`）。
    assert status == 403, payload
    assert payload["ok"] is False
    assert payload["data"]["error_code"] == "ORG_EGRESS_DENIED"
    # 拒绝时预留照样退还，退款逻辑必须跑在翻译之前。
    assert harness.meter.cancelled == ["reservation_mark"]
    assert harness.meter.confirm == []
    assert harness.meter.clear_context == [True]


# --- C1-08 -----------------------------------------------------------------


def test_c1_08_authz_denial_from_the_leaf_keeps_its_contracted_status(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _raise_from_detect(harness, AuthzError("ORG_CREDENTIAL_MISSING"))

    status, payload = _post(harness)

    assert status == 409, payload
    assert payload["data"]["error_code"] == "ORG_CREDENTIAL_MISSING"
    assert harness.meter.cancelled == ["reservation_mark"]


# --- C1-09 -----------------------------------------------------------------


def test_c1_09_unrelated_failures_still_answer_500(harness):
    """负向看门：§2.4 只翻译组织拒绝，不得把不相干的错误也改掉。"""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _raise_from_detect(harness, RuntimeError("boom"))

    status, payload = _post(harness)

    assert status == 500, payload
    assert "mark detect failed" in str(payload)
    assert "boom" in str(payload)
    assert harness.meter.cancelled == ["reservation_mark"]


def test_c1_09b_platform_path_unrelated_failure_is_unchanged(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    _raise_from_detect(harness, RuntimeError("vision unavailable"))

    status, payload = _post(harness)

    assert status == 500, payload
    assert "mark detect failed" in str(payload)
    assert harness.meter.cancelled == ["reservation_mark"]


# --- guard: the fixture must not be silently resolving a different route ----


def test_route_and_image_fixture_are_wired(harness):
    assert Path(harness.image_path).exists()
    assert harness.client.app.openapi()["paths"].get(
        "/api/v1/projects/{project}/freezone/marks/detect"
    )
