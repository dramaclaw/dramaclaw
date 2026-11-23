"""Stand-ins for what the remote MCP entry relies on.

``FakeKeyPort`` is the auth session port's Agent Key part, which the entry checks every
key with in process. ``Exchange`` answers the API endpoints tools call back into: the
project listing (``GET /api/v1/projects``) and the per-key agent catalogs
(``GET /api/v1/freezone/agent-config/<kind>``). It also answers the HTTP key exchange,
but only for the stdio launcher, which still exchanges its key over HTTP; it records
every exchange so a test can check the entry never made one. ``direct_tools`` lists the
tools of the stdio launcher, which the entry must serve unchanged.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
from threading import Thread
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from novelvideo.ports.auth_contract import AgentSessionToken, AuthError, AuthFailureReason

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "agent-kit/scripts/launch_mcp.py"
KEY = "fake-entry-key-DO-NOT-USE-7f3a9c"
FAKE_TOKEN = "fake-exchange-token-DO-NOT-USE-91c2"


class FakeKeyPort:
    """Agent Key methods of the auth session port, for keys that can change mid-test.

    ``sessions`` maps each valid key to the session token its exchanges return.
    ``refusals`` maps a key to the reason its check fails with, as after a revocation;
    ``forbidden`` holds the ``(key, project_id)`` pairs a key may not use; ``failure``
    is raised by every call, as when the key service is down. ``gate``, when set, holds
    the check of an unknown key until it is set.
    """

    def __init__(self, sessions, *, lifetime=3600):
        self.sessions = dict(sessions)
        self.lifetime = lifetime
        self.refusals = {}
        self.forbidden = set()
        self.failure = None
        self.gate = None
        self.checks = 0
        self.exchanges = []

    def _verify(self, raw_key):
        if self.failure is not None:
            raise self.failure
        if raw_key in self.refusals:
            raise AuthError(self.refusals[raw_key], "refused")
        if raw_key not in self.sessions:
            raise AuthError(AuthFailureReason.INVALID, "unknown key")

    async def check_agent_key(self, raw_key):
        self.checks += 1
        if raw_key not in self.sessions and self.gate is not None:
            await asyncio.wait_for(self.gate.wait(), timeout=8)
        self._verify(raw_key)

    async def exchange_agent_key(
        self, raw_key, *, ttl_seconds=None, worker_id=None, current_scope_kind="home",
        current_project_id=None,
    ):
        scope = (
            {"kind": "project", "id": current_project_id}
            if current_scope_kind == "project" else {"kind": "home"}
        )
        self.exchanges.append(scope)
        self._verify(raw_key)
        if (raw_key, current_project_id) in self.forbidden:
            raise AuthError(AuthFailureReason.FORBIDDEN, "project not allowed")
        return AgentSessionToken(
            value=self.sessions[raw_key], session_id=f"session-{len(self.exchanges)}",
            user="alice", scopes=(), exp=int(time.time()) + self.lifetime, worker_id="",
        )


def register_key_port(monkeypatch, port):
    """Make ``port`` the process's auth session port for the rest of the test."""
    from novelvideo.ports import registry

    monkeypatch.setitem(registry._PORTS, "auth_session", port)
    return port


def clean_env():
    # Keep host credentials and agent profile settings out of test subprocesses.
    return {
        k: v for k, v in os.environ.items()
        if not k.startswith(("DRAMACLAW_", "ST_", "SUPERTALE_", "REMOTE_MCP_"))
    } | {"PYTHONDONTWRITEBYTECODE": "1"}


class Exchange:
    """API double: ``KEY`` and every key in ``catalogs`` exchange for a token.

    ``catalogs`` maps a key to ``(token, {kind: catalog})``; ``projects`` is the project
    ID list every key's token sees, or an HTTP status the listing fails with. ``key_port`` is
    a ``FakeKeyPort`` that accepts the same keys for the same tokens.
    """

    def __init__(self, projects=None, catalogs=None):
        self.requests = []
        self.project_requests = []
        self.catalog_requests = []
        catalogs = {} if catalogs is None else catalogs
        projects = [] if projects is None else projects
        self.key_port = FakeKeyPort(
            {KEY: FAKE_TOKEN} | {key: token for key, (token, _) in catalogs.items()},
        )
        exchange = self

        class Handler(BaseHTTPRequestHandler):
            def _reply(self, status, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

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
                if self.path != "/api/v1/agent/sessions":
                    self._reply(404, {"ok": False})
                elif matches:
                    self._reply(200, {
                        "ok": True, "data": {
                            "token": catalogs[key][0] if key in catalogs else FAKE_TOKEN,
                            "expires_at": time.time() + 60,
                        },
                    })
                else:
                    self._reply(401, {"ok": False})

            def do_GET(self):
                if self.path.startswith("/api/v1/freezone/agent-config/"):
                    kind = self.path.rsplit("/", 1)[-1]
                    owner = next((key for key, (token, _) in catalogs.items()
                                  if self.headers.get("Authorization") == f"Bearer {token}"), None)
                    exchange.catalog_requests.append({"path": self.path, "owner": owner})
                    if owner is None:
                        self._reply(401, {"ok": False})
                    elif kind not in catalogs[owner][1]:
                        self._reply(404, {"ok": False})
                    else:
                        self._reply(200, {"ok": True, "data": catalogs[owner][1][kind]})
                    return
                matches = self.headers.get("Authorization") in {
                    f"Bearer {token}" for token in exchange.key_port.sessions.values()
                }
                exchange.project_requests.append({
                    "path": self.path, "authorization_matches": matches,
                    "accept": self.headers.get("Accept"),
                })
                if self.path != "/api/v1/projects":
                    self._reply(404, {"ok": False})
                elif not matches:
                    self._reply(401, {"ok": False})
                elif isinstance(projects, int):
                    self._reply(projects, {"ok": False})
                else:
                    self._reply(200, {
                        "ok": True, "data": [{"id": project_id} for project_id in projects],
                    })

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
