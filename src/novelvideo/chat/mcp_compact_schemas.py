"""Publish focused argument shapes for external Codex without changing validation."""

import os

from mcp.types import Tool

# Keep common call shapes visible to hosts with a 5 KB per-tool schema budget.
# Input validation still uses the complete registry schema.
_GROUP = {"id": None, "label": None, "node_ids": None}
_PLAN = {
    **dict.fromkeys(
        (
            "analysis",
            "assumptions",
            "execution_policy",
            "expansion_rules",
            "expected_node_count",
            "inputs",
            "missing_inputs",
            "mode",
            "source_context",
        )
    ),
    "expected_node_counts": dict.fromkeys(
        (
            "audioNode",
            "beatContextNode",
            "htmlArtifactNode",
            "imageGenNode",
            "scriptNode",
            "textAnnotationNode",
            "videoComposeNode",
            "videoNode",
        )
    ),
    "group": None,
    "layout": {"direction": None, "groups": _GROUP, "mode": None},
    "schema_version": None,
    "skill": {"id": None, "version": None},
    "title": None,
    "summary": None,
    "workflow_type": None,
    "phases": None,
    "external_inputs": {"id": None, "node_id": None, "media_kind": None},
    "nodes": {
        "id": None,
        "node_type": None,
        "stage": None,
        "label": None,
        "position": {"x": None, "y": None},
        "data": {"workflowCatalog": {"recipeId": None}, "prompt": None},
    },
    "edges": {"source": None, "target": None, "link_type": None},
    "groups": _GROUP,
}
_INTENT = {
    "schema_version": None,
    "skill_id": None,
    "user_goal": None,
    "inputs": dict.fromkeys(
        (
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
        )
    ),
    "planner": dict.fromkeys(
        (
            "deliverable",
            "image_recipe_id",
            "include_audio",
            "item_count",
            "mode",
            "total_duration_seconds",
            "units",
            "video_dependency",
        )
    ),
    "assumptions": None,
    "external_inputs": _PLAN["external_inputs"],
    "include_audio": None,
    "summary": None,
    "include_compose": None,
    "workflow_type": None,
    "title": None,
    "items": {
        "id": None,
        "title": None,
        "recipe_id": None,
        "prompt": None,
        "depends_on": None,
        "reference_inputs": None,
        "duration_seconds": None,
    },
}
_MEDIA = {"source": None, "asset_id": None, "url": None, "status": None}
_SEGMENT = {
    "id": None,
    "kind": None,
    "title": None,
    "script": None,
    "video_prompt": None,
    "scene_refs": None,
    "character_ids": None,
    "media": _MEDIA,
    "choice_loop": {"description": None, "media": _MEDIA},
}
_CHOICE = {
    "id": None,
    "source_segment_id": None,
    "target_segment_id": None,
    "text": None,
    "mode": None,
    "order": None,
    "is_default": None,
}
_STORY = {
    "schema_version": None,
    "story_id": None,
    "revision": None,
    "title": None,
    "start_segment_id": None,
    "synopsis": None,
    "segments": _SEGMENT,
    "choices": _CHOICE,
    "characters": {"id": None, "name": None, "description": None},
    "scenes": {"id": None, "name": None, "description": None},
    "flags": {"name": None, "initial": None},
    "variables": {"name": None, "initial": None},
}
_PATCH = {**_SEGMENT, **_CHOICE, "synopsis": None}
_OPERATIONS = {
    "op": None,
    "segment_id": None,
    "choice_id": None,
    "character_id": None,
    "scene_id": None,
    "variable_name": None,
    "flag_name": None,
    "segment": _SEGMENT,
    "choice": _CHOICE,
    "changes": _PATCH,
    "character": _STORY["characters"],
    "scene": _STORY["scenes"],
    "flag": _STORY["flags"],
    "variable": _STORY["variables"],
}
_PROJECTIONS = {
    "dramaclaw_create_interactive_story": {"story": _STORY},
    "dramaclaw_patch_interactive_story": {"operations": _OPERATIONS},
    "freezone_prepare_workflow": {
        "intent": _INTENT,
        "plan": {
            **{
                key: fields
                for key, fields in _PLAN.items()
                if key not in {"execution_policy", "expansion_rules", "source_context"}
            },
            "expected_node_counts": None,
            "layout": {"direction": None, "groups": None, "mode": None},
            "external_inputs": None,
            "groups": None,
        },
        "bindings": {"source": None, "target": None, "prompt": None, "usage": None},
    },
    "freezone_prepare_workflow_plan_draft": {"plan": _PLAN},
    "workflow_graph_compile": {"plan": _PLAN},
}


def _compact_node(schemas: list[dict], fields: dict | None) -> dict:
    candidates = [
        branch
        for schema in schemas
        for branch in (schema, *schema.get("oneOf", []), *schema.get("anyOf", []))
        if isinstance(branch, dict)
    ]
    items = [
        node["items"] for node in candidates if isinstance(node.get("items"), dict)
    ]
    if items:
        return {"type": "array", "items": _compact_node(items, fields)}
    objects = [node for node in candidates if isinstance(node.get("properties"), dict)]
    if objects and fields is not None:
        properties = {}
        for name, selection in fields.items():
            variants = [
                node["properties"][name]
                for node in objects
                if name in node["properties"]
            ]
            if variants:
                properties[name] = _compact_node(variants, selection)
        required = [
            name
            for name in properties
            if all(name in node.get("required", []) for node in objects)
        ]
        result = {"type": "object", "properties": properties}
        if required:
            result["required"] = required
        return result
    enums = list(
        dict.fromkeys(
            value
            for node in candidates
            for value in ([node["const"]] if "const" in node else node.get("enum", []))
            if isinstance(value, (str, int, float, bool))
        )
    )
    types = {node["type"] for node in candidates if isinstance(node.get("type"), str)}
    result = {"type": types.pop()} if len(types) == 1 else {}
    if enums and all("const" in node or "enum" in node for node in candidates):
        result["enum"] = enums
    return result


def compact_codex_tool(tool: Tool) -> Tool:
    if os.environ.get("DRAMACLAW_CODEX_COMPACT_SCHEMAS") != "1":
        return tool
    projection = _PROJECTIONS.get(tool.name)
    if projection is None:
        return tool
    original = tool.inputSchema
    properties = {
        name: (
            {key: value for key, value in field.items() if key != "description"}
            if isinstance(field, dict)
            else field
        )
        for name, field in original["properties"].items()
    }
    for name, fields in projection.items():
        if name in properties:
            properties[name] = _compact_node([properties[name]], fields)
    description = tool.description or ""
    description += (
        " The advertised input schema shows the common fields. Additional documented "
        "fields are accepted and validated against the full contract."
    )
    if "plan" in projection:
        description += (
            " Use the selected Skill's id and version in plan.skill. Build edges with "
            "source and target matching plan.nodes[].id and a compatible link_type."
        )
    if "operation_id" in properties:
        description += (
            " When admission is required, copy operation_id from "
            "freezone_begin_agent_product_generation for this Skill."
        )
    if tool.name == "freezone_prepare_workflow":
        description += (
            " Use the selected Workflow Skill's contract for optional plan metadata, exact "
            "node counts, and layout. Bindings refer to node IDs from the current plan."
        )
    if tool.name.startswith("dramaclaw_"):
        description += (
            " For ready imported or generated story media, use the existing asset_id "
            "or media URL. Use placeholder for media that does not exist yet."
        )
    if tool.name == "dramaclaw_patch_interactive_story":
        operations = original["properties"]["operations"]["items"]["oneOf"]
        requirements = "; ".join(
            f"{variant['properties']['op']['const']}: "
            + ", ".join(field for field in variant["required"] if field != "op")
            for variant in operations
        )
        description += f" Required fields besides op: {requirements}."
    return tool.model_copy(
        update={
            "description": description,
            "inputSchema": {**original, "properties": properties},
        }
    )
