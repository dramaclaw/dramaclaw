from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.interactive_story.canvas_mapper import (
    CLIP_HEIGHT,
    CLIP_WIDTH,
    project_story_to_canvas,
    story_from_canvas,
)
from novelvideo.interactive_story.models import (
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    StoryDraftV1,
    StoryMediaRef,
    StoryPatchV1,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.service import (
    InteractiveStoryService,
    InteractiveStoryServiceError,
    issues_for_story,
)

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "interactive_story"
    / "story_draft_v1.json"
)


@pytest.fixture
def story() -> StoryDraftV1:
    return StoryDraftV1.model_validate_json(EXAMPLE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def service(tmp_path: Path) -> InteractiveStoryService:
    return InteractiveStoryService(
        tmp_path / "project", project_id="project-1", actor_id="user-1"
    )


def create_request(
    story: StoryDraftV1, *, key: str = "agent-create-0001"
) -> CreateInteractiveStoryRequest:
    return CreateInteractiveStoryRequest(
        canvas_id="default",
        base_revision=0,
        idempotency_key=key,
        story=story,
    )


def test_mapper_round_trip_preserves_domain_ids_conditions_and_effects(
    story: StoryDraftV1,
) -> None:
    projection = project_story_to_canvas(story)
    canvas = {
        "revision": 7,
        "nodes": projection.nodes,
        "edges": projection.edges,
    }

    restored = story_from_canvas(canvas, story.story_id)

    assert restored.revision == 7
    assert restored.start_segment_id == story.start_segment_id
    assert [segment.id for segment in restored.segments] == [
        segment.id for segment in story.segments
    ]
    assert [choice.id for choice in restored.choices] == [
        choice.id for choice in story.choices
    ]
    assert restored.choices[0].effects[0].variable == "courage"
    assert restored.choices[2].condition == story.choices[2].condition


def test_mapper_projects_composite_story_clips_without_overlap(
    story: StoryDraftV1,
) -> None:
    projection = project_story_to_canvas(story)
    clips = [node for node in projection.nodes if node["type"] == "videoNode"]
    group = next(node for node in projection.nodes if node["id"] == projection.group_id)

    assert clips
    assert all(
        node["width"] == CLIP_WIDTH and node["height"] == CLIP_HEIGHT for node in clips
    )
    for index, left in enumerate(clips):
        for right in clips[index + 1 :]:
            left_x, left_y = left["position"]["x"], left["position"]["y"]
            right_x, right_y = right["position"]["x"], right["position"]["y"]
            overlaps = (
                left_x < right_x + CLIP_WIDTH
                and left_x + CLIP_WIDTH > right_x
                and left_y < right_y + CLIP_HEIGHT
                and left_y + CLIP_HEIGHT > right_y
            )
            assert not overlaps

    assert group["width"] >= max(
        node["position"]["x"] + CLIP_WIDTH + 60 for node in clips
    )
    assert group["height"] >= max(
        node["position"]["y"] + CLIP_HEIGHT + 60 for node in clips
    )


def test_create_appends_story_atomically_and_get_reads_canvas_revision(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    result = service.create(create_request(story))
    canvas = canvas_store.read_canvas(service.project_dir, "default")

    assert result.revision == 1
    assert result.canvas_id == "default"
    assert result.refresh_canvas is True
    assert result.idempotent is False
    assert canvas is not None
    assert canvas["revision"] == 1
    assert canvas["save_source"] == "agent_create"
    assert len(canvas["nodes"]) == len(story.segments) + 1
    assert len(canvas["edges"]) == len(story.choices)
    assert all(issue.code == "missing_video" for issue in result.issues)

    read = service.get(
        GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    )
    assert read.story.revision == 1
    assert read.story.title == story.title


def test_get_reports_duplicate_story_groups_as_invalid_story(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))
    canvas_path = service.project_dir / "freezone" / "canvases" / "default.json"
    canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    story_group = next(
        node
        for node in canvas["nodes"]
        if (node.get("data") or {}).get("interactiveStoryId") == story.story_id
    )
    duplicate_group = {**story_group, "id": f"{story_group['id']}-duplicate"}
    canvas["nodes"].append(duplicate_group)
    canvas_store.atomic_write_json(canvas_path, canvas)

    with pytest.raises(InteractiveStoryServiceError) as caught:
        service.get(
            GetInteractiveStoryRequest(
                canvas_id="default",
                story_id=story.story_id,
            )
        )

    assert caught.value.code == "invalid_story"


def test_create_preserves_unrelated_canvas_nodes(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    unrelated = {
        "schema_version": 2,
        "canvas_id": "default",
        "project_id": "project-1",
        "revision": 4,
        "nodes": [
            {
                "id": "user-note",
                "type": "textAnnotationNode",
                "position": {"x": 10, "y": 20},
                "width": 320,
                "data": {"content": "keep me"},
            }
        ],
        "edges": [],
        "viewport": {"x": 1, "y": 2, "zoom": 0.8},
        "metadata": {"keep": True},
    }
    canvas_store.atomic_write_json(
        service.project_dir / "freezone" / "canvases" / "default.json",
        unrelated,
    )
    request = create_request(story)
    request.base_revision = 4

    result = service.create(request)
    canvas = canvas_store.read_canvas(service.project_dir, "default")

    assert result.revision == 5
    assert canvas is not None
    assert any(node.get("id") == "user-note" for node in canvas["nodes"])
    assert canvas["viewport"] == unrelated["viewport"]
    assert canvas["metadata"] == unrelated["metadata"]


def test_create_retry_is_idempotent_and_does_not_duplicate_story(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    request = create_request(story)
    first = service.create(request)
    second = service.create(request)
    canvas = canvas_store.read_canvas(service.project_dir, "default")

    assert first.revision == second.revision == 1
    assert second.idempotent is True
    assert canvas is not None
    groups = [
        node
        for node in canvas["nodes"]
        if (node.get("data") or {}).get("interactiveStoryId")
    ]
    assert len(groups) == 1


def test_create_rejects_idempotency_key_reuse_for_different_story_payload(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    request = create_request(story)
    service.create(request)
    changed = story.model_copy(update={"title": "另一个标题"})

    with pytest.raises(InteractiveStoryServiceError) as caught:
        service.create(create_request(changed))

    assert caught.value.code == "idempotency_conflict"


def test_patch_preserves_manual_layout_media_and_unknown_node_data(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))
    canvas_path = service.project_dir / "freezone" / "canvases" / "default.json"
    canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    target = next(
        node
        for node in canvas["nodes"]
        if (node.get("data") or {}).get("storySegmentId") == "truth_ending"
    )
    target["position"] = {"x": 999, "y": 321}
    target["data"]["videoUrl"] = "/media/user-cut.mp4"
    target["data"]["customUserField"] = "preserve"
    canvas_store.atomic_write_json(canvas_path, canvas)

    result = service.patch(
        StoryPatchV1.model_validate(
            {
                "canvas_id": "default",
                "story_id": story.story_id,
                "base_revision": 1,
                "idempotency_key": "agent-patch-0001",
                "operations": [
                    {
                        "op": "update_segment",
                        "segment_id": "truth_ending",
                        "changes": {"script": "旅人带着真相独自走进晨光。"},
                    }
                ],
            }
        )
    )
    saved = canvas_store.read_canvas(service.project_dir, "default")
    assert saved is not None
    updated = next(
        node
        for node in saved["nodes"]
        if (node.get("data") or {}).get("storySegmentId") == "truth_ending"
    )

    assert result.revision == 2
    assert updated["position"] == {"x": 999, "y": 321}
    assert updated["data"]["videoUrl"] == "/media/user-cut.mp4"
    assert updated["data"]["customUserField"] == "preserve"
    assert updated["data"]["narration"] == "旅人带着真相独自走进晨光。"
    assert saved["save_source"] == "agent_patch"


def test_patch_media_null_clears_segment_to_placeholder(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))

    service.patch(
        StoryPatchV1.model_validate(
            {
                "canvas_id": "default",
                "story_id": story.story_id,
                "base_revision": 1,
                "idempotency_key": "agent-patch-clear-media",
                "operations": [
                    {
                        "op": "update_segment",
                        "segment_id": story.start_segment_id,
                        "changes": {"media": None},
                    }
                ],
            }
        )
    )

    restored = service.get(
        GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    ).story
    updated = next(
        segment for segment in restored.segments if segment.id == story.start_segment_id
    )
    assert updated.media == StoryMediaRef()


def test_patch_is_atomic_on_invalid_result_and_rejects_stale_revision(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))
    invalid_patch = StoryPatchV1.model_validate(
        {
            "canvas_id": "default",
            "story_id": story.story_id,
            "base_revision": 1,
            "idempotency_key": "agent-patch-invalid",
            "operations": [
                {"op": "remove_segment", "segment_id": story.start_segment_id}
            ],
        }
    )
    with pytest.raises(InteractiveStoryServiceError) as invalid:
        service.patch(invalid_patch)
    assert invalid.value.code == "invalid_story"
    assert canvas_store.read_canvas(service.project_dir, "default")["revision"] == 1

    valid_patch = StoryPatchV1.model_validate(
        {
            "canvas_id": "default",
            "story_id": story.story_id,
            "base_revision": 1,
            "idempotency_key": "agent-patch-valid",
            "operations": [
                {
                    "op": "update_story_metadata",
                    "changes": {"title": "午夜站台：重制版"},
                }
            ],
        }
    )
    service.patch(valid_patch)
    with pytest.raises(InteractiveStoryServiceError) as stale:
        service.patch(
            valid_patch.model_copy(update={"idempotency_key": "agent-patch-stale"})
        )
    assert stale.value.code == "revision_conflict"
    assert stale.value.current_revision == 2


def test_remove_segment_cascades_directly_connected_choices(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))

    result = service.patch(
        StoryPatchV1.model_validate(
            {
                "canvas_id": "default",
                "story_id": story.story_id,
                "base_revision": 1,
                "idempotency_key": "agent-patch-remove-ending",
                "operations": [{"op": "remove_segment", "segment_id": "truth_ending"}],
            }
        )
    )
    restored = service.get(
        GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    ).story

    assert result.revision == 2
    assert "truth_ending" not in {segment.id for segment in restored.segments}
    assert "follow_open_door" not in {choice.id for choice in restored.choices}
    assert all(
        choice.source_segment_id != "truth_ending"
        and choice.target_segment_id != "truth_ending"
        for choice in restored.choices
    )


def test_story_issues_distinguish_bound_asset_and_warn_about_timed_fallback(
    story: StoryDraftV1,
) -> None:
    payload = story.model_dump(mode="json")
    payload["segments"][0]["media"] = {
        "source": "generated",
        "status": "ready",
        "asset_id": "video-asset-001",
        "version": 1,
    }
    for choice in payload["choices"]:
        if choice["source_segment_id"] == payload["segments"][0]["id"]:
            choice["is_default"] = False
    updated = StoryDraftV1.model_validate(payload)

    issues = issues_for_story(updated)
    start_codes = {
        issue.code for issue in issues if issue.entity_id == updated.start_segment_id
    }

    assert "missing_video" not in start_codes
    assert "media_url_unresolved" in start_codes
    assert "timed_choice_uses_first_default" in start_codes


def test_patch_retry_is_idempotent_and_does_not_bump_revision_twice(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))
    patch = StoryPatchV1.model_validate(
        {
            "canvas_id": "default",
            "story_id": story.story_id,
            "base_revision": 1,
            "idempotency_key": "agent-patch-retry-01",
            "operations": [
                {
                    "op": "update_story_metadata",
                    "changes": {"title": "午夜站台：导演剪辑版"},
                }
            ],
        }
    )

    first = service.patch(patch)
    second = service.patch(patch)
    canvas = canvas_store.read_canvas(service.project_dir, "default")

    assert first.revision == second.revision == 2
    assert second.idempotent is True
    assert canvas is not None
    assert canvas["revision"] == 2


def test_validate_reports_malformed_canvas_without_modifying_it(
    service: InteractiveStoryService,
    story: StoryDraftV1,
) -> None:
    service.create(create_request(story))
    canvas_path = service.project_dir / "freezone" / "canvases" / "default.json"
    canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    canvas["edges"][0]["target"] = "missing-node"
    canvas_store.atomic_write_json(canvas_path, canvas)

    result = service.validate(
        ValidateInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    )

    assert result.valid is False
    assert result.issues[0].severity == "error"
    assert result.issues[0].code == "invalid_story"
    assert canvas_store.read_canvas(service.project_dir, "default") == canvas
