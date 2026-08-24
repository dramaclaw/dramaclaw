"""MCP bridge for DramaClaw tools.

Hermes uses ``.hermes/plugins/dramaclaw`` directly. Claude, Codex, and other
MCP-speaking agents use this stdio server to call that same toolset without
duplicating DramaClaw API wrappers.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import sys
import types as py_types
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server


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


def _load_dramaclaw_plugin() -> Any:
    _install_hermes_registry_shim()
    plugin_path = _repo_root() / ".hermes" / "plugins" / "dramaclaw" / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "_dramaclaw_hermes_plugin_for_mcp",
        plugin_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load DramaClaw plugin from {plugin_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _tool_index(plugin: Any) -> dict[str, tuple[dict[str, Any], Any]]:
    index: dict[str, tuple[dict[str, Any], Any]] = {}
    for entry in getattr(plugin, "TOOLS", ()):
        if not isinstance(entry, tuple) or len(entry) != 3:
            continue
        name, schema, handler = entry
        if isinstance(name, str) and isinstance(schema, dict) and callable(handler):
            index[name] = (schema, handler)
    return index


PLUGIN = _load_dramaclaw_plugin()
TOOLS = _tool_index(PLUGIN)
SERVER = Server("dramaclaw", version="0.1.0")

TOOL_SEARCH_NAME = "dramaclaw_tool_search"
TOOL_DESCRIBE_NAME = "dramaclaw_tool_describe"
TOOL_CALL_NAME = "dramaclaw_tool_call"
BRIDGE_TOOL_NAMES = frozenset(
    {TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME}
)

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


def _available_tools() -> dict[str, tuple[dict[str, Any], Any]]:
    if _scope_kind() == "home":
        return {name: TOOLS[name] for name in sorted(HOME_TOOL_NAMES) if name in TOOLS}
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
    return _bridge_tools()


@SERVER.call_tool(validate_input=True)
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    arguments = arguments or {}
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
