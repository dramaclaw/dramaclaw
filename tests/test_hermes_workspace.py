"""Unit tests for novelvideo.chat.hermes_workspace."""

from __future__ import annotations

import pytest
import yaml

from novelvideo import config as app_config
from novelvideo.chat import hermes_sdk
from novelvideo.chat import hermes_workspace as hw
from novelvideo.model_gateway_settings import save_custom_newapi_gateway


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


@pytest.fixture
def isolated_workspace(tmp_path, monkeypatch):
    """Redirect DRAMACLAW_ROOT/state and repo-pinned skills to a tmp tree."""
    repo_root = tmp_path / "repo"
    state_root = repo_root / "state"
    state_root.mkdir(parents=True)
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", repo_root)
    monkeypatch.setattr(app_config, "STATE_DIR", str(state_root))
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))
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
    for name in ("json-render", "dramaclaw", "other-skill"):
        (skills / name).mkdir()
        (skills / name / "SKILL.md").write_text(f"# {name}\n")
    return skills


@pytest.fixture
def repo_plugins(isolated_workspace):
    """Create a fake repo .hermes/plugins tree."""
    plugins = isolated_workspace / ".hermes" / "plugins"
    plugins.mkdir(parents=True)
    for name in ("dramaclaw", "other-plugin"):
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
    assert not (home / "skills" / "json-render").exists()
    assert not (home / "skills" / "other-skill").exists()
    plugin_link = home / "plugins" / "dramaclaw"
    assert plugin_link.is_symlink()
    assert not (home / "plugins" / "other-plugin").exists()
    config = (home / "config.yaml").read_text()
    assert _enabled_toolsets(config) == ["hermes-acp", "memory"]
    assert "    - dramaclaw" in config
    assert "你是虾导" in (home / "SOUL.md").read_text()
    memory = (home / "memories" / "MEMORY.md").read_text()
    assert "虾导在 DramaClaw 会话中面向用户自称“虾导”" in memory
    assert "我是虾导，DramaClaw 的小说转视频创作助手。" not in memory


def test_hermes_initialize_timeout_allows_cold_start():
    assert hermes_sdk.INITIALIZE_TIMEOUT == 30.0


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


def test_hermes_detects_content_filter_error_text():
    payload = {"error": {"message": "Content filter triggered. Finish reason: 'content_filter'"}}

    assert hermes_sdk._has_content_filter_signal(payload)


def test_hermes_classifies_dramaclaw_write_tools():
    assert hermes_sdk._is_dramaclaw_write_tool("dramaclaw_generate_script")
    assert hermes_sdk._is_dramaclaw_write_tool("dramaclaw_start_single_video")
    assert not hermes_sdk._is_dramaclaw_write_tool("dramaclaw_pipeline_status")
    assert not hermes_sdk._is_dramaclaw_write_tool("dramaclaw_get_task")


def test_hermes_allows_read_tools_after_write_task():
    assert not hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_pipeline_status",
    )
    assert not hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_get_task",
    )


def test_hermes_stops_second_write_tool_after_write_task():
    assert hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_start_single_video",
    )


def test_hermes_detects_failed_tool_update():
    assert hermes_sdk._is_failed_tool_update({"status": "failed"})
    assert hermes_sdk._is_failed_tool_update({"result": {"ok": False}})
    assert not hermes_sdk._is_failed_tool_update({"status": "completed"})


def test_hermes_does_not_mark_read_task_failure_as_first_write_failure():
    assert not hermes_sdk._should_mark_first_write_failed(
        "dramaclaw_generate_script",
        "dramaclaw_get_task",
        {"result": {"status": "failed", "error": "render failed"}},
    )
    assert hermes_sdk._should_mark_first_write_failed(
        "dramaclaw_generate_script",
        "dramaclaw_generate_script",
        {"result": {"ok": False, "error": "identity_plan_required"}},
    )


def test_state_root_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    assert hw._state_root() == tmp_path / "state"


def test_state_root_falls_back_to_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", tmp_path / "repo")
    monkeypatch.delenv("NOVELVIDEO_STATE_DIR", raising=False)

    assert hw._state_root() == tmp_path / "repo" / "state"


def test_fresh_config_uses_hermes_model_env(isolated_workspace, repo_skills, repo_plugins):
    (isolated_workspace / ".env").write_text(
        "\n".join(
            [
                "NEWAPI_API_KEY=root-key",
                "HERMES_MODEL=gemini-3.5-flash",
                "HERMES_MODEL_PROVIDER=custom",
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
    assert "  provider: custom" in config
    assert "  base_url: http://newapi.local/v1" in config
    assert "  api_key: root-key" in config
    assert "  api_mode: responses" in config
    assert "  context_length: 65536" in config
    parsed = yaml.safe_load(config)
    assert parsed["model"]["context_length"] == 65536


def test_existing_config_syncs_rotated_newapi_endpoint_and_key(
    isolated_workspace, repo_skills, repo_plugins
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=old-key\nNEWAPI_BASE_URL=http://old-gateway/v1\n",
        encoding="utf-8",
    )
    home = hw.ensure_user_hermes_workspace("admin")
    config_path = home / "config.yaml"
    first = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert first["model"]["api_key"] == "old-key"
    assert first["model"]["base_url"] == "http://old-gateway/v1"

    config = config_path.read_text(encoding="utf-8") + "\ncustom_block:\n  keep: true\n"
    config_path.write_text(config, encoding="utf-8")
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=rotated-key\nNEWAPI_BASE_URL=http://new-gateway/v1\n",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")
    parsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert parsed["model"]["api_key"] == "rotated-key"
    assert parsed["model"]["base_url"] == "http://new-gateway/v1"
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

    assert parsed["model"]["api_key"] == "custom-key"
    assert parsed["model"]["base_url"] == "http://custom-gateway/v1"
    assert "OPENAI_API_KEY=custom-key" in env_text
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


def test_fresh_env_copies_root_newapi_key_as_openai_key(
    isolated_workspace, repo_skills, repo_plugins
):
    # The root NEWAPI_API_KEY is re-exposed in the per-user hermes .env as
    # OPENAI_API_KEY (the `custom` provider only reads OPENAI_API_KEY).
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=test-newapi-key\n",
        encoding="utf-8",
    )

    home = hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "OPENAI_API_KEY=test-newapi-key" in env_text


def test_existing_env_gets_missing_newapi_default_without_overwrite(
    isolated_workspace, repo_skills, repo_plugins
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\n",
        encoding="utf-8",
    )
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / ".env").write_text("OPENAI_API_KEY=user-key\n", encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")

    # Existing user-supplied OPENAI_API_KEY must be preserved, not overwritten
    # with the root NEWAPI_API_KEY value.
    assert "OPENAI_API_KEY=user-key" in env_text
    assert "OPENAI_API_KEY=root-key" not in env_text


def test_legacy_config_gets_default_plugin_block(isolated_workspace, repo_skills, repo_plugins):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("enabled_toolsets:\n  - dramaclaw\n")

    hw.ensure_user_hermes_workspace("admin")

    config = (home / "config.yaml").read_text()
    assert _enabled_toolsets(config) == ["hermes-acp"]
    assert "plugins:\n  enabled:\n    - dramaclaw" in config


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
