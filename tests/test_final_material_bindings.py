"""Final material ownership is checked at production boundaries, not artifact reads."""
from copy import deepcopy
import hashlib
from types import SimpleNamespace
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from test_material_work import plan_payload
from novelvideo.freezone.remix.material_work import (
    MaterialRequirement, _fingerprint, accept_material_candidate, prepare_material_work,
    validate_material_completion,
)
from novelvideo.freezone.remix.store import RemixArtifactStore


def _plan(tmp_path):
    store = RemixArtifactStore(tmp_path, 'project', created_by='alice')
    payload = plan_payload()
    picture = payload['placements'][0]
    payload['placements'].append({**picture, 'id': 'cutaway', 'role': 'overlay', 'track_id': 'broll'})
    payload['beats'][0]['turns'] = [{'id': 'turn', 'speaker': 'Guest', 'text': 'Complete dialogue'}]
    path = tmp_path / 'speech.wav'
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\x00\x00' * 8000)
    payload['resources'] = [{'id': 'speech-resource', 'node_id': 'speech-node', 'media_kind': 'audio',
                            'media_path': 'speech.wav', 'media_hash': hashlib.sha256(path.read_bytes()).hexdigest(),
                            'duration_us': 1_000_000, 'has_audio': True}]
    payload['placements'].append({**picture, 'id': 'speech', 'kind': 'audio', 'role': 'speech',
                                  'track_id': 'speech', 'resource_id': 'speech-resource'})
    payload['speech_takes'] = [{'id': 'take', 'beat_id': 'opening', 'resource_id': 'speech-resource',
                               'origin_placement_id': 'speech', 'turn_ids': ['turn']}]
    saved = store.create('production_plan.v2', payload, [])
    return store, {'artifact_id': saved['id'], 'revision': saved['revision']}, saved['payload']


def _requirements(field, kinds):
    target = 'take' if field == 'take_ids' else 'picture'
    requirements = [{'id': f'requirement-{index}', field: [target], 'description': 'Confirmed final material',
                     'media_kind': kind, 'final_step_id': f'final-{index}'}
                    for index, kind in enumerate(kinds)]
    steps = [{'id': f'final-{index}', 'label': 'Final material', 'source': 'generate', 'media_kind': kind,
              'recipe_id': f'general-{kind}', 'prompt': 'Confirmed content'}
             for index, kind in enumerate(kinds)]
    return requirements, steps


def _legacy_work(store, plan_ref, plan, requirements, steps):
    """Store the same schema-valid envelope produced before ownership enforcement."""
    requirements = [MaterialRequirement.model_validate(row).model_dump(mode='json', exclude_none=True)
                    for row in requirements]
    return store.create('material_work_package.v1', {
        'plan_ref': plan_ref, 'input_fingerprint': _fingerprint(store, plan, requirements),
        'requirements': requirements, 'steps': steps, 'command_id': 'legacy-work',
    }, [plan_ref])


def _snapshot(tmp_path):
    return {str(path.relative_to(tmp_path)): path.read_bytes()
            for path in tmp_path.rglob('*') if path.is_file()}


@pytest.mark.parametrize('field,kinds', [
    ('placement_ids', ('image', 'video')),
    ('placement_ids', ('video', 'video')),
    ('take_ids', ('audio', 'audio')),
])
def test_prepare_rejects_conflicting_finals_without_publishing_work(tmp_path, field, kinds):
    store, plan_ref, _ = _plan(tmp_path)
    requirements, steps = _requirements(field, kinds)
    before = _snapshot(tmp_path)
    with pytest.raises(ValueError, match='final material bindings conflict') as rejected:
        prepare_material_work(store, plan_ref, requirements, steps, 'conflicting-work')
    assert 'freezone_prepare_production_edit' in str(rejected.value)
    assert 'intermediate' in str(rejected.value)
    assert _snapshot(tmp_path) == before


@pytest.mark.parametrize('field,kinds', [
    ('placement_ids', ('image', 'video')),
    ('placement_ids', ('video', 'video')),
    ('take_ids', ('audio', 'audio')),
])
def test_legacy_conflicting_work_remains_readable_and_completion_rejects_it(tmp_path, field, kinds):
    from novelvideo.freezone.remix.material_execution import read_material_state

    store, plan_ref, plan = _plan(tmp_path)
    requirements, steps = _requirements(field, kinds)
    saved = _legacy_work(store, plan_ref, plan, requirements, steps)
    ref = {'artifact_id': saved['id'], 'revision': saved['revision']}
    before = _snapshot(tmp_path)
    reread = store.read(saved['id'], saved['revision'])
    assert reread == saved
    assert store.read_latest(saved['id']) == saved
    assert read_material_state(store, ref)['work']['requirements'] == saved['payload']['requirements']
    assert _snapshot(tmp_path) == before
    with pytest.raises(ValueError, match='final material bindings conflict'):
        validate_material_completion(store, reread, plan)
    assert _snapshot(tmp_path) == before


@pytest.mark.parametrize('field,kinds', [('placement_ids', ('image',)), ('take_ids', ('audio',))])
def test_same_final_step_may_satisfy_repeated_requirements_for_one_target(tmp_path, field, kinds):
    store, plan_ref, _ = _plan(tmp_path)
    requirements, steps = _requirements(field, kinds)
    requirements.append({**requirements[0], 'id': 'additional-criterion'})
    prepared = prepare_material_work(store, plan_ref, requirements, steps, 'same-final')
    assert prepared['ready_step_ids'] == ['final-0']


def test_distinct_finals_may_share_turn_context_with_distinct_picture_targets(tmp_path):
    store, plan_ref, _ = _plan(tmp_path)
    requirements, steps = _requirements('placement_ids', ('image', 'video'))
    requirements[1]['placement_ids'] = ['cutaway']
    for requirement in requirements:
        requirement['turn_ids'] = ['turn']
    prepared = prepare_material_work(store, plan_ref, requirements, steps, 'same-turn')
    assert prepared['ready_step_ids'] == ['final-0', 'final-1']


def test_one_reviewed_final_source_can_complete_several_distinct_saved_placements(tmp_path):
    from novelvideo.freezone.remix.material_execution import review_material_candidate, confirm_material_review
    from novelvideo.freezone.remix.production_commands import apply_production_commands

    store, plan_ref, _ = _plan(tmp_path)
    requirements = [{'id': target, 'placement_ids': [target], 'description': 'Same accepted picture',
                     'media_kind': 'image', 'final_step_id': 'shared'} for target in ('picture', 'cutaway')]
    steps = [{'id': 'shared', 'label': 'Shared final picture', 'source': 'existing', 'media_kind': 'image', 'node_id': 'n'}]
    work = prepare_material_work(store, plan_ref, requirements, steps, 'shared-final')
    Image.new('RGB', (16, 12), 'red').save(tmp_path / 'picture.png')
    canvas = {'nodes': [{'id': 'n', 'data': {'imageUrl': '/static/projects/project/picture.png'}}]}
    review = review_material_candidate(store, work['work_ref'], 'shared', canvas, 'n')
    confirmed = confirm_material_review(store, review['review_ref'], canvas, canvas_id='canvas', requester_user_id='alice')
    resource = confirmed['review']['resource']
    accepted = accept_material_candidate(store, work['work_ref'], 'shared', resource, confirmed['review_ref'], 'accept-shared')
    bound = apply_production_commands(store, plan_ref, [
        {'kind': 'bind_media', 'target_id': 'picture', 'payload': {'resource_id': resource['id'], 'resource': resource}},
        {'kind': 'bind_media', 'target_id': 'cutaway', 'payload': {'resource_id': resource['id']}},
    ], 'bind-shared')
    current_plan = store.read(bound['plan_ref']['artifact_id'], bound['plan_ref']['revision'])['payload']
    current_work = store.read_latest(accepted['work_ref']['artifact_id'])
    validate_material_completion(store, current_work, current_plan)
    targets = [row for row in current_plan['placements'] if row['id'] in {'picture', 'cutaway'}]
    assert {row['resource_id'] for row in targets} == {resource['id']}


def test_graphic_targets_are_not_bound_and_do_not_block_completion(tmp_path):
    """Authored graphic layers carry no media; binding them fails every retry."""
    from novelvideo.freezone.remix.material_execution import review_material_candidate, confirm_material_review
    from novelvideo.freezone.remix.material_work import bind_accepted_materials

    store = RemixArtifactStore(tmp_path, 'project', created_by='alice')
    payload = plan_payload()
    picture = payload['placements'][0]
    payload['placements'].append({**picture, 'id': 'card', 'kind': 'graphic', 'role': 'effect',
                                  'track_id': 'graphics',
                                  'graphic': {'template': 'question_card', 'text': '为什么？'}})
    saved = store.create('production_plan.v2', payload, [])
    plan_ref = {'artifact_id': saved['id'], 'revision': saved['revision']}
    work = prepare_material_work(store, plan_ref,
        [{'id': 'final', 'placement_ids': ['picture', 'card'], 'description': 'Opening shot',
          'media_kind': 'image', 'final_step_id': 'image'}],
        [{'id': 'image', 'label': 'Opening shot', 'source': 'existing',
          'node_id': 'n', 'media_kind': 'image'}], 'graphic-target')
    Image.new('RGB', (16, 12), 'red').save(tmp_path / 'picture.png')
    canvas = {'nodes': [{'id': 'n', 'data': {'imageUrl': '/static/projects/project/picture.png'}}]}
    review = review_material_candidate(store, work['work_ref'], 'image', canvas, 'n')
    confirmed = confirm_material_review(store, review['review_ref'], canvas,
                                        canvas_id='canvas', requester_user_id='alice')
    accepted = accept_material_candidate(store, work['work_ref'], 'image',
        confirmed['review']['resource'], confirmed['review_ref'], 'accept-graphic-target')
    assert accepted['binding_candidates'][0]['placement_ids'] == ['picture']

    result = bind_accepted_materials(store, accepted['work_ref'], plan_ref, 'bind-graphic-target')
    plan = store.read(result['plan_ref']['artifact_id'], result['plan_ref']['revision'])
    current = store.read_latest(result['work_ref']['artifact_id'])
    assert 'card' not in {row['id'] for row in plan['payload']['placements'] if row.get('resource_id')}
    validate_material_completion(store, current, plan['payload'])


def test_intermediate_reference_without_final_target_completes_without_a_plan_resource(tmp_path):
    """One shared identity image feeds several shots; no placement owns it."""
    from novelvideo.freezone.remix.material_execution import review_material_candidate, confirm_material_review
    from novelvideo.freezone.remix.material_work import bind_accepted_materials

    store, plan_ref, _ = _plan(tmp_path)
    work = prepare_material_work(store, plan_ref,
        [{'id': 'identity', 'placement_ids': [], 'description': 'Shared identity reference',
          'media_kind': 'image', 'final_step_id': 'reference'},
         {'id': 'opening', 'placement_ids': ['picture'], 'description': 'Opening shot',
          'media_kind': 'image', 'final_step_id': 'opening'}],
        [{'id': 'reference', 'label': 'Shared identity', 'source': 'existing',
          'node_id': 'n', 'media_kind': 'image'},
         {'id': 'opening', 'label': 'Opening shot', 'source': 'existing',
          'node_id': 'shot', 'media_kind': 'image',
          'references': [{'step_id': 'reference', 'role': 'identity'}]}], 'shared-identity')
    Image.new('RGB', (16, 12), 'red').save(tmp_path / 'picture.png')
    canvas = {'nodes': [{'id': node, 'data': {'imageUrl': '/static/projects/project/picture.png'}}
                        for node in ('n', 'shot')]}

    def accept_step(ref, step_id, command_id):
        review = review_material_candidate(store, ref, step_id, canvas, 'n' if step_id == 'reference' else 'shot')
        confirmed = confirm_material_review(store, review['review_ref'], canvas,
                                            canvas_id='canvas', requester_user_id='alice')
        return accept_material_candidate(store, ref, step_id, confirmed['review']['resource'],
                                          confirmed['review_ref'], command_id)

    accepted = accept_step(work['work_ref'], 'reference', 'accept-identity')
    assert accepted['binding_candidates'][0]['placement_ids'] == []
    final = accept_step(accepted['work_ref'], 'opening', 'accept-opening')
    bound = bind_accepted_materials(store, final['work_ref'], plan_ref, 'bind-shared-identity')
    current_plan = store.read(bound['plan_ref']['artifact_id'], bound['plan_ref']['revision'])
    current_work = store.read(bound['work_ref']['artifact_id'], bound['work_ref']['revision'])
    identity = next(step for step in current_work['payload']['steps'] if step['id'] == 'reference')
    assert identity['accepted_resource']['id'] not in {row['id'] for row in current_plan['payload']['resources']}
    validate_material_completion(store, current_work, current_plan['payload'])


def test_advisory_content_binds_into_plan_without_browser_confirmation(tmp_path):
    from novelvideo.freezone.remix.material_execution import review_material_candidate
    from novelvideo.freezone.remix.material_work import bind_accepted_materials

    store, plan_ref, _ = _plan(tmp_path)
    requirements = [{'id': target, 'placement_ids': [target], 'description': 'Advisory picture',
                     'media_kind': 'image', 'final_step_id': 'shared'} for target in ('picture', 'cutaway')]
    steps = [{'id': 'shared', 'label': 'Shared final picture', 'source': 'existing', 'media_kind': 'image', 'node_id': 'n'}]
    work = prepare_material_work(store, plan_ref, requirements, steps, 'advisory-final')
    Image.new('RGB', (16, 12), 'red').save(tmp_path / 'picture.png')
    canvas = {'nodes': [{'id': 'n', 'data': {'imageUrl': '/static/projects/project/picture.png'}}]}

    review = review_material_candidate(store, work['work_ref'], 'shared', canvas, 'n')
    assert review['review']['content']['status'] == 'unavailable'
    accepted = accept_material_candidate(store, work['work_ref'], 'shared', review['review']['resource'],
                                         review['review_ref'], 'accept-advisory')

    bound = bind_accepted_materials(store, accepted['work_ref'], plan_ref, 'bind-advisory')
    current_plan = store.read(bound['plan_ref']['artifact_id'], bound['plan_ref']['revision'])['payload']
    current_work = store.read(bound['work_ref']['artifact_id'], bound['work_ref']['revision'])
    validate_material_completion(store, current_work, current_plan)
    targets = [row for row in current_plan['placements'] if row['id'] in {'picture', 'cutaway'}]
    assert {row['resource_id'] for row in targets} == {review['review']['resource']['id']}


@pytest.fixture
def material_api(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone, reference_material, reference_director
    from novelvideo.freezone import canvas_store

    store, plan_ref, plan = _plan(tmp_path)
    ctx = SimpleNamespace(project_id='project', state_dir=tmp_path, output_dir=tmp_path,
                          requester_user_id='alice', requester_username='alice', owner_username='alice')
    async def resolve(*args, **kwargs):
        return ctx, 'alice', 'project', tmp_path, str(tmp_path)
    monkeypatch.setattr(freezone, '_resolve_freezone_project', resolve)
    canvas = {'project_id': 'project', 'canvas_id': 'canvas', 'revision': 1,
              'nodes': [{'id': 'analysis', 'type': 'videoStoryNode', 'position': {'x': 0, 'y': 0}, 'data': {}},
                        {'id': 'plan', 'type': 'scriptNode', 'position': {'x': 1, 'y': 0},
                         'data': {'productionPlanV2Ref': {'artifactId': plan_ref['artifact_id'], 'revision': plan_ref['revision']}}}],
              'edges': [{'source': 'analysis', 'target': 'plan'}]}
    canvas_store.save_canvas(tmp_path, 'canvas', base_revision=None, build_payload=lambda _: deepcopy(canvas))
    app = FastAPI()
    app.include_router(reference_material.router, prefix='/api/v1')
    app.include_router(reference_director.router, prefix='/api/v1')
    app.dependency_overrides[get_api_user] = lambda: {'username': 'alice', 'user_id': 'alice', 'role': 'owner'}
    with TestClient(app) as client:
        yield client, store, plan_ref, plan, tmp_path, app


_BASE = '/api/v1/projects/project/freezone/canvases/canvas/director'


@pytest.mark.parametrize('field,kinds', [
    ('placement_ids', ('image', 'video')),
    ('placement_ids', ('video', 'video')),
    ('take_ids', ('audio', 'audio')),
])
def test_material_stage_rejects_legacy_collision_but_state_still_reads(material_api, field, kinds):
    client, store, plan_ref, plan, tmp_path, _ = material_api
    requirements, steps = _requirements(field, kinds)
    saved = _legacy_work(store, plan_ref, plan, requirements, steps)
    ref = {'artifact_id': saved['id'], 'revision': saved['revision']}
    before = _snapshot(tmp_path)
    assert client.post(_BASE + '/material-state', json={'work_ref': ref}).status_code == 200
    response = client.post(_BASE + '/material-stage', json={'work_ref': ref})
    assert response.status_code == 422, response.text
    assert 'final material bindings conflict' in response.json()['detail']
    assert _snapshot(tmp_path) == before


def test_material_stage_keeps_valid_pending_work_and_revision_checks(material_api):
    client, store, plan_ref, _, tmp_path, _ = material_api
    requirements, steps = _requirements('placement_ids', ('image',))
    requirements.append({**requirements[0], 'id': 'extra'})
    prepared = prepare_material_work(store, plan_ref, requirements, steps, 'stage-valid')
    before = _snapshot(tmp_path)
    response = client.post(_BASE + '/material-stage', json={'work_ref': prepared['work_ref']})
    assert response.status_code == 200, response.text
    assert response.json()['data']['ready_step_ids'] == ['final-0']
    assert _snapshot(tmp_path) == before
    saved = store.read_latest(prepared['work_ref']['artifact_id'])
    store.revise(saved['id'], saved['revision'], saved['payload'], saved['upstream_refs'])
    assert client.post(_BASE + '/material-stage', json={'work_ref': prepared['work_ref']}).status_code == 409


def test_material_stage_rechecks_each_video_clip_duration_before_draft(material_api):
    client, store, plan_ref, _, _, _ = material_api
    requirements, steps = _requirements('placement_ids', ('video',))
    prepared = prepare_material_work(store, plan_ref, requirements, steps, 'video-without-duration')
    response = client.post(_BASE + '/material-stage', json={'work_ref': prepared['work_ref']})
    assert response.status_code == 422, response.text
    assert response.json()['detail']['code'] == 'material_duration_invalid'
    assert response.json()['detail']['issues'][0]['step_id'] == 'final-0'


def test_material_stage_rechecks_saved_user_parameters_before_next_wave(material_api, monkeypatch):
    from novelvideo.api.routes import reference_material

    client, store, plan_ref, _, _, _ = material_api
    requirements, steps = _requirements('placement_ids', ('video',))
    steps[0]['generation_inputs'] = {'durationSec': 5, 'model': 'agent-model'}
    choices = {'video_model': 'user-model', 'video_aspect_ratio': '9:16',
               'video_resolution': '720P'}
    async def current_choices(*args):
        return choices
    monkeypatch.setattr(reference_material, '_current_material_generation_choices', current_choices)
    prepared = prepare_material_work(
        store, plan_ref, requirements, steps, 'saved-choices',
        confirmed_choices=choices,
    )
    response = client.post(_BASE + '/material-stage', json={'work_ref': prepared['work_ref']})
    assert response.status_code == 409, response.text
    detail = response.json()['detail']
    assert detail['code'] == 'material_parameter_choice_conflict'
    assert detail['conflicts'][0]['step_id'] == 'final-0'


def test_material_stage_scopes_native_workflow_to_selected_saved_placement(material_api, monkeypatch):
    from novelvideo.api.routes import reference_material

    async def current_choices(*args):
        return {f'{kind}_{field}': value for kind in ('image', 'video')
                for field, value in (('model', 'chosen-model'), ('aspect_ratio', '9:16'),
                                     ('resolution', '720p'))}
    monkeypatch.setattr(reference_material, '_current_material_generation_choices', current_choices)
    client, store, plan_ref, _, tmp_path, _ = material_api
    requirements, steps = _requirements('placement_ids', ('image', 'video'))
    requirements[1]['placement_ids'] = ['cutaway']
    prepared = prepare_material_work(store, plan_ref, requirements, steps, 'stage-selected',
                                     confirmed_choices={f'{kind}_{field}': value for kind in ('image', 'video')
                                                        for field, value in (('model', 'chosen-model'),
                                                                             ('aspect_ratio', '9:16'),
                                                                             ('resolution', '720p'))})
    before = _snapshot(tmp_path)
    response = client.post(_BASE + '/material-stage', json={
        'work_ref': prepared['work_ref'], 'placement_ids': ['picture'],
    })
    assert response.status_code == 200, response.text
    data = response.json()['data']
    assert data['generation_scope']['selected'] == ['final-0']
    assert data['generation_scope']['ready'] == ['final-0']
    assert data['ready_step_ids'] == ['final-0']
    assert [item['id'] for item in data['workflow_intent']['items']] == ['final-0']
    assert _snapshot(tmp_path) == before
    invalid = client.post(_BASE + '/material-stage', json={
        'work_ref': prepared['work_ref'], 'placement_ids': ['not-in-plan'],
    })
    assert invalid.status_code == 422
    assert _snapshot(tmp_path) == before


@pytest.mark.parametrize('canvas_patch,status', [
    ({'project_id': 'foreign'}, 404),
    ({'access_model': 'private', 'owner_principal_id': 'other'}, 403),
])
def test_material_stage_preserves_canvas_scope_before_diagnosis(material_api, monkeypatch, canvas_patch, status):
    from novelvideo.freezone import canvas_store

    client, store, plan_ref, plan, _, _ = material_api
    requirements, steps = _requirements('placement_ids', ('image', 'video'))
    saved = _legacy_work(store, plan_ref, plan, requirements, steps)
    canvas = canvas_store.read_canvas(store.project_dir, 'canvas')
    monkeypatch.setattr(canvas_store, 'read_canvas', lambda *args: {**canvas, **canvas_patch})
    response = client.post(_BASE + '/material-stage', json={'work_ref': {'artifact_id': saved['id'], 'revision': 1}})
    assert response.status_code == status
    assert 'final material bindings conflict' not in response.text


def test_material_work_still_requires_confirmed_plan_before_binding_diagnosis(material_api):
    from novelvideo.freezone.remix.reference_commission import create_reference_commission

    client, store, plan_ref, _, tmp_path, _ = material_api
    commission = create_reference_commission(store, canvas_id='canvas', requester_user_id='alice',
        analysis_node_id='analysis', goal='Confirmed direction',
        analysis_evidence={'task_id': 'actual-task-fixture', 'result_fingerprint': 'fixture'})
    requirements, steps = _requirements('placement_ids', ('image', 'video'))
    before = _snapshot(tmp_path)
    response = client.post(_BASE + '/material-work', json={
        'commission_ref': commission['commission_ref'], 'plan_ref': plan_ref, 'command_id': 'not-approved',
        'requirements': requirements, 'steps': steps,
    })
    assert response.status_code == 409
    assert 'confirm the reviewed plan' in response.text
    assert _snapshot(tmp_path) == before


@pytest.mark.parametrize('change', ['review-head', 'file'])
def test_material_completion_rechecks_accepted_review_head_and_file(tmp_path, change):
    from test_reference_commission import confirmed_bound_picture
    store, _, plan, accepted, _ = confirmed_bound_picture(tmp_path)
    work = store.read_latest(accepted['work_ref']['artifact_id'])
    step = work['payload']['steps'][0]
    if change == 'review-head':
        review = store.read_latest(step['review_ref']['artifact_id'])
        payload = deepcopy(review['payload'])
        payload['content']['status'] = 'rejected'
        store.revise(review['id'], review['revision'], payload, review['upstream_refs'])
    else:
        Image.new('RGB', (16, 12), 'blue').save(store.project_dir / step['accepted_resource']['media_path'])
    with pytest.raises(ValueError, match='review|media'):
        validate_material_completion(store, work, plan['payload'])


def test_take_only_final_binding_rebases_native_work_inputs_and_keeps_review(tmp_path):
    from novelvideo.freezone.remix.material_work import bind_accepted_materials
    from novelvideo.freezone.remix.material_execution import review_material_candidate, confirm_material_review
    store, plan_ref, _ = _plan(tmp_path)
    path = tmp_path / 'new-speech.wav'
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\x10\x00' * 8000)
    work = prepare_material_work(store, plan_ref,
        [{'id': 'speech-final', 'take_ids': ['take'], 'turn_ids': ['turn'], 'description': 'New dialogue source',
          'media_kind': 'audio', 'final_step_id': 'voice'}],
        [{'id': 'voice', 'label': 'Voice', 'source': 'existing', 'node_id': 'new-voice', 'media_kind': 'audio'}], 'new-dialogue')
    canvas = {'nodes': [{'id': 'new-voice', 'type': 'audioNode', 'data': {'audioUrl': '/static/projects/project/new-speech.wav'}}]}
    review = review_material_candidate(store, work['work_ref'], 'voice', canvas, 'new-voice')
    review = confirm_material_review(store, review['review_ref'], canvas, canvas_id='canvas', requester_user_id='alice')
    accepted = accept_material_candidate(store, work['work_ref'], 'voice', review['review']['resource'], review['review_ref'], 'accept-voice')
    result = bind_accepted_materials(store, accepted['work_ref'], plan_ref, 'bind-voice')
    plan = store.read(result['plan_ref']['artifact_id'], result['plan_ref']['revision'])
    current_work = store.read(result['work_ref']['artifact_id'], result['work_ref']['revision'])
    validate_material_completion(store, current_work, plan['payload'])
    assert current_work['payload']['plan_ref'] == result['plan_ref']
    assert current_work['payload']['steps'][0]['review_ref'] == review['review_ref']
    assert plan['payload']['speech_takes'][0]['resource_id'] == review['review']['resource']['id']
    assert bind_accepted_materials(store, accepted['work_ref'], plan_ref, 'bind-voice') == result
    assert store.read_latest(current_work['id'])['revision'] == current_work['revision']
