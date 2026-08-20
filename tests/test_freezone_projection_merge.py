from novelvideo.api.routes.freezone import (
    _merge_projected_preset_canvas,
    _projection_group_id,
    _remove_projected_preset_canvas,
    _wrap_projection_payload_in_group,
)


def node(node_id, *, preset=False, projection_key=None, user=False):
    data = {}
    if preset:
        data["preset_managed"] = True
    if projection_key:
        data["projection_key"] = projection_key
    if user:
        data["user_spawned"] = True
    return {"id": node_id, "type": "imageNode", "position": {"x": 0, "y": 0}, "data": data}


def edge(edge_id, source, target, *, preset=False, projection_key=None):
    data = {}
    if preset:
        data["preset_managed"] = True
    if projection_key:
        data["projection_key"] = projection_key
    return {"id": edge_id, "source": source, "target": target, "data": data}


def test_projection_payload_is_wrapped_in_draggable_group():
    payload = {
        "nodes": [
            {
                "id": "beat_ctx",
                "type": "beatContextNode",
                "position": {"x": 120, "y": 80},
                "style": {"width": 300, "height": 180},
                "data": {"preset_managed": True, "projection_key": "beat:1:4"},
            },
            {
                "id": "skill_node",
                "type": "skillNode",
                "position": {"x": 520, "y": 140},
                "width": 260,
                "height": 180,
                "data": {"preset_managed": True, "projection_key": "beat:1:4"},
            },
        ],
        "edges": [
            edge("preset_edge", "beat_ctx", "skill_node", preset=True, projection_key="beat:1:4"),
        ],
        "metadata": {},
    }

    wrapped = _wrap_projection_payload_in_group(
        payload,
        projection_key="beat:1:4",
        label="EP1/B4",
    )

    group = next(node for node in wrapped["nodes"] if node["type"] == "groupNode")
    assert group["id"] == _projection_group_id("beat:1:4")
    assert group["position"] == {"x": 100, "y": 46}
    assert group["style"]["width"] == 700
    assert group["style"]["height"] == 294
    assert group["data"]["preset_managed"] is True
    assert group["data"]["projection_key"] == "beat:1:4"
    assert group["data"]["displayName"] == "EP1/B4"

    children = {node["id"]: node for node in wrapped["nodes"] if node["id"] != group["id"]}
    assert children["beat_ctx"]["parentId"] == group["id"]
    assert children["beat_ctx"]["extent"] == "parent"
    assert children["beat_ctx"]["position"] == {"x": 20, "y": 34}
    assert children["skill_node"]["parentId"] == group["id"]
    assert children["skill_node"]["extent"] == "parent"
    assert children["skill_node"]["position"] == {"x": 420, "y": 94}


def test_projection_merge_replaces_group_without_touching_user_nodes():
    existing = {
        "nodes": [
            node("projection_group_beat_1_4", preset=True, projection_key="beat:1:4"),
            node("old_beat_ctx", preset=True, projection_key="beat:1:4"),
            node("user_edit", user=True),
        ],
        "edges": [],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "old"}}},
    }
    incoming = {
        "nodes": [
            node("projection_group_beat_1_4", preset=True, projection_key="beat:1:4"),
            node("new_beat_ctx", preset=True, projection_key="beat:1:4"),
        ],
        "edges": [],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "new"}}},
    }

    merged = _merge_projected_preset_canvas(
        incoming_payload=incoming,
        existing_payload=existing,
        projection_key="beat:1:4",
    )

    ids = [node["id"] for node in merged["nodes"]]
    assert ids.count("projection_group_beat_1_4") == 1
    assert "new_beat_ctx" in ids
    assert "old_beat_ctx" not in ids
    assert "user_edit" in ids


def test_projection_merge_replaces_only_matching_preset_nodes():
    existing = {
        "nodes": [
            node("old_beat_ctx", preset=True, projection_key="beat:1:4"),
            node("other_scene", preset=True, projection_key="scene:shop"),
            node("user_edit", user=True),
        ],
        "edges": [
            edge("old_preset_edge", "old_beat_ctx", "user_edit", preset=True, projection_key="beat:1:4"),
            edge("user_edge", "user_edit", "old_beat_ctx"),
            edge("other_edge", "other_scene", "user_edit", preset=True, projection_key="scene:shop"),
        ],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "old"}}},
    }
    incoming = {
        "nodes": [node("new_beat_ctx", preset=True, projection_key="beat:1:4")],
        "edges": [edge("new_preset_edge", "new_beat_ctx", "user_edit", preset=True, projection_key="beat:1:4")],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "new"}}},
    }

    merged = _merge_projected_preset_canvas(
        incoming_payload=incoming,
        existing_payload=existing,
        projection_key="beat:1:4",
    )

    ids = {n["id"] for n in merged["nodes"]}
    assert "new_beat_ctx" in ids
    assert "other_scene" in ids
    assert "user_edit" in ids
    assert "old_beat_ctx" in ids
    archived = next(n for n in merged["nodes"] if n["id"] == "old_beat_ctx")
    assert archived["data"]["projection_archived"] is True
    assert archived["data"].get("preset_managed") is not True
    assert archived["data"].get("user_spawned") is True
    assert archived["data"].get("projection_key") is None
    assert archived["data"].get("source_projection_key") == "beat:1:4"
    edge_ids = {e["id"] for e in merged["edges"]}
    assert "new_preset_edge" in edge_ids
    assert "old_preset_edge" not in edge_ids
    assert "user_edge" in edge_ids
    assert "other_edge" in edge_ids
    assert merged["metadata"]["projections"]["beat:1:4"]["facts_signature"] == "new"


def test_projection_merge_does_not_touch_user_spawned_node_inside_projection():
    existing = {
        "nodes": [
            node("preset_ctx", preset=True, projection_key="beat:1:4"),
            node("candidate", projection_key="beat:1:4", user=True),
        ],
        "edges": [edge("candidate_link", "preset_ctx", "candidate")],
        "metadata": {},
    }
    incoming = {
        "nodes": [node("preset_ctx", preset=True, projection_key="beat:1:4")],
        "edges": [],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "new"}}},
    }

    merged = _merge_projected_preset_canvas(
        incoming_payload=incoming,
        existing_payload=existing,
        projection_key="beat:1:4",
    )

    ids = {n["id"] for n in merged["nodes"]}
    assert "candidate" in ids
    candidate = next(n for n in merged["nodes"] if n["id"] == "candidate")
    assert candidate["data"].get("projection_key") is None
    assert candidate["data"].get("source_projection_key") == "beat:1:4"
    assert any(e["id"] == "candidate_link" for e in merged["edges"])


def test_projection_merge_preserves_user_spawned_node_even_with_stale_projection_flags():
    existing = {
        "nodes": [
            node("preset_ctx", preset=True, projection_key="beat:1:4"),
            node("candidate", preset=True, projection_key="beat:1:4", user=True),
        ],
        "edges": [],
        "metadata": {},
    }
    incoming = {
        "nodes": [node("preset_ctx", preset=True, projection_key="beat:1:4")],
        "edges": [],
        "metadata": {"projections": {"beat:1:4": {"facts_signature": "new"}}},
    }

    merged = _merge_projected_preset_canvas(
        incoming_payload=incoming,
        existing_payload=existing,
        projection_key="beat:1:4",
    )

    ids = {n["id"] for n in merged["nodes"]}
    assert "candidate" in ids
    candidate = next(n for n in merged["nodes"] if n["id"] == "candidate")
    assert candidate["data"].get("user_spawned") is True
    assert candidate["data"].get("preset_managed") is None
    assert candidate["data"].get("projection_key") is None
    assert candidate["data"].get("source_projection_key") == "beat:1:4"


def test_projection_remove_drops_matching_projection_only():
    existing = {
        "nodes": [
            node("projection_group_beat_1_4", preset=True, projection_key="beat:1:4"),
            node("beat_ctx", preset=True, projection_key="beat:1:4"),
            node("other_scene", preset=True, projection_key="scene:shop"),
            node("user_edit", user=True),
            node("candidate", projection_key="beat:1:4", user=True),
        ],
        "edges": [
            edge("beat_preset_edge", "beat_ctx", "candidate", preset=True, projection_key="beat:1:4"),
            edge("user_edge_to_projection", "user_edit", "beat_ctx"),
            edge("user_candidate_edge", "user_edit", "candidate"),
            edge("other_edge", "other_scene", "user_edit", preset=True, projection_key="scene:shop"),
        ],
        "metadata": {
            "projections": {
                "beat:1:4": {"facts_signature": "old"},
                "scene:shop": {"facts_signature": "other"},
            },
            "last_projection_key": "beat:1:4",
        },
    }

    removed = _remove_projected_preset_canvas(
        existing_payload=existing,
        projection_key="beat:1:4",
    )

    ids = {n["id"] for n in removed["nodes"]}
    assert "projection_group_beat_1_4" not in ids
    assert "beat_ctx" not in ids
    assert "candidate" in ids
    assert "user_edit" in ids
    assert "other_scene" in ids
    candidate = next(n for n in removed["nodes"] if n["id"] == "candidate")
    assert candidate["data"].get("projection_key") is None
    assert candidate["data"].get("source_projection_key") == "beat:1:4"
    edge_ids = {e["id"] for e in removed["edges"]}
    assert "beat_preset_edge" not in edge_ids
    assert "user_edge_to_projection" not in edge_ids
    assert "user_candidate_edge" in edge_ids
    assert "other_edge" in edge_ids
    assert "beat:1:4" not in removed["metadata"]["projections"]
    assert removed["metadata"]["projections"]["scene:shop"]["facts_signature"] == "other"
    assert removed["metadata"].get("last_projection_key") != "beat:1:4"
