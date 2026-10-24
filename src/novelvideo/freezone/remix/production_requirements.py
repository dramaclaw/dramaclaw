"""Typed production requirements resolved against authenticated direction evidence."""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from fractions import Fraction
from math import ceil, floor
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .reference_commission import AuthenticatedDecisionEvidence, advance_reference_commission, read_reference_commission
from .store import RemixArtifactConflict


class _Value(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class PositiveRange(_Value):
    min: int | None = Field(default=None, gt=0)
    max: int | None = Field(default=None, gt=0)

    @model_validator(mode='after')
    def ordered(self):
        if self.min is None and self.max is None:
            raise ValueError('range requires min or max')
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError('range min must not exceed max')
        return self


class ConfirmedSpokenTurn(_Value):
    speaker: str = Field(max_length=80)
    text: str = Field(min_length=1, max_length=2000)

    @model_validator(mode='after')
    def nonblank(self):
        if not self.text.strip():
            raise ValueError('confirmed spoken text must not be blank')
        return self


class DialogueRequirements(_Value):
    mode: Literal['preserve_source', 'use_confirmed_text', 'rewrite', 'unspecified']
    source_turn_ids: list[str] | None = Field(default=None, min_length=1, max_length=80)
    confirmed_turns: list[ConfirmedSpokenTurn] | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode='after')
    def compatible_text(self):
        if self.confirmed_turns is not None and self.mode != 'use_confirmed_text':
            raise ValueError('confirmed_turns requires use_confirmed_text')
        return self


class OutputRequirements(_Value):
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)


class SemanticRequirement(_Value):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)


class ProductionRequirements(_Value):
    dialogue: DialogueRequirements | None = None
    primary_shots: PositiveRange | None = None
    duration_us: PositiveRange | None = None
    output_requirements: OutputRequirements | None = None
    semantic: list[SemanticRequirement] | None = None

    @model_validator(mode='after')
    def unique_semantic_ids(self):
        ids = [item.id for item in self.semantic or []]
        if len(ids) != len(set(ids)):
            raise ValueError('semantic requirement ids must be unique')
        return self


def normalize_requirements(value: Any) -> dict:
    return ProductionRequirements.model_validate(value).model_dump(exclude_none=True)


def duration_frame_bounds(requirements: dict, *, fps_num: int, fps_den: int) -> tuple[int | None, int | None]:
    """Convert program duration bounds to representable whole frames."""
    if type(fps_num) is not int or type(fps_den) is not int or min(fps_num, fps_den) <= 0:
        raise ValueError('invalid_output_fps')
    bounds = normalize_requirements(requirements).get('duration_us', {})
    rate = Fraction(fps_num, 1_000_000 * fps_den)
    lower = ceil(bounds['min'] * rate) if 'min' in bounds else None
    upper = floor(bounds['max'] * rate) if 'max' in bounds else None
    if (upper is not None and upper < 1) or (lower is not None and upper is not None and lower > upper):
        raise ValueError('duration_not_representable_at_fps')
    return lower, upper


def resolve_source_timing(store, source: dict) -> dict | None:
    """Read the source clock from a saved project artifact, not model prose."""
    ref = source.get('evidence_ref') if isinstance(source, dict) else None
    if ref is None:
        return None
    if (not isinstance(ref, dict) or set(ref) != {'artifact_id', 'revision'}
            or not isinstance(ref.get('artifact_id'), str) or type(ref.get('revision')) is not int):
        raise ValueError('source evidence reference is invalid')
    artifact = store.read(ref['artifact_id'], ref['revision'])
    if artifact['schema'] != 'reference_evidence.v1':
        raise ValueError('source timing requires actual reference evidence')
    duration = artifact['payload']['duration_us']
    ranges = []
    for event in source.get('events', []):
        if not isinstance(event, dict) or not all(key in event for key in ('event_id', 'start_us', 'end_us')):
            continue  # Older blueprint events may not have reviewable clocks.
        start, end = event['start_us'], event['end_us']
        if (type(start) is not int or type(end) is not int or not 0 <= start < end <= duration):
            raise ValueError('source event is outside actual reference duration')
        ranges.append({'event_id': event['event_id'], 'start_us': start, 'end_us': end})
    return {'duration_us': duration, 'evidence_ref': dict(ref), 'event_ranges': ranges}


def snapshot_confirmed_dialogue(direction: dict, *, previous: dict | None,
                                message_content: str | None, _amendment: bool = False) -> dict:
    """Check semantic speech against host-owned human input before publication.

    Exact membership validates provenance, never classifies speech or captions.
    When `_amendment=True`, the caller has already authenticated the amendment
    via `apply_requirement_amendment`; skip the `message_content` provenance
    check so amended dialogue can update `locked_turns` even though the user's
    confirmation message doesn't repeat the new dialogue text verbatim.
    """
    direction = dict(direction)
    requirements = normalize_requirements(direction.get('requirements', {}))
    dialogue = requirements.get('dialogue', {})
    if dialogue.get('mode') == 'use_confirmed_text':
        turns = dialogue.get('confirmed_turns')
        if not turns:
            raise ValueError('use_confirmed_text requires explicitly confirmed_turns')
        old = (previous or {}).get('requirements', {}).get('dialogue', {})
        # Only the previously authenticated, internally consistent snapshot can
        # lend evidence. Both input turn lists are bounded by the typed schema.
        prior_turns = old.get('confirmed_turns') or []
        if (old.get('mode') != 'use_confirmed_text'
                or (previous or {}).get('locked_turns') != prior_turns):
            prior_turns = []
        elif prior_turns:
            prior_turns = DialogueRequirements.model_validate(old).model_dump(
                exclude_none=True)['confirmed_turns']
        if isinstance(message_content, str) and len(message_content) > 200_000:
            raise ValueError('confirmed spoken text message exceeds evidence limit')

        # Amendment flow: user confirmed the change via authenticated channel,
        # so skip the message_content provenance check.
        if not _amendment:
            # Each state maps an old-snapshot offset to the least current-message
            # offset consumed so far. A larger message offset at the same old offset
            # can never permit more future matches, so retain only the smaller one.
            # This bounds the search to at most 81 states for each of at most 80 turns.
            # Try BOTH sources: greedily retaining a moved line can consume old
            # evidence needed by a later unchanged line.
            states = {0: 0}
            for turn in turns:
                next_states: dict[int, int] = {}
                for prior_offset, message_offset in states.items():
                    retained_index = next((i for i in range(prior_offset, len(prior_turns))
                                           if prior_turns[i] == turn), None)
                    if retained_index is not None:
                        next_offset = retained_index + 1
                        next_states[next_offset] = min(next_states.get(next_offset, message_offset), message_offset)
                    if (isinstance(message_content, str)
                            and (not turn['speaker'] or turn['speaker'] in message_content)):
                        index = message_content.find(turn['text'], message_offset)
                        if index >= 0:
                            next_offset = index + len(turn['text'])
                            next_states[prior_offset] = min(next_states.get(prior_offset, next_offset), next_offset)
                if not next_states:
                    raise ValueError('confirmed spoken text differs from authenticated message')
                states = next_states
        direction['locked_turns'] = [dict(turn) for turn in turns]
    elif dialogue.get('mode') == 'preserve_source':
        # Amendment with preserve_source: if confirmed_turns provided, lock them
        if _amendment and dialogue.get('confirmed_turns'):
            direction['locked_turns'] = [dict(turn) for turn in dialogue['confirmed_turns']]
        else:
            direction.pop('locked_turns', None)
    if 'requirements' in direction:
        direction['requirements'] = requirements
    return direction


def check_production_requirements(payload: dict, requirements: dict, *, project_dir: Path,
                                  locked_turns: list[dict] | None = None) -> list[dict]:
    """Check author content; locked text comes from the host's resolved input.

    This stage needs no generated media. Semantic judgments remain reasoned
    human/Agent findings in the actual review, never a model-authored certificate.
    """
    from .production_plan_v2 import ProductionPlanV2, resolve_production_placement_timing

    requirements = normalize_requirements(requirements)
    plan = ProductionPlanV2.model_validate(payload)
    checks = []

    def check(code, entity_id, message, passed):
        checks.append({'code': code, 'entity_id': entity_id, 'message': message,
                       'status': 'passed' if passed else 'failed'})

    def within(value, bounds):
        return ((bounds.get('min') is None or value >= bounds['min'])
                and (bounds.get('max') is None or value <= bounds['max']))

    if 'primary_shots' in requirements or 'duration_us' in requirements:
        duration, rows = resolve_production_placement_timing(payload)
        if 'primary_shots' in requirements:
            primaries = [row for row in rows if row['kind'] == 'visual' and row['role'] == 'primary']
            intervals = []
            for row in primaries:
                valid = row['timing_status'] == 'resolved'
                check('primary_shot_timing_invalid', row['id'],
                      f"Primary visual interval: {row['start_frame']}..{row['end_frame']}; {row['timing_status']}", valid)
                if valid:
                    intervals.append((row['start_frame'], row['end_frame']))
            # Simultaneous/split-screen elements form one visual interval, not
            # several sequential shots. Distinct adjacent placements can count.
            count, previous_end = 0, -1
            for start, end in sorted(intervals):
                if start >= previous_end:
                    count += 1
                previous_end = max(previous_end, end)
            check('primary_shot_count_mismatch', 'plan',
                  f"Resolved independent primary visuals: {count}; required {requirements['primary_shots']}",
                  within(count, requirements['primary_shots']))
        if 'duration_us' in requirements:
            duration_us = Fraction(duration * 1_000_000 * plan.output.fps_den, plan.output.fps_num)
            check('duration_mismatch', 'plan',
                  f"Program duration: {duration} frames ({duration_us} us); required {requirements['duration_us']}",
                  within(duration_us, requirements['duration_us']))
    for field, expected in requirements.get('output_requirements', {}).items():
        actual = getattr(plan.output, field)
        check('output_requirement_mismatch', 'plan', f'Output {field}: {actual}; required {expected}', actual == expected)
        checks[-1]['path'] = f'/output/{field}'
    mode = requirements.get('dialogue', {}).get('mode')
    if locked_turns is not None or mode in {'preserve_source', 'use_confirmed_text'}:
        if locked_turns is None:
            check('locked_dialogue_evidence_missing', 'plan', 'Locked dialogue requires resolved original or confirmed text', False)
        else:
            actual = [{'speaker': turn.speaker, 'text': turn.text} for beat in plan.beats for turn in beat.turns]
            expected = [{'speaker': turn.get('speaker', ''), 'text': turn['text']} for turn in locked_turns]
            check('locked_dialogue_changed', 'plan', '锁定台词未原样保留：逐字核对说话者、文字与顺序', actual == expected)
    return checks


def _fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_dialogue(store, analysis_ref: dict) -> tuple[list[dict], dict]:
    if not isinstance(analysis_ref, dict) or analysis_ref.get('project_id', store.project_id) != store.project_id:
        raise ValueError('preserve_source requires the bound analysis_ref')
    analysis = store.read(analysis_ref['artifact_id'], analysis_ref['revision'])
    if analysis['schema'] != 'reference_analysis.v1':
        raise ValueError('analysis_ref must reference actual reference analysis')
    ref = analysis['payload'].get('transcript_ref')
    if not ref or analysis['payload'].get('transcript_status') != 'completed':
        raise ValueError('source dialogue requires completed original transcript')
    if ref.get('project_id', store.project_id) != store.project_id:
        raise ValueError('source transcript belongs to another project')
    timeline = store.read(ref['artifact_id'], ref['revision'])
    payload = timeline['payload']
    text = payload.get('transcript')
    if (timeline['schema'] != 'word_timeline.v1' or payload.get('status') != 'completed'
            or payload.get('media_hash') != analysis['payload'].get('media_hash')
            or not payload.get('words') or not isinstance(text, str) or not text.strip()):
        raise ValueError('source dialogue requires matching actual original transcript text')
    # The immutable transcript has no diarization. Preserve its whole actual text
    # as one turn; never invent speakers or use screen subtitles as ASR evidence.
    return [{'id': f"{timeline['id']}:{timeline['revision']}:0:{len(text)}", 'speaker': '', 'text': text}], ref


def resolve_production_requirements(store, *, commission: dict,
                                    allow_historical: bool = False) -> dict:
    current = read_reference_commission(store, commission['commission_ref'],
                                        latest=not allow_historical)
    if (current['commission_ref'] != commission['commission_ref'] or
            any(current.get(k) != commission.get(k) for k in ('direction_revision', 'direction_fingerprint', 'analysis_evidence'))):
        raise RemixArtifactConflict('production requirements direction changed; reload current direction')
    if (current['project_id'] != store.project_id or current['requester_user_id'] != store.created_by
            or not current.get('direction')):
        raise PermissionError('production requirements require the authenticated current direction')
    from .direction_contract import resolve_direction_review_contract
    requirements = resolve_direction_review_contract(current['direction'])['requirements']
    receipt = next(row for row in reversed(current['decisions']) if row['type'] == 'direction_confirmed'
                   and row.get('direction_revision') == current['direction_revision'])
    provenance = {'commission_ref': current['commission_ref'], 'analysis_node_id': current['analysis_node_id'],
        'analysis_ref': current['analysis_evidence'].get('analysis_ref'), 'direction_revision': current['direction_revision'],
        'direction_fingerprint': current['direction_fingerprint'], 'user_message_id': receipt['message_id'],
        'project_id': store.project_id, 'canvas_id': current['canvas_id'], 'requester_user_id': current['requester_user_id']}
    result: dict = {'requirements': requirements, 'requirements_provenance': provenance}
    dialogue = requirements.get('dialogue', {})
    if dialogue.get('mode') == 'preserve_source':
        # Always fetch transcript for provenance
        turns, transcript_ref = source_dialogue(store, provenance['analysis_ref'])
        provenance['transcript_ref'] = transcript_ref
        # Amendment flow may have updated `locked_turns` in the direction record.
        # Use it when present instead of always re-parsing from original transcript.
        locked = current['direction'].get('locked_turns')
        if locked:
            result['locked_turns'] = [dict(turn) for turn in locked]
        else:
            requested = dialogue.get('source_turn_ids', [t['id'] for t in turns])
            if len(set(requested)) != len(requested) or any(i not in {t['id'] for t in turns} for i in requested):
                raise ValueError('source_turn_ids must name actual turns in this bound analysis transcript')
            requirements['dialogue']['source_turn_ids'] = requested
            result['locked_turns'] = [{k: t[k] for k in ('speaker', 'text')} for t in turns if t['id'] in requested]
    elif dialogue.get('mode') == 'use_confirmed_text':
        turns = current['direction'].get('locked_turns')
        if dialogue.get('confirmed_turns') is not None and turns != dialogue['confirmed_turns']:
            raise ValueError('locked_turns differs from confirmed spoken text')
        from novelvideo.api.routes.remix import ProductionPlanDraftBody
        if not turns:
            raise ValueError('use_confirmed_text requires explicitly confirmed locked_turns')
        result['locked_turns'] = [t.model_dump() for t in ProductionPlanDraftBody.model_validate({'topic': current['goal'], 'locked_turns': turns}).locked_turns]
    result['requirements_fingerprint'] = _fingerprint(result)
    return result


def apply_requirement_amendment(store, *, commission_ref: dict, requirements: dict,
                                host_evidence: AuthenticatedDecisionEvidence, canvas: dict | None = None, _canvas_guard=None) -> dict:
    from .production_advancement import _MutationStore
    from .reference_director import _MaterialPublicationGuard
    normalized = normalize_requirements(requirements)
    with store._locked() as artifact_guard:
        publication_guard = _MaterialPublicationGuard(artifact_guard, _canvas_guard)
        base_store = store
        while isinstance(base_store, _MutationStore):
            base_store = base_store._store
        locked = _MutationStore(base_store, publication_guard)
        current = read_reference_commission(locked, commission_ref, latest=True)
        if current['commission_ref'] != commission_ref:
            raise RemixArtifactConflict('Commission changed; reload before amending requirements')
        if not isinstance(host_evidence, AuthenticatedDecisionEvidence):
            raise PermissionError('Authenticated host decision evidence required')
        if current['requester_user_id'] != store.created_by:
            raise PermissionError('requirement amendment actor differs')
        bound = current.get('plan_ref')
        if not bound:
            raise ValueError('requirement amendment requires an already bound plan')
        if canvas is None:
            raise ValueError('requirement amendment requires the current canvas binding')
        if canvas is not None:
            if canvas.get('canvas_id') != current['canvas_id'] or canvas.get('project_id', store.project_id) != store.project_id:
                raise PermissionError('requirement amendment canvas scope differs')
            matches = [node for node in canvas.get('nodes', []) if node.get('data', {}).get('productionPlanV2Ref') in
                       ({'artifactId': bound['artifact_id'], 'revision': bound['revision']}, bound)]
            if len(matches) != 1:
                raise ValueError('requirement amendment requires the exact current canvas plan binding')
        plan = locked.read_latest(bound['artifact_id'])
        if plan['schema'] != 'production_plan.v2' or plan['revision'] != bound['revision'] or plan['created_by'] != store.created_by:
            raise RemixArtifactConflict('Bound plan changed; receive its current revision before amendment')
        if _canvas_guard is not None:
            _canvas_guard.reassert()
        return advance_reference_commission(locked, commission_ref,
            {'type': 'direction_confirmed', 'direction': {**current['direction'], 'requirements': normalized}},
            commission_ref['revision'], host_evidence=host_evidence, canvas=canvas, _amended_plan_ref=bound)



def _resolve_manual_source(store, requirements: dict, provenance: dict) -> dict:
    if (provenance.get('project_id') != store.project_id or provenance.get('requester_user_id') != store.created_by
            or not provenance.get('canvas_id') or not provenance.get('analysis_node_id')):
        raise PermissionError('manual source requirements actor or project differs')
    turns, transcript_ref = source_dialogue(store, provenance.get('analysis_ref'))
    requirements = normalize_requirements(requirements)
    dialogue = requirements.get('dialogue', {})
    if dialogue.get('mode') != 'preserve_source':
        raise ValueError('manual source provenance requires preserve_source dialogue')
    ids = dialogue.get('source_turn_ids', [turn['id'] for turn in turns])
    if len(set(ids)) != len(ids) or any(i not in {t['id'] for t in turns} for i in ids):
        raise ValueError('source_turn_ids must name actual turns in the canvas analysis')
    requirements['dialogue']['source_turn_ids'] = ids
    result = {'requirements': requirements,
        'locked_turns': [{k:t[k] for k in ('speaker','text')} for t in turns if t['id'] in ids],
        'requirements_provenance': {**provenance, 'transcript_ref': transcript_ref}}
    result['requirements_fingerprint'] = _fingerprint(result)
    return result


def validate_native_requirements(store, payload: dict) -> None:
    """Normalize drafting inputs; direction receipts are not execution gates."""
    provenance = payload.pop('requirements_provenance', None)
    if isinstance(provenance, dict) and provenance.get('kind') == 'manual_source':
        payload['requirements_provenance'] = provenance
        resolved = _resolve_manual_source(store, payload.get('requirements'), provenance)
        if any(payload.get(key) != value for key, value in resolved.items()):
            raise ValueError('manual source requirements or locked_turns differ from original evidence')
        return
    # Recompute from the actual inputs rather than comparing a receipt from a
    # previous conversation. Old nodes may still carry that receipt.
    payload.pop('requirements_fingerprint', None)
    if 'requirements' not in payload:
        return
    requirements = normalize_requirements(payload['requirements'])
    if requirements.get('dialogue', {}).get('mode') == 'preserve_source':
        raise ValueError('preserve_source requires a bound analysis_ref and host provenance')
    if requirements.get('dialogue', {}).get('mode') in {'rewrite', 'unspecified'} and payload.get('locked_turns'):
        raise ValueError('locked_turns conflicts with dialogue mode')
    if requirements.get('dialogue', {}).get('mode') == 'use_confirmed_text' and not payload.get('locked_turns'):
        raise ValueError('use_confirmed_text requires explicit locked_turns')
    confirmed_turns = requirements.get('dialogue', {}).get('confirmed_turns')
    if confirmed_turns is not None and payload.get('locked_turns') != confirmed_turns:
        raise ValueError('locked_turns differs from explicit confirmed_turns')
    snapshot = {'requirements': requirements}
    if payload.get('locked_turns') is not None:
        snapshot['locked_turns'] = payload['locked_turns']
    fingerprint = _fingerprint(snapshot)
    payload.update(requirements=requirements, requirements_fingerprint=fingerprint)


def hydrate_native_requirements(store, payload: dict, *, canvas: dict, node_id: str,
                                requester_user_id: str) -> None:
    """Use submitted inputs, filling omissions from the current canvas node."""
    plan_nodes = [node for node in canvas.get('nodes', []) if node.get('id') == node_id
                  and node.get('type') == 'scriptNode'
                  and (node.get('data') or {}).get('remixRole') == 'production_plan']
    if len(plan_nodes) > 1:
        raise ValueError('native plan target is ambiguous')
    analysis_ids = {edge['source'] for edge in canvas.get('edges', []) if edge.get('target') == node_id
                    and any(n.get('id') == edge.get('source') and n.get('type') == 'videoStoryNode' for n in canvas.get('nodes', []))}
    if len(analysis_ids) > 1:
        raise ValueError('native plan requires one bound analysis node')
    node_data = (plan_nodes[0].get('data') or {}) if len(plan_nodes) == 1 else {}
    node_payload = node_data.get('processingPayload')
    if isinstance(node_payload, dict):
        for key in ('topic', 'requirements', 'locked_turns'):
            if key not in payload and key in node_payload:
                payload[key] = deepcopy(node_payload[key])
    payload.pop('requirements_provenance', None)
    payload.pop('requirements_fingerprint', None)
    requirements = normalize_requirements(payload['requirements']) if 'requirements' in payload else {}
    if requirements.get('dialogue', {}).get('mode') == 'preserve_source':
        sources = [n for n in canvas.get('nodes', []) if n.get('id') in analysis_ids]
        if len(sources) != 1:
            raise ValueError('preserve_source requires one actual canvas analysis_ref')
        ref = sources[0].get('data', {}).get('referenceAnalysisRef')
        if not isinstance(ref, dict):
            raise ValueError('preserve_source requires an actual canvas analysis_ref')
        provenance = {'kind': 'manual_source', 'project_id': store.project_id, 'canvas_id': canvas['canvas_id'],
            'requester_user_id': requester_user_id, 'analysis_node_id': sources[0]['id'],
            'analysis_ref': {'artifact_id': ref.get('artifact_id', ref.get('artifactId')), 'revision': ref['revision']}}
        payload.update(_resolve_manual_source(store, requirements, provenance))
    validate_native_requirements(store, payload)
