"""External MCP credentials exercised against a real, local HTTP boundary."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import re
import sys
from threading import Barrier, Lock, Thread
import time
from typing import Any
from urllib.parse import unquote, urlsplit

import pytest
from mcp import types

from novelvideo.chat import dramaclaw_mcp


KEY = "fake-agent-key-DO-NOT-USE-1111"
OTHER_KEY = "fake-agent-key-DO-NOT-USE-2222"
TOKEN = "fake-session-token-AAAA-0001"
OTHER_TOKEN = "fake-session-token-BBBB-0002"
EXCHANGE_PATH = "/api/v1/agent/sessions"
PROJECT_PATH = "/api/v1/projects/project-a/ping"
ENV_VARS = (
    "DRAMACLAW_AGENT_TOKEN", "DRAMACLAW_AGENT_TOKEN_FILE",
    "DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE",
    "DRAMACLAW_LOCAL_AGENT_TRUST", "DRAMACLAW_CE_OWNER",
    "DRAMACLAW_CE_OWNER_ALLOW_REMOTE", "DRAMACLAW_PROJECT_ID",
    "DRAMACLAW_CANVAS_ID", "DRAMACLAW_AGENT_PROFILE", "DRAMACLAW_TOOL_MODE",
    "DRAMACLAW_CHAT_SURFACE", "DRAMACLAW_ROOT",
)


@dataclass
class FakeAPI:
    url: str = ""
    requests: list[dict[str, Any]] = field(default_factory=list)
    issued: dict[str, dict[str, Any]] = field(default_factory=dict)
    invalidated: set[str] = field(default_factory=set)
    accepted_tokens: set[str] = field(default_factory=set)
    exchange_status: int = 200
    exchange_body: Any = None
    expires_in: int = 3600
    exchange_delay: float = 0
    business_statuses: list[int] = field(default_factory=list)
    echo_secrets: bool = False
    allow_anonymous: bool = False
    lock: Lock = field(default_factory=Lock)

    @property
    def exchanges(self) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["path"] == EXCHANGE_PATH]

    @property
    def business(self) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["path"] != EXCHANGE_PATH]

    def handle(self, request: dict[str, Any]) -> tuple[int, Any]:
        with self.lock:
            self.requests.append(request)
            if request["path"] == EXCHANGE_PATH:
                number = len(self.exchanges)
                if self.exchange_status >= 400:
                    return self.exchange_status, self.error_body(request)
                if self.exchange_body is not None:
                    return self.exchange_status, self.exchange_body
                token = f"fake-session-token-ISSUED-{number:04d}"
                scope = (request["body"] or {}).get("scope", {})
                self.issued[token] = scope
                response = {
                    "ok": True,
                    "data": {
                        "token": token, "token_type": "Bearer",
                        "session_id": f"fake-session-id-{number:04d}",
                        "expires_at": int(time.time()) + self.expires_in,
                        "agent_kind": "external", "scopes": [scope],
                    },
                }
                return self.exchange_status, response

            authorization = request["authorization"]
            token = authorization.removeprefix("Bearer ") if authorization else ""
            status = self.business_statuses.pop(0) if self.business_statuses else 200
            valid = (
                token in self.accepted_tokens
                or (token in self.issued and token not in self.invalidated)
                or (not authorization and self.allow_anonymous)
            )
            if not valid and status == 200:
                status = 401
            scope = self.issued.get(token, {})
            project = re.search(r"/projects/([^/]+)", request["path"])
            if (
                status == 200 and project and scope.get("kind") == "project"
                and unquote(project.group(1)) != scope.get("id")
            ):
                status = 403
            if status != 200:
                if status == 401:
                    self.invalidated.add(token)
                return status, self.error_body(request)
            return 200, {"ok": True, "data": {"pong": True}}

    def error_body(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.echo_secrets:
            return {"detail": "invalid agent credential"}
        # Echo every credential the client has held (the key, the current and
        # earlier sessions), as bare strings in nested fields as well as in
        # detail, to detect partial error-body sanitization.
        secrets = [KEY, *self.issued, request["authorization"] or ""]
        return {"detail": "rejected " + " ".join(secrets),
                "debug": {"credentials": secrets}, "extra": secrets}


@pytest.fixture
def api_factory():
    running = []

    def start() -> FakeAPI:
        api = FakeAPI()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                request = {
                    "method": self.command, "path": urlsplit(self.path).path,
                    "query": urlsplit(self.path).query,
                    "authorization": self.headers.get("Authorization"),
                    "body": json.loads(raw) if raw else None,
                }
                # Sleep outside the state lock so concurrent exchanges would
                # all arrive; the server must not serialize the client for it.
                if request["path"] == EXCHANGE_PATH:
                    time.sleep(api.exchange_delay)
                status, body = api.handle(request)
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        running.append((server, thread))
        api.url = f"http://127.0.0.1:{server.server_port}"
        thread.start()
        return api

    try:
        yield start
    finally:
        for server, thread in reversed(running):
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


@pytest.fixture
def api(api_factory):
    return api_factory()


@pytest.fixture(params=["freezone", "dramaclaw"])
def plugin(request, monkeypatch, api):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    monkeypatch.delitem(sys.modules, "tools.registry", raising=False)
    monkeypatch.delitem(sys.modules, "tools", raising=False)
    dramaclaw_mcp._install_hermes_registry_shim()
    return dramaclaw_mcp._plugin(request.param)


def request_result(plugin, method="GET", path=PROJECT_PATH, **kwargs):
    """Make a raised credential error an explicit contract assertion failure."""
    try:
        result = plugin._request(method, path, **kwargs)
    except Exception as exc:
        result = exc
    assert isinstance(result, dict), (
        f"_request must return a result dict, not raise {type(result).__name__}"
    )
    return result


def assert_success(result):
    assert result.get("ok") is True
    assert result.get("status_code") == 200


@pytest.mark.parametrize("source", ["DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE"])
def test_available_with_key_source(plugin, monkeypatch, tmp_path, source):
    # Availability does not read the file; it may be populated after startup.
    value = KEY if source.endswith("_KEY") else str(tmp_path / "not-created-yet.key")
    monkeypatch.setenv(source, value)
    assert plugin._available() is True


@pytest.mark.parametrize("path,project,scope", [
    (PROJECT_PATH, None, {"kind": "project", "id": "project-a"}),
    ("/projects/project%20with%2Fslash/ping", "fallback", {"kind": "project", "id": "project with/slash"}),
    (PROJECT_PATH, "fallback", {"kind": "project", "id": "project-a"}),
    ("/api/v1/ping", "fallback", {"kind": "project", "id": "fallback"}),
    ("/api/v1/ping", None, {"kind": "home"}),
])
def test_exchange_shape_and_scope(plugin, api, monkeypatch, path, project, scope):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    if project:
        monkeypatch.setenv("DRAMACLAW_PROJECT_ID", project)
    assert_success(request_result(plugin, path=path))
    assert api.exchanges == [{
        "method": "POST", "path": EXCHANGE_PATH, "query": "",
        "authorization": f"Bearer {KEY}", "body": {"scope": scope},
    }]
    assert len(api.business) == 1
    assert api.business[0]["method"] == "GET"
    assert api.business[0]["path"] == ("/api/v1" + path if path.startswith("/projects/") else path)
    assert api.business[0]["authorization"] == f"Bearer {next(iter(api.issued))}"
    assert KEY not in json.dumps(api.business)


@pytest.mark.parametrize("expires_in,exchange_count", [(3600, 1), (30, 2), (60, 2)])
def test_cache_lifetime(plugin, api, monkeypatch, expires_in, exchange_count):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.expires_in = expires_in
    for _ in range(2):
        assert_success(request_result(plugin))
    assert len(api.exchanges) == exchange_count
    assert len(api.business) == 2
    assert len({r["authorization"] for r in api.business}) == exchange_count


def test_concurrent_same_scope_exchanges_once(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_delay = 0.2
    barrier = Barrier(8)

    def call(_):
        barrier.wait(timeout=10)
        return request_result(plugin)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(call, range(8)))
    for result in results:
        assert_success(result)
    assert len(api.exchanges) == 1
    assert len(api.business) == 8
    assert {r["authorization"] for r in api.business} == {f"Bearer {next(iter(api.issued))}"}


def test_cache_is_separate_per_scope(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    for project in ("project-a", "project-b", "project-a", "project-b"):
        assert_success(request_result(plugin, path=f"/api/v1/projects/{project}/ping"))
    assert [r["body"]["scope"] for r in api.exchanges] == [
        {"kind": "project", "id": "project-a"}, {"kind": "project", "id": "project-b"},
    ]
    headers = [r["authorization"] for r in api.business]
    assert headers[0] == headers[2]
    assert headers[1] == headers[3]
    assert headers[0] != headers[1]


def test_home_and_project_have_separate_cached_sessions(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    for path in ("/api/v1/ping", PROJECT_PATH, "/api/v1/ping"):
        assert_success(request_result(plugin, path=path))
    assert [r["body"]["scope"] for r in api.exchanges] == [
        {"kind": "home"}, {"kind": "project", "id": "project-a"},
    ]
    assert api.business[0]["authorization"] == api.business[2]["authorization"]


def test_cache_is_separate_per_api_base_url(plugin, api, api_factory, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    assert_success(request_result(plugin))
    other_api = api_factory()
    monkeypatch.setenv("DRAMACLAW_API_URL", other_api.url)
    assert_success(request_result(plugin))
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    assert_success(request_result(plugin))
    assert len(api.exchanges) == len(other_api.exchanges) == 1
    assert len(api.business) == 2
    assert len(other_api.business) == 1


def test_cache_is_separate_per_key(plugin, api, monkeypatch):
    for key in (KEY, OTHER_KEY, KEY):
        monkeypatch.setenv("DRAMACLAW_AGENT_KEY", key)
        assert_success(request_result(plugin))
    assert [r["authorization"] for r in api.exchanges] == [f"Bearer {KEY}", f"Bearer {OTHER_KEY}"]
    assert api.business[0]["authorization"] == api.business[2]["authorization"]


def test_key_file_is_lazy_stripped_and_beats_key_env(plugin, api, monkeypatch, tmp_path):
    key_file = tmp_path / "agent.key"
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY_FILE", str(key_file))
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", OTHER_KEY)
    assert api.requests == []
    key_file.write_text(f" \n{KEY}\n ", encoding="utf-8")
    assert_success(request_result(plugin))
    assert api.exchanges[0]["authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize("statuses,expected_ok", [([401], True), ([401, 401], False)])
def test_business_401_exchanges_and_retries_exact_request_once(plugin, api, monkeypatch, statuses, expected_ok):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.business_statuses = list(statuses)
    result = request_result(plugin, "POST", query={"view": "compact", "page": 2}, body={"message": "hello"})
    assert result.get("ok") is expected_ok
    assert result.get("status_code") == (200 if expected_ok else 401)
    assert len(api.exchanges) == len(api.business) == 2
    first, retry = api.business
    assert first["authorization"] != retry["authorization"]
    assert {k: v for k, v in first.items() if k != "authorization"} == {
        k: v for k, v in retry.items() if k != "authorization"
    } == {"method": "POST", "path": PROJECT_PATH, "query": "view=compact&page=2", "body": {"message": "hello"}}


def test_401_invalidates_only_its_scope(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    other_path = "/api/v1/projects/project-b/ping"
    assert_success(request_result(plugin))
    assert_success(request_result(plugin, path=other_path))
    other_auth = api.business[-1]["authorization"]
    api.business_statuses = [401]
    assert_success(request_result(plugin))
    assert_success(request_result(plugin, path=other_path))
    assert len(api.exchanges) == 3
    assert len(api.business) == 5
    assert api.business[-1]["authorization"] == other_auth


@pytest.mark.parametrize("status", [403, 503])
def test_business_non_401_preserves_status_without_retry(plugin, api, monkeypatch, status):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.business_statuses = [status]
    result = request_result(plugin)
    assert result.get("ok") is False
    assert result.get("status_code") == status
    assert len(api.exchanges) == len(api.business) == 1


@pytest.mark.parametrize("status", [400, 401, 403, 422, 503, 404, 405])
def test_exchange_http_failure_is_result_without_business_call(plugin, api, monkeypatch, status):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_status = status
    result = request_result(plugin)
    assert result.get("ok") is False
    assert result.get("status_code") == status
    unsupported = status in {404, 405}
    assert result.get("code") == ("agent_key_exchange_unsupported" if unsupported else "agent_key_exchange_failed")
    if unsupported:
        assert "DRAMACLAW_LOCAL_AGENT_TRUST" in result.get("error", "")
    assert len(api.exchanges) == 1
    assert api.business == []


@pytest.mark.parametrize("body", [
    {}, {"ok": True, "data": {}}, {"ok": True, "data": {"token": None}},
    {"ok": True, "data": {"token": 123}}, {"ok": True, "data": []},
], ids=["no-data", "missing-token", "null-token", "numeric-token", "non-object-data"])
def test_exchange_malformed_success_is_unsupported(plugin, api, monkeypatch, body):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_body = body
    result = request_result(plugin)
    assert result.get("ok") is False
    assert result.get("status_code") == 200
    assert result.get("code") == "agent_key_exchange_unsupported"
    assert "DRAMACLAW_LOCAL_AGENT_TRUST" in result.get("error", "")
    assert len(api.exchanges) == 1
    assert api.business == []


def test_unreadable_key_file_does_not_fall_back(plugin, api, monkeypatch, tmp_path):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY_FILE", str(tmp_path / "missing.key"))
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    api.allow_anonymous = True
    result = request_result(plugin)
    assert result.get("ok") is False
    assert result.get("code") == "agent_key_unavailable"
    assert api.requests == []


def test_key_refuses_insecure_remote_http_without_network(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://agent.example.invalid")
    attempted = []

    def forbid_network(*args, **kwargs):
        attempted.append((args, kwargs))
        raise AssertionError("insecure key mode must reject before urlopen")

    # No DNS/network is allowed even if the transport guard regresses.
    monkeypatch.setattr(plugin, "urlopen", forbid_network)
    result = request_result(plugin)
    assert attempted == []
    assert api.requests == []
    assert result.get("ok") is False
    assert result.get("code") == "agent_key_insecure_transport"


@pytest.mark.parametrize("source", ["env", "file"])
def test_existing_token_beats_key_and_never_exchanges(plugin, api, monkeypatch, tmp_path, source):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    # A missing key file also proves that token mode never consults it.
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY_FILE", str(tmp_path / "missing.key"))
    if source == "env":
        monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", TOKEN)
    else:
        token_file = tmp_path / "session.token"
        token_file.write_text(f" \n{TOKEN}\n", encoding="utf-8")
        monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
        monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", OTHER_TOKEN)
    api.accepted_tokens.add(TOKEN)
    assert_success(request_result(plugin))
    assert api.exchanges == []
    assert [r["authorization"] for r in api.business] == [f"Bearer {TOKEN}"]


def test_existing_token_file_is_reread_every_call(plugin, api, monkeypatch, tmp_path):
    token_file = tmp_path / "session.token"
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.accepted_tokens.update({TOKEN, OTHER_TOKEN})
    for token in (TOKEN, OTHER_TOKEN):
        token_file.write_text(token, encoding="utf-8")
        assert_success(request_result(plugin))
    assert api.exchanges == []
    assert [r["authorization"] for r in api.business] == [f"Bearer {TOKEN}", f"Bearer {OTHER_TOKEN}"]


@pytest.mark.parametrize("source", ["env", "file"])
def test_existing_token_mode_does_not_retry_401(plugin, api, monkeypatch, tmp_path, source):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    if source == "env":
        monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", TOKEN)
    else:
        token_file = tmp_path / "session.token"
        token_file.write_text(TOKEN, encoding="utf-8")
        monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
    api.accepted_tokens.add(TOKEN)
    api.business_statuses = [401]
    result = request_result(plugin)
    assert result.get("ok") is False
    assert result.get("status_code") == 401
    assert api.exchanges == []
    assert len(api.business) == 1


def test_key_beats_local_trust(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    api.allow_anonymous = True
    assert_success(request_result(plugin))
    assert len(api.exchanges) == 1
    assert api.business[0]["authorization"] == f"Bearer {next(iter(api.issued))}"


@pytest.mark.parametrize("plugin", ["dramaclaw"], indirect=True)
def test_key_beats_ce_owner(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")
    api.allow_anonymous = True
    assert_success(request_result(plugin))
    assert len(api.exchanges) == 1
    assert api.business[0]["authorization"] == f"Bearer {next(iter(api.issued))}"


def test_existing_loopback_local_trust_sends_no_authorization(plugin, api, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    api.allow_anonymous = True
    assert plugin._available() is True
    assert_success(request_result(plugin))
    assert api.exchanges == []
    assert [r["authorization"] for r in api.business] == [None]


@pytest.fixture
def secret_sinks(plugin, monkeypatch, tmp_path, caplog):
    for name, directory in (
        ("HOME", "home"), ("TMPDIR", "tmp"),
        ("DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", "tool-results"),
    ):
        path = tmp_path / directory
        path.mkdir()
        monkeypatch.setenv(name, str(path))
    key_file = tmp_path / "agent.key"
    key_file.write_text(KEY, encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY_FILE", str(key_file))
    caplog.set_level(logging.DEBUG)
    return key_file


@pytest.fixture
def read_tool(plugin, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    is_freezone = "freezone" in plugin.__name__
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas" if is_freezone else "mainline")
    if is_freezone:
        return "freezone_get_saved_skill", {"skill_id": "fake-skill"}
    return "dramaclaw_list_tasks", {}


@pytest.mark.asyncio
async def test_existing_token_reaches_read_only_mcp_tool(plugin, api, monkeypatch, read_tool):
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", TOKEN)
    api.accepted_tokens.add(TOKEN)
    api.business_statuses = [401]
    name, arguments = read_tool
    result = await dramaclaw_mcp.call_tool(name, arguments)
    assert result.isError is True
    assert api.exchanges == []
    assert len(api.business) == 1
    assert api.business[0]["method"] == "GET"
    assert api.business[0]["authorization"] == f"Bearer {TOKEN}"


def assert_no_secret_leaks(result, api, key_file, tmp_path, caplog, capsys):
    captured = capsys.readouterr()
    sinks = {
        "result": json.dumps(result, default=str),
        "logs": caplog.text,
        "stdout": captured.out, "stderr": captured.err,
        "environment": json.dumps(dict(os.environ)),
    }
    for path in tmp_path.rglob("*"):
        if path.is_file() and path != key_file:
            sinks[f"file:{path.relative_to(tmp_path)}"] = path.read_bytes().decode("utf-8", errors="replace")
    for label, value in sinks.items():
        for secret in (KEY, OTHER_KEY, *api.issued):
            assert secret not in value, f"credential leaked into {label}"


@pytest.mark.parametrize("failure", ["success", "exchange-401", "business-401", "business-403"])
def test_key_and_sessions_never_escape_process_memory(
    plugin, api, secret_sinks, tmp_path, caplog, capsys, failure,
):
    api.echo_secrets = True
    if failure == "exchange-401":
        api.exchange_status = 401
    elif failure.startswith("business-"):
        status = int(failure.split("-")[1])
        api.business_statuses = [status, status] if status == 401 else [status]
    try:
        result = plugin._request("GET", PROJECT_PATH)
    except Exception as exc:
        result = exc
    assert_no_secret_leaks(result, api, secret_sinks, tmp_path, caplog, capsys)
    assert isinstance(result, dict), f"expected result dict, got {type(result).__name__}"
    assert result.get("ok") is (failure == "success")
    assert len(api.exchanges) == (2 if failure == "business-401" else 1)
    if failure != "exchange-401":
        assert len(api.issued) == (2 if failure == "business-401" else 1)
    if failure == "success":
        # A second call must reuse only the in-memory session, with no new sinks.
        assert_success(request_result(plugin))
        assert len(api.exchanges) == 1
        assert_no_secret_leaks(result, api, secret_sinks, tmp_path, caplog, capsys)


@pytest.mark.asyncio
async def test_mcp_tool_result_redacts_all_sessions_after_two_401s(
    plugin, api, read_tool, secret_sinks, tmp_path, caplog, capsys,
):
    name, arguments = read_tool
    api.echo_secrets = True
    api.business_statuses = [401, 401]
    try:
        result = await dramaclaw_mcp.call_tool(name, arguments)
    except Exception as exc:
        result = exc
    payload = result.model_dump() if isinstance(result, types.CallToolResult) else result
    assert_no_secret_leaks(payload, api, secret_sinks, tmp_path, caplog, capsys)
    assert isinstance(result, types.CallToolResult), (
        f"MCP must return tool content, not raise {type(result).__name__}"
    )
    assert result.isError is True
    assert len(api.exchanges) == len(api.business) == 2
    assert all(r["method"] == "GET" for r in api.business)
    assert len(api.issued) == 2


@pytest.mark.parametrize("path", [
    "https://evil.example.invalid/api/v1/x",
    "/api/v1/projects/project-a/../x",
])
def test_key_mode_preserves_path_validation_errors(plugin, api, monkeypatch, path):
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    with pytest.raises(ValueError) as local_error:
        plugin._request("GET", path)

    monkeypatch.delenv("DRAMACLAW_LOCAL_AGENT_TRUST")
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    with pytest.raises(type(local_error.value)) as key_error:
        plugin._request("GET", path)

    assert type(key_error.value) is type(local_error.value)
    assert str(key_error.value) == str(local_error.value)
    assert api.requests == []
