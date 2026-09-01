"""MCP bridge for DramaClaw tools.

Hermes uses ``.hermes/plugins/dramaclaw`` directly. Claude, Codex, and other
MCP-speaking agents use this stdio server to call that same toolset without
duplicating DramaClaw API wrappers.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import re
import sys
import types as py_types
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

logger = logging.getLogger("novelvideo.chat.dramaclaw_mcp")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _install_hermes_registry_shim() -> None:
    if "tools.registry" in sys.modules:
        return

    tools_pkg = py_types.ModuleType("tools")
    registry = py_types.ModuleType("tools.registry")

    def tool_result(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False)

    def tool_error(message: Any) -> str:
        return json.dumps({"ok": False, "error": str(message)}, ensure_ascii=False)

    registry.tool_result = tool_result
    registry.tool_error = tool_error
    tools_pkg.registry = registry
    sys.modules.setdefault("tools", tools_pkg)
    sys.modules["tools.registry"] = registry


def _load_plugin(plugin_name: str) -> Any:
    _install_hermes_registry_shim()
    plugin_path = _repo_root() / ".hermes" / "plugins" / plugin_name / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        f"_dramaclaw_{plugin_name}_hermes_plugin_for_mcp",
        plugin_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {plugin_name} plugin from {plugin_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _tool_index(*plugins: Any) -> dict[str, tuple[dict[str, Any], Any]]:
    index: dict[str, tuple[dict[str, Any], Any]] = {}
    for plugin in plugins:
        for entry in getattr(plugin, "TOOLS", ()):
            if not isinstance(entry, tuple) or len(entry) != 3:
                continue
            name, schema, handler = entry
            if isinstance(name, str) and isinstance(schema, dict) and callable(handler):
                if name in index:
                    raise RuntimeError(f"duplicate MCP tool name: {name}")
                index[name] = (schema, handler)
    return index


# Hermes registers both the core DramaClaw tools and the Freezone canvas
# tools. Loading only the core plugin here bypasses the browser bridge, so
# Codex can mutate canvas state without producing the Hermes approval card.
PLUGINS = (_load_plugin("dramaclaw"), _load_plugin("freezone"))
# Backwards-compatible alias for callers/tests that inspect the core plugin.
PLUGIN = PLUGINS[0]
TOOLS = _tool_index(*PLUGINS)
SERVER = Server("dramaclaw", version="0.1.0")


def _adapt_external_agent_tool_result(name: str, value: Any) -> str:
    """Resolve legacy workflow instructions at the external MCP boundary.

    Hermes consumes the plugin result directly and keeps its existing flow. External
    MCP agents receive an instruction that distinguishes an already-authorized create
    imperative from a draft that genuinely still needs confirmation.
    """

    raw = str(value or "")
    if name != "freezone_prepare_workflow_draft":
        return raw
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return raw
    if not isinstance(payload, dict) or not (
        payload.get("ok") is True
        and str(payload.get("status") or "") == "workflow_draft_ready"
    ):
        return raw
    # Billing metadata is intentionally kept in the tool payload.  Do not
    # replace an instruction produced by the workflow plugin: EE uses that
    # instruction to describe the planning estimate and the separate media
    # charges.  Metadata can be nested in ``billing`` or ``data`` depending
    # on the plugin version, so inspect the whole JSON object.
    billing_keys = {
        "agent_planning_charge",
        "agent_credit_estimate",
        "planning_charge",
        "credit_estimate",
        "feature_credit_estimate",
    }

    def has_billing_metadata(item: Any) -> bool:
        if isinstance(item, dict):
            if any(key in item for key in billing_keys):
                return True
            return any(has_billing_metadata(child) for child in item.values())
        if isinstance(item, list):
            return any(has_billing_metadata(child) for child in item)
        return False

    instruction = str(payload.get("agent_instruction") or "").strip()
    if instruction:
        instruction += " "
    instruction += (
        "Present the exact preview in product language, including each node's "
        "preview.recipe_pipelines order as 主 Recipe → 补充 Recipe. If the current user message explicitly asks to create "
        "or run the workflow and all required clarification answers are available, that "
        "imperative is authorization: call freezone_confirm_workflow_draft exactly once now "
        "with this draft_id and revision, without asking for another confirmation. Otherwise "
        "wait for explicit user confirmation. For adjustments, patch this draft instead of "
        "rebuilding the intent."
    )
    if has_billing_metadata(payload):
        instruction += (
            " Preserve and clearly display the provided planning charge, Agent credit estimate, "
            "and separate media-generation costs."
        )
    else:
        instruction += " Do not invent or mention credits, billing, pricing, or editions."
    payload["agent_instruction"] = instruction
    return json.dumps(payload, ensure_ascii=False)

TOOL_SEARCH_NAME = "dramaclaw_tool_search"
TOOL_DESCRIBE_NAME = "dramaclaw_tool_describe"
TOOL_CALL_NAME = "dramaclaw_tool_call"
BRIDGE_TOOL_NAMES = frozenset(
    {TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME}
)
_WORKFLOW_DRAFT_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ok": {"type": "boolean"},
        "status": {"type": "string"},
        "code": {"type": ["string", "null"]},
        "draft_id": {"type": ["string", "null"]},
        "revision": {"type": ["integer", "null"]},
        "preview": {"type": ["object", "array", "null"]},
        "agent_planning_charge": {"type": ["object", "number", "string", "null"]},
        "agent_credit_estimate": {"type": ["object", "number", "string", "null"]},
        "confirmation_required": {"type": "boolean"},
        "next_action": {"type": ["string", "null"]},
        "agent_instruction": {"type": ["string", "null"]},
    },
    "required": ["ok", "status", "confirmation_required", "next_action"],
    "additionalProperties": True,
}

# Home turns have no bound project and should only manage the project
# collection. Project-scoped tokens remain the authority for every underlying
# API call, but this allow-list also keeps irrelevant production schemas out of
# discovery and prevents the model from selecting a project-only operation.
HOME_TOOL_NAMES = frozenset(
    {
        "dramaclaw_get",
        "dramaclaw_post",
        "dramaclaw_patch",
        "dramaclaw_delete",
    }
)

_SEARCH_ALIASES = {
    "dramaclaw_get": "get read list inspect project projects 项目 查询 读取 列表 状态 settings config",
    "dramaclaw_post": "post create start project projects 项目 创建 新建 启动 upload ingest",
    "dramaclaw_patch": "patch update edit project projects settings 项目 修改 更新 设置",
    "dramaclaw_delete": "delete remove project projects canvas 项目 删除 移除",
}
_SEARCH_TERM_RE = re.compile(r"[\w\u4e00-\u9fff-]+", re.UNICODE)
_CJK_TERM_RE = re.compile(r"^[\u4e00-\u9fff]+$")


def _scope_kind() -> str:
    return "project" if os.environ.get("DRAMACLAW_PROJECT_ID", "").strip() else "home"


def _freezone_canvas_mode() -> bool:
    """Detect Freezone even when a shared App Server drops one env flag."""
    if os.environ.get("DRAMACLAW_TOOL_MODE", "").strip() == "freezone_canvas":
        return True
    return bool(
        os.environ.get("DRAMACLAW_CANVAS_ID", "").strip()
        and os.environ.get("DRAMACLAW_AGENT_PROFILE", "").strip().startswith("freezone")
    ) or os.environ.get("DRAMACLAW_CHAT_SURFACE", "").strip() == "freezone"


def _available_tools() -> dict[str, tuple[dict[str, Any], Any]]:
    if _scope_kind() == "home":
        return {name: TOOLS[name] for name in sorted(HOME_TOOL_NAMES) if name in TOOLS}
    if _freezone_canvas_mode():
        denied = frozenset().union(
            *(getattr(plugin, "FREEZONE_DENIED_MAINLINE_WRITE_TOOLS", ()) for plugin in PLUGINS)
        )
        return {name: item for name, item in TOOLS.items() if name not in denied}
    return dict(TOOLS)


def _tool_summary(name: str, schema: dict[str, Any]) -> dict[str, str]:
    return {
        "name": name,
        "description": str(schema.get("description") or "").strip(),
    }


def _search_tools(query: str, limit: int) -> list[dict[str, str]]:
    available = _available_tools()
    normalized = str(query or "").strip().lower()
    terms: list[str] = []
    for term in _SEARCH_TERM_RE.findall(normalized):
        terms.append(term)
        if len(term) > 2 and _CJK_TERM_RE.fullmatch(term):
            terms.extend(term[index : index + 2] for index in range(len(term) - 1))
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    for name, (schema, _handler) in available.items():
        description = str(schema.get("description") or "")
        haystack = f"{name} {description} {_SEARCH_ALIASES.get(name, '')}".lower()
        if not terms:
            score = 1
        else:
            score = sum(4 if term in name.lower() else 1 for term in terms if term in haystack)
        if score:
            ranked.append((score, name, schema))

    # A zero-result search is rarely useful to an agent. Home has only four
    # tools, while project fallback returns a small alphabetical sample that
    # lets the model refine its next query without receiving every schema.
    if not ranked:
        ranked = [(0, name, schema) for name, (schema, _handler) in available.items()]
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [_tool_summary(name, schema) for _score, name, schema in ranked[:limit]]


def _bridge_tools() -> list[types.Tool]:
    scope = _scope_kind()
    return [
        types.Tool(
            name=TOOL_SEARCH_NAME,
            description=(
                "Search the project-scoped DramaClaw tool catalog before choosing a business "
                "operation. Search by user intent, production phase, asset, task, or Chinese/English "
                f"keyword. Current scope: {scope}. Returns names and short descriptions only."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Intent or capability keywords, for example 项目列表, 分集规划, 首帧, or compose video.",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 12,
                        "default": 6,
                    },
                },
                "additionalProperties": False,
            },
        ),
        types.Tool(
            name=TOOL_DESCRIBE_NAME,
            description=(
                "Return the exact input schema for one tool found with dramaclaw_tool_search. "
                "Use this before dramaclaw_tool_call when its arguments are not already known."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string", "minLength": 1},
                },
                "required": ["tool_name"],
                "additionalProperties": False,
            },
        ),
        types.Tool(
            name=TOOL_CALL_NAME,
            description=(
                "Call one project-scoped DramaClaw tool after discovering it. The underlying "
                "schema is validated and the existing short-lived agent token remains authoritative."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string", "minLength": 1},
                    "arguments": {"type": "object", "default": {}},
                },
                "required": ["tool_name"],
                "additionalProperties": False,
            },
        ),
    ]


def _json_text(payload: Any) -> list[types.TextContent]:
    return [
        types.TextContent(
            type="text",
            text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )
    ]


@SERVER.list_tools()
async def list_tools() -> list[types.Tool]:
    # In Freezone, expose the same concrete Hermes tool names. The previous
    # search/describe/call indirection made Codex spend an extra turn choosing
    # a tool and could cause it to retry after the browser had already applied
    # the command. All handlers still execute through the same Freezone bridge.
    if _scope_kind() == "project" and _freezone_canvas_mode():
        result: list[types.Tool] = []
        for name, (schema, _handler) in sorted(_available_tools().items()):
            parameters = schema.get("parameters") if isinstance(schema, dict) else None
            result.append(
                types.Tool(
                    name=name,
                    description=str(schema.get("description") or ""),
                    inputSchema=parameters if isinstance(parameters, dict) else {"type": "object"},
                    outputSchema=(
                        _WORKFLOW_DRAFT_OUTPUT_SCHEMA
                        if name == "freezone_prepare_workflow_draft"
                        else None
                    ),
                )
            )
        return result
    return _bridge_tools()


def _skill_resource_path(uri: str) -> Path:
    """Resolve only Markdown files below an agent ``.agents/skills`` root.

    Codex can send either a standards-based ``file://`` URI or the resource's
    absolute/agent-root-relative path while progressively loading a skill.
    Both forms are constrained and then remapped to the current thread root.
    """
    raw_uri = str(uri or "").strip()
    parsed = urlparse(raw_uri)
    if parsed.scheme == "file":
        if parsed.netloc:
            raise ValueError("remote file skill resources are not supported")
        raw_path = unquote(parsed.path)
    elif not parsed.scheme and not parsed.netloc:
        raw_path = unquote(parsed.path)
    else:
        raise ValueError("only local skill resources are supported")
    if not raw_path:
        raise ValueError("skill resource path is required")
    raw_target = Path(raw_path).expanduser()
    parts = raw_target.parts
    relative: Path | None = None
    for index in range(len(parts) - 1):
        if parts[index] == ".agents" and parts[index + 1] == "skills":
            relative = Path(*parts[index + 2 :])
            break
    if relative is None:
        raise ValueError("resource is outside the agent skills directory")
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError("resource is outside the agent skills directory")
    if relative.suffix.lower() != ".md":
        raise ValueError("only Markdown skill resources are supported")
    relative_parts = relative.parts
    if len(relative_parts) < 2 or (
        relative_parts[-1] != "SKILL.md" and "references" not in relative_parts[1:-1]
    ):
        raise ValueError("resource is not a skill document")
    roots = _skill_resource_roots()
    if raw_target.is_absolute() and raw_target.exists():
        existing_target = raw_target.resolve()
        if not any(
            _path_is_within(existing_target, root)
            for root in roots
        ):
            raise ValueError("resource belongs to a different agent workspace")
    # Persisted Codex threads can retain a file URI from an older workspace.
    # Resolve the same skill-relative path against the current thread's
    # explicitly scoped skills root; never search arbitrary host directories.
    for root in roots:
        candidate = (root / relative).resolve()
        if not _path_is_within(candidate, root):
            continue
        if candidate.is_file():
            return candidate
    raise ValueError("skill resource is unavailable")


def _path_is_within(target: Path, root: Path) -> bool:
    try:
        target.relative_to(root)
    except ValueError:
        return False
    return True


def _skill_resource_roots() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("DRAMACLAW_SKILLS_DIR", "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path.cwd() / ".agents" / "skills")
    roots: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        try:
            root = candidate.expanduser().resolve()
        except OSError:
            continue
        if root in seen or not root.is_dir():
            continue
        seen.add(root)
        roots.append(root)
    return roots


@SERVER.list_resources()
async def list_resources() -> list[types.Resource]:
    """Advertise readable skill Markdown resources to MCP clients."""
    resources: list[types.Resource] = []
    seen: set[Path] = set()
    for root in _skill_resource_roots():
        for target in sorted(root.rglob("*.md")):
            if not target.is_file() or target in seen:
                continue
            try:
                _skill_resource_path(target.as_uri())
            except ValueError:
                continue
            seen.add(target)
            resources.append(
                types.Resource(
                    name=target.relative_to(root).as_posix(),
                    uri=target.as_uri(),
                    description="DramaClaw agent skill resource",
                    mimeType="text/markdown",
                    size=target.stat().st_size,
                )
            )
    logger.info("mcp resources/list scope=%s count=%d", _scope_kind(), len(resources))
    return resources


@SERVER.list_resource_templates()
async def list_resource_templates() -> list[types.ResourceTemplate]:
    """DramaClaw exposes concrete skill files, not parameterized resources."""
    logger.info("mcp resources/templates/list scope=%s count=0", _scope_kind())
    return []


@SERVER.read_resource()
async def read_resource(uri: Any) -> str:
    """Read a referenced SKILL.md or references/*.md file only."""
    target = _skill_resource_path(str(uri))
    logger.info("mcp resources/read scope=%s resource=%s", _scope_kind(), target.name)
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError("skill resource is unavailable") from exc


@SERVER.call_tool(validate_input=True)
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    arguments = arguments or {}
    logger.info(
        "mcp call scope=%s bridge=%s tool=%s", _scope_kind(), name, arguments.get("tool_name")
    )
    if name in _available_tools() and name not in BRIDGE_TOOL_NAMES:
        schema, handler = _available_tools()[name]
        parameters = schema.get("parameters") if isinstance(schema, dict) else None
        input_schema = parameters if isinstance(parameters, dict) else {"type": "object"}
        try:
            Draft202012Validator.check_schema(input_schema)
            Draft202012Validator(input_schema).validate(arguments)
        except (SchemaError, ValidationError) as exc:
            return _json_text({
                "ok": False,
                "error": "tool_arguments_invalid",
                "tool_name": name,
                "message": getattr(exc, "message", str(exc)),
            })
        result = handler(arguments)
        adapted = _adapt_external_agent_tool_result(name, result)
        if name == "freezone_prepare_workflow_draft":
            try:
                structured = json.loads(adapted)
            except (TypeError, json.JSONDecodeError):
                structured = {"ok": False, "status": "invalid_tool_result", "next_action": None}
            if isinstance(structured, dict):
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=adapted)],
                    structuredContent=structured,
                )
        return [
            types.TextContent(
                type="text",
                text=adapted,
            )
        ]

    if name == TOOL_SEARCH_NAME:
        try:
            limit = max(1, min(12, int(arguments.get("limit", 6))))
        except (TypeError, ValueError):
            limit = 6
        matches = _search_tools(str(arguments.get("query") or ""), limit)
        return _json_text(
            {
                "ok": True,
                "scope": _scope_kind(),
                "available_count": len(_available_tools()),
                "matches": matches,
            }
        )

    tool_name = str(arguments.get("tool_name") or "").strip()
    item = _available_tools().get(tool_name)
    if item is None:
        return _json_text(
            {
                "ok": False,
                "error": "tool_not_available_in_scope",
                "scope": _scope_kind(),
                "tool_name": tool_name,
            }
        )
    schema, handler = item
    parameters = schema.get("parameters") if isinstance(schema, dict) else None
    input_schema = parameters if isinstance(parameters, dict) else {"type": "object"}

    if name == TOOL_DESCRIBE_NAME:
        return _json_text(
            {
                "ok": True,
                "scope": _scope_kind(),
                "tool": {
                    **_tool_summary(tool_name, schema),
                    "input_schema": input_schema,
                },
            }
        )
    if name != TOOL_CALL_NAME:
        raise ValueError(f"unknown DramaClaw bridge tool: {name}")

    underlying_arguments = arguments.get("arguments") or {}
    if not isinstance(underlying_arguments, dict):
        return _json_text({"ok": False, "error": "arguments_must_be_an_object"})
    try:
        Draft202012Validator.check_schema(input_schema)
        Draft202012Validator(input_schema).validate(underlying_arguments)
    except SchemaError:
        return _json_text(
            {"ok": False, "error": "invalid_registered_tool_schema", "tool_name": tool_name}
        )
    except ValidationError as exc:
        return _json_text(
            {
                "ok": False,
                "error": "tool_arguments_invalid",
                "tool_name": tool_name,
                "message": exc.message,
                "path": list(exc.absolute_path),
            }
        )

    text = handler(underlying_arguments)
    if tool_name == "freezone_prepare_workflow_draft":
        adapted = _adapt_external_agent_tool_result(tool_name, text)
        try:
            structured = json.loads(adapted)
        except (TypeError, json.JSONDecodeError):
            structured = None
        if isinstance(structured, dict):
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=adapted)],
                structuredContent=structured,
            )
        return [types.TextContent(type="text", text=adapted)]
    return [types.TextContent(type="text", text=str(text or ""))]


async def _main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await SERVER.run(
            read_stream,
            write_stream,
            SERVER.create_initialization_options(),
        )


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
