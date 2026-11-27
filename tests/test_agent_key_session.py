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

from novelvideo.chat import agent_key_session, dramaclaw_mcp


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
    business_location: str = ""
    echo_secrets: bool = False
    allow_anonymous: bool = False
    business_bodies: dict[str, Any] = field(default_factory=dict)
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
            return 200, self.business_bodies.get(
                request["path"], {"ok": True, "data": {"pong": True}},
            )

    def error_body(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.echo_secrets:
            return {"detail": "invalid agent credential"}
        # Echo every credential the client has held (the key, the current and
        # earlier sessions), as bare strings in nested fields as well as in
        # detail, to detect partial error-body sanitization.
        secrets = [KEY, *self.issued, request["authorization"] or ""]
        return {"detail": "rejected " + " ".join(secrets),
                "debug": {"credentials": secrets}, "extra": secrets}


@pytest.fixture(autouse=True)
def clear_agent_key_session_state():
    """Clear process-wide sessions keyed by API base, as random ports can recur in a worker."""
    agent_key_session._state.cache.clear()
    agent_key_session._state.locks.clear()
    agent_key_session._state.secrets.clear()
    try:
        yield
    finally:
        agent_key_session._state.cache.clear()
        agent_key_session._state.locks.clear()
        agent_key_session._state.secrets.clear()


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
                if 300 <= status < 400 and api.business_location:
                    self.send_header("Location", api.business_location)
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


def test_each_test_starts_without_cached_agent_sessions(plugin, api, monkeypatch):
    assert agent_key_session._state.cache == {}
    assert agent_key_session._state.locks == {}

    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    assert_success(request_result(plugin))
    assert len(agent_key_session._state.cache) == 1


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


@pytest.fixture
def redirecting_api():
    """A local address that answers every request with a redirect elsewhere."""
    state = {"status": 302, "location": "", "requests": []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state["requests"].append((self.command, urlsplit(self.path).path))
            self.send_response(state["status"])
            self.send_header("Location", state["location"])
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}"
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_key_exchange_does_not_follow_a_redirect(plugin, api, redirecting_api, monkeypatch, status):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_API_URL", redirecting_api["url"])
    redirecting_api["status"] = status
    redirecting_api["location"] = f"{api.url}{EXCHANGE_PATH}"

    result = request_result(plugin)

    # The address the redirect points at must never see the key, or anything else.
    assert api.requests == []
    assert redirecting_api["requests"] == [("POST", EXCHANGE_PATH)]
    assert result.get("ok") is False
    assert result.get("code") == "agent_key_exchange_redirected"
    assert result.get("status_code") == status
    assert "redirect" in result.get("error", "")
    assert "DRAMACLAW_API_URL must be the final API address" in result.get("error", "")
    assert KEY not in json.dumps(result)


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_key_business_request_does_not_follow_a_redirect(
    plugin, api, api_factory, monkeypatch, status, method,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    elsewhere = api_factory()
    api.business_statuses = [status]
    api.business_location = f"{elsewhere.url}{PROJECT_PATH}"

    result = request_result(plugin, method, PROJECT_PATH, body={} if method == "POST" else None)

    # The address the redirect points at must never see the session, or anything else.
    assert elsewhere.requests == []
    assert len(api.exchanges) == 1
    assert [(r["method"], r["path"]) for r in api.business] == [(method, PROJECT_PATH)]
    assert result.get("ok") is False
    assert result.get("code") == "agent_key_request_redirected"
    assert result.get("status_code") == status
    assert "redirect" in result.get("error", "")
    assert "DRAMACLAW_API_URL must be the final API address" in result.get("error", "")
    assert not any(token in json.dumps(result) for token in (KEY, *api.issued))


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


@pytest.mark.parametrize("status,kind,reason", [
    (401, "rejected", "agent_key_rejected"),
    (403, "rejected", "agent_key_project_forbidden"),
    (503, "unavailable", "agent_key_service_unavailable"),
    (500, "unavailable", "agent_key_service_unavailable"),
])
def test_exchange_failure_says_whether_key_was_rejected(
    plugin, api, monkeypatch, status, kind, reason,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_status = status
    result = request_result(plugin)
    assert result.get("code") == "agent_key_exchange_failed"
    assert result.get("status_code") == status
    assert result.get("status") == kind
    assert result.get("reason") == reason
    assert result.get("next_action") == ("tell_user" if kind == "rejected" else "retry")
    assert result.get("retryable") is (kind == "unavailable")
    message = result.get("message", "")
    if status == 403:
        assert message == (
            "The agent key is valid but cannot be used on this project (HTTP 403). "
            "You can switch to a project the key can access, or ask the key owner "
            "to check that their account has access to this project and that the key "
            "includes it."
        )
        assert result["agent_instruction"] == (
            "Do not retry with the same key for this project. Tell the user the agent "
            "key cannot be used on this project and that they can switch to a project "
            "the key can access, or ask the key owner to check that their account has "
            "access to this project and that the key includes it."
        )
        for guidance in (message, result["agent_instruction"]):
            assert "new agent key" not in guidance.lower()
            assert "new key" not in guidance.lower()
            assert "replace" not in guidance.lower()
    elif status == 401:
        assert "rejected" in message and "new agent key" in message
    else:
        assert "temporarily unavailable" in message and "try again later" in message


def test_exchange_401_guidance_is_unchanged():
    assert agent_key_session._failure_guidance(401) == {
        "status": "rejected",
        "reason": "agent_key_rejected",
        "retryable": False,
        "next_action": "tell_user",
        "message": (
            "The server rejected the agent key (HTTP 401): it is invalid, revoked, "
            "expired or not allowed for this project. Ask the key owner for a new agent key "
            "and configure the agent with it."
        ),
        "agent_instruction": (
            "Do not retry with the same key. Tell the user the agent key was rejected "
            "and that a new agent key must be configured."
        ),
    }


@pytest.mark.parametrize("nested", [True, False], ids=["nested-code", "top-level-code"])
def test_exchange_deleted_project_guides_user_to_restore_it(plugin, api, monkeypatch, nested):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_status = 409
    server_message = "Untrusted exchange response text"
    detail = {"code": "agent_key_project_deleted", "message": server_message}
    monkeypatch.setattr(api, "error_body", lambda _: {"detail": detail} if nested else detail)

    result = request_result(plugin)

    assert len(api.exchanges) == 1
    assert api.business == []
    assert result["status_code"] == 409
    assert result["reason"] == "agent_key_project_deleted"
    assert result["status"] == "rejected"
    assert result["retryable"] is False
    assert result["next_action"] == "tell_user"
    assert server_message not in json.dumps(result)
    for guidance_field in ("message", "agent_instruction"):
        guidance = result[guidance_field].lower()
        for phrase in ("agent key", "valid", "project", "deleted", "restor", "owner", "web app"):
            assert phrase in guidance
        assert "new agent key" not in guidance
        assert "new key" not in guidance


@pytest.mark.parametrize(
    "body", [{"detail": {"code": "another_conflict"}}, {"detail": "conflict"}]
)
def test_exchange_conflict_without_deleted_project_code_is_unavailable(
    plugin, api, monkeypatch, body
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_status = 409
    monkeypatch.setattr(api, "error_body", lambda _: body)

    result = request_result(plugin)

    assert result["status_code"] == 409
    assert result["reason"] == "agent_key_service_unavailable"
    assert result["status"] == "unavailable"
    assert result["retryable"] is True
    assert result["next_action"] == "retry"
    assert api.business == []


def test_exchange_network_failure_is_unavailable(plugin, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:9")
    result = request_result(plugin)
    assert result.get("code") == "agent_key_exchange_failed"
    assert result.get("status") == "unavailable"
    assert result.get("retryable") is True


CONFIG_PATH = "/api/v1/config"
CANVAS_LIST_PATH = "/api/v1/projects/project-a/freezone/canvases:agent-view"
SERVER_EXECUTOR = {"ok": True, "data": {"agent_canvas_executor": "server"}}
BROWSER_EXECUTOR = {"ok": True, "data": {"agent_canvas_executor": "browser"}}
CANVAS_LIST = {"ok": True, "data": {
    "canvases": [], "quota": {"status": "available", "used": 0, "limit": 25},
}}
CANVAS_MANAGEMENT_TOOLS = [
    ("freezone_list_canvases", {"project_id": "project-a"}),
    ("freezone_create_canvas", {"project_id": "project-a", "name": "Plan"}),
]


@pytest.fixture
def canvas_tools(monkeypatch, api):
    """The stdio launcher's tools mode: the Freezone canvas tools over MCP."""
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    monkeypatch.delitem(sys.modules, "tools.registry", raising=False)
    monkeypatch.delitem(sys.modules, "tools", raising=False)
    dramaclaw_mcp._install_hermes_registry_shim()
    return api


@pytest.mark.asyncio
@pytest.mark.parametrize("tool,arguments", CANVAS_MANAGEMENT_TOOLS, ids=["list", "create"])
@pytest.mark.parametrize("status,kind", [
    (401, "rejected"), (403, "rejected"), (503, "unavailable"),
])
async def test_canvas_tools_report_key_session_failure_not_missing_executor(
    canvas_tools, monkeypatch, tool, arguments, status, kind,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    canvas_tools.exchange_status = status
    result = await dramaclaw_mcp.call_tool(tool, arguments)
    content = result.structuredContent
    assert content.get("code") != "canvas_server_executor_required", content
    assert content.get("code") == "agent_key_exchange_failed"
    assert content.get("status") == kind
    assert content.get("retryable") is (kind == "unavailable")
    assert content.get("next_action") == ("tell_user" if kind == "rejected" else "retry")
    assert content.get("message") and content.get("agent_instruction")
    assert result.isError is True
    assert canvas_tools.business == []


@pytest.mark.asyncio
async def test_canvas_executor_is_not_remembered_from_a_refused_key(canvas_tools, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    canvas_tools.business_bodies = {CONFIG_PATH: SERVER_EXECUTOR, CANVAS_LIST_PATH: CANVAS_LIST}
    canvas_tools.exchange_status = 401
    refused = await dramaclaw_mcp.call_tool(*CANVAS_MANAGEMENT_TOOLS[0])
    assert refused.structuredContent.get("status") == "rejected"
    # Once the key is accepted again, the server executor is used without a restart.
    canvas_tools.exchange_status = 200
    listed = await dramaclaw_mcp.call_tool(*CANVAS_MANAGEMENT_TOOLS[0])
    assert listed.structuredContent.get("status") == "listed", listed.structuredContent


@pytest.mark.asyncio
@pytest.mark.parametrize("credential", ["agent_key", "local_trust"])
@pytest.mark.parametrize("executor,expected", [
    (SERVER_EXECUTOR, "listed"), (BROWSER_EXECUTOR, "canvas_server_executor_required"),
])
async def test_canvas_executor_selection_unchanged_for_working_credentials(
    canvas_tools, monkeypatch, credential, executor, expected,
):
    if credential == "agent_key":
        monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    else:
        monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
        canvas_tools.allow_anonymous = True
    canvas_tools.business_bodies = {CONFIG_PATH: executor, CANVAS_LIST_PATH: CANVAS_LIST}
    result = await dramaclaw_mcp.call_tool(*CANVAS_MANAGEMENT_TOOLS[0])
    content = result.structuredContent
    assert expected in {content.get("status"), content.get("code")}, content
    assert len(canvas_tools.exchanges) == (1 if credential == "agent_key" else 0)


@pytest.mark.asyncio
async def test_canvas_request_keeps_key_refusal_after_executor_was_chosen(canvas_tools, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    # Sessions this short are exchanged again on every call.
    canvas_tools.expires_in = 30
    canvas_tools.business_bodies = {CONFIG_PATH: SERVER_EXECUTOR, CANVAS_LIST_PATH: CANVAS_LIST}
    listed = await dramaclaw_mcp.call_tool(*CANVAS_MANAGEMENT_TOOLS[0])
    assert listed.structuredContent.get("status") == "listed", listed.structuredContent
    canvas_tools.exchange_status = 403
    refused = await dramaclaw_mcp.call_tool(*CANVAS_MANAGEMENT_TOOLS[0])
    content = refused.structuredContent
    assert content.get("code") == "agent_key_exchange_failed", content
    assert content.get("status") == "rejected"
    assert "cannot be used on this project" in content.get("message", "")


def assert_session_failure(content: dict[str, Any], kind: str, status: int) -> None:
    """The agent key session's own refusal, with its guidance, reached the agent."""
    assert content.get("code") == "agent_key_exchange_failed", content
    assert content.get("status") == kind, content
    assert content.get("retryable") is (kind == "unavailable"), content
    assert content.get("next_action") == ("tell_user" if kind == "rejected" else "retry"), content
    assert content.get("message") and content.get("agent_instruction"), content
    assert ("new agent key" in content["message"]) is (status == 401), content


KEY_FAILURES = pytest.mark.parametrize("status,kind", [
    (401, "rejected"), (403, "rejected"), (503, "unavailable"),
])
BOUND_CANVAS_WRITES = [
    ("freezone_delete_nodes", {
        "project_id": "project-a", "canvas_id": "canvas-a", "node_ids": ["node-a"],
    }),
    ("freezone_move_nodes", {
        "project_id": "project-a", "canvas_id": "canvas-a",
        "positions": {"node-a": {"x": 10, "y": 20}},
    }),
]


@pytest.mark.asyncio
@KEY_FAILURES
@pytest.mark.parametrize("tool,arguments", BOUND_CANVAS_WRITES, ids=["delete", "move"])
async def test_bound_canvas_write_reports_key_session_failure(
    canvas_tools, monkeypatch, tool, arguments, status, kind,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    canvas_tools.exchange_status = status
    result = await dramaclaw_mcp.call_tool(tool, arguments)
    assert result.structuredContent.get("code") != "canvas_revision_check_unavailable"
    assert_session_failure(result.structuredContent, kind, status)
    assert result.isError is True
    assert canvas_tools.business == []


@pytest.mark.asyncio
async def test_bound_canvas_write_keeps_revision_check_failure_for_server_errors(
    canvas_tools, monkeypatch,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    canvas_tools.business_statuses = [503]
    result = await dramaclaw_mcp.call_tool(*BOUND_CANVAS_WRITES[0])
    content = result.structuredContent
    assert content.get("code") == "canvas_revision_check_unavailable", content
    assert content.get("retryable") is True


@pytest.mark.asyncio
@KEY_FAILURES
async def test_canvas_context_reports_key_session_failure_with_executor_remembered(
    canvas_tools, monkeypatch, status, kind,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    # Sessions this short are exchanged again on every call.
    canvas_tools.expires_in = 30
    canvas_tools.business_bodies = {
        CONFIG_PATH: SERVER_EXECUTOR,
        "/api/v1/projects/project-a/freezone/canvases/canvas-a/agent-context": {
            "ok": True, "data": {
                "canvas_context_status": "resolved",
                "responses": [{"type": "selection_detail", "data": {"nodes": []}}],
            },
        },
    }
    arguments = {"project_id": "project-a", "canvas_id": "canvas-a"}
    selected = await dramaclaw_mcp.call_tool("freezone_get_selection", arguments)
    assert selected.structuredContent.get("ok") is not False, selected.structuredContent
    canvas_tools.exchange_status = status
    result = await dramaclaw_mcp.call_tool("freezone_get_selection", arguments)
    assert_session_failure(result.structuredContent, kind, status)


@pytest.fixture
def mainline_tools(monkeypatch, api):
    """The stdio launcher's default mode: the DramaClaw production tools over MCP."""
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DRAMACLAW_API_URL", api.url)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    monkeypatch.delitem(sys.modules, "tools.registry", raising=False)
    monkeypatch.delitem(sys.modules, "tools", raising=False)
    dramaclaw_mcp._install_hermes_registry_shim()
    return api


@pytest.mark.asyncio
@KEY_FAILURES
async def test_production_tool_reports_key_session_failure(
    mainline_tools, monkeypatch, status, kind,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    mainline_tools.exchange_status = status
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_generate_sketches", {"project_id": "project-a", "episode": 1},
    )
    assert_session_failure(result.structuredContent, kind, status)
    assert mainline_tools.business == []


@pytest.mark.asyncio
@KEY_FAILURES
async def test_workflow_catalog_reports_key_session_failure(
    mainline_tools, monkeypatch, status, kind,
):
    from novelvideo.chat import workflow_mcp

    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    mainline_tools.exchange_status = status
    result = await workflow_mcp.call_tool(
        "workflow_catalog_search", {"kind": "skills", "query": "storyboard"},
    )
    assert result.structuredContent.get("status") != "catalog_read_failed"
    assert_session_failure(result.structuredContent, kind, status)
    assert result.isError is True


@pytest.mark.asyncio
async def test_workflow_catalog_keeps_read_failure_for_server_errors(mainline_tools, monkeypatch):
    from novelvideo.chat import workflow_mcp

    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    mainline_tools.business_statuses = [503]
    result = await workflow_mcp.call_tool(
        "workflow_catalog_search", {"kind": "skills", "query": "storyboard"},
    )
    assert result.structuredContent == {
        "ok": False, "status": "catalog_read_failed",
        "error": "Workflow catalog is unavailable for this agent key",
    }


PLUGIN_FAILED_STAGE_TOOLS = {
    # A failed preparation request becomes the tool's own failed stage or check.
    "dramaclaw": ("dramaclaw_generate_sketches", {"project_id": "project-a", "episode": 1}),
    "freezone": BOUND_CANVAS_WRITES[0],
}


@KEY_FAILURES
def test_plugin_tool_result_carries_key_session_failure(plugin, api, monkeypatch, status, kind):
    """What a host that reads the plugin's own result, not the MCP view, gets."""
    monkeypatch.setenv("DRAMACLAW_AGENT_KEY", KEY)
    api.exchange_status = status
    name, arguments = PLUGIN_FAILED_STAGE_TOOLS[plugin.TOOLSET]
    handler = next(handler for tool, _, handler in plugin.TOOLS if tool == name)
    assert_session_failure(json.loads(handler(dict(arguments))), kind, status)
    assert api.business == []
