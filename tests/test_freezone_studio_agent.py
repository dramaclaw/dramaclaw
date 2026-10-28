"""Agent access to a compose node's OpenFilm film: read, edit, import and export through Studio."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from novelvideo.api.schemas import (
    FreezoneVideoComposeItem,
    FreezoneVideoComposeTrack,
)
from novelvideo.freezone import canvas_store
from novelvideo.freezone import studio
from novelvideo.freezone.studio import (
    StudioError,
    build_studio_film,
    edit_studio_film,
    export_studio_film,
    film_dir_for_node,
    import_media_to_film,
    read_studio_film,
    studio_export_film_dir,
)


def _source(project_dir: Path, name: str) -> str:
    path = project_dir / "freezone" / "_uploads" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake media " + name.encode())
    return f"/freezone/_uploads/{name}"


def _build_film(project_dir: Path) -> Path:
    tracks = [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="item-first",
                    source_url=_source(project_dir, "first.mp4"),
                    timeline_start=0.0,
                    source_start=0.0,
                    source_end=4.0,
                ),
                FreezoneVideoComposeItem(
                    item_id="item-second",
                    source_url=_source(project_dir, "second.mp4"),
                    timeline_start=4.0,
                    source_start=1.0,
                    source_end=3.0,
                ),
            ],
        )
    ]
    return build_studio_film(
        project_dir=project_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        title="Dusk alley",
        resolution="1080p",
        background_color="#000000",
        keep_original_audio=True,
        tracks=tracks,
    )


def _write_canvas(state_dir: Path) -> None:
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(state_dir, "canvas-1"),
        {
            "schema_version": 2,
            "canvas_id": "canvas-1",
            "revision": 3,
            "nodes": [
                {
                    "id": "video-a",
                    "type": "videoNode",
                    "data": {
                        "label": "Clip A",
                        "videoUrl": "/freezone/_uploads/first.mp4",
                    },
                },
                {
                    "id": "video-b",
                    "type": "videoNode",
                    "data": {
                        "label": "Clip B",
                        "videoUrl": "/freezone/_uploads/second.mp4",
                    },
                },
                {
                    "id": "node-1",
                    "type": "videoComposeNode",
                    "data": {
                        "draftTimeline": {
                            "tracks": [
                                {
                                    "id": "video-1",
                                    "kind": "video",
                                    "clips": [
                                        {
                                            "id": "item-first",
                                            "nodeId": "video-a",
                                            "displayName": None,
                                        },
                                        {
                                            "id": "item-second",
                                            "nodeId": "video-b",
                                            "displayName": "B take 2",
                                        },
                                    ],
                                }
                            ]
                        }
                    },
                },
            ],
            "edges": [],
        },
    )


class FakeStudio:
    """Answers Studio's API the way the vendored server does, from a scripted table."""

    def __init__(self, film_dir: Path):
        self.film_dir = film_dir
        self.calls: list[tuple[str, str, Any]] = []
        self.rev = "rev-1"
        self.doc = {
            "stage": {"w": 1920, "h": 1080},
            "tracks": [
                {
                    "clips": [
                        {
                            "id": "clip-0",
                            "src": "assets/clip-0-item-first.mp4",
                            "at": 0,
                            "time": [0, 4],
                        },
                        {
                            "id": "clip-1",
                            "src": "assets/clip-1-item-second.mp4",
                            "at": 4,
                            "time": [1, 3],
                            "speed": 2,
                            "volume": 0.5,
                            "overrides": [{"fade": [0.5, 0]}],
                        },
                    ]
                },
                {
                    "muted": True,
                    "clips": [{"id": "bed", "src": "assets/bed.m4a", "at": 0}],
                },
            ],
        }
        self.edit_status = 200
        self.export_steps: list[dict[str, Any]] = []

    async def ensure(self) -> dict[str, Any]:
        return {"origin": "http://127.0.0.1:4747", "key": "k"}

    async def post(self, state, path, body):
        self.calls.append(("POST", path, body))
        assert path == "/api/projects" and body["path"] == str(self.film_dir)
        return {"project": {"id": "pid-1"}}

    async def request(self, state, method, path, body=None, *, timeout=20.0):
        self.calls.append((method, path, body))
        if method == "GET" and path == "/api/projects/pid-1":
            return 200, {"rev": self.rev, "doc": self.doc, "problems": []}
        if method == "GET" and path.startswith("/api/projects/pid-1/media?"):
            if "bed.m4a" in path:
                return 200, {"duration": 9.5, "audio": True}
            return 200, {
                "duration": 6.0,
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "audio": True,
            }
        if method == "POST" and path == "/api/projects/pid-1/edit":
            if self.edit_status == 409:
                return 409, {
                    "error": 'clip "clip-9" is not in film.html any more',
                    "rev": "rev-3",
                    "doc": self.doc,
                }
            if self.edit_status == 422:
                return 422, {
                    "error": "speed has to be a number from 0.25 to 4.",
                    "rev": self.rev,
                }
            self.rev = "rev-2"
            return 200, {
                "rev": "rev-2",
                "value": self.doc,
                "doc": self.doc,
                "rebased": body["base"] != "rev-1",
            }
        if method == "POST" and path == "/api/projects/pid-1/exports":
            folder = Path(body["folder"])
            assert folder.is_dir()
            rendered = folder / "Dusk alley.mp4"
            self.rendered = rendered
            return 200, {
                "exports": [{"id": "exp-1", "status": "waiting", "outputs": []}]
            }
        if method == "GET" and path == "/api/projects/pid-1/exports":
            step = self.export_steps.pop(0)
            if step.get("status") == "done":
                self.rendered.write_bytes(b"rendered")
                step = {**step, "outputs": [str(self.rendered)]}
            return 200, {"exports": [{"id": "exp-1", **step}]}
        if method == "DELETE":
            return 200, {}
        raise AssertionError(f"unexpected Studio call {method} {path}")


@pytest.fixture()
def fake_studio(monkeypatch, tmp_path: Path) -> tuple[FakeStudio, Path, Path]:
    project_dir = tmp_path / "project"
    state_dir = tmp_path / "state"
    film_dir = _build_film(project_dir)
    _write_canvas(state_dir)
    fake = FakeStudio(film_dir)
    monkeypatch.setattr(studio, "_ensure_studio", fake.ensure)
    monkeypatch.setattr(studio, "_studio_post", fake.post)
    monkeypatch.setattr(studio, "_studio_request", fake.request)
    return fake, project_dir, state_dir


@pytest.mark.asyncio
async def test_read_film_maps_clips_to_their_canvas_sources(fake_studio):
    fake, project_dir, state_dir = fake_studio

    result = await read_studio_film(
        project_dir=project_dir,
        state_dir=state_dir,
        canvas_id="canvas-1",
        node_id="node-1",
    )

    assert result["ok"] is True and result["status"] == "studio_film"
    assert result["rev"] == "rev-1"
    assert result["studio"] == {"project_id": "pid-1", "edited_by_hand": False}
    film = result["film"]
    assert film["stage"] == {"width": 1920, "height": 1080}
    first, second = film["tracks"][0]["clips"]
    assert first["id"] == "clip-0" and first["kind"] == "video"
    assert first["duration"] == 4.0 and first["end"] == 4.0
    assert first["source"]["item_id"] == "item-first"
    assert first["source"]["node_id"] == "video-a"
    assert first["source"]["label"] == "Clip A"
    # speed 2 halves the two source seconds; the draft's own display name wins the label
    assert second["duration"] == 1.0 and second["end"] == 5.0
    assert second["fade"] == [0.5, 0.0] and second["volume"] == 0.5
    assert second["source"]["label"] == "B take 2"
    bed = film["tracks"][1]
    assert bed["muted"] is True
    # a sound without a fragment plays the whole probed file
    assert bed["clips"][0]["kind"] == "sound" and bed["clips"][0]["duration"] == 9.5
    assert film["duration"] == 9.5
    assert {entry["path"] for entry in result["media"]} == {
        "assets/clip-0-item-first.mp4",
        "assets/clip-1-item-second.mp4",
        "assets/bed.m4a",
    }


@pytest.mark.asyncio
async def test_read_film_needs_a_film(fake_studio):
    _fake, project_dir, state_dir = fake_studio
    with pytest.raises(StudioError) as excinfo:
        await read_studio_film(
            project_dir=project_dir,
            state_dir=state_dir,
            canvas_id="canvas-1",
            node_id="never",
        )
    assert excinfo.value.status_code == 404
    assert "open its compose workspace" in str(excinfo.value)


@pytest.mark.asyncio
async def test_edit_film_forwards_ops_with_the_base_rev(fake_studio):
    fake, project_dir, state_dir = fake_studio

    result = await edit_studio_film(
        project_dir=project_dir,
        state_dir=state_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        base_rev="rev-1",
        ops=[{"op": "move", "clip": "clip-1", "at": 3}],
    )

    assert result["ok"] is True and result["status"] == "studio_film_edited"
    assert result["rev"] == "rev-2" and result["rebased"] is False
    assert result["ops_applied"] == 1
    assert result["film"]["tracks"][0]["clips"][0]["source"]["label"] == "Clip A"
    edit_call = next(call for call in fake.calls if call[1].endswith("/edit"))
    assert edit_call[2] == {
        "base": "rev-1",
        "ops": [{"op": "move", "clip": "clip-1", "at": 3}],
    }


@pytest.mark.asyncio
async def test_edit_film_reports_a_conflict_instead_of_raising(fake_studio):
    fake, project_dir, state_dir = fake_studio
    fake.edit_status = 409

    result = await edit_studio_film(
        project_dir=project_dir,
        state_dir=state_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        base_rev="rev-1",
        ops=[{"op": "remove", "clip": "clip-9"}],
    )

    assert result["ok"] is False
    assert result["status"] == "studio_edit_conflict"
    assert result["retryable"] is True
    assert result["rev"] == "rev-3"
    assert "clip-9" in result["error"]


@pytest.mark.asyncio
async def test_edit_film_reports_an_invalid_edit(fake_studio):
    fake, project_dir, state_dir = fake_studio
    fake.edit_status = 422

    result = await edit_studio_film(
        project_dir=project_dir,
        state_dir=state_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        base_rev="rev-1",
        ops=[{"op": "set", "clip": "clip-0", "field": "speed", "value": 9}],
    )

    assert result["ok"] is False
    assert result["status"] == "studio_edit_invalid"
    assert result["retryable"] is False
    assert "speed" in result["error"]


@pytest.mark.asyncio
async def test_edit_film_rejects_malformed_ops(fake_studio):
    _fake, project_dir, state_dir = fake_studio
    with pytest.raises(StudioError) as excinfo:
        await edit_studio_film(
            project_dir=project_dir,
            state_dir=state_dir,
            canvas_id="canvas-1",
            node_id="node-1",
            base_rev="rev-1",
            ops=[{"clip": "clip-0"}],
        )
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_import_media_copies_into_assets_and_remembers_the_source(fake_studio):
    fake, project_dir, _state_dir = fake_studio
    url = _source(project_dir, "extra.mp4")

    result = await import_media_to_film(
        project_dir=project_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        source_url=url,
        source_node_id="video-c",
        label="Clip C",
    )

    assert result["ok"] is True and result["status"] == "studio_media_imported"
    asset_path = result["asset_path"]
    assert asset_path.startswith("assets/import-") and asset_path.endswith(".mp4")
    assert "Clip-C" in asset_path
    assert (fake.film_dir / asset_path).read_bytes() == b"fake media extra.mp4"
    assert result["kind"] == "video"
    assert result["media"][0]["duration"] == 6.0
    manifest = json.loads((fake.film_dir / "manifest.json").read_text())
    assert manifest["imports"][asset_path.split("/", 1)[1]] == {
        "source_url": url,
        "node_id": "video-c",
        "label": "Clip C",
    }

    again = await import_media_to_film(
        project_dir=project_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        source_url=url,
        source_node_id="video-c",
        label="Clip C",
    )
    assert again["asset_path"] == asset_path


@pytest.mark.asyncio
async def test_import_media_accepts_stills_but_not_arbitrary_files(fake_studio):
    _fake, project_dir, _state_dir = fake_studio
    still = await import_media_to_film(
        project_dir=project_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        source_url=_source(project_dir, "frame.png"),
    )
    assert still["kind"] == "still"
    with pytest.raises(StudioError) as excinfo:
        await import_media_to_film(
            project_dir=project_dir,
            canvas_id="canvas-1",
            node_id="node-1",
            source_url=_source(project_dir, "notes.txt"),
        )
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_export_waits_for_studio_and_moves_the_render_into_place(
    fake_studio, tmp_path
):
    fake, _project_dir, _state_dir = fake_studio
    fake.export_steps = [
        {"status": "running", "progress": 0.4},
        {"status": "done", "progress": 1},
    ]
    output = tmp_path / "out" / "job-1.mp4"

    rendered = await export_studio_film(
        film_dir=fake.film_dir, output_path=output, fps=25, poll_seconds=0
    )

    assert rendered == output and output.read_bytes() == b"rendered"
    start = next(
        call
        for call in fake.calls
        if call[1].endswith("/exports") and call[0] == "POST"
    )
    assert start[2]["jobs"] == [{"kind": "video", "codec": "h264", "fps": 25}]
    # Studio's own copy stays where Studio lists it, so its export panel can still open it
    assert start[2]["folder"] == str(output.parent / "studio-exports")
    assert (
        output.parent / "studio-exports" / "Dusk alley.mp4"
    ).read_bytes() == b"rendered"


@pytest.mark.asyncio
async def test_export_surfaces_a_failed_render(fake_studio, tmp_path):
    fake, _project_dir, _state_dir = fake_studio
    fake.export_steps = [{"status": "failed", "error": "ffmpeg exited 1"}]

    with pytest.raises(StudioError) as excinfo:
        await export_studio_film(
            film_dir=fake.film_dir,
            output_path=tmp_path / "job-2.mp4",
            fps=30,
            poll_seconds=0,
        )
    assert "ffmpeg exited 1" in str(excinfo.value)


@pytest.mark.asyncio
async def test_export_times_out_and_cancels(fake_studio, tmp_path):
    fake, _project_dir, _state_dir = fake_studio
    fake.export_steps = [{"status": "running"}] * 5

    with pytest.raises(StudioError) as excinfo:
        await export_studio_film(
            film_dir=fake.film_dir,
            output_path=tmp_path / "job-3.mp4",
            poll_seconds=0,
            timeout_seconds=0,
        )
    assert excinfo.value.status_code == 504
    assert ("DELETE", "/api/projects/pid-1/exports/exp-1", None) in fake.calls


def test_only_a_hand_cut_film_takes_over_the_compose_export(tmp_path: Path):
    project_dir = tmp_path / "project"
    assert studio_export_film_dir(project_dir, "canvas-1", "node-1") is None
    film_dir = _build_film(project_dir)
    # built from the timeline and never touched: the timeline still renders
    assert studio_export_film_dir(project_dir, "canvas-1", "node-1") is None
    document = film_dir / "film.html"
    document.write_text(
        document.read_text().replace('at="4"', 'at="3.5"'), encoding="utf-8"
    )
    assert studio_export_film_dir(project_dir, "canvas-1", "node-1") == film_dir
    assert studio_export_film_dir(project_dir, "", "node-1") is None
    assert film_dir_for_node(project_dir, "canvas-1", "node-1") == film_dir


@pytest.mark.asyncio
async def test_studio_export_leaf_keeps_the_film_inside_the_project(
    tmp_path: Path, monkeypatch
):
    from novelvideo.freezone.jobs import run_freezone_studio_export

    project_dir = tmp_path / "project"
    film_dir = _build_film(project_dir)
    seen: dict[str, Any] = {}

    async def fake_export(*, film_dir, output_path, fps):
        seen.update(film_dir=film_dir, output_path=output_path, fps=fps)
        output_path.write_bytes(b"x")
        return output_path

    monkeypatch.setattr(studio, "export_studio_film", fake_export)
    output = await run_freezone_studio_export(
        project_dir=project_dir, job_id="job-9", film_dir=str(film_dir), fps=24
    )
    assert output.name == "job-9.mp4" and output.parent.name == "freezone_video_compose"
    assert seen["film_dir"] == film_dir and seen["fps"] == 24

    with pytest.raises(RuntimeError):
        await run_freezone_studio_export(
            project_dir=project_dir,
            job_id="job-10",
            film_dir=str(tmp_path / "elsewhere"),
        )
