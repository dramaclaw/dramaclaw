import json

import pytest
from novelvideo.freezone.skill_import_retrieval import (
    _prompt_only_text_recipe, resolve_task_recipes, validate_source_analysis,
)
from novelvideo.freezone.skill_import_evidence import segment_source


def task(task_id, query, output='text'):
    return {'id': task_id, 'title': query, 'queries': [query], 'output_kinds': [output],
            'requirements': [query], 'source_quotes': [query], 'source_media_guaranteed': False}


def draft_payload(task_payload, purpose='Review', orchestration='Confirm'):
    return {
        'purpose': purpose,
        'orchestration_summary': orchestration,
        'orchestration_segment_ids': ['S0001'],
        'tasks': [task_payload],
    }


@pytest.mark.asyncio
async def test_separate_batches_reuse_shared_definition_and_keep_task_choices_independent():
    catalog = [{'id': 'citations', 'name': 'citations', 'output_kind': 'text', 'system_prompt': 'Check citations'}]
    calls = []
    async def ask(name, instruction, data, validate, amount):
        calls.append(data)
        return validate({'tasks': [{'task_id': t['task']['id'], 'decisions': [
            {'recipe_id': 'citations', 'constraint_checks': [], 'compatible': True, 'reason': 'Checks citations'}],
            'search_queries': []} for t in data['tasks']]})
    result = await resolve_task_recipes({'tasks': [task('a','citations'),task('b','citations')], 'skill_notes': 'Confirm'}, catalog, ask)
    assert len(calls) == 2
    assert all(len(call['tasks']) == 1 for call in calls)
    assert len(calls[0]['candidate_recipes']) == 1
    assert result['selected_ids'] == ['citations']
    assert [t['selected_recipe_id'] for t in result['tasks']] == ['citations','citations']


@pytest.mark.asyncio
async def test_text_deliverable_never_reuses_prompt_only_text_recipe():
    catalog = [
        {'id': 'general-text', 'name': 'general text', 'output_kind': 'text',
         'system_prompt': 'Rewrite rough user intent into a clear instruction. Output ONLY refined prompt text.'},
        {'id': 'final-spec', 'name': 'final specification', 'output_kind': 'text',
         'system_prompt': 'Produce the final specification document now.'},
    ]
    inspected = []

    async def ask(name, instruction, data, validate, amount):
        inspected.extend(recipe['id'] for recipe in data['candidate_recipes'])
        assert 'text Recipes must directly produce the final text deliverable' in instruction
        assert 'mandatory genre, species, costume or subject' in instruction
        return validate({'tasks': [{'task_id': 'spec', 'decisions': [
            {'recipe_id': rid, 'constraint_checks': [], 'compatible': True, 'reason': 'Can write the specification'}
            for rid in data['tasks'][0]['candidate_ids']], 'search_queries': []}]})

    result = await resolve_task_recipes(
        {'tasks': [task('spec', 'final specification document')], 'skill_notes': 'Deliver the final document'},
        catalog, ask,
    )
    assert inspected == ['final-spec']
    assert result['selected_ids'] == ['final-spec']


def test_prompt_only_filter_is_limited_to_explicit_text_contracts():
    assert _prompt_only_text_recipe({'output_kind': 'text', 'system_prompt': '只输出优化后的提示词。'})
    assert not _prompt_only_text_recipe({'output_kind': 'image', 'system_prompt': '只输出优化后的提示词。'})
    assert not _prompt_only_text_recipe({'output_kind': 'text', 'system_prompt': '直接输出最终文档。'})
    assert not _prompt_only_text_recipe({
        'output_kind': 'text',
        'system_prompt': 'Do not output only refined prompt text. Produce the final specification document.',
    })
    assert not _prompt_only_text_recipe({
        'output_kind': 'text', 'system_prompt': '不要只输出优化后的提示词。请直接产出最终规格文档。',
    })
    assert not _prompt_only_text_recipe({
        'output_kind': 'text', 'system_prompt': '只输出最终文档，不要输出提示词。',
    })
    assert not _prompt_only_text_recipe({
        'output_kind': 'text', 'system_prompt': '仅输出完整评审报告，禁止输出提示词。',
    })


@pytest.mark.asyncio
async def test_prompt_deliverable_may_reuse_prompt_only_text_recipe():
    catalog = [{'id': 'prompt-editor', 'name': 'prompt editor', 'output_kind': 'text',
                'system_prompt': 'Output ONLY refined prompt text.'}]
    inspected = []

    async def ask(name, instruction, data, validate, amount):
        inspected.extend(r['id'] for r in data['candidate_recipes'])
        return validate({'tasks': [{'task_id': 'prompt', 'decisions': [
            {'recipe_id': 'prompt-editor', 'constraint_checks': [], 'compatible': True, 'reason': 'Final deliverable is a prompt'}]}]})

    result = await resolve_task_recipes(
        {'tasks': [task('prompt', 'refine prompt text')], 'skill_notes': 'Deliver a refined prompt'},
        catalog, ask,
    )
    assert inspected == ['prompt-editor']
    assert result['selected_ids'] == ['prompt-editor']


@pytest.mark.asyncio
async def test_storyboard_prompt_title_remains_a_prompt_deliverable():
    catalog = [{'id': 'prompt-editor', 'name': 'storyboard prompt', 'output_kind': 'text',
                'system_prompt': 'Output ONLY refined prompt text.'}]
    async def ask(name, instruction, data, validate, amount):
        return validate({'tasks': [{'task_id': 'storyboard-prompt', 'decisions': [
            {'recipe_id': 'prompt-editor', 'constraint_checks': [], 'compatible': True, 'reason': 'Writes final prompt'}]}]})
    result = await resolve_task_recipes(
        {'tasks': [task('storyboard-prompt', 'storyboard prompt')], 'skill_notes': 'Prompt deliverable'},
        catalog, ask,
    )
    assert result['selected_ids'] == ['prompt-editor']


@pytest.mark.asyncio
async def test_text_only_asset_branch_cannot_reuse_recipe_requiring_source_media():
    catalog = [
        {'id': 'prop-from-image', 'name': 'prop reference', 'output_kind': 'image',
         'requires_source_media': True, 'system_prompt': 'Adapt the supplied prop image.'},
        {'id': 'prop-from-text', 'name': 'prop description', 'output_kind': 'image',
         'requires_source_media': False, 'system_prompt': 'Generate a prop image from text.'},
    ]
    inspected = []

    async def ask(name, instruction, data, validate, amount):
        inspected.extend(recipe['id'] for recipe in data['candidate_recipes'])
        assert 'source_media_guaranteed' in instruction
        return validate({'tasks': [{'task_id': 'prop', 'decisions': [
            {'recipe_id': rid, 'constraint_checks': [], 'compatible': True, 'reason': 'Suitable asset method'}
            for rid in data['tasks'][0]['candidate_ids']]}]})

    result = await resolve_task_recipes(
        {'tasks': [task('prop', 'prop reference image', 'image')], 'skill_notes': 'Text-only allowed'},
        catalog, ask,
    )
    assert inspected == ['prop-from-text']
    assert result['selected_ids'] == ['prop-from-text']


@pytest.mark.asyncio
async def test_ineligible_media_candidates_do_not_hide_later_eligible_recipe():
    catalog = [{'id': f'a-prop-{index:03}', 'name': 'prop image', 'output_kind': 'image',
                'requires_source_media': True, 'system_prompt': 'Requires source image.'}
               for index in range(50)]
    catalog.append({'id': 'z-prop-from-text', 'name': 'prop image', 'output_kind': 'image',
                    'requires_source_media': False, 'system_prompt': 'Generates image from text.'})
    inspected = []
    async def ask(name, instruction, data, validate, amount):
        inspected.extend(recipe['id'] for recipe in data['candidate_recipes'])
        return validate({'tasks': [{'task_id': 'prop', 'decisions': [
            {'recipe_id': 'z-prop-from-text', 'constraint_checks': [], 'compatible': True, 'reason': 'Fits'}]}]})
    result = await resolve_task_recipes(
        {'tasks': [task('prop', 'prop image', 'image')], 'skill_notes': 'Text-only input'},
        catalog, ask,
    )
    assert inspected == ['z-prop-from-text']
    assert result['selected_ids'] == ['z-prop-from-text']


@pytest.mark.asyncio
async def test_only_one_expansion_excludes_reviewed_and_does_not_send_catalog():
    catalog = [{'id': 'translate', 'name': 'translate', 'output_kind': 'text', 'system_prompt': 'Translate only'},
               {'id': 'citations', 'name': 'citations', 'output_kind': 'text', 'system_prompt': 'Check citations'}]
    calls = []
    async def ask(name, instruction, data, validate, amount):
        calls.append(data)
        rid = data['candidate_recipes'][0]['id']
        return validate({'tasks': [{'task_id': 'a', 'decisions': [{'recipe_id':rid, 'constraint_checks': [], 'compatible':rid=='citations','reason':'Method'}], 'search_queries':['citations']}]})
    result = await resolve_task_recipes({'tasks':[task('a','translate')],'skill_notes':'Confirm'},catalog,ask)
    assert [[r['id'] for r in c['candidate_recipes']] for c in calls] == [['translate'],['citations']]
    assert result['selected_ids'] == ['citations']


@pytest.mark.asyncio
async def test_no_match_fallback_and_huge_catalog_stay_bounded():
    catalog = [{'id':f'video-{i:03}', 'name':f'video {i}', 'output_kind':'video','system_prompt':'Video method'} for i in range(1000)]
    calls = []
    async def ask(name,instruction,data,validate,amount):
        calls.append(data)
        return validate({'tasks':[{'task_id':'a','decisions':[{'recipe_id':r,'constraint_checks': [], 'compatible':False,'reason':'Does not support requested input'} for r in data['tasks'][0]['candidate_ids']], 'search_queries':['missing']} ]})
    result = await resolve_task_recipes({'tasks':[task('a','missing','video')],'skill_notes':'Confirm'},catalog,ask)
    assert len(calls) == 2
    assert all(len(c['candidate_recipes'])<=5 for c in calls)
    assert len(result['tasks'][0]['verdicts']) == 10
    assert result['tasks'][0]['selected_recipe_id'] is None


def test_queries_and_output_types_are_bounded_and_native():
    draft_task = {**task('a', 'citations'), 'source_segment_ids': ['S0001']}
    draft_task.pop('source_quotes')
    draft_task['requirement_summary'] = draft_task.pop('requirements')[0]
    payload = draft_payload(draft_task)
    assert validate_source_analysis(payload,'citations')['tasks'][0]['queries']==['citations']
    payload['tasks'][0]['output_kinds']=['document']
    with pytest.raises(ValueError):
        validate_source_analysis(payload,'citations')


def test_analysis_hydrates_exact_quotes_from_model_selected_segment_ids():
    source = "# Procedure\n\nUse `literal` \\\\ path and keep café unchanged.\n"
    segments = segment_source(source)
    response = {
        'purpose': 'Preserve the procedure',
        'orchestration_summary': 'Follow the source',
        'orchestration_segment_ids': ['S0001'],
        'tasks': [{
            'id': 'preserve',
            'title': 'Preserve syntax',
            'requirement_summary': 'Keep exact syntax',
            'source_segment_ids': ['S0002'],
            'source_media_guaranteed': False,
            'output_kinds': ['text'],
            'queries': ['literal path'],
        }],
    }

    analysis = validate_source_analysis(response, source, segments)

    assert analysis['tasks'][0]['source_quotes'] == [segments[1]['text']]
    assert 'source_segment_ids' not in analysis['tasks'][0]


def test_analysis_rejects_unknown_duplicate_or_excess_segment_ids():
    source = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n\nSeven.\n"
    segments = segment_source(source)
    base_task = {
        'id': 'a', 'title': 'Task', 'requirement_summary': 'Use evidence',
        'source_media_guaranteed': False,
        'output_kinds': ['text'], 'queries': ['evidence'],
    }
    base = {
        'purpose': 'Test',
        'orchestration_summary': 'Test',
        'orchestration_segment_ids': ['S0001'],
    }

    for ids in (['S9999'], ['S0001', 'S0001'], [s['id'] for s in segments]):
        with pytest.raises(ValueError):
            validate_source_analysis(
                {**base, 'tasks': [{**base_task, 'source_segment_ids': ids}]},
                source,
                segments,
            )


def test_analysis_rejects_model_copied_source_quotes():
    source = "Exact source."
    segments = segment_source(source)
    response = {
        'purpose': 'Test',
        'orchestration_summary': 'Test',
        'orchestration_segment_ids': ['S0001'],
        'tasks': [{
            'id': 'a', 'title': 'Task', 'requirement_summary': 'Use evidence',
            'source_segment_ids': ['S0001'],
            'source_media_guaranteed': False,
            'source_quotes': ['model-authored copy'],
            'output_kinds': ['text'], 'queries': ['evidence'],
        }],
    }

    with pytest.raises(ValueError):
        validate_source_analysis(response, source, segments)


@pytest.mark.asyncio
async def test_matching_budget_exhaustion_returns_unresolved_for_generation():
    from novelvideo.freezone.skill_import_budget import ImportBudgetExceeded
    async def ask(*args):
        raise ImportBudgetExceeded('Skill import matching-call budget exhausted')
    catalog = [{'id':'citations','name':'citations','output_kind':'text','system_prompt':'Check citations'}]
    result = await resolve_task_recipes({'tasks':[task('a','citations')],'skill_notes':'Confirm'},catalog,ask)
    assert result['selected_ids'] == []
    assert result['tasks'][0]['search_status'] == 'budget_exhausted'


@pytest.mark.asyncio
async def test_large_candidate_group_stays_under_inspection_cap_without_truncating_definitions():
    body = 'Follow every citation rule exactly. ' * 265
    catalog = [{'id':f'citations-{i}','name':'citations','output_kind':'text','system_prompt':body} for i in range(5)]
    calls=[]
    async def ask(name,instruction,data,validate,amount):
        calls.append(data)
        ids=data['tasks'][0]['candidate_ids']
        return validate({'tasks':[{'task_id':'a','decisions':[{'recipe_id':rid,'constraint_checks': [], 'compatible':True,'reason':'Method'} for rid in ids]}]})
    result=await resolve_task_recipes({'tasks':[task('a','citations')],'skill_notes':'Confirm'},catalog,ask)
    assert result['selected_ids']
    assert calls
    assert all(len(json.dumps(call, ensure_ascii=False)) <= 32_000 for call in calls)
    assert all(r['system_prompt'] == body for call in calls for r in call['candidate_recipes'])


@pytest.mark.asyncio
async def test_three_first_round_groups_leave_one_call_for_expansion():
    body = 'Apply the complete production procedure. ' * 700
    tasks = [task('translate', 'translate'), task('illustrate', 'illustrate', 'image'),
             task('animate', 'animate', 'video')]
    catalog = [
        {'id': 'translate', 'name': 'translate', 'output_kind': 'text', 'system_prompt': body},
        {'id': 'citations', 'name': 'citations', 'output_kind': 'text', 'system_prompt': body},
        {'id': 'illustrate', 'name': 'illustrate', 'output_kind': 'image', 'system_prompt': body},
        {'id': 'animate', 'name': 'animate', 'output_kind': 'video', 'system_prompt': body},
    ]
    calls = []

    async def ask(name, instruction, data, validate, amount):
        calls.append((name, data))
        results = []
        for entry in data['tasks']:
            task_id = entry['task']['id']
            decisions = [
                {'recipe_id': recipe_id, 'constraint_checks': [], 'compatible': recipe_id != 'translate', 'reason': 'Method check'}
                for recipe_id in entry['candidate_ids']
            ]
            results.append({
                'task_id': task_id,
                'decisions': decisions,
                'search_queries': ['citations'] if task_id == 'translate' else [],
            })
        return validate({'tasks': results})

    result = await resolve_task_recipes(
        {'tasks': tasks, 'skill_notes': 'Confirm every method'}, catalog, ask)

    assert [name.split(':')[:2] for name, _ in calls] == [
        ['inspecting', '0'], ['inspecting', '0'], ['inspecting', '0'], ['inspecting', '1']]
    assert len(calls) == 4
    assert result['tasks'][0]['selected_recipe_id'] == 'citations'


@pytest.mark.asyncio
async def test_four_call_limit_leaves_uninspected_task_unresolved():
    body = 'Apply the complete production procedure. ' * 700
    kinds = ['text', 'image', 'video', 'audio', 'html']
    tasks = [task(f'job-{index}', f'job-{index}', kind) for index, kind in enumerate(kinds)]
    catalog = [
        {
            'id': item['id'],
            'name': item['title'],
            'output_kind': 'text' if kind == 'html' else kind,
            **({'output_format': 'html'} if kind == 'html' else {}),
            'system_prompt': body,
        }
        for item, kind in zip(tasks, kinds, strict=True)
    ]
    inspected = []
    calls = 0

    async def ask(name, instruction, data, validate, amount):
        nonlocal calls
        calls += 1
        inspected.extend(entry['task']['id'] for entry in data['tasks'])
        return validate({'tasks': [
            {
                'task_id': entry['task']['id'],
                'decisions': [
                    {'recipe_id': recipe_id, 'constraint_checks': [], 'compatible': True, 'reason': 'Complete method'}
                    for recipe_id in entry['candidate_ids']
                ],
                'search_queries': [],
            }
            for entry in data['tasks']
        ]})

    result = await resolve_task_recipes(
        {'tasks': tasks, 'skill_notes': 'Confirm every method'}, catalog, ask)

    assert calls == 4
    assert len(inspected) == 4
    assert result['tasks'][4]['task_id'] not in inspected
    assert result['tasks'][4]['selected_recipe_id'] is None
    assert result['tasks'][4]['search_status'] == 'budget_exhausted'
    assert result['tasks'][4]['new_recipe_reason']


@pytest.mark.asyncio
async def test_live_budget_uses_fourth_inspection_when_no_expansion_is_needed():
    body = 'Apply complete production procedure. ' * 700
    tasks = [task(f'job-{index}', f'job-{index}', kind)
             for index, kind in enumerate(['text', 'image', 'video', 'audio'])]
    catalog = [{'id': item['id'], 'name': item['title'], 'output_kind': item['output_kinds'][0],
                'system_prompt': body} for item in tasks]
    remaining = 4
    inspected = []

    async def ask(name, instruction, data, validate, amount, **kwargs):
        nonlocal remaining
        remaining -= 1
        inspected.extend(entry['task']['id'] for entry in data['tasks'])
        return validate({'tasks': [{
            'task_id': entry['task']['id'],
            'decisions': [{'recipe_id': rid, 'constraint_checks': [], 'compatible': True, 'reason': 'Fits'}
                          for rid in entry['candidate_ids']],
        } for entry in data['tasks']]})

    result = await resolve_task_recipes(
        {'tasks': tasks, 'skill_notes': 'Confirm'}, catalog, ask,
        matching_calls_remaining=lambda: remaining,
    )
    assert inspected == [item['id'] for item in tasks]
    assert remaining == 0
    assert len(result['selected_ids']) == 4


@pytest.mark.asyncio
async def test_first_round_transport_cap_keeps_one_submit_for_expansion():
    catalog = [
        {'id': 'initial', 'name': 'initial', 'output_kind': 'text', 'system_prompt': 'Method'},
        {'id': 'better', 'name': 'better', 'output_kind': 'text', 'system_prompt': 'Better method'},
    ]
    remaining = 4
    calls = []

    async def ask(name, instruction, data, validate, amount, **kwargs):
        nonlocal remaining
        calls.append((name, kwargs))
        if name.startswith('inspecting:0'):
            remaining -= 3  # Timeout, malformed JSON correction, successful incompatible verdict.
            return validate({'tasks': [{'task_id': 'a', 'decisions': [
                {'recipe_id': rid, 'constraint_checks': [], 'compatible': False, 'reason': 'Wrong method'}
                for rid in data['tasks'][0]['candidate_ids']], 'search_queries': ['better']}]})
        remaining -= 1
        return validate({'tasks': [{'task_id': 'a', 'decisions': [
            {'recipe_id': rid, 'constraint_checks': [], 'compatible': True, 'reason': 'Fits'}
            for rid in data['tasks'][0]['candidate_ids']]}]})

    result = await resolve_task_recipes(
        {'tasks': [task('a', 'initial')], 'skill_notes': 'Confirm'}, catalog, ask,
        matching_calls_remaining=lambda: remaining,
    )
    assert calls[0][1]['max_transport_submits'] == 3
    assert [name.split(':')[1] for name, _ in calls] == ['0', '1']
    assert result['selected_ids'] == ['better']


@pytest.mark.asyncio
async def test_uninspected_tasks_get_budget_before_expansions(monkeypatch):
    from novelvideo.freezone import skill_import_retrieval as module
    monkeypatch.setattr(module, 'MAX_INSPECTION_DATA_CHARS', 48_000)
    tasks=[task(str(i),f'job{i}') for i in range(5)]
    catalog=[{'id':f'job{i}-{j}','name':f'job{i}','output_kind':'text','system_prompt':'x'*20000} for i in range(5) for j in range(3)]
    checked=[]
    async def ask(name,instruction,data,validate,amount):
        checked.extend(t['task']['id'] for t in data['tasks'])
        return validate({'tasks':[{'task_id':t['task']['id'],'decisions':[{'recipe_id':rid,'constraint_checks': [], 'compatible':False,'reason':'Input mismatch'} for rid in t['candidate_ids']], 'search_queries':[t['task']['title']]} for t in data['tasks']]})
    result=await resolve_task_recipes({'tasks':tasks,'skill_notes':'Confirm'},catalog,ask)
    assert checked[:4]==['0','1','2','3']
    assert result['tasks'][4]['search_status']=='budget_exhausted'


@pytest.mark.asyncio
async def test_grid_conflict_overrides_positive_verdict():
    catalog = [{'id': 'grid', 'name': 'grid', 'output_kind': 'image',
                'system_prompt': '9镜=3×3。禁止涉及分镜脚本中的画面描述'}]
    async def ask(name, instruction, data, validate, amount, **kwargs):
        return validate({'tasks': [{'task_id': 'grid-task', 'decisions': [{
            'recipe_id': 'grid', 'compatible': True, 'reason': 'Layout matches',
            'constraint_checks': [{'recipe_quote': '禁止涉及分镜脚本中的画面描述',
                'task_requirement': '每格描述具体画面', 'status': 'conflict',
                'reason': 'Cannot include required scene descriptions', 'exception_quote': ''}],
        }]}]})
    result = await resolve_task_recipes({'tasks': [task('grid-task', 'grid', 'image')],
                                       'skill_notes': ''}, catalog, ask)
    assert result['selected_ids'] == []
    assert result['tasks'][0]['verdicts'][0]['compatible'] is False


@pytest.mark.parametrize('status,quote,exception', [
    ('conflict', 'invented rule', ''),
    ('explicit_exception', '禁止文字', ''),
    ('explicit_exception', '禁止文字', 'invented exception'),
])
def test_constraint_evidence_must_exist(status, quote, exception):
    from novelvideo.freezone.skill_import_retrieval import validate_recipe_verdict
    value = {'recipe_id': 'grid', 'compatible': True, 'reason': 'Fits',
             'constraint_checks': [{'recipe_quote': quote, 'task_requirement': '文字',
                 'status': status, 'reason': 'Check', 'exception_quote': exception}]}
    with pytest.raises(ValueError):
        validate_recipe_verdict(value, {'system_prompt': '禁止文字，除非用户明确要求'})


def test_explicit_recipe_exception_allows_reuse():
    from novelvideo.freezone.skill_import_retrieval import validate_recipe_verdict
    value = {'recipe_id': 'grid', 'compatible': True, 'reason': 'Fits',
             'constraint_checks': [{'recipe_quote': '禁止文字', 'task_requirement': '用户已确认文字',
                 'status': 'explicit_exception', 'reason': 'Confirmed text is allowed',
                 'exception_quote': '除非用户明确要求'}]}
    assert validate_recipe_verdict(value, {'system_prompt': '禁止文字，除非用户明确要求'})['compatible']


def test_compatibility_requires_explicit_constraint_audit():
    from novelvideo.freezone.skill_import_retrieval import validate_recipe_verdict
    with pytest.raises(ValueError):
        validate_recipe_verdict({'recipe_id': 'grid', 'compatible': True, 'reason': 'Looks similar'},
                                {'system_prompt': '禁止涉及分镜脚本中的画面描述'})


@pytest.mark.asyncio
async def test_conflicting_candidate_does_not_hide_compatible_alternative():
    catalog = [
        {'id': 'a-grid', 'name': 'grid', 'output_kind': 'image', 'system_prompt': '禁止画面描述'},
        {'id': 'b-grid', 'name': 'grid', 'output_kind': 'image', 'system_prompt': '根据逐格画面描述生成分镜'},
    ]
    async def ask(name, instruction, data, validate, amount, **kwargs):
        decisions = []
        for rid in data['tasks'][0]['candidate_ids']:
            conflict = rid == 'a-grid'
            decisions.append({'recipe_id': rid, 'compatible': True, 'reason': 'Grid method',
                'constraint_checks': [{'recipe_quote': '禁止画面描述' if conflict else '根据逐格画面描述生成分镜',
                    'task_requirement': '每格描述具体画面', 'status': 'conflict' if conflict else 'satisfied',
                    'reason': 'Conflicts' if conflict else 'Supports scenes', 'exception_quote': ''}]})
        return validate({'tasks': [{'task_id': 'grid-task', 'decisions': decisions}]})
    result = await resolve_task_recipes({'tasks': [task('grid-task', 'grid', 'image')],
                                       'skill_notes': ''}, catalog, ask)
    assert result['selected_ids'] == ['b-grid']


@pytest.mark.asyncio
async def test_single_task_batches_overlap_with_at_most_two_requests():
    import asyncio
    catalog = [{'id': 'image', 'name': 'image', 'output_kind': 'image', 'system_prompt': 'Draw image'}]
    active = peak = 0
    calls = []
    paired = asyncio.Event()

    async def ask(name, instruction, data, validate, amount):
        nonlocal active, peak
        assert len(data['tasks']) == 1
        assert len(data['candidate_recipes']) <= 5
        calls.append(name)
        active += 1
        peak = max(peak, active)
        if active == 2:
            paired.set()
        try:
            await asyncio.wait_for(paired.wait(), .5)
            await asyncio.sleep(.01)
            entry = data['tasks'][0]
            return validate({'tasks': [{'task_id': entry['task']['id'], 'decisions': [
                {'recipe_id': 'image', 'compatible': True, 'constraint_checks': [], 'reason': 'Fits'}]}]})
        finally:
            active -= 1

    result = await resolve_task_recipes({'tasks': [task(str(i), 'image', 'image') for i in range(4)],
                                       'skill_notes': ''}, catalog, ask)
    assert peak == 2
    assert len(set(calls)) == 4
    assert all(item['selected_recipe_id'] == 'image' for item in result['tasks'])


@pytest.mark.asyncio
async def test_failed_inspection_cancels_other_inflight_request():
    import asyncio
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    catalog = [{'id': 'image', 'name': 'image', 'output_kind': 'image', 'system_prompt': 'Draw'}]

    async def ask(name, instruction, data, validate, amount):
        if data['tasks'][0]['task']['id'] == 'first':
            await entered.wait()
            raise RuntimeError('fatal provider error')
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    with pytest.raises(RuntimeError, match='fatal provider error'):
        await asyncio.wait_for(resolve_task_recipes(
            {'tasks': [task('first', 'image', 'image'), task('second', 'image', 'image')],
             'skill_notes': ''}, catalog, ask), 1)
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_bad_quote_on_rejected_recipe_does_not_discard_reusable_candidate():
    catalog = [
        {'id': 'wrong', 'name': 'draft', 'output_kind': 'text', 'system_prompt': '输出故事剧本'},
        {'id': 'good', 'name': 'document', 'output_kind': 'text', 'system_prompt': '输出规格文档'},
    ]
    async def ask(name, instruction, data, validate, amount, **kwargs):
        decisions = []
        for recipe_id in data['tasks'][0]['candidate_ids']:
            if recipe_id == 'wrong':
                decisions.append({'recipe_id': recipe_id, 'compatible': False, 'reason': 'Wrong output',
                    'constraint_checks': [{'recipe_quote': '【任务目标】输出故事剧本',
                        'task_requirement': '规格文档', 'status': 'conflict',
                        'reason': 'Wrong output', 'exception_quote': ''}]})
            else:
                decisions.append({'recipe_id': recipe_id, 'compatible': True, 'reason': 'Direct document',
                    'constraint_checks': [{'recipe_quote': '输出规格文档',
                        'task_requirement': '规格文档', 'status': 'satisfied',
                        'reason': 'Same deliverable', 'exception_quote': ''}]})
        return validate({'tasks': [{'task_id': 'spec', 'decisions': decisions}]})
    result = await resolve_task_recipes({'tasks': [task('spec', 'unrelated')], 'skill_notes': ''}, catalog, ask)
    assert result['selected_ids'] == ['good']
    assert next(v for v in result['tasks'][0]['verdicts'] if v['recipe_id'] == 'wrong')['compatible'] is False


@pytest.mark.asyncio
async def test_live_budget_can_inspect_more_than_four_distinct_tasks():
    catalog = [{'id': f'recipe-{i}', 'name': f'job-{i}', 'output_kind': 'text',
                'system_prompt': 'Produce the requested document'} for i in range(5)]
    remaining = 6
    inspected = []
    async def ask(name, instruction, data, validate, amount, **kwargs):
        nonlocal remaining
        remaining -= 1
        item = data['tasks'][0]
        inspected.append(item['task']['id'])
        return validate({'tasks': [{'task_id': item['task']['id'], 'decisions': [
            {'recipe_id': rid, 'compatible': True, 'reason': 'Fits', 'constraint_checks': []}
            for rid in item['candidate_ids']]}]})
    result = await resolve_task_recipes({'tasks': [task(f'job-{i}', f'job-{i}') for i in range(5)],
                                       'skill_notes': ''}, catalog, ask,
                                       matching_calls_remaining=lambda: remaining)
    assert len(inspected) == 5
    assert all(item['search_status'] == 'matched' for item in result['tasks'])
