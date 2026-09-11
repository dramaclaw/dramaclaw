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
    StoryChoiceAnchor,
    StoryChoiceInteraction,
    StoryDraftV2,
    StoryMediaRef,
    StoryPatchV2,
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
    / "story_draft_v2.json"
)


@pytest.fixture
def story() -> StoryDraftV2:
    return StoryDraftV2.model_validate_json(EXAMPLE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def service(tmp_path: Path) -> InteractiveStoryService:
    return InteractiveStoryService(
        tmp_path / "project", project_id="project-1", actor_id="user-1"
    )


def create_request(
    story: StoryDraftV2, *, key: str = "agent-create-0001"
) -> CreateInteractiveStoryRequest:
    return CreateInteractiveStoryRequest(
        canvas_id="default",
        base_revision=0,
        idempotency_key=key,
        story=story,
    )


def test_video_prompt_round_trip_and_patch_preserve_story_and_media(
    service: InteractiveStoryService, story: StoryDraftV2,
) -> None:
    segment = story.segments[0]
    segment.video_prompt = "主角推门未开，中景停留。"
    segment.media = StoryMediaRef(source="imported", status="ready", url="/media/door.mp4")
    service.create(create_request(story))
    saved = canvas_store.read_canvas(service.project_dir, "default")
    node = next(n for n in saved["nodes"] if n["data"].get("storySegmentId") == segment.id)
    assert node["data"]["prompt"] == segment.video_prompt
    request = GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    assert service.get(request).story.segments[0].video_prompt == segment.video_prompt

    # Updating just narrative must preserve the independent production prompt.
    for revision, changes in enumerate([
        {"script": "更新剧情，不重做视频。"},
        {"video_prompt": "镜头缓慢推进，停留在木门。"},
        {"video_prompt": ""},
    ], start=1):
        service.patch(StoryPatchV2.model_validate({
            "canvas_id": "default", "story_id": story.story_id,
            "base_revision": revision, "idempotency_key": f"prompt-patch-{revision}",
            "operations": [{"op": "update_segment", "segment_id": segment.id, "changes": changes}],
        }))
        restored = service.get(request).story
        actual = restored.segments[0]
        assert actual.video_prompt == changes.get("video_prompt", segment.video_prompt)
        assert actual.script == "更新剧情，不重做视频。"
        assert actual.production_notes == segment.production_notes
        assert actual.media == segment.media
        assert restored.choices == story.choices


def test_mapper_keeps_group_display_name_in_sync_with_story_title(
    story: StoryDraftV2,
) -> None:
    projection = project_story_to_canvas(story)
    group = next(node for node in projection.nodes if node["type"] == "groupNode")
    assert group["data"]["displayName"] == story.title
    assert group["data"]["label"] == story.title

    group["data"]["displayName"] = "分组 1"
    renamed = story.model_copy(update={"title": "新的互动短剧标题"})
    updated = project_story_to_canvas(
        renamed, existing_canvas={"nodes": projection.nodes, "edges": projection.edges}
    )
    updated_group = next(node for node in updated.nodes if node["type"] == "groupNode")
    assert updated_group["id"] == group["id"]
    assert updated_group["data"]["displayName"] == renamed.title
    assert updated_group["data"]["label"] == renamed.title


def test_mapper_round_trip_preserves_domain_ids_conditions_and_effects(
    story: StoryDraftV2,
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
    assert restored.choices[0].effects[0].variable == "engagement"
    assert restored.choices[0].feedback_text == story.choices[0].feedback_text
    assert restored.choices[0].interaction == story.choices[0].interaction
    assert restored.segments[0].choice_loop == story.segments[0].choice_loop
    assert restored.choices[2].condition == story.choices[2].condition


def test_mapper_round_trip_preserves_flags_and_automatic_transition(
    story: StoryDraftV2,
) -> None:
    payload = story.model_dump(mode="json")
    payload["flags"].append({"name": "has_key", "label": "已拿到钥匙", "initial": False})
    payload["choices"][0].update(
        {
            "mode": "automatic",
            "text": "",
            "condition": {"kind": "flag", "flag": "has_key", "value": False},
            "effects": [{"kind": "set_flag", "flag": "has_key", "value": True}],
            "feedback_text": "",
            "interaction": {},
            "is_default": False,
        }
    )
    edited = StoryDraftV2.model_validate(payload)
    projection = project_story_to_canvas(edited)
    restored = story_from_canvas(
        {"revision": 3, "nodes": projection.nodes, "edges": projection.edges},
        edited.story_id,
    )

    assert restored.flags == edited.flags
    assert restored.choices[0].mode == "automatic"
    assert restored.choices[0].condition == edited.choices[0].condition
    assert restored.choices[0].effects == edited.choices[0].effects


def test_mapper_preserves_overlay_interaction_with_authored_anchor(
    story: StoryDraftV2,
) -> None:
    edited = story.model_copy(deep=True)
    edited.choices[0].interaction = StoryChoiceInteraction(
        presentation="overlay",
        anchor=StoryChoiceAnchor(x=0.23, y=0.81, object_label="保留给下次锚定的灯"),
        ui_style="warning",
        motion="pulse",
        transition="flash",
    )

    projection = project_story_to_canvas(edited)
    canvas = {"revision": 7, "nodes": projection.nodes, "edges": projection.edges}
    restored = story_from_canvas(canvas, edited.story_id)
    projected_again = project_story_to_canvas(restored)

    assert restored.choices[0].interaction == edited.choices[0].interaction
    edge = next(item for item in projected_again.edges if item["data"]["storyChoiceId"] == edited.choices[0].id)
    assert edge["data"]["interaction"] == {
        "presentation": "overlay",
        "anchor": {"x": 0.23, "y": 0.81, "objectLabel": "保留给下次锚定的灯"},
        "uiStyle": "warning",
        "motion": "pulse",
        "transition": "flash",
    }


def test_mapper_preserves_baked_video_rectangular_hotspot(story: StoryDraftV2) -> None:
    edited = story.model_copy(deep=True)
    edited.choices[0].interaction = StoryChoiceInteraction(
        presentation="baked_video",
        anchor=StoryChoiceAnchor(x=0.52, y=0.63, width=0.28, height=0.16),
    )

    projection = project_story_to_canvas(edited)
    canvas = {"revision": 7, "nodes": projection.nodes, "edges": projection.edges}
    restored = story_from_canvas(canvas, edited.story_id)

    assert restored.choices[0].interaction == edited.choices[0].interaction
    edge = next(item for item in projection.edges if item["data"]["storyChoiceId"] == edited.choices[0].id)
    assert edge["data"]["interaction"]["anchor"] == {
        "x": 0.52,
        "y": 0.63,
        "width": 0.28,
        "height": 0.16,
    }


def test_mapper_appended_clips_avoid_existing_and_each_other(story: StoryDraftV2) -> None:
    original = project_story_to_canvas(story)
    clips = [node for node in original.nodes if node["type"] == "videoNode"]
    # A manually enlarged clip spans the preferred columns of appended scenes.
    clips[0]["position"] = {"x": 0, "y": 0}
    clips[0]["measured"] = {"width": 10000, "height": 1800}
    previous_positions = {node["id"]: dict(node["position"]) for node in clips}
    appended = [story.segments[0].model_copy(update={"id": f"appended-{i}"}) for i in range(2)]
    edited = story.model_copy(update={"segments": appended + story.segments})
    projected = project_story_to_canvas(
        edited, existing_canvas={"nodes": original.nodes, "edges": original.edges}
    )
    new_clips = [node for node in projected.nodes
                 if node.get("data", {}).get("storySegmentId", "").startswith("appended-")]
    assert len(new_clips) == 2
    for node in projected.nodes:
        if node["id"] in previous_positions:
            assert node["position"] == previous_positions[node["id"]]
    assert all(node["position"]["y"] >= 1920 for node in new_clips)
    assert abs(new_clips[0]["position"]["y"] - new_clips[1]["position"]["y"]) >= CLIP_HEIGHT + 120
    group = next(node for node in projected.nodes if node["id"] == projected.group_id)
    assert group["width"] >= 10000 + 60
    assert group["height"] >= max(node["position"]["y"] + CLIP_HEIGHT + 60 for node in new_clips)
    repeated = project_story_to_canvas(
        edited, existing_canvas={"nodes": projected.nodes, "edges": projected.edges}
    )
    assert repeated.nodes == projected.nodes


def test_mapper_projects_composite_story_clips_without_overlap(
    story: StoryDraftV2,
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
    story: StoryDraftV2,
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
    story: StoryDraftV2,
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
    story: StoryDraftV2,
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
    story: StoryDraftV2,
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
    story: StoryDraftV2,
) -> None:
    request = create_request(story)
    service.create(request)
    changed = story.model_copy(update={"title": "另一个标题"})

    with pytest.raises(InteractiveStoryServiceError) as caught:
        service.create(create_request(changed))

    assert caught.value.code == "idempotency_conflict"


def test_patch_preserves_manual_layout_media_and_unknown_node_data(
    service: InteractiveStoryService,
    story: StoryDraftV2,
) -> None:
    service.create(create_request(story))
    canvas_path = service.project_dir / "freezone" / "canvases" / "default.json"
    canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    target = next(
        node
        for node in canvas["nodes"]
        if (node.get("data") or {}).get("storySegmentId") == "sample_ending"
    )
    target["position"] = {"x": 999, "y": 321}
    target["data"]["videoUrl"] = "/media/user-cut.mp4"
    target["data"]["customUserField"] = "preserve"
    canvas_store.atomic_write_json(canvas_path, canvas)

    result = service.patch(
        StoryPatchV2.model_validate(
            {
                "canvas_id": "default",
                "story_id": story.story_id,
                "base_revision": 1,
                "idempotency_key": "agent-patch-0001",
                "operations": [
                    {
                        "op": "update_segment",
                        "segment_id": "sample_ending",
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
        if (node.get("data") or {}).get("storySegmentId") == "sample_ending"
    )

    assert result.revision == 2
    assert updated["position"] == {"x": 999, "y": 321}
    assert updated["data"]["videoUrl"] == "/media/user-cut.mp4"
    assert updated["data"]["customUserField"] == "preserve"
    assert updated["data"]["narration"] == "旅人带着真相独自走进晨光。"
    assert saved["save_source"] == "agent_patch"


def test_patch_media_null_clears_segment_to_placeholder(
    service: InteractiveStoryService,
    story: StoryDraftV2,
) -> None:
    service.create(create_request(story))

    service.patch(
        StoryPatchV2.model_validate(
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
    story: StoryDraftV2,
) -> None:
    service.create(create_request(story))
    invalid_patch = StoryPatchV2.model_validate(
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

    valid_patch = StoryPatchV2.model_validate(
        {
            "canvas_id": "default",
            "story_id": story.story_id,
            "base_revision": 1,
            "idempotency_key": "agent-patch-valid",
            "operations": [
                {
                    "op": "update_story_metadata",
                    "changes": {"title": "这一口，听你的：重制版"},
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
    story: StoryDraftV2,
) -> None:
    service.create(create_request(story))

    result = service.patch(
        StoryPatchV2.model_validate(
            {
                "canvas_id": "default",
                "story_id": story.story_id,
                "base_revision": 1,
                "idempotency_key": "agent-patch-remove-ending",
                "operations": [{"op": "remove_segment", "segment_id": "sample_ending"}],
            }
        )
    )
    restored = service.get(
        GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    ).story

    assert result.revision == 2
    assert "sample_ending" not in {segment.id for segment in restored.segments}
    assert "citrus_sample" not in {choice.id for choice in restored.choices}
    assert "berry_sample" not in {choice.id for choice in restored.choices}
    assert all(
        choice.source_segment_id != "sample_ending"
        and choice.target_segment_id != "sample_ending"
        for choice in restored.choices
    )


@pytest.mark.parametrize("remove", [False, True])
def test_patch_preserves_media_edges_except_those_touching_removed_segments(
    service: InteractiveStoryService, story: StoryDraftV2, remove: bool,
) -> None:
    service.create(create_request(story))
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    target = next(n["id"] for n in canvas["nodes"] if n["data"].get("storySegmentId") == "sample_ending")
    surviving = next(n["id"] for n in canvas["nodes"] if n["data"].get("storySegmentId") == story.start_segment_id)
    media_nodes = [
        {"id": name, "type": "imageNode", "position": {"x": 0, "y": 0}, "data": {}}
        for name in ("reference-image", "external-output")
    ]
    media_edges = [
        {"id": "incoming", "source": "reference-image", "target": target},
        {"id": "outgoing", "source": target, "target": "external-output"},
        {"id": "surviving-reference", "source": "reference-image", "target": surviving},
        {"id": "unrelated", "source": "reference-image", "target": "external-output"},
    ]
    canvas["nodes"].extend(media_nodes)
    canvas["edges"].extend(media_edges)
    canvas["revision"] = 2
    canvas_store.save_canvas(
        service.project_dir, "default", base_revision=1,
        build_payload=lambda _: canvas, client_save_id="reference-setup-01",
    )
    operation = (
        {"op": "remove_segment", "segment_id": "sample_ending"} if remove
        else {"op": "update_story_metadata", "changes": {"title": "新版"}}
    )
    service.patch(StoryPatchV2.model_validate({
        "canvas_id": "default", "story_id": story.story_id, "base_revision": 2,
        "idempotency_key": "media-edge-patch-01", "operations": [operation],
    }))
    saved = canvas_store.read_canvas(service.project_dir, "default")
    ids = {n["id"] for n in saved["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in saved["edges"])
    expected = media_edges[2:] if remove else media_edges
    assert [e for e in saved["edges"] if e["id"] in {item["id"] for item in media_edges}] == expected
    assert all(node in saved["nodes"] for node in media_nodes)


def test_patch_preserves_non_story_video_nodes_inside_story_group(
    service: InteractiveStoryService, story: StoryDraftV2,
) -> None:
    service.create(create_request(story))
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    group = next(node for node in canvas["nodes"] if node["data"].get("storyGroup"))
    start = next(
        node["id"]
        for node in canvas["nodes"]
        if node["data"].get("storySegmentId") == story.start_segment_id
    )
    manual = {
        "id": "manual-production-video",
        "type": "videoNode",
        "parentId": group["id"],
        "position": {"x": 80, "y": 90},
        "data": {"label": "手工制作节点", "customMarker": "keep-me"},
    }
    manual_edge = {
        "id": "manual-production-edge",
        "source": "manual-production-video",
        "target": start,
    }
    canvas["nodes"].append(manual)
    canvas["edges"].append(manual_edge)
    canvas["revision"] = 2
    canvas_store.save_canvas(
        service.project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _: canvas,
        client_save_id="manual-production-setup-01",
    )

    service.patch(StoryPatchV2.model_validate({
        "canvas_id": "default",
        "story_id": story.story_id,
        "base_revision": 2,
        "idempotency_key": "preserve-manual-video-01",
        "operations": [{
            "op": "update_story_metadata",
            "changes": {"title": "只修改故事标题"},
        }],
    }))

    saved = canvas_store.read_canvas(service.project_dir, "default")
    assert manual in saved["nodes"]
    assert manual_edge in saved["edges"]
    assert not any(
        node.get("data", {}).get("storySegmentId") == "manual-production-video"
        for node in saved["nodes"]
    )


def test_story_issues_distinguish_bound_asset_and_warn_about_timed_fallback(
    story: StoryDraftV2,
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
    updated = StoryDraftV2.model_validate(payload)

    issues = issues_for_story(updated)
    start_codes = {
        issue.code for issue in issues if issue.entity_id == updated.start_segment_id
    }

    assert "missing_video" not in start_codes
    assert "media_url_unresolved" in start_codes
    assert "timed_choice_uses_first_default" in start_codes


def test_path_analysis_reports_branch_that_conditions_can_never_reach(
    story: StoryDraftV2,
) -> None:
    payload = story.model_dump(mode="json")
    payload["choices"].append(
        {
            "id": "impossible_citrus_branch",
            "source_segment_id": "citrus_reveal",
            "target_segment_id": "share_ending",
            "text": "不存在的莓果状态",
            "order": 2,
            "condition": {
                "kind": "flag",
                "flag": "prefers_citrus",
                "value": False,
            },
        }
    )

    issues = issues_for_story(StoryDraftV2.model_validate(payload))

    assert any(
        issue.code == "condition_unreachable"
        and issue.entity_id == "impossible_citrus_branch"
        for issue in issues
    )


def test_path_analysis_blocks_reachable_variable_overflow(story: StoryDraftV2) -> None:
    payload = story.model_dump(mode="json")
    payload["choices"][0]["effects"][0]["delta"] = 4

    issues = issues_for_story(StoryDraftV2.model_validate(payload))

    assert any(
        issue.code == "variable_out_of_bounds" and issue.entity_id == "pick_citrus"
        for issue in issues
    )


def test_path_analysis_blocks_condition_matched_automatic_cycle(story: StoryDraftV2) -> None:
    payload = story.model_dump(mode="json")
    route = next(choice for choice in payload["choices"] if choice["id"] == "route_citrus")
    route["target_segment_id"] = "flavor_scan"

    issues = issues_for_story(StoryDraftV2.model_validate(payload))

    assert any(
        issue.code == "automatic_cycle" and issue.entity_id == "route_citrus"
        for issue in issues
    )


def test_long_finite_automatic_chain_is_incomplete_not_a_cycle() -> None:
    story = StoryDraftV2.model_validate({
        "story_id": "long_chain", "title": "长过场", "start_segment_id": "n0",
        "segments": [
            {"id": f"n{i}", "title": f"场景{i}", "script": "过场"}
            for i in range(103)
        ],
        "choices": [
            {"id": f"e{i}", "source_segment_id": f"n{i}",
             "target_segment_id": f"n{i + 1}", "text": "", "order": 0,
             "mode": "automatic"}
            for i in range(102)
        ],
    })
    codes = {issue.code for issue in issues_for_story(story)}
    assert "path_analysis_incomplete" in codes
    assert "automatic_cycle" not in codes
    assert "runtime_unreachable" not in codes


def test_path_analysis_allows_player_return_after_unlocking_state() -> None:
    story = StoryDraftV2.model_validate(
        {
            "story_id": "locked_door",
            "title": "门锁谜题",
            "start_segment_id": "door",
            "flags": [{"name": "unlocked", "label": "门已解锁", "initial": False}],
            "segments": [
                {"id": "door", "title": "门口", "script": "门锁着。"},
                {"id": "key", "title": "储物间", "script": "你找到钥匙。"},
                {"id": "room", "title": "密室", "script": "门开了。", "kind": "ending", "ending_label": "GE"},
            ],
            "choices": [
                {
                    "id": "find_key",
                    "source_segment_id": "door",
                    "target_segment_id": "key",
                    "text": "寻找钥匙",
                    "order": 0,
                    "condition": {"kind": "flag", "flag": "unlocked", "value": False},
                },
                {
                    "id": "open_door",
                    "source_segment_id": "door",
                    "target_segment_id": "room",
                    "text": "打开门",
                    "order": 1,
                    "condition": {"kind": "flag", "flag": "unlocked", "value": True},
                },
                {
                    "id": "return_with_key",
                    "source_segment_id": "key",
                    "target_segment_id": "door",
                    "text": "返回门口",
                    "order": 0,
                    "effects": [{"kind": "set_flag", "flag": "unlocked", "value": True}],
                },
            ],
        }
    )

    path_codes = {
        issue.code
        for issue in issues_for_story(story)
        if issue.code in {"runtime_unreachable", "condition_unreachable", "automatic_cycle"}
    }

    assert path_codes == set()


def test_patch_retry_is_idempotent_and_does_not_bump_revision_twice(
    service: InteractiveStoryService,
    story: StoryDraftV2,
) -> None:
    service.create(create_request(story))
    patch = StoryPatchV2.model_validate(
        {
            "canvas_id": "default",
            "story_id": story.story_id,
            "base_revision": 1,
            "idempotency_key": "agent-patch-retry-01",
            "operations": [
                {
                    "op": "update_story_metadata",
                    "changes": {"title": "这一口，听你的：导演剪辑版"},
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
    story: StoryDraftV2,
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
