"""MCP bridge for DramaClaw tools.

Hermes uses ``.hermes/plugins/dramaclaw`` directly. Claude, Codex, and other
MCP-speaking agents use this stdio server to call that same toolset without
duplicating DramaClaw API wrappers.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import logging
import os
import re
import sys
import time
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
    if name not in {
        "freezone_prepare_workflow_draft",
        "freezone_prepare_workflow_plan_draft",
    }:
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
        "wait for explicit user confirmation. "
    )
    instruction += (
        "For adjustments, prepare a new complete Plan draft."
        if name == "freezone_prepare_workflow_plan_draft"
        else "For adjustments, patch this draft instead of rebuilding the intent."
    )
    if has_billing_metadata(payload):
        instruction += (
            " Preserve and clearly display the provided planning charge, Agent credit estimate, "
            "and separate media-generation costs."
        )
    else:
        instruction += (
            " Do not invent or mention credits, billing, pricing, or editions."
        )
    payload["agent_instruction"] = instruction
    return json.dumps(payload, ensure_ascii=False)


TOOL_SEARCH_NAME = "dramaclaw_tool_search"
TOOL_DESCRIBE_NAME = "dramaclaw_tool_describe"
TOOL_CALL_NAME = "dramaclaw_tool_call"
BRIDGE_TOOL_NAMES = frozenset({TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME})
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
        "quote_id": {"type": ["string", "null"]},
        "quote": {"type": ["object", "null"]},
        "next_action": {"type": ["string", "null"]},
        "agent_instruction": {"type": ["string", "null"]},
    },
    "required": ["ok", "status"],
    "additionalProperties": True,
}

_MCP_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Structured DramaClaw tool result; tool-specific fields may be present.",
    "properties": {
        "ok": {"type": "boolean"},
        "status": {"type": "string"},
        "code": {"type": ["string", "null"]},
        "error": {"type": ["string", "null"]},
        "next_action": {"type": ["string", "null"]},
    },
    "required": ["ok"],
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
    return (
        bool(
            os.environ.get("DRAMACLAW_CANVAS_ID", "").strip()
            and os.environ.get("DRAMACLAW_AGENT_PROFILE", "")
            .strip()
            .startswith("freezone")
        )
        or os.environ.get("DRAMACLAW_CHAT_SURFACE", "").strip() == "freezone"
    )


def _available_tools() -> dict[str, tuple[dict[str, Any], Any]]:
    if _scope_kind() == "home":
        return {name: TOOLS[name] for name in sorted(HOME_TOOL_NAMES) if name in TOOLS}
    if _freezone_canvas_mode():
        denied = frozenset().union(
            *(
                getattr(plugin, "FREEZONE_DENIED_MAINLINE_WRITE_TOOLS", ())
                for plugin in PLUGINS
            )
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
            score = sum(
                4 if term in name.lower() else 1 for term in terms if term in haystack
            )
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


def _mcp_error_result(payload: dict[str, Any]) -> types.CallToolResult:
    """Expose validation failures as MCP errors rather than plain text."""
    body = dict(payload)
    body.setdefault("ok", False)
    body.setdefault("status", "tool_failed")
    body.setdefault("retryable", False)
    body.setdefault("next_action", "检查错误字段后再重试")
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=encoded)],
        structuredContent=body,
        isError=True,
    )


def _log_mcp_call_end(
    *,
    scope: str,
    tool: str,
    started: float,
    payload: Any = None,
    error: Any = None,
) -> None:
    """Log a compact call outcome without prompts, paths, or credentials."""
    if isinstance(payload, dict):
        ok = payload.get("ok")
        status = payload.get("status")
        error = payload.get("error", error)
    else:
        ok = None
        status = None
    logger.info(
        "mcp.call.end scope=%s tool=%s elapsed_ms=%d ok=%s status=%s error=%s result_type=%s result_bytes=%s",
        scope,
        tool,
        int((time.monotonic() - started) * 1000),
        ok,
        status,
        str(error)[:240] if error else None,
        type(payload).__name__ if payload is not None else "none",
        len(payload) if isinstance(payload, str) else None,
    )


def _workflow_schema_recovery_instruction(tool_name: str) -> str | None:
    if tool_name not in {
        "freezone_prepare_workflow_plan_draft",
        "workflow_graph_compile",
    }:
        return None
    return (
        "WorkflowPlan 校验失败。不要提交单节点探测、空 edges 或 compact Intent。"
        "请保留同一份完整节点清单和所有边；每个可执行节点必须把"
        "workflowCatalog.recipeId 放在节点 data 内。确认所有 edge 的 source/target"
        "都对应 nodes[].id。提交前由 Agent 检查整图连通性；独立 Beat/镜头分支应通过"
        "非执行型公共输入根节点扇出连接，不能要求用户说明内部连线，也不能把需要故障"
        "隔离的兄弟分支串行连接。连线兼容性不明确时先读取 link type catalog，禁止猜测"
        "类型或反复试编译。恢复编译成功后立即用同一计划提交创建。"
    )


def _workflow_plan_log_summary(arguments: Any) -> dict[str, Any]:
    plan = arguments.get("plan") if isinstance(arguments, dict) else None
    if not isinstance(plan, dict):
        return {"plan_type": type(plan).__name__}
    nodes = plan.get("nodes")
    edges = plan.get("edges")
    node_types: dict[str, int] = {}
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict):
                node_type = str(node.get("node_type") or node.get("type") or "unknown")
                node_types[node_type] = node_types.get(node_type, 0) + 1
    return {
        "schema_version": plan.get("schema_version"),
        "node_count": len(nodes) if isinstance(nodes, list) else None,
        "edge_count": len(edges) if isinstance(edges, list) else None,
        "node_types": node_types,
        "has_skill": isinstance(plan.get("skill"), dict),
    }


@SERVER.list_tools()
async def list_tools() -> list[types.Tool]:
    # Expose concrete, scope-filtered business tools everywhere. Native MCP
    # clients can defer loading schemas themselves, while the old
    # search/describe/call wrapper hid capabilities from that mechanism and
    # added an avoidable model round trip.
    result: list[types.Tool] = []
    for name, (schema, _handler) in sorted(_available_tools().items()):
        parameters = schema.get("parameters") if isinstance(schema, dict) else None
        result.append(
            types.Tool(
                name=name,
                description=str(schema.get("description") or ""),
                inputSchema=(
                    parameters if isinstance(parameters, dict) else {"type": "object"}
                ),
                outputSchema=(
                    _WORKFLOW_DRAFT_OUTPUT_SCHEMA
                    if name
                    in {
                        "freezone_prepare_workflow_draft",
                        "freezone_prepare_workflow_plan_draft",
                    }
                    else _MCP_OUTPUT_SCHEMA
                ),
            )
        )
    return result


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
        if not any(_path_is_within(existing_target, root) for root in roots):
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
    call_started = time.monotonic()
    logger.info(
        "mcp.call.start scope=%s tool=%s bridge_tool=%s arg_keys=%s",
        _scope_kind(),
        name,
        arguments.get("tool_name"),
        sorted(str(key) for key in arguments),
    )
    if name in _available_tools():
        schema, handler = _available_tools()[name]
        workflow_started = (
            time.monotonic() if name == "freezone_prepare_workflow_plan_draft" else None
        )
        if workflow_started is not None:
            logger.info(
                "freezone_prepare_workflow_plan_draft.start scope=%s summary=%s",
                _scope_kind(),
                _workflow_plan_log_summary(arguments),
            )
        parameters = schema.get("parameters") if isinstance(schema, dict) else None
        input_schema = (
            parameters if isinstance(parameters, dict) else {"type": "object"}
        )
        try:
            Draft202012Validator.check_schema(input_schema)
            Draft202012Validator(input_schema).validate(arguments)
        except (SchemaError, ValidationError) as exc:
            recovery = _workflow_schema_recovery_instruction(name)
            if workflow_started is not None:
                logger.warning(
                    "freezone_prepare_workflow_plan_draft.validation_failed elapsed_ms=%d message=%s path=%s summary=%s",
                    int((time.monotonic() - workflow_started) * 1000),
                    getattr(exc, "message", str(exc)),
                    ".".join(str(part) for part in getattr(exc, "absolute_path", ())),
                    _workflow_plan_log_summary(arguments),
                )
            # Some model adapters accidentally wrap a complete graph one level
            # too deep as {"plan": {"plan": {...}}}. Unwrap only this exact
            # shape; all other schema errors remain fail-closed.
            nested = arguments.get("plan") if isinstance(arguments, dict) else None
            if (
                name == "freezone_prepare_workflow_plan_draft"
                and isinstance(nested, dict)
                and isinstance(nested.get("plan"), dict)
            ):
                unwrapped = dict(arguments)
                unwrapped["plan"] = nested["plan"]
                try:
                    Draft202012Validator(input_schema).validate(unwrapped)
                except ValidationError:
                    pass
                else:
                    arguments = unwrapped
                    # Continue through the normal handler below.
                    try:
                        result = await asyncio.to_thread(handler, arguments)
                    except Exception as exc:
                        logger.exception(
                            "mcp.call.exception scope=%s tool=%s elapsed_ms=%d error_type=%s error=%s",
                            _scope_kind(),
                            name,
                            int((time.monotonic() - call_started) * 1000),
                            type(exc).__name__,
                            str(exc)[:240],
                        )
                        raise
                    if inspect.isawaitable(result):
                        result = await result
                    adapted = _adapt_external_agent_tool_result(name, result)
                    try:
                        structured = json.loads(adapted)
                    except (TypeError, json.JSONDecodeError):
                        structured = None
                    if isinstance(structured, dict):
                        return types.CallToolResult(
                            content=[types.TextContent(type="text", text=adapted)],
                            structuredContent=structured,
                            isError=structured.get("ok") is False,
                        )
                    return [types.TextContent(type="text", text=adapted)]
            error_payload = {
                "ok": False,
                "error": "tool_arguments_invalid",
                "tool_name": name,
                "message": getattr(exc, "message", str(exc)),
                "status": (
                    "workflow_validation_failed"
                    if name
                    in {
                        "freezone_prepare_workflow_plan_draft",
                        "workflow_graph_compile",
                    }
                    else "tool_arguments_invalid"
                ),
                "phase": (
                    "graph_compile"
                    if name
                    in {
                        "freezone_prepare_workflow_plan_draft",
                        "workflow_graph_compile",
                    }
                    else "tool_validation"
                ),
                "retryable": name
                in {"freezone_prepare_workflow_plan_draft", "workflow_graph_compile"},
                **({"agent_instruction": recovery} if recovery else {}),
            }
            _log_mcp_call_end(
                scope=_scope_kind(),
                tool=name,
                started=call_started,
                payload=error_payload,
            )
            return _mcp_error_result(error_payload)
        try:
            result = await asyncio.to_thread(handler, arguments)
        except Exception as exc:
            logger.exception(
                "mcp.call.exception scope=%s tool=%s elapsed_ms=%d error_type=%s error=%s",
                _scope_kind(),
                name,
                int((time.monotonic() - call_started) * 1000),
                type(exc).__name__,
                str(exc)[:240],
            )
            raise
        if inspect.isawaitable(result):
            result = await result
        adapted = _adapt_external_agent_tool_result(name, result)
        if workflow_started is not None:
            logger.info(
                "freezone_prepare_workflow_plan_draft.end elapsed_ms=%d result_bytes=%d",
                int((time.monotonic() - workflow_started) * 1000),
                len(adapted),
            )
        try:
            structured = json.loads(adapted)
        except (TypeError, json.JSONDecodeError):
            structured = None
        if isinstance(structured, dict):
            if not isinstance(structured.get("ok"), bool):
                structured["ok"] = not bool(structured.get("error"))
            if not isinstance(structured.get("status"), str):
                structured["status"] = "completed" if structured["ok"] else "failed"
            _log_mcp_call_end(
                scope=_scope_kind(),
                tool=name,
                started=call_started,
                payload=structured,
            )
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=adapted)],
                structuredContent=structured,
                isError=structured.get("ok") is False,
            )
        _log_mcp_call_end(
            scope=_scope_kind(),
            tool=name,
            started=call_started,
            payload=adapted,
        )
        return [
            types.TextContent(
                type="text",
                text=adapted,
            )
        ]

    raise ValueError(f"unknown DramaClaw tool: {name}")


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
