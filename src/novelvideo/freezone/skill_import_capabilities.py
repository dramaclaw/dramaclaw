"""Offline product contracts and non-executing candidate workflow checks."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any

from jsonschema import Draft202012Validator

from novelvideo.freezone.agent_workflows.graph import (
    LINK_OBJECT_TYPE_BY_NODE_TYPE,
    LINK_TYPE_RULES,
    build_workflow_graph_commands,
)
from novelvideo.freezone.workflow_plan import (
    MAX_WORKFLOW_EDGES,
    MAX_WORKFLOW_NODES,
    MAX_WORKFLOW_PLANNING_TEXT_CHARS,
    validate_workflow_plan,
)
from novelvideo.freezone.workflow_schema import (
    LINK_TYPE_VALUES,
    NODE_TYPE_VALUES,
    workflow_plan_json_schema,
)

CAPABILITY_SCHEMA_VERSION = "freezone_skill_import_capabilities.v1"
_MAX_ERRORS = 30


def snapshot_capabilities() -> dict[str, Any]:
    """Return stable portable capabilities; no account/provider discovery or I/O."""
    snapshot: dict[str, Any] = {
        "schema_version": CAPABILITY_SCHEMA_VERSION,
        "sources": [
            "novelvideo.freezone.workflow_schema",
            "novelvideo.freezone.workflow_plan",
            "novelvideo.freezone.agent_workflows.graph",
        ],
        "node_types": {node_type: {"object_type": LINK_OBJECT_TYPE_BY_NODE_TYPE[node_type]}
                       for node_type in NODE_TYPE_VALUES},
        "link_types": list(LINK_TYPE_VALUES),
        "node_object_types": dict(LINK_OBJECT_TYPE_BY_NODE_TYPE),
        "link_rules": {
            kind: {"source_object_types": sorted(rule[0]),
                   "target_object_types": sorted(rule[1])}
            for kind, rule in sorted(LINK_TYPE_RULES.items())
        },
        "models": {
            "availability": "unknown",
            "scope": "offline portable contract; live provider catalog not queried",
            "selection_field": "nodes[].data.model",
            "instructions": (
                "Do not invent supported model IDs or infer availability from aliases. "
                "Omit an unverified model selection and record the requirement as unresolved. "
                "Live canvas node schemas determine model availability, sizes, ratios, "
                "duration limits and provider-specific options at runtime."
            ),
        },
        "limits": {"nodes": MAX_WORKFLOW_NODES, "edges": MAX_WORKFLOW_EDGES,
                   "planning_text_chars": MAX_WORKFLOW_PLANNING_TEXT_CHARS},
        "plan_schema": workflow_plan_json_schema(),
        "planner_contract": {
            "output": "Return an object with a plan field matching plan_schema.",
            "mode": "agent_authored_topology",
            "candidate_catalog_only": True,
            "representative_scenarios": (
                "Produce the complete topology required for the provided scenario using the "
                "candidate catalog, including source-media anchors and composition when needed. "
                "Use scenario-specific inputs; do not substitute an unrelated minimal graph."
            ),
            "confirmed_inputs": (
                "plan.inputs and workflowCatalog.confirmedInputs contain input values; "
                "workflow dependencies must be declared as edges, not embedded references."
            ),
        },
        "instructions": [
            "Generate representative complete WorkflowPlans against the candidate Skill and Recipes. "
            "Use the candidate skill.id at plan.skill.id; select allowed recipe IDs explicitly "
            "in each executable node's data.workflowCatalog.recipeId.",
            "Node IDs are local logical references. All edges and groups reference those IDs. "
            "Use one connected acyclic graph; no dangling, duplicate or self edges.",
            "Recipe output_kind must match its node: text for textual nodes, image for "
            "imageGenNode, video for videoNode, audio for audioNode. Ordered recipePipeline "
            "entries must be allowed, output-compatible and non-conflicting; pinned versions must match.",
            "Input/resource text uses textAnnotationNode with stage input, resource or asset "
            "and no Recipe. Generated nodes require Recipes. Put stage on the node, not data.",
            "A Recipe requiring source media needs an incoming media_input_for or derived_from "
            "edge from media, or existing media in referenceImageUrl/sourceUrl/audioUrl/videoUrl/"
            "referenceUrls. Text prompt or dependency edges alone do not supply media. "
            "Generate a source anchor with a suitable non-source-dependent Recipe when needed.",
            "Final composition uses at most one terminal videoComposeNode without a Recipe, "
            "with at least one videoNode input. All incoming edges use composition_input_for.",
            "Only the listed native nodes/links are executable. Branches, loops, shell commands, "
            "external tools and approval gates are not implied by descriptive stages. "
            "Preserve unsupported requirements as unresolved constraints instead of claiming execution.",
            "Do not include run_after_create. These plans are static compatibility checks; "
            "they do not execute media, install a Skill, verify provider availability or prove output quality.",
        ],
    }
    snapshot["capability_hash"] = hashlib.sha256(
        json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return snapshot


def _failure(errors: list[str], status: str) -> dict[str, Any]:
    return {"status": "failed", "errors": errors[:_MAX_ERRORS],
            "validation_status": status, "model_availability": "unknown"}


def validate_candidate_plan(bundle: dict, plan: dict) -> dict[str, Any]:
    """Validate candidate-only refs then compile commands in memory, never execute them.

    Bundle structure/security validation remains the importer's responsibility.
    No global catalog is modified or consulted, including for reused Recipes:
    those must be present in the candidate bundle.
    """
    if not isinstance(bundle, dict) or not isinstance(bundle.get("skill"), dict):
        return _failure(["bundle.skill must be an object"], "invalid_candidate_catalog")
    skill = bundle["skill"]
    if not isinstance(skill.get("id"), str) or not skill["id"]:
        return _failure(["bundle.skill.id must be a non-empty string"], "invalid_candidate_catalog")
    raw_recipes = bundle.get("recipes", [])
    if not isinstance(raw_recipes, list):
        return _failure(["bundle.recipes must be an array"], "invalid_candidate_catalog")
    recipes: dict[str, dict] = {}
    for recipe in raw_recipes:
        if (not isinstance(recipe, dict) or not isinstance(recipe.get("id"), str)
                or not recipe["id"] or recipe["id"] in recipes):
            return _failure(["candidate Recipes require unique non-empty IDs"], "invalid_candidate_catalog")
        recipes[recipe["id"]] = recipe

    # The semantic validator expects schema-safe references (e.g. hashable IDs).
    schema_errors = []
    for error in Draft202012Validator(workflow_plan_json_schema()).iter_errors(plan):
        location = ".".join(str(part) for part in error.absolute_path) or "$"
        schema_errors.append(f"{location}: {error.message[:1200]}")
        if len(schema_errors) >= _MAX_ERRORS:
            break
    if schema_errors:
        return _failure(schema_errors, "invalid_plan_schema")

    checked_plan = deepcopy(plan)
    # Resolve omitted node skill IDs to the plan's Skill so the existing validator
    # also enforces membership for references that only specify recipeId.
    for node in checked_plan["nodes"]:
        catalog = node.get("data", {}).get("workflowCatalog")
        if isinstance(catalog, dict):
            catalog.setdefault("skillId", checked_plan["skill"]["id"])
    validation = validate_workflow_plan(
        checked_plan, skills_by_id={skill["id"]: skill}, recipes_by_id=recipes
    )
    if not validation["ok"]:
        return _failure([
            f"{issue.get('path', '$')}: {issue['message']}"
            for issue in validation.get("errors", [])
        ], validation["status"])
    compiled = build_workflow_graph_commands({"plan": checked_plan, "run_after_create": False})
    if not compiled.get("ok") or compiled.get("skipped_edges"):
        errors = [str(issue.get("message", issue)) for issue in compiled.get("errors", [])]
        errors.append(str(compiled.get("error") or "graph compilation failed or skipped edges"))
        return _failure(errors, compiled["status"])
    return {
        "status": "passed", "errors": [], "validation_status": validation["status"],
        "model_availability": "unknown", "preflight": validation.get("preflight", {}),
        "compilation": {
            "status": compiled["status"], "node_count": validation["node_count"],
            "edge_count": validation["edge_count"],
            "command_count": len(compiled["commands"]), "execution_requested": False,
        },
    }
