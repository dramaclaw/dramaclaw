"""Versioned material requirements and the dependency graph that produces them."""
from __future__ import annotations

from copy import deepcopy
import hashlib
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .production_plan_v2 import ResourceV2
from .production_audio_sources import planned_speech_sources


def material_content_blocks(review: dict[str, Any]) -> bool:
    """Only an explicit content rejection blocks a candidate.

    Content that could not be observed (``unavailable``) stays advisory: the
    candidate keeps its technical pass, can be accepted and bound to the plan,
    and is confirmed in aggregate later. A rejection still blocks acceptance;
    regenerating stays an explicit action on the same step.
    """
    return (review.get("content") or {}).get("status") == "rejected"


_BINDABLE_PLACEMENT_KINDS = frozenset({"visual", "audio"})


def bindable_placement_ids(plan: dict[str, Any], requirement: dict[str, Any]) -> list[str]:
    """Placements a material step can own: media layers only.

    Subtitle and graphic placements are drawn from authored text. ``bind_media``
    refuses them, so a plan listing them as final targets would otherwise fail
    every automatic binding retry forever.
    """
    placements = {row.get("id"): row for row in plan.get("placements", [])}
    return [placement_id for placement_id in requirement.get("placement_ids", [])
            if (placements.get(placement_id) or {}).get("kind") in _BINDABLE_PLACEMENT_KINDS]


def binds_final_media(plan: dict[str, Any], requirement: dict[str, Any]) -> bool:
    """Whether this requirement hands its media to a placement or take.

    A requirement with neither final target is an intermediate reference, such
    as one shared identity image feeding several shots. Its step is still
    accepted and reviewed on its own, but no plan resource carries it, so
    completion must not require it to be registered in the plan.
    """
    return bool(bindable_placement_ids(plan, requirement) or requirement.get("take_ids"))


class _Value(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class MaterialSourceConflict(ValueError):
    """A material final step disagrees with the plan's authored speech owner."""

    def __init__(self, message: str, *, placement_id: str,
                 turn_ids: list[str], step_ids: list[str]) -> None:
        super().__init__(message)
        self.details = {"code": "material_speech_source_conflict",
                        "placement_id": placement_id, "turn_ids": turn_ids,
                        "step_ids": step_ids, "message": message}


class MaterialWorkRequestError(ValueError):
    """A bounded, deterministic material-work request failure for the Agent."""

    def __init__(self, *, code: str, message: str,
                 errors: list[dict[str, str]],
                 next_action: str = "correct_material_request",
                 retryable: bool = False) -> None:
        self.details = {
            "code": code,
            "phase": "material_plan_drafting",
            "message": str(message)[:300],
            "errors": [
                {"path": str(item.get("path", "material_work"))[:160],
                 "message": str(item.get("message", "invalid material request"))[:300]}
                for item in errors[:8]
            ],
            "next_action": next_action,
            "retryable": bool(retryable),
            "side_effects": "none",
        }
        super().__init__(self.details["message"])


def _material_request_errors(exc: ValueError) -> list[dict[str, str]]:
    """Extract bounded Pydantic paths without forwarding request values."""
    getter = getattr(exc, "errors", None)
    raw = getter() if callable(getter) else []
    items: list[dict[str, str]] = []
    for item in raw[:8] if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        parts = item.get("loc") or ()
        path = ""
        for part in parts:
            if isinstance(part, int) and 0 <= part <= 9999:
                path += f"[{part}]"
            elif isinstance(part, str) and part.replace("_", "").replace("-", "").isalnum():
                path += ("." if path else "") + part[:80]
            else:
                path = ""
                break
        message = item.get("msg")
        if path and isinstance(message, str) and message.strip():
            items.append({"path": path, "message": " ".join(message.split())[:300]})
    return items or [{"path": "material_work", "message": " ".join(str(exc).split())[:300]}]


class MaterialReference(_Value):
    step_id: str | None = None
    node_id: str | None = None
    role: Literal["identity", "product", "setting", "composition", "motion", "voice", "first_frame", "last_frame"]

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.step_id) == bool(self.node_id):
            raise ValueError("material reference requires exactly one step or node")
        return self


class PreservationBinding(_Value):
    choice_id: str = Field(min_length=1, max_length=160)
    source_node_id: str = Field(min_length=1, max_length=160)
    role: Literal["identity", "product", "setting", "composition", "motion", "first_frame", "last_frame"]
    # Filled from the current project media by the host, never trusted from a
    # proposed work package. It catches a source changing after preparation.
    source_media_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class MaterialRequirement(_Value):
    id: str = Field(min_length=1, max_length=128)
    placement_ids: list[str] = Field(default_factory=list, max_length=200)
    take_ids: list[str] = Field(default_factory=list, max_length=200)
    turn_ids: list[str] = Field(default_factory=list, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    media_kind: Literal["image", "video", "audio"]
    final_step_id: str = Field(min_length=1)
    acceptance: list[str] = Field(default_factory=list, max_length=100)
    preservation_bindings: list[PreservationBinding] = Field(default_factory=list, max_length=100)


class MaterialStep(_Value):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=200)
    media_kind: Literal["image", "video", "audio"]
    source: Literal["generate", "existing", "upload"]
    recipe_id: Literal["general-image", "general-video", "general-audio"] | None = None
    prompt: str = Field(default="", max_length=20000)
    dialogue_turn_ids: list[str] = Field(default_factory=list, max_length=200)
    node_id: str | None = None
    depends_on: list[str] = Field(default_factory=list, max_length=100)
    references: list[MaterialReference] = Field(default_factory=list, max_length=100)
    generation_inputs: dict[str, Any] = Field(default_factory=dict)
    status: Literal["planned", "awaiting_upload", "submitted", "candidate", "accepted", "rejected", "stale"] = "planned"
    candidates: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    accepted_resource: ResourceV2 | None = None
    review_ref: dict[str, Any] | None = None
    execution: dict[str, Any] | None = None
    task_id: str | None = None
    reason: str | None = None

    @model_validator(mode="after")
    def executable(self):
        reserved = {"id", "recipe_id", "prompt", "name", "reference_inputs", "node_id", "depends_on", "source", "status"}
        if reserved & self.generation_inputs.keys():
            raise ValueError("generation_inputs cannot override execution identity or references")
        if {"dialogue", "narration", "voiceover", "speech_text", "speechText"} & self.generation_inputs.keys():
            raise ValueError("generation_inputs cannot supply dialogue; use saved dialogue turn IDs")
        if self.dialogue_turn_ids:
            if self.source != "generate" or self.media_kind == "image":
                raise ValueError("dialogue turn IDs require generated audio or video")
        if self.source == "generate":
            if self.recipe_id != "general-" + self.media_kind or not self.prompt.strip():
                raise ValueError("generation step requires matching Recipe and prompt")
        elif self.recipe_id is not None:
            raise ValueError("supplied material cannot request generation")
        if self.status == "accepted" and (self.accepted_resource is None or self.review_ref is None):
            raise ValueError("accepted material requires resource and review")
        return self


class MaterialWorkPackageV1(_Value):
    schema_version: Literal[1] = 1
    plan_ref: dict[str, Any]
    input_fingerprint: str
    requirements: list[MaterialRequirement] = Field(min_length=1, max_length=200)
    steps: list[MaterialStep] = Field(min_length=1, max_length=200)
    command_id: str = Field(min_length=1, max_length=128)
    confirmed_generation_choices: dict[str, Any] | None = None
    command_receipts: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def graph(self):
        steps = {s.id: s for s in self.steps}
        if len(steps) != len(self.steps) or len({r.id for r in self.requirements}) != len(self.requirements):
            raise ValueError("material IDs must be unique")
        done: set[str] = set()
        pending: set[str] = set()
        def visit(key: str):
            if key in pending:
                raise ValueError("material dependency cycle")
            if key in done:
                return
            pending.add(key)
            step = steps[key]
            deps = set(step.depends_on) | {r.step_id for r in step.references if r.step_id}
            for dep in deps:
                if dep not in steps:
                    raise ValueError("unknown material dependency")
                visit(dep)
            pending.remove(key)
            done.add(key)
        for key in steps:
            visit(key)
        for requirement in self.requirements:
            step = steps.get(requirement.final_step_id)
            if not step or step.media_kind != requirement.media_kind:
                raise ValueError("final material step does not match requirement")
        return self


def _exact_ref(ref: dict) -> dict:
    if (not isinstance(ref, dict) or set(ref) != {"artifact_id", "revision"}
            or not isinstance(ref["artifact_id"], str) or type(ref["revision"]) is not int or ref["revision"] < 1):
        raise ValueError("exact artifact revision required")
    return ref


def _fingerprint(store, plan: dict, requirements: list[dict]) -> str:
    turns = {t["id"]: t for b in plan["beats"] for t in b.get("turns", [])}
    placements = {p["id"]: p for p in plan["placements"]}
    takes = {t["id"]: t for t in plan.get("speech_takes", [])}
    speech_sources = planned_speech_sources(plan)
    selected = []
    for requirement in requirements:
        # Old work revisions did not have this optional field. An empty value
        # must retain their original fingerprint when they are revised.
        normalized = {key: value for key, value in requirement.items()
                      if key != 'preservation_bindings' or value}
        entry = {"requirement": normalized, "placements": [], "turns": [], "takes": []}
        target_ids = set(requirement.get("placement_ids", []))
        target_ids.update(takes[take_id]["origin_placement_id"]
                          for take_id in requirement.get("take_ids", []) if take_id in takes)
        owned_speech = [{"placement_id": placement_id, "turn_ids": speech_sources[placement_id]}
                        for placement_id in sorted(target_ids & speech_sources.keys())]
        if owned_speech:
            entry["planned_speech_sources"] = owned_speech
        for key, source in (("placement_ids", placements), ("take_ids", takes), ("turn_ids", turns)):
            for entity_id in requirement.get(key, []):
                if entity_id not in source:
                    raise ValueError(f"material {key} references missing placement/take/turn")
                entity = source[entity_id]
                if key == "turn_ids":
                    entity = {"id": entity_id, "speaker": entity.get("speaker"), "text": entity["text"],
                              **({"speech_placement_id": entity["speech_placement_id"]}
                                 if "speech_placement_id" in entity else {})}
                elif key == "placement_ids":
                    entity = {k: v for k, v in entity.items() if k in {"id", "kind", "role", "turn_id", "content", "graphic", "source_audio"}}
                entry[{"placement_ids": "placements", "take_ids": "takes", "turn_ids": "turns"}[key]].append(entity)
        selected.append(entry)
    return hashlib.sha256(store._canonical({"goal": plan["goal"], "selected": selected})).hexdigest()


def validate_material_work_lineage(store, payload: dict, refs: list[dict]) -> None:
    ref = _exact_ref(payload["plan_ref"])
    if not any(r["artifact_id"] == ref["artifact_id"] and r["revision"] == ref["revision"] for r in refs):
        raise ValueError("material work requires exact plan dependency")
    plan = store._read(ref["artifact_id"], ref["revision"])
    if plan["schema"] != "production_plan.v2" or _fingerprint(store, plan["payload"], payload["requirements"]) != payload["input_fingerprint"]:
        raise ValueError("material work input differs from saved plan")
    _validate_step_dialogue(plan["payload"], payload)


def validate_final_material_bindings(requirements: list[dict[str, Any]]) -> None:
    """Each single-resource target is owned by one final production step."""
    owners: dict[tuple[str, str], str] = {}
    for requirement in requirements:
        final_step_id = requirement['final_step_id']
        for field in ('placement_ids', 'take_ids'):
            for target_id in requirement.get(field, []):
                key = (field, target_id)
                if key in owners and owners[key] != final_step_id:
                    raise ValueError(
                        'final material bindings conflict: different final_step_id values '
                        'cannot own the same placement_id or take_id; use '
                        'freezone_prepare_production_edit to add or edit actual saved '
                        'placements/takes before preparing new work, keep shared reference '
                        'images as intermediate steps without final bindings, or reuse '
                        'one final step across distinct saved targets'
                    )
                owners[key] = final_step_id


def validate_material_completion(store, work: dict, plan: dict) -> None:
    """Check the current selected finals, including their real accepted reviews."""
    if work['schema'] != 'material_work_package.v1' or _fingerprint(store, plan, work['payload']['requirements']) != work['payload']['input_fingerprint']:
        raise ValueError('material requirements changed; prepare current work')
    validate_final_material_bindings(work['payload']['requirements'])
    steps = {step['id']: step for step in work['payload']['steps']}
    resources = {row['id']: row for row in plan.get('resources', [])}
    placements = {row['id']: row for row in plan.get('placements', [])}
    takes = {row['id']: row for row in plan.get('speech_takes', [])}
    for requirement in work['payload']['requirements']:
        step = steps[requirement['final_step_id']]
        resource = step.get('accepted_resource')
        if step['status'] != 'accepted' or not resource:
            raise ValueError('material acceptance was invalidated or is not bound')
        if binds_final_media(plan, requirement) and resources.get(resource['id']) != resource:
            raise ValueError('material acceptance was invalidated or is not bound')
        review_ref = step.get('review_ref') or {}
        review = store._read(review_ref.get('artifact_id', ''), review_ref.get('revision', 0))
        if store._latest_revision(review['id']) != review['revision'] or review['created_by'] != store.created_by:
            raise ValueError('material review is no longer the authorized current head')
        from .material_review import validate_material_review_lineage
        validate_material_review_lineage(store, review['payload'], review['upstream_refs'])
        path = (store.project_dir / resource['media_path']).resolve()
        if not path.is_relative_to(store.project_dir.resolve()) or not path.is_file():
            raise ValueError('accepted material media unavailable before completion')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != resource['media_hash']:
            raise ValueError('accepted material media changed before completion')
        evidence = review['payload']
        if review['schema'] != 'material_review.v1' or evidence['technical']['status'] != 'passed' or material_content_blocks(evidence) or evidence['resource'] != resource or evidence['step_id'] != step['id'] or evidence['work_ref']['artifact_id'] != work['id']:
            raise ValueError('material acceptance requires its actual passed review')
        if any(placements[placement_id].get('resource_id') != resource['id']
               for placement_id in bindable_placement_ids(plan, requirement)):
            raise ValueError('material final binding differs from current plan')
        if any(takes.get(take_id, {}).get('resource_id') != resource['id'] for take_id in requirement.get('take_ids', [])):
            raise ValueError('material final binding differs from current plan')


def _confirmed_visual_choices(direction: dict | None) -> set[str]:
    """Only explicit structured visual identity decisions create source duties."""
    choices = (direction or {}).get('preserve_replace', [])
    if not isinstance(choices, list):
        return set()
    required: set[str] = set()
    for choice in choices:
        if not isinstance(choice, dict) or choice.get('action') != 'preserve' or choice.get('visual_identity') is not True:
            continue
        identity = choice.get('id') or (
            f"{choice.get('entity_kind')}:{choice.get('entity_id')}"
            if choice.get('entity_kind') and choice.get('entity_id') else None
        )
        if not isinstance(identity, str) or not identity.strip():
            raise ValueError('confirmed visual preservation choice requires an identity')
        required.add(identity)
    return required


def _validate_preservation_bindings(store, work: dict, canvas: dict, *,
                                    required_choices: set[str] | None = None,
                                    prepare: bool = False) -> None:
    """Prove a confirmed visual source reaches each bound final material."""
    from .material_execution import canvas_material_resource

    steps = {step['id']: step for step in work['steps']}
    bound_choices: set[str] = set()

    def referenced_source(step_id: str, source_node_id: str, role: str,
                          seen: set[str]) -> bool:
        if step_id in seen:
            return False
        visited = seen | {step_id}
        step = steps[step_id]
        if step['source'] == 'existing' and step.get('node_id') == source_node_id:
            return True
        for reference in step.get('references', []):
            if reference.get('node_id') == source_node_id and reference.get('role') == role:
                return True
            parent = reference.get('step_id')
            if parent in steps and referenced_source(parent, source_node_id, role, visited):
                return True
        return False

    for requirement in work['requirements']:
        for binding in requirement.get('preservation_bindings', []):
            choice_id = binding['choice_id']
            bound_choices.add(choice_id)
            source = binding['source_node_id']
            if not referenced_source(requirement['final_step_id'], source, binding['role'], set()):
                raise ValueError(f'preservation binding {choice_id} has no reference path to final step {requirement["final_step_id"]}')
            kind = _canvas_reference_kind(canvas, source)
            if kind != 'image':
                raise ValueError(f'preservation binding {choice_id} requires an image source; current source is {kind}')
            actual = canvas_material_resource(store, canvas, source, kind)
            if prepare:
                binding['source_media_hash'] = actual['media_hash']
            elif binding.get('source_media_hash') != actual['media_hash']:
                raise ValueError(f'preservation binding {choice_id} source media changed')
    missing = (required_choices or set()) - bound_choices
    if missing:
        raise ValueError('confirmed visual preservation choices lack material bindings: ' + ', '.join(sorted(missing)))


def _apply_confirmed_material_choices(steps: list[dict], choices: dict | None) -> list[dict]:
    """Copy compatible saved user choices into otherwise unspecified steps."""
    copied = deepcopy(steps)
    if not isinstance(choices, dict):
        return copied
    for step in copied:
        kind = step.get('media_kind')
        if step.get('source') != 'generate' or kind not in {'image', 'video'}:
            continue
        prefix = f'{kind}_'
        explicit = _material_generation_controls(step)
        model_key = f'{kind}_model'
        if (model_key in explicit and model_key in choices
                and explicit[model_key] not in ('recommended', choices[model_key])):
            continue
        inputs = step.setdefault('generation_inputs', {})
        for key, value in choices.items():
            if key.startswith(prefix) and key != 'video_duration_seconds' and (
                    key not in explicit or explicit[key] == 'recommended'):
                if explicit.get(key) == 'recommended':
                    aliases = {
                        f'{kind}_model': ('model', f'{kind}_model'),
                        f'{kind}_aspect_ratio': ('aspectRatio', 'aspect_ratio', f'{kind}_aspect_ratio'),
                        f'{kind}_resolution': (('quality', 'resolution', 'video_resolution')
                                                if kind == 'video' else
                                                ('size', 'resolution', 'image_resolution')),
                    }.get(key, (key,))
                    for alias in aliases:
                        if inputs.get(alias) == 'recommended':
                            del inputs[alias]
                inputs[key] = value
        _material_generation_controls(step)
    return copied


def material_parameter_conflicts(steps: list[dict], choices: dict | None) -> list[dict]:
    """A proposed concrete setting cannot silently replace the user's saved choice."""
    confirmed = choices if isinstance(choices, dict) else {}
    conflicts = []
    for step in steps:
        kind = step.get('media_kind')
        if step.get('source') != 'generate' or kind not in {'image', 'video'}:
            continue
        explicit = _material_generation_controls(step)
        for field, chosen in confirmed.items():
            if (not field.startswith(kind + '_') or field == 'video_duration_seconds'
                    or field not in explicit or explicit[field] == 'recommended'):
                continue
            if explicit[field] != chosen:
                conflicts.append({'step_id': step.get('id'), 'field': field,
                                  'chosen': chosen, 'proposed': explicit[field]})
    return conflicts


def missing_material_parameter_choices(steps: list[dict], choices: dict | None) -> dict[str, list[str]]:
    """Require a human parameter receipt for each media type actually generated."""
    confirmed = choices if isinstance(choices, dict) else {}
    required = ('model', 'aspect_ratio', 'resolution')
    missing: dict[str, list[str]] = {}
    for step in steps:
        kind = step.get('media_kind')
        if step.get('source') != 'generate' or kind not in {'image', 'video'}:
            continue
        absent = [field for field in required if not confirmed.get(f'{kind}_{field}')]
        if absent:
            bucket = missing.setdefault(kind, [])
            bucket.extend(field for field in absent if field not in bucket)
    return missing


def material_duration_issues(steps: list[dict]) -> list[dict]:
    """Check each actual video request, independent of the film's total length."""
    issues = []
    aliases = ('durationSec', 'duration_seconds', 'durationSeconds',
               'video_duration_seconds', 'duration')
    for step in steps:
        if step.get('source') != 'generate' or step.get('media_kind') != 'video':
            continue
        inputs = step.get('generation_inputs') or {}
        present = [(key, inputs[key]) for key in aliases if key in inputs]
        values = {value for _, value in present if type(value) is int}
        valid = (len(present) >= 1 and len(values) == 1
                 and all(type(value) is int for _, value in present)
                 and 4 <= next(iter(values)) <= 15)
        if not valid:
            issues.append({
                'step_id': step.get('id'), 'actual': dict(present) if present else None,
                'minimum': 4, 'maximum': 15,
                'message': f"Video material step {step.get('id')} needs an explicit integer durationSec of 4–15 seconds",
            })
    return issues


def prepare_material_work(store, plan_ref: dict, requirements: list[dict], steps: list[dict], command_id: str, *, canvas: dict | None = None, direction: dict | None = None, confirmed_choices: dict | None = None) -> dict:
    try:
        return _prepare_material_work(store, plan_ref, requirements, steps, command_id,
                                      canvas=canvas, direction=direction,
                                      confirmed_choices=confirmed_choices)
    except (MaterialSourceConflict, MaterialWorkRequestError):
        raise
    except ValueError as exc:
        errors = _material_request_errors(exc)
        raise MaterialWorkRequestError(
            code="material_work_request_invalid",
            message=errors[0]["message"] if errors else "素材工作包请求不符合当前方案或素材约束",
            errors=errors,
        ) from exc


def _prepare_material_work(store, plan_ref: dict, requirements: list[dict], steps: list[dict], command_id: str, *, canvas: dict | None = None, direction: dict | None = None, confirmed_choices: dict | None = None, _artifact_guard=None) -> dict:
    """Reserve an immutable work package under the project artifact mutex."""
    plan_ref = _exact_ref(plan_ref)
    steps = _apply_confirmed_material_choices(steps, confirmed_choices)
    for step in steps:
        if (step.get("status", "planned") not in {"planned", "awaiting_upload"} or step.get("candidates")
                or any(step.get(key) for key in ("accepted_resource", "review_ref", "execution", "task_id"))):
            raise ValueError("initial material execution and acceptance are server owned")
    from contextlib import nullcontext
    with (nullcontext(_artifact_guard) if _artifact_guard is not None else store._locked()) as guard:
        plan = store._read(plan_ref["artifact_id"], plan_ref["revision"])
        if plan["schema"] != "production_plan.v2":
            raise ValueError("material work requires production plan")
        requirements = [MaterialRequirement.model_validate(row).model_dump(mode="json", exclude_none=True) for row in requirements]
        validate_final_material_bindings(requirements)
        fingerprint = _fingerprint(store, plan["payload"], requirements)
        payload = MaterialWorkPackageV1.model_validate({"plan_ref": plan_ref, "requirements": requirements, "steps": steps,
                    "input_fingerprint": fingerprint, "command_id": command_id,
                    "confirmed_generation_choices": confirmed_choices or None}).model_dump(mode="json", exclude_none=True)
        _validate_step_dialogue(plan["payload"], payload)
        required_choices = _confirmed_visual_choices(direction)
        if (required_choices or any(row.get('preservation_bindings') for row in payload['requirements'])) and canvas is None:
            raise ValueError('visual preservation requires the current authorized canvas')
        if canvas is not None:
            _validate_preservation_bindings(store, payload, canvas,
                                            required_choices=required_choices, prepare=True)
            payload['input_fingerprint'] = _fingerprint(store, plan['payload'], payload['requirements'])
            _validate_reference_media(store, payload, canvas)
            material_workflow_intent(payload, canvas=canvas, store=store)
        artifact_id = hashlib.sha256(("material-work:" + command_id).encode()).hexdigest()[:32]
        try:
            old = store._read(artifact_id, 1)
        except FileNotFoundError:
            old = None
        if old:
            if old["payload"] != payload:
                raise ValueError("material command_id reused with different inputs")
            return {"work_ref": {"artifact_id": artifact_id, "revision": 1}, "ready_step_ids": ready_material_steps(payload)}
        refs = store._reference_list([plan_ref], store.project_id)
        validate_material_work_lineage(store, payload, refs)
        store._publish(artifact_id=artifact_id, schema="material_work_package.v1", revision=1,
                       payload=payload, upstream_refs=refs, created_by=store.created_by, guard=guard)
        return {"work_ref": {"artifact_id": artifact_id, "revision": 1}, "ready_step_ids": ready_material_steps(payload)}


def material_stage_groups(work: dict) -> list[list[str]]:
    """Group dependency depths into human-reviewed production stages."""
    steps = {step['id']: step for step in work['steps']}
    depths, visiting = {}, set()

    def depth(step_id):
        if step_id in depths:
            return depths[step_id]
        if step_id in visiting or step_id not in steps:
            raise ValueError('material stage dependencies must be an acyclic saved graph')
        visiting.add(step_id)
        step = steps[step_id]
        dependencies = set(step.get('depends_on', [])) | {
            ref['step_id'] for ref in step.get('references', []) if ref.get('step_id')}
        depths[step_id] = max((depth(dep) + 1 for dep in dependencies), default=0)
        visiting.remove(step_id)
        return depths[step_id]

    for step_id in steps:
        depth(step_id)
    return [[step_id for step_id in steps if depths[step_id] == level]
            for level in sorted(set(depths.values()))]


def ready_material_steps(work: dict, reopenable_step_ids=None) -> list[str]:
    accepted = {s["id"] for s in work["steps"] if s.get("status") == "accepted"}
    stage = next((set(group) for group in material_stage_groups(work)
                  if not set(group) <= accepted), set())
    reopenable = set(reopenable_step_ids or ())
    ready: list[str] = []
    for step in work["steps"]:
        if step['id'] not in stage:
            continue
        status = step.get("status")
        if status not in {"planned", "awaiting_upload", "rejected", "stale"} and not (
                status == "submitted" and step["id"] in reopenable):
            continue
        dependencies = set(step.get("depends_on", [])) | {
            r["step_id"] for r in step.get("references", []) if r.get("step_id")}
        if dependencies <= accepted:
            ready.append(step["id"])
    return ready


def pending_material_steps(work: dict, reopenable_step_ids=None) -> list[str]:
    """Steps that still need work, in plan order and ignoring earlier waves.

    Execution order belongs to the compiled graph edges, so a step whose
    prerequisites are still unproduced is already part of the same draft wave.
    Steps bound to a draft that was never confirmed (``reopenable_step_ids``)
    are pending again so a wrong draft can be replanned without a manual retry.
    ``ready_material_steps`` stays the "runnable right now" projection.
    """
    reopenable = set(reopenable_step_ids or ())
    return [s["id"] for s in work["steps"]
            if s.get("status") in {"planned", "awaiting_upload", "rejected", "stale"}
            or (s.get("status") == "submitted" and s["id"] in reopenable)]


def material_lifecycle_status(
    work: dict[str, Any] | None,
    *,
    workflow_draft: dict[str, Any] | None = None,
    delivery_receipts: list[dict[str, Any]] | None = None,
    pending_approval: bool = False,
    native_statuses: list[str] | None = None,
) -> dict[str, str]:
    """Project material progress without conflating persistence with execution."""
    saved = isinstance(work, dict) and isinstance(work.get("steps"), list)
    material_work_status = "saved" if saved else "not_saved"

    raw_draft_status = None
    if isinstance(workflow_draft, dict):
        # A tool receipt carries the transport status ("workflow_draft_ready")
        # alongside the persisted draft state. Only draft_status is the draft;
        # reading the envelope status first reports a ready draft as failed.
        raw_draft_status = workflow_draft.get("draft_status") or workflow_draft.get("status")
    draft_status = str(raw_draft_status or "not_created")
    if draft_status not in {"not_created", "ready", "confirming", "submitted", "confirmed", "cancelled"}:
        draft_status = "failed"

    receipts = delivery_receipts if isinstance(delivery_receipts, list) else []
    graph_states = {
        str(receipt.get("graph_state"))
        for receipt in receipts
        if isinstance(receipt, dict) and receipt.get("graph_state")
    }
    if "delivered" in graph_states:
        canvas_delivery_status = "delivered"
    elif not isinstance(workflow_draft, dict):
        canvas_delivery_status = "not_requested"
    elif "rejected" in graph_states:
        canvas_delivery_status = "failed"
    elif pending_approval and draft_status in {"confirming", "submitted"}:
        canvas_delivery_status = "awaiting_confirmation"
    elif draft_status == "ready" and not workflow_draft.get("confirmation_started_at"):
        canvas_delivery_status = "ready_to_submit"
    else:
        canvas_delivery_status = "pending"

    generated_steps = [
        step for step in (work or {}).get("steps", [])
        if isinstance(step, dict) and step.get("source") == "generate"
    ]
    result_steps = [
        step for step in generated_steps
        if step.get("status") in {"candidate", "accepted"}
        and (
            (step.get("status") == "accepted" and isinstance(step.get("accepted_resource"), dict))
            or (isinstance(step.get("candidates"), list) and bool(step.get("candidates")))
        )
    ]
    if generated_steps and len(result_steps) == len(generated_steps):
        generation_status = "completed"
    elif result_steps:
        generation_status = "candidate_ready"
    elif any(status in {"queued", "pending", "running"} for status in (native_statuses or [])):
        generation_status = "submitted"
    else:
        generation_status = "not_started"

    return {
        "material_work_status": material_work_status,
        "workflow_draft_status": draft_status,
        "canvas_delivery_status": canvas_delivery_status,
        "generation_status": generation_status,
    }


def _validate_step_dialogue(plan: dict, work: dict) -> None:
    from .production_dialogue import generation_dialogue

    steps = {step["id"]: step for step in work["steps"]}
    sources = planned_speech_sources(plan)
    source_by_turn = {turn_id: placement_id for placement_id, ids in sources.items() for turn_id in ids}
    ordered_turns = [turn_id for ids in sources.values() for turn_id in ids]
    takes = {take["id"]: take for take in plan.get("speech_takes", [])}
    owner_by_turn: dict[str, str] = {}
    for requirement in work["requirements"]:
        step_id = requirement["final_step_id"]
        targets = set(requirement.get("placement_ids", []))
        targets.update(takes[take_id]["origin_placement_id"] for take_id in requirement.get("take_ids", []))
        for turn_id in requirement.get("turn_ids", []):
            source_id = source_by_turn.get(turn_id)
            if source_id is None:
                continue
            if source_id not in targets:
                raise MaterialSourceConflict(
                    f"material source conflict: turn {turn_id} planned placement {source_id} "
                    f"is not owned by final step {step_id}",
                    placement_id=source_id, turn_ids=[turn_id], step_ids=[step_id])
            previous = owner_by_turn.setdefault(turn_id, step_id)
            if previous != step_id:
                raise MaterialSourceConflict(
                    f"material source conflict: turn {turn_id} placement {source_id} "
                    f"is assigned to final steps {previous} and {step_id}",
                    placement_id=source_id, turn_ids=[turn_id], step_ids=[previous, step_id])
        for source_id in sorted(targets & sources.keys()):
            step = steps[step_id]
            missing_requirement = set(sources[source_id]) - set(requirement.get('turn_ids', []))
            missing_step = (set(sources[source_id]) - set(step.get('dialogue_turn_ids', []))
                            if step['source'] == 'generate' else set())
            if missing_requirement or missing_step:
                coverage = ("to own and generate the complete planned dialogue"
                            if step['source'] == 'generate' else "to cover the complete planned dialogue")
                # Name the field that is short, not just the sentence: the Agent
                # otherwise re-sends the same steps and hits the same conflict.
                reasons = []
                if missing_requirement:
                    reasons.append("requirement omits turns "
                                   + ", ".join(sorted(missing_requirement)))
                if missing_step:
                    reasons.append("step dialogue_turn_ids omits turns "
                                   + ", ".join(sorted(missing_step)))
                raise MaterialSourceConflict(
                    f"material source conflict: placement {source_id} turns "
                    f"{', '.join(sources[source_id])} require final step {step_id} "
                    f"{coverage} ({'; '.join(reasons)})",
                    placement_id=source_id, turn_ids=sources[source_id], step_ids=[step_id])
    for step in work["steps"]:
        ids = step.get("dialogue_turn_ids", [])
        if not ids:
            continue
        generation_dialogue(plan, ids)
        relevant: set[str] = set()
        for requirement in work["requirements"]:
            stack = [requirement["final_step_id"]]
            seen: set[str] = set()
            while stack:
                step_id = stack.pop()
                if step_id in seen:
                    continue
                seen.add(step_id)
                dependency = steps[step_id]
                stack.extend(dependency.get("depends_on", []))
                stack.extend(ref["step_id"] for ref in dependency.get("references", []) if ref.get("step_id"))
            if step["id"] in seen:
                relevant.update(requirement.get("turn_ids", []))
        if not set(ids) <= relevant:
            unexpected = [turn_id for turn_id in ids if turn_id not in relevant]
            allowed = ", ".join(t for t in ordered_turns if t in relevant) or "none"
            raise MaterialWorkRequestError(
                code="material_step_dialogue_turns_mismatch",
                message=(
                    f"material step {step['id']} cannot generate dialogue turns "
                    f"{', '.join(unexpected)}; no requirement finalised on this step "
                    f"covers them (allowed here: {allowed})"
                ),
                errors=[{
                    "path": f"steps[{step['id']}].dialogue_turn_ids",
                    "message": (
                        "keep only turns listed by this step's own requirement; "
                        f"allowed here: {allowed}"
                    ),
                }],
                next_action="correct_material_step_dialogue_turns",
            )
        for turn_id in ids:
            source_id = source_by_turn.get(turn_id)
            if source_id is not None and owner_by_turn.get(turn_id) != step['id']:
                raise MaterialSourceConflict(
                    f"material source conflict: turn {turn_id} planned placement {source_id} "
                    f"cannot be generated by step {step['id']}",
                    placement_id=source_id, turn_ids=[turn_id], step_ids=[step['id']])


def _canvas_reference_kind(canvas: dict | None, node_id: str) -> str:
    """Read canonical current output fields; previews never turn video into image."""
    if canvas is None:
        raise ValueError('material reference requires an authorized current canvas')
    nodes = [node for node in canvas.get('nodes', []) if node.get('id') == node_id]
    if not nodes:
        raise ValueError('material reference is not on the current canvas')
    if len(nodes) != 1:
        raise ValueError('material reference node is ambiguous on the current canvas')
    node = nodes[0]
    data = node.get('data') or {}
    if data.get('workflowResultStale') is True or data.get('remixVisualOutputCurrent') is False:
        raise ValueError('material reference output is stale')
    kinds = {'imageNode': 'image', 'imageGenNode': 'image', 'exportImageNode': 'image',
             'pano360ViewerNode': 'image', 'videoNode': 'video', 'audioNode': 'audio'}
    node_type = node.get('type')
    if node_type and node_type not in kinds and node_type != 'uploadNode':
        raise ValueError('material reference requires a current media node')
    outputs = [kind for kind, field in (('image', 'imageUrl'), ('video', 'videoUrl'), ('audio', 'audioUrl'))
               if isinstance(data.get(field), str) and data[field].strip()]
    nominal = kinds.get(node_type)
    if not outputs and nominal == 'image' and isinstance(data.get('previewImageUrl'), str) and data['previewImageUrl'].strip():
        outputs = ['image']
    if not outputs:
        raise ValueError('material reference node has no current output')
    if len(outputs) != 1:
        raise ValueError('material reference output kind is ambiguous')
    if nominal and nominal != outputs[0]:
        raise ValueError('material reference node kind and current output are contradictory')
    return outputs[0]


def _material_generation_controls(step: dict) -> dict:
    """Translate explicit node controls without guessing or provider normalization."""
    values = step.get('generation_inputs', {})
    if set(values) & {'inputs', 'confirmedInputs', 'mode_confirmations', 'workflowCatalog', 'schema_version'}:
        raise ValueError('material generation controls cannot override workflow identity or confirmation')
    kind = step['media_kind']
    if kind not in {'image', 'video'}:
        return {}
    aliases = {'model': kind + '_model', 'aspectRatio': kind + '_aspect_ratio',
               'aspect_ratio': kind + '_aspect_ratio', 'count': kind + '_variants_per_node',
               'quality': 'video_resolution' if kind == 'video' else 'image_quality'}
    if kind == 'video':
        aliases.update(genMode='video_generation_mode', generateAudio='video_generate_audio',
            durationSec='video_duration_seconds', durationSeconds='video_duration_seconds',
            duration_seconds='video_duration_seconds', duration='video_duration_seconds', resolution='video_resolution')
    else:
        aliases.update(size='image_resolution', resolution='image_resolution')
    aliases.update({key: key for key in aliases.values()})
    # These are already recognized by the unchanged native item parser. Keep
    # their original per-item semantics instead of treating them as controls.
    item_fields = {'title', 'narration', 'voiceover', 'dialogue', 'speech_text', 'speechText',
        'stage', 'timeline_role', 'timelineRole', 'requires_generated_audio', 'audio_kind', 'audioKind',
        'music_length_ms', 'musicLengthMs', 'recipe_pipeline', 'recipePipeline', 'step_id', 'stepId'}
    if kind == 'image':
        item_fields |= {'duration', 'duration_seconds', 'durationSeconds'}
    controls = {}
    for key, value in values.items():
        if key not in aliases:
            if key in item_fields:
                continue
            raise ValueError('unsupported material generation control; use the existing native intent controls')
        target = aliases[key]
        if target.endswith('_variants_per_node'):
            valid = type(value) is int and value in {1, 2, 4}
        elif target == 'video_duration_seconds':
            valid = type(value) is int and 1 <= value <= 600
        elif target == 'video_generate_audio':
            valid = type(value) is bool
        else:
            valid = isinstance(value, str) and bool(value) and value == value.strip()
        if target == 'video_generation_mode':
            from novelvideo.freezone.workflow_schema import PORTABLE_VIDEO_GENERATION_MODES
            valid = valid and value in PORTABLE_VIDEO_GENERATION_MODES
        if not valid:
            raise ValueError('material generation control cannot be represented without conversion')
        if target in controls and (type(controls[target]) is not type(value) or controls[target] != value):
            raise ValueError('material generation control aliases conflict')
        controls[target] = value
    return controls


def material_workflow_intent(work: dict, skill_id: str = "reference-video-remix", *, canvas: dict | None = None,
                             store=None, selected_step_ids: list[str] | None = None,
                             reopenable_step_ids=None) -> dict:
    """Compile only the current stage; downstream work waits for human acceptance."""
    if any(row.get('preservation_bindings') for row in work.get('requirements', [])):
        if canvas is None or store is None:
            raise ValueError('preservation binding requires current project media verification')
        _validate_preservation_bindings(store, work, canvas)
    dialogue_plan = None
    if work.get("plan_ref") and store is not None:
        plan_ref = _exact_ref(work["plan_ref"])
        dialogue_plan = store._read(plan_ref["artifact_id"], plan_ref["revision"])["payload"]
        _validate_step_dialogue(dialogue_plan, work)
    elif any(step.get("dialogue_turn_ids") for step in work["steps"]):
        if store is None:
            raise ValueError("saved production plan is required for dialogue generation")
        raise ValueError("saved production plan is required for dialogue generation")
    voiced_step_ids: set[str] = set()
    if dialogue_plan is not None:
        placements = {row['id']: row for row in dialogue_plan['placements']}
        planned_sources = planned_speech_sources(dialogue_plan)
        take_origins = {row['id']: row['origin_placement_id']
                        for row in dialogue_plan.get('speech_takes', [])}
        for requirement in work['requirements']:
            step = next(row for row in work['steps'] if row['id'] == requirement['final_step_id'])
            if step['media_kind'] != 'video' or step['source'] != 'generate':
                continue
            targets = [*requirement.get('placement_ids', []),
                       *(take_origins[take_id] for take_id in requirement.get('take_ids', []))]
            if any(placements[placement_id].get('source_audio') is True
                   or placement_id in planned_sources or placement_id in take_origins.values()
                   for placement_id in targets):
                voiced_step_ids.add(step['id'])
    steps = {s["id"]: s for s in work["steps"]}
    compile_set = set(ready_material_steps(work, reopenable_step_ids))
    if selected_step_ids is not None:
        if (any(not isinstance(step_id, str) for step_id in selected_step_ids)
                or len(selected_step_ids) != len(set(selected_step_ids))
                or not set(selected_step_ids) <= compile_set):
            raise ValueError("selected material steps must be unique pending saved steps")
        chosen = set(selected_step_ids)
        frontier = list(chosen)
        while frontier:
            selected_step = steps[frontier.pop()]
            prerequisites = [*selected_step.get("depends_on", []),
                             *(ref["step_id"] for ref in selected_step.get("references", [])
                               if ref.get("step_id"))]
            for prerequisite in prerequisites:
                if prerequisite in compile_set and prerequisite not in chosen:
                    chosen.add(prerequisite)
                    frontier.append(prerequisite)
        compile_set = chosen
    external: dict[str, dict] = {}
    items = []
    cohorts, shared_inputs, durations = {}, {}, []
    compiled: set[str] = set()
    for step in work["steps"]:
        if step["id"] not in compile_set or step["source"] != "generate":
            continue
        blockers = ({reference["step_id"] for reference in step.get("references", [])
                     if reference.get("step_id")}
                    | set(step.get("depends_on", [])))
        if (blockers & compile_set) - compiled:
            # A prerequisite stayed out of this wave (incoherent generation
            # controls or an unresolved external reference); its dependents
            # wait with it so the compiled graph stays resolvable.
            continue
        controls = _material_generation_controls(step)
        kind = step['media_kind']
        if kind == 'video' and 'video_generation_mode' not in controls and step.get('references'):
            # The compiled plan carries a consuming edge for this shot, and
            # ``textToVideo`` is the runtime default for an omitted mode, which
            # does not consume media. State the mode the references require.
            controls = {**controls, 'video_generation_mode': 'imageReference'}
        if (
            kind == 'video'
            and step['id'] in voiced_step_ids
            and 'video_generate_audio' not in controls
        ):
            # A shot whose generated dialogue is already saved in the plan
            # cannot be silent. Only an unstated choice is filled here; an
            # explicit `false` stays a preflight conflict the caller resolves.
            controls = {**controls, 'video_generate_audio': True}
        shared = {key: value for key, value in controls.items() if key != 'video_duration_seconds'}
        if kind in cohorts and cohorts[kind] != shared:
            continue
        cohorts.setdefault(kind, shared)
        shared_inputs.update(shared)
        if kind == 'video':
            durations.append(controls.get('video_duration_seconds'))
        inputs = []
        for reference in step.get("references", []):
            node_id = reference.get("node_id")
            step_ref = reference.get("step_id")
            if step_ref and step_ref in compile_set:
                # Same-wave sibling: the compiled plan carries the
                # ``media_input_for`` edge, and the canvas order decides when
                # this step may actually run.
                if steps[step_ref]['media_kind'] != 'image':
                    raise ValueError(f'material workflow supports only image references; actual reference is {steps[step_ref]["media_kind"]}; select or prepare an image reference, use source=existing for an unchanged video clip, or revise the preservation requirement')
                if step_ref not in inputs:
                    inputs.append(step_ref)
                continue
            if step_ref:
                source = steps[step_ref]
                resource = source.get('accepted_resource') or {}
                node_id, media_kind = resource.get('node_id'), resource.get('media_kind')
                if (media_kind not in {'image', 'video', 'audio'} or media_kind != source.get('media_kind')
                        or (source.get('node_id') and source['node_id'] != node_id)):
                    raise ValueError('material reference differs from its actual accepted resource')
                if canvas is not None and _canvas_reference_kind(canvas, node_id) != media_kind:
                    raise ValueError('material reference current output differs from its accepted resource')
            else:
                media_kind = _canvas_reference_kind(canvas, node_id)
            if not node_id:
                raise ValueError("ready material reference has no accepted canvas resource")
            if media_kind != 'image':
                raise ValueError(f'material workflow supports only image references; actual reference is {media_kind}; select or prepare an image reference, use source=existing for an unchanged video clip, or revise the preservation requirement')
            key = "ref_" + hashlib.sha256(node_id.encode()).hexdigest()[:12]
            external[key] = {"id": key, "node_id": node_id, "media_kind": media_kind}
            inputs.append(key)
        item = {"id": step["id"],
                "recipe_id": step["recipe_id"], "prompt": step["prompt"],
                "name": step["label"], **step.get("generation_inputs", {})}
        if step['id'] in voiced_step_ids:
            item['requires_generated_audio'] = True
        if step.get("dialogue_turn_ids"):
            from .production_dialogue import generation_dialogue
            dialogue = generation_dialogue(dialogue_plan, step["dialogue_turn_ids"])
            item["dialogue"] = "\n".join(f"{row['speaker']}：{row['text']}" for row in dialogue)
        model_key = f'{kind}_model' if kind in {'image', 'video'} else None
        if model_key and model_key not in controls:
            # The existing native canvas adapter resolves this symbolic value
            # against the live Catalog. Explicit per-step/user choices above
            # always win; an unavailable recommendation remains a preflight
            # blocker rather than silently changing a confirmed model.
            item['model'] = 'recommended'
        if 'video_duration_seconds' in controls:
            item['duration_seconds'] = controls['video_duration_seconds']
        if inputs:
            item["reference_inputs"] = inputs
        compiled.add(step["id"])
        items.append(item)
    if durations and durations[0] is not None and all(value == durations[0] for value in durations):
        shared_inputs['video_duration_seconds'] = durations[0]
    return {"schema_version": "freezone_workflow_intent.v1", "skill_id": skill_id,
            "user_goal": "按已确认方案准备当前可制作的素材", "inputs": shared_inputs, "items": items,
            "external_inputs": list(external.values()), "include_compose": False}


def _validate_reference_media(store, work: dict, canvas: dict, *, step_ids: set[str] | None = None) -> None:
    """Check actual bytes and type for all currently resolvable references."""
    from .material_execution import canvas_material_resource
    steps = {step['id']: step for step in work['steps']}
    for step in work['steps']:
        if step_ids is not None and step['id'] not in step_ids:
            continue
        if step['source'] == 'existing':
            node_id = step.get('node_id')
            if not node_id:
                raise ValueError('existing material requires a current canvas node')
            actual_kind = _canvas_reference_kind(canvas, node_id)
            if actual_kind != step['media_kind']:
                raise ValueError('existing material media kind differs from step')
            canvas_material_resource(store, canvas, node_id, actual_kind)
        if step['source'] != 'generate':
            continue
        for reference in step.get('references', []):
            node_id = reference.get('node_id')
            if reference.get('step_id'):
                source = steps[reference['step_id']]
                resource = source.get('accepted_resource') or {}
                node_id = resource.get('node_id')
                if node_id is None:
                    continue  # The dependency must be accepted before execution.
                if resource.get('media_kind') != source['media_kind']:
                    raise ValueError('material reference differs from accepted source kind')
            if node_id:
                kind = _canvas_reference_kind(canvas, node_id)
                if kind != 'image':
                    raise ValueError(f'material workflow supports only image references; actual reference is {kind}; select or prepare an image reference, use source=existing for an unchanged video clip, or revise the preservation requirement')
                actual = canvas_material_resource(store, canvas, node_id, kind)
                if reference.get('step_id') and actual != resource:
                    raise ValueError('accepted material reference differs from current project media')


class _IndependentMaterialReviewContinuity:
    """One operation's bounded proof of native independent acceptance history.

    Original reviews and receipts remain immutable. This cache exists only while
    the caller holds the artifact mutex; it is never an approval supplied by an Agent.
    """
    def __init__(self, store, current: dict, canvas_id: str | None):
        self.store, self.current, self.canvas_id = store, current, canvas_id
        self._artifacts = {(current['id'], current['revision']): current}
        self._latest = {}
        self._validated_work = set()
        self._transitions = set()
        self._ranges = set()

    def __getattr__(self, name):
        return getattr(self.store, name)

    def _read(self, artifact_id, revision):
        key = (artifact_id, revision)
        if key not in self._artifacts:
            self._artifacts[key] = self.store._read(artifact_id, revision)
        return self._artifacts[key]

    def _head(self, artifact_id):
        if artifact_id not in self._latest:
            self._latest[artifact_id] = self.store._latest_revision(artifact_id)
        return self._latest[artifact_id]

    def _same(self, left, right):
        return self.store._canonical(left) == self.store._canonical(right)

    @staticmethod
    def _step(work, step_id):
        step = next((s for s in work['payload']['steps'] if s['id'] == step_id), None)
        if not step or step['source'] != 'existing' or step.get('references') or step.get('depends_on'):
            raise ValueError('historical material review requires an independent existing step')
        return step

    def _work(self, revision):
        if not 0 <= self.current['revision'] - revision <= 200:
            raise ValueError('material review acceptance history exceeds its bounded proof')
        saved = self._read(self.current['id'], revision)
        if saved['schema'] != 'material_work_package.v1' or saved['created_by'] != self.store.created_by:
            raise ValueError('material review work belongs to another actor')
        if revision not in self._validated_work:
            validate_material_work_lineage(self, saved['payload'], saved['upstream_refs'])
            self._validated_work.add(revision)
        return saved

    def _plan(self, work):
        plan_ref = work['plan_ref']
        return self._read(plan_ref['artifact_id'], plan_ref['revision'])['payload']

    def _review(self, review, step_id, resource, previous_revision):
        from .material_review import validate_material_review_lineage
        payload = review['payload']
        decision = payload.get('user_decision') or {}
        if (not isinstance(self.canvas_id, str) or not self.canvas_id or review['schema'] != 'material_review.v1'
                or review['created_by'] != self.store.created_by
                or self._head(review['id']) != review['revision']
                or payload['actor_kind'] != 'user' or not payload.get('decision_receipt_id')
                or decision.get('canvas_id') != self.canvas_id
                or payload['technical']['status'] != 'passed' or payload['content']['status'] != 'passed'
                or payload['step_id'] != step_id or not self._same(payload['resource'], resource)
                or payload['work_ref'].get('artifact_id') != self.current['id']):
            raise ValueError('historical material review requires its original current scoped user receipt')
        basis = _exact_ref(payload['work_ref'])
        if basis['revision'] > previous_revision:
            raise ValueError('material review basis is newer than its acceptance')
        step = self._step(self._work(basis['revision']), step_id)
        validate_material_review_lineage(self, payload, review['upstream_refs'])
        if step.get('node_id') != resource['node_id']:
            raise ValueError('material review differs from its original existing node')
        self._range(basis['revision'], previous_revision, step_id)

    def _transition(self, revision):
        if revision in self._transitions:
            return
        before, after = self._work(revision - 1), self._work(revision)
        old, new = before['payload'], after['payload']
        receipts = new.get('command_receipts', [])
        prior = old.get('command_receipts', [])
        if len(receipts) != len(prior) + 1 or not self._same(receipts[:-1], prior):
            raise ValueError('material history is not native acceptance bookkeeping')
        receipt = receipts[-1]
        request = receipt.get('request', {})
        if (set(receipt) != {'command_id', 'request', 'result'}
                or set(request) != {'work_ref', 'step_id', 'resource', 'review_ref'}
                or request['work_ref'] != {'artifact_id': self.current['id'], 'revision': revision - 1}
                or not isinstance(receipt['command_id'], str) or not 1 <= len(receipt['command_id']) <= 128
                or any(r['command_id'] == receipt['command_id'] for r in prior)):
            raise ValueError('material history requires an exact original acceptance command')
        _exact_ref(request['work_ref'])
        step = self._step(before, request['step_id'])
        if step['status'] == 'accepted' or step['id'] not in ready_material_steps(old):
            raise ValueError('material history acceptance step was not independently ready')
        ref = _exact_ref(request['review_ref'])
        review = self._read(ref['artifact_id'], ref['revision'])
        self._review(review, step['id'], request['resource'], revision - 1)
        expected = deepcopy(old)
        target = next(s for s in expected['steps'] if s['id'] == step['id'])
        target.update(status='accepted', accepted_resource=request['resource'], review_ref=ref,
                      node_id=request['resource']['node_id'])
        target['candidates'].append({'command_id': receipt['command_id'], 'resource': request['resource'], 'review_ref': ref})
        plan = self._plan(old)
        result = {'work_ref': {'artifact_id': self.current['id'], 'revision': revision},
                  'ready_step_ids': ready_material_steps(expected),
                  'binding_candidates': [{'placement_ids': bindable_placement_ids(plan, r), 'take_ids': r['take_ids'],
                                          'resource': request['resource']}
                                         for r in expected['requirements'] if r['final_step_id'] == step['id']]}
        expected['command_receipts'].append({'command_id': receipt['command_id'], 'request': request, 'result': result})
        expected = MaterialWorkPackageV1.model_validate(expected).model_dump(mode='json', exclude_none=True)
        refs = self.store._reference_list([*before['upstream_refs'], ref], self.store.project_id)
        if not self._same(new, expected) or not self._same(after['upstream_refs'], refs):
            raise ValueError('material history changed beyond native independent acceptance')
        self._transitions.add(revision)

    def _range(self, start, end, step_id):
        key = (start, end, step_id)
        if key in self._ranges:
            return
        original = self._step(self._work(start), step_id)
        for revision in range(start + 1, end + 1):
            self._transition(revision)
            if not self._same(original, self._step(self._work(revision), step_id)):
                raise ValueError('material review target changed after original confirmation')
        self._ranges.add(key)

    def validate(self, review):
        payload = review['payload']
        basis_revision = payload['work_ref']['revision']
        if not 0 <= self.current['revision'] - basis_revision <= 200:
            raise ValueError('material review acceptance history exceeds its bounded proof')
        basis = self._work(basis_revision)
        original = next(step for step in basis['payload']['steps'] if step['id'] == payload['step_id'])
        if original['source'] != 'generate':
            work = self._work(self.current['revision'])
            plan_ref = work['payload']['plan_ref']
            if self._head(plan_ref['artifact_id']) != plan_ref['revision']:
                raise ValueError('historical material review requires its unchanged plan revision')
            self._review(review, payload['step_id'], payload['resource'], self.current['revision'])
            return
        self.validate_target(review)
        if not original.get('execution') or original.get('status') != 'submitted':
            raise ValueError('historical generated material requires its submitted native execution')
        decision = payload.get('user_decision') or {}
        if (payload.get('actor_kind') != 'user' or not payload.get('decision_receipt_id')
                or decision.get('requester_user_id') != self.store.created_by
                or decision.get('canvas_id') != self.canvas_id
                or decision.get('media_hash') != payload['resource']['media_hash']
                or payload['technical']['status'] != 'passed'
                or payload['content']['status'] != 'passed'):
            raise ValueError('historical material review requires its original passed scoped user receipt')

    def validate_target(self, review):
        """Keep an unchanged candidate valid across unrelated execution bookkeeping.

        Every saved revision is checked, so changing and restoring a target cannot
        revive an old approval. Current media and native execution are checked by
        the caller before display or acceptance.
        """
        from .material_review import validate_material_review_lineage
        current = self._work(self.current['revision'])
        payload = review['payload']
        if (not self.canvas_id or review['schema'] != 'material_review.v1'
                or review['created_by'] != self.store.created_by
                or self._head(review['id']) != review['revision']
                or payload['work_ref'].get('artifact_id') != current['id']):
            raise ValueError('material review display requires its scoped current target')
        basis = _exact_ref(payload['work_ref'])
        if basis['revision'] > current['revision']:
            raise ValueError('material review target basis is newer than current work')
        plan_ref = current['payload']['plan_ref']
        if self._head(plan_ref['artifact_id']) != plan_ref['revision']:
            raise ValueError('material review target plan changed')
        validate_material_review_lineage(self, payload, review['upstream_refs'])
        decision = payload.get('user_decision')
        if decision and (decision.get('canvas_id') != self.canvas_id
                         or decision.get('requester_user_id') != self.store.created_by):
            raise ValueError('material review target belongs to another canvas or actor')
        original = next((step for step in self._work(basis['revision'])['payload']['steps']
                         if step['id'] == payload['step_id']), None)
        if (not original or original.get('node_id') != payload['resource']['node_id']
                or original['media_kind'] != payload['resource']['media_kind']):
            raise ValueError('material review target differs from its original resource')
        original_work = self._work(basis['revision'])['payload']
        if original['source'] != 'generate':
            for revision in range(basis['revision'] + 1, current['revision'] + 1):
                self._transition(revision)
                target = next((step for step in self._work(revision)['payload']['steps']
                               if step['id'] == payload['step_id']), None)
                if not self._same(original, target):
                    raise ValueError('material review target changed after original observation')
            return
        protected = {payload['step_id']}
        frontier = list(protected)
        originals = {step['id']: step for step in original_work['steps']}
        while frontier:
            step = originals[frontier.pop()]
            for dependency in set(step.get('depends_on', [])) | {
                    ref['step_id'] for ref in step.get('references', []) if ref.get('step_id')}:
                if dependency not in protected:
                    protected.add(dependency)
                    frontier.append(dependency)
        def identity(step):
            return {key: value for key, value in step.items()
                    if key not in {'status', 'candidates', 'accepted_resource', 'review_ref'}}
        metadata = {key: value for key, value in original_work.items()
                    if key not in {'steps', 'command_receipts'}}
        for revision in range(basis['revision'] + 1, current['revision'] + 1):
            work = self._work(revision)['payload']
            if not self._same(metadata, {key: value for key, value in work.items()
                                        if key not in {'steps', 'command_receipts'}}):
                raise ValueError('material review requirements changed after original observation')
            targets = {step['id']: step for step in work['steps']}
            for step_id in protected:
                target = targets.get(step_id)
                if (not target or target.get('status') in {'stale', 'rejected'}
                        or not self._same(identity(originals[step_id]), identity(target))
                        or (step_id != payload['step_id'] and not self._same(
                            originals[step_id].get('accepted_resource'), target.get('accepted_resource')))):
                    raise ValueError('material review target changed after original observation')


MAX_ACCEPTANCE_SNAPSHOT_BYTES = 128 * 1024 * 1024


class _AcceptanceSnapshot:
    """One host operation's validated immutable reads, never persisted approval."""
    def __init__(self, store):
        self._store = store
        self._artifacts, self._heads, self._digests = {}, {}, {}
        self._bytes = 0
        self.scope = (str(store.project_dir), store.project_id, store.created_by)

    def __getattr__(self, name):
        return getattr(self._store, name)

    def _read_json(self, path):
        import json
        content = self._store._read_bytes(path)
        if path not in self._digests:
            self._bytes += len(content)
            if self._bytes > MAX_ACCEPTANCE_SNAPSHOT_BYTES:
                raise ValueError('material acceptance snapshot exceeds its bounded content proof')
        digest = hashlib.sha256(content).hexdigest()
        if path in self._digests and self._digests[path] != digest:
            raise ValueError('material acceptance snapshot changed during preparation')
        self._digests[path] = digest
        try:
            value = json.loads(content)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError('invalid material acceptance snapshot') from exc
        if not isinstance(value, dict):
            raise ValueError('invalid material acceptance snapshot')
        return value

    def _read(self, artifact_id, revision):
        from .store import RemixArtifactStore
        key = (artifact_id, revision)
        if key not in self._artifacts:
            # Use the same artifact schema/content-hash parser with this operation's
            # byte-capturing reader; never substitute header metadata for proof.
            self._artifacts[key] = RemixArtifactStore._read(self, artifact_id, revision)
        return self._artifacts[key]

    def _latest_revision(self, artifact_id):
        if artifact_id not in self._heads:
            self._heads[artifact_id] = self._store._latest_revision(artifact_id)
        return self._heads[artifact_id]

    def _validate_upstream_refs(self, refs):
        for ref in refs:
            self._read(ref['artifact_id'], ref['revision'])

    def reassert(self, store, guard):
        if self.scope != (str(store.project_dir), store.project_id, store.created_by):
            raise PermissionError('material acceptance snapshot scope or actor changed')
        for identity, revision in self._heads.items():
            if store._latest_revision(identity) != revision:
                raise ValueError('material acceptance current head changed; retry')
        for path, digest in self._digests.items():
            # Required actual content hashes, including historical envelopes and
            # payloads; filenames/mtime cannot certify an unchanged native proof.
            store._directory(path.parent.name)
            if hashlib.sha256(store._read_bytes(path)).hexdigest() != digest:
                raise ValueError('material acceptance snapshot content changed; retry')
        guard.reassert()


class _PreparedMaterialAcceptance:
    def __init__(self, snapshot, request, canvas_id, current, payload, refs, result):
        self._snapshot = snapshot
        self._request = snapshot._canonical(request)
        self._canvas_id = canvas_id
        self._identity = (current['id'], current['schema'], current['revision'], current['created_by'])
        self._payload = snapshot._canonical(payload) if payload is not None else None
        self._refs = snapshot._canonical({'refs': refs})
        self._result = snapshot._canonical(result)


class _AcceptancePublicationGuard:
    def __init__(self, store, prepared, resource, guard):
        self._store, self._prepared, self._resource, self._guard = store, prepared, resource, guard

    def reassert(self):
        self._prepared._snapshot.reassert(self._store, self._guard)
        _check_acceptance_media(self._store, self._resource)
        self._guard.reassert()


def _check_acceptance_media(store, resource):
    path = (store.project_dir / resource['media_path']).resolve()
    if not path.is_relative_to(store.project_dir.resolve()) or not path.is_file():
        raise ValueError('material resource is unavailable in project')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != resource['media_hash']:
        raise ValueError('material content changed')


def prepare_material_acceptance(store, work_ref: dict, step_id: str, resource: dict,
                                review_ref: dict | None, command_id: str, *, canvas_id: str | None = None):
    """Precompute exact native proof outside all caller write locks; host-only result."""
    from .material_review import validate_material_review_lineage
    _exact_ref(work_ref)
    if review_ref is None:
        raise ValueError('material candidate requires review')
    _exact_ref(review_ref)
    resource = ResourceV2.model_validate(resource).model_dump(mode='json', exclude_none=True)
    _check_acceptance_media(store, resource)
    snapshot = _AcceptanceSnapshot(store)
    store = snapshot
    current = store._read(work_ref["artifact_id"], store._latest_revision(work_ref["artifact_id"]))
    if current['schema'] != 'material_work_package.v1' or current['created_by'] != store.created_by:
        raise ValueError('material acceptance snapshot work belongs to another actor or scope')
    request = {"work_ref": work_ref, "step_id": step_id, "resource": resource, "review_ref": review_ref}
    for receipt in current["payload"].get("command_receipts", []):
        if receipt["command_id"] == command_id:
            if receipt["request"] != request:
                raise ValueError("material command_id reused with different inputs")
            return _PreparedMaterialAcceptance(snapshot, {**request, "command_id": command_id}, canvas_id, current, None, [], receipt["result"])
    if current["revision"] != work_ref["revision"]:
        raise ValueError("material work changed; reload current revision")
    work = deepcopy(current["payload"])
    plan = store._read(work["plan_ref"]["artifact_id"], store._latest_revision(work["plan_ref"]["artifact_id"]))
    if _fingerprint(store, plan["payload"], work["requirements"]) != work["input_fingerprint"]:
        raise ValueError("material requirement changed; replan affected work")
    step = next((s for s in work["steps"] if s["id"] == step_id), None)
    if not step or step["media_kind"] != resource["media_kind"]:
        raise ValueError("material step or media kind differs")
    review = store._read(review_ref["artifact_id"], review_ref["revision"])
    if store._latest_revision(review["id"]) != review["revision"] or review["created_by"] != store.created_by:
        raise ValueError("material review requires its authorized current head")
    validate_material_review_lineage(store, review["payload"], review["upstream_refs"])
    if review["schema"] != "material_review.v1" or review["payload"]["resource"] != resource or review["payload"]["step_id"] != step_id:
        raise ValueError("material review does not belong to candidate")
    if review['payload']['work_ref'] != work_ref:
        _IndependentMaterialReviewContinuity(store, current, canvas_id).validate(review)
    if review["payload"]["technical"]["status"] != "passed" or material_content_blocks(review["payload"]):
        raise ValueError("material technical/content review has not passed")
    accepted = {s["id"] for s in work["steps"] if s.get("status") == "accepted"}
    dependencies = set(step.get("depends_on", [])) | {r["step_id"] for r in step.get("references", []) if r.get("step_id")}
    stage = next((set(group) for group in material_stage_groups(work)
                  if not set(group) <= accepted), set())
    if step_id not in stage:
        raise ValueError('previous material stage requires complete acceptance')
    if not dependencies <= accepted or (step_id not in ready_material_steps(work) and step.get("status") not in {"candidate", "submitted"}):
        raise ValueError("material dependencies are not accepted")
    step.update(status="accepted", accepted_resource=resource, review_ref=review_ref, node_id=resource["node_id"])
    step["candidates"].append({"command_id": command_id, "resource": resource, "review_ref": review_ref})
    result = {"work_ref": {"artifact_id": current["id"], "revision": current["revision"] + 1},
              "ready_step_ids": ready_material_steps(work),
              "binding_candidates": [{"placement_ids": bindable_placement_ids(plan["payload"], r), "take_ids": r["take_ids"], "resource": resource}
                                     for r in work["requirements"] if r["final_step_id"] == step_id]}
    work.setdefault("command_receipts", []).append({"command_id": command_id, "request": request, "result": result})
    validated = MaterialWorkPackageV1.model_validate(work).model_dump(mode="json", exclude_none=True)
    refs = store._reference_list([*current["upstream_refs"], review_ref], store.project_id)
    store._validate_upstream_refs(refs)
    validate_material_work_lineage(store, validated, refs)
    return _PreparedMaterialAcceptance(snapshot, {**request, "command_id": command_id}, canvas_id, current, validated, refs, result)


def accept_material_candidate(store, work_ref: dict, step_id: str, resource: dict, review_ref: dict | None, command_id: str,
                              *, canvas_id: str | None = None, _canvas_guard=None, _prepared=None) -> dict:
    import json
    resource = ResourceV2.model_validate(resource).model_dump(mode='json', exclude_none=True)
    if _prepared is None:
        _prepared = prepare_material_acceptance(store, work_ref, step_id, resource, review_ref, command_id,
                                                 canvas_id=canvas_id)
    if not isinstance(_prepared, _PreparedMaterialAcceptance):
        raise ValueError('host material acceptance snapshot required')
    request = {'work_ref': work_ref, 'step_id': step_id, 'resource': resource, 'review_ref': review_ref}
    # The command is retained in result payload/receipt; prevent cross-command reuse.
    request['command_id'] = command_id
    if (_prepared._request != store._canonical(request) or _prepared._canvas_id != canvas_id):
        raise ValueError('material acceptance snapshot request changed')
    with store._locked() as guard:
        from .reference_director import _MaterialPublicationGuard
        publication_guard = _AcceptancePublicationGuard(store, _prepared, resource,
                            _MaterialPublicationGuard(guard, _canvas_guard))
        publication_guard.reassert()
        if _prepared._payload is not None:
            identity, schema, revision, actor = _prepared._identity
            store._publish(artifact_id=identity, schema=schema, revision=revision + 1,
                payload=json.loads(_prepared._payload), upstream_refs=json.loads(_prepared._refs)['refs'],
                created_by=actor, guard=publication_guard)
        return json.loads(_prepared._result)


def invalidate_material_step(work: dict, step_id: str, reason: str) -> dict:
    updated = deepcopy(work)
    affected = {step_id}
    while True:
        next_ids = {s["id"] for s in updated["steps"] if (set(s.get("depends_on", [])) | {r["step_id"] for r in s.get("references", []) if r.get("step_id")}) & affected}
        if next_ids <= affected:
            break
        affected |= next_ids
    for step in updated["steps"]:
        if step["id"] in affected:
            step.update(status="stale", reason=reason)
            step.pop("accepted_resource", None)
            step.pop("review_ref", None)
    return updated


def retry_material_step(store, work_ref: dict, step_id: str, reason: str, command_id: str, *, rejected_review_ref: dict | None = None) -> dict:
    """Record a failed/rejected attempt, preserving independent work and command history."""
    _exact_ref(work_ref)
    if not isinstance(reason,str) or not reason.strip() or len(reason)>4000 or not isinstance(command_id,str) or not 1<=len(command_id)<=128:
        raise ValueError('material retry requires bounded reason and command_id')
    request = {'kind':'retry','work_ref':work_ref,'step_id':step_id,'reason':reason,'rejected_review_ref':rejected_review_ref}
    with store._locked() as guard:
        current = store._read(work_ref['artifact_id'],store._latest_revision(work_ref['artifact_id']))
        if current['schema'] != 'material_work_package.v1':
            raise ValueError('material work package required')
        for receipt in current['payload'].get('command_receipts',[]):
            if receipt['command_id'] == command_id:
                if receipt['request'] != request:
                    raise ValueError('material command_id reused with different inputs')
                return receipt['result']
        if current['revision'] != work_ref['revision']:
            raise ValueError('material work changed; reload current revision')
        if not any(s['id'] == step_id for s in current['payload']['steps']):
            raise ValueError('unknown material step')
        review = None
        if rejected_review_ref is not None:
            _exact_ref(rejected_review_ref)
            review = store._read(rejected_review_ref['artifact_id'],rejected_review_ref['revision'])
            if (review['schema'] != 'material_review.v1' or review['payload']['work_ref'] != work_ref
                    or review['payload']['step_id'] != step_id or review['payload']['content']['status'] != 'rejected'):
                raise ValueError('rejected review does not belong to material attempt')
        updated = invalidate_material_step(current['payload'],step_id,reason)
        affected = {step_id}
        for _ in updated['steps']:
            affected |= {row['id'] for row in updated['steps']
                         if (set(row.get('depends_on', [])) | {r['step_id'] for r in row.get('references', []) if r.get('step_id')}) & affected}
        for before, after in zip(current['payload']['steps'],updated['steps']):
            if after['id'] in affected:
                history = {key:deepcopy(before[key]) for key in ('accepted_resource','review_ref','execution','task_id','node_id') if before.get(key)}
                if history:
                    after['candidates'].append({'attempt_history':history,'reason':reason,'command_id':command_id})
                after.pop('execution',None)
                after.pop('task_id',None)
                # The producing node stays put so a retry regenerates the same
                # canvas node and keeps its plan ownership; only the produced
                # material and its review evidence are invalidated.
        target = next(s for s in updated['steps'] if s['id'] == step_id)
        target['status'] = 'rejected'
        if review is not None:
            target['candidates'].append({'resource':review['payload']['resource'],'review_ref':rejected_review_ref,
                                         'command_id':command_id,'status':'rejected'})
        public_work = {key:deepcopy(value) for key,value in updated.items() if key != 'command_receipts'}
        result = {'work_ref':{'artifact_id':current['id'],'revision':current['revision']+1},
                  'ready_step_ids':ready_material_steps(updated),'work':public_work}
        updated.setdefault('command_receipts',[]).append({'command_id':command_id,'request':request,'result':result})
        validated = MaterialWorkPackageV1.model_validate(updated).model_dump(mode='json',exclude_none=True)
        validate_material_work_lineage(store,validated,current['upstream_refs'])
        store._publish(artifact_id=current['id'],schema=current['schema'],revision=current['revision']+1,
                       payload=validated,upstream_refs=current['upstream_refs'],created_by=current['created_by'],guard=guard)
        return result


class MaterialStrategyConflict(ValueError):
    code = 'artifact_revision_conflict'

    def __init__(self, latest_ref: dict, changed_step_ids: list[str]):
        super().__init__('material work changed; read latest revision and merge the intended edits')
        self.latest_ref = latest_ref
        self.changed_step_ids = changed_step_ids


_STRATEGY_FIELDS = ('id', 'label', 'media_kind', 'source', 'recipe_id', 'prompt',
                    'dialogue_turn_ids', 'node_id', 'depends_on', 'references', 'generation_inputs')
_SERVER_STEP_FIELDS = {'status', 'candidates', 'accepted_resource', 'review_ref',
                       'execution', 'task_id', 'reason'}


def _step_strategy(step: dict) -> dict:
    return {key: step.get(key) for key in _STRATEGY_FIELDS}


def _material_descendants(steps: list[dict], roots: set[str]) -> set[str]:
    affected = set(roots)
    while True:
        expanded = affected | {step['id'] for step in steps if
            (set(step.get('depends_on', [])) |
             {ref['step_id'] for ref in step.get('references', []) if ref.get('step_id')}) & affected}
        if expanded == affected:
            return affected
        affected = expanded


def revise_material_strategy(store, work_ref: dict, replacements: list[dict], command_id: str, *, canvas: dict) -> dict:
    """Atomically replace complete step strategies at an exact work revision."""
    _exact_ref(work_ref)
    if not isinstance(command_id, str) or not 1 <= len(command_id) <= 128:
        raise ValueError('material strategy requires a bounded command_id')
    if not isinstance(replacements, list) or not replacements:
        raise ValueError('material strategy requires replacements')
    if not isinstance(canvas, dict):
        raise ValueError('material strategy requires an authorized current canvas')
    normalized = []
    for replacement in replacements:
        if not isinstance(replacement, dict):
            raise ValueError('material strategy requires object replacements')
        rejected = sorted(_SERVER_STEP_FIELDS & replacement.keys())
        if rejected:
            # The Agent usually copies a saved step verbatim, so the message must
            # name the fields it has to drop instead of failing opaquely.
            raise ValueError(
                'material strategy cannot set execution or review state; remove '
                + ', '.join(rejected)
            )
        if replacement.get('source') in {'generate', 'upload'} and replacement.get('node_id'):
            raise ValueError('generated or awaiting upload strategy cannot claim a canvas output node')
        normalized.append(MaterialStep.model_validate(replacement).model_dump(mode='json', exclude_none=True))
    ids = [step['id'] for step in normalized]
    if len(set(ids)) != len(ids):
        raise ValueError('material strategy step IDs must be unique')
    request = {'kind': 'revise_strategy', 'work_ref': deepcopy(work_ref), 'replacements': deepcopy(normalized)}
    with store._locked() as guard:
        current = store._read(work_ref['artifact_id'], store._latest_revision(work_ref['artifact_id']))
        if current['schema'] != 'material_work_package.v1':
            raise ValueError('material work package required')
        for receipt in current['payload'].get('command_receipts', []):
            if receipt['command_id'] == command_id:
                if receipt['request'] != request:
                    raise ValueError('material command_id reused with different inputs')
                return receipt['result']
        if current['revision'] != work_ref['revision']:
            previous = store._read(work_ref['artifact_id'], work_ref['revision'])
            previous_steps = {step['id']: step for step in previous['payload']['steps']}
            changed = [step['id'] for step in current['payload']['steps'] if
                _step_strategy(step) != _step_strategy(previous_steps.get(step['id'], {}))]
            raise MaterialStrategyConflict({'artifact_id': current['id'], 'revision': current['revision']}, changed)
        original = {step['id']: step for step in current['payload']['steps']}
        unknown_ids = sorted(step_id for step_id in ids if step_id not in original)
        if unknown_ids:
            # A revision only replaces existing steps; the caller cannot invent
            # new ones, so it must learn which ids actually exist.
            raise ValueError(
                'unknown material step: ' + ', '.join(unknown_ids)
                + '; existing steps: ' + ', '.join(sorted(original))
            )
        # Validate every supplied source before publishing any replacement.
        from .material_execution import canvas_material_resource
        for step in normalized:
            if step['source'] == 'existing':
                node_id = step.get('node_id')
                if not node_id:
                    raise ValueError('existing material requires a current canvas node')
                canvas_material_resource(store, canvas, node_id, step['media_kind'])
            elif step['source'] == 'upload' and step.get('node_id'):
                raise ValueError('upload strategy cannot claim an existing canvas node')
        updated = deepcopy(current['payload'])
        by_id = {step['id']: step for step in normalized}
        changed = {step_id for step_id in ids if _step_strategy(by_id[step_id]) != _step_strategy(original[step_id])}
        if not changed:
            raise ValueError('material strategy contains no changes')
        tentative = [by_id.get(step['id'], step) for step in updated['steps']]
        affected = _material_descendants(updated['steps'], changed) | _material_descendants(tentative, changed)
        for index, before in enumerate(updated['steps']):
            step_id = before['id']
            if step_id not in affected:
                continue
            target = deepcopy(by_id[step_id]) if step_id in changed else deepcopy(before)
            history = {key: deepcopy(before[key]) for key in ('accepted_resource', 'review_ref',
                       'execution', 'task_id', 'node_id') if before.get(key)}
            if step_id in changed:
                target['candidates'] = deepcopy(before.get('candidates', []))
            if history:
                target.setdefault('candidates', []).append({'attempt_history': history,
                    'reason': 'strategy_revised', 'command_id': command_id})
            for key in ('accepted_resource', 'review_ref', 'execution', 'task_id'):
                target.pop(key, None)
            if step_id not in changed:
                target['status'] = 'stale'
                if target['source'] == 'generate':
                    target.pop('node_id', None)
            else:
                target['status'] = 'awaiting_upload' if target['source'] == 'upload' else 'planned'
            target['reason'] = 'strategy_revised'
            updated['steps'][index] = target
        validated = MaterialWorkPackageV1.model_validate(updated).model_dump(mode='json', exclude_none=True)
        _validate_preservation_bindings(store, validated, canvas)
        _validate_reference_media(store, validated, canvas, step_ids=changed)
        # Ready steps are the only ones the native compiler can run now. Its
        # media-type guard also rejects unsupported future direct references.
        material_workflow_intent(validated, canvas=canvas, store=store)
        validate_material_work_lineage(store, validated, current['upstream_refs'])
        result = {'work_ref': {'artifact_id': current['id'], 'revision': current['revision'] + 1},
                  'changed_step_ids': [step['id'] for step in updated['steps'] if step['id'] in changed],
                  'affected_step_ids': [step['id'] for step in updated['steps'] if step['id'] in affected],
                  'ready_step_ids': ready_material_steps(validated),
                  'work': {key: deepcopy(value) for key, value in validated.items() if key != 'command_receipts'}}
        validated.setdefault('command_receipts', []).append({'command_id': command_id, 'request': request, 'result': result})
        validated = MaterialWorkPackageV1.model_validate(validated).model_dump(mode='json', exclude_none=True)
        store._publish(artifact_id=current['id'], schema=current['schema'], revision=current['revision'] + 1,
                       payload=validated, upstream_refs=current['upstream_refs'],
                       created_by=current['created_by'], guard=guard)
        return result


def material_binding_commands(store, work: dict, plan: dict) -> list[dict]:
    """Build one native batch from saved final ownership and real accepted media."""
    validate_final_material_bindings(work['payload']['requirements'])
    if _fingerprint(store, plan, work['payload']['requirements']) != work['payload']['input_fingerprint']:
        raise ValueError('material requirements changed; preserve current plan edits')
    steps = {s['id']: s for s in work['payload']['steps']}
    placements = {p['id']: p for p in plan.get('placements', [])}
    takes = {t['id']: t for t in plan.get('speech_takes', [])}
    original = store.read(work['payload']['plan_ref']['artifact_id'], work['payload']['plan_ref']['revision'])['payload']
    old_placements = {p['id']: p for p in original.get('placements', [])}
    resources = {r['id']: r for r in plan.get('resources', [])}
    commands, targets = [], {}
    for requirement in work['payload']['requirements']:
        step = steps[requirement['final_step_id']]
        if step['status'] != 'accepted':
            raise ValueError('final material is not accepted')
        resource = step['accepted_resource']
        ref = step['review_ref']
        review = store.read_latest(ref['artifact_id'])
        if (review['revision'] != ref['revision'] or review['created_by'] != store.created_by
                or review['schema'] != 'material_review.v1'
                or review['payload']['work_ref']['artifact_id'] != work['id']
                or review['payload']['step_id'] != step['id']
                or review['payload']['resource'] != resource
                or review['payload']['technical']['status'] != 'passed'
                or material_content_blocks(review['payload'])):
            raise ValueError('final material review is no longer current and passed')
        from .material_review import validate_material_review_lineage
        validate_material_review_lineage(store, review['payload'], review['upstream_refs'])
        target_ids = bindable_placement_ids(plan, requirement)
        for take_id in requirement['take_ids']:
            take = takes.get(take_id)
            if not take or not take.get('origin_placement_id'):
                raise ValueError('saved take has no native origin placement')
            target_ids.append(take['origin_placement_id'])
        for target_id in dict.fromkeys(target_ids):
            if target_id not in placements:
                raise ValueError('saved final placement is missing')
            target = placements[target_id]
            if target_id in targets and targets[target_id] != resource:
                raise ValueError('final material bindings conflict through take origin')
            targets[target_id] = resource
            if target.get('resource_id') == resource['id']:
                if resources.get(resource['id']) != resource:
                    raise ValueError('current registered resource differs from accepted media')
                continue
            if target.get('resource_id') != old_placements.get(target_id, {}).get('resource_id'):
                raise ValueError('final target was edited; preserve current user binding')
            if resource['id'] in resources and resources[resource['id']] != resource:
                raise ValueError('registered resource identity conflicts with accepted media')
            payload = {'resource_id': resource['id']}
            if resource['id'] not in resources:
                payload['resource'] = resource
                resources[resource['id']] = resource
            if not any(c['target_id'] == target_id for c in commands):
                commands.append({'kind': 'bind_media', 'target_id': target_id, 'payload': payload})
    if len(commands) > 100:
        raise ValueError('final material binding exceeds native batch limit')
    return commands


def bind_accepted_materials(store, work_ref: dict, plan_ref: dict, command_id: str) -> dict:
    """Apply native final bindings and rebase only their measured take inputs.

    Canvas hosts retain their publication mutex/guard while invoking this helper.
    Existing review artifacts and user decision receipts stay unchanged.
    """
    from .production_commands import apply_production_commands
    work_ref, plan_ref = _exact_ref(work_ref), _exact_ref(plan_ref)
    current = store.read_latest(work_ref['artifact_id'])
    request = {'kind': 'bind_materials', 'work_ref': work_ref, 'plan_ref': plan_ref}
    for receipt in current['payload'].get('command_receipts', []):
        if receipt['command_id'] == command_id:
            if receipt['request'] != request:
                raise ValueError('material binding command reused with different inputs')
            return receipt['result']
    if current['revision'] != work_ref['revision']:
        raise ValueError('material work changed before final binding')
    plan = store.read(plan_ref['artifact_id'], plan_ref['revision'])
    commands = material_binding_commands(store, current, plan['payload'])
    bound = apply_production_commands(store, plan_ref, commands, command_id)
    bound_plan = store.read(bound['plan_ref']['artifact_id'], bound['plan_ref']['revision'])
    fingerprint = _fingerprint(store, bound_plan['payload'], current['payload']['requirements'])
    result = {**bound, 'work_ref': work_ref}
    if fingerprint == current['payload']['input_fingerprint']:
        return result
    payload = deepcopy(current['payload'])
    payload['plan_ref'] = bound['plan_ref']
    payload['input_fingerprint'] = fingerprint
    result['work_ref'] = {'artifact_id': current['id'], 'revision': current['revision'] + 1}
    payload.setdefault('command_receipts', []).append({'command_id': command_id, 'request': request, 'result': result})
    refs = store._reference_list([*current['upstream_refs'], bound['plan_ref']], store.project_id)
    store.revise(current['id'], current['revision'], payload, refs)
    return result
