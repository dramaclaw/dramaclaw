import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.chat import backend_sdk, codex_app_server, service
from novelvideo.chat.store import ChatScope, chat_store


_FIXTURES = Path(__file__).parent / "fixtures" / "codex-0.162"


@pytest.fixture
def node(monkeypatch, tmp_path):
    control = tmp_path / "ipc"
    control.mkdir()
    monkeypatch.setattr(codex_app_server, "_control_dir", lambda: control)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    home = tmp_path / "codex-home"
    monkeypatch.setenv("DRAMACLAW_CODEX_HOME", str(home))
    runtime = codex_app_server._SharedCodexRuntime()
    monkeypatch.setattr(codex_app_server, "_RUNTIME", runtime)
    socket, _, signature = codex_app_server._control_paths(home)
    owner, drain, leases = codex_app_server._coordination_paths(home)
    state = SimpleNamespace(
        home=home, runtime=runtime, socket=socket, signature=signature, owner=owner,
        drain=drain, leases=leases, running=False, statuses={}, interrupted=[], revoked=[],
    )
    monkeypatch.setattr(
        codex_app_server._SharedCodexRuntime, "_socket_accepting",
        staticmethod(lambda _: state.running),
    )

    def forbidden(*args, **kwargs):
        pytest.fail("existing-turn work must not spawn or acquire a lease")

    monkeypatch.setattr(runtime, "acquire", forbidden)
    monkeypatch.setattr(codex_app_server.subprocess, "Popen", forbidden)

    class Client:
        def start(self):
            self.ready = False

        def initialize(self):
            from openai_codex.models import InitializeResponse

            rows = (_FIXTURES / "12-revert.jsonl").read_text().splitlines()
            result = next(
                json.loads(row)["msg"]["result"] for row in rows
                if json.loads(row)["seq"] == 391
            )
            self.ready = True
            return InitializeResponse.model_validate(result)

        def close(self):
            pass

        def thread_read(self, thread_id, *, include_turns=False):
            assert self.ready is True
            status = state.statuses.get(thread_id, "idle")
            if isinstance(status, Exception):
                raise status
            return SimpleNamespace(thread=SimpleNamespace(
                status=SimpleNamespace(type=status), turns=[],
            ))

        def turn_interrupt(self, thread_id, turn_id):
            assert self.ready is True
            state.interrupted.append((thread_id, turn_id))

        def request(self, method, payload, *, response_model):
            assert self.ready is True
            seq = {"thread/turns/list": 71, "thread/items/list": 81}[method]
            rows = (_FIXTURES / "05-history-reads.jsonl").read_text().splitlines()
            result = next(
                json.loads(row)["msg"]["result"] for row in rows
                if json.loads(row)["seq"] == seq
            )
            if method == "thread/items/list":
                result["data"] = [
                    item for item in result["data"] if item["turnId"] == payload["turnId"]
                ]
            return response_model.model_validate(result)

    monkeypatch.setattr(
        codex_app_server._UnixSocketCodexClient, "create", lambda *_: Client(),
    )

    class Auth:
        async def revoke_agent_session(self, token):
            state.revoked.append(token)

    monkeypatch.setattr(service, "get_auth_session_port", lambda: Auth())
    return state


def persist(node, tmp_path, *, user="test-user", key="scope", started_at=1, **extra):
    token = tmp_path / f"{key}.token"
    token.write_text(f"token-{key}")
    scope = ChatScope(kind="home")
    entry = {
        "thread_id": f"thread-{key}", "turn_id": f"turn-{key}",
        "business_turn_id": f"business-{key}", "started_at": started_at,
        "lock_key": service._chat_run_lock_key("project-a"), "token_file": str(token),
        "store_scope": scope.to_dict(), "store_state_dir": None,
        "project_state_dir": str(tmp_path), "agent_profile": "freezone:main",
        "structured_canvas_reply": False, **extra,
    }
    service._set_active_codex_turn(user, key, entry)
    node.statuses[entry["thread_id"]] = "active"
    return token, scope, entry


def running_node(node):
    node.running = True
    node.signature.write_text("signature")
    node.owner.write_text(json.dumps({"pid": 4242, "signature": "signature"}))

    def terminate():
        node.running = False

    node.runtime._process = SimpleNamespace(pid=4242, terminate=terminate, wait=lambda **_: None)


def test_attach_missing_runtime_never_starts_or_leases(node):
    with pytest.raises(codex_app_server.CodexRuntimeError, match="app-server is not running"):
        with codex_app_server.attach_shared_codex(node.home):
            pytest.fail("missing node cannot be attached")
    assert list(node.leases.iterdir()) == []
    assert node.owner.exists() is False


@pytest.mark.asyncio
async def test_interrupt_attaches_during_drain(node, tmp_path):
    running_node(node)
    node.drain.touch()
    persist(node, tmp_path)
    assert await service.interrupt_active_codex_turn("test-user", "scope", "business-scope")
    assert node.interrupted == [("thread-scope", "turn-scope")]
    assert list(node.leases.iterdir()) == []
    assert node.drain.exists() is True


@pytest.mark.asyncio
async def test_interrupt_without_runtime_returns_false(node, tmp_path):
    persist(node, tmp_path)
    assert await service.interrupt_active_codex_turn(
        "test-user", "scope", "business-scope"
    ) is False
    assert node.interrupted == []
    assert list(node.leases.iterdir()) == []


@pytest.mark.parametrize("remaining", ["idle", "removed", "error"])
def test_drain_waits_for_active_turn_without_lease(node, tmp_path, remaining):
    running_node(node)
    persist(node, tmp_path)
    assert node.runtime.request_restart(node.home) == "draining"
    assert list(node.leases.iterdir()) == []
    codex_app_server.complete_pending_drain(node.home)
    assert node.running is True
    assert node.drain.exists() is True
    with pytest.raises(RuntimeError, match="applying new Agent configuration; retry shortly"):
        node.runtime.ensure(
            codex_bin=tmp_path / "unused", codex_home=node.home, env={}, config_overrides=(),
        )
    if remaining == "removed":
        service._set_active_codex_turn("test-user", "scope", None)
    else:
        node.statuses["thread-scope"] = (
            RuntimeError("status unavailable") if remaining == "error" else "idle"
        )
    codex_app_server.complete_pending_drain(node.home)
    assert node.running is (remaining == "error")
    assert node.drain.exists() is (remaining == "error")


def test_release_does_not_stop_a_running_turn(node, tmp_path):
    running_node(node)
    persist(node, tmp_path)
    node.drain.touch()
    lease = node.leases / "released.json"
    lease.write_text("{}")
    node.runtime.release(node.home, lease)
    assert lease.exists() is False
    assert node.running is True
    assert node.drain.exists() is True


def test_active_probe_only_runs_for_pending_drain(node, tmp_path):
    running_node(node)
    persist(node, tmp_path)
    node.statuses["thread-scope"] = RuntimeError("status unavailable")
    node.runtime.release(node.home, node.leases / "absent.json")
    assert node.drain.exists() is False
    assert node.running is True
    assert node.runtime.request_restart(node.home) == "draining"
    assert service._load_active_codex_turns("test-user")["scope"]["turn_id"] == "turn-scope"


def test_history_attaches_during_drain(node):
    running_node(node)
    node.drain.touch()
    page = backend_sdk.read_codex_thread_history(
        codex_bin=node.home / "unused", cwd=node.home, env={"CODEX_HOME": str(node.home)},
        config_overrides=(), thread_id="thread-draining-history", before=None,
    )
    assert [(m["role"], m["content"]) for m in page.messages] == [
        ("assistant", "ready"),
        ("assistant", "I can see DI-ALPHA, AC-ONE, and AC-TWO."),
    ]
    assert page.before is None
    assert list(node.leases.iterdir()) == []
    assert node.drain.exists() is True


@pytest.mark.asyncio
async def test_sweeper_times_out_only_old_turn_and_settles_once(node, monkeypatch, tmp_path):
    running_node(node)
    monkeypatch.setenv("DRAMACLAW_CODEX_TURN_MAX_SECONDS", "61")
    token, scope, _ = persist(node, tmp_path, key="old", started_at=1)
    persist(node, tmp_path, user="second-user", key="young", started_at=120)
    await service.sweep_codex_turns(now=163)
    assert node.interrupted == [("thread-old", "turn-old")]
    assert service._load_active_codex_turns("test-user")["old"]["timeout_reason"] == "max_duration"
    assert "timeout_reason" not in service._load_active_codex_turns("second-user")["young"]
    assert token.exists() is True
    node.statuses["thread-old"] = "idle"
    await asyncio.gather(service.sweep_codex_turns(now=163), service.active_chat_turn("test-user"))
    assert await service.finalize_codex_turn("test-user", "old", "turn-old", "cancelled") is None
    assert node.revoked == ["token-old"]
    assert token.exists() is False
    assert [m["content"] for m in chat_store.list_messages("test-user", scope)] == [
        "本轮请求超过最长 2 分钟，已停止。"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("running", [False, True])
async def test_deploy_or_stale_turn_is_finalized_and_new_start_accepted(node, tmp_path, running):
    token, scope, _ = persist(node, tmp_path)
    node.running = running
    node.statuses["thread-scope"] = "idle"
    await service.sweep_codex_turns(now=100)
    assert service._load_active_codex_turns("test-user") == {}
    assert token.exists() is False
    assert node.revoked == ["token-scope"]
    assert [m["content"] for m in chat_store.list_messages("test-user", scope)] == [
        "本轮请求已中断。"
    ]
    assert await service.active_chat_turn("test-user", "project-a") is None
    lock = service._acquire_chat_run_lock("test-user", "project-a", "new-business")
    assert lock is not None
    service._release_chat_run_lock("test-user", "project-a", lock)
    assert list(node.leases.iterdir()) == []


@pytest.mark.asyncio
async def test_successful_finalization_completes_drain(node, tmp_path):
    running_node(node)
    _, _, entry = persist(node, tmp_path)
    node.drain.touch()
    claimed = await service.finalize_codex_turn("test-user", "scope", "turn-scope", "completed")
    assert claimed == entry
    assert node.running is False
    assert node.drain.exists() is False


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["codex", "claude"])
async def test_app_starts_and_cancels_only_codex_sweeper(node, monkeypatch, backend):
    from fastapi import FastAPI
    from novelvideo.api import app

    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", backend)
    monkeypatch.delenv("CODEX_BIN", raising=False)
    application = FastAPI()
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def sweep_forever():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(service, "run_codex_turn_sweeper", sweep_forever, raising=False)
    app._start_codex_turn_sweeper(application)
    if backend == "codex":
        await asyncio.wait_for(entered.wait(), 1)
    await app._stop_codex_turn_sweeper(application)
    assert entered.is_set() is (backend == "codex")
    assert cancelled.is_set() is (backend == "codex")


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["invalid", "0", "-1"])
async def test_sweeper_uses_default_max_for_invalid_settings(node, monkeypatch, tmp_path, value):
    running_node(node)
    monkeypatch.setenv("DRAMACLAW_CODEX_TURN_MAX_SECONDS", value)
    persist(node, tmp_path, started_at=1)
    await service.sweep_codex_turns(now=3601)
    assert node.interrupted == []
    await service.sweep_codex_turns(now=3602)
    assert node.interrupted == [("thread-scope", "turn-scope")]


@pytest.mark.asyncio
async def test_sweeper_loop_continues_after_error_and_completes_drain(node, monkeypatch):
    running_node(node)
    node.drain.touch()
    attempts = []
    intervals = []

    async def sweep():
        attempts.append("tick")
        raise RuntimeError("read unavailable")

    async def sleep(interval):
        intervals.append(interval)
        if len(intervals) == 2:
            raise asyncio.CancelledError

    monkeypatch.setenv("DRAMACLAW_CODEX_TURN_SWEEP_SECONDS", "0")
    monkeypatch.setattr(service, "sweep_codex_turns", sweep, raising=False)
    monkeypatch.setattr(service.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await service.run_codex_turn_sweeper()
    assert attempts == ["tick", "tick"]
    assert intervals == [30, 30]
    assert node.running is False
    assert node.drain.exists() is False


@pytest.mark.asyncio
async def test_failed_drain_completion_does_not_skip_turn_settlement(node, tmp_path):
    running_node(node)
    token, scope, entry = persist(node, tmp_path, timeout_reason="max_duration")
    node.drain.touch()

    def fail_stop():
        raise OSError("runtime stop unavailable")

    node.runtime._process.terminate = fail_stop
    assert await service.finalize_codex_turn(
        "test-user", "scope", "turn-scope", "cancelled"
    ) == entry
    assert node.revoked == ["token-scope"]
    assert token.exists() is False
    assert [m["content"] for m in chat_store.list_messages("test-user", scope)] == [
        "本轮请求超过最长 60 分钟，已停止。"
    ]
    assert node.drain.exists() is True


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [RuntimeError, codex_app_server.CodexRuntimeError])
async def test_snapshot_errors_keep_turn_busy(node, tmp_path, error):
    running_node(node)
    token, _, _ = persist(node, tmp_path)
    node.statuses["thread-scope"] = error("thread read unavailable")
    active = await service.active_chat_turn("test-user", "project-a")
    assert active is not None
    assert active.turn_id == "business-scope"
    await service.sweep_codex_turns(now=4000)
    assert token.exists() is True
    assert node.interrupted == []
    assert node.runtime.request_restart(node.home) == "draining"


@pytest.mark.asyncio
async def test_sweeper_does_not_mark_or_interrupt_a_replaced_turn(node, monkeypatch, tmp_path):
    running_node(node)
    _, _, entry = persist(node, tmp_path)
    replacement = {**entry, "turn_id": "replacement", "started_at": 4000}
    snapshot = service._codex_thread_snapshot

    def replace_while_reading(thread_id, *, include_turns=False):
        service._set_active_codex_turn("test-user", "scope", replacement)
        return snapshot(thread_id, include_turns=include_turns)

    monkeypatch.setattr(service, "_codex_thread_snapshot", replace_while_reading)
    await service.sweep_codex_turns(now=4000)
    assert service._load_active_codex_turns("test-user") == {"scope": replacement}
    assert node.interrupted == []


@pytest.mark.asyncio
async def test_timeout_settles_pending_clarification(node, monkeypatch, tmp_path):
    from novelvideo.chat import hermes_pool, hermes_workspace
    from novelvideo.freezone import canvas_command_bridge

    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a", agent_id="main"
    )
    persist(
        node, tmp_path, store_scope=scope.to_dict(), structured_canvas_reply=True,
        timeout_reason="max_duration",
    )
    chat_store.append_ui_event("test-user", scope, "business-scope", {
        "type": "assistant.clarification.request", "bridge_key": "bridge-a",
        "clarification_id": "clarify-a", "questions": [],
    })
    monkeypatch.setattr(
        hermes_workspace, "ensure_user_hermes_workspace", lambda *a, **kw: tmp_path / "workspace"
    )
    monkeypatch.setattr(
        hermes_pool, "canvas_bridge_dir_for_profile", lambda *a: tmp_path / "bridge"
    )
    monkeypatch.setattr(canvas_command_bridge, "resolve_clarification_result", lambda *a, **kw: {})
    await service.finalize_codex_turn("test-user", "scope", "turn-scope", "cancelled")
    events = (await chat_store.turn_ui_events_async("test-user", scope, ["business-scope"]))[
        "business-scope"
    ]
    assert events[-1]["submitted"] is True
    assert events[-1]["cancelled"] is True
    assert events[-1]["clarification_status"] == "cancelled"
    assert [
        m["content"] for m in chat_store.list_messages("test-user", scope) if m["role"] == "system"
    ] == ["本轮请求超过最长 60 分钟，已停止。"]
