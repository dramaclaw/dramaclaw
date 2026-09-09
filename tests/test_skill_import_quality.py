import copy
import json
import pytest
from novelvideo.freezone.skill_import_contracts import content_hash, install_quality_errors, validate_bundle_review
from novelvideo.freezone.skill_import_quality import run_quality_pipeline


def design_fixture():
    return {'purpose': 'Assess a document', 'requirements': ['Check citations'], 'skill_notes': 'Ask for a document and assess it', 'recipe_notes': ['Create a citation review recipe'], 'recipe_decisions': []}


def review_fixture():
    return {'summary': 'Method preserved', 'issues': []}


def blocker_fixture():
    return {'summary': 'Missing method', 'issues': [{'category': 'missing_method', 'severity': 'blocker', 'source_quote': 'Check citations', 'evidence_paths': ['/recipes/0/system_prompt'], 'message': 'Citation checking is missing from the production method'}]}


def record_fixture():
    return {'id': 'a' * 32, 'source': {'text': 'Check citations'}, 'catalog': []}


@pytest.mark.asyncio
async def test_default_conversion_uses_three_calls_and_installs_without_graph_or_capability_snapshot():
    from test_freezone_agent_bundle import _bundle_payload
    record = record_fixture()
    # Legacy blockers must not survive into final-package evaluation.
    record['adaptation'] = {'mappings': [{'status': 'unsupported', 'reason': 'No existing Recipe/model'}]}
    record['plan_checks'] = [{'failed': True}]
    responses = [design_fixture(), _bundle_payload(), review_fixture()]
    prompts = []
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert len(prompts) == 3
    assert record['status'] == 'ready'
    assert 'planning' not in record['quality_report']
    assert 'capability_sha256' not in record['quality_report']
    assert 'adaptation' not in record and 'plan_checks' not in record
    assert not install_quality_errors(record, record['bundle'])
    async def no_call(prompt):
        raise AssertionError('Valid checkpoints must be reused')
    await run_quality_pipeline(record, 'alice', no_call, lambda: None, lambda *a: None)
    assert record['quality_report']['validated']


@pytest.mark.asyncio
async def test_concrete_content_defect_repairs_candidate():
    from test_freezone_agent_bundle import _bundle_payload
    responses = [design_fixture(), _bundle_payload(), blocker_fixture(), _bundle_payload(), review_fixture()]
    record = record_fixture()
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['status'] == 'ready'
    assert not responses


@pytest.mark.asyncio
async def test_revalidate_does_not_overwrite_user_draft_or_bypass_content_blockers():
    from novelvideo.freezone.agent_bundle_store import validate_agent_bundle
    from test_freezone_agent_bundle import _bundle_payload
    record = record_fixture()
    record['validation_candidate'] = validate_agent_bundle(_bundle_payload())['bundle']
    responses = [design_fixture(), blocker_fixture()]
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert not record['quality_report']['validated']
    assert install_quality_errors(record, record['bundle'])
    assert record['bundle'] == record['validation_candidate']


@pytest.mark.asyncio
async def test_advisory_review_is_installable_with_warning():
    from test_freezone_agent_bundle import _bundle_payload
    review = {'summary': 'Preserved', 'issues': [{'category': 'advisory', 'severity': 'blocker', 'message': 'Consider clearer labels'}]}
    responses = [design_fixture(), _bundle_payload(), review]
    record = record_fixture()
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['status'] == 'needs_review'
    assert record['warnings'] == ['Consider clearer labels']
    assert not install_quality_errors(record, record['bundle'])


def test_blocking_review_needs_source_and_bundle_evidence():
    issue = blocker_fixture()
    with pytest.raises(ValueError):
        validate_bundle_review(issue, 'Other source', {'recipes': [{'system_prompt': 'text'}]})
    with pytest.raises(ValueError):
        validate_bundle_review(issue, 'Check citations', {})
    assert validate_bundle_review(issue, 'Check citations', {'recipes': [{'system_prompt': 'text'}]})


def test_install_rejects_old_reports_and_changed_drafts_but_not_environment_changes():
    bundle = {'skill': {}}
    report = {'version': 3, 'validated': True, 'blockers': [], 'bundle_sha256': content_hash(bundle), 'structure': {'status': 'passed'}, 'coverage': {'status': 'passed'}}
    record = {'quality_report': report}
    assert not install_quality_errors(record, bundle)
    assert install_quality_errors(record, {'changed': True})
    report['version'] = 2
    assert install_quality_errors(record, bundle)


@pytest.mark.asyncio
async def test_invalid_response_repair_is_logged_privately_and_includes_previous_answer(caplog):
    from test_freezone_agent_bundle import _bundle_payload
    from novelvideo.freezone.skill_import import public_record
    responses = [{'invalid': True}, design_fixture(), _bundle_payload(), review_fixture()]
    prompts = []
    record = record_fixture()
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert 'PREVIOUS RESPONSE' in prompts[1] and 'invalid' in prompts[1]
    assert any(e['event'] == 'validation_failed' and 'response' in e for e in record['diagnostics'])
    assert 'diagnostics' not in public_record(record)


def test_diagnostics_redact_and_bound_payloads():
    from novelvideo.freezone.skill_import_quality import append_diagnostic
    record = {'id': 'd' * 32}
    for _ in range(30):
        append_diagnostic(record, 'response', response='api_key=private-value ' + 'x' * 100_000)
    encoded = json.dumps(record['diagnostics'], ensure_ascii=False).encode()
    assert b'private-value' not in encoded
    assert len(encoded) <= 2_000_000 and record['diagnostics_dropped'] > 0


@pytest.mark.asyncio
async def test_model_exception_is_logged_without_secrets():
    record = record_fixture()
    async def generate(prompt): raise RuntimeError('api_key=private-value connection failed')
    with pytest.raises(RuntimeError):
        await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    failure = next(e for e in record['diagnostics'] if e['event'] == 'model_failed')
    assert failure['error_type'] == 'RuntimeError' and 'private-value' not in failure['error']


@pytest.mark.asyncio
async def test_saved_defaults_are_revalidated_before_report_passes():
    from test_freezone_agent_bundle import _bundle_payload
    from novelvideo.freezone.agent_bundle_store import validate_agent_bundle
    valid = validate_agent_bundle(_bundle_payload())['bundle']
    invalid = copy.deepcopy(valid)
    invalid['skill']['evaluation'].pop('domain_constraints')
    responses = [design_fixture(), invalid, valid, review_fixture()]
    prompts = []
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    record = record_fixture()
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['quality_report']['validated']
    assert 'domain_constraints must contain at least one item' in prompts[2]
    assert validate_agent_bundle(record['bundle'])['bundle'] == record['bundle']



def test_internal_design_ignores_auxiliary_fields():
    from novelvideo.freezone.skill_import_contracts import ConversionDesign
    assert ConversionDesign.model_validate({**design_fixture(), 'native_schemas': {'extra_notes': 'advisory'}}).model_dump() == design_fixture()


@pytest.mark.asyncio
async def test_catalog_is_compared_before_design_and_reused_definition_is_hydrated():
    from test_freezone_agent_bundle import _bundle_payload
    from novelvideo.freezone.agent_catalog_schema import validate_agent_recipe_config
    payload = _bundle_payload()
    original = copy.deepcopy(payload['recipes'][0])
    record = record_fixture()
    record['catalog'] = [original]
    payload['recipes'] = []
    design = design_fixture()
    design['recipe_decisions'] = [{'recipe_id': original['id'], 'action': 'reuse',
        'compared_recipe_ids': [original['id']], 'reason': 'Existing method accepts the required task context unchanged'}]
    responses = [design, payload, review_fixture()]
    prompts = []
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert original['system_prompt'] in prompts[0]
    assert record['status'] == 'ready'
    assert record['bundle']['recipes'] == [validate_agent_recipe_config(original)]
    assert record['catalog'] == [original]
    assert record['quality_report']['recipe_reuse'] == {'reused_ids': [original['id']], 'new_ids': []}
    assert record['conversion_design']['recipe_decisions'] == design['recipe_decisions']


def test_hydration_does_not_overwrite_modified_definitions_or_invent_missing_recipes():
    from novelvideo.freezone.skill_import_quality import hydrate_catalog_recipes
    from novelvideo.freezone.skill_import import validate_reused_recipes
    from novelvideo.freezone.agent_bundle_store import validate_agent_bundle
    from test_freezone_agent_bundle import _bundle_payload
    payload = validate_agent_bundle(_bundle_payload())['bundle']
    catalog = copy.deepcopy(payload['recipes'])
    payload['recipes'][0]['system_prompt'] = 'Changed method'
    hydrated = hydrate_catalog_recipes(payload, catalog)
    with pytest.raises(ValueError, match='differs from catalog'):
        validate_reused_recipes(hydrated, catalog)
    payload['recipes'] = []
    payload['skill']['allowed_recipe_ids'] = ['unknown-new-method']
    assert hydrate_catalog_recipes(payload, catalog)['recipes'] == []


@pytest.mark.asyncio
async def test_same_output_kind_does_not_force_reuse_when_method_conflicts():
    from test_freezone_agent_bundle import _bundle_payload
    record = record_fixture()
    payload = _bundle_payload()
    existing = copy.deepcopy(payload['recipes'][0])
    existing.update(id='different-method', system_prompt='Only translate; never evaluate citations')
    record['catalog'] = [existing]
    design = design_fixture()
    design['recipe_decisions'] = [{'recipe_id': payload['recipes'][0]['id'], 'action': 'new',
        'compared_recipe_ids': ['different-method'], 'reason': 'Translation cannot perform citation assessment'}]
    responses = [design, payload, review_fixture()]
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['status'] == 'ready'
    assert record['quality_report']['recipe_reuse'] == {
        'reused_ids': [], 'new_ids': payload['skill']['allowed_recipe_ids']}


@pytest.mark.asyncio
async def test_format_repair_does_not_consume_only_method_repair_opportunity():
    from test_freezone_agent_bundle import _bundle_payload
    malformed = _bundle_payload()
    malformed['skill']['evaluation']['domain_constraints'] = []
    responses = [design_fixture(), malformed, _bundle_payload(), blocker_fixture(), _bundle_payload(), review_fixture()]
    record = record_fixture()
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['status'] == 'ready'
    assert not responses


@pytest.mark.asyncio
async def test_role_rule_changes_invalidate_old_conversion_checkpoints(monkeypatch):
    from novelvideo.freezone import skill_import_quality as module
    from test_freezone_agent_bundle import _bundle_payload
    record = record_fixture()
    responses = [design_fixture(), _bundle_payload(), review_fixture()] * 2
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    monkeypatch.setattr(module, 'ROLE_RULES', module.ROLE_RULES + '\nUpdated method compatibility rule')
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert not responses
    assert record['quality_report']['validated']


@pytest.mark.asyncio
async def test_import_repairs_empty_prompt_guide_instead_of_approving_it():
    from test_freezone_agent_bundle import _bundle_payload
    empty = _bundle_payload()
    empty['skill']['planning']['prompt_guide'] = '   '
    responses = [design_fixture(), empty, _bundle_payload(), review_fixture()]
    record = record_fixture()
    async def generate(prompt): return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert not responses
    assert record['status'] == 'ready'
    assert record['bundle']['skill']['planning']['prompt_guide'].strip()
