"""Strict validation for agent-authored Freezone workflow plans."""

from __future__ import annotations

import re
from typing import Any

from novelvideo.freezone.workflow_schema import (
    LINK_TYPE_VALUES,
    NODE_TYPE_VALUES,
    WORKFLOW_PLAN_SCHEMA_VERSION,
)

MAX_WORKFLOW_NODES = 200
MAX_WORKFLOW_EDGES = 400

ALLOWED_NODE_TYPES = set(NODE_TYPE_VALUES)
ALLOWED_LINK_TYPES = set(LINK_TYPE_VALUES)

_OBJECT_TYPE_BY_NODE_TYPE = {
    "textAnnotationNode": "TextNode",
    "scriptNode": "ScriptNode",
    "beatContextNode": "TextNode",
    "imageGenNode": "ImageNode",
    "videoNode": "VideoNode",
    "audioNode": "AudioNode",
    "videoComposeNode": "VideoNode",
}

_LINK_RULES = {
    "context_for": ({"TextNode", "ScriptNode"}, {"TextNode", "ScriptNode"}),
    "prompt_for": (
        {"TextNode", "ScriptNode"},
        {"ImageNode", "VideoNode", "AudioNode", "ScriptNode"},
    ),
    "dependency_for": (
        {"TextNode", "ScriptNode", "ImageNode", "VideoNode", "AudioNode"},
        {"TextNode", "ScriptNode", "ImageNode", "VideoNode", "AudioNode"},
    ),
    "media_input_for": (
        {"ImageNode", "VideoNode", "AudioNode"},
        {"TextNode", "ImageNode", "VideoNode", "AudioNode", "ScriptNode"},
    ),
    "derived_from": (
        {"ImageNode", "VideoNode", "AudioNode"},
        {"ImageNode", "VideoNode", "AudioNode"},
    ),
    "composition_input_for": (
        {"TextNode", "ScriptNode", "ImageNode", "VideoNode", "AudioNode"},
        {"VideoNode"},
    ),
}

_OUTPUT_KIND_BY_NODE_TYPE = {
    "textAnnotationNode": "text",
    "scriptNode": "text",
    "beatContextNode": "text",
    "imageGenNode": "image",
    "videoNode": "video",
    "audioNode": "audio",
}

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

_PROMPT_STRATEGY_VALUES = {
    "template",
    "user_message",
    "previous_output",
    "llm_refine",
}

_USER_INPUT_STAGES = {"input", "resource", "asset"}
_USER_INPUT_STEP_IDS = {"workflow_input", "user_input", "user_requirement"}


def _node_type_value(node: dict[str, Any]) -> str:
    return str(node.get("node_type") or "").strip()


def _node_stage_value(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    return str(node.get("stage") or data.get("stage") or "").strip()


def _edge_link_type_value(edge: dict[str, Any]) -> str:
    return str(edge.get("link_type") or "").strip()


def validate_workflow_plan(
    payload: Any,
    *,
    skills_by_id: dict[str, dict[str, Any]] | None = None,
    recipes_by_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Validate an untrusted agent-authored plan without silently repairing it."""
    errors: list[dict[str, str]] = []
    if not isinstance(payload, dict):
        return _invalid([_issue("$", "plan must be an object")])
    if payload.get("schema_version") != WORKFLOW_PLAN_SCHEMA_VERSION:
        errors.append(
            _issue(
                "schema_version",
                f"must equal {WORKFLOW_PLAN_SCHEMA_VERSION}",
            )
        )
    if "run_after_create" in payload:
        errors.append(
            _issue(
                "run_after_create",
                "execution policy must be passed beside plan in the tool arguments",
            )
        )

    nodes = payload.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        errors.append(_issue("nodes", "must be a non-empty array"))
        nodes = []
    elif len(nodes) > MAX_WORKFLOW_NODES:
        errors.append(
            _issue("nodes", f"must contain at most {MAX_WORKFLOW_NODES} nodes")
        )

    expected_node_count = payload.get("expected_node_count")
    if expected_node_count is not None:
        if isinstance(expected_node_count, bool) or not isinstance(
            expected_node_count, int
        ):
            errors.append(_issue("expected_node_count", "must be an integer"))
        elif expected_node_count != len(nodes):
            errors.append(
                _issue(
                    "expected_node_count",
                    f"expected {expected_node_count} nodes but plan contains {len(nodes)}",
                )
            )

    expected_node_counts = payload.get("expected_node_counts")
    if expected_node_counts is not None:
        if not isinstance(expected_node_counts, dict):
            errors.append(_issue("expected_node_counts", "must be an object"))
        else:
            actual_node_counts = {
                node_type: sum(
                    1
                    for node in nodes
                    if isinstance(node, dict) and _node_type_value(node) == node_type
                )
                for node_type in ALLOWED_NODE_TYPES
            }
            for node_type, expected_count in expected_node_counts.items():
                path = f"expected_node_counts.{node_type}"
                if node_type not in ALLOWED_NODE_TYPES:
                    errors.append(_issue(path, f"unsupported node type: {node_type}"))
                elif isinstance(expected_count, bool) or not isinstance(
                    expected_count, int
                ):
                    errors.append(_issue(path, "must be an integer"))
                elif expected_count != actual_node_counts[node_type]:
                    errors.append(
                        _issue(
                            path,
                            f"expected {expected_count} but plan contains "
                            f"{actual_node_counts[node_type]}",
                        )
                    )

    node_types: dict[str, str] = {}
    node_values: dict[str, dict[str, Any]] = {}
    node_indexes: dict[str, int] = {}
    referenced_skill_ids: set[str] = set()
    source_required_nodes: dict[str, str] = {}
    source_satisfied_node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        path = f"nodes[{index}]"
        if not isinstance(node, dict):
            errors.append(_issue(path, "must be an object"))
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not _ID_RE.fullmatch(node_id):
            errors.append(_issue(f"{path}.id", "must be a safe, non-empty unique id"))
            continue
        if node_id in node_types:
            errors.append(_issue(f"{path}.id", f"duplicate node id: {node_id}"))
            continue
        node_type = str(node.get("node_type") or "").strip()
        if node_type not in ALLOWED_NODE_TYPES:
            errors.append(
                _issue(f"{path}.node_type", f"unsupported node type: {node_type}")
            )
            continue
        node_types[node_id] = node_type
        node_values[node_id] = node
        node_indexes[node_id] = index
        _validate_node_catalog_refs(
            node,
            path=path,
            node_type=node_type,
            skills_by_id=skills_by_id,
            recipes_by_id=recipes_by_id,
            referenced_skill_ids=referenced_skill_ids,
            source_required_nodes=source_required_nodes,
            source_satisfied_node_ids=source_satisfied_node_ids,
            errors=errors,
        )

    top_level_skill = payload.get("skill")
    if isinstance(top_level_skill, dict):
        skill_id = str(top_level_skill.get("id") or "").strip()
        if skill_id:
            referenced_skill_ids.add(skill_id)
            skill = skills_by_id.get(skill_id) if skills_by_id is not None else None
            if skills_by_id is not None and skill is None:
                errors.append(_issue("skill.id", f"unknown skill: {skill_id}"))
            elif skill is not None:
                requested_version = str(top_level_skill.get("version") or "").strip()
                actual_version = str(skill.get("version") or "").strip()
                if requested_version and requested_version != actual_version:
                    errors.append(
                        _issue(
                            "skill.version",
                            f"skill version mismatch: requested {requested_version}, "
                            f"found {actual_version or 'unversioned'}",
                        )
                    )
    if skills_by_id is not None and not referenced_skill_ids:
        errors.append(
            _issue(
                "skill",
                "dynamic plan must reference a skill at plan.skill.id or node.data.workflowCatalog.skillId",
            )
        )
    if len(referenced_skill_ids) > 1:
        errors.append(_issue("skill", "dynamic plan must reference exactly one skill"))

    edges = payload.get("edges", [])
    if not isinstance(edges, list):
        errors.append(_issue("edges", "must be an array"))
        edges = []
    elif len(edges) > MAX_WORKFLOW_EDGES:
        errors.append(
            _issue("edges", f"must contain at most {MAX_WORKFLOW_EDGES} edges")
        )
    elif len(node_types) > 1 and not edges:
        errors.append(
            _issue("edges", "multi-node workflow must declare dependency edges")
        )
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_types}
    undirected_adjacency: dict[str, set[str]] = {
        node_id: set() for node_id in node_types
    }
    incoming_edges: dict[str, list[dict[str, Any]]] = {
        node_id: [] for node_id in node_types
    }
    seen_edges: set[tuple[str, str, str]] = set()
    for index, edge in enumerate(edges):
        path = f"edges[{index}]"
        if not isinstance(edge, dict):
            errors.append(_issue(path, "must be an object"))
            continue
        source = edge.get("source")
        target = edge.get("target")
        link_type = str(edge.get("link_type") or "").strip()
        if source not in node_types:
            errors.append(_issue(f"{path}.source", f"unknown node: {source}"))
        if target not in node_types:
            errors.append(_issue(f"{path}.target", f"unknown node: {target}"))
        if source == target and source in node_types:
            errors.append(_issue(path, "self edges are not allowed"))
        if link_type not in ALLOWED_LINK_TYPES:
            errors.append(
                _issue(f"{path}.link_type", f"unsupported link type: {link_type}")
            )
        if (
            source in node_types
            and target in node_types
            and link_type in ALLOWED_LINK_TYPES
        ):
            incoming_edges[target].append(edge)
            edge_key = (source, target, link_type)
            if edge_key in seen_edges:
                errors.append(_issue(path, "duplicate edge"))
            seen_edges.add(edge_key)
            if not _link_allowed(link_type, node_types[source], node_types[target]):
                errors.append(
                    _issue(
                        path,
                        f"{link_type} is incompatible with {node_types[source]} -> {node_types[target]}",
                    )
                )
            else:
                undirected_adjacency[source].add(target)
                undirected_adjacency[target].add(source)
            adjacency[source].append(target)
            if link_type in {
                "media_input_for",
                "derived_from",
            } and _OBJECT_TYPE_BY_NODE_TYPE.get(node_types[source]) in {
                "ImageNode",
                "VideoNode",
                "AudioNode",
            }:
                source_satisfied_node_ids.add(target)

    compose_node_ids = [
        node_id
        for node_id, node_type in node_types.items()
        if node_type == "videoComposeNode"
    ]
    if len(compose_node_ids) > 1:
        errors.append(
            _issue(
                "nodes",
                "workflow may contain at most one videoComposeNode",
            )
        )
    for node_id, node in node_values.items():
        node_type = node_types[node_id]
        node_index = node_indexes[node_id]
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        catalog = (
            data.get("workflowCatalog")
            if isinstance(data.get("workflowCatalog"), dict)
            else {}
        )
        if node_type == "videoComposeNode":
            if str(catalog.get("recipeId") or "").strip():
                errors.append(
                    _issue(
                        f"nodes[{node_index}].data.workflowCatalog.recipeId",
                        "videoComposeNode is a system composition capability and must not use a Recipe",
                    )
                )
            compose_inputs = incoming_edges.get(node_id, [])
            video_inputs = [
                edge
                for edge in compose_inputs
                if _edge_link_type_value(edge) == "composition_input_for"
                and node_types.get(str(edge.get("source") or "")) == "videoNode"
            ]
            if not video_inputs:
                errors.append(
                    _issue(
                        f"nodes[{node_index}]",
                        "videoComposeNode requires at least one video composition input",
                    )
                )
            if adjacency.get(node_id):
                errors.append(
                    _issue(
                        f"nodes[{node_index}]",
                        "videoComposeNode must be a terminal node",
                    )
                )
            continue
        if node_type != "videoNode":
            continue
        role = (
            str(catalog.get("role") or data.get("workflowCatalogRole") or "")
            .strip()
            .lower()
        )
        stage = _node_stage_value(node).lower()
        step_id = str(catalog.get("stepId") or "").strip().lower().replace("-", "_")
        if (
            role in {"composition", "compose", "final_composition"}
            or stage in {"composition", "compose"}
            or step_id
            in {"compose", "final_compose", "final_composition", "video_compose"}
        ):
            errors.append(
                _issue(
                    f"nodes[{node_index}]",
                    "final composition must use videoComposeNode, not a Recipe-backed videoNode",
                )
            )

    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            continue
        source = edge.get("source")
        target = edge.get("target")
        link_type = _edge_link_type_value(edge)
        if (
            link_type == "composition_input_for"
            and node_types.get(target) != "videoComposeNode"
        ):
            errors.append(
                _issue(
                    f"edges[{index}]",
                    "composition_input_for must target videoComposeNode",
                )
            )
        if (
            node_types.get(target) == "videoComposeNode"
            and link_type != "composition_input_for"
        ):
            errors.append(
                _issue(
                    f"edges[{index}]",
                    "all videoComposeNode inputs must use composition_input_for",
                )
            )

    if len(node_types) > 1 and edges:
        first_node = next(iter(node_types))
        connected = {first_node}
        pending = [first_node]
        while pending:
            current = pending.pop()
            for neighbor in undirected_adjacency[current] - connected:
                connected.add(neighbor)
                pending.append(neighbor)
        disconnected = sorted(set(node_types) - connected)
        if disconnected:
            errors.append(
                _issue(
                    "edges",
                    "workflow graph contains disconnected nodes: "
                    + ", ".join(disconnected),
                )
            )

    for node_id in sorted(set(source_required_nodes) - source_satisfied_node_ids):
        errors.append(
            _issue(
                source_required_nodes[node_id],
                "selected Recipe requires source media; attach existing media or add a generated asset anchor",
            )
        )

    cycle_node = _find_cycle(adjacency)
    if cycle_node:
        errors.append(
            _issue("edges", f"workflow graph contains a cycle at node: {cycle_node}")
        )

    _validate_group_refs(payload, node_types, errors)
    if errors:
        return _invalid(errors)
    preflight = _build_plan_preflight(nodes)
    return {
        "ok": True,
        "status": "workflow_plan_valid",
        "schema_version": WORKFLOW_PLAN_SCHEMA_VERSION,
        "plan": payload,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "skill_id": next(iter(referenced_skill_ids), ""),
        "preflight": preflight,
    }


def _build_plan_preflight(nodes: list[Any]) -> dict[str, Any]:
    counts = {
        "text": 0,
        "image": 0,
        "video": 0,
        "audio": 0,
        "compose": 0,
    }
    models: set[str] = set()
    warnings: list[dict[str, str]] = []
    planned_video_duration = 0
    generated_text_count = 0
    for index, raw_node in enumerate(nodes):
        if not isinstance(raw_node, dict):
            continue
        node_type = _node_type_value(raw_node)
        kind = {
            "textAnnotationNode": "text",
            "scriptNode": "text",
            "beatContextNode": "text",
            "imageGenNode": "image",
            "videoNode": "video",
            "audioNode": "audio",
            "videoComposeNode": "compose",
        }.get(node_type)
        if kind:
            counts[kind] += 1
        data = raw_node.get("data") if isinstance(raw_node.get("data"), dict) else {}
        catalog = (
            data.get("workflowCatalog")
            if isinstance(data.get("workflowCatalog"), dict)
            else {}
        )
        if kind == "text" and str(catalog.get("recipeId") or "").strip():
            generated_text_count += 1
        model = str(data.get("model") or "").strip()
        if model:
            models.add(model)
        if node_type == "videoNode":
            duration = data.get("durationSec")
            if isinstance(duration, (int, float)) and duration > 0:
                planned_video_duration += int(duration)
                if duration > 15:
                    warnings.append(
                        _issue(
                            f"nodes[{index}].data.durationSec",
                            "video duration exceeds 15 seconds and will be split or clamped by the runtime",
                        )
                    )
            if not model:
                warnings.append(
                    _issue(
                        f"nodes[{index}].data.model",
                        "video model is not pinned; the current runtime default will be used",
                    )
                )
        elif node_type == "imageGenNode" and not model:
            warnings.append(
                _issue(
                    f"nodes[{index}].data.model",
                    "image model is not pinned; the current runtime default will be used",
                )
            )
    generation_tasks = (
        generated_text_count + counts["image"] + counts["video"] + counts["audio"]
    )
    return {
        "status": "ready",
        "blockers": [],
        "warnings": warnings,
        "generation_task_count": generation_tasks,
        "counts": counts,
        "models": sorted(models),
        "planned_video_duration_seconds": planned_video_duration,
    }


def _validate_node_catalog_refs(
    node: dict[str, Any],
    *,
    path: str,
    node_type: str,
    skills_by_id: dict[str, dict[str, Any]] | None,
    recipes_by_id: dict[str, dict[str, Any]] | None,
    referenced_skill_ids: set[str],
    source_required_nodes: dict[str, str],
    source_satisfied_node_ids: set[str],
    errors: list[dict[str, str]],
) -> None:
    data = node.get("data")
    if data is not None and not isinstance(data, dict):
        errors.append(_issue(f"{path}.data", "must be an object"))
        return
    catalog = data.get("workflowCatalog") if isinstance(data, dict) else None
    if catalog is None:
        return
    if not isinstance(catalog, dict):
        errors.append(_issue(f"{path}.data.workflowCatalog", "must be an object"))
        return
    catalog_path = f"{path}.data.workflowCatalog"
    for field in ("confirmedInputs", "inputStrategy", "promptBuilder"):
        if field in catalog and not isinstance(catalog[field], dict):
            errors.append(_issue(f"{catalog_path}.{field}", "must be an object"))
    if (
        "promptStrategy" in catalog
        and catalog["promptStrategy"] not in _PROMPT_STRATEGY_VALUES
    ):
        allowed = ", ".join(sorted(_PROMPT_STRATEGY_VALUES))
        errors.append(
            _issue(
                f"{catalog_path}.promptStrategy",
                f"must be one of: {allowed}",
            )
        )
    recipe_id = str(catalog.get("recipeId") or "").strip()
    stage = _node_stage_value(node).lower()
    role = str(data.get("workflowCatalogRole") or "").strip().lower()
    step_id = str(catalog.get("stepId") or "").strip().lower().replace("-", "_")
    if recipe_id and node_type in {"textAnnotationNode", "scriptNode", "beatContextNode"} and (
        stage in _USER_INPUT_STAGES
        or role == "user_input"
        or step_id in _USER_INPUT_STEP_IDS
    ):
        errors.append(
            _issue(
                f"{catalog_path}.recipeId",
                "user input/resource nodes must not execute a Recipe; express downstream "
                "dependencies with plan edges",
            )
        )
    skill_id = str(catalog.get("skillId") or "").strip()
    skill = None
    if skill_id:
        referenced_skill_ids.add(skill_id)
        skill = skills_by_id.get(skill_id) if skills_by_id is not None else None
        if skills_by_id is not None and skill is None:
            errors.append(
                _issue(
                    f"{path}.data.workflowCatalog.skillId", f"unknown skill: {skill_id}"
                )
            )
        elif skill is not None:
            requested_skill_version = str(catalog.get("skillVersion") or "").strip()
            actual_skill_version = str(skill.get("version") or "").strip()
            if (
                requested_skill_version
                and requested_skill_version != actual_skill_version
            ):
                errors.append(
                    _issue(
                        f"{path}.data.workflowCatalog.skillVersion",
                        f"skill version mismatch: requested {requested_skill_version}, "
                        f"found {actual_skill_version or 'unversioned'}",
                    )
                )
    if not recipe_id:
        return
    if recipes_by_id is None:
        return
    recipe = recipes_by_id.get(recipe_id)
    if recipe is None:
        errors.append(
            _issue(
                f"{path}.data.workflowCatalog.recipeId", f"unknown recipe: {recipe_id}"
            )
        )
        return
    if skill is not None:
        allowed_recipe_ids = {
            str(item).strip()
            for item in skill.get("allowed_recipe_ids") or []
            if str(item).strip()
        }
        if recipe_id not in allowed_recipe_ids:
            errors.append(
                _issue(
                    f"{path}.data.workflowCatalog.recipeId",
                    f"recipe {recipe_id} is not allowed by skill {skill_id}",
                )
            )
    if recipe.get("requires_source_media") or recipe.get("requiresSourceMedia"):
        source_required_nodes[str(node.get("id") or "")] = path
        direct_media = (
            data.get("referenceImageUrl")
            or data.get("sourceUrl")
            or data.get("audioUrl")
            or data.get("videoUrl")
            or data.get("referenceUrls")
        )
        if direct_media:
            source_satisfied_node_ids.add(str(node.get("id") or ""))
    requested_version = str(catalog.get("recipeVersion") or "").strip()
    actual_version = str(recipe.get("version") or "").strip()
    if requested_version and requested_version != actual_version:
        errors.append(
            _issue(
                f"{path}.data.workflowCatalog.recipeVersion",
                f"recipe version mismatch: requested {requested_version}, found {actual_version or 'unversioned'}",
            )
        )
    output_kind = str(
        recipe.get("output_kind")
        or recipe.get("generationType")
        or recipe.get("generation_type")
        or ""
    ).strip()
    expected_kind = _OUTPUT_KIND_BY_NODE_TYPE.get(node_type)
    if output_kind and expected_kind and output_kind != expected_kind:
        errors.append(
            _issue(
                f"{path}.data.workflowCatalog.recipeId",
                f"recipe output {output_kind} is incompatible with {node_type}",
            )
        )
    pipeline = catalog.get("recipePipeline") or []
    if not isinstance(pipeline, list):
        errors.append(
            _issue(f"{path}.data.workflowCatalog.recipePipeline", "must be an array")
        )
        return
    seen_pipeline_ids = {recipe_id}
    pipeline_recipe_ids = {recipe_id}
    for pipeline_index, raw_pipeline_item in enumerate(pipeline):
        pipeline_id = str(
            raw_pipeline_item.get("id")
            if isinstance(raw_pipeline_item, dict)
            else raw_pipeline_item or ""
        ).strip()
        pipeline_path = f"{path}.data.workflowCatalog.recipePipeline[{pipeline_index}]"
        if not pipeline_id or pipeline_id in seen_pipeline_ids:
            continue
        seen_pipeline_ids.add(pipeline_id)
        pipeline_recipe_ids.add(pipeline_id)
        pipeline_recipe = recipes_by_id.get(pipeline_id)
        if pipeline_recipe is None:
            errors.append(_issue(pipeline_path, f"unknown recipe: {pipeline_id}"))
            continue
        if skill is not None and pipeline_id not in allowed_recipe_ids:
            errors.append(
                _issue(
                    pipeline_path,
                    f"recipe {pipeline_id} is not allowed by skill {skill_id}",
                )
            )
        pipeline_kind = str(pipeline_recipe.get("output_kind") or "").strip()
        if output_kind and pipeline_kind != output_kind:
            errors.append(
                _issue(
                    pipeline_path,
                    f"recipe output {pipeline_kind or 'unknown'} does not match {output_kind}",
                )
            )
        if isinstance(raw_pipeline_item, dict):
            requested_pipeline_version = str(
                raw_pipeline_item.get("version") or ""
            ).strip()
            actual_pipeline_version = str(pipeline_recipe.get("version") or "").strip()
            if (
                requested_pipeline_version
                and requested_pipeline_version != actual_pipeline_version
            ):
                errors.append(
                    _issue(
                        f"{pipeline_path}.version",
                        f"recipe version mismatch: requested {requested_pipeline_version}, "
                        f"found {actual_pipeline_version or 'unversioned'}",
                    )
                )
        if pipeline_recipe.get("requires_source_media"):
            source_required_nodes[str(node.get("id") or "")] = path
    for checked_recipe_id in sorted(pipeline_recipe_ids):
        checked_recipe = recipes_by_id.get(checked_recipe_id)
        if checked_recipe is None:
            continue
        conflicts = {
            str(item).strip()
            for item in checked_recipe.get("conflicts_with") or []
            if str(item).strip()
        }
        matched = sorted((conflicts & pipeline_recipe_ids) - {checked_recipe_id})
        if matched:
            errors.append(
                _issue(
                    f"{path}.data.workflowCatalog.recipePipeline",
                    f"recipe {checked_recipe_id} conflicts with {matched[0]}",
                )
            )
            break


def _validate_group_refs(
    payload: dict[str, Any],
    node_types: dict[str, str],
    errors: list[dict[str, str]],
) -> None:
    groups = payload.get("groups")
    groups_path = "groups"
    if groups is None:
        groups = payload.get("group")
        groups_path = "group"
    layout = payload.get("layout")
    if groups is None and isinstance(layout, dict):
        groups = layout.get("groups")
        groups_path = "layout.groups"
    if groups is None:
        return
    if isinstance(groups, dict):
        groups = [groups]
    if not isinstance(groups, list):
        errors.append(_issue(groups_path, "must be an object or array"))
        return
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict):
            errors.append(_issue(f"{groups_path}[{group_index}]", "must be an object"))
            continue
        refs = group.get("node_ids") or []
        if not isinstance(refs, list):
            errors.append(
                _issue(f"{groups_path}[{group_index}].node_ids", "must be an array")
            )
            continue
        for ref_index, node_id in enumerate(refs):
            if node_id not in node_types:
                errors.append(
                    _issue(
                        f"{groups_path}[{group_index}].node_ids[{ref_index}]",
                        f"unknown node: {node_id}",
                    )
                )


def _link_allowed(link_type: str, source_type: str, target_type: str) -> bool:
    source_objects, target_objects = _LINK_RULES[link_type]
    return (
        _OBJECT_TYPE_BY_NODE_TYPE.get(source_type) in source_objects
        and _OBJECT_TYPE_BY_NODE_TYPE.get(target_type) in target_objects
    )


def _find_cycle(adjacency: dict[str, list[str]]) -> str | None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> str | None:
        if node_id in visiting:
            return node_id
        if node_id in visited:
            return None
        visiting.add(node_id)
        for target in adjacency.get(node_id, []):
            cycle = visit(target)
            if cycle:
                return cycle
        visiting.remove(node_id)
        visited.add(node_id)
        return None

    for node_id in adjacency:
        cycle = visit(node_id)
        if cycle:
            return cycle
    return None


def _issue(path: str, message: str) -> dict[str, str]:
    return {"path": path, "message": message}


def _invalid(errors: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "invalid_dynamic_workflow_plan",
        "error": errors[0]["message"] if errors else "invalid workflow plan",
        "errors": errors,
    }
