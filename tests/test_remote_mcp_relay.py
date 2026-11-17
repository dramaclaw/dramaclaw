"""Executable contract for the standalone remote MCP relay (implementation pending)."""

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
import pytest


ROOT = Path(__file__).resolve().parents[1]
RELAY = ROOT / "agent-kit/scripts/remote_mcp_relay.py"
LAUNCHER = ROOT / "agent-kit/scripts/launch_mcp.py"
FAKE = ROOT / "tests/fixtures/remote_mcp_fake_server.py"
KEY = "fake-relay-key-DO-NOT-USE-7f3a9c"
OTHER_KEY = "fake-relay-key-DO-NOT-USE-second"
SECRETS = (KEY, OTHER_KEY, "poison-token-value", "poison-key-value")
INITIALIZE = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "relay-contract", "version": "1"},
    },
}
LIST_TOOLS = {"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {}}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def clean_env():
    # Keep host credentials and agent profile settings out of test subprocesses.
    return {
        k: v for k, v in os.environ.items()
        if not k.startswith(("DRAMACLAW_", "ST_", "SUPERTALE_", "REMOTE_MCP_FAKE_"))
    } | {"PYTHONDONTWRITEBYTECODE": "1"}


def assert_secret_free(text):
    assert not any(secret in text for secret in SECRETS), "Credential leaked"


def pid_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def wait_reaped(pid):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not pid_exists(pid):
            state = subprocess.run(
                ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True,
                check=False,
            ).stdout.strip()
            assert not state.startswith("Z"), "Child became a zombie"
            return
        await asyncio.sleep(0.05)
    pytest.fail("Child still exists (including possible zombie) after 10 seconds")


class Relay:
    def __init__(self, directory, *, idle=20, real=False, ignore_term=False):
        self.directory = directory
        self.ce_dir = ROOT if real else directory / "ce"
        if not real:
            self.ce_dir.mkdir()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.api_url = f"http://127.0.0.1:{free_port()}" if real else "http://127.0.0.1:9"
        self.pid_log = directory / "children.txt"
        self.bodies = []
        self.env = clean_env() | {
            "REMOTE_MCP_FAKE_EXPECTED_KEY_SHA256": hashlib.sha256(KEY.encode()).hexdigest(),
            "REMOTE_MCP_FAKE_PID_LOG": str(self.pid_log),
            "REMOTE_MCP_FAKE_NOTIFICATION_LOG": str(directory / "notifications.jsonl"),
            "DRAMACLAW_AGENT_KEY": "poison-key-value",
            "DRAMACLAW_AGENT_TOKEN": "poison-token-value",
            "DRAMACLAW_AGENT_KEY_FILE": "poison-key-value",
            "DRAMACLAW_AGENT_TOKEN_FILE": "poison-token-value",
        }
        if ignore_term:
            self.env["REMOTE_MCP_FAKE_IGNORE_TERM"] = "1"
        if real:
            self.env["DRAMACLAW_PROJECT_ID"] = "relay-test-project"
        self.command = [
            sys.executable, str(RELAY), "--host", "127.0.0.1", "--port", str(self.port),
            "--idle-timeout", str(idle), "--api-url", self.api_url,
            "--username", "relay-user", "--ce-dir", str(self.ce_dir),
        ]
        if real:
            self.command += ["--child-python", str(ROOT / ".venv/bin/python")]
        else:
            self.command += ["--launch-script", str(FAKE)]
        self.stdout = (directory / "stdout.log").open("wb")
        self.stderr = (directory / "stderr.log").open("wb")
        self.process = None

    def start(self):
        self.process = subprocess.Popen(
            self.command, env=self.env, stdout=self.stdout, stderr=self.stderr, cwd=ROOT,
        )
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                pytest.fail("Relay exited before readiness; see captured stdout.log/stderr.log")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.05)
        pytest.fail("Relay did not listen within 8 seconds")

    def close(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        finally:
            self.stdout.close()
            self.stderr.close()
            # Clean up leaked fake children even when a lifecycle assertion failed.
            if self.pid_log.exists():
                for value in self.pid_log.read_text().splitlines():
                    try:
                        os.kill(int(value), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        for name in ("stdout.log", "stderr.log"):
            assert_secret_free((self.directory / name).read_text(errors="replace"))
        for body in self.bodies:
            assert_secret_free(body)

    async def request(self, method, path="/mcp/tools", *, key=KEY, sid=None, **kwargs):
        headers = {"Accept": "application/json, text/event-stream"}
        if key is not None:
            headers["Authorization"] = f"Bearer {key}"
        if sid is not None:
            headers["Mcp-Session-Id"] = sid
            headers["MCP-Protocol-Version"] = "2025-03-26"
        headers.update(kwargs.pop("headers", {}))
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            response = await client.request(method, self.url + path, headers=headers, **kwargs)
        self.bodies.append(response.text)
        assert_secret_free(response.text)
        return response

    @asynccontextmanager
    async def session(self, mode="tools", *, delete=True):
        async with streamablehttp_client(
            self.url + f"/mcp/{mode}", headers={"Authorization": f"Bearer {KEY}"},
            timeout=8, sse_read_timeout=12, terminate_on_close=delete,
        ) as (reader, writer, get_id):
            async with ClientSession(
                reader, writer, read_timeout_seconds=timedelta(seconds=8),
            ) as session:
                initialized = await session.initialize()
                assert get_id(), "Initialize must establish a session"
                yield session, get_id(), initialized


@pytest.fixture
def relay_factory(tmp_path):
    relays = []

    def start(**kwargs):
        directory = tmp_path / str(len(relays))
        directory.mkdir()
        relay = Relay(directory, **kwargs)
        relays.append(relay)
        relay.start()
        return relay

    yield start
    for relay in reversed(relays):
        relay.close()


async def whoami(session):
    result = await session.call_tool("whoami", {})
    assert result.isError is False
    return json.loads(result.content[0].text)


def serialized(result):
    return json.dumps(result.model_dump(mode="json", by_alias=True, exclude_none=True),
                      sort_keys=True)


async def direct_tools(script, mode, env, ce_dir, python=sys.executable):
    params = StdioServerParameters(
        command=python, args=[str(script), mode, "--ce-dir", str(ce_dir)], env=env, cwd=str(ROOT),
    )
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(
            reader, writer, read_timeout_seconds=timedelta(seconds=8),
        ) as session:
            await session.initialize()
            return serialized(await session.list_tools())


def test_rejects_missing_invalid_and_empty_authorization(relay_factory):
    relay = relay_factory()

    async def scenario():
        for authorization in (None, "Basic xxx", "Bearer"):
            headers = {} if authorization is None else {"Authorization": authorization}
            response = await relay.request("POST", key=None, headers=headers, json=INITIALIZE)
            assert response.status_code == 401
            assert "www-authenticate" not in response.headers
        await asyncio.sleep(0.1)
        assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""

    asyncio.run(scenario())


def test_unknown_and_well_known_paths_are_404(relay_factory):
    relay = relay_factory()

    async def scenario():
        for path in (
            "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource/mcp/tools", "/.well-known/arbitrary",
            "/mcp/other", "/",
        ):
            for method in ("GET", "POST"):
                for key in (None, KEY):
                    response = await relay.request(method, path, key=key, json=INITIALIZE)
                    assert response.status_code == 404
        assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""

    asyncio.run(scenario())


def test_tools_resources_and_child_environment(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, _, initialized):
            assert initialized.serverInfo.name == "fake-tools"
            names = [t.name for t in (await session.list_tools()).tools]
            assert names == ["whoami", "sleep", "echo"]
            echoed = await session.call_tool("echo", {"text": "literal echo: ☃"})
            assert echoed.isError is False
            assert echoed.content[0].text == "literal echo: ☃"
            identity = await whoami(session)
            assert identity == {
                "mode": "tools", "pid": identity["pid"], "key_matches": True,
                "has_token_env": False, "has_key_file_env": False,
                "ce_dir": str(relay.ce_dir), "api_url": "http://127.0.0.1:9",
                "username": "relay-user",
            }
            assert relay.pid_log.read_text().splitlines() == [str(identity["pid"])]
            await session.send_progress_notification("literal-token", 3, 7, "literal progress")
            notification_log = relay.directory / "notifications.jsonl"
            deadline = time.monotonic() + 3
            while not notification_log.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert json.loads(notification_log.read_text()) == {
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {
                    "progressToken": "literal-token", "progress": 3, "total": 7,
                    "message": "literal progress",
                },
            }
            resources = (await session.list_resources()).resources
            actual = [(str(r.uri), r.mimeType) for r in resources]
            assert actual == [("fake://doc", "text/markdown")]
            templates = (await session.list_resource_templates()).resourceTemplates
            assert [t.uriTemplate for t in templates] == ["fake://item/{name}"]
            read = await session.read_resource("fake://doc")
            assert read.contents[0].text == "# fake doc"
            assert read.contents[0].mimeType == "text/markdown"

    asyncio.run(scenario())


def test_workflows_path_selects_workflows_server(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session("workflows") as (session, _, initialized):
            assert initialized.serverInfo.name == "fake-workflows"
            assert [t.name for t in (await session.list_tools()).tools] == [
                "whoami", "sleep", "echo", "workflow_only",
            ]
            assert (await whoami(session))["mode"] == "workflows"

    asyncio.run(scenario())


def test_tool_definitions_match_direct_stdio_byte_for_byte(relay_factory):
    relay = relay_factory()

    async def scenario():
        for mode in ("tools", "workflows"):
            expected = await direct_tools(FAKE, mode, clean_env(), relay.ce_dir)
            async with relay.session(mode) as (session, _, _):
                assert serialized(await session.list_tools()) == expected

    asyncio.run(scenario())


def test_session_cannot_be_hijacked(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, sid, _):
            response = await relay.request("POST", key=OTHER_KEY, sid=sid, json=LIST_TOOLS)
            assert response.status_code in (401, 404)
            response = await relay.request("POST", key=None, sid=sid, json=LIST_TOOLS)
            assert response.status_code == 401
            assert "www-authenticate" not in response.headers
            assert (await whoami(session))["key_matches"] is True

    asyncio.run(scenario())


@pytest.mark.parametrize("ignore_term", [False, True])
def test_delete_terminates_and_reaps_child(relay_factory, ignore_term):
    relay = relay_factory(ignore_term=ignore_term)

    async def scenario():
        async with relay.session() as (session, sid, _):
            pid = (await whoami(session))["pid"]
        await wait_reaped(pid)
        response = await relay.request("POST", sid=sid, json=LIST_TOOLS)
        assert response.status_code >= 400

    asyncio.run(scenario())


def test_idle_timeout_reaps_child_with_open_get_stream(relay_factory):
    relay = relay_factory(idle=2)

    async def scenario():
        async with relay.session(delete=False) as (session, sid, _):
            pid = (await whoami(session))["pid"]
        async with httpx.AsyncClient(timeout=12, trust_env=False) as client:
            async with client.stream("GET", relay.url + "/mcp/tools", headers={
                "Authorization": f"Bearer {KEY}", "Mcp-Session-Id": sid,
                "Accept": "text/event-stream", "MCP-Protocol-Version": "2025-03-26",
            }) as response:
                assert response.status_code == 200
                assert response.headers["content-type"].startswith("text/event-stream")
                await wait_reaped(pid)
        response = await relay.request("POST", sid=sid, json=LIST_TOOLS)
        assert response.status_code >= 400

    asyncio.run(scenario())


def test_long_post_is_not_reaped(relay_factory):
    relay = relay_factory(idle=2)

    async def scenario():
        async with relay.session() as (session, _, _):
            pid = (await whoami(session))["pid"]
            result = await session.call_tool("sleep", {"seconds": 5})
            assert result.isError is False
            assert result.content[0].text == "slept"
            assert pid_exists(pid)
            # Idle time starts at completion, not at the start of the long call.
            await asyncio.sleep(0.5)
            assert (await whoami(session))["pid"] == pid

    asyncio.run(scenario())


def test_child_exit_invalidates_session_without_hanging(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session(delete=False) as (session, sid, _):
            pid = (await whoami(session))["pid"]
            os.kill(pid, signal.SIGKILL)
            await wait_reaped(pid)
            response = await relay.request("POST", sid=sid, json=LIST_TOOLS)
            assert response.status_code >= 400

    asyncio.run(scenario())


@pytest.mark.parametrize("shutdown_signal", [signal.SIGTERM, signal.SIGINT])
def test_relay_shutdown_reaps_children(relay_factory, shutdown_signal):
    relay = relay_factory()

    async def scenario():
        async with relay.session(delete=False) as (session, _, _):
            pid = (await whoami(session))["pid"]
        relay.process.send_signal(shutdown_signal)
        await asyncio.to_thread(relay.process.wait, timeout=10)
        await wait_reaped(pid)

    asyncio.run(scenario())


def test_credentials_never_appear_in_process_command_lines(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, _, _):
            await whoami(session)
            commands = subprocess.run(
                ["ps", "-ax", "-o", "command"], check=True, capture_output=True, text=True,
            ).stdout
            assert_secret_free(commands)

    asyncio.run(scenario())


def test_cli_help_and_defaults():
    result = subprocess.run(
        [sys.executable, str(RELAY), "--help"], capture_output=True, text=True, timeout=5,
        env=clean_env(),
    )
    assert result.returncode == 0
    for option in (
        "--idle-timeout", "--host", "--port", "--ce-dir", "--api-url", "--username",
        "--launch-script", "--child-python",
    ):
        assert option in result.stdout
    spec = importlib.util.spec_from_file_location("remote_mcp_relay", RELAY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        args = module.build_arg_parser().parse_args([])
        assert args.host == "127.0.0.1"
        assert args.idle_timeout == 600
        assert str(args.launch_script) == str(LAUNCHER)
        assert str(args.child_python) == sys.executable
    finally:
        sys.modules.pop(spec.name, None)


def test_real_launcher_tool_definitions_match_direct_stdio(relay_factory):
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        pytest.skip("Real launcher requires the repository .venv/bin/python")
    relay = relay_factory(real=True)
    # Discovery builds local schemas; agent_key_session.request exchanges keys lazily.
    env = clean_env() | {
        "DRAMACLAW_AGENT_KEY": KEY, "DRAMACLAW_API_URL": relay.api_url,
        "DRAMACLAW_USERNAME": "relay-user", "DRAMACLAW_CE_DIR": str(ROOT),
        "DRAMACLAW_PROJECT_ID": "relay-test-project",
    }

    async def scenario():
        for mode in ("tools", "workflows"):
            expected = await direct_tools(LAUNCHER, mode, env, ROOT, str(python))
            assert json.loads(expected)["tools"]
            async with relay.session(mode) as (session, _, _):
                assert serialized(await session.list_tools()) == expected

    asyncio.run(scenario())
