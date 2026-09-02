"""Build frontend canvas commands from Freezone workflow graph plans."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from novelvideo.freezone.workflow_schema import (
    LINK_TYPE_VALUES as PORTABLE_LINK_TYPE_VALUES,
    NODE_TYPE_VALUES,
)

CANVAS_CHAT_COMMANDS_SCHEMA_VERSION = "canvas_chat_commands.v1"

ALLOWED_NODE_TYPES = set(NODE_TYPE_VALUES)

DEFAULT_NODE_TYPE = "textAnnotationNode"

TEXTUAL_NODE_TYPES = {"textAnnotationNode", "scriptNode", "beatContextNode"}

LINK_TYPE_VALUES = set(PORTABLE_LINK_TYPE_VALUES)

WORKFLOW_GRAPH_COMMAND_TYPES = {
    "create_node",
    "create_edge",
    "group_nodes",
    "layout_nodes",
    "select_nodes",
    "run_workflow",
}

LINK_OBJECT_TYPE_BY_NODE_TYPE = {
    "textAnnotationNode": "TextNode",
    "scriptNode": "ScriptNode",
    "beatContextNode": "TextNode",
    "imageGenNode": "ImageNode",
    "videoNode": "VideoNode",
    "audioNode": "AudioNode",
    "videoComposeNode": "VideoNode",
}

LINK_TYPE_RULES = {
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

MODEL_ALIASES_BY_NODE_TYPE = {
    "imageGenNode": {
        "nano-banana-2": "newapi_nanobanana2",
        "nanobanana2": "newapi_nanobanana2",
        "nano_banana_2": "newapi_nanobanana2",
        "gpt-image-2": "newapi_gpt_image2",
        "openai/gpt-image-2": "newapi_gpt_image2",
    },
    "videoNode": {
        # Workflow/canvas plans use the public model ids exposed by the node
        # schema. Provider routing prefixes belong to the backend generation
        # request and must never leak into canvas node data.
        "omni-flash": "seedance-2.0-fast",
        "omni_flash": "seedance-2.0-fast",
        "seedance_2_0_fast": "seedance-2.0-fast",
        "newapi_seedance-2.0-fast": "seedance-2.0-fast",
        "newapi_seedance-2.0": "seedance-2.0",
        "newapi_seedance-1.5-pro": "seedance-1.5-pro",
        "newapi_seedance-1.0-pro-fast": "seedance-1.0-pro-fast",
        "huimeng_seedance-2.0-fast": "seedance-2.0-fast",
        "huimeng_seedance-2.0": "seedance-2.0",
        "huimeng_seedance-1.5-pro": "seedance-1.5-pro",
        "huimeng_seedance-1.0-pro-fast": "seedance-1.0-pro-fast",
    },
}

STAGE_ORDER = {
    "input": 0,
    "resource": 0,
    "story": 1,
    "analysis": 1,
    "character": 2,
    "scene": 2,
    "asset": 3,
    "beat": 3,
    "shot": 4,
    "frame": 4,
    "image": 4,
    "video": 5,
    "audio": 5,
    "compose": 6,
    "quality": 7,
    "review": 7,
}

USER_INPUT_STAGES = {"input", "resource", "asset"}

def build_workflow_graph_commands(args: dict[str, Any]) -> dict[str, Any]:
    """Convert a workflow plan/graph payload into canvas_chat_commands.v1 commands.

    The assistant-facing workflow plan uses logical ids. This builder turns those
    ids into same-envelope ``client_id`` aliases and only emits valid canvas
    command refs. It never emits ``auto:*`` ids.
    """
    payload = args.get("plan")
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "status": "dynamic_workflow_plan_required",
            "error": "plan must be a complete freezone_workflow_plan.v1 object",
            "commands": [],
            "skipped_edges": [],
            "warnings": [],
        }
    raw_nodes = payload.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        return {
            "ok": False,
            "status": "empty_nodes",
            "error": "workflow graph requires a non-empty nodes array",
            "commands": [],
            "skipped_edges": [],
            "warnings": [],
        }

    warnings: list[str] = []
    skipped_edges: list[dict[str, Any]] = []
    commands: list[dict[str, Any]] = []
    workflow_instance_id = _workflow_instance_id(args, payload)
    node_by_plan_id: dict[str, dict[str, Any]] = {}
    used_client_ids: set[str] = set()

    normalized_nodes = []
    for index, raw_node in enumerate(raw_nodes):
        if not isinstance(raw_node, dict):
            warnings.append(f"nodes[{index}] ignored because it is not an object")
            continue
        plan_id = _node_plan_id(raw_node, index)
        node_type = _node_type(raw_node)
        if node_type not in ALLOWED_NODE_TYPES:
            warnings.append(
                f"nodes[{index}] uses unsupported node_type {node_type!r}; "
                f"falling back to {DEFAULT_NODE_TYPE}"
            )
            node_type = DEFAULT_NODE_TYPE
        client_id = _unique_client_id(plan_id, used_client_ids)
        used_client_ids.add(client_id)
        node = {
            "plan_id": plan_id,
            "client_id": client_id,
            "node_type": node_type,
            "raw": raw_node,
            "stage_index": _stage_index(raw_node, node_type),
        }
        node_by_plan_id[plan_id] = node
        node_by_plan_id[client_id] = node
        normalized_nodes.append(node)

    if not normalized_nodes:
        return {
            "ok": False,
            "status": "empty_nodes",
            "error": "workflow graph did not contain any valid node objects",
            "commands": [],
            "skipped_edges": skipped_edges,
            "warnings": warnings,
        }

    edge_records: list[dict[str, Any]] = []
    prompt_source_plan_ids: set[str] = set()
    context_source_plan_ids: set[str] = set()
    audio_prompt_target_plan_ids: set[str] = set()
    for edge_index, edge in enumerate(_edge_pairs(payload.get("edges"))):
        source_ref, target_ref, requested_link_type = edge
        source = node_by_plan_id.get(source_ref)
        target = node_by_plan_id.get(target_ref)
        if source is None or target is None:
            skipped_edges.append(
                {
                    "index": edge_index,
                    "source": source_ref,
                    "target": target_ref,
                    "reason": "source or target plan node not found",
                }
            )
            continue
        if source["client_id"] == target["client_id"]:
            skipped_edges.append(
                {
                    "index": edge_index,
                    "source": source_ref,
                    "target": target_ref,
                    "reason": "self edges are not allowed",
                }
            )
            continue
        link_type = _infer_link_type(source["node_type"], target["node_type"], requested_link_type)
        if link_type is None:
            skipped_edges.append(
                {
                    "index": edge_index,
                    "source": source_ref,
                    "target": target_ref,
                    "reason": f"{source['node_type']} cannot directly connect to {target['node_type']}",
                }
            )
            continue
        if link_type == "context_for" and target["node_type"] == "beatContextNode":
            skipped_edges.append(
                {
                    "index": edge_index,
                    "source": source_ref,
                    "target": target_ref,
                    "reason": "beatContextNode is used as a prompt/context source, not a semantic edge target",
                }
            )
            continue
        record = {
            "index": edge_index,
            "source_ref": source_ref,
            "target_ref": target_ref,
            "source": source,
            "target": target,
            "link_type": link_type,
        }
        edge_records.append(record)
        if link_type == "prompt_for" and source["node_type"] in TEXTUAL_NODE_TYPES:
            prompt_source_plan_ids.add(source["plan_id"])
        if link_type == "context_for" and source["node_type"] in TEXTUAL_NODE_TYPES:
            context_source_plan_ids.add(source["plan_id"])
        if (
            link_type == "prompt_for"
            and source["node_type"] in TEXTUAL_NODE_TYPES
            and target["node_type"] == "audioNode"
        ):
            audio_prompt_target_plan_ids.add(target["plan_id"])

    for order, node in enumerate(normalized_nodes):
        raw_node = node["raw"]
        data = _node_data(
            raw_node,
            node["node_type"],
            audio_uses_upstream_text=node["plan_id"] in audio_prompt_target_plan_ids,
        )
        raw_data = raw_node.get("data") if isinstance(raw_node.get("data"), dict) else {}
        raw_stage = str(raw_node.get("stage") or raw_data.get("stage") or "").strip().lower()
        if node["node_type"] in TEXTUAL_NODE_TYPES and raw_stage in USER_INPUT_STAGES:
            data.setdefault("workflowCatalogRole", "user_input")
        if (
            node["plan_id"] in prompt_source_plan_ids
            and node["plan_id"] not in context_source_plan_ids
            and node["node_type"] in TEXTUAL_NODE_TYPES
        ):
            data.setdefault("semanticOutputRole", "input_text")
        data.setdefault("workflowInstanceId", workflow_instance_id)
        data.setdefault("workflowPlanNodeId", node["plan_id"])
        # The graph approval is the single parameter confirmation point for a
        # workflow. Persist this marker on executable nodes so the later DAG
        # runner and Agent action catalog can reuse the approved model/size/
        # duration/voice fields instead of asking for them again.
        if node["node_type"] in {"imageGenNode", "videoNode", "audioNode", "videoComposeNode"}:
            data["workflowConfigConfirmed"] = True
            data["workflowConfigSource"] = "workflow_graph_approval"
        command = {
            "type": "create_node",
            "client_id": node["client_id"],
            "node_type": node["node_type"],
            "position": _node_position(raw_node, node["stage_index"], order),
            "data": data,
        }
        commands.append(command)

    for record in edge_records:
        source = record["source"]
        target = record["target"]
        link_type = record["link_type"]
        command = {
            "type": "create_edge",
            "source": source["client_id"],
            "target": target["client_id"],
            "link_type": link_type,
        }
        commands.append(command)

    groups = _groups(payload.get("groups") or payload.get("group"), payload.get("layout"))
    group_client_node_ids: list[list[str]] = []
    if groups:
        for group in groups:
            node_ids = [
                node_by_plan_id[item]["client_id"]
                for item in group["node_ids"]
                if item in node_by_plan_id
            ]
            if len(node_ids) >= 2:
                group_client_node_ids.append(_dedupe(node_ids))
                commands.append(
                    {
                        "type": "group_nodes",
                        "node_ids": group_client_node_ids[-1],
                        "label": group.get("label") or "工作流",
                    }
                )
    elif len(normalized_nodes) >= 2:
        commands.append(
            {
                "type": "group_nodes",
                "node_ids": [node["client_id"] for node in normalized_nodes],
                "label": str(payload.get("workflow_type") or payload.get("title") or "工作流"),
            }
        )

    layout_targets = group_client_node_ids or [[node["client_id"] for node in normalized_nodes]]
    for node_ids in layout_targets:
        commands.append(
            {
                "type": "layout_nodes",
                "node_ids": node_ids,
                "mode": "grid",
            }
        )
    commands.append(
        {
            "type": "select_nodes",
            "node_ids": [node["client_id"] for node in normalized_nodes],
            "focus": True,
        }
    )
    raw_run_after_create = args.get("run_after_create")
    run_after_create = _bool_value(raw_run_after_create, False)
    if run_after_create:
        commands.append(
            {
                "type": "run_workflow",
                "node_ids": [node["client_id"] for node in normalized_nodes],
                "scope": "selection",
            }
        )

    command_errors = validate_workflow_graph_commands(commands)
    if command_errors:
        return {
            "ok": False,
            "status": "invalid_compiled_command_schema",
            "code": "invalid_compiled_command_schema",
            "error": command_errors[0]["message"],
            "errors": command_errors,
            "commands": [],
            "skipped_edges": skipped_edges,
            "warnings": warnings,
            "agent_instruction": (
                "The deterministic workflow compiler produced commands that do not satisfy the "
                "canvas write contract. Do not hand-author canvas commands or reduce the plan. "
                "Correct only a semantic WorkflowPlan field explicitly named by errors[].path; "
                "otherwise report this as an adapter/compiler defect without retrying."
            ),
        }

    return {
        "ok": True,
        "status": "workflow_graph_commands_created",
        "schema_version": CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        "workflow_instance_id": workflow_instance_id,
        "run_after_create": run_after_create,
        "commands": commands,
        "skipped_edges": skipped_edges,
        "warnings": warnings,
    }


def _workflow_instance_id(args: dict[str, Any], payload: dict[str, Any]) -> str:
    explicit = str(args.get("workflow_instance_id") or "").strip()
    if explicit:
        return explicit[:160]
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return f"workflow_plan_{hashlib.sha256(encoded).hexdigest()[:24]}"


def _bool_value(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _node_plan_id(node: dict[str, Any], index: int) -> str:
    value = node.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    label = node.get("label") or node.get("title") or node.get("name") or f"node_{index + 1}"
    return str(label)


def _node_type(node: dict[str, Any]) -> str:
    value = node.get("node_type")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return DEFAULT_NODE_TYPE


def _unique_client_id(raw: str, used: set[str]) -> str:
    base = _safe_client_id(raw)
    if not base or re.fullmatch(r"auto:\d+", base, flags=re.IGNORECASE):
        base = "workflow_node"
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}_{index}"
        index += 1
    return candidate


def _safe_client_id(value: str) -> str:
    text = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", str(value).strip())
    text = re.sub(r"_+", "_", text).strip("_-")
    return text[:64] or "workflow_node"


def _stage_index(node: dict[str, Any], node_type: str) -> int:
    text = " ".join(
        str(node.get(key) or "")
        for key in ("stage", "phase", "group", "role", "id", "label", "title", "description")
    ).lower()
    for key, order in STAGE_ORDER.items():
        if key in text:
            return order
    return {
        "textAnnotationNode": 0,
        "scriptNode": 1,
        "beatContextNode": 3,
        "imageGenNode": 4,
        "videoNode": 5,
        "audioNode": 5,
        "videoComposeNode": 6,
    }.get(node_type, 0)


def _node_position(node: dict[str, Any], stage_index: int, order: int) -> dict[str, int]:
    position = node.get("position")
    if isinstance(position, dict):
        x = _number(position.get("x"))
        y = _number(position.get("y"))
        if x is not None and y is not None:
            return {"x": int(x), "y": int(y)}
    row = order % 4
    return {"x": 80 + stage_index * 340, "y": 80 + row * 220}


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _node_data(
    node: dict[str, Any],
    node_type: str,
    *,
    audio_uses_upstream_text: bool = False,
) -> dict[str, Any]:
    data = node.get("data")
    result = dict(data) if isinstance(data, dict) else {}
    label = node.get("label") or node.get("title") or node.get("name")
    description = node.get("description") or node.get("responsibility") or node.get("purpose")
    if isinstance(label, str) and label.strip():
        result.setdefault("displayName", label.strip())
        result.setdefault("title", label.strip())
    if isinstance(description, str) and description.strip():
        result.setdefault("content", description.strip())
        result.setdefault("prompt", description.strip())
        result.setdefault("description", description.strip())
    prompt = node.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        current_prompt = result.get("prompt")
        if not isinstance(current_prompt, str) or not current_prompt.strip():
            result["prompt"] = prompt.strip()
    if node_type == "textAnnotationNode":
        # Workflow plans authored by different agent hosts commonly use either
        # ``text`` or ``content`` for a plain text node. The canvas command
        # contract is intentionally narrower and requires ``data.title`` plus
        # ``data.content``.
        # Normalize at the portable workflow boundary so every host emits the
        # same valid canvas command without loosening the canvas schema.
        title = result.get("title")
        if not isinstance(title, str) or not title.strip():
            for candidate in (
                result.get("displayName"),
                node.get("label"),
                node.get("name"),
                node.get("id"),
            ):
                if isinstance(candidate, str) and candidate.strip():
                    result["title"] = candidate.strip()
                    break
        content = result.get("content")
        if not isinstance(content, str) or not content.strip():
            for candidate in (
                result.get("text"),
                result.get("prompt"),
                result.get("description"),
                node.get("content"),
                node.get("text"),
                result.get("title"),
                result.get("displayName"),
                node.get("id"),
            ):
                if isinstance(candidate, str) and candidate.strip():
                    result["content"] = candidate.strip()
                    break
    _normalize_model_alias(result, node_type)
    if node_type == "audioNode":
        result.setdefault("audioKind", "speech")
        if result.get("audioKind") == "speech":
            result["speechMode"] = "clone"
            result.setdefault("voiceAvailable", False)
        result.setdefault("audioUrl", None)
        result.setdefault("sourceFileName", None)
        result.setdefault("durationMs", None)
        result.setdefault("isUploading", False)
        text = result.get("text")
        if not audio_uses_upstream_text and (not isinstance(text, str) or not text.strip()):
            for key in ("content", "prompt", "description"):
                value = result.get(key)
                if isinstance(value, str) and value.strip():
                    result["text"] = value.strip()
                    break
        result.setdefault("emotionPrompt", "")
        result.setdefault("voiceLanguage", "")
        result.setdefault("isGenerating", False)
        result.setdefault("generationStartedAt", None)
    return result


def validate_workflow_graph_commands(commands: Any) -> list[dict[str, str]]:
    """Validate the static canvas contract emitted by the workflow compiler.

    The frontend still performs authoritative stateful validation (live model
    catalogs, current node ids, revision checks). This check covers the stable
    command shape before ``workflow_graph_compile`` is allowed to report
    success, so compilation and creation cannot disagree on fields that the
    deterministic builder owns.
    """
    if not isinstance(commands, list) or not commands:
        return [{"path": "commands", "message": "compiled commands must be a non-empty array"}]

    errors: list[dict[str, str]] = []
    created_ids: set[str] = set()
    for index, command in enumerate(commands):
        path = f"commands[{index}]"
        if not isinstance(command, dict):
            errors.append({"path": path, "message": f"{path} must be an object"})
            continue
        command_type = command.get("type")
        if command_type not in WORKFLOW_GRAPH_COMMAND_TYPES:
            errors.append(
                {
                    "path": f"{path}.type",
                    "message": f"{path}.type is not a workflow graph command: {command_type!r}",
                }
            )
            continue
        if command_type != "create_node":
            continue
        client_id = command.get("client_id")
        if not isinstance(client_id, str) or not client_id.strip():
            errors.append(
                {"path": f"{path}.client_id", "message": f"{path} requires client_id"}
            )
        elif client_id in created_ids:
            errors.append(
                {
                    "path": f"{path}.client_id",
                    "message": f"{path}.client_id duplicates {client_id!r}",
                }
            )
        else:
            created_ids.add(client_id)
        node_type = command.get("node_type")
        if node_type not in ALLOWED_NODE_TYPES:
            errors.append(
                {
                    "path": f"{path}.node_type",
                    "message": f"{path}.node_type is not directly creatable: {node_type!r}",
                }
            )
        position = command.get("position")
        if not isinstance(position, dict) or any(
            _number(position.get(axis)) is None for axis in ("x", "y")
        ):
            errors.append(
                {
                    "path": f"{path}.position",
                    "message": f"{path}.position requires numeric x and y",
                }
            )
        data = command.get("data")
        if not isinstance(data, dict):
            errors.append({"path": f"{path}.data", "message": f"{path}.data must be an object"})
        elif node_type == "textAnnotationNode":
            for field in ("title", "content"):
                if not isinstance(data.get(field), str) or not data[field].strip():
                    errors.append(
                        {
                            "path": f"{path}.data.{field}",
                            "message": f"{path} requires textAnnotationNode {field} in data",
                        }
                    )

    for index, command in enumerate(commands):
        if not isinstance(command, dict):
            continue
        path = f"commands[{index}]"
        command_type = command.get("type")
        if command_type == "create_edge":
            for field in ("source", "target"):
                value = command.get(field)
                if not isinstance(value, str) or value not in created_ids:
                    errors.append(
                        {
                            "path": f"{path}.{field}",
                            "message": f"{path}.{field} must reference a created client_id",
                        }
                    )
            if command.get("link_type") not in LINK_TYPE_VALUES:
                errors.append(
                    {
                        "path": f"{path}.link_type",
                        "message": f"{path}.link_type is not supported",
                    }
                )
        elif command_type in {"group_nodes", "layout_nodes", "select_nodes", "run_workflow"}:
            node_ids = command.get("node_ids")
            if not isinstance(node_ids, list) or not node_ids:
                errors.append(
                    {"path": f"{path}.node_ids", "message": f"{path}.node_ids must be non-empty"}
                )
            elif any(not isinstance(node_id, str) or node_id not in created_ids for node_id in node_ids):
                errors.append(
                    {
                        "path": f"{path}.node_ids",
                        "message": f"{path}.node_ids must reference created client_ids",
                    }
                )
            if command_type == "layout_nodes" and not str(command.get("mode") or "").strip():
                errors.append({"path": f"{path}.mode", "message": f"{path} requires mode"})

    return errors


def _normalize_model_alias(data: dict[str, Any], node_type: str) -> None:
    model = data.get("model")
    if not isinstance(model, str) or not model.strip():
        return
    aliases = MODEL_ALIASES_BY_NODE_TYPE.get(node_type) or {}
    normalized_key = model.strip().lower()
    replacement = aliases.get(normalized_key)
    if replacement:
        data["model"] = replacement


def _edge_pairs(raw_edges: Any) -> list[tuple[str, str, str | None]]:
    result: list[tuple[str, str, str | None]] = []
    if not isinstance(raw_edges, list):
        return result
    for raw in raw_edges:
        source: Any = None
        target: Any = None
        requested_link_type: str | None = None
        if isinstance(raw, dict):
            source = raw.get("source")
            target = raw.get("target")
            link_type_value = raw.get("link_type")
            if isinstance(link_type_value, str) and link_type_value.strip():
                requested_link_type = link_type_value.strip()
        if (
            isinstance(source, str)
            and source.strip()
            and isinstance(target, str)
            and target.strip()
        ):
            result.append((source.strip(), target.strip(), requested_link_type))
    return result


def _infer_link_type(
    source_type: str, target_type: str, requested: str | None = None
) -> str | None:
    if requested in LINK_TYPE_VALUES and _link_type_allowed(requested, source_type, target_type):
        return requested
    if target_type == "videoComposeNode" and _link_type_allowed(
        "composition_input_for",
        source_type,
        target_type,
    ):
        return "composition_input_for"
    source_object = _link_object_type(source_type)
    target_object = _link_object_type(target_type)
    if source_object in {"TextNode", "ScriptNode"}:
        if target_object in {"TextNode", "ScriptNode"}:
            return "context_for"
        if target_object in {"ImageNode", "VideoNode", "AudioNode"}:
            return "prompt_for"
    if source_object in {"ImageNode", "VideoNode", "AudioNode"} and target_object in {
        "TextNode",
        "ImageNode",
        "VideoNode",
        "AudioNode",
        "ScriptNode",
    }:
        return "media_input_for"
    return None


def _link_type_allowed(link_type: str, source_type: str, target_type: str) -> bool:
    rule = LINK_TYPE_RULES.get(link_type)
    if rule is None:
        return False
    source_objects, target_objects = rule
    source_object = _link_object_type(source_type)
    target_object = _link_object_type(target_type)
    return source_object in source_objects and target_object in target_objects


def _link_object_type(node_type: str) -> str:
    return LINK_OBJECT_TYPE_BY_NODE_TYPE.get(node_type, "")


def _groups(raw_groups: Any, layout: Any) -> list[dict[str, Any]]:
    groups = raw_groups
    if not isinstance(groups, list) and isinstance(layout, dict):
        groups = layout.get("groups")
    if isinstance(groups, dict):
        groups = [groups]
    result: list[dict[str, Any]] = []
    if not isinstance(groups, list):
        return result
    for raw in groups:
        if not isinstance(raw, dict):
            continue
        node_ids = raw.get("node_ids")
        if not isinstance(node_ids, list):
            continue
        refs = [item.strip() for item in node_ids if isinstance(item, str) and item.strip()]
        if len(refs) < 2:
            continue
        label = raw.get("label")
        result.append({"label": str(label).strip() if label else "工作流", "node_ids": refs})
    return result


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result
