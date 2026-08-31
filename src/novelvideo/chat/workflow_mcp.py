"""Standalone MCP server for shared DramaClaw Workflow Skills and Recipes.

This server is deliberately read/compile-only. Canvas authorization, approval,
and commit remain in the existing DramaClaw MCP adapter, so every agent shares
the same deterministic plans without duplicating the protected write boundary.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import unquote, urlsplit

from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from novelvideo.freezone.agent_workflows.catalog import (
    compile_workflow_intent,
    get_workflow_skill,
    validate_agent_workflow_plan,
)
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.agent_workflows.registry import (
    get_catalog_item,
    search_catalog,
)
from novelvideo.freezone.workflow_schema import (
    workflow_intent_json_schema,
    workflow_plan_json_schema,
)

SERVER = Server("dramaclaw-workflows", version="1.0.0")


def _username() -> str:
    return str(os.environ.get("DRAMACLAW_USERNAME") or "local").strip() or "local"


def _text(payload: dict[str, Any]) -> list[types.TextContent]:
    return [
        types.TextContent(
            type="text",
            text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )
    ]


def _object_schema(
    properties: dict[str, Any], required: list[str] | None = None
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


@SERVER.list_resource_templates()
async def list_resource_templates() -> list[types.ResourceTemplate]:
    """Expose Skills and Recipes through standard parameterized MCP resources."""

    return [
        types.ResourceTemplate(
            name="DramaClaw Workflow Skill",
            uriTemplate="dramaclaw-workflow://skills/{skill_id}",
            description="One portable Workflow Skill planning package",
            mimeType="application/json",
        ),
        types.ResourceTemplate(
            name="DramaClaw Workflow Recipe",
            uriTemplate="dramaclaw-workflow://recipes/{recipe_id}",
            description="One portable Workflow Recipe definition",
            mimeType="application/json",
        ),
    ]


@SERVER.read_resource()
async def read_resource(uri: Any) -> str:
    """Read one exact catalog item selected through an MCP resource URI."""

    parsed = urlsplit(str(uri))
    if parsed.scheme != "dramaclaw-workflow":
        raise ValueError("unsupported workflow resource URI")
    kind = parsed.netloc
    item_id = unquote(parsed.path.lstrip("/"))
    if kind == "skills":
        payload = get_workflow_skill({"skill_id": item_id, "compact": True})
        if not payload.get("ok"):
            raise ValueError("workflow skill resource not found")
    elif kind == "recipes":
        item = get_catalog_item(
            username=_username(),
            kind="recipes",
            item_id=item_id,
        )
        if item is None:
            raise ValueError("workflow recipe resource not found")
        payload = {"ok": True, "recipe": item}
    else:
        raise ValueError("unsupported workflow resource kind")
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


@SERVER.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="workflow_catalog_search",
            description=(
                "Search compact shared DramaClaw workflow Skill or Recipe metadata. "
                "Use Skills for workflow routing and Recipes for exact custom topology planning."
            ),
            inputSchema=_object_schema(
                {
                    "kind": {"type": "string", "enum": ["skills", "recipes"]},
                    "query": {"type": "string", "default": ""},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 50,
                        "default": 12,
                    },
                },
                ["kind"],
            ),
        ),
        types.Tool(
            name="workflow_skill_get",
            description=(
                "Read one shared Workflow Skill planning package and compact Recipe summaries. "
                "This is read-only and does not create a canvas draft."
            ),
            inputSchema=_object_schema(
                {
                    "skill_id": {"type": "string", "minLength": 1},
                    "user_goal": {"type": "string"},
                    "inputs": {"type": "object"},
                    "compact": {
                        "type": "boolean",
                        "description": (
                            "Compatibility flag accepted by every host. This standalone "
                            "reader always returns the compact planning package."
                        ),
                    },
                },
                ["skill_id"],
            ),
        ),
        types.Tool(
            name="workflow_recipe_get",
            description=(
                "Read one full shared Recipe definition after it was selected from compact "
                "catalog results. This is read-only and does not execute the Recipe."
            ),
            inputSchema=_object_schema(
                {"recipe_id": {"type": "string", "minLength": 1}},
                ["recipe_id"],
            ),
        ),
        types.Tool(
            name="workflow_intent_compile",
            description=(
                "Deterministically compile one freezone_workflow_intent.v1 into a validated "
                "workflow plan. This is read-only; use the authorized DramaClaw workflow draft "
                "or graph tool to persist and commit it."
            ),
            inputSchema=_object_schema(
                {"intent": workflow_intent_json_schema()},
                ["intent"],
            ),
        ),
        types.Tool(
            name="workflow_graph_compile",
            description=(
                "Validate one freezone_workflow_plan.v1 and deterministically compile a single "
                "canvas batch containing nodes, edges, grouping, layout, and selection. Read-only. "
                "For recovery, compile the same complete user workflow; never construct reduced "
                "probe nodes or pass an empty edges array for a multi-node plan."
            ),
            inputSchema=_object_schema(
                {
                    "plan": workflow_plan_json_schema(),
                    "workflow_instance_id": {"type": "string"},
                    "run_after_create": {"type": "boolean", "default": False},
                },
                ["plan"],
            ),
        ),
    ]


@SERVER.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    args = dict(arguments or {})
    if name == "workflow_catalog_search":
        kind = str(args.get("kind") or "")
        if kind not in {"skills", "recipes"}:
            return _text({"ok": False, "status": "invalid_catalog_kind"})
        items = search_catalog(
            username=_username(),
            kind=kind,  # type: ignore[arg-type]
            query=str(args.get("query") or ""),
            limit=int(args.get("limit") or 12),
        )
        return _text({"ok": True, "kind": kind, "items": items})
    if name == "workflow_skill_get":
        result = get_workflow_skill({**args, "compact": True})
        return _text(result)
    if name == "workflow_recipe_get":
        item = get_catalog_item(
            username=_username(),
            kind="recipes",
            item_id=str(args.get("recipe_id") or ""),
        )
        return _text(
            {"ok": True, "recipe": item}
            if item is not None
            else {"ok": False, "status": "recipe_not_found"}
        )
    if name == "workflow_intent_compile":
        return _text(compile_workflow_intent(args.get("intent")))
    if name == "workflow_graph_compile":
        validation = validate_agent_workflow_plan(args.get("plan"))
        if not validation.get("ok"):
            return _text(validation)
        return _text(build_workflow_graph_commands(args))
    return _text({"ok": False, "status": "unknown_tool", "tool": name})


async def _main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await SERVER.run(
            read_stream,
            write_stream,
            SERVER.create_initialization_options(),
        )


def main() -> None:
    import asyncio

    asyncio.run(_main())


if __name__ == "__main__":
    main()
