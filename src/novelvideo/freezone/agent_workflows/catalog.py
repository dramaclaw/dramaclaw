"""Resolve Workflow Skills and validate agent-authored dynamic workflow plans."""

from __future__ import annotations

import json
import math
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from pathlib import Path
from typing import Any

from novelvideo.freezone.workflow_schema import (
    WORKFLOW_INTENT_SCHEMA_VERSION,
    WORKFLOW_PLAN_SCHEMA_VERSION,
)

try:
    from novelvideo.freezone.agent_config_store import list_user_agent_config_items
except Exception:  # pragma: no cover - Hermes can run before app imports are available.
    list_user_agent_config_items = None

try:
    from novelvideo.freezone.workflow_plan import (
        ALLOWED_LINK_TYPES,
        ALLOWED_NODE_TYPES,
        _build_plan_preflight,
        validate_workflow_plan,
    )
except Exception:  # pragma: no cover - Hermes can run before app imports are available.
    validate_workflow_plan = None
    _build_plan_preflight = None
    ALLOWED_LINK_TYPES = set()
    ALLOWED_NODE_TYPES = set()

_REQUEST_CATALOG: ContextVar[dict[str, list[dict[str, Any]]] | None] = ContextVar(
    "workflow_request_catalog", default=None
)


@contextmanager
def workflow_catalog_scope(username: str):
    """Use one authenticated catalog snapshot without changing process environment."""
    if not username.strip() or list_user_agent_config_items is None:
        raise ValueError("workflow catalog identity is unavailable")
    snapshot = {
        kind: _normalize_agent_config_items(
            kind, list_user_agent_config_items(username, kind)
        )
        for kind in ("skills", "recipes")
    }
    token = _REQUEST_CATALOG.set(snapshot)
    try:
        yield
    finally:
        _REQUEST_CATALOG.reset(token)


PLAN_SCHEMA_VERSION = WORKFLOW_PLAN_SCHEMA_VERSION

_ROOT = Path(__file__).resolve().parents[4]
_CATALOG_ROOT = _ROOT / "src" / "novelvideo" / "freezone" / "agent_catalog" / "builtins"
_SKILLS_DIR = _CATALOG_ROOT / "skills"
_RECIPES_DIR = _CATALOG_ROOT / "recipes"
# Compatibility overlay for legacy installations and project-local catalog
# extensions. Built-in shared catalog data lives under
# ``src/novelvideo/freezone/agent_catalog`` and no longer depends on Hermes.
_PLUGIN_CATALOG_ROOT = _ROOT / ".hermes" / "plugins" / "freezone" / "catalog"
_PLUGIN_SKILLS_DIR = _PLUGIN_CATALOG_ROOT / "skills"
_PLUGIN_RECIPES_DIR = _PLUGIN_CATALOG_ROOT / "recipes"

_NODE_TYPE_BY_OUTPUT_KIND = {
    "text": "textAnnotationNode",
    "image": "imageGenNode",
    "video": "videoNode",
    "audio": "audioNode",
}

_STAGE_BY_NODE_TYPE = {
    "textAnnotationNode": "story",
    "scriptNode": "story",
    "beatContextNode": "beat",
    "imageGenNode": "image",
    "videoNode": "video",
    "audioNode": "audio",
    "videoComposeNode": "compose",
    "htmlArtifactNode": "html",
}

_CAPABILITY_BY_NODE_TYPE = {
    "textAnnotationNode": "textGeneration",
    "scriptNode": "textGeneration",
    "beatContextNode": "textGeneration",
    "imageGenNode": "imageGeneration",
    "videoNode": "videoGeneration",
    "audioNode": "audioGeneration",
    "videoComposeNode": "videoCompose",
    "htmlArtifactNode": "textGeneration",
}

_OUTPUT_KIND_BY_CAPABILITY = {
    "textGeneration": "text",
    "imageGeneration": "image",
    "videoGeneration": "video",
    "audioGeneration": "audio",
}

# These built-in prompt Recipes consume the user goal or upstream structured text.
# Older catalog copies marked them as requiring binary media, which makes valid
# text-first blueprints impossible to compile.
_TEXT_FIRST_BUILTIN_RECIPE_IDS = {
    "digital-product-text-plan",
    "drama-character-extraction",
    "drama-character-turnaround",
    "drama-plot-outline",
    "drama-prop-extraction",
    "drama-prop-image",
    "drama-scene-extraction",
    "drama-scene-image",
    "drama-shot-group-detail",
    "drama-shot-planning",
    "ecommerce-text-plan",
    "keyframe-scene-script",
    "social-copywriting",
    "video-ad-brief",
    "video-ad-creative-outline",
    "video-creative-outline",
    "video-storyboard-grid",
    "video-storyboard-script",
}

def _stage(
    stage_id: str, node_type: str, recipes: list[str], *, required: bool
) -> dict[str, Any]:
    """One stage of a standard planner template (see ``stages`` below)."""
    return {
        "id": stage_id,
        "node_type": node_type,
        "recipes": list(recipes),
        "required": required,
    }


# ``stages`` is the machine-comparable shape of what ``_standard_skill_items``
# emits for the skill: one entry per planner stage, in template order, with the
# recipes the planner (and its catalog siblings) use for it. ``required`` marks
# the stages the planner emits for every deliverable / include_audio choice;
# an agent-authored plan for the skill must contain each of them or its draft
# preflight reports ``skill_stage_missing`` (issue #677). ``edges`` lists which
# stage's output the next stage consumes: every node of the downstream stage
# must be reachable from a node of the upstream stage over consuming edges
# (any link type but ``dependency_for``, which only orders execution), or the
# preflight reports ``skill_stage_unused`` (a shot-planning node nothing
# consumes is not a shot-planning stage). Text-to-media ``dependency_for``
# gating (a planning document ahead of a media stage) is deliberately not an
# edge here. The table is locked to the planner output by
# tests/test_workflow_plan.py.
_DETERMINISTIC_SKILL_PLANNERS = {
    "ecommerce-ad": {
        "default_item_count": 3,
        "deliverables": ["images", "video", "mixed"],
        "default_deliverable": "video",
        "default_include_audio": True,
        "stages": [
            _stage(
                "planning",
                "textAnnotationNode",
                [
                    "video-ad-creative-outline",
                    "video-ad-brief",
                    "video-storyboard-script",
                    "ecommerce-text-plan",
                    "digital-product-text-plan",
                    "general-text",
                ],
                required=True,
            ),
            _stage(
                "assets",
                "imageGenNode",
                ["general-image", "ecommerce-style-reference"],
                required=True,
            ),
            _stage(
                "images",
                "imageGenNode",
                [
                    "ecommerce-scene-image",
                    "ecommerce-ad-image",
                    "ecommerce-remix-image",
                    "digital-product-ad-image",
                ],
                required=True,
            ),
            _stage("video", "videoNode", ["video-clip-generation"], required=False),
            _stage("audio", "audioNode", ["general-audio"], required=False),
        ],
        "edges": [["assets", "images"], ["images", "video"]],
    },
    "text-to-image-video": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": False,
        "stages": [
            _stage(
                "planning",
                "textAnnotationNode",
                ["video-creative-outline", "general-text"],
                required=True,
            ),
            _stage(
                "images",
                "imageGenNode",
                ["general-image", "video-storyboard-grid"],
                required=True,
            ),
            _stage("video", "videoNode", ["general-video"], required=True),
        ],
        "edges": [["images", "video"]],
    },
    "video-tutorial": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": True,
        "stages": [
            _stage("planning", "textAnnotationNode", ["general-text"], required=True),
            _stage("images", "imageGenNode", ["general-image"], required=True),
            _stage("video", "videoNode", ["general-video"], required=True),
            _stage("audio", "audioNode", ["general-audio"], required=False),
        ],
        "edges": [["images", "video"]],
    },
    "short-drama-quick": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": True,
        "stages": [
            _stage(
                "planning",
                "textAnnotationNode",
                ["drama-plot-outline", "general-text"],
                required=True,
            ),
            _stage(
                "shots",
                "textAnnotationNode",
                [
                    "drama-shot-group-detail",
                    "drama-shot-planning",
                    "drama-shot-group-storyboard",
                    "keyframe-scene-script",
                ],
                required=True,
            ),
            _stage("video", "videoNode", ["general-video"], required=True),
            _stage(
                "audio",
                "audioNode",
                ["drama-shot-voice", "drama-background-music"],
                required=False,
            ),
        ],
        "edges": [["planning", "shots"], ["shots", "video"]],
    },
}

_TEXT_NODE_TYPES = {"textAnnotationNode", "scriptNode", "beatContextNode"}
_USER_MATERIAL_STAGES = {"input", "resource", "asset"}


def standard_skill_stages(skill_id: str) -> list[dict[str, Any]]:
    """The standard planner's stage template for ``skill_id`` ([] without one)."""
    profile = _DETERMINISTIC_SKILL_PLANNERS.get(skill_id) or {}
    return [deepcopy(stage) for stage in profile.get("stages") or []]


def standard_skill_stage_edges(skill_id: str) -> list[tuple[str, str]]:
    """``(upstream_stage, downstream_stage)`` feeding pairs of the template."""
    profile = _DETERMINISTIC_SKILL_PLANNERS.get(skill_id) or {}
    return [(str(edge[0]), str(edge[1])) for edge in profile.get("edges") or []]


_ORDER_ONLY_LINK_TYPE = "dependency_for"


def _downstream_node_ids(node_ids: set[str], edges: Any) -> set[str]:
    """Every node that consumes ``node_ids`` output, directly or transitively.

    Only consuming edges count: ``dependency_for`` orders execution without
    handing the source output to the target (the runtime skips such edges when
    it gathers upstream text), so it cannot make a stage's result "used".
    """
    successors: dict[str, set[str]] = {}
    for edge in edges if isinstance(edges, list) else []:
        if not isinstance(edge, dict):
            continue
        if _text(edge.get("link_type")) == _ORDER_ONLY_LINK_TYPE:
            continue
        source = _text(edge.get("source"))
        target = _text(edge.get("target"))
        if source and target:
            successors.setdefault(source, set()).add(target)
    reached: set[str] = set()
    pending = list(node_ids)
    while pending:
        current = pending.pop()
        for target in successors.get(current, ()):
            if target not in reached:
                reached.add(target)
                pending.append(target)
    return reached


def _node_kind(node_type: str) -> str:
    """Text node types are interchangeable for stage matching; media are exact."""
    return "text" if node_type in _TEXT_NODE_TYPES else node_type


def _node_fills_stage(
    node: Any, stage: dict[str, Any], *, kind_is_unique: bool
) -> bool:
    if not isinstance(node, dict):
        return False
    node_type = _text(node.get("node_type") or node.get("type"))
    if _node_kind(node_type) != _node_kind(_text(stage["node_type"])):
        return False
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    label = _text(node.get("stage") or data.get("stage")).lower()
    if label == stage["id"]:
        return True
    if label in _USER_MATERIAL_STAGES:
        return False
    catalog = data.get("workflowCatalog") if isinstance(data.get("workflowCatalog"), dict) else {}
    recipe_id = _text(catalog.get("recipeId"))
    if recipe_id in stage["recipes"]:
        return True
    # When the skill has a single stage of this kind, any executable node of
    # the kind fills it (node_type + recipe family, issue #678 tolerance); a
    # kind shared by two stages needs the stage label or a family recipe.
    return kind_is_unique and bool(recipe_id)


def skill_stage_blockers(
    skill_id: str, nodes: Any, edges: Any = None
) -> list[dict[str, Any]]:
    """Preflight blockers for standard-planner stages a plan skips or bypasses.

    The standard planner always emits the ``required`` stages and wires them
    in template order; an agent-authored plan (raw plan or intent items) that
    skips one, such as a short drama without its shot-planning stage, compiled
    and reached ``ready`` before issue #677 (``skill_stage_missing``). A stage
    node that exists but feeds nothing downstream is no better: every node of
    a downstream stage must be reachable from a node of the upstream stage
    (``skill_stage_unused``), and only consuming edges count for that: a
    ``dependency_for`` edge orders execution without feeding the target.
    Skills without a standard planner have no template and are not checked.
    """
    stages = standard_skill_stages(skill_id)
    if not stages or not isinstance(nodes, list):
        return []
    kind_counts: dict[str, int] = {}
    for stage in stages:
        kind = _node_kind(_text(stage["node_type"]))
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
    filled: dict[str, list[str]] = {}
    for stage in stages:
        kind_is_unique = kind_counts[_node_kind(_text(stage["node_type"]))] == 1
        filled[stage["id"]] = [
            _text(node.get("id"))
            for node in nodes
            if _node_fills_stage(node, stage, kind_is_unique=kind_is_unique)
        ]
    blockers: list[dict[str, Any]] = []
    for stage in stages:
        if not stage.get("required") or filled[stage["id"]]:
            continue
        recipes = ", ".join(stage["recipes"])
        blockers.append(
            {
                "path": f"plan.stages.{stage['id']}",
                "code": "skill_stage_missing",
                "message": (
                    f"Skill {skill_id} requires a {stage['id']} stage; no "
                    f"{stage['node_type']} node carries stage=\"{stage['id']}\" or one of "
                    f"its recipes ({recipes})"
                ),
                "stage": stage["id"],
                "node_type": stage["node_type"],
                "recipes": list(stage["recipes"]),
                "hint": (
                    f"Add a {stage['node_type']} node for the {stage['id']} stage (set its "
                    f"stage to \"{stage['id']}\" or use one of {recipes}) and feed the "
                    "downstream nodes from it, or drop the custom items and let the "
                    "standard planner (planner.mode=standard) produce every required stage."
                ),
            }
        )
    for upstream, downstream in standard_skill_stage_edges(skill_id):
        sources = filled.get(upstream) or []
        targets = filled.get(downstream) or []
        if not sources or not targets:
            continue  # a missing stage is reported above; an absent optional one is fine
        reached = _downstream_node_ids(set(sources), edges)
        unfed = [node_id for node_id in targets if node_id not in reached]
        if not unfed:
            continue
        blockers.append(
            {
                "path": f"plan.stages.{upstream}.feeds.{downstream}",
                "code": "skill_stage_unused",
                "message": (
                    f"Skill {skill_id} requires the {upstream} stage to feed the "
                    f"{downstream} stage; {downstream} node(s) {', '.join(unfed)} do not "
                    f"consume any {upstream} node ({', '.join(sources)}) through a "
                    "consuming edge (dependency_for only orders execution)"
                ),
                "stage": upstream,
                "downstream_stage": downstream,
                "node_ids": unfed,
                "hint": (
                    f"Connect a {upstream} node to each listed {downstream} node (directly "
                    "or through its inputs) with an edge the target consumes: prompt_for "
                    "from text to generated media, context_for between text nodes, "
                    "media_input_for from media. dependency_for does not count; a "
                    f"{upstream} node nothing downstream reads does not satisfy the stage."
                ),
            }
        )
    return blockers


def _attach_skill_stage_blockers(result: dict[str, Any], skill_id: str) -> None:
    """Fold stage blockers into ``result['preflight']`` (status → blocked)."""
    plan = result.get("plan") if isinstance(result.get("plan"), dict) else {}
    blockers = skill_stage_blockers(
        skill_id, plan.get("nodes") or [], plan.get("edges") or []
    )
    if not blockers:
        return
    preflight = result.get("preflight") if isinstance(result.get("preflight"), dict) else {}
    result["preflight"] = {
        **preflight,
        "status": "blocked",
        "blockers": [*(preflight.get("blockers") or []), *blockers],
        "warnings": list(preflight.get("warnings") or []),
    }


_MAX_STANDARD_PLANNER_UNITS = 12
_TEMPLATE_ISOMORPHIC = "template_isomorphic"


def _node_template_stage(
    node: Any, stages: list[dict[str, Any]], kind_counts: dict[str, int]
) -> dict[str, Any] | None:
    """The template stage an executable node fills, preferring its stage label."""
    if not isinstance(node, dict):
        return None
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    label = _text(node.get("stage") or data.get("stage")).lower()
    matches = [
        stage
        for stage in stages
        if _node_fills_stage(
            node,
            stage,
            kind_is_unique=kind_counts[_node_kind(_text(stage["node_type"]))] == 1,
        )
    ]
    for stage in matches:
        if stage["id"] == label:
            return stage
    return matches[0] if matches else None


def _node_text(node: dict[str, Any], *keys: str) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    for key in keys:
        for source in (node, data):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def template_isomorphism(skill_id: str, plan: Any) -> dict[str, Any]:
    """Compare an agent-authored plan with the Skill's standard planner template.

    Issue #678: a plan whose executable nodes all fill template stages, whose
    required stages are present and fed (``skill_stage_blockers`` is empty)
    and whose edges never run from a later stage back to an earlier one
    restates the template rather than customising it; node counts and prompts
    are parameters, not topology. User-material nodes (``input`` /
    ``resource`` / ``asset``) and the planner-added compose node are ignored.
    The result carries ``isomorphic`` plus a machine-readable ``reason`` for
    the first deviation, or the standard planner ``units`` / ``deliverable`` /
    ``include_audio`` recovered from the nodes when it matches. This is the
    cheap structural screen; before a plan is actually rerouted the standard
    compilation is compared with it node for node
    (``_template_round_trip_reason``), so per-node dependencies, per-stage
    prompts, narration pairing and music are never changed silently.
    """
    stages = standard_skill_stages(skill_id)
    if not stages:
        return {"isomorphic": False, "reason": "no_standard_planner"}
    if not isinstance(plan, dict):
        return {"isomorphic": False, "reason": "plan_not_an_object"}
    if plan.get("external_inputs"):
        return {"isomorphic": False, "reason": "external_inputs"}
    nodes = [node for node in plan.get("nodes") or [] if isinstance(node, dict)]
    edges = plan.get("edges") if isinstance(plan.get("edges"), list) else []
    kind_counts: dict[str, int] = {}
    for stage in stages:
        kind = _node_kind(_text(stage["node_type"]))
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
    stage_index = {stage["id"]: index for index, stage in enumerate(stages)}
    node_stage: dict[str, str] = {}
    by_stage: dict[str, list[dict[str, Any]]] = {stage["id"]: [] for stage in stages}
    for node in nodes:
        node_id = _text(node.get("id"))
        node_type = _text(node.get("node_type") or node.get("type"))
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        label = _text(node.get("stage") or data.get("stage")).lower()
        if node_type == "videoComposeNode" or (
            node_type in _TEXT_NODE_TYPES and label in _USER_MATERIAL_STAGES
        ):
            continue
        stage = _node_template_stage(node, stages, kind_counts)
        if stage is None:
            return {"isomorphic": False, "reason": f"node_outside_template:{node_id}"}
        node_stage[node_id] = stage["id"]
        by_stage[stage["id"]].append(node)
    for blocker in skill_stage_blockers(skill_id, nodes, edges):
        if blocker["code"] == "skill_stage_missing":
            return {"isomorphic": False, "reason": f"stage_missing:{blocker['stage']}"}
        return {
            "isomorphic": False,
            "reason": f"stage_unused:{blocker['stage']}->{blocker['downstream_stage']}",
        }
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source = node_stage.get(_text(edge.get("source")))
        target = node_stage.get(_text(edge.get("target")))
        if source and target and stage_index[source] > stage_index[target]:
            return {
                "isomorphic": False,
                "reason": f"stage_order:{_text(edge.get('source'))}->{_text(edge.get('target'))}",
            }
    video_nodes = by_stage.get("video") or []
    image_nodes = by_stage.get("images") or []
    unit_nodes = video_nodes or image_nodes
    if not unit_nodes:
        return {"isomorphic": False, "reason": "unit_stage_empty"}
    if len(unit_nodes) > _MAX_STANDARD_PLANNER_UNITS:
        return {"isomorphic": False, "reason": f"unit_count:{len(unit_nodes)}"}
    speech_nodes = [
        node
        for node in by_stage.get("audio") or []
        if _text((node.get("data") or {}).get("audioKind") or "speech") != "music"
    ]
    narrations = _narrations_by_unit(unit_nodes, speech_nodes, edges)
    units: list[dict[str, Any]] = []
    for index, node in enumerate(unit_nodes):
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        unit: dict[str, Any] = {
            "title": _node_text(node, "title", "name", "label", "displayName")
            or f"内容段 {index + 1}",
            "prompt": _node_text(node, "prompt", "description", "content")
            or f"内容段 {index + 1}",
        }
        if narrations[index] is not None:
            unit["narration"] = narrations[index]
        duration = _positive_duration_seconds(data.get("durationSec"))
        if video_nodes and duration is not None:
            unit["duration_seconds"] = duration
        units.append(unit)
    return {
        "isomorphic": True,
        "reason": None,
        "deliverable": "video" if video_nodes else "images",
        "include_audio": bool(speech_nodes),
        "unit_count": len(units),
        "units": units,
    }


def _edge_predecessors(edges: Any) -> dict[str, set[str]]:
    """target -> sources over every edge, order-only ones included.

    Used for attachment (which unit a node belongs to), not consumption: a
    voice-over the planner gates behind its shot plan with ``dependency_for``
    is still that shot's voice-over.
    """
    predecessors: dict[str, set[str]] = {}
    for edge in edges if isinstance(edges, list) else []:
        if not isinstance(edge, dict):
            continue
        source = _text(edge.get("source"))
        target = _text(edge.get("target"))
        if source and target:
            predecessors.setdefault(target, set()).add(source)
    return predecessors


def _narrations_by_unit(
    unit_nodes: list[dict[str, Any]],
    speech_nodes: list[dict[str, Any]],
    edges: Any,
) -> list[str | None]:
    """Pair speech nodes with units by what they are attached to, not by order.

    A speech node attached (by any edge) to a unit's video node or to that
    unit's own source (its frame / shot plan) narrates that unit; only speech
    nodes attached to nothing unit-specific (an ecommerce voice-over that
    reads the creative outline) fall back to list order. A wrong pairing can
    never be applied silently: the standard compilation is compared with the
    plan afterwards, edges included.
    """
    predecessors = _edge_predecessors(edges)
    unit_ids = [_text(node.get("id")) for node in unit_nodes]
    unit_scope: list[set[str]] = [
        {unit_id, *predecessors.get(unit_id, set())} for unit_id in unit_ids
    ]
    narrations: list[str | None] = [None] * len(unit_nodes)
    unattached: list[str] = []
    for node in speech_nodes:
        text = _node_text(node, "text", "prompt", "content")
        upstream = predecessors.get(_text(node.get("id")), set())
        owners = [index for index, scope in enumerate(unit_scope) if scope & upstream]
        if len(owners) == 1 and narrations[owners[0]] is None:
            narrations[owners[0]] = text
        else:
            unattached.append(text)
    for index in range(len(narrations)):
        if narrations[index] is None and unattached:
            narrations[index] = unattached.pop(0)
    return narrations


# Node data that describes the node rather than what it generates: labels,
# the prompt / text (compared separately, whitespace-normalised) and the
# catalog bookkeeping the compiler derives. Everything else in ``data`` is an
# execution parameter (model, ratio, quality, duration, speechMode, voiceId,
# voiceAvailable, presetVoice, makeInstrumental, ...) and must match exactly.
_PRESENTATION_DATA_KEYS = {
    "displayName",
    "title",
    "name",
    "label",
    "description",
    "content",
    "prompt",
    "text",
    "stage",
    "workflowCatalog",
    "workflowCatalogRole",
}
_DERIVED_CATALOG_KEYS = {
    "recipeId",
    "recipePipeline",
}


def _hashable(value: Any) -> Any:
    if isinstance(value, dict):
        return tuple(sorted((str(k), _hashable(v)) for k, v in value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(_hashable(v) for v in value)
    return value


_COMPOSE_ORDER_KEY = "compositionInputOrder"
_MAPPING_SEARCH_BUDGET = 20000


class _MappingBudgetExceeded(Exception):
    """The node-mapping search gave up; the plan is treated as not expressible."""


def _node_role(node: Any) -> str:
    """``material`` (user input / resource / asset), ``compose``, ``executable`` or ``""``."""
    if not isinstance(node, dict):
        return ""
    node_type = _text(node.get("node_type") or node.get("type"))
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    label = _text(node.get("stage") or data.get("stage")).lower()
    if node_type == "videoComposeNode":
        return "compose"
    if node_type in _TEXT_NODE_TYPES and label in _USER_MATERIAL_STAGES:
        return "material"
    return "executable"


def _node_signature(node: dict[str, Any]) -> tuple:
    """What a node says, independent of id, label and layout.

    Executable nodes: kind, prompt / text, recipe and every execution
    parameter. User material: its text. The compose node: its settings other
    than the input order, which is compared under the node mapping.
    """
    node_type = _text(node.get("node_type") or node.get("type"))
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    role = _node_role(node)
    kind = "material" if role == "material" else _node_kind(node_type)
    if kind == "audioNode":
        text = _node_text(node, "text", "prompt", "content")
    elif kind == "material":
        text = _node_text(node, "content", "text", "prompt", "description")
    elif role == "compose":
        text = ""  # the planner writes a fixed caption; not a user decision
    else:
        text = _node_text(node, "prompt", "description", "content")
    catalog = (
        data.get("workflowCatalog")
        if isinstance(data.get("workflowCatalog"), dict)
        else {}
    )
    pipeline = (
        catalog.get("recipePipeline")
        if isinstance(catalog.get("recipePipeline"), list)
        else []
    )
    recipe = (
        _text(catalog.get("recipeId")),
        tuple(
            _text(step.get("id") if isinstance(step, dict) else step)
            for step in pipeline
        ),
    )
    settings = tuple(
        sorted(
            (key, _hashable(value))
            for key, value in data.items()
            if key not in _PRESENTATION_DATA_KEYS and key != _COMPOSE_ORDER_KEY
        )
    )
    return (kind, re.sub(r"\s+", " ", text), recipe, settings)


def _plan_signature(
    plan: dict[str, Any], *, include_material: bool, include_compose: bool
) -> tuple[dict[str, tuple], dict[tuple[str, str, str], int], dict[str, list[str]]]:
    """Per-node signatures, the edge multiset (by node id) and compose orders.

    Node ids, titles and layout are presentation; what a plan says is each
    node's signature and which node is wired to which, consuming
    (``prompt_for`` / ``context_for`` / ``media_input_for`` ...) or order-only
    (``dependency_for``). User-material and compose nodes are included only
    when the agent's plan has them (``include_*``): the planner adds its own
    input and compose nodes, which must not count as differences when the
    agent left them out, but an input / resource note or a compose order the
    agent did write has to survive the round trip.
    """
    signatures: dict[str, tuple] = {}
    compose_orders: dict[str, list[str]] = {}
    for node in plan.get("nodes") or []:
        role = _node_role(node)
        if not role:
            continue
        if role == "material" and not include_material:
            continue
        if role == "compose" and not include_compose:
            continue
        node_id = _text(node.get("id"))
        signatures[node_id] = _node_signature(node)
        if role == "compose":
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            order = data.get(_COMPOSE_ORDER_KEY)
            compose_orders[node_id] = (
                [_text(item) for item in order] if isinstance(order, list) else []
            )
    edges: dict[tuple[str, str, str], int] = {}
    for edge in plan.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        source = _text(edge.get("source"))
        target = _text(edge.get("target"))
        if source not in signatures or target not in signatures:
            continue
        link_class = (
            "order"
            if _text(edge.get("link_type")) == _ORDER_ONLY_LINK_TYPE
            else "consume"
        )
        edges[(source, target, link_class)] = (
            edges.get((source, target, link_class), 0) + 1
        )
    return signatures, edges, compose_orders


def _degree_profile(
    node_ids: dict[str, tuple], edges: dict[tuple[str, str, str], int]
) -> dict[str, tuple]:
    """Signature refined by in/out degree per link class: a cheap invariant
    any node-for-node mapping has to respect."""
    out_deg: dict[str, dict[str, int]] = {n: {} for n in node_ids}
    in_deg: dict[str, dict[str, int]] = {n: {} for n in node_ids}
    for (source, target, link_class), count in edges.items():
        out_deg[source][link_class] = out_deg[source].get(link_class, 0) + count
        in_deg[target][link_class] = in_deg[target].get(link_class, 0) + count
    return {
        n: (sig, tuple(sorted(out_deg[n].items())), tuple(sorted(in_deg[n].items())))
        for n, sig in node_ids.items()
    }


def _match_plan_nodes(
    agent: tuple,
    standard: tuple,
    *,
    budget: int = _MAPPING_SEARCH_BUDGET,
) -> dict[str, str] | None:
    """A node-for-node mapping under which both plans have the same edges.

    Nodes with identical signatures are still distinct identities: a frame
    both clips read maps to one standard frame only, so the second clip's
    edge cannot be satisfied and no mapping exists. Candidates are filtered
    by signature *and* degree first (that alone rejects a shared frame), then
    a backtracking search extends the mapping one node at a time, always
    picking the unmapped node with the most already-mapped neighbours so an
    inconsistent edge is found immediately instead of after permuting every
    look-alike node. ``budget`` bounds the number of search steps; exceeding
    it raises ``_MappingBudgetExceeded``.
    """
    agent_sigs, agent_edges = agent[0], agent[1]
    standard_sigs, standard_edges = standard[0], standard[1]
    if len(agent_sigs) != len(standard_sigs) or sum(agent_edges.values()) != sum(
        standard_edges.values()
    ):
        return None
    agent_profile = _degree_profile(agent_sigs, agent_edges)
    standard_profile = _degree_profile(standard_sigs, standard_edges)
    by_profile: dict[tuple, list[str]] = {}
    for node_id, profile in standard_profile.items():
        by_profile.setdefault(profile, []).append(node_id)
    candidates = {n: list(by_profile.get(p, [])) for n, p in agent_profile.items()}
    if any(not options for options in candidates.values()):
        return None
    neighbours: dict[str, dict[str, list[tuple[str, int]]]] = {
        n: {} for n in agent_sigs
    }
    for (source, target, link_class), count in agent_edges.items():
        neighbours[source].setdefault(target, []).append((f"out:{link_class}", count))
        neighbours[target].setdefault(source, []).append((f"in:{link_class}", count))
    mapping: dict[str, str] = {}
    used: set[str] = set()
    steps = 0

    def consistent(node_id: str, candidate: str) -> bool:
        for other, links in neighbours[node_id].items():
            if other not in mapping:
                continue
            for direction, count in links:
                kind, _, link_class = direction.partition(":")
                key = (
                    (candidate, mapping[other], link_class)
                    if kind == "out"
                    else (mapping[other], candidate, link_class)
                )
                if standard_edges.get(key, 0) != count:
                    return False
        return True

    def next_node() -> str:
        return max(
            (n for n in agent_sigs if n not in mapping),
            key=lambda n: (
                sum(1 for other in neighbours[n] if other in mapping),
                -len(candidates[n]),
            ),
        )

    def assign() -> bool:
        nonlocal steps
        if len(mapping) == len(agent_sigs):
            mapped = {
                (mapping[s], mapping[t], c): n for (s, t, c), n in agent_edges.items()
            }
            return mapped == standard_edges
        node_id = next_node()
        for candidate in candidates[node_id]:
            if candidate in used:
                continue
            steps += 1
            if steps > budget:
                raise _MappingBudgetExceeded()
            if not consistent(node_id, candidate):
                continue
            mapping[node_id] = candidate
            used.add(candidate)
            if assign():
                return True
            used.discard(candidate)
            del mapping[node_id]
        return False

    return dict(mapping) if assign() else None


def _template_round_trip_reason(
    agent_plan: dict[str, Any], standard_plan: dict[str, Any]
) -> str | None:
    """Why the standard compilation is not the agent's plan, or None if it is.

    Rerouting must never change what the user planned: every node of the
    agent's plan (kind, prompt / text, recipe, execution parameters; user
    material and compose settings when the agent wrote them) has to map onto
    exactly one node of the standard planner's output with the same
    signature, nothing may be added, under that mapping the edges have to be
    the same (consuming or order-only) and a compose node's input order has
    to match. Node ids and list order do not count.
    """
    nodes = agent_plan.get("nodes") or []
    include_material = any(_node_role(node) == "material" for node in nodes)
    include_compose = any(_node_role(node) == "compose" for node in nodes)
    agent = _plan_signature(
        agent_plan, include_material=include_material, include_compose=include_compose
    )
    standard = _plan_signature(
        standard_plan,
        include_material=include_material,
        include_compose=include_compose,
    )
    agent_sigs, agent_edges, agent_orders = agent
    standard_sigs, standard_edges, standard_orders = standard
    remaining: dict[tuple, int] = {}
    for signature in standard_sigs.values():
        remaining[signature] = remaining.get(signature, 0) + 1
    for node_id, signature in agent_sigs.items():
        if remaining.get(signature, 0) <= 0:
            return f"not_expressible:node:{node_id}"
        remaining[signature] -= 1
    for node_id, signature in standard_sigs.items():
        if remaining.get(signature, 0) > 0:
            return f"not_expressible:extra_node:{node_id}"
    try:
        mapping = _match_plan_nodes(agent, standard)
    except _MappingBudgetExceeded:
        return "not_expressible:mapping_budget"
    if mapping is not None:
        for node_id, order in agent_orders.items():
            mapped = [mapping.get(item, item) for item in order]
            if mapped != standard_orders.get(mapping[node_id], []):
                return f"not_expressible:compose_order:{node_id}"
        return None
    # Same nodes, different wiring: name the first agent edge that no
    # signature-preserving mapping can place (by node identity, not content).
    standard_pairs: dict[tuple, int] = {}
    for (source, target, link_class), count in standard_edges.items():
        key = (standard_sigs[source], standard_sigs[target], link_class)
        standard_pairs[key] = standard_pairs.get(key, 0) + count
    agent_pairs: dict[tuple, int] = {}
    for (source, target, link_class), count in agent_edges.items():
        key = (agent_sigs[source], agent_sigs[target], link_class)
        agent_pairs[key] = agent_pairs.get(key, 0) + count
        if standard_pairs.get(key, 0) < agent_pairs[key]:
            return f"not_expressible:edge:{source}->{target}"
    for (source, target, link_class), count in standard_edges.items():
        key = (standard_sigs[source], standard_sigs[target], link_class)
        if agent_pairs.get(key, 0) < standard_pairs[key]:
            return f"not_expressible:extra_edge:{source}->{target}"
    # Same content pairs, but no consistent node mapping: some node is wired
    # to more targets than any node of its kind in the template (a frame both
    # clips read where the template has one frame per clip).
    agent_profile = _degree_profile(agent_sigs, agent_edges)
    standard_profiles = set(_degree_profile(standard_sigs, standard_edges).values())
    for source, target, _link_class in agent_edges:
        if agent_profile[source] not in standard_profiles:
            return f"not_expressible:edge:{source}->{target}"
    return "not_expressible:wiring"


def _plan_goal_text(plan: dict[str, Any]) -> str:
    """The user goal a raw plan states, or the closest thing it carries.

    Raw plans are not required to repeat ``user_goal``; the standard planner
    writes the goal into ``summary`` and into the user-material input node.
    """
    goal = _workflow_goal_text(plan)
    if goal:
        return goal
    summary = plan.get("summary")
    if isinstance(summary, str) and summary.strip():
        return re.sub(r"\s+", " ", summary.strip())
    for node in plan.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        label = _text(node.get("stage") or data.get("stage")).lower()
        if label in _USER_MATERIAL_STAGES:
            text = _node_text(node, "content", "prompt", "description", "text")
            if text:
                return text
    for node in plan.get("nodes") or []:
        if isinstance(node, dict):
            text = _node_text(node, "prompt", "description", "content")
            if text:
                return text
    return ""


def _standard_intent_from_match(
    *,
    skill_id: str,
    user_goal: str,
    inputs: Any,
    match: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": WORKFLOW_INTENT_SCHEMA_VERSION,
        "skill_id": skill_id,
        "user_goal": user_goal,
        "inputs": dict(inputs) if isinstance(inputs, dict) else {},
        "planner": {
            "mode": "standard",
            "deliverable": match["deliverable"],
            "item_count": match["unit_count"],
            "include_audio": match["include_audio"],
            "units": deepcopy(match["units"]),
        },
    }


def _template_match_audit(match: dict[str, Any]) -> dict[str, Any]:
    """The part of a template comparison that goes into ``planner`` metadata."""
    audit: dict[str, Any] = {"isomorphic": bool(match.get("isomorphic"))}
    if match.get("reason"):
        audit["reason"] = match["reason"]
    if match.get("isomorphic"):
        audit["unit_count"] = match.get("unit_count")
    return audit


def _template_planner_metadata(
    compiled_planner: dict[str, Any],
    *,
    source: str,
    requested_mode: str,
    match: dict[str, Any],
) -> dict[str, Any]:
    metadata = {
        **compiled_planner,
        "selected_by": _TEMPLATE_ISOMORPHIC,
        "source": source,
        "template_match": _template_match_audit(match),
    }
    if requested_mode:
        metadata["requested_mode"] = requested_mode
    return metadata


def _compile_isomorphic_plan_through_template(
    *,
    skill_id: str,
    user_goal: str,
    inputs: Any,
    match: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Compile the recovered standard intent; on failure return the reason instead."""
    intent = _standard_intent_from_match(
        skill_id=skill_id, user_goal=user_goal, inputs=inputs, match=match
    )
    compiled = compile_workflow_intent(intent)
    if not compiled.get("ok"):
        return None, {
            "isomorphic": False,
            "reason": f"standard_compile_failed:{_text(compiled.get('error'))}",
        }
    return compiled, match

_UNIVERSAL_GENERATION_INPUT_KEYS = {
    "aspect_ratio",
    "image_aspect_ratio",
    "image_model",
    "image_quality",
    "image_resolution",
    "image_variants_per_node",
    "video_aspect_ratio",
    "video_duration_seconds",
    "video_generate_audio",
    "video_generation_mode",
    "video_model",
    "video_resolution",
    "video_variants_per_node",
}

_PORTABLE_GENERATION_VARIANT_COUNTS = {1, 2, 4}
_PORTABLE_VIDEO_GENERATION_MODES = {
    "allReference",
    "firstLastFrame",
    "imageReference",
    "imageToVideo",
    "textToVideo",
}


def _portable_generation_input_error(parameter_id: str, value: Any) -> str | None:
    """Validate stable generation inputs before copying them into node data.

    Model ids and model-dependent ratios/resolutions remain dynamic strings; the
    progressively loaded live node schema validates whether a selected model
    supports their concrete values. Stable scalar types, ranges, and modes are
    enforced here for every Agent host.
    """
    if parameter_id in {
        "image_variants_per_node",
        "video_variants_per_node",
    }:
        if not isinstance(value, int) or isinstance(value, bool):
            return "must be an integer"
        if value not in _PORTABLE_GENERATION_VARIANT_COUNTS:
            supported = ", ".join(
                str(item) for item in sorted(_PORTABLE_GENERATION_VARIANT_COUNTS)
            )
            return f"unsupported option: {value}; supported values: {supported}"
        return None
    if parameter_id == "video_duration_seconds":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return "must be a number"
        if value <= 0:
            return "must be greater than 0"
        if value > 600:
            return "must be less than or equal to 600"
        return None
    if parameter_id == "video_generate_audio":
        return None if isinstance(value, bool) else "must be a boolean"
    if parameter_id == "video_generation_mode":
        if not isinstance(value, str) or not value.strip():
            return "must be a non-empty string"
        if value not in _PORTABLE_VIDEO_GENERATION_MODES:
            return f"unsupported option: {value}"
        return None
    if parameter_id in _UNIVERSAL_GENERATION_INPUT_KEYS:
        return (
            None
            if isinstance(value, str) and bool(value.strip())
            else "must be a non-empty string"
        )
    return None


def _workflow_input_values(args: dict[str, Any]) -> dict[str, Any]:
    value = args.get("inputs")
    if isinstance(value, dict):
        return dict(value)
    return {}


def _parameter_option_values(parameter: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for option in parameter.get("options") or []:
        value = (
            _text(option.get("value")) if isinstance(option, dict) else _text(option)
        )
        if value:
            values.append(value)
    return values


def _is_missing_parameter_value(value: Any) -> bool:
    return value is None or value == "" or value == []


def _canonical_parameter_value(parameter_type: str, value: Any) -> Any:
    """Canonicalize only unambiguous scalar encodings from Agent transports."""
    if not isinstance(value, str):
        return value
    if parameter_type in {"integer", "count"} and re.fullmatch(
        r"-?(?:0|[1-9][0-9]*)", value
    ):
        try:
            return int(value)
        except (ValueError, OverflowError):
            return value
    if parameter_type == "number" and re.fullmatch(
        r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value
    ):
        try:
            number = float(value)
        except (ValueError, OverflowError):
            return value
        if math.isfinite(number):
            return int(number) if number.is_integer() else number
        return value
    if parameter_type == "boolean" and value in {"true", "false"}:
        return value == "true"
    return value


def _parameter_type_error(parameter_type: str, value: Any) -> str | None:
    if parameter_type in {"integer", "count"}:
        return (
            None
            if isinstance(value, int) and not isinstance(value, bool)
            else "must be an integer"
        )
    if parameter_type == "number":
        return (
            None
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else "must be a number"
        )
    if parameter_type == "boolean":
        return None if isinstance(value, bool) else "must be a boolean"
    return None


def _allowed_inferred_option(parameter: dict[str, Any], value: str) -> str | None:
    return value if value in _parameter_option_values(parameter) else None


def _infer_parameter_value(parameter: dict[str, Any], user_goal: str) -> Any:
    """Extract only unambiguous structured values from the user's own words."""
    parameter_id = _text(parameter.get("id"))
    goal = user_goal.strip()
    lowered = goal.lower()
    if not parameter_id or not goal:
        return None

    options = [
        item for item in parameter.get("options") or [] if isinstance(item, dict)
    ]
    for option in options:
        value = _text(option.get("value"))
        label = _text(option.get("label"))
        if label and label.lower() in lowered:
            return value

    if parameter_id in {"aspect_ratio", "aspectRatio"}:
        ratio_match = re.search(r"(?<!\d)(\d{1,2}\s*:\s*\d{1,2})(?!\d)", goal)
        if ratio_match:
            ratio = re.sub(r"\s+", "", ratio_match.group(1))
            return _allowed_inferred_option(parameter, ratio)
        aliases = (
            (("竖屏", "竖版", "vertical", "portrait"), "9:16"),
            (("横屏", "横版", "landscape"), "16:9"),
            (("方形", "正方形", "square"), "1:1"),
            (("宽画幅", "超宽屏", "ultrawide"), "21:9"),
        )
        for keywords, value in aliases:
            if any(keyword in lowered for keyword in keywords):
                return _allowed_inferred_option(parameter, value)

    if parameter_id == "execution_mode":
        if any(
            keyword in lowered
            for keyword in (
                "只创建",
                "仅创建",
                "不执行",
                "不自动执行",
                "不要执行",
                "手动执行",
            )
        ):
            return _allowed_inferred_option(parameter, "manual")
        if any(
            keyword in lowered
            for keyword in ("自动执行", "自动运行", "直接执行", "直接生成")
        ):
            return _allowed_inferred_option(parameter, "auto")

    if parameter_id == "voice_mode":
        voice_aliases = (
            (("无对白", "不要对白", "纯音乐"), "no_dialogue"),
            (("旁白", "解说"), "voiceover"),
            (("对白", "对话"), "dialogue"),
        )
        for keywords, value in voice_aliases:
            if any(keyword in lowered for keyword in keywords):
                return _allowed_inferred_option(parameter, value)

    if parameter_id in {"duration", "duration_seconds"}:
        duration_match = re.search(
            r"(?<!\d)(\d{1,4})\s*(?:秒|s\b|sec(?:ond)?s?\b)", lowered
        )
        if duration_match:
            seconds = int(duration_match.group(1))
            exact = _allowed_inferred_option(parameter, str(seconds))
            if exact is not None:
                return exact
            for option in options:
                value = _text(option.get("value"))
                range_match = re.fullmatch(r"(\d+)[_-](\d+)", value)
                if range_match and int(range_match.group(1)) <= seconds <= int(
                    range_match.group(2)
                ):
                    return value

    if parameter_id in {
        "count",
        "item_count",
        "image_count",
        "shot_count",
        "beat_count",
    }:
        count_match = re.search(
            r"(?<!\d)(\d{1,2})\s*(?:张|幅|屏|个|段|条|镜头|镜)(?!\d)", goal
        )
        if count_match:
            return int(count_match.group(1))

    return None


def _infer_workflow_inputs(
    skill: dict[str, Any], args: dict[str, Any]
) -> dict[str, Any]:
    user_goal = _workflow_goal_text(args)
    inferred: dict[str, Any] = {}
    for parameter in skill.get("input_parameters") or []:
        if not isinstance(parameter, dict):
            continue
        parameter_id = _text(parameter.get("id"))
        value = _infer_parameter_value(parameter, user_goal)
        if parameter_id and not _is_missing_parameter_value(value):
            inferred[parameter_id] = value
    return inferred


def _skill_input_contract(
    skill: dict[str, Any], args: dict[str, Any]
) -> dict[str, Any]:
    raw_parameters = skill.get("input_parameters") or []
    parameters = [item for item in raw_parameters if isinstance(item, dict)]
    provided = _workflow_input_values(args)
    inferred = _infer_workflow_inputs(skill, args)
    effective = {**inferred, **provided}
    resolved: dict[str, Any] = {}
    missing_required: list[str] = []
    errors: list[dict[str, str]] = []
    fields: list[dict[str, Any]] = []

    for parameter in parameters:
        parameter_id = _text(parameter.get("id"))
        if not parameter_id:
            continue
        has_provided_value = parameter_id in provided
        has_inferred_value = parameter_id in inferred and not has_provided_value
        value = (
            effective.get(parameter_id)
            if parameter_id in effective
            else deepcopy(parameter.get("default"))
        )
        required = bool(parameter.get("required"))
        parameter_type = _text(parameter.get("type")) or "text"
        value = _canonical_parameter_value(parameter_type, value)
        option_values = _parameter_option_values(parameter)
        if required and _is_missing_parameter_value(value):
            missing_required.append(parameter_id)
        elif not _is_missing_parameter_value(value):
            type_error = _parameter_type_error(parameter_type, value)
            if type_error is not None:
                errors.append(
                    {
                        "path": f"inputs.{parameter_id}",
                        "message": type_error,
                    }
                )
            elif parameter_type == "multi_select":
                if not isinstance(value, list):
                    errors.append(
                        {
                            "path": f"inputs.{parameter_id}",
                            "message": "must be an array",
                        }
                    )
                else:
                    invalid = [
                        str(item)
                        for item in value
                        if option_values and str(item) not in option_values
                    ]
                    if invalid:
                        errors.append(
                            {
                                "path": f"inputs.{parameter_id}",
                                "message": f"unsupported option: {invalid[0]}",
                            }
                        )
            elif option_values and str(value) not in option_values:
                errors.append(
                    {
                        "path": f"inputs.{parameter_id}",
                        "message": f"unsupported option: {value}",
                    }
                )
            resolved[parameter_id] = value
        fields.append(
            {
                "id": parameter_id,
                "label": _text(parameter.get("label")) or parameter_id,
                "type": parameter_type,
                "required": required,
                "default": deepcopy(parameter.get("default")),
                "options": deepcopy(parameter.get("options") or []),
                "value": deepcopy(value),
                "source": (
                    "user"
                    if has_provided_value
                    else "inferred" if has_inferred_value else "default"
                ),
            }
        )

    # Image/video generation choices are portable execution inputs rather than
    # Skill-specific creative inputs. Preserve the recognized keys even when a
    # catalog Skill has no matching input_parameters declaration, so an answer
    # collected by any Agent host reaches every generated media node.
    for parameter_id in sorted(_UNIVERSAL_GENERATION_INPUT_KEYS):
        if parameter_id in provided and not _is_missing_parameter_value(
            provided[parameter_id]
        ):
            value = provided[parameter_id]
            error = _portable_generation_input_error(parameter_id, value)
            if error is not None:
                errors.append({"path": f"inputs.{parameter_id}", "message": error})
            else:
                resolved[parameter_id] = deepcopy(value)

    execution_mode = _text(resolved.get("execution_mode")) or "manual"
    return {
        "schema_version": "freezone_skill_inputs.v1",
        "fields": fields,
        "provided": provided,
        "inferred": inferred,
        "resolved": resolved,
        "missing_required": missing_required,
        "errors": errors,
        "ready_for_planning": not missing_required and not errors,
        "requires_confirmation": bool(fields),
        "execution_mode": execution_mode,
        "recommended_run_after_create": execution_mode == "auto",
        "execution_policy": deepcopy(skill.get("execution_policy") or {}),
    }


def get_workflow_skill(args: dict[str, Any]) -> dict[str, Any]:
    """Return one complete planning package for an explicitly selected Skill."""
    skill_id = _text(args.get("skill_id"))
    if not skill_id:
        return {
            "ok": False,
            "status": "skill_id_required",
            "error": "skill_id is required",
        }
    skill = _load_skill(skill_id)
    if skill is None or skill.get("_disabled") is True:
        return {
            "ok": False,
            "status": "workflow_skill_not_found",
            "error": f"workflow skill not found: {skill_id}",
            "available_skill_ids": sorted(
                _text(item.get("id"))
                for item in _load_skills()
                if _text(item.get("id")) and item.get("_disabled") is not True
            ),
        }

    recipes = [
        recipe
        for recipe in _load_agent_config_items("recipes", _RECIPES_DIR)
        if recipe.get("enabled") is not False and _text(recipe.get("id"))
    ]
    allowed_capabilities = _skill_capabilities(skill)
    candidate_recipes = _workflow_skill_recipe_candidates(
        skill,
        recipes,
        allowed_capabilities=allowed_capabilities,
    )
    referenced_recipe_ids = _skill_referenced_recipe_ids(skill)
    selected_recipes = [
        recipe
        for recipe in candidate_recipes
        if _recipe_matches_references(recipe, referenced_recipe_ids)
    ]
    full_recipes = [_without_private_fields(recipe) for recipe in selected_recipes]
    recipe_summaries = [_recipe_planning_summary(recipe) for recipe in selected_recipes]
    recipes_by_output_kind: dict[str, list[str]] = {}
    source_anchor_recipe_ids: dict[str, list[str]] = {}
    for recipe in recipe_summaries:
        output_kind = _text(recipe.get("output_kind"))
        recipe_id = _text(recipe.get("id"))
        if not output_kind or not recipe_id:
            continue
        recipes_by_output_kind.setdefault(output_kind, []).append(recipe_id)
        if not recipe.get("requires_source_media"):
            source_anchor_recipe_ids.setdefault(output_kind, []).append(recipe_id)
    input_contract = _skill_input_contract(skill, args)
    compact = bool(args.get("compact"))
    from novelvideo.freezone.workflow_planning import WORKFLOW_PLANNING_INSTRUCTIONS

    planning_skill = _without_private_fields(skill)
    allowed_node_types = {
        node_type
        for node_type, capability in _CAPABILITY_BY_NODE_TYPE.items()
        if capability in allowed_capabilities
    }
    # Composition is a terminal canvas operation rather than a Recipe capability.
    # Keep the planning package aligned with plan validation for video Skills.
    if "videoNode" in allowed_node_types:
        allowed_node_types.add("videoComposeNode")
    return {
        "ok": True,
        "schema_version": "freezone_workflow_skill_package.v1",
        "agent_instruction": WORKFLOW_PLANNING_INSTRUCTIONS,
        "skill_id": _text(skill.get("id")),
        "user_goal": _workflow_goal_text(args),
        "source": _catalog_source(skill),
        "skill": planning_skill,
        "recipes": [] if compact else full_recipes,
        "recipe_definitions_omitted": compact,
        "available_recipes": recipe_summaries,
        "capabilities": [
            {
                "id": capability,
                "output_kind": _OUTPUT_KIND_BY_CAPABILITY.get(
                    capability, "composition"
                ),
                "node_type": next(
                    (
                        node_type
                        for node_type, mapped_capability in _CAPABILITY_BY_NODE_TYPE.items()
                        if mapped_capability == capability
                    ),
                    "",
                ),
            }
            for capability in allowed_capabilities
        ],
        "allowed_node_types": sorted(allowed_node_types),
        "allowed_link_types": sorted(ALLOWED_LINK_TYPES),
        "input_contract": input_contract,
        "planning_contract": {
            "node_prompt_role": "task_brief",
            "execution_prompt_owner": "runtime_recipe_compiler",
            "schema_version": PLAN_SCHEMA_VERSION,
            "workflow_type_prefix": "dynamic.",
            "mode": "dynamic_only",
            "requires_agent_authored_topology": (
                _text(skill.get("id")) not in _DETERMINISTIC_SKILL_PLANNERS
            ),
            "custom_items_require_agent_authored_topology": True,
            "requires_explicit_skill_id": True,
            "requires_explicit_recipe_id": (
                _text(skill.get("id")) not in _DETERMINISTIC_SKILL_PLANNERS
            ),
            "custom_items_require_explicit_recipe_id": True,
            "topology_modes": (
                ["standard_planner", "custom_items"]
                if _text(skill.get("id")) in _DETERMINISTIC_SKILL_PLANNERS
                else ["custom_items"]
            ),
            "standard_planner": deepcopy(
                _DETERMINISTIC_SKILL_PLANNERS.get(_text(skill.get("id"))) or {}
            ),
            "supports_ordered_recipe_pipeline": True,
            "strict_validation": True,
            "plan_inputs_field": "inputs",
            "max_nodes": 200,
            "max_edges": 400,
            "missing_source_media": {
                "strategy": "generate_anchor_then_continue",
                "anchor_recipe_requires_source_media": False,
                "dependency_link_type": "media_input_for",
                "source_anchor_recipe_ids": source_anchor_recipe_ids,
            },
            "recipe_ids_by_output_kind": recipes_by_output_kind,
            "recipe_selection_rule": (
                "Use each Recipe's node_type. output_kind=text with output_format=html produces "
                "a saved HTML webpage through htmlArtifactNode, while ordinary text produces textAnnotationNode. "
                "HTML steps require a non-empty generation prompt in node.prompt or node.data.prompt; "
                "describe the webpage's business requirements, not inline HTML source. "
                "Use reference_inputs for the copy and media consumed by the webpage. "
                "For a generated source-media "
                "anchor, choose a same-output Recipe listed in source_anchor_recipe_ids; "
                "never copy a downstream text Recipe onto an image anchor."
            ),
        },
        "message": (
            "已加载完整 Workflow Skill 包，可直接规划 freezone_workflow_plan.v1。"
            if input_contract["ready_for_planning"]
            else "已加载 Workflow Skill，但必须先补全或修正 input_contract。"
        ),
    }


def compile_workflow_intent(intent: Any) -> dict[str, Any]:
    """Compile a compact Agent decision into a complete, validated dynamic plan."""
    if not isinstance(intent, dict):
        return _intent_error("intent must be an object", path="intent")
    schema_version = _text(intent.get("schema_version"))
    if schema_version and schema_version != WORKFLOW_INTENT_SCHEMA_VERSION:
        return _intent_error(
            f"schema_version must equal {WORKFLOW_INTENT_SCHEMA_VERSION}",
            path="schema_version",
        )
    skill_id = _text(intent.get("skill_id"))
    if not skill_id:
        return _intent_error("skill_id is required", path="skill_id")
    skill = _load_skill(skill_id)
    if skill is None or skill.get("_disabled") is True:
        return _intent_error(f"workflow skill not found: {skill_id}", path="skill_id")

    user_goal = _workflow_goal_text(intent)
    if not user_goal:
        return _intent_error("user_goal is required", path="user_goal")
    input_contract = _skill_input_contract(skill, intent)
    if input_contract["errors"] or input_contract["missing_required"]:
        errors = list(input_contract["errors"])
        errors.extend(
            {
                "path": f"inputs.{parameter_id}",
                "message": "required Skill input is missing",
                "hint": (
                    f"Provide inputs.{parameter_id}; its definition (type, "
                    "description, allowed values) is in the input_contract "
                    "returned by freezone_get_workflow_skill."
                ),
            }
            for parameter_id in input_contract["missing_required"]
        )
        return {
            "ok": False,
            "status": "invalid_workflow_intent",
            "error": errors[0]["message"],
            "errors": errors,
            "agent_instruction": _INTENT_FIX_INSTRUCTION,
        }

    compiled_intent = deepcopy(intent)
    planner_metadata: dict[str, Any] | None = None
    plan_metadata: dict[str, Any] | None = None
    requested_mode = (
        _text((intent.get("planner") or {}).get("mode"))
        if isinstance(intent.get("planner"), dict)
        else ""
    )
    if _intent_items(compiled_intent):
        # Agent-authored items take precedence over the standard planner; record
        # that choice (and whether a standard planner was available) so the
        # draft shows why the template path was not taken (issue #678).
        planner_metadata = _agent_authored_planner_metadata(
            skill_id,
            source="intent_items",
            requested_mode=requested_mode,
            item_count=len(_intent_items(compiled_intent)),
        )
    else:
        compiled_intent, planner_metadata, planner_error = (
            _expand_standard_skill_intent(
                intent=compiled_intent,
                skill_id=skill_id,
                user_goal=user_goal,
                resolved_inputs=input_contract["resolved"],
            )
        )
        if planner_error is not None:
            return planner_error
        plan_metadata = planner_metadata

    compiled = _compile_dynamic_recipe_items_intent(
        intent=compiled_intent,
        skill=skill,
        user_goal=user_goal,
        resolved_inputs=input_contract["resolved"],
    )
    if compiled.get("ok") and planner_metadata is not None:
        if planner_metadata.get("mode") == "agent_authored":
            # Items that merely restate the Skill's standard template are the
            # template: compile them through the standard planner so the draft
            # gets its production shape, and record why (issue #678).
            match = template_isomorphism(skill_id, compiled.get("plan"))
            if match["isomorphic"]:
                rerouted, match = _compile_isomorphic_plan_through_template(
                    skill_id=skill_id,
                    user_goal=user_goal,
                    inputs=intent.get("inputs"),
                    match=match,
                )
                if rerouted is not None:
                    mismatch = _template_round_trip_reason(
                        compiled["plan"], rerouted["plan"]
                    )
                    if mismatch is None:
                        rerouted["planner"] = _template_planner_metadata(
                            rerouted["planner"],
                            source="intent_items",
                            requested_mode=requested_mode,
                            match=match,
                        )
                        return rerouted
                    match = {"isomorphic": False, "reason": mismatch}
            planner_metadata = _agent_authored_planner_metadata(
                skill_id,
                source="intent_items",
                requested_mode=requested_mode,
                item_count=len(_intent_items(compiled_intent)),
                template_match=match,
            )
        compiled["planner"] = planner_metadata
        plan = compiled.get("plan")
        # Only the deterministic planner stamps the plan itself; the plan JSON
        # schema does not declare ``planner`` for agent-authored graphs.
        if isinstance(plan, dict) and plan_metadata is not None:
            plan["planner"] = deepcopy(plan_metadata)
    # Agent-authored items that skip a stage the Skill's standard planner
    # always emits surface as a ``skill_stage_missing`` preflight blocker; the
    # check runs in validate_agent_workflow_plan, which compilation goes through.
    return compiled


def _agent_authored_planner_metadata(
    skill_id: str,
    *,
    source: str,
    requested_mode: str = "",
    item_count: int | None = None,
    template_match: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Audit record for a topology the agent authored instead of the standard planner.

    ``template_match`` says why the standard planner was not used for a Skill
    that has one: the first deviation from its template (issue #678).
    """
    metadata: dict[str, Any] = {
        "mode": "agent_authored",
        "source": source,
        "skill_id": skill_id,
        "selected_by": "agent",
        "standard_planner_available": skill_id in _DETERMINISTIC_SKILL_PLANNERS,
    }
    if requested_mode:
        metadata["requested_mode"] = requested_mode
    if item_count is not None:
        metadata["item_count"] = item_count
    if template_match is not None and skill_id in _DETERMINISTIC_SKILL_PLANNERS:
        metadata["template_match"] = _template_match_audit(template_match)
    return metadata


def _standard_skill_items(
    *,
    skill_id: str,
    deliverable: str,
    include_audio: bool,
    units: list[dict[str, Any]],
    user_goal: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if skill_id == "ecommerce-ad":
        items.append(
            _planned_item(
                item_id="creative_outline",
                title="广告创意大纲",
                prompt=user_goal,
                recipe_id="video-ad-creative-outline",
                depends_on=["workflow_input"],
                stage="planning",
            )
        )
        items.append(
            _planned_item(
                item_id="product_reference",
                title="商品视觉锚点",
                prompt=f"{user_goal}，生成稳定一致的商品主体参考图",
                recipe_id="general-image",
                depends_on=["creative_outline"],
                stage="assets",
            )
        )
        for index, unit in enumerate(units, 1):
            image_id = f"scene_{index}"
            items.append(
                _planned_item(
                    item_id=image_id,
                    title=unit["title"],
                    prompt=unit["prompt"],
                    recipe_id="ecommerce-scene-image",
                    depends_on=["product_reference"],
                    stage="images",
                )
            )
            if deliverable != "images":
                items.append(
                    _planned_item(
                        item_id=f"clip_{index}",
                        title=f"{unit['title']}视频",
                        prompt=unit["prompt"],
                        recipe_id="video-clip-generation",
                        depends_on=[image_id],
                        stage="video",
                        timeline_role="visual",
                        duration_seconds=unit.get("duration_seconds"),
                    )
                )
            if include_audio:
                items.append(
                    _planned_item(
                        item_id=f"voice_{index}",
                        title=f"{unit['title']}旁白",
                        prompt=unit["narration"],
                        narration=unit["narration"],
                        recipe_id="general-audio",
                        depends_on=["creative_outline"],
                        stage="audio",
                        timeline_role="voiceover",
                    )
                )
        return items

    outline_recipe = {
        "text-to-image-video": "video-creative-outline",
        "video-tutorial": "general-text",
        "short-drama-quick": "drama-plot-outline",
    }[skill_id]
    items.append(
        _planned_item(
            item_id="outline",
            title="内容规划",
            prompt=user_goal,
            recipe_id=outline_recipe,
            depends_on=["workflow_input"],
            stage="planning",
        )
    )
    for index, unit in enumerate(units, 1):
        if skill_id == "short-drama-quick":
            source_id = f"shot_plan_{index}"
            items.append(
                _planned_item(
                    item_id=source_id,
                    title=f"{unit['title']}镜头设计",
                    prompt=unit["prompt"],
                    recipe_id="drama-shot-group-detail",
                    depends_on=["outline"],
                    stage="shots",
                )
            )
        else:
            source_id = f"frame_{index}"
            items.append(
                _planned_item(
                    item_id=source_id,
                    title=f"{unit['title']}画面",
                    prompt=unit["prompt"],
                    recipe_id="general-image",
                    depends_on=["outline"],
                    stage="images",
                )
            )
        items.append(
            _planned_item(
                item_id=f"clip_{index}",
                title=f"{unit['title']}视频",
                prompt=unit["prompt"],
                recipe_id="general-video",
                depends_on=[source_id],
                stage="video",
                # The shot plan is what the clip renders, not a gate ahead of
                # it: reference it so the edge is prompt_for and the runtime
                # feeds the shot text into the video prompt (issue #677).
                reference_inputs=(
                    [source_id] if skill_id == "short-drama-quick" else None
                ),
                timeline_role="visual",
                duration_seconds=unit.get("duration_seconds"),
            )
        )
        if include_audio and skill_id in {"video-tutorial", "short-drama-quick"}:
            items.append(
                _planned_item(
                    item_id=f"voice_{index}",
                    title=f"{unit['title']}旁白",
                    prompt=unit["narration"],
                    narration=unit["narration"],
                    recipe_id=(
                        "drama-shot-voice"
                        if skill_id == "short-drama-quick"
                        else "general-audio"
                    ),
                    depends_on=[source_id],
                    stage="audio",
                    timeline_role="voiceover",
                )
            )
    if include_audio and skill_id == "short-drama-quick":
        items.append(
            _planned_item(
                item_id="background_music",
                title="背景音乐",
                prompt=f"{user_goal}，生成与情绪节奏匹配的纯音乐",
                recipe_id="drama-background-music",
                depends_on=["outline"],
                stage="audio",
                timeline_role="music",
            )
        )
    return items


def _standard_planner_units(
    *,
    planner: dict[str, Any],
    item_count: int,
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> list[dict[str, Any]]:
    raw_units = planner.get("units")
    source_units = raw_units if isinstance(raw_units, list) else []
    units: list[dict[str, Any]] = []
    for index in range(item_count):
        raw_unit = source_units[index] if index < len(source_units) else {}
        if isinstance(raw_unit, str):
            raw_unit = {"title": raw_unit, "prompt": raw_unit}
        if not isinstance(raw_unit, dict):
            raw_unit = {}
        number = index + 1
        title = (
            _text(raw_unit.get("title") or raw_unit.get("name")) or f"内容段 {number}"
        )
        prompt = (
            _text(
                raw_unit.get("prompt")
                or raw_unit.get("description")
                or raw_unit.get("goal")
            )
            or f"{user_goal}，第 {number} 段：{title}"
        )
        narration = _text(
            raw_unit.get("narration")
            or raw_unit.get("voiceover")
            or raw_unit.get("dialogue")
        )
        duration_seconds = _positive_duration_seconds(
            raw_unit.get("duration_seconds")
            or raw_unit.get("durationSeconds")
            or raw_unit.get("duration")
        )
        units.append(
            {
                "title": title,
                "prompt": prompt,
                "narration": narration,
                **(
                    {"duration_seconds": duration_seconds}
                    if duration_seconds is not None
                    else {}
                ),
            }
        )

    total_duration_seconds = _planner_total_duration_seconds(
        planner=planner,
        resolved_inputs=resolved_inputs,
        user_goal=user_goal,
    )
    if total_duration_seconds is not None:
        missing_indices = [
            index for index, unit in enumerate(units) if "duration_seconds" not in unit
        ]
        explicit_total = sum(
            int(unit["duration_seconds"])
            for unit in units
            if "duration_seconds" in unit
        )
        remaining = total_duration_seconds - explicit_total
        if missing_indices and remaining >= len(missing_indices):
            base, extra = divmod(remaining, len(missing_indices))
            for offset, index in enumerate(missing_indices):
                units[index]["duration_seconds"] = base + (1 if offset < extra else 0)
    return units


def _planned_item(
    *,
    item_id: str,
    title: str,
    prompt: str,
    recipe_id: str,
    depends_on: list[str],
    stage: str,
    reference_inputs: list[str] | None = None,
    narration: str = "",
    timeline_role: str = "",
    duration_seconds: int | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "title": title,
        "prompt": prompt,
        "recipe_id": recipe_id,
        "depends_on": depends_on,
        "stage": stage,
        **({"reference_inputs": reference_inputs} if reference_inputs else {}),
        **({"narration": narration} if narration else {}),
        **({"timeline_role": timeline_role} if timeline_role else {}),
        **(
            {"duration_seconds": duration_seconds}
            if duration_seconds is not None
            else {}
        ),
    }


def _expand_standard_skill_intent(
    *,
    intent: dict[str, Any],
    skill_id: str,
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    profile = _DETERMINISTIC_SKILL_PLANNERS.get(skill_id)
    if profile is None:
        return (
            intent,
            None,
            _intent_error(
                "dynamic workflow intent must include at least one recipe-backed item",
                path="items",
            ),
        )
    raw_planner = intent.get("planner")
    if raw_planner is not None and not isinstance(raw_planner, dict):
        return intent, None, _intent_error("planner must be an object", path="planner")
    planner = raw_planner if isinstance(raw_planner, dict) else {}
    mode = _text(planner.get("mode")) or "standard"
    if mode != "standard":
        return (
            intent,
            None,
            _intent_error(
                "planner.mode must equal standard",
                path="planner.mode",
            ),
        )
    deliverable = _text(planner.get("deliverable")) or profile["default_deliverable"]
    if deliverable not in profile["deliverables"]:
        return (
            intent,
            None,
            _intent_error(
                f"planner.deliverable is not supported by Skill {skill_id}: {deliverable}",
                path="planner.deliverable",
            ),
        )
    raw_count = planner.get("item_count", planner.get("itemCount"))
    if raw_count is None:
        item_count = int(profile["default_item_count"])
    elif isinstance(raw_count, int) and not isinstance(raw_count, bool):
        item_count = raw_count
    else:
        return (
            intent,
            None,
            _intent_error(
                "planner.item_count must be an integer",
                path="planner.item_count",
            ),
        )
    if not 1 <= item_count <= 12:
        return (
            intent,
            None,
            _intent_error(
                "planner.item_count must be between 1 and 12",
                path="planner.item_count",
            ),
        )
    planner_include_audio = planner.get("include_audio")
    if planner_include_audio is not None and not isinstance(
        planner_include_audio, bool
    ):
        return (
            intent,
            None,
            _intent_error(
                "planner.include_audio must be a boolean",
                path="planner.include_audio",
            ),
        )
    if planner.get("units") is not None and not isinstance(planner.get("units"), list):
        return (
            intent,
            None,
            _intent_error(
                "planner.units must be an array",
                path="planner.units",
            ),
        )
    include_audio = _intent_bool(
        intent,
        "include_audio",
        (
            planner_include_audio
            if isinstance(planner_include_audio, bool)
            else profile["default_include_audio"]
        ),
    )
    if deliverable == "images":
        include_audio = False
    units = _standard_planner_units(
        planner=planner,
        item_count=item_count,
        user_goal=user_goal,
        resolved_inputs=resolved_inputs,
    )
    if include_audio:
        for index, unit in enumerate(units):
            narration = _text(unit.get("narration"))
            title = _text(unit.get("title"))
            if not narration:
                return (
                    intent,
                    None,
                    _intent_error(
                        f"planner.units.{index} is missing narration; when "
                        "include_audio=true EVERY unit must carry its own "
                        "literal narration text (narration on another unit "
                        "does not cover this one)",
                        path=f"planner.units.{index}.narration",
                        hint=(
                            "Add narration to each unit: the exact sentence(s) the "
                            "voice-over should speak aloud for that unit, in the "
                            "user's language. If you want one overall voice-over "
                            "line instead of per-unit narration, drop the planner "
                            "units and plan explicit items with a single speech "
                            "audio item carrying that line. If the user did not "
                            "ask for audio, set include_audio=false."
                        ),
                    ),
                )
            if narration == title or re.fullmatch(
                r"(?:这是)?(?:短剧|视频)?的?第?[一二三四五六七八九十\d]+段(?:旁白|解说)[。.!！]?",
                narration,
            ):
                return (
                    intent,
                    None,
                    _intent_error(
                        "speech audio requires the literal narration text; "
                        "do not use a placeholder or a request to generate narration",
                        path=f"planner.units.{index}.narration",
                        hint=(
                            "Write the exact sentence(s) the voice-over should speak "
                            "aloud for this unit, in the user's language. Placeholders "
                            'like "第一段旁白" / "这是短剧的第二段解说" and unit titles '
                            'are rejected. Example: "深夜的便利店，只有他一个人。" '
                            "If include_audio was not requested by the user, set "
                            "include_audio=false instead of inventing narration."
                        ),
                    ),
                )
    items = _standard_skill_items(
        skill_id=skill_id,
        deliverable=deliverable,
        include_audio=include_audio,
        units=units,
        user_goal=user_goal,
    )
    expanded = {
        **intent,
        "items": items,
        "include_audio": include_audio,
        "include_compose": deliverable != "images",
    }
    metadata = {
        "mode": "deterministic_standard",
        "skill_id": skill_id,
        "deliverable": deliverable,
        "item_count": len(units),
        "include_audio": include_audio,
    }
    return expanded, metadata, None


def _compile_dynamic_recipe_items_intent(
    *,
    intent: dict[str, Any],
    skill: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> dict[str, Any]:
    items = _intent_items(intent)
    if not items:
        return _intent_error(
            "dynamic workflow intent must include at least one recipe-backed item",
            path="items",
        )

    recipes = _intent_recipe_index()
    allowed_recipe_ids = {
        _text(item) for item in skill.get("allowed_recipe_ids") or [] if _text(item)
    }
    nodes: list[dict[str, Any]] = [
        {
            "id": "workflow_input",
            "node_type": "textAnnotationNode",
            "name": "用户需求 / 输入素材",
            "description": user_goal,
            "stage": "input",
            "data": {
                "displayName": "用户需求 / 输入素材",
                "title": "用户需求 / 输入素材",
                "content": user_goal,
                "prompt": user_goal,
                "workflowCatalogRole": "user_input",
            },
        }
    ]
    node_types = {"workflow_input": "textAnnotationNode"}
    node_recipes: dict[str, dict[str, Any] | None] = {"workflow_input": None}
    node_requires_source: dict[str, bool] = {"workflow_input": False}
    item_by_id: dict[str, dict[str, Any]] = {}
    external_inputs = intent.get("external_inputs") or []
    if not isinstance(external_inputs, list) or len(external_inputs) > 24:
        return _intent_error("external_inputs must be an array of at most 24 items", path="external_inputs")
    external_ids: set[str] = set()
    for index, source in enumerate(external_inputs):
        if not isinstance(source, dict) or set(source) != {"id", "node_id", "media_kind"}:
            return _intent_error("external input requires id, node_id and media_kind", path=f"external_inputs.{index}")
        alias = _text(source.get("id"))
        if (not alias or _safe_id(alias) != alias or alias == "workflow_input"
                or alias in external_ids or not _text(source.get("node_id"))
                or source.get("media_kind") != "image"):
            return _intent_error("invalid external image input", path=f"external_inputs.{index}")
        external_ids.add(alias)
        node_types[alias] = "imageGenNode"
    phases: list[str] = []
    include_audio = _intent_bool(intent, "include_audio", True)
    planner = intent.get("planner") if isinstance(intent.get("planner"), dict) else {}
    html_deliverable = _text(planner.get("deliverable")) == "html" or any(
        _recipe_node_type(recipes.get(_text(item.get("recipe_id"))) or {})
        == "htmlArtifactNode"
        for item in items
    )
    include_compose = _intent_bool(intent, "include_compose", not html_deliverable)

    for index, item in enumerate(items):
        item_id = _safe_id(_text(item.get("id")) or f"item_{index + 1}")
        if item_id in node_types or item_id in item_by_id:
            return _intent_error(
                f"duplicate or reserved dynamic item id: {item_id}",
                path=f"items.{index}.id",
            )
        recipe_id = _text(item.get("recipe_id") or item.get("recipeId"))
        recipe = recipes.get(recipe_id)
        canonical_recipe_id = _text(recipe.get("id")) if recipe else ""
        if not recipe_id or recipe is None:
            return _intent_error(
                f"unknown Recipe for dynamic item {item_id}: {recipe_id or '<missing>'}",
                path=f"items.{index}.recipe_id",
            )
        if canonical_recipe_id not in allowed_recipe_ids:
            return _intent_error(
                f"Recipe {canonical_recipe_id} is not allowed by Skill {_text(skill.get('id'))}",
                path=f"items.{index}.recipe_id",
            )
        if _text(recipe.get("output_kind")) == "audio" and not include_audio:
            continue
        if include_compose and _is_redundant_compose_item(item_id, item):
            # The compiler appends one real videoComposeNode below. A Recipe-backed
            # "final compose" video item would instead call Seedance R2V with every
            # completed clip and exceed its reference-video duration limit.
            continue
        recipe_pipeline: list[dict[str, Any]] = []
        raw_pipeline = item.get("recipe_pipeline") or item.get("recipePipeline") or []
        if not isinstance(raw_pipeline, list):
            return _intent_error(
                "recipe_pipeline must be an array",
                path=f"items.{index}.recipe_pipeline",
            )
        for pipeline_index, pipeline_value in enumerate(raw_pipeline[:6]):
            pipeline_id = _text(
                pipeline_value.get("id")
                if isinstance(pipeline_value, dict)
                else pipeline_value
            )
            pipeline_recipe = recipes.get(pipeline_id)
            canonical_pipeline_id = (
                _text(pipeline_recipe.get("id")) if pipeline_recipe else ""
            )
            if not canonical_pipeline_id:
                return _intent_error(
                    f"unknown Recipe in pipeline: {pipeline_id or '<missing>'}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if canonical_pipeline_id not in allowed_recipe_ids:
                return _intent_error(
                    f"Recipe {canonical_pipeline_id} is not allowed by Skill "
                    f"{_text(skill.get('id'))}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if _text(pipeline_recipe.get("output_kind")) != _text(
                recipe.get("output_kind")
            ):
                return _intent_error(
                    f"Recipe {canonical_pipeline_id} output kind does not match "
                    f"{canonical_recipe_id}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if canonical_pipeline_id == canonical_recipe_id or any(
                _text(existing.get("id")) == canonical_pipeline_id
                for existing in recipe_pipeline
            ):
                continue
            recipe_pipeline.append(pipeline_recipe)
        conflict = _recipe_pipeline_conflict([recipe, *recipe_pipeline])
        if conflict is not None:
            source_id, target_id = conflict
            return _intent_error(
                f"Recipe {source_id} conflicts with {target_id}",
                path=f"items.{index}.recipe_pipeline",
            )
        node_type = _recipe_node_type(recipe)
        if not node_type:
            return _intent_error(
                f"Recipe {canonical_recipe_id} has unsupported output_kind",
                path=f"items.{index}.recipe_id",
            )
        if (
            node_type == "audioNode"
            and _intent_audio_kind(item, recipe) == "speech"
            and not _text(item.get("narration"))
            and _looks_like_speech_generation_instruction(item.get("prompt"))
        ):
            return _intent_error(
                "speech audio item must provide narration as the literal text to speak; "
                "prompt must not be a request to generate narration",
                path=f"items.{index}.narration",
                hint=(
                    "Set items[].narration to the exact spoken sentence(s), e.g. "
                    '"深夜的便利店，只有他一个人。" — an instruction such as '
                    '"为这段视频生成旁白" is not narration and is rejected.'
                ),
            )
        node = _intent_item_node(
            skill=skill,
            recipe=recipe,
            node_type=node_type,
            item_id=item_id,
            item=item,
            user_goal=user_goal,
            resolved_inputs=resolved_inputs,
            recipe_pipeline=recipe_pipeline,
        )
        explicit_stage = _text(item.get("stage"))
        if explicit_stage:
            node["stage"] = explicit_stage
        stage = _text(node.get("stage"))
        if stage and stage not in phases:
            phases.append(stage)
        nodes.append(node)
        node_types[item_id] = node_type
        node_recipes[item_id] = recipe
        node_requires_source[item_id] = any(
            bool(
                candidate.get("requires_source_media")
                or candidate.get("requiresSourceMedia")
            )
            for candidate in [recipe, *recipe_pipeline]
        )
        item_by_id[item_id] = item

    edges: list[dict[str, str]] = []
    item_order = {item_id: index for index, item_id in enumerate(item_by_id)}
    for item_id, item in item_by_id.items():
        raw_dependencies = item.get("depends_on") or item.get("dependsOn") or []
        raw_references = (
            item.get("reference_inputs") or item.get("referenceInputs") or []
        )
        dependencies = (
            [_text(value) for value in raw_dependencies if _text(value)]
            if isinstance(raw_dependencies, list)
            else [_text(raw_dependencies)] if _text(raw_dependencies) else []
        )
        references = (
            [_text(value) for value in raw_references if _text(value)]
            if isinstance(raw_references, list)
            else [_text(raw_references)] if _text(raw_references) else []
        )
        for reference_id in references:
            if reference_id not in dependencies:
                dependencies.append(reference_id)
        if external_ids.intersection(dependencies) and "workflow_input" not in dependencies:
            dependencies.append("workflow_input")
        if not dependencies:
            dependencies = ["workflow_input"]
        normalized_dependencies: list[str] = []
        normalized_references: set[str] = set()
        for source_id in dependencies:
            normalized_source = (
                "workflow_input"
                if source_id == "workflow_input"
                else _safe_id(source_id)
            )
            if normalized_source not in node_types:
                return _intent_error(
                    f"unknown dependency {source_id} for dynamic item {item_id}",
                    path=f"items.{item_id}.depends_on",
                )
            normalized_dependencies.append(normalized_source)
            if source_id in references:
                normalized_references.add(normalized_source)

        has_media_dependency = any(
            node_types.get(source_id) in {"imageGenNode", "videoNode", "audioNode"}
            for source_id in normalized_dependencies
        )
        if node_requires_source.get(item_id) and not has_media_dependency:
            current_order = item_order[item_id]
            candidates = [
                candidate_id
                for candidate_id, candidate_order in item_order.items()
                if candidate_order < current_order
                and node_types.get(candidate_id)
                in {"imageGenNode", "videoNode", "audioNode"}
                and not node_requires_source.get(candidate_id)
            ]
            same_kind_candidates = [
                candidate_id
                for candidate_id in candidates
                if node_types.get(candidate_id) == node_types.get(item_id)
            ]
            anchor_id = (
                same_kind_candidates[0]
                if len(same_kind_candidates) == 1
                else (
                    candidates[0]
                    if not same_kind_candidates and len(candidates) == 1
                    else ""
                )
            )
            if anchor_id:
                normalized_dependencies.append(anchor_id)

        for normalized_source in normalized_dependencies:
            source_item = item_by_id.get(normalized_source) or {}
            source_timeline_role = _text(
                source_item.get("timeline_role") or source_item.get("timelineRole")
            ).lower()
            if (
                node_types.get(normalized_source) == "audioNode"
                and node_types.get(item_id) == "videoNode"
                and normalized_source not in normalized_references
                and source_timeline_role
                in {
                    "voiceover",
                    "narration",
                    "shot_voice",
                    "music",
                    "bgm",
                    "background_music",
                }
            ):
                # Final narration/music belongs on the compose timeline. Feeding a
                # full-length track to Seedance omni makes it an audio reference,
                # whose provider limit is 1.8-15.2 seconds per clip.
                continue
            edges.append(
                {
                    "source": normalized_source,
                    "target": item_id,
                    "link_type": (
                        _intent_reference_link_type(
                            node_types.get(normalized_source, ""),
                            node_types.get(item_id, ""),
                        )
                        if normalized_source in normalized_references
                        else _intent_link_type(
                            node_types.get(normalized_source, ""),
                            node_types.get(item_id, ""),
                        )
                    ),
                }
            )

    if include_compose:
        compose_sources = [
            node_id
            for node_id, node_type in node_types.items()
            if node_type in {"videoNode", "audioNode"}
        ]
        if len(compose_sources) >= 2 and any(
            node_types.get(node_id) == "videoNode" for node_id in compose_sources
        ):
            compose_id = "final_compose"
            nodes.append(
                {
                    "id": compose_id,
                    "node_type": "videoComposeNode",
                    "name": "成片合成",
                    "description": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                    "stage": "compose",
                    "data": {
                        "displayName": "成片合成",
                        "title": "成片合成",
                        "content": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                        "prompt": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                        # Keep the intent's semantic source order. Canvas node ids
                        # are allocated later, so the frontend resolves these plan
                        # ids through each node's workflowPlanNodeId.
                        "compositionInputOrder": compose_sources,
                        "workflowCatalog": {
                            "skillId": _text(skill.get("id")),
                            "skillVersion": skill.get("version"),
                            "confirmedInputs": resolved_inputs,
                            "stepId": compose_id,
                            "promptBuilder": {"userGoal": user_goal},
                        },
                    },
                }
            )
            node_types[compose_id] = "videoComposeNode"
            node_recipes[compose_id] = None
            edges.extend(
                {
                    "source": source_id,
                    "target": compose_id,
                    "link_type": "composition_input_for",
                }
                for source_id in compose_sources
            )
            phases.append("compose")

    edges = _dedupe_intent_edges(edges)
    skill_id = _text(skill.get("id"))
    title = _text(intent.get("title")) or _catalog_label(skill)
    plan = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "workflow_type": f"dynamic.{skill_id}",
        "mode": "tool_compiled_dynamic",
        "skill": {"id": skill_id, "version": skill.get("version")},
        "summary": _text(intent.get("summary")) or user_goal,
        "source_context": {
            "user_goal": user_goal,
            "canvas_context": [],
            "input_assets": [],
        },
        "analysis": {"entities": [], "production_units": [], "risks": []},
        "phases": phases,
        "assumptions": list(intent.get("assumptions") or []),
        "missing_inputs": [],
        "expansion_rules": {"item_count": len(items)},
        "inputs": resolved_inputs,
        "external_inputs": deepcopy(external_inputs),
        "nodes": nodes,
        "edges": edges,
        "layout": {
            "direction": "left_to_right",
            "groups": [
                {
                    "label": title,
                    "node_ids": [_text(node.get("id")) for node in nodes],
                }
            ],
        },
        "execution_policy": {
            "requires_user_confirmation": True,
            "auto_create_nodes": False,
            "auto_generate_content": False,
            "handoff_tool": "freezone_prepare_workflow_draft",
        },
    }
    # The intent compiler decides the planner path itself (compile_workflow_intent
    # reroutes template-shaped items); never reroute from inside compilation.
    validated = validate_agent_workflow_plan(plan, allow_template_reroute=False)
    if not validated.get("ok"):
        return {
            **validated,
            "status": "compiled_workflow_plan_invalid",
            "compiled_plan": plan,
        }
    return {
        "ok": True,
        "status": "workflow_intent_compiled",
        "schema_version": WORKFLOW_INTENT_SCHEMA_VERSION,
        "skill_id": skill_id,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "preflight": validated.get("preflight") or {},
        "plan": plan,
    }


def _dynamic_default_model(recipe: dict[str, Any]) -> str:
    if _text(recipe.get("output_kind")) != "audio":
        return ""
    searchable = " ".join(
        [
            _text(recipe.get("id")),
            _text(recipe.get("name")),
            *[_text(item) for item in recipe.get("action_keys") or []],
        ]
    ).lower()
    return (
        "suno_music"
        if any(token in searchable for token in ("music", "bgm", "音乐", "配乐"))
        else "edge-tts"
    )


def _intent_audio_kind(item: dict[str, Any], recipe: dict[str, Any] | None) -> str:
    explicit = _text(item.get("audio_kind") or item.get("audioKind")).lower()
    if explicit in {"music", "speech"}:
        return explicit

    model = _text(item.get("model")).lower()
    if model:
        return "music" if model == "suno_music" else "speech"
    if _text(item.get("narration")):
        return "speech"

    searchable = " ".join(
        [
            _text(item.get("id")),
            _text(item.get("title")),
            _text(item.get("timeline_role") or item.get("timelineRole")),
            _text(item.get("prompt")),
            _text(recipe.get("id") if recipe else ""),
            _text(recipe.get("name") if recipe else ""),
        ]
    ).lower()
    return (
        "music"
        if any(
            token in searchable
            for token in ("background_music", "bgm", "背景音乐", "配乐", "纯音乐")
        )
        else "speech"
    )


def _looks_like_speech_generation_instruction(value: Any) -> bool:
    text = _text(value)
    if not text:
        return False
    return bool(
        re.search(
            r"(?:根据|基于|使用|提取|将).{0,40}(?:旁白|文案|脚本|广告词).{0,40}"
            r"(?:生成|制作|转换|合成).{0,12}(?:旁白|配音|语音|音频)"
            r"|(?:生成|制作).{0,20}(?:旁白配音|语音音频)",
            text,
            re.IGNORECASE,
        )
    )


def _duration_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(float(value) * 1000)
    text = _text(value).lower()
    if not text:
        return None
    minute_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:分钟|分|min(?:ute)?s?)", text)
    if minute_match:
        return int(float(minute_match.group(1)) * 60_000)
    second_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)", text)
    if second_match:
        return int(float(second_match.group(1)) * 1000)
    return None


def _positive_duration_seconds(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return max(1, min(int(round(float(value))), 600))
    text = _text(value)
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return max(1, min(int(round(float(text))), 600))
    parsed_ms = _duration_ms(text)
    if parsed_ms is None:
        return None
    return max(1, min(int(round(parsed_ms / 1000)), 600))


def _planner_total_duration_seconds(
    *,
    planner: dict[str, Any],
    resolved_inputs: dict[str, Any],
    user_goal: str,
) -> int | None:
    for key in (
        "total_duration_seconds",
        "totalDurationSeconds",
        "target_duration_seconds",
        "targetDurationSeconds",
        "duration_seconds",
        "durationSeconds",
        "duration",
    ):
        parsed = _positive_duration_seconds(planner.get(key))
        if parsed is not None:
            return parsed
    for key in ("total_duration", "target_duration", "video_duration", "duration"):
        parsed = _positive_duration_seconds(resolved_inputs.get(key))
        if parsed is not None:
            return parsed
    parsed_ms = _duration_ms(user_goal)
    return int(round(parsed_ms / 1000)) if parsed_ms is not None else None


def _intent_music_length_ms(
    item: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> int | None:
    explicit = item.get("music_length_ms") or item.get("musicLengthMs")
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool):
        return max(3_000, min(int(explicit), 600_000))
    for key in ("total_duration", "target_duration", "video_duration", "duration"):
        parsed = _duration_ms(resolved_inputs.get(key))
        if parsed:
            return max(3_000, min(parsed + 1_000, 600_000))
    for value in (user_goal, item.get("prompt")):
        parsed = _duration_ms(value)
        if parsed:
            return max(3_000, min(parsed + 1_000, 600_000))
    return None


_INTENT_FIX_INSTRUCTION = (
    "Fix the intent fields listed in `errors` and call this tool again with the "
    "corrected freezone_workflow_intent.v1. Each error message (and `hint`, when "
    "present) already contains everything needed to fix the payload — do NOT "
    "search or read plugin/source code to debug validation rules."
)


def _intent_error(
    message: str, *, path: str, hint: str | None = None
) -> dict[str, Any]:
    error: dict[str, Any] = {"path": path, "message": message}
    if hint:
        error["hint"] = hint
    return {
        "ok": False,
        "status": "invalid_workflow_intent",
        "error": message,
        "errors": [error],
        "agent_instruction": _INTENT_FIX_INSTRUCTION,
    }


def _intent_bool(intent: dict[str, Any], key: str, default: bool) -> bool:
    value = intent.get(key)
    if value is None:
        return default
    return value if isinstance(value, bool) else default


def _intent_recipe_index() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for recipe in _load_agent_config_items("recipes", _RECIPES_DIR):
        if recipe.get("enabled") is False:
            continue
        recipe_id = _text(recipe.get("id"))
        if recipe_id:
            result[recipe_id] = recipe
        for field in ("actionKeys", "action_keys", "operationTypes", "operation_types"):
            for action_key in recipe.get(field) or []:
                if _text(action_key):
                    result.setdefault(_text(action_key), recipe)
    return result


def _recipe_pipeline_conflict(
    recipes: list[dict[str, Any]],
) -> tuple[str, str] | None:
    recipe_ids = {
        _text(recipe.get("id")) for recipe in recipes if _text(recipe.get("id"))
    }
    for recipe in recipes:
        recipe_id = _text(recipe.get("id"))
        conflicts = {
            _text(item) for item in recipe.get("conflicts_with") or [] if _text(item)
        }
        matched = sorted((conflicts & recipe_ids) - {recipe_id})
        if matched:
            return recipe_id, matched[0]
    return None


def _intent_items(intent: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = intent.get("items") or intent.get("shots") or []
    if not isinstance(raw_items, list):
        return []
    items: list[dict[str, Any]] = []
    for raw_item in raw_items[:24]:
        if isinstance(raw_item, str) and raw_item.strip():
            items.append({"title": raw_item.strip(), "prompt": raw_item.strip()})
        elif isinstance(raw_item, dict):
            title = _text(raw_item.get("title") or raw_item.get("name"))
            prompt = _text(
                raw_item.get("prompt")
                or raw_item.get("description")
                or raw_item.get("goal")
            )
            narration = _text(
                raw_item.get("narration")
                or raw_item.get("voiceover")
                or raw_item.get("dialogue")
                or raw_item.get("speech_text")
                or raw_item.get("speechText")
            )
            step_id = _text(raw_item.get("step_id") or raw_item.get("stepId"))
            duration_seconds = _positive_duration_seconds(
                raw_item.get("duration_seconds")
                or raw_item.get("durationSeconds")
                or raw_item.get("duration")
            )
            if duration_seconds is None:
                duration_seconds = _positive_duration_seconds(prompt)
            if title or prompt or narration:
                items.append(
                    {
                        **(
                            {"id": _safe_id(_text(raw_item.get("id")))}
                            if _text(raw_item.get("id"))
                            else {}
                        ),
                        "title": title or prompt or narration,
                        "prompt": prompt or title or narration,
                        **({"narration": narration} if narration else {}),
                        **({"step_id": _safe_id(step_id)} if step_id else {}),
                        **(
                            {
                                "recipe_id": _text(
                                    raw_item.get("recipe_id")
                                    or raw_item.get("recipeId")
                                )
                            }
                            if _text(
                                raw_item.get("recipe_id") or raw_item.get("recipeId")
                            )
                            else {}
                        ),
                        **(
                            {
                                "recipe_pipeline": list(
                                    raw_item.get("recipe_pipeline")
                                    or raw_item.get("recipePipeline")
                                )
                            }
                            if isinstance(
                                raw_item.get("recipe_pipeline")
                                or raw_item.get("recipePipeline"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {
                                "depends_on": list(
                                    raw_item.get("depends_on")
                                    or raw_item.get("dependsOn")
                                )
                            }
                            if isinstance(
                                raw_item.get("depends_on") or raw_item.get("dependsOn"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {
                                "reference_inputs": list(
                                    raw_item.get("reference_inputs")
                                    or raw_item.get("referenceInputs")
                                )
                            }
                            if isinstance(
                                raw_item.get("reference_inputs")
                                or raw_item.get("referenceInputs"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {"stage": _text(raw_item.get("stage"))}
                            if _text(raw_item.get("stage"))
                            else {}
                        ),
                        **(
                            {
                                "timeline_role": _text(
                                    raw_item.get("timeline_role")
                                    or raw_item.get("timelineRole")
                                )
                            }
                            if _text(
                                raw_item.get("timeline_role")
                                or raw_item.get("timelineRole")
                            )
                            else {}
                        ),
                        **(
                            {"model": _text(raw_item.get("model"))}
                            if _text(raw_item.get("model"))
                            else {}
                        ),
                        **(
                            {
                                "audio_kind": _text(
                                    raw_item.get("audio_kind")
                                    or raw_item.get("audioKind")
                                ).lower()
                            }
                            if _text(
                                raw_item.get("audio_kind") or raw_item.get("audioKind")
                            ).lower()
                            in {"music", "speech"}
                            else {}
                        ),
                        **(
                            {
                                "music_length_ms": int(
                                    raw_item.get("music_length_ms")
                                    or raw_item.get("musicLengthMs")
                                )
                            }
                            if isinstance(
                                raw_item.get("music_length_ms")
                                or raw_item.get("musicLengthMs"),
                                (int, float),
                            )
                            and not isinstance(
                                raw_item.get("music_length_ms")
                                or raw_item.get("musicLengthMs"),
                                bool,
                            )
                            else {}
                        ),
                        **(
                            {"duration_seconds": duration_seconds}
                            if duration_seconds is not None
                            else {}
                        ),
                    }
                )
    return items


def _intent_dependency_edges(
    source_ids: list[str],
    target_ids: list[str],
    *,
    node_types: dict[str, str],
) -> list[dict[str, str]]:
    pairs = (
        list(zip(source_ids, target_ids, strict=True))
        if len(source_ids) == len(target_ids) and len(source_ids) > 1
        else [
            (source_id, target_id)
            for source_id in source_ids
            for target_id in target_ids
        ]
    )
    return [
        {
            "source": source_id,
            "target": target_id,
            "link_type": _intent_link_type(
                node_types.get(source_id, ""),
                node_types.get(target_id, ""),
            ),
        }
        for source_id, target_id in pairs
    ]


def _intent_link_type(source_type: str, target_type: str) -> str:
    if target_type == "videoComposeNode":
        return "composition_input_for"
    if source_type == "videoNode" and target_type == "videoNode":
        # A previous generated shot may gate the next workflow step without
        # becoming an R2V reference. Otherwise Seedance receives every prior
        # shot and can exceed its 15.2-second total reference-video limit.
        return "dependency_for"
    if source_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
        if target_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
            return "context_for"
        # A planning document can gate a media stage, but it is not the stage's
        # final execution prompt. The Recipe compiles that prompt from the
        # item's own prompt and the Skill constraints.
        return "dependency_for"
    if source_type in {"imageGenNode", "videoNode", "audioNode"}:
        return "media_input_for"
    return "context_for"


def _intent_reference_link_type(source_type: str, target_type: str) -> str:
    """Choose a typed input edge for an explicit Agent reference.

    ``reference_inputs`` means that the target consumes the referenced node, but
    it does not imply that every reference is media. Text references are prompts;
    only generated media may use ``media_input_for``.
    """
    if target_type == "videoComposeNode":
        return "composition_input_for"
    if source_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
        if target_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
            return "context_for"
        return "prompt_for"
    if source_type in {"imageGenNode", "videoNode", "audioNode"}:
        return "media_input_for"
    return _intent_link_type(source_type, target_type)


def _is_redundant_compose_item(item_id: str, item: dict[str, Any]) -> bool:
    normalized_id = item_id.strip().lower().replace("-", "_")
    if normalized_id in {
        "compose",
        "final_compose",
        "final_composition",
        "video_compose",
    }:
        return True
    title = _text(item.get("title")).strip().lower()
    return title in {
        "最终合成",
        "成片合成",
        "最终成片合成",
        "final compose",
        "final composition",
    }


def _intent_item_node(
    *,
    skill: dict[str, Any],
    recipe: dict[str, Any] | None,
    node_type: str,
    item_id: str,
    item: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
    recipe_pipeline: list[dict[str, Any]],
) -> dict[str, Any]:
    label = (_text(item.get("title")) or _text(item.get("prompt")) or item_id)[:64]
    audio_kind = _intent_audio_kind(item, recipe) if node_type == "audioNode" else ""
    model = _text(item.get("model"))
    if not model:
        model = (
            "suno_music"
            if audio_kind == "music"
            else _dynamic_default_model(recipe or {})
        )
    item_prompt = _text(item.get("prompt"))
    if node_type == "audioNode" and model in {
        "edge-tts",
        "LingShan-TTS-2",
        "qwen3-tts-flash",
    }:
        item_prompt = _text(item.get("narration")) or item_prompt
    prompt = item_prompt or label
    timeline_role = _text(item.get("timeline_role") or item.get("timelineRole"))
    recipe_id = _text(recipe.get("id") if recipe else "")
    operation_type = next(
        (
            _text(action_key)
            for action_key in (recipe.get("action_keys") if recipe else []) or []
            if _text(action_key)
        ),
        recipe_id,
    )
    data: dict[str, Any] = {
        "displayName": label,
        "title": label,
        "content": prompt,
        "prompt": prompt,
        "description": prompt,
        "workflowCatalog": {
            "skillId": _text(skill.get("id")),
            "skillVersion": skill.get("version"),
            "confirmedInputs": resolved_inputs,
            "stepId": item_id,
            **({"timelineRole": timeline_role} if timeline_role else {}),
            "operationType": operation_type,
            "recipeId": recipe_id,
            "recipeName": _text(recipe.get("name") if recipe else ""),
            "recipeVersion": recipe.get("version") if recipe else None,
            "recipePipeline": [
                {
                    "id": _text(pipeline_recipe.get("id")),
                    "name": _text(pipeline_recipe.get("name")),
                    "version": pipeline_recipe.get("version"),
                }
                for pipeline_recipe in recipe_pipeline
            ],
            "promptStrategy": "llm_refine",
            "inputStrategy": {},
            "promptBuilder": {
                "userGoal": user_goal,
                "goalTemplate": label,
                "recipeId": recipe_id,
                **({"planItem": item} if item else {}),
            },
        },
    }
    generation_model = _text(
        resolved_inputs.get("image_model")
        if node_type == "imageGenNode"
        else resolved_inputs.get("video_model") if node_type == "videoNode" else ""
    )
    if generation_model:
        data["model"] = generation_model
    elif model:
        data["model"] = model
    aspect_ratio = _text(
        resolved_inputs.get("image_aspect_ratio")
        if node_type == "imageGenNode"
        else (
            resolved_inputs.get("video_aspect_ratio")
            if node_type == "videoNode"
            else ""
        )
    ) or _text(resolved_inputs.get("aspect_ratio"))
    if aspect_ratio and node_type in {"imageGenNode", "videoNode"}:
        data["aspectRatio"] = aspect_ratio
    if node_type == "imageGenNode":
        image_resolution = _text(resolved_inputs.get("image_resolution"))
        image_quality = _text(resolved_inputs.get("image_quality"))
        image_variants = resolved_inputs.get("image_variants_per_node")
        if image_resolution:
            data["size"] = image_resolution
        if image_quality:
            data["quality"] = image_quality
        if isinstance(image_variants, int) and not isinstance(image_variants, bool):
            data["count"] = image_variants
    if node_type == "videoNode":
        duration_seconds = _positive_duration_seconds(item.get("duration_seconds"))
        if duration_seconds is None:
            duration_seconds = _positive_duration_seconds(
                resolved_inputs.get("video_duration_seconds")
            )
        if duration_seconds is not None:
            data["durationSec"] = duration_seconds
        video_resolution = _text(resolved_inputs.get("video_resolution"))
        video_mode = _text(resolved_inputs.get("video_generation_mode"))
        video_variants = resolved_inputs.get("video_variants_per_node")
        if video_resolution:
            data["quality"] = video_resolution
        if video_mode:
            data["genMode"] = video_mode
        if isinstance(resolved_inputs.get("video_generate_audio"), bool):
            data["generateAudio"] = resolved_inputs["video_generate_audio"]
        if isinstance(video_variants, int) and not isinstance(video_variants, bool):
            data["count"] = video_variants
    if node_type == "audioNode":
        data["text"] = prompt
        if audio_kind == "music":
            data["audioKind"] = "music"
            data["makeInstrumental"] = True
            data["sunoGptDescriptionPrompt"] = prompt
            music_length_ms = _intent_music_length_ms(item, user_goal, resolved_inputs)
            if music_length_ms is not None:
                data["musicLengthMs"] = music_length_ms
        else:
            data["audioKind"] = "speech"
            data["speechMode"] = "clone"
            data["voiceAvailable"] = False
            data["languageType"] = "Chinese"
    if node_type == "htmlArtifactNode":
        data = {
            key: value for key, value in data.items()
            if key in {"displayName", "title", "prompt", "workflowCatalog"}
        }
    return {
        "id": item_id,
        "node_type": node_type,
        "name": label,
        "description": prompt,
        "stage": _STAGE_BY_NODE_TYPE.get(node_type, "story"),
        "data": data,
    }


def _dedupe_intent_edges(edges: list[dict[str, str]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for edge in edges:
        key = (edge["source"], edge["target"], edge["link_type"])
        if key not in seen:
            result.append(edge)
            seen.add(key)
    return result


# Portable generation preferences the standard planner writes into node data
# (see _intent_item_node). An agent-authored plan gets the same runtime fields
# backfilled from the Skill input contract so both paths produce comparable
# nodes: an explicit node value always wins, only absent fields are filled.
_PLAN_RUNTIME_BACKFILL_FIELDS: dict[str, tuple[tuple[str, str], ...]] = {
    "imageGenNode": (
        ("image_model", "model"),
        ("image_aspect_ratio", "aspectRatio"),
        ("image_resolution", "size"),
        ("image_quality", "quality"),
        ("image_variants_per_node", "count"),
    ),
    "videoNode": (
        ("video_model", "model"),
        ("video_aspect_ratio", "aspectRatio"),
        ("video_resolution", "quality"),
        ("video_duration_seconds", "durationSec"),
        ("video_generation_mode", "genMode"),
        ("video_generate_audio", "generateAudio"),
        ("video_variants_per_node", "count"),
    ),
}


def _backfill_plan_runtime_fields(
    nodes: list[Any], resolved_inputs: dict[str, Any]
) -> dict[str, list[str]]:
    """Fill absent generation fields on plan nodes from resolved Skill inputs.

    Returns ``{node_id: [field, ...]}`` for every field that was written, so the
    draft can show which values came from preferences rather than the plan.
    """
    filled: dict[str, list[str]] = {}
    if not isinstance(resolved_inputs, dict) or not resolved_inputs:
        return filled
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_type = _text(node.get("node_type") or node.get("type"))
        fields = _PLAN_RUNTIME_BACKFILL_FIELDS.get(node_type)
        if not fields:
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            data = {}
            node["data"] = data
        for input_key, field in fields:
            if data.get(field) is not None:
                continue
            raw = resolved_inputs.get(input_key)
            if field == "aspectRatio" and not _text(raw):
                # Same precedence as _intent_item_node: the media-specific
                # ratio first, then the universal aspect_ratio preference.
                raw = resolved_inputs.get("aspect_ratio")
            value: Any
            if field == "durationSec":
                value = _positive_duration_seconds(raw)
            elif field == "generateAudio":
                value = raw if isinstance(raw, bool) else None
            elif field == "count":
                value = raw if isinstance(raw, int) and not isinstance(raw, bool) else None
            else:
                value = _text(raw) or None
            if value is None:
                continue
            data[field] = value
            filled.setdefault(_text(node.get("id")) or node_type, []).append(field)
    return filled


def validate_agent_workflow_plan(
    plan: Any, *, username: str | None = None, allow_template_reroute: bool = True
) -> dict[str, Any]:
    """Strictly validate an agent-authored plan against the live catalog.

    A raw plan that restates the Skill's standard template (issue #678) is
    compiled through the standard planner instead and returned in the same
    validated shape with ``planner.selected_by = template_isomorphic``;
    ``allow_template_reroute=False`` skips that (used when validating the
    standard planner's own output).
    """
    if validate_workflow_plan is None:
        return {
            "ok": False,
            "status": "workflow_plan_validation_unavailable",
            "error": "workflow plan validation is unavailable",
        }
    if username is not None:
        # HTTP callers must supply the authenticated catalog owner explicitly.
        # Never fall back to process-wide agent environment or another catalog.
        if not username.strip() or list_user_agent_config_items is None:
            raise ValueError("workflow catalog identity is unavailable")
        skill_items = list_user_agent_config_items(username, "skills")
        recipe_items = _normalize_agent_config_items(
            "recipes", list_user_agent_config_items(username, "recipes")
        )
    else:
        skill_items = _load_skills()
        recipe_items = _load_agent_config_items("recipes", _RECIPES_DIR)
    skills = {
        _text(skill.get("id")): skill
        for skill in skill_items
        if _text(skill.get("id"))
        and skill.get("_disabled") is not True
        and skill.get("enabled") is not False
    }
    recipes = {
        _text(recipe.get("id")): recipe
        for recipe in recipe_items
        if _text(recipe.get("id")) and recipe.get("enabled") is not False
    }
    validated = validate_workflow_plan(
        plan,
        skills_by_id=skills,
        recipes_by_id=recipes,
    )
    if not validated.get("ok"):
        return validated
    skill_id = _text(validated.get("skill_id"))
    allowed_capabilities = _skill_capabilities(skills[skill_id])
    allowed_node_types = {
        node_type
        for node_type, capability in _CAPABILITY_BY_NODE_TYPE.items()
        if capability in allowed_capabilities
    }
    allowed_node_types.add("textAnnotationNode")
    if "videoNode" in allowed_node_types:
        allowed_node_types.add("videoComposeNode")
    allowed_recipe_ids = {
        _text(recipe.get("id"))
        for recipe in _workflow_skill_recipe_candidates(
            skills[skill_id], list(recipes.values())
        )
    }
    errors: list[dict[str, str]] = []
    plan_inputs = plan.get("inputs", {})
    if not isinstance(plan_inputs, dict):
        errors.append({"path": "inputs", "message": "must be an object"})
        plan_inputs = {}
    input_contract = _skill_input_contract(skills[skill_id], {"inputs": plan_inputs})
    errors.extend(input_contract["errors"])
    errors.extend(
        {
            "path": f"inputs.{parameter_id}",
            "message": "required Skill input is missing",
        }
        for parameter_id in input_contract["missing_required"]
    )
    for index, node in enumerate(plan.get("nodes") or []):
        node_type = (
            _text(node.get("node_type") or node.get("type"))
            if isinstance(node, dict)
            else ""
        )
        if node_type not in allowed_node_types:
            errors.append(
                {
                    "path": f"nodes[{index}].node_type",
                    "message": f"node type {node_type} is not allowed by skill {skill_id}",
                }
            )
        data = node.get("data") if isinstance(node, dict) else None
        catalog = data.get("workflowCatalog") if isinstance(data, dict) else None
        recipe_id = _text(catalog.get("recipeId")) if isinstance(catalog, dict) else ""
        recipe_pipeline = (
            (catalog.get("recipePipeline") or []) if isinstance(catalog, dict) else []
        )
        data_stage = data.get("stage") if isinstance(data, dict) else None
        stage = _text(node.get("stage") or data_stage) if isinstance(node, dict) else ""
        requires_recipe = node_type in {
            "imageGenNode",
            "videoNode",
            "audioNode",
            "scriptNode",
            "beatContextNode",
        } or (
            node_type == "textAnnotationNode"
            and stage not in {"input", "resource", "asset"}
        )
        if requires_recipe and not recipe_id:
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipeId",
                    "message": f"executable node {node.get('id')} requires an explicit recipeId",
                }
            )
        if recipe_id and recipe_id not in allowed_recipe_ids:
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipeId",
                    "message": f"recipe {recipe_id} is not allowed by skill {skill_id}",
                }
            )
        if not isinstance(recipe_pipeline, list):
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipePipeline",
                    "message": "recipePipeline must be an array",
                }
            )
        else:
            for pipeline_index, pipeline_value in enumerate(recipe_pipeline):
                pipeline_id = _text(
                    pipeline_value.get("id")
                    if isinstance(pipeline_value, dict)
                    else pipeline_value
                )
                if pipeline_id and pipeline_id not in allowed_recipe_ids:
                    errors.append(
                        {
                            "path": (
                                f"nodes[{index}].data.workflowCatalog."
                                f"recipePipeline[{pipeline_index}]"
                            ),
                            "message": (
                                f"recipe {pipeline_id} is not allowed by skill {skill_id}"
                            ),
                        }
                    )
    if errors:
        return {
            "ok": False,
            "status": "invalid_dynamic_workflow_plan",
            "error": errors[0]["message"],
            "errors": errors,
        }
    validated_plan = validated.get("plan") if isinstance(validated.get("plan"), dict) else {}
    backfilled = _backfill_plan_runtime_fields(
        validated_plan.get("nodes") or [], input_contract["resolved"]
    )
    if backfilled:
        validated["backfilled_runtime_fields"] = backfilled
        if _build_plan_preflight is not None:
            # Planned duration and warnings must reflect the backfilled nodes.
            validated["preflight"] = _build_plan_preflight(validated_plan.get("nodes") or [])
    validated["resolved_inputs"] = input_contract["resolved"]
    validated["execution_mode"] = input_contract["execution_mode"]
    validated["recommended_run_after_create"] = input_contract[
        "recommended_run_after_create"
    ]
    # A raw plan that skips a stage the Skill's standard planner always emits
    # (e.g. a short drama without shot planning) is a preflight blocker, not a
    # schema error: the draft can be revised or re-planned (issue #677).
    _attach_skill_stage_blockers(validated, skill_id)
    stamped = plan.get("planner") if isinstance(plan.get("planner"), dict) else None
    if stamped and _text(stamped.get("mode")) == "deterministic_standard":
        # The standard planner's own output keeps its audit record.
        validated["planner"] = deepcopy(stamped)
        return validated
    match = template_isomorphism(skill_id, plan) if allow_template_reroute else None
    if match is not None and match["isomorphic"]:
        compiled, match = _compile_isomorphic_plan_through_template(
            skill_id=skill_id,
            user_goal=_plan_goal_text(plan),
            inputs=plan.get("inputs"),
            match=match,
        )
        if compiled is not None:
            rerouted = validate_agent_workflow_plan(
                compiled["plan"], username=username, allow_template_reroute=False
            )
            if rerouted.get("ok"):
                # Only when the standard planner reproduces the agent's plan node
                # for node: a plan it cannot express stays agent-authored.
                mismatch = _template_round_trip_reason(validated_plan, rerouted["plan"])
                if mismatch is None:
                    rerouted["planner"] = _template_planner_metadata(
                        compiled["planner"],
                        source="exact_plan",
                        requested_mode="",
                        match=match,
                    )
                    return rerouted
                match = {"isomorphic": False, "reason": mismatch}
            else:
                match = {
                    "isomorphic": False,
                    "reason": f"standard_validate_failed:{_text(rerouted.get('error'))}",
                }
    validated["planner"] = _agent_authored_planner_metadata(
        skill_id,
        source="exact_plan",
        item_count=len(validated_plan.get("nodes") or []),
        template_match=match,
    )
    return validated


def _load_skill(skill_id: str) -> dict[str, Any] | None:
    wanted = _alias_key(skill_id)
    for skill in _load_skills():
        if _alias_key(_text(skill.get("id"))) == wanted:
            return skill
    return None


def _load_skills() -> list[dict[str, Any]]:
    return _load_agent_config_items("skills", _SKILLS_DIR, _PLUGIN_SKILLS_DIR)


def _skill_capabilities(skill: dict[str, Any]) -> list[str]:
    capabilities: list[str] = []
    triggers = skill.get("triggers") if isinstance(skill.get("triggers"), dict) else {}
    raw_scopes = triggers.get("node_scopes") or triggers.get("nodeScopes") or []
    for scope in raw_scopes if isinstance(raw_scopes, list) else []:
        normalized = _text(scope)
        aliases = {
            "text": "textGeneration",
            "image": "imageGeneration",
            "video": "videoGeneration",
            "audio": "audioGeneration",
            "compose": "videoCompose",
        }
        capability = aliases.get(normalized, normalized)
        if capability in _OUTPUT_KIND_BY_CAPABILITY or capability == "videoCompose":
            if capability not in capabilities:
                capabilities.append(capability)
    if not capabilities:
        capabilities = list(_OUTPUT_KIND_BY_CAPABILITY)
    return capabilities


def _skill_referenced_recipe_ids(skill: dict[str, Any]) -> set[str]:
    references = {
        _text(item)
        for field in (
            "recipe_ids",
            "recipeIds",
            "allowed_recipe_ids",
            "allowedRecipeIds",
        )
        for item in (skill.get(field) if isinstance(skill.get(field), list) else [])
        if _text(item)
    }
    return references


def _workflow_skill_recipe_candidates(
    skill: dict[str, Any],
    recipes: list[dict[str, Any]],
    *,
    allowed_capabilities: list[str] | None = None,
) -> list[dict[str, Any]]:
    capabilities = allowed_capabilities or _skill_capabilities(skill)
    output_kinds = {
        _OUTPUT_KIND_BY_CAPABILITY[capability]
        for capability in capabilities
        if capability in _OUTPUT_KIND_BY_CAPABILITY
    }
    references = _skill_referenced_recipe_ids(skill)
    general_recipe_ids = {f"general-{output_kind}" for output_kind in output_kinds}
    candidates: list[dict[str, Any]] = []
    for recipe in recipes:
        recipe_id = _text(recipe.get("id"))
        action_keys = {
            _text(item)
            for field in (
                "actionKeys",
                "action_keys",
                "operationTypes",
                "operation_types",
            )
            for item in (
                recipe.get(field) if isinstance(recipe.get(field), list) else []
            )
            if _text(item)
        }
        output_kind = _text(
            recipe.get("output_kind")
            or recipe.get("generationType")
            or recipe.get("generation_type")
        )
        explicitly_referenced = recipe_id in references or bool(
            action_keys & references
        )
        if (
            explicitly_referenced
            or recipe_id in general_recipe_ids
            or (not references and (not output_kinds or output_kind in output_kinds))
        ):
            candidates.append(recipe)
    candidates.sort(key=lambda item: _text(item.get("id")))
    return candidates


def _recipe_matches_references(recipe: dict[str, Any], references: set[str]) -> bool:
    if _text(recipe.get("id")) in references:
        return True
    return any(
        _text(item) in references
        for field in ("actionKeys", "action_keys", "operationTypes", "operation_types")
        for item in (recipe.get(field) if isinstance(recipe.get(field), list) else [])
    )


def _recipe_node_type(recipe: dict[str, Any]) -> str | None:
    output_kind = _text(
        recipe.get("output_kind") or recipe.get("generationType") or recipe.get("generation_type")
    )
    if recipe.get("output_format") == "html":
        return "htmlArtifactNode" if output_kind == "text" else None
    return _NODE_TYPE_BY_OUTPUT_KIND.get(output_kind)


def _recipe_planning_summary(recipe: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _text(recipe.get("id")),
        "name": _text(recipe.get("name") or recipe.get("label")),
        "version": recipe.get("version"),
        **({"output_format": recipe["output_format"]} if recipe.get("output_format") else {}),
        "node_type": _recipe_node_type(recipe),
        "output_kind": _text(
            recipe.get("output_kind")
            or recipe.get("generationType")
            or recipe.get("generation_type")
        ),
        "action_keys": [
            _text(item)
            for field in (
                "actionKeys",
                "action_keys",
                "operationTypes",
                "operation_types",
            )
            for item in (
                recipe.get(field) if isinstance(recipe.get(field), list) else []
            )
            if _text(item)
        ],
        "planning_prompt": _text(
            recipe.get("planning_prompt") or recipe.get("planningPrompt")
        ),
        "result_summary": _text(
            recipe.get("result_summary") or recipe.get("resultSummary")
        ),
        "requires_source_media": bool(
            recipe.get("requires_source_media") or recipe.get("requiresSourceMedia")
        ),
        "conflicts_with": [
            _text(item) for item in recipe.get("conflicts_with") or [] if _text(item)
        ],
    }


def _without_private_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_private_fields(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [_without_private_fields(item) for item in value]
    return value


def _load_agent_config_items(
    kind: str, fallback_dir: Path, project_dir: Path | None = None
) -> list[dict[str, Any]]:
    snapshot = _REQUEST_CATALOG.get()
    if snapshot is not None:
        return deepcopy(snapshot[kind])
    if list_user_agent_config_items is not None:
        username = _catalog_username()
        if username:
            try:
                loaded_items = list_user_agent_config_items(username, kind)
                return _normalize_agent_config_items(kind, loaded_items)
            except Exception:
                pass

    if project_dir is None:
        project_dir = _PLUGIN_RECIPES_DIR if kind == "recipes" else _PLUGIN_SKILLS_DIR
    fallback_items = _load_json_dir(fallback_dir)
    if project_dir is not None:
        project_items = [
            {**item, "_catalog_source": "builtin"}
            for item in _load_json_dir(project_dir)
        ]
        if project_items:
            fallback_items = _merge_agent_config_items(fallback_items, project_items)
    if kind == "skills":
        fallback_items = [
            item for item in fallback_items if item.get("allowed_recipe_ids")
        ]
    return _normalize_agent_config_items(kind, fallback_items)


def _normalize_agent_config_items(
    kind: str, items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if kind != "recipes":
        return items
    normalized: list[dict[str, Any]] = []
    for item in items:
        if _text(item.get("id")) in _TEXT_FIRST_BUILTIN_RECIPE_IDS:
            normalized.append({**item, "requires_source_media": False})
        else:
            normalized.append(item)
    return normalized


def _merge_agent_config_items(
    builtin_items: list[dict[str, Any]],
    loaded_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge code fallback builtins with user/config-store items."""

    by_id: dict[str, dict[str, Any]] = {
        _text(item.get("id")): {
            **item,
            "_catalog_source": item.get("_catalog_source") or "builtin",
        }
        for item in builtin_items
        if _text(item.get("id"))
    }
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in loaded_items:
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        if not item_id:
            continue
        if item.get("hidden") is True:
            by_id.pop(item_id, None)
            seen.add(item_id)
            continue
        base = by_id.pop(item_id, {})
        merged = {**base, **item}
        merged.setdefault("_catalog_source", item.get("_catalog_source") or "user")
        ordered.append(merged)
        seen.add(item_id)
    ordered.extend(
        item for item_id, item in sorted(by_id.items()) if item_id not in seen
    )
    return ordered


def _catalog_username() -> str:
    # The hosted MCP adapter binds this identity from the authenticated turn.
    authenticated_user = os.environ.get("DRAMACLAW_USERNAME", "").strip()
    if authenticated_user:
        return authenticated_user
    if os.environ.get("ST_EDITION", "").strip().lower() == "ce":
        return "local"
    return (
        os.environ.get("DRAMACLAW_USERNAME")
        or os.environ.get("DRAMACLAW_USER")
        or os.environ.get("SUPERTALE_USER")
        or os.environ.get("FREEZONE_USER")
        or "local"
    ).strip()


def _catalog_source(payload: dict[str, Any]) -> str:
    return _text(payload.get("_catalog_source")) or "builtin"


def _load_json_dir(path: Path) -> list[dict[str, Any]]:
    if not path.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for file_path in sorted(path.glob("*.json")):
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict):
            items.append(payload)
        elif isinstance(payload, list):
            items.extend(item for item in payload if isinstance(item, dict))
    return items


def _catalog_label(skill: dict[str, Any]) -> str:
    return (
        _text(skill.get("name") or skill.get("label") or skill.get("id"))
        or "配置工作流"
    )


def _workflow_goal_text(args: dict[str, Any]) -> str:
    for field in (
        "user_goal",
        "userGoal",
        "goal",
        "brief",
        "description",
        "message",
        "prompt",
        "title",
        "name",
    ):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            return re.sub(r"\s+", " ", value.strip())
    return ""


def _alias_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _safe_id(value: str) -> str:
    text = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", value.strip())
    text = re.sub(r"_+", "_", text).strip("_-")
    return text[:64] or "catalog_step"


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "status": "catalog_workflow_error", "error": message}
