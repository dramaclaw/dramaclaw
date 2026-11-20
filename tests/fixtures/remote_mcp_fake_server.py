"""Deterministic stdio peer for the remote relay contract tests."""

import argparse
import asyncio
import hashlib
import json
import os
import signal
from pathlib import Path

from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.stdio import stdio_server


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["tools", "workflows"])
    parser.add_argument("--ce-dir")
    args = parser.parse_args()
    if path := os.environ.get("REMOTE_MCP_FAKE_PID_LOG"):
        with Path(path).open("a") as log:
            log.write(f"{os.getpid()}\n")
    if os.environ.get("REMOTE_MCP_FAKE_IGNORE_TERM") == "1":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    server = Server(f"fake-{args.mode}")

    async def record_notification(notification):
        if path := os.environ.get("REMOTE_MCP_FAKE_NOTIFICATION_LOG"):
            with Path(path).open("a") as log:
                log.write(notification.model_dump_json(by_alias=True, exclude_none=True) + "\n")

    server.notification_handlers[types.ProgressNotification] = record_notification

    @server.list_tools()
    async def list_tools():
        schemas = {
            "whoami": {},
            "sleep": {"seconds": {"type": "number"}},
            "echo": {"text": {"type": "string"}},
        }
        if args.mode == "workflows":
            schemas["workflow_only"] = {}
        schemas["noisy"] = {}
        schemas["binary_noise"] = {}
        return [
            types.Tool(
                name=name,
                description=f"Fake {name}",
                inputSchema={"type": "object", "properties": props},
            )
            for name, props in schemas.items()
        ]

    @server.call_tool()
    async def call_tool(name, arguments):
        if name == "whoami":
            value = json.dumps({
                **({"env_names": sorted(os.environ)}
                   if os.environ.get("REMOTE_MCP_FAKE_REPORT_ENV_NAMES") else {}),
                "mode": args.mode,
                "project_id": os.environ.get("DRAMACLAW_PROJECT_ID"),
                "canvas_id": os.environ.get("DRAMACLAW_CANVAS_ID"),
                "pid": os.getpid(),
                "key_matches": hashlib.sha256(
                    os.environ.get("DRAMACLAW_AGENT_KEY", "").encode()
                ).hexdigest() == os.environ.get("REMOTE_MCP_FAKE_EXPECTED_KEY_SHA256"),
                "has_token_env": any(k.startswith("DRAMACLAW_AGENT_TOKEN") for k in os.environ),
                "has_key_file_env": "DRAMACLAW_AGENT_KEY_FILE" in os.environ,
                "ce_dir": os.environ.get("DRAMACLAW_CE_DIR"),
                "api_url": os.environ.get("DRAMACLAW_API_URL"),
                "username": os.environ.get("DRAMACLAW_USERNAME"),
            })
        elif name == "sleep":
            await asyncio.sleep(arguments["seconds"])
            value = "slept"
        elif name == "echo":
            value = arguments["text"]
        elif name == "noisy":
            os.write(1, b"stray-stdout-line-not-json-5d1e\n")
            value = "noisy done"
        elif name == "binary_noise":
            os.write(1, b"\xff\xfe stray-binary-line\n")
            value = "binary noise done"
        elif name == "workflow_only" and args.mode == "workflows":
            value = "workflow"
        else:
            raise ValueError("Unknown fake tool")
        return [types.TextContent(type="text", text=value)]

    @server.list_resources()
    async def list_resources():
        return [types.Resource(uri="fake://doc", name="doc", mimeType="text/markdown")]

    @server.list_resource_templates()
    async def list_templates():
        return [types.ResourceTemplate(uriTemplate="fake://item/{name}", name="item")]

    @server.read_resource()
    async def read_resource(uri):
        if str(uri) != "fake://doc":
            raise ValueError("Unknown fake resource")
        return [ReadResourceContents(content="# fake doc", mime_type="text/markdown")]

    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
