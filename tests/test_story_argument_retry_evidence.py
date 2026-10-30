from copy import deepcopy

import pytest

from novelvideo.chat.runtime_event_evidence import story_argument_retry_matches


def _rejection(paths, *, complete=True):
    return {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
            "invalid_argument_paths": paths, "argument_corrections_complete": complete}


def _story_args():
    return {
        "project_id": "project-a", "canvas_id": "canvas-a", "base_revision": 1,
        "idempotency_key": "original-key", "story_id": "story-a",
        "operations": [{"op": "update", "value": "bad", "effects": ["keep"]},
                       {"op": "update", "value": "other", "effects": ["preserve"]}],
    }


def test_story_retry_allows_each_reported_scalar_correction_and_new_revision():
    before = _story_args()
    after = deepcopy(before)
    after["operations"][0]["value"] = "fixed"
    after["operations"][1]["value"] = "fixed too"
    after["base_revision"] = 2
    after["idempotency_key"] = "new-key"
    assert story_argument_retry_matches(before, after, _rejection([
        ["operations", 0, "value"], ["operations", 1, "value"],
    ]))


@pytest.mark.parametrize("change", ["reorder", "remove", "append", "effects", "scope", "identity"])
def test_story_retry_does_not_mask_unreported_changes(change):
    before = _story_args()
    after = deepcopy(before)
    after["operations"][0]["value"] = "fixed"
    if change == "reorder":
        after["operations"].reverse()
    elif change == "remove":
        after["operations"].pop()
    elif change == "append":
        after["operations"].append({"op": "delete"})
    elif change == "effects":
        after["operations"][0]["effects"] = []
    elif change == "scope":
        after["canvas_id"] = "canvas-b"
    else:
        after["story_id"] = "story-b"
    assert not story_argument_retry_matches(before, after, _rejection([["operations", 0, "value"]]))


@pytest.mark.parametrize("path", [["operations"], ["operations", 0], ["operations", 0, "effects"], []])
def test_story_retry_never_masks_whole_operation_or_container(path):
    before = _story_args()
    after = deepcopy(before)
    after["operations"][0]["value"] = "fixed"
    assert not story_argument_retry_matches(before, after, _rejection([path]))


def test_story_retry_requires_complete_diagnostic_and_a_real_correction():
    before = _story_args()
    after = deepcopy(before)
    after["operations"][0]["value"] = "fixed"
    assert not story_argument_retry_matches(before, after, _rejection([["operations", 0, "value"]], complete=False))
    assert not story_argument_retry_matches(before, before, _rejection([["operations", 0, "value"]]))


def test_story_retry_allows_a_missing_scalar_but_not_a_whole_missing_object():
    before = {"outline": {"title": "Piko"}}
    after = {"outline": {"title": "Piko", "kind": "ad"}}
    assert story_argument_retry_matches(before, after, _rejection([["outline", "kind"]]))
    assert not story_argument_retry_matches({}, after, _rejection([["outline"]]))


def test_story_retry_allows_array_scalar_but_not_reordering_or_size_changes():
    before = {"outline": {"open_questions": [0, "other"]}}
    corrected = {"outline": {"open_questions": ["fixed", "other"]}}
    diagnostic = _rejection([["outline", "open_questions", 0]])
    assert story_argument_retry_matches(before, corrected, diagnostic)
    assert not story_argument_retry_matches(before, {"outline": {"open_questions": ["other", "fixed"]}}, diagnostic)
    assert not story_argument_retry_matches(before, {"outline": {"open_questions": ["fixed", "other", "added"]}}, diagnostic)
    assert not story_argument_retry_matches(before, {"outline": {"open_questions": ["fixed"]}}, diagnostic)


@pytest.mark.parametrize(
    ("field", "default", "different"),
    [
        ("schema_version", "pending_story_outline.v1", "other"),
        ("interaction_summary", "", "changed"),
        ("endings_summary", "", "changed"),
        ("duration_budget_sec", None, 12),
        ("open_questions", [], ["changed"]),
        ("status", "pending", "needs_revision"),
    ],
)
@pytest.mark.parametrize("default_in_before", [False, True])
def test_outline_retry_treats_only_its_saved_defaults_as_equivalent(
    field, default, different, default_in_before
):
    before = {"outline": {"title": "Piko", "premise": "广告", "plot_summary": "故事"}}
    after = {"outline": {**before["outline"], "kind": "ad"}}
    (before if default_in_before else after)["outline"][field] = default
    diagnostic = _rejection([["outline", "kind"]])
    tool = "dramaclaw_save_interactive_story_outline"
    assert story_argument_retry_matches(before, after, diagnostic, tool_name=tool)
    assert not story_argument_retry_matches(before, after, diagnostic, tool_name="dramaclaw_patch_interactive_story")
    (before if default_in_before else after)["outline"][field] = different
    assert not story_argument_retry_matches(before, after, diagnostic, tool_name=tool)


def test_outline_retry_defaults_do_not_hide_unreported_content_change():
    before = {"outline": {"title": "Piko"}}
    after = {"outline": {"title": "Other", "kind": "ad", "schema_version": "pending_story_outline.v1"}}
    assert not story_argument_retry_matches(
        before, after, _rejection([["outline", "kind"]]),
        tool_name="dramaclaw_save_interactive_story_outline",
    )


@pytest.mark.parametrize(
    ("field", "default"),
    [
        ("schema_version", "pending_story_outline.v1"),
        ("interaction_summary", ""),
        ("endings_summary", ""),
        ("duration_budget_sec", None),
        ("open_questions", []),
        ("status", "pending"),
    ],
)
def test_outline_retry_defaults_match_the_persisted_contract(field, default):
    from novelvideo.interactive_story.models import PendingStoryOutline

    data = {"outline_id": "outline-a", "kind": "ad", "title": "Piko",
            "premise": "广告", "plot_summary": "故事"}
    implicit = PendingStoryOutline.model_validate(data).model_dump(mode="json")
    explicit = PendingStoryOutline.model_validate({**data, field: default}).model_dump(mode="json")
    assert implicit == explicit
