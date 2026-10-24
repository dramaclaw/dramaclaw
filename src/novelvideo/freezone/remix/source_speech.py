"""Immutable full-source recognition, scoped to host-authorized candidate media.

The SQLite claim survives process death. An ambiguous provider attempt is never
reclaimed by time alone; a trusted reconciliation may supply its actual result.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

PRODUCER = 'remix-source-speech.v1'
SCHEMA = 'source_speech_observation.v1'


class SourceSpeechPending(TimeoutError):
    """The existing recognition may still have run; reconcile without retrying."""


class RecognizedSpeechSpan(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    start_us: int = Field(ge=0)
    end_us: int = Field(gt=0)

    @model_validator(mode='after')
    def bounds(self):
        if self.end_us <= self.start_us:
            raise ValueError('recognized speech span must have positive duration')
        return self


class SourceSpeechObservationV1(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schema_version: Literal[1] = 1
    resource_signature: dict[str, Any]
    authorization_scope: dict[str, Any]
    provider_signature: str = Field(min_length=1)
    scope_signature: str = Field(pattern=r'^[a-f0-9]{64}$')
    source_key: str = Field(pattern=r'^[a-f0-9]{64}$')
    language: str = Field(min_length=1)
    requested_language: str | None = None
    source_duration_us: int = Field(ge=0)
    transcript: str = ''
    recognized_words: list[RecognizedSpeechSpan] = Field(default_factory=list)
    recognized_segments: list[RecognizedSpeechSpan] = Field(default_factory=list)
    timing_granularity: Literal['word', 'segment', 'none']
    status: Literal['completed', 'missing_audio', 'no_speech_detected', 'skipped']

    @model_validator(mode='after')
    def honest_timing(self):
        expected = 'word' if self.recognized_words else 'segment' if self.recognized_segments else 'none'
        if self.timing_granularity != expected:
            raise ValueError('timing granularity differs from recognized evidence')
        if self.status != 'completed' and (self.recognized_words or self.recognized_segments or self.transcript):
            raise ValueError('absent speech cannot carry recognition evidence')
        if any(span.end_us > self.source_duration_us for span in [*self.recognized_words, *self.recognized_segments]):
            raise ValueError('recognized speech exceeds full source duration')
        signature = self.resource_signature
        if set(signature) != {'media_hash', 'stream_index'} or not isinstance(signature['media_hash'], str):
            raise ValueError('invalid resource signature')
        if type(signature['stream_index']) is not int or signature['stream_index'] != 0:
            raise ValueError('only the native first audio stream is supported')
        return self


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_speech_key(*, scope: dict, media_hash: str, stream_index: int, language: str, provider_signature: str) -> str:
    """No planned duration or target text participates in source recognition."""
    return _digest({'scope': scope, 'media_hash': media_hash, 'stream_index': stream_index,
                    'language': language, 'provider_signature': provider_signature})


def configured_provider_signature() -> str:
    from novelvideo.egress_context import ambient_organization_egress_context
    from novelvideo.config import get_newapi_runtime_credentials
    from .newapi_transcription import MODEL
    context = ambient_organization_egress_context()
    if context is not None:
        gateway = {'organization_id': context.billing_principal.id,
                   'credential_id': context.credential.credential_id,
                   'credential_version': context.credential.key_version}
    else:
        _, base_url = get_newapi_runtime_credentials()
        parsed = urlsplit(base_url)
        # Credentials, URL userinfo and query tokens never enter the stored digest.
        gateway = {'endpoint': f'{parsed.scheme}://{parsed.hostname}:{parsed.port or ""}{parsed.path.rstrip("/")}'}
    return _digest({'provider': 'newapi', 'model': MODEL, 'version': 'candidate-v1',
                    **gateway, 'config': {'format': 'verbose_json', 'timestamps': 'word',
                    'audio_stream': 0, 'channels': 1, 'sample_rate': 16000, 'bitrate': '32k'}})


def candidate_scope(ctx, canvas: dict, canvas_id: str, *, require_write: bool = True) -> dict:
    if (canvas.get('project_id') != ctx.project_id or not ctx.is_home_node or
        ctx.effective_role not in ({'owner', 'admin', 'editor'} if require_write else {'owner', 'admin', 'editor', 'viewer'})):
        raise ValueError('authorized home-node editor context required')
    private = canvas.get('access_model') in {'private', 'user_private'}
    owner = canvas.get('owner_principal_id') or ''
    if private and owner != ctx.requester_user_id:
        raise ValueError('private canvas access denied')
    return {'owner_type': ctx.owner_type, 'owner_id': ctx.owner_id, 'project_id': ctx.project_id,
            'canvas_id': canvas_id, 'access_model': canvas.get('access_model', 'shared'),
            'private_owner_id': owner if private else ''}


def prepare_material_speech(store, ctx, canvas: dict, *, canvas_id: str, work_ref: dict,
                            step_id: str, node_id: str, language: str,
                            provider_signature: str | None = None, _automatic_only: bool = False) -> dict:
    from .material_work import _exact_ref
    from .material_execution import canvas_material_resource, validate_material_native_execution
    _exact_ref(work_ref)
    scope = candidate_scope(ctx, canvas, canvas_id)
    if store.project_id != ctx.project_id or store.project_dir != Path(ctx.output_dir).resolve():
        raise ValueError('candidate store differs from host project scope')
    if not isinstance(language, str) or not language or len(language) > 32:
        raise ValueError('language is required')
    saved = store.read(work_ref['artifact_id'], work_ref['revision'])
    if saved['schema'] != 'material_work_package.v1':
        raise ValueError('material work package required')
    if store.read_latest(saved['id'])['revision'] != saved['revision']:
        raise ValueError('material work changed; reload current revision')
    plan_ref = saved['payload']['plan_ref']
    plan_nodes = [n for n in canvas.get('nodes', []) if n.get('type') == 'scriptNode']
    plan_refs = [(n.get('data', {}).get('productionPlanV2Ref') or {}) for n in plan_nodes]
    if not any(ref.get('artifactId', ref.get('artifact_id')) == plan_ref['artifact_id']
               and ref.get('revision') == plan_ref['revision'] for ref in plan_refs):
        raise ValueError('work plan revision is not current on canvas')
    step = next((s for s in saved['payload']['steps'] if s['id'] == step_id), None)
    if not step or step['status'] in {'rejected', 'stale'}:
        raise ValueError('current material step required')
    if step.get('node_id') and step['node_id'] != node_id:
        raise ValueError('material node differs from work step')
    execution = None
    if step['source'] == 'generate':
        if (step.get('execution') or {}).get('canvas_id') != canvas_id:
            raise ValueError('material generation has no native execution for this canvas')
        execution = validate_material_native_execution(store, canvas, step, node_id,
            require_complete=True, workflow_state_dir=Path(ctx.state_dir), work_ref=work_ref)
    elif step['source'] == 'existing' and step.get('node_id') != node_id:
        raise ValueError('existing material node differs from planned resource')
    resource = canvas_material_resource(store, canvas, node_id, step['media_kind'])
    relevant = [r for r in saved['payload']['requirements'] if r['final_step_id'] == step_id]
    speech_required = any(r.get('turn_ids') or r.get('take_ids') for r in relevant)
    # An explicit manual request is also a speech inspection request. Automatic
    # settlement uses speech_required to skip silent visual material.
    provider = (provider_signature or 'not-requested') if _automatic_only and not speech_required else (provider_signature or configured_provider_signature())
    task_payload = {'canvas_id': canvas_id, 'work_ref': work_ref, 'step_id': step_id, 'node_id': node_id,
                    'language': language, 'scope': scope, 'resource': resource,
                    'provider_signature': provider, 'native_execution': execution}
    return {'input_refs': [work_ref], 'normalized_parameters': {'action': 'analyze_material_speech', 'payload': task_payload},
            'task_payload': task_payload, 'task_type': 'remix_analyze_material_speech', 'queue_kind': 'default',
            'producer_version': PRODUCER, 'scope': '',
            'input_media_hashes': ['sha256:' + resource['media_hash']], 'speech_required': speech_required}


def _verified_media(store, resource: dict) -> Path:
    from .alignment import _sha256
    relative = resource.get('media_path')
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError('project-relative candidate media required')
    path = (store.project_dir / relative).resolve()
    if not path.is_relative_to(store.project_dir) or not path.is_file():
        raise ValueError('candidate media unavailable')
    if _sha256(path) != 'sha256:' + resource['media_hash']:
        raise ValueError('candidate media changed since submission')
    return path


def _connection(store):
    freezone = store.project_dir / 'freezone'
    database = freezone / '_source_speech.sqlite3'
    if freezone.is_symlink() or database.is_symlink():
        raise ValueError('source speech storage contains a symlink')
    freezone.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database, timeout=10)
    connection.execute('CREATE TABLE IF NOT EXISTS observations (source_key TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT NOT NULL, result_json TEXT, artifact_ref TEXT)')
    return connection


def unresolved_source_speech_claim(store, source_key: str) -> str | None:
    """Return the durable claim status when no provider result is saved yet.

    Automation reads this before preparing another paid recognition. An operator
    still resubmits explicitly; only the automatic checker defers.
    """
    conn = _connection(store)
    try:
        row = conn.execute('SELECT status, result_json, artifact_ref FROM observations WHERE source_key=?',
                           (source_key,)).fetchone()
    finally:
        conn.close()
    if not row or row[1] or row[2]:
        return None
    return row[0]


def observe_source_speech(store, *, scope: dict, resource: dict, language: str,
                          provider_signature: str, aligner=None) -> dict:
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    from .alignment import transcribe_media, configured_newapi_transcriber
    from .newapi_transcription import TranscriptionPreDispatchError
    media_path = _verified_media(store, resource)
    if scope.get('project_id') != store.project_id:
        raise ValueError('source scope differs from project')
    signature = {'media_hash': resource['media_hash'], 'stream_index': 0}
    key = source_speech_key(scope=scope, media_hash=signature['media_hash'], stream_index=0,
                            language=language, provider_signature=provider_signature)
    owner = uuid.uuid4().hex
    conn = _connection(store)
    try:
        with conn:
            inserted = conn.execute('INSERT OR IGNORE INTO observations VALUES (?, ?, ?, NULL, NULL)',
                                    (key, 'processing', owner)).rowcount
            row = conn.execute('SELECT status, owner, result_json, artifact_ref FROM observations WHERE source_key=?', (key,)).fetchone()
        if row[3]:
            ref = json.loads(row[3])
            read_source_speech_observation(store, ref, scope=scope, resource=resource,
                language=language, provider_signature=provider_signature)
            return ref
        if row[2]:
            observation = json.loads(row[2])
        elif not inserted:
            raise SourceSpeechPending('source recognition already claimed; reconcile provider outcome')
        else:
            dispatch_possible = False
            try:
                status = 'missing_audio' if not resource.get('has_audio') else 'completed'
                if status == 'completed':
                    if aligner is None:
                        aligner = configured_newapi_transcriber(allow_segments=True)
                    dispatch_possible = True
                raw = transcribe_media(media_path, language, aligner=aligner, allow_segments=True) if status == 'completed' else {}
                if raw.get('status') == 'no_speech':
                    status = 'no_speech_detected'
                words = [{k: w[k] for k in ('text', 'start_us', 'end_us')} for w in raw.get('words', [])]
                segments = [{k: s[k] for k in ('text', 'start_us', 'end_us')} for s in raw.get('segments', [])]
                for kind, spans in [('word', words), ('segment', segments)]:
                    for index, span in enumerate(spans):
                        span['id'] = f'{kind}_{key[:16]}_{index}'
                observation = SourceSpeechObservationV1.model_validate({
                    'resource_signature': signature, 'authorization_scope': scope, 'scope_signature': _digest(scope), 'source_key': key,
                    'provider_signature': provider_signature, 'language': raw.get('language', language),
                    'requested_language': language,
                    'source_duration_us': resource['duration_us'], 'recognized_words': words,
                    'recognized_segments': segments, 'transcript': raw.get('transcript', ''), 'status': status,
                    'timing_granularity': 'word' if words else 'segment' if segments else 'none',
                }).model_dump(mode='json')
                _verified_media(store, resource)
                with conn:
                    conn.execute('UPDATE observations SET status=?, result_json=? WHERE source_key=? AND owner=?',
                                 ('recognized', json.dumps(observation), key, owner))
            except BaseException as exc:
                pre_dispatch = not dispatch_possible or isinstance(exc, TranscriptionPreDispatchError)
                with conn:
                    if pre_dispatch:
                        conn.execute('DELETE FROM observations WHERE source_key=? AND owner=? AND result_json IS NULL', (key, owner))
                    else:
                        conn.execute('UPDATE observations SET status=? WHERE source_key=? AND owner=?', ('unknown', key, owner))
                if not pre_dispatch and isinstance(exc, Exception):
                    raise SourceSpeechPending('source recognition outcome requires reconciliation: ' + str(exc)) from exc
                raise
        # Serialize publication only after provider work, preserving raw result
        # for recovery if artifact publication or notification fails.
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute('SELECT artifact_ref FROM observations WHERE source_key=?', (key,)).fetchone()[0]
        if existing:
            ref = json.loads(existing)
        else:
            from .store import RemixArtifactStore
            producer = RemixArtifactStore(store.project_dir, store.project_id, created_by=store.created_by, producer_version=PRODUCER)
            with producer._locked() as guard:
                try:
                    artifact = producer._read(key, 1)
                    if artifact['producer_version'] != PRODUCER or artifact['schema'] != SCHEMA or artifact['payload'] != observation:
                        raise ValueError('source observation provenance differs')
                except FileNotFoundError:
                    artifact = producer._publish(artifact_id=key, schema=SCHEMA, revision=1,
                        payload=observation, upstream_refs=[], created_by=store.created_by, guard=guard)
            ref = {'artifact_id': artifact['id'], 'revision': artifact['revision']}
            conn.execute('UPDATE observations SET status=?, artifact_ref=? WHERE source_key=?', ('completed', json.dumps(ref), key))
        conn.commit()
        return ref
    except SourceSpeechPending:
        raise
    except (OSError, sqlite3.Error, CanvasLockBusy) as exc:
        raise SourceSpeechPending('durable source result publication requires reconciliation') from exc
    finally:
        conn.close()


def make_material_speech_scheduler(ctx, *, canvas_id: str):
    """Bind B1's scheduler hook to an authenticated host ProjectContext.

    Invoke from a worker/thread, outside canvas/artifact locks. The callback
    never builds a ProjectContext from a candidate or model-supplied dictionary.
    """
    def schedule(*, store, canvas, work_ref, step_id, resource, native_result,
                 workflow_state_dir, command_id, settlement_id=None):
        import asyncio
        from .material_execution import review_material_candidate
        if Path(workflow_state_dir).resolve() != Path(ctx.state_dir).resolve():
            raise ValueError('candidate workflow state differs from host context')
        prepared = prepare_material_speech(store, ctx, canvas, canvas_id=canvas_id,
            work_ref=work_ref, step_id=step_id, node_id=resource['node_id'], language='auto', _automatic_only=True)
        if prepared['task_payload']['resource'] != resource:
            raise ValueError('settled candidate differs from current resource')
        if not prepared['speech_required']:
            proof = {'settlement_id': settlement_id} if settlement_id is not None else {}
            review = review_material_candidate(store, work_ref, step_id, canvas, resource['node_id'],
                workflow_state_dir=workflow_state_dir, command_id=command_id, **proof)
            return {'status': 'needs_review', 'review_ref': review['review_ref']}
        revision = native_result.get('node_revision')
        revision = revision if type(revision) is int and revision > 0 else 1
        result = asyncio.run(enqueue_material_speech(ctx, store, prepared,
            command_id=command_id, node_revision=revision))
        return {'status': 'checking', 'check_ref': {'operation_id': result['operation_id']}}
    return schedule


async def enqueue_material_speech(ctx, store, prepared: dict, *, command_id: str, node_revision: int, admission_guard=None) -> dict:
    """Submit via existing native durable operation fencing and the default lane."""
    from starlette.concurrency import run_in_threadpool
    from novelvideo.ports import get_task_backend
    from .operations import RemixOperationStore
    from novelvideo.api.routes.remix import record_enqueue_exception
    operations = RemixOperationStore(store.project_dir, ctx.project_id)
    operation = await run_in_threadpool(operations.start, idempotency_key=command_id,
        input_refs=prepared['input_refs'], producer_version=prepared['producer_version'],
        normalized_parameters=prepared['normalized_parameters'], node_revision=node_revision,
        input_media_hashes=prepared['input_media_hashes'])
    if operation['task_id'] or operation['status'] != 'pending':
        return operation
    owner = uuid.uuid4().hex
    fence = await run_in_threadpool(operations.claim_submission, operation['operation_id'], owner=owner)
    if fence is None:
        return await run_in_threadpool(operations.get, operation['operation_id'])
    if admission_guard is not None:
        try:
            # Submission reservation has finished and released its operation
            # mutex. Host input/CV/automation fences run before any backend call.
            await run_in_threadpool(admission_guard)
        except BaseException:
            await run_in_threadpool(operations.release_submission, operation['operation_id'], owner=owner, fencing_token=fence)
            raise
    try:
        queued = await get_task_backend().enqueue_project_task(ctx, product_surface='freezone',
            task_type='remix_analyze_material_speech', queue_kind='default', episode=0,
            scope=operation['operation_id'], payload={**prepared['task_payload'],
                'operation_id': operation['operation_id'], 'node_revision': node_revision})
    except Exception as exc:
        await record_enqueue_exception(operations, operation['operation_id'], owner=owner,
            fencing_token=fence, error=exc)
        raise
    return await run_in_threadpool(operations.bind_task, operation['operation_id'],
        task_id=queued.task_state.task_id, owner=owner, fencing_token=fence)


def read_source_speech_observation(store, ref: dict, *, scope: dict, resource: dict,
                                   language: str, provider_signature: str) -> dict:
    """Validate immutable recognition before candidate correction or C3 adoption.

    The caller derives scope/resource from current authorized host state. Target
    identity and user review receipts remain separate from the raw observation.
    """
    from .material_work import _exact_ref
    _exact_ref(ref)
    _verified_media(store, resource)
    expected = source_speech_key(scope=scope, media_hash=resource['media_hash'],
        stream_index=0, language=language, provider_signature=provider_signature)
    artifact = store.read(ref['artifact_id'], ref['revision'])
    payload = artifact['payload']
    if (scope.get('project_id') != store.project_id or artifact['schema'] != SCHEMA or
            artifact['producer_version'] != PRODUCER or artifact['revision'] != 1 or
            artifact['id'] != expected or payload.get('source_key') != expected or
            payload.get('scope_signature') != _digest(scope) or payload.get('authorization_scope') != scope or
            payload.get('provider_signature') != provider_signature or
            payload.get('resource_signature') != {'media_hash': resource['media_hash'], 'stream_index': 0} or
            payload.get('source_duration_us') != resource['duration_us']):
        raise ValueError('source observation provenance differs')
    return artifact


def reconcile_material_speech(ctx, operation: dict) -> dict | None:
    """Publish a shared durable observation without submitting recognition again."""
    from novelvideo.freezone import canvas_store
    from .store import RemixArtifactStore
    from .operations import RemixOperationStore
    if (operation.get('producer_version') != PRODUCER or not operation.get('task_id') or
            operation.get('status') not in {'pending', 'pending_reconciliation'} or operation.get('cancel_reason')):
        return None
    saved = operation.get('normalized_parameters', {}).get('payload') or {}
    store = RemixArtifactStore(Path(ctx.output_dir), ctx.project_id, created_by=ctx.requester_user_id)
    canvas = canvas_store.read_canvas(Path(ctx.state_dir), saved.get('canvas_id', ''))
    current = prepare_material_speech(store, ctx, canvas, canvas_id=saved.get('canvas_id'),
        work_ref=saved.get('work_ref'), step_id=saved.get('step_id'), node_id=saved.get('node_id'),
        language=saved.get('language'), provider_signature=configured_provider_signature())
    if (current['normalized_parameters'] != operation['normalized_parameters'] or
        operation['input_refs'] != [{**saved['work_ref'], 'project_id': ctx.project_id}]):
        raise ValueError('candidate operation input ownership changed')
    key = source_speech_key(scope=saved['scope'], media_hash=saved['resource']['media_hash'],
        stream_index=0, language=saved['language'], provider_signature=saved['provider_signature'])
    conn = _connection(store)
    try:
        row = conn.execute('SELECT result_json FROM observations WHERE source_key=?', (key,)).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return None
    # A saved raw result is the only path into observe here; provider claims can
    # never be created or reclaimed from the reconciliation endpoint.
    ref = observe_source_speech(store, scope=saved['scope'], resource=saved['resource'],
        language=saved['language'], provider_signature=saved['provider_signature'])
    return RemixOperationStore(store.project_dir, ctx.project_id).publish_result_unverified(
        operation['operation_id'], output_refs=[ref])
