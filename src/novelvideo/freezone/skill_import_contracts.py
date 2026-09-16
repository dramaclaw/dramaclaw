"""Internal import contracts. These are audit artifacts, never runtime Skills."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field

CONVERSION_VERSION = 3


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


def validate_bundle_review(payload: dict, source: str, bundle: dict) -> dict:
    review = BundleReview.model_validate(payload).model_dump()
    for issue in review['issues']:
        if issue['category'] == 'advisory':
            issue['severity'] = 'warning'
        for pointer in issue['evidence_paths']:
            resolve_pointer(bundle, pointer)
        if issue['severity'] == 'blocker':
            quote = ' '.join(issue['source_quote'].split())
            if not quote or quote not in ' '.join(source.split()) or not issue['evidence_paths']:
                raise ValueError('Blocking findings require an exact source quote and valid Bundle evidence paths. '
                                 'Copy a short contiguous source phrase verbatim; do not abbreviate with ellipses or combine passages. '
                                 f'Invalid quote: {issue["source_quote"][:400]}')
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
