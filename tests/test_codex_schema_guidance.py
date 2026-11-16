"""Observe real Codex schema conversion with scripted, loopback-only Responses.

Opt in with DRAMACLAW_TEST_CODEX_BIN. This tests the product MCP configuration
and the external agent-kit launcher, not the full patched chat runtime.

Only the product lifts Codex's tool schema budget. The agent-kit template keeps
the Codex default, which may compact nested constraint guidance away, so that
host only has to deliver both servers' tools to the model.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import tomllib

import pytest

from novelvideo.chat import service
from test_codex_app_server import (
    _recording_responses_gateway,
    _response_created,
    _response_completed,
    _responses_sse,
)
from test_mcp_schema_guidance import descriptions, assert_choice_guidance


@pytest.mark.parametrize("host", ["product", "agent-kit"])
async def test_real_codex_keeps_conditional_guidance(tmp_path, host):
    binary = os.environ.get("DRAMACLAW_TEST_CODEX_BIN")
    if not binary:
        pytest.skip(
            "set DRAMACLAW_TEST_CODEX_BIN for the real, loopback-only Codex capture"
        )
    root = Path(__file__).resolve().parents[1]
    home = tmp_path / "codex"
    home.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    token = tmp_path / "token"
    token.write_text("schema-test-token")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "CODEX_HOME": str(home),
        "PYTHONPATH": str(root / "src"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "ST_EDITION": "ce",
        "DRAMACLAW_API_URL": "http://127.0.0.1:1",
        "DRAMACLAW_AGENT_TOKEN_FILE": str(token),
        "DRAMACLAW_USERNAME": "schema-test",
        "DRAMACLAW_PROJECT_ID": "schema-project",
        "DRAMACLAW_CANVAS_ID": "schema-canvas",
        "DRAMACLAW_CHAT_SURFACE": "freezone",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR": str(tmp_path / "bridge"),
        "NOVELVIDEO_OUTPUT_DIR": str(tmp_path / "output"),
        "NOVELVIDEO_RUNTIME_DIR": str(tmp_path / "runtime"),
        "NOVELVIDEO_STATE_DIR": str(tmp_path / "state"),
    }
    if host == "product":
        servers = service._dramaclaw_mcp_servers("freezone_canvas")
        overrides = list(service._codex_mcp_config_overrides(servers))
        # Disable dotenv in every child, including hosts which inherit only a
        # narrow allowlist of environment variables in the product.
        overrides.extend(
            f"mcp_servers.{name}.env="
            + "{"
            + ",".join(
                f"{key}={json.dumps(value)}"
                for key, value in env.items()
                if key not in {"PATH", "HOME", "CODEX_HOME"}
            )
            + "}"
            for name in servers
        )
    else:
        template = (root / "agent-kit/hosts/codex/config.toml").read_text()
        replacements = {
            "__PYTHON__": sys.executable,
            "__LAUNCHER__": str(root / "agent-kit/scripts/launch_mcp.py"),
            "__DRAMACLAW_CE_DIR__": str(root),
            "__DRAMACLAW_USERNAME__": env["DRAMACLAW_USERNAME"],
            "__DRAMACLAW_API_URL__": env["DRAMACLAW_API_URL"],
            "__DRAMACLAW_PROJECT_ID__": env["DRAMACLAW_PROJECT_ID"],
            "__DRAMACLAW_CANVAS_ID__": env["DRAMACLAW_CANVAS_ID"],
        }
        for key, value in replacements.items():
            template = template.replace(key, value)
        servers = tomllib.loads(template)["mcp_servers"]
        (home / "config.toml").write_text(template)
        overrides = [
            f"mcp_servers.{name}.env="
            + "{"
            + ",".join(
                f"{key}={json.dumps(value)}"
                for key, value in {**env, **server["env"]}.items()
                if key not in {"PATH", "HOME", "CODEX_HOME"}
            )
            + "}"
            for name, server in servers.items()
        ]
    response = _responses_sse(
        _response_created("schema-capture"),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "msg",
                "content": [{"type": "output_text", "text": "done"}],
            },
        },
        _response_completed("schema-capture"),
    )
    with _recording_responses_gateway([response]) as (url, requests):
        config = [
            'model="fixture-model"',
            'model_provider="fixture"',
            'model_providers.fixture.name="fixture"',
            'model_providers.fixture.wire_api="responses"',
            f"model_providers.fixture.base_url={json.dumps(url)}",
            "model_providers.fixture.requires_openai_auth=false",
            *overrides,
        ]
        command = [binary, "app-server"]
        for setting in config:
            command.extend(["-c", setting])
        with (tmp_path / "stderr.log").open("wb") as stderr:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=workspace,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr,
                limit=8 * 1024 * 1024,
            )
            serial = 0

            async def rpc(method, params, until=None):
                nonlocal serial
                serial += 1
                process.stdin.write(
                    (
                        json.dumps({"id": serial, "method": method, "params": params})
                        + "\n"
                    ).encode()
                )
                await process.stdin.drain()
                result = None
                async with asyncio.timeout(90):
                    while line := await process.stdout.readline():
                        message = json.loads(line)
                        if message.get("id") == serial and "method" not in message:
                            assert "error" not in message, message
                            result = message["result"]
                        if result is not None and (
                            until is None or message.get("method") == until
                        ):
                            return result
                raise AssertionError((tmp_path / "stderr.log").read_text())

            try:
                await rpc(
                    "initialize",
                    {
                        "clientInfo": {"name": "schema_capture", "version": "1"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                thread = await rpc(
                    "thread/start", {"cwd": str(workspace), "approvalPolicy": "never"}
                )
                await rpc(
                    "turn/start",
                    {
                        "threadId": thread["thread"]["id"],
                        "input": [
                            {"type": "text", "text": "Say done without calling tools."}
                        ],
                    },
                    "turn/completed",
                )
            finally:
                if process.returncode is None:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), 10)
    assert len(requests) == 1
    request = requests[0]["body"]
    (tmp_path / "model-request.json").write_text(
        json.dumps(request, ensure_ascii=False, indent=2)
    )
    tools = {}

    def collect(value):
        if isinstance(value, dict):
            if "parameters" in value and "name" in value:
                tools[value["name"]] = value["parameters"]
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(request)
    print(
        f"{host}: {len(tools)} tools; model tool JSON bytes={len(json.dumps(tools, ensure_ascii=False).encode())}; capture={tmp_path}"
    )
    assert "dramaclaw_patch_interactive_story" in tools, sorted(tools)
    assert {"workflow_catalog_search", "workflow_graph_compile"} <= set(tools)
    if host == "agent-kit":
        return
    create = tools["dramaclaw_create_interactive_story"]["properties"]["story"]
    assert_choice_guidance(create["properties"]["choices"]["items"])
    patch = tools["dramaclaw_patch_interactive_story"]["properties"]["operations"][
        "items"
    ]["oneOf"]
    add_choice = next(
        variant
        for variant in patch
        if variant["properties"]["op"]["enum"] == ["add_choice"]
    )
    assert_choice_guidance(add_choice["properties"]["choice"])
    shown = tools["dramaclaw_patch_interactive_story"]
    text = descriptions(shown)
    for rule in (
        '"if":',
        '"else":',
        '"automatic"',
        '"baked_video"',
        '"minimum":300',
        '"pattern":',
    ):
        assert rule in text, rule
    assert '"maximum":50' in descriptions(tools["workflow_catalog_search"])
    assert '"minLength":' in descriptions(tools["workflow_graph_compile"])
