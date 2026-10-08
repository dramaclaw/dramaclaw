"""Imported HEVC playback uses a separate H.264 file, never a source rewrite."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.deps import ProjectResolution
from novelvideo.api.routes import files
from novelvideo.freezone import browser_video


def _source(project: Path) -> Path:
    source = project / "freezone" / "liblib_import" / "canvas" / "media" / "clip.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"source-video")
    return source


def test_imported_hevc_copy_is_cached_and_source_is_unchanged(monkeypatch, tmp_path):
    source = _source(tmp_path)
    calls = 0
    monkeypatch.setattr(browser_video, "_ffmpeg_executable", lambda: "ffmpeg")
    monkeypatch.setattr(browser_video, "_probe_video_codec", lambda *_: "hevc")

    def convert(_source_path, destination, _ffmpeg):
        nonlocal calls
        calls += 1
        destination.write_bytes(b"h264-video")

    monkeypatch.setattr(browser_video, "_transcode_video", convert)
    first = browser_video.browser_playback_file(tmp_path, source)
    second = browser_video.browser_playback_file(tmp_path, source)
    assert first == second
    assert first.read_bytes() == b"h264-video"
    assert source.read_bytes() == b"source-video"
    assert calls == 1

    source.write_bytes(b"new-source-video")
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    refreshed = browser_video.browser_playback_file(tmp_path, source)
    assert refreshed != first
    assert calls == 2


def test_h264_and_unrelated_files_keep_their_original_path(monkeypatch, tmp_path):
    source = _source(tmp_path)
    monkeypatch.setattr(browser_video, "_ffmpeg_executable", lambda: "ffmpeg")
    monkeypatch.setattr(browser_video, "_probe_video_codec", lambda *_: "h264")
    assert browser_video.browser_playback_file(tmp_path, source) == source
    unrelated = tmp_path / "freezone" / "_outputs" / "clip.mp4"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_bytes(b"another-video")
    assert browser_video.browser_playback_file(tmp_path, unrelated) == unrelated


def test_finds_ffmpeg_bundled_with_configured_comfyui_python(monkeypatch, tmp_path):
    python = tmp_path / "python_embeded" / "python.exe"
    binary = python.parent / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries" / "ffmpeg.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"executable")
    monkeypatch.setattr(browser_video.config, "FFMPEG_PATH", "missing-ffmpeg")
    monkeypatch.setattr(browser_video.shutil, "which", lambda _: None)
    monkeypatch.setenv("COMFYUI_PYTHON", str(python))
    assert browser_video._ffmpeg_executable() == str(binary)


def test_media_route_only_returns_copy_for_explicit_playback_request(monkeypatch, tmp_path):
    source = _source(tmp_path)
    copy = tmp_path / "browser-copy.mp4"
    copy.write_bytes(b"browser-video")

    async def resolve(project, user, *, required_role="viewer", media_read=False):
        assert required_role == "viewer"
        assert media_read is True
        return ProjectResolution(
            ctx=None,
            username="admin",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(files, "resolve_project_scope", resolve)
    monkeypatch.setattr(files, "browser_playback_file", lambda _project, _source: copy)
    app = FastAPI()
    app.include_router(files.router)
    app.dependency_overrides[files.get_api_user] = lambda: {"username": "admin"}
    client = TestClient(app)
    path = "/projects/demo/media/freezone/liblib_import/canvas/media/clip.mp4"

    plain = client.get(path)
    compatible = client.get(path, params={"st_video": "h264", "v": "1"})
    partial = client.get(
        path, params={"st_video": "h264", "v": "1"}, headers={"Range": "bytes=0-3"}
    )
    assert plain.status_code == 200 and plain.content == source.read_bytes()
    assert compatible.status_code == 200 and compatible.content == b"browser-video"
    assert compatible.headers["content-type"].startswith("video/mp4")
    assert partial.status_code == 206 and partial.content == b"brow"
