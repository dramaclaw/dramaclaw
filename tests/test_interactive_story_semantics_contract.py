"""Shared semantic expectations, also consumed by the frontend's Ink tests."""
import json
from pathlib import Path

import pytest

from novelvideo.interactive_story.models import StoryDraftV2
from novelvideo.interactive_story.service import issues_for_story

CASES = sorted((Path(__file__).resolve().parents[1] / 'tests/fixtures/interactive_story/cases').glob('*.json'))
assert CASES, 'Shared story semantic cases must not be empty'


def canonical(issues):
    return sorted(issues, key=lambda issue: (issue['code'], issue['entityId'] or '', issue['severity']))


@pytest.mark.parametrize('path', CASES, ids=lambda path: path.stem)
def test_shared_story_semantics(path):
    case = json.loads(path.read_text(encoding='utf-8'))
    story = StoryDraftV2.model_validate(case['story'])
    actual = [
        {'code': issue.code, 'severity': issue.severity,
         'entityId': None if issue.entity_type == 'story' else issue.entity_id}
        for issue in issues_for_story(story)
    ]
    assert canonical(actual) == canonical(case['expectedIssues'])
    # Every playable fixture must have a runtime trace; rejected graphs must never run.
    assert bool(case['playthroughs']) == (not any(i['severity'] == 'error' for i in actual))
