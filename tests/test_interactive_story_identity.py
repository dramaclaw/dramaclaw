"""Regression coverage for stable manual IDs and atomic projection conflicts."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.interactive_story.canvas_mapper import (
    _domain_id,
    project_story_to_canvas,
    story_choice_edge_id,
    story_segment_node_id,
)
from novelvideo.interactive_story.models import (
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    StoryDraftV2,
    StoryPatchV2,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.publication import PublicationStore
from novelvideo.interactive_story.service import (
    InteractiveStoryService,
    InteractiveStoryServiceError,
)


def _story(story_id: str, start: str = "start", end: str = "end") -> StoryDraftV2:
    return StoryDraftV2.model_validate({
        "story_id": story_id,
        "title": "ID regression",
        "start_segment_id": start,
        "segments": [
            {"id": start, "title": "Start", "script": "Start"},
            {"id": end, "title": "End", "script": "End", "kind": "ending", "ending_label": "END"},
        ],
        "choices": [{
            "id": "original", "source_segment_id": start,
            "target_segment_id": end, "text": "Continue", "order": 0,
        }],
    })


def _create(service: InteractiveStoryService, story: StoryDraftV2) -> None:
    service.create(CreateInteractiveStoryRequest(
        canvas_id="default", base_revision=0,
        idempotency_key="identity-create-01", story=story,
    ))


def _save_manual_canvas(service: InteractiveStoryService, canvas: dict) -> None:
    revision = canvas["revision"]
    canvas["revision"] = revision + 1
    canvas_store.save_canvas(
        service.project_dir, "default", base_revision=revision,
        build_payload=lambda _: canvas,
    )


@pytest.fixture
def service(tmp_path: Path) -> InteractiveStoryService:
    return InteractiveStoryService(tmp_path / "state", project_id="p", actor_id="author")


@pytest.fixture
def long_manual_story(service: InteractiveStoryService):
    story = _story(
        "12345678-1234-1234-1234-123456789abc",
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    )
    _create(service, story)
    projection = project_story_to_canvas(story)
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    source = story_segment_node_id(story.story_id, story.start_segment_id)
    target = story_segment_node_id(story.story_id, story.segments[1].id)
    # Match addStoryChoiceEdge: order is the only difference, at the end of 183 chars.
    canvas["edges"] = [{
        "id": f"story-{source}-{target}-{order}",
        "type": "storyChoiceEdge", "source": source, "target": target,
        "sourceHandle": "source", "targetHandle": "target",
        "data": {"choiceText": f"Option {order}", "order": order, "customMarker": f"keep-{order}"},
    } for order in (0, 1)]
    assert len(canvas["edges"][0]["id"]) == 183
    assert canvas["edges"][0]["id"][:128] == canvas["edges"][1]["id"][:128]
    _save_manual_canvas(service, canvas)
    return story, projection.group_id, canvas["edges"]


def test_domain_id_preserves_valid_ids_and_hashes_full_long_ids():
    assert _domain_id("a" * 128, fallback="unused", prefix="choice") == "a" * 128
    common = "a" * 128
    first = _domain_id(None, fallback=common + "0", prefix="choice")
    second = _domain_id(None, fallback=common + "1", prefix="choice")
    assert first != second
    assert len(first) <= 128
    assert _domain_id(common + "0", fallback="unused", prefix="choice") == first
    assert _domain_id(None, fallback=common + "0", prefix="choice") == first


@pytest.mark.parametrize("candidate", ["a/b", "中文", "", "_leading"])
def test_domain_id_normalizes_invalid_ids_to_contract_values(candidate):
    value = _domain_id(candidate, fallback=candidate, prefix="segment")
    story = _story("normalized", start=value)
    assert story.start_segment_id == value


def test_long_manual_choices_support_get_validate_and_patch_without_replacing_edges(
    service: InteractiveStoryService, long_manual_story,
):
    story, _, edges = long_manual_story
    request = GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    read = service.get(request)
    ids = [choice.id for choice in read.story.choices]
    assert len(set(ids)) == 2
    assert [choice.id for choice in service.get(request).story.choices] == ids
    assert service.validate(ValidateInteractiveStoryRequest(
        canvas_id="default", story_id=story.story_id,
    )).valid
    before = canvas_store.read_canvas(service.project_dir, "default")
    patch = StoryPatchV2.model_validate({
        "canvas_id": "default", "story_id": story.story_id, "base_revision": 2,
        "idempotency_key": "long-identity-patch-01",
        "operations": [
            {"op": "update_story_metadata", "changes": {"title": "Updated title"}},
            {"op": "update_choice", "choice_id": ids[1], "changes": {"text": "Updated option"}},
        ],
    })
    result = service.patch(patch)
    assert result.revision == 3
    saved = canvas_store.read_canvas(service.project_dir, "default")
    assert [edge["id"] for edge in saved["edges"]] == [edge["id"] for edge in edges]
    assert [edge["data"]["customMarker"] for edge in saved["edges"]] == ["keep-0", "keep-1"]
    assert [edge["data"]["storyChoiceId"] for edge in saved["edges"]] == ids
    assert [node["id"] for node in saved["nodes"]] == [node["id"] for node in before["nodes"]]
    after = service.get(request)
    assert [choice.id for choice in after.story.choices] == ids
    assert after.story.choices[1].text == "Updated option"
    assert service.patch(patch).idempotent
    assert canvas_store.read_canvas(service.project_dir, "default") == saved


def test_long_manual_choices_can_be_published(
    service: InteractiveStoryService, long_manual_story, tmp_path: Path,
):
    _, group_id, edges = long_manual_story
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    output = tmp_path / "output"
    output.mkdir()
    (output / "clip.mp4").write_bytes(b"fixture media")
    for node in canvas["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["videoUrl"] = "/api/v1/projects/p/media/clip.mp4"
    _save_manual_canvas(service, canvas)
    store = PublicationStore(tmp_path / "publications", output_dir=output)
    prepared = store.prepare("author", service.project_dir, output, "p", {
        "canvas_id": "default", "group_id": group_id, "revision": 3,
        "request_id": "long-id-publication", "title": "Long ID publication", "cover": None,
    })
    store.finish(prepared)
    release = store.version(prepared["public_id"], prepared["version"])
    assert release["status"] == "ready", release
    store.activate(prepared["public_id"], "author", prepared["version"], True)
    assert [edge["id"] for edge in store.public(prepared["public_id"])["snapshot"]["edges"]] == [edge["id"] for edge in edges]


@pytest.mark.parametrize("entity", ["node", "edge"])
def test_patch_rejects_collisions_atomically_and_can_retry_after_resolution(
    service: InteractiveStoryService, entity: str,
):
    story = _story("s")
    _create(service, story)
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    start = story_segment_node_id("s", "start")
    if entity == "node":
        collision = story_segment_node_id("s", "new")
        canvas["nodes"].append({
            "id": collision, "type": "imageGenNode", "position": {"x": 10, "y": 20},
            "data": {"customMarker": "unrelated image"},
        })
        operations = [{"op": "add_segment", "segment": {
            "id": "new", "title": "New ending", "script": "New ending",
            "kind": "ending", "ending_label": "NEW",
        }}]
    else:
        collision = story_choice_edge_id("s", "new")
        canvas["nodes"].append({
            "id": "image", "type": "imageGenNode", "position": {"x": 10, "y": 20}, "data": {},
        })
        canvas["edges"].append({
            "id": collision, "source": "image", "target": start,
            "data": {"customMarker": "unrelated reference"},
        })
        operations = [{"op": "add_choice", "choice": {
            "id": "new", "source_segment_id": "start", "target_segment_id": "end",
            "text": "Another option", "order": 1,
        }}]
    _save_manual_canvas(service, canvas)
    patch = StoryPatchV2.model_validate({
        "canvas_id": "default", "story_id": "s", "base_revision": 2,
        "idempotency_key": "collision-patch-01", "operations": operations,
    })
    path = canvas_store.canvas_path(service.project_dir, "default")
    before = path.read_bytes()
    for _ in range(2):
        with pytest.raises(InteractiveStoryServiceError) as caught:
            service.patch(patch)
        assert caught.value.code == "story_id_conflict"
        assert collision in str(caught.value)
        assert path.read_bytes() == before
        assert canvas_store.find_idempotency_entry(service.project_dir, "default", patch.idempotency_key) is None

    resolved = copy.deepcopy(canvas)
    collection = resolved["nodes"] if entity == "node" else resolved["edges"]
    for item in collection:
        if item["id"] == collision:
            item["id"] = "unrelated-renamed"
    _save_manual_canvas(service, resolved)
    retry = patch.model_copy(update={"base_revision": 3})
    result = service.patch(retry)
    assert result.revision == 4
    saved = canvas_store.read_canvas(service.project_dir, "default")
    for field in ("nodes", "edges"):
        ids = [item["id"] for item in saved[field]]
        assert len(ids) == len(set(ids))
    assert any(item["id"] == "unrelated-renamed" for item in saved["nodes"] + saved["edges"])
    assert service.patch(retry).idempotent


@pytest.mark.parametrize("segment_id", ["开场", "a" * 129, " start "])
def test_title_patch_preserves_nodes_and_references_after_segment_id_normalization(
    service: InteractiveStoryService, segment_id: str,
):
    story = _story("normalized-segments")
    _create(service, story)
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    start = next(n for n in canvas["nodes"] if n.get("data", {}).get("storySegmentId") == "start")
    original_id = start["id"]
    start["position"] = {"x": 1234, "y": 678}
    start["width"], start["height"] = 900, 450
    start["data"].update({
        "storySegmentId": segment_id,
        "customMarker": {"nested": ["keep"]},
        "videoUrl": "/api/v1/projects/p/media/start.mp4",
        "storyMedia": {"source": "imported", "status": "ready", "version": 3,
                       "url": "/api/v1/projects/p/media/start.mp4"},
    })
    canvas["edges"][0]["data"]["condition"] = {"visitedNodeId": original_id, "op": ">=", "value": 1}
    references = [
        {"id": "reference-image", "type": "imageGenNode", "position": {"x": 0, "y": 0},
         "data": {"customMarker": "reference"}},
        {"id": "external-output", "type": "textAnnotationNode", "position": {"x": 0, "y": 0},
         "data": {"content": "Keep output"}},
    ]
    reference_edges = [
        {"id": "incoming-reference", "source": "reference-image", "target": original_id,
         "data": {"link_type": "media_input_for"}},
        {"id": "outgoing-reference", "source": original_id, "target": "external-output"},
    ]
    canvas["nodes"].extend(references)
    canvas["edges"].extend(reference_edges)
    _save_manual_canvas(service, canvas)
    before = copy.deepcopy(canvas)
    request = GetInteractiveStoryRequest(canvas_id="default", story_id=story.story_id)
    read = service.get(request)
    normalized_id = read.story.start_segment_id
    assert normalized_id == _domain_id(segment_id, fallback=original_id, prefix="segment")
    patch = StoryPatchV2.model_validate({
        "canvas_id": "default", "story_id": story.story_id, "base_revision": 2,
        "idempotency_key": "normalized-segment-title-patch",
        "operations": [{"op": "update_story_metadata", "changes": {"title": "Updated title"}}],
    })
    assert service.patch(patch).revision == 3
    saved = canvas_store.read_canvas(service.project_dir, "default")
    assert {n["id"] for n in saved["nodes"]} == {n["id"] for n in before["nodes"]}
    retained = next(n for n in saved["nodes"] if n["id"] == original_id)
    assert retained["data"]["storySegmentId"] == normalized_id
    assert retained["position"] == start["position"]
    assert (retained["width"], retained["height"]) == (900, 450)
    assert retained["data"]["customMarker"] == start["data"]["customMarker"]
    assert retained["data"]["videoUrl"] == start["data"]["videoUrl"]
    assert retained["data"]["storyMedia"] == start["data"]["storyMedia"]
    assert all(node in saved["nodes"] for node in references)
    assert all(edge in saved["edges"] for edge in reference_edges)
    assert {(e["id"], e["source"], e["target"]) for e in saved["edges"]} == {
        (e["id"], e["source"], e["target"]) for e in before["edges"]
    }
    reread = service.get(request)
    assert reread.story.start_segment_id == normalized_id
    assert reread.story.title == "Updated title"
    assert reread.story.choices == read.story.choices
    assert service.patch(patch).idempotent
    assert canvas_store.read_canvas(service.project_dir, "default") == saved
