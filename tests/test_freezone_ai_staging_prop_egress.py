"""C1 for OI-54 S2: request-path egress identity on freezone/ai-staging-prop.

从 HTTP 入口进（`create_app()` + `TestClient`），**不**直接调 `_run_ai_staging_prop`
或底层闸门——现状的病正是「单元绿、链路漏」：`tests/test_p0_gray_execution_boundaries.py:509`
的 EG-17 单测早就绿着，因为它手工把 `egress_context=` 喂给 `generate_ai_staging_prop`；
而 HTTP 请求路径从不绑定 ambient context，于是
`task_backend/subprocesses.py:122-128` 的闸门永远读到 `None`、永远放行。

关于假 `AuthzPort`：CE 单机的真实现 `LocalAuthz`（`ports/local/__init__.py:63-78`）
只会产 `kind="local"`，**不可能**产 organization 身份，所以组织分支在 CE 内除了替换
authz 端口之外没有别的到达方式。替换点与 S0 的 `tests/test_request_egress_binding.py:113`、
`tests/test_p0g4c_video_egress.py:803` 是同一个 seam，且被替换的只有**身份来源**：
`request_egress_scope`、`require_direct_model_egress_allowed` 闸门、
`asyncio.to_thread` 的 contextvar 复制、app 级 `AuthzError` handler 全部是真的。
组织身份走真库真密文的纵向由 EE 侧覆盖。

本文件刻意**不出现** `model_gateway_request_scope`：绑定必须由产品代码完成，测试只
通过 `current_model_gateway_context()` 观察结果（测试自己绑上下文正是 OI-54 记录的
假绿写法）。
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from novelvideo import ports
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

_USER_ID = "u-alice"
_PROJECT_ID = "proj_demo"
_ENDPOINT = f"/api/v1/projects/{_PROJECT_ID}/freezone/ai-staging-prop"
_TASK_TYPE = "freezone_ai_staging_prop"


# --- 假 authz 端口（只替换身份来源，见模块 docstring） -----------------------


def _admission(*, kind: str, user_id: str, root_task_id: str) -> AdmissionContext:
    """回显调用方传入的 id，与两个真实实现一致（EE port.py:169、CE LocalAuthz）。"""
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


class _StubAuthz:
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
        raise AuthzError(self.code)


def _use_authz(monkeypatch: pytest.MonkeyPatch, port: object) -> None:
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


# --- HTTP 夹具 --------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch) -> dict[str, int]:
    """兜底：本文件任何测试都不得真的出网。

    RED 阶段实测（修复前）：C1-02 的**组织身份**请求真的打到了 NewAPI 网关并拿回
    `status_code: 401 ... new_api_error` —— 那是 fail-open 的实证，同时也意味着一次
    回归就会让 CI 发出真实的、按量计费的调用。这里做进程级拦截。

    它**不替代** C1-04 的断言：C1-04 读的就是这里的计数器。`TestClient` 自己走
    `ASGITransport`，不受影响。
    """
    counters = {"transport": 0}

    def blocked(*_args, **_kwargs):
        counters["transport"] += 1
        raise RuntimeError("test attempted real network egress")

    async def blocked_async(*_args, **_kwargs):
        counters["transport"] += 1
        raise RuntimeError("test attempted real network egress")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked_async)
    return counters


@pytest.fixture()
def client(monkeypatch, tmp_path) -> TestClient:
    """真 `create_app()`：app 级 `AuthzError` handler（app.py:210-233）必须在链路里。"""
    from novelvideo.api.app import create_app
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id=_PROJECT_ID,
        requester_user_id=_USER_ID,
        owner_username="alice",
        project_name="demo",
        output_dir=str(project_dir),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)

    app = create_app()
    app.dependency_overrides[get_api_user] = lambda: {
        "id": _USER_ID,
        "username": "alice",
    }
    return TestClient(app, raise_server_exceptions=False)


def _probe(monkeypatch, *, result: dict | None = None) -> dict:
    """替换 `generate_ai_staging_prop`，在**线程内侧**记下 ambient context。"""
    from novelvideo.api.routes import freezone

    seen: dict[str, object] = {"calls": 0, "context": "<never called>", "request": None}

    def probe(request: dict[str, object]) -> dict[str, object]:
        seen["calls"] = int(seen["calls"]) + 1
        seen["context"] = current_model_gateway_context()
        seen["request"] = dict(request)
        return result if result is not None else {"ok": True, "prop": {"id": "p1"}}

    monkeypatch.setattr(freezone, "generate_ai_staging_prop", probe)
    return seen


# --- C1-01 ------------------------------------------------------------------


def test_c1_01_organization_identity_crosses_to_thread(client, monkeypatch) -> None:
    """绑定必须穿过 `asyncio.to_thread`（freezone.py:4542-4543）到达出网侧。"""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))
    seen = _probe(monkeypatch)

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})

    assert seen["calls"] == 1, response.json()
    context = seen["context"]
    assert context is not None
    assert context.is_organization is True
    assert context.requester_user_id == _USER_ID
    assert context.project_id == _PROJECT_ID
    assert context.task_type == _TASK_TYPE


# --- C1-02 ------------------------------------------------------------------


def test_c1_02_organization_is_denied_with_contracted_code(client, monkeypatch) -> None:
    """真闸门 + 真 handler：组织身份下端点稳定拒绝，码是 ORG_EGRESS_DENIED。"""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 403, body
    assert body["ok"] is False
    assert body["data"]["error_code"] == "ORG_EGRESS_DENIED"


# --- C1-03 ------------------------------------------------------------------


def test_c1_03_denial_is_not_a_bare_502(client, monkeypatch) -> None:
    """钉住 §2.4：`EgressBoundaryError` 是 `RuntimeError` 子类，不得被压成裸 502。"""
    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code != 502, body
    assert "data" in body and "error_code" in body["data"], body


# --- C1-04 ------------------------------------------------------------------


def test_c1_04_denied_before_any_egress_side_effect(
    client, monkeypatch, no_real_network
) -> None:
    """`egress-inventory.md:17-23` 的 submit 前副作用契约：拒绝必须发生在提交前。"""
    from novelvideo.director_world import staging_prop_ai

    _use_authz(monkeypatch, _StubAuthz(kind="organization"))

    counters = {"agent": 0, "run": 0, "popen": 0}

    def count_agent(*_args, **_kwargs):
        counters["agent"] += 1
        raise AssertionError("provider client must not be created")

    async def count_run(*_args, **_kwargs):
        counters["run"] += 1
        raise AssertionError("model must not be invoked")

    def count_popen(*_args, **_kwargs):
        counters["popen"] += 1
        raise AssertionError("no subprocess on this path")

    monkeypatch.setattr(staging_prop_ai, "create_staging_prop_agent", count_agent)
    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", count_run)
    monkeypatch.setattr(subprocess, "Popen", count_popen)

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})

    assert response.status_code == 403, response.text
    assert counters == {"agent": 0, "run": 0, "popen": 0}
    assert no_real_network["transport"] == 0


# --- C1-05 ------------------------------------------------------------------


def test_c1_05_platform_path_is_unchanged(client, monkeypatch) -> None:
    """看门测试：平台身份下什么都不绑，端点行为逐字节不变。"""
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    seen = _probe(monkeypatch, result={"ok": True, "prop": {"id": "p1"}})

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 200, body
    assert seen["calls"] == 1
    assert seen["context"] is None
    assert body == {"ok": True, "data": {"ok": True, "prop": {"id": "p1"}}}


def test_c1_05b_platform_passes_the_real_gate(client, monkeypatch) -> None:
    """同上，但走**真的** `generate_ai_staging_prop`：真闸门必须放行平台身份。"""
    from novelvideo.director_world import staging_prop_ai

    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    monkeypatch.setenv("MODEL_API_KEY", "platform-key")
    monkeypatch.setenv("NEWAPI_API_KEY", "platform-key")

    async def fake_run(_request, **_kwargs):
        return {"name": "一匹马"}

    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", fake_run)

    response = client.post(
        _ENDPOINT, json={"user_hint": "让他骑马", "crosshair_target": {}}
    )
    body = response.json()

    assert response.status_code == 200, body
    assert body["ok"] is True
    assert body["data"]["ok"] is True


# --- C1-06 ------------------------------------------------------------------


def test_c1_06_gray_disabled_binds_nothing(client, monkeypatch) -> None:
    """灰度关＝平台语义（egress_binding.py:70-71）：不抛、不绑。"""
    _use_authz(monkeypatch, _RaisingAuthz("P0_GRAY_DISABLED"))
    seen = _probe(monkeypatch, result={"ok": True, "prop": {"id": "p1"}})

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 200, body
    assert seen["calls"] == 1
    assert seen["context"] is None
    assert body == {"ok": True, "data": {"ok": True, "prop": {"id": "p1"}}}


# --- C1-07 ------------------------------------------------------------------


def test_c1_07_real_authz_denial_propagates(client, monkeypatch) -> None:
    """身份解析阶段的拒绝上抛为契约化 403，且根本不进出网。"""
    from novelvideo.api.routes import freezone

    _use_authz(monkeypatch, _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE"))

    calls = {"n": 0}

    async def spy(request: dict[str, object]) -> dict[str, object]:
        calls["n"] += 1
        return {"ok": True}

    monkeypatch.setattr(freezone, "_run_ai_staging_prop", spy)

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 403, body
    assert body["data"]["error_code"] == "ORG_MEMBERSHIP_INACTIVE"
    assert calls["n"] == 0


# --- C1-08 （负向：不相干的错误不得被本切片改掉） ----------------------------


def test_c1_08_unrelated_runtime_error_still_502(client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    _use_authz(monkeypatch, _StubAuthz(kind="platform"))

    async def boom(_request: dict[str, object]) -> dict[str, object]:
        raise RuntimeError("boom")

    monkeypatch.setattr(freezone, "_run_ai_staging_prop", boom)

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 502, body
    assert "boom" in str(body.get("detail"))


# --- C1-09 （负向：`ok` 为假仍走原来的 502 分支） ----------------------------


def test_c1_09_not_ok_result_still_502(client, monkeypatch) -> None:
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    _probe(monkeypatch, result={"ok": False, "error": "nope"})

    response = client.post(_ENDPOINT, json={"user_hint": "一匹马"})
    body = response.json()

    assert response.status_code == 502, body
    assert "nope" in str(body.get("detail"))


# --- C1-10 （负向：凭证剥离防线未被本切片碰坏） ------------------------------


def test_c1_10_credentials_are_still_stripped(client, monkeypatch) -> None:
    """freezone.py:4553-4558 的「never accept credentials from an HTTP payload」。"""
    _use_authz(monkeypatch, _StubAuthz(kind="platform"))
    seen = _probe(monkeypatch)

    response = client.post(
        _ENDPOINT,
        json={
            "api_key": "attacker-key",
            "base_url": "http://attacker.test/v1",
            "user_hint": "一匹马",
        },
    )

    assert response.status_code == 200, response.json()
    forwarded = seen["request"]
    assert forwarded is not None
    assert "api_key" not in forwarded
    assert "base_url" not in forwarded
    assert forwarded["user_hint"] == "一匹马"
