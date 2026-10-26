"""Project-bound rendering of immutable remix composition artifacts."""
from __future__ import annotations

import asyncio
import re
import hashlib
import json
import subprocess
import time
from copy import copy
from pathlib import Path
from typing import Any

from novelvideo.freezone.remix.render import render_manifest, validate_manifest
from novelvideo.freezone.remix.alignment import align_script, transcribe_media
from novelvideo.freezone.remix.evidence import build_reference_evidence
from novelvideo.freezone.remix.broll_plan import generate_broll_plan
from novelvideo.freezone.remix.script_draft import generate_script_draft
from novelvideo.freezone.remix.production_plan import (
    generate_production_plan_draft, generate_production_plan_arrangement,
)
from novelvideo.freezone.remix.production_plan_failures import build_plan_failure_summary
from novelvideo.freezone.remix.production_plan_v2 import (
    ProductionPlanV2, compile_production_plan_v2,
    production_speech_source, project_production_plan_v2,
)
from novelvideo.freezone.remix.contracts import reference_blueprint_readiness_errors
from novelvideo.freezone.remix.timing import compile_timing
from novelvideo.freezone.remix.take_timing import compile_take_timing, spoken_text_for_segment
from novelvideo.freezone.remix.store import RemixArtifactStore
from novelvideo.freezone.remix.production_store import production_store
from novelvideo.freezone.remix.operations import RemixOperationStore
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.cancel import (
    await_envelope_with_cancel_watch, raise_if_envelope_cancel_requested,
)
from novelvideo.llm_instrumentation import (
    log_production_plan_diagnostic,
    production_plan_diagnostic_context,
    production_plan_diagnostic_sink,
)


_JOB_ID = re.compile(r"[a-f0-9]{64}\Z")


def _project_media_path(project_dir: Path, relative: object) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError("remix processing requires a project-relative media path")
    root = project_dir.resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise FileNotFoundError("remix processing media is unavailable")
    return candidate


def _publish_operation_result(payload: dict[str, Any], ctx: ProjectContext, output_ref: dict[str, Any]) -> None:
    operation_id = payload.get("operation_id")
    if operation_id:
        RemixOperationStore(Path(ctx.output_dir), ctx.project_id).publish_result_unverified(
            str(operation_id), output_refs=[output_ref]
        )


def _verified_project_media_path(project_dir: Path, payload: dict[str, Any]) -> Path:
    path = _project_media_path(project_dir, payload.get("media_path"))
    expected = payload.get("media_sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("remix media content hash is required")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1_048_576), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError("remix media changed since submission")
    return path


def run_remix_transcribe_media(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Publish a normalized transcript from a server-confirmed project media path."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    media_path = _verified_project_media_path(project_dir, payload)
    language = payload.get("language")
    if not isinstance(language, str) or not language:
        raise ValueError("remix transcription language is required")
    timeline = transcribe_media(media_path, language, allow_segments=True)
    artifact = RemixArtifactStore(project_dir, ctx.project_id).create(
        schema="word_timeline.v1", payload=timeline, upstream_refs=[]
    )
    _publish_operation_result(payload, ctx, {"artifact_id": artifact["id"], "revision": artifact["revision"]})
    return {"status": "completed", "artifact_ref": {"artifact_id": artifact["id"], "revision": artifact["revision"]}}


def run_remix_analyze_material_speech(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Recognize an authorized current candidate without accepting or binding it."""
    from novelvideo.freezone import canvas_store
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    from novelvideo.freezone.remix.source_speech import (
        PRODUCER, SourceSpeechPending, observe_source_speech, prepare_material_speech, configured_provider_signature,
    )
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    operation_id = payload.get("operation_id")
    task_id = str(envelope.get("__run_task_id") or "")
    if not operation_id or not task_id:
        raise ValueError("candidate speech requires a bound native task operation")
    operations = RemixOperationStore(Path(ctx.output_dir), ctx.project_id)
    operation = operations.get(operation_id)
    if (operation.get("task_id") and operation["task_id"] != task_id) or operation.get("producer_version") != PRODUCER:
        raise ValueError("candidate speech operation belongs to another task")
    if operation["status"] in {"cancelled", "cancelling", "stale", "failed"} or operation.get("cancel_reason"):
        raise ValueError("candidate speech operation is no longer active")
    store = RemixArtifactStore(Path(ctx.output_dir), ctx.project_id, created_by=ctx.requester_user_id)
    canvas = canvas_store.read_canvas(Path(ctx.state_dir), payload.get("canvas_id", ""))
    if not isinstance(canvas, dict):
        raise ValueError("candidate canvas unavailable")
    current = prepare_material_speech(store, ctx, canvas,
        canvas_id=payload.get("canvas_id"), work_ref=payload.get("work_ref"),
        step_id=payload.get("step_id"), node_id=payload.get("node_id"),
        language=payload.get("language"), provider_signature=configured_provider_signature())
    expected = current["task_payload"]
    if any(payload.get(key) != value for key, value in expected.items()):
        raise ValueError("candidate speech source or authorization changed since submission")
    if (operation["normalized_parameters"] != current["normalized_parameters"] or
        operation["input_refs"] != [{**expected["work_ref"], "project_id": ctx.project_id}]):
        raise ValueError("candidate operation input ownership differs")
    if not operation.get("task_id"):
        # A verified delivery can arrive before enqueue returns to the API.
        # Finish its existing fenced claim using the actual admitted task id;
        # the submitter's later identical bind remains idempotent.
        operation = operations.bind_task(operation_id, task_id=task_id,
            owner=operation.get("submission_owner", ""),
            fencing_token=operation.get("submission_fence", 0))
    ref = observe_source_speech(store, scope=expected["scope"], resource=expected["resource"],
        language=expected["language"], provider_signature=expected["provider_signature"])
    # The immutable observation remains valid if the candidate subsequently
    # changes, but cannot become evidence for that changed binding.
    latest_canvas = canvas_store.read_canvas(Path(ctx.state_dir), expected["canvas_id"])
    latest = prepare_material_speech(store, ctx, latest_canvas,
        canvas_id=expected["canvas_id"], work_ref=expected["work_ref"], step_id=expected["step_id"],
        node_id=expected["node_id"], language=expected["language"],
        provider_signature=configured_provider_signature())
    if latest["task_payload"] != expected:
        raise ValueError("candidate changed during recognition")
    try:
        _publish_operation_result(payload, ctx, ref)
    except (OSError, CanvasLockBusy) as exc:
        raise SourceSpeechPending('durable source operation publication requires reconciliation') from exc
    return {"status": "completed", "artifact_ref": ref}


def _run_remix_adopt_source_speech(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Adopt measured source timing after revalidating its native operation."""
    from novelvideo.freezone import canvas_store
    from novelvideo.freezone.remix.source_speech import candidate_scope
    from novelvideo.freezone.remix.source_speech_adoption import (
        PRODUCER, prepare_source_observation_adoption, adopt_source_observation, read_source_adoption_result,
    )
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    operation_id, task_id = payload.get("operation_id"), str(envelope.get("__run_task_id") or "")
    if not operation_id or not task_id:
        raise ValueError("source adoption requires a bound native task operation")
    operations = RemixOperationStore(Path(ctx.output_dir), ctx.project_id)

    def active(*, snapshot=False):
        # Atomic operation JSON is safe to read without acquiring its mutex.
        # Result publication holds operation -> artifact locks, so artifact
        # publication guards must never acquire them in the opposite order.
        operation = operations._read(operation_id) if snapshot else operations.get(operation_id)
        if snapshot:
            from novelvideo.freezone.remix.production_automation import assert_operation_automation_current
            assert_operation_automation_current(ctx, operation_id)
        if (operation.get("task_id") and operation["task_id"] != task_id) or operation.get("producer_version") != PRODUCER:
            raise ValueError("source adoption operation belongs to another task")
        if operation["status"] in {"cancelled", "cancelling", "stale", "failed"} or operation.get("cancel_reason"):
            raise ValueError("source adoption operation is no longer active")
        return operation

    operation = active()
    store = RemixArtifactStore(Path(ctx.output_dir), ctx.project_id, created_by=ctx.requester_user_id)
    canvas_id = payload.get("canvas_id", "")
    with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as canvas_guard:
        canvas = canvas_store.read_canvas(Path(ctx.state_dir), canvas_id)
        scope = candidate_scope(ctx, canvas, canvas_id)
        expected = {key: payload[key] for key in ("canvas_id", "plan_ref", "take_id", "observation_ref", "work_ref", "scope", "requester_user_id")}
        if payload.get("correction_ref"):
            expected["correction_ref"] = payload["correction_ref"]
        refs = [expected["plan_ref"], expected["observation_ref"], expected["work_ref"]] + ([expected["correction_ref"]] if expected.get("correction_ref") else [])
        if (scope != expected["scope"] or ctx.requester_user_id != expected["requester_user_id"]
                or operation["normalized_parameters"] != {"action": "adopt_source_observation", "payload": expected}
                or operation["input_refs"] != [{**r, "project_id": ctx.project_id} for r in refs]):
            raise ValueError("source adoption input ownership changed")
        request = {key: expected.get(key) for key in ("plan_ref", "take_id", "observation_ref", "work_ref", "scope", "requester_user_id", "correction_ref")}
        result = read_source_adoption_result(store, scope=scope, requester_user_id=ctx.requester_user_id,
            command_id=operation_id, request=request)
        if result is None:
            prepare_source_observation_adoption(store, ctx, canvas, canvas_id=canvas_id,
                plan_ref=payload.get("plan_ref"), take_id=payload.get("take_id"),
                observation_ref=payload.get("observation_ref"), work_ref=payload.get("work_ref"),
                correction_ref=payload.get("correction_ref"))
            if not operation.get("task_id"):
                operations.bind_task(operation_id, task_id=task_id, owner=operation.get("submission_owner", ""),
                    fencing_token=operation.get("submission_fence", 0))

            class PublicationGuard:
                def reassert(self):
                    canvas_guard.reassert()
                    active(snapshot=True)

            result = adopt_source_observation(store, plan_ref=payload["plan_ref"], take_id=payload["take_id"],
                observation_ref=payload["observation_ref"], work_ref=payload["work_ref"], scope=scope,
                requester_user_id=ctx.requester_user_id, correction_ref=payload.get("correction_ref"),
                command_id=operation_id, _canvas_guard=PublicationGuard())
        latest_operation = active()
        output_refs = [result["plan_ref"], *result["timeline_refs"]]
        if latest_operation['status'] in {'completed', 'confirming', 'needs_confirmation'}:
            if latest_operation['output_refs'] != output_refs:
                raise ValueError('source adoption replay output ownership changed')
        else:
            operations.publish_result_unverified(operation_id, output_refs=output_refs)
    return {"status": "completed", "artifact_ref": result["plan_ref"], **result}



def run_remix_adopt_source_speech(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    from novelvideo.freezone.remix.source_speech_adoption import SourceAdoptionPending
    try:
        return _run_remix_adopt_source_speech(envelope, ctx)
    except (OSError, CanvasLockBusy) as exc:
        raise SourceAdoptionPending('durable source adoption requires reconciliation') from exc


def run_remix_analyze_reference_video(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Publish timestamped evidence for the entire uploaded reference video."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    media_path = _verified_project_media_path(project_dir, payload)
    evidence = build_reference_evidence(media_path)
    artifact = RemixArtifactStore(project_dir, ctx.project_id).create(
        schema="reference_evidence.v1", payload=evidence, upstream_refs=[]
    )
    ref = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
    _publish_operation_result(payload, ctx, ref)
    return {"status": "completed", "artifact_ref": ref}



def run_remix_joint_reference_analysis(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Probe, recognize and jointly inspect one immutable project video source."""
    from novelvideo.freezone.remix import reference_analysis_service as service
    payload = envelope.get("payload") or {}
    root = Path(ctx.output_dir).resolve()
    path = _verified_project_media_path(root, payload)
    store = production_store(ctx)
    transcript_ref = (service.validated_transcript_ref(ctx, payload['transcript_ref'], payload['media_sha256'])
                      if payload.get('transcript_ref') is not None else None)
    no_speech_ref = (service.validated_no_speech_ref(ctx, payload['no_speech_ref'], payload['media_sha256'])
                     if payload.get('no_speech_ref') is not None else None)
    if transcript_ref and no_speech_ref:
        raise ValueError('reference source has conflicting speech observations')
    evidence = build_reference_evidence(path)
    saved = store.create("reference_evidence.v1", evidence, [])
    evidence_ref = {"artifact_id": saved["id"], "revision": saved["revision"]}
    limitations = []
    if transcript_ref:
        transcript_status = "completed"
    elif no_speech_ref:
        transcript_status = "no_speech"
        transcript_ref = no_speech_ref
    elif service.probe_audio_track(path) is False:
        transcript_status = "no_audio"
    else:
        try:
            timeline = transcribe_media(path, "auto")
            transcript_status = timeline["status"]
            saved_transcript = store.create("word_timeline.v1", timeline, [])
            transcript_ref = {"artifact_id": saved_transcript["id"], "revision": saved_transcript["revision"]}
        except Exception:
            transcript_status = "failed"
            limitations.append("Speech recognition failed; dialogue and word timing are unavailable.")
    story_payload = {**payload, "video_path": str(path), "project_dir": str(root),
                     "job_id": payload.get("job_id") or payload.get("operation_id") or payload["media_sha256"],
                     "duration_sec": evidence["duration_us"] / 1_000_000,
                     "evidence_ref": evidence_ref,
                     "transcript_ref": transcript_ref if transcript_status == "completed" else None}
    # Keep the verified envelope type and identity when deriving story inputs.
    # Dict unpacking downgrades TrustedRunnerEnvelope and the leaf gate rejects
    # its retained trusted context. A copy also leaves the outer task unchanged.
    story_envelope = copy(envelope)
    story_envelope["payload"] = story_payload
    story = asyncio.run(service.analyze_story(story_envelope, ctx))
    content_filtered = bool(story.get("content_filtered"))
    if content_filtered:
        limitations.append(
            "上游内容审核(content_filter)拦截了视觉解析，镜头/节奏/动作/视觉风格未自动完成，需人工确认或补充。")
    coverage = {"visual_inspection": "content_filtered" if content_filtered else "sampled_frames",
                "frame_times_us": story.get("frame_times_us", []),
                "decoded_frame_count": evidence.get("frame_count"), "duration_us": evidence["duration_us"],
                "scene_detection": "full_source", "speech_recognition": "reused_transcript" if payload.get("transcript_ref") else "reused_no_speech" if no_speech_ref else "skipped_no_audio" if transcript_status == "no_audio" else "failed" if transcript_status == "failed" else "full_source"}
    unknowns = ["Cross-shot visual consistency has not been separately verified.",
                "Entrance, hold and exit intervals beyond sampled frames are unknown.",
                "Music/effect roles and semantic triggers require targeted inspection."]
    blueprint_events = []
    for index, event in enumerate(story.get("reference_events", [])):
        observed = event.get("observed_frame")
        if not isinstance(observed, dict):
            limitations.append(f"Visual event {index + 1} has no observed frame.")
            continue
        spoken = event.get("spoken_range")
        blueprint_events.append({
            "event_id": f"event-{index + 1}", "start_us": event["start_us"], "end_us": event["end_us"],
            "observed_frame": {**observed, "evidence_ref": evidence_ref},
            "spoken_range": {**spoken, "transcript_ref": transcript_ref} if isinstance(spoken, dict) and transcript_status == "completed" else None,
            "model": {"visual_observation": event.get("visual_observation", ""),
                      "visible_text": event.get("visible_text", ""), "narrative_inference": event.get("narrative_inference", "")},
            "user_override": {"narrative_role": event.get("narrative_inference") or "Reference event", "review_state": "needs_review"},
        })
    blueprint = store.create("reference_blueprint.v1", {
        "narrative_role": str((story.get("video_story") or {}).get("summary") or "Reference visual structure"),
        "events": blueprint_events, "preserve_replace_rules": [],
        "observations": story.get("analyses", []), "inferences": [], "user_choices": [],
        "evidence_ref": evidence_ref, "transcript_ref": transcript_ref if transcript_status == "completed" else None,
        "coverage": coverage, "unknowns": unknowns,
    }, [evidence_ref, *([transcript_ref] if transcript_status == "completed" and transcript_ref else [])])
    blueprint_ref = {"artifact_id": blueprint["id"], "revision": blueprint["revision"]}
    receipt = {"media_path": payload["media_path"], "media_hash": evidence["media_hash"],
               "evidence_ref": evidence_ref, "transcript_ref": transcript_ref, "blueprint_ref": blueprint_ref,
               "transcript_status": transcript_status, "story": story,
               "coverage": coverage, "limitations": limitations,
               "content_filtered": content_filtered,
               "visual_system": {"status": "content_filtered" if content_filtered else "unknown", "entrance_hold_exit": "unknown"},
               "sound_roles": [], "semantic_triggers": [], "unknowns": unknowns}
    refs = [evidence_ref, blueprint_ref, *([transcript_ref] if transcript_ref else [])]
    saved_receipt = store.create("reference_analysis.v1", receipt, refs)
    analysis_ref = {"artifact_id": saved_receipt["id"], "revision": saved_receipt["revision"]}
    _publish_operation_result(payload, ctx, analysis_ref)
    return {**story, "status": "completed", "analysis_ref": analysis_ref, "artifact_ref": analysis_ref,
            "evidence_ref": evidence_ref, "transcript_ref": transcript_ref, "blueprint_ref": blueprint_ref,
            "transcript_status": transcript_status, "limitations": limitations, "coverage": coverage,
            "content_filtered": content_filtered}

def run_remix_plan_broll(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Publish B-roll decisions for one exact immutable remix script revision."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    ref = payload.get("script_ref") if isinstance(payload.get("script_ref"), dict) else {}
    artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
    if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
        raise ValueError("B-roll planning script reference is incomplete")
    store = RemixArtifactStore(Path(ctx.output_dir).resolve(), ctx.project_id)
    script = store.read(artifact_id, revision)
    if script["schema"] != "remix_script.v1":
        raise ValueError("B-roll planning requires a remix script")
    planned = asyncio.run(
        generate_broll_plan(
            script=script["payload"],
            username=ctx.requester_username,
        )
    )
    artifact = store.create(
        "remix_script.v1",
        planned,
        [{"artifact_id": artifact_id, "revision": revision}],
    )
    output = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
    _publish_operation_result(payload, ctx, output)
    return {"status": "completed", "artifact_ref": output}


def run_remix_generate_script_draft(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Generate an editable script draft from one exact saved blueprint revision."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    ref = payload.get("blueprint_ref") if isinstance(payload.get("blueprint_ref"), dict) else {}
    artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
    topic = payload.get("new_topic")
    if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
        raise ValueError("script generation blueprint reference is incomplete")
    if not isinstance(topic, str) or not topic.strip() or len(topic) > 2_000:
        raise ValueError("script generation topic is invalid")
    store = RemixArtifactStore(Path(ctx.output_dir).resolve(), ctx.project_id)
    blueprint = store.read(artifact_id, revision)
    if blueprint["schema"] != "reference_blueprint.v1":
        raise ValueError("script generation requires a reference blueprint")
    readiness_errors = reference_blueprint_readiness_errors(
        blueprint["payload"], blueprint.get("upstream_refs", [])
    )
    if readiness_errors:
        raise ValueError("blueprint is not script-ready: " + "; ".join(readiness_errors))
    draft = asyncio.run(generate_script_draft(
        blueprint=blueprint["payload"],
        topic=topic.strip(),
        username=ctx.requester_username,
    ))
    artifact = store.create(
        "remix_script.v1",
        {
            "dialogue": draft["dialogue"],
            "segments": draft.get("segments", []),
            "selections": draft["selections"],
            "blueprint_mappings": [],
            "media_requirements": [],
        },
        [{"artifact_id": artifact_id, "revision": revision}],
    )
    output = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
    _publish_operation_result(payload, ctx, output)
    return {"status": "completed", "artifact_ref": output}


def run_remix_generate_production_plan_draft(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Generate and save only structure and dialogue."""
    return _run_production_plan_stage(envelope, ctx, arrangement=False)


def run_remix_generate_production_plan_arrangement(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Arrange media against a saved revision in its own explicitly submitted task."""
    return _run_production_plan_stage(envelope, ctx, arrangement=True)


def _run_production_plan_stage(envelope: dict[str, Any], ctx: ProjectContext, *, arrangement: bool) -> dict[str, Any]:
    action = "generate_production_plan_arrangement" if arrangement else "generate_production_plan_draft"
    stage = "arrangement" if arrangement else "full"
    envelope = {**envelope, "__plan_task_type": f"remix_{action}", "__plan_authoring_stage": stage}
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    store = production_store(ctx)
    operation_id = payload.get("operation_id")
    operation = None
    if operation_id:
        operation = RemixOperationStore(Path(ctx.output_dir), ctx.project_id).get(operation_id)
    from novelvideo.freezone.remix.production_task_inputs import restore_production_plan_inputs

    payload = restore_production_plan_inputs(store, payload, operation, action=action)
    base_plan = None
    source_payload = payload
    refs: list[dict[str, Any]] = []
    if arrangement:
        from novelvideo.freezone.remix.production_task_inputs import read_arrangement_plan
        base_plan = read_arrangement_plan(store, payload.get("plan_ref"))
        plan = base_plan["payload"]
        provenance = plan.get("provenance") or {}
        source_payload = dict(provenance)
        original_operation_id = provenance.get("operation_id")
        if original_operation_id:
            original = RemixOperationStore(Path(ctx.output_dir), ctx.project_id).get(original_operation_id)
            source_payload = {**(original.get("normalized_parameters") or {}).get("payload", {}), **source_payload}
        topic = plan["goal"]
        refs = base_plan["upstream_refs"]
    else:
        topic = payload.get("topic")
    if not isinstance(topic, str) or not topic.strip() or len(topic) > 2_000:
        raise ValueError("production plan topic is invalid")
    source = source_payload.get("analysis_context")
    source_timing = None
    if "blueprint_ref" in source_payload:
        ref = source_payload["blueprint_ref"]
        if not isinstance(ref, dict) or set(ref) != {"artifact_id", "revision"} or not isinstance(ref.get("artifact_id"), str) or type(ref.get("revision")) is not int or ref["revision"] < 1:
            raise ValueError("production plan blueprint reference is incomplete")
        blueprint = store.read(ref["artifact_id"], ref["revision"])
        if blueprint["schema"] != "reference_blueprint.v1":
            raise ValueError("production plan requires a reference blueprint")
        source = blueprint["payload"]
        if not arrangement:
            refs = [ref]
        from novelvideo.freezone.remix.production_requirements import resolve_source_timing
        source_timing = resolve_source_timing(store, source)
    operation_id = str(operation_id or "")
    stage_store = RemixOperationStore(Path(ctx.output_dir), ctx.project_id) if operation_id else None
    active_stage = stage

    async def on_stage(event: Any) -> None:
        nonlocal active_stage
        if event.status != "started" and event.status != "completed":
            return
        labels = {"full": "正在起草完整作品方案", "outline": "正在整理结构与台词", "arrangement": "正在安排画面与声音",
                  "finalize": "正在检查作品方案"}
        progress = {"full": 0.05, "outline": 0.05, "arrangement": 0.05, "finalize": 0.85}
        if event.status == "started":
            active_stage = event.stage
            await asyncio.to_thread(
                _record_plan_task_stage, envelope, ctx, labels[event.stage], progress[event.stage],
            )
        elif (stage_store is not None and event.stage in {"outline", "arrangement"}
              and isinstance(event.payload, dict)
              and isinstance(envelope.get("__run_task_id"), str)):
            try:
                await asyncio.to_thread(
                    stage_store.record_draft_stage, operation_id,
                    envelope["__run_task_id"], event.stage, event.payload,
                )
            except Exception:
                log_production_plan_diagnostic(
                    "production_plan.stage_record_failed", stage="persisting",
                    draft_stage=event.stage,
                )
    with (
        production_plan_diagnostic_context(
            project_id=ctx.project_id,
            canvas_id=str((operation or {}).get("canvas_id") or payload.get("canvas_id") or ""),
            node_id=str((operation or {}).get("node_id") or payload.get("workflow_node_id") or ""),
            workflow_run_id=str(payload.get("workflow_run_id") or ""),
            operation_id=operation_id,
            task_id=str(envelope.get("__run_task_id") or ""),
        ),
        production_plan_diagnostic_sink(
            lambda record: _persist_plan_diagnostic(envelope, ctx, record)
        ),
    ):
        _record_plan_task_stage(envelope, ctx, "正在起草作品方案", 0.02)
        started = time.monotonic()
        log_production_plan_diagnostic("production_plan.runner_started", stage="requesting")
        try:
            output_preferences = source_payload.get("output_preferences")
            generation_kwargs = dict(
                blueprint=source, username=ctx.requester_username, on_stage=on_stage,
                **({"deadline": envelope["__deadline_monotonic"]}
                   if type(envelope.get("__deadline_monotonic")) in (int, float) else {}),
                **({"requirements": source_payload["requirements"]} if "requirements" in source_payload else {}),
                **({"output_preferences": output_preferences} if isinstance(output_preferences, dict) and output_preferences else {}),
                **({"source_timing": source_timing} if source_timing is not None else {}),
            )
            timing_assumptions: list[dict[str, str]] = []
            if arrangement:
                # Explicitly saved edits are the frozen dialogue for this stage.
                locked_turns = [{"speaker": turn.get("speaker", ""), "text": turn["text"]}
                                for beat in base_plan["payload"]["beats"] for turn in beat.get("turns", [])]
                request = generate_production_plan_arrangement(
                    plan=base_plan["payload"], locked_turns=locked_turns, **generation_kwargs)
            else:
                request = generate_production_plan_draft(
                    topic=topic.strip(), locked_turns=payload.get("locked_turns"),
                    timing_assumptions=timing_assumptions, **generation_kwargs)
            draft = asyncio.run(await_envelope_with_cancel_watch(request, envelope))
        except BaseException as exc:
            validation_failure = isinstance(exc, ValueError) and str(exc) in {
                "json_parse_failed", "plan_validation_failed", "production_plan_stage_validation_failed",
            }
            log_production_plan_diagnostic(
                "production_plan.runner_failed", stage="validating" if validation_failure else "requesting",
                error_code=str(exc) if validation_failure else None,
                draft_stage=active_stage,
                response_received=True if validation_failure else None,
                error=exc,
                elapsed_ms=round((time.monotonic() - started) * 1000),
            )
            raise
        if not arrangement:
            provenance = draft.setdefault('provenance', {})
            # The model may author creative provenance, but task identity and hard
            # constraints come only from the persisted operation snapshot.
            for key in ('operation_id', 'node_target', 'requirements',
                        'requirements_fingerprint', 'requirements_provenance', 'locked_turns'):
                provenance.pop(key, None)
            for key in ('requirements', 'requirements_fingerprint', 'requirements_provenance', 'locked_turns'):
                if key in payload:
                    provenance[key] = payload[key]
            if operation:
                provenance['operation_id'] = operation_id
            if operation and operation.get('canvas_id') and operation.get('node_id'):
                provenance['node_target'] = {
                    'canvas_id': operation['canvas_id'], 'node_id': operation['node_id'],
                    'node_revision': operation['node_revision'], 'goal': topic.strip(),
                }
            if refs:
                draft["provenance"]["blueprint_ref"] = refs[0]
        raise_if_envelope_cancel_requested(envelope)
        _record_plan_task_stage(envelope, ctx, "正在保存作品方案", 0.95)
        persist_started = time.monotonic()
        log_production_plan_diagnostic("production_plan.runner_persist_started", stage="persisting")
        try:
            artifact = (store.revise(base_plan["id"], base_plan["revision"], draft, refs)
                        if arrangement else store.create("production_plan.v2", draft, refs))
        except BaseException as exc:
            log_production_plan_diagnostic(
                "production_plan.runner_failed", stage="persisting", error_code="artifact_persist_failed",
                error=exc, elapsed_ms=round((time.monotonic() - persist_started) * 1000),
            )
            raise
        log_production_plan_diagnostic(
            "production_plan.runner_persisted", stage="persisting",
            elapsed_ms=round((time.monotonic() - persist_started) * 1000),
        )
        output = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
        raise_if_envelope_cancel_requested(envelope)
        _record_plan_task_stage(envelope, ctx, "正在发布作品方案", 0.98)
        publish_started = time.monotonic()
        log_production_plan_diagnostic("production_plan.runner_publish_started", stage="publishing")
        try:
            _publish_operation_result(payload, ctx, output)
        except BaseException as exc:
            log_production_plan_diagnostic(
                "production_plan.runner_failed", stage="publishing", error_code="operation_publish_failed",
                error=exc, elapsed_ms=round((time.monotonic() - publish_started) * 1000),
            )
            raise
        log_production_plan_diagnostic(
            "production_plan.runner_published", stage="publishing",
            elapsed_ms=round((time.monotonic() - publish_started) * 1000),
        )
        from novelvideo.freezone.remix.production_plan_diagnostics import (
            collect_plan_diagnostics, measure_plan_speech,
        )
        return {"status": "completed", "artifact_ref": output,
                "speech_estimates": measure_plan_speech(
                    draft, local_timing_beat_ids={row["beat_id"] for row in timing_assumptions}),
                "timing_assumptions": timing_assumptions,
                "plan_diagnostics": collect_plan_diagnostics(draft)}


def _record_plan_task_stage(
    envelope: dict[str, Any], ctx: ProjectContext, stage: str, progress: float,
) -> None:
    task_id = envelope.get("__run_task_id")
    if not task_id:
        return
    try:
        from novelvideo.task_state import get_task_manager

        get_task_manager().update_progress_for_project(
            ctx, envelope.get("__plan_task_type", "remix_generate_production_plan_draft"), int(envelope.get("episode") or 0),
            beat_num=envelope.get("beat_num"), scope=envelope.get("scope"),
            progress=progress, current_task=stage, logs=[stage], expected_task_id=str(task_id),
            metadata={"authoring_stage": envelope.get("__plan_authoring_stage", "full")},
        )
    except Exception:
        # Diagnostics must never convert a valid model result into a failed task.
        log_production_plan_diagnostic("production_plan.task_log_failed", stage="persisting")


def _persist_plan_diagnostic(
    envelope: dict[str, Any], ctx: ProjectContext, record: dict[str, object],
) -> None:
    """Append one already sanitized diagnostic to the active task's log."""
    task_id = envelope.get("__run_task_id")
    if not isinstance(task_id, str) or not task_id:
        return
    from novelvideo.task_state import get_task_manager

    manager = get_task_manager()
    task_type = envelope.get("__plan_task_type", "remix_generate_production_plan_draft")
    episode = int(envelope.get("episode") or 0)
    beat_num = envelope.get("beat_num")
    scope = envelope.get("scope")
    active = manager.get_task_for_project(
        ctx, task_type, episode, beat_num=beat_num, scope=scope,
    )
    if active is None or active.task_id != task_id:
        return
    failure = build_plan_failure_summary(record, task_id=task_id)
    manager.update_progress_for_project(
        ctx, task_type, episode, beat_num=beat_num, scope=scope,
        status=active.status, logs=[json.dumps(record, ensure_ascii=False)],
        metadata={"production_plan_failure": failure} if failure else None,
        expected_task_id=task_id,
    )


def run_remix_compile_production_plan(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Compile and save one ready V2 revision as its exact manifest projection."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    ref = payload.get("plan_ref")
    if (not isinstance(ref, dict) or set(ref) != {"artifact_id", "revision"}
            or not isinstance(ref.get("artifact_id"), str) or type(ref.get("revision")) is not int
            or ref["revision"] < 1):
        raise ValueError("production compilation needs an exact plan revision")
    project_dir = Path(ctx.output_dir).resolve()
    store = production_store(ctx)
    source = store.read(ref["artifact_id"], ref["revision"])
    if source["schema"] != "production_plan.v2":
        raise ValueError("production compilation requires production_plan.v2")
    provenance = source['payload'].get('provenance') or {}
    requirements = provenance.get('requirements') or {}
    bound = provenance.get('requirements_provenance') or {}
    if bound.get('commission_ref'):
        from novelvideo.freezone.remix.reference_commission import read_reference_commission
        from novelvideo.freezone.remix.production_requirements import resolve_production_requirements

        commission = read_reference_commission(store, bound['commission_ref'])
        resolved = resolve_production_requirements(
            store, commission=commission, allow_historical=True)
        if (provenance.get('requirements_fingerprint') != resolved['requirements_fingerprint']
                or requirements != resolved['requirements']
                or bound != resolved['requirements_provenance']):
            raise ValueError('production requirements differ from authenticated duration and direction')
        requirements = resolved['requirements']
    if requirements.get('duration_us'):
        from novelvideo.freezone.remix.production_requirements import check_production_requirements
        checks = check_production_requirements(
            source['payload'], {'duration_us': requirements['duration_us']},
            project_dir=project_dir)
        failed = [row for row in checks if row['status'] == 'failed']
        if failed:
            raise ValueError('production duration requirements failed: ' +
                             json.dumps(failed, ensure_ascii=False))
    projection = project_production_plan_v2(source["payload"], project_dir=project_dir)
    if not projection["ready"]:
        raise ValueError("production plan is not ready: " + "; ".join(
            str(issue.get("message") or issue.get("code") or "unresolved placement")
            for issue in projection["issues"][:5]
        ))
    manifest = compile_production_plan_v2(source["payload"])
    manifest["source_versions"] = [ref]
    saved = store.create("composition_manifest.v2", manifest, [ref])
    output = {"artifact_id": saved["id"], "revision": saved["revision"]}
    _publish_operation_result(payload, ctx, output)
    return {"status": "completed", "artifact_ref": output}


def run_remix_align_script(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Align server-confirmed narration to one immutable remix script revision."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    media_path = _verified_project_media_path(project_dir, payload)
    ref = payload.get("script_ref") if isinstance(payload.get("script_ref"), dict) else {}
    artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
    if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
        raise ValueError("remix alignment script reference is incomplete")
    store = RemixArtifactStore(project_dir, ctx.project_id)
    script = store.read(artifact_id, revision)
    if script["schema"] != "remix_script.v1":
        raise ValueError("remix alignment requires a remix script")
    source = {**script["payload"], "revision": revision}
    timeline = align_script(media_path, source)
    artifact = store.create("word_timeline.v1", timeline, [{"artifact_id": artifact_id, "revision": revision}])
    _publish_operation_result(payload, ctx, {"artifact_id": artifact["id"], "revision": artifact["revision"]})
    return {"status": "completed", "artifact_ref": {"artifact_id": artifact["id"], "revision": artifact["revision"]}}


def run_remix_align_production_speech(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Recognize one source once, then time every bound turn in that take."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    media_path = _verified_project_media_path(project_dir, payload)
    ref = payload.get("plan_ref") if isinstance(payload.get("plan_ref"), dict) else {}
    artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
    if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
        raise ValueError("production speech alignment needs an exact plan revision")
    store = RemixArtifactStore(project_dir, ctx.project_id, producer_version="remix-align-production-speech.v1")
    plan = store.read(artifact_id, revision)
    if plan["schema"] != "production_plan.v2":
        raise ValueError("production speech alignment requires a v2 production plan")
    turn, placement, resource = production_speech_source(
        plan["payload"], payload.get("turn_id"), payload.get("placement_id"), payload.get("take_id")
    )
    if resource.media_path != payload.get("media_path") or resource.media_hash != payload["media_sha256"]:
        raise ValueError("production speech source differs from the saved plan resource")
    parsed_plan = ProductionPlanV2.model_validate(plan["payload"])
    take = next((row for row in parsed_plan.speech_takes if row.id == payload.get("take_id")), None)
    group = [candidate for beat in parsed_plan.beats for candidate in beat.turns
             if (candidate.id in take.turn_ids if take else
                 candidate.speech_placement_id == placement.id or
                 (candidate.speech_placement_id is None and candidate.speech_timing is not None
                  and candidate.speech_timing.placement_id == placement.id))]
    if not any(candidate.id == turn.id for candidate in group):
        group = [turn]
    for candidate in group:
        production_speech_source(plan["payload"], candidate.id, None if take else placement.id, payload.get("take_id"))
    script_text = "\n".join(candidate.text for candidate in group)
    script = {"revision": revision, "text": script_text, "already_spoken": True}
    # Recognition uses the complete bound media. Placement bounds are an editing
    # decision and may differ from the duration of newly generated speech.
    timeline = align_script(media_path, script)
    timeline["media_hash"] = "sha256:" + resource.media_hash
    timeline.update({"plan_ref": ref, "turn_id": turn.id, "placement_id": placement.id,
                     "text_hash": hashlib.sha256(script_text.encode("utf-8")).hexdigest(),
                     "source_in_us": 0, "source_out_us": resource.duration_us})
    if len(group) > 1:
        timeline["group_turn_ids"] = [candidate.id for candidate in group]
    if len(group) > 1 and timeline["status"] == "completed":
        ranges: dict[str, tuple[int, int]] = {}
        cursor = 0
        for candidate in group:
            ranges[candidate.id] = (cursor, cursor + len(candidate.text))
            cursor += len(candidate.text) + 1
        divided: dict[str, list[dict[str, Any]]] = {candidate.id: [] for candidate in group}
        for word in timeline["words"]:
            matching = [candidate for candidate in group
                        if ranges[candidate.id][0] <= word["start_char"]
                        and word["end_char"] <= ranges[candidate.id][1]]
            if len(matching) != 1:
                divided = {}
                break
            candidate = matching[0]
            start_char = ranges[candidate.id][0]
            divided[candidate.id].append({**word,
                                          "start_char": word["start_char"] - start_char,
                                          "end_char": word["end_char"] - start_char})
        if not divided or any(not words for words in divided.values()):
            timeline["status"] = "script_mismatch"
            timeline["words"] = []
            timeline["mismatch"] = {
                "reason": "recognized words cannot be assigned to every turn in the shared source",
                "report": timeline.get("match_report"),
            }
        else:
            sibling_refs: list[dict[str, Any]] = []
            primary_payload: dict[str, Any] | None = None
            for candidate in group:
                turn_payload = {**timeline, "turn_id": candidate.id,
                                "text_hash": hashlib.sha256(candidate.text.encode("utf-8")).hexdigest(),
                                "transcript": candidate.text, "words": divided[candidate.id]}
                turn_payload.pop("match_report", None)
                if candidate.id == turn.id:
                    primary_payload = turn_payload
                    continue
                sibling = store.create("word_timeline.v1", turn_payload, [ref])
                sibling_refs.append({"turn_id": candidate.id, "artifact_id": sibling["id"],
                                     "revision": sibling["revision"]})
            assert primary_payload is not None
            primary_payload["group_refs"] = sibling_refs
            artifact = store.create("word_timeline.v1", primary_payload,
                                    [ref, *[{"artifact_id": row["artifact_id"],
                                             "revision": row["revision"]} for row in sibling_refs]])
    if len(group) == 1 or timeline["status"] != "completed":
        artifact = store.create("word_timeline.v1", timeline, [ref])
    output = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
    _publish_operation_result(payload, ctx, output)
    return {"status": "needs_review" if timeline["status"] != "completed" else "completed",
            "artifact_ref": output, "alignment_status": timeline["status"]}


def run_remix_compile_semantic_timeline(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Compile exact script and completed alignment revisions into timing evidence."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    store = RemixArtifactStore(project_dir, ctx.project_id)
    _verified_project_media_path(project_dir, payload)
    def read_ref(name: str, schema: str) -> dict[str, Any]:
        ref = payload.get(name) if isinstance(payload.get(name), dict) else {}
        artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
        if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
            raise ValueError(f"{name} is incomplete")
        artifact = store.read(artifact_id, revision)
        if artifact["schema"] != schema:
            raise ValueError(f"{name} must reference {schema}")
        return artifact
    script_artifact = read_ref("script_ref", "remix_script.v1")
    words_artifact = read_ref("word_timeline_ref", "word_timeline.v1")
    blueprint_artifact = read_ref("blueprint_ref", "reference_blueprint.v1")
    words = {**words_artifact["payload"], "artifact_revision": words_artifact["revision"]}
    if words.get("status") != "completed":
        raise ValueError("semantic timing requires completed alignment")
    linked = any(
        ref.get("artifact_id") == script_artifact["id"]
        and ref.get("revision") == script_artifact["revision"]
        for ref in words_artifact["upstream_refs"]
    )
    if not linked or words.get("script_revision") != script_artifact["revision"]:
        raise ValueError("word timeline does not belong to the exact script revision")
    narration_hash = "sha256:" + str(payload["media_sha256"])
    if words.get("media_hash") != narration_hash:
        raise ValueError("word timeline does not belong to the exact narration media")
    script = {
        **script_artifact["payload"],
        "revision": script_artifact["revision"],
        "media_hash": words["media_hash"],
    }
    timing = compile_timing(script, words, payload.get("edit_map", []), payload.get("overrides", []), payload.get("fps"))
    artifact = store.create(
        "performance_timing.v1",
        timing,
        [
            {"artifact_id": script_artifact["id"], "revision": script_artifact["revision"]},
            {"artifact_id": words_artifact["id"], "revision": words_artifact["revision"]},
            {"artifact_id": blueprint_artifact["id"], "revision": blueprint_artifact["revision"]},
        ],
    )
    _publish_operation_result(payload, ctx, {"artifact_id": artifact["id"], "revision": artifact["revision"]})
    status = "needs_review" if timing["unresolved_required_events"] else "completed"
    return {"status": status, "artifact_ref": {"artifact_id": artifact["id"], "revision": artifact["revision"]}, "unresolved_required_events": timing["unresolved_required_events"]}


def _media_duration_us(path: Path) -> int:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if not 0 < duration <= 60:
        raise ValueError("accepted take duration must be within 60 seconds")
    return round(duration * 1_000_000)


def run_remix_compile_take_timeline(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    """Align each accepted take against its own text and publish one joined clock."""
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    ref = payload.get("script_ref") if isinstance(payload.get("script_ref"), dict) else {}
    project_dir = Path(ctx.output_dir).resolve()
    store = RemixArtifactStore(project_dir, ctx.project_id)
    script_artifact = store.read(ref.get("artifact_id"), ref.get("revision"))
    if script_artifact["schema"] != "remix_script.v1":
        raise ValueError("take timeline requires a saved remix script")
    script = {**script_artifact["payload"], "revision": script_artifact["revision"]}
    bindings = payload.get("take_bindings")
    if not script.get("segments") or any(not isinstance(segment, dict) or not segment.get("segment_id") for segment in script["segments"]):
        raise ValueError("take timeline requires performance segments")
    if not isinstance(bindings, list) or len(bindings) != len(script["segments"]):
        raise ValueError("one accepted media binding is required per performance segment")
    takes: list[dict[str, Any]] = []
    refs = [{"artifact_id": script_artifact["id"], "revision": script_artifact["revision"]}]
    for segment, binding in zip(script["segments"], bindings, strict=True):
        if not isinstance(binding, dict) or binding.get("segment_id") != segment["segment_id"]:
            raise ValueError("take binding order does not match the script")
        path = _verified_project_media_path(project_dir, binding)
        media_hash = "sha256:" + binding["media_sha256"]
        if segment.get("take_media_revision") and segment["take_media_revision"] != binding["media_sha256"]:
            raise ValueError("selected take media revision has changed")
        text = spoken_text_for_segment(script["dialogue"], segment)
        aligned = align_script(path, {"revision": script_artifact["revision"], "dialogue": text, "already_spoken": True})
        if aligned.get("status") != "completed" or aligned.get("media_hash") != media_hash:
            raise ValueError(f"take {segment['segment_id']} does not match its spoken script or media")
        word_artifact = store.create("word_timeline.v1", {**aligned, "segment_id": segment["segment_id"]}, refs[:1])
        refs.append({"artifact_id": word_artifact["id"], "revision": word_artifact["revision"]})
        takes.append({"segment_id": segment["segment_id"], "media_hash": media_hash,
                      "duration_us": _media_duration_us(path), "alignment": aligned})
    timing = compile_take_timing(script, takes, fps=payload.get("fps"))
    artifact = store.create("performance_timing.v2", timing, refs)
    output = {"artifact_id": artifact["id"], "revision": artifact["revision"]}
    _publish_operation_result(payload, ctx, output)
    return {"status": "needs_review" if timing["unresolved_required_events"] else "completed", "artifact_ref": output,
            "unresolved_required_events": timing["unresolved_required_events"]}


def _project_media_paths(project_dir: Path, manifest: dict[str, Any]) -> dict[str, Path]:
    """Resolve only relative paths saved in the immutable manifest."""
    root = project_dir.resolve()
    resolved: dict[str, Path] = {}
    for binding in manifest["media_bindings"]:
        media_id = binding["media_id"]
        relative = binding.get("project_path")
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
            raise ValueError(f"media binding {media_id} lacks a project-local path")
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise FileNotFoundError(f"bound media is unavailable: {media_id}")
        expected_hash = binding.get("media_hash")
        if not isinstance(expected_hash, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_hash):
            raise ValueError(f"media binding {media_id} lacks a valid content hash")
        # Legacy callers pin rejection before invoking their renderer. The v4
        # renderer owns the hash gate so its immutable inputs are read only once.
        if manifest.get("manifest_version", 1) != 4:
            digest = hashlib.sha256()
            with candidate.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1_048_576), b""):
                    digest.update(chunk)
            if f"sha256:{digest.hexdigest()}" != expected_hash:
                raise ValueError(f"bound media changed since manifest was saved: {media_id}")
        resolved[media_id] = candidate
    return resolved


def run_remix_render(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    ref = payload.get("manifest_ref") if isinstance(payload.get("manifest_ref"), dict) else {}
    artifact_id, revision = ref.get("artifact_id"), ref.get("revision")
    job_id = str(payload.get("job_id") or "")
    if not isinstance(artifact_id, str) or type(revision) is not int or revision < 1:
        raise ValueError("remix render manifest reference is incomplete")
    if not _JOB_ID.fullmatch(job_id):
        raise ValueError("invalid remix render job id")
    project_dir = Path(ctx.output_dir).resolve()
    artifact = RemixArtifactStore(project_dir, ctx.project_id).read(artifact_id, revision)
    if artifact["schema"] not in {"composition_manifest.v1", "composition_manifest.v2"}:
        raise ValueError("remix render requires a composition manifest")
    manifest = artifact["payload"]
    validate_manifest(manifest)
    media_paths = _project_media_paths(project_dir, manifest)
    output = project_dir / "freezone" / "remix_renders" / artifact_id / str(revision) / f"{job_id}.mp4"
    render_manifest(manifest, media_paths=media_paths, output_path=output)
    _publish_operation_result(payload, ctx, {"project_path": output.relative_to(project_dir).as_posix()})
    return {
        "job_id": job_id,
        "output_path": output.relative_to(project_dir).as_posix(),
        "manifest_ref": {"artifact_id": artifact_id, "revision": revision},
        "node_revision": payload.get("node_revision"),
    }


def _with_operation_failure_transition(runner):
    def guarded(envelope: dict[str, Any], ctx: ProjectContext):
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        operation_id = payload.get("operation_id")
        try:
            return runner(envelope, ctx)
        except TimeoutError:
            if operation_id:
                operations = RemixOperationStore(Path(ctx.output_dir), ctx.project_id)
                try:
                    if operations.get(str(operation_id))["status"] == "cancelling":
                        operations.cancellation_outcome_unknown(str(operation_id), reason="task timeout during cancellation")
                    else:
                        operations.provider_outcome_unknown(str(operation_id), provider_task_id=str(envelope.get("__run_task_id") or envelope.get("task_id") or ""))
                except ValueError:
                    pass
            raise
        except Exception as exc:
            if operation_id:
                operations = RemixOperationStore(Path(ctx.output_dir), ctx.project_id)
                try:
                    if operations.get(str(operation_id))["status"] == "cancelling":
                        operations.cancellation_outcome_unknown(str(operation_id), reason=str(exc) or type(exc).__name__)
                    else:
                        operations.fail(str(operation_id), reason=str(exc) or type(exc).__name__)
                except ValueError:
                    pass
            raise
    return guarded


register_project_task_runner("remix_render", _with_operation_failure_transition(run_remix_render), requires_home_node=True, lane="ffmpeg")
register_project_task_runner("remix_adopt_source_speech", _with_operation_failure_transition(run_remix_adopt_source_speech), requires_home_node=True, lane="default")
register_project_task_runner("remix_analyze_material_speech", _with_operation_failure_transition(run_remix_analyze_material_speech), requires_home_node=True, lane="default")
register_project_task_runner("remix_transcribe_media", _with_operation_failure_transition(run_remix_transcribe_media), requires_home_node=True, lane="default")
register_project_task_runner("remix_analyze_reference_video", _with_operation_failure_transition(run_remix_analyze_reference_video), requires_home_node=True)
register_project_task_runner("remix_plan_broll", _with_operation_failure_transition(run_remix_plan_broll), requires_home_node=True)
register_project_task_runner("remix_generate_script_draft", _with_operation_failure_transition(run_remix_generate_script_draft), requires_home_node=True)
register_project_task_runner("remix_generate_production_plan_draft", _with_operation_failure_transition(run_remix_generate_production_plan_draft), requires_home_node=True)
register_project_task_runner("remix_compile_production_plan", _with_operation_failure_transition(run_remix_compile_production_plan), requires_home_node=True)
register_project_task_runner("remix_align_script", _with_operation_failure_transition(run_remix_align_script), requires_home_node=True, lane="default")
register_project_task_runner("remix_align_production_speech", _with_operation_failure_transition(run_remix_align_production_speech), requires_home_node=True, lane="default")
register_project_task_runner("remix_compile_semantic_timeline", _with_operation_failure_transition(run_remix_compile_semantic_timeline), requires_home_node=True)
register_project_task_runner("remix_compile_take_timeline", _with_operation_failure_transition(run_remix_compile_take_timeline), requires_home_node=True, lane="default")

register_project_task_runner("remix_joint_reference_analysis", _with_operation_failure_transition(run_remix_joint_reference_analysis), requires_home_node=True)

register_project_task_runner("remix_generate_production_plan_arrangement", _with_operation_failure_transition(run_remix_generate_production_plan_arrangement), requires_home_node=True)
