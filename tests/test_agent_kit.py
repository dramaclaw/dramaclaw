from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tomllib
from urllib.parse import unquote, urlsplit
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


CE_ROOT = Path(__file__).resolve().parents[1]
KIT_ROOT = CE_ROOT / "agent-kit"
SCRIPTS = KIT_ROOT / "scripts"


def _load_script(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"agent_kit_{name}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _render(host: str) -> str:
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "render_config.py"),
            "--host",
            host,
            "--ce-dir",
            str(CE_ROOT),
            "--username",
            "local",
            "--project-id",
            "project-a",
            "--canvas-id",
            "canvas-a",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "__" not in result.stdout
    return result.stdout


def test_manifest_and_skill_are_publishable() -> None:
    manifest = json.loads((KIT_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == "dramaclaw.agent-kit.v1"
    ce_requirement = manifest["requires"]["dramaclaw_ce"]
    assert ce_requirement["compatibility"] == "capability_contract"
    required_files = ce_requirement["required_files"]
    assert "src/novelvideo/chat/workflow_mcp.py" in required_files
    for path in required_files:
        assert (CE_ROOT / path).is_file()
    contract = json.loads(
        (CE_ROOT / ce_requirement["contract_file"]).read_text(encoding="utf-8")
    )
    assert contract["schema_version"] == ce_requirement["contract_schema"]
    assert contract["contract_version"] >= ce_requirement["minimum_contract_version"]
    assert set(ce_requirement["required_capabilities"]) <= set(contract["capabilities"])
    assert set(manifest["mcp_servers"]) == {"dramaclaw", "dramaclaw-workflows"}
    assert {Path(path).name for path in manifest["skills"]} == {
        "dramaclaw-workflows",
        "interactive-story",
    }
    for skill_path in manifest["skills"]:
        assert (KIT_ROOT / skill_path / "SKILL.md").is_file()
    assert (KIT_ROOT / "LICENSES" / "Elastic-2.0.txt").is_file()


def test_published_skill_matches_canonical_source() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "sync_skill.py"), "--check"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "synchronized" in result.stdout


def _flat(text: str) -> str:
    return " ".join(text.split())


def test_workflow_skill_admission_matches_hosts_without_a_chat_turn() -> None:
    """ISS-143: a host without a product chat turn opens no operation to copy."""
    root = CE_ROOT / "src" / "novelvideo" / "agent_skills" / "dramaclaw-workflows"
    skill = _flat((root / "SKILL.md").read_text(encoding="utf-8"))
    step3 = skill.split("3. Call `freezone_begin_agent_product_generation`", 1)[1].split(
        " 4. ", 1
    )[0]
    step4 = skill.split(" 4. For a normal workflow", 1)[1].split(" 5. ", 1)[0]

    # In-product admission is unchanged: copy the operation id, never invent one.
    assert (
        "Copy the returned `operation_id` exactly; never invent, abbreviate, or "
        "reconstruct one" in step3
    )
    # Hosts without a chat turn get a no-op admission and omit the id.
    assert "`agent_product_operation_not_required`" in step3
    assert "omit `operation_id`" in step3
    assert "never invent one" in step3
    assert "`agent_product_operation_not_required`" in step4

    operations = _flat(
        (root / "references" / "workflow-operations.md").read_text(encoding="utf-8")
    )
    first = operations.split("`freezone_prepare_workflow` takes exactly one", 1)[1].split(
        "It returns", 1
    )[0]
    assert "the admitted `operation_id`" in first
    assert "`agent_product_operation_not_required`" in first
    assert "omit" in first


def test_interactive_story_discovery_and_duration_contract() -> None:
    skill = (
        CE_ROOT / "src" / "novelvideo" / "agent_skills" / "interactive-story" / "SKILL.md"
    ).read_text(encoding="utf-8")
    frontmatter = skill.split("---", 2)[1]
    for trigger in (
        "FMV", "剧情画布", "占位素材试玩", "互动剧片段制作准备",
        "互动广告", "交互式视频广告", "interactive ad", "interactive video ad",
    ):
        assert trigger in frontmatter
    for boundary in ("story tools", "通用 canvas", "线性 novel-to-video", "普通线性广告"):
        assert boundary in frontmatter

    guidance = skill.split("## 面向用户的引导", 1)[1].split(
        "## 职责", 1
    )[0]
    for invariant in (
        "每条可玩路径",
        "互斥分支",
        "选择等待时间",
        "不要仅为收集该确认而打开结构化澄清卡片",
    ):
        assert invariant in guidance


def test_codex_template_renders_valid_toml() -> None:
    payload = tomllib.loads(_render("codex"))
    assert set(payload["mcp_servers"]) == {"dramaclaw", "dramaclaw_workflows"}
    assert payload["mcp_servers"]["dramaclaw"]["env"]["DRAMACLAW_PROJECT_ID"] == (
        "project-a"
    )


def test_interactive_story_reference_links_are_local_and_reachable() -> None:
    """Check progressive-disclosure navigation, not model compliance with prose."""
    root = (CE_ROOT / "src/novelvideo/agent_skills/interactive-story").resolve()
    documents = set(root.rglob("*.md"))
    pending = [root / "SKILL.md"]
    visited: set[Path] = set()
    while pending:
        document = pending.pop()
        if document in visited:
            continue
        visited.add(document)
        for href in re.findall(r"\[[^\]]*\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
            url = urlsplit(href)
            if url.scheme or not url.path:
                continue
            target = (document.parent / unquote(url.path)).resolve()
            assert target.is_relative_to(root), (document, href)
            assert target.is_file(), (document, href)
            if target.suffix == ".md":
                pending.append(target)
    assert visited == documents, f"Unreachable references: {documents - visited}"


def test_interactive_story_next_step_guide_covers_live_stage_order() -> None:
    from novelvideo.interactive_story.stage_progress import STORY_STAGE_ORDER

    guide = (
        CE_ROOT
        / "src/novelvideo/agent_skills/interactive-story/references/stage-guidance.md"
    ).read_text(encoding="utf-8")
    guided_stages = tuple(re.findall(r"^\| `(\w+)`", guide, flags=re.MULTILINE))
    assert guided_stages == STORY_STAGE_ORDER


@pytest.mark.parametrize("host", ["claude-code", "openclaw", "workbuddy", "generic"])
def test_json_host_templates_render_valid_mcp_config(host: str) -> None:
    payload = json.loads(_render(host))
    assert set(payload["mcpServers"]) == {"dramaclaw", "dramaclaw-workflows"}
    assert payload["mcpServers"]["dramaclaw"]["env"]["DRAMACLAW_CANVAS_ID"] == (
        "canvas-a"
    )


def test_launcher_rejects_remote_local_trust(monkeypatch: pytest.MonkeyPatch) -> None:
    launcher = _load_script("launch_mcp")
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    env = {
        "DRAMACLAW_API_URL": "https://example.invalid",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1",
    }
    with pytest.raises(SystemExit, match="loopback"):
        launcher._configure_tools_env(env, CE_ROOT)


@pytest.fixture
def key_launcher(monkeypatch):
    for name in (
        "DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE",
        "DRAMACLAW_AGENT_TOKEN", "DRAMACLAW_AGENT_TOKEN_FILE",
        "DRAMACLAW_LOCAL_AGENT_TRUST", "DRAMACLAW_CE_OWNER",
        "DRAMACLAW_API_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    return _load_script("launch_mcp")


def _configure_key_launcher(launcher, env):
    failure = None
    try:
        launcher._configure_tools_env(env, CE_ROOT)
    except SystemExit as exc:
        failure = str(exc)
    assert failure is None, f"key-authenticated URL must be accepted: {failure}"


@pytest.mark.parametrize("source", ["DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE"])
def test_launcher_accepts_key_https_without_default_local_trust(key_launcher, tmp_path, source):
    key_file = tmp_path / "agent.key"
    key_file.write_text("fake-agent-key-DO-NOT-USE-1111", encoding="utf-8")
    env = {
        "DRAMACLAW_API_URL": "https://agent.example.invalid",
        source: str(key_file) if source.endswith("_FILE") else "fake-agent-key-DO-NOT-USE-1111",
    }
    _configure_key_launcher(key_launcher, env)
    assert env.get("DRAMACLAW_LOCAL_AGENT_TRUST") != "1"
    assert env["DRAMACLAW_API_URL"] == "https://agent.example.invalid"


@pytest.mark.parametrize("source", ["DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE"])
@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_launcher_accepts_key_loopback_http(key_launcher, tmp_path, source, host):
    key_file = tmp_path / "agent.key"
    key_file.write_text("fake-agent-key-DO-NOT-USE-1111", encoding="utf-8")
    env = {
        "DRAMACLAW_API_URL": f"http://{host}:8780",
        source: str(key_file) if source.endswith("_FILE") else "fake-agent-key-DO-NOT-USE-1111",
    }
    _configure_key_launcher(key_launcher, env)
    assert env.get("DRAMACLAW_LOCAL_AGENT_TRUST") != "1"


@pytest.mark.parametrize("source", ["DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE"])
@pytest.mark.parametrize("host", ["agent.example.invalid", "10.0.0.5:8780"])
def test_launcher_rejects_key_remote_http_with_https_guidance(key_launcher, tmp_path, source, host):
    key = "fake-agent-key-DO-NOT-USE-1111"
    key_file = tmp_path / "agent.key"
    key_file.write_text(key, encoding="utf-8")
    env = {
        "DRAMACLAW_API_URL": f"http://{host}",
        source: str(key_file) if source.endswith("_FILE") else key,
    }
    with pytest.raises(SystemExit) as exc_info:
        key_launcher._configure_tools_env(env, CE_ROOT)
    assert "https" in str(exc_info.value)
    assert key not in str(exc_info.value)


def test_launcher_rejects_explicit_remote_local_trust_even_with_key(key_launcher):
    env = {
        "DRAMACLAW_API_URL": "https://agent.example.invalid",
        "DRAMACLAW_AGENT_KEY": "fake-agent-key-DO-NOT-USE-1111",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1",
    }
    with pytest.raises(SystemExit, match="loopback"):
        key_launcher._configure_tools_env(env, CE_ROOT)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_launcher_without_credentials_defaults_loopback_local_trust(key_launcher, host):
    env = {"DRAMACLAW_API_URL": f"http://{host}:8780"}
    key_launcher._configure_tools_env(env, CE_ROOT)
    assert env["DRAMACLAW_LOCAL_AGENT_TRUST"] == "1"


def test_launcher_without_credentials_rejects_remote_https(key_launcher):
    env = {"DRAMACLAW_API_URL": "https://agent.example.invalid"}
    with pytest.raises(SystemExit, match="loopback"):
        key_launcher._configure_tools_env(env, CE_ROOT)


def test_launcher_defaults_keep_frontend_approval_bridge() -> None:
    launcher = _load_script("launch_mcp")
    env: dict[str, str] = {}
    launcher._configure_tools_env(env, CE_ROOT)
    assert env["DRAMACLAW_EXTERNAL_MCP"] == "1"
    assert env["DRAMACLAW_AGENT_PROFILE"] == "freezone:main"
    assert env["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"].startswith(str(CE_ROOT / "state"))


def test_doctor_passes_without_mutating_local_api() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "doctor.py"),
            "--ce-dir",
            str(CE_ROOT),
            "--skip-api",
        ],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert json.loads(result.stdout)["ok"] is True


def test_doctor_accepts_source_archive_without_git_history(tmp_path) -> None:
    doctor = _load_script("doctor")
    requirement = doctor._ce_source_requirement()
    required_files = set(doctor.REQUIRED) | set(requirement["required_files"])
    for relative_path in required_files:
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        source = CE_ROOT / relative_path
        target.write_bytes(source.read_bytes())
    archive_python = tmp_path / ".venv" / "bin" / "python"
    archive_python.parent.mkdir(parents=True)
    archive_python.write_text("", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "doctor.py"),
            "--ce-dir",
            str(tmp_path),
            "--skip-api",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert not (tmp_path / ".git").exists()
    assert json.loads(result.stdout)["ok"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "required_tool"),
    [
        ("workflows", "workflow_catalog_search"),
        ("tools", "freezone_prepare_workflow_draft"),
    ],
)
async def test_launcher_completes_real_mcp_handshake(
    mode: str,
    required_tool: str,
) -> None:
    env = {
        **os.environ,
        "DRAMACLAW_CE_DIR": str(CE_ROOT),
        "DRAMACLAW_PROJECT_ID": "project-a",
        "DRAMACLAW_CANVAS_ID": "canvas-a",
        "DRAMACLAW_USERNAME": "local",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[str(SCRIPTS / "launch_mcp.py"), mode],
        env=env,
        cwd=str(CE_ROOT),
    )
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = await session.list_tools()
    assert required_tool in {tool.name for tool in tools.tools}
