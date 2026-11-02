"""Story frames should consume the exact reference images planned for their clip."""


import pytest

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_story_targets import prepare_story_frame_references


def _plan():
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "text-to-image-video"},
        "source_context": {"story_id": "story-1", "targets": [
            {"plan_node_id": "frame-opening", "story_segment_id": "opening", "video_node_id": "video-opening"},
            {"plan_node_id": "frame-ending", "story_segment_id": "ending", "video_node_id": "video-ending"},
        ]},
        "nodes": [
            {"id": "brief", "node_type": "textAnnotationNode", "stage": "input", "data": {"content": "visual brief"}},
            *({"id": f"frame-{segment}", "node_type": "imageGenNode", "stage": "image", "data": {"prompt": segment}}
              for segment in ("opening", "ending")),
        ],
        "edges": [
            {"source": "brief", "target": f"frame-{segment}", "link_type": "prompt_for"}
            for segment in ("opening", "ending")
        ],
    }


def _asset(node_id, kind, entity_id, segment_ids, *, url=None, story_id="story-1"):
    return {"id": node_id, "type": "imageGenNode", "data": {
        "imageUrl": url if url is not None else f"/static/projects/project-1/{node_id}.png",
        "storyAssetTarget": {"storyId": story_id, "kind": kind, "entityId": entity_id, "segmentIds": segment_ids},
    }}


def _canvas():
    return {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {"storyGroup": True, "interactiveStoryId": "story-1"}},
        {"id": "video-opening", "type": "videoNode", "parentId": "story-group", "data": {
            "storySegmentId": "opening", "storyCharacterIds": ["hero", "product"], "storySceneRefs": [{"scene_id": "office"}],
        }},
        {"id": "video-ending", "type": "videoNode", "parentId": "story-group", "data": {
            "storySegmentId": "ending", "storyCharacterIds": ["hero"], "storySceneRefs": [],
        }},
        _asset("hero-image", "subject", "hero", ["opening", "ending"]),
        _asset("product-image", "subject", "product", ["opening"]),
        _asset("office-image", "scene", "office", ["opening"]),
        _asset("other-story", "subject", "hero", ["opening", "ending"], story_id="story-2"),
    ]}


def _reference_pairs(plan):
    sources = {item["id"]: item["node_id"] for item in plan.get("external_inputs", [])}
    return {(sources[edge["source"]], edge["target"]) for edge in plan["edges"]
            if edge.get("link_type") == "media_input_for" and edge["source"] in sources}


def test_story_frames_attach_only_their_declared_assets_and_compile_real_edges():
    original = _plan()
    plan = prepare_story_frame_references(original, _canvas())
    expected = {
        ("hero-image", "frame-opening"), ("product-image", "frame-opening"),
        ("office-image", "frame-opening"), ("hero-image", "frame-ending"),
    }
    assert _reference_pairs(plan) == expected
    assert original == _plan()  # Draft preparation does not mutate caller input.
    assert prepare_story_frame_references(plan, _canvas()) == plan  # Revalidation is idempotent.

    graph = build_workflow_graph_commands({"plan": plan})
    assert graph["ok"], graph
    assert {(c["source"], c["target"]) for c in graph["commands"]
            if c["type"] == "create_edge" and c.get("link_type") == "media_input_for"} == expected
    frames = {c["data"]["workflowPlanNodeId"]: c["data"]["storyFrameTarget"]["referenceNodeIds"]
              for c in graph["commands"] if c["type"] == "create_node" and c.get("node_type") == "imageGenNode"}
    assert set(frames["frame-opening"]) == {"hero-image", "product-image", "office-image"}
    assert frames["frame-ending"] == ["hero-image"]


def test_ambiguous_reference_requires_selection_and_explicit_input_resolves_it():
    canvas = _canvas()
    canvas["nodes"].append(_asset("hero-alt", "subject", "hero", ["opening", "ending"]))
    with pytest.raises(ValueError, match="hero"):
        prepare_story_frame_references(_plan(), canvas)

    plan = _plan()
    plan["external_inputs"] = [{"id": "chosen-hero", "node_id": "hero-alt", "media_kind": "image"}]
    plan["edges"].extend({"source": "chosen-hero", "target": f"frame-{segment}", "link_type": "media_input_for"}
                         for segment in ("opening", "ending"))
    prepared = prepare_story_frame_references(plan, canvas)
    assert ("hero-alt", "frame-opening") in _reference_pairs(prepared)
    assert ("hero-alt", "frame-ending") in _reference_pairs(prepared)
    assert not any(node_id == "hero-image" for node_id, _ in _reference_pairs(prepared))
    assert sum(item["node_id"] == "hero-alt" for item in prepared["external_inputs"]) == 1


def test_unfinished_mapped_reference_is_reported_instead_of_silently_generating():
    canvas = _canvas()
    canvas["nodes"][3]["data"]["imageUrl"] = None
    with pytest.raises(ValueError, match="hero"):
        prepare_story_frame_references(_plan(), canvas)


def test_legacy_story_without_asset_metadata_keeps_manual_inputs():
    canvas = _canvas()
    canvas["nodes"] = canvas["nodes"][:3] + [{"id": "legacy-image", "type": "uploadNode", "data": {
        "imageUrl": "/static/projects/project-1/legacy.png",
    }}]
    plan = _plan()
    plan["external_inputs"] = [{"id": "legacy", "node_id": "legacy-image", "media_kind": "image"}]
    plan["edges"].append({"source": "legacy", "target": "frame-opening", "link_type": "media_input_for"})
    assert prepare_story_frame_references(plan, canvas) == plan


def test_partial_legacy_mapping_only_adds_unambiguous_known_assets():
    canvas = _canvas()
    canvas["nodes"] = canvas["nodes"][:4]  # Product and scene have no structured asset metadata.
    prepared = prepare_story_frame_references(_plan(), canvas)
    assert _reference_pairs(prepared) == {("hero-image", "frame-opening"), ("hero-image", "frame-ending")}


def test_explicit_exclusion_omits_only_the_selected_asset_for_one_frame():
    plan = _plan()
    plan["source_context"]["story_reference_exclusions"] = [{
        "plan_node_id": "frame-opening", "kind": "subject", "entity_id": "hero",
    }]
    prepared = prepare_story_frame_references(plan, _canvas())
    assert ("hero-image", "frame-opening") not in _reference_pairs(prepared)
    assert ("hero-image", "frame-ending") in _reference_pairs(prepared)
    assert ("product-image", "frame-opening") in _reference_pairs(prepared)


def test_asset_with_no_segment_mapping_is_not_guessed():
    canvas = _canvas()
    canvas["nodes"][3]["data"]["storyAssetTarget"]["segmentIds"] = ["opening"]
    prepared = prepare_story_frame_references(_plan(), canvas)
    assert ("hero-image", "frame-opening") in _reference_pairs(prepared)
    assert ("hero-image", "frame-ending") not in _reference_pairs(prepared)


def test_generated_references_preserve_existing_reference_order_and_are_idempotent():
    canvas = _canvas()
    canvas["nodes"].append({"id": "manual-image", "type": "uploadNode", "data": {
        "imageUrl": "/static/projects/project-1/manual.png",
    }})
    plan = _plan()
    plan["external_inputs"] = [{"id": "manual", "node_id": "manual-image", "media_kind": "image"}]
    plan["edges"].append({"source": "manual", "target": "frame-opening", "link_type": "media_input_for"})
    prepared = prepare_story_frame_references(plan, canvas)
    sources = {item["id"]: item["node_id"] for item in prepared["external_inputs"]}
    opening = [sources[e["source"]] for e in prepared["edges"]
               if e.get("link_type") == "media_input_for" and e["target"] == "frame-opening"]
    assert opening[0] == "manual-image"
    assert set(opening) == {"manual-image", "hero-image", "product-image", "office-image"}
    assert prepare_story_frame_references(prepared, canvas) == prepared


def test_reference_image_url_is_not_a_generated_asset():
    canvas = _canvas()
    canvas["nodes"][3]["data"].update(imageUrl=None, referenceImageUrl="/static/projects/project-1/source.png")
    with pytest.raises(ValueError, match="hero"):
        prepare_story_frame_references(_plan(), canvas)


@pytest.mark.parametrize("exclusions", [
    "hero",
    [{"plan_node_id": "frame-opening", "kind": "subject", "entity_id": "typo"}],
    [{"plan_node_id": "unknown-frame", "kind": "subject", "entity_id": "hero"}],
    [{"plan_node_id": "frame-opening", "kind": "character", "entity_id": "hero"}],
    [{"plan_node_id": "frame-opening", "kind": "subject", "entity_id": "hero"}] * 2,
])
def test_invalid_reference_exclusions_do_not_silently_skip_a_required_reference(exclusions):
    plan = _plan()
    plan["source_context"]["story_reference_exclusions"] = exclusions
    with pytest.raises(ValueError, match="exclusions"):
        prepare_story_frame_references(plan, _canvas())


def test_exclusion_cannot_contradict_an_explicit_reference_edge():
    plan = _plan()
    plan["external_inputs"] = [{"id": "hero", "node_id": "hero-image", "media_kind": "image"}]
    plan["edges"].append({"source": "hero", "target": "frame-opening", "link_type": "media_input_for"})
    plan["source_context"]["story_reference_exclusions"] = [{
        "plan_node_id": "frame-opening", "kind": "subject", "entity_id": "hero",
    }]
    with pytest.raises(ValueError, match="exclu"):
        prepare_story_frame_references(plan, _canvas())


@pytest.mark.parametrize("kind", [[], {}])
def test_malformed_asset_kind_is_ignored_for_legacy_compatibility(kind):
    canvas = _canvas()
    canvas["nodes"][3]["data"]["storyAssetTarget"]["kind"] = kind
    warnings = []
    prepared = prepare_story_frame_references(_plan(), canvas, warnings=warnings)
    assert all(node != "hero-image" for node, _ in _reference_pairs(prepared))
    assert any(warning["code"] == "story_reference_unmapped" and "hero" in warning["message"]
               for warning in warnings)
    assert all(warning["message_i18n"] == {
        "code": "workflowDraftContinuation.storyReferenceItem",
        "params": {"frame": warning["frame_name"], "entity": warning["entity_name"]},
    } for warning in warnings)


@pytest.mark.parametrize("kind", [[], {}])
def test_malformed_exclusion_kind_is_rejected(kind):
    plan = _plan()
    plan["source_context"]["story_reference_exclusions"] = [{
        "plan_node_id": "frame-opening", "kind": kind, "entity_id": "hero",
    }]
    with pytest.raises(ValueError, match="exclusions"):
        prepare_story_frame_references(plan, _canvas())
