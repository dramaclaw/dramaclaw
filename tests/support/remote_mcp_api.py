"""Stand-in for the API endpoints the remote MCP entry calls back into.

``Exchange`` answers the agent key exchange (``POST /api/v1/agent/sessions``), the
project listing (``GET /api/v1/projects``) and the per-key agent catalogs
(``GET /api/v1/freezone/agent-config/<kind>``), and records every request so a test can
check which credential reached the API. ``direct_tools`` lists the tools of the stdio
launcher, which the entry must serve unchanged.
"""

from __future__ import annotations

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

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "agent-kit/scripts/launch_mcp.py"
KEY = "fake-entry-key-DO-NOT-USE-7f3a9c"
FAKE_TOKEN = "fake-exchange-token-DO-NOT-USE-91c2"


def clean_env():
    # Keep host credentials and agent profile settings out of test subprocesses.
    return {
        k: v for k, v in os.environ.items()
        if not k.startswith(("DRAMACLAW_", "ST_", "SUPERTALE_", "REMOTE_MCP_"))
    } | {"PYTHONDONTWRITEBYTECODE": "1"}


class Exchange:
    """API double: ``KEY`` and every key in ``catalogs`` exchange for a token.

    ``catalogs`` maps a key to ``(token, {kind: catalog})``; ``projects`` is the project
    ID list ``FAKE_TOKEN`` sees, or an HTTP status the listing fails with.
    """

    def __init__(self, projects=None, catalogs=None):
        self.requests = []
        self.project_requests = []
        self.catalog_requests = []
        catalogs = {} if catalogs is None else catalogs
        projects = [] if projects is None else projects
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
                matches = self.headers.get("Authorization") == f"Bearer {FAKE_TOKEN}"
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
