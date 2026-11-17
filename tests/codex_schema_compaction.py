"""Test helper: Codex CLI's MCP tool input-schema pipeline, ported to Python.

Codex rewrites every MCP tool ``inputSchema`` before showing it to the model. This module
reproduces that rewrite so tests can assert what a model actually receives. It ports
Codex CLI 0.169.0 (openai/codex, ``codex-rs/tools/src``):

* ``mcp_tool.rs``: insert a root ``properties`` object when it is missing, then parse.
* ``json_schema.rs``: sanitize the schema and prune unreachable ``$defs``/``definitions``.
* ``json_schema/types.rs``: the ``JsonSchema`` struct. Only its fields survive parsing
  (``$ref``, ``type``, ``description``, ``encrypted``, ``enum``, ``items``, ``minItems``,
  ``properties``, ``required``, ``additionalProperties``, ``anyOf``, ``oneOf``,
  ``allOf``, ``$defs``, ``definitions``). Keywords such as ``minLength``, ``maximum`` or
  ``pattern`` never reach the model, whatever the budget.
* ``json_schema/compaction.rs``: the size budget (``tool_input_schema_max_bytes``,
  default 5000). Size is the byte length of the parsed schema serialized as compact
  JSON (the "normalized size" used throughout these tests). While it exceeds the budget,
  four passes run in order, each only if still needed: strip every description, drop
  definitions, collapse complex nodes at depth >= 3 to ``{}``, and replace any node with
  ``anyOf``/``oneOf``/``allOf`` by ``{}``. The third pass is the cliff: one byte over
  after descriptions are gone and every nested structure disappears at once.

The port was checked against the tool schemas Codex CLI 0.169.0 actually sent to a local
scripted Responses gateway (the method of ``tests/test_codex_schema_guidance.py``). When
Codex changes this pipeline, update the version above together with the port.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Callable

CODEX_CLI_VERSION = "0.169.0"
DEFAULT_MAX_BYTES = 5000

_MAX_DEPTH = 3
_DEF_KEYS = ("$defs", "definitions")
_CHILD_KEYS = ("items", "anyOf", "oneOf", "allOf")
_COMPOSITION_KEYS = ("anyOf", "oneOf", "allOf")
_PRIMITIVE_TYPES = ("string", "number", "boolean", "integer", "object", "array", "null")


class UnparseableSchema(ValueError):
    """The schema does not deserialize into Codex's ``JsonSchema`` struct."""


def parse_schema(value: Any) -> dict[str, Any]:
    """Return ``value`` as Codex's ``JsonSchema`` struct would serialize it back."""
    if not isinstance(value, dict):
        raise UnparseableSchema(f"schema must be an object, got {type(value).__name__}")
    out: dict[str, Any] = {}

    def present(key: str) -> Any:
        return value.get(key)

    ref = present("$ref")
    if ref is not None:
        if not isinstance(ref, str):
            raise UnparseableSchema("$ref")
        out["$ref"] = ref
    schema_type = present("type")
    if schema_type is not None:
        if isinstance(schema_type, str):
            if schema_type not in _PRIMITIVE_TYPES:
                raise UnparseableSchema("type")
        elif isinstance(schema_type, list):
            if not all(
                isinstance(t, str) and t in _PRIMITIVE_TYPES for t in schema_type
            ):
                raise UnparseableSchema("type")
        else:
            raise UnparseableSchema("type")
        out["type"] = schema_type
    description = present("description")
    if description is not None:
        if not isinstance(description, str):
            raise UnparseableSchema("description")
        out["description"] = description
    encrypted = present("encrypted")
    if encrypted is not None:
        if not isinstance(encrypted, bool):
            raise UnparseableSchema("encrypted")
        out["encrypted"] = encrypted
    enum = present("enum")
    if enum is not None:
        if not isinstance(enum, list):
            raise UnparseableSchema("enum")
        out["enum"] = enum
    items = present("items")
    if items is not None:
        out["items"] = parse_schema(items)
    min_items = present("minItems")
    if min_items is not None:
        if not (
            isinstance(min_items, int)
            and not isinstance(min_items, bool)
            and min_items >= 0
        ):
            raise UnparseableSchema("minItems")
        out["minItems"] = min_items
    properties = present("properties")
    if properties is not None:
        if not isinstance(properties, dict):
            raise UnparseableSchema("properties")
        # BTreeMap: properties serialize in key order.
        out["properties"] = {
            key: parse_schema(properties[key]) for key in sorted(properties)
        }
    required = present("required")
    if required is not None:
        if not (
            isinstance(required, list) and all(isinstance(r, str) for r in required)
        ):
            raise UnparseableSchema("required")
        out["required"] = required
    additional = present("additionalProperties")
    if additional is not None:
        out["additionalProperties"] = (
            additional if isinstance(additional, bool) else parse_schema(additional)
        )
    for key in _COMPOSITION_KEYS:
        variants = present(key)
        if variants is not None:
            if not isinstance(variants, list):
                raise UnparseableSchema(key)
            out[key] = [parse_schema(variant) for variant in variants]
    for key in _DEF_KEYS:
        definitions = present(key)
        if definitions is not None:
            if not isinstance(definitions, dict):
                raise UnparseableSchema(key)
            out[key] = {
                name: parse_schema(definitions[name]) for name in sorted(definitions)
            }
    return out


def compact_bytes(value: Any) -> int:
    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def normalized_size(value: Any) -> int:
    """Codex's size measure. An unparseable schema measures 0, as in compaction.rs."""
    try:
        return compact_bytes(parse_schema(value))
    except UnparseableSchema:
        return 0


def _types(node: dict[str, Any]) -> list[str]:
    schema_type = node.get("type")
    if isinstance(schema_type, str):
        return [schema_type] if schema_type in _PRIMITIVE_TYPES else []
    if isinstance(schema_type, list):
        return [t for t in schema_type if isinstance(t, str) and t in _PRIMITIVE_TYPES]
    return []


def _sanitize(value: Any) -> Any:
    if isinstance(value, bool):
        return {"type": "string"}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if not isinstance(value, dict):
        return value
    node = value
    if isinstance(node.get("properties"), dict):
        node["properties"] = {
            key: _sanitize(child) for key, child in node["properties"].items()
        }
    if "items" in node:
        node["items"] = _sanitize(node["items"])
    if "additionalProperties" in node and not isinstance(
        node["additionalProperties"], bool
    ):
        node["additionalProperties"] = _sanitize(node["additionalProperties"])
    if "prefixItems" in node:
        node["prefixItems"] = _sanitize(node["prefixItems"])
    for key in _COMPOSITION_KEYS:
        if key in node:
            node[key] = _sanitize(node[key])
    for key in _DEF_KEYS:
        if key in node:
            if isinstance(node[key], dict):
                node[key] = {
                    name: _sanitize(child) for name, child in node[key].items()
                }
            else:
                del node[key]
    if "const" in node:
        node["enum"] = [node.pop("const")]
    types = _types(node)
    if not types and ("$ref" in node or any(key in node for key in _COMPOSITION_KEYS)):
        return node
    if not types:
        if any(
            key in node for key in ("properties", "required", "additionalProperties")
        ):
            types = ["object"]
        elif "items" in node or "prefixItems" in node:
            types = ["array"]
        elif "enum" in node or "format" in node:
            types = ["string"]
        elif any(
            key in node
            for key in (
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
            )
        ):
            types = ["number"]
        else:
            node.clear()
            return node
    node["type"] = types[0] if len(types) == 1 else types
    if "object" in types and "properties" not in node:
        node["properties"] = {}
    if "array" in types and "items" not in node:
        node["items"] = {"type": "string"}
    return node


def _local_ref(ref: Any) -> tuple[str, str] | None:
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    parts = ref[2:].split("/")
    if len(parts) < 2 or parts[0] not in _DEF_KEYS:
        return None
    return parts[0], parts[1].replace("~1", "/").replace("~0", "~")


def _children(node: dict[str, Any], *, include_definitions: bool) -> list[Any]:
    children: list[Any] = []
    if isinstance(node.get("properties"), dict):
        children += list(node["properties"].values())
    for key in _CHILD_KEYS:
        if key in node:
            children.append(node[key])
    if "additionalProperties" in node and not isinstance(
        node["additionalProperties"], bool
    ):
        children.append(node["additionalProperties"])
    if include_definitions:
        for key in _DEF_KEYS:
            if isinstance(node.get(key), dict):
                children += list(node[key].values())
    return children


def _prune_unreachable_definitions(root: Any) -> None:
    if not isinstance(root, dict):
        return
    pending: list[tuple[str, str]] = []
    reachable: set[tuple[str, str]] = set()

    def refs_outside_definitions(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                refs_outside_definitions(item)
        elif isinstance(value, dict):
            if ref := _local_ref(value.get("$ref")):
                pending.append(ref)
            for child in _children(value, include_definitions=False):
                refs_outside_definitions(child)

    def all_refs(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                all_refs(item)
        elif isinstance(value, dict):
            if ref := _local_ref(value.get("$ref")):
                pending.append(ref)
            for child in value.values():
                all_refs(child)

    refs_outside_definitions(root)
    while pending:
        ref = pending.pop()
        if ref in reachable:
            continue
        reachable.add(ref)
        definitions = root.get(ref[0])
        if (
            isinstance(definitions, dict)
            and (target := definitions.get(ref[1])) is not None
        ):
            all_refs(target)
    for key in _DEF_KEYS:
        if isinstance(root.get(key), dict):
            root[key] = {
                name: d for name, d in root[key].items() if (key, name) in reachable
            }
            if not root[key]:
                del root[key]


def _map_children(node: dict[str, Any], fn: Callable[[Any], Any]) -> None:
    if isinstance(node.get("properties"), dict):
        for key in list(node["properties"]):
            node["properties"][key] = fn(node["properties"][key])
    for key in _CHILD_KEYS:
        if key in node:
            node[key] = fn(node[key])
    if "additionalProperties" in node and not isinstance(
        node["additionalProperties"], bool
    ):
        node["additionalProperties"] = fn(node["additionalProperties"])


def _strip_descriptions(value: Any) -> Any:
    if isinstance(value, list):
        for item in value:
            _strip_descriptions(item)
    elif isinstance(value, dict):
        value.pop("description", None)
        for child in _children(value, include_definitions=True):
            _strip_descriptions(child)
    return value


def _drop_definitions(root: Any) -> Any:
    def rewrite(value: Any) -> Any:
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            if _local_ref(value.get("$ref")):
                return {}
            _map_children(value, rewrite)
        return value

    root = rewrite(root)
    if isinstance(root, dict):
        for key in _DEF_KEYS:
            root.pop(key, None)
    return root


def _is_complex(node: dict[str, Any]) -> bool:
    return any(key in node for key in _CHILD_KEYS) or any(
        key in node for key in ("properties", "additionalProperties", "$ref")
    )


def _collapse_deep(value: Any, depth: int = 0) -> Any:
    if isinstance(value, list):
        return [_collapse_deep(item, depth) for item in value]
    if isinstance(value, dict):
        if depth >= _MAX_DEPTH and _is_complex(value):
            return {}
        _map_children(value, lambda child: _collapse_deep(child, depth + 1))
    return value


def _prune_compositions(value: Any) -> Any:
    if isinstance(value, list):
        return [_prune_compositions(item) for item in value]
    if isinstance(value, dict):
        if any(key in value for key in _COMPOSITION_KEYS):
            return {}
        _map_children(value, _prune_compositions)
    return value


COMPACTION_PASSES: tuple[tuple[str, Callable[[Any], Any]], ...] = (
    ("strip_descriptions", _strip_descriptions),
    ("drop_definitions", _drop_definitions),
    ("collapse_depth_3", _collapse_deep),
    ("prune_compositions", _prune_compositions),
)


def prepare(input_schema: dict[str, Any]) -> dict[str, Any]:
    """Codex's preparation before any budget is applied (no information is lost here
    except keywords the ``JsonSchema`` struct does not carry)."""
    value = copy.deepcopy(input_schema)
    if value.get("properties") is None:
        value["properties"] = {}
    value = _sanitize(value)
    _prune_unreachable_definitions(value)
    return value


def codex_tool_parameters(
    input_schema: dict[str, Any],
    max_bytes: int = DEFAULT_MAX_BYTES,
    trace: list[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    """Return the ``parameters`` Codex sends to the model for this ``inputSchema``."""
    value: Any = prepare(input_schema)
    if trace is not None:
        trace.append(("prepared", normalized_size(value)))
    for name, compaction_pass in COMPACTION_PASSES:
        if normalized_size(value) <= max_bytes:
            break
        value = compaction_pass(value)
        if trace is not None:
            trace.append((name, normalized_size(value)))
    return parse_schema(value)


def prepared_size(input_schema: dict[str, Any]) -> int:
    """Normalized size Codex compares against ``tool_input_schema_max_bytes``."""
    return normalized_size(prepare(input_schema))
