from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from novelvideo.interactive_story.models import (
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    InteractiveStoryError,
    InteractiveStoryIssue,
    InteractiveStoryMutationResult,
    InteractiveStoryReadResult,
    InteractiveStoryValidationResult,
    StoryDraftV2,
    StoryPatchV2,
    ValidateInteractiveStoryRequest,
)

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "interactive_story"
    / "story_draft_v2.json"
)


@pytest.fixture
def example_payload() -> dict:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


def test_video_prompt_is_independent_and_bounded(example_payload: dict) -> None:
    example_payload["segments"][0]["video_prompt"] = "  主角推门未开，中景停留。  "
    segment = StoryDraftV2.model_validate(example_payload).segments[0]
    assert segment.video_prompt == "主角推门未开，中景停留。"
    assert segment.script == example_payload["segments"][0]["script"]
    example_payload["segments"][0]["video_prompt"] = "x" * 20_001
    with pytest.raises(ValidationError):
        StoryDraftV2.model_validate(example_payload)


def test_example_story_round_trips_and_expresses_four_decision_points_two_endings(
    example_payload: dict,
) -> None:
    story = StoryDraftV2.model_validate(example_payload)

    assert story.start_segment_id == "heatwave_hook"
    assert story.choices[0].feedback_text
    assert story.choices[2].feedback_text == ""
    assert story.choices[0].interaction.presentation == "overlay"
    assert story.choices[0].interaction.anchor is None
    assert story.segments[0].choice_loop is not None
    assert "无缝循环" in story.segments[0].choice_loop.production_notes
    assert len({choice.source_segment_id for choice in story.choices}) == 4
    assert [segment.ending_label for segment in story.segments if segment.kind == "ending"] == [
        "SAMPLE",
        "SHARE",
    ]
    assert StoryDraftV2.model_validate(story.model_dump()).model_dump() == story.model_dump()


@pytest.mark.parametrize("field", ["source_segment_id", "target_segment_id"])
def test_story_rejects_dangling_choice_references(example_payload: dict, field: str) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][0][field] = "missing_segment"

    with pytest.raises(ValidationError, match=f"unknown {field}"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_duplicate_choice_order_for_one_source(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][1]["order"] = payload["choices"][0]["order"]

    with pytest.raises(ValidationError, match="choice order 0 is duplicated"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_more_than_one_default_choice_per_source(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][1]["is_default"] = True

    with pytest.raises(ValidationError, match="more than one default choice"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_outgoing_choice_from_ending(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"].append(
        {
            "id": "invalid_exit",
            "source_segment_id": "sample_ending",
            "target_segment_id": "heatwave_hook",
            "text": "重新开始",
            "order": 0,
        }
    )

    with pytest.raises(ValidationError, match="ending segment 'sample_ending' must not have choices"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_choice_loop_without_outgoing_choices(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    ending = next(segment for segment in payload["segments"] if segment["kind"] == "ending")
    ending["choice_loop"] = {
        "description": "不应存在的选择循环",
        "media": {"source": "placeholder", "status": "missing", "version": 1},
    }

    with pytest.raises(ValidationError, match="defines choice_loop but has no outgoing choices"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_unknown_variable_in_condition_and_effect(example_payload: dict) -> None:
    condition_payload = copy.deepcopy(example_payload)
    condition_payload["choices"][2]["condition"] = {
        "kind": "variable",
        "variable": "unknown",
        "operator": ">=",
        "value": 1,
    }
    with pytest.raises(ValidationError, match="condition references unknown variable 'unknown'"):
        StoryDraftV2.model_validate(condition_payload)

    effect_payload = copy.deepcopy(example_payload)
    effect_payload["choices"][0]["effects"][0]["variable"] = "unknown"
    with pytest.raises(ValidationError, match="effect references unknown variable 'unknown'"):
        StoryDraftV2.model_validate(effect_payload)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("text", "隐藏按钮", "must not define choice text"),
        ("feedback_text", "不应显示", "must not define player feedback"),
        (
            "interaction",
            {"presentation": "overlay", "ui_style": "warning"},
            "must not define player interaction",
        ),
    ],
)
def test_automatic_transition_rejects_hidden_player_ui(
    example_payload: dict, field: str, value: object, message: str
) -> None:
    payload = copy.deepcopy(example_payload)
    automatic = payload["choices"][2]
    automatic[field] = value

    with pytest.raises(ValidationError, match=message):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_unknown_character_reference(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["segments"][0]["character_ids"].append("ghost")

    with pytest.raises(ValidationError, match="references unknown characters"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_ready_external_media_without_reference(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["segments"][0]["media"] = {
        "source": "generated",
        "status": "ready",
        "version": 1,
    }

    with pytest.raises(ValidationError, match="requires asset_id or url"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_anchored_interaction_without_a_hotspot(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][0]["interaction"] = {"presentation": "baked_video"}

    with pytest.raises(ValidationError, match="require an anchor"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_baked_interaction_without_a_rectangular_hotspot(
    example_payload: dict,
) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][0]["interaction"] = {
        "presentation": "baked_video",
        "anchor": {"x": 0.5, "y": 0.5},
    }

    with pytest.raises(ValidationError, match="require hotspot width and height"):
        StoryDraftV2.model_validate(payload)


def test_story_rejects_hotspot_extending_outside_video_frame(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][0]["interaction"] = {
        "presentation": "baked_video",
        "anchor": {"x": 0.05, "y": 0.5, "width": 0.2, "height": 0.2},
    }

    with pytest.raises(ValidationError, match="hotspot width must stay inside"):
        StoryDraftV2.model_validate(payload)


def test_story_contracts_reject_unknown_fields(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["agent_runtime"] = "hermes"

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        StoryDraftV2.model_validate(payload)


def test_patch_parses_typed_operations_and_requires_revision_and_idempotency() -> None:
    patch = StoryPatchV2.model_validate(
        {
            "schema_version": "story_patch.v2",
            "canvas_id": "default",
            "story_id": "fizz_choice_ad",
            "base_revision": 3,
            "idempotency_key": "agent-turn-0004",
            "operations": [
                {
                    "op": "update_segment",
                    "segment_id": "sample_ending",
                    "changes": {"script": "女孩独自留下，旅人带着真相走进晨光。"},
                },
                {
                    "op": "set_story_start",
                    "segment_id": "heatwave_hook",
                },
            ],
        }
    )

    assert patch.base_revision == 3
    assert patch.operations[0].op == "update_segment"
    assert patch.operations[1].op == "set_story_start"


def test_patch_rejects_empty_changes_and_unknown_operation() -> None:
    base = {
        "schema_version": "story_patch.v2",
        "canvas_id": "default",
        "story_id": "fizz_choice_ad",
        "base_revision": 3,
        "idempotency_key": "agent-turn-0004",
    }
    with pytest.raises(ValidationError, match="requires at least one field"):
        StoryPatchV2.model_validate(
            {**base, "operations": [{"op": "update_segment", "segment_id": "heatwave_hook", "changes": {}}]}
        )
    with pytest.raises(ValidationError, match="union_tag_invalid"):
        StoryPatchV2.model_validate({**base, "operations": [{"op": "replace_everything"}]})


def test_tool_result_and_error_contracts_are_runtime_neutral() -> None:
    issue = InteractiveStoryIssue(
        severity="warning",
        code="missing_video",
        message="节点尚未绑定视频，将使用占位卡试玩。",
        entity_type="segment",
        entity_id="heatwave_hook",
        path="segments[0].media",
    )
    result = InteractiveStoryMutationResult(
        canvas_id="default",
        story_id="fizz_choice_ad",
        revision=1,
        issues=[issue],
    )
    error = InteractiveStoryError(
        code="revision_conflict",
        message="故事已被其他编辑更新。",
        story_id="fizz_choice_ad",
        current_revision=2,
    )

    assert result.ok is True
    assert result.refresh_canvas is True
    assert result.model_dump()["issues"][0]["code"] == "missing_video"
    assert error.ok is False
    assert error.current_revision == 2


def test_v2_supports_flags_and_automatic_transitions(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["flags"].append({"name": "has_key", "label": "已拿到钥匙", "initial": False})
    payload["choices"][0].update(
        {
            "mode": "automatic",
            "text": "",
            "condition": {"kind": "flag", "flag": "has_key", "value": True},
            "effects": [{"kind": "set_flag", "flag": "has_key", "value": False}],
            "feedback_text": "",
            "interaction": {},
            "is_default": False,
        }
    )
    story = StoryDraftV2.model_validate(payload)
    assert story.choices[0].mode == "automatic"
    assert next(flag for flag in story.flags if flag.name == "has_key").initial is False


def test_v2_rejects_unknown_flag(example_payload: dict) -> None:
    payload = copy.deepcopy(example_payload)
    payload["choices"][0]["condition"] = {
        "kind": "flag",
        "flag": "missing_flag",
        "value": True,
    }
    with pytest.raises(ValidationError, match="condition references unknown flag"):
        StoryDraftV2.model_validate(payload)


def test_tool_request_and_result_models_publish_json_schemas(example_payload: dict) -> None:
    story = StoryDraftV2.model_validate(example_payload)
    create = CreateInteractiveStoryRequest(
        canvas_id="default",
        base_revision=4,
        idempotency_key="agent-turn-create-01",
        story=story,
    )
    get = GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    validate = ValidateInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    read = InteractiveStoryReadResult(canvas_id="default", story=story)
    validation = InteractiveStoryValidationResult(
        canvas_id="default",
        story_id=story.story_id,
        revision=4,
        valid=True,
    )

    assert create.story.schema_version == "story_draft.v2"
    assert get.story_id == validate.story_id == read.story.story_id == validation.story_id
    for model in (
        CreateInteractiveStoryRequest,
        GetInteractiveStoryRequest,
        StoryPatchV2,
        ValidateInteractiveStoryRequest,
        InteractiveStoryReadResult,
        InteractiveStoryValidationResult,
        InteractiveStoryMutationResult,
        InteractiveStoryError,
    ):
        schema = model.model_json_schema()
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
