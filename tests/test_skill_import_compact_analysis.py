import json

import pytest
from pydantic import ValidationError

from novelvideo.freezone.skill_import_evidence import segment_source
from novelvideo.freezone.skill_import_retrieval import (
    DraftSourceAnalysis,
    resolve_task_recipes,
    validate_source_analysis,
)


def compact_analysis(segments: list[dict]) -> dict:
    return {
        'purpose': 'Create the requested media',
        'orchestration_summary': 'Confirm the mode, render each asset, then assemble in order.',
        'orchestration_segment_ids': [segments[0]['id']],
        'tasks': [{
            'id': 'render',
            'title': 'Render the requested still',
            'requirement_summary': 'Create one still image with the specified composition.',
            'source_segment_ids': [segments[1]['id']],
            'source_media_guaranteed': False,
            'output_kinds': ['image'],
            'queries': ['still image composition'],
        }],
    }


def test_draft_schema_contains_only_compact_model_authored_fields():
    schema = DraftSourceAnalysis.model_json_schema()
    properties = schema['properties']
    task_properties = schema['$defs']['DraftProductionTask']['properties']

    assert set(properties) == {
        'purpose', 'orchestration_summary', 'orchestration_segment_ids', 'tasks',
    }
    assert set(task_properties) == {
        'id', 'title', 'requirement_summary', 'source_segment_ids', 'source_media_guaranteed',
        'output_kinds', 'queries',
    }
    assert not ({'requirements', 'source_quotes', 'skill_notes', 'recipe_notes',
                 'recipe_decisions'} & (set(properties) | set(task_properties)))


def test_compact_analysis_hydrates_existing_shape_and_preserves_exact_source_authority():
    source = (
        '# Shared rules\n\nConfirm **mode** before work.  Keep two spaces.\n\n'
        '# Deliverable\n\nCreate `one` still at C:\\\\refs\\hero.png.\n'
    )
    segments = segment_source(source)
    draft = compact_analysis(segments)
    draft['tasks'].append({
        **draft['tasks'][0],
        'id': 'render-second',
        'source_segment_ids': [segments[3]['id']],
    })

    analysis = validate_source_analysis(draft, source, segments)

    assert analysis['purpose'] == draft['purpose']
    assert analysis['requirements'] == [draft['tasks'][0]['requirement_summary']]
    assert analysis['recipe_notes'] == []
    assert analysis['recipe_decisions'] == []
    assert analysis['tasks'][0]['requirements'] == [draft['tasks'][0]['requirement_summary']]
    assert analysis['tasks'][0]['source_quotes'] == [segments[1]['text']]
    assert analysis['tasks'][1]['requirements'] == [draft['tasks'][1]['requirement_summary']]
    assert analysis['tasks'][1]['source_quotes'] == [segments[3]['text']]
    assert draft['orchestration_summary'] in analysis['skill_notes']
    assert segments[0]['text'] in analysis['skill_notes']
    assert 'authoritative' in analysis['skill_notes'].lower()
    assert 'orchestration_summary' not in analysis
    assert 'requirement_summary' not in analysis['tasks'][0]


def test_compact_analysis_hydrates_quotes_from_original_offsets_not_segment_copies():
    source = 'Confirm mode exactly.\n\nCreate the requested still.\n'
    segments = segment_source(source)
    copied_segments = [dict(segment) for segment in segments]
    copied_segments[0]['text'] = 'model-controlled replacement'
    copied_segments[1]['text'] = 'another replacement'

    analysis = validate_source_analysis(compact_analysis(segments), source, copied_segments)

    assert segments[0]['text'] in analysis['skill_notes']
    assert copied_segments[0]['text'] not in analysis['skill_notes']
    assert analysis['tasks'][0]['source_quotes'] == [segments[1]['text']]


@pytest.mark.parametrize(
    ('field', 'value'),
    [
        ('purpose', 'x' * 301),
        ('orchestration_summary', 'x' * 2001),
        ('orchestration_segment_ids', [f'S{i:04d}' for i in range(1, 34)]),
    ],
)
def test_compact_analysis_rejects_top_level_length_and_count_overflow(field, value):
    segments = segment_source('Shared rules.\n\nCreate a still.\n')
    payload = compact_analysis(segments)
    payload[field] = value

    with pytest.raises(ValidationError):
        DraftSourceAnalysis.model_validate(payload)


def test_compact_analysis_rejects_task_length_and_count_overflow():
    segments = segment_source('Shared rules.\n\nCreate a still.\n')
    payload = compact_analysis(segments)
    payload['tasks'][0]['title'] = 'x' * 201
    with pytest.raises(ValidationError):
        DraftSourceAnalysis.model_validate(payload)

    payload = compact_analysis(segments)
    payload['tasks'][0]['requirement_summary'] = 'x' * 401
    with pytest.raises(ValidationError):
        DraftSourceAnalysis.model_validate(payload)

    payload = compact_analysis(segments)
    payload['tasks'] *= 17
    with pytest.raises(ValidationError):
        DraftSourceAnalysis.model_validate(payload)


@pytest.mark.parametrize(
    'mutate',
    [
        lambda payload: payload.update(orchestration_segment_ids=['S0001', 'S0001']),
        lambda payload: payload.update(orchestration_segment_ids=['S9999']),
        lambda payload: payload['tasks'].append({**payload['tasks'][0]}),
    ],
)
def test_compact_analysis_rejects_duplicate_or_unknown_authority_ids(mutate):
    source = 'Shared rules.\n\nCreate a still.\n'
    segments = segment_source(source)
    payload = compact_analysis(segments)
    mutate(payload)

    with pytest.raises(ValueError):
        validate_source_analysis(payload, source, segments)


@pytest.mark.asyncio
async def test_recipe_inspection_receives_semantic_summaries_and_exact_source_rules():
    source = 'Confirm the selected mode exactly.\n\nCreate one still image.\n'
    segments = segment_source(source)
    analysis = validate_source_analysis(compact_analysis(segments), source, segments)
    catalog = [{
        'id': 'still-image', 'name': 'still image', 'output_kind': 'image',
        'system_prompt': 'Create one still image.',
    }]
    captured = {}

    async def ask(name, instruction, data, validate, amount):
        captured.update(data)
        return validate({'tasks': [{
            'task_id': 'render',
            'decisions': [{'recipe_id': 'still-image', 'constraint_checks': [], 'compatible': True, 'reason': 'Matches'}],
            'search_queries': [],
        }]})

    await resolve_task_recipes(analysis, catalog, ask)

    inspected_task = captured['tasks'][0]['task']
    assert inspected_task['requirements'] == [
        compact_analysis(segments)['tasks'][0]['requirement_summary'],
    ]
    assert inspected_task['source_quotes'] == [segments[1]['text']]
    assert compact_analysis(segments)['orchestration_summary'] in captured['cross_stage_rules']
    assert segments[0]['text'] in captured['cross_stage_rules']


@pytest.mark.asyncio
async def test_pipeline_invalidates_verbose_checkpoint_and_keeps_complete_source_for_generation_and_review():
    from novelvideo.freezone.skill_import_quality import run_quality_pipeline
    from test_freezone_agent_bundle import _bundle_payload

    source = '# Rules\n\nConfirm mode.\n\n# Output\n\nCreate one text report.\n'
    segments = segment_source(source)
    draft = compact_analysis(segments)
    record = {
        'id': 'c' * 32,
        'source': {'text': source},
        'catalog': [],
        'source_signature': 'stale-verbose-schema-signature',
        'checkpoint_signature': 'stale-verbose-checkpoint-signature',
        'checkpoints': {
            'analyzing': {
                'key': 'stale-key',
                'value': {
                    'purpose': 'Old verbose analysis',
                    'requirements': ['Old requirement'],
                    'skill_notes': 'Old notes',
                    'recipe_notes': [],
                    'recipe_decisions': [],
                    'tasks': [],
                },
            },
        },
    }
    responses = [draft, _bundle_payload(), {'summary': 'Preserved', 'issues': []}]
    prompts = []
    inputs = []

    async def generate(prompt):
        prompts.append(prompt)
        inputs.append(json.loads(prompt.split('INPUT DATA:\n', 1)[1]))
        return json.dumps(responses.pop(0))

    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *args: None)

    assert not responses
    assert 'navigation aids only' in prompts[0]
    assert 'exact cited source segments remain authoritative' in prompts[0]
    assert 'every requested media deliverable' in prompts[0]
    assert 'mutually exclusive branches' in prompts[0]
    assert 'distinct media-input contracts' in prompts[0]
    assert 'orchestration/tool-only steps' in prompts[0]
    assert 'source_segments' in inputs[0]
    assert inputs[1]['source'] == source
    assert inputs[2]['source_segments'] == segments
    assert all(
        source[segment['start']:segment['end']] == segment['text']
        for segment in inputs[2]['source_segments']
    )
    covered = {
        offset
        for segment in inputs[2]['source_segments']
        for offset in range(segment['start'], segment['end'])
    }
    assert all(character.isspace() or offset in covered for offset, character in enumerate(source))
    assert record['checkpoints']['analyzing']['value'] == draft
