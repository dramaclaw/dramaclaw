"""Unit tests for novelvideo.chat.hermes_workspace."""

from __future__ import annotations

import json
import runpy
import sys
import threading
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from novelvideo import config as app_config
from novelvideo.chat import hermes_sdk
from novelvideo.chat import hermes_workspace as hw
from novelvideo.model_gateway_settings import (
    save_custom_newapi_gateway,
    save_official_newapi_key,
)


def _enabled_toolsets(config: str) -> list[str]:
    lines = config.splitlines()
    values: list[str] = []
    in_block = False
    for line in lines:
        if line.strip() == "enabled_toolsets:":
            in_block = True
            continue
        if in_block:
            if line.startswith("  - "):
                values.append(line.split("#", 1)[0].replace("  - ", "", 1).strip())
                continue
            if line and not line.startswith(" "):
                break
    return values


def _dramaclaw_provider(config: dict) -> dict:
    return next(
        item for item in config["custom_providers"] if item.get("name") == "dramaclaw"
    )


def _hermes_thread() -> hermes_sdk.HermesSdkThread:
    return hermes_sdk.HermesSdkThread(
        cli_path=Path("hermes"),
        cwd=Path("."),
        env={},
        model=None,
        username="admin",
        session_id="session-a",
    )


def _session_update(update: dict) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "session-a", "update": update},
    }


@pytest.fixture
def isolated_workspace(tmp_path, monkeypatch):
    """Redirect DRAMACLAW_ROOT/state and repo-pinned skills to a tmp tree."""
    repo_root = tmp_path / "repo"
    state_root = repo_root / "state"
    state_root.mkdir(parents=True)
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", repo_root)
    monkeypatch.setattr(hw, "_freezone_workflow_skill_items", lambda _username: [])
    monkeypatch.setattr(app_config, "STATE_DIR", str(state_root))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))
    for key in (
        "NEWAPI_API_KEY",
        "NEWAPI_BASE_URL",
        "MODEL_GATEWAY_RUNTIME_VERSION",
        "OPENAI_API_KEY",
        "OPENAI_API_BASE",
        "OPENAI_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("MODEL_GATEWAY_MODE", raising=False)
    # Pin explicitly: the repo .env may opt into auto, and config loading would
    # re-add a deleted var via load_dotenv(override=False).
    monkeypatch.setenv("HERMES_TOOL_SEARCH_MODE", "off")
    monkeypatch.delenv("ST_HERMES_SKILLS", raising=False)
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_DEFAULT", raising=False)
    monkeypatch.delenv("DRAMACLAW_HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_PROVIDER", raising=False)
    monkeypatch.delenv("HERMES_MODEL_BASE_URL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_API_MODE", raising=False)
    monkeypatch.delenv("HERMES_MODEL_CONTEXT_LENGTH", raising=False)
    yield repo_root


@pytest.fixture
def repo_skills(isolated_workspace):
    """Create a fake repo .hermes/skills tree."""
    skills = isolated_workspace / ".hermes" / "skills"
    skills.mkdir(parents=True)
    for name in (
        "json-render",
        "dramaclaw",
        "freezone",
        "sketch-correction-worker",
        "sketch-storyboard-director",
        "workflows",
        "other-skill",
    ):
        (skills / name).mkdir()
        (skills / name / "SKILL.md").write_text(f"# {name}\n")
    return skills


@pytest.fixture
def repo_plugins(isolated_workspace):
    """Create a fake repo .hermes/plugins tree."""
    plugins = isolated_workspace / ".hermes" / "plugins"
    plugins.mkdir(parents=True)
    for name in ("dramaclaw", "freezone", "other-plugin"):
        (plugins / name).mkdir()
        (plugins / name / "plugin.yaml").write_text(f"name: {name}\n")
    return plugins


def test_fresh_create_layout(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    assert home.exists()
    assert (home / "config.yaml").exists()
    assert (home / ".env").exists()
    assert (home / "tmp").is_dir()
    assert (home / "skills" / "_user").is_dir()
    # Default allowlist should be symlinked in.
    assert (home / "skills" / "dramaclaw").is_symlink()
    assert not (home / "skills" / "freezone").exists()
    assert (home / "skills" / "sketch-correction-worker").is_symlink()
    assert (home / "skills" / "sketch-storyboard-director").is_symlink()
    assert not (home / "skills" / "workflows").exists()
    assert not (home / "skills" / "json-render").exists()
    assert not (home / "skills" / "other-skill").exists()
    plugin_link = home / "plugins" / "dramaclaw"
    assert plugin_link.is_symlink()
    assert not (home / "plugins" / "freezone").exists()
    assert not (home / "plugins" / "other-plugin").exists()
    config = (home / "config.yaml").read_text()
    assert _enabled_toolsets(config) == ["hermes-acp", "memory"]
    assert "    - dramaclaw" in config
    assert "    - freezone" not in config
    assert "你是虾导" in (home / "SOUL.md").read_text()
    memory = (home / "memories" / "MEMORY.md").read_text()
    assert "虾导在 DramaClaw 会话中面向用户自称“虾导”" in memory
    assert "不要在普通回复开头自报身份" in memory
    assert "我是虾导，DramaClaw 的小说转视频创作助手。" not in memory


def test_project_workspace_keeps_hermes_native_state_under_project(
    isolated_workspace, repo_skills, repo_plugins
):
    project_state = isolated_workspace / "state" / "admin" / "movie-a"

    director_home = hw.ensure_user_hermes_workspace(
        "admin", project_state_dir=project_state
    )
    freezone_home = hw.ensure_user_hermes_workspace(
        "admin", profile="freezone", project_state_dir=project_state
    )

    assert director_home == project_state / "agents" / "hermes" / "director"
    assert freezone_home == project_state / "agents" / "hermes" / "freezone"
    assert (director_home / "config.yaml").is_file()
    assert (director_home / "memories" / "MEMORY.md").is_file()
    assert (freezone_home / "config.yaml").is_file()


def test_freezone_profile_uses_isolated_workspace(
    isolated_workspace, repo_skills, repo_plugins
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")

    assert home == isolated_workspace / "state" / "admin" / ".hermes-freezone"
    assert (home / "skills" / "freezone").is_symlink()
    assert (home / "skills" / "workflows").is_symlink()
    assert not (home / "skills" / "dramaclaw").exists()
    assert (home / "plugins" / "freezone").is_symlink()
    assert not (home / "plugins" / "dramaclaw").exists()

    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert parsed["enabled_toolsets"] == ["hermes-acp", "freezone-acp", "memory"]
    assert parsed["tools"]["tool_search"]["enabled"] == "off"
    assert parsed["plugins"]["enabled"] == ["freezone"]
    assert parsed["tools"]["skill_manage"]["enabled"] == "off"
    assert parsed["agent"]["coding_context"] == "off"
    assert "dramaclaw-acp" in parsed["disabled_toolsets"]
    soul = (home / "SOUL.md").read_text(encoding="utf-8")
    memory = (home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "创意咨询" in soul
    assert "画布节点、连线、资源和工作流操作" in soul
    assert "不要在普通回复开头自报身份" in soul
    assert "FREEZONE_CANVAS_ASSISTANT" in soul
    assert "command catalog" not in soul
    assert "只使用 Freezone 画布能力" in memory
    assert "不得用 DramaClaw 主线工具" in memory
    assert "创意咨询" not in memory
    assert "command catalog" not in memory
    assert len(soul) < 250
    assert len(memory) < 100
    assert (hw.freezone_python_hook_dir(home) / "sitecustomize.py").is_file()


def test_freezone_sitecustomize_disables_only_skill_manage(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    sitecustomize = hw.freezone_python_hook_dir(home) / "sitecustomize.py"
    registered: list[str] = []

    class FakeRegistry:
        def __init__(self) -> None:
            self._tools = {"skill_manage": object()}
            self._lock = threading.RLock()

        def register(self, name: str, **kwargs) -> str:
            registered.append(name)
            self._tools[name] = kwargs
            return name

        def deregister(self, name: str) -> None:
            self._tools.pop(name, None)

    fake_registry = FakeRegistry()
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.registry = fake_registry
    monkeypatch.setitem(sys.modules, "tools", tools_module)
    monkeypatch.setitem(sys.modules, "tools.registry", registry_module)
    monkeypatch.setenv("DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE", "1")
    monkeypatch.delenv("DRAMACLAW_HERMES_TOOL_DENY", raising=False)

    runpy.run_path(str(sitecustomize))

    assert "skill_manage" not in fake_registry._tools
    assert fake_registry.register("skill_manage") is None
    assert fake_registry.register("skill_view") == "skill_view"
    assert registered == ["skill_view"]


def test_freezone_sitecustomize_denies_tools_from_env(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    sitecustomize = hw.freezone_python_hook_dir(home) / "sitecustomize.py"

    class FakeRegistry:
        def __init__(self) -> None:
            self._tools = {"terminal": object(), "todo": object()}
            self._lock = threading.RLock()

        def register(self, name: str, **kwargs) -> str:
            self._tools[name] = kwargs
            return name

        def deregister(self, name: str) -> None:
            self._tools.pop(name, None)

    fake_registry = FakeRegistry()
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.registry = fake_registry
    monkeypatch.setitem(sys.modules, "tools", tools_module)
    monkeypatch.setitem(sys.modules, "tools.registry", registry_module)
    monkeypatch.delenv("DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE", raising=False)
    monkeypatch.setenv("DRAMACLAW_HERMES_TOOL_DENY", "terminal, delegate_task")

    runpy.run_path(str(sitecustomize))

    assert "terminal" not in fake_registry._tools
    assert fake_registry.register("terminal") is None
    assert fake_registry.register("delegate_task") is None
    assert fake_registry.register("read_file") == "read_file"
    assert "todo" in fake_registry._tools


def test_freezone_sitecustomize_verify_warns_red_only_on_leftover(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
    capsys,
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    sitecustomize = hw.freezone_python_hook_dir(home) / "sitecustomize.py"
    monkeypatch.delenv("DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE", raising=False)
    monkeypatch.delenv("DRAMACLAW_HERMES_TOOL_DENY", raising=False)

    module = runpy.run_path(str(sitecustomize))
    verify = module["_verify_denied_tools_removed"]

    class FakeRegistry:
        def __init__(self, tools: dict) -> None:
            self._tools = tools

    leftover = verify(FakeRegistry({"terminal": object()}), frozenset({"terminal"}))
    captured = capsys.readouterr()
    assert leftover == ["terminal"]
    assert "\033[31m" in captured.err
    assert "terminal" in captured.err

    clean = verify(FakeRegistry({"todo": object()}), frozenset({"terminal"}))
    captured = capsys.readouterr()
    assert clean == []
    assert captured.err == ""


def test_freezone_profile_materializes_native_workflow_skills(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    items = [
        {
            "id": "ecommerce-ad",
            "name": "电商广告",
            "description": "动态生成电商广告工作流。",
            "category": "ecommerce",
            "triggers": {"keywords": ["商品广告", "带货视频"]},
            "allowed_recipe_ids": ["ecommerce-ad-image"],
        }
    ]
    monkeypatch.setattr(hw, "_freezone_workflow_skill_items", lambda _username: items)

    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    skill_dir = home / "skills" / "ecommerce-ad"
    content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    summaries = hw.list_freezone_hermes_workflow_skills("admin")

    assert "name: ecommerce-ad" in content
    assert 'skill_id="ecommerce-ad"' in content
    assert "freezone_prepare_workflow_draft" in content
    assert "freezone_patch_workflow_draft" in content
    assert "freezone_confirm_workflow_draft" in content
    assert "freezone_create_workflow_from_intent" not in content
    assert summaries == [
        {
            "id": "ecommerce-ad",
            "name": "电商广告",
            "description": "动态生成电商广告工作流。 适用于：商品广告、带货视频。 选择后使用虾画确定性工具生成动态工作流。",
            "category": "ecommerce",
            "source": "hermes_native_workflow_skill",
            "allowed_recipe_ids": ["ecommerce-ad-image"],
        }
    ]

    manual_skill = home / "skills" / "manual-skill"
    manual_skill.mkdir()
    (manual_skill / "SKILL.md").write_text("# Manual\n", encoding="utf-8")
    monkeypatch.setattr(hw, "_freezone_workflow_skill_items", lambda _username: [])

    hw.ensure_user_hermes_workspace("admin", profile="freezone")

    assert not skill_dir.exists()
    assert manual_skill.exists()


def test_freezone_profile_preserves_tool_search_disable(
    isolated_workspace,
    repo_skills,
    repo_plugins,
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    config_file = home / "config.yaml"
    parsed = yaml.safe_load(config_file.read_text(encoding="utf-8"))
    parsed["tools"] = {"tool_search": {"enabled": "off"}}
    config_file.write_text(yaml.safe_dump(parsed, allow_unicode=True), encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin", profile="freezone")

    updated = yaml.safe_load(config_file.read_text(encoding="utf-8"))
    assert updated["tools"]["tool_search"]["enabled"] == "off"
    assert updated["tools"]["skill_manage"]["enabled"] == "off"


def test_freezone_profile_tool_search_mode_from_env(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    monkeypatch.setenv("HERMES_TOOL_SEARCH_MODE", "auto")
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert parsed["tools"]["tool_search"]["enabled"] == "auto"
    assert parsed["tools"]["skill_manage"]["enabled"] == "off"

    monkeypatch.setenv("HERMES_TOOL_SEARCH_MODE", "bogus")
    hw.ensure_user_hermes_workspace("admin", profile="freezone")
    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert parsed["tools"]["tool_search"]["enabled"] == "auto"


def test_freezone_profile_tool_search_defaults_to_auto(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    monkeypatch.delenv("HERMES_TOOL_SEARCH_MODE", raising=False)

    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))

    assert parsed["tools"]["tool_search"]["enabled"] == "auto"


def test_freezone_profile_migrates_existing_tool_search_to_auto(
    isolated_workspace,
    repo_skills,
    repo_plugins,
    monkeypatch,
):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")
    config_file = home / "config.yaml"
    parsed = yaml.safe_load(config_file.read_text(encoding="utf-8"))
    parsed["tools"]["tool_search"]["enabled"] = "off"
    config_file.write_text(
        yaml.safe_dump(parsed, allow_unicode=True), encoding="utf-8"
    )
    monkeypatch.delenv("HERMES_TOOL_SEARCH_MODE", raising=False)

    hw.ensure_user_hermes_workspace("admin", profile="freezone")
    migrated = yaml.safe_load(config_file.read_text(encoding="utf-8"))

    assert migrated["tools"]["tool_search"]["enabled"] == "auto"


def test_freezone_profile_refreshes_stale_repo_symlinks(
    isolated_workspace,
    repo_skills,
    repo_plugins,
):
    stale_root = isolated_workspace / "stale"
    stale_skill = stale_root / "skills" / "workflows"
    stale_plugin = stale_root / "plugins" / "freezone"
    stale_skill.mkdir(parents=True)
    stale_plugin.mkdir(parents=True)

    home = isolated_workspace / "state" / "admin" / ".hermes-freezone"
    (home / "skills").mkdir(parents=True)
    (home / "plugins").mkdir(parents=True)
    (home / "skills" / "workflows").symlink_to(stale_skill)
    (home / "plugins" / "freezone").symlink_to(stale_plugin)

    refreshed = hw.ensure_user_hermes_workspace("admin", profile="freezone")

    assert refreshed == home
    assert (home / "skills" / "workflows").resolve() == repo_skills / "workflows"
    assert (home / "plugins" / "freezone").resolve() == repo_plugins / "freezone"


def test_hermes_initialize_timeout_allows_cold_start():
    assert hermes_sdk.INITIALIZE_TIMEOUT == 90.0


def test_hermes_stdio_line_limit_allows_large_acp_tool_calls():
    assert hermes_sdk.HERMES_STDIO_LINE_LIMIT_BYTES >= 4 * 1024 * 1024


def test_hermes_stream_timeout_allows_long_active_turns():
    assert hermes_sdk.STREAM_IDLE_TIMEOUT == 300.0
    assert hermes_sdk.STREAM_TOTAL_TIMEOUT == 1800.0
    assert (
        hermes_sdk._refresh_stream_idle_deadline(
            now=100.0,
            total_deadline=1800.0,
        )
        == 400.0
    )
    assert (
        hermes_sdk._refresh_stream_idle_deadline(
            now=1700.0,
            total_deadline=1800.0,
        )
        == 1800.0
    )


@pytest.mark.asyncio
async def test_hermes_stream_timeout_retires_worker_before_completion(monkeypatch):
    thread = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    thread.id = "hermes-session"
    closed = []

    async def fake_close():
        closed.append(True)

    monkeypatch.setattr(thread, "close", fake_close)

    event = await thread._stream_timeout_event("turn-timeout")

    assert closed == [True]
    assert event.type == "complete"
    assert event.thread_id == "hermes-session"
    assert event.turn_id == "turn-timeout"
    assert event.text == "(hermes timed out)"


def test_hermes_detects_content_filter_finish_reason():
    payload = {
        "result": {
            "body": [
                {
                    "finish_reason": "content_filter",
                    "provider_details": {"finish_reason": "content_filter"},
                }
            ]
        }
    }

    assert hermes_sdk._has_content_filter_signal(payload)


def test_hermes_translates_thought_plan_and_usage_updates():
    thread = _hermes_thread()

    thought = thread._translate_notification(
        _session_update(
            {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "分析画布结构"},
            }
        ),
        "turn-a",
    )
    plan = thread._translate_notification(
        _session_update(
            {
                "sessionUpdate": "plan",
                "entries": [
                    {
                        "content": "读取资产",
                        "status": "completed",
                        "priority": "medium",
                    },
                    {
                        "content": "生成分镜",
                        "status": "in_progress",
                        "priority": "high",
                    },
                ],
            }
        ),
        "turn-a",
    )
    usage = thread._translate_notification(
        _session_update({"sessionUpdate": "usage_update", "used": 128, "size": 4096}),
        "turn-a",
    )

    assert thought is not None
    assert thought.type == "thought_delta"
    assert thought.text == "分析画布结构"
    assert plan is not None
    assert plan.type == "plan_update"
    assert plan.entries == [
        {"content": "读取资产", "status": "completed", "priority": "medium"},
        {"content": "生成分镜", "status": "in_progress", "priority": "high"},
    ]
    assert usage is not None
    assert usage.type == "usage_update"
    assert usage.usage == {"used": 128, "size": 4096}


def test_hermes_preserves_tool_call_identity_across_lifecycle_updates():
    thread = _hermes_thread()
    tool_started = thread._translate_notification(
        _session_update(
            {
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "read_file: storyboard.json",
                "status": "pending",
                "rawInput": {"path": "storyboard.json"},
            }
        ),
        "turn-a",
    )
    tool_completed = thread._translate_notification(
        _session_update(
            {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "rawOutput": {"ok": True},
            }
        ),
        "turn-a",
    )

    assert tool_started is not None
    assert tool_started.type == "tool_started"
    assert tool_started.call_id == "call-1"
    assert tool_started.name == "read_file"
    assert tool_started.input == {"path": "storyboard.json"}
    assert tool_completed is not None
    assert tool_completed.type == "tool_updated"
    assert tool_completed.call_id == "call-1"
    assert tool_completed.name == "read_file"
    assert tool_completed.input == {"path": "storyboard.json"}
    assert tool_completed.output == {"ok": True}
    assert tool_completed.status == "completed"


@pytest.mark.asyncio
async def test_hermes_permission_request_round_trip_uses_selected_acp_option():
    class _Writer:
        def __init__(self) -> None:
            self.data = bytearray()

        def write(self, value: bytes) -> None:
            self.data.extend(value)

        async def drain(self) -> None:
            return None

    thread = _hermes_thread()
    writer = _Writer()
    thread._proc = SimpleNamespace(stdin=writer)
    event = thread._translate_notification(
        {
            "jsonrpc": "2.0",
            "id": 71,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-a",
                "toolCall": {
                    "title": "运行媒体探测",
                    "rawInput": "ffprobe clip.mp4",
                },
                "options": [
                    {"optionId": "allow-1", "kind": "allow_once", "name": "允许一次"},
                    {"optionId": "deny-1", "kind": "reject_once", "name": "拒绝"},
                ],
            },
        },
        "turn-a",
    )

    assert event is not None
    assert event.type == "permission_requested"
    assert event.request_id == 71
    assert event.text == "运行媒体探测"
    assert await thread.resolve_permission(71, "allow-1") is True
    assert json.loads(writer.data.decode("utf-8")) == {
        "jsonrpc": "2.0",
        "id": 71,
        "result": {"outcome": {"outcome": "selected", "optionId": "allow-1"}},
    }
    assert await thread.resolve_permission(71, "allow-1") is False


@pytest.mark.asyncio
async def test_hermes_rejects_expired_permission_response(monkeypatch):
    class _Writer:
        def __init__(self) -> None:
            self.data = bytearray()

        def write(self, value: bytes) -> None:
            self.data.extend(value)

        async def drain(self) -> None:
            return None

    now = [100.0]
    monkeypatch.setattr(hermes_sdk.time, "monotonic", lambda: now[0])
    thread = _hermes_thread()
    writer = _Writer()
    thread._proc = SimpleNamespace(stdin=writer)
    event = thread._translate_notification(
        {
            "jsonrpc": "2.0",
            "id": 72,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-a",
                "toolCall": {"title": "运行命令"},
                "options": [
                    {
                        "optionId": "allow_once",
                        "kind": "allow_once",
                        "name": "Allow once",
                    }
                ],
            },
        },
        "turn-expired",
    )

    assert event is not None
    now[0] += hermes_sdk.PERMISSION_REQUEST_TIMEOUT_SECONDS + 1
    assert await thread.resolve_permission(72, "allow_once") is False
    assert writer.data == b""
    assert thread._pending_permissions == {}


def test_hermes_clears_pending_permissions_for_completed_turn():
    thread = _hermes_thread()
    event = thread._translate_notification(
        {
            "jsonrpc": "2.0",
            "id": 73,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-a",
                "toolCall": {"title": "运行命令"},
                "options": [
                    {"optionId": "deny", "kind": "reject_once", "name": "Deny"}
                ],
            },
        },
        "turn-complete",
    )

    assert event is not None
    thread._clear_pending_permissions_for_turn("turn-complete")
    assert thread._pending_permissions == {}


def test_hermes_detects_content_filter_error_text():
    payload = {
        "error": {
            "message": "Content filter triggered. Finish reason: 'content_filter'"
        }
    }

    assert hermes_sdk._has_content_filter_signal(payload)


def test_hermes_detects_failed_write_in_nested_tool_content():
    update = {
        "status": "completed",
        "rawOutput": {
            "content": [
                {
                    "type": "text",
                    "text": '{"status_code":422,"ok":false,"error":"body required"}',
                }
            ]
        },
    }

    assert hermes_sdk._is_failed_tool_update(update) is True


def test_hermes_detects_nested_session_unavailable_error_payload():
    payload = {
        "code": -32000,
        "message": "prompt failed",
        "data": {
            "details": [
                {
                    "message": "prompt: session 5e14b825-b50c-4fed-be9e-aaa2a3882b7e not found"
                },
            ],
        },
    }

    assert hermes_sdk._is_session_unavailable_error(payload)


def test_hermes_stops_mainline_writes_but_not_freezone_canvas_writes():
    assert hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_start_single_video",
    )
    assert not hermes_sdk._should_stop_after_write_tool(
        "freezone_emit_canvas_command",
        "freezone_emit_canvas_command",
    )
    assert hermes_sdk._is_freezone_canvas_write_tool("freezone_create_workflow_graph")
    assert not hermes_sdk._should_stop_after_write_tool(
        "freezone_emit_canvas_command",
        "dramaclaw_start_single_video",
    )


def test_hermes_keeps_mainline_tool_call_limit_narrow():
    assert (
        hermes_sdk._turn_tool_call_limit_for_tool("dramaclaw_generate_script") is None
    )


def test_hermes_allows_more_freezone_tool_calls():
    assert (
        hermes_sdk._turn_tool_call_limit_for_tool("freezone_emit_canvas_command") == 20
    )
    assert (
        hermes_sdk._turn_tool_call_limit_for_tool("freezone_put_agent_catalog_recipe")
        == 20
    )


def test_hermes_tool_call_guard_counts_update_only_calls():
    guard = hermes_sdk._TurnToolCallGuard()

    for index in range(3):
        result = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="freezone_get_node_detail",
                call_id=f"call-{index}",
                input={"node_id": f"node-{index}"},
                status="completed",
            )
        )
        assert result is None

    assert guard.total == 3


def test_hermes_tool_call_guard_does_not_charge_skill_loading_to_action_limit(
    monkeypatch,
):
    monkeypatch.setattr(hermes_sdk, "TURN_TOOL_CALL_LIMIT", 1)
    guard = hermes_sdk._TurnToolCallGuard()

    assert (
        guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="skill",
                call_id="skill-a",
                input={"name": "dramaclaw"},
            )
        )
        is None
    )
    assert guard.total == 0
    assert (
        guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="dramaclaw_pipeline_status",
                call_id="status-a",
                input={"episode": 2},
            )
        )
        is None
    )
    assert guard.total == 1


def test_hermes_tool_call_guard_still_stops_repeated_skill_loading():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None

    for index in range(hermes_sdk.REPEATED_READ_TOOL_CALL_LIMIT + 1):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="skill",
                call_id=f"skill-{index}",
                input={"name": "dramaclaw"},
            )
        )

    assert stop_message is not None
    assert guard.total == 0


def test_hermes_tool_call_guard_distinguishes_inputless_reads_by_title():
    # Hermes "polished" tools (skill_view etc.) send rawInput=None over ACP and
    # _split_tool_title collapses "skill view (x)" to "skill"; the title tail is
    # the only per-call distinguisher. Distinct reads must not trip the guard.
    guard = hermes_sdk._TurnToolCallGuard()

    for index, title in enumerate([
        "skill view (workflows)",
        "skill view (ecommerce-ad)",
        "skill view (workflows/references/product-video.md)",
    ]):
        assert guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="skill",
                call_id=f"view-{index}",
                input=None,
                raw={"title": title},
            )
        ) is None


def test_hermes_tool_call_guard_distinguishes_chunked_reads_by_content_args():
    # read_file is also "polished" (rawInput=None) and its title is only
    # "read: <path>", so chunked reads of one file share a title. The start
    # event's content blocks carry the args JSON (offset/limit) — distinct
    # chunks must not trip the guard.
    guard = hermes_sdk._TurnToolCallGuard()

    for index, offset in enumerate([488, 748, 1028]):
        assert guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="read",
                call_id=f"read-{index}",
                input=None,
                raw={
                    "title": "read: /repo/plugins/freezone/json_workflow_catalog.py",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": f'{{\n  "limit": 300,\n  "offset": {offset},\n  "path": "..."\n}}',
                            },
                        }
                    ],
                },
            )
        ) is None


def test_hermes_tool_call_guard_still_stops_repeated_inputless_reads():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None

    for index in range(hermes_sdk.REPEATED_READ_TOOL_CALL_LIMIT + 1):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_started",
                name="skill",
                call_id=f"view-{index}",
                input=None,
                raw={"title": "skill view (workflows)"},
            )
        )

    assert stop_message is not None
    assert "重复读取" in stop_message


def test_hermes_tool_call_guard_reason_is_machine_readable():
    assert hermes_sdk._tool_call_guard_reason("本轮操作已停止：重复读取同一项状态") == (
        "repeated_read"
    )
    assert hermes_sdk._tool_call_guard_reason("本轮操作已停止：连续调用工具过多") == (
        "tool_call_limit"
    )


def test_hermes_tool_call_guard_stops_repeated_identical_node_reads():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None

    for index in range(hermes_sdk.REPEATED_READ_TOOL_CALL_LIMIT + 1):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="freezone_get_node_detail",
                call_id=f"call-{index}",
                input={"node_id": "node-a"},
                status="completed",
            )
        )

    assert stop_message is not None
    assert "重复读取同一个画布节点" in stop_message


def test_hermes_tool_call_guard_stops_repeated_identical_mainline_reads():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None

    for index in range(hermes_sdk.REPEATED_READ_TOOL_CALL_LIMIT + 1):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="dramaclaw_pipeline_status",
                call_id=f"call-{index}",
                input={"episode": 1},
                status="completed",
            )
        )

    assert stop_message is not None
    assert "重复读取同一项状态" in stop_message


def test_hermes_tool_call_guard_allows_distinct_mainline_reads():
    guard = hermes_sdk._TurnToolCallGuard()

    for index in range(10):
        assert (
            guard.observe(
                hermes_sdk.ChatBackendEvent(
                    type="tool_updated",
                    name="dramaclaw_get_episode_media",
                    call_id=f"call-{index}",
                    input={"episode": 1, "beat": index + 1},
                    status="completed",
                )
            )
            is None
        )


def test_hermes_tool_call_guard_does_not_double_count_start_and_update():
    guard = hermes_sdk._TurnToolCallGuard()
    started = hermes_sdk.ChatBackendEvent(
        type="tool_started",
        name="freezone_get_node_detail",
        call_id="call-a",
        input={"node_id": "node-a"},
    )
    updated = hermes_sdk.ChatBackendEvent(
        type="tool_updated",
        name="freezone_get_node_detail",
        call_id="call-a",
        input={"node_id": "node-a"},
        status="completed",
    )

    assert guard.observe(started) is None
    assert guard.observe(updated) is None
    assert guard.total == 1


def test_hermes_tool_call_guard_stops_repeated_identical_failures():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None
    tool_input = {
        "body": {},
        "envelope": {},
        "commands": [{"type": "create_node", "client_id": "node-a"}],
    }
    tool_output = [
        {
            "type": "content",
            "content": {
                "type": "text",
                "text": "freezone_validate_canvas_commands failed: commands required",
            },
        }
    ]

    for index in range(2):
        call_id = f"call-{index}"
        assert (
            guard.observe(
                hermes_sdk.ChatBackendEvent(
                    type="tool_started",
                    name="freezone_validate_canvas_commands",
                    call_id=call_id,
                    input=tool_input,
                )
            )
            is None
        )
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="freezone_validate_canvas_commands",
                call_id=call_id,
                input=tool_input,
                output=tool_output,
                status="failed",
            )
        )

    assert stop_message is not None
    assert "重复返回相同错误" in stop_message
    assert guard.total == 2


def test_hermes_tool_call_guard_tracks_same_failure_across_unrelated_success():
    guard = hermes_sdk._TurnToolCallGuard()

    first_failure = hermes_sdk.ChatBackendEvent(
        type="tool_updated",
        name="freezone_validate_canvas_commands",
        call_id="failed-a",
        input={"commands": []},
        output={"ok": False, "status": "empty_validation_payload"},
        status="completed",
    )
    success = hermes_sdk.ChatBackendEvent(
        type="tool_updated",
        name="freezone_summarize_canvas",
        call_id="success",
        input={},
        output={"ok": True},
        status="completed",
    )
    second_failure = hermes_sdk.ChatBackendEvent(
        type="tool_updated",
        name="freezone_validate_canvas_commands",
        call_id="failed-b",
        input={"commands": []},
        output={"ok": False, "status": "empty_validation_payload"},
        status="completed",
    )

    assert guard.observe(first_failure) is None
    assert guard.observe(success) is None
    stop_message = guard.observe(second_failure)

    assert stop_message is not None
    assert "重复返回相同错误" in stop_message


def test_hermes_tool_call_guard_normalizes_volatile_failure_fields():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None

    for index in range(2):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="freezone_emit_canvas_command",
                call_id=f"failed-{index}",
                input={"commands": [{"type": "create_node", "data": {}}]},
                output=json.dumps(
                    {
                        "ok": False,
                        "tool_call_status": "failed",
                        "bridge_key": f"bridge-{index}",
                        "resolved_at": 100.0 + index,
                        "errors": ["create_node requires title and content"],
                    }
                ),
                status="failed",
            )
        )

    assert stop_message is not None
    assert "重复返回相同错误" in stop_message


def test_hermes_tool_call_guard_stops_repeated_successful_validation():
    guard = hermes_sdk._TurnToolCallGuard()
    stop_message = None
    tool_input = {
        "commands": [
            {
                "type": "create_node",
                "node_type": "textAnnotationNode",
                "data": {"title": "线索核对", "content": "核对账册"},
            }
        ]
    }

    for index in range(hermes_sdk.REPEATED_VALIDATION_TOOL_CALL_LIMIT):
        stop_message = guard.observe(
            hermes_sdk.ChatBackendEvent(
                type="tool_updated",
                name="freezone_validate_canvas_commands",
                call_id=f"validation-{index}",
                input=tool_input,
                output={"ok": True, "validation": {"valid": True}},
                status="completed",
            )
        )

    assert stop_message is not None
    assert "重复校验同一批画布命令" in stop_message


def test_hermes_freezone_tool_limit_message_uses_freezone_context():
    message = hermes_sdk._tool_call_limit_stop_message(
        "freezone_put_agent_catalog_recipe"
    )

    assert "虾画" in message
    assert "虾导" not in message
    assert "beat" not in message


def test_state_root_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    assert hw._state_root() == tmp_path / "state"


def test_state_root_falls_back_to_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", tmp_path / "repo")
    monkeypatch.delenv("NOVELVIDEO_STATE_DIR", raising=False)

    assert hw._state_root() == tmp_path / "repo" / "state"


def test_official_brainclaw_ignores_legacy_hermes_model_env(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    save_official_newapi_key(api_key="root-key", activate=True)
    (isolated_workspace / ".env").write_text(
        "\n".join(
            [
                "NEWAPI_API_KEY=root-key",
                "HERMES_MODEL=gemini-3.5-flash",
                "HERMES_MODEL_PROVIDER=openrouter",
                "HERMES_MODEL_BASE_URL=http://newapi.local/v1",
                "HERMES_MODEL_API_MODE=responses",
                "HERMES_MODEL_CONTEXT_LENGTH=65536",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    home = hw.ensure_user_hermes_workspace("admin")
    config = (home / "config.yaml").read_text(encoding="utf-8")

    assert "  default: brainclaw" in config
    parsed = yaml.safe_load(config)
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert parsed["model"]["default"] == "brainclaw"
    assert parsed["model"]["context_length"] == 65536
    assert "api_key" not in parsed["model"]
    provider = _dramaclaw_provider(parsed)
    assert provider == {
        "name": "dramaclaw",
        "base_url": app_config.OFFICIAL_NEWAPI_BASE_URL,
        "key_env": "NEWAPI_API_KEY",
        "api_mode": "responses",
    }


def test_existing_config_syncs_endpoint_without_persisting_rotated_key(
    isolated_workspace, repo_skills, repo_plugins
):
    save_custom_newapi_gateway(
        base_url="http://old-gateway/v1",
        api_key="old-key",
        activate=True,
    )
    home = hw.ensure_user_hermes_workspace("admin")
    config_path = home / "config.yaml"
    first = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert "api_key" not in first["model"]
    assert _dramaclaw_provider(first)["base_url"] == "http://old-gateway/v1"
    assert "old-key" not in config_path.read_text(encoding="utf-8")

    config = config_path.read_text(encoding="utf-8") + "\ncustom_block:\n  keep: true\n"
    config_path.write_text(config, encoding="utf-8")
    save_custom_newapi_gateway(
        base_url="http://new-gateway/v1",
        api_key="rotated-key",
        activate=True,
    )

    hw.ensure_user_hermes_workspace("admin")
    parsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert "api_key" not in parsed["model"]
    assert _dramaclaw_provider(parsed)["base_url"] == "http://new-gateway/v1"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert "rotated-key" not in config_path.read_text(encoding="utf-8")
    assert parsed["custom_block"]["keep"] is True
    assert _enabled_toolsets(config_path.read_text(encoding="utf-8")) == [
        "hermes-acp",
        "memory",
    ]

    hw.ensure_user_hermes_workspace("admin")
    reparsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert reparsed["enabled_toolsets"] == ["hermes-acp", "memory"]
    assert reparsed["plugins"]["enabled"] == ["dramaclaw"]
    assert reparsed["agent"]["max_turns"] == 4


def test_hermes_uses_settings_db_newapi_before_root_env(
    isolated_workspace, repo_skills, repo_plugins
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\nNEWAPI_BASE_URL=http://root-gateway/v1\n",
        encoding="utf-8",
    )
    save_custom_newapi_gateway(
        base_url="http://custom-gateway/v1",
        api_key="custom-key",
        activate=True,
    )

    home = hw.ensure_user_hermes_workspace("admin")
    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "api_key" not in parsed["model"]
    assert _dramaclaw_provider(parsed)["base_url"] == "http://custom-gateway/v1"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert "custom-key" not in (home / "config.yaml").read_text(encoding="utf-8")
    assert "NEWAPI_API_KEY=custom-key" in env_text
    assert "OPENAI_API_KEY=custom-key" in env_text
    assert "root-key" not in env_text


def test_hermes_env_syncs_current_newapi_key_and_replaces_stale_openai_key(
    isolated_workspace, repo_skills, repo_plugins
):
    save_official_newapi_key(api_key="current-newapi-key", activate=True)
    home = isolated_workspace / "state" / "admin" / ".hermes-freezone"
    home.mkdir(parents=True)
    (home / ".env").write_text(
        "OPENAI_API_KEY=stale-test-key\nUNRELATED_SECRET=keep-me\n",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin", profile="freezone")
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "NEWAPI_API_KEY=current-newapi-key" in env_text
    assert "OPENAI_API_KEY=current-newapi-key" in env_text
    assert "OPENAI_API_KEY=stale-test-key" not in env_text
    assert "UNRELATED_SECRET=keep-me" in env_text


def test_idempotent_rerun(isolated_workspace, repo_skills, repo_plugins):
    home1 = hw.ensure_user_hermes_workspace("admin")
    cfg_text = (home1 / "config.yaml").read_text(encoding="utf-8")
    # Touch user .env so we can verify it is NOT overwritten
    (home1 / ".env").write_text("# user customized\nOPENROUTER_API_KEY=secret\n")

    home2 = hw.ensure_user_hermes_workspace("admin")
    assert home2 == home1
    # config.yaml content not regenerated (we only write config changes when needed)
    assert (home1 / "config.yaml").read_text(encoding="utf-8") == cfg_text
    # .env preserved
    assert "OPENROUTER_API_KEY=secret" in (home1 / ".env").read_text()


def test_fresh_workspace_does_not_persist_newapi_key(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=test-newapi-key\n",
        encoding="utf-8",
    )
    save_official_newapi_key(api_key="test-newapi-key", activate=True)

    home = hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))

    assert "api_key" not in config["model"]
    assert _dramaclaw_provider(config)["key_env"] == "NEWAPI_API_KEY"
    assert "test-newapi-key" not in (home / "config.yaml").read_text(encoding="utf-8")
    assert "NEWAPI_API_KEY=test-newapi-key" in env_text
    assert "OPENAI_API_KEY=test-newapi-key" in env_text


def test_existing_inline_key_is_removed_automatically(
    isolated_workspace, repo_skills, repo_plugins
):
    save_official_newapi_key(api_key="current-key", activate=True)
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(
        """model:
  default: legacy-model
  provider: custom
  base_url: https://legacy.example/v1
  api_key: legacy-key
custom_providers:
  - name: user-provider
    base_url: https://user.example/v1
    key_env: USER_PROVIDER_KEY
""",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")
    text = (home / "config.yaml").read_text(encoding="utf-8")
    config = yaml.safe_load(text)

    assert config["model"]["provider"] == "custom:dramaclaw"
    assert "api_key" not in config["model"]
    assert "legacy-key" not in text
    assert any(
        item.get("name") == "user-provider" for item in config["custom_providers"]
    )
    assert _dramaclaw_provider(config)["key_env"] == "NEWAPI_API_KEY"


def test_existing_openai_env_is_synced_to_current_newapi_key(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("NEWAPI_API_KEY", "root-key")
    save_official_newapi_key(api_key="root-key", activate=True)
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / ".env").write_text(
        "OPENAI_API_KEY=user-key\nOPENAI_BASE_URL=http://old-gateway/v1\n"
        "OPENROUTER_API_KEY=plugin-key\n",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "OPENAI_API_KEY=root-key" in env_text
    assert "OPENAI_API_KEY=user-key" not in env_text
    assert "OPENAI_BASE_URL" not in env_text
    assert "OPENROUTER_API_KEY=plugin-key" in env_text


def test_legacy_config_gets_default_plugin_block(
    isolated_workspace, repo_skills, repo_plugins
):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("enabled_toolsets:\n  - dramaclaw\n")

    hw.ensure_user_hermes_workspace("admin")

    config = (home / "config.yaml").read_text()
    parsed = yaml.safe_load(config)
    assert _enabled_toolsets(config) == ["hermes-acp", "memory"]
    assert "plugins:\n  enabled:\n    - dramaclaw" in config
    assert "    - freezone" not in config
    assert parsed["model"]["default"] == "brainclaw"
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert parsed["agent"]["max_turns"] == 4


def test_existing_plugin_block_gets_missing_freezone_plugin(
    isolated_workspace, repo_skills, repo_plugins
):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(
        "enabled_toolsets:\n  - hermes-acp\nplugins:\n  enabled:\n    - dramaclaw\n",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")

    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert set(parsed["plugins"]["enabled"]) == {"dramaclaw"}
    assert "freezone-acp" not in parsed["enabled_toolsets"]
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert parsed["agent"]["max_turns"] == 4


def test_legacy_identity_context_is_migrated(
    isolated_workspace, repo_skills, repo_plugins
):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    memories = home / "memories"
    memories.mkdir(parents=True)
    (home / "SOUL.md").write_text(hw._OLD_SOUL_PREFIX + "\n", encoding="utf-8")
    (memories / "MEMORY.md").write_text(hw._OLD_MEMORY_LINE + "\n", encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin")

    soul = (home / "SOUL.md").read_text(encoding="utf-8")
    memory = (memories / "MEMORY.md").read_text(encoding="utf-8")
    assert "你是虾导" in soul
    assert "You are Hermes Agent" not in soul
    assert "我是虾导，DramaClaw 的小说转视频创作助手。" not in memory
    assert "DramaClaw 管理的虾导会话" in memory
    assert "DramaClaw 管理的 Hermes 会话" not in memory


def test_stale_symlinks_removed(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    stale = home / "skills" / "json-render"
    stale.symlink_to(repo_skills / "json-render", target_is_directory=True)

    # Re-run; stale non-allowlisted symlink should be removed
    hw.ensure_user_hermes_workspace("admin")
    assert not (home / "skills" / "json-render").exists()
    assert (home / "skills" / "dramaclaw").is_symlink()  # still there


def test_stale_plugin_symlinks_removed(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    import shutil

    shutil.rmtree(repo_plugins / "dramaclaw")
    hw.ensure_user_hermes_workspace("admin")
    assert not (home / "plugins" / "dramaclaw").exists()


def test_no_repo_skills_dir(isolated_workspace):
    """Missing repo .hermes/skills should not crash; just no skill links."""
    home = hw.ensure_user_hermes_workspace("admin")
    assert home.exists()
    assert (home / "skills").is_dir()
    # _user/ should still be there
    assert (home / "skills" / "_user").is_dir()
    # but no symlinks
    assert not any(p.is_symlink() for p in (home / "skills").iterdir())


def test_user_skill_dir_not_clobbered(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    # user_skill ends up at _user — should still be writable / preserved
    user_skill = home / "skills" / "_user" / "my-favorite"
    user_skill.mkdir()
    (user_skill / "SKILL.md").write_text("# my favorite hack\n")
    hw.ensure_user_hermes_workspace("admin")
    assert (user_skill / "SKILL.md").read_text() == "# my favorite hack\n"


def test_chmod_700(isolated_workspace, repo_skills, repo_plugins):
    import os
    import stat

    home = hw.ensure_user_hermes_workspace("admin")
    mode = stat.S_IMODE(home.stat().st_mode)
    if os.name == "nt":
        # Windows has no POSIX permission bits; directories report 0o777.
        assert mode & stat.S_IRWXU == stat.S_IRWXU, f"unexpected mode {oct(mode)}"
    else:
        # On filesystems that support chmod, should be 0o700
        assert mode in (0o700, 0o755, 0o775), f"unexpected mode {oct(mode)}"
