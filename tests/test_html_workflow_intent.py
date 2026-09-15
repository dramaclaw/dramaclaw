from copy import deepcopy

import pytest

from novelvideo.freezone.agent_catalog_schema import validate_agent_recipe_config
from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands


def private_recipe(recipe_id, kind, **metadata):
    return dict(id=recipe_id, name=recipe_id, version='1', output_kind=kind, action_keys=[recipe_id],
                system_prompt='Produce the requested deliverable.', planning_prompt='Create a product page.',
                result_summary='Final deliverable.', **metadata)


@pytest.fixture
def private_catalog(monkeypatch):
    recipes = [private_recipe('private-html-copy', 'text'), private_recipe('private-html-image', 'image'),
               private_recipe('private-html-page', 'text', output_format='html')]
    skill = dict(id='private-html-smoke-test', version='1', allowed_recipe_ids=[r['id'] for r in recipes],
                 planning={'planning_notes': '先完成文案和配图，再制作产品介绍网页。'})
    monkeypatch.setattr(catalog, '_load_skill', lambda _: skill)
    monkeypatch.setattr(catalog, '_load_agent_config_items', lambda kind, *roots: recipes if kind == 'recipes' else [skill])
    return recipes


def test_normal_private_skill_intent_selects_html_from_recipe_metadata(private_catalog):
    result = catalog.compile_workflow_intent({
        'schema_version': 'freezone_workflow_intent.v1', 'skill_id': 'private-html-smoke-test',
        'user_goal': '制作包含文案和配图的产品介绍网页', 'planner': {'deliverable': 'html'},
        'items': [
            {'id': 'copy', 'title': '产品文案', 'recipe_id': 'private-html-copy'},
            {'id': 'image', 'title': '产品配图', 'recipe_id': 'private-html-image', 'reference_inputs': ['copy']},
            {'id': 'page', 'title': '产品介绍网页', 'recipe_id': 'private-html-page', 'reference_inputs': ['copy', 'image']},
        ],
    })
    assert result['ok'], result
    page = next(node for node in result['plan']['nodes'] if node['id'] == 'page')
    assert page['node_type'] == 'htmlArtifactNode'
    assert 'content' not in page['data']
    assert {'source': 'copy', 'target': 'page', 'link_type': 'prompt_for'} in result['plan']['edges']
    assert {'source': 'image', 'target': 'page', 'link_type': 'media_input_for'} in result['plan']['edges']
    compiled = build_workflow_graph_commands({'plan': result['plan']})
    assert any(command.get('action') == 'prepare' for command in compiled['commands'])


def test_html_output_metadata_is_durable_and_text_only(private_catalog):
    recipe = private_catalog[-1]
    assert validate_agent_recipe_config(recipe)['output_format'] == 'html'
    invalid = deepcopy(recipe)
    invalid['output_kind'] = 'image'
    with pytest.raises(ValueError):
        validate_agent_recipe_config(invalid)


def test_catalog_summary_advertises_html_target(private_catalog):
    summary = catalog._recipe_planning_summary(private_catalog[-1])
    assert summary['output_format'] == 'html'
    assert summary['node_type'] == 'htmlArtifactNode'
    assert catalog._recipe_planning_summary(private_catalog[0])['node_type'] == 'textAnnotationNode'


def test_html_recipe_cannot_silently_become_plain_text_node(private_catalog):
    from novelvideo.freezone.workflow_plan import validate_workflow_plan
    plan = {'schema_version': 'freezone_workflow_plan.v1', 'skill': {'id': 'private-html-smoke-test'},
            'nodes': [{'id': 'page', 'node_type': 'textAnnotationNode', 'data': {'workflowCatalog': {'recipeId': 'private-html-page'}}}],
            'edges': []}
    assert not validate_workflow_plan(plan, recipes_by_id={r['id']: r for r in private_catalog})['ok']


def test_html_recipe_format_survives_user_catalog_storage(monkeypatch, tmp_path):
    from novelvideo.freezone import agent_config_store
    monkeypatch.setattr(agent_config_store, 'OUTPUT_DIR', tmp_path)
    recipe = private_recipe('private-html-page', 'text', output_format='html')
    agent_config_store.save_user_agent_config_item(username='alice', kind='recipes', payload=recipe)
    stored = next(item for item in agent_config_store.list_user_agent_config_items('alice', 'recipes')
                  if item['id'] == recipe['id'])
    assert stored['output_format'] == 'html'


def test_registry_search_advertises_html_format_and_target(monkeypatch):
    from novelvideo.freezone.agent_workflows import registry
    recipe = private_recipe('product-page', 'text', output_format='html')
    monkeypatch.setattr(registry, 'list_user_agent_config_items', lambda username, kind: [recipe])
    results = registry.search_catalog(username='alice', kind='recipes', query='html')
    assert len(results) == 1
    assert results[0]['output_format'] == 'html'
    assert results[0]['node_type'] == 'htmlArtifactNode'


@pytest.mark.asyncio
async def test_normal_private_html_intent_survives_strict_mcp_boundaries(private_catalog):
    from novelvideo.chat import workflow_mcp
    from novelvideo.freezone.workflow_schema import workflow_plan_json_schema
    from jsonschema import Draft202012Validator
    import json

    intent = {'skill_id': 'private-html-smoke-test', 'user_goal': '制作产品介绍网页',
              'items': [{'id': name, 'title': name, 'recipe_id': 'private-html-' + name,
                         **({'reference_inputs': ['copy', 'image']} if name == 'page'
                            else {'reference_inputs': ['copy']} if name == 'image' else {})}
                        for name in ['copy', 'image', 'page']]}
    result = await workflow_mcp.call_tool('workflow_intent_compile', {'intent': intent})
    compiled = json.loads(result.content[0].text)
    assert compiled['ok'], compiled
    Draft202012Validator(workflow_plan_json_schema()).validate(compiled['plan'])
    result = await workflow_mcp.call_tool('workflow_graph_compile', {'plan': compiled['plan']})
    graph = json.loads(result.content[0].text)
    assert graph['ok'], graph
    result = await workflow_mcp.call_tool('workflow_skill_get', {'skill_id': intent['skill_id']})
    package = json.loads(result.content[0].text)
    assert package['ok'], package
    page = next(recipe for recipe in package['available_recipes'] if recipe['id'] == 'private-html-page')
    assert page['node_type'] == 'htmlArtifactNode'
    assert page['output_format'] == 'html'
