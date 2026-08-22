"""C1 for OI-54 S4 (OI-61): the chat WS project turn must bind its own egress identity.

`_MODEL_GATEWAY_CONTEXT`（`model_gateway_runtime.py:30-33`）的全部生产 set 点都在
worker 侧，请求路径上一个都没有。于是组织用户在 chat 里发一句话时，出网闸门读到
`None`，hermes 子进程拿到的是部署级 `NEWAPI_API_KEY`
（`hermes_pool.py:584` 的 `effective_gateway_credentials()`）——平台替组织垫真实算力。

`service.py:3588` 的组织分支 S3 就写好了，但今天永远进不去：没人传 `egress_context`。
本文件**从 `/api/v1/chat/ws` 入口进**，观察 hermes 子进程 env 里到底是谁的 Key。

**测试自己不绑上下文**：本文件刻意不出现 `model_gateway_request_scope` /
`build_request_egress_context`——绑定必须由产品代码完成，测试只观察结果。
那是 OI-54 登记在案的假绿写法。

**范围声明**：CE 单机不注册 `egress_operations` 端口
（`ports/local/__init__.py` 的 ports 元组里没有它），所以 C1-02 用仓内既有的
`tests/support/egress_ledger.py` 替身把 claim 钉到端口边界；真库落行的纵向由 EE
`tests/b2b/` 补。chat 路径没有成功侧状态迁移，所以只断言 claim，不断言终态。
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo import ports
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.auth_contract import AgentSessionToken
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from support.egress_ledger import LedgerDouble

pytestmark = pytest.mark.m08

# 登录名与 user_id 刻意不同：身份判定只认 user_id（C1-06 钉这条）。
_USERNAME = "alice"
_USER_ID = "user-id-9"
_PROJECT_ID = "project-chat-71"
_TASK_TYPE = "agent.hermes.text"

PLATFORM_KEY_CANARY = "PLATFORM_KEY_CANARY"
ORG_KEY_CANARY = "ORG_KEY_CANARY"
_PLATFORM_BASE_URL = "https://platform.canary.invalid/v1"
_ORG_BASE_URL = "https://org.canary.invalid/v1"


# --- doubles ---------------------------------------------------------------


def _admission(*, kind: str, user_id: str, root_task_id: str) -> AdmissionContext:
    """Echoes the caller's identity back, like both production implementations
    (EE `authz/port.py:169`, CE `ports/local/__init__.py:67-79`)."""
    organization = kind == "organization"
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-chat-3" if organization else user_id,
        ),
        credential=CredentialReference(
            source="organization" if organization else kind,
            credential_id="credential-chat-1",
            key_version=7,
            org_id="org-chat-3" if organization else None,
        ),
        admission_id="admission-chat-42",
        root_task_id=root_task_id,
        admitted_at="2026-08-13T02:03:04Z",
        membership_id="membership-chat-5" if organization else None,
        authz_version=13,
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
    refuses any non-`local` credential source."""

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
        self.calls: list[dict] = []

    async def require_feature_credit_balance(self, **kwargs):
        self.calls.append(kwargs)
        return None


class _FakeAuthSessions:
    def __init__(self) -> None:
        self.created = 0
        self.revoked: list[str] = []
        self.updated: list[tuple[str, dict]] = []

    async def create_agent_session(self, **kwargs) -> AgentSessionToken:
        self.created += 1
        return AgentSessionToken(
            value=f"token-{self.created}",
            session_id=f"agent-session-{self.created}",
            user=str(kwargs["username"]),
            scopes=tuple(kwargs["scopes"]),
            exp=int(time.time()) + 3600,
            worker_id=str(kwargs["worker_id"]),
            agent_kind=str(kwargs["agent_kind"]),
        )

    async def revoke_agent_session(self, raw_token: str) -> bool:
        self.revoked.append(raw_token)
        return True

    async def update_agent_session_scope(self, raw_token: str, **kwargs) -> bool:
        self.updated.append((raw_token, kwargs))
        return True


class _FakeThread:
    """Minimal ACP thread. `on_stream` runs *inside* an active turn, which is the
    only window in which the pool holds a live org slot (see C1-08)."""

    def __init__(self, session_id: str, *, on_stream=None) -> None:
        self.id = session_id
        self.closed = False
        self._on_stream = on_stream

    async def close(self) -> None:
        self.closed = True

    @property
    def is_closed(self) -> bool:
        return self.closed

    async def warm(self) -> None:
        return None

    async def stream(self, prompt: str, *, current_project: str | None = None):
        yield SimpleNamespace(
            type="thread_started", thread_id=self.id, turn_id="turn-1"
        )
        if self._on_stream is not None:
            await self._on_stream()
        yield SimpleNamespace(
            type="complete",
            text="hermes says hello",
            raw=None,
            name=None,
            thread_id=self.id,
            turn_id="turn-1",
        )


# --- harness ---------------------------------------------------------------


@pytest.fixture()
def harness(monkeypatch, tmp_path):
    """A real `create_app()` WS client wired to a fake hermes worker.

    Only the two ends are faked: who the caller is (auth) and what the hermes
    subprocess is. Everything between — route, egress binding, chat service,
    hermes pool, child-env construction — runs for real, because that middle is
    exactly what OI-61 is about.
    """
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import chat as chat_routes
    from novelvideo.chat import hermes_pool
    from novelvideo.chat import service as chat_service

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    output_dir = tmp_path / "out"
    state_dir = tmp_path / "state"
    runtime_dir = tmp_path / "runtime"
    workspace = tmp_path / "hermes-home"
    for path in (output_dir, state_dir, runtime_dir, workspace):
        path.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id=_PROJECT_ID,
        project_name="demo",
        owner_type="user",
        owner_id=_USER_ID,
        owner_username=_USERNAME,
        requester_user_id=_USER_ID,
        requester_username=_USERNAME,
        requester_principals=(),
        effective_role="owner",
        home_node_id="node-1",
        output_dir=output_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )

    async def fake_resolve_project_context(*, user, project_id, required_role="viewer"):
        return ctx

    async def fake_verify_browser_session(_raw_cookie):
        return {"id": _USER_ID, "username": _USERNAME}

    meter = _Meter()
    monkeypatch.setattr(chat_routes, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(chat_routes, "_verify_browser_session", fake_verify_browser_session)
    monkeypatch.setattr(chat_routes, "get_usage_meter", lambda: meter)

    # --- fake hermes worker -------------------------------------------------
    spawned_envs: list[dict[str, str]] = []
    threads: list[_FakeThread] = []
    stream_hook: dict[str, object] = {"fn": None}
    fake_cli = tmp_path / "hermes"
    fake_cli.write_text("#!/bin/sh\n", encoding="utf-8")
    auth_sessions = _FakeAuthSessions()

    class FakeHermesSdkClient:
        def __init__(self, **kwargs) -> None:
            spawned_envs.append(dict(kwargs["env"]))

        def _thread(self, session_id: str) -> _FakeThread:
            async def _hook() -> None:
                fn = stream_hook["fn"]
                if fn is not None:
                    await fn()  # type: ignore[operator]

            thread = _FakeThread(session_id, on_stream=_hook)
            threads.append(thread)
            return thread

        def thread_start(self) -> _FakeThread:
            return self._thread(f"session-{len(threads) + 1}")

        def thread_resume(self, session_id: str) -> _FakeThread:
            return self._thread(session_id)

    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda _path: None)
    monkeypatch.setattr(
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _u, **_kwargs: workspace,
    )
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)
    monkeypatch.setattr(hermes_pool, "get_auth_session_port", lambda: auth_sessions)
    monkeypatch.setattr(hermes_pool, "gateway_origin_fingerprint", lambda: "gateway-1")
    monkeypatch.setattr(
        hermes_pool,
        "effective_gateway_credentials",
        lambda: (PLATFORM_KEY_CANARY, _PLATFORM_BASE_URL),
    )

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)
    monkeypatch.setattr(hermes_pool, "pool", pool)

    # 观察点：leaf 看到的 ambient 出网身份。
    observed_contexts: list[object] = []
    real_get_for_user = pool.get_for_user

    async def spying_get_for_user(*args, **kwargs):
        observed_contexts.append(current_model_gateway_context())
        return await real_get_for_user(*args, **kwargs)

    monkeypatch.setattr(pool, "get_for_user", spying_get_for_user)

    app = create_app()
    from fastapi.testclient import TestClient

    client = TestClient(app)

    return SimpleNamespace(
        client=client,
        chat_routes=chat_routes,
        chat_service=chat_service,
        pool=pool,
        ctx=ctx,
        meter=meter,
        envs=spawned_envs,
        threads=threads,
        stream_hook=stream_hook,
        observed=observed_contexts,
        auth_sessions=auth_sessions,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )


def _use_authz(monkeypatch, port) -> None:
    # `egress_binding.py:46` 在函数体内惰性取端口，所以打模块属性即可。
    monkeypatch.setattr(ports, "get_authz_port", lambda: port)


def _use_org_credentials(monkeypatch) -> tuple[_OrgCredentials, LedgerDouble]:
    credentials = _OrgCredentials()
    ledger = LedgerDouble()
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credentials)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: ledger)
    return credentials, ledger


_DRAIN_EVENT = "__drain__"
_DRAIN_REPLY = f"unsupported event: {_DRAIN_EVENT}"


def _send_project_turn(harness, *, text: str = "画个分镜") -> list[dict]:
    """Drive one project-scope turn through `/api/v1/chat/ws` and drain its frames.

    收帧不能停在 `chat.done`：`_stream_project_turn` 的 `finally` 先发 `chat.done`，
    异常才冒到 WS 主循环变成 `error` 帧。停在 `chat.done` 会把拒绝读成成功。
    这里改用哨兵事件——路由对未知事件的固定回应——收到它才算本轮帧收全。
    """
    frames: list[dict] = []
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        frames.append(websocket.receive_json())  # scope.changed (home)
        websocket.send_json(
            {
                "type": "chat.message",
                "scope": {"kind": "project", "id": _PROJECT_ID},
                "turn_id": "turn-1",
                "text": text,
            }
        )
        websocket.send_json({"type": _DRAIN_EVENT})
        while True:
            frame = websocket.receive_json()
            if frame.get("message") == _DRAIN_REPLY:
                break
            frames.append(frame)
    return frames


def _assert_org_key_only(env: dict[str, str]) -> None:
    assert env.get("NEWAPI_API_KEY") == ORG_KEY_CANARY, env
    leaked = [key for key, value in env.items() if PLATFORM_KEY_CANARY in str(value)]
    assert leaked == [], f"platform canary leaked into child env keys: {leaked}"


# --- C1-01 -----------------------------------------------------------------


def test_c1_01_project_turn_launches_hermes_with_the_org_key(harness):
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, _ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(harness.envs) == 1, harness.envs
    _assert_org_key_only(harness.envs[0])
    assert harness.envs[0]["NEWAPI_BASE_URL"] == _ORG_BASE_URL
    # 喂给 admit_model_task 的必须是 user_id，不是登录名。
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert len(credentials.admissions) == 1
    assert credentials.admissions[0].requester_user_id == _USER_ID
    # 绑定确实由产品代码完成：leaf 取号时 ambient 上下文非空。
    assert harness.observed and harness.observed[0] is not None
    assert harness.observed[0].task_type == _TASK_TYPE
    assert harness.observed[0].project_id == _PROJECT_ID


# --- C1-02 -----------------------------------------------------------------


def test_c1_02_project_turn_leaves_a_claim_on_the_egress_ledger(harness):
    """出网必须留痕。chat 路径没有成功侧状态迁移，所以只断言 claim，不断言终态。"""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert len(ledger.claims) == 1, ledger.claims
    spec = ledger.claims[0]
    # 账本侧的 capability 与绑定侧的 task_type 必须是同一个字符串（EG-07 口径）。
    assert spec.capability == _TASK_TYPE
    assert spec.organization_id == "org-chat-3"
    assert spec.project_id == _PROJECT_ID
    assert spec.credential_id == "credential-chat-1"
    assert spec.credential_version == 7


# --- C1-03 -----------------------------------------------------------------


def test_c1_03_platform_identity_path_is_unchanged(harness):
    """看门测试：非组织身份下什么都不绑，子进程 env 走既有平台路径。"""
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(harness.envs) == 1
    assert harness.envs[0]["NEWAPI_API_KEY"] == PLATFORM_KEY_CANARY
    assert "NEWAPI_BASE_URL" not in harness.envs[0]
    assert ORG_KEY_CANARY not in str(harness.envs[0])
    # 平台路径逐字节不变：不绑上下文、不解组织凭证、不动账本。
    assert harness.observed == [None]
    assert credentials.admissions == []
    assert ledger.claims == []
    assert current_model_gateway_context() is None


# --- C1-04 -----------------------------------------------------------------


def test_c1_04_gray_disabled_behaves_exactly_like_the_platform_path(harness):
    """灰度关＝平台语义：不绑、不拒，与 C1-03 同结果。"""
    authz = _RaisingAuthz("P0_GRAY_DISABLED")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(authz.calls) == 1
    assert len(harness.envs) == 1
    assert harness.envs[0]["NEWAPI_API_KEY"] == PLATFORM_KEY_CANARY
    assert ORG_KEY_CANARY not in str(harness.envs[0])
    assert harness.observed == [None]
    assert credentials.admissions == []
    assert ledger.claims == []


# --- C1-05 -----------------------------------------------------------------


def test_c1_05_real_denial_is_not_squashed_into_the_platform_path(harness):
    """`ORG_MEMBERSHIP_INACTIVE` 是真拒绝，不得被压成 `None` 当作「非组织，放行」。"""
    authz = _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE")
    _use_authz(harness.monkeypatch, authz)
    _use_org_credentials(harness.monkeypatch)

    frames = _send_project_turn(harness)

    assert len(authz.calls) == 1
    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert errors[0]["message"] == str(AuthzError("ORG_MEMBERSHIP_INACTIVE"))
    # 拒绝就是拒绝：一个 hermes worker 都不许起。
    assert harness.envs == []
    assert current_model_gateway_context() is None


# --- C1-06 -----------------------------------------------------------------


def test_c1_06_identity_is_decided_by_user_id_not_by_login_name(harness):
    """登录名与 user_id 是两个值。判定只认 user_id，env 里才是登录名。"""
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)
    assert _USERNAME != _USER_ID

    frames = _send_project_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    _assert_org_key_only(harness.envs[0])
    # 判定侧一律 user_id；登录名一次都不许出现在身份判定入参里。
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert _USERNAME not in [call[0] for call in authz.calls]
    assert [a.requester_user_id for a in credentials.admissions] == [_USER_ID]
    assert harness.observed[0].requester_user_id == _USER_ID
    assert ledger.claims[0].organization_id == "org-chat-3"
    # 子进程 env 里的 DRAMACLAW_USER 仍是登录名——那是 workspace 口径，不是身份口径。
    assert harness.envs[0]["DRAMACLAW_USER"] == _USERNAME


# --- C1-07 -----------------------------------------------------------------
#
# 这两条是**接缝守卫测试**，不是链路测试（链路由 C1-01/02/06/08 覆盖）。
# 刻意直调，因为路由造不出这个形状：`TrustedEgressContext.__post_init__`
# （`egress_context.py:36-47`）要求 `requester_user_id` 非空，而路由把同一个
# `project_ctx.requester_user_id` 同时喂给绑定工厂和 service，两边永远相等。
# 纵深防御的价值恰恰在于挡住「上游哪天变了」，所以它必须在接缝上被钉住。


def _org_context() -> object:
    from novelvideo.egress_context import TrustedEgressContext

    admission = _admission(kind="organization", user_id=_USER_ID, root_task_id="rt-1")
    return TrustedEgressContext(
        envelope_id="req-rt-1",
        project_id=_PROJECT_ID,
        task_type=_TASK_TYPE,
        requester_user_id=admission.requester_user_id,
        root_task_id=admission.root_task_id,
        admission_id=admission.admission_id,
        admitted_at=admission.admitted_at,
        membership_id=admission.membership_id,
        authz_version=admission.authz_version,
        billing_principal=admission.billing_principal,
        credential=admission.credential,
    )


@pytest.mark.asyncio
async def test_c1_07a_missing_requester_user_id_is_refused_not_backfilled(harness):
    """`egress_context` 非 None 而 `requester_user_id` 为空 → 拒，不得回落成登录名。"""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    async def _on_event(_event):
        return None

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.stream_assistant_reply(
            _USERNAME,
            _PROJECT_ID,
            "画个分镜",
            _on_event,
            project_dir=harness.ctx.output_dir,
            project_state_dir=harness.ctx.state_dir,
            egress_context=_org_context(),
            requester_user_id="",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    # 没有回落成 username：既没解凭证，也没起 worker，更没落账。
    assert credentials.admissions == []
    assert ledger.claims == []
    assert harness.envs == []


@pytest.mark.asyncio
async def test_c1_07b_pool_rechecks_identity_against_an_independent_source(harness):
    """pool 层的身份复核必须有独立来源，否则那次 `_strict_admission` 是 `x != x`。"""
    from novelvideo.chat import hermes_pool
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        HermesTurnAuthorization,
    )
    from novelvideo.ports.model_credentials import RequestCredential

    context = _org_context()
    authorization = HermesTurnAuthorization.for_test(
        context=context,
        credential=RequestCredential(
            reference=context.credential,
            api_key=ORG_KEY_CANARY,
            base_url=_ORG_BASE_URL,
        ),
    )
    token = (await harness.auth_sessions.create_agent_session(
        username=_USERNAME,
        scopes=["projects:read"],
        ttl_seconds=60,
        agent_kind="hermes",
        worker_id="worker-1",
    ))
    home = Path(harness.tmp_path / "hermes-home")

    def _build(**overrides):
        kwargs = {
            "project_id": _PROJECT_ID,
            "egress_project_id": _PROJECT_ID,
            "requester_user_id": _USER_ID,
            "project_env": None,
            "authorization": authorization,
        }
        kwargs.update(overrides)
        return harness.pool._build_env(home, _USERNAME, token, **kwargs)

    # `build_hermes_child_env` 的调用探针。
    # 光断言「抛了 TASK_ENVELOPE_INVALID」钉不住 pool 自己那两道守卫：
    # `build_hermes_child_env` 里的 `_strict_admission`（`hermes_egress.py:78-82`）
    # 对同样的输入会抛出**同一个错误码**，守卫删掉后行为一模一样。
    # 纵深防御的语义是「在到达下游之前就拒」，所以这里钉的是**次序**：
    # 身份不全时，下游根本不许被调用到。
    real_build_child_env = hermes_pool.build_hermes_child_env
    child_env_calls: list[dict] = []

    def _spy(**kwargs):
        child_env_calls.append(kwargs)
        return real_build_child_env(**kwargs)

    harness.monkeypatch.setattr(hermes_pool, "build_hermes_child_env", _spy)

    # 正向：来源一致时照常构造，且确实走到了下游。
    _assert_org_key_only(_build())
    assert len(child_env_calls) == 1

    # 缺 egress_project_id → S3 那道 fail-closed 守卫，且必须**先于**下游触发。
    with pytest.raises(EgressBoundaryError) as missing_project:
        _build(egress_project_id=None)
    assert missing_project.value.code == "TASK_ENVELOPE_INVALID"
    assert len(child_env_calls) == 1, "身份不全时 build_hermes_child_env 不得被调用"

    # 缺 requester_user_id → 拒，不得回落成 authorization.context 自己的值。
    # 同样必须先于下游触发。
    with pytest.raises(EgressBoundaryError) as missing_user:
        _build(requester_user_id="")
    assert missing_user.value.code == "TASK_ENVELOPE_INVALID"
    assert len(child_env_calls) == 1, "身份不全时 build_hermes_child_env 不得被调用"

    # 来源不一致 → 拒。这条是「复核不再自证」的唯一证据：
    # 若 `requester_user_id` 仍取自 `authorization.context`，这里会静默通过。
    with pytest.raises(EgressBoundaryError) as mismatched_user:
        _build(requester_user_id="user-id-somebody-else")
    assert mismatched_user.value.code == "TASK_ENVELOPE_INVALID"

    with pytest.raises(EgressBoundaryError) as mismatched_project:
        _build(egress_project_id="project-somebody-else")
    assert mismatched_project.value.code == "TASK_ENVELOPE_INVALID"


# --- C1-08 -----------------------------------------------------------------


def test_c1_08_worker_rotation_keeps_the_org_key(harness):
    """轮换之后仍必须是组织 Key。

    组织 slot 是 one-shot 且 `gateway_fingerprint=""`（`hermes_pool.py` 的
    `_spawn_locked`），所以**任何**不带 authorization 的 `get_for_user` 撞上活着的
    组织 slot，都会立刻走 `reason="model-gateway-change"` 的 `_rotate_slot_locked`。
    生产上最常见的触发者就是同一用户的第二个浏览器标签：WS 连上／切 scope 会调
    `chat_service.prewarm_chat_backend`，而它不带 authorization。

    组织 slot 只在一个 turn 内活着（`_finish_turn` 会收掉它），所以这里在 hermes
    流式回合**内部**触发那次 prewarm——即真实的并发窗口。调用的是产品函数本身，
    测试不自己造轮换。
    """
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def second_tab_prewarm() -> None:
        # 第二个标签页连上来时路由做的事，一字不差。
        await harness.chat_service.prewarm_chat_backend(
            _USERNAME, project=_PROJECT_ID
        )

    harness.stream_hook["fn"] = second_tab_prewarm

    frames = _send_project_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    # 轮换真的发生了：第二个 worker 被起了起来。
    assert len(harness.envs) == 2, harness.envs
    assert harness.auth_sessions.created == 2
    # 轮换之后的 worker 仍然是组织身份，平台 canary 不出现。
    _assert_org_key_only(harness.envs[1])
    assert harness.envs[1]["NEWAPI_BASE_URL"] == _ORG_BASE_URL
    # 两个 worker 都不许带平台 Key。
    _assert_org_key_only(harness.envs[0])


# --- C1-09 -----------------------------------------------------------------


def test_c1_09_scope_does_not_leak_out_of_the_turn(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)
    assert current_model_gateway_context() is None

    frames = _send_project_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


def test_c1_09b_scope_does_not_leak_on_the_exception_path(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def blow_up() -> None:
        raise RuntimeError("hermes exploded mid-turn")

    harness.stream_hook["fn"] = blow_up

    frames = _send_project_turn(harness)

    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert "hermes exploded mid-turn" in errors[0]["message"]
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


# --- guard: the harness must really be going through the WS route ----------


def test_route_and_backend_fixture_are_wired(harness):
    from novelvideo.chat.service import _chat_backend

    assert _chat_backend() == "hermes"
    # 入口是产品路由本身，不是测试自搭的 app。
    ws_routes = [
        route
        for route in harness.chat_routes.router.routes
        if getattr(route, "path", "") == "/chat/ws"
    ]
    assert len(ws_routes) == 1
    assert ws_routes[0].endpoint is harness.chat_routes.chat_ws
    # 且 `/api/v1/chat/ws` 真的能连上（其余用例都走这条）。
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        assert websocket.receive_json()["type"] == "scope.changed"
