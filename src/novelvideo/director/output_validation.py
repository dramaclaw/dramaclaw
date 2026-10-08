"""Explain a paid result's contract failure without exposing exception inputs.

ValidationError's default string embeds model text, which can include private
source material. A small typed receipt is enough to find the faulty field; the
full response stays in the explicitly opened, authenticated result viewer.
"""

from __future__ import annotations

import json
import re

from pydantic import ValidationError


class OutputContractError(ValueError):
    def __init__(self, code: str, path: str):
        super().__init__(code)
        self.code, self.path = code, path


def parse_model_json(raw: str) -> dict:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise OutputContractError("OUTLINE_DUPLICATE_JSON_KEY", "$")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=unique)


def validation_receipt(error: Exception) -> dict:
    if isinstance(error, OutputContractError):
        return {"kind": "contract", "issueCount": 1, "issues": [{"path": error.path, "code": error.code}]}
    if isinstance(error, ValidationError):
        failures = error.errors(include_input=False, include_context=False, include_url=False)
        issues = []
        for failure in failures[:20]:
            path = ".".join(
                str(part) if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(part)) else "?"
                for part in failure["loc"]
            )
            # Cross-field validators are absent from generated JSON Schema.
            # Preserve only host-authored uppercase error codes, never input.
            context = error.errors(include_input=False, include_url=False)[len(issues)].get("ctx", {})
            rule = str(context.get("error", ""))
            code = rule if re.fullmatch(r"[A-Z][A-Z0-9_]{3,80}", rule) else failure["type"]
            issues.append({"path": path[:240] or "$", "code": code})
        return {"kind": "schema", "issueCount": len(failures), "issues": issues}
    if isinstance(error, json.JSONDecodeError):
        return {"kind": "json", "issueCount": 1, "issues": [
            {"path": f"line:{error.lineno}:column:{error.colno}", "code": "INVALID_JSON"},
        ]}
    message = str(error)
    code = message if re.fullmatch(r"(?:OUTLINE|PLANNING)_[A-Z_]{1,60}", message) else "CONTRACT_MISMATCH"
    return {"kind": "contract", "issueCount": 1, "issues": [{"path": "$", "code": code}]}
