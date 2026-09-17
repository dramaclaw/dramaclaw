"""Candidate retrieval only; full definitions remain the authority for reuse."""
from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Literal
import asyncio
import json
import re

from pydantic import Field, StringConstraints

from novelvideo.freezone.skill_import_contracts import ConversionDesign, StrictModel
from novelvideo.freezone.skill_import_budget import ImportBudgetExceeded, is_transient_model_error
from novelvideo.freezone.skill_import_evidence import segment_source


class ProductionTask(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1)
    requirements: list[str] = Field(min_length=1)
    source_quotes: list[str] = Field(min_length=1)
    source_media_guaranteed: bool
    output_kinds: list[Literal["text", "image", "video", "audio", "html"]] = Field(min_length=1, max_length=4)
    queries: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]] = Field(min_length=1, max_length=3)


class SourceAnalysis(ConversionDesign):
    tasks: list[ProductionTask] = Field(min_length=1, max_length=16)


class DraftProductionTask(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    requirement_summary: str = Field(min_length=1, max_length=400)
    source_segment_ids: list[str] = Field(min_length=1, max_length=6)
    source_media_guaranteed: bool
    output_kinds: list[Literal["text", "image", "video", "audio", "html"]] = Field(min_length=1, max_length=4)
    queries: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]] = Field(min_length=1, max_length=3)


class DraftSourceAnalysis(StrictModel):
    purpose: str = Field(min_length=1, max_length=300)
    orchestration_summary: str = Field(min_length=1, max_length=2000)
    orchestration_segment_ids: list[str] = Field(min_length=1, max_length=32)
    tasks: list[DraftProductionTask] = Field(min_length=1, max_length=16)


class CandidateSelection(StrictModel):
    candidate_ids: list[str] = Field(max_length=3)
    search_more: bool = False


class ConstraintCheck(StrictModel):
    recipe_quote: str = Field(min_length=1, max_length=800)
    task_requirement: str = Field(min_length=1, max_length=400)
    status: Literal['satisfied', 'conflict', 'explicit_exception']
    reason: str = Field(min_length=1, max_length=400)
    exception_quote: str = Field(max_length=800)


class RecipeVerdict(StrictModel):
    recipe_id: str = Field(min_length=1)
    compatible: bool
    constraint_checks: list[ConstraintCheck] = Field(max_length=24)
    reason: str = Field(min_length=1, max_length=800)


def validate_recipe_verdict(value: dict, recipe: dict) -> dict:
    """Verify cited instructions and veto any unresolved method conflict."""
    verdict = RecipeVerdict.model_validate(value).model_dump()
    instruction_fields = ('system_prompt', 'planning_prompt', 'must_have_items',
                          'description', 'result_summary')
    texts = []
    for key in instruction_fields:
        field = recipe.get(key, '')
        texts.extend(str(item) for item in field) if isinstance(field, list) else texts.append(str(field))
    for check in verdict['constraint_checks']:
        if not any(check['recipe_quote'] in text for text in texts):
            raise ValueError('Recipe constraint quote must exist in its full definition')
        if check['status'] == 'explicit_exception':
            if not check['exception_quote'].strip() or not any(
                check['exception_quote'] in text for text in texts
            ):
                raise ValueError('Recipe exception must quote an explicit allowance in its definition')
    conflicts = [check for check in verdict['constraint_checks'] if check['status'] == 'conflict']
    if conflicts:
        verdict['compatible'] = False
        verdict['reason'] = '; '.join(check['reason'] for check in conflicts)[:800]
    return verdict


class CandidateInspection(StrictModel):
    decisions: list[RecipeVerdict] = Field(max_length=3)
    search_more: bool = False


def recipe_summaries(catalog: list[dict]) -> list[dict]:
    """Derive versioned search hints from current definitions, never cached prose."""
    result = []
    for recipe in catalog:
        summary = {key: recipe[key] for key in ('id', 'version', 'name', 'output_kind', 'output_format',
                    'requires_source_media') if key in recipe}
        for key in ('description', 'planning_prompt', 'result_summary', 'system_prompt', 'must_have_items'):
            value = recipe.get(key, '')
            text = '\n'.join(map(str, value)) if isinstance(value, list) else str(value)
            summary['instruction_excerpt' if key == 'system_prompt' else key] = text[:200]
            if len(text) > 200:
                summary.setdefault('excerpted_fields', []).append(key)
        result.append(summary)
    return result


def checked_ids(ids: list[str], catalog: list[dict], seen: set[str] | None = None) -> list[str]:
    known = {recipe['id'] for recipe in catalog}
    if len(set(ids)) != len(ids) or any(recipe_id not in known for recipe_id in ids):
        raise ValueError('Candidate IDs must be unique IDs from the supplied catalog')
    if seen is not None and any(recipe_id in seen for recipe_id in ids):
        raise ValueError('Additional candidate IDs must not have been inspected already')
    return ids


def _hydrate_source_quotes(segment_ids: list[str], segments: list[dict], source: str) -> list[str]:
    """Slice exact evidence from the original source using program-owned offsets."""
    by_id = {segment['id']: segment for segment in segments}
    unknown = [segment_id for segment_id in segment_ids if segment_id not in by_id]
    if unknown:
        raise ValueError(f'Unknown source segment ID: {unknown[0]}')
    quotes = []
    for segment_id in segment_ids:
        segment = by_id[segment_id]
        start, end = segment.get('start'), segment.get('end')
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start <= end <= len(source):
            raise ValueError(f'Invalid source segment offsets: {segment_id}')
        quotes.append(source[start:end])
    return quotes


def validate_source_analysis(value: dict, source: str, segments: list[dict] | None = None) -> dict:
    draft = DraftSourceAnalysis.model_validate(value).model_dump()
    ids = [task['id'] for task in draft['tasks']]
    if len(set(ids)) != len(ids):
        raise ValueError('Production task IDs must be unique')
    evidence = segments if segments is not None else segment_source(source)
    orchestration_segment_ids = draft.pop('orchestration_segment_ids')
    if len(set(orchestration_segment_ids)) != len(orchestration_segment_ids):
        raise ValueError('Orchestration source_segment_ids must be unique')
    orchestration_quotes = _hydrate_source_quotes(orchestration_segment_ids, evidence, source)
    orchestration_summary = draft.pop('orchestration_summary')
    exact_rules = '\n\n'.join(
        f'[Exact source rule {segment_id}]\n{quote}'
        for segment_id, quote in zip(
            orchestration_segment_ids, orchestration_quotes, strict=True,
        )
    )
    skill_notes = (
        'Orchestration summary (navigation only; cited source remains authoritative):\n'
        f'{orchestration_summary}\n\n'
        'Exact orchestration and cross-stage source rules (authoritative):\n'
        f'{exact_rules}'
    )
    tasks = []
    quotes = []
    requirements = []
    for task in draft['tasks']:
        segment_ids = task.pop('source_segment_ids')
        if len(set(segment_ids)) != len(segment_ids):
            raise ValueError('Task source_segment_ids must be unique')
        task_quotes = _hydrate_source_quotes(segment_ids, evidence, source)
        requirement_summary = task.pop('requirement_summary')
        if requirement_summary not in requirements:
            requirements.append(requirement_summary)
        quotes.append(task_quotes)
        tasks.append({
            **task,
            'requirements': [requirement_summary],
            'source_quotes': task_quotes,
        })
    analysis = SourceAnalysis.model_validate({
        **draft,
        'requirements': requirements,
        'skill_notes': skill_notes,
        'recipe_notes': [],
        'recipe_decisions': [],
        'tasks': tasks,
    }).model_dump()
    analysis['skill_notes'] = skill_notes
    for task, exact_quotes in zip(analysis['tasks'], quotes, strict=True):
        task['source_quotes'] = exact_quotes
    return analysis


MAX_CANDIDATES = 30
BATCH_CANDIDATES = 5
MAX_INSPECTION_DATA_CHARS = 32_000


def _prompt_only_text_recipe(recipe: dict) -> bool:
    """Exclude explicit prompt rewriting from final-text production tasks."""
    if recipe.get('output_kind') != 'text':
        return False
    instruction = str(recipe.get('system_prompt') or '')
    return bool(
        re.search(r'(?:^|[.!?]\s+)output\s+only\s+(?:the\s+)?(?:refined|rewritten|optimized|improved)\s+prompt(?:\s+text)?\b',
                  instruction, re.IGNORECASE)
        or re.search(r'(?:^|[。！？!?]\s*)(?:只|仅)输出(?:优化后|改写后|润色后|精炼后)?的?提示词', instruction)
    )


def _final_document_task(task: dict) -> bool:
    title = f"{task.get('id', '')} {task.get('title', '')}".lower()
    document_terms = ('文档', '报告', '规格', '剧本', '分镜', 'document', 'spec', 'report', 'storyboard', 'script')
    if '提示词' in title or 'prompt' in title:
        return False
    if any(term in title for term in document_terms):
        return True
    requirements = ' '.join(map(str, task.get('requirements', []))).lower()
    if '提示词' in requirements or 'prompt' in requirements:
        return False
    return any(term in requirements for term in document_terms)


class TaskInspection(StrictModel):
    task_id: str
    decisions: list[RecipeVerdict] = Field(max_length=5)
    search_queries: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]] = Field(default_factory=list, max_length=3)


class BatchInspection(StrictModel):
    tasks: list[TaskInspection] = Field(min_length=1, max_length=16)


def find_candidates(index, task: dict, seen: set[str], queries: list[str],
                    eligible: Callable[[str], bool] | None = None) -> list[str]:
    if eligible is None:
        def eligible(rid: str) -> bool:
            return True
    scores: dict[str, float] = {}
    for query in queries:
        for rank, summary in enumerate(index.search(query=query, limit=MAX_CANDIDATES)):
            kinds = task.get('output_kinds', [])
            actual = 'html' if summary.get('output_format') == 'html' else summary.get('output_kind')
            if summary['id'] not in seen and eligible(summary['id']) and (not kinds or actual in kinds):
                scores[summary['id']] = scores.get(summary['id'], 0) + 1 / (rank + 1)
    if not scores:
        # A bounded type-level fallback, never a full-directory model request.
        for summary in index.search(query='', limit=50):
            actual = 'html' if summary.get('output_format') == 'html' else summary.get('output_kind')
            if summary['id'] not in seen and eligible(summary['id']) and actual in task.get('output_kinds', []):
                scores[summary['id']] = 0
        # Type search finds candidates beyond the first alphabetical page.
        for kind in task.get('output_kinds', []):
            for summary in index.search(query=kind, limit=50):
                actual = 'html' if summary.get('output_format') == 'html' else summary.get('output_kind')
                if summary['id'] not in seen and eligible(summary['id']) and actual == kind:
                    scores.setdefault(summary['id'], 0)
    return sorted(scores, key=lambda rid: (-scores[rid], rid))[:MAX_CANDIDATES]


async def resolve_task_recipes(
    analysis: dict,
    catalog: list[dict],
    ask,
    matching_calls_remaining: Callable[[], int] | None = None,
) -> dict:
    """Search locally and inspect one task per request, with at most two requests in flight."""
    from novelvideo.freezone.agent_workflows.registry import CatalogSearch
    visible = [r for r in catalog if r.get('enabled') is not False and not r.get('hidden')]
    by_id = {r['id']: r for r in visible}
    indexes: dict[tuple[bool, bool], CatalogSearch] = {}
    states = {t['id']: {'task_id': t['id'], 'selected_recipe_id': None, 'verdicts': [],
                        'search_status': 'no_candidate', 'new_recipe_reason': ''} for t in analysis['tasks']}
    seen = {t['id']: set() for t in analysis['tasks']}
    queries = {t['id']: t.get('queries', [t['title']]) for t in analysis['tasks']}
    pending = analysis['tasks']
    call_index = 0
    inspection_limit = max(4, len(analysis['tasks']) + 1) if matching_calls_remaining else 4
    for round_index in range(2):
        groups = []
        for task in pending:
            document_task = _final_document_task(task)
            source_media_guaranteed = task.get('source_media_guaranteed') is True
            eligibility = (document_task, source_media_guaranteed)
            if eligibility not in indexes:
                indexes[eligibility] = CatalogSearch(items=[
                    recipe for recipe in visible
                    if not (document_task and _prompt_only_text_recipe(recipe))
                    and (not recipe.get('requires_source_media') or source_media_guaranteed)
                ], kind='recipes')
            ids = find_candidates(
                indexes[eligibility], task, seen[task['id']], queries[task['id']],
            )
            if not ids:
                continue
            def payload(entries):
                unique = list(dict.fromkeys(rid for e in entries for rid in e['candidate_ids']))
                return {'tasks': entries, 'cross_stage_rules': analysis['skill_notes'],
                        'candidate_recipes': [by_id[rid] for rid in unique],
                        'schema': BatchInspection.model_json_schema()}
            fitted = []
            for rid in ids:
                trial = {'task': task, 'candidate_ids': fitted + [rid]}
                if len(json.dumps(payload([trial]), ensure_ascii=False)) <= MAX_INSPECTION_DATA_CHARS:
                    fitted.append(rid)
                if len(fitted) == BATCH_CANDIDATES:
                    break
            if not fitted:
                states[task['id']].update(search_status='budget_exhausted', new_recipe_reason='Candidate definitions exceed inspection request budget')
                continue
            entry = {'task': task, 'candidate_ids': fitted}
            groups.append([entry])
        next_pending = []
        async def inspect_group(group):
            nonlocal call_index
            if (round_index == 0 and next_pending and matching_calls_remaining is not None
                    and matching_calls_remaining() <= 1):
                for entry in group:
                    states[entry['task']['id']].update(
                        search_status='budget_exhausted',
                        new_recipe_reason='Matching request budget reserved for expansion',
                    )
                return
            if call_index >= inspection_limit or (round_index == 0 and next_pending and call_index >= inspection_limit - 1):
                for entry in group:
                    states[entry['task']['id']].update(search_status='budget_exhausted', new_recipe_reason='Matching request budget exhausted')
                    next_pending.append(entry['task'])
                return
            request_index = call_index
            call_index += 1  # Allocate checkpoint identity before yielding to another request.
            data = payload(group)
            remaining = matching_calls_remaining() if matching_calls_remaining is not None else None
            reserved_transport_limit = (
                max(1, remaining - 1) if round_index == 0 and remaining is not None else None
            )
            def validate(value):
                result = BatchInspection.model_validate(value).model_dump()
                returned = [t['task_id'] for t in result['tasks']]
                expected = {e['task']['id']: e['candidate_ids'] for e in group}
                if len(set(returned)) != len(returned) or set(returned) != set(expected):
                    raise ValueError('Return exactly one task result for each supplied task')
                for t in result['tasks']:
                    ids = [v['recipe_id'] for v in t['decisions']]
                    if len(set(ids)) != len(ids) or set(ids) != set(expected[t['task_id']]):
                        raise ValueError('Return one verdict for each candidate of that task; no cross-task IDs')
                    checked = []
                    for verdict in t['decisions']:
                        try:
                            checked.append(validate_recipe_verdict(verdict, by_id[verdict['recipe_id']]))
                        except ValueError as exc:
                            # An invalid citation cannot justify reuse. Keep the other
                            # candidates' verdicts instead of discarding the whole task.
                            checked.append({**verdict, 'compatible': False,
                                            'reason': f'Unverifiable Recipe evidence: {exc}'})
                    t['decisions'] = checked
                return result
            try:
                result = await ask(f'inspecting:{round_index}:{request_index}',
                    'Check all supplied tasks against their assigned FULL Recipe definitions. '
                    'Return one verdict per candidate per task. For each candidate, fill constraint_checks BEFORE deciding compatibility: '
                    'quote its relevant mandatory instructions and prohibitions verbatim, pair each with the task requirement, '
                    'and mark satisfied, conflict, or explicit_exception. Cover every relevant restriction; use [] only '
                    'when there are no relevant mandatory instructions or prohibitions. An explicit_exception must quote '
                    'the allowance from the Recipe itself, and explain why the task meets its conditions; otherwise '
                    'exception_quote is empty. Any unresolved conflict means incompatible, even when the layout matches. '
                    'A requirement to describe each storyboard cell conflicts with a prohibition on scene descriptions; '
                    'supplying those descriptions in Skill context does not remove that prohibition. '
                    'Compare input media combinations, mandatory '
                    'production methods, explicit prohibitions and EVERY required branch. Style or wording '
                    'differences are acceptable. Task context may supply unspecified parameters but may not '
                    'rewrite a prohibition or invent an exception. A first/last IMAGE-only method is not '
                    'proof of support for VIDEO reference plus end-frame image. Check mandatory camera rules '
                    'against boundary-frame continuity. Recipe compilation emits a prompt; downstream '
                    'generators produce media deliverables, so prompt output is expected for media Recipes; '
                    'text Recipes must directly produce the final text deliverable. A text Recipe that only '
                    'rewrites an input into a refined prompt cannot produce a final document and is incompatible. '
                    'source_media_guaranteed means every invocation of the task has a bound user or upstream '
                    'media asset. When false, a Recipe with requires_source_media=true cannot cover a text-only '
                    'branch; a scene image is not guaranteed to provide an original image for every prop. '
                    'A Recipe imposing a mandatory genre, species, costume or subject absent from the source '
                    'is incompatible even if its layout matches. Such fixed content cannot be changed by Skill '
                    'planning or task parameters; for example, an anthropomorphic kung-fu asset Recipe cannot '
                    'produce generic human character, scene and prop references. '
                    'Confirmations, binding, serial orchestration, frame extraction and final assembly '
                    'belong to Skill planning or runtime tools, not production Recipes. Choose compatible '
                    'methods by marking verdicts; if none fits, give up to three narrower search_queries '
                    'for missing capabilities. Never select a candidate assigned only to another task. '
                    'Keep concrete reasons short; do not repeat source analysis. Return ONLY schema JSON.',
                    data, validate, .3,
                    **({'max_transport_submits': reserved_transport_limit}
                       if reserved_transport_limit is not None else {}))
            except ImportBudgetExceeded as exc:
                if 'matching-call budget' not in str(exc):
                    raise
                call_index = 4
                for entry in group:
                    states[entry['task']['id']].update(search_status='budget_exhausted', new_recipe_reason='Matching request budget exhausted; compatibility not determined')
                return
            except BaseException as exc:
                if reserved_transport_limit is None or not (
                    is_transient_model_error(exc) or isinstance(exc, ValueError)
                ):
                    raise
                for entry in group:
                    states[entry['task']['id']].update(
                        search_status='budget_exhausted',
                        new_recipe_reason='Candidate inspection transport failed; matching request reserved for expansion',
                    )
                return
            for item in result['tasks']:
                state = states[item['task_id']]
                state['verdicts'].extend(item['decisions'])
                seen[item['task_id']].update(v['recipe_id'] for v in item['decisions'])
                fits = [v['recipe_id'] for v in item['decisions'] if v['compatible']]
                if fits:
                    state.update(selected_recipe_id=fits[0], search_status='matched', new_recipe_reason='')
                else:
                    state.update(search_status='incompatible', new_recipe_reason='; '.join(v['reason'] for v in item['decisions'])[:1600])
                    if round_index == 0 and item['search_queries']:
                        queries[item['task_id']] = item['search_queries']
                        next_pending.append(next(t for t in analysis['tasks'] if t['id'] == item['task_id']))
        semaphore = asyncio.Semaphore(2)

        async def limited_inspection(group):
            async with semaphore:
                await inspect_group(group)

        workers = [asyncio.create_task(limited_inspection(group)) for group in groups]
        try:
            await asyncio.gather(*workers)
        except BaseException:
            # Do not leave model calls or checkpoint writes running after the import fails.
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            raise
        pending = sorted(next_pending, key=lambda task: bool(seen[task["id"]]))
    resolutions = list(states.values())
    for state in resolutions:
        if state['search_status'] == 'no_candidate':
            state['new_recipe_reason'] = 'No reusable candidate found within bounded search; the entire catalog was not inspected'
    selected = list(dict.fromkeys(s['selected_recipe_id'] for s in resolutions if s['selected_recipe_id']))
    return {'selected_ids': selected, 'tasks': resolutions,
            'candidate_recipes': [by_id[rid] for rid in dict.fromkeys(rid for ids in seen.values() for rid in sorted(ids))]}
