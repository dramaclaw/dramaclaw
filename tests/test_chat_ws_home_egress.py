"""C1 for OI-54 S5 (OI-63): the chat WS *home* turn must bind its own egress identity.

S4 (OI-61) closed the project turn. home 态是 chat 这条线上最后一个洞：
`_stream_home_turn`（`api/routes/chat.py`）是一段独立的流式循环，**完全绕开
`chat/service.py`**，直接调 `hermes_pool.get_for_user`。于是组织用户在首页聊天里
发一句话时，请求路径上没有任何地方产出 authorization，hermes 子进程拿到的是部署级
`NEWAPI_API_KEY`（`hermes_pool.py` 的 `effective_gateway_credentials()`）——
平台替组织垫真实算力。

project 态的测试挡不住这条：两条路径是两份独立实现。所以本文件**从
`/api/v1/chat/ws` 入口进，且 scope 一律是 home**，观察 hermes 子进程 env 里到底是谁的 Key。

**测试自己不绑上下文**：本文件刻意不出现 `model_gateway_request_scope` /
`build_request_egress_context`——绑定必须由产品代码完成，测试只观察结果。
那是 OI-54 登记在案的假绿写法。

**哨兵**：home 态的出网 project 身份是 `HOME_SCOPE_EGRESS_PROJECT_ID == "__home__"`
（`chat/hermes_egress.py`，S3 定义，本片是它的第一个消费方）。它必须**两跳一致**：
`request_egress_scope` 产出的 `context.project_id`、`authorize_hermes_launch` 的
`egress_project_id`、`get_for_user` 的 `egress_project_id` 三处同值，
否则 `_strict_admission` 在 `authorize_credentialed_hermes` 与
`build_hermes_child_env` 两处各比一次，任一处不一致即 `TASK_ENVELOPE_INVALID`。
与此同时**会话身份仍是 home**（`project_id=None`），所以哨兵不得漏进子进程的
`DRAMACLAW_PROJECT_ID`——C2-02 钉这条。

**范围声明**：CE 单机不注册 `egress_operations` 端口
（`ports/local/__init__.py` 的 ports 元组里没有它），所以 C2-03 用仓内既有的
`tests/support/egress_ledger.py` 替身把 claim 钉到端口边界；真库落行的纵向由 EE
`tests/b2b/` 补。chat 路径没有成功侧状态迁移，所以只断言 claim，不断言终态。
"""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from novelvideo import ports
from novelvideo.chat.hermes_egress import HOME_SCOPE_EGRESS_PROJECT_ID
from novelvideo.model_gateway_runtime import current_model_gateway_context
from novelvideo.ports.auth_contract import AgentSessionToken
from novelvideo.ports.authz import AdmissionContext, AuthzError, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from support.egress_ledger import LedgerDouble

pytestmark = pytest.mark.m08

# 登录名与 user_id 刻意不同：身份判定只认 user_id（C2-07 钉这条）。
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
    only window in which the pool holds a live org slot (see C2-11)."""

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
    exactly what OI-63 is about.
    """
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import chat as chat_routes
    from novelvideo.chat import hermes_pool
    from novelvideo.chat import service as chat_service

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")
    # home 态的会话持久化落在 `chat/store.py` 的 `_state_root()`，缺省是仓内
    # `state/`。指到 tmp 让本文件不写仓库工作树。
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "chat-state"))

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
    monkeypatch.setattr(
        chat_routes, "resolve_project_context", fake_resolve_project_context
    )
    monkeypatch.setattr(
        chat_routes, "_verify_browser_session", fake_verify_browser_session
    )
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
    monkeypatch.setattr(
        hermes_pool, "ensure_user_hermes_workspace", lambda _u: workspace
    )
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)
    monkeypatch.setattr(hermes_pool, "get_auth_session_port", lambda: auth_sessions)
    monkeypatch.setattr(
        hermes_pool, "effective_gateway_fingerprint", lambda: "gateway-1"
    )
    monkeypatch.setattr(
        hermes_pool,
        "effective_gateway_credentials",
        lambda: (PLATFORM_KEY_CANARY, _PLATFORM_BASE_URL),
    )

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {}

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
        app=app,
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


def _send_home_turn(harness, *, text: str = "帮我想个故事") -> list[dict]:
    """Drive one **home-scope** turn through `/api/v1/chat/ws` and drain its frames.

    收帧不能停在 `chat.done`：`_stream_home_turn` 的 `finally` 先发 `chat.done`，
    异常才冒到 WS 主循环变成 `error` 帧。停在 `chat.done` 会把拒绝读成成功。
    这里改用哨兵事件——路由对未知事件的固定回应——收到它才算本轮帧收全。
    """
    frames: list[dict] = []
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        frames.append(websocket.receive_json())  # scope.changed (home)
        websocket.send_json(
            {
                "type": "chat.message",
                "scope": {"kind": "home"},
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


# --- C2-01 -----------------------------------------------------------------


def test_c2_01_home_turn_launches_hermes_with_the_org_key(harness):
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, _ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(harness.envs) == 1, harness.envs
    _assert_org_key_only(harness.envs[0])
    assert harness.envs[0]["NEWAPI_BASE_URL"] == _ORG_BASE_URL
    # 喂给 admit_model_task 的必须是 user_id，不是登录名。
    assert [call[0] for call in authz.calls] == [_USER_ID]
    assert len(credentials.admissions) == 1
    assert credentials.admissions[0].requester_user_id == _USER_ID
    # 绑定确实由产品代码完成：leaf 取号时 ambient 上下文非空，且出网 project
    # 身份就是 home 哨兵。
    assert harness.observed and harness.observed[0] is not None
    assert harness.observed[0].task_type == _TASK_TYPE
    assert harness.observed[0].project_id == HOME_SCOPE_EGRESS_PROJECT_ID


# --- C2-02 -----------------------------------------------------------------


def test_c2_02_session_identity_stays_home_and_the_sentinel_never_reaches_the_child(
    harness,
):
    """哨兵只喂出网比对，不得漏进子进程。

    会话身份与出网身份是两个口径：`get_for_user(project_id=None)` 是会话侧，
    `egress_project_id="__home__"` 是出网侧。`build_hermes_child_env` 只在
    `project_id` 非空时写 `DRAMACLAW_PROJECT_ID`，所以 home 态的子进程里这个变量
    必须**不存在**——它一旦出现，hermes 会把 `__home__` 当成一个真项目去操作。
    """
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    env = harness.envs[0]
    # 出网侧确实用了哨兵……
    _assert_org_key_only(env)
    assert harness.observed[0].project_id == HOME_SCOPE_EGRESS_PROJECT_ID
    # ……但会话侧仍是 home：子进程里没有 project id，哨兵一个字节都没漏进去。
    assert "DRAMACLAW_PROJECT_ID" not in env, env
    assert HOME_SCOPE_EGRESS_PROJECT_ID not in str(env), env


# --- C2-03 -----------------------------------------------------------------


def test_c2_03_home_turn_leaves_a_claim_on_the_egress_ledger(harness):
    """出网必须留痕。chat 路径没有成功侧状态迁移，所以只断言 claim，不断言终态。"""
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert len(ledger.claims) == 1, ledger.claims
    spec = ledger.claims[0]
    # 账本侧的 capability 与绑定侧的 task_type 必须是同一个字符串（EG-07 口径）。
    assert spec.capability == _TASK_TYPE
    assert spec.organization_id == "org-chat-3"
    # 账本上 home 态记的是哨兵。EE 侧 egress_operations 的 project_id 是
    # TEXT NOT NULL 且没有指向 projects 的外键，所以哨兵不需要真实 project 记录。
    assert spec.project_id == HOME_SCOPE_EGRESS_PROJECT_ID
    assert spec.credential_id == "credential-chat-1"
    assert spec.credential_version == 7


# --- C2-04 -----------------------------------------------------------------


def test_c2_04_platform_identity_path_is_unchanged(harness):
    """看门测试：非组织身份下什么都不绑，子进程 env 走既有平台路径。"""
    _use_authz(harness.monkeypatch, _Authz(kind="platform"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

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


# --- C2-05 -----------------------------------------------------------------


def test_c2_05_gray_disabled_behaves_exactly_like_the_platform_path(harness):
    """灰度关＝平台语义：不绑、不拒，与 C2-04 同结果。"""
    authz = _RaisingAuthz("P0_GRAY_DISABLED")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert [f for f in frames if f.get("type") == "error"] == [], frames
    assert frames[-1]["type"] == "chat.done"
    assert len(authz.calls) == 1
    assert len(harness.envs) == 1
    assert harness.envs[0]["NEWAPI_API_KEY"] == PLATFORM_KEY_CANARY
    assert ORG_KEY_CANARY not in str(harness.envs[0])
    assert harness.observed == [None]
    assert credentials.admissions == []
    assert ledger.claims == []


# --- C2-06 -----------------------------------------------------------------


def test_c2_06_real_denial_is_not_squashed_into_the_platform_path(harness):
    """`ORG_MEMBERSHIP_INACTIVE` 是真拒绝，不得被压成 `None` 当作「非组织，放行」。"""
    authz = _RaisingAuthz("ORG_MEMBERSHIP_INACTIVE")
    _use_authz(harness.monkeypatch, authz)
    _use_org_credentials(harness.monkeypatch)

    frames = _send_home_turn(harness)

    assert len(authz.calls) == 1
    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert errors[0]["message"] == str(AuthzError("ORG_MEMBERSHIP_INACTIVE"))
    # 拒绝就是拒绝：一个 hermes worker 都不许起。
    assert harness.envs == []
    assert current_model_gateway_context() is None


# --- C2-07 -----------------------------------------------------------------


def test_c2_07_identity_is_decided_by_user_id_not_by_login_name(harness):
    """登录名与 user_id 是两个值。判定只认 user_id，env 里才是登录名。"""
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    credentials, ledger = _use_org_credentials(harness.monkeypatch)
    assert _USERNAME != _USER_ID

    frames = _send_home_turn(harness)

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


# --- C2-08 -----------------------------------------------------------------
#
# 接缝守卫测试，不是链路测试（链路由 C2-01/02/03/07/11 覆盖）。
# 刻意直调 helper，因为路由造不出这个形状：`TrustedEgressContext.__post_init__`
# 要求 `requester_user_id` 非空，而路由把同一个 `requester_user_id` 同时喂给绑定
# 工厂和 helper，两边永远相等。纵深防御的价值恰恰在于挡住「上游哪天变了」。


def _home_context() -> object:
    """A trusted context whose `project_id` is the home sentinel.

    顺带钉住 §6.3：哨兵能过 `TrustedEgressContext.__post_init__` 的非空不变量，
    不需要为它放宽任何校验。
    """
    from novelvideo.egress_context import TrustedEgressContext

    admission = _admission(kind="organization", user_id=_USER_ID, root_task_id="rt-1")
    return TrustedEgressContext(
        envelope_id="req-rt-1",
        project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
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
async def test_c2_08_missing_requester_user_id_is_refused_not_backfilled(harness):
    """`egress_context` 非 None 而 `requester_user_id` 为空 → 拒，不得回落成登录名。"""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.authorize_hermes_launch(
            egress_context=_home_context(),
            username=_USERNAME,
            requester_user_id="",
            egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
            prompt="帮我想个故事",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    # 没有回落成 username：既没解凭证，也没起 worker，更没落账。
    assert credentials.admissions == []
    assert ledger.claims == []
    assert harness.envs == []


@pytest.mark.asyncio
async def test_c2_08b_sentinel_must_agree_across_both_hops(harness):
    """哨兵两跳一致：换 authorization 那一跳与绑定那一跳对不上即拒。"""
    from novelvideo.chat.hermes_egress import EgressBoundaryError

    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    with pytest.raises(EgressBoundaryError) as excinfo:
        await harness.chat_service.authorize_hermes_launch(
            egress_context=_home_context(),  # context.project_id == "__home__"
            username=_USERNAME,
            requester_user_id=_USER_ID,
            egress_project_id="project-somebody-else",
            prompt="帮我想个故事",
        )

    assert excinfo.value.code == "TASK_ENVELOPE_INVALID"
    assert credentials.admissions == []
    assert ledger.claims == []

    # 正向对照：同值时照常放行，证明上面红的是「不一致」而不是「哨兵本身不合法」。
    authorization = await harness.chat_service.authorize_hermes_launch(
        egress_context=_home_context(),
        username=_USERNAME,
        requester_user_id=_USER_ID,
        egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
        prompt="帮我想个故事",
    )
    assert authorization is not None
    assert authorization.credential.api_key == ORG_KEY_CANARY
    assert len(ledger.claims) == 1


@pytest.mark.asyncio
async def test_c2_08c_non_org_context_yields_no_authorization(harness):
    """`egress_context is None` → 返回 None，平台路径不解凭证、不落账。"""
    credentials, ledger = _use_org_credentials(harness.monkeypatch)

    authorization = await harness.chat_service.authorize_hermes_launch(
        egress_context=None,
        username=_USERNAME,
        requester_user_id=_USER_ID,
        egress_project_id=HOME_SCOPE_EGRESS_PROJECT_ID,
        prompt="帮我想个故事",
    )

    assert authorization is None
    assert credentials.admissions == []
    assert ledger.claims == []


# --- C2-09 -----------------------------------------------------------------


def test_c2_09_scope_does_not_leak_out_of_the_turn(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)
    assert current_model_gateway_context() is None

    frames = _send_home_turn(harness)

    assert frames[-1]["type"] == "chat.done", frames
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


def test_c2_09b_scope_does_not_leak_on_the_exception_path(harness):
    _use_authz(harness.monkeypatch, _Authz(kind="organization"))
    _use_org_credentials(harness.monkeypatch)

    async def blow_up() -> None:
        raise RuntimeError("hermes exploded mid-turn")

    harness.stream_hook["fn"] = blow_up

    frames = _send_home_turn(harness)

    errors = [f for f in frames if f.get("type") == "error"]
    assert len(errors) == 1, frames
    assert "hermes exploded mid-turn" in errors[0]["message"]
    assert harness.observed[0] is not None
    assert current_model_gateway_context() is None


# --- C2-11 -----------------------------------------------------------------


async def _home_turn_via_asgi(harness, *, text: str, turn_id: str) -> list[dict]:
    """Drive a home turn through `/api/v1/chat/ws` from *inside* the app event loop.

    C2-11 要的是「project 回合流式输出期间」的并发窗口，而 `TestClient` 的
    `websocket_connect` 是阻塞式的、只能由测试线程驱动，进不了那个窗口。
    这里按 ASGI 协议直接连同一个 app：入口仍是产品路由 `/api/v1/chat/ws` 本身，
    中间件、鉴权、事件分发、`_stream_home_turn` 全程照跑，少的只是 TestClient
    那层线程封装。**不是**绕过路由直调 `_stream_home_turn`。
    """
    inbound: asyncio.Queue = asyncio.Queue()
    await inbound.put({"type": "websocket.connect"})
    for payload in (
        {
            "type": "chat.message",
            "scope": {"kind": "home"},
            "turn_id": turn_id,
            "text": text,
        },
        {"type": _DRAIN_EVENT},
    ):
        await inbound.put({"type": "websocket.receive", "text": json.dumps(payload)})

    frames: list[dict] = []
    drained = asyncio.Event()

    async def receive() -> dict:
        if inbound.empty():
            await drained.wait()
            return {"type": "websocket.disconnect", "code": 1000}
        return await inbound.get()

    async def send(message: dict) -> None:
        if message["type"] == "websocket.send" and message.get("text"):
            frame = json.loads(message["text"])
            frames.append(frame)
            if frame.get("message") == _DRAIN_REPLY:
                drained.set()
        elif message["type"] == "websocket.close":
            drained.set()

    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "server": ("testserver", 80),
        "client": ("testclient", 50001),
        "root_path": "",
        "path": "/api/v1/chat/ws",
        "raw_path": b"/api/v1/chat/ws",
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "subprotocols": [],
        "state": {},
    }
    await harness.app(scope, receive, send)
    return frames


def _send_project_turn(harness, *, text: str = "画个分镜") -> list[dict]:
    frames: list[dict] = []
    with harness.client.websocket_connect("/api/v1/chat/ws") as websocket:
        frames.append(websocket.receive_json())  # scope.changed (home)
        websocket.send_json(
            {
                "type": "chat.message",
                "scope": {"kind": "project", "id": _PROJECT_ID},
                "turn_id": "turn-project-1",
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


def test_c2_11_concurrent_home_turn_runs_its_own_admission(harness):
    """并发 home 回合必须走**自己的**准入，不得继承 project 回合的 authorization。

    S4 给 `_rotate_slot_locked` 加了出网身份继承，修掉了「组织用户自己的在途回合被
    并发调用抢走 worker 后退回平台 Key」。但由此留下一条窄缝：**不带 authorization**
    的并发调用会命中 `gateway_fingerprint` 不符那条轮换分支
    （组织 slot 的指纹是 `""`），于是 `_rotate_slot_locked(authorization=slot.authorization)`
    把组织凭证**继承**给了一轮从未走过准入的调用。

    S5 之前，home 回合恰恰就是这样一个不带 authorization 的调用方。
    S5 之后它自带 authorization，于是走 `get_for_user` 开头那条**拆除重建**路径
    （`slot is not None and authorization is not None`）而非轮换，此缝闭合。
    本用例就是这条闭合的守门人。

    反证形式：在 authz 假件上断言 `admit_model_task` 被调用**两次**
    （两次 root_task_id 互不相同），并断言没有第二个 worker 被起起来——
    继承一旦发生，第二个 worker 会带着组织 Key 出现在 `harness.envs` 里。
    """
    authz = _Authz(kind="organization")
    _use_authz(harness.monkeypatch, authz)
    _credentials, ledger = _use_org_credentials(harness.monkeypatch)

    home_frames: list[dict] = []

    async def concurrent_home_turn() -> None:
        # project 回合正在流式输出（slot.active_turns == 1）时，另一个标签页发来
        # 一条 home 消息。走的是同一个 app 的同一条 WS 路由。
        home_frames.extend(
            await _home_turn_via_asgi(
                harness, text="顺便讲个笑话", turn_id="turn-home-concurrent"
            )
        )

    harness.stream_hook["fn"] = concurrent_home_turn

    project_frames = _send_project_turn(harness)

    # project 回合本身没被并发调用破坏，且仍是组织 Key。
    assert [f for f in project_frames if f.get("type") == "error"] == [], project_frames
    assert project_frames[-1]["type"] == "chat.done"
    _assert_org_key_only(harness.envs[0])

    # 反证一：home 回合跑了**自己的** admit，两次 root_task_id 互不相同。
    assert len(authz.calls) == 2, authz.calls
    assert authz.calls[0][1] != authz.calls[1][1], authz.calls
    assert [call[0] for call in authz.calls] == [_USER_ID, _USER_ID]

    # 反证二：home 回合换到的是**自己的** authorization——账本上两条 claim，
    # business_task_id（envelope_id）不同，且 home 那条记的是 home 哨兵。
    assert len(ledger.claims) == 2, ledger.claims
    assert ledger.claims[0].business_task_id != ledger.claims[1].business_task_id
    assert {spec.project_id for spec in ledger.claims} == {
        _PROJECT_ID,
        HOME_SCOPE_EGRESS_PROJECT_ID,
    }

    # 真正的安全属性：**没有**第二个 worker 被起起来。
    # 继承那条缝若还在，`_rotate_slot_locked` 会用 project 回合的 authorization
    # 再起一个带组织 Key 的 worker——那一轮从未走过准入。
    assert len(harness.envs) == 1, harness.envs
    assert harness.auth_sessions.created == 1

    # 带 authorization 的并发调用撞上在途的组织 slot，走的是拆除重建路径；
    # 在途回合还没结束时它拿不到 worker，于是这一轮被拒。拒绝＝不继承，
    # 正是本用例要的结果（用户重试即可，与任何并发组织调用的既有语义一致）。
    # （收帧用的哨兵事件本身也回一条 error 帧，排掉它再数。）
    home_errors = [
        f
        for f in home_frames
        if f.get("type") == "error" and f.get("message") != _DRAIN_REPLY
    ]
    assert len(home_errors) == 1, home_frames
    assert home_errors[0]["turn_id"] == "turn-home-concurrent"
    assert ORG_KEY_CANARY not in str(home_frames)


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
