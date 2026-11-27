"""Actionable, schema-driven diagnostics for Studio tool arguments."""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError, best_match

from novelvideo.chat.story_validation import base_validation_error_payload


_SUGGESTIONS = {
    "clipId": "clip", "clip_id": "clip", "clipID": "clip", "type": "op",
    "rev": "base_rev", "baseRev": "base_rev", "nodeId": "node_id",
    "source": "source_node_id", "sourceNodeId": "source_node_id",
}


def _path(parent: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{parent}[{key}]"
    return f"{parent}.{key}" if parent else key


def _diagnose(arguments: Any, schema: dict[str, Any]) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []

    def add(path: str, problem: str, message: str) -> None:
        errors.append({"path": path, "problem": problem, "message": message})

    def missing(path: str) -> None:
        add(path, "missing_field", f"{path} is required.")

    def unknown(value: dict, properties: dict, path: str) -> None:
        for key in value:
            if key in properties:
                continue
            child = _path(path, key)
            add(child, "unknown_field", f"{child} is not a known field.")
            suggestion = _SUGGESTIONS.get(key)
            if suggestion and (
                suggestion in properties
                or suggestion in schema.get("properties", {})
            ):
                errors[-1]["suggestion"] = suggestion
                hint = (
                    suggestion if suggestion in properties
                    else f"the top-level {suggestion} argument"
                )
                errors[-1]["message"] += f" Did you mean {hint}?"

    def invalid(value: Any, candidate: dict, path: str) -> None:
        error = best_match(Draft202012Validator(candidate).iter_errors(value))
        if error is not None:
            add(path, "invalid_value", f"{path}: {error.message}")

    def variants_walk(value: Any, variants: list[dict], path: str) -> None:
        properties = {
            key: prop for variant in variants for key, prop in variant["properties"].items()
        }
        names = list(dict.fromkeys(v["properties"]["op"]["const"] for v in variants))
        if "op" not in value:
            missing(_path(path, "op"))
            unknown(value, properties, path)
            return
        if not isinstance(value["op"], str) or value["op"] not in names:
            child = _path(path, "op")
            add(child, "unknown_op",
                f"{child} '{value['op']}' is not an op. Use one of: {', '.join(names)}")
            unknown(value, properties, path)
            return
        matches = [v for v in variants if v["properties"]["op"]["const"] == value["op"]]
        skip = {"op"}
        if len(matches) > 1:
            fields = [v["properties"]["field"]["const"] for v in matches]
            child = _path(path, "field")
            if "field" not in value or value["field"] not in fields:
                if "field" not in value:
                    missing(child)
                else:
                    add(child, "invalid_value", f"{child}: use one of: {', '.join(fields)}")
                unknown(value, {
                    key: prop for v in matches for key, prop in v["properties"].items()
                }, path)
                return
            matches = [v for v in matches if v["properties"]["field"]["const"] == value["field"]]
            skip.add("field")
        walk(value, matches[0], path, skip)

    def walk(
        value: Any, candidate: dict, path: str,
        skip: set[str] | frozenset[str] = frozenset(),
    ) -> None:
        if "anyOf" in candidate:
            variants = candidate["anyOf"]
            if any(Draft202012Validator(v).is_valid(value) for v in variants):
                return
            non_null = [v for v in variants if v.get("type") != "null"]
            if len(variants) == 2 and len(non_null) == 1:
                walk(value, non_null[0], path)
            elif all(
                v.get("type") == "object"
                and "const" in v.get("properties", {}).get("op", {})
                for v in variants
            ):
                if isinstance(value, dict):
                    variants_walk(value, variants, path)
                else:
                    invalid(value, candidate, path)
            else:
                invalid(value, candidate, path)
            return
        if candidate.get("type") == "object":
            if not isinstance(value, dict):
                invalid(value, candidate, path)
                return
            properties = candidate.get("properties", {})
            for key in candidate.get("required", []):
                if key not in value and key not in skip:
                    missing(_path(path, key))
            if candidate.get("additionalProperties") is False:
                unknown(value, properties, path)
            for key, item in value.items():
                if key in properties and key not in skip:
                    walk(item, properties[key], _path(path, key))
            return
        if candidate.get("type") == "array":
            if (
                not isinstance(value, list)
                or len(value) < candidate.get("minItems", 0)
                or len(value) > candidate.get("maxItems", float("inf"))
            ):
                invalid(value, candidate, path)
                return
            for index, item in enumerate(value):
                walk(item, candidate.get("items", {}), _path(path, index))
            return
        invalid(value, candidate, path)

    walk(arguments, schema, "")
    return errors


def studio_validation_error(
    name: str,
    arguments: dict[str, Any],
    schema: dict[str, Any],
    exc: SchemaError | ValidationError,
    errors: list[Any],
) -> dict[str, Any]:
    """Explain every argument problem and provide a minimal valid retry shape."""
    payload = base_validation_error_payload(name, arguments, schema, exc, errors)
    if isinstance(exc, SchemaError):
        return payload
    details = _diagnose(arguments, schema)
    if not details:
        path = ""
        for part in exc.absolute_path:
            path = _path(path, part)
        details = [{"path": path, "problem": "invalid_value", "message": f"{path}: {exc.message}"}]
    args = arguments if isinstance(arguments, dict) else {}

    def supplied(key: str, placeholder: str) -> str:
        value = args.get(key)
        return value if isinstance(value, str) and value else placeholder

    example: dict[str, Any] = {"node_id": supplied("node_id", "<compose_node_id>")}
    instruction = (
        f"These arguments do not match the {name} schema; every problem is in errors. "
        "Fix all of them and call the tool once with corrected arguments; example is a minimal "
        "valid call. Sending the same arguments again fails the same way."
    )
    if name == "freezone_studio_edit_film":
        example.update({
            "base_rev": supplied("base_rev", "<rev from freezone_studio_get_film>"),
            "ops": [{"op": "set", "clip": "<clip id from freezone_studio_get_film>",
                     "field": "at", "value": 2}],
        })
        variants = schema["properties"]["ops"]["items"]["anyOf"]
        payload["valid_ops"] = list(dict.fromkeys(v["properties"]["op"]["const"] for v in variants))
        instruction += (
            " Clip ids and base_rev come from freezone_studio_get_film; "
            "valid_ops lists the op names."
        )
    elif name == "freezone_studio_import_media":
        example["source_node_id"] = "<canvas node id with finished media>"
    payload.update({
        "errors": details,
        "message": "; ".join(error["message"] for error in details),
        "path": details[0]["path"],
        "agent_instruction": instruction,
        "next_action": "Fix the listed errors and call the tool once with corrected arguments.",
        "example": example,
    })
    return payload
