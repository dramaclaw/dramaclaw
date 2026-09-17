"""Internal import contracts. These are audit artifacts, never runtime Skills."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field

from novelvideo.freezone.skill_import_evidence import hydrate_segment_quotes

CONVERSION_VERSION = 12


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


def content_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def resolve_pointer(bundle: dict, pointer: str) -> Any:
    if not pointer.startswith('/') or pointer == '/':
        raise ValueError('Review evidence must be a specific JSON pointer into the Bundle')
    current: Any = bundle
    try:
        for part in pointer[1:].split('/'):
            part = part.replace('~1', '/').replace('~0', '~')
            current = current[int(part)] if isinstance(current, list) else current[part]
    except (KeyError, IndexError, ValueError, TypeError):
        raise ValueError(f'Invalid review evidence: {pointer}') from None
    if current is None or current == '' or current == [] or current == {}:
        raise ValueError(f'Empty review evidence: {pointer}')
    return current


def bundle_evidence_paths(bundle: dict) -> list[str]:
    """Return the non-empty Bundle leaf pointers allowed as review evidence."""
    paths = []

    def walk(value: Any, path: str) -> None:
        if value is None or value == '' or value == [] or value == {}:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                escaped = str(key).replace('~', '~0').replace('/', '~1')
                walk(child, path + '/' + escaped)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, path + '/' + str(index))
        else:
            paths.append(path)

    walk(bundle, '')
    return paths


def structural_issues(bundle: dict) -> list[str]:
    issues = []
    if not str(bundle['skill']['planning'].get('prompt_guide') or '').strip():
        issues.append('planning.prompt_guide must describe source-derived language, prompt style and output conventions; it cannot be empty')
    evaluation = bundle['skill']['evaluation']
    scores = [r['score'] for r in evaluation['rating_bands']]
    threshold = evaluation['quality_threshold']
    if threshold < 0 or threshold > max(scores) or (max(scores) > 1 and 0 < threshold < 1):
        issues.append('Quality threshold must use the same scale as rating bands')
    return issues


class RecipeDecision(StrictModel):
    recipe_id: str = Field(min_length=1)
    action: Literal["reuse", "new"]
    compared_recipe_ids: list[str] = Field(default_factory=list, max_length=100)
    reason: str = Field(min_length=1)


class ConversionDesign(StrictModel):
    model_config = ConfigDict(extra='ignore', str_strip_whitespace=True)
    purpose: str = Field(min_length=1)
    requirements: list[str] = Field(min_length=1, max_length=100)
    skill_notes: str = Field(min_length=1)
    recipe_notes: list[str] = Field(default_factory=list, max_length=100)
    recipe_decisions: list[RecipeDecision] = Field(default_factory=list, max_length=100)


class BundleFinding(StrictModel):
    category: Literal['missing_method', 'changed_method', 'invalid_recipe', 'advisory']
    severity: Literal['blocker', 'warning']
    source_quote: str = ''
    evidence_paths: list[str] = Field(default_factory=list, max_length=20)
    message: str = Field(min_length=1, max_length=3000)


class BundleReview(StrictModel):
    summary: str = Field(min_length=1)
    issues: list[BundleFinding] = Field(default_factory=list, max_length=100)


class DraftBundleFinding(StrictModel):
    category: Literal['missing_method', 'changed_method', 'invalid_recipe', 'advisory']
    severity: Literal['blocker', 'warning']
    source_segment_ids: list[str] = Field(default_factory=list, max_length=1)
    evidence_paths: list[str] = Field(default_factory=list, max_length=20)
    message: str = Field(min_length=1, max_length=3000)


class DraftBundleReview(StrictModel):
    summary: str = Field(min_length=1)
    issues: list[DraftBundleFinding] = Field(default_factory=list, max_length=100)


def validate_bundle_review(payload: dict, source_segments: list[dict], bundle: dict) -> dict:
    draft = DraftBundleReview.model_validate(payload).model_dump()
    allowed_evidence_paths = set(bundle_evidence_paths(bundle))
    issues = []
    for issue in draft['issues']:
        if issue['category'] == 'advisory':
            issue['severity'] = 'warning'
        for pointer in issue['evidence_paths']:
            if pointer not in allowed_evidence_paths:
                raise ValueError(f'Invalid review evidence: {pointer}')
            resolve_pointer(bundle, pointer)
        if issue['severity'] == 'blocker':
            if not issue['source_segment_ids'] or not issue['evidence_paths']:
                raise ValueError('Blocking findings require a source segment ID and valid Bundle evidence paths.')
        if issue['source_segment_ids']:
            source_quote = hydrate_segment_quotes(issue['source_segment_ids'], source_segments)[0]
        else:
            source_quote = ''
        finding = {key: value for key, value in issue.items() if key != 'source_segment_ids'}
        persisted = BundleFinding.model_validate({**finding, 'source_quote': ''}).model_dump()
        persisted['source_quote'] = source_quote
        issues.append(persisted)
    review = BundleReview.model_validate({'summary': draft['summary'], 'issues': issues}).model_dump()
    for normalized, exact in zip(review['issues'], issues, strict=True):
        normalized['source_quote'] = exact['source_quote']
    return review


def install_quality_errors(record: dict, bundle: dict) -> list[str]:
    report = record.get('quality_report') or {}
    if report.get('version') != CONVERSION_VERSION:
        return ['Revalidate this draft using the current conversion checks']
    if not report.get('validated') or report.get('blockers') or any(report.get(k, {}).get('status') != 'passed' for k in ('structure', 'coverage')):
        return ['Resolve native Bundle structure or method conversion issues before installing']
    if report.get('bundle_sha256') != content_hash(bundle):
        return ['Candidate changed; validate the edited draft before installing']
    return []
