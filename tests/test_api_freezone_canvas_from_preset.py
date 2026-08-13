"""Route-level tests for ``POST /freezone/canvases:from-preset``.

The focus here is the idempotency contract from plan §10: a replayed preset
request (network retry, double-click, etc.) must not produce duplicate
history snapshots or revision bumps.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.freezone.presets import canvas_id_for_preset


@pytest.fixture()
def preset_client(monkeypatch, tmp_path):
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

    async def fake_resolve(
        project: str,
        user: dict,
        *,
        required_role: str = "editor",
        require_home_node: bool = True,
    ):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    # Event append touches additional state we don't care about here; the
    # preset endpoint calls it after every success and conflict, so a stub
    # keeps the test focused on the canvas file itself.
    monkeypatch.setattr(freezone, "_append_canvas_event", lambda **_kwargs: None)

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), project_dir


def _from_preset(client: TestClient, **body) -> tuple[int, dict]:
    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases:from-preset",
        json={"scope": "blank", **body},
    )
    return response.status_code, response.json()


def test_from_preset_blank_replay_is_idempotent(preset_client) -> None:
    """Replayed preset refreshes must not bump revision when facts are unchanged.

    Scenario: user clicks "regenerate from preset" twice in quick succession
    with ``overwrite_existing=True`` and the same ``base_revision``. If the
    preset-managed facts did not change, the refresh should short-circuit before
    the revision check and should not create history churn.
    """

    client, project_dir = preset_client

    def revision_on_disk(cid: str) -> int:
        canvas_file = project_dir / "freezone" / "canvases" / f"{cid}.json"
        return json.loads(canvas_file.read_text(encoding="utf-8"))["revision"]

    # First create — seeds the canvas at revision 1.
    status, body = _from_preset(client)
    assert status == 200, body
    canvas_id = body["data"]["canvas_id"]
    assert revision_on_disk(canvas_id) == 1

    # Second call — overwrite the same canvas with base_revision=1.
    status, body = _from_preset(
        client, overwrite_existing=True, canvas_id=canvas_id, base_revision=1
    )
    assert status == 200, body
    assert revision_on_disk(canvas_id) == 1

    # Replay of the same call — also a no-op because facts are unchanged.
    status, body = _from_preset(
        client, overwrite_existing=True, canvas_id=canvas_id, base_revision=1
    )

    canvas_file = project_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    history_dir = canvas_file.parent / "_history"
    history_entries = sorted(history_dir.glob(f"{canvas_id}.rev*.json"))

    assert status == 200, (
        f"replayed preset request returned {status} — unchanged facts should "
        f"short-circuit instead of revision_conflict (409). Body: {body}"
    )
    assert revision_on_disk(canvas_id) == 1, (
        f"canvas file is at revision={revision_on_disk(canvas_id)} after "
        "replay — unchanged facts must not write a new revision on disk"
    )
    assert len(history_entries) == 0, (
        f"found {len(history_entries)} history snapshots after replay, "
        f"expected none for no-op refreshes; entries: {[p.name for p in history_entries]}"
    )


def test_from_preset_prefers_canonical_canvas_over_newer_legacy_match(
    preset_client,
) -> None:
    client, project_dir = preset_client
    canvases_dir = project_dir / "freezone" / "canvases"
    canvases_dir.mkdir(parents=True, exist_ok=True)
    canonical = canvas_id_for_preset("blank")
    legacy = f"{canonical}_20260603_120000"[:64]
    for canvas_id, revision, mtime in (
        (canonical, 1, 100),
        (legacy, 9, 300),
    ):
        canvas_file = canvases_dir / f"{canvas_id}.json"
        canvas_file.write_text(
            json.dumps({
                "schema_version": 2,
                "canvas_id": canvas_id,
                "project_id": "proj_demo",
                "revision": revision,
                "nodes": [],
                "edges": [],
                "metadata": {"preset": {"preset_key": "blank", "scope": "blank"}},
            }),
            encoding="utf-8",
        )
        canvas_file.touch()
        os.utime(canvas_file, (mtime, mtime))

    status, body = _from_preset(client)

    assert status == 200, body
    assert body["data"]["canvas_id"] == canonical
    assert body["data"]["reused"] is True


def test_from_preset_scene_asset_includes_derived_base_master_input(
    preset_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = preset_client
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

    status, body = _from_preset(
        client,
        scope="asset",
        asset_kind="scene",
        asset_id="城市街道_雨夜版",
    )

    assert status == 200, body
    canvas_file = (
        project_dir / "freezone" / "canvases" / f"{body['data']['canvas_id']}.json"
    )
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    base_nodes = [
        node
        for node in payload["nodes"]
        if node.get("data", {}).get("displayName") == "城市街道 base master"
    ]
    assert len(base_nodes) == 1
    assert base_nodes[0]["data"]["imageUrl"]
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    assert (base_nodes[0]["id"], "ref_scene_master_1") in edges
