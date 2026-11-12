"""Schema-driven argument refusals for workflow draft tools."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from novelvideo.chat.studio_tool_validation import _path
from novelvideo.freezone.workflow_schema import workflow_plan_schema_diagnostics


def _variants(schema: dict) -> list[dict]:
    return schema.get("anyOf", schema.get("oneOf", []))


def _shape(schema: dict | bool, *, nested: bool = False) -> str:
    if isinstance(schema, bool):
        return "any value" if schema else "no value"
    if "enum" in schema:
        return "one of " + ", ".join(json.dumps(v, ensure_ascii=False) for v in schema["enum"])
    if "const" in schema:
        return json.dumps(schema["const"], ensure_ascii=False)
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        if not nested and schema.get("properties"):
            return "object with " + ", ".join(
                f"{key} ({_shape(prop, nested=True)})"
                for key, prop in schema["properties"].items() if prop is not False
            )
        return "object"
    if variants := _variants(schema):
        return " or ".join(dict.fromkeys(_shape(v, nested=nested) for v in variants))
    if isinstance(kind, list):
        return " or ".join(kind)
    if kind is None:
        for constraint, direction in (("maxItems", "most"), ("minItems", "least")):
            if constraint in schema:
                count = schema[constraint]
                return f"array with at {direction} {count} item" + ("" if count == 1 else "s")
    if kind == "array":
        if "items" not in schema:
            return "array"
        item = _shape(schema["items"], nested=True)
        if item in {"string", "integer", "number", "boolean", "object"}:
            item += "s"
        return "array of " + item
    return kind or "any value"


def _required_alternatives(variants: list[dict]) -> bool:
    return bool(variants) and all(
        isinstance(variant, dict) and set(variant) == {"required"} for variant in variants
    )


def _default(schema: dict | bool, field: str) -> Any:
    if isinstance(schema, bool):
        return None
    if "enum" in schema:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]
    kind = schema.get("type")
    variants = _variants(schema)
    if kind == "object" or "properties" in schema:
        keys = list(schema.get("required", []))
        if _required_alternatives(variants):
            keys.extend(variants[0]["required"])
        return {
            key: _default(schema.get("properties", {}).get(key, {}), key)
            for key in dict.fromkeys(keys)
        }
    if variants:
        return _default(next((v for v in variants if v != {"type": "null"}), variants[0]), field)
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
    return None


def _discriminator(variants: list[dict]) -> str | None:
    if not all(isinstance(variant, dict) and "properties" in variant for variant in variants):
        return None
    for key in variants[0]["properties"]:
        if all(
            isinstance(prop := variant.get("properties", {}).get(key), dict)
            and ("enum" in prop or "const" in prop)
            for variant in variants
        ):
            return key
    return None


def _field_path(parts: tuple) -> str:
    path = ""
    for part in parts:
        path = _path(path, part)
    return path or "arguments"


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

    enclosing: list[tuple[tuple, dict]] = []

    def repaired_at(parts: tuple) -> Any:
        current = example
        for part in parts:
            current = current[part]
        return current

    def add(
        value: Any, candidate: dict | bool, parts: tuple, problem: str, *, coerce: bool = True,
    ) -> None:
        nonlocal example
        path = _field_path(parts)
        if problem == "unknown_field":
            accepted = [
                key for key, prop in candidate.get("properties", {}).items() if prop is not False
            ]
        else:
            variants = _variants(candidate) if isinstance(candidate, dict) else []
            accepted = list(dict.fromkeys(_shape(v) for v in (variants or [candidate])))
        error = {"path": path, "problem": problem, "accepted": accepted}
        if problem == "unknown_field":
            message = f"{path}: field is not allowed. Known fields: {', '.join(accepted)}."
            for ancestor_parts, ancestor in reversed(enclosing[:-1]):
                if ancestor.get("properties", {}).get(parts[-1], False) is not False:
                    location = (
                        _field_path(ancestor_parts) if ancestor_parts else "the top-level arguments"
                    )
                    message += f" {parts[-1]} is a field of {location}."
                    break
        else:
            prefix = (
                f"{path}: field is required." if problem == "missing_field"
                else f"{path}: {_shown(value)} is not accepted."
            )
            message = f"{prefix} Accepted: {' | '.join(accepted)}."
            validator = Draft202012Validator(candidate)
            choices = []
            if problem == "invalid_value" and coerce:
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    choices.append(str(value))
                elif isinstance(value, str):
                    if re.fullmatch(r"[+-]?[0-9]+", value):
                        try:
                            choices.append(int(value))
                        except ValueError:
                            pass
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
            parent = repaired_at(parts[:-1])
            if problem == "unknown_field":
                del parent[parts[-1]]
            else:
                parent[parts[-1]] = deepcopy(error["example"])

    def check_object_alternatives(value: dict, candidate: dict, parts: tuple) -> None:
        variants = _variants(candidate)
        if not variants:
            return
        if not _required_alternatives(variants):
            if not any(Draft202012Validator(v).is_valid(value) for v in variants):
                accepted = list(dict.fromkeys(_shape(v) for v in variants))
                path = _field_path(parts)
                errors.append({
                    "path": path, "problem": "invalid_value", "accepted": accepted,
                    "message": f"{path}: this object is not accepted. "
                    f"Accepted: {' | '.join(accepted)}.",
                })
            return
        satisfied = [v for v in variants if all(key in value for key in v["required"])]
        exclusive = "oneOf" in candidate
        if satisfied and (not exclusive or len(satisfied) == 1):
            return
        properties = candidate.get("properties", {})
        accepted = [
            " + ".join(f"{key} ({_shape(properties.get(key, {}))})" for key in v["required"])
            for v in variants
        ]
        names = ", ".join(" + ".join(v["required"]) for v in variants)
        path = _field_path(parts)
        message = f"{path}: provide {'exactly' if exclusive else 'at least'} one of {names}"
        error = {
            "path": path, "problem": "conflicting_fields" if satisfied else "missing_field",
            "accepted": accepted,
        }
        fixed = repaired_at(parts)
        if satisfied:
            message += "; got " + ", ".join(" + ".join(v["required"]) for v in satisfied)
            keep = satisfied[0]["required"]
            for variant in variants:
                for key in variant["required"]:
                    if key not in keep:
                        fixed.pop(key, None)
        message += f". Accepted: {' | '.join(accepted)}."
        if not satisfied:
            choice = {
                key: _default(properties.get(key, {}), key) for key in variants[0]["required"]
            }
            error["example"] = choice
            fixed.update(deepcopy(choice))
            message += f" Example: {json.dumps(choice, ensure_ascii=False)}."
        error["message"] = message
        errors.append(error)

    def walk(value: Any, candidate: dict | bool, parts: tuple = ()) -> None:
        if isinstance(candidate, bool):
            if not candidate:
                add(value, candidate, parts, "invalid_value")
            return
        variants = _variants(candidate)
        if isinstance(value, dict) and (
            "properties" in candidate
            or isinstance(candidate.get("additionalProperties"), dict)
        ):
            properties = candidate.get("properties", {})
            enclosing.append((parts, candidate))
            for key in candidate.get("required", []):
                if key not in value:
                    add(None, properties.get(key, {}), (*parts, key), "missing_field")
            extra = candidate.get("additionalProperties", True)
            for key, item in value.items():
                if properties.get(key) is False or (key not in properties and extra is False):
                    add(item, candidate, (*parts, key), "unknown_field")
                elif key in properties:
                    walk(item, properties[key], (*parts, key))
                elif isinstance(extra, dict):
                    walk(item, extra, (*parts, key))
            enclosing.pop()
            check_object_alternatives(value, candidate, parts)
            return
        if variants:
            if isinstance(value, dict) and (key := _discriminator(variants)) is not None:
                values = []
                for variant in variants:
                    prop = variant["properties"][key]
                    for option in prop.get("enum", [prop.get("const")]):
                        if option not in values:
                            values.append(option)
                candidates = [
                    v for v in variants
                    if key in value
                    and Draft202012Validator(v["properties"][key]).is_valid(value[key])
                ]
                if not candidates:
                    add(
                        value.get(key), {"enum": values}, (*parts, key),
                        "invalid_value" if key in value else "missing_field", coerce=False,
                    )
                    return
                selected = min(
                    candidates,
                    key=lambda v: len(list(Draft202012Validator(v).iter_errors(value))),
                )
                walk(value, selected, parts)
                return
            if Draft202012Validator(candidate).is_valid(value):
                return
            non_null = [v for v in variants if v != {"type": "null"}]
            if len(non_null) == 1:
                walk(value, non_null[0], parts)
            else:
                add(value, candidate, parts, "invalid_value")
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
    diagnostics = {
        issue["path"]: issue["message"]
        for issue in (
            workflow_plan_schema_diagnostics(arguments, schema)
            if isinstance(arguments, dict) else []
        )
        if re.match(r"^plan\.nodes\[\d+\]", issue["path"])
    }
    errors = [
        error for error in errors
        if error["path"] in diagnostics or not any(
            error["path"] == "arguments"
            or path.startswith(error["path"] + ".")
            or path.startswith(error["path"] + "[")
            for path in diagnostics
        )
    ]
    for error in errors:
        if error["path"] in diagnostics:
            error["message"] = f"{error['path']}: {diagnostics.pop(error['path'])}"
            if "example" in error:
                if not error["message"].endswith("."):
                    error["message"] += "."
                error["message"] += f" Example: {json.dumps(error['example'], ensure_ascii=False)}."
    errors.extend(
        {"path": path, "problem": "invalid_value", "message": f"{path}: {message}"}
        for path, message in diagnostics.items()
    )
    payload = {
        "retryable": True,
        "errors": errors,
        "message": "; ".join(error["message"] for error in errors),
        "path": errors[0]["path"],
        "next_action": "Fix the listed errors and call the tool once with corrected arguments.",
        "agent_instruction": (
            f"These arguments do not match the {name} schema; every problem is "
            "listed in errors with the accepted shapes or values. Fix all of them and call the "
            "tool "
            "once with corrected arguments. example is a schema-valid call; keep the user's real "
            "values and use example only for the format. Sending the same arguments again fails "
            "the same way."
        ),
    }
    validator = Draft202012Validator(schema)
    if not validator.is_valid(example):
        example = _default(schema, "arguments")
    if validator.is_valid(example):
        payload["example"] = example
    return payload
