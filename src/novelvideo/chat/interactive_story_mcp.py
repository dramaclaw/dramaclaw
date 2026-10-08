"""Independent stdio MCP for interactive stories on one bound canvas.

Run with ``python -m novelvideo.chat.interactive_story_mcp``. Story schemas and
API wrappers are shared with native Hermes; transport validation is shared
with the canvas MCP. No director or Freezone plugin is loaded by this server.
"""

from __future__ import annotations

import asyncio
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from novelvideo.chat import mcp_runtime, story_tools
from novelvideo.chat.story_mcp_policy import STORY_HOOKS
from novelvideo.chat.agent_api_errors import _http_error_result, _maybe_json

SERVER = Server("dramaclaw_interactive_story", version="0.1.0")


def _request(method: str, path: str, *, query=None, body=None) -> dict[str, Any]:
    """Use only this turn's API credential, reading its file at call time."""
    base = os.environ.get("DRAMACLAW_API_URL", "").strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("interactive-story API URL is not configured")
    if not path.startswith("/api/v1/projects/") or ".." in path.split("/"):
        raise ValueError("interactive-story API path is invalid")
    token_file = os.environ.get("DRAMACLAW_AGENT_TOKEN_FILE", "").strip()
    if token_file:
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
    else:
        token = os.environ.get("DRAMACLAW_AGENT_TOKEN", "").strip()
    local_trust = (
        os.environ.get("DRAMACLAW_LOCAL_AGENT_TRUST", "").strip().lower()
        in {"1", "true", "yes", "on"}
        and parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
        and not token_file
    )
    if not token and not local_trust:
        raise ValueError("interactive-story agent token is not configured")
    headers = {
        "Accept": "application/json",
        "User-Agent": "interactive-story-mcp/0.1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    suffix = "?" + urlencode(query, doseq=True) if query else ""
    request = Request(
        base + path + suffix, data=payload, headers=headers, method=method
    )
    try:
        timeout = max(30, int(os.environ.get("DRAMACLAW_API_TIMEOUT_SECONDS", "120")))
    except ValueError:
        timeout = 120
    try:
        with urlopen(request, timeout=timeout) as response:
            data = _maybe_json(response.read().decode("utf-8", errors="replace"))
            if isinstance(data, dict):
                return {"status_code": response.status, **data}
            return {
                "ok": 200 <= response.status < 300,
                "status_code": response.status,
                "data": data,
            }
    except HTTPError as exc:
        return _http_error_result(
            exc.code, exc.read(65537).decode("utf-8", errors="replace"), str(exc.reason)
        )
    except URLError as exc:
        return {"ok": False, "error": f"network_error: {exc.reason}"}


def _schema(
    name, description, properties, required=None, *, additional_properties=False
):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
            "additionalProperties": additional_properties,
        },
        "output_schema": story_tools.output_schema(name),
    }


@lru_cache(maxsize=1)
def _tools() -> mcp_runtime.ToolIndex:
    entries = story_tools.build_tools(
        schema=_schema,
        request=lambda *args, **kwargs: _request(*args, **kwargs),
        project_from_args=lambda args: args["project_id"],
        tool_result=lambda value: value,
        tool_error=lambda message: {"ok": False, "error": str(message)},
    )
    canvas_name = "dramaclaw_get_freezone_canvas"
    entries = (
        *entries,
        (
            canvas_name,
            _schema(
                canvas_name,
                "Read the bound persisted canvas and its current revision before a story write. "
                "Refresh after intervening canvas commands or media results; earlier revisions may be stale.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to the current project context.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to the current canvas context.",
                    },
                },
            ),
            lambda args: story_tools.get_bound_canvas(args, _request),
        ),
    )

    def scoped(handler):
        def handle(args):
            try:
                result = handler(story_tools.bound_story_args(args))
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            return json.dumps(result, ensure_ascii=False)

        return handle

    return {name: (schema, scoped(handler)) for name, schema, handler in entries}


@SERVER.list_tools()
async def list_tools() -> list[types.Tool]:
    return mcp_runtime.build_mcp_tools(_tools())


@SERVER.call_tool(validate_input=False)
async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    return await mcp_runtime.call_tool(
        name, arguments, tool_index=_tools(), hooks=STORY_HOOKS
    )


async def _main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await SERVER.run(
            read_stream, write_stream, SERVER.create_initialization_options()
        )


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
