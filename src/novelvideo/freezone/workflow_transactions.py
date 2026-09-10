"""Host-neutral, deterministic workflow preparation and revision.

This module has no model calls, canvas writes, or approval authority. HTTP and
MCP adapters share the same transformations and persist only validated results.
"""

from copy import deepcopy
import hashlib
import math
from typing import Any

from novelvideo.freezone.agent_workflows.catalog import (
    compile_workflow_intent,
    validate_agent_workflow_plan,
    workflow_catalog_scope,
)
from novelvideo.freezone.agent_workflows.drafts import build_workflow_draft_patch
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_semantics import text_edge_error

CONTRACT_VERSION = "dramaclaw.workflow-operations.v1"
_SETTINGS = {
    "model": "model",
    "aspect_ratio": "aspectRatio",
    "quality": "quality",
    "duration_seconds": "durationSec",
    "generate_audio": "generateAudio",
    "variants": "count",
    "voice_ref": "voiceRef",
}
_NODE_SETTINGS = {
    "imageGenNode": {"model", "aspect_ratio", "quality", "variants", "resolution"},
    "videoNode": {
        "model",
        "aspect_ratio",
        "quality",
        "duration_seconds",
        "generate_audio",
        "variants",
        "resolution",
    },
    "audioNode": {"voice_ref"},
}
_VOICE_REF_FIELDS = {
    "scope": "scope",
    "character_name": "characterName",
    "characterName": "characterName",
    "identity_id": "identityId",
    "identityId": "identityId",
    "slot": "slot",
    "voice_id": "voiceId",
    "voiceId": "voiceId",
}
_VOICE_REF_REQUIRED_FIELDS = {
    "project_narrator": (),
    "user_custom": ("voiceId",),
    "character_default": ("characterName",),
    "character_age_group": ("characterName", "slot"),
    "identity": ("characterName", "identityId"),
    "identity_resolved": ("characterName", "identityId"),
}


class WorkflowOperationError(ValueError):
    def __init__(
        self, message: str, *, code: str = "invalid_workflow_change", errors=None
    ):
        super().__init__(message)
        self.result = {
            "ok": False,
            "status": code,
            "code": code,
            "error": message,
            "retryable": False,
            "next_action": "correct_reported_fields",
            "errors": errors or [],
        }


def _require_result(result: dict) -> dict:
    if not result.get("ok"):
        raise WorkflowOperationError(
            str(result.get("error") or "workflow validation failed"),
            code=str(result.get("status") or "workflow_validation_failed"),
            errors=result.get("errors"),
        )
    return result


def _node_index(plan: dict) -> dict[str, dict]:
    nodes = plan.get("nodes")
    if not isinstance(nodes, list):
        raise WorkflowOperationError("plan.nodes must be an array")
    index = {}
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            raise WorkflowOperationError("each node requires a string id")
        if node["id"] in index:
            raise WorkflowOperationError("duplicate node id")
        index[node["id"]] = node
    return index


def _add_edge(plan: dict, source: str, target: str, kind: str) -> None:
    edges = plan.setdefault("edges", [])
    if not isinstance(edges, list):
        raise WorkflowOperationError("plan.edges must be an array")
    edge = {"source": source, "target": target, "link_type": kind}
    if edge not in edges:
        edges.append(edge)


def _normalize_voice_ref(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise WorkflowOperationError("voice_ref must be an object")
    unknown = set(value) - set(_VOICE_REF_FIELDS)
    if unknown:
        raise WorkflowOperationError("voice_ref contains unsupported fields")
    normalized: dict[str, str] = {}
    for source, target in _VOICE_REF_FIELDS.items():
        if source not in value:
            continue
        raw = value[source]
        if not isinstance(raw, str) or not raw.strip():
            raise WorkflowOperationError(f"voice_ref.{source} must be non-empty text")
        clean = raw.strip()
        if target in normalized and normalized[target] != clean:
            raise WorkflowOperationError(f"voice_ref.{target} values conflict")
        normalized[target] = clean
    scope = normalized.get("scope")
    required = _VOICE_REF_REQUIRED_FIELDS.get(scope or "")
    if required is None:
        raise WorkflowOperationError("voice_ref.scope is unsupported")
    missing = [field for field in required if not normalized.get(field)]
    if missing:
        raise WorkflowOperationError(
            f"voice_ref requires {', '.join(missing)} for scope {scope}"
        )
    return normalized


def bind_workflow_inputs(plan: dict, bindings: Any) -> dict:
    """Bind declared usages; creating a prompt bridge requires actual prompt text."""
    plan = deepcopy(plan)
    if not isinstance(bindings, list) or len(bindings) > 200:
        raise WorkflowOperationError("bindings must be an array with at most 200 items")
    nodes = _node_index(plan)
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) - {
            "source",
            "target",
            "usage",
            "prompt",
        }:
            raise WorkflowOperationError(
                "binding accepts source, target, usage and optional prompt"
            )
        source_id, target_id = binding.get("source"), binding.get("target")
        if not isinstance(source_id, str) or not isinstance(target_id, str):
            raise WorkflowOperationError("binding source and target must be node ids")
        source, target = nodes.get(source_id), nodes.get(target_id)
        if source is None or target is None or source_id == target_id:
            raise WorkflowOperationError(
                "binding requires distinct existing source and target nodes"
            )
        usage = binding.get("usage")
        if not isinstance(usage, str):
            raise WorkflowOperationError("binding usage must be a string")
        kind = {
            "prompt": "prompt_for",
            "context": "context_for",
            "reference": "media_input_for",
            "dependency": "dependency_for",
            "composition": "composition_input_for",
        }.get(usage)
        if kind is None:
            raise WorkflowOperationError("unsupported binding usage")
        prompt = binding.get("prompt")
        if prompt is not None:
            if usage != "prompt" or not isinstance(prompt, str) or not prompt.strip():
                raise WorkflowOperationError(
                    "actual prompt text is only allowed for prompt bindings"
                )
            if source.get("node_type") not in {
                "textAnnotationNode",
                "scriptNode",
                "beatContextNode",
            }:
                raise WorkflowOperationError("prompt bridges require a text source")
            error = text_edge_error(
                "context_for",
                source.get("node_type"),
                source.get("data"),
                "textAnnotationNode",
            )
            if error:
                raise WorkflowOperationError(error)
            suffix = hashlib.sha256(f"{source_id}\0{target_id}".encode()).hexdigest()[
                :16
            ]
            prompt_id = f"bound_prompt_{suffix}"
            new_node = {
                "id": prompt_id,
                "node_type": "textAnnotationNode",
                "stage": "input",
                "data": {
                    "title": "生成提示词",
                    "content": prompt,
                    "semanticOutputRole": "input_text",
                },
            }
            existing = nodes.get(prompt_id)
            if existing is not None and existing != new_node:
                raise WorkflowOperationError(
                    "prompt binding already exists; update that step instead"
                )
            if existing is None:
                plan["nodes"].append(new_node)
                nodes[prompt_id] = new_node
            _add_edge(plan, source_id, prompt_id, "context_for")
            source_id = prompt_id
        _add_edge(plan, source_id, target_id, kind)
    return plan


def update_workflow_steps(plan: dict, updates: Any) -> dict:
    plan = deepcopy(plan)
    if not isinstance(updates, list) or len(updates) > 200:
        raise WorkflowOperationError(
            "step_updates must be an array with at most 200 items"
        )
    nodes = _node_index(plan)
    for update in updates:
        if not isinstance(update, dict) or set(update) - {
            "node_id",
            "prompt",
            "settings",
        }:
            raise WorkflowOperationError(
                "step update accepts node_id, prompt and settings"
            )
        node_id = update.get("node_id")
        node = nodes.get(node_id) if isinstance(node_id, str) else None
        if node is None:
            raise WorkflowOperationError("step update node not found")
        node_type = node.get("node_type")
        data = node.setdefault("data", {})
        if not isinstance(data, dict):
            raise WorkflowOperationError("node data must be an object")
        if "prompt" in update:
            prompt = update["prompt"]
            if not isinstance(prompt, str) or not prompt.strip():
                raise WorkflowOperationError("prompt must be non-empty text")
            if node_type not in {
                "textAnnotationNode",
                "scriptNode",
                "imageGenNode",
                "videoNode",
                "audioNode",
            }:
                raise WorkflowOperationError("node does not accept prompt updates")
            field = {"textAnnotationNode": "content", "audioNode": "text"}.get(
                node_type, "prompt"
            )
            data[field] = prompt
            if node_type == "textAnnotationNode" and "prompt" in data:
                data["prompt"] = prompt
        settings = update.get("settings", {})
        if not isinstance(settings, dict):
            raise WorkflowOperationError("settings must be an object")
        for key, value in settings.items():
            if key not in _NODE_SETTINGS.get(node_type, set()):
                raise WorkflowOperationError(
                    f"setting {key} is not supported for {node_type}"
                )
            if key == "variants" and (type(value) is not int or value not in (1, 2, 4)):
                raise WorkflowOperationError("variants must be 1, 2 or 4")
            if key == "generate_audio" and not isinstance(value, bool):
                raise WorkflowOperationError("generate_audio must be boolean")
            if key == "duration_seconds" and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or value > 86400
                or not math.isfinite(value)
                or value <= 0
            ):
                raise WorkflowOperationError("duration_seconds must be positive")
            if key not in {
                "variants",
                "generate_audio",
                "duration_seconds",
                "voice_ref",
            } and (not isinstance(value, str) or not value.strip()):
                raise WorkflowOperationError(f"setting {key} must be non-empty text")
            if key == "voice_ref":
                value = _normalize_voice_ref(value)
                data["voiceAvailable"] = True
            field = (
                ("size" if node_type == "imageGenNode" else "quality")
                if key == "resolution"
                else _SETTINGS[key]
            )
            data[field] = deepcopy(value)
    return plan


def prepare_workflow_source(body: dict, *, username: str) -> dict:
    """Accept business intent or an exact plan; return server-owned compilation."""
    if "run_after_create" in body and not isinstance(body["run_after_create"], bool):
        raise WorkflowOperationError("run_after_create must be boolean")
    with workflow_catalog_scope(username):
        intent = body.get("intent")
        compiled = body.get("compiled")
        if "plan" in body:
            if intent is not None or compiled is not None:
                raise WorkflowOperationError("provide exactly one workflow source")
            plan = body["plan"]
            intent = {"schema_version": "freezone_workflow_plan_draft.v1", "plan": plan}
        elif isinstance(compiled, dict):
            plan = compiled.get("plan")
            if isinstance(intent, dict) and "plan" in intent and intent["plan"] != plan:
                raise WorkflowOperationError("workflow intent and compiled plan differ")
        elif isinstance(intent, dict):
            if isinstance(intent.get("plan"), dict):
                plan = intent["plan"]
            else:
                plan = _require_result(compile_workflow_intent(intent))["plan"]
        else:
            raise WorkflowOperationError("intent or plan is required")
        if not isinstance(intent, dict):
            raise WorkflowOperationError("intent must be an object")
        if not isinstance(plan, dict):
            raise WorkflowOperationError("plan must be an object")
        if "bindings" in body:
            plan = bind_workflow_inputs(plan, body["bindings"])
            intent = {"schema_version": "freezone_workflow_plan_draft.v1", "plan": plan}
        validated = _require_result(validate_agent_workflow_plan(plan))
        if isinstance(compiled, dict) and compiled.get("skill_id") != validated.get(
            "skill_id"
        ):
            raise WorkflowOperationError(
                "compiled Skill does not match the validated plan"
            )
        built = _require_result(
            build_workflow_graph_commands({"plan": validated["plan"]})
        )
        if built.get("skipped_edges"):
            raise WorkflowOperationError(
                "workflow contains unresolved edges", errors=built["skipped_edges"]
            )
        return {"intent": deepcopy(intent), "compiled": validated}


def revise_workflow_source(payload: dict, changes: Any, *, username: str) -> dict:
    if not isinstance(changes, dict) or not changes:
        raise WorkflowOperationError("changes must be a non-empty object")
    graph_fields = {"step_updates", "bindings"}
    if graph_fields & set(changes):
        if set(changes) - graph_fields:
            raise WorkflowOperationError(
                "do not mix step/binding changes with compact intent fields"
            )
        plan = deepcopy(payload["compiled"]["plan"])
        if "step_updates" in changes:
            plan = update_workflow_steps(plan, changes["step_updates"])
        if "bindings" in changes:
            plan = bind_workflow_inputs(plan, changes["bindings"])
        prepared = prepare_workflow_source({"plan": plan}, username=username)
        return {**prepared, "last_changes": deepcopy(changes)}
    if isinstance(payload.get("intent", {}).get("plan"), dict):
        raise WorkflowOperationError("exact plans accept step_updates or bindings")
    with workflow_catalog_scope(username):
        patched, error = build_workflow_draft_patch(
            payload=payload,
            changes=changes,
            compile_intent=compile_workflow_intent,
        )
        if error:
            _require_result(error)
        validated = prepare_workflow_source(patched, username=username)
        return {**patched, **validated}
