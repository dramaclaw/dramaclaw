"""A canvas save carries media addresses; an inline data: URL in a media field is rejected."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone import canvas_store
from novelvideo.project_context import ProjectContext

USER = {"id": "user_bob", "username": "bob"}
LOCAL = "/static/projects/proj_a/freezone/_uploads/b.png"
PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_a",
        project_name="vlog",
        owner_type="user",
        owner_id="user_bob",
        owner_username="bob",
        requester_user_id="user_bob",
        requester_username="bob",
        requester_principals=(("user", "user_bob"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "proj_a",
        state_dir=tmp_path / "state" / "proj_a",
        runtime_dir=tmp_path / "runtime" / "proj_a",
        is_home_node=True,
    )


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectContext:
    project = _ctx(tmp_path)

    async def resolve(*, user, project_id=None, project_name=None, required_role="viewer"):
        if project_id != project.project_id:
            raise HTTPException(status_code=404, detail="Project not found")
        return project

    monkeypatch.setattr(freezone_routes, "resolve_project_context", resolve)
    return project


def _node(node_id: str, data: dict) -> dict:
    return {"id": node_id, "type": "image", "position": {"x": 0, "y": 0}, "data": data}


async def _save(nodes: list[dict], *, base_revision: int | None = None) -> dict:
    return await freezone_routes.put_canvas(
        project="proj_a",
        canvas_id="default",
        body=CanvasPayload(nodes=nodes, base_revision=base_revision),
        user=USER,
    )


async def test_put_canvas_rejects_inline_data_in_media_fields_and_writes_nothing(ctx) -> None:
    saved = await _save([_node("n1", {"imageUrl": LOCAL})])
    revision = saved["data"]["revision"]

    with pytest.raises(HTTPException) as excinfo:
        await _save(
            [
                _node(
                    "n1",
                    {
                        "imageUrl": PNG_DATA_URL,
                        "previewImageUrl": f" {PNG_DATA_URL}",
                        "videoUrl": "DATA:video/mp4;base64,AAAA",
                        "audioUrl": "data:audio/mpeg;base64,AAAA",
                    },
                ),
                _node(
                    "n2",
                    {
                        "imageUrl": LOCAL,
                        "frames": [
                            {"id": "f0", "imageUrl": LOCAL, "previewImageUrl": LOCAL},
                            {"id": "f1", "imageUrl": PNG_DATA_URL, "previewImageUrl": LOCAL},
                        ],
                    },
                ),
            ],
            base_revision=revision,
        )

    assert excinfo.value.status_code == 422
    assert excinfo.value.detail == {
        "code": "canvas_inline_media",
        "fields": [
            {"node_id": "n1", "field": "imageUrl"},
            {"node_id": "n1", "field": "videoUrl"},
            {"node_id": "n1", "field": "audioUrl"},
            {"node_id": "n1", "field": "previewImageUrl"},
            {"node_id": "n2", "field": "frames[1].imageUrl"},
        ],
    }
    stored = canvas_store.read_canvas(Path(ctx.state_dir), "default")
    assert stored["revision"] == revision
    assert stored["nodes"][0]["data"] == {"imageUrl": LOCAL}


async def test_put_canvas_saves_media_addresses_and_text_that_mentions_data(ctx) -> None:
    result = await _save(
        [
            _node(
                "n1",
                {
                    "imageUrl": LOCAL,
                    "previewImageUrl": LOCAL,
                    "prompt": "data:image/png;base64 is not allowed in media fields",
                },
            )
        ]
    )

    assert result["data"]["saved"] is True
