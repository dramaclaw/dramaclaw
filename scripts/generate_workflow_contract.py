#!/usr/bin/env python3
"""Generate language-specific Workflow contract constants from one JSON source."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from pprint import pformat

import black

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "schemas" / "workflow" / "v1" / "stable-contract.json"
PYTHON_TARGET = (
    ROOT / "src" / "novelvideo" / "freezone" / "workflow_contract_generated.py"
)
TYPESCRIPT_TARGET = (
    ROOT
    / "frontend"
    / "src"
    / "features"
    / "freezone"
    / "generated"
    / "workflowContract.ts"
)
MCP_TARGET = ROOT / "src" / "novelvideo" / "chat" / "workflow_contract.generated.json"


def _validate_source(payload: dict) -> None:
    required_keys = {
        "schema_version",
        "workflow_plan_schema_version",
        "workflow_intent_schema_version",
        "workflow_node_types",
        "agent_creatable_node_types",
        "link_types",
        "generation_action_types",
        "model_aliases_by_node_type",
        "recipe_envelope",
    }
    missing = sorted(required_keys - payload.keys())
    if missing:
        raise ValueError(f"Workflow contract source is missing: {', '.join(missing)}")
    for key in (
        "workflow_node_types",
        "agent_creatable_node_types",
        "link_types",
        "generation_action_types",
    ):
        values = payload[key]
        if (
            not isinstance(values, list)
            or not values
            or not all(isinstance(value, str) and value for value in values)
        ):
            raise ValueError(f"{key} must be a non-empty string array")
        if len(values) != len(set(values)):
            raise ValueError(f"{key} contains duplicates")
    creatable = set(payload["agent_creatable_node_types"])
    if not set(payload["workflow_node_types"]).issubset(creatable):
        raise ValueError("workflow_node_types must be agent-creatable")
    aliases = payload["model_aliases_by_node_type"]
    if not isinstance(aliases, dict) or not set(aliases).issubset(creatable):
        raise ValueError("model alias node types must be agent-creatable")
    recipe = payload["recipe_envelope"]
    if not isinstance(recipe, dict) or not recipe.get("required"):
        raise ValueError("recipe_envelope.required must be defined")


def _source() -> tuple[dict, str]:
    raw = SOURCE.read_bytes()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Workflow contract source must be a JSON object")
    _validate_source(payload)
    return payload, hashlib.sha256(raw).hexdigest()


def _python(payload: dict, digest: str) -> str:
    def literal(value: object) -> str:
        return pformat(value, width=88, sort_dicts=False)

    source = "\n".join(
        [
            '"""Generated from schemas/workflow/v1/stable-contract.json; do not edit."""',
            "",
            f'SOURCE_SHA256 = "{digest}"',
            f'WORKFLOW_CONTRACT_SCHEMA_VERSION = {literal(payload["schema_version"])}',
            f'WORKFLOW_PLAN_SCHEMA_VERSION = {literal(payload["workflow_plan_schema_version"])}',
            f'WORKFLOW_INTENT_SCHEMA_VERSION = {literal(payload["workflow_intent_schema_version"])}',
            f'WORKFLOW_NODE_TYPES = {literal(payload["workflow_node_types"])}',
            f'AGENT_CREATABLE_NODE_TYPES = {literal(payload["agent_creatable_node_types"])}',
            f'WORKFLOW_LINK_TYPES = {literal(payload["link_types"])}',
            f'GENERATION_ACTION_TYPES = {literal(payload["generation_action_types"])}',
            f'MODEL_ALIASES_BY_NODE_TYPE = {literal(payload["model_aliases_by_node_type"])}',
            f'RECIPE_ENVELOPE_CONTRACT = {literal(payload["recipe_envelope"])}',
            "",
        ]
    )
    return black.format_str(source, mode=black.Mode(line_length=100))


def _typescript(payload: dict, digest: str) -> str:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    return "\n".join(
        [
            "// Generated from schemas/workflow/v1/stable-contract.json; do not edit.",
            f'export const WORKFLOW_CONTRACT_SOURCE_SHA256 = "{digest}";',
            f"export const WORKFLOW_STABLE_CONTRACT = {rendered} as const;",
            "export const WORKFLOW_AGENT_CREATABLE_NODE_TYPES =",
            "  WORKFLOW_STABLE_CONTRACT.agent_creatable_node_types;",
            "export const WORKFLOW_NODE_TYPES = WORKFLOW_STABLE_CONTRACT.workflow_node_types;",
            "export const WORKFLOW_LINK_TYPES = WORKFLOW_STABLE_CONTRACT.link_types;",
            "export const WORKFLOW_GENERATION_ACTION_TYPES =",
            "  WORKFLOW_STABLE_CONTRACT.generation_action_types;",
            "",
        ]
    )


def _mcp(payload: dict, digest: str) -> str:
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://dramaclaw.com/schemas/workflow/v1/stable-contract.json",
        "x-source-sha256": digest,
        "title": "DramaClaw Workflow stable MCP contract",
        "type": "object",
        "properties": {
            "schema_version": {"const": payload["workflow_plan_schema_version"]},
            "node_type": {"enum": payload["workflow_node_types"]},
            "link_type": {"enum": payload["link_types"]},
            "action": {"enum": payload["generation_action_types"]},
        },
    }
    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def generated_outputs() -> dict[Path, str]:
    payload, digest = _source()
    return {
        PYTHON_TARGET: _python(payload, digest),
        TYPESCRIPT_TARGET: _typescript(payload, digest),
        MCP_TARGET: _mcp(payload, digest),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale: list[Path] = []
    for path, expected in generated_outputs().items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != expected:
                stale.append(path.relative_to(ROOT))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(expected, encoding="utf-8")
    if stale:
        print("Workflow contract generated files are stale:")
        for path in stale:
            print(f"- {path}")
        print("Run: python3 scripts/generate_workflow_contract.py")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
