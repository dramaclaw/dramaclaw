"""Studio film generation: a Dramaclaw compose timeline becomes an OpenFilm folder."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from novelvideo.api.schemas import (
    FreezoneVideoComposeItem,
    FreezoneVideoComposeTrack,
)
from novelvideo.freezone.studio import (
    StudioError,
    build_studio_film,
    studio_open_url,
)


def _source(project_dir: Path, name: str) -> str:
    path = project_dir / "freezone" / "_uploads" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake media " + name.encode())
    return f"/freezone/_uploads/{name}"


def _tracks(project_dir: Path) -> list[FreezoneVideoComposeTrack]:
    return [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="first",
                    source_url=_source(project_dir, "first.mp4"),
                    timeline_start=2.0,
                    source_start=1.5,
                    source_end=4.25,
                    volume=0.5,
                    muted=False,
                    speed=2.0,
                ),
                FreezoneVideoComposeItem(
                    item_id="second",
                    source_url=_source(project_dir, "second.mov"),
                    timeline_start=3.0,
                    source_start=0.0,
                    source_end=2.0,
                    volume=1.0,
                    muted=True,
                    speed=1.0,
                ),
            ],
        ),
        FreezoneVideoComposeTrack(
            track_id="audio-1",
            kind="audio",
            items=[
                FreezoneVideoComposeItem(
                    item_id="bed",
                    source_url=_source(project_dir, "bed.m4a"),
                    timeline_start=0.0,
                    source_start=0.0,
                    source_end=6.0,
                    volume=0.8,
                    muted=False,
                    speed=1.0,
                )
            ],
        ),
    ]


def _build(project_dir: Path, **overrides):
    values = dict(
        project_dir=project_dir,
        canvas_id="canvas-1",
        node_id="node-1",
        title="My film",
        resolution="1080p",
        background_color="#101010",
        keep_original_audio=True,
        tracks=_tracks(project_dir),
    )
    values.update(overrides)
    return build_studio_film(**values)


def test_builds_a_film_html_from_compose_tracks(tmp_path: Path):
    film_dir = _build(tmp_path)
    html = (film_dir / "film.html").read_text()

    assert '<meta name="viewport" content="width=1920, height=1080">' in html
    assert "background: #101010" in html
    assert html.count("<section>") == 2
    assert (
        '<video id="clip-0" data-dramaclaw-item-id="first" '
        'src="assets/clip-0-first.mp4#t=1.5,4.25" at="2" volume="0.5" speed="2"></video>'
    ) in html
    assert 'muted' in html
    assert (
        '<audio id="clip-2" data-dramaclaw-item-id="bed" '
        'src="assets/clip-2-bed.m4a#t=0,6" at="0" volume="0.8"></audio>'
    ) in html
    assert (film_dir / "assets" / "clip-0-first.mp4").exists()
    assert (film_dir / "assets" / "clip-1-second.mov").exists()
    assert (film_dir / "assets" / "clip-2-bed.m4a").exists()


def test_mutes_video_when_original_audio_is_off(tmp_path: Path):
    html = (_build(tmp_path, keep_original_audio=False) / "film.html").read_text()
    first_video = html.split('id="clip-0"', 1)[1].split("</video>", 1)[0]
    assert " muted" in first_video
    bed = html.split('id="clip-2"', 1)[1].split("</audio>", 1)[0]
    assert " muted" not in bed


def test_rejects_a_non_hex_background_color(tmp_path: Path):
    with pytest.raises(StudioError) as error:
        _build(
            tmp_path,
            background_color="red; } </style><script>alert(1)</script>",
        )
    assert error.value.status_code == 400


def test_reuses_the_folder_until_the_timeline_changes(tmp_path: Path):
    film_dir = _build(tmp_path)
    first = (film_dir / "film.html").read_text()

    assert _build(tmp_path) == film_dir
    assert (film_dir / "film.html").read_text() == first
    # An edit made in Studio survives reopening the same timeline.
    (film_dir / "film.html").write_text(first + "\n<!-- studio edit -->\n")
    _build(tmp_path)
    assert "studio edit" in (film_dir / "film.html").read_text()

    rebuilt = _build(tmp_path, rebuild=True)
    assert rebuilt == film_dir
    assert "studio edit" not in (film_dir / "film.html").read_text()


def test_rebuild_drops_assets_that_left_the_timeline(tmp_path: Path):
    film_dir = _build(tmp_path)
    assets = film_dir / "assets"
    assert (assets / "clip-0-first.mp4").is_file()

    tracks = [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="later",
                    source_url=_source(tmp_path, "later.mp4"),
                    source_end=2.0,
                )
            ],
        )
    ]
    _build(tmp_path, tracks=tracks)

    # Studio 素材库按 assets 目录扫描；旧片段的拷贝留着就会一条片段出现两份。
    assert (assets / "clip-0-later.mp4").is_file()
    assert not (assets / "clip-0-first.mp4").exists()
    assert not (assets / "clip-1-second.mov").exists()
    assert not (assets / "clip-2-bed.m4a").exists()


def test_uses_a_720p_stage_and_writes_a_manifest(tmp_path: Path):
    film_dir = _build(tmp_path, resolution="720p")
    html = (film_dir / "film.html").read_text()
    assert "width=1280, height=720" in html
    manifest = (film_dir / "manifest.json").read_text()
    assert '"canvas_id": "canvas-1"' in manifest
    assert '"node_id": "node-1"' in manifest


def test_rejects_a_source_outside_the_project(tmp_path: Path):
    tracks = [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="bad",
                    source_url="/freezone/../../etc/passwd",
                    source_end=1.0,
                )
            ],
        )
    ]
    with pytest.raises(StudioError) as error:
        _build(tmp_path, tracks=tracks)
    assert error.value.status_code == 400


def test_rejects_a_missing_source(tmp_path: Path):
    tracks = [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="missing",
                    source_url="/freezone/_uploads/nope.mp4",
                    source_end=1.0,
                )
            ],
        )
    ]
    with pytest.raises(StudioError) as error:
        _build(tmp_path, tracks=tracks)
    assert error.value.status_code == 404


def test_escapes_the_title_and_item_ids(tmp_path: Path):
    tracks = _tracks(tmp_path)
    tracks[0].items[0].item_id = '"><script>alert(1)</script>'
    film_dir = _build(tmp_path, title='A "film" <b>', tracks=tracks)
    html = (film_dir / "film.html").read_text()
    assert "<script>" not in html
    assert "&quot;" in html or "&#x27;" in html


def test_builds_the_open_url_with_the_host_back_target():
    url = studio_open_url(
        origin="http://127.0.0.1:4747",
        key="a" * 48,
        project_id="abc123",
        host_back="http://127.0.0.1:5173/projects/p/freezone?canvas=default",
        host_back_label="返回虾画",
    )
    parsed = urlsplit(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == "http://127.0.0.1:4747/open"
    query = parse_qs(parsed.query)
    assert query["key"] == ["a" * 48]
    target = query["to"][0]
    assert target.startswith("/projects/abc123?")
    inner = parse_qs(urlsplit(target).query)
    assert inner["hostBack"] == [
        "http://127.0.0.1:5173/projects/p/freezone?canvas=default"
    ]
    assert inner["hostBackLabel"] == ["返回虾画"]


def test_rejects_a_non_http_host_back_target():
    with pytest.raises(StudioError):
        studio_open_url(
            origin="http://127.0.0.1:4747",
            key="a" * 48,
            project_id="abc123",
            host_back="javascript:alert(1)",
        )


def test_rebuild_leaves_unrelated_assets_alone(tmp_path: Path):
    film_dir = _build(tmp_path)
    assets = film_dir / "assets"
    (assets / "clip-notes.txt").write_text("keep me")
    (assets / "clip-9-mine").mkdir()

    tracks = [
        FreezoneVideoComposeTrack(
            track_id="video-1",
            kind="video",
            items=[
                FreezoneVideoComposeItem(
                    item_id="later",
                    source_url=_source(tmp_path, "later.mp4"),
                    source_end=2.0,
                )
            ],
        )
    ]
    _build(tmp_path, tracks=tracks)

    assert (assets / "clip-notes.txt").read_text() == "keep me"
    assert (assets / "clip-9-mine").is_dir()
    assert not (assets / "clip-0-first.mp4").exists()


def test_studio_env_keeps_api_secrets_out(monkeypatch, tmp_path: Path):
    from novelvideo.freezone import studio

    for name in ("MODEL_API_KEY", "ST_CONTROL_PLANE_DSN", "SESSION_SECRET"):
        monkeypatch.setenv(name, "secret")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    env = studio._studio_env(4747, "k" * 48, tmp_path / "ready.json")

    assert env["PATH"] == "/usr/bin:/bin"
    assert env["OPENFILM_STUDIO_PORT"] == "4747"
    assert env["OPENFILM_STUDIO_KEY"] == "k" * 48
    assert env["OPENFILM_STUDIO_READY_FILE"] == str(tmp_path / "ready.json")
    assert not {"MODEL_API_KEY", "ST_CONTROL_PLANE_DSN", "SESSION_SECRET"} & set(env)
