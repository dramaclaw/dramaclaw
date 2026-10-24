"""Versioned creative decisions for one reference-derived production branch.

Decision evidence is supplied by authenticated host code, never deserialized
from model/tool arguments. Saved receipts bind the exact direction or plan.
"""
from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal, TYPE_CHECKING
from pydantic import BaseModel, ConfigDict, Field, model_validator
if TYPE_CHECKING:
    from .store import RemixArtifactStore


@dataclass(frozen=True)
class AuthenticatedDecisionEvidence:
    project_id: str
    canvas_id: str
    requester_user_id: str
    message_id: str
    message_content: str | None = None


@dataclass(frozen=True)
class AuthenticatedMaterialCreationEvidence:
    project_id: str
    canvas_id: str
    requester_user_id: str


class MaterialWorkAssociationInterrupted(RuntimeError):
    def __init__(self, work_ref):
        super().__init__('material work saved; association did not complete')
        self.work_ref = work_ref


def _plan_approval_receipts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Find original scoped approvals; later media/timing revisions keep their receipt."""
    plan_ref = payload.get('plan_ref') or {}
    return [row for row in payload['decisions']
            if row.get('type') == 'plan_confirmed'
            and row.get('direction_revision') == payload['direction_revision']
            and isinstance(row.get('message_id'), str) and row['message_id'].strip()
            and (row.get('project_id'), row.get('canvas_id'), row.get('requester_user_id'))
            == (payload['project_id'], payload['canvas_id'], payload['requester_user_id'])
            and (row.get('plan_ref') or {}).get('artifact_id') == plan_ref.get('artifact_id')
            and (row.get('plan_ref') or {}).get('project_id', payload['project_id']) == payload['project_id']
            and isinstance((row.get('plan_ref') or {}).get('revision'), int)
            and not isinstance(row['plan_ref']['revision'], bool)
            and 1 <= row['plan_ref']['revision'] <= plan_ref.get('revision', 0)]


class ReferenceCommission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal['reference_commission.v1'] = 'reference_commission.v1'
    project_id: str = Field(min_length=1)
    canvas_id: str = Field(min_length=1)
    requester_user_id: str = Field(min_length=1)
    analysis_node_id: str = Field(min_length=1)
    analysis_evidence: dict[str, Any]
    goal: str = Field(min_length=1)
    production_scope: Literal['仅作品方案', '可编辑合成', '预览成片', '导出成片'] = '可编辑合成'
    phase: Literal['awaiting_direction', 'drafting_plan', 'awaiting_plan_review', 'awaiting_plan_confirmation', 'preparing_materials', 'aligning_speech', 'composing', 'reviewing_output', 'completed'] = 'awaiting_direction'
    direction: dict[str, Any] | None = None
    direction_revision: int = Field(default=0, ge=0)
    direction_fingerprint: str | None = None
    review_ref: dict[str, Any] | None = None
    plan_ref: dict[str, Any] | None = None
    work_ref: dict[str, Any] | None = None
    manifest_ref: dict[str, Any] | None = None
    output_review_ref: dict[str, Any] | None = None
    parent_commission_ref: dict[str, Any] | None = None
    plan_branches: list[dict[str, Any]] = Field(default_factory=list)
    decisions: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode='after')
    def evidence_and_phase(self):
        if not self.analysis_evidence.get('result_fingerprint') or not (self.analysis_evidence.get('task_id') or self.analysis_evidence.get('adopted_node')):
            raise ValueError('commission requires real analysis evidence')
        if self.phase != 'awaiting_direction' and (not self.direction or self.direction_revision < 1):
            raise ValueError('confirmed direction required')
        if self.direction is not None:
            fingerprint = hashlib.sha256(json.dumps(self.direction, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if self.direction_fingerprint != fingerprint or not any(
                row.get('type') == 'direction_confirmed' and row.get('direction_revision') == self.direction_revision
                and row.get('direction') == self.direction and row.get('message_id')
                and (row.get('project_id'), row.get('canvas_id'), row.get('requester_user_id')) == (self.project_id, self.canvas_id, self.requester_user_id)
                for row in self.decisions):
                raise ValueError('confirmed direction requires matching host decision receipt')
        if self.phase == 'awaiting_plan_confirmation' and not self.review_ref:
            raise ValueError('saved passing review required')
        if self.phase in {'preparing_materials', 'aligning_speech', 'composing', 'reviewing_output', 'completed'} and self.plan_ref:
            if not self.review_ref or not _plan_approval_receipts(self.model_dump(mode='json')):
                raise ValueError('confirmed plan requires matching host decision receipt')
        if self.phase in {'awaiting_plan_confirmation', 'preparing_materials'} and not self.plan_ref:
            raise ValueError('saved plan required')
        return self


_PRODUCTION_PHASES = {'preparing_materials', 'aligning_speech', 'composing', 'reviewing_output', 'completed'}
_REVIEW_RECEIVING_PHASES = {'awaiting_plan_review', *_PRODUCTION_PHASES}


_ACTIONS = {
    'awaiting_direction': {'owner': 'agent', 'kind': 'discuss_direction', 'tool': None},
    'drafting_plan': {'owner': 'agent', 'kind': 'prepare_production_nodes', 'tool': 'freezone_prepare_production_nodes'},
    'awaiting_plan_review': {'owner': 'agent', 'kind': 'review_production_plan', 'tool': 'freezone_review_production_plan'},
    'awaiting_plan_confirmation': {'owner': 'user', 'kind': 'request_plan_confirmation', 'tool': None},
    'preparing_materials': {'owner': 'agent', 'kind': 'prepare_material_work_package', 'tool': None},
    'aligning_speech': {'owner': 'agent', 'kind': 'align_adopted_speech', 'tool': None},
    'composing': {'owner': 'agent', 'kind': 'compile_and_preview', 'tool': None},
    'reviewing_output': {'owner': 'agent', 'kind': 'review_output', 'tool': None},
    'completed': {'owner': 'agent', 'kind': 'deliver_output', 'tool': None},
}


def _result(artifact: dict[str, Any]) -> dict[str, Any]:
    payload = artifact['payload']
    return {**payload, 'commission_ref': {'artifact_id': artifact['id'], 'revision': artifact['revision'], 'project_id': artifact['project_id']},
            'next_action': _ACTIONS[payload['phase']]}


def create_reference_commission(store: RemixArtifactStore, *, canvas_id: str, requester_user_id: str,
                                analysis_node_id: str, goal: str, analysis_evidence: dict[str, Any], production_scope: str = '可编辑合成') -> dict[str, Any]:
    payload = ReferenceCommission(project_id=store.project_id, canvas_id=canvas_id, requester_user_id=requester_user_id,
                                  analysis_node_id=analysis_node_id, goal=goal, analysis_evidence=analysis_evidence, production_scope=production_scope).model_dump(mode='json')
    return _result(store.create('reference_commission.v1', payload, []))


def read_reference_commission(store: RemixArtifactStore, commission_ref: dict[str, Any], *, latest: bool = False) -> dict[str, Any]:
    if commission_ref.get('project_id', store.project_id) != store.project_id:
        raise ValueError('Cross-project commission reference')
    artifact = store.read_latest(commission_ref['artifact_id']) if latest else store.read(commission_ref['artifact_id'], commission_ref['revision'])
    if artifact['schema'] != 'reference_commission.v1':
        raise ValueError('reference is not a commission')
    result = _result(artifact)
    if result['phase'] == 'drafting_plan' and result.get('plan_ref'):
        from .production_review import is_unarranged_outline
        plan = store.read(result['plan_ref']['artifact_id'], result['plan_ref']['revision'])
        if is_unarranged_outline(plan['payload']):
            result.update(authoring_stage='outline', next_action={
                'owner': 'agent', 'kind': 'inspect_outline', 'tool': None})
    return result


def advance_reference_commission(store: RemixArtifactStore, commission_ref: dict[str, Any], event: dict[str, Any],
                                 expected_revision: int, *, host_evidence: AuthenticatedDecisionEvidence | None = None,
                                 canvas: dict[str, Any] | None = None, _amended_plan_ref: dict | None = None) -> dict[str, Any]:
    from .store import RemixArtifactConflict
    if event.get('type') == 'plan_confirmed':
        from .production_advancement import _MutationStore

        # Keep the exact plan check and approval publication in one artifact
        # lease. Host mutation adapters already hold that lease; no canvas
        # lock is acquired and production timing refinements remain unchanged.
        if not isinstance(store, _MutationStore):
            with store._locked() as guard:
                return advance_reference_commission(
                    _MutationStore(store, guard), commission_ref, event, expected_revision,
                    host_evidence=host_evidence, canvas=canvas,
                )
    if event.get('type') == 'material_work_selected':
        if host_evidence is None:
            raise PermissionError('Authenticated host selection evidence required')
        if commission_ref.get('revision') != expected_revision:
            raise RemixArtifactConflict('Commission changed; reload before selecting material work')
        return select_material_work(store, commission_ref, event.get('work_ref'), event.get('command_id'),
                                    host_evidence=host_evidence, canvas=canvas)
    current = read_reference_commission(store, commission_ref, latest=True)
    if current['commission_ref']['revision'] != expected_revision or commission_ref['revision'] != expected_revision:
        raise RemixArtifactConflict('Commission changed; reload before deciding')
    payload = ReferenceCommission.model_validate({key: current[key] for key in ReferenceCommission.model_fields if key in current}).model_dump(mode='json')
    kind = event.get('type')
    refs = []
    if payload.get('parent_commission_ref'):
        refs.append(payload['parent_commission_ref'])
    refs.extend(row['commission_ref'] for row in payload.get('plan_branches', []))
    if kind == 'branches_reopened':
        child_ref = event.get('commission_ref') or {}
        if payload['phase'] != 'completed' or not any(row['commission_ref']['artifact_id'] == child_ref.get('artifact_id') for row in payload.get('plan_branches', [])):
            raise ValueError('group can reopen only for a registered changed branch')
        child = store.read_latest(child_ref['artifact_id'])
        if child['revision'] != child_ref.get('revision') or child['schema'] != 'reference_commission.v1' or child['payload']['phase'] == 'completed' or (child['payload'].get('parent_commission_ref') or {}).get('artifact_id') != commission_ref['artifact_id']:
            raise ValueError('group reopening requires current incomplete child evidence')
        payload['phase'] = 'awaiting_plan_review'
        refs.append(child_ref)
    elif kind == 'branches_completed':
        registered = {row['commission_ref']['artifact_id'] for row in payload.get('plan_branches', [])}
        requested = event.get('commission_refs')
        if not registered or not isinstance(requested, list) or {ref.get('artifact_id') for ref in requested} != registered or len(requested) != len(registered) or payload.get('plan_ref'):
            raise ValueError('group completion requires exactly its registered independent branches')
        for ref in requested:
            child = store.read_latest(ref['artifact_id'])
            data = child['payload']
            if child['revision'] != ref.get('revision') or child['schema'] != 'reference_commission.v1' or data['phase'] != 'completed':
                raise ValueError('branch must be completed at the exact current revision')
            if (data['project_id'], data['canvas_id'], data['requester_user_id'], data['analysis_node_id']) != (payload['project_id'], payload['canvas_id'], payload['requester_user_id'], payload['analysis_node_id']) or (data.get('parent_commission_ref') or {}).get('artifact_id') != commission_ref['artifact_id']:
                raise ValueError('branch completion source or actor differs')
            if not data.get('decisions'):
                raise ValueError('branch requires actual confirmed content')
            plan_ref = data.get('plan_ref') or {}
            plan = store.read_latest(plan_ref.get('artifact_id', ''))
            if plan['schema'] != 'production_plan.v2' or plan['revision'] != plan_ref.get('revision'):
                raise ValueError('completed branch plan is no longer current')
            from .production_review import production_decision_fingerprint
            approved = store.read(data['review_ref']['artifact_id'], data['review_ref']['revision'])
            if approved['payload']['decision_fingerprint'] != production_decision_fingerprint(plan['payload']):
                raise ValueError('completed branch content approval is stale')
            if data['production_scope'] == '仅作品方案':
                if not any(row['type'] == 'plan_confirmed' and row.get('plan_ref') == data['plan_ref'] for row in data['decisions']):
                    raise ValueError('branch requires current plan confirmation')
            else:
                manifest_ref = data.get('manifest_ref') or {}
                manifest = store.read(manifest_ref.get('artifact_id', ''), manifest_ref.get('revision', 0))
                if manifest['schema'] != 'composition_manifest.v2' or manifest['payload']['source_versions'] != [{'artifact_id': plan['id'], 'revision': plan['revision']}]:
                    raise ValueError('completed branch composition is stale')
                from .production_plan_v2 import project_production_plan_v2
                if not project_production_plan_v2(plan['payload'], project_dir=store.project_dir)['ready']:
                    raise ValueError('completed branch media changed')
                if data['production_scope'] == '可编辑合成':
                    if not any(row['type'] == 'editable_composition_confirmed' and row.get('manifest_ref') == data['manifest_ref'] for row in data['decisions']):
                        raise ValueError('branch requires current editable review')
                else:
                    output_ref = data.get('output_review_ref') or {}
                    output_review = store.read(output_ref.get('artifact_id', ''), output_ref.get('revision', 0))
                    if output_review['schema'] != 'production_output_review.v1' or output_review['payload']['status'] != 'passed' or output_review['payload']['manifest_ref'] != manifest_ref:
                        raise ValueError('branch requires current output review')
                    from novelvideo.api.routes.remix_media import _inspect_existing_media
                    inspected = _inspect_existing_media(store.project_dir, output_review['payload']['media']['media_path'])
                    if inspected['media_hash'] != output_review['payload']['media']['media_hash']:
                        raise ValueError('completed encoded output changed')
            refs.append(ref)
        payload['phase'] = 'completed'
    elif kind in {'direction_confirmed', 'plan_confirmed', 'editable_composition_confirmed'}:
        if not isinstance(host_evidence, AuthenticatedDecisionEvidence) or not host_evidence.message_id.strip() or (
            host_evidence.project_id, host_evidence.canvas_id, host_evidence.requester_user_id
        ) != (payload['project_id'], payload['canvas_id'], payload['requester_user_id']):
            raise PermissionError('Authenticated host decision evidence required')
        receipt = {'type': kind, 'project_id': host_evidence.project_id, 'canvas_id': host_evidence.canvas_id,
                   'requester_user_id': host_evidence.requester_user_id, 'message_id': host_evidence.message_id,
                   'commission_revision': expected_revision}
        if kind == 'direction_confirmed':
            direction = event.get('direction')
            if not isinstance(direction, dict) or not direction:
                raise ValueError('direction must describe the confirmed creative choice')
            from .direction_contract import resolve_direction_review_contract
            resolve_direction_review_contract(direction)
            if 'requirements' in direction:
                from .production_requirements import snapshot_confirmed_dialogue
                # Amendment flow: user confirmed via authenticated channel, skip message_content check
                direction = snapshot_confirmed_dialogue(direction, previous=payload.get('direction'),
                    message_content=host_evidence.message_content, _amendment=_amended_plan_ref is not None)
            if _amended_plan_ref is not None and _amended_plan_ref != payload.get('plan_ref'):
                raise ValueError('amendment must preserve the already bound plan')
            kept_plan = _amended_plan_ref or (payload['plan_ref'] if payload.get('parent_commission_ref') else None)
            # Amendment flow: preserve review and work refs so the production can
            # continue without losing the already-approved plan review.
            if _amended_plan_ref is not None:
                payload.update(direction=direction, direction_revision=payload['direction_revision'] + 1, plan_ref=kept_plan, manifest_ref=None, output_review_ref=None, plan_branches=[], direction_fingerprint=hashlib.sha256(json.dumps(direction, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), phase='awaiting_plan_review')
            else:
                payload.update(direction=direction, direction_revision=payload['direction_revision'] + 1, plan_ref=kept_plan, review_ref=None, work_ref=None, manifest_ref=None, output_review_ref=None, plan_branches=[], direction_fingerprint=hashlib.sha256(json.dumps(direction, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), phase='drafting_plan')
            receipt.update(direction=direction, direction_revision=payload['direction_revision'])
        elif kind == 'plan_confirmed':
            if payload['phase'] != 'awaiting_plan_confirmation' or event.get('plan_ref') != payload['plan_ref']:
                raise ValueError('decision must match the exact saved plan awaiting confirmation')
            saved_plan = store.read_latest(payload['plan_ref']['artifact_id'])
            from .production_review import production_decision_fingerprint
            review = store.read(payload['review_ref']['artifact_id'], payload['review_ref']['revision'])
            if (saved_plan['revision'] != payload['plan_ref']['revision']
                    or production_decision_fingerprint(saved_plan['payload']) != review['payload']['decision_fingerprint']):
                raise RemixArtifactConflict('Plan content changed; review and confirm the current revision')
            payload['plan_ref'] = {'artifact_id': saved_plan['id'], 'revision': saved_plan['revision'], 'project_id': store.project_id}
            payload['phase'] = 'completed' if payload['production_scope'] == '仅作品方案' else 'preparing_materials'
            receipt['plan_ref'] = payload['plan_ref']
            receipt['direction_revision'] = payload['direction_revision']
        else:
            if payload['phase'] != 'reviewing_output' or payload['production_scope'] != '可编辑合成' or event.get('manifest_ref') != payload['manifest_ref']:
                raise ValueError('editable composition decision must match the requested current manifest')
            manifest = store.read(payload['manifest_ref']['artifact_id'], payload['manifest_ref']['revision'])
            plan = store.read_latest(payload['plan_ref']['artifact_id'])
            if manifest['payload']['source_versions'] != [{'artifact_id': plan['id'], 'revision': plan['revision']}]:
                raise RemixArtifactConflict('Composition changed; inspect the current editable production')
            from .production_plan_v2 import project_production_plan_v2
            projection = project_production_plan_v2(plan['payload'], project_dir=store.project_dir)
            if not projection['ready']:
                raise ValueError('editable composition has changed or unavailable media')
            payload['phase'] = 'completed'
            receipt['manifest_ref'] = payload['manifest_ref']
        payload['decisions'] = [*payload['decisions'], receipt]
    elif kind == 'plan_ready':
        if payload['phase'] == 'awaiting_direction':
            raise ValueError('confirm direction before preparing a plan')
        ref = event.get('plan_ref')
        try:
            if not isinstance(ref, dict) or ref.get('project_id', store.project_id) != store.project_id:
                raise ValueError('invalid scope')
            plan = store.read(ref['artifact_id'], ref['revision'])
            if plan['schema'] != 'production_plan.v2':
                raise ValueError('invalid schema')
        except (KeyError, ValueError, FileNotFoundError) as exc:
            raise ValueError('plan_ready requires a saved production_plan.v2') from exc
        if store.read_latest(ref['artifact_id'])['revision'] != ref['revision']:
            raise RemixArtifactConflict('Plan changed; use its current revision')
        plan_ref = {'artifact_id': ref['artifact_id'], 'revision': ref['revision'], 'project_id': store.project_id}
        from .production_review import is_unarranged_outline
        outline_only = is_unarranged_outline(plan['payload'])
        production_phases = {'preparing_materials', 'aligning_speech', 'composing', 'reviewing_output', 'completed'}
        if payload['phase'] in production_phases:
            from .production_review import production_decision_fingerprint
            from .production_requirements import check_production_requirements, resolve_production_requirements
            review = store.read(payload['review_ref']['artifact_id'], payload['review_ref']['revision'])
            previous_plan = store.read(payload['plan_ref']['artifact_id'], payload['plan_ref']['revision'])
            if plan_ref == payload['plan_ref'] or plan['content_hash'] == previous_plan['content_hash']:
                raise ValueError('plan_ready requires changed plan content')
            requirements = (payload['direction'] or {}).get('requirements', {})
            requirement_checks = []
            if requirements:
                locked_turns = None
                if requirements.get('dialogue', {}).get('mode') in {'preserve_source', 'use_confirmed_text'}:
                    locked_turns = resolve_production_requirements(store, commission=current).get('locked_turns')
                requirement_checks = check_production_requirements(
                    plan['payload'], requirements, project_dir=store.project_dir,
                    locked_turns=locked_turns)
            unchanged_creative = (ref['artifact_id'] == payload['plan_ref']['artifact_id']
                                  and production_decision_fingerprint(plan['payload']) == review['payload']['decision_fingerprint']
                                  and all(row['status'] == 'passed' for row in requirement_checks))
            if unchanged_creative:
                # Media/timing refinement retains creative approval. Recompile
                # outputs built from a previous exact plan revision.
                phase = 'composing' if payload['phase'] in {'reviewing_output', 'completed'} else payload['phase']
                payload.update(phase=phase, manifest_ref=None, output_review_ref=None)
                if phase != 'preparing_materials':
                    payload['plan_ref'] = plan_ref
            else:
                payload.update(plan_ref=plan_ref, phase='drafting_plan' if outline_only else 'awaiting_plan_review', review_ref=None,
                               work_ref=None, manifest_ref=None, output_review_ref=None)
        else:
            payload.update(plan_ref=plan_ref, phase='drafting_plan' if outline_only else 'awaiting_plan_review', review_ref=None,
                           work_ref=None, manifest_ref=None, output_review_ref=None)
    elif kind == 'plan_reviewed':
        ref = event.get('review_ref')
        if not isinstance(ref, dict) or payload['phase'] not in _REVIEW_RECEIVING_PHASES:
            raise ValueError('saved review required')
        review = store.read(ref['artifact_id'], ref['revision'])
        review_payload = review['payload']
        source = review_payload.get('plan_ref') or review_payload.get('source_plan_ref')
        latest_plan = store.read_latest(payload['plan_ref']['artifact_id'])
        if (review['schema'] != 'production_review.v1' or source != payload['plan_ref']
                or review_payload.get('status') != 'passed'
                or review_payload.get('direction_fingerprint') != payload['direction_fingerprint']):
            raise ValueError('review must approve the exact saved plan')
        if payload['phase'] in _PRODUCTION_PHASES:
            # A revoked review of unchanged creative content gains its host
            # approval back in place; the original plan confirmation still
            # covers the same decision content, so no second user turn.
            from .production_review import production_decision_fingerprint
            current_plan = store.read(payload['plan_ref']['artifact_id'], payload['plan_ref']['revision'])
            if review_payload.get('decision_fingerprint') != production_decision_fingerprint(current_plan['payload']):
                raise ValueError('changed plan content requires a new user confirmation')
            payload.update(review_ref=ref)
        else:
            if latest_plan['revision'] != payload['plan_ref']['revision']:
                raise ValueError('review must approve the exact saved plan')
            payload.update(review_ref=ref, phase='awaiting_plan_confirmation')
    elif kind == 'materials_invalidated':
        ref = event.get('work_ref') or {}
        work = store.read_latest(ref.get('artifact_id', ''))
        if work['revision'] != ref.get('revision') or work['schema'] != 'material_work_package.v1' or work['payload']['plan_ref']['artifact_id'] != (payload.get('plan_ref') or {}).get('artifact_id'):
            raise ValueError('material invalidation requires current work for this plan')
        if payload.get('work_ref') and payload['work_ref']['artifact_id'] != work['id']:
            raise ValueError('material invalidation belongs to another work package')
        payload.update(work_ref=ref, manifest_ref=None, output_review_ref=None, phase='preparing_materials')
    elif kind in {'materials_ready', 'speech_aligned', 'composition_ready', 'output_reviewed'}:
        from .production_review import production_decision_fingerprint
        plan = store.read_latest(payload['plan_ref']['artifact_id']) if payload['plan_ref'] else None
        review = store.read(payload['review_ref']['artifact_id'], payload['review_ref']['revision']) if payload['review_ref'] else None
        if not plan or not review or production_decision_fingerprint(plan['payload']) != review['payload']['decision_fingerprint']:
            raise ValueError('production requires an unchanged confirmed plan')
        accepted_ref = {'artifact_id': plan['id'], 'revision': plan['revision'], 'project_id': store.project_id}
        if kind != 'materials_ready' and payload.get('work_ref'):
            from .material_work import validate_material_completion
            current_work = store.read_latest(payload['work_ref']['artifact_id'])
            validate_material_completion(store, current_work, plan['payload'])
            payload['work_ref'] = {'artifact_id':current_work['id'],'revision':current_work['revision'],'project_id':store.project_id}
        if kind == 'materials_ready':
            if payload['phase'] != 'preparing_materials':
                raise ValueError('materials completion is out of phase')
            ref = event.get('work_ref') or {}
            if payload.get('work_ref') and ref.get('artifact_id') != payload['work_ref']['artifact_id']:
                raise ValueError('material completion must use the explicitly selected work')
            work = store.read(ref['artifact_id'], ref['revision'])
            if store.read_latest(ref['artifact_id'])['revision'] != ref['revision']:
                raise RemixArtifactConflict('material work changed; use its current accepted revision')
            if work['schema'] != 'material_work_package.v1' or work['payload']['plan_ref']['artifact_id'] != plan['id']:
                raise ValueError('material work belongs to another plan')
            from .material_work import _fingerprint
            if _fingerprint(store, plan['payload'], work['payload']['requirements']) != work['payload']['input_fingerprint']:
                raise ValueError('material requirements changed after preparation')
            from .material_work import validate_material_completion
            validate_material_completion(store, work, plan['payload'])
            steps = {step['id']: step for step in work['payload']['steps']}
            placements = {row['id']: row for row in plan['payload'].get('placements', [])}
            takes = {row['id']: row for row in plan['payload'].get('speech_takes', [])}
            resources = {row['id']: row for row in plan['payload'].get('resources', [])}
            for requirement in work['payload']['requirements']:
                step = steps[requirement['final_step_id']]
                resource = step.get('accepted_resource')
                if step['status'] != 'accepted' or not resource:
                    raise ValueError('final material has not been accepted and bound')
                from .material_work import bindable_placement_ids, binds_final_media
                if binds_final_media(plan['payload'], requirement) and resources.get(resource['id']) != resource:
                    raise ValueError('final material has not been accepted and bound')
                if any(placements[placement_id].get('resource_id') != resource['id']
                       for placement_id in bindable_placement_ids(plan['payload'], requirement)):
                    raise ValueError('final material binding differs from plan')
                if any(takes.get(take_id, {}).get('resource_id') != resource['id']
                       for take_id in requirement.get('take_ids', [])):
                    raise ValueError('final material binding differs from plan')
            payload.update(work_ref=ref, plan_ref=accepted_ref, phase='aligning_speech')
        elif kind == 'speech_aligned':
            if payload['phase'] not in {'aligning_speech', 'preparing_materials'} or event.get('plan_ref') != accepted_ref:
                raise ValueError('speech completion must reference the current plan')
            if payload['phase'] == 'preparing_materials' and any(placement['kind'] in {'visual','audio'} for placement in plan['payload'].get('placements', [])):
                raise ValueError('silent media requires accepted material work before composition')
            turns = [turn for beat in plan['payload']['beats'] for turn in beat.get('turns', []) if turn.get('text')]
            cues = plan['payload'].get('speech_cues', [])
            if turns and (payload['phase'] != 'aligning_speech' or any(not any(cue['turn_id'] == turn['id'] and cue.get('timing_status') == 'ready' for cue in cues) for turn in turns)):
                raise ValueError('dialogue requires ready timing evidence')
            payload.update(plan_ref=accepted_ref, phase='composing')
        elif kind == 'composition_ready':
            if payload['phase'] != 'composing':
                raise ValueError('composition completion is out of phase')
            ref = event.get('manifest_ref') or {}
            manifest = store.read(ref['artifact_id'], ref['revision'])
            if manifest['schema'] != 'composition_manifest.v2' or manifest['payload']['source_versions'] != [{'artifact_id': plan['id'], 'revision': plan['revision']}]:
                raise ValueError('composition must use the exact current plan')
            payload.update(plan_ref=accepted_ref, manifest_ref=ref, phase='reviewing_output')
        else:
            if payload['phase'] != 'reviewing_output':
                raise ValueError('output review is out of phase')
            manifest = store.read(payload['manifest_ref']['artifact_id'], payload['manifest_ref']['revision'])
            if manifest['schema'] != 'composition_manifest.v2' or manifest['payload'].get('source_versions') != [{'artifact_id': plan['id'], 'revision': plan['revision']}]:
                raise ValueError('composition must use the exact current plan; recompile changed materials or timing')
            ref = event.get('review_ref') or {}
            output_review = store.read(ref['artifact_id'], ref['revision'])
            if output_review['schema'] != 'production_output_review.v1' or output_review['payload'].get('status') != 'passed' or output_review['payload'].get('manifest_ref') != payload['manifest_ref']:
                raise ValueError('output requires real passed review of current composition')
            payload.update(output_review_ref=ref, phase='completed')
    else:
        raise ValueError('Unsupported commission event')
    if payload['plan_ref']:
        refs.append(payload['plan_ref'])
    if payload['review_ref']:
        refs.append(payload['review_ref'])
    refs.extend(payload[key] for key in ('work_ref', 'manifest_ref', 'output_review_ref') if payload[key])
    validated = ReferenceCommission.model_validate(payload).model_dump(mode='json')
    advanced = _result(store.revise(commission_ref['artifact_id'], expected_revision, validated, refs))
    if kind == 'plan_reviewed' and advanced['phase'] == 'awaiting_plan_confirmation':
        # A production-phase re-approval keeps the existing confirmation.
        from .plan_review_settlement import ensure_reviewed_plan_confirmation

        ensure_reviewed_plan_confirmation(store, commission_ref=advanced['commission_ref'])
    return read_reference_commission(store, advanced['commission_ref'])


def _selection_ref(store, ref: dict[str, Any]) -> dict[str, Any]:
    if (not isinstance(ref, dict) or set(ref) - {'artifact_id', 'revision', 'project_id'}
            or ref.get('project_id', store.project_id) != store.project_id):
        raise ValueError('exact project reference required')
    store._validate_id(ref.get('artifact_id'))
    store._validate_revision(ref.get('revision'))
    return {'artifact_id': ref['artifact_id'], 'revision': ref['revision'], 'project_id': store.project_id}


def _validate_selection_canvas(store, payload: dict, plan: dict, work: dict, canvas: dict) -> None:
    from .store import RemixArtifactConflict
    if (canvas.get('project_id'), canvas.get('canvas_id')) != (store.project_id, payload['canvas_id']):
        raise PermissionError('material work selection requires the authorized current canvas')
    if canvas.get('access_model') in {'private', 'user_private'} and canvas.get('owner_principal_id') != payload['requester_user_id']:
        raise PermissionError('private canvas access denied')
    nodes = canvas.get('nodes', [])
    node_ids = [node['id'] for node in nodes]
    if len(set(node_ids)) != len(node_ids):
        raise ValueError('canvas node identities are ambiguous')
    plan_nodes = []
    for node in nodes:
        ref = node.get('data', {}).get('productionPlanV2Ref') or {}
        if node.get('type') == 'scriptNode' and ref.get('artifactId', ref.get('artifact_id')) == plan['id']:
            if ref.get('revision') != plan['revision'] or ref.get('project_id', store.project_id) != store.project_id or node.get('data', {}).get('productionPlanV2Dirty') is True:
                raise RemixArtifactConflict('current saved plan must match the canvas plan head')
            plan_nodes.append(node['id'])
    if len(plan_nodes) != 1 or payload['analysis_node_id'] not in node_ids:
        raise ValueError('current plan must have one node on the commission canvas')
    reachable = {payload['analysis_node_id']}
    for _ in nodes:
        children = {edge.get('target') for edge in canvas.get('edges', []) if edge.get('source') in reachable}
        if children <= reachable:
            break
        reachable |= children
    if plan_nodes[0] not in reachable:
        raise ValueError('plan is not derived from the commission analysis')
    for step in work['payload']['steps']:
        referenced_nodes = [step.get('node_id'), (step.get('accepted_resource') or {}).get('node_id')]
        referenced_nodes += [ref.get('node_id') for ref in step.get('references', [])]
        referenced_nodes += [candidate.get('node_id') for candidate in step.get('candidates', [])]
        if any(node_id and node_id not in node_ids for node_id in referenced_nodes):
            raise ValueError('material node is not on the current canvas')
        execution = step.get('execution') or {}
        if execution.get('canvas_id', payload['canvas_id']) != payload['canvas_id']:
            raise PermissionError('material execution belongs to another canvas')
        if step.get('review_ref'):
            ref = step['review_ref']
            review = store._read(ref['artifact_id'], ref['revision'])['payload']
            decision = review.get('user_decision')
            if decision and (decision.get('canvas_id'), decision.get('requester_user_id')) != (payload['canvas_id'], payload['requester_user_id']):
                raise PermissionError('material acceptance belongs to another canvas or actor')


def _validate_selection_actor(store, payload, evidence, canvas):
    if (not isinstance(evidence, (AuthenticatedDecisionEvidence, AuthenticatedMaterialCreationEvidence))
            or (evidence.project_id, evidence.canvas_id, evidence.requester_user_id) != (
                payload['project_id'], payload['canvas_id'], payload['requester_user_id'])
            or store.created_by != payload['requester_user_id']):
        raise PermissionError('Authenticated host selection scope differs')
    if not isinstance(canvas, dict) or (canvas.get('project_id'), canvas.get('canvas_id')) != (store.project_id, payload['canvas_id']):
        raise PermissionError('authorized current canvas required')
    if canvas.get('access_model') in {'private', 'user_private'} and canvas.get('owner_principal_id') != payload['requester_user_id']:
        raise PermissionError('private canvas access denied')


def _read_selectable_work(store, payload, work_ref, canvas):
    from .store import RemixArtifactConflict
    from .material_work import _fingerprint
    from .production_review import production_decision_fingerprint
    work = store._read(work_ref['artifact_id'], store._latest_revision(work_ref['artifact_id']))
    if work['revision'] != work_ref['revision']:
        raise RemixArtifactConflict('material work changed; select its current revision')
    if work['schema'] != 'material_work_package.v1' or work['created_by'] != payload['requester_user_id']:
        raise PermissionError('material work belongs to another creator or is not a work package')
    if work['payload']['plan_ref']['artifact_id'] != payload['plan_ref']['artifact_id']:
        raise ValueError('material work belongs to another plan branch')
    plan = store._read(payload['plan_ref']['artifact_id'], store._latest_revision(payload['plan_ref']['artifact_id']))
    review = store._read(payload['review_ref']['artifact_id'], payload['review_ref']['revision'])
    if (plan['schema'] != 'production_plan.v2' or plan['created_by'] != payload['requester_user_id']
            or production_decision_fingerprint(plan['payload']) != review['payload']['decision_fingerprint']
            or _fingerprint(store, plan['payload'], work['payload']['requirements']) != work['payload']['input_fingerprint']):
        raise RemixArtifactConflict('current plan is incompatible with confirmed material work')
    _validate_selection_canvas(store, payload, plan, work, canvas)
    return plan, work


def select_material_work(store: RemixArtifactStore, commission_ref: dict[str, Any], work_ref: dict[str, Any],
                         command_id: str, *, host_evidence: AuthenticatedDecisionEvidence | None,
                         canvas: dict[str, Any], _canvas_guard=None) -> dict[str, Any]:
    """Explicitly select compatible current work with CAS and durable replay.

    The host holds the canvas mutex while calling this function. Every artifact
    read, command replay check and publication occurs under one artifact mutex.
    Selection preserves historical material review and host approval receipts.
    """
    commission_ref, work_ref = _selection_ref(store, commission_ref), _selection_ref(store, work_ref)
    if not isinstance(command_id, str) or not command_id.strip() or len(command_id) > 128:
        raise ValueError('command_id must contain 1 to 128 characters')
    if not isinstance(host_evidence, AuthenticatedDecisionEvidence):
        raise PermissionError('Authenticated host selection evidence required')
    request = {'commission_ref': commission_ref, 'work_ref': work_ref}
    with store._locked() as artifact_guard:
        return _select_material_work_locked(store, commission_ref, work_ref, command_id,
            host_evidence=host_evidence, canvas=canvas, artifact_guard=artifact_guard,
            _canvas_guard=_canvas_guard, request=request)


def _select_material_work_locked(store, commission_ref, work_ref, command_id, *,
        host_evidence, canvas, artifact_guard, _canvas_guard, request, receipt_type='material_work_selected'):
    from .reference_director import _MaterialPublicationGuard
    from .store import RemixArtifactConflict
    guard = _MaterialPublicationGuard(artifact_guard, _canvas_guard)
    current = store._read(commission_ref['artifact_id'], store._latest_revision(commission_ref['artifact_id']))
    if current['schema'] != 'reference_commission.v1':
        raise ValueError('reference is not a commission')
    payload = ReferenceCommission.model_validate(current['payload']).model_dump(mode='json')
    _validate_selection_actor(store, payload, host_evidence, canvas)
    for receipt in payload['decisions']:
        if receipt.get('type') == receipt_type and receipt.get('command_id') == command_id:
            if receipt.get('request') != request:
                raise RemixArtifactConflict('selection command_id reused with different inputs')
            return _result(store._read(current['id'], receipt['commission_revision'] + 1))
    if current['revision'] != commission_ref['revision']:
        raise RemixArtifactConflict('Commission changed; reload before selecting material work')
    if payload['phase'] != 'preparing_materials':
        raise ValueError('material work selection requires preparing_materials phase')
    plan, _ = _read_selectable_work(store, payload, work_ref, canvas)
    receipt = {'type': receipt_type, 'command_id': command_id, 'request': request,
               'commission_revision': current['revision'], 'previous_work_ref': payload['work_ref'],
               'work_ref': work_ref, 'project_id': store.project_id, 'canvas_id': payload['canvas_id'],
               'requester_user_id': payload['requester_user_id']}
    payload.update(work_ref=work_ref, plan_ref={'artifact_id': plan['id'], 'revision': plan['revision'], 'project_id': store.project_id},
                   decisions=[*payload['decisions'], receipt], manifest_ref=None, output_review_ref=None)
    validated = ReferenceCommission.model_validate(payload).model_dump(mode='json', exclude_none=True)
    refs = [payload[key] for key in ('plan_ref', 'review_ref', 'work_ref', 'parent_commission_ref') if payload.get(key)]
    refs += [row['commission_ref'] for row in payload.get('plan_branches', [])]
    refs = store._reference_list(refs, store.project_id)
    store._validate_upstream_refs(refs)
    store._validate_v2_lineage(current['schema'], validated, refs, target_artifact_id=current['id'], previous_plan=current)
    guard.reassert()
    return _result(store._publish(artifact_id=current['id'], schema=current['schema'], revision=current['revision'] + 1,
        payload=validated, upstream_refs=refs, created_by=current['created_by'], guard=guard))


def prepare_commission_material_work(store, commission_ref, plan_ref, requirements, steps, command_id, *,
        select_for_commission=False, host_evidence, canvas, direction=None, confirmed_choices=None, _canvas_guard=None):
    """Save an explicit creation command and optionally associate it, without approval.

    Interrupted association is returned for explicit selection on replay. Both
    writes use the existing canvas/artifact lock order, without nested locking.
    """
    from .material_work import _prepare_material_work
    from .store import RemixArtifactConflict
    if not isinstance(host_evidence, AuthenticatedMaterialCreationEvidence):
        raise PermissionError('Authenticated host creation scope required')
    if not isinstance(command_id, str) or not command_id.strip() or len(command_id) > 128:
        raise ValueError('command_id must contain 1 to 128 characters')
    commission_ref = _selection_ref(store, commission_ref)
    plan_ref = _selection_ref(store, plan_ref)
    work_id = hashlib.sha256(('material-work:' + command_id).encode()).hexdigest()[:32]
    with store._locked() as guard:
        current = store._read(commission_ref['artifact_id'], store._latest_revision(commission_ref['artifact_id']))
        if current['schema'] != 'reference_commission.v1':
            raise ValueError('reference is not a commission')
        payload = ReferenceCommission.model_validate(current['payload']).model_dump(mode='json')
        _validate_selection_actor(store, payload, host_evidence, canvas)
        receipts = [r for r in payload['decisions']
                    if r.get('type') == 'material_work_created_selected' and r.get('command_id') == command_id]
        work_ref = {'artifact_id': work_id, 'revision': 1, 'project_id': store.project_id}
        request = {'commission_ref': commission_ref, 'work_ref': work_ref,
                   'select_for_commission': select_for_commission}
        if receipts and receipts[0].get('request') != request:
            raise RemixArtifactConflict('material creation command_id reused with different selection inputs')
        if receipts and (current['revision'] != receipts[0]['commission_revision'] + 1
                         or _selection_ref(store, payload.get('work_ref')) != work_ref):
            raise RemixArtifactConflict('material creation association changed; read current references')
        if not receipts and current['revision'] != commission_ref['revision']:
            raise RemixArtifactConflict('Commission changed; reload before creating material work')
        if payload['phase'] != 'preparing_materials':
            raise RemixArtifactConflict('material creation requires preparing_materials phase')
        if _selection_ref(store, payload['plan_ref']) != plan_ref:
            raise RemixArtifactConflict('material plan differs from the current commission')
        from .production_review import production_decision_fingerprint
        plan = store._read(plan_ref['artifact_id'], store._latest_revision(plan_ref['artifact_id']))
        review = store._read(payload['review_ref']['artifact_id'], payload['review_ref']['revision'])
        if (plan['revision'] != plan_ref['revision'] or plan['created_by'] != store.created_by
                or production_decision_fingerprint(plan['payload']) != review['payload']['decision_fingerprint']):
            raise RemixArtifactConflict('current plan differs from the confirmed material basis')
        if select_for_commission:
            _validate_selection_canvas(store, payload, plan, {'payload': {'steps': steps}}, canvas)
        if select_for_commission and payload.get('work_ref') and not receipts:
            raise RemixArtifactConflict('commission already has selected material work')
        try:
            existing = store._read(work_id, store._latest_revision(work_id))
        except FileNotFoundError:
            existing = None
        if existing and existing['revision'] != 1:
            raise RemixArtifactConflict('material work changed; use its current reference explicitly')
        exact_plan = {key: plan_ref[key] for key in ('artifact_id', 'revision')}
        result = _prepare_material_work(store, exact_plan, requirements, steps, command_id,
            canvas=canvas, direction=direction, confirmed_choices=confirmed_choices, _artifact_guard=guard)
        if receipts:
            selected = _result(store._read(current['id'], receipts[0]['commission_revision'] + 1))
            return {**result, 'commission_ref': selected['commission_ref'], 'selection_status': 'selected'}
        if not select_for_commission:
            return result
        if existing:
            return {**result, 'commission_ref': _result(current)['commission_ref'],
                    'selection_status': 'selection_required', 'next_tool': 'freezone_select_material_work'}
        try:
            selected = _select_material_work_locked(store, commission_ref, work_ref, command_id,
                host_evidence=host_evidence, canvas=canvas, artifact_guard=guard, _canvas_guard=_canvas_guard,
                request=request, receipt_type='material_work_created_selected')
        except Exception as exc:
            raise MaterialWorkAssociationInterrupted(result['work_ref']) from exc
        return {**result, 'commission_ref': selected['commission_ref'], 'selection_status': 'selected'}


def propose_material_work_selection(store: RemixArtifactStore, commission_ref: dict[str, Any],
                                    candidate_refs: list[dict[str, Any]], *,
                                    host_evidence: AuthenticatedDecisionEvidence,
                                    canvas: dict[str, Any]) -> dict[str, Any]:
    """Suggest a unique provably compatible legacy work without adopting it.

    Candidate refs come from the authorized host inventory. Invalid, foreign or
    stale candidates are excluded; an empty or ambiguous set remains blocked.
    """
    from .store import RemixArtifactConflict
    commission_ref = _selection_ref(store, commission_ref)
    with store._locked():
        current = store._read(commission_ref['artifact_id'], store._latest_revision(commission_ref['artifact_id']))
        if current['schema'] != 'reference_commission.v1':
            raise ValueError('reference is not a commission')
        payload = ReferenceCommission.model_validate(current['payload']).model_dump(mode='json')
        _validate_selection_actor(store, payload, host_evidence, canvas)
        if current['revision'] != commission_ref['revision']:
            raise RemixArtifactConflict('Commission changed; reload before proposing material work')
        if payload['phase'] != 'preparing_materials' or payload.get('work_ref'):
            raise ValueError('legacy proposal requires unselected preparing_materials commission')
        eligible = {}
        for candidate in candidate_refs:
            try:
                candidate = _selection_ref(store, candidate)
                _read_selectable_work(store, payload, candidate, canvas)
            except (ValueError, PermissionError, FileNotFoundError):
                continue
            eligible[candidate['artifact_id']] = candidate
        return {'work_ref': None, 'suggested_work_ref': next(iter(eligible.values())) if len(eligible) == 1 else None,
                'blockers': [{'owner': 'user', 'kind': 'work_selection_required', 'action_id': None}]}
