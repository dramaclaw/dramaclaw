"""Remote MCP for local verification only, not a production multi-user service.

Each session owns one child process, bridging Streamable HTTP to stdio.
"""

import argparse
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import logging
import os
from pathlib import Path
import re
import sys
import time
from uuid import uuid4
from urllib.parse import urlsplit

import anyio
import httpx
from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.streamable_http import StreamableHTTPServerTransport
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn


logger = logging.getLogger("remote_mcp_relay")


async def check_key(api_url, key, project_id):
    scope = {"kind": "home"} if project_id is None else {"kind": "project", "id": project_id}
    try:
        async with httpx.AsyncClient(
            trust_env=False, timeout=10, follow_redirects=False,
        ) as client:
            response = await client.post(
                api_url.rstrip("/") + "/api/v1/agent/sessions",
                json={"scope": scope, "ttl_seconds": 60},
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json", "Accept": "application/json",
                },
            )
        if response.status_code in (401, 403):
            return 401
        if response.is_success:
            body = response.json()
            if (isinstance(body, dict) and body.get("ok") is True
                    and isinstance(body.get("data"), dict)
                    and isinstance(body["data"].get("token"), str) and body["data"]["token"]):
                return 200
    except (httpx.HTTPError, ValueError):
        pass
    return 503


@dataclass
class Session:
    mode: str
    project_id: str | None
    canvas_id: str | None
    key_hash: bytes
    transport: StreamableHTTPServerTransport
    stop: anyio.Event = field(default_factory=anyio.Event)
    child_outcome: anyio.Event = field(default_factory=anyio.Event)
    child_received: bool = False
    posts: int = 0
    last_post_end: float = field(default_factory=time.monotonic)


class Relay:
    def __init__(self, args):
        self.args = args
        self.sessions: dict[str, Session] = {}
        self.tasks = None

    def child_parameters(self, mode, key, project_id, canvas_id):
        env = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_TOKEN"))
            and name not in ("DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID")
        }
        if project_id is not None:
            env["DRAMACLAW_PROJECT_ID"] = project_id
        if canvas_id is not None:
            env["DRAMACLAW_CANVAS_ID"] = canvas_id
        for option in ("ce_dir", "api_url", "username"):
            value = getattr(self.args, option)
            if value is not None:
                env[f"DRAMACLAW_{option.upper()}"] = str(value)
        env["DRAMACLAW_AGENT_KEY"] = key
        args = [str(self.args.launch_script), mode]
        if self.args.ce_dir is not None:
            args += ["--ce-dir", str(self.args.ce_dir)]
        return StdioServerParameters(command=self.args.child_python, args=args, env=env)

    async def run_session(self, sid, session, params, *, task_status=anyio.TASK_STATUS_IGNORED):
        started = False

        async def forward(reader, writer, from_child=False):
            try:
                async for message in reader:
                    if isinstance(message, Exception):
                        logger.warning(
                            "Session %s (%s) skipped an unreadable message from %s",
                            sid[:8], session.mode, "child" if from_child else "client",
                        )
                        continue
                    if from_child:
                        session.child_received = True
                        session.child_outcome.set()
                    await writer.send(message)
            finally:
                if from_child and not session.child_received:
                    logger.warning(
                        "Session %s (%s) child exited before initialize", sid[:8], session.mode,
                    )
                    session.child_outcome.set()
                # EOF from either side also ends outstanding HTTP requests.
                session.stop.set()

        try:
            # Child stderr is untrusted and can contain credentials or environment dumps.
            with open(os.devnull, "w") as errlog:
                async with stdio_client(params, errlog=errlog) as (child_read, child_write):
                    del params
                    async with session.transport.connect() as (http_read, http_write):
                        try:
                            async with anyio.create_task_group() as bridge:
                                bridge.start_soon(forward, http_read, child_write)
                                bridge.start_soon(forward, child_read, http_write, True)
                                started = True
                                task_status.started(True)
                                await session.stop.wait()
                                bridge.cancel_scope.cancel()
                        finally:
                            self.sessions.pop(sid, None)
                            await session.transport.terminate()
                # stdio_client closes stdin, escalates terminate to kill, and waits.
        except Exception:
            # Do not stringify exceptions: subprocess/validation errors may contain secrets.
            logger.warning("Session %s (%s) ended with an error", sid[:8], session.mode)
        finally:
            self.sessions.pop(sid, None)
            await session.transport.terminate()
            if not started:
                task_status.started(False)

    async def reaper(self):
        while True:
            await anyio.sleep(min(1.0, self.args.idle_timeout / 4))
            now = time.monotonic()
            for session in list(self.sessions.values()):
                if session.posts == 0 and now - session.last_post_end > self.args.idle_timeout:
                    session.stop.set()

    @asynccontextmanager
    async def lifespan(self, app):
        async with anyio.create_task_group() as tasks:
            self.tasks = tasks
            async def reap():
                with anyio.CancelScope() as scope:
                    reaper_scope.append(scope)
                    await self.reaper()

            reaper_scope = []
            tasks.start_soon(reap)
            try:
                yield
            finally:
                for session in list(self.sessions.values()):
                    session.stop.set()
                for scope in reaper_scope:
                    scope.cancel()
                # Let session owners leave stdio_client normally so cleanup is not cancelled.

    async def __call__(self, scope, receive, send):
        request = Request(scope, receive)
        mode = request.path_params["mode"]
        project_id = request.path_params.get("project_id")
        canvas_id = request.path_params.get("canvas_id")
        if mode not in ("tools", "workflows") or any(
            value is not None and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value) is None
            for value in (project_id, canvas_id)
        ):
            await JSONResponse({"error": "Not found"}, 404)(scope, receive, send)
            return
        authorization = request.headers.get("authorization", "").split(None, 1)
        if (len(authorization) != 2 or authorization[0].lower() != "bearer"
                or not authorization[1].strip()):
            await JSONResponse({"error": "Bearer key required"}, 401)(scope, receive, send)
            return
        key = authorization[1].strip()
        key_hash = hashlib.sha256(key.encode()).digest()
        sid = request.headers.get("mcp-session-id")
        new_session = sid is None and request.method == "POST"
        if new_session:
            status = await check_key(self.args.api_url, key, project_id)
            if status != 200:
                error = "Agent key rejected" if status == 401 else "Agent key check unavailable"
                await JSONResponse({"error": error}, status)(scope, receive, send)
                return
            sid = uuid4().hex
            session = Session(
                mode, project_id, canvas_id, key_hash, StreamableHTTPServerTransport(sid),
            )
            self.sessions[sid] = session
            # Count initialization before starting the child so the reaper cannot race it.
            session.posts += 1
            ready = await self.tasks.start(
                self.run_session, sid, session,
                self.child_parameters(mode, key, project_id, canvas_id),
            )
            if not ready:
                await JSONResponse({"error": "Child unavailable"}, 503)(scope, receive, send)
                return
        else:
            session = self.sessions.get(sid)
            if (session is None or session.stop.is_set() or session.mode != mode
                    or session.project_id != project_id or session.canvas_id != canvas_id
                    or not hmac.compare_digest(session.key_hash, key_hash)):
                await JSONResponse({"error": "Session not found"}, 404)(scope, receive, send)
                return
            if request.method == "POST":
                session.posts += 1
        del key, authorization
        try:
            if new_session:
                await self.handle_initial_request(session, scope, receive, send)
            else:
                await session.transport.handle_request(scope, receive, send)
        finally:
            if request.method == "POST":
                session.posts -= 1
                session.last_post_end = time.monotonic()
            if session.transport.is_terminated:
                session.stop.set()

    async def handle_initial_request(self, session, scope, receive, send):
        response_started = False

        async def guarded_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                if 200 <= message["status"] < 300:
                    # SSE sends headers before the child answers; retain the option of a 503.
                    await session.child_outcome.wait()
                if session.child_outcome.is_set() and not session.child_received:
                    await anyio.sleep_forever()
                response_started = True
            await send(message)

        async with anyio.create_task_group() as tasks:
            async def watch_child():
                await session.child_outcome.wait()
                if not session.child_received:
                    tasks.cancel_scope.cancel()

            tasks.start_soon(watch_child)
            await session.transport.handle_request(scope, receive, guarded_send)
            tasks.cancel_scope.cancel()
        if not response_started and not session.child_received:
            await JSONResponse({"error": "Child unavailable"}, 503)(scope, receive, send)


def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--idle-timeout", type=float, default=600)
    parser.add_argument("--ce-dir")
    parser.add_argument("--api-url", default="http://127.0.0.1:8780")
    parser.add_argument("--username")
    parser.add_argument("--launch-script", default=str(Path(__file__).with_name("launch_mcp.py")))
    parser.add_argument("--child-python", default=sys.executable)
    parser.add_argument("--log-level", default="info")
    return parser


def main():
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        api_url = urlsplit(args.api_url)
        valid_url = bool(api_url.hostname) and (
            api_url.scheme == "https" or (
                api_url.scheme == "http" and api_url.hostname in {"127.0.0.1", "::1", "localhost"}
            )
        )
    except ValueError:
        valid_url = False
    if not valid_url:
        parser.error("--api-url must use https or loopback http")
    if not 0 < args.idle_timeout < float("inf"):
        parser.error("--idle-timeout must be finite and positive")
    # The SDK's malformed-stdio diagnostic includes raw child output in a traceback.
    # Unlike disabled, this filter survives uvicorn's logging configuration.
    logging.getLogger("mcp.client.stdio").addFilter(lambda record: False)
    relay = Relay(args)
    app = Starlette(routes=[
        Route("/mcp/{mode}", relay),
        Route("/mcp/{mode}/", relay),
        Route("/mcp/{mode}/projects/{project_id}", relay),
        Route("/mcp/{mode}/projects/{project_id}/", relay),
        Route("/mcp/{mode}/projects/{project_id}/canvases/{canvas_id}", relay),
        Route("/mcp/{mode}/projects/{project_id}/canvases/{canvas_id}/", relay),
    ], lifespan=relay.lifespan)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level,
                timeout_graceful_shutdown=1)


if __name__ == "__main__":
    main()
