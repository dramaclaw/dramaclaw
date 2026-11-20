"""Remote MCP entry served by the API process: stateless, one key per request."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import random
from threading import Thread, current_thread, main_thread
import time

import httpx
from mcp import types
import pytest
from starlette.applications import Starlette

from test_remote_mcp_relay import (
    FAKE_TOKEN,
    KEY,
    LAUNCHER,
    ROOT,
    Exchange,
    clean_env,
    direct_tools,
    serialized,
)

FLAG = "DRAMACLAW_REMOTE_MCP_ENABLED"
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
    "DRAMACLAW_LOCAL_AGENT_TRUST", "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR",
    "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "DRAMACLAW_API_URL", FLAG,
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
    """Session exchange and project listing whose accepted keys can change mid-test."""

    def __init__(self, sessions):
        self.sessions = dict(sessions)
        self.exchange_status = None
        self.exchanges = []
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
                key = self.headers.get("Authorization", "").removeprefix("Bearer ")
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                fake.exchanges.append(body.get("scope"))
                token = fake.sessions.get(key)
                if self.path != "/api/v1/agent/sessions":
                    self.reply(404, {"ok": False})
                elif fake.exchange_status is not None:
                    self.reply(fake.exchange_status, {"ok": False})
                elif token is None:
                    self.reply(401, {"ok": False})
                else:
                    self.reply(200, {"ok": True, "data": {
                        "token": token, "expires_at": time.time() + 3600,
                    }})

            def do_GET(self):
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                if token not in fake.sessions.values():
                    self.reply(401, {"ok": False})
                else:
                    self.reply(200, {"ok": True, "data": [
                        {"id": "project-a"}, {"id": "project-b"},
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
    for name in IDENTITY_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    from novelvideo.chat import agent_key_session, dramaclaw_mcp

    for name, empty in (("_CACHE", {}), ("_LOCKS", {}), ("_SECRETS", set())):
        monkeypatch.setattr(agent_key_session, name, empty)
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})


@pytest.fixture
def fake_api(monkeypatch):
    api = FakeApi({KEY_A: TOKEN_A, KEY_B: TOKEN_B})
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    yield api
    api.close()


@pytest.fixture
def exchange_factory(monkeypatch):
    started = []

    def start(**kwargs):
        exchange = Exchange(**kwargs)
        started.append(exchange)
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
                assert response.json() == {"error": "Bearer key required"}

    asyncio.run(scenario())
    assert fake_api.exchanges == []


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
                assert response.json()["error"] == "Agent key rejected"

    asyncio.run(scenario())
    assert fake_api.exchanges == [{"kind": "project", "id": "project-a"}] * 3


@pytest.mark.parametrize("exchange_status,status,error", [
    (401, 401, "Agent key rejected"),
    (403, 401, "Agent key rejected"),
    (500, 503, "Agent key check unavailable"),
    (404, 503, "Agent key check unavailable"),
])
def test_revoked_or_expired_key_surfaces_the_exchange_reason(
    monkeypatch, fake_api, exchange_status, status, error,
):
    identity_tools(monkeypatch)

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            path = "/mcp/tools/projects/project-a"
            first = await client.post(path, json=call("whoami"), headers=bearer(KEY_A))
            assert first.status_code == 200
            # The cached session is dropped, as when it expires or the API refuses it.
            from novelvideo.chat import agent_key_session

            agent_key_session._CACHE.clear()
            fake_api.exchange_status = exchange_status
            refused = await client.post(path, json=call("whoami"), headers=bearer(KEY_A))
            assert refused.status_code == status
            body = refused.json()
            assert body["error"] == error
            assert body["status_code"] == exchange_status
            assert body["code"].startswith("agent_key_exchange_")
            assert_secret_free(refused.text)

    asyncio.run(scenario())


def test_unreachable_exchange_is_unavailable(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:1")

    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/tools", json=rpc("tools/list"), headers=bearer(KEY_A),
            )
            assert response.status_code == 503
            assert response.json()["error"] == "Agent key check unavailable"
            assert_secret_free(response.text)

    asyncio.run(scenario())


def test_missing_api_address_names_the_setting(monkeypatch):
    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.post(
                "/mcp/tools", json=rpc("tools/list"), headers=bearer(KEY_A),
            )
            assert response.status_code == 503
            assert "DRAMACLAW_API_URL" in response.json()["error"]

    asyncio.run(scenario())


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
    assert fake_api.exchanges == []


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_only_post_is_served(monkeypatch, fake_api, method):
    async def scenario():
        async with client_for(entry_app(monkeypatch)) as client:
            response = await client.request(method, "/mcp/tools", headers=bearer(KEY_A))
            assert response.status_code == 405
            assert response.headers["allow"] == "POST"

    asyncio.run(scenario())
    assert fake_api.exchanges == []


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
            fake_api.exchange_status = 500
            from novelvideo.chat import agent_key_session

            agent_key_session._CACHE.clear()
            response = await client.post("/mcp/tools", json=call("whoami"), headers=bearer(KEY_B))
            bodies.append(response.text)
        return bodies

    for body in asyncio.run(scenario()):
        assert_secret_free(body)
        assert "fake-entry-key-DO-NOT-USE-unknown" not in body
    assert caplog.records
    assert_secret_free(caplog.text)
    assert "fake-entry-key-DO-NOT-USE-unknown" not in caplog.text


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
    assert all(request["authorization_matches"] for request in exchange.requests)


@pytest.mark.parametrize("path,projects,scope", [
    ("/mcp/tools", ["project-a", "project-b"], {}),
    ("/mcp/tools", ["relay-test-project"], {"DRAMACLAW_PROJECT_ID": "relay-test-project"}),
    ("/mcp/tools/projects/relay-test-project/canvases/relay-test-canvas", [], {
        "DRAMACLAW_PROJECT_ID": "relay-test-project", "DRAMACLAW_CANVAS_ID": "relay-test-canvas",
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
        "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR": "/process/results",
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
