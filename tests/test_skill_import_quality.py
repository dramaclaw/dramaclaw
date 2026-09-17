import copy
import json
import pytest
from novelvideo.freezone.skill_import_contracts import CONVERSION_VERSION, content_hash, install_quality_errors, validate_bundle_review
from novelvideo.freezone.skill_import_evidence import segment_source
from novelvideo.freezone.skill_import_quality import review_schema, run_quality_pipeline


def test_prompt_only_reuse_fix_invalidates_prior_conversion_reports():
    assert CONVERSION_VERSION > 8
    assert install_quality_errors({'quality_report': {'version': 8, 'validated': True}}, {}) == [
        'Revalidate this draft using the current conversion checks'
    ]


def design_fixture():
    return {
        'purpose': 'Assess a document',
        'orchestration_summary': 'Ask for a document and assess it',
        'orchestration_segment_ids': ['S0001'],
        'tasks': [{
            'id': 'citations',
            'title': 'Citation assessment',
            'requirement_summary': 'Check citations',
            'source_segment_ids': ['S0001'],
            'source_media_guaranteed': False,
            'output_kinds': ['text'],
            'queries': ['citations'],
        }],
    }


def inspection_fixture(verdicts, queries=None):
    return {'tasks': [{'task_id': 'citations', 'decisions': [
        {'recipe_id': rid, 'constraint_checks': [], 'compatible': fits, 'reason': 'Matching method' if fits else 'Different method'}
        for rid, fits in verdicts], 'search_queries': queries or []}]}


def review_fixture():
    return {'summary': 'Method preserved', 'issues': []}


def blocker_fixture():
    return {'summary': 'Missing method', 'issues': [{'category': 'missing_method', 'severity': 'blocker', 'source_segment_ids': ['S0001'], 'evidence_paths': ['/recipes/0/system_prompt'], 'message': 'Citation checking is missing from the production method'}]}


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
    analysis_input = json.loads(prompts[0].split('INPUT DATA:\n', 1)[1])
    assert analysis_input['source_segments'][0]['text'] == 'Check citations'
    assert 'source' not in analysis_input
    review_input = json.loads(prompts[2].split('INPUT DATA:\n', 1)[1])
    assert review_input['source_segments'][0]['text'] == 'Check citations'
    assert 'source' not in review_input
    assert record['source_analysis']['tasks'][0]['source_quotes'] == ['Check citations']
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
    segments = segment_source('Check citations')
    with pytest.raises(ValueError):
        validate_bundle_review(issue, segments, {})
    review = validate_bundle_review(issue, segments, {'recipes': [{'system_prompt': 'text'}]})
    assert review['issues'][0]['source_quote'] == 'Check citations'
    assert 'source_segment_ids' not in review['issues'][0]


def test_review_hydrates_exact_source_segment_and_rejects_model_quotes():
    source = "# Review\n\nKeep `literal` \\\\ path and café exactly.\n"
    segments = segment_source(source)
    bundle = {'recipes': [{'system_prompt': 'Different method'}]}
    payload = {
        'summary': 'Mismatch',
        'issues': [{
            'category': 'changed_method',
            'severity': 'blocker',
            'source_segment_ids': ['S0002'],
            'evidence_paths': ['/recipes/0/system_prompt'],
            'message': 'The method changes the required literal syntax',
        }],
    }

    review = validate_bundle_review(payload, segments, bundle)

    assert review['issues'][0]['source_quote'] == segments[1]['text']
    copied = copy.deepcopy(payload)
    copied['issues'][0]['source_quote'] = 'model-authored copy'
    with pytest.raises(ValueError):
        validate_bundle_review(copied, segments, bundle)


def test_review_rejects_unknown_or_empty_blocker_evidence_and_invalid_pointers():
    segments = segment_source('Check citations')
    bundle = {'recipes': [{'system_prompt': 'Different method'}]}
    payload = blocker_fixture()

    payload['issues'][0]['source_segment_ids'] = ['S9999']
    with pytest.raises(ValueError, match='Unknown source segment ID'):
        validate_bundle_review(payload, segments, bundle)

    payload['issues'][0]['source_segment_ids'] = []
    with pytest.raises(ValueError, match='Blocking findings require'):
        validate_bundle_review(payload, segments, bundle)

    payload['issues'][0]['source_segment_ids'] = ['S0001']
    payload['issues'][0]['evidence_paths'] = []
    with pytest.raises(ValueError, match='Blocking findings require'):
        validate_bundle_review(payload, segments, bundle)

    payload['issues'][0]['evidence_paths'] = ['/recipes/1/system_prompt']
    with pytest.raises(ValueError, match='Invalid review evidence'):
        validate_bundle_review(payload, segments, bundle)

    payload['issues'][0]['evidence_paths'] = ['/recipes/0']
    with pytest.raises(ValueError, match='Invalid review evidence'):
        validate_bundle_review(payload, segments, bundle)


def test_advisory_review_does_not_require_source_or_bundle_evidence():
    review = validate_bundle_review(
        {'summary': 'Suggestion', 'issues': [{
            'category': 'advisory',
            'severity': 'blocker',
            'message': 'Consider clearer labels',
        }]},
        segment_source('Check citations'),
        {},
    )

    assert review['issues'][0]['severity'] == 'warning'
    assert review['issues'][0]['source_quote'] == ''
    assert review['issues'][0]['evidence_paths'] == []


def test_review_schema_enumerates_current_source_segments_and_bundle_pointers():
    segments = segment_source('First requirement.\n\nSecond requirement.\n')
    schema = review_schema({'recipes': [{'system_prompt': 'Method'}]}, segments)
    finding = schema['$defs']['DraftBundleFinding']['properties']

    assert finding['source_segment_ids']['items']['enum'] == ['S0001', 'S0002']
    assert finding['evidence_paths']['items']['enum'] == ['/recipes/0/system_prompt']


def test_install_rejects_old_reports_and_changed_drafts_but_not_environment_changes():
    bundle = {'skill': {}}
    report = {'version': CONVERSION_VERSION, 'validated': True, 'blockers': [], 'bundle_sha256': content_hash(bundle), 'structure': {'status': 'passed'}, 'coverage': {'status': 'passed'}}
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
    analysis_attempts = [e for e in record['diagnostics']
                         if e['event'] == 'model_started' and e['stage'] == 'analyzing']
    assert [(e['contract_attempt'], e['transport_attempt']) for e in analysis_attempts] == [(1, 1), (2, 1)]
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
async def test_transient_failure_retries_only_the_current_request_and_charges_each_submit():
    from test_freezone_agent_bundle import _bundle_payload
    responses = [design_fixture(), TimeoutError('provider timed out'), _bundle_payload(), review_fixture()]
    prompts = []
    record = record_fixture()

    async def generate(prompt):
        prompts.append(prompt)
        response = responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return json.dumps(response)

    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    assert record['status'] == 'ready'
    assert not responses
    assert len(prompts) == 4
    assert prompts[1] == prompts[2]
    assert record['checkpoints']['analyzing']['value']['purpose'] == design_fixture()['purpose']
    assert record['run_budget']['model_calls'] == 4
    assert sum(e['event'] == 'model_started' and e.get('stage') == 'analyzing'
               for e in record['diagnostics']) == 1
    generation_events = [
        (e['event'], e['contract_attempt'], e['transport_attempt'], e['call'])
        for e in record['diagnostics']
        if e.get('stage') == 'generating:0' and e['event'].startswith('model_')
    ]
    assert generation_events == [
        ('model_started', 1, 1, 2),
        ('model_failed', 1, 1, 2),
        ('model_started', 1, 2, 3),
        ('model_completed', 1, 2, 3),
    ]


@pytest.mark.asyncio
async def test_two_transient_failures_propagate_after_one_retry():
    record = record_fixture()
    submits = 0

    async def generate(_prompt):
        nonlocal submits
        submits += 1
        raise TimeoutError('provider timed out')

    with pytest.raises(TimeoutError, match='provider timed out'):
        await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    assert submits == 2
    assert record['run_budget']['model_calls'] == 2
    failures = [e for e in record['diagnostics'] if e['event'] == 'model_failed']
    assert [(e['contract_attempt'], e['transport_attempt']) for e in failures] == [(1, 1), (1, 2)]


@pytest.mark.asyncio
async def test_non_transient_failure_is_not_retried():
    record = record_fixture()
    submits = 0

    async def generate(_prompt):
        nonlocal submits
        submits += 1
        raise RuntimeError('provider rejected the request')

    with pytest.raises(RuntimeError, match='provider rejected'):
        await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    assert submits == 1
    assert record['run_budget']['model_calls'] == 1


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
    from novelvideo.freezone.skill_import_retrieval import SourceAnalysis, validate_source_analysis
    design = validate_source_analysis(design_fixture(), 'Check citations')
    assert SourceAnalysis.model_validate({**design, 'native_schemas': {'extra_notes': 'advisory'}}).model_dump() == design


@pytest.mark.asyncio
async def test_catalog_is_compared_before_design_and_reused_definition_is_hydrated():
    from test_freezone_agent_bundle import _bundle_payload
    from novelvideo.freezone.agent_catalog_schema import validate_agent_recipe_config
    payload = _bundle_payload()
    original = copy.deepcopy(payload['recipes'][0])
    record = record_fixture()
    record['catalog'] = [original]
    payload['recipes'] = []
    responses = [design_fixture(), inspection_fixture([(record['catalog'][0]['id'], True)]), payload, review_fixture()]
    prompts = []
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert original['system_prompt'] not in prompts[0]
    assert original['system_prompt'] in prompts[1]
    assert record['status'] == 'ready'
    assert record['bundle']['recipes'] == [validate_agent_recipe_config(original)]
    assert record['catalog'] == [original]
    assert record['quality_report']['recipe_reuse'] == {'reused_ids': [original['id']], 'new_ids': []}
    assert record['task_recipe_resolutions'][0]['selected_recipe_id'] == original['id']


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
    responses = [design_fixture(), inspection_fixture([(record['catalog'][0]['id'], False)]), payload, review_fixture()]
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


@pytest.mark.asyncio
async def test_recipe_retrieval_reads_full_candidates_and_can_expand_search():
    from test_freezone_agent_bundle import _bundle_payload
    payload = _bundle_payload()
    original = copy.deepcopy(payload['recipes'][0])
    other = copy.deepcopy(original)
    other.update(id='translation-only', name='translation', system_prompt='Only translate; never check citations')
    record = record_fixture()
    record['catalog'] = [other, original]
    payload['recipes'] = []
    design = design_fixture()
    design['tasks'][0]['queries'] = ['translation']
    responses = [design, inspection_fixture([(other['id'], False)], ['community-brief']),
                 inspection_fixture([(original['id'], True)]), payload, review_fixture()]
    prompts = []
    async def generate(prompt):
        prompts.append(prompt)
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    data = json.loads(prompts[2].split('INPUT DATA:\n', 1)[1])
    assert data['candidate_recipes'] == [original]
    generation = json.loads(prompts[3].split('INPUT DATA:\n', 1)[1])
    assert generation['existing_recipes'] == [original]
    assert record['status'] == 'ready'
    async def no_call(prompt):
        raise AssertionError('Expanded-search checkpoints must be reused')
    await run_quality_pipeline(record, 'alice', no_call, lambda: None, lambda *a: None)
    assert record['quality_report']['validated']


@pytest.mark.asyncio
async def test_first_group_retry_then_second_timeout_still_preserves_expansion():
    from test_freezone_agent_bundle import _bundle_payload

    body = 'Apply the complete production procedure. ' * 700
    design = design_fixture()
    design['tasks'] = [
        {
            'id': 'translate', 'title': 'translation', 'requirement_summary': 'Check translation',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['text'], 'queries': ['translation'],
        },
        {
            'id': 'illustrate', 'title': 'illustration', 'requirement_summary': 'Check illustration',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['image'], 'queries': ['illustration'],
        },
        {
            'id': 'animate', 'title': 'animation', 'requirement_summary': 'Check animation',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['video'], 'queries': ['animation'],
        },
    ]
    record = record_fixture()
    recipe = _bundle_payload()['recipes'][0]
    record['catalog'] = []
    for recipe_id, name, output_kind in [
        ('translation-only', 'translation', 'text'),
        ('citation-review', 'citations', 'text'),
        ('illustration-method', 'illustration', 'image'),
        ('animation-method', 'animation', 'video'),
    ]:
        candidate = copy.deepcopy(recipe)
        candidate.update(id=recipe_id, name=name, output_kind=output_kind, system_prompt=body)
        record['catalog'].append(candidate)
    inspection_submits = []
    first_inspection = True

    async def generate(prompt):
        nonlocal first_inspection
        data = json.loads(prompt.split('INPUT DATA:\n', 1)[1])
        if 'candidate_recipes' in data:
            task_ids = tuple(entry['task']['id'] for entry in data['tasks'])
            candidate_ids = tuple(recipe['id'] for recipe in data['candidate_recipes'])
            inspection_submits.append((task_ids, candidate_ids))
            if first_inspection:
                first_inspection = False
                raise TimeoutError('provider timed out')
            if task_ids == ('illustrate',):
                raise TimeoutError('provider timed out')
            results = []
            for entry in data['tasks']:
                task_id = entry['task']['id']
                results.append({
                    'task_id': task_id,
                    'decisions': [
                        {
                            'recipe_id': recipe_id,
                            'constraint_checks': [], 'compatible': recipe_id != 'translation-only',
                            'reason': 'Complete method' if recipe_id != 'translation-only' else 'Wrong method',
                        }
                        for recipe_id in entry['candidate_ids']
                    ],
                    'search_queries': ['citations'] if task_id == 'translate' else [],
                })
            return json.dumps({'tasks': results})
        if 'bundle' in data:
            return json.dumps(review_fixture())
        if 'source_segments' in data:
            return json.dumps(design)
        return json.dumps(_bundle_payload())

    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    # The first two batches overlap; completion order is not part of the contract.
    from collections import Counter
    assert Counter(inspection_submits) == Counter([
        (('translate',), ('translation-only',)),
        (('translate',), ('translation-only',)),
        (('illustrate',), ('illustration-method',)),
        (('translate',), ('citation-review',)),
    ])
    assert record['run_budget']['matching_calls'] == len(inspection_submits) <= 4
    assert record['quality_report']['validated']
    resolutions = {item['task_id']: item for item in record['task_recipe_resolutions']}
    assert resolutions['translate']['selected_recipe_id'] == 'citation-review'
    assert resolutions['illustrate']['selected_recipe_id'] is None
    assert resolutions['illustrate']['new_recipe_reason']
    assert resolutions['animate']['selected_recipe_id'] is None
    assert resolutions['animate']['new_recipe_reason']
    assert 'illustration-method' not in record['bundle']['skill']['allowed_recipe_ids']


@pytest.mark.asyncio
async def test_third_first_round_timeout_is_not_retried_and_expansion_still_submits():
    from test_freezone_agent_bundle import _bundle_payload

    body = 'Apply the complete production procedure. ' * 700
    design = design_fixture()
    design['tasks'] = [
        {
            'id': 'translate', 'title': 'translation', 'requirement_summary': 'Check translation',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['text'], 'queries': ['translation'],
        },
        {
            'id': 'illustrate', 'title': 'illustration', 'requirement_summary': 'Check illustration',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['image'], 'queries': ['illustration'],
        },
        {
            'id': 'animate', 'title': 'animation', 'requirement_summary': 'Check animation',
            'source_segment_ids': ['S0001'], 'source_media_guaranteed': False, 'output_kinds': ['video'], 'queries': ['animation'],
        },
    ]
    record = record_fixture()
    recipe = _bundle_payload()['recipes'][0]
    record['catalog'] = []
    for recipe_id, name, output_kind in [
        ('translation-only', 'translation', 'text'),
        ('citation-review', 'citations', 'text'),
        ('illustration-method', 'illustration', 'image'),
        ('animation-method', 'animation', 'video'),
    ]:
        candidate = copy.deepcopy(recipe)
        candidate.update(id=recipe_id, name=name, output_kind=output_kind, system_prompt=body)
        record['catalog'].append(candidate)
    inspection_submits = []

    async def generate(prompt):
        data = json.loads(prompt.split('INPUT DATA:\n', 1)[1])
        if 'candidate_recipes' in data:
            task_ids = tuple(entry['task']['id'] for entry in data['tasks'])
            candidate_ids = tuple(recipe['id'] for recipe in data['candidate_recipes'])
            inspection_submits.append((task_ids, candidate_ids))
            if task_ids == ('animate',):
                raise TimeoutError('provider timed out')
            results = []
            for entry in data['tasks']:
                task_id = entry['task']['id']
                results.append({
                    'task_id': task_id,
                    'decisions': [
                        {
                            'recipe_id': recipe_id,
                            'constraint_checks': [], 'compatible': recipe_id != 'translation-only',
                            'reason': 'Complete method' if recipe_id != 'translation-only' else 'Wrong method',
                        }
                        for recipe_id in entry['candidate_ids']
                    ],
                    'search_queries': ['citations'] if task_id == 'translate' else [],
                })
            return json.dumps({'tasks': results})
        if 'bundle' in data:
            return json.dumps(review_fixture())
        if 'source_segments' in data:
            return json.dumps(design)
        return json.dumps(_bundle_payload())

    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    assert inspection_submits == [
        (('translate',), ('translation-only',)),
        (('illustrate',), ('illustration-method',)),
        (('animate',), ('animation-method',)),
        (('translate',), ('citation-review',)),
    ]
    assert record['run_budget']['matching_calls'] == len(inspection_submits) <= 4
    resolutions = {item['task_id']: item for item in record['task_recipe_resolutions']}
    assert resolutions['translate']['selected_recipe_id'] == 'citation-review'
    assert resolutions['animate']['selected_recipe_id'] is None
    assert resolutions['animate']['new_recipe_reason']
    assert 'animation-method' not in record['bundle']['skill']['allowed_recipe_ids']
    assert record['quality_report']['validated']


@pytest.mark.asyncio
async def test_contract_repair_and_transport_retry_cannot_consume_expansion_submit():
    from test_freezone_agent_bundle import _bundle_payload

    design = design_fixture()
    design['tasks'][0].update(id='translation', title='translation', queries=['translation'])
    record = record_fixture()
    recipe = _bundle_payload()['recipes'][0]
    record['catalog'] = []
    for recipe_id, name in [('translation-only', 'translation'), ('citation-review', 'citations')]:
        candidate = copy.deepcopy(recipe)
        candidate.update(id=recipe_id, name=name, output_kind='text', system_prompt='Check the full method.')
        record['catalog'].append(candidate)
    inspected = []

    async def generate(prompt):
        decoder = json.JSONDecoder()
        data, _ = decoder.raw_decode(prompt.split('INPUT DATA:\n', 1)[1])
        if 'candidate_recipes' in data:
            candidate_id = data['candidate_recipes'][0]['id']
            inspected.append(candidate_id)
            if candidate_id == 'translation-only':
                if inspected.count(candidate_id) == 1:
                    return '{}'
                if inspected.count(candidate_id) == 2:
                    raise TimeoutError('provider timed out')
            return json.dumps({'tasks': [{
                'task_id': 'translation',
                'decisions': [{'recipe_id': candidate_id, 'constraint_checks': [], 'compatible': candidate_id == 'citation-review',
                               'reason': 'Complete method' if candidate_id == 'citation-review' else 'Wrong method'}],
                'search_queries': ['citations'] if candidate_id == 'translation-only' else [],
            }]})
        if 'bundle' in data:
            return json.dumps(review_fixture())
        if 'source_segments' in data:
            return json.dumps(design)
        return json.dumps(_bundle_payload())

    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)

    assert inspected == ['translation-only'] * 3 + ['citation-review']
    assert record['run_budget']['matching_calls'] == 4
    assert record['task_recipe_resolutions'][0]['selected_recipe_id'] == 'citation-review'
    assert record['quality_report']['validated']


def test_recipe_summary_is_versioned_hint_and_never_changes_definition():
    from novelvideo.freezone.skill_import_retrieval import recipe_summaries, checked_ids
    recipe = {'id': 'long-method', 'version': 1, 'system_prompt': 'a' * 2000,
              'must_have_items': ['single asset', 'never grid'], 'output_kind': 'image'}
    original = copy.deepcopy(recipe)
    summary = recipe_summaries([recipe])[0]
    assert len(summary['instruction_excerpt']) == 200
    assert summary['excerpted_fields'] == ['system_prompt']
    assert recipe == original
    recipe.update(version=2, system_prompt='Updated method')
    assert recipe_summaries([recipe])[0]['instruction_excerpt'] == 'Updated method'
    assert recipe_summaries([recipe])[0]['version'] == 2
    with pytest.raises(ValueError):
        checked_ids(['unknown'], [recipe])
    with pytest.raises(ValueError):
        checked_ids(['long-method'], [recipe], {'long-method'})


@pytest.mark.asyncio
async def test_uninspected_existing_recipe_cannot_be_reused_by_generation():
    from test_freezone_agent_bundle import _bundle_payload
    payload = _bundle_payload()
    record = record_fixture()
    record['catalog'] = copy.deepcopy(payload['recipes'])
    responses = [design_fixture(), inspection_fixture([(record['catalog'][0]['id'], False)]), payload, payload, payload]
    async def generate(prompt):
        return json.dumps(responses.pop(0))
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert not record['quality_report']['validated']
    assert 'Cannot reuse a Recipe without inspecting' in str(record['quality_report'])


def test_task_analysis_requires_known_source_evidence_and_bounded_candidate_responses():
    from novelvideo.freezone.skill_import_retrieval import validate_source_analysis, CandidateSelection, CandidateInspection
    design = design_fixture()
    design['tasks'][0]['source_segment_ids'] = ['S9999']
    with pytest.raises(ValueError):
        validate_source_analysis(design, 'Different source')
    with pytest.raises(ValueError):
        CandidateSelection.model_validate({'candidate_ids': ['a', 'b', 'c', 'd']})
    with pytest.raises(ValueError):
        CandidateInspection.model_validate({'purpose': 'Repeat the full analysis', 'decisions': []})


@pytest.mark.asyncio
async def test_run_timeout_preserves_candidate_and_cannot_install(monkeypatch):
    import asyncio
    from novelvideo.freezone import skill_import_quality as module
    from novelvideo.freezone.skill_import_budget import ImportBudget
    from test_freezone_agent_bundle import _bundle_payload
    monkeypatch.setattr(module, 'ImportBudget', lambda: ImportBudget(timeout_seconds=.04))
    record = record_fixture()
    responses = [design_fixture(), _bundle_payload()]
    async def generate(prompt):
        if responses:
            return json.dumps(responses.pop(0))
        await asyncio.sleep(1)
        return json.dumps(review_fixture())
    await run_quality_pipeline(record, 'alice', generate, lambda: None, lambda *a: None)
    assert record['bundle']
    assert not record['quality_report']['validated']
    assert install_quality_errors(record, record['bundle'])
    assert record['run_budget']['model_calls'] == 3
