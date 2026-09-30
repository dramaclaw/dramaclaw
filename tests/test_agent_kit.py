from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tomllib
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
    assert (KIT_ROOT / manifest["skills"][0] / "SKILL.md").is_file()
    assert (KIT_ROOT / "LICENSES" / "Elastic-2.0.txt").is_file()


def test_published_skill_matches_canonical_source() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "sync_skill.py"), "--check"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "synchronized" in result.stdout


def test_codex_template_renders_valid_toml() -> None:
    payload = tomllib.loads(_render("codex"))
    assert set(payload["mcp_servers"]) == {"dramaclaw", "dramaclaw_workflows"}
    assert payload["mcp_servers"]["dramaclaw"]["env"]["DRAMACLAW_PROJECT_ID"] == (
        "project-a"
    )


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


def test_launcher_defaults_keep_frontend_approval_bridge() -> None:
    launcher = _load_script("launch_mcp")
    env: dict[str, str] = {}
    launcher._configure_tools_env(env, CE_ROOT)
    assert env["DRAMACLAW_MCP_DIRECT_CANVAS_APPLY"] == "0"
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
