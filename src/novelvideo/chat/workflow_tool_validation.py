"""Schema-driven argument refusals for workflow draft tools."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from novelvideo.chat.studio_tool_validation import _path


def _variants(schema: dict) -> list[dict]:
    return schema.get("anyOf", schema.get("oneOf", []))


def _shape(schema: dict) -> str:
    if "enum" in schema:
        return "one of " + ", ".join(json.dumps(v, ensure_ascii=False) for v in schema["enum"])
    if "const" in schema:
        return json.dumps(schema["const"], ensure_ascii=False)
    if variants := _variants(schema):
        return " or ".join(_shape(v) for v in variants)
    kind = schema.get("type")
    if isinstance(kind, list):
        return " or ".join(kind)
    if kind == "array":
        if "items" not in schema:
            return "array"
        item = _shape(schema["items"])
        if item in {"string", "integer", "number", "boolean", "object"}:
            item += "s"
        elif schema["items"].get("type") == "object":
            item = "objects"
        return "array of " + item
    if kind == "object" or "properties" in schema:
        if "properties" in schema:
            return "object with " + ", ".join(
                f"{key} ({_shape(prop)})" for key, prop in schema["properties"].items()
            )
        return "object"
    return kind or "any value"


def _default(schema: dict, field: str) -> Any:
    if "enum" in schema:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]
    if variants := _variants(schema):
        return _default(next((v for v in variants if v != {"type": "null"}), variants[0]), field)
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((t for t in kind if t != "null"), "null")
    if kind == "string":
        return f"<{field}>"
    if kind in {"integer", "number"}:
        return schema.get("minimum", 1)
    if kind == "boolean":
        return False
    if kind == "array":
        return [_default(schema.get("items", {}), field) for _ in range(schema.get("minItems", 0))]
    if kind == "object" or "properties" in schema:
        return {
            key: _default(schema.get("properties", {}).get(key, {}), key)
            for key in schema.get("required", [])
        }
    return None


def _shown(value: Any) -> str:
    if not isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False)
        if len(text) <= 80:
            return text
    kind = (
        "object" if isinstance(value, dict) else "array" if isinstance(value, list)
        else "number" if isinstance(value, (int, float)) else "string"
    )
    return f"this {kind}"


def workflow_argument_refusal(
    name: str, arguments: Any, schema: dict, exc: ValidationError,
) -> dict:
    """Describe all argument problems and include only schema-valid repair examples."""
    errors: list[dict] = []
    example = deepcopy(arguments)

    def add(value: Any, candidate: dict, parts: tuple, problem: str) -> None:
        nonlocal example
        path = ""
        for part in parts:
            path = _path(path, part)
        accepted = (
            list(candidate.get("properties", {})) if problem == "unknown_field"
            else [_shape(v) for v in (_variants(candidate) or [candidate])]
        )
        error = {"path": path, "problem": problem, "accepted": accepted}
        if problem == "unknown_field":
            message = f"{path} is not a known field. Known fields: {', '.join(accepted)}."
        else:
            prefix = (
                f"{path} is required." if problem == "missing_field"
                else f"{path}: {_shown(value)} is not accepted."
            )
            message = f"{prefix} Accepted: {' | '.join(accepted)}."
            validator = Draft202012Validator(candidate)
            choices = []
            if problem == "invalid_value":
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    choices.append(str(value))
                elif isinstance(value, str):
                    if re.fullmatch(r"[+-]?[0-9]+", value):
                        choices.append(int(value))
                    elif re.fullmatch(r"[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+)", value):
                        choices.append(float(value))
            choices.append(_default(candidate, str(parts[-1]) if parts else "arguments"))
            for choice in choices:
                if validator.is_valid(choice):
                    error["example"] = deepcopy(choice)
                    message += f" Example: {json.dumps(choice, ensure_ascii=False)}."
                    break
        error["message"] = message
        errors.append(error)
        if problem == "unknown_field" or "example" in error:
            if not parts:
                example = deepcopy(error["example"])
                return
            parent = example
            for part in parts[:-1]:
                parent = parent[part]
            if problem == "unknown_field":
                del parent[parts[-1]]
            else:
                parent[parts[-1]] = deepcopy(error["example"])

    def walk(value: Any, candidate: dict, parts: tuple = ()) -> None:
        if variants := _variants(candidate):
            if any(Draft202012Validator(v).is_valid(value) for v in variants):
                return
            non_null = [v for v in variants if v != {"type": "null"}]
            if len(non_null) == 1:
                walk(value, non_null[0], parts)
            else:
                add(value, candidate, parts, "invalid_value")
            return
        if isinstance(value, dict) and (
            "properties" in candidate
            or isinstance(candidate.get("additionalProperties"), dict)
        ):
            properties = candidate.get("properties", {})
            for key in candidate.get("required", []):
                if key not in value:
                    add(None, properties.get(key, {}), (*parts, key), "missing_field")
            extra = candidate.get("additionalProperties", True)
            for key, item in value.items():
                if key in properties:
                    walk(item, properties[key], (*parts, key))
                elif extra is False:
                    add(item, candidate, (*parts, key), "unknown_field")
                elif isinstance(extra, dict):
                    walk(item, extra, (*parts, key))
            return
        if candidate.get("type") == "array":
            if (
                not isinstance(value, list)
                or len(value) < candidate.get("minItems", 0)
                or len(value) > candidate.get("maxItems", float("inf"))
            ):
                add(value, candidate, parts, "invalid_value")
            else:
                for index, item in enumerate(value):
                    walk(item, candidate.get("items", {}), (*parts, index))
            return
        if not Draft202012Validator(candidate).is_valid(value):
            add(value, candidate, parts, "invalid_value")

    walk(arguments, schema)
    if not errors:
        add(exc.instance, exc.schema, tuple(exc.absolute_path), "invalid_value")
    payload = {
        "errors": errors,
        "message": "; ".join(error["message"] for error in errors),
        "path": errors[0]["path"],
        "next_action": "Fix the listed errors and call the tool once with corrected arguments.",
        "agent_instruction": (
            f"These arguments do not match the {name} schema; every problem is "
            "listed in errors with the accepted shapes or values. Fix all of them and call the "
            "tool "
            "once with corrected arguments. example is the corrected call; keep the user's real "
            "values and use example only for the format. Sending the same arguments again fails "
            "the same way."
        ),
    }
    if Draft202012Validator(schema).is_valid(example):
        payload["example"] = example
    return payload
