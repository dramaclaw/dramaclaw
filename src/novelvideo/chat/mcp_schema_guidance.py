"""Keep schema constraints readable when MCP hosts strip validation keywords."""

from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

# Codex preserves descriptions but its tool schema type omits these validators.
_DESCRIPTION_CONSTRAINTS = frozenset(
    {
        "if",
        "then",
        "else",
        "not",
        "minLength",
        "maxLength",
        "pattern",
        "format",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "maxItems",
        "uniqueItems",
        "minProperties",
        "maxProperties",
        "dependentRequired",
    }
)


def schema_with_guidance(schema: dict[str, Any]) -> dict[str, Any]:
    """Annotate only the advertised copy; the original remains the validator's source.

    Use JSON Schema itself as the description, rather than a lossy translation of
    conditional/default/nullable semantics. Paths remain relative to this value.
    """
    result = deepcopy(schema)
    visited: set[int] = set()

    def annotate(node: Any) -> None:
        if not isinstance(node, dict) or id(node) in visited:
            return
        visited.add(id(node))
        constraints = {
            key: value for key, value in node.items() if key in _DESCRIPTION_CONSTRAINTS
        }
        # Codex also prunes allOf fragments with no surviving structural keys;
        # attach their conditions to the enclosing value, not the pruned branch.
        conditional = [
            child
            for child in node.get("allOf", [])
            if isinstance(child, dict) and _DESCRIPTION_CONSTRAINTS.intersection(child)
        ]
        if conditional:
            constraints["allOf"] = conditional
        if constraints:
            hint = (
                "Server constraints (JSON Schema, relative to this value): "
                + json.dumps(constraints, ensure_ascii=False, separators=(",", ":"))
            )
            description = node.get("description", "")
            if not description.endswith(hint):
                node["description"] = "\n".join(filter(None, [description, hint]))
        for key in ("properties", "$defs", "definitions", "patternProperties"):
            for child in node.get(key, {}).values():
                annotate(child)
        for key in ("items", "additionalProperties"):
            annotate(node.get(key))
        for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            for child in node.get(key, []):
                if key != "allOf" or child not in conditional:
                    annotate(child)

    annotate(result)
    return result
