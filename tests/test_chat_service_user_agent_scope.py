import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat import backend_sdk
from novelvideo.chat import service as chat_service
from novelvideo.chat.store import ChatScope, chat_store


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_chat_visible_text_redacts_local_filesystem_paths():
    content = (
        "前端目录 ~/Works/supertale-fe，"
        "后端目录 /Users/tao/Works/SuperTale/state/admin/.hermes。"
    )

    redacted = chat_service._redact_local_filesystem_paths(content)

    assert "~/Works/supertale-fe" not in redacted
    assert "/Users/tao/Works/SuperTale" not in redacted
    assert redacted.count("[本地路径]") == 2


def test_completion_notice_appends_without_replacing_existing_reply():
    existing = "我已经检查完前置条件，下一步会启动第 1 个任务。"
    notice = "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。"

    merged = chat_service._completion_text_or_existing(notice, existing)

    assert merged.startswith(existing)
    assert notice in merged


def test_canvas_context_tool_result_infers_missing_status():
    payload = chat_routes.CanvasContextToolResultIn.model_validate(
        {
            "bridge_key": "bridge-a",
            "tool_call_status": "completed",
            "ok": True,
            "responses": [],
            "errors": [],
        }
    )

    assert payload.canvas_context_status is None


def test_infer_display_tool_call_recovers_sketch_display_promise():
    inferred = chat_service._infer_display_tool_call_from_text(
        "全部显示",
        "我来为您显示全部37个beat的草图。正在为您展示第1集前12个beat的草图：",
        [],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_infer_display_tool_call_uses_recent_context_for_short_reply():
    inferred = chat_service._infer_display_tool_call_from_text(
        "全部显示",
        "正在为您展示前12个。",
        ["如果您需要查看全部37个草图，我可以分页显示。"],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_infer_display_tool_call_ignores_progress_status_language():
    inferred = chat_service._infer_display_tool_call_from_text(
        "进度怎样了",
        "当前进度如下：草图生成已完成，下面展示进度表。",
        ["如果您需要查看全部37个草图，我可以分页显示。"],
    )

    assert inferred is None


def test_infer_display_tool_call_requires_user_sketch_display_intent():
    inferred = chat_service._infer_display_tool_call_from_text(
        "看一下第2集草图",
        "正在为您展示第2集草图。",
        [],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 2})


def test_infer_display_tool_call_uses_sketch_candidate_tool_for_pool_terms():
    inferred = chat_service._infer_display_tool_call_from_text(
        "看第1集 Beat 3 的草图候选池",
        "正在为您展示 Beat 3 的草图候选。",
        [],
    )

    assert inferred == ("dramaclaw_get_sketch_candidates", {"episode": 1, "beat": 3})


def test_extract_display_tool_call_uses_named_tool_field():
    inferred = chat_service._extract_display_tool_call(
        {
            "sessionUpdate": "tool_call",
            "title": "tool",
            "name": "dramaclaw_get_sketches",
            "content": [
                {
                    "type": "content",
                    "content": {"type": "text", "text": '{"episode": 1}'},
                }
            ],
        }
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_backend_api_get_default_uses_ipv4_loopback(monkeypatch):
    seen = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return None

        def read(self):
            return b'{"ok":true}'

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return FakeResponse()

    monkeypatch.delenv("DRAMACLAW_API_URL", raising=False)
    monkeypatch.delenv("SUPERTALE_API_URL", raising=False)
    monkeypatch.delenv("NOVELVIDEO_API_URL", raising=False)
    monkeypatch.setenv("NOVELVIDEO_API_PORT", "8780")
    monkeypatch.setattr(chat_service, "urlopen", fake_urlopen)

    assert chat_service._backend_api_get("/api/v1/config", "token") == {"ok": True}
    assert seen["url"] == "http://127.0.0.1:8780/api/v1/config"


def test_backend_api_get_ignores_stale_legacy_supertale_url(monkeypatch):
    seen = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return None

        def read(self):
            return b'{"ok":true}'

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return FakeResponse()

    monkeypatch.delenv("DRAMACLAW_API_URL", raising=False)
    monkeypatch.delenv("NOVELVIDEO_API_URL", raising=False)
    monkeypatch.setenv("SUPERTALE_API_URL", "http://localhost:7860")
    monkeypatch.setenv("NOVELVIDEO_API_PORT", "8780")
    monkeypatch.setattr(chat_service, "urlopen", fake_urlopen)

    assert chat_service._backend_api_get("/api/v1/config", "token") == {"ok": True}
    assert seen["url"] == "http://127.0.0.1:8780/api/v1/config"


@pytest.mark.anyio
async def test_append_chat_notification_persists_project_assistant_message(monkeypatch, tmp_path):
    seen = {}

    async def fake_project_context(user, scope):
        seen["scope"] = scope
        return SimpleNamespace(output_dir=tmp_path / "out", state_dir=tmp_path / "state")

    def fake_add_assistant_message(
        username,
        project,
        content,
        media=None,
        *,
        project_dir=None,
        project_state_dir=None,
    ):
        seen.update(
            {
                "username": username,
                "project": project,
                "content": content,
                "project_dir": project_dir,
                "project_state_dir": project_state_dir,
            }
        )
        return {"id": "1", "role": "assistant", "content": content}

    monkeypatch.setattr(chat_routes, "_project_context_for_scope", fake_project_context)
    monkeypatch.setattr(
        chat_routes.chat_service,
        "add_assistant_message",
        fake_add_assistant_message,
    )

    result = await chat_routes.append_chat_notification(
        chat_routes.ChatNotificationIn(
            scope=chat_routes.ChatScopePayload(kind="project", id="demo"),
            text="  任务已完成。  ",
        ),
        user={"username": "alice"},
    )

    assert result == {
        "ok": True,
        "data": {"id": "1", "role": "assistant", "content": "任务已完成。"},
    }
    assert seen["username"] == "alice"
    assert seen["project"] == "demo"
    assert seen["content"] == "任务已完成。"
    assert seen["project_dir"] == tmp_path / "out"
    assert seen["project_state_dir"] == tmp_path / "state"


@pytest.mark.anyio
async def test_deterministic_stream_redacts_local_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    events = []

    async def on_event(event):
        events.append(event)

    message = await chat_service._stream_deterministic_assistant_reply(
        "admin",
        "project-a",
        "临时路径：~/Works/supertale-fe/src",
        on_event,
    )

    assert "~/Works/supertale-fe" not in message["content"]
    assert message["content"] == "临时路径：[本地路径]"
    assert events[0]["type"] == "assistant_delta"
    assert events[0]["text"] == "临时路径：[本地路径]"


@pytest.mark.anyio
async def test_fallback_display_does_not_use_pool_sketch_as_current_sketch(
    monkeypatch,
    tmp_path,
):
    project_dir = tmp_path / "project"
    sketch_dir = project_dir / "grids" / "ep001" / "sketch"
    sketch_dir.mkdir(parents=True)
    (sketch_dir / "beat_01_t123.png").write_bytes(b"fake")

    monkeypatch.setattr(
        chat_service,
        "_backend_api_get",
        lambda path, token: {
            "ok": True,
            "beats": [
                {
                    "beat_number": 1,
                    "sketch_url": "",
                    "frame_url": "",
                }
            ],
        },
    )

    specs = await chat_service._fallback_display_tool_ui_specs(
        "admin",
        "project-a",
        "dramaclaw_get_sketches",
        {"episode": 1},
        token="token",
        project_dir=project_dir,
    )

    assert specs == []


@pytest.mark.anyio
async def test_fallback_display_prefers_api_project_id(monkeypatch):
    seen_paths = []

    def fake_backend_api_get(path, token):
        seen_paths.append(path)
        return {
            "ok": True,
            "beats": [
                {
                    "beat_number": 1,
                    "sketch_url": "/static/projects/api-project/sketch.png?v=1",
                    "frame_url": "",
                }
            ],
        }

    monkeypatch.setattr(chat_service, "_backend_api_get", fake_backend_api_get)

    specs = await chat_service._fallback_display_tool_ui_specs(
        "local",
        "chat-scope",
        "dramaclaw_get_sketches",
        {"episode": 1, "project_id": "api-project"},
        token="token",
    )

    assert seen_paths == ["/api/v1/projects/api-project/episodes/1/beats"]
    assert len(specs) == 1
    root = specs[0]["root"]
    first_child = specs[0]["elements"][root]["children"][0]
    assert specs[0]["elements"][first_child]["props"]["src"] == "/static/projects/api-project/sketch.png?v=1"


def test_claude_and_codex_sessions_are_scope_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    chat_service._set_claude_session_id("admin", "project-a", "claude-session-1")
    assert chat_service._get_claude_session_id("admin", "project-b") == "claude-session-1"
    assert chat_service._get_codex_thread_id("admin", "project-b") is None

    chat_service._set_codex_thread_id("admin", "project-a", "codex-thread-1")
    assert chat_service._get_claude_session_id("admin", "project-b") is None
    assert chat_service._get_codex_thread_id("admin", "project-b") == "codex-thread-1"

    state_file = tmp_path / "state" / "admin" / "agent_sessions.json"
    assert state_file.exists()


def test_user_agent_workspace_is_not_project_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    chat_service.ensure_user_claude_workspace("admin", "project-a")
    chat_service.ensure_user_codex_workspace("admin", "project-a")

    workspace = chat_service._user_agent_workspace("admin")
    assert workspace == tmp_path / "state" / "admin" / ".chat_agents"
    assert (workspace / ".claude" / "settings.local.json").exists()
    assert (workspace / ".claude" / "skills").is_dir()
    assert (workspace / ".codex" / "skills").is_dir()

    project_workspace = Path(tmp_path / "output" / "admin" / "project-a")
    assert not (project_workspace / ".claude").exists()
    assert not (project_workspace / ".codex").exists()


def test_dramaclaw_mcp_server_config_is_agent_neutral():
    servers = chat_service._dramaclaw_mcp_servers()

    assert servers["dramaclaw"]["type"] == "stdio"
    assert servers["dramaclaw"]["args"] == ["-m", "novelvideo.chat.dramaclaw_mcp"]


def test_codex_client_carries_dramaclaw_mcp_servers(tmp_path):
    overrides = chat_service._codex_mcp_config_overrides(chat_service._dramaclaw_mcp_servers())

    expected_command = json.dumps(__import__("sys").executable, ensure_ascii=False)
    assert f"mcp_servers.dramaclaw.command={expected_command}" in overrides
    assert 'mcp_servers.dramaclaw.args=["-m","novelvideo.chat.dramaclaw_mcp"]' in overrides

    client = backend_sdk.CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env={"DRAMACLAW_AGENT_TOKEN": "token"},
        model="gpt-5.4",
        config_overrides=overrides,
    )

    thread = client.thread_start()

    assert thread._config_overrides == overrides


def test_explicit_codex_does_not_fallback_when_unavailable(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "codex")
    monkeypatch.delenv("SUPERTALE_CHAT_BACKEND", raising=False)
    monkeypatch.setattr(chat_service, "is_codex_backend_available", lambda: False)
    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(chat_service, "is_claude_backend_available", lambda: True)

    with pytest.raises(RuntimeError, match="DRAMACLAW_CHAT_BACKEND=codex requested"):
        chat_service._chat_backend()


def test_codex_backend_uses_sdk_runtime_by_default(monkeypatch):
    monkeypatch.delenv("CODEX_BIN", raising=False)
    monkeypatch.setattr(
        chat_service.importlib.util,
        "find_spec",
        lambda name: object() if name == "openai_codex" else None,
    )

    assert chat_service._codex_bin_path() is None
    assert chat_service.is_codex_backend_available() is True


def test_codex_backend_validates_explicit_binary(monkeypatch, tmp_path):
    missing_bin = tmp_path / "missing-codex"
    monkeypatch.setenv("CODEX_BIN", str(missing_bin))
    monkeypatch.setattr(
        chat_service.importlib.util,
        "find_spec",
        lambda name: object() if name == "openai_codex" else None,
    )

    assert chat_service._codex_bin_path() == missing_bin
    assert chat_service.is_codex_backend_available() is False


def test_chat_run_lock_is_user_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
            chat_service._acquire_chat_run_lock("admin", "project-b")
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)

    next_lock_id = chat_service._acquire_chat_run_lock("admin", "project-b")
    chat_service._release_chat_run_lock("admin", "project-b", next_lock_id)


def test_freezone_chat_run_lock_is_agent_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    first_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-1",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    first_lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
        store_scope=first_scope,
    )
    second_lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
        store_scope=second_scope,
    )

    first_lock_id = chat_service._acquire_chat_run_lock("admin", first_lock_project)
    try:
        second_lock_id = chat_service._acquire_chat_run_lock("admin", second_lock_project)
        chat_service._release_chat_run_lock("admin", second_lock_project, second_lock_id)
    finally:
        chat_service._release_chat_run_lock("admin", first_lock_project, first_lock_id)


def test_director_chat_run_lock_remains_project_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="default",
        store_scope=ChatScope(
            kind="project",
            id="project-a",
            surface="director",
            agent_id="agent-2",
        ),
    )

    assert lock_project == "project-a"


def test_chat_run_lock_uses_named_agent_locks_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")

    assert lock_path.parent == tmp_path / "state" / "admin" / "chat_agent_locks"
    assert lock_path.name.endswith(".lock")


def test_chat_run_lock_file_expires_after_ten_minutes(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    assert chat_service._CHAT_RUN_LOCK_TTL_SECONDS == 10 * 60

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    stale_started_at = datetime.now(timezone.utc) - timedelta(seconds=10 * 60 + 1)
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "stale-lock",
                "owner_pid": os.getpid(),
                "started_at": stale_started_at.isoformat(),
            }
        ),
        encoding="utf-8",
    )

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_id != "stale-lock"
        assert lock_path.exists()
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_uses_updated_at_for_idle_timeout(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    old_started_at = datetime.now(timezone.utc) - timedelta(seconds=10 * 60 + 1)
    fresh_updated_at = datetime.now(timezone.utc)
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "active-long-run",
                "owner_pid": os.getpid(),
                "started_at": old_started_at.isoformat(),
                "updated_at": fresh_updated_at.isoformat(),
            }
        ),
        encoding="utf-8",
    )

    assert chat_service.chat_run_lock_is_active("admin", "project-a") is True
    with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
        chat_service._acquire_chat_run_lock("admin", "project-a")


def test_chat_run_lock_still_has_max_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    too_old_started_at = datetime.now(timezone.utc) - timedelta(
        seconds=chat_service._CHAT_RUN_LOCK_MAX_SECONDS + 1
    )
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "too-old-lock",
                "owner_pid": os.getpid(),
                "started_at": too_old_started_at.isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ),
        encoding="utf-8",
    )

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_id != "too-old-lock"
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_heartbeat_refreshes_updated_at(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    atomic_writes = []
    original_atomic_write = chat_service._atomic_write_chat_run_lock_file

    def spy_atomic_write(path, payload):
        atomic_writes.append((path, payload))
        original_atomic_write(path, payload)

    monkeypatch.setattr(chat_service, "_atomic_write_chat_run_lock_file", spy_atomic_write)

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    try:
        _current_lock_id, _owner_pid, started_at, updated_at = chat_service._read_chat_run_lock_file(
            lock_path
        )
        assert started_at is not None
        assert updated_at is not None
        old_updated_at = started_at - timedelta(seconds=30)
        lock_path.write_text(
            json.dumps(
                {
                    "lock_id": lock_id,
                    "owner_pid": os.getpid(),
                    "started_at": started_at.isoformat(),
                    "updated_at": old_updated_at.isoformat(),
                }
            ),
            encoding="utf-8",
        )

        assert chat_service._heartbeat_chat_run_lock("admin", "project-a", lock_id) is True
        assert len(atomic_writes) == 1
        assert atomic_writes[0][0] == lock_path
        assert json.loads(atomic_writes[0][1])["lock_id"] == lock_id
        refreshed_lock_id, _owner_pid, refreshed_started_at, refreshed_updated_at = (
            chat_service._read_chat_run_lock_file(lock_path)
        )
        assert refreshed_lock_id == lock_id
        assert refreshed_started_at == started_at
        assert refreshed_updated_at is not None
        assert refreshed_updated_at > old_updated_at
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_treats_new_empty_lock_as_active(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    lock_path.write_text("", encoding="utf-8")

    with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
        chat_service._acquire_chat_run_lock("admin", "project-a")

    assert lock_path.exists()


def test_chat_run_lock_removes_old_invalid_lock(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    lock_path.write_text("", encoding="utf-8")
    old_mtime = (
        datetime.now(timezone.utc).timestamp()
        - chat_service._CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS
        - 1
    )
    os.utime(lock_path, (old_mtime, old_mtime))

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_path.exists()
        assert chat_service._read_chat_run_lock_file(lock_path)[0] == lock_id
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


@pytest.mark.anyio
async def test_reingest_confirmation_reply_bypasses_agent_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        chat_service,
        "_chat_backend",
        lambda: pytest.fail("reingest confirmation should not call the agent backend"),
    )
    events = []

    async def on_event(event):
        events.append(event)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        """创建视频

[DRAMACLAW_REINGEST_CONFIRMATION]
stage: choose_overwrite
dramaclaw_project_id: project-a
filename: novel.docx
[/DRAMACLAW_REINGEST_CONFIRMATION]""",
        on_event,
    )

    assert "当前项目已有摄入内容" in result["content"]
    assert "覆盖" in result["content"]
    assert "新建项目" not in result["content"]
    assert [event["type"] for event in events] == ["assistant_delta", "done"]


@pytest.mark.anyio
async def test_reingest_final_confirmation_reply_bypasses_agent_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        chat_service,
        "_chat_backend",
        lambda: pytest.fail("reingest confirmation should not call the agent backend"),
    )

    async def on_event(event):
        pass

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        """覆盖

[DRAMACLAW_REINGEST_CONFIRMATION]
stage: confirm_clear
dramaclaw_project_id: project-a
filename: novel.docx
[/DRAMACLAW_REINGEST_CONFIRMATION]""",
        on_event,
    )

    assert "会清空/重建当前项目已有角色" in result["content"]
    assert "确定" in result["content"]
    assert "新建项目" not in result["content"]


def test_prompt_injects_json_render_contract(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "查看肖像图片，用 json-render 显示",
    )

    assert "[RENDERING_CONTRACT]" in prompt
    assert "才需要调用对应的 DramaClaw 展示工具" in prompt
    assert "不要向用户解释内部渲染格式、渲染机制、工具调用过程或工具名" in prompt
    assert "不要用文字列表、文件名列表、Beat 名称列表或 URL 列表替代媒体展示" in prompt
    assert "必须调用对应展示工具" in prompt
    assert "若没有工具返回的可展示媒体，只说明当前暂无可展示媒体" in prompt
    assert "后端会自动把工具结果渲染为 json-render" not in prompt
    assert "不要手写、复制或粘贴 <ui-spec> JSON" not in prompt
    assert "dramaclaw_get_character_media" in prompt
    assert "dramaclaw_get_sketches" in prompt
    assert "dramaclaw_get_scene_images" in prompt
    assert "dramaclaw_get_episode_media" in prompt
    assert "只有在回复需要展示图片、肖像、身份图、草图、首帧、视频、音频等可视/可播放媒体时" in prompt
    assert "media_json" in prompt
    assert "不要猜测、拼接或改写静态资源路径" in prompt
    assert "禁止自行编造 /static/projects/{project_id}/..." in prompt
    assert "portrait_url" in prompt
    assert "image_url" in prompt
    assert "video_url" in prompt
    assert "不要使用 *_path" in prompt
    assert "发送前自检" in prompt
    assert "角色列表、剧集规划、项目进度、任务状态、脚本/beat 摘要、表格、长篇正文、普通结构化说明默认使用 markdown" in prompt
    assert "不要为纯文本、进度、脚本、表格、角色/剧集清单调用媒体展示工具" in prompt
    assert prompt.rstrip().endswith("查看肖像图片，用 json-render 显示")


def test_freezone_prompt_allows_creative_ideation_canvas_framework_without_mainline_generation(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "我想做个公益短片没思路",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "creative ideation" in prompt
    assert "working Freezone canvas material" in prompt
    assert "command catalog" in prompt
    assert "node create schema" in prompt
    assert "link type catalog" in prompt
    assert "MUST call a Freezone" in prompt
    assert "first assistant output MUST be the Freezone write" in prompt
    assert "Do not emit assistant prose" in prompt
    assert "matching single-operation write tool" in prompt
    assert "If no write tool succeeds" in prompt
    assert "Validate multi-step or edge-creating commands" in prompt
    assert "submit one validated Freezone canvas command batch" in prompt
    assert "do not write nodes step by step" in prompt
    assert "Freezone canvas tools" in prompt
    assert "generate complete short videos" in prompt
    assert "video, audio, and composition nodes" in prompt
    assert "videoComposeNode is the final timeline/composition node" in prompt
    assert "do not connect planning text, briefs, or prompts directly into videoComposeNode" in prompt
    assert "Do not use mainline production tools" in prompt
    assert "Do not start or mutate the main video-production pipeline" in prompt
    assert "do not generate/plan scripts" not in prompt


def test_freezone_prompt_omits_skill_studio_contract_for_normal_canvas_requests(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "加一个视频节点",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt


def test_freezone_prompt_routes_skill_studio_by_user_text_not_canvas_context(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        (
            "查看下当前节点详情然后返回ok\n\n"
            "[SUPERTALE_CANVAS_NODE_REFERENCES]\n"
            "node_type: skillNode\n"
            "available_actions: add_next_node, run_skill\n"
            "[/SUPERTALE_CANVAS_NODE_REFERENCES]"
        ),
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
        route_prompt="查看下当前节点详情然后返回ok",
    )

    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt
    assert "node_type: skillNode" in prompt
    assert "available_actions: add_next_node, run_skill" in prompt


def test_freezone_prompt_includes_clarification_card_rule_for_interactive_questions(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "你给我提几个问题测试一下我对重庆了解多少",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "选择式澄清/互动类" in prompt
    assert "freezone_request_user_clarification" in prompt
    assert "不要询问内部实现细节" in prompt
    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt


def test_freezone_prompt_includes_skill_studio_contract_only_for_catalog_intent(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "帮我创建一个电商详情页 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "freezone_request_user_clarification" in prompt
    assert "freezone_begin_agent_catalog_draft" in prompt
    assert "freezone_patch_agent_catalog_draft" in prompt
    assert "freezone_put_agent_catalog_recipe" in prompt
    assert "freezone_finish_agent_catalog_draft" in prompt
    assert "For local edits, prefer freezone_patch_agent_catalog_draft" in prompt
    assert "Do not regenerate unchanged Recipes" in prompt
    assert "expected_recipe_count" in prompt
    assert "Use 0 only when the draft intentionally has no Recipes" in prompt
    assert "Do not pass the full Skill/Recipe catalog in one tool call" in prompt
    assert "skill_studio_session_id" in prompt
    assert "Do not claim the Skill or Recipe is saved" in prompt
    assert "Do not ask whether to\n  save the current draft" in prompt
    assert "save_now/save_current/confirm_save" in prompt
    assert "prompt/instruction generator" in prompt
    assert "不要直接生成最终内容" in prompt
    assert "送入对应节点" in prompt
    assert "planning.planning_notes must start with an executable path summary" in prompt
    assert "planning.conduct_rules must include hard execution rules" in prompt
    assert "workflow_templates[].condition should be machine-readable" in prompt
    assert '{"type":"previous_step","step_id":"..."}' in prompt
    assert "workflow_templates[].steps[] should include aspect_ratio" in prompt
    assert "Recipe system_prompt must never be the final downstream prompt itself" in prompt
    assert "重要：你的输出是一条提示词/指令" in prompt
    assert "终端生成型" not in prompt
    assert "不要把所有 Recipe 都写成 prompt compiler" not in prompt
    assert "must not emit Freezone canvas commands" in prompt


def test_freezone_prompt_separates_new_skill_from_current_canvas_context(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "我想做一个制作公益短片的 skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "new_from_user_brief" in prompt
    assert "current canvas is ambient context, not source evidence" in prompt
    assert "Do not ask whether to preserve current project details" in prompt
    assert "topic/domain, audience/context, artifact scope, style/tone, and workflow granularity" in prompt
    assert "distill_from_canvas" in prompt


def test_freezone_prompt_requires_summary_confirmation_for_canvas_workflow_skill(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "把当前流程保存成 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "distill_from_canvas" in prompt
    assert "current canvas, current flow, selected nodes, this project, this workflow, or existing workflow" in prompt
    assert "ask 1-2 high-level confirmation questions first" in prompt
    assert "preserve project-specific details or abstract them into a reusable Skill" in prompt
    assert "split key generator/planner capabilities into Recipes or merge them into fewer Recipes" in prompt
    assert "freezone_request_user_clarification" in prompt


def test_freezone_prompt_requires_canvas_workflow_distillation_rules(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "帮我把当前画布总结成一个 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "skill-studio-authoring-guide.md" in prompt
    assert "canvas_workflow_analysis" in prompt
    assert "Use canvas ontology or canvas summary first for whole-canvas Skill distillation" in prompt
    assert "Do not read every node detail one by one" in prompt
    assert "Do not treat tool schemas as authoring guidance" in prompt
    assert "capability modeling" in prompt
    assert "schema fields are final serialization constraints" in prompt
    assert "Do not ask for Skill name, category, or whether to include workflow templates" in prompt
    assert "concrete case vs reusable template" in prompt
    assert "recipe granularity" in prompt
    assert "If the user selects or already submitted workflow-template inclusion" in prompt
    assert "workflow_templates" in prompt
    assert "node_type=videoCompose" in prompt
    assert "Do not create a Recipe for videoCompose" in prompt
    assert "Do not present videoCompose, final media composition, or final synthesis as a Recipe granularity option" in prompt
    assert "do not count the videoCompose terminal step in the Recipe count" in prompt
    assert "textGeneration Recipe for a compose/timeline plan" in prompt
    assert "Extract hard constraints from repeated prompt text" in prompt
    assert "perform prompt_evidence_analysis before topology summarization" in prompt
    assert "domain_contract or creative_contract" in prompt
    assert "repeated prompt phrases, media facts, source filenames, references, and edges" in prompt
    assert "not from displayName or node type alone" in prompt
    assert "Write the domain_contract or creative_contract into existing fields: planning_notes, conduct_rules, evaluation.domain_constraints, workflow step descriptions, and Recipe quality standards" in prompt
    assert "perform skill_identity_analysis after prompt_evidence_analysis" in prompt
    assert "case_variables, reusable_protocol_terms, output_format_terms, use_case_terms, and workflow_method_terms" in prompt
    assert "Skill name, id, description, and triggers.keywords" in prompt
    assert "remove case_variables but preserve reusable_protocol_terms" in prompt
    assert "Do not let workflow_method_terms alone dominate the Skill identity" in prompt
    assert "keywords must cover protocol, output format, use case, and workflow method" in prompt
    assert "Visual projects may need global visual language, stage-specific style exceptions, and style inheritance rules" in prompt
    assert "Pixar 3D cartoon, C4D + Octane, soft studio lighting" in prompt
    assert "storyboard may require black-and-white pencil sketch instead of inheriting rendered 3D color" in prompt
    assert "videoCompose does not generate new creative content" in prompt
    assert "For non-visual domains, the same contract may capture metric definitions, legal jurisdiction, teaching level, voice persona, or gameplay rules" in prompt
    assert "Do not derive Recipes only from node types" in prompt


def test_tool_mode_infers_freezone_from_frontend_canvas_injection():
    prompt = """加个视频节点

[SUPERTALE_CANVAS_ROUTING]
Current surface is Freezone canvas.
[/SUPERTALE_CANVAS_ROUTING]"""

    assert chat_service._tool_mode_for_surface(None, prompt=prompt) == "freezone_canvas"


def test_tool_mode_infers_freezone_from_canvas_context():
    assert (
        chat_service._tool_mode_for_surface(
            None,
            surface_context={"freezone_canvas_id": "canvas-a"},
        )
        == "freezone_canvas"
    )


def test_project_media_uses_project_id_url_and_explicit_project_dir(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")

    media = chat_service._extract_media(
        "use frames/ep001/beat_01.png",
        "admin",
        "01KS_PROJECT_ID",
        project_dir=project_dir,
    )

    assert media == [
        {
            "kind": "image",
            "url": f"/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png?v={image.stat().st_mtime_ns}",
            "path": "frames/ep001/beat_01.png",
            "label": "beat_01.png",
        }
    ]


def test_markdown_project_image_is_not_duplicated_as_media(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")

    media = chat_service._extract_media(
        "![frame](/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png)",
        "admin",
        "01KS_PROJECT_ID",
        project_dir=project_dir,
    )

    assert media == []


def test_markdown_project_image_filters_normalized_media_item(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")
    url = f"/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png?v={image.stat().st_mtime_ns}"

    media = chat_service._filter_markdown_duplicate_images(
        "![frame](/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png)",
        [
            {
                "kind": "image",
                "url": url,
                "path": "frames/ep001/beat_01.png",
                "label": "beat_01.png",
            }
        ],
    )

    assert media == []


def test_project_chat_storage_uses_resolved_project_state_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    project_dir = tmp_path / "output" / "admin" / "demo"
    project_state_dir = tmp_path / "managed-state" / "projects" / "01KS_PROJECT_ID"
    project_dir.mkdir(parents=True)
    project_state_dir.mkdir(parents=True)

    chat_service.add_user_message(
        "admin",
        "01KS_PROJECT_ID",
        "hello",
        project_dir=project_dir,
        project_state_dir=project_state_dir,
    )

    assert (project_state_dir / "chat.db").exists()
    assert not (tmp_path / "state" / "admin" / "01KS_PROJECT_ID").exists()
    assert not (tmp_path / "output" / "admin" / "01KS_PROJECT_ID").exists()


def test_project_chat_storage_creates_missing_resolved_state_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    project_state_dir = tmp_path / "managed-state" / "missing-project"

    chat_service.add_user_message(
        "admin",
        "01KS_PROJECT_ID",
        "hello",
        project_state_dir=project_state_dir,
    )

    assert (project_state_dir / "chat.db").exists()
    assert not (tmp_path / "state" / "admin" / "01KS_PROJECT_ID").exists()


def test_project_history_hides_trace_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    chat_service.add_user_message("admin", "project-a", "你好")
    chat_service.add_trace_message("admin", "project-a", "→ dramaclaw_pipeline_status\ncompleted")
    chat_service.add_assistant_message("admin", "project-a", "你好！")

    messages = chat_service.list_messages("admin", "project-a")

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert all("dramaclaw_pipeline_status" not in message["content"] for message in messages)


def test_project_history_defaults_to_last_50_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    for index in range(60):
        chat_service.add_assistant_message("admin", "project-a", f"message-{index:02d}")

    messages = chat_service.list_messages("admin", "project-a")

    assert len(messages) == 50
    assert messages[0]["content"] == "message-10"
    assert messages[-1]["content"] == "message-59"


def test_home_history_hides_trace_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")

    chat_store.append_message("admin", scope, "user", "你好")
    chat_store.append_message("admin", scope, "trace", "→ dramaclaw_pipeline_status\ncompleted")
    chat_store.append_message("admin", scope, "assistant", "你好！")

    messages = chat_store.list_messages("admin", scope)

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert all("dramaclaw_pipeline_status" not in message["content"] for message in messages)


def test_chat_history_keeps_repeated_assistant_replies_across_turns(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")

    chat_store.append_message("admin", scope, "user", "你好", turn_id="turn-1")
    chat_store.append_message("admin", scope, "assistant", "你好！有什么可以帮你？", turn_id="turn-1")
    chat_store.append_message("admin", scope, "user", "你好", turn_id="turn-2")
    chat_store.append_message("admin", scope, "assistant", "你好！有什么可以帮你？", turn_id="turn-2")

    messages = chat_store.list_messages("admin", scope)

    assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant"]
    assert messages[1]["content"] == "你好！有什么可以帮你？"
    assert messages[3]["content"] == "你好！有什么可以帮你？"


def test_freezone_history_uses_separate_project_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    chat_service.add_user_message("admin", "project-a", "mainline")
    scope = ChatScope(kind="project", id="project-a", surface="freezone", canvas_id="canvas-a")
    chat_store.append_message("admin", scope, "user", "canvas")

    assert chat_service.list_messages("admin", "project-a")[0]["content"] == "mainline"
    assert chat_store.list_messages("admin", scope)[0]["content"] == "canvas"
    assert (state_root / "admin" / "project-a" / "chat.db").exists()
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "main"
        / "chat.db"
    ).exists()


def test_freezone_agent_history_uses_separate_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    main_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    chat_store.append_message("admin", main_scope, "user", "main agent")
    chat_store.append_message("admin", second_scope, "user", "second agent")

    assert chat_store.list_messages("admin", main_scope)[0]["content"] == "main agent"
    assert chat_store.list_messages("admin", second_scope)[0]["content"] == "second agent"
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "agent-2"
        / "chat.db"
    ).exists()


def test_freezone_canvas_agent_summaries_pick_recent_server_agent(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    main_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    other_canvas_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-b",
        agent_id="agent-3",
    )

    chat_store.append_message("admin", main_scope, "user", "主会话")
    chat_store.append_message("admin", other_canvas_scope, "user", "别的画布")
    chat_store.append_message("admin", second_scope, "user", "最近的服务端会话标题很长需要截断")
    chat_store.append_message("admin", second_scope, "assistant", "agent-2 reply")

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert [summary["id"] for summary in summaries] == ["agent-2", "main"]
    assert summaries[0]["name"] == "最近的服务端会话标题很长需要截断"
    assert summaries[0]["lastActiveAt"] > summaries[1]["lastActiveAt"]


def test_freezone_canvas_agent_summaries_default_to_latest_twenty(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    for index in range(25):
        scope = ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
            agent_id=f"agent-{index + 1}",
        )
        chat_store.append_message("admin", scope, "user", f"agent {index + 1}")

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert len(summaries) == 20
    assert summaries[0]["id"] == "agent-25"
    assert summaries[-1]["id"] == "agent-6"


def test_freezone_canvas_agent_summaries_tie_break_same_millisecond(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    for index in range(25):
        scope = ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
            agent_id=f"agent-{index + 1}",
        )
        chat_store.append_message("admin", scope, "user", f"agent {index + 1}")

    def same_time_summary(agent_id, _db_path):
        return {
            "id": agent_id,
            "name": agent_id,
            "createdAt": 1000,
            "lastActiveAt": 1000,
        }

    monkeypatch.setattr(chat_store, "_freezone_agent_summary_from_db", same_time_summary)

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert [summary["id"] for summary in summaries] == [f"agent-{index}" for index in range(25, 5, -1)]


@pytest.mark.anyio
async def test_freezone_hermes_assistant_message_keeps_turn_id(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    events = []

    class FakeThread:
        async def stream(self, _prompt, *, current_project=None):
            yield backend_sdk.ChatBackendEvent(type="thread_started", thread_id="thread-a", turn_id="turn-a")
            yield backend_sdk.ChatBackendEvent(type="assistant_delta", text="你好")
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        async def get_for_user(self, *_args, **_kwargs):
            return FakeThread()

    async def on_event(event):
        events.append(event)

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", FakePool())

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "你好",
        on_event,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert result["turn_id"] == "turn-a"
    messages = chat_store.list_messages("admin", scope)
    assistant = [message for message in messages if message["role"] == "assistant"][0]
    assert assistant["turn_id"] == "turn-a"


def test_freezone_main_agent_reads_legacy_canvas_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    legacy_db = state_root / "admin" / "project-a" / "_chat" / "freezone" / "canvas-a" / "chat.db"
    conn = chat_store.connect("admin", scope, db_path=legacy_db)
    try:
        conn.execute(
            """
            INSERT INTO chat_messages (role, content, media_json, turn_id, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("user", "legacy canvas", "[]", None, "{}", datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()

    assert chat_store.list_messages("admin", scope)[0]["content"] == "legacy canvas"

    chat_store.append_message("admin", scope, "user", "new main")

    assert chat_store.list_messages("admin", scope)[0]["content"] == "new main"
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "main"
        / "chat.db"
    ).exists()


def test_director_history_path_ignores_agent_id(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "director",
            "agentId": "agent-2",
        }
    )
    chat_store.append_message("admin", scope, "user", "director")

    assert scope == ChatScope(kind="project", id="project-a", surface="director")
    assert (state_root / "admin" / "project-a" / "chat.db").exists()
    assert not (state_root / "admin" / "project-a" / "_chat").exists()


def test_chat_ui_events_attach_to_user_message_when_turn_has_no_assistant(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="project", id="project-a", surface="freezone", canvas_id="canvas-a")

    chat_store.append_message("admin", scope, "user", "加个视频节点", turn_id="turn-a")
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {
            "type": "canvas_command_approval",
            "schema_version": "canvas_command_approval.v1",
            "canvas_id": "canvas-a",
            "bridge_key": "bridge-a",
            "envelopes": [],
        },
    )

    messages = chat_store.list_messages("admin", scope)

    assert messages[0]["role"] == "user"
    assert messages[0]["ui_events"][0]["type"] == "canvas_command_approval"


def test_chat_message_parts_keep_canvas_feedback_after_stale_snapshot(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="project", id="project-a", surface="freezone", canvas_id="canvas-a")

    chat_store.append_message("admin", scope, "user", "生成下分镜", turn_id="turn-a")
    chat_store.append_message("admin", scope, "assistant", "", turn_id="turn-a")
    context_part = {
        "id": "canvas_context:context:bridge-a:validation",
        "type": "canvas_context",
        "event": {
            "key": "context:bridge-a:validation",
            "bridgeKey": "bridge-a:validation",
            "status": "done",
            "errors": [],
        },
    }
    approval_part = {
        "id": "canvas_approval:bridge:bridge-a:turn:turn-a",
        "type": "canvas_approval",
        "event": {
            "key": "bridge:bridge-a:turn:turn-a",
            "bridgeKey": "bridge-a",
        },
    }
    feedback_part = {
        "id": "canvas_feedback:bridge:bridge-a:turn:turn-a",
        "type": "canvas_feedback",
        "event": {
            "key": "bridge:bridge-a:turn:turn-a",
            "errors": ["节点动作完成但未产出 imageUrl。"],
        },
    }

    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part, approval_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part, feedback_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part]},
    )

    messages = chat_store.list_messages("admin", scope)
    assistant = next(message for message in messages if message["role"] == "assistant")
    part_types = [part["type"] for part in assistant["parts"]]
    feedback = next(part for part in assistant["parts"] if part["type"] == "canvas_feedback")

    assert "canvas_feedback" in part_types
    assert "canvas_approval" not in part_types
    assert feedback["event"]["errors"] == ["节点动作完成但未产出 imageUrl。"]


def test_chat_message_parts_drop_stale_skill_studio_status_snapshot(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="project", id="project-a", surface="freezone", canvas_id="canvas-a")

    chat_store.append_message("admin", scope, "user", "做一个公益短片 skill", turn_id="turn-a")
    chat_store.append_message("admin", scope, "assistant", "草稿已生成。", turn_id="turn-a")
    question_part = {
        "id": "skill_studio.questions:question-key",
        "type": "skill_studio",
        "event": {
            "type": "skill_studio.questions",
            "bridge_key": "question-key",
            "submitted": True,
            "questions": [],
        },
    }
    status_part = {
        "id": "skill_studio.status:skill_studio.status",
        "type": "skill_studio",
        "event": {
            "type": "skill_studio.status",
            "status": "draft_patch_applied",
            "message": "已更新 Recipe: public-welfare-storyboard-images",
        },
    }
    text_part = {"id": "text-3", "type": "text", "text": "草稿已生成。"}

    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [status_part, question_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [question_part, text_part]},
    )

    messages = chat_store.list_messages("admin", scope)
    assistant = next(message for message in messages if message["role"] == "assistant")

    assert [part["type"] for part in assistant["parts"]] == ["skill_studio", "text"]
    assert [part.get("event", {}).get("type") for part in assistant["parts"] if part["type"] == "skill_studio"] == [
        "skill_studio.questions"
    ]


def test_chat_scope_round_trips_freezone_canvas_payload() -> None:
    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "freezone",
            "canvasId": "canvas-a",
            "agentId": "agent-2",
        }
    )

    assert scope == ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    assert scope.to_dict() == {
        "kind": "project",
        "id": "project-a",
        "surface": "freezone",
        "canvasId": "canvas-a",
        "agentId": "agent-2",
    }


def test_chat_scope_defaults_freezone_agent_to_main() -> None:
    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "freezone",
            "canvasId": "canvas-a",
        }
    )

    assert scope.agent_id == "main"
    assert scope.to_dict()["agentId"] == "main"


def test_hermes_workspace_profile_treats_freezone_agent_profiles_as_freezone() -> None:
    from novelvideo.chat import hermes_pool

    assert hermes_pool._workspace_profile_for_agent("freezone:agent-2", "freezone_canvas", "freezone") == "freezone"
    assert hermes_pool._workspace_profile_for_agent("main", "default", None) == "director"


def test_legacy_freezone_scope_still_uses_legacy_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope(kind="freezone", id="project-a")
    chat_store.append_message("admin", scope, "user", "legacy")

    assert chat_store.list_messages("admin", scope)[0]["content"] == "legacy"
    assert (state_root / "admin" / "_freezone" / "project-a" / "chat.db").exists()


def test_json_render_reply_normalizer_unwraps_fenced_ui_spec():
    content = """请查看：

```json-render
<ui-spec>
{
  "type": "character_showcase",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack",
      "props": {},
      "children": ["portrait"]
    },
    "portrait": {
      "type": "Image",
      "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
      "children": []
    }
  }
}
</ui-spec>
```"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "```" not in normalized
    assert '<ui-spec type="character_showcase">' in normalized
    assert '"type": "Image"' in normalized


def test_json_render_reply_normalizer_repairs_missing_trailing_brace():
    content = """<ui-spec>{"type":"character_showcase","root":"root","elements":{"root":{"type":"Stack","props":{},"children":[]}}</ui-spec>"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert '"elements": {' in normalized
    assert normalized.rstrip().endswith("</ui-spec>")


def test_json_render_reply_normalizer_repairs_legacy_component_children_props():
    content = """<ui-spec>
{
  "type": "script_overview",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack",
      "props": {"row": false, "gap": 12},
      "children": ["heading", "badge", "body"]
    },
    "heading": {
      "type": "Heading",
      "props": {"level": 3, "children": "第 1 集脚本概览"},
      "children": []
    },
    "badge": {
      "type": "Badge",
      "props": {"children": "completed", "variant": "success"},
      "children": []
    },
    "body": {
      "type": "Text",
      "props": {"children": "脚本已经生成完成。", "variant": "body"},
      "children": []
    }
  }
}
</ui-spec>"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert '"direction": "column"' in normalized
    assert '"content": "第 1 集脚本概览"' in normalized
    assert '"label": "completed"' in normalized
    assert '"content": "脚本已经生成完成。"' in normalized
    assert '"children": "脚本已经生成完成。"' not in normalized


def test_json_render_reply_normalizer_blocks_invalid_ui_spec():
    content = "<ui-spec>{not json}</ui-spec>"

    normalized = chat_service._normalize_json_render_reply(content)

    assert "<ui-spec>" not in normalized
    assert "格式校验失败" in normalized


def test_json_render_reply_normalizer_accepts_media_bundle_array():
    spec_a = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
                "children": [],
            },
        },
    }
    spec_b = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = f"<ui-spec type=\"media_bundle\">{json.dumps([spec_a, spec_b])}</ui-spec>"

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert normalized.count("<ui-spec") == 1
    assert '<ui-spec type="media_bundle">' in normalized
    assert '"type": "character_showcase"' in normalized
    assert '"type": "sketch_gallery"' in normalized


def test_json_render_reply_normalizer_wraps_embedded_canonical_json():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = f"已加载草图：\n\n{json.dumps(spec, ensure_ascii=False)}\n\n继续查看请告诉我。"

    normalized = chat_service._normalize_json_render_reply(content)

    assert "已加载草图" in normalized
    assert "继续查看请告诉我" in normalized
    assert '<ui-spec type="sketch_gallery">' in normalized
    assert "/static/projects/demo/sketch.png" in normalized


def test_extract_tool_ui_specs_canonicalizes_tool_payload():
    payload = {
        "content": {
            "result": {
                "ok": True,
                "ui_spec": {
                    "type": "sketch_gallery",
                    "root": "root",
                    "elements": {
                        "root": {
                            "type": "Stack",
                            "props": {"row": True},
                            "children": ["image_1"],
                        },
                        "image_1": {
                            "type": "Image",
                            "props": {
                                "src": "/static/projects/demo/scene.png?v=1",
                                "alt": "场景",
                            },
                        },
                    },
                },
            }
        }
    }

    specs = chat_service._extract_tool_ui_specs(payload)

    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert specs[0]["elements"]["root"]["props"]["direction"] == "row"
    assert specs[0]["elements"]["image_1"]["children"] == []


def test_extract_tool_ui_specs_parses_json_string_tool_result():
    payload = {
        "sessionUpdate": "tool_call_update",
        "content": json.dumps(
            {
                "ok": True,
                "ui_spec": {
                    "type": "sketch_gallery",
                    "root": "root",
                    "elements": {
                        "root": {
                            "type": "Stack",
                            "props": {"direction": "column"},
                            "children": ["image_1"],
                        },
                        "image_1": {
                            "type": "Image",
                            "props": {
                                "src": "/static/projects/demo/sketch.png?v=1",
                                "alt": "草图",
                            },
                        },
                    },
                },
            },
            ensure_ascii=False,
        ),
    }

    specs = chat_service._extract_tool_ui_specs(payload)

    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert specs[0]["elements"]["image_1"]["props"]["src"] == "/static/projects/demo/sketch.png?v=1"


def test_extract_tool_chat_error_from_nested_tool_result_string():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": json.dumps(
            {
                "ok": True,
                "data": [
                    {
                        "status": "failed",
                        "error": "Content filter triggered. Finish reason: 'content_filter'",
                        "chat_error": "模型内容安全过滤拦截了本次文本生成，请调整原文后重试。",
                    }
                ],
            },
            ensure_ascii=False,
        ),
    }

    assert (
        chat_service._extract_tool_chat_error(payload)
        == "模型内容安全过滤拦截了本次文本生成，请调整原文后重试。"
    )


def test_extract_tool_chat_error_ignores_raw_provider_error_without_hint():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "error": "Content filter triggered. Finish reason: 'content_filter'",
            "provider_response_id": "resp_123",
        },
    }

    assert chat_service._extract_tool_chat_error(payload) is None


def test_extract_tool_chat_error_maps_render_prereq_task_error():
    raw_error = (
        "Render 重生未生成可用图片（mode=1x1_2-3, beats=[1, 2, 3]）："
        "Render 模式需要草图但未找到覆盖 beat 1-1 的草图"
    )
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "status": "failed",
            "error": raw_error,
        },
    }

    chat_error = chat_service._extract_tool_chat_error(payload)

    assert chat_error is not None
    assert "Render 任务没有生成可用图片" in chat_error
    assert "虾塘" in chat_error
    assert raw_error in chat_error


def test_extract_tool_chat_error_maps_generic_failed_task_error():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "status": "failed",
            "error": "上游下载失败 token=secret-token provider_response_id=resp_123",
        },
    }

    chat_error = chat_service._extract_tool_chat_error(payload)

    assert chat_error is not None
    assert chat_error.startswith("任务执行失败：")
    assert "上游下载失败" in chat_error
    assert "secret-token" not in chat_error
    assert "resp_123" not in chat_error


def test_extract_tool_chat_error_maps_ok_false_without_error_text():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {"ok": False},
    }

    assert (
        chat_service._extract_tool_chat_error(payload)
        == "任务执行失败：接口返回 ok=false，但没有提供具体错误原因。"
    )


def test_freezone_suppresses_status_only_tool_lifecycle_failure():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
    }

    assert chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )
    assert not chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="default",
    )


def test_freezone_suppresses_canvas_bridge_tool_lifecycle_failure():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
        "content": [
            {
                "type": "content",
                "content": {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "ok": False,
                            "tool_call_status": "failed",
                            "canvas_apply_status": "failed",
                            "errors": ["节点动作完成但未产出 imageUrl。"],
                            "user_message": "节点动作完成但未产出 imageUrl。",
                        },
                        ensure_ascii=False,
                    ),
                },
            }
        ],
    }

    assert chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )


def test_freezone_keeps_tool_lifecycle_failure_with_business_payload():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
        "result": {
            "status": "failed",
            "error": "前端桥接执行失败",
        },
    }

    assert not chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )


def test_freezone_strips_status_only_lifecycle_failure_prefix():
    text = "任务执行失败：当前状态为 failed。\n\n已触发「Sketch from selected background」技能。"

    assert chat_service._strip_freezone_tool_lifecycle_failure_text(
        text,
        tool_mode="freezone_canvas",
    ) == "已触发「Sketch from selected background」技能。"
    assert chat_service._strip_freezone_tool_lifecycle_failure_text(
        text,
        tool_mode="default",
    ) == text


def test_freezone_hides_generic_tool_lifecycle_failure_error():
    assert (
        chat_service._visible_tool_chat_error_for_mode(
            "任务执行失败：当前状态为 failed。",
            tool_mode="freezone_canvas",
        )
        is None
    )
    assert (
        chat_service._visible_tool_chat_error_for_mode(
            "任务执行失败：当前状态为 failed。",
            tool_mode="default",
        )
        == "任务执行失败：当前状态为 failed。"
    )


def test_append_tool_ui_specs_adds_block_when_model_did_not_write_one():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png?v=1", "alt": "肖像"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示肖像。", [spec])

    assert content.startswith("已展示肖像。")
    assert '<ui-spec type="character_showcase">' in content
    assert "/static/projects/demo/portrait.png?v=1" in content


def test_append_tool_ui_specs_ignores_placeholder_ui_spec_chatter():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png?v=1", "alt": "肖像"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "\n".join(
            [
                "首先，调用dramaclaw_get_character_media工具获取角色肖像信息：",
                "<ui-spec> JSON has been generated and will be automatically rendered by the backend.",
                "所有图片都已按规范渲染为UI画廊，您可以直接查看。",
                "如需查看其他内容，请告诉我。",
            ]
        ),
        [spec],
    )

    assert "dramaclaw_get_character_media" not in content
    assert "automatically rendered" not in content
    assert "UI画廊" not in content
    assert "如需查看其他内容" in content
    assert '<ui-spec type="character_showcase">' in content
    assert "/static/projects/demo/portrait.png?v=1" in content


def test_append_tool_ui_specs_replaces_truncated_embedded_media_json():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    truncated_json = (
        '{"type": "sketch_gallery", "root": "root", "elements": '
        '{"root": {"type": "Stack", "props": {}, "children": ["sketch"]}}'
    )

    content = chat_service._append_tool_ui_specs(
        f"已为您展示草图：\n\n{truncated_json}\n\n继续查看请告诉我。",
        [spec],
    )

    assert "已为您展示草图" in content
    assert "继续查看请告诉我" in content
    assert truncated_json not in content
    assert '<ui-spec type="sketch_gallery">' in content
    assert "/static/projects/demo/sketch.png" in content


def test_ui_spec_json_is_generated_before_wrapping_tags():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png?v=1", "alt": "肖像"},
                "children": [],
            },
        },
    }

    spec_type, json_text = chat_service._ui_spec_json(spec)
    wrapped = chat_service._wrap_ui_spec_json(spec_type, json_text)

    assert spec_type == "character_showcase"
    assert "<ui-spec" not in json_text
    assert "</ui-spec>" not in json_text
    assert wrapped.startswith('<ui-spec type="character_showcase">')
    assert wrapped.endswith("</ui-spec>")


def test_append_tool_ui_specs_keeps_image_specs_separate_and_ordered():
    portrait_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/portrait.png?v=1",
                    "alt": "肖像",
                    "overlayTitle": "江念",
                },
                "children": [],
            },
        },
    }
    sketch_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/sketch.png?v=1",
                    "alt": "草图",
                    "overlayTitle": "Beat 1 草图",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示媒体。", [portrait_spec, sketch_spec])

    assert content.count("<ui-spec") == 2
    assert '<ui-spec type="character_showcase">' in content
    assert '<ui-spec type="sketch_gallery">' in content
    assert '"type": "character_showcase"' in content
    assert '"type": "sketch_gallery"' in content
    assert content.index('<ui-spec type="character_showcase">') < content.index(
        '<ui-spec type="sketch_gallery">'
    )
    assert content.index("/static/projects/demo/portrait.png?v=1") < content.index(
        "/static/projects/demo/sketch.png?v=1"
    )


def test_append_tool_ui_specs_merges_adjacent_character_showcase_specs():
    first_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/jiang-nian.png?v=1",
                    "alt": "江念",
                    "overlayTitle": "江念",
                },
                "children": [],
            },
        },
    }
    second_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/luo-xi.png?v=1",
                    "alt": "洛曦",
                    "overlayTitle": "洛曦",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示角色。", [first_spec, second_spec])

    assert content.count('<ui-spec type="character_showcase">') == 1
    assert "/static/projects/demo/jiang-nian.png?v=1" in content
    assert "/static/projects/demo/luo-xi.png?v=1" in content
    assert '"portrait_2"' in content
    assert content.index("/static/projects/demo/jiang-nian.png?v=1") < content.index(
        "/static/projects/demo/luo-xi.png?v=1"
    )


def test_append_tool_ui_specs_merges_same_category_video_and_audio_specs():
    video_a = {
        "type": "keyframe_video",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["video"]},
            "video": {
                "type": "Video",
                "props": {"src": "/static/projects/demo/beat-1.mp4", "title": "Beat 1"},
                "children": [],
            },
        },
    }
    video_b = {
        "type": "keyframe_video",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["video"]},
            "video": {
                "type": "Video",
                "props": {"src": "/static/projects/demo/beat-2.mp4", "title": "Beat 2"},
                "children": [],
            },
        },
    }
    audio_a = {
        "type": "audio_list",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["audio"]},
            "audio": {
                "type": "Audio",
                "props": {"src": "/static/projects/demo/beat-1.mp3", "title": "Beat 1"},
                "children": [],
            },
        },
    }
    audio_b = {
        "type": "audio_list",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["audio"]},
            "audio": {
                "type": "Audio",
                "props": {"src": "/static/projects/demo/beat-2.mp3", "title": "Beat 2"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示媒体。", [video_a, video_b, audio_a, audio_b])

    assert content.count('<ui-spec type="keyframe_video">') == 1
    assert content.count('<ui-spec type="audio_list">') == 1
    assert content.index("/static/projects/demo/beat-1.mp4") < content.index(
        "/static/projects/demo/beat-2.mp4"
    )
    assert content.index("/static/projects/demo/beat-2.mp4") < content.index(
        "/static/projects/demo/beat-1.mp3"
    )
    assert content.index("/static/projects/demo/beat-1.mp3") < content.index(
        "/static/projects/demo/beat-2.mp3"
    )


def test_append_tool_ui_specs_keeps_same_src_across_different_categories():
    shared_src = "/static/projects/demo/shared.png?v=1"
    portrait_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": shared_src, "alt": "肖像", "overlayTitle": "角色肖像"},
                "children": [],
            },
        },
    }
    sketch_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": shared_src, "alt": "草图", "overlayTitle": "草图候选"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示媒体。", [portrait_spec, sketch_spec])

    assert content.count("<ui-spec") == 2
    assert content.count(shared_src) == 2
    assert "角色肖像" in content
    assert "草图候选" in content


def test_split_ui_specs_from_text_extracts_model_written_blocks():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["image"]},
            "image": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = (
        "以下是草图：\n\n"
        f"<ui-spec>{json.dumps(spec, ensure_ascii=False)}</ui-spec>\n\n"
        "展示完成。"
    )

    text, specs = chat_service._split_ui_specs_from_text(content)

    assert "<ui-spec" not in text
    assert text == "以下是草图：\n\n展示完成。"
    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert specs[0]["elements"]["image"]["children"] == []


def test_append_tool_ui_specs_does_not_duplicate_existing_ui_spec():
    existing_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
                "children": [],
            },
        },
    }
    tool_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        f"已有展示\n<ui-spec>{json.dumps(existing_spec, ensure_ascii=False)}</ui-spec>",
        [tool_spec],
    )

    assert content.count("<ui-spec") == 1
    assert "已有展示" in content
    assert "/static/projects/demo/portrait.png" in content
    assert "/static/projects/demo/sketch.png" not in content
