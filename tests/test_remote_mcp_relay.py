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
import re
import signal
import socket
import subprocess
import sys
import time
from threading import Event, Thread

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
        if not k.startswith(("DRAMACLAW_", "ST_", "SUPERTALE_", "REMOTE_MCP_"))
    } | {"PYTHONDONTWRITEBYTECODE": "1"}


def assert_secret_free(text):
    assert not any(secret in text for secret in SECRETS), "Credential leaked"


def pid_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def wait_reaped(pid, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not pid_exists(pid):
            state = subprocess.run(
                ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True,
                check=False,
            ).stdout.strip()
            assert not state.startswith("Z"), "Child became a zombie"
            return
        await asyncio.sleep(0.05)
    pytest.fail(f"Child still exists (including possible zombie) after {timeout} seconds")


class Exchange:
    def __init__(self, mode="ok", projects=None, catalogs=None, reject_gate=None):
        self.requests = []
        self.project_requests = []
        self.catalog_requests = []
        catalogs = {} if catalogs is None else catalogs
        projects = [] if projects is None else projects
        exchange = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                key = self.headers.get("Authorization", "").removeprefix("Bearer ")
                matches = self.headers.get("Authorization") == f"Bearer {KEY}" or (
                    key in catalogs and self.headers.get("Authorization") == f"Bearer {key}"
                )
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                exchange.requests.append({
                    "path": self.path, "body": body, "authorization_matches": matches,
                    "content_type": self.headers.get("Content-Type"),
                    "accept": self.headers.get("Accept"),
                })
                if not matches and reject_gate is not None:
                    reject_gate.wait(timeout=8)
                if self.path != "/api/v1/agent/sessions":
                    status, payload = 404, {"ok": False}
                elif mode == "ok" and matches:
                    status, payload = 200, {
                        "ok": True, "data": {
                            "token": catalogs[key][0] if key in catalogs else FAKE_TOKEN,
                            "expires_at": time.time() + 60,
                        },
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

            def do_GET(self):
                if self.path.startswith("/api/v1/freezone/agent-config/"):
                    kind = self.path.rsplit("/", 1)[-1]
                    owner = next((key for key, (token, _) in catalogs.items()
                                  if self.headers.get("Authorization") == f"Bearer {token}"), None)
                    exchange.catalog_requests.append({"path": self.path, "owner": owner})
                    if owner is None:
                        status, payload = 401, {"ok": False}
                    elif kind not in catalogs[owner][1]:
                        status, payload = 404, {"ok": False}
                    else:
                        status, payload = 200, {"ok": True, "data": catalogs[owner][1][kind]}
                    encoded = json.dumps(payload).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                    return
                matches = self.headers.get("Authorization") == f"Bearer {FAKE_TOKEN}"
                exchange.project_requests.append({
                    "path": self.path, "authorization_matches": matches,
                    "accept": self.headers.get("Accept"),
                })
                if self.path != "/api/v1/projects":
                    status, payload = 404, {"ok": False}
                elif not matches:
                    status, payload = 401, {"ok": False}
                elif isinstance(projects, int):
                    status, payload = projects, {"ok": False}
                else:
                    status, payload = 200, {
                        "ok": True, "data": [{"id": project_id} for project_id in projects],
                    }
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
        exchange_mode="ok", projects=None, api_url=None, launch_script=None,
        catalogs=None, output_dir=None,
        max_children=None, max_children_per_key=None, disconnect_grace=None, extra_args=(),
    ):
        self.directory = directory
        self.ce_dir = ROOT if real else directory / "ce"
        if not real:
            self.ce_dir.mkdir()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.exchange = Exchange(exchange_mode, projects=projects, catalogs=catalogs)
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
        if output_dir is not None:
            self.env["NOVELVIDEO_OUTPUT_DIR"] = str(output_dir)
            self.env["ST_EDITION"] = "ce"
        for name, value in (
            ("MAX_CHILDREN", max_children), ("MAX_CHILDREN_PER_KEY", max_children_per_key),
            ("IDLE_TIMEOUT", idle), ("DISCONNECT_GRACE", disconnect_grace),
        ):
            if value is not None:
                self.env[f"REMOTE_MCP_{name}"] = str(value)
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
        self.command += list(extra_args)
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

    def child_pids(self):
        if not self.pid_log.exists():
            return []
        return [int(value) for value in self.pid_log.read_text().splitlines()]

    def live_children(self):
        return [pid for pid in self.child_pids() if pid_exists(pid)]

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
    async def session(self, mode="tools", *, path=None, delete=True, key=KEY):
        async with streamablehttp_client(
            self.url + (path if path is not None else f"/mcp/{mode}"),
            headers={"Authorization": f"Bearer {key}"},
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


@pytest.mark.parametrize("request_kwargs,status", [
    pytest.param({"json": LIST_TOOLS}, 400, id="not-initialize"),
    pytest.param(
        {"json": INITIALIZE, "headers": {"Accept": "application/json"}},
        406, id="missing-event-stream",
    ),
    pytest.param(
        {"content": json.dumps(INITIALIZE), "headers": {"Content-Type": "text/plain"}},
        # SDK transport security rejects this before the transport's 415 check.
        400, id="wrong-content-type",
    ),
    pytest.param(
        {"content": b"{not json", "headers": {"Content-Type": "application/json"}},
        400, id="invalid-json",
    ),
    pytest.param({"json": []}, 400, id="json-array"),
    pytest.param({"json": {"foo": 1}}, 400, id="not-jsonrpc"),
])
def test_invalid_first_request_never_exchanges_or_starts_child(
    relay_factory, request_kwargs, status,
):
    relay = relay_factory()

    async def scenario():
        response = await relay.request("POST", **request_kwargs)
        assert response.status_code == status
        error = response.json()["error"]
        message = error["message"] if isinstance(error, dict) else error
        assert isinstance(message, str) and message.strip()
        await asyncio.sleep(0.5)
        children = relay.pid_log.read_text().splitlines() if relay.pid_log.exists() else []
        assert (children, relay.exchange.requests) == ([], [])
        async with relay.session() as (session, _, initialized):
            assert initialized.serverInfo.name == "fake-tools"
            identity = await whoami(session)
            assert identity["key_matches"] is True
            assert relay.pid_log.read_text().splitlines() == [str(identity["pid"])]

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
            assert names == ["whoami", "sleep", "echo", "noisy", "binary_noise"]
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


def test_non_utf8_child_stdout_preserves_session(relay_factory):
    relay = relay_factory()

    async def scenario():
        async with relay.session() as (session, _, _):
            pid = (await whoami(session))["pid"]
            try:
                await asyncio.wait_for(session.call_tool("binary_noise", {}), 10)
            except Exception:
                # Only the noisy call may fail; the same session must remain usable.
                pass
            echoed = await session.call_tool("echo", {"text": "after binary noise"})
            assert echoed.isError is False
            assert echoed.content[0].text == "after binary noise"
            assert (await whoami(session))["pid"] == pid
            assert relay.pid_log.read_text().splitlines() == [str(pid)]

    try:
        asyncio.run(scenario())
    finally:
        relay.close()
        logs = "\n".join(
            (relay.directory / name).read_text(errors="replace")
            for name in ("stderr.log", "stdout.log")
        )
        assert "stray-binary-line" not in logs


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
                "whoami", "sleep", "echo", "workflow_only", "noisy", "binary_noise",
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


def test_cli_help_and_defaults(monkeypatch):
    for name in tuple(os.environ):
        if name.startswith("REMOTE_MCP_"):
            monkeypatch.delenv(name)
    result = subprocess.run(
        [sys.executable, str(RELAY), "--help"], capture_output=True, text=True, timeout=5,
        env=clean_env(),
    )
    assert result.returncode == 0
    for option in (
        "--idle-timeout", "--host", "--port", "--ce-dir", "--api-url", "--username",
        "--launch-script", "--child-python",
        "--max-children", "--max-children-per-key", "--disconnect-grace",
    ):
        assert option in result.stdout
    for option, default in (
        ("max-children", 32), ("max-children-per-key", 8),
        ("idle-timeout", 600), ("disconnect-grace", 10),
    ):
        assert re.search(
            rf"--{option}\s[^\n]*(?:\n(?!  --)[^\n]*)*?default:\s*{default}\b",
            result.stdout,
        ), f"--{option} help must show default: {default}"
    spec = importlib.util.spec_from_file_location("remote_mcp_relay", RELAY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        args = module.build_arg_parser().parse_args([])
        assert args.api_url == "http://127.0.0.1:8780"
        assert args.host == "127.0.0.1"
        assert args.max_children == 32
        assert args.max_children_per_key == 8
        assert args.disconnect_grace == 10
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


def test_per_key_cap_refuses_new_session_and_keeps_existing(relay_factory):
    relay = relay_factory(max_children_per_key=2)

    async def scenario():
        async with relay.session() as (first, first_sid, _):
            async with relay.session() as (second, _, _):
                first_identity = await whoami(first)
                second_identity = await whoami(second)
                assert len(relay.exchange.requests) == 2
                response = await relay.request("POST", json=INITIALIZE)
                assert response.status_code == 429
                assert response.json() == {
                    "jsonrpc": "2.0", "id": INITIALIZE["id"],
                    "error": {"code": -32000, "message": (
                        "Too many open MCP sessions for this agent key (limit 2). "
                        "Close unused sessions or wait for idle sessions to end."
                    )},
                }
                assert len(relay.exchange.requests) == 2
                assert len(relay.child_pids()) == len(relay.live_children()) == 2
                assert await whoami(first) == first_identity
                assert await whoami(second) == second_identity
                terminated = await relay.request("DELETE", sid=first_sid)
                assert terminated.status_code == 200
                await wait_reaped(first_identity["pid"])
                async with relay.session() as (replacement, _, _):
                    assert (await whoami(replacement))["key_matches"] is True
                    assert len(relay.live_children()) == 2

    asyncio.run(scenario())


def test_total_cap_refuses_new_session(relay_factory):
    relay = relay_factory(max_children=1, max_children_per_key=8)

    async def scenario():
        async with relay.session() as (session, _, _):
            identity = await whoami(session)
            response = await relay.request("POST", json=INITIALIZE)
            assert response.status_code == 429
            assert response.json() == {
                "jsonrpc": "2.0", "id": INITIALIZE["id"],
                "error": {"code": -32000, "message": (
                    "The relay has too many open MCP sessions (limit 1). Try again later."
                )},
            }
            assert len(relay.exchange.requests) == 1
            assert relay.child_pids() == relay.live_children() == [identity["pid"]]
            assert await whoami(session) == identity

    asyncio.run(scenario())


def test_concurrent_new_sessions_never_exceed_cap(relay_factory):
    relay = relay_factory(max_children_per_key=2)

    async def scenario():
        async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
            responses = await asyncio.gather(*(
                client.post(relay.url + "/mcp/tools", json=INITIALIZE, headers={
                    "Authorization": f"Bearer {KEY}",
                    "Accept": "application/json, text/event-stream",
                }) for _ in range(6)
            ))
        assert sorted(response.status_code for response in responses) == [
            200, 200, 429, 429, 429, 429,
        ]
        session_ids = [r.headers["mcp-session-id"] for r in responses if r.status_code == 200]
        assert len(set(session_ids)) == 2
        # Concurrent requests can pass the pre-check before either slot is reserved.
        assert 2 <= len(relay.exchange.requests) <= len(responses)
        assert len(relay.child_pids()) == len(relay.live_children()) == 2

    asyncio.run(scenario())


def test_status_polls_without_delete_do_not_accumulate_children(relay_factory):
    relay = relay_factory(idle=600, disconnect_grace=1, max_children_per_key=3)

    async def scenario():
        for _ in range(10):
            async with relay.session(delete=False) as (session, sid, _):
                assert (await session.list_tools()).tools
            # Close the SDK stream first so this GET cannot conflict with it.
            async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
                async with client.stream("GET", relay.url + "/mcp/tools", headers={
                    "Authorization": f"Bearer {KEY}", "Mcp-Session-Id": sid,
                    "Accept": "text/event-stream", "MCP-Protocol-Version": "2025-03-26",
                }) as response:
                    assert response.status_code == 200
                    assert response.headers["content-type"].startswith("text/event-stream")
            assert len(relay.live_children()) <= 1
            await wait_reaped(relay.child_pids()[-1], timeout=5)
            assert relay.live_children() == []
        assert len(relay.child_pids()) == len(relay.exchange.requests) == 10
        await asyncio.sleep(3)
        assert relay.live_children() == []
        for pid in relay.child_pids():
            await wait_reaped(pid)

    asyncio.run(scenario())


def test_idle_sessions_without_get_stream_are_reaped_and_free_slots(relay_factory):
    relay = relay_factory(idle=2, max_children_per_key=1)

    async def scenario():
        first = await relay.request("POST", json=INITIALIZE)
        assert first.status_code == 200
        assert first.headers["mcp-session-id"]
        pid, = relay.child_pids()
        refused = await relay.request("POST", json=INITIALIZE)
        assert refused.status_code == 429
        assert len(relay.exchange.requests) == 1
        await wait_reaped(pid, timeout=5)
        assert relay.live_children() == []
        replacement = await relay.request("POST", json=INITIALIZE)
        assert replacement.status_code == 200
        assert replacement.headers["mcp-session-id"] != first.headers["mcp-session-id"]
        assert len(relay.live_children()) == 1

    asyncio.run(scenario())


def test_max_children_zero_env_refused_at_startup(relay_factory):
    relay = relay_factory(max_children=0, wait_ready=False)
    try:
        relay.process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pytest.fail("Relay accepted REMOTE_MCP_MAX_CHILDREN=0 instead of an argparse error")
    assert relay.process.returncode == 2
    stderr = (relay.directory / "stderr.log").read_text()
    assert "usage:" in stderr
    assert "error:" in stderr
    assert "max-children" in stderr or "REMOTE_MCP_MAX_CHILDREN" in stderr


@pytest.mark.parametrize("mode", ["tools", "workflows"])
@pytest.mark.parametrize("suffix", ["", "/"])
def test_home_path_binds_single_visible_project(relay_factory, mode, suffix):
    relay = relay_factory(projects=["solo-project"])

    async def scenario():
        async with relay.session(path=f"/mcp/{mode}{suffix}") as (session, sid, _):
            identity = await whoami(session)
            assert identity["mode"] == mode
            assert identity["project_id"] == "solo-project"
            assert identity["canvas_id"] is None
            assert [request["body"] for request in relay.exchange.requests] == [
                {"scope": {"kind": "home"}, "ttl_seconds": 60},
            ]
            assert await whoami(session) == identity
            for path_mode in sorted({mode, "tools"}):
                response = await relay.request(
                    "POST", path=f"/mcp/{path_mode}/projects/solo-project",
                    sid=sid, json=LIST_TOOLS,
                )
                assert response.status_code == 404
            assert await whoami(session) == identity
            assert relay.exchange.project_requests == [{
                "path": "/api/v1/projects", "authorization_matches": True,
                "accept": "application/json",
            }]

    try:
        asyncio.run(scenario())
    finally:
        relay.close()
        logs = "\n".join(
            (relay.directory / name).read_text() for name in ("stdout.log", "stderr.log")
        )
        assert KEY not in logs
        assert FAKE_TOKEN not in logs


def test_home_path_with_several_projects_stays_home(relay_factory):
    relay = relay_factory(projects=["p1", "p2"])

    async def scenario():
        async with relay.session() as (session, _, _):
            identity = await whoami(session)
            assert identity["project_id"] is None
            assert identity["canvas_id"] is None
            assert await whoami(session) == identity

    asyncio.run(scenario())
    relay.close()
    logs = "\n".join(
        (relay.directory / name).read_text() for name in ("stdout.log", "stderr.log")
    )
    assert logs.count("Home path kept home scope:") == 1
    assert logs.count("Home path kept home scope: several visible projects\n") == 1
    assert relay.exchange.project_requests == [{
        "path": "/api/v1/projects", "authorization_matches": True,
        "accept": "application/json",
    }]


@pytest.mark.parametrize("projects,warning", [
    pytest.param(500, "Home path kept home scope: project listing unavailable", id="http-500"),
    pytest.param([], "Home path kept home scope: no visible project", id="empty"),
])
def test_home_path_projects_error_stays_home_and_serves(relay_factory, projects, warning):
    relay = relay_factory(projects=projects)

    async def scenario():
        async with relay.session() as (session, _, _):
            identity = await whoami(session)
            assert identity["project_id"] is None
            assert identity["canvas_id"] is None
            echoed = await session.call_tool("echo", {"text": "still serving home"})
            assert echoed.isError is False
            assert echoed.content[0].text == "still serving home"

    try:
        asyncio.run(scenario())
    finally:
        relay.close()
        logs = "\n".join(
            (relay.directory / name).read_text() for name in ("stdout.log", "stderr.log")
        )
        assert KEY not in logs
        assert FAKE_TOKEN not in logs
    assert logs.count("Home path kept home scope:") == 1
    assert logs.count(warning + "\n") == 1
    assert relay.exchange.project_requests == [{
        "path": "/api/v1/projects", "authorization_matches": True,
        "accept": "application/json",
    }]


@pytest.mark.parametrize("suffix,canvas_id", [
    ("", None), ("/canvases/explicit-canvas", "explicit-canvas"),
])
def test_explicit_project_path_is_never_overridden(relay_factory, suffix, canvas_id):
    relay = relay_factory(projects=["solo-project"])

    async def scenario():
        async with relay.session(
            path=f"/mcp/tools/projects/explicit-project{suffix}",
        ) as (session, _, _):
            identity = await whoami(session)
            assert identity["project_id"] == "explicit-project"
            assert identity["canvas_id"] == canvas_id
            assert [request["body"] for request in relay.exchange.requests] == [
                {"scope": {"kind": "project", "id": "explicit-project"}, "ttl_seconds": 60},
            ]

    asyncio.run(scenario())
    relay.close()
    assert relay.exchange.project_requests == []


def test_real_launcher_home_with_several_projects_lists_freezone_tools(relay_factory):
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        pytest.skip("Real launcher requires the repository .venv/bin/python")
    relay = relay_factory(real=True, projects=["project-a", "project-b"])

    async def scenario():
        async with relay.session(path="/mcp/tools") as (session, _, initialized):
            names = {tool.name for tool in (await session.list_tools()).tools}
            assert {
                "freezone_list_projects", "freezone_create_node", "freezone_list_canvases",
            } <= names
            assert len(names) > 4
            assert "freezone_list_projects" in (initialized.instructions or "")
            assert "project_id" in (initialized.instructions or "")

    asyncio.run(scenario())


def test_real_launcher_workflow_catalog_is_scoped_to_key(relay_factory, tmp_path):
    if not (ROOT / ".venv/bin/python").exists():
        pytest.skip("Real launcher requires the repository .venv/bin/python")
    builtin = ROOT / "src/novelvideo/freezone/agent_catalog/builtins"
    catalogs = {}
    output = tmp_path / "output"
    for user in ("alice", "bob", "relay-user"):
        items = {}
        for kind, source in (("skills", "text-to-image-video"), ("recipes", "general-image")):
            item = json.loads((builtin / kind / f"{source}.json").read_text())
            item.update(id=f"private-{user}", name=f"{user} private")
            items[kind] = [
                *(json.loads(path.read_text()) for path in sorted((builtin / kind).glob("*.json"))),
                item,
            ]
            if user == "relay-user":
                folder = output / user / "_account/freezone/agent_config" / kind
                folder.mkdir(parents=True)
                (folder / f"private-{user}.json").write_text(json.dumps(item))
        if user != "relay-user":
            catalogs[f"test-key-{user}"] = (f"session-{user}", items)
    relay = relay_factory(real=True, catalogs=catalogs, output_dir=output)

    async def scenario():
        results = {}
        for user in ("alice", "bob"):
            async with relay.session("workflows", key=f"test-key-{user}") as (session, _, _):
                result = await session.call_tool(
                    "workflow_catalog_search", {"kind": "recipes", "query": "private"},
                )
                text = serialized(result)
                assert not any(secret in text for secret in (
                    "test-key-alice", "test-key-bob", "session-alice", "session-bob",
                )), "Credential leaked in tool result"
                results[user] = json.loads(result.content[0].text)
        assert all(result["ok"] is True for result in results.values())
        assert {user: {item["id"] for item in result["items"]} for user, result in results.items()} == {
            "alice": {"private-alice"}, "bob": {"private-bob"},
        }
        assert {request["owner"] for request in relay.exchange.catalog_requests} == set(catalogs)

    asyncio.run(scenario())


def test_real_launcher_tools_catalog_is_scoped_to_key(relay_factory, tmp_path):
    if not (ROOT / '.venv/bin/python').exists():
        pytest.skip('Real launcher requires the repository .venv/bin/python')
    builtin = ROOT / 'src/novelvideo/freezone/agent_catalog/builtins'
    catalogs = {}
    output = tmp_path / 'output'
    for user in ('alice', 'bob', 'relay-user'):
        items = {}
        for kind, source in (('skills', 'text-to-image-video'), ('recipes', 'general-image')):
            item = json.loads((builtin / kind / f'{source}.json').read_text())
            item.update(id=f'private-{user}', name=f'{user} private')
            if kind == 'skills':
                item['allowed_recipe_ids'] = [f'private-{user}']
            items[kind] = [
                *(json.loads(path.read_text()) for path in sorted((builtin / kind).glob('*.json'))),
                item,
            ]
            if user == 'relay-user':
                folder = output / user / '_account/freezone/agent_config' / kind
                folder.mkdir(parents=True)
                (folder / f'private-{user}.json').write_text(json.dumps(item))
        if user != 'relay-user':
            catalogs[f'test-key-{user}'] = (f'session-{user}', items)
    relay = relay_factory(real=True, catalogs=catalogs, output_dir=output)

    async def scenario():
        results = {}
        for owner in ('alice', 'bob'):
            async with relay.session('tools', key=f'test-key-{owner}') as (session, _, _):
                results[owner] = {}
                for user in ('alice', 'bob', 'relay-user'):
                    result = await session.call_tool('freezone_get_workflow_skill', {
                        'skill_id': f'private-{user}',
                    })
                    text = serialized(result)
                    assert not any(secret in text for secret in (
                        'test-key-alice', 'test-key-bob', 'session-alice', 'session-bob',
                    )), 'Credential leaked in tool result'
                    results[owner][user] = json.loads(result.content[0].text)['ok']
        assert results == {
            'alice': {'alice': True, 'bob': False, 'relay-user': False},
            'bob': {'alice': False, 'bob': True, 'relay-user': False},
        }
        assert {(request['owner'], request['path']) for request in relay.exchange.catalog_requests} == {
            (key, f'/api/v1/freezone/agent-config/{kind}')
            for key in catalogs for kind in ('skills', 'recipes')
        }

    asyncio.run(scenario())


def test_unverified_keys_do_not_reserve_session_slots(relay_factory):
    reject_gate = Event()
    api = Exchange(reject_gate=reject_gate)
    relay = relay_factory(
        api_url=f"http://127.0.0.1:{api.port}", max_children=2, max_children_per_key=8,
    )

    async def scenario():
        async with httpx.AsyncClient(timeout=12, trust_env=False) as client:
            bogus = [asyncio.create_task(client.post(
                relay.url + "/mcp/tools", json=INITIALIZE, headers={
                    "Authorization": f"Bearer fake-bogus-key-{index}",
                    "Accept": "application/json, text/event-stream",
                },
            )) for index in range(2)]
            try:
                deadline = time.monotonic() + 5
                while len(api.requests) < 2 and time.monotonic() < deadline:
                    await asyncio.sleep(0.01)
                assert len(api.requests) == 2, "Both bogus key checks must reach the API"
                assert relay.child_pids() == []
                response = await relay.request("POST", json=INITIALIZE)
            finally:
                reject_gate.set()
                rejected = await asyncio.gather(*bogus)
            assert [result.status_code for result in rejected] == [401, 401]
            assert response.status_code == 200, "Unverified keys occupied the global session cap"
            sid = response.headers["mcp-session-id"]
            notified = await relay.request("POST", sid=sid, json={
                "jsonrpc": "2.0", "method": "notifications/initialized",
            })
            assert notified.status_code == 202
            identity = await relay.request("POST", sid=sid, json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "whoami", "arguments": {}},
            })
            payload = next(json.loads(line.removeprefix("data: "))
                           for line in identity.text.splitlines() if line.startswith("data: "))
            assert json.loads(payload["result"]["content"][0]["text"])["key_matches"] is True
            assert len(relay.child_pids()) == 1
            await relay.request("DELETE", sid=sid)

    try:
        asyncio.run(scenario())
    finally:
        reject_gate.set()
        api.close()


def relay_mode_env(result_dir):
    return {
        "DRAMACLAW_EXTERNAL_MCP": "0",
        "DRAMACLAW_TURN_ID": "turn-from-relay-env",
        "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR": str(result_dir),
        "DRAMACLAW_CHAT_SURFACE": "other",
        "DRAMACLAW_TOOL_MODE": "other",
        "DRAMACLAW_AGENT_PROFILE": "other:agent",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1",
    }


def test_child_does_not_inherit_relay_mode_env(tmp_path):
    relay = Relay(tmp_path)
    poisoned = relay_mode_env(tmp_path / "tool-results")
    relay.env.update(poisoned)
    relay.env["REMOTE_MCP_FAKE_REPORT_ENV_NAMES"] = "1"

    async def scenario():
        async with relay.session() as (session, _, _):
            identity = await whoami(session)
            assert identity["key_matches"] is True
            assert set(identity["env_names"]).isdisjoint(poisoned)

    try:
        relay.start()
        asyncio.run(scenario())
    finally:
        relay.close()


def test_real_launcher_ignores_relay_mode_env(relay_factory, tmp_path):
    if not (ROOT / ".venv/bin/python").exists():
        pytest.skip("Real launcher requires the repository .venv/bin/python")
    baseline = relay_factory(real=True, projects=["project-a", "project-b"])
    directory = tmp_path / "poisoned"
    directory.mkdir()
    relay = Relay(directory, real=True, projects=["project-a", "project-b"])
    result_dir = tmp_path / "tool-results"
    result_dir.mkdir()
    relay.env.update(relay_mode_env(result_dir))

    async def observe(target):
        async with target.session(path="/mcp/tools") as (session, _, initialized):
            names = sorted(tool.name for tool in (await session.list_tools()).tools)
            result = await session.call_tool("freezone_create_node", {"node_type": "textGeneration"})
            return names, bool(initialized.instructions), result

    async def scenario():
        clean_names, clean_instructions, clean_result = await observe(baseline)
        names, instructions, result = await observe(relay)
        assert "freezone_list_projects" in clean_names
        assert "freezone_create_node" in clean_names
        assert clean_instructions is True
        assert names == clean_names
        assert instructions == clean_instructions
        clean_payload = json.loads(clean_result.content[0].text)
        payload = json.loads(result.content[0].text)
        assert (result.isError, payload.get("status"), payload.get("code")) == (
            clean_result.isError, clean_payload.get("status"), clean_payload.get("code"),
        )
        assert list(result_dir.iterdir()) == []

    try:
        relay.start()
        asyncio.run(scenario())
    finally:
        relay.close()
