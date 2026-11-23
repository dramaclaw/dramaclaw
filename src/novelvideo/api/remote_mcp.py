"""Remote MCP entry served by the API process.

Stateless Streamable HTTP with JSON responses: every request carries its own agent key,
is checked before any tool code runs, and sees only its own key, project and canvas
through ``request_context``. Nothing is kept between requests, so any API process can
answer any request. Off unless ``DRAMACLAW_REMOTE_MCP_ENABLED`` is set.

Paths are ``/mcp/{tools|workflows}[/projects/{project_id}[/canvases/{canvas_id}]]``;
a path without a project binds the key's only visible project when it has exactly one.

Keys are checked in process through the auth session port's optional agent key methods,
on every request, so a revoked key is refused from its next request on. The session a
key is exchanged for is cached per key and scope and handed to the tools, which call the
API with it; it is exchanged again only once it is missing or close to expiry. A request
without a bearer key, or with a key the port rejects, gets 401; a key that may not be
used on the requested project gets 403; an installation without an agent key service,
or a check that cannot complete, gets 503.

Requests that passed the key check are counted while they run, in total and per key.
The count belongs to this process: with several API processes each one allows its own
limit, and nothing is shared between them.
"""

from __future__ import annotations

import asyncio
from collections import Counter
import hashlib
import json
import logging
import os
import re
from typing import Any
from urllib.request import ProxyHandler, build_opener

import anyio
from starlette.responses import JSONResponse
from starlette.routing import get_route_path
from starlette.types import Receive, Scope, Send
from starlette.websockets import WebSocketClose

from novelvideo.chat import agent_key_session, request_context
from novelvideo.chat import service as chat_service
from novelvideo.chat.hermes_pool import canvas_bridge_dir_for_profile
from novelvideo.chat.hermes_workspace import ensure_user_hermes_workspace
from novelvideo.ports import get_auth_session_port
from novelvideo.ports.auth_contract import AuthError, AuthFailureReason
from novelvideo.ports.registry import PortNotRegistered
from novelvideo.project_context import require_project_home_node, resolve_project_context

logger = logging.getLogger("novelvideo.api.remote_mcp")

ENABLE_FLAG = "DRAMACLAW_REMOTE_MCP_ENABLED"
MAX_CONCURRENT = "DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT"
MAX_CONCURRENT_PER_KEY = "DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT_PER_KEY"
_RETRY_AFTER_SECONDS = 1
MOUNT_PATH = "/mcp"
_ID = r"[A-Za-z0-9._-]{1,128}"
_ID_PATTERN = re.compile(_ID)
_PATH_PATTERN = re.compile(
    rf"/(?P<mode>tools|workflows)"
    rf"(?:/projects/(?P<project>{_ID})(?:/canvases/(?P<canvas>{_ID}))?)?/?"
)
_CHECK_TIMEOUT_SECONDS = 10.0

# Names a request must never inherit from the process: credentials, the switches that
# let a local caller act without one, the scope they act in, the user they act as, the
# host kind that selects tools, and the directory canvas events are written to, which
# belongs to one project. The request's own key, scope and host kind are set afresh in
# their place.
IDENTITY_PREFIXES = ("DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_TOKEN")
IDENTITY_NAMES = frozenset({
    "DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID", "DRAMACLAW_TURN_ID",
    "DRAMACLAW_EXTERNAL_MCP", "DRAMACLAW_CHAT_SURFACE", "SUPERTALE_CHAT_SURFACE",
    "DRAMACLAW_TOOL_MODE", "DRAMACLAW_TOOL_MODE_FILE", "DRAMACLAW_AGENT_PROFILE",
    "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", "DRAMACLAW_LOCAL_AGENT_TRUST",
    "DRAMACLAW_CE_OWNER", "DRAMACLAW_CE_OWNER_ALLOW_REMOTE",
    "DRAMACLAW_USERNAME", "DRAMACLAW_USER", "ST_LOCAL_USERNAME",
    "FREEZONE_USER", "SUPERTALE_USER", "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR",
})
# What the stdio launcher sets for a key connection to the tools server.
_TOOLS_HOST = {
    "DRAMACLAW_EXTERNAL_MCP": "1",
    "DRAMACLAW_CHAT_SURFACE": "freezone",
    "DRAMACLAW_TOOL_MODE": "freezone_canvas",
    "DRAMACLAW_AGENT_PROFILE": "freezone:main",
}
_NO_KEY_SERVICE = (
    "This installation has no Agent Key service, so the remote MCP entry cannot accept "
    "agent keys. This is a property of the server, not a problem with the key or the "
    "request."
)

_open_direct = build_opener(ProxyHandler({})).open


def enabled() -> bool:
    return os.environ.get(ENABLE_FLAG, "").strip().lower() in {"1", "true", "yes", "on"}


def _concurrency_limit(name: str, default: int) -> int:
    """A whole number of at least 1; anything else leaves the default in place."""
    value = os.environ.get(name, "").strip()
    return int(value) if value.isascii() and value.isdigit() and int(value) >= 1 else default


def concurrency_limits() -> tuple[int, int]:
    """How many requests this process runs at once: in total, and for one key.

    Tools run on the event loop's default thread pool, which the API's own routes use
    too, and a tool waits there for its callback into the API. The defaults therefore
    stay at half of that pool, and one key at half of the total, so that neither remote
    requests as a whole nor a single key can hold every thread the callbacks need.
    """
    threads = min(32, (os.cpu_count() or 1) + 4)  # asyncio's default pool size
    total = _concurrency_limit(MAX_CONCURRENT, max(1, threads // 2))
    return total, _concurrency_limit(MAX_CONCURRENT_PER_KEY, max(1, total // 2))


def mount(application: Any) -> bool:
    """Serve the entry under ``/mcp`` when the flag is set; otherwise add nothing."""
    if not enabled():
        return False
    entry = RemoteMcpApp()
    application.mount(MOUNT_PATH, entry, name="remote-mcp")
    logger.info(
        "Remote MCP entry enabled at %s/{tools|workflows}; this process runs at most "
        "%d requests at once, %d per key",
        MOUNT_PATH, entry.max_concurrent, entry.max_concurrent_per_key,
    )
    return True


def _request_values(
    mode: str, key: str, api_base: str, project_id: str | None, canvas_id: str | None,
    bridge_dir: str | None = None,
) -> dict[str, str]:
    values = {
        name: value for name, value in os.environ.items()
        if not name.startswith(IDENTITY_PREFIXES) and name not in IDENTITY_NAMES
    }
    values["DRAMACLAW_AGENT_KEY"] = key
    # Tools call back to the address the key was checked at.
    values["DRAMACLAW_API_URL"] = api_base
    if project_id:
        values["DRAMACLAW_PROJECT_ID"] = project_id
    if canvas_id:
        values["DRAMACLAW_CANVAS_ID"] = canvas_id
    if mode == "tools":
        values.update(_TOOLS_HOST)
    if bridge_dir:
        values["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"] = bridge_dir
    return values


def _session_request(api_base: str, api_path: str, opener: Any) -> dict[str, Any]:
    def decode(status: int, body: str) -> dict[str, Any]:
        parsed = json.loads(body) if body else {"ok": True}
        return parsed if isinstance(parsed, dict) else {"ok": False}

    return agent_key_session.protect(lambda: agent_key_session.request(
        api_base=api_base, api_path=api_path, method="GET", query_string="",
        payload=None, headers={"Accept": "application/json"},
        timeout=_CHECK_TIMEOUT_SECONDS, opener=opener, decode_success=decode,
        shape_http_error=lambda status, text, reason: {"ok": False, "status_code": status},
    ))


def _key_service() -> Any | None:
    """The auth session port when it implements agent keys, otherwise ``None``."""
    try:
        port = get_auth_session_port()
    except PortNotRegistered:
        return None
    if not all(
        callable(getattr(port, name, None))
        for name in ("check_agent_key", "exchange_agent_key")
    ):
        return None
    return port


async def _open_session(port: Any, api_base: str, key: str, project_id: str | None) -> None:
    """Make sure the tools find a live session of ``key`` for the scope in the cache."""
    if agent_key_session.live_session(api_base, key, project_id) is not None:
        return
    token = await asyncio.wait_for(
        port.exchange_agent_key(
            key, current_scope_kind="project" if project_id else "home",
            current_project_id=project_id,
        ),
        _CHECK_TIMEOUT_SECONDS,
    )
    agent_key_session.remember_session(api_base, key, project_id, token.value, token.exp)


def _key_refusal(exc: Exception) -> JSONResponse:
    """Turn a failed key check or exchange into 401, 403 or 503."""
    if isinstance(exc, AuthError):
        if exc.reason is AuthFailureReason.FORBIDDEN:
            return JSONResponse({
                "error": "Agent key is not allowed on this project",
                "code": "agent_key_project_forbidden",
            }, status_code=403)
        return JSONResponse(
            {"error": "Agent key rejected", "code": "agent_key_rejected"}, status_code=401,
        )
    # The message may quote the key, so only the type is logged.
    logger.warning("Remote MCP key check could not complete error=%s", type(exc).__name__)
    return JSONResponse(
        {"error": "Agent key check unavailable", "code": "agent_key_check_unavailable"},
        status_code=503,
    )


def _single_visible_project(api_base: str) -> tuple[str | None, str | None]:
    """Bind an unscoped path to the key's project when it sees exactly one."""
    result = _session_request(api_base, "/api/v1/projects", _open_direct)
    projects = result.get("data")
    if result.get("ok") is not True or not isinstance(projects, list):
        return None, "project listing unavailable"
    if not projects:
        return None, "no visible project"
    if len(projects) > 1:
        return None, "several visible projects"
    project = projects[0]
    if (not isinstance(project, dict) or not isinstance(project.get("id"), str)
            or _ID_PATTERN.fullmatch(project["id"]) is None):
        return None, "project listing unavailable"
    return project["id"], None


def _caller_username(api_base: str) -> str | None:
    """The user the request's session acts as, as the API reports it."""
    result = _session_request(api_base, "/api/v1/auth/me", _open_direct)
    data = result.get("data")
    if result.get("ok") is not True or not isinstance(data, dict):
        return None
    username = data.get("username")
    return username.strip() or None if isinstance(username, str) else None


async def _project_bridge_dir(api_base: str, project_id: str) -> tuple[str | None, str | None]:
    """The directory every chat session of the project watches for canvas events.

    It lives under the project's state directory, which only the project's home node
    holds. A request names no canvas agent, so it gets the project's shared directory
    rather than the one of a single agent.
    """
    username = await asyncio.to_thread(_caller_username, api_base)
    if username is None:
        return None, "caller unavailable"
    # Exception messages may quote request data, so only their type is reported.
    try:
        context = await resolve_project_context(
            user={"username": username}, project_id=project_id, required_role="viewer",
        )
    except Exception as exc:
        return None, f"project unavailable ({type(exc).__name__})"
    try:
        require_project_home_node(context)
    except Exception:
        return None, "project is kept on another node"
    try:
        home = await asyncio.to_thread(
            ensure_user_hermes_workspace, username, profile="freezone",
            project_state_dir=context.state_dir,
        )
    except Exception as exc:
        return None, f"project workspace unavailable ({type(exc).__name__})"
    return str(canvas_bridge_dir_for_profile(home, "freezone")), None


class _RequestServer:
    """One MCP server whose initialization is computed for the current request."""

    def __init__(self, server: Any, instructions: Any = None) -> None:
        self._server = server
        self._instructions = instructions

    def create_initialization_options(self) -> Any:
        options = self._server.create_initialization_options()
        if self._instructions is None:
            return options
        return options.model_copy(update={"instructions": self._instructions()})

    async def run(self, *args: Any, **kwargs: Any) -> None:
        await self._server.run(*args, **kwargs)


def _server(mode: str) -> _RequestServer:
    if mode == "workflows":
        from novelvideo.chat import workflow_mcp

        return _RequestServer(workflow_mcp.SERVER)
    from novelvideo.chat import dramaclaw_mcp

    return _RequestServer(dramaclaw_mcp.SERVER, dramaclaw_mcp.server_instructions)


async def _serve(server: _RequestServer, mode: str, scope: Scope, receive: Receive, send: Send) -> None:
    """Run one MCP exchange on a transport that lives only for this request."""
    from mcp.server.streamable_http import StreamableHTTPServerTransport

    transport = StreamableHTTPServerTransport(mcp_session_id=None, is_json_response_enabled=True)

    async def run_server(*, task_status: Any = anyio.TASK_STATUS_IGNORED) -> None:
        async with transport.connect() as (read_stream, write_stream):
            task_status.started()
            try:
                await server.run(
                    read_stream, write_stream, server.create_initialization_options(),
                    stateless=True,
                )
            except Exception as exc:
                # The message may quote request data, so only the type is logged.
                logger.error(
                    "Remote MCP request failed mode=%s error=%s", mode, type(exc).__name__,
                )

    async with anyio.create_task_group() as task_group:
        await task_group.start(run_server)
        try:
            await transport.handle_request(scope, receive, send)
        finally:
            await transport.terminate()
            task_group.cancel_scope.cancel()


class RemoteMcpApp:
    """ASGI application mounted at ``/mcp``."""

    def __init__(self) -> None:
        self.max_concurrent, self.max_concurrent_per_key = concurrency_limits()
        # Running requests per key digest. Only the event loop reads or changes it.
        self._running: Counter[bytes] = Counter()

    def _busy(self, key_digest: bytes) -> JSONResponse | None:
        """The refusal for a request that would exceed a limit, without queueing it."""
        if self._running[key_digest] >= self.max_concurrent_per_key:
            code = "remote_mcp_key_concurrency_limit"
            error = (
                f"This agent key already has {self.max_concurrent_per_key} remote MCP "
                "requests running in this API process, which is its limit. The request "
                "itself is fine: retry it unchanged once one of them has finished. The "
                f"server operator can raise {MAX_CONCURRENT_PER_KEY}."
            )
        elif self._running.total() >= self.max_concurrent:
            code = "remote_mcp_concurrency_limit"
            error = (
                f"This API process is already running {self.max_concurrent} remote MCP "
                "requests, which is its limit. The request itself is fine: retry it "
                f"unchanged shortly. The server operator can raise {MAX_CONCURRENT}."
            )
        else:
            return None
        return JSONResponse(
            {"error": error, "code": code}, status_code=429,
            headers={"Retry-After": str(_RETRY_AFTER_SECONDS)},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await WebSocketClose(code=1008)(scope, receive, send)
            return
        response = await self._handle(scope, receive, send)
        if response is not None:
            await response(scope, receive, send)

    async def _handle(self, scope: Scope, receive: Receive, send: Send) -> JSONResponse | None:
        matched = _PATH_PATTERN.fullmatch(get_route_path(scope))
        if matched is None:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if scope["method"] != "POST":
            # Stateless JSON responses: there is no stream to open and no session to end.
            return JSONResponse(
                {"error": "Only POST is served on this MCP path"}, status_code=405,
                headers={"Allow": "POST"},
            )
        mode, project_id, canvas_id = matched.group("mode", "project", "canvas")
        headers = {name: value for name, value in scope["headers"]}
        scheme, _, key = headers.get(b"authorization", b"").decode("latin-1").partition(" ")
        key = key.strip()
        if scheme.lower() != "bearer" or not key:
            return JSONResponse(
                {"error": "Bearer key required", "code": "agent_key_required"}, status_code=401,
            )
        # Resolved like the chat backend does for its own agents, so it is never empty.
        api_base = chat_service._load_api_url()
        key_digest = hashlib.sha256(key.encode("utf-8")).digest()
        bridge_dir = None
        # A full process answers before the key check.
        busy = self._busy(key_digest)
        if busy is not None:
            return busy
        port = _key_service()
        if port is None:
            return JSONResponse({
                "error": "Agent key check unavailable", "code": "agent_key_unsupported",
                "detail": _NO_KEY_SERVICE,
            }, status_code=503)
        # Tools carry the session to this address, so it is refused before any exchange.
        insecure = agent_key_session.transport_refusal(api_base)
        if insecure is not None:
            return JSONResponse({
                "error": "Agent key check unavailable", "code": insecure["code"],
                "detail": insecure["error"],
            }, status_code=503)
        try:
            # Every request, even with a cached session, so a revocation applies at once.
            await asyncio.wait_for(port.check_agent_key(key), _CHECK_TIMEOUT_SECONDS)
            await _open_session(port, api_base, key, project_id)
        except Exception as exc:
            return _key_refusal(exc)
        with request_context.scope(_request_values(mode, key, api_base, project_id, canvas_id)):
            if project_id is None:
                project_id, reason = await asyncio.to_thread(_single_visible_project, api_base)
                if reason is not None:
                    logger.debug("Unscoped path kept home scope mode=%s: %s", mode, reason)
                elif project_id:
                    try:
                        await _open_session(port, api_base, key, project_id)
                    except Exception as exc:
                        return _key_refusal(exc)
            if mode == "tools" and project_id:
                bridge_dir, reason = await _project_bridge_dir(api_base, project_id)
                if reason is not None:
                    # Canvas events then go where no browser of the project looks.
                    logger.warning(
                        "Project request kept the default event directory: %s", reason,
                    )
        # Counted only from here, so a key that was not accepted never holds a place and
        # a counted request never waits on the check of another one.
        busy = self._busy(key_digest)
        if busy is not None:
            return busy
        self._running[key_digest] += 1
        try:
            with request_context.scope(
                _request_values(mode, key, api_base, project_id, canvas_id, bridge_dir)
            ):
                await _serve(_server(mode), mode, scope, receive, send)
        finally:
            self._running[key_digest] -= 1
            if not self._running[key_digest]:
                del self._running[key_digest]
        return None
