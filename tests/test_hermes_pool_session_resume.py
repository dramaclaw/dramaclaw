import json
import os
import time
from pathlib import Path

import pytest

from novelvideo.ports.auth_contract import AgentSessionToken

pytestmark = pytest.mark.m08


class _FakeAuthService:
    def __init__(self) -> None:
        self.created = 0
        self.updated: list[tuple[str, dict]] = []
        self.revoked: list[str] = []

    async def create_agent_session(self, **kwargs):
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
    def __init__(self, session_id: str) -> None:
        self.id = session_id
        self.closed = False

    async def close(self) -> None:
        self.closed = True

    @property
    def is_closed(self) -> bool:
        return self.closed


def test_hermes_session_pointer_is_durable_in_runtime_home(tmp_path: Path) -> None:
    from novelvideo.chat.hermes_pool import HermesPool

    home = tmp_path / "project-state" / "agents" / "hermes" / "director"
    home.mkdir(parents=True)
    HermesPool._persist_session_id(
        home,
        "project",
        "project_a",
        "main",
        None,
        "session-123",
    )

    restarted_pool = HermesPool(max_workers=1)
    assert restarted_pool._persisted_session_id_for(
        home, "project", "project_a", "main", None
    ) == "session-123"

    restarted_pool._forget_session(
        "alice",
        "project",
        "project_a",
        "main",
        None,
        home=home,
    )
    assert restarted_pool._persisted_session_id_for(
        home, "project", "project_a", "main", None
    ) is None


def _write_fake_hermes_cli(path: Path) -> None:
    """A stand-in CLI. The version it reports no longer matters.

    It used to have to echo whatever `.hermes-version` held, because the pool
    refused to spawn on a mismatch. That gate is gone: a version string cannot
    tell the fork from stock — the fork keeps upstream's version — so it was
    checking the weaker property while costing an edit on every alignment.
    What the pool checks now is behaviour, in `require_hermes_fork`.
    """
    path.write_text(
        "#!/bin/sh\necho 'Hermes Agent v0.0.0-test'\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _patch_fake_hermes_pool(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from novelvideo.chat import hermes_pool
    from novelvideo.ports import registry

    calls: list[tuple[str, str | None]] = []
    started_count = 0
    fake_auth = _FakeAuthService()
    gateway = {"fingerprint": "gateway-1"}
    fake_cli = tmp_path / "hermes"
    _write_fake_hermes_cli(fake_cli)

    class FakeHermesSdkClient:
        def __init__(self, **_kwargs) -> None:
            pass

        def thread_start(self) -> _FakeThread:
            nonlocal started_count
            started_count += 1
            calls.append(("start", None))
            return _FakeThread(f"session-{started_count}")

        def thread_resume(self, session_id: str) -> _FakeThread:
            calls.append(("resume", session_id))
            return _FakeThread(session_id)

    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("auth_session", fake_auth)
    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda _path: None)
    monkeypatch.setattr(
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _user, profile="director", **_kwargs: tmp_path,
    )
    monkeypatch.setattr(
        hermes_pool,
        "gateway_origin_fingerprint",
        lambda: gateway["fingerprint"],
    )
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)
    return pool, calls, fake_auth, gateway


def test_hermes_worker_receives_effective_newapi_key_without_mutating_host_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool

    monkeypatch.delenv("NEWAPI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(
        hermes_pool,
        "effective_gateway_credentials",
        lambda: ("worker-only-key", "https://newapi.example/v1"),
    )
    token = AgentSessionToken(
        value="agent-token",
        session_id="agent-session",
        user="alice",
        scopes=("projects:read",),
        exp=int(time.time()) + 3600,
        worker_id="worker-1",
        agent_kind="hermes",
    )

    pool = hermes_pool.HermesPool(max_workers=1)
    env = pool._build_env(
        tmp_path,
        "alice",
        token,
        project_id=None,
    )

    # The real gateway key is delivered per turn through ACP metadata; the
    # long-lived worker only receives a non-secret placeholder.
    assert env["NEWAPI_API_KEY"] == "dramaclaw-per-turn-placeholder"
    assert env["OPENAI_API_KEY"] == "dramaclaw-per-turn-placeholder"
    assert "NEWAPI_API_KEY" not in os.environ
    assert "OPENAI_API_KEY" not in os.environ


def test_hermes_worker_defaults_to_ce_edition(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo.chat import hermes_pool

    monkeypatch.delenv("ST_EDITION", raising=False)
    # 即便宿主进程有控制面 DSN,也绝不能泄漏进 worker 子进程环境。
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    monkeypatch.setattr(hermes_pool, "effective_gateway_credentials", lambda: ("", ""))
    token = AgentSessionToken(
        value="agent-token",
        session_id="agent-session",
        user="alice",
        scopes=("projects:read",),
        exp=int(time.time()) + 3600,
        worker_id="worker-1",
        agent_kind="hermes",
    )

    pool = hermes_pool.HermesPool(max_workers=1)
    env = pool._build_env(
        tmp_path,
        "alice",
        token,
        project_id=None,
    )

    assert env["ST_EDITION"] == "ce"
    assert "ST_CONTROL_PLANE_DSN" not in env


def test_hermes_worker_receives_novelvideo_data_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo.chat import hermes_pool

    monkeypatch.setattr(hermes_pool, "effective_gateway_credentials", lambda: ("", ""))
    token = AgentSessionToken(
        value="agent-token",
        session_id="agent-session",
        user="alice",
        scopes=("projects:read",),
        exp=int(time.time()) + 3600,
        worker_id="worker-1",
        agent_kind="hermes",
    )

    pool = hermes_pool.HermesPool(max_workers=1)
    env = pool._build_env(
        tmp_path,
        "alice",
        token,
        project_id=None,
    )

    assert env["NOVELVIDEO_OUTPUT_DIR"] == str(hermes_pool.config.OUTPUT_DIR)
    assert env["NOVELVIDEO_STATE_DIR"] == str(hermes_pool.config.STATE_DIR)
    assert env["NOVELVIDEO_RUNTIME_DIR"] == str(hermes_pool.config.RUNTIME_DIR)


def test_freezone_hermes_worker_disables_skill_manage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool

    monkeypatch.setattr(hermes_pool, "effective_gateway_credentials", lambda: ("", ""))
    token = AgentSessionToken(
        value="agent-token",
        session_id="agent-session",
        user="alice",
        scopes=("projects:read",),
        exp=int(time.time()) + 3600,
        worker_id="worker-1",
        agent_kind="hermes-freezone",
    )

    pool = hermes_pool.HermesPool(max_workers=1)
    env = pool._build_env(
        tmp_path,
        "alice",
        token,
        agent_profile="freezone",
        project_id=None,
    )

    assert env["DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE"] == "1"
    assert env["DRAMACLAW_HERMES_TOOL_DENY"] == ",".join(
        hermes_pool.FREEZONE_HERMES_TOOL_DENY
    )
    assert "terminal" in env["DRAMACLAW_HERMES_TOOL_DENY"]
    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(tmp_path / ".dramaclaw-python")


@pytest.mark.asyncio
async def test_hermes_pool_uses_separate_sessions_per_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        second = await pool.get_for_user("alice", scope_kind="project", project_id="project_b")
        third = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        fourth = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
    finally:
        await pool.close_all()

    assert first.id == "session-1"
    assert second.id == "session-2"
    assert third.id == "session-1"
    assert fourth.id == "session-1"
    assert calls == [("start", None), ("start", None), ("resume", "session-1")]
    assert fake_auth.created == 3
    assert fake_auth.updated == [
        ("token-3", {"scope_kind": "project", "project_id": "project_a"}),
    ]
    assert fake_auth.revoked == ["token-1", "token-2", "token-3"]


@pytest.mark.asyncio
async def test_hermes_pool_uses_separate_sessions_per_agent_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        main = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        freezone = await pool.get_for_user(
            "alice",
            agent_profile="freezone",
            tool_mode="freezone_canvas",
            scope_kind="project",
            project_id="project_a",
        )
        main_again = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        freezone_again = await pool.get_for_user(
            "alice",
            agent_profile="freezone",
            tool_mode="freezone_canvas",
            scope_kind="project",
            project_id="project_a",
        )
    finally:
        await pool.close_all()

    assert main.id == "session-1"
    assert freezone.id == "session-2"
    assert main_again.id == "session-1"
    assert freezone_again.id == "session-2"
    assert calls == [("start", None), ("start", None)]
    assert sorted(pool._session_ids["alice"]) == [
        ("freezone", "project", "project_a", None),
        ("main", "project", "project_a", None),
    ]
    assert fake_auth.created == 2


@pytest.mark.asyncio
async def test_hermes_pool_freezone_profile_uses_isolated_home_and_canvas_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool
    from novelvideo.ports import registry

    fake_auth = _FakeAuthService()
    fake_cli = tmp_path / "hermes"
    _write_fake_hermes_cli(fake_cli)
    workspaces: list[tuple[str, str, str | None]] = []
    client_kwargs: list[dict] = []

    class FakeHermesSdkClient:
        def __init__(self, **kwargs) -> None:
            client_kwargs.append(kwargs)

        def thread_start(self) -> _FakeThread:
            return _FakeThread("session-freezone")

        def thread_resume(self, session_id: str) -> _FakeThread:
            return _FakeThread(session_id)

    def fake_workspace(
        username: str,
        *,
        profile: str = "director",
        project_state_dir=None,
    ) -> Path:
        workspaces.append((username, profile, project_state_dir))
        home = Path(project_state_dir) / "agents" / "hermes" / profile
        (home / "tmp").mkdir(parents=True, exist_ok=True)
        return home

    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("auth_session", fake_auth)
    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(hermes_pool, "ensure_user_hermes_workspace", fake_workspace)
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)

    try:
        thread = await pool.get_for_user(
            "alice",
            agent_profile="freezone",
            tool_mode="freezone_canvas",
            scope_kind="project",
            project_id="project_a",
            canvas_id="canvas_123",
        )
    finally:
        await pool.close_all()

    assert thread.id == "session-freezone"
    project_state = tmp_path / "project-state"
    expected_home = project_state / "agents" / "hermes" / "freezone"
    assert workspaces == [("alice", "freezone", str(project_state))]
    assert client_kwargs[0]["cwd"] == expected_home
    env = client_kwargs[0]["env"]
    assert env["HERMES_HOME"] == str(expected_home)
    assert env["DRAMACLAW_CANVAS_ID"] == "canvas_123"
    assert env["SUPERTALE_CANVAS_ID"] == "canvas_123"
    assert env["DRAMACLAW_CHAT_SURFACE"] == "freezone"
    persisted_sessions = json.loads(
        (expected_home / "dramaclaw_sessions.json").read_text(encoding="utf-8")
    )
    assert persisted_sessions == {
        '["freezone","project","project_a","canvas_123"]': "session-freezone"
    }


@pytest.mark.asyncio
async def test_hermes_pool_resumes_current_project_session_when_renewing_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        pool._slots["alice"].token = AgentSessionToken(
            value="expired-token",
            session_id="expired-agent-session",
            user="alice",
            scopes=("projects:read",),
            exp=0,
            worker_id="expired-worker",
            agent_kind="hermes",
        )
        second = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
    finally:
        await pool.close_all()

    assert first.id == "session-1"
    assert second.id == "session-1"
    assert calls == [("start", None), ("resume", "session-1")]
    assert fake_auth.created == 2
    assert fake_auth.revoked == ["expired-token", "token-2"]


@pytest.mark.asyncio
async def test_hermes_pool_starts_fresh_session_when_resume_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool
    from novelvideo.ports import registry

    calls: list[tuple[str, str | None]] = []
    fake_auth = _FakeAuthService()
    fake_cli = tmp_path / "hermes"
    _write_fake_hermes_cli(fake_cli)

    class FakeHermesSdkClient:
        def __init__(self, **_kwargs) -> None:
            pass

        def thread_start(self) -> _FakeThread:
            calls.append(("start", None))
            return _FakeThread("fresh-session")

        def thread_resume(self, session_id: str) -> _FakeThread:
            calls.append(("resume", session_id))
            raise RuntimeError("session stale-session not found")

    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("auth_session", fake_auth)
    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _user, profile="director", **_kwargs: tmp_path,
    )
    monkeypatch.setattr(
        hermes_pool,
        "gateway_origin_fingerprint",
        lambda: "gateway-1",
    )
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)

    pool = hermes_pool.HermesPool(max_workers=5)
    pool._session_ids = {
        "alice": {
            ("main", "project", "project_a", None): "stale-session",
        },
    }

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)

    try:
        thread = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
    finally:
        await pool.close_all()

    assert thread.id == "fresh-session"
    assert calls == [("resume", "stale-session"), ("start", None)]
    assert pool._session_ids["alice"][("main", "project", "project_a", None)] == "fresh-session"
    assert fake_auth.created == 1


@pytest.mark.asyncio
async def test_hermes_pool_surfaces_error_when_resume_and_fresh_start_fail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool
    from novelvideo.ports import registry

    calls: list[tuple[str, str | None]] = []
    fake_auth = _FakeAuthService()
    fake_cli = tmp_path / "hermes"
    _write_fake_hermes_cli(fake_cli)

    class FakeHermesSdkClient:
        def __init__(self, **_kwargs) -> None:
            pass

        def thread_start(self) -> _FakeThread:
            calls.append(("start", None))
            raise RuntimeError("No LLM provider configured")

        def thread_resume(self, session_id: str) -> _FakeThread:
            calls.append(("resume", session_id))
            raise RuntimeError("session stale-session not found")

    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("auth_session", fake_auth)
    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _user, profile="director", **_kwargs: tmp_path,
    )
    monkeypatch.setattr(
        hermes_pool,
        "gateway_origin_fingerprint",
        lambda: "gateway-1",
    )
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)

    pool = hermes_pool.HermesPool(max_workers=5)
    pool._session_ids = {
        "alice": {
            ("main", "project", "project_a", None): "stale-session",
        },
    }

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)

    with pytest.raises(RuntimeError, match="No LLM provider configured"):
        await pool.get_for_user("alice", scope_kind="project", project_id="project_a")

    assert calls == [("resume", "stale-session"), ("start", None)]
    assert "alice" not in pool._session_ids


@pytest.mark.asyncio
async def test_hermes_pool_does_not_restore_stale_session_after_rotation_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.chat import hermes_pool
    from novelvideo.ports import registry

    calls: list[tuple[str, str | None]] = []
    fake_auth = _FakeAuthService()
    fake_cli = tmp_path / "hermes"
    _write_fake_hermes_cli(fake_cli)
    starts = 0

    class FakeHermesSdkClient:
        def __init__(self, **_kwargs) -> None:
            pass

        def thread_start(self) -> _FakeThread:
            nonlocal starts
            starts += 1
            session_id = "stale-session" if starts == 1 else "fresh-session"
            calls.append(("start", None))
            return _FakeThread(session_id)

        def thread_resume(self, session_id: str) -> _FakeThread:
            calls.append(("resume", session_id))
            raise RuntimeError(f"session {session_id} not found")

    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("auth_session", fake_auth)
    monkeypatch.setattr(hermes_pool, "_hermes_cli_path", lambda: fake_cli)
    monkeypatch.setattr(
        hermes_pool,
        "ensure_user_hermes_workspace",
        lambda _user, profile="director", **_kwargs: tmp_path,
    )
    monkeypatch.setattr(
        hermes_pool,
        "gateway_origin_fingerprint",
        lambda: "gateway-1",
    )
    monkeypatch.setattr(hermes_pool, "require_hermes_fork", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(hermes_pool, "HermesSdkClient", FakeHermesSdkClient)

    pool = hermes_pool.HermesPool(max_workers=5)

    async def fake_project_env(*_args, **_kwargs):
        return {"DRAMACLAW_PROJECT_STATE_DIR": str(tmp_path / "project-state")}

    monkeypatch.setattr(pool, "_project_env", fake_project_env)

    try:
        first = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        pool._slots["alice"].token = AgentSessionToken(
            value="expired-token",
            session_id="expired-agent-session",
            user="alice",
            scopes=("projects:read",),
            exp=0,
            worker_id="expired-worker",
            agent_kind="hermes",
        )
        second = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
    finally:
        await pool.close_all()

    assert first.id == "stale-session"
    assert second.id == "fresh-session"
    assert calls == [("start", None), ("resume", "stale-session"), ("start", None)]
    assert pool._session_ids["alice"][("main", "project", "project_a", None)] == "fresh-session"


@pytest.mark.asyncio
async def test_hermes_pool_reset_for_user_forgets_cached_session_and_starts_fresh(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        pool._remember_session(pool._slots["alice"])
        second = await pool.reset_for_user(
            "alice",
            scope_kind="project",
            project_id="project_a",
        )
    finally:
        await pool.close_all()

    assert first.id == "session-1"
    assert second.id == "session-2"
    assert calls == [("start", None), ("start", None)]
    assert fake_auth.created == 2
    assert fake_auth.revoked == ["token-1", "token-2"]


@pytest.mark.asyncio
async def test_hermes_pool_restarts_dirty_freezone_profile_on_next_turn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user(
            "alice",
            agent_profile="freezone:agent-1",
            tool_mode="freezone_canvas",
            scope_kind="project",
            project_id="project_a",
            surface="freezone",
            canvas_id="canvas_a",
        )
        pool.mark_user_profile_dirty("alice", "freezone:agent-1")
        second = await pool.get_for_user(
            "alice",
            agent_profile="freezone:agent-1",
            tool_mode="freezone_canvas",
            scope_kind="project",
            project_id="project_a",
            surface="freezone",
            canvas_id="canvas_a",
        )
    finally:
        await pool.close_all()

    assert second is not first
    assert second.id == "session-2"
    assert calls == [("start", None), ("start", None)]
    assert fake_auth.created == 2
    assert fake_auth.revoked == ["token-1", "token-2"]


@pytest.mark.asyncio
async def test_hermes_pool_rotates_closed_thread(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, _gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
        await first.close()
        second = await pool.get_for_user("alice", scope_kind="project", project_id="project_a")
    finally:
        await pool.close_all()

    assert first.closed is True
    assert second is not first
    assert second.id == "session-1"
    assert calls == [("start", None), ("resume", "session-1")]
    assert fake_auth.created == 2
    assert fake_auth.revoked == ["token-1", "token-2"]


@pytest.mark.asyncio
async def test_hermes_pool_rotates_and_resumes_when_gateway_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool, calls, fake_auth, gateway = _patch_fake_hermes_pool(tmp_path, monkeypatch)

    try:
        first = await pool.get_for_user(
            "alice", scope_kind="project", project_id="project_a"
        )
        gateway["fingerprint"] = "gateway-2"
        second = await pool.get_for_user(
            "alice", scope_kind="project", project_id="project_a"
        )
    finally:
        await pool.close_all()

    assert second is not first
    assert second.id == first.id == "session-1"
    assert calls == [("start", None), ("resume", "session-1")]
    assert fake_auth.created == 2
    assert fake_auth.revoked == ["token-1", "token-2"]
