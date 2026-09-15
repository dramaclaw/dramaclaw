from copy import deepcopy

import pytest

from novelvideo.freezone.skill_import_capabilities import (
    snapshot_capabilities,
    validate_candidate_plan,
)


def candidate():
    bundle = {
        'skill': {'id': 'example', 'version': 1, 'allowed_recipe_ids': ['render']},
        'recipes': [{'id': 'render', 'version': 1, 'output_kind': 'image',
                     'requires_source_media': False}],
    }
    plan = {
        'schema_version': 'freezone_workflow_plan.v1',
        'skill': {'id': 'example', 'version': 1},
        'nodes': [
            {'id': 'brief', 'node_type': 'textAnnotationNode', 'stage': 'input',
             'data': {'content': 'A representative request'}},
            {'id': 'output', 'node_type': 'imageGenNode', 'data': {
                'workflowCatalog': {'skillId': 'example', 'recipeId': 'render'}}},
        ],
        'edges': [{'source': 'brief', 'target': 'output', 'link_type': 'prompt_for'}],
    }
    return bundle, plan


def test_snapshot_is_stable_and_does_not_claim_live_models():
    first = snapshot_capabilities()
    assert first == snapshot_capabilities()
    assert len(first['capability_hash']) == 64
    assert first['models']['availability'] == 'unknown'
    assert first['plan_schema']['properties']['nodes']
    first['node_types'].clear()
    assert snapshot_capabilities()['node_types']


def test_valid_plan_compiles_without_mutation_or_execution():
    bundle, plan = candidate()
    before = deepcopy((bundle, plan))
    result = validate_candidate_plan(bundle, plan)
    assert result['status'] == 'passed', result
    assert result['errors'] == []
    assert result['compilation']['node_count'] == 2
    assert result['compilation']['execution_requested'] is False
    assert (bundle, plan) == before


@pytest.mark.parametrize('change, message', [
    ('reference', 'unknown recipe'),
    ('node_type', 'incompatible'),
    ('source', 'requires source media'),
    ('edge', 'unknown node'),
    ('membership', 'not allowed'),
])
def test_invalid_candidate_plans_fail(change, message):
    bundle, plan = candidate()
    if change == 'reference':
        plan['nodes'][1]['data']['workflowCatalog']['recipeId'] = 'missing'
    elif change == 'node_type':
        plan['nodes'][1]['node_type'] = 'audioNode'
    elif change == 'source':
        bundle['recipes'][0]['requires_source_media'] = True
    elif change == 'edge':
        plan['edges'][0]['source'] = 'missing'
    else:
        bundle['skill']['allowed_recipe_ids'] = []
        del plan['nodes'][1]['data']['workflowCatalog']['skillId']
    result = validate_candidate_plan(bundle, plan)
    assert result['status'] == 'failed'
    assert any(message in error for error in result['errors']), result


def test_malformed_plan_is_reported_not_raised():
    bundle, plan = candidate()
    plan['edges'][0]['source'] = []
    assert validate_candidate_plan(bundle, plan)['status'] == 'failed'
