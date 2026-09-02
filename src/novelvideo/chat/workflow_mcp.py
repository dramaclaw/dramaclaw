"""Standalone MCP server for shared DramaClaw Workflow Skills and Recipes.

This server is deliberately read/compile-only. Canvas authorization, approval,
and commit remain in the existing DramaClaw MCP adapter, so every agent shares
the same deterministic plans without duplicating the protected write boundary.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
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
logger = logging.getLogger("novelvideo.chat.workflow_mcp")

# References are shared host guidance, not catalog IDs.  Keep the resolver
# inside the repository and never expose/accept arbitrary filesystem paths.
_REFERENCE_ROOT = Path(__file__).resolve().parents[1] / "agent_skills" / "dramaclaw-workflows" / "references"
_REFERENCE_NAMES = frozenset({"custom-topology.md", "error-recovery.md", "integration.md"})

_WORKFLOW_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Structured result returned by every DramaClaw workflow tool.",
    "properties": {
        "ok": {"type": "boolean"},
        "status": {"type": "string"},
        "code": {"type": ["string", "null"]},
        "error": {"type": ["string", "null"]},
        "next_action": {"type": ["string", "null"]},
    },
    "required": ["ok", "status"],
    "additionalProperties": True,
}


def _username() -> str:
    return str(os.environ.get("DRAMACLAW_USERNAME") or "local").strip() or "local"


def _text(payload: dict[str, Any]) -> list[types.TextContent]:
    return [
        types.TextContent(
            type="text",
            text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )
    ]


def _result(payload: Any) -> types.CallToolResult | list[types.TextContent]:
    """Return JSON text plus structured content for MCP clients that support it."""
    if not isinstance(payload, dict):
        payload = {"ok": False, "status": "invalid_tool_result", "error": str(payload)}
    else:
        payload = dict(payload)
        if not isinstance(payload.get("ok"), bool):
            payload["ok"] = not bool(payload.get("error"))
        if not isinstance(payload.get("status"), str) or not payload["status"].strip():
            payload["status"] = "completed" if payload["ok"] else "failed"
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=encoded)],
        structuredContent=payload,
        isError=payload.get("ok") is False,
    )


def _plan_log_summary(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict):
        return {"plan_type": type(plan).__name__}
    nodes = plan.get("nodes")
    edges = plan.get("edges")
    node_types: dict[str, int] = {}
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict):
                node_type = str(node.get("node_type") or "unknown")
                node_types[node_type] = node_types.get(node_type, 0) + 1
    return {
        "schema_version": plan.get("schema_version"),
        "node_count": len(nodes) if isinstance(nodes, list) else None,
        "edge_count": len(edges) if isinstance(edges, list) else None,
        "node_types": node_types,
        "has_skill": isinstance(plan.get("skill"), dict),
    }


def _object_schema(
    properties: dict[str, Any], required: list[str] | None = None
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


def _read_skill_reference(skill_id: Any, reference: Any) -> dict[str, Any]:
    """Read an allow-listed Workflow Skill reference by logical name."""
    normalized_skill = str(skill_id or "").strip()
    normalized_reference = str(reference or "").strip().replace("\\", "/")
    # References currently describe the portable workflow contract and are
    # shared by all catalog Skills.  Require a real Skill ID so hosts cannot
    # use this endpoint as a generic file reader.
    skill = get_workflow_skill({"skill_id": normalized_skill, "compact": True})
    if not skill.get("ok"):
        return {"ok": False, "status": "workflow_skill_not_found", "skill_id": normalized_skill}
    if normalized_reference.startswith("references/"):
        normalized_reference = normalized_reference[len("references/") :]
    if (
        not normalized_reference
        or normalized_reference not in _REFERENCE_NAMES
        or "/" in normalized_reference
        or normalized_reference in {".", ".."}
    ):
        return {"ok": False, "status": "workflow_reference_not_found", "reference": normalized_reference}
    path = (_REFERENCE_ROOT / normalized_reference).resolve()
    if path.parent != _REFERENCE_ROOT or not path.is_file():
        return {"ok": False, "status": "workflow_reference_not_found", "reference": normalized_reference}
    return {
        "ok": True,
        "status": "workflow_reference_ready",
        "skill_id": normalized_skill,
        "reference": normalized_reference,
        "content": path.read_text(encoding="utf-8"),
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
        types.ResourceTemplate(
            name="DramaClaw Workflow Skill Reference",
            uriTemplate="dramaclaw-workflow://skills/{skill_id}/references/{reference}",
            description="One allow-listed reference document for a Workflow Skill",
            mimeType="text/markdown",
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
        parts = item_id.split("/references/", 1)
        if len(parts) == 2:
            payload = _read_skill_reference(parts[0], parts[1])
            if not payload.get("ok"):
                raise ValueError("workflow skill reference not found")
        else:
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
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
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
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
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
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
        ),
        types.Tool(
            name="workflow_skill_reference_get",
            description=(
                "Read one allow-listed reference document for a selected Workflow Skill. "
                "Pass only a logical filename such as custom-topology.md; never pass a filesystem path."
            ),
            inputSchema=_object_schema(
                {
                    "skill_id": {"type": "string", "minLength": 1},
                    "reference": {
                        "type": "string",
                        "enum": ["custom-topology.md", "error-recovery.md", "integration.md"],
                    },
                },
                ["skill_id", "reference"],
            ),
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
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
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
        ),
        types.Tool(
            name="workflow_graph_compile",
            description=(
                "Validate one freezone_workflow_plan.v1 and deterministically compile a single "
                "canvas batch containing nodes, edges, grouping, layout, and selection. Read-only. "
                "For recovery, compile the same complete user workflow; never construct reduced "
                "probe nodes or pass an empty edges array for a multi-node plan. Node ids belong "
                "only in plan.nodes[].id and edge source/target values; do not add a top-level "
                "id, node_id, commands, or canvas command objects."
            ),
            inputSchema=_object_schema(
                {
                    "plan": workflow_plan_json_schema(),
                    "workflow_instance_id": {"type": "string"},
                    "run_after_create": {"type": "boolean", "default": False},
                },
                ["plan"],
            ),
            outputSchema=_WORKFLOW_OUTPUT_SCHEMA,
        ),
    ]


@SERVER.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> Any:
    args = dict(arguments or {})
    if name == "workflow_catalog_search":
        kind = str(args.get("kind") or "")
        if kind not in {"skills", "recipes"}:
            return _result({"ok": False, "status": "invalid_catalog_kind"})
        items = search_catalog(
            username=_username(),
            kind=kind,  # type: ignore[arg-type]
            query=str(args.get("query") or ""),
            limit=int(args.get("limit") or 12),
        )
        return _result({"ok": True, "status": "catalog_ready", "kind": kind, "items": items})
    if name == "workflow_skill_get":
        result = get_workflow_skill({**args, "compact": True})
        return _result(result)
    if name == "workflow_recipe_get":
        item = get_catalog_item(
            username=_username(),
            kind="recipes",
            item_id=str(args.get("recipe_id") or ""),
        )
        return _result(
            {"ok": True, "recipe": item}
            if item is not None
            else {"ok": False, "status": "recipe_not_found"}
        )
    if name == "workflow_skill_reference_get":
        return _result(_read_skill_reference(args.get("skill_id"), args.get("reference")))
    if name == "workflow_intent_compile":
        return _result(compile_workflow_intent(args.get("intent")))
    if name == "workflow_graph_compile":
        started = time.monotonic()
        logger.info("workflow_graph_compile.start summary=%s", _plan_log_summary(args.get("plan")))
        validation = validate_agent_workflow_plan(args.get("plan"))
        if not validation.get("ok"):
            logger.warning(
                "workflow_graph_compile.validation_failed elapsed_ms=%d status=%s errors=%s",
                int((time.monotonic() - started) * 1000),
                validation.get("status"),
                validation.get("errors") or validation.get("error"),
            )
            errors = validation.get("errors") or []
            disconnected = any(
                isinstance(issue, dict)
                and "disconnected nodes" in str(issue.get("message") or "")
                for issue in errors
            )
            incompatible_edge = any(
                isinstance(issue, dict)
                and "is incompatible with" in str(issue.get("message") or "")
                for issue in errors
            )
            instruction = (
                "保留同一份完整 WorkflowPlan；不要提交单节点探测、空 edges 或 compact Intent。"
                "每个可执行节点必须在 data.workflowCatalog.recipeId 中指定 Recipe，"
                "且所有边的 source/target 必须对应 nodes[].id。"
            )
            if disconnected:
                instruction += (
                    "当前计划包含多个互不连通的分支。不要要求用户补充内部连线，也不要为了"
                    "通过校验而把需要独立失败隔离的 Beat/镜头串行连接；请加入一个非执行型公共"
                    "输入根节点，将它分别连接到每个独立分支的输入节点，再仅重新编译一次完整计划。"
                )
            if incompatible_edge:
                instruction += (
                    "当前存在不兼容的连线类型。调用 freezone_get_link_type_catalog 一次，按实际"
                    "source/target 节点类型选择目录中列出的 link_type；禁止继续猜测其它类型或"
                    "反复试编译。恢复编译成功后，必须立即用同一份计划提交工作流创建。"
                )
            validation.setdefault("agent_instruction", instruction)
            return _result(validation)
        result = build_workflow_graph_commands(args)
        logger.info(
            "workflow_graph_compile.end elapsed_ms=%d ok=%s status=%s command_count=%s",
            int((time.monotonic() - started) * 1000),
            result.get("ok"),
            result.get("status"),
            len(result.get("commands") or []) if isinstance(result, dict) else None,
        )
        return _result(result)
    return _result({"ok": False, "status": "unknown_tool", "tool": name})


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
