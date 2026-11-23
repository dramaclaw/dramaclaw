"""Remote MCP entry served by the API process: stateless, one key per request."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import random
from threading import Event, Lock, Thread, current_thread, main_thread
import time
from types import SimpleNamespace
from urllib.request import OpenerDirector

import httpx
from mcp import types
import pytest
from starlette.applications import Starlette

from novelvideo.ports.auth_contract import AuthFailureReason
from support.remote_mcp_api import (
    FAKE_TOKEN,
    KEY,
    LAUNCHER,
    ROOT,
    Exchange,
    FakeKeyPort,
    clean_env,
    direct_tools,
    register_key_port,
    serialized,
)

FLAG = "DRAMACLAW_REMOTE_MCP_ENABLED"
MAX_CONCURRENT = "DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT"
MAX_CONCURRENT_PER_KEY = "DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT_PER_KEY"
UNKNOWN_KEY = "fake-entry-key-DO-NOT-USE-unknown"
BRIDGE_DIR = "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"
PROJECT_PATH = "/mcp/tools/projects/project-a"
KEY_A = "fake-entry-key-DO-NOT-USE-alpha"
KEY_B = "fake-entry-key-DO-NOT-USE-beta"
TOKEN_A = "fake-entry-session-DO-NOT-USE-alpha"
TOKEN_B = "fake-entry-session-DO-NOT-USE-beta"
SECRETS = (KEY, FAKE_TOKEN, KEY_A, KEY_B, TOKEN_A, TOKEN_B)
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
OUTPUT_SCHEMA = {"type": "object", "properties": {
    "ok": {"type": "boolean"}, "before": {"type": "object"}, "after": {"type": "object"},
    "seen": {"type": "object"},
}}
IDENTITY_NAMES = (
    "DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE", "DRAMACLAW_AGENT_TOKEN",
    "DRAMACLAW_AGENT_TOKEN_FILE", "DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID",
    "DRAMACLAW_TURN_ID", "DRAMACLAW_USERNAME", "DRAMACLAW_USER", "ST_LOCAL_USERNAME",
    "DRAMACLAW_EXTERNAL_MCP", "DRAMACLAW_CHAT_SURFACE", "SUPERTALE_CHAT_SURFACE",
    "DRAMACLAW_TOOL_MODE", "DRAMACLAW_TOOL_MODE_FILE", "DRAMACLAW_AGENT_PROFILE",
    "DRAMACLAW_LOCAL_AGENT_TRUST", "DRAMACLAW_CE_OWNER", "DRAMACLAW_CE_OWNER_ALLOW_REMOTE",
    "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR",
    "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "DRAMACLAW_API_URL", FLAG,
    MAX_CONCURRENT, MAX_CONCURRENT_PER_KEY,
)
# Every name the API address is resolved from, so that no test reads the developer's own.
API_ADDRESS_NAMES = (
    "DRAMACLAW_API_URL", "NOVELVIDEO_API_URL", "NOVELVIDEO_API_HOST", "NOVELVIDEO_API_PORT",
    "SUPERTALE_API_URL",
)


def rpc(method, params=None, request_id=1):
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}


def call(name, arguments=None, request_id=1):
    return rpc("tools/call", {"name": name, "arguments": arguments or {}}, request_id)


def bearer(key):
    return {**MCP_HEADERS, "Authorization": f"Bearer {key}"}


def assert_secret_free(text):
    assert not any(secret in text for secret in SECRETS), "Credential leaked"


class FakeApi:
    """The API tools call back into, with the key port that accepts the same keys.

    Keys are checked and exchanged through ``port`` in process only: every POST this
    API receives is recorded in ``posts`` and refused.
    """

    def __init__(self, sessions):
        self.sessions = dict(sessions)
        self.port = FakeKeyPort(self.sessions)
        self.posts = []
        # Set to answer every GET with this status and the caller's credential in the body.
        self.callback_status = None
        # The user the sessions belong to; without one the API does not say who is calling.
        self.username = None
        self.projects = ["project-a", "project-b"]
        self.gets = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_POST(self):
                fake.posts.append(self.path)
                self.reply(404, {"ok": False})

            def do_GET(self):
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                fake.gets.append(self.path)
                if token not in fake.sessions.values():
                    self.reply(401, {"ok": False})
                elif fake.callback_status is not None:
                    echoed = f"request refused: {self.headers.get('Authorization')}"
                    self.reply(fake.callback_status, {
                        "ok": False, "error": echoed, "detail": echoed, "message": echoed,
                    })
                elif self.path == "/api/v1/auth/me":
                    if fake.username is None:
                        self.reply(404, {"ok": False})
                    else:
                        self.reply(200, {"ok": True, "data": {
                            "username": fake.username, "role": "user",
                            "credential_kind": "agent_session",
                        }})
                else:
                    self.reply(200, {"ok": True, "data": [
                        {"id": project_id} for project_id in fake.projects
                    ]})

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


@pytest.fixture(autouse=True)
def process_env(monkeypatch):
    # The entry must take identity from the request only, so the process starts with none.
    for name in IDENTITY_NAMES + API_ADDRESS_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    from novelvideo.chat import agent_key_session, dramaclaw_mcp

    # Shared with every bundled copy of the module, so emptied in place.
    for state in (agent_key_session._CACHE, agent_key_session._LOCKS, agent_key_session._SECRETS):
        state.clear()
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    yield
    for state in (agent_key_session._CACHE, agent_key_session._LOCKS, agent_key_session._SECRETS):
        state.clear()


@pytest.fixture
def fake_api(monkeypatch):
    api = FakeApi({KEY_A: TOKEN_A, KEY_B: TOKEN_B})
    register_key_port(monkeypatch, api.port)
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    yield api
    api.close()
    # Neither the entry nor the tools it served exchanged a key over HTTP.
    assert api.posts == []


@pytest.fixture
def exchange_factory(monkeypatch):
    started = []

    def start(**kwargs):
        exchange = Exchange(**kwargs)
        started.append(exchange)
        register_key_port(monkeypatch, exchange.key_port)
        monkeypatch.setenv("DRAMACLAW_API_URL", f"http://127.0.0.1:{exchange.port}")
        return exchange

    yield start
    for exchange in started:
        exchange.close()


def entry_app(monkeypatch, enabled=True):
    from novelvideo.api import remote_mcp

    if enabled:
        monkeypatch.setenv(FLAG, "1")
    application = Starlette()
    remote_mcp.mount(application)
    return application


def client_for(application):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://entry.test",
        timeout=30,
    )


def identity_tools(monkeypatch):
    """Replace the tool list with one tool that reports what its request can see."""
    from novelvideo.chat import dramaclaw_mcp, request_context

    def seen():
        return {
            name: request_context.get(name, "")
            for name in ("DRAMACLAW_AGENT_KEY", "DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID")
        } | {"scoped": request_context.active()}

    def whoami(arguments):
        before = seen()
        time.sleep(random.uniform(0, 0.004))
        return json.dumps({"ok": True, "before": before, "after": seen()})

    def tools():
        return {"whoami": ({
            "name": "whoami",
            "description": json.dumps(seen(), sort_keys=True),
            "parameters": {"type": "object", "properties": {}},
            "output_schema": OUTPUT_SCHEMA,
        }, whoami)}

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", tools)


def project_home(monkeypatch, state_dir, *, home_node=True):
    """Resolve every project to ``state_dir``, on this node or on another one."""
    from novelvideo.api import remote_mcp
    from novelvideo.project_context import ProjectContext

    asked = []

    async def resolve(*, user, project_id, required_role):
        asked.append((user, project_id, required_role))
        return ProjectContext(
            project_id=project_id, project_name="demo", owner_type="user", owner_id="u1",
            owner_username=user["username"], requester_user_id="u1",
            requester_username=user["username"], requester_principals=(),
            effective_role="owner", home_node_id="local" if home_node else "other-node",
            output_dir=state_dir, state_dir=state_dir, runtime_dir=state_dir,
            is_home_node=home_node,
        )

    monkeypatch.setattr(remote_mcp, "resolve_project_context", resolve)
    return asked


def bridge_tools(monkeypatch):
    """Replace the tool list with one tool that reports its event directory."""
    from novelvideo.chat import dramaclaw_mcp, request_context

    def whoami(arguments):
        return json.dumps({"ok": True, "seen": {
            BRIDGE_DIR: request_context.get(BRIDGE_DIR, "<unset>"),
        }})

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {"whoami": ({
        "name": "whoami", "description": "", "parameters": {"type": "object", "properties": {}},
        "output_schema": OUTPUT_SCHEMA,
    }, whoami)})


def expected_bridge_dir(username, state_dir):
    """The project directory the chat routes watch whichever canvas agent is open."""
    from novelvideo.api.routes import chat as chat_routes

    return str(chat_routes._canvas_bridge_dir(
        username, profile="freezone", project_state_dir=state_dir,
    ))


async def seen_bridge_dir(client, path, key=KEY_A):
    response = await client.post(path, json=call("whoami"), headers=bearer(key))
    assert response.status_code == 200
    assert_secret_free(response.text)
    return json.loads(response.json()["result"]["content"][0]["text"])["seen"][BRIDGE_DIR]


def limits(monkeypatch, *, total, per_key):
    monkeypatch.setenv(MAX_CONCURRENT, str(total))
    monkeypatch.setenv(MAX_CONCURRENT_PER_KEY, str(per_key))


def holding_tools(monkeypatch):
    """Replace the tool list with one tool that can stay running, or fail, on request."""
    from novelvideo.chat import dramaclaw_mcp

    state = SimpleNamespace(release=Event(), running=0, lock=Lock())

    def work(arguments):
        if arguments.get("fail"):
            raise RuntimeError("tool failed")
        if arguments.get("hold"):
            with state.lock:
                state.running += 1
            state.release.wait(timeout=10)
        return json.dumps({"ok": True})

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {"work": ({
        "name": "work", "description": "",
        "parameters": {"type": "object", "properties": {
            "hold": {"type": "boolean"}, "fail": {"type": "boolean"},
        }},
        "output_schema": OUTPUT_SCHEMA,
    }, work)})
    return state


async def until(condition):
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("The awaited state was not reached")


def work(client, key, **arguments):
    return client.post(PROJECT_PATH, json=call("work", arguments), headers=bearer(key))


def test_disabled_by_default_is_not_mounted(monkeypatch):
    async def scenario():
        async with client_for(entry_app(monkeypatch, enabled=False)) as client:
            for path in ("/mcp/tools", "/mcp/workflows", "/mcp/tools/projects/project-a"):
                response = await client.post(path, json=rpc("tools/list"), headers=bearer(KEY_A))
                assert response.status_code == 404

    asyncio.run(scenario())


@pytest.mark.parametrize("value,status", [
    ("", 404), ("0", 404), ("false", 404), ("1", 401), ("true", 401),
])
def test_api_app_serves_entry_only_with_the_flag(monkeypatch, value, status):
    from novelvideo.api.app import create_app

    monkeypatch.setenv(FLAG, value)

    async def scenario():
        async with client_for(create_app()) as client:
            response = await client.post("/mcp/tools", json=rpc("tools/list"), headers=MCP_HEADERS)
            assert response.status_code == status

    asyncio.run(scenario())


@pytest.mark.parametrize("headers", [
    {}, {"Authorization": ""}, {"Authorization": "Bearer "}, {"Authorization": "Basic abc"},
    {"Authorization": KEY_A},
])
def test_missing_key_is_refused_before_exchange_even_with_local_trust(
    monkeypatch, fake_api, headers,
):
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY_A)
    identity_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for mode in ("tools", "workflows"):
                response = await client.post(
                    f"/mcp/{mode}", json=call("whoami"), headers={**MCP_HEADERS, **headers},
                )
                assert response.status_code == 401
                assert response.json() == {
                    "error": "Bearer key required", "code": "agent_key_required",
                }

    asyncio.run(scenario())
    assert fake_api.port.checks == 0
    assert fake_api.port.exchanges == []


def test_invalid_key_is_refused_before_tool_code(monkeypatch, fake_api):
    from novelvideo.chat import dramaclaw_mcp

    def forbidden():
        raise AssertionError("tool code ran for a rejected key")

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", forbidden)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for payload in (rpc("initialize"), rpc("tools/list"), call("whoami")):
                response = await client.post(
                    "/mcp/tools/projects/project-a", json=payload,
                    headers=bearer("fake-entry-key-DO-NOT-USE-unknown"),
                )
                assert response.status_code == 401
                assert response.json() == {
                    "error": "Agent key rejected", "code": "agent_key_rejected",
                }

    asyncio.run(scenario())
    assert fake_api.port.checks == 3
    assert fake_api.port.exchanges == []


@pytest.mark.parametrize("reason", [
    AuthFailureReason.REVOKED, AuthFailureReason.EXPIRED, AuthFailureReason.USER_SUSPENDED,
    AuthFailureReason.INVALID,
])
def test_revoked_key_is_refused_on_its_first_request_after_revocation(
    monkeypatch, fake_api, reason,
):
    identity_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            first = await client.post(PROJECT_PATH, json=call("whoami"), headers=bearer(KEY_A))
            assert first.status_code == 200
            # The session the key was exchanged for is still cached and unexpired.
            fake_api.port.refusals[KEY_A] = reason
            for payload in (call("whoami"), rpc("tools/list")):
                refused = await client.post(PROJECT_PATH, json=payload, headers=bearer(KEY_A))
                assert refused.status_code == 401
                assert refused.json() == {
                    "error": "Agent key rejected", "code": "agent_key_rejected",
                }
                assert_secret_free(refused.text)
            # Other keys are unaffected.
            other = await client.post(PROJECT_PATH, json=call("whoami"), headers=bearer(KEY_B))
            assert other.status_code == 200

    asyncio.run(scenario())
    assert fake_api.port.checks == 4


def test_live_session_is_reused_without_another_exchange(monkeypatch, fake_api):
    identity_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for payload in (rpc("initialize"), rpc("tools/list"), call("whoami")):
                response = await client.post(PROJECT_PATH, json=payload, headers=bearer(KEY_A))
                assert response.status_code == 200

    asyncio.run(scenario())
    # Every request checked the key; one exchange served them all.
    assert fake_api.port.checks == 3
    assert fake_api.port.exchanges == [{"kind": "project", "id": "project-a"}]


def test_session_close_to_expiry_is_exchanged_again(monkeypatch, fake_api):
    from novelvideo.chat import agent_key_session

    identity_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for _ in range(2):
                response = await client.post(PROJECT_PATH, json=call("whoami"), headers=bearer(KEY_A))
                assert response.status_code == 200
                # The cached session now has less than a minute left.
                for cache_key, (token, _) in list(agent_key_session._CACHE.items()):
                    agent_key_session._CACHE[cache_key] = (token, time.time() + 30)

    asyncio.run(scenario())
    assert fake_api.port.exchanges == [{"kind": "project", "id": "project-a"}] * 2


def test_project_the_key_may_not_use_is_forbidden(monkeypatch, fake_api):
    from novelvideo.chat import dramaclaw_mcp

    def forbidden():
        raise AssertionError("tool code ran for a project the key may not use")

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", forbidden)
    fake_api.port.forbidden.add((KEY_A, "project-x"))

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for payload in (rpc("tools/list"), call("whoami")):
                response = await client.post(
                    "/mcp/tools/projects/project-x", json=payload, headers=bearer(KEY_A),
                )
                assert response.status_code == 403
                body = response.json()
                assert body["code"] == "agent_key_project_forbidden"
                assert "project" in body["error"].lower()
                assert_secret_free(response.text)

    asyncio.run(scenario())


@pytest.mark.parametrize("installed", ["no auth session port", "port without agent keys"])
def test_installation_without_agent_key_service_refuses_every_key(
    monkeypatch, fake_api, installed,
):
    from novelvideo.ports import registry
    from novelvideo.ports.local.auth import LocalAuthSession

    identity_tools(monkeypatch)
    if installed == "no auth session port":
        monkeypatch.delitem(registry._PORTS, "auth_session")
    else:
        monkeypatch.setitem(registry._PORTS, "auth_session", LocalAuthSession())

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for mode in ("tools", "workflows"):
                response = await client.post(
                    f"/mcp/{mode}", json=call("whoami"), headers=bearer(KEY_A),
                )
                assert response.status_code == 503
                body = response.json()
                assert body["code"] == "agent_key_unsupported"
                assert "no Agent Key service" in body["detail"]
                assert "LOCAL_AGENT_TRUST" not in response.text
                assert_secret_free(response.text)

    asyncio.run(scenario())
    assert fake_api.port.checks == 0


@pytest.mark.parametrize("failing", ["check_agent_key", "exchange_agent_key"])
def test_unavailable_key_service_is_not_a_rejection(monkeypatch, fake_api, caplog, failing):
    caplog.set_level(logging.DEBUG)
    identity_tools(monkeypatch)

    async def down(*args, **kwargs):
        raise ConnectionError(f"key service unreachable for {KEY_A}")

    monkeypatch.setattr(fake_api.port, failing, down)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(PROJECT_PATH, json=call("whoami"), headers=bearer(KEY_A))
            assert response.status_code == 503
            assert response.json() == {
                "error": "Agent key check unavailable", "code": "agent_key_check_unavailable",
            }

    asyncio.run(scenario())
    assert "ConnectionError" in caplog.text
    assert_secret_free(caplog.text)


def test_insecure_api_address_is_refused_before_the_key_check(monkeypatch, fake_api):
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://api.example.test:8780")

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post("/mcp/tools", json=rpc("tools/list"), headers=bearer(KEY_A))
            assert response.status_code == 503
            assert response.json()["code"] == "agent_key_insecure_transport"
            assert_secret_free(response.text)

    asyncio.run(scenario())
    assert fake_api.port.checks == 0


@pytest.mark.parametrize("names", [
    ("NOVELVIDEO_API_URL",), ("NOVELVIDEO_API_HOST", "NOVELVIDEO_API_PORT"),
    ("NOVELVIDEO_API_PORT",), ("SUPERTALE_API_URL",),
])
def test_api_address_is_resolved_like_the_chat_backend(monkeypatch, fake_api, names):
    from novelvideo.chat import request_context

    monkeypatch.delenv("DRAMACLAW_API_URL")
    host, _, port = fake_api.url.removeprefix("http://").partition(":")
    values = {
        "NOVELVIDEO_API_URL": fake_api.url, "SUPERTALE_API_URL": fake_api.url,
        # A listen address of every interface is called on loopback.
        "NOVELVIDEO_API_HOST": "0.0.0.0", "NOVELVIDEO_API_PORT": port,
    }
    for name in names:
        monkeypatch.setenv(name, values[name])
    from novelvideo.chat import dramaclaw_mcp

    def whoami(arguments):
        return json.dumps({"ok": True, "seen": {
            "DRAMACLAW_API_URL": request_context.get("DRAMACLAW_API_URL", ""),
        }})

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {"whoami": ({
        "name": "whoami", "description": "", "parameters": {"type": "object", "properties": {}},
        "output_schema": OUTPUT_SCHEMA,
    }, whoami)})

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(PROJECT_PATH, json=call("whoami"), headers=bearer(KEY_A))
            assert response.status_code == 200
            return json.loads(response.json()["result"]["content"][0]["text"])["seen"]

    # The tool calls back to the address its key was checked at.
    assert asyncio.run(scenario()) == {"DRAMACLAW_API_URL": f"http://{host}:{port}"}
    assert fake_api.port.exchanges


@pytest.mark.parametrize("name", ["NOVELVIDEO_API_PORT", "SUPERTALE_API_URL"])
def test_plugin_tool_calls_the_address_resolved_for_its_request(monkeypatch, fake_api, name):
    # The process names the API only the way the chat backend resolves it; the real
    # plugin tool must use the address the entry put in its request, not the process's.
    monkeypatch.delenv("DRAMACLAW_API_URL")
    port = fake_api.url.rpartition(":")[2]
    monkeypatch.setenv(name, port if name == "NOVELVIDEO_API_PORT" else fake_api.url)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/tools", json=call("freezone_list_projects"), headers=bearer(KEY_A),
            )
            assert response.status_code == 200
            assert_secret_free(response.text)
            return json.loads(response.json()["result"]["content"][0]["text"])

    result = asyncio.run(scenario())
    assert result["ok"] is True, result
    assert [item["project_id"] for item in result["projects"]] == ["project-a", "project-b"]
    assert "/api/v1/projects" in fake_api.gets


def test_workflow_catalog_is_read_from_the_address_resolved_for_its_request(
    monkeypatch, exchange_factory,
):
    exchange = exchange_factory(catalogs=private_catalogs())
    monkeypatch.delenv("DRAMACLAW_API_URL")
    monkeypatch.setenv("NOVELVIDEO_API_PORT", str(exchange.port))

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post("/mcp/workflows", json=call(
                "workflow_catalog_search", {"kind": "recipes", "query": "private"},
            ), headers=bearer(KEY_A))
            assert response.status_code == 200
            return json.loads(response.json()["result"]["content"][0]["text"])

    # Only the key's own server catalog has this recipe; the bundled one does not.
    assert {item["id"] for item in asyncio.run(scenario())["items"]} == {"private-alice"}
    assert {request["owner"] for request in exchange.catalog_requests} == {KEY_A}


@pytest.mark.parametrize("path", [
    "/mcp", "/mcp/", "/mcp/other", "/mcp/tools/extra", "/mcp/tools/projects",
    "/mcp/tools/projects/bad%20id", "/mcp/tools/projects/project-a/canvases",
    "/mcp/tools/projects/project-a/canvases/c/extra", "/mcp/.well-known/oauth-protected-resource",
    "/mcp/tools/projects/" + "p" * 129,
])
def test_unknown_paths_are_not_found_without_exchange(monkeypatch, fake_api, path):
    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(path, json=rpc("tools/list"), headers=bearer(KEY_A))
            if path == "/mcp":
                # The router sends the bare mount point to "/mcp/", which is not found.
                assert response.status_code in (307, 404)
            else:
                assert response.status_code == 404
                assert response.json() == {"error": "Not found"}

    asyncio.run(scenario())
    assert fake_api.port.checks == 0


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_only_post_is_served(monkeypatch, fake_api, method):
    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.request(method, "/mcp/tools", headers=bearer(KEY_A))
            assert response.status_code == 405
            assert response.headers["allow"] == "POST"

    asyncio.run(scenario())
    assert fake_api.port.checks == 0


def test_path_scope_reaches_the_tool_and_trailing_slash_is_accepted(monkeypatch, fake_api):
    identity_tools(monkeypatch)
    expected = {
        "/mcp/tools/projects/project-a": ("project-a", ""),
        "/mcp/tools/projects/project-a/": ("project-a", ""),
        "/mcp/tools/projects/project-a/canvases/canvas-a": ("project-a", "canvas-a"),
        "/mcp/tools/projects/project-a/canvases/canvas-a/": ("project-a", "canvas-a"),
        "/mcp/tools": ("", ""),
        "/mcp/tools/": ("", ""),
    }

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for path, (project, canvas) in expected.items():
                response = await client.post(path, json=call("whoami"), headers=bearer(KEY_A))
                assert response.status_code == 200, path
                seen = json.loads(response.json()["result"]["content"][0]["text"])["after"]
                assert seen == {
                    "DRAMACLAW_AGENT_KEY": KEY_A, "DRAMACLAW_PROJECT_ID": project,
                    "DRAMACLAW_CANVAS_ID": canvas, "scoped": True,
                }

    asyncio.run(scenario())


def test_concurrent_keys_never_observe_each_other(monkeypatch, fake_api):
    from novelvideo.chat import request_context

    identity_tools(monkeypatch)
    limits(monkeypatch, total=40, per_key=40)
    identities = [
        (KEY_A, "project-a", "canvas-a"),
        (KEY_B, "project-b", "canvas-b"),
        (KEY_A, "project-a2", ""),
        (KEY_B, "", ""),
    ]

    async def one(client, index):
        key, project, canvas = identities[index % len(identities)]
        path = "/mcp/tools" + (f"/projects/{project}" if project else "") + (
            f"/canvases/{canvas}" if canvas else ""
        )
        expected = {
            "DRAMACLAW_AGENT_KEY": key, "DRAMACLAW_PROJECT_ID": project,
            "DRAMACLAW_CANVAS_ID": canvas, "scoped": True,
        }
        await asyncio.sleep(random.uniform(0, 0.003))
        listed = await client.post(path, json=rpc("tools/list", request_id=index), headers=bearer(key))
        assert listed.status_code == 200
        assert json.loads(listed.json()["result"]["tools"][0]["description"]) == expected
        await asyncio.sleep(random.uniform(0, 0.003))
        called = await client.post(path, json=call("whoami", request_id=index), headers=bearer(key))
        assert called.status_code == 200
        assert called.json()["id"] == index
        seen = json.loads(called.json()["result"]["content"][0]["text"])
        assert seen == {"ok": True, "before": expected, "after": expected}

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            for _ in range(10):
                await asyncio.gather(*(one(client, index) for index in range(40)))
                assert not request_context.active()
        assert not request_context.active()
        assert request_context.get("DRAMACLAW_AGENT_KEY", "") == ""
        assert request_context.get("DRAMACLAW_PROJECT_ID", "") == ""
        assert len(asyncio.all_tasks()) == 1, "A request left a task behind"

    asyncio.run(scenario())
    for name in ("DRAMACLAW_AGENT_KEY", "DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID"):
        assert name not in os.environ


def test_logs_and_error_bodies_carry_no_key_material(monkeypatch, fake_api, caplog):
    identity_tools(monkeypatch)
    caplog.set_level(logging.DEBUG)

    async def scenario():
        bodies = []
        async with client_for(entry_app(monkeypatch)) as client:
            for key in (KEY_A, "fake-entry-key-DO-NOT-USE-unknown"):
                for payload in (rpc("initialize"), call("whoami"), call("missing-tool")):
                    response = await client.post(
                        "/mcp/tools/projects/project-a", json=payload, headers=bearer(key),
                    )
                    # The test tool answers with its own key on purpose; its log lines still count.
                    if response.status_code != 200 or payload != call("whoami"):
                        bodies.append(response.text)
            # The key service fails with the key in its message.
            fake_api.port.failure = RuntimeError(f"key service down for {KEY_B}")
            response = await client.post("/mcp/tools", json=call("whoami"), headers=bearer(KEY_B))
            assert response.status_code == 503
            bodies.append(response.text)
        return bodies

    for body in asyncio.run(scenario()):
        assert_secret_free(body)
        assert "fake-entry-key-DO-NOT-USE-unknown" not in body
    assert caplog.records
    assert_secret_free(caplog.text)
    assert "fake-entry-key-DO-NOT-USE-unknown" not in caplog.text


def test_failing_tool_callbacks_carry_no_key_material(monkeypatch, fake_api, caplog):
    caplog.set_level(logging.DEBUG)
    quoted = []

    def failing_open(self, request, *args, **kwargs):
        quoted.append(request.get_header("Authorization"))
        # Like a client library whose error quotes the request it could not send.
        raise RuntimeError(f"request failed: {request.full_url} {request.header_items()}")

    async def ask(client):
        results = []
        for mode, name, arguments in (
            ("tools", "freezone_list_projects", {}),
            ("workflows", "workflow_catalog_search", {"kind": "recipes"}),
        ):
            response = await client.post(
                f"/mcp/{mode}", json=call(name, arguments), headers=bearer(KEY_A),
            )
            assert response.status_code == 200
            assert_secret_free(response.text)
            results.append(response.json()["result"])
        return results

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            # The API answers the callback with an error that repeats the credential.
            fake_api.callback_status = 500
            echoed = await ask(client)
            # The callback raises with the credential in the exception text.
            monkeypatch.setattr(OpenerDirector, "open", failing_open)
            raised = await ask(client)
        return echoed + raised

    results = asyncio.run(scenario())
    assert [result["isError"] for result in results] == [True] * 4
    assert f"Bearer {TOKEN_A}" in quoted
    assert "mcp.call.end" in caplog.text
    assert_secret_free(caplog.text)


def test_requests_over_the_process_limit_are_refused_at_once(monkeypatch, fake_api):
    state = holding_tools(monkeypatch)
    limits(monkeypatch, total=2, per_key=2)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            held = [
                asyncio.create_task(work(client, key, hold=True)) for key in (KEY_A, KEY_B)
            ]
            await until(lambda: state.running == 2)
            checks = fake_api.port.checks
            for key in (KEY_A, UNKNOWN_KEY):
                refused = await work(client, key)
                assert refused.status_code == 429
                assert refused.headers["retry-after"] == "1"
                body = refused.json()
                assert body["code"] == "remote_mcp_concurrency_limit"
                assert "retry" in body["error"].lower()
                assert MAX_CONCURRENT in body["error"]
                assert_secret_free(refused.text)
                assert UNKNOWN_KEY not in refused.text
            # A full process answers without calling back into the API.
            assert fake_api.port.checks == checks
            state.release.set()
            assert [response.status_code for response in await asyncio.gather(*held)] == [200, 200]
            assert (await work(client, KEY_A)).status_code == 200

    asyncio.run(scenario())


def test_one_key_at_its_limit_leaves_other_keys_served(monkeypatch, fake_api):
    state = holding_tools(monkeypatch)
    limits(monkeypatch, total=3, per_key=1)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            held = asyncio.create_task(work(client, KEY_A, hold=True))
            await until(lambda: state.running == 1)
            refused = await work(client, KEY_A)
            assert refused.status_code == 429
            assert refused.headers["retry-after"] == "1"
            body = refused.json()
            assert body["code"] == "remote_mcp_key_concurrency_limit"
            assert "retry" in body["error"].lower()
            assert MAX_CONCURRENT_PER_KEY in body["error"]
            assert_secret_free(refused.text)
            assert (await work(client, KEY_B)).status_code == 200
            state.release.set()
            assert (await held).status_code == 200
            assert (await work(client, KEY_A)).status_code == 200

    asyncio.run(scenario())


def test_a_failed_request_gives_its_place_back(monkeypatch, fake_api):
    from novelvideo.api import remote_mcp

    holding_tools(monkeypatch)
    limits(monkeypatch, total=1, per_key=1)
    real_serve = remote_mcp._serve
    failures = [RuntimeError("serve failed")]

    async def serve(*args):
        if failures:
            raise failures.pop()
        await real_serve(*args)

    monkeypatch.setattr(remote_mcp, "_serve", serve)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            with pytest.raises(RuntimeError, match="serve failed"):
                await work(client, KEY_A)
            for _ in range(3):
                failed = await work(client, KEY_A, fail=True)
                assert failed.status_code == 200
                assert failed.json()["result"]["isError"] is True
            served = await work(client, KEY_A)
            assert served.status_code == 200
            assert served.json()["result"]["isError"] is False

    asyncio.run(scenario())


def test_a_cancelled_request_gives_its_place_back(monkeypatch, fake_api):
    state = holding_tools(monkeypatch)
    limits(monkeypatch, total=1, per_key=1)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            held = asyncio.create_task(work(client, KEY_A, hold=True))
            await until(lambda: state.running == 1)
            assert (await work(client, KEY_A)).status_code == 429
            # The task running the request is cancelled; its place must come back.
            held.cancel()
            with pytest.raises(asyncio.CancelledError):
                await held
            try:
                assert (await work(client, KEY_A)).status_code == 200
            finally:
                state.release.set()

    asyncio.run(scenario())


def test_requests_without_a_valid_key_take_no_place(monkeypatch, fake_api):
    holding_tools(monkeypatch)
    limits(monkeypatch, total=1, per_key=1)
    fake_api.port.gate = asyncio.Event()

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            unchecked = asyncio.create_task(work(client, UNKNOWN_KEY))
            await until(lambda: fake_api.port.checks == 1)
            try:
                # The only place stays free while the other key is still being checked.
                assert (await work(client, KEY_A)).status_code == 200
            finally:
                fake_api.port.gate.set()
            assert (await unchecked).status_code == 401
            assert (await client.post(
                PROJECT_PATH, json=call("work"), headers=MCP_HEADERS,
            )).status_code == 401
            assert (await work(client, KEY_A)).status_code == 200

    asyncio.run(scenario())


def test_limits_come_from_the_environment(monkeypatch):
    from novelvideo.api import remote_mcp

    total, per_key = remote_mcp.concurrency_limits()
    assert 1 <= per_key <= total
    limits(monkeypatch, total=5, per_key=2)
    assert remote_mcp.concurrency_limits() == (5, 2)
    for value in ("", " ", "0", "-3", "many", "2.5"):
        limits(monkeypatch, total=value, per_key=value)
        assert remote_mcp.concurrency_limits() == (total, per_key), value


def test_workflow_catalog_is_read_off_the_event_loop(monkeypatch):
    from novelvideo.chat import request_context, workflow_mcp

    threads = []

    def catalog():
        threads.append((current_thread(), request_context.get("DRAMACLAW_AGENT_KEY", "")))
        return None

    monkeypatch.setattr(workflow_mcp, "_server_catalog", catalog)

    async def scenario():
        with request_context.scope({"DRAMACLAW_AGENT_KEY": KEY_A}):
            await workflow_mcp.call_tool("workflow_catalog_search", {"kind": "recipes"})
            with pytest.raises(ValueError):
                await workflow_mcp.read_resource("dramaclaw-workflow://recipes/general-image")

    asyncio.run(scenario())
    assert len(threads) == 2
    assert all(thread is not main_thread() and key == KEY_A for thread, key in threads)


def private_catalogs():
    builtin = ROOT / "src/novelvideo/freezone/agent_catalog/builtins"
    catalogs = {}
    for key, token, user in ((KEY_A, TOKEN_A, "alice"), (KEY_B, TOKEN_B, "bob")):
        items = {}
        for kind, source in (("skills", "text-to-image-video"), ("recipes", "general-image")):
            item = json.loads((builtin / kind / f"{source}.json").read_text())
            item.update(id=f"private-{user}", name=f"{user} private")
            if kind == "skills":
                item["allowed_recipe_ids"] = [f"private-{user}"]
            items[kind] = [
                *(json.loads(path.read_text()) for path in sorted((builtin / kind).glob("*.json"))),
                item,
            ]
        catalogs[key] = (token, items)
    return catalogs


def test_tool_calls_reach_the_api_as_the_calling_key(monkeypatch, exchange_factory):
    exchange = exchange_factory(catalogs=private_catalogs())
    limits(monkeypatch, total=4, per_key=2)
    owners = {KEY_A: "alice", KEY_B: "bob"}

    async def ask(client, key, mode, name, arguments):
        response = await client.post(f"/mcp/{mode}", json=call(name, arguments), headers=bearer(key))
        assert response.status_code == 200
        assert_secret_free(response.text)
        return json.loads(response.json()["result"]["content"][0]["text"])

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            skills = await asyncio.gather(*(
                ask(client, key, "tools", "freezone_get_workflow_skill",
                    {"skill_id": f"private-{user}"})
                for key in owners for user in owners.values()
            ))
            searches = await asyncio.gather(*(
                ask(client, key, "workflows", "workflow_catalog_search",
                    {"kind": "recipes", "query": "private"})
                for key in owners
            ))
        return skills, searches

    skills, searches = asyncio.run(scenario())
    assert [item["ok"] for item in skills] == [True, False, False, True]
    assert [{item["id"] for item in result["items"]} for result in searches] == [
        {"private-alice"}, {"private-bob"},
    ]
    assert {request["owner"] for request in exchange.catalog_requests} == set(owners)
    # Keys were exchanged through the port only; tools reused the sessions it gave.
    assert exchange.requests == []
    assert exchange.key_port.exchanges


@pytest.mark.parametrize("path,projects,scope", [
    ("/mcp/tools", ["project-a", "project-b"], {}),
    ("/mcp/tools", ["entry-test-project"], {"DRAMACLAW_PROJECT_ID": "entry-test-project"}),
    ("/mcp/tools/projects/entry-test-project/canvases/entry-test-canvas", [], {
        "DRAMACLAW_PROJECT_ID": "entry-test-project", "DRAMACLAW_CANVAS_ID": "entry-test-canvas",
    }),
    ("/mcp/workflows", [], {}),
])
def test_listed_tools_and_instructions_match_the_stdio_key_server(
    monkeypatch, exchange_factory, path, projects, scope,
):
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        pytest.skip("The stdio server requires the repository .venv/bin/python")
    exchange = exchange_factory(projects=projects)
    mode = path.split("/")[2]
    env = clean_env() | scope | {
        "DRAMACLAW_AGENT_KEY": KEY, "DRAMACLAW_USERNAME": "local", "DRAMACLAW_CE_DIR": str(ROOT),
        "DRAMACLAW_API_URL": f"http://127.0.0.1:{exchange.port}",
    }

    async def scenario():
        expected = await direct_tools(LAUNCHER, mode, env, ROOT, str(python))
        # The stdio launcher exchanges its key over HTTP; the entry must not.
        stdio_exchanges = len(exchange.requests)
        async with client_for(entry_app(monkeypatch)) as client:
            listed = await client.post(path, json=rpc("tools/list"), headers=bearer(KEY))
            initialized = await client.post(path, json=rpc("initialize", {
                "protocolVersion": "2025-03-26", "capabilities": {},
                "clientInfo": {"name": "entry-contract", "version": "1"},
            }), headers=bearer(KEY))
        assert listed.status_code == initialized.status_code == 200
        assert "mcp-session-id" not in initialized.headers
        actual = types.ListToolsResult.model_validate(listed.json()["result"])
        assert actual.tools
        assert serialized(actual) == expected
        instructions = initialized.json()["result"].get("instructions") or ""
        assert ("freezone_list_projects" in instructions) == (
            mode == "tools" and "DRAMACLAW_PROJECT_ID" not in scope
        )
        assert len(exchange.requests) == stdio_exchanges

    asyncio.run(scenario())


def test_plugin_loaded_for_the_process_is_not_reused_for_requests(monkeypatch, fake_api):
    from novelvideo.chat import dramaclaw_mcp

    # A plugin fixes host-dependent tools when it loads; this one loads for the process.
    process_tools = dramaclaw_mcp._plugin_tools("freezone")
    assert "freezone_get_upload_address" not in process_tools

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/tools/projects/project-a", json=rpc("tools/list"), headers=bearer(KEY_A),
            )
            return {tool["name"] for tool in response.json()["result"]["tools"]}

    assert "freezone_get_upload_address" in asyncio.run(scenario())
    assert dramaclaw_mcp._plugin_tools("freezone") is process_tools


def test_process_identity_never_reaches_a_request(monkeypatch, fake_api):
    from novelvideo.chat import request_context

    process_values = {
        "DRAMACLAW_AGENT_TOKEN": "process-token", "DRAMACLAW_AGENT_TOKEN_FILE": "/process/token",
        "DRAMACLAW_AGENT_KEY_FILE": "/process/key", "DRAMACLAW_TURN_ID": "process-turn",
        "DRAMACLAW_CANVAS_ID": "process-canvas", "DRAMACLAW_PROJECT_ID": "process-project",
        "DRAMACLAW_USERNAME": "process-user", "DRAMACLAW_USER": "process-user",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1", "DRAMACLAW_TOOL_MODE": "process-mode",
        "DRAMACLAW_CE_OWNER": "1", "DRAMACLAW_CE_OWNER_ALLOW_REMOTE": "1",
        "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR": "/process/results",
        BRIDGE_DIR: "/process/bridge",
    }
    for name, value in process_values.items():
        monkeypatch.setenv(name, value)
    from novelvideo.chat import dramaclaw_mcp

    def whoami(arguments):
        return json.dumps({"ok": True, "seen": {
            name: request_context.get(name, "") for name in process_values
        }})

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {"whoami": ({
        "name": "whoami", "description": "", "parameters": {"type": "object", "properties": {}},
        "output_schema": OUTPUT_SCHEMA,
    }, whoami)})

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/tools/projects/project-a", json=call("whoami"), headers=bearer(KEY_A),
            )
            assert response.status_code == 200
            return json.loads(response.json()["result"]["content"][0]["text"])["seen"]

    seen = asyncio.run(scenario())
    assert seen.pop("DRAMACLAW_PROJECT_ID") == "project-a"
    assert seen.pop("DRAMACLAW_TOOL_MODE") == "freezone_canvas"
    assert set(seen.values()) == {""}


@pytest.mark.parametrize("path,projects,exchanges", [
    (PROJECT_PATH, ["project-a", "project-b"], [{"kind": "project", "id": "project-a"}]),
    (PROJECT_PATH + "/canvases/canvas-a", ["project-a", "project-b"],
     [{"kind": "project", "id": "project-a"}]),
    # An unscoped path is bound to the key's only project first, with a home session.
    ("/mcp/tools", ["project-a"], [{"kind": "home"}, {"kind": "project", "id": "project-a"}]),
])
def test_project_tools_request_writes_events_to_the_project_directory(
    monkeypatch, fake_api, tmp_path, path, projects, exchanges,
):
    fake_api.username, fake_api.projects = "alice", projects
    asked = project_home(monkeypatch, tmp_path / "state")
    bridge_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            return await seen_bridge_dir(client, path)

    assert asyncio.run(scenario()) == expected_bridge_dir("alice", tmp_path / "state")
    assert asked == [({"username": "alice"}, "project-a", "viewer")]
    # Who is calling is asked with a session the key check already opened.
    assert fake_api.port.exchanges == exchanges


def test_process_event_directory_never_reaches_a_request(monkeypatch, fake_api, tmp_path):
    monkeypatch.setenv(BRIDGE_DIR, str(tmp_path / "process"))
    fake_api.username = "alice"
    project_home(monkeypatch, tmp_path / "state")
    bridge_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            # The key sees two projects, so the unscoped path stays without one.
            return [await seen_bridge_dir(client, path) for path in (PROJECT_PATH, "/mcp/tools")]

    assert asyncio.run(scenario()) == [
        expected_bridge_dir("alice", tmp_path / "state"), "<unset>",
    ]


@pytest.mark.parametrize("failure", [
    "username unavailable", "username malformed", "project unavailable",
    "project on another node", "workspace unavailable",
])
def test_unresolved_event_directory_is_left_unset_and_the_request_served(
    monkeypatch, fake_api, tmp_path, caplog, failure,
):
    from fastapi import HTTPException
    from novelvideo.api import remote_mcp

    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv(BRIDGE_DIR, str(tmp_path / "process"))
    fake_api.username = "alice"
    asked = project_home(
        monkeypatch, tmp_path / "state", home_node=failure != "project on another node",
    )
    if failure == "username unavailable":
        fake_api.username = None
    elif failure == "username malformed":
        fake_api.username = ["alice"]
    elif failure == "project unavailable":
        async def refuse(**kwargs):
            raise HTTPException(status_code=404, detail=f"Project not found for {KEY_A}")

        monkeypatch.setattr(remote_mcp, "resolve_project_context", refuse)
    elif failure == "workspace unavailable":
        def broken(*args, **kwargs):
            raise OSError(f"cannot prepare the workspace for {KEY_A}")

        monkeypatch.setattr(remote_mcp, "ensure_user_hermes_workspace", broken)
    bridge_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            return await seen_bridge_dir(client, PROJECT_PATH)

    assert asyncio.run(scenario()) == "<unset>"
    assert "/api/v1/auth/me" in fake_api.gets
    assert bool(asked) == (failure in {"project on another node", "workspace unavailable"})
    assert "kept the default event directory" in caplog.text
    assert_secret_free(caplog.text)
    assert not (tmp_path / "state").exists()


def test_workflows_request_resolves_no_event_directory(monkeypatch, fake_api, tmp_path):
    fake_api.username = "alice"
    asked = project_home(monkeypatch, tmp_path / "state")

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/workflows/projects/project-a", json=rpc("tools/list"),
                headers=bearer(KEY_A),
            )
            assert response.status_code == 200

    asyncio.run(scenario())
    assert asked == []
    assert fake_api.gets == []
    assert not (tmp_path / "state").exists()


def test_event_written_through_the_entry_lands_in_the_project_directory(
    monkeypatch, fake_api, tmp_path,
):
    import tempfile

    from novelvideo.chat import dramaclaw_mcp
    from novelvideo.freezone import canvas_command_bridge

    system_tmp = tmp_path / "system-tmp"
    system_tmp.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(system_tmp))
    fake_api.username = "alice"
    project_home(monkeypatch, tmp_path / "state")

    def emit(arguments):
        # Written like the tools write it: without naming a directory.
        canvas_command_bridge.put_pending_skill_studio_event(
            key="entry-event", project_id="project-a", canvas_id="canvas-a",
            event={"type": "entry-test"},
        )
        return json.dumps({"ok": True})

    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {"emit": ({
        "name": "emit", "description": "", "parameters": {"type": "object", "properties": {}},
        "output_schema": OUTPUT_SCHEMA,
    }, emit)})

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                PROJECT_PATH + "/canvases/canvas-a", json=call("emit"), headers=bearer(KEY_A),
            )
            assert response.status_code == 200
            assert response.json()["result"]["isError"] is False

    asyncio.run(scenario())

    def pending(directory):
        return [item["key"] for item in canvas_command_bridge.list_pending_bridge_messages(
            project_id="project-a", canvas_id="canvas-a", bridge_dir=directory,
        )]

    assert pending(expected_bridge_dir("alice", tmp_path / "state")) == ["entry-event"]
    assert pending(system_tmp / "supertale_canvas_command_bridge") == []
    assert list(system_tmp.iterdir()) == []
