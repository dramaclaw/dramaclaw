"""JSON mode alone does not enforce required fields or forbid invented fields.

Only enable decoding constraints on the two Agent Plan routes verified with
real probes. The same host schema still validates the raw response afterwards;
provider support cannot prove story facts or cross-reference integrity.
"""

from __future__ import annotations

from copy import deepcopy

STRICT_MODELS = frozenset({"ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"})


def decoder_schema(schema: dict) -> dict:
    """Keep search-style nonblank checks equivalent under full-match decoders.

    Pydantic's pattern=\\S accepts any text containing a nonspace character.
    A grammar decoder may instead match the whole string, forcing one character.
    This is a semantic-preserving adapter, not removal of host constraints.
    """
    result = deepcopy(schema)

    def visit(value):
        if isinstance(value, dict):
            if value.get("pattern") == r"\S":
                value["pattern"] = r"[\s\S]*\S[\s\S]*"
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(result)
    return result


def response_format(model: str, schema: dict, *, name: str) -> dict:
    if model not in STRICT_MODELS:
        return {"type": "json_object"}
    return {"type": "json_schema", "json_schema": {
        "name": name, "strict": True, "schema": decoder_schema(schema),
    }}
