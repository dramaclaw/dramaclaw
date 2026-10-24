"""Server owned production enrollment, generations and bounded observer execution.

All mutations serialize on the existing canvas mutex. Atomic snapshots can be
read by artifact publication guards without acquiring an operation lock. A saved
control is authority only after host authentication; task/model payloads cannot
activate it. Legacy commissions are never enrolled by recovery.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

from novelvideo.project_context import ProjectContext, require_project_home_node
from novelvideo.freezone import canvas_store
from .store import RemixArtifactStore
from .reference_commission import read_reference_commission

logger = logging.getLogger(__name__)
LEASE_SECONDS = 30.0
MAX_OWNED_OPERATIONS = 64


def _scope(ctx, canvas_id, commission_id, agent_id, *, require_write=True):
    if not isinstance(ctx, ProjectContext) or ctx.effective_role not in ({'owner', 'admin', 'editor'} if require_write else {'owner','admin','editor','viewer'}):
        raise PermissionError('authenticated editor ProjectContext required')
    require_project_home_node(ctx, operation='production automation')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', canvas_id) or not isinstance(commission_id, str) or not commission_id or not isinstance(agent_id, str) or not agent_id:
        raise ValueError('production automation identity required')
    return {'project_id': ctx.project_id, 'requester_user_id': ctx.requester_user_id,
            'canvas_id': canvas_id, 'agent_id': agent_id, 'commission_id': commission_id}


def _root(ctx):
    root = Path(ctx.output_dir).resolve() / 'freezone' / '_remix_operations' / 'production_controls'
    for path in (root.parent.parent, root.parent, root):
        if path.is_symlink():
            raise ValueError('invalid production control storage')
    return root


def _key(scope):
    return hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _read(ctx, scope):
    path = _root(ctx) / (_key(scope) + '.json')
    if path.is_symlink():
        raise ValueError('invalid production control file')
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    if record.get('scope') != scope:
        raise PermissionError('production control scope differs')
    return record


def _write(path, record, guard):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.production-control-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream, sort_keys=True, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        guard.reassert()
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


@contextmanager
def _canvas_lock(ctx, canvas_id, canvas_guard=None):
    if canvas_guard is not None:
        canvas_guard.reassert()
        yield canvas_guard
    else:
        with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
            yield guard


def _authorize(ctx, scope, commission_ref, *, saved_commission=None):
    from .source_speech import candidate_scope
    canvas = canvas_store.read_canvas(ctx.state_dir, scope['canvas_id'])
    if not canvas or canvas.get('canvas_id') != scope['canvas_id']:
        raise PermissionError('production canvas unavailable')
    candidate_scope(ctx, canvas, scope['canvas_id'])
    commission = saved_commission or read_reference_commission(RemixArtifactStore(ctx.output_dir, ctx.project_id), commission_ref, latest=True)
    if (commission['canvas_id'], commission['requester_user_id']) != (scope['canvas_id'], ctx.requester_user_id):
        raise PermissionError('production commission belongs to another actor or canvas')
    return commission


def read_production_control(ctx, *, canvas_id, commission_id, agent_id='main', _require_write=True):
    """Atomic read, safe inside the canvas -> artifact publication critical path."""
    return _read(ctx, _scope(ctx, canvas_id, commission_id, agent_id, require_write=_require_write))


def _inherit_current_source_operations(ctx, scope, commission, old):
    """Explicit new intent may own an existing native result with current inputs."""
    from .operations import RemixOperationStore
    from .source_speech import candidate_scope
    if not old or not commission.get('plan_ref') or not commission.get('work_ref'):
        return {}
    canvas = canvas_store.read_canvas(ctx.state_dir, scope['canvas_id'])
    host_scope = candidate_scope(ctx, canvas, scope['canvas_id'])
    exact = lambda ref: (ref.get('artifact_id'), ref.get('revision')) if isinstance(ref, dict) else None
    inherited = {}
    operations = RemixOperationStore(ctx.output_dir, ctx.project_id)
    for operation_id in old.get('owned_operations', []):
        try:
            operation = operations._read(operation_id)  # Atomic read; never invert artifact -> operation locks.
            parameters = operation.get('normalized_parameters') or {}
            packet = parameters.get('payload') or {}
            binding = json.loads((_root(ctx) / ('operation-' + operation_id + '.json')).read_text())
            if (binding.get('scope') != scope or operation.get('producer_version') != 'remix-adopt-source-speech.v1'
                    or parameters.get('action') != 'adopt_source_observation'
                    or operation.get('canvas_id') != scope['canvas_id'] or packet.get('scope') != host_scope
                    or packet.get('requester_user_id') != ctx.requester_user_id
                    or operation.get('status') not in {'pending', 'pending_reconciliation', 'needs_confirmation', 'completed'}
                    or operation.get('cancel_reason') or operation.get('superseded_by')):
                continue
            if operation['status'] == 'completed':
                # Confirmation may precede commission/CV publication. Inherit
                # only a real current owned result still awaiting application.
                run = {'canvas_id': scope['canvas_id'], 'commission_ref': commission['commission_ref']}
                if not owned_source_needs_settlement(ctx, run, operation):
                    continue
                from novelvideo.task_state import get_task_manager
                task = get_task_manager().get_task_for_project(ctx, 'remix_adopt_source_speech', 0, scope=operation_id)
                if task is None or task.task_id != operation.get('task_id') or task.status != 'completed':
                    continue
            elif (exact(packet.get('plan_ref')) != exact(commission['plan_ref'])
                  or exact(packet.get('work_ref')) != exact(commission['work_ref'])):
                continue
            inherited[operation_id] = binding['generation']
        except FileNotFoundError:
            continue
    return inherited


def enroll_production_automation(ctx, *, canvas_id, commission_ref, command_id, agent_id='main', canvas_guard=None, _saved_commission=None):
    """Called only by an explicit host advance/whole-production user request.

    Replaying the same request after STOP does not resume it. A new request
    snapshots the actual current references and increments the control generation.
    """
    if not isinstance(command_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', command_id):
        raise ValueError('explicit automation command identity required')
    scope = _scope(ctx, canvas_id, commission_ref['artifact_id'], agent_id)
    with _canvas_lock(ctx, canvas_id, canvas_guard) as guard:
        commission = _authorize(ctx, scope, commission_ref, saved_commission=_saved_commission)
        old = _read(ctx, scope)
        commands = _root(ctx) / 'enrollments'
        if commands.is_symlink():
            raise ValueError('invalid production enrollment storage')
        command_hash = hashlib.sha256(json.dumps([scope, command_id], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        command_path = commands / (command_hash + '.json')
        if command_path.exists() or (old and command_id in old.get('enrollment_commands', [])):
            # Durable request identity outlives the bounded presentation list.
            # An interrupted enrollment remains conservative until a new explicit
            # request; a replay must never overrule a later persisted stop.
            return old or {'scope': scope, 'active': False, 'generation': 0}
        inherited = _inherit_current_source_operations(ctx, scope, commission, old)
        record = {'scope': scope, 'active': True, 'generation': (old or {}).get('generation', 0) + 1,
            'commission_ref': commission['commission_ref'], 'plan_ref': commission.get('plan_ref'),
            'work_ref': commission.get('work_ref'), 'enrollment_commands': [*((old or {}).get('enrollment_commands', [])), command_id][-128:],
            'owned_operations': list(inherited), 'inherited_operations': inherited, 'event_receipts': [], 'event_replays': 0, 'lease_owner': '', 'lease_until': 0,
            'updated_at': time.time()}
        _write(command_path, {'scope': scope, 'generation': record['generation']}, guard)
        _write(_root(ctx) / (_key(scope) + '.json'), record, guard)
        return record


def stop_production_automation(ctx, *, canvas_id, commission_ref, agent_id='main', canvas_guard=None):
    """Persist stop intent first. No paid/native task is cancelled by this gate."""
    scope = _scope(ctx, canvas_id, commission_ref['artifact_id'], agent_id)
    with _canvas_lock(ctx, canvas_id, canvas_guard) as guard:
        commission = _authorize(ctx, scope, commission_ref)
        old = _read(ctx, scope) or {'scope': scope, 'generation': 0, 'commission_ref': commission['commission_ref'],
            'owned_operations': [], 'enrollment_commands': [], 'event_receipts': []}
        record = {**old, 'active': False, 'lease_owner': '', 'lease_until': 0, 'updated_at': time.time()}
        _write(_root(ctx) / (_key(scope) + '.json'), record, guard)
        if commission.get('plan_branches'):
            from novelvideo.chat.reference_production_observer import _branch_commissions
            children = _branch_commissions(RemixArtifactStore(ctx.output_dir, ctx.project_id), commission)
            for child in children:
                child_id = child['commission_ref']['artifact_id']
                if read_production_control(ctx, canvas_id=canvas_id, commission_id=child_id, agent_id=agent_id):
                    stop_production_automation(ctx, canvas_id=canvas_id, commission_ref=child['commission_ref'],
                        agent_id=agent_id, canvas_guard=guard)
        return record


def enroll_registered_branch_controls(ctx, *, canvas_id, parent_ref, agent_id='main'):
    """Only authenticated registered descendants inherit explicit group intent."""
    scope = _scope(ctx, canvas_id, parent_ref['artifact_id'], agent_id)
    with _canvas_lock(ctx, canvas_id) as guard:
        parent_control = _read(ctx, scope)
        if not parent_control or not parent_control['active']:
            return []
        parent = _authorize(ctx, scope, parent_ref)
        from novelvideo.chat.reference_production_observer import _branch_commissions
        children = _branch_commissions(RemixArtifactStore(ctx.output_dir, ctx.project_id), parent)
        controls = []
        for child in children:
            identity = [scope, parent_control['generation'], child['commission_ref']['artifact_id']]
            command = 'branch-' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
            controls.append(enroll_production_automation(ctx, canvas_id=canvas_id, commission_ref=child['commission_ref'],
                command_id=command, agent_id=agent_id, canvas_guard=guard, _saved_commission=child))
        return controls


def assert_production_automation_current(ctx, *, canvas_id, commission_id, agent_id='main', generation=None):
    """Read-only fence. Invoke while holding and reasserting the canvas lease."""
    control = read_production_control(ctx, canvas_id=canvas_id, commission_id=commission_id, agent_id=agent_id)
    if control and not control['active']:
        raise ValueError('production automation stopped')
    if generation is not None and (not control or control['generation'] != generation):
        raise ValueError('production automation generation changed')
    return control


def bind_automation_operation(ctx, *, canvas_id, commission_id, generation, operation_id, agent_id='main', canvas_guard=None):
    """Bind host operation identity before enqueue, never trust task payload ownership."""
    from .operations import RemixOperationStore
    scope = _scope(ctx, canvas_id, commission_id, agent_id)
    if not re.fullmatch(r'[a-f0-9]{32}', operation_id):
        raise ValueError('invalid automation operation identity')
    with _canvas_lock(ctx, canvas_id, canvas_guard) as guard:
        record = assert_production_automation_current(ctx, canvas_id=canvas_id, commission_id=commission_id,
            agent_id=agent_id, generation=generation)
        operation = RemixOperationStore(ctx.output_dir, ctx.project_id)._read(operation_id)
        if operation.get('canvas_id') != canvas_id:
            raise PermissionError('automation operation canvas differs')
        packet = operation.get('normalized_parameters', {}).get('payload') or {}
        if packet.get('requester_user_id', ctx.requester_user_id) != ctx.requester_user_id:
            raise PermissionError('automation operation actor differs')
        binding_path = _root(ctx) / ('operation-' + operation_id + '.json')
        binding = {'scope': scope, 'generation': generation, 'operation_id': operation_id}
        if binding_path.is_file() and json.loads(binding_path.read_text()) != binding:
            raise ValueError('automation operation already belongs to another generation')
        _write(binding_path, binding, guard)
        owned = list(record.get('owned_operations', []))
        if operation_id not in owned:
            if len(owned) >= MAX_OWNED_OPERATIONS:
                raise ValueError('production automation operation capacity requires explicit continuation')
            owned.append(operation_id)
        _write(_root(ctx) / (_key(scope) + '.json'), {**record, 'owned_operations': owned}, guard)
        return binding


def assert_operation_automation_current(ctx, operation_id):
    """Publication fence reads only atomic durable identities, with no op lock.

    C3 must call this at every artifact publication reassert while its canvas
    lease is held. Unowned legacy operations retain their original behavior.
    """
    if not re.fullmatch(r'[a-f0-9]{32}', operation_id):
        raise ValueError('invalid automation operation identity')
    path = _root(ctx) / ('operation-' + operation_id + '.json')
    if not path.exists():
        return None
    if path.is_symlink():
        raise ValueError('invalid automation operation binding')
    binding = json.loads(path.read_text())
    scope = binding['scope']
    if scope.get('project_id') != ctx.project_id or scope.get('requester_user_id') != ctx.requester_user_id or binding.get('operation_id') != operation_id:
        raise PermissionError('automation operation belongs to another actor')
    current = read_production_control(ctx, canvas_id=scope['canvas_id'], commission_id=scope['commission_id'], agent_id=scope['agent_id'])
    generation = binding['generation']
    if (current and current.get('active') and operation_id in current.get('owned_operations', [])
            and current.get('inherited_operations', {}).get(operation_id) == generation):
        generation = current['generation']
    return assert_production_automation_current(ctx, canvas_id=scope['canvas_id'], commission_id=scope['commission_id'],
        agent_id=scope['agent_id'], generation=generation)


def claim_automation_event(ctx, *, canvas_id, commission_id, generation, event_key, owner, agent_id='main'):
    scope = _scope(ctx, canvas_id, commission_id, agent_id)
    with _canvas_lock(ctx, canvas_id) as guard:
        record = assert_production_automation_current(ctx, canvas_id=canvas_id, commission_id=commission_id,
            agent_id=agent_id, generation=generation)
        if event_key in record.get('event_receipts', []):
            _write(_root(ctx) / (_key(scope) + '.json'), {**record, 'event_replays': record.get('event_replays', 0) + 1}, guard)
            return None
        if record.get('lease_owner') and record.get('lease_until', 0) > time.time():
            return None
        claim = {**record, 'lease_owner': owner, 'lease_until': time.time() + LEASE_SECONDS,
                 'event_key': event_key, 'lease_token': uuid.uuid4().hex}
        _write(_root(ctx) / (_key(scope) + '.json'), claim, guard)
        return claim


def assert_automation_event_current(ctx, claim):
    """Atomic read-only observer lease fence; queued native workers use generation."""
    scope = _scope(ctx, claim['scope']['canvas_id'], claim['scope']['commission_id'], claim['scope']['agent_id'])
    if claim['scope'] != scope:
        raise PermissionError('automation event lease scope differs')
    record = _read(ctx, scope)
    if (not record or not record['active'] or record['generation'] != claim['generation']
            or record.get('lease_owner') != claim.get('lease_owner')
            or record.get('lease_token') != claim.get('lease_token')
            or record.get('lease_until', 0) <= time.time()):
        raise ValueError('production automation event lease expired or replaced')
    return record


def finish_automation_event(ctx, claim, *, owner, consumed=True):
    scope = _scope(ctx, claim['scope']['canvas_id'], claim['scope']['commission_id'], claim['scope']['agent_id'])
    with _canvas_lock(ctx, scope['canvas_id']) as guard:
        record = _read(ctx, scope)
        if not record or not record['active'] or record['generation'] != claim['generation'] or record.get('lease_owner') != owner or record.get('lease_token') != claim.get('lease_token') or record.get('lease_until', 0) <= time.time():
            return False
        receipts = list(record.get('event_receipts', []))
        if consumed and claim['event_key'] not in receipts:
            receipts.append(claim['event_key'])
        _write(_root(ctx) / (_key(scope) + '.json'), {**record, 'lease_owner': '', 'lease_until': 0,
            'event_receipts': receipts[-128:]}, guard)
        return True


def _read_automation_state(ctx, run, runs):
    from .production_inventory import read_current_production
    scope = _scope(ctx, run['canvas_id'], run['commission_ref']['artifact_id'], run.get('agent_id', 'main'))
    with _canvas_lock(ctx, scope['canvas_id']) as guard:
        _authorize(ctx, scope, run['commission_ref'])
        canvas = canvas_store.read_canvas(ctx.state_dir, scope['canvas_id'])
        store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
        guard.reassert()
        return read_current_production(store, canvas=canvas, canvas_id=scope['canvas_id'],
            agent_id=scope['agent_id'], requester_user_id=ctx.requester_user_id, runs=runs,
            state_dir=ctx.state_dir, commission_id=scope['commission_id'])


def _prepare_next_candidate_check(ctx, run, state):
    """Inspect available current speech candidates before their human review."""
    from .source_speech import (prepare_material_speech, source_speech_key,
        read_source_speech_observation, unresolved_source_speech_claim)
    if not state.get('plan_ref') or not state.get('work_ref') or state.get('phase') not in {'preparing_materials', 'aligning_speech'}:
        return None
    if state.get('plan_review_valid') is False or any(b.get('kind') in {'plan_edit_conflict', 'review_production_plan', 'selected_work_unavailable'} for b in state.get('blockers', [])):
        return None
    with _canvas_lock(ctx, run['canvas_id']) as guard:
        canvas = canvas_store.read_canvas(ctx.state_dir, run['canvas_id'])
        store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
        work = store.read_latest(state['work_ref']['artifact_id'])
        ref = {'artifact_id': work['id'], 'revision': work['revision']}
        control = (read_production_control(ctx, canvas_id=run['canvas_id'], commission_id=run['commission_ref']['artifact_id'],
            agent_id=run.get('agent_id', 'main')) if run.get('commission_ref') else None)
        for step in work['payload']['steps']:
            if not step.get('node_id') or step['status'] in {'rejected', 'stale'}:
                continue
            relevant = [r for r in work['payload']['requirements'] if r['final_step_id'] == step['id']]
            if not any(r.get('turn_ids') or r.get('take_ids') for r in relevant):
                continue
            try:
                prepared = prepare_material_speech(store, ctx, canvas, canvas_id=run['canvas_id'],
                    work_ref=ref, step_id=step['id'], node_id=step['node_id'], language='auto')
                packet = prepared['task_payload']
                if control:
                    event = hashlib.sha256(json.dumps([control['generation'], None, ['candidate-check', prepared['normalized_parameters']]],
                        sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                    if event in control.get('event_receipts', []):
                        continue  # An accepted check does not serialize independent sources.
                key = source_speech_key(scope=packet['scope'], media_hash=packet['resource']['media_hash'],
                    stream_index=0, language=packet['language'], provider_signature=packet['provider_signature'])
                try:
                    read_source_speech_observation(store, {'artifact_id':key, 'revision':1}, scope=packet['scope'],
                        resource=packet['resource'], language=packet['language'], provider_signature=packet['provider_signature'])
                    continue
                except FileNotFoundError:
                    pass
                if unresolved_source_speech_claim(store, key):
                    continue  # The provider outcome is still unclaimed; retrying would only fail again.
                guard.reassert()
                return prepared
            except (ValueError, FileNotFoundError):
                continue
    return None


def _prepare_next_adoption(ctx, run, state):
    """Targeted deterministic source lookup; no historical artifact/operation scan."""
    from .source_speech import candidate_scope, configured_provider_signature, source_speech_key
    from .source_speech_adoption import prepare_source_observation_adoption
    if state.get('phase') != 'aligning_speech' or not state.get('plan_ref') or not state.get('work_ref'):
        return None
    with _canvas_lock(ctx, run['canvas_id']) as guard:
        canvas = canvas_store.read_canvas(ctx.state_dir, run['canvas_id'])
        scope = candidate_scope(ctx, canvas, run['canvas_id'])
        store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
        plan = store.read(state['plan_ref']['artifact_id'], state['plan_ref']['revision'])['payload']
        ready_turns = {c['turn_id'] for c in plan.get('speech_cues', []) if c.get('timing_status') == 'ready'}
        for take in plan.get('speech_takes', []):
            if set(take['turn_ids']) <= ready_turns:
                continue
            resource = next(r for r in plan['resources'] if r['id'] == take['resource_id'])
            key = source_speech_key(scope=scope, media_hash=resource['media_hash'], stream_index=0,
                language='auto', provider_signature=configured_provider_signature())
            try:
                # This is C1's automatic candidate identity, recomputed from host
                # media and config. Missing/manual-language observations wait for
                # their explicit native adoption action rather than guessing.
                store.read(key, 1)
                correction_ref = None
                from .candidate_speech_correction import read_candidate_speech_review
                work = store.read(state['work_ref']['artifact_id'], state['work_ref']['revision'])
                targets = [r for r in work['payload']['requirements'] if take['id'] in r.get('take_ids', [])
                    or take['origin_placement_id'] in r.get('placement_ids', [])]
                for target in targets:
                    step = next(s for s in work['payload']['steps'] if s['id'] == target['final_step_id'])
                    review = read_candidate_speech_review(store, ctx, canvas, canvas_id=run['canvas_id'],
                        work_ref={k: state['work_ref'][k] for k in ('artifact_id','revision')}, step_id=step['id'],
                        node_id=resource['node_id'], observation_ref={'artifact_id':key,'revision':1})
                    correction_ref = review['summary'].get('correction_ref') or correction_ref
                prepared = prepare_source_observation_adoption(store, ctx, canvas, canvas_id=run['canvas_id'],
                    plan_ref={k: state['plan_ref'][k] for k in ('artifact_id', 'revision')}, take_id=take['id'],
                    observation_ref={'artifact_id':key,'revision':1},
                    work_ref={k: state['work_ref'][k] for k in ('artifact_id', 'revision')}, correction_ref=correction_ref)
                guard.reassert()
                return prepared
            except (ValueError, FileNotFoundError):
                continue  # Missing review/word evidence blocks only this take.
    return None


def owned_source_needs_settlement(ctx, run, operation):
    """Read current commission/CV refs without requiring an already-bound plan."""
    if operation.get('producer_version') != 'remix-adopt-source-speech.v1' or operation.get('status') not in {'needs_confirmation', 'completed'}:
        return False
    packet = operation.get('normalized_parameters', {}).get('payload') or {}
    refs = operation.get('output_refs') or []
    if not refs or not refs[0].get('artifact_id'):
        return False
    store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
    commission = read_reference_commission(store, run['commission_ref'], latest=True)
    exact = lambda ref: (ref.get('artifact_id'), ref.get('revision')) if isinstance(ref, dict) else None
    if (commission['requester_user_id'] != ctx.requester_user_id or commission['canvas_id'] != run['canvas_id']
            or packet.get('requester_user_id') != ctx.requester_user_id or packet.get('canvas_id') != run['canvas_id']
            or exact(commission.get('plan_ref')) not in {exact(packet.get('plan_ref')), exact(refs[0])}
            or (commission.get('work_ref') or {}).get('artifact_id') != (packet.get('work_ref') or {}).get('artifact_id')):
        return False
    canvas = canvas_store.read_canvas(ctx.state_dir, run['canvas_id'])
    current = commission.get('plan_ref') or {}
    nodes = [n for n in (canvas or {}).get('nodes', []) if (n.get('data', {}).get('productionPlanV2Ref') or {}).get('artifactId') == refs[0]['artifact_id']]
    applied = exact(current) == exact(refs[0]) and len(nodes) == 1 and nodes[0]['data']['productionPlanV2Ref'].get('revision') == refs[0]['revision']
    return not applied


async def _settle_owned_source(ctx, run, control, operation):
    """A saved native plan precedes its CV binding, so settle before inventory."""
    from .production_advancement import settle_source_adoption
    store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
    commission = await asyncio.to_thread(read_reference_commission, store, run['commission_ref'], latest=True)
    evidence = [control['generation'], commission['commission_ref'], operation['operation_id'], operation['output_refs']]
    event_key = hashlib.sha256(json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    owner = uuid.uuid4().hex
    claim = await asyncio.to_thread(claim_automation_event, ctx, canvas_id=run['canvas_id'],
        commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'),
        generation=control['generation'], event_key=event_key, owner=owner)
    if not claim:
        return False
    consumed = False
    try:
        await settle_source_adoption(ctx, canvas_id=run['canvas_id'], commission_ref=commission['commission_ref'],
            operation_id=operation['operation_id'], agent_id=run.get('agent_id', 'main'),
            automation_generation=control['generation'], automation_event=claim)
        consumed = True
        return True
    finally:
        await asyncio.to_thread(finish_automation_event, ctx, claim, owner=owner, consumed=consumed)
        logger.debug('Reference automation commission_id=%s operation_id=%s event_key=%s stage=source_adoption_settlement outcome=%s',
            control['scope']['commission_id'], operation['operation_id'], event_key, 'advanced' if consumed else 'deferred')


async def advance_enrolled_production(ctx, run, *, runs):
    """At most one native action on the existing bounded observer wake.

    Native services retain their own canvas CAS, current approvals, task quotas,
    admission fencing and paid provider uncertainty rules. No model/provider call
    is made here. Generation is rechecked by those services under their mutex.
    """
    from .production_advancement import advance_production, select_next_action, enqueue_source_observation_adoption
    from .operations import RemixOperationStore
    control = await asyncio.to_thread(read_production_control, ctx, canvas_id=run['canvas_id'],
        commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'))
    if not control or not control['active']:
        return False
    operations = RemixOperationStore(ctx.output_dir, ctx.project_id)
    # These exact native IDs belong to this explicit generation. Their plan
    # result may legitimately be ahead of CV/commission during reconciliation.
    for operation_id in control.get('owned_operations', []):
        operation = await asyncio.to_thread(operations.get, operation_id)
        if await asyncio.to_thread(owned_source_needs_settlement, ctx, run, operation):
            return await _settle_owned_source(ctx, run, control, operation)
    state = await asyncio.to_thread(_read_automation_state, ctx, run, runs)
    if state.get('execution_status') == 'stopped':
        return False
    check = await asyncio.to_thread(_prepare_next_candidate_check, ctx, run, state)
    action = select_next_action(state)
    prepared = None
    if not check and (not action or action.get('owner') != 'system') and state.get('phase') == 'aligning_speech':
        # Global creative conflicts still stop mutation. Human review of another
        # candidate does not prevent a fully accepted independent take proceeding.
        if any(b.get('kind') in {'plan_edit_conflict','review_production_plan','selected_work_unavailable'} for b in state.get('blockers', [])):
            return False
        prepared = await asyncio.to_thread(_prepare_next_adoption, ctx, run, state)
    if not check and not prepared and (not action or action.get('owner') != 'system'):
        return False
    identity = ['candidate-check', check['normalized_parameters']] if check else ['adopt', prepared['task_payload']['take_id']] if prepared else action
    event_key = hashlib.sha256(json.dumps([control['generation'],None if check else state['projection_revision'],identity], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    owner = uuid.uuid4().hex
    claim = await asyncio.to_thread(claim_automation_event, ctx, canvas_id=run['canvas_id'],
        commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'),
        generation=control['generation'], event_key=event_key, owner=owner)
    if not claim:
        return False
    consumed = False
    started = time.monotonic()
    outcome = 'deferred'
    try:
        if check:
            from .source_speech import enqueue_material_speech
            mutex = canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, run['canvas_id'])
            guard = await asyncio.to_thread(mutex.__enter__)
            try:
                assert_production_automation_current(ctx, canvas_id=run['canvas_id'], commission_id=run['commission_ref']['artifact_id'],
                    agent_id=run.get('agent_id', 'main'), generation=control['generation'])
                guard.reassert()
                assert_automation_event_current(ctx, claim)
                candidate_store = RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id)
                def admission_guard():
                    from .source_speech import prepare_material_speech
                    guard.reassert()
                    assert_production_automation_current(ctx, canvas_id=run['canvas_id'], commission_id=run['commission_ref']['artifact_id'],
                        agent_id=run.get('agent_id', 'main'), generation=control['generation'])
                    assert_automation_event_current(ctx, claim)
                    packet = check['task_payload']
                    actual_canvas = canvas_store.read_canvas(ctx.state_dir, run['canvas_id'])
                    current = prepare_material_speech(candidate_store, ctx, actual_canvas, canvas_id=run['canvas_id'],
                        work_ref=packet['work_ref'], step_id=packet['step_id'], node_id=packet['node_id'], language=packet['language'],
                        _automatic_only=True)
                    if current != check:
                        raise ValueError('candidate speech inputs changed before actual admission')
                    guard.reassert()
                    assert_automation_event_current(ctx, claim)
                result = await enqueue_material_speech(ctx, candidate_store,
                    check, command_id='automation-check-' + event_key, node_revision=check['task_payload']['work_ref']['revision'],
                    admission_guard=admission_guard)
                consumed = bool(result.get('task_id') or result.get('status') != 'pending')
            finally:
                await asyncio.to_thread(mutex.__exit__, None, None, None)
        elif prepared:
            result = await enqueue_source_observation_adoption(ctx, RemixArtifactStore(ctx.output_dir, ctx.project_id, created_by=ctx.requester_user_id),
                prepared, command_id='automation-' + event_key, node_revision=prepared['task_payload']['plan_ref']['revision'],
                automation_control=control, automation_event=claim)
            consumed = bool(result.get('task_id') or result.get('status') != 'pending')
        else:
            result = await advance_production(ctx, canvas_id=run['canvas_id'], commission_ref=state['commission_ref'],
                expected_projection_revision=state['projection_revision'], command_id='automation-' + event_key,
                agent_id=run.get('agent_id', 'main'), automation_generation=control['generation'], automation_event=claim)
            consumed = bool(result.get('advancement', {}).get('action'))
        outcome = 'advanced' if consumed else 'waiting_result'
        return consumed
    finally:
        await asyncio.to_thread(finish_automation_event, ctx, claim, owner=owner, consumed=consumed)
        logger.debug('Reference automation commission_id=%s work_id=%s step_id=%s operation_id=%s event_key=%s stage=%s outcome=%s elapsed_ms=%.1f',
            control['scope']['commission_id'], (state.get('work_ref') or {}).get('artifact_id'),
            (check or {}).get('task_payload', {}).get('step_id'), None, event_key, state.get('phase'), outcome,
            (time.monotonic() - started) * 1000)
