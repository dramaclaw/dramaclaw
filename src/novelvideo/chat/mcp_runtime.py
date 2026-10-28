"""Protocol handling shared by MCP hosts, with domain rules supplied by hooks.

This module has no application, plugin, canvas, or workflow dependencies.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from mcp import types

from novelvideo.chat.story_validation import (
    _integer_string_argument_paths as _integer_string_argument_paths,
    _unexpected_argument_fields as _unexpected_argument_fields,
    base_validation_error_payload as validation_error_payload,
    validation_correction_paths as validation_correction_paths,
    validation_error_details as validation_error_details,
)

ToolIndex = dict[str, tuple[dict[str, Any], Any]]
logger = logging.getLogger("novelvideo.chat.mcp_runtime")


def normalize_structured_result(schema: dict[str, Any], decoded: Any) -> dict[str, Any]:
    raw = decoded if isinstance(decoded, dict) else {}
    nested = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    ok = (
        raw.get("ok") if isinstance(raw.get("ok"), bool) else not bool(raw.get("error"))
    )
    status = raw.get("status") or nested.get("status")
    if not isinstance(status, str) or not status:
        status = "completed" if ok else "failed"
    properties = schema.get("properties") or {}
    structured = {"ok": ok, "status": status}
    for key in properties:
        if key in {"ok", "status"}:
            continue
        if key in raw:
            structured[key] = raw[key]
        elif key in nested:
            structured[key] = nested[key]

    # FastAPI validation failures are returned under data.detail. Preserve that
    # diagnostic in the typed MCP result so the Agent can correct one request
    # instead of guessing alternate payload shapes from a generic 422 message.
    if "details" in properties and "details" not in structured:
        if isinstance(nested, dict) and "detail" in nested:
            detail = nested["detail"]
            structured["details"] = (
                [
                    {
                        "path": ".".join(
                            str(part)
                            for part in (
                                item.get("loc", [])[1:]
                                if item.get("loc", [])[:1] == ["body"]
                                else item.get("loc", [])
                            )
                        ),
                        "message": str(item.get("msg", "Validation failed")),
                    }
                    for item in detail
                    if isinstance(item, dict)
                ]
                if isinstance(detail, list)
                else detail
            )

    if isinstance(raw.get("data"), list):
        array_fields = [
            key
            for key, property_schema in properties.items()
            if key not in structured and property_schema.get("type") == "array"
        ]
        if len(array_fields) == 1:
            structured[array_fields[0]] = raw["data"]
    return structured


def output_schema_for_tool(name: str, tool_index: ToolIndex) -> dict[str, Any]:
    entry = tool_index.get(name)
    if entry is None:
        raise ValueError(f"unknown MCP tool: {name}")
    schema = entry[0].get("output_schema")
    if not isinstance(schema, dict):
        raise RuntimeError(f"missing output schema for {name}")
    return schema


def build_mcp_tools(tool_index: ToolIndex) -> list[types.Tool]:
    result = []
    for name, (schema, _handler) in sorted(tool_index.items()):
        parameters = schema.get("parameters")
        result.append(
            types.Tool(
                name=name,
                description=str(schema.get("description") or ""),
                inputSchema=parameters
                if isinstance(parameters, dict)
                else {"type": "object"},
                outputSchema=output_schema_for_tool(name, tool_index),
            )
        )
    return result


def _identity_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return arguments


def _no_repair(
    name: str, arguments: dict[str, Any], schema: dict[str, Any]
) -> dict[str, Any] | None:
    return None


def _encode_result(name: str, value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _preserve_text(
    name: str, text: str, decoded: Any, structured: dict[str, Any]
) -> str:
    return text


def _collect_all_errors(name: str) -> bool:
    return True


@dataclass(frozen=True)
class ToolCallHooks:
    """Domain behavior injected by a host; defaults enforce plain MCP contracts."""

    normalize_arguments: Callable[[str, dict[str, Any]], dict[str, Any]] = (
        _identity_arguments
    )
    repair_arguments: Callable[
        [str, dict[str, Any], dict[str, Any]], dict[str, Any] | None
    ] = _no_repair
    validation_error: Callable[..., dict[str, Any]] = validation_error_payload
    collect_all_errors: Callable[[str], bool] = _collect_all_errors
    adapt_result: Callable[[str, Any], str] = _encode_result
    normalize_result: Callable[[dict[str, Any], Any], dict[str, Any]] = (
        normalize_structured_result
    )
    render_text: Callable[[str, str, Any, dict[str, Any]], str] = _preserve_text


DEFAULT_HOOKS = ToolCallHooks()


def structured_tool_result(
    name: str,
    text: str,
    tool_index: ToolIndex,
    *,
    hooks: ToolCallHooks = DEFAULT_HOOKS,
) -> types.CallToolResult:
    try:
        decoded = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        decoded = text
    schema = output_schema_for_tool(name, tool_index)
    structured = hooks.normalize_result(schema, decoded)
    Draft202012Validator(schema).validate(structured)
    return types.CallToolResult(
        content=[
            types.TextContent(
                type="text", text=hooks.render_text(name, text, decoded, structured)
            )
        ],
        structuredContent=structured,
        isError=structured["ok"] is False,
    )


def mcp_error_result(
    name: str,
    payload: dict[str, Any],
    tool_index: ToolIndex,
    *,
    hooks: ToolCallHooks = DEFAULT_HOOKS,
) -> types.CallToolResult:
    body = dict(payload)
    body.setdefault("ok", False)
    body.setdefault("status", "tool_failed")
    body.setdefault("retryable", False)
    body.setdefault("next_action", "检查错误字段后再重试")
    return structured_tool_result(
        name,
        json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        tool_index,
        hooks=hooks,
    )


def _log_call_end(
    log: logging.Logger, scope: str, name: str, started: float, payload: Any
) -> None:
    raw = payload if isinstance(payload, dict) else {}
    log.info(
        "mcp.call.end scope=%s tool=%s elapsed_ms=%d ok=%s status=%s error=%s result_type=%s result_bytes=%s",
        scope,
        name,
        int((time.monotonic() - started) * 1000),
        raw.get("ok"),
        raw.get("status"),
        str(raw.get("error"))[:240] if raw.get("error") else None,
        type(payload).__name__,
        len(payload) if isinstance(payload, str) else None,
    )


async def call_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    tool_index: ToolIndex,
    hooks: ToolCallHooks = DEFAULT_HOOKS,
    scope: str = "project",
    log: logging.Logger = logger,
) -> types.CallToolResult:
    """Validate, execute, and encode one tool without loading any host modules."""
    if name not in tool_index:
        raise ValueError(f"unknown MCP tool: {name}")
    arguments = hooks.normalize_arguments(name, arguments or {})
    started = time.monotonic()
    log.info(
        "mcp.call.start scope=%s tool=%s arg_keys=%s",
        scope,
        name,
        sorted(str(key) for key in arguments),
    )
    schema, handler = tool_index[name]
    parameters = schema.get("parameters")
    input_schema = parameters if isinstance(parameters, dict) else {"type": "object"}
    errors: list[Any] = []
    try:
        Draft202012Validator.check_schema(input_schema)
        validator = Draft202012Validator(input_schema)
        if hooks.collect_all_errors(name):
            errors = sorted(
                validator.iter_errors(arguments),
                key=lambda error: tuple(
                    (0, part) if isinstance(part, int) else (1, str(part))
                    for part in getattr(error, "absolute_path", ())
                ),
            )
            if errors:
                raise errors[0]
        else:
            validator.validate(arguments)
    except (SchemaError, ValidationError) as exc:
        repaired = (
            hooks.repair_arguments(name, arguments, input_schema)
            if isinstance(exc, ValidationError)
            else None
        )
        if repaired is not None:
            try:
                Draft202012Validator(input_schema).validate(repaired)
            except ValidationError:
                repaired = None
        if repaired is None:
            payload = hooks.validation_error(
                name, arguments, input_schema, exc, errors or [exc]
            )
            _log_call_end(log, scope, name, started, payload)
            return mcp_error_result(name, payload, tool_index, hooks=hooks)
        arguments = repaired
    try:
        result = await asyncio.to_thread(handler, arguments)
        if inspect.isawaitable(result):
            result = await result
        adapted = hooks.adapt_result(name, result)
        response = structured_tool_result(name, adapted, tool_index, hooks=hooks)
    except Exception as exc:
        log.exception(
            "mcp.call.exception scope=%s tool=%s elapsed_ms=%d error_type=%s error=%s",
            scope,
            name,
            int((time.monotonic() - started) * 1000),
            type(exc).__name__,
            str(exc)[:240],
        )
        raise
    _log_call_end(log, scope, name, started, response.structuredContent)
    return response
