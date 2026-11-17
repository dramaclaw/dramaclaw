"""Executable contract for the standalone remote MCP relay (implementation pending)."""

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from threading import Thread

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
FAKE_TOKEN = "fake-exchange-token-DO-NOT-USE-91c2"
SECRETS = (KEY, OTHER_KEY, FAKE_TOKEN, "poison-token-value", "poison-key-value")
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


class Exchange:
    def __init__(self, mode="ok"):
        self.requests = []
        exchange = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                matches = self.headers.get("Authorization") == f"Bearer {KEY}"
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                exchange.requests.append({
                    "path": self.path, "body": body, "authorization_matches": matches,
                    "content_type": self.headers.get("Content-Type"),
                    "accept": self.headers.get("Accept"),
                })
                if self.path != "/api/v1/agent/sessions":
                    status, payload = 404, {"ok": False}
                elif mode == "ok" and matches:
                    status, payload = 200, {
                        "ok": True, "data": {"token": FAKE_TOKEN, "expires_at": time.time() + 60},
                    }
                else:
                    status = 200 if mode == "bad-body" else 401 if mode == "ok" else int(mode)
                    payload = {"ok": False}
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class Relay:
    def __init__(
        self, directory, *, idle=20, real=False, ignore_term=False,
        exchange_mode="ok", api_url=None, launch_script=None,
    ):
        self.directory = directory
        self.ce_dir = ROOT if real else directory / "ce"
        if not real:
            self.ce_dir.mkdir()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.exchange = Exchange(exchange_mode)
        self.api_url = api_url or f"http://127.0.0.1:{self.exchange.port}"
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
        if not real:
            self.env["DRAMACLAW_PROJECT_ID"] = "inherited-project"
            self.env["DRAMACLAW_CANVAS_ID"] = "inherited-canvas"
        self.command = [
            sys.executable, str(RELAY), "--host", "127.0.0.1", "--port", str(self.port),
            "--idle-timeout", str(idle), "--api-url", self.api_url,
            "--username", "relay-user", "--ce-dir", str(self.ce_dir),
        ]
        if real:
            self.command += ["--child-python", str(ROOT / ".venv/bin/python")]
        else:
            self.command += ["--launch-script", str(launch_script or FAKE)]
        self.stdout = (directory / "stdout.log").open("wb")
        self.stderr = (directory / "stderr.log").open("wb")
        self.process = None

    def spawn(self):
        self.process = subprocess.Popen(
            self.command, env=self.env, stdout=self.stdout, stderr=self.stderr, cwd=ROOT,
        )

    def start(self):
        self.spawn()
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
            self.exchange.close()
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
    async def session(self, mode="tools", *, path=None, delete=True):
        async with streamablehttp_client(
            self.url + (path if path is not None else f"/mcp/{mode}"),
            headers={"Authorization": f"Bearer {KEY}"},
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

    def start(*, wait_ready=True, **kwargs):
        directory = tmp_path / str(len(relays))
        directory.mkdir()
        relay = Relay(directory, **kwargs)
        relays.append(relay)
        if wait_ready:
            relay.start()
        else:
            relay.spawn()
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
            assert names == ["whoami", "sleep", "echo", "noisy"]
            echoed = await session.call_tool("echo", {"text": "literal echo: ☃"})
            assert echoed.isError is False
            assert echoed.content[0].text == "literal echo: ☃"
            identity = await whoami(session)
            assert identity == {
                "mode": "tools", "pid": identity["pid"], "key_matches": True,
                "project_id": None, "canvas_id": None,
                "has_token_env": False, "has_key_file_env": False,
                "ce_dir": str(relay.ce_dir),
                "api_url": f"http://127.0.0.1:{relay.exchange.port}",
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


def test_stray_child_stdout_preserves_session(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, sid, _):
            pid = (await whoami(session))["pid"]
            try:
                await asyncio.wait_for(session.call_tool("noisy", {}), 10)
            except Exception:
                # Only this call may fail; subsequent calls must use the same live child.
                pass
            echoed = await session.call_tool("echo", {"text": "after noise"})
            assert echoed.isError is False
            assert echoed.content[0].text == "after noise"
            assert (await whoami(session))["pid"] == pid
            assert pid_exists(pid)
            return sid

    sid = asyncio.run(scenario())
    relay.close()
    logs = "\n".join(
        (relay.directory / name).read_text(errors="replace")
        for name in ("stderr.log", "stdout.log")
    )
    message = f"Session {sid[:8]} (tools) skipped an unreadable message from child"
    assert logs.count(message) == 1
    assert "stray-stdout-line-not-json-5d1e" not in logs
    assert_secret_free(logs)


def test_aborted_post_body_preserves_session(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, sid, _):
            pid = (await whoami(session))["pid"]
            with socket.create_connection(("127.0.0.1", relay.port), timeout=3) as sock:
                request = (
                    "POST /mcp/tools HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{relay.port}\r\n"
                    f"Authorization: Bearer {KEY}\r\n"
                    f"Mcp-Session-Id: {sid}\r\n"
                    "MCP-Protocol-Version: 2025-03-26\r\n"
                    "Accept: application/json, text/event-stream\r\n"
                    "Content-Type: application/json\r\n"
                    "Content-Length: 500\r\n\r\n"
                    '{"jsonrpc"'
                )
                sock.sendall(request.encode())
                await asyncio.sleep(0.3)
            await asyncio.sleep(1.5)
            identity = await asyncio.wait_for(whoami(session), 5)
            assert identity["pid"] == pid
            assert pid_exists(pid)

    asyncio.run(scenario())


def test_workflows_path_selects_workflows_server(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session("workflows") as (session, _, initialized):
            assert initialized.serverInfo.name == "fake-workflows"
            assert [t.name for t in (await session.list_tools()).tools] == [
                "whoami", "sleep", "echo", "workflow_only", "noisy",
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
        assert args.api_url == "http://127.0.0.1:8780"
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
    }

    async def scenario():
        for mode in ("tools", "workflows"):
            expected = await direct_tools(LAUNCHER, mode, env, ROOT, str(python))
            if mode == "workflows":
                assert json.loads(expected)["tools"]
            async with relay.session(mode) as (session, _, _):
                assert serialized(await session.list_tools()) == expected

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["tools", "workflows"])
def test_key_exchange_once_per_new_session(relay_factory, mode):
    relay = relay_factory()

    async def scenario():
        for count in (1, 2):
            async with relay.session(mode) as (session, _, _):
                assert (await whoami(session))["key_matches"] is True
                await session.list_tools()
                assert relay.exchange.requests == [{
                    "path": "/api/v1/agent/sessions",
                    "body": {"scope": {"kind": "home"}, "ttl_seconds": 60},
                    "authorization_matches": True,
                    "content_type": "application/json", "accept": "application/json",
                }] * count

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["tools", "workflows"])
@pytest.mark.parametrize("exchange_mode", ["401", "403", "ok"])
def test_rejected_exchange_never_starts_child(relay_factory, mode, exchange_mode):
    relay = relay_factory(exchange_mode=exchange_mode)

    async def scenario():
        response = await relay.request(
            "POST", f"/mcp/{mode}", key=OTHER_KEY if exchange_mode == "ok" else KEY,
            json=INITIALIZE,
        )
        assert response.status_code == 401
        assert "www-authenticate" not in response.headers
        assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""
        assert len(relay.exchange.requests) == 1
        assert relay.exchange.requests[0]["authorization_matches"] is (exchange_mode != "ok")

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["tools", "workflows"])
@pytest.mark.parametrize("failure", ["404", "500", "bad-body", "unreachable"])
def test_unavailable_exchange_never_starts_child(relay_factory, mode, failure):
    kwargs = {"api_url": f"http://127.0.0.1:{free_port()}"} if failure == "unreachable" else {
        "exchange_mode": failure,
    }
    relay = relay_factory(**kwargs)

    async def scenario():
        bodies = []
        for key in (KEY, OTHER_KEY):
            response = await relay.request("POST", f"/mcp/{mode}", key=key, json=INITIALIZE)
            assert response.status_code == 503
            bodies.append(response.text)
            assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""
        assert bodies[0] == bodies[1]
        assert bodies[0]

    asyncio.run(scenario())


def test_non_loopback_http_api_url_refused_at_startup(relay_factory):
    relay = relay_factory(api_url="http://example.invalid:8780", wait_ready=False)
    deadline = time.monotonic() + 5
    while relay.process.poll() is None and time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", relay.port), timeout=0.1):
                pytest.fail("Relay listened with an insecure non-loopback API URL")
        except OSError:
            time.sleep(0.05)
    assert relay.process.poll() is not None, "Relay did not refuse the API URL within 5 seconds"
    assert relay.process.returncode != 0
    assert (relay.directory / "stderr.log").read_text().strip()


def test_https_api_url_allowed_at_startup(relay_factory):
    relay_factory(api_url="https://example.invalid")


def test_child_exit_before_initialize_logs_fixed_message(relay_factory, tmp_path):
    child_message = "untrusted-child-stderr-must-not-be-forwarded"
    script = tmp_path / "exit_child.py"
    script.write_text(f"import sys\nprint({child_message!r}, file=sys.stderr)\nsys.exit(1)\n")
    relay = relay_factory(launch_script=script)

    async def scenario():
        response = await relay.request("POST", json=INITIALIZE)
        assert response.status_code >= 500
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            logs = "\n".join(
                (relay.directory / name).read_text() for name in ("stdout.log", "stderr.log")
            )
            if "child exited before initialize" in logs:
                break
            await asyncio.sleep(0.05)
        assert "child exited before initialize" in logs
        assert "(tools)" in logs
        assert child_message not in logs
        assert child_message not in response.text

    asyncio.run(scenario())


@pytest.mark.parametrize("path,mode,project_id,canvas_id", [
    ("/mcp/tools", "tools", None, None),
    ("/mcp/tools/projects/proj.A-1_x", "tools", "proj.A-1_x", None),
    ("/mcp/tools/projects/proj.A-1_x/", "tools", "proj.A-1_x", None),
    ("/mcp/workflows/projects/p1/canvases/c1", "workflows", "p1", "c1"),
    ("/mcp/workflows/projects/p1/canvases/c1/", "workflows", "p1", "c1"),
])
def test_path_scope_controls_child_environment_and_exchange(
    relay_factory, path, mode, project_id, canvas_id,
):
    relay = relay_factory()

    async def scenario():
        async with relay.session(path=path) as (session, _, _):
            identity = await whoami(session)
            assert identity["mode"] == mode
            assert identity["project_id"] == project_id
            assert identity["canvas_id"] == canvas_id
            scope = {"kind": "home"} if project_id is None else {
                "kind": "project", "id": project_id,
            }
            assert [request["body"] for request in relay.exchange.requests] == [
                {"scope": scope, "ttl_seconds": 60},
            ]

    asyncio.run(scenario())


@pytest.mark.parametrize("path", [
    "/mcp/tools/projects/a%20b",
    "/mcp/tools/projects/a$b",
    "/mcp/tools/projects/" + "a" * 129,
    "/mcp/tools/projects/p1/canvases/c%2Fd",
    "/mcp/tools/projects/p1/canvases/",
    "/mcp/tools/projects/p1/other/c1",
    "/mcp/tools/projects",
])
def test_invalid_scope_path_never_exchanges_or_starts_child(relay_factory, path):
    relay = relay_factory()

    async def scenario():
        response = await relay.request("POST", path=path, json=INITIALIZE)
        assert response.status_code == 404
        assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""
        assert relay.exchange.requests == []

    asyncio.run(scenario())


@pytest.mark.parametrize("exchange_mode", ["401", "403"])
def test_rejected_project_exchange_never_starts_child(relay_factory, exchange_mode):
    relay = relay_factory(exchange_mode=exchange_mode)

    async def scenario():
        response = await relay.request(
            "POST", path="/mcp/tools/projects/p1", json=INITIALIZE,
        )
        assert response.status_code == 401
        assert "www-authenticate" not in response.headers
        assert not relay.pid_log.exists() or relay.pid_log.read_text() == ""
        assert [request["body"] for request in relay.exchange.requests] == [
            {"scope": {"kind": "project", "id": "p1"}, "ttl_seconds": 60},
        ]

    asyncio.run(scenario())


def test_session_cannot_be_reused_on_another_scope_path(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session(
            path="/mcp/tools/projects/p1/canvases/c1",
        ) as (session, sid, _):
            identity = await whoami(session)
            expected = serialized(await session.list_tools())
            for path in (
                "/mcp/tools",
                "/mcp/tools/projects/p2/canvases/c1",
                "/mcp/tools/projects/p1/canvases/c2",
                "/mcp/tools/projects/p1",
                "/mcp/workflows/projects/p1/canvases/c1",
            ):
                response = await relay.request("POST", path=path, sid=sid, json=LIST_TOOLS)
                assert response.status_code == 404
            assert serialized(await session.list_tools()) == expected
            assert await whoami(session) == identity

    asyncio.run(scenario())


def test_real_launcher_project_tool_definitions_match_direct_stdio(relay_factory):
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        pytest.skip("Real launcher requires the repository .venv/bin/python")
    relay = relay_factory(real=True)
    env = clean_env() | {
        "DRAMACLAW_AGENT_KEY": KEY, "DRAMACLAW_API_URL": relay.api_url,
        "DRAMACLAW_USERNAME": "relay-user", "DRAMACLAW_CE_DIR": str(ROOT),
        "DRAMACLAW_PROJECT_ID": "relay-test-project",
        "DRAMACLAW_CANVAS_ID": "relay-test-canvas",
    }

    async def scenario():
        expected = await direct_tools(LAUNCHER, "tools", env, ROOT, str(python))
        assert json.loads(expected)["tools"]
        async with relay.session(
            path="/mcp/tools/projects/relay-test-project/canvases/relay-test-canvas",
        ) as (session, _, _):
            actual = await session.list_tools()
            assert actual.tools
            assert serialized(actual) == expected

    asyncio.run(scenario())
