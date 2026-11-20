"""Remote MCP entry served by the API process.

Stateless Streamable HTTP with JSON responses: every request carries its own agent key,
is checked before any tool code runs, and sees only its own key, project and canvas
through ``request_context``. Nothing is kept between requests, so any API process can
answer any request. Off unless ``DRAMACLAW_REMOTE_MCP_ENABLED`` is set.

Paths and refusals follow ``agent-kit/scripts/remote_mcp_relay.py``:
``/mcp/{tools|workflows}[/projects/{project_id}[/canvases/{canvas_id}]]``.
"""

from __future__ import annotations

import asyncio
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

logger = logging.getLogger("novelvideo.api.remote_mcp")

ENABLE_FLAG = "DRAMACLAW_REMOTE_MCP_ENABLED"
MOUNT_PATH = "/mcp"
_ID = r"[A-Za-z0-9._-]{1,128}"
_ID_PATTERN = re.compile(_ID)
_PATH_PATTERN = re.compile(
    rf"/(?P<mode>tools|workflows)"
    rf"(?:/projects/(?P<project>{_ID})(?:/canvases/(?P<canvas>{_ID}))?)?/?"
)
_CHECK_TIMEOUT_SECONDS = 10.0

# Names a request must never inherit from the process: credentials, the scope they act
# in, the user they act as, and the host kind that selects tools. The relay strips the
# same credentials, scope and host-kind names from its child processes.
IDENTITY_PREFIXES = ("DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_TOKEN")
IDENTITY_NAMES = frozenset({
    "DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID", "DRAMACLAW_TURN_ID",
    "DRAMACLAW_EXTERNAL_MCP", "DRAMACLAW_CHAT_SURFACE", "SUPERTALE_CHAT_SURFACE",
    "DRAMACLAW_TOOL_MODE", "DRAMACLAW_TOOL_MODE_FILE", "DRAMACLAW_AGENT_PROFILE",
    "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", "DRAMACLAW_LOCAL_AGENT_TRUST",
    "DRAMACLAW_USERNAME", "DRAMACLAW_USER", "ST_LOCAL_USERNAME",
    "FREEZONE_USER", "SUPERTALE_USER",
})
# What the stdio launcher sets for a key connection to the tools server.
_TOOLS_HOST = {
    "DRAMACLAW_EXTERNAL_MCP": "1",
    "DRAMACLAW_CHAT_SURFACE": "freezone",
    "DRAMACLAW_TOOL_MODE": "freezone_canvas",
    "DRAMACLAW_AGENT_PROFILE": "freezone:main",
}
# Exchange results whose fixed text tells the operator what to change.
_CONFIGURATION_CODES = frozenset({
    "agent_key_exchange_unsupported", "agent_key_exchange_redirected",
    "agent_key_insecure_transport",
})
_API_URL_MISSING = (
    "Remote MCP entry is not configured: DRAMACLAW_API_URL is not set for the API "
    "process. The server operator must set it to the address this API is reached at "
    "and restart the API."
)

_open_direct = build_opener(ProxyHandler({})).open


def enabled() -> bool:
    return os.environ.get(ENABLE_FLAG, "").strip().lower() in {"1", "true", "yes", "on"}


def mount(application: Any) -> bool:
    """Serve the entry under ``/mcp`` when the flag is set; otherwise add nothing."""
    if not enabled():
        return False
    application.mount(MOUNT_PATH, RemoteMcpApp(), name="remote-mcp")
    logger.info("Remote MCP entry enabled at %s/{tools|workflows}", MOUNT_PATH)
    return True


def _request_values(
    mode: str, key: str, project_id: str | None, canvas_id: str | None,
) -> dict[str, str]:
    values = {
        name: value for name, value in os.environ.items()
        if not name.startswith(IDENTITY_PREFIXES) and name not in IDENTITY_NAMES
    }
    values["DRAMACLAW_AGENT_KEY"] = key
    if project_id:
        values["DRAMACLAW_PROJECT_ID"] = project_id
    if canvas_id:
        values["DRAMACLAW_CANVAS_ID"] = canvas_id
    if mode == "tools":
        values.update(_TOOLS_HOST)
    return values


class _NoResponseBody:
    status = 204

    def __enter__(self) -> _NoResponseBody:
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def read(self) -> bytes:
        return b""


def _session_only(request: Any, timeout: float) -> _NoResponseBody:
    """Stand in for the follow-up request so that only the key exchange happens."""
    return _NoResponseBody()


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


def _check_key(api_base: str) -> dict[str, Any]:
    """Exchange the request's key for its scope, or reuse its live session."""
    return _session_request(api_base, "/api/v1/agent/sessions", _session_only)


def _single_visible_project(api_base: str) -> tuple[str | None, str | None]:
    """Like the relay, bind an unscoped path to the key's project when it has one."""
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


def _refusal(result: dict[str, Any]) -> JSONResponse:
    """Shape a failed exchange like the relay does, plus the exchange's own reason."""
    code = str(result.get("code") or "agent_key_exchange_failed")
    status = result.get("status_code")
    rejected = code == "agent_key_exchange_failed" and status in (401, 403)
    body: dict[str, Any] = {
        "error": "Agent key rejected" if rejected else "Agent key check unavailable",
        "code": code,
    }
    if isinstance(status, int):
        body["status_code"] = status
    if code in _CONFIGURATION_CODES:
        body["detail"] = str(result.get("error") or "")
    return JSONResponse(body, status_code=401 if rejected else 503)


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
            return JSONResponse({"error": "Bearer key required"}, status_code=401)
        api_base = os.environ.get("DRAMACLAW_API_URL", "").strip().rstrip("/")
        if not api_base:
            return JSONResponse(
                {"error": _API_URL_MISSING, "code": "remote_mcp_api_url_missing"},
                status_code=503,
            )
        with request_context.scope(_request_values(mode, key, project_id, canvas_id)):
            checked = await asyncio.to_thread(_check_key, api_base)
            if checked.get("ok") is not True:
                return _refusal(checked)
            if project_id is None:
                project_id, reason = await asyncio.to_thread(_single_visible_project, api_base)
                if reason is not None:
                    logger.debug("Unscoped path kept home scope mode=%s: %s", mode, reason)
        with request_context.scope(_request_values(mode, key, project_id, canvas_id)):
            await _serve(_server(mode), mode, scope, receive, send)
        return None
