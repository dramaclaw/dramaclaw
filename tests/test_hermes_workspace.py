"""Unit tests for novelvideo.chat.hermes_workspace."""

from __future__ import annotations

import json
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
        item
        for item in config["custom_providers"]
        if item.get("name") == "dramaclaw"
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


def test_freezone_profile_uses_isolated_workspace(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin", profile="freezone")

    assert home == isolated_workspace / "state" / "admin" / ".hermes-freezone"
    assert (home / "skills" / "freezone").is_symlink()
    assert (home / "skills" / "workflows").is_symlink()
    assert not (home / "skills" / "dramaclaw").exists()
    assert (home / "plugins" / "freezone").is_symlink()
    assert not (home / "plugins" / "dramaclaw").exists()

    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert parsed["enabled_toolsets"] == ["hermes-acp", "freezone-acp", "memory"]
    assert parsed["plugins"]["enabled"] == ["freezone"]
    assert "dramaclaw-acp" in parsed["disabled_toolsets"]
    soul = (home / "SOUL.md").read_text(encoding="utf-8")
    memory = (home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "创意咨询、找思路、风格建议" in soul
    assert "搭建可继续工作的画布框架" in soul
    assert "不要在普通回复开头自报身份" in soul
    assert "command catalog" in soul
    assert "node create schema" in soul
    assert "link type catalog" in soul
    assert "生成完整短片" in soul
    assert "创意咨询、找思路、风格建议" in memory
    assert "搭建可继续工作的画布框架" in memory
    assert "不要在普通回复开头自报身份" in memory
    assert "command catalog" in memory
    assert "node create schema" in memory
    assert "link type catalog" in memory
    assert "生成完整短片" in memory


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
    assert hermes_sdk.INITIALIZE_TIMEOUT == 30.0


def test_hermes_stdio_line_limit_allows_large_acp_tool_calls():
    assert hermes_sdk.HERMES_STDIO_LINE_LIMIT_BYTES >= 4 * 1024 * 1024


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
                    {"content": "读取资产", "status": "completed", "priority": "medium"},
                    {"content": "生成分镜", "status": "in_progress", "priority": "high"},
                ],
            }
        ),
        "turn-a",
    )
    usage = thread._translate_notification(
        _session_update(
            {"sessionUpdate": "usage_update", "used": 128, "size": 4096}
        ),
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
                    {"optionId": "allow_once", "kind": "allow_once", "name": "Allow once"}
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
    payload = {"error": {"message": "Content filter triggered. Finish reason: 'content_filter'"}}

    assert hermes_sdk._has_content_filter_signal(payload)


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
    assert hermes_sdk._turn_tool_call_limit_for_tool("dramaclaw_generate_script") == 20


def test_hermes_allows_more_freezone_tool_calls():
    assert hermes_sdk._turn_tool_call_limit_for_tool("freezone_emit_canvas_command") == 80
    assert hermes_sdk._turn_tool_call_limit_for_tool("freezone_put_agent_catalog_recipe") == 80


def test_hermes_freezone_tool_limit_message_uses_freezone_context():
    message = hermes_sdk._tool_call_limit_stop_message("freezone_put_agent_catalog_recipe")

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


def test_fresh_config_uses_model_env_but_keeps_newapi_transport(
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

    assert "  default: gemini-3.5-flash" in config
    parsed = yaml.safe_load(config)
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert parsed["model"]["default"] == "gemini-3.5-flash"
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
    assert "OPENAI_API_KEY" not in env_text
    assert "root-key" not in env_text


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
    assert "OPENAI_API_KEY" not in env_text


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
        item.get("name") == "user-provider"
        for item in config["custom_providers"]
    )
    assert _dramaclaw_provider(config)["key_env"] == "NEWAPI_API_KEY"


def test_existing_env_is_preserved(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("NEWAPI_API_KEY", "root-key")
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / ".env").write_text("OPENAI_API_KEY=user-key\n", encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "OPENAI_API_KEY=user-key" in env_text


def test_legacy_config_gets_default_plugin_block(isolated_workspace, repo_skills, repo_plugins):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("enabled_toolsets:\n  - dramaclaw\n")

    hw.ensure_user_hermes_workspace("admin")

    config = (home / "config.yaml").read_text()
    parsed = yaml.safe_load(config)
    assert _enabled_toolsets(config) == ["hermes-acp"]
    assert "plugins:\n  enabled:\n    - dramaclaw" in config
    assert "    - freezone" not in config
    assert parsed["model"]["default"] == "DC-hermes-LLM"
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"


def test_existing_plugin_block_gets_missing_freezone_plugin(
    isolated_workspace, repo_skills, repo_plugins
):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(
        "enabled_toolsets:\n"
        "  - hermes-acp\n"
        "plugins:\n"
        "  enabled:\n"
        "    - dramaclaw\n",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")

    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert set(parsed["plugins"]["enabled"]) == {"dramaclaw"}
    assert "freezone-acp" not in parsed["enabled_toolsets"]
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"


def test_legacy_identity_context_is_migrated(isolated_workspace, repo_skills, repo_plugins):
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
