"""Schema diagnostics shared by interactive-story MCP and native Hermes."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError


def validation_error_details(
    errors: list[Any], message_for_error: Callable[[Any], str | None] | None = None
) -> list[dict[str, Any]]:
    """Return every invalid argument path without noisy duplicate entries."""
    grouped: dict[str, dict[str, Any]] = {}
    expanded = []

    def expand(error):
        contexts = list(getattr(error, "context", ()) or ())
        instance = getattr(error, "instance", None)
        schema = getattr(error, "schema", {})
        if contexts and isinstance(instance, dict):
            variants = schema.get("oneOf", [])
            for discriminator in ("op", "kind"):
                if discriminator not in instance:
                    continue
                matches = [
                    i
                    for i, variant in enumerate(variants)
                    if variant.get("properties", {}).get(discriminator, {}).get("const")
                    == instance[discriminator]
                ]
                if len(matches) == 1:
                    before = len(expanded)
                    for child in contexts:
                        if child.schema_path and child.schema_path[0] == matches[0]:
                            expand(child)
                    if len(expanded) == before:
                        expanded.append(error)
                    return
        expanded.append(error)

    for error in errors:
        expand(error)
    for error in expanded:
        path = ".".join(str(part) for part in getattr(error, "absolute_path", ()))
        detail = grouped.setdefault(path, {"path": path, "messages": []})
        contexts = list(getattr(error, "context", ()) or ())
        messages = [getattr(item, "message", str(item)) for item in contexts]
        if not messages:
            messages = [getattr(error, "message", str(error))]
        if message_for_error is not None:
            override = message_for_error(error)
            if override is not None:
                messages = [override]
        for message in messages:
            if message not in detail["messages"]:
                detail["messages"].append(message)
    return [
        {"path": detail["path"], "message": "; ".join(detail.pop("messages"))}
        for detail in grouped.values()
    ]


def validation_correction_paths(
    errors: list[Any], schema: dict[str, Any] | None = None
) -> tuple[list[list[Any]], bool]:
    """Locate schema-invalid fields without permitting unrelated argument edits.

    These paths are evidence for matching a corrected retry, not instructions to
    mutate the request. Ambiguous unions and whole containers cannot establish
    which nested values were wrong, so they make the result incomplete.
    """
    paths: list[list[Any]] = []
    complete = bool(errors)

    def scalar_schema(candidate: Any) -> bool:
        if not isinstance(candidate, dict):
            return False
        if "const" in candidate:
            return not isinstance(candidate["const"], (dict, list))
        if isinstance(candidate.get("enum"), list):
            return all(not isinstance(item, (dict, list)) for item in candidate["enum"])
        declared = candidate.get("type")
        if isinstance(declared, str):
            return declared in {"string", "number", "integer", "boolean", "null"}
        if isinstance(declared, list):
            return bool(declared) and all(
                item in {"string", "number", "integer", "boolean", "null"}
                for item in declared
            )
        variants = candidate.get("oneOf") or candidate.get("anyOf")
        return isinstance(variants, list) and bool(variants) and all(
            scalar_schema(variant) for variant in variants
        )

    def schema_at(path: list[Any]) -> Any:
        current: Any = schema
        for part in path:
            if not isinstance(current, dict):
                return None
            if isinstance(part, str):
                current = current.get("properties", {}).get(part)
            elif type(part) is int:
                current = current.get("items")
            else:
                return None
        return current

    def add(path: list[Any]) -> None:
        nonlocal complete
        if not path or any(
            not isinstance(part, (str, int)) or isinstance(part, bool) for part in path
        ):
            complete = False
        elif path[0] in {"project_id", "canvas_id", "project"}:
            complete = False
        elif path not in paths:
            paths.append(path)

    def visit(error: Any) -> None:
        nonlocal complete
        path = list(getattr(error, "absolute_path", ()))
        validator = getattr(error, "validator", None)
        instance = getattr(error, "instance", None)
        schema = getattr(error, "schema", None)
        if validator == "required" and isinstance(instance, dict):
            required = getattr(error, "validator_value", None)
            if not isinstance(required, list) or any(
                not isinstance(k, str) for k in required
            ):
                complete = False
                return
            missing = [key for key in required if key not in instance]
            if not missing:
                complete = False
            for key in missing:
                child_schema = (
                    schema.get("properties", {}).get(key)
                    if isinstance(schema, dict) else None
                )
                if child_schema is None:
                    child_schema = schema_at([*path, key])
                if not scalar_schema(child_schema):
                    complete = False
                add([*path, key])
            return
        if (
            validator == "additionalProperties"
            and isinstance(instance, dict)
            and isinstance(schema, dict)
        ):
            properties = schema.get("properties", {})
            patterns = schema.get("patternProperties", {})
            if not isinstance(properties, dict) or not isinstance(patterns, dict):
                complete = False
                return
            try:
                extra = [
                    key for key in instance
                    if key not in properties
                    and not any(re.search(pattern, key) for pattern in patterns)
                ]
            except (TypeError, re.error):
                complete = False
                return
            if not extra:
                complete = False
            for key in extra:
                if isinstance(instance[key], (dict, list)):
                    complete = False
                add([*path, key])
            return
        if validator in {"oneOf", "anyOf"}:
            variants = getattr(error, "validator_value", None)
            contexts = list(getattr(error, "context", ()) or ())
            if isinstance(instance, dict) and isinstance(variants, list):
                for discriminator in ("op", "kind", "type"):
                    if discriminator not in instance:
                        continue
                    matches = []
                    discriminated = True
                    for index, variant in enumerate(variants):
                        prop = (
                            variant.get("properties", {}).get(discriminator, {})
                            if isinstance(variant, dict) else {}
                        )
                        if not isinstance(prop, dict) or not (
                            "const" in prop or isinstance(prop.get("enum"), list)
                        ):
                            discriminated = False
                            break
                        if (
                            "const" in prop and prop["const"] == instance[discriminator]
                        ) or (
                            isinstance(prop.get("enum"), list)
                            and instance[discriminator] in prop["enum"]
                        ):
                            matches.append(index)
                    if discriminated and len(matches) == 1:
                        children = [
                            child for child in contexts
                            if child.schema_path and child.schema_path[0] == matches[0]
                        ]
                        if children:
                            for child in children:
                                visit(child)
                            return
            # A scalar rejected by a union may require an entire object or
            # array as its replacement. Such a retry cannot be matched safely
            # by the scalar-only correction policy.
            if not isinstance(instance, (dict, list)) and scalar_schema(schema):
                add(path)
                return
            complete = False
            return
        # Restrict matching to individual fields. Replacing an entire list or
        # object may silently alter valid elements that were never diagnosed.
        if validator in {
            "type", "enum", "const", "format", "pattern", "minLength", "maxLength",
            "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
        } and not isinstance(instance, (dict, list)) and scalar_schema(schema):
            add(path)
            return
        complete = False

    for error in errors:
        visit(error)
    return paths, complete and bool(paths)


def _format_schema_path(parts: list[Any]) -> str:
    path = ""
    for part in parts:
        if isinstance(part, int):
            path += f"[{part}]"
        elif path:
            path += f".{part}"
        else:
            path = str(part)
    return path or "arguments"


def _matching_object_variants(
    schema: Any, value: dict[str, Any]
) -> list[dict[str, Any]] | None:
    """The object schemas that apply to this value, narrowing a oneOf/anyOf
    union by its type discriminator; None when that cannot be decided."""
    if not isinstance(schema, dict):
        return None
    variants = schema.get("oneOf") or schema.get("anyOf")
    if not isinstance(variants, list):
        variants = [schema]
    matching = []
    for variant in variants:
        if not isinstance(variant, dict):
            return None
        discriminator = (variant.get("properties") or {}).get("type")
        allowed = discriminator.get("enum") if isinstance(discriminator, dict) else None
        if isinstance(allowed, list) and value.get("type") not in allowed:
            continue
        matching.append(variant)
    return matching or None


def _closed_object_fields(schema: Any, value: dict[str, Any]) -> set[str] | None:
    """Fields a closed object schema allows for this value, or None if unknown.

    Open schemas, or unions with no matching variant, are never judged.
    """
    matching = _matching_object_variants(schema, value)
    if matching is None or any(
        variant.get("additionalProperties") is not False
        or not isinstance(variant.get("properties"), dict)
        for variant in matching
    ):
        return None
    return {field for variant in matching for field in variant["properties"]}


def _unexpected_argument_fields(
    schema: dict[str, Any], arguments: Any
) -> list[dict[str, Any]]:
    """Fields no schema variant allows, by path, for a provable retry (#686).

    Dropping exactly these fields is the only structural correction the chat
    service accepts as the same call when the agent retries a rejection.
    Covers the top-level arguments and objects inside top-level arrays.
    """
    if not isinstance(arguments, dict):
        return []
    found: list[dict[str, Any]] = []
    allowed = _closed_object_fields(schema, arguments)
    if allowed is not None and set(arguments) - allowed:
        found.append({"path": [], "fields": sorted(set(arguments) - allowed)})
    properties = schema.get("properties") if isinstance(schema, dict) else None
    for key, value in arguments.items():
        property_schema = (properties or {}).get(key)
        if not isinstance(value, list) or not isinstance(property_schema, dict):
            continue
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            allowed = _closed_object_fields(property_schema.get("items"), item)
            if allowed is not None and set(item) - allowed:
                found.append(
                    {"path": [key, index], "fields": sorted(set(item) - allowed)}
                )
    return found


_ASCII_INTEGER_STRING = re.compile(r"-?[0-9]+", re.ASCII)


def _declares_integer(schema: Any) -> bool:
    if not isinstance(schema, dict):
        return False
    declared = schema.get("type")
    types = declared if isinstance(declared, list) else [declared]
    return "integer" in types and "string" not in types


def _integer_string_argument_paths(schema: Any, value: Any) -> list[list[Any]]:
    """Paths the schema declares integer but that hold a numeric string (#686).

    Coercing exactly these values is the only value correction the chat
    service accepts as the same call on retry. Open objects such as node data
    declare nothing, so their contents are never coerced.
    """
    found: list[list[Any]] = []
    if isinstance(value, list) and isinstance(schema, dict):
        for index, item in enumerate(value):
            for path in _integer_string_argument_paths(schema.get("items"), item):
                found.append([index, *path])
        return found
    if not isinstance(value, dict):
        return found
    matching = _matching_object_variants(schema, value)
    if matching is None:
        return found
    for key, item in value.items():
        property_schemas = [
            (variant.get("properties") or {}).get(key) for variant in matching
        ]
        # Every applicable variant must agree, or the type is not provable.
        if any(not isinstance(candidate, dict) for candidate in property_schemas):
            continue
        if all(_declares_integer(candidate) for candidate in property_schemas):
            if isinstance(item, str) and _ASCII_INTEGER_STRING.fullmatch(item):
                found.append([key])
            continue
        if len(property_schemas) == 1:
            for path in _integer_string_argument_paths(property_schemas[0], item):
                found.append([key, *path])
    return found


def _schema_validation_diagnostic(
    exc: SchemaError | ValidationError,
) -> tuple[str, str]:
    parts = list(getattr(exc, "absolute_path", ()))
    if isinstance(exc, ValidationError) and exc.validator in {"oneOf", "anyOf"}:
        instance = exc.instance
        variants = exc.validator_value
        if (
            isinstance(instance, dict)
            and "type" not in instance
            and isinstance(variants, list)
            and variants
            and all(
                isinstance(variant, dict) and "type" in variant.get("required", [])
                for variant in variants
            )
        ):
            path = _format_schema_path([*parts, "type"])
            return path, f"{path}: field is required"

    path = _format_schema_path(parts)
    return path, getattr(exc, "message", str(exc))


def base_validation_error_payload(
    name: str,
    arguments: dict[str, Any],
    schema: dict[str, Any],
    exc: SchemaError | ValidationError,
    errors: list[Any],
) -> dict[str, Any]:
    path, message = _schema_validation_diagnostic(exc)
    unexpected = _unexpected_argument_fields(schema, arguments)
    integer_strings = _integer_string_argument_paths(schema, arguments)
    return {
        "ok": False,
        "error": "tool_arguments_invalid",
        "tool_name": name,
        "message": message,
        "path": path,
        "status": "tool_arguments_invalid",
        "phase": "tool_validation",
        "retryable": False,
        "next_action": "检查错误字段后再重试",
        **({"unexpected_fields": unexpected} if unexpected else {}),
        **({"integer_string_fields": integer_strings} if integer_strings else {}),
    }


STORY_WRITE_TOOLS = frozenset(
    {
        "dramaclaw_create_interactive_story",
        "dramaclaw_patch_interactive_story",
        "dramaclaw_save_interactive_story_outline",
        "dramaclaw_confirm_interactive_story_outline",
        "dramaclaw_confirm_interactive_story_stages",
    }
)


def _validation_message(error: Any) -> str | None:
    path = ".".join(str(part) for part in getattr(error, "absolute_path", ()))
    if (
        path.endswith(".feedback_text")
        and error.validator == "const"
        and error.validator_value == ""
    ):
        return "Automatic transition feedback_text must be empty. Keep effects unchanged; automatic transitions may apply effects."
    return None


def story_validation_error_details(errors: list[Any]) -> list[dict[str, Any]]:
    return validation_error_details(errors, _validation_message)


def validation_error_payload(
    name: str,
    arguments: dict[str, Any],
    schema: dict[str, Any],
    exc: SchemaError | ValidationError,
    errors: list[Any],
) -> dict[str, Any]:
    payload = base_validation_error_payload(name, arguments, schema, exc, errors)
    if name in STORY_WRITE_TOOLS:
        details = story_validation_error_details(errors)
        correction_paths, complete = validation_correction_paths(errors, schema)
        payload.update(
            {
                "message": f"{len(details)} argument validation error(s); first at {details[0]['path'] or '<root>'}: {details[0]['message']}",
                "path": ".".join(
                    str(part) for part in getattr(exc, "absolute_path", ())
                ),
                "details": details,
                "invalid_argument_paths": correction_paths,
                "argument_corrections_complete": complete,
                "retryable": complete,
                "next_action": (
                    "仅修正 invalid_argument_paths 列出的字段，保留其他字段；读取最新 revision 后最多重试一次"
                    if complete else "校验错误无法安全定位；不要猜测或自动重试"
                ),
                "agent_instruction": (
                    "The story write was rejected before execution. If argument_corrections_complete is true, "
                    "correct only invalid_argument_paths and preserve all other arguments including effects. "
                    "Re-read the current canvas or story as appropriate, then retry once with the latest revision "
                    "and a new idempotency key. If corrections are incomplete or the retry fails, report the "
                    "error and stop without another write."
                ),
            }
        )
    return payload


def validate_arguments(name: str, arguments: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any] | None:
    """Validate one story tool call before its native handler executes."""
    errors: list[Any] = []
    try:
        Draft202012Validator.check_schema(schema)
        errors = sorted(
            Draft202012Validator(schema).iter_errors(arguments),
            key=lambda error: tuple(
                (0, part) if isinstance(part, int) else (1, str(part))
                for part in getattr(error, "absolute_path", ())
            ),
        )
        if errors:
            raise errors[0]
    except (SchemaError, ValidationError) as exc:
        return validation_error_payload(name, arguments, schema, exc, errors or [exc])
    return None
