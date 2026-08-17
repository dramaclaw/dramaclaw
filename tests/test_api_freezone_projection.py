from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def projection_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=str(project_dir),
        state_dir=str(project_dir),
        runtime_dir=str(project_dir / "_runtime"),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "_append_canvas_event", lambda **_kwargs: None)

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), project_dir


def _project(client: TestClient, canvas_id: str, **body) -> tuple[int, dict]:
    response = client.post(
        f"/api/v1/projects/proj_demo/freezone/canvases/{canvas_id}/projections:from-preset",
        json={
            "scope": "blank",
            "projection_key": "blank:user",
            "base_revision": 0,
            **body,
        },
    )
    return response.status_code, response.json()


def _build_projection(client: TestClient, **body) -> tuple[int, dict]:
    response = client.post(
        "/api/v1/projects/proj_demo/freezone/projections:build-from-preset",
        json={
            "scope": "blank",
            "projection_key": "blank:user",
            "base_revision": 0,
            **body,
        },
    )
    return response.status_code, response.json()


def test_projection_creates_target_canvas(projection_client) -> None:
    client, project_dir = projection_client

    status, body = _project(client, "user_alice_abc123")

    assert status == 200, body
    assert body["data"]["canvas_id"] == "user_alice_abc123"
    assert body["data"]["projection_key"] == "blank:user"
    assert body["data"]["revision"] == 1
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert "preset" not in payload["metadata"]
    assert payload["metadata"]["projections"]["blank:user"]["facts_signature"]
    assert payload["metadata"]["last_projection_key"] == "blank:user"


def test_build_projection_from_preset_does_not_write_canvas(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "beat_ctx",
                    "type": "beatContextNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _build_projection(
        client,
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )

    assert status == 200, body
    data = body["data"]
    assert data["projection_key"] == "beat:1:4"
    assert data["facts_signature"]
    group = next(node for node in data["nodes"] if node["type"] == "groupNode")
    assert group["id"] == freezone._projection_group_id("beat:1:4")
    assert data["metadata"]["projections"]["beat:1:4"]["facts_signature"]
    projection = data["metadata"]["projections"]["beat:1:4"]
    assert projection["request"] == {
        "scope": "beat",
        "episode": 1,
        "beat": 4,
        "primary_slot": "render",
        "projection_key": "beat:1:4",
    }
    assert "force_refresh" not in projection["request"]
    assert not (project_dir / "freezone" / "canvases").exists()


def test_projection_scene_asset_includes_derived_base_master_input(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    base_master_path = project_dir / "assets" / "scenes" / "城市街道" / "master.png"
    base_master_path.parent.mkdir(parents=True)
    base_master_path.write_bytes(b"fake image")

    class Store:
        async def get_scene(self, scene_id: str):
            scenes = {
                "城市街道": {
                    "scene_id": "城市街道",
                    "name": "城市街道",
                    "scene_type": "exterior",
                    "environment_prompt": "正面：霓虹店铺和公交站",
                },
                "城市街道_雨夜版": {
                    "scene_id": "城市街道_雨夜版",
                    "name": "城市街道_雨夜版",
                    "scene_type": "exterior",
                    "base_scene_id": "城市街道",
                    "variant_id": "雨夜版",
                    "variant_prompt": "路面积水反射霓虹，雨幕明显",
                },
            }
            return scenes.get(scene_id)

        async def close(self):
            return None

    async def fake_make_sqlite_store_for_context(_ctx):
        return Store()

    monkeypatch.setattr(
        freezone,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="asset",
        asset_kind="scene",
        asset_id="城市街道_雨夜版",
        projection_key="scene:城市街道_雨夜版",
    )

    assert status == 200, body
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    base_nodes = [
        node
        for node in payload["nodes"]
        if node.get("data", {}).get("displayName") == "城市街道 base master"
    ]
    assert len(base_nodes) == 1
    groups = {node["id"]: node for node in payload["nodes"] if node["type"] == "groupNode"}
    assert base_nodes[0].get("parentId") in groups
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    assert (base_nodes[0]["id"], "ref_scene_master_1") in edges


def test_projection_group_id_is_unique_per_non_ascii_asset() -> None:
    """一个人物一个主线投影组。

    组 id 由 projection_key 清洗而来，中文角色名被 ``[^A-Za-z0-9]`` 全部换成 ``_``、
    再 strip 掉，两个角色都塌成 ``projection_group_asset_character``——第二个角色
    进虾画时组名被换、两个角色的节点挤进同一个组。
    """
    from novelvideo.api.routes import freezone

    lin = freezone._projection_group_id("asset:character:林小满")
    gu = freezone._projection_group_id("asset:character:顾南城")
    assert lin != gu
    # 组 id 就是节点 id，跨请求必须稳定，否则每次投影都长出一个新组。
    assert lin == freezone._projection_group_id("asset:character:林小满")
    # ASCII / beat / episode 这些原本就不会撞的 key 仍要各自唯一。
    assert freezone._projection_group_id("beat:1:4") != freezone._projection_group_id(
        "beat:1:6"
    )


def test_projection_group_encloses_nodes_without_explicit_size() -> None:
    """组框必须包住成员的**真实**渲染尺寸。

    preset 产出的节点大多不带显式 width/height（`_text_node` / `_upload_node`），
    带尺寸的（`_skill_node` / `_beat_context_node`）也只写在 `measured` 里。按统一
    的 320x180 估算会严重低估这些节点，算出的组框包不住成员——成员带
    `extent: "parent"`，React Flow 会把它们夹回小框内叠成一堆（用户可见症状）。
    """
    from novelvideo.api.routes import freezone

    projection_key = "asset:character:林小满"
    nodes = [
        # _text_node：无 width/height/style，前端实际渲染 440x320
        {
            "id": "character_profile",
            "type": "textAnnotationNode",
            "position": {"x": -1040, "y": -560},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
        # _upload_node：无尺寸，前端实际渲染 320x350
        {
            "id": "portrait_ref",
            "type": "uploadNode",
            "position": {"x": -560, "y": -220},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
        # _skill_node：尺寸只写在 measured 里
        {
            "id": "skill_portrait",
            "type": "skillNode",
            "position": {"x": -100, "y": -220},
            "measured": {"width": 380, "height": 520},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
    ]
    expected_sizes = {
        "character_profile": (440, 320),
        "portrait_ref": (320, 350),
        "skill_portrait": (380, 520),
    }

    payload = freezone._wrap_projection_payload_in_group(
        {"nodes": [dict(node) for node in nodes], "edges": []},
        projection_key=projection_key,
        label="林小满",
    )
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    group_width = group["style"]["width"]
    group_height = group["style"]["height"]

    for child in payload["nodes"]:
        if child["type"] == "groupNode":
            continue
        width, height = expected_sizes[child["id"]]
        assert child["position"]["x"] >= 0, child["id"]
        assert child["position"]["y"] >= 0, child["id"]
        assert child["position"]["x"] + width <= group_width, child["id"]
        assert child["position"]["y"] + height <= group_height, child["id"]


def test_projection_wraps_preset_nodes_in_group(projection_client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "beat_ctx",
                    "type": "beatContextNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
                {
                    "id": "skill_node",
                    "type": "skillNode",
                    "position": {"x": 440, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )

    assert status == 200, body
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    assert group["id"] == freezone._projection_group_id("beat:1:4")
    assert group["data"]["displayName"] == "EP1/B4"
    children = [node for node in payload["nodes"] if node.get("parentId") == group["id"]]
    assert {node["id"] for node in children} == {"beat_ctx", "skill_node"}
    assert all(node.get("extent") == "parent" for node in children)


def test_projection_same_facts_noops_before_revision_check(projection_client) -> None:
    client, project_dir = projection_client

    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body
    status, body = _project(client, "user_alice_abc123", base_revision=1)
    assert status == 200, body
    assert body["data"]["no_op"] is True
    assert body["data"]["revision"] == 1

    # A stale replay should also short-circuit before revision checking because
    # the projection facts are unchanged.
    status, body = _project(client, "user_alice_abc123", base_revision=0)

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    history_dir = canvas_file.parent / "_history"
    history_entries = sorted(history_dir.glob("user_alice_abc123.rev*.json"))

    assert status == 200, body
    assert payload["revision"] == 1
    assert history_entries == []


def test_projection_changed_facts_bypass_idempotency_cache(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "old scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body
    assert body["data"]["revision"] == 1

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=1,
    )
    assert status == 200, body
    assert body["data"]["no_op"] is True
    assert body["data"]["revision"] == 1

    scene_prompt["value"] = "new scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=1,
    )

    assert status == 200, body
    assert body["data"]["no_op"] is False
    assert body["data"]["revision"] == 2
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "new scene prompt"


def test_projection_force_refresh_rewrites_dirty_projection_nodes(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "data": {
                        "preset_managed": True,
                        "content": "mainline scene prompt",
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    node["data"]["content"] = "dirty local edit"
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
    )
    assert status == 200, body
    assert body["data"]["no_op"] is True
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "dirty local edit"

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["no_op"] is False
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "mainline scene prompt"
    projection = payload["metadata"]["projections"]["beat:1:4"]
    assert "force_refresh" not in projection["request"]


def test_projection_force_refresh_preserves_existing_group_position(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "mainline scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 320, "height": 180},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    group["position"] = {"x": 840, "y": 360}
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    scene_prompt["value"] = "updated mainline scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    assert group["position"] == {"x": 840, "y": 360}
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "updated mainline scene prompt"


def test_projection_force_refresh_preserves_existing_node_layout(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "mainline scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 320, "height": 180},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    node["position"] = {"x": 444, "y": 222}
    node["style"] = {"width": 520, "height": 260}
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    scene_prompt["value"] = "updated mainline scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["position"] == {"x": 444, "y": 222}
    assert node["style"] == {"width": 520, "height": 260}
    assert node["data"]["content"] == "updated mainline scene prompt"


def test_projection_status_reports_stale_when_mainline_facts_changed(projection_client) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:status",
        json={"projection_keys": ["blank:user"]},
    )
    assert response.status_code == 200, response.json()
    item = response.json()["data"]["projections"][0]
    assert item["projection_key"] == "blank:user"
    assert item["stale"] is False

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["metadata"]["projections"]["blank:user"]["facts_signature"] = "old"
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:status",
        json={"projection_keys": ["blank:user"]},
    )

    assert response.status_code == 200, response.json()
    item = response.json()["data"]["projections"][0]
    assert item["projection_key"] == "blank:user"
    assert item["stored_facts_signature"] == "old"
    assert item["current_facts_signature"]
    assert item["stale"] is True


def test_projection_remove_deletes_projection_without_touching_user_nodes(projection_client) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["nodes"].append(
        {
            "id": "user_note",
            "type": "textAnnotation",
            "position": {"x": 10, "y": 10},
            "data": {"user_spawned": True},
        }
    )
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 2},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["projection_key"] == "blank:user"
    assert response.json()["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert "blank:user" not in payload["metadata"]["projections"]
    node_ids = {node["id"] for node in payload["nodes"]}
    assert "user_note" in node_ids


def test_projection_remove_allows_empty_canvas_when_only_projection_nodes_remain(
    projection_client,
) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["nodes"] = [
        {
            "id": "projected_context",
            "type": "beatContext",
            "position": {"x": 0, "y": 0},
            "data": {
                "preset_managed": True,
                "projection_key": "blank:user",
            },
        }
    ]
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 2},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["projection_key"] == "blank:user"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert payload["nodes"] == []
    assert payload["edges"] == []
    assert "blank:user" not in payload["metadata"]["projections"]


def test_projection_remove_missing_canvas_returns_404(projection_client) -> None:
    client, _project_dir = projection_client

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/missing_canvas/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 1},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "canvas not found"


def _projection_payload_with_group() -> dict:
    """一个投影：一个组节点 + 两个归位的成员。"""
    return {
        "nodes": [
            {
                "id": "scoped__projection_group_asset_character_abc",
                "type": "groupNode",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:林小满",
                    "label": "林小满",
                },
            },
            {
                "id": "scoped__ref_identity_costume_1",
                "type": "imageGenNode",
                "parentId": "scoped__projection_group_asset_character_abc",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:林小满",
                },
            },
            {
                "id": "scoped__character_profile",
                "type": "textAnnotationNode",
                "parentId": "scoped__projection_group_asset_character_abc",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:林小满",
                },
            },
        ]
    }


def test_projection_is_intact_when_every_member_sits_in_its_own_group() -> None:
    from novelvideo.api.routes import freezone

    assert (
        freezone._projection_is_intact_in_payload(
            _projection_payload_with_group(), "asset:character:林小满"
        )
        is True
    )


def test_projection_is_broken_when_members_lost_their_group() -> None:
    """组没了、成员散落在画布上——facts 没变也必须重建，否则永远修不回来。"""
    from novelvideo.api.routes import freezone

    payload = _projection_payload_with_group()
    payload["nodes"] = [
        node for node in payload["nodes"] if node.get("type") != "groupNode"
    ]
    for node in payload["nodes"]:
        node.pop("parentId", None)

    assert (
        freezone._projection_is_intact_in_payload(payload, "asset:character:林小满")
        is False
    )


def test_projection_is_broken_when_members_hang_under_another_characters_group() -> None:
    """id 撞车的历史遗留：成员的 parent 是别人的组。"""
    from novelvideo.api.routes import freezone

    payload = _projection_payload_with_group()
    payload["nodes"][0]["data"]["projection_key"] = "asset:character:顾南城"

    assert (
        freezone._projection_is_intact_in_payload(payload, "asset:character:林小满")
        is False
    )


def test_projection_with_no_members_is_not_reported_broken() -> None:
    from novelvideo.api.routes import freezone

    assert freezone._projection_is_intact_in_payload({"nodes": []}, "blank:user") is True
    assert freezone._projection_is_intact_in_payload(None, "blank:user") is True


def test_projection_refresh_rebuilds_group_when_facts_unchanged(
    projection_client,
    monkeypatch,
) -> None:
    """facts 没变但组丢了：不能 noop,得把成员重新收回组里。

    组丢失是历史 id 撞车 / 命名空间迁移的残局。上游事实没变,只看 facts_signature
    的话 refresh 会一路 noop,散落的成员永远回不到组里。
    """
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "ref_identity_costume_1",
                    "type": "imageGenNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
                {
                    "id": "character_profile",
                    "type": "textAnnotationNode",
                    "position": {"x": 420, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert any(node.get("type") == "groupNode" for node in payload["nodes"])
    revision = payload["revision"]

    # 模拟命名空间迁移后的残局：组没了,成员变成散落节点。
    payload["nodes"] = [
        {key: value for key, value in node.items() if key not in {"parentId", "extent"}}
        for node in payload["nodes"]
        if node.get("type") != "groupNode"
    ]
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    status, body = _project(client, "user_alice_abc123", base_revision=revision)
    assert status == 200, body
    assert body["data"].get("noop_reason") != "projection_facts_unchanged"

    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    groups = [
        node
        for node in payload["nodes"]
        if node.get("type") == "groupNode"
        and (node.get("data") or {}).get("projection_key") == "blank:user"
    ]
    assert len(groups) == 1
    members = [
        node
        for node in payload["nodes"]
        if node.get("type") != "groupNode"
        and (node.get("data") or {}).get("projection_key") == "blank:user"
    ]
    assert members
    assert all(node.get("parentId") == groups[0]["id"] for node in members)
