"""Security contract tests for Codex App Server filesystem access.

These tests intentionally distinguish the two boundaries involved here:

* DramaClaw business and canvas access is MCP-only.
* The Codex runtime is not an MCP-only file reader: it receives a workspace cwd
  and may read managed bootstrap files. Native mutation and command surfaces
  must therefore remain disabled and the runtime sandbox must stay read-only.
"""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from novelvideo.chat import backend_sdk, codex_app_server, dramaclaw_mcp, service
from novelvideo.chat.backend_sdk import CodexThread


def test_native_file_and_command_surfaces_remain_disabled():
    overrides = set(
        service._codex_gateway_config_overrides("https://gateway.example/v1")
    )

    assert "features.shell_tool=false" in overrides
    assert "features.view_image=false" in overrides
    assert "features.apps=false" in overrides
    assert "features.hooks=false" in overrides
    assert "features.plugins=false" in overrides
    assert "features.multi_agent=false" in overrides
    assert 'web_search="disabled"' in overrides


def test_native_command_and_file_approval_requests_fail_closed():
    assert codex_app_server._deny_unexpected_approval(
        "item/commandExecution/requestApproval",
        {"command": "cat /etc/passwd"},
    ) == {"decision": "decline"}
    assert codex_app_server._deny_unexpected_approval(
        "item/fileChange/requestApproval",
        {"changes": [{"path": "outside.txt"}]},
    ) == {"decision": "decline"}


def test_shared_node_process_does_not_receive_project_or_provider_secrets():
    filtered = codex_app_server._node_process_env(
        {
            "CODEX_HOME": "/state/.codex-app-server",
            "PATH": "/usr/bin",
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": "https://gateway.example/v1",
            "DRAMACLAW_AGENT_TOKEN": "project-secret",
            "DRAMACLAW_AGENT_TOKEN_FILE": "/state/project/turn.token",
            "DRAMACLAW_PROJECT_ID": "project-a",
            "NEWAPI_API_KEY": "gateway-secret",
            "OPENAI_API_KEY": "openai-secret",
            "UNLISTED_SECRET": "ambient-secret",
        }
    )

    assert filtered == {
        "CODEX_HOME": "/state/.codex-app-server",
        "PATH": "/usr/bin",
        "DRAMACLAW_CODEX_GATEWAY_BASE_URL": "https://gateway.example/v1",
    }


@pytest.mark.anyio
async def test_skill_mcp_reader_is_confined_to_managed_markdown(monkeypatch, tmp_path):
    skills_root = tmp_path / "workspace" / ".agents" / "skills"
    skill_dir = skills_root / "safe-skill"
    skill_dir.mkdir(parents=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text("safe skill", encoding="utf-8")
    secret_file = tmp_path / "host-secret.txt"
    secret_file.write_text("must not be exposed", encoding="utf-8")
    escape_link = skill_dir / "references" / "escape.md"
    escape_link.parent.mkdir()
    escape_link.symlink_to(secret_file)

    monkeypatch.setenv("DRAMACLAW_SKILLS_DIR", str(skills_root))
    monkeypatch.chdir(tmp_path / "workspace")

    assert await dramaclaw_mcp.read_resource(skill_file.as_uri()) == "safe skill"
    with pytest.raises(ValueError, match="outside the agent skills directory"):
        await dramaclaw_mcp.read_resource(secret_file.as_uri())
    with pytest.raises(ValueError, match="different agent workspace"):
        await dramaclaw_mcp.read_resource(escape_link.as_uri())


@pytest.mark.anyio
async def test_every_codex_thread_is_deny_all_and_read_only(monkeypatch, tmp_path):
    from openai_codex import ApprovalMode, Sandbox
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    captured = {}
    completed = Notification(
        method="turn/completed",
        payload=v2.TurnCompletedNotification.model_validate(
            {
                "threadId": "thread-security",
                "turn": {
                    "id": "turn-security",
                    "items": [],
                    "status": "completed",
                },
            }
        ),
    )

    class FakeThread:
        id = "thread-security"

    class FakeTurn:
        id = "turn-security"

        def stream(self):
            return iter([completed])

        def interrupt(self):
            return None

    @contextmanager
    def fake_shared_codex(_config):
        yield SimpleNamespace()

    def capture_thread(_codex, _thread_id, options):
        captured.update(options)
        return FakeThread()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(backend_sdk, "_start_or_resume_codex_thread", capture_thread)
    monkeypatch.setattr(
        backend_sdk,
        "_start_codex_turn",
        lambda *_args, **_kwargs: FakeTurn(),
    )

    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=(),
        thread_config={"mcp_servers.dramaclaw.required": True},
        turn_metadata={},
        thread_id=None,
    )

    events = [event async for event in thread.stream("Inspect the project")]

    assert captured["approval_mode"] == ApprovalMode.deny_all
    assert captured["sandbox"] == Sandbox.read_only
    assert captured["cwd"] == str(tmp_path)
    assert captured["config"] == {"mcp_servers.dramaclaw.required": True}
    assert events[-1].type == "complete"


def test_canvas_business_tools_are_exposed_only_by_required_mcp_servers():
    servers = service._dramaclaw_mcp_servers("freezone_canvas")
    overrides = service._codex_mcp_config_overrides(servers)
    rendered = "\n".join(overrides)

    assert set(servers) == {"dramaclaw", "dramaclaw_workflows"}
    assert "mcp_servers.dramaclaw.required=true" in rendered
    assert "mcp_servers.dramaclaw_workflows.required=true" in rendered
    assert 'mcp_servers.dramaclaw.default_tools_approval_mode="approve"' in rendered
    assert (
        'mcp_servers.dramaclaw_workflows.default_tools_approval_mode="approve"'
        in rendered
    )
