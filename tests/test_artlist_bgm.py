"""Tests for the Artlist BGM provider and provider-neutral compose wiring.

Covers OAuth token caching, search duration fallback, download failure,
ffmpeg mix success/failure, compose cancellation, missing credentials, and the
provider-neutral BGM source resolution + provenance persistence. All HTTP and
ffmpeg subprocess calls are mocked — no network or ffmpeg binary required.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from novelvideo.music import ArtlistError, ArtlistMusicProvider


# --- aiohttp fakes ------------------------------------------------------------


class _FakeResp:
    def __init__(self, *, status=200, json_data=None, text_data="", body=b""):
        self.status = status
        self._json = json_data
        self._text = text_data
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return self._json

    async def text(self):
        return self._text

    async def read(self):
        return self._body


class _FakeSession:
    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def post(self, url, **kw):
        return self._handler("POST", url, kw)

    def get(self, url, **kw):
        return self._handler("GET", url, kw)


def _install_http(monkeypatch, handler):
    from novelvideo.music import artlist_provider

    monkeypatch.setattr(
        artlist_provider.aiohttp,
        "ClientSession",
        lambda *a, **k: _FakeSession(handler),
    )


# --- provider: OAuth token caching -------------------------------------------


async def test_oauth_token_cached_and_refreshed(monkeypatch):
    counter = {"token": 0}

    def handler(method, url, kw):
        if "oauth2/token" in url:
            counter["token"] += 1
            return _FakeResp(
                json_data={"access_token": f"tok{counter['token']}", "expires_in": 3600}
            )
        raise AssertionError(f"unexpected call: {method} {url}")

    _install_http(monkeypatch, handler)
    provider = ArtlistMusicProvider(client_id="id", client_secret="sec")

    first = await provider._access_token()
    second = await provider._access_token()
    assert first == second == "tok1"
    assert counter["token"] == 1  # reused within TTL, not re-fetched

    # Force expiry -> next call must refresh.
    provider._token_exp = time.time() - 1
    third = await provider._access_token()
    assert third == "tok2"
    assert counter["token"] == 2


# --- provider: search duration fallback --------------------------------------


async def test_search_duration_fallback(monkeypatch, tmp_path):
    calls = {"search": 0}

    def handler(method, url, kw):
        if "oauth2/token" in url:
            return _FakeResp(json_data={"access_token": "tok", "expires_in": 3600})
        if url.endswith("/search/v1/song"):
            calls["search"] += 1
            params = kw.get("params") or {}
            if "durationMin" in params or "durationMax" in params:
                # Nothing matches the tight duration window.
                return _FakeResp(json_data={"songs": []})
            # Relaxed search (no duration filter) returns a hit.
            return _FakeResp(
                json_data={
                    "songs": [
                        {
                            "id": "7",
                            "duration": 95,
                            "name": "Relaxed",
                            "url": "preview",
                            "genreCategories": [{"name": "cinematic"}],
                        }
                    ]
                }
            )
        if "/download/v1/downloadable/song/" in url:
            return _FakeResp(json_data={"url": "https://dl.example/track.mp3"})
        if url == "https://dl.example/track.mp3":
            return _FakeResp(body=b"audio-bytes")
        raise AssertionError(f"unexpected call: {method} {url}")

    _install_http(monkeypatch, handler)
    provider = ArtlistMusicProvider(client_id="id", client_secret="sec")

    out = tmp_path / "bgm.mp3"
    track, path = await provider.fetch_bgm(
        str(out), query="calm", duration_target=100
    )

    assert calls["search"] == 2  # windowed search then relaxed fallback
    assert track.id == "7"
    assert track.name == "Relaxed"
    assert Path(path).read_bytes() == b"audio-bytes"


# --- provider: download failure ----------------------------------------------


async def test_download_failure_raises(monkeypatch, tmp_path):
    def handler(method, url, kw):
        return _FakeResp(status=500, text_data="server error")

    _install_http(monkeypatch, handler)
    provider = ArtlistMusicProvider(client_id="id", client_secret="sec")

    with pytest.raises(ArtlistError):
        await provider.download_track(
            "https://dl.example/x.mp3", str(tmp_path / "x.mp3")
        )


# --- provider: missing credentials -------------------------------------------


def test_missing_credentials_raises(monkeypatch):
    monkeypatch.delenv("ARTLIST_CLIENT_ID", raising=False)
    monkeypatch.delenv("ARTLIST_CLIENT_SECRET", raising=False)
    with pytest.raises(ValueError):
        ArtlistMusicProvider()


# --- runner: provider-neutral source resolution ------------------------------


def test_resolve_bgm_source_is_provider_neutral():
    from novelvideo.task_backend.runners.video import _resolve_bgm_source

    # add_bgm off -> never any BGM regardless of source.
    assert _resolve_bgm_source(False, None) is None
    assert _resolve_bgm_source(False, "artlist") is None

    # Explicit provider selection is required and case-insensitive.
    assert _resolve_bgm_source(True, "artlist") == "artlist"
    assert _resolve_bgm_source(True, "ARTLIST") == "artlist"

    # "none" is an explicit opt-out.
    assert _resolve_bgm_source(True, "none") is None

    # add_bgm=true alone must NOT silently pick a vendor.
    with pytest.raises(ValueError):
        _resolve_bgm_source(True, None)

    # Unknown providers error clearly.
    with pytest.raises(ValueError):
        _resolve_bgm_source(True, "spotify")


# --- runner: ffmpeg mix success + provenance ---------------------------------


def _install_fake_provider(monkeypatch, track):
    import novelvideo.music as music_mod

    class _FakeProvider:
        def __init__(self, *a, **k):
            self.client_id = "acct-xyz"

        async def fetch_bgm(self, output_path, **kw):
            Path(output_path).write_bytes(b"track")
            return track, output_path

    monkeypatch.setattr(music_mod, "ArtlistMusicProvider", _FakeProvider)


def test_apply_artlist_bgm_success_persists_provenance(monkeypatch, tmp_path):
    import shutil

    from novelvideo.task_backend.runners import video

    track = SimpleNamespace(
        id="123", name="Night Drive", genres=("cinematic",), duration=120.0
    )
    _install_fake_provider(monkeypatch, track)
    monkeypatch.setattr(video, "_probe_media_duration", lambda *a, **k: 120.0)
    # No real ffmpeg output file exists; make the in-place move a no-op-ish copy.
    monkeypatch.setattr(shutil, "move", lambda s, d: Path(d).write_bytes(b"mixed"))

    seen = []

    def run_checked(cmd, *, default_timeout_seconds):
        seen.append(cmd)
        return SimpleNamespace(returncode=0, stderr="")

    video_path = tmp_path / "ep001_final.mp4"
    video_path.write_bytes(b"video")

    status, prov = video._apply_artlist_bgm(
        video_path=video_path,
        tmp_dir=tmp_path,
        query="cinematic",
        volume=0.15,
        run_checked=run_checked,
        subprocess_timeout=lambda n: n,
    )

    assert seen and seen[0][0] == "ffmpeg"
    assert "Night Drive" in status
    assert prov["provider"] == "artlist"
    assert prov["source"] == "artlist"
    assert prov["track_id"] == "123"
    assert prov["track_name"] == "Night Drive"
    assert prov["account_ref"] == "acct-xyz"
    assert prov["license"]  # non-empty license reference
    assert prov["download_format"] == "mp3"

    # Sidecar persistence writes structured provenance next to the media.
    sidecar = video._write_bgm_provenance(video_path, prov)
    assert sidecar is not None
    loaded = json.loads(Path(sidecar).read_text(encoding="utf-8"))
    assert loaded["track_id"] == "123"
    assert loaded["provider"] == "artlist"


# --- runner: ffmpeg mix failure ----------------------------------------------


def test_apply_artlist_bgm_ffmpeg_failure_raises(monkeypatch, tmp_path):
    from novelvideo.task_backend.runners import video

    track = SimpleNamespace(id="9", name="X", genres=(), duration=10.0)
    _install_fake_provider(monkeypatch, track)
    monkeypatch.setattr(video, "_probe_media_duration", lambda *a, **k: 10.0)

    def run_checked(cmd, *, default_timeout_seconds):
        return SimpleNamespace(returncode=1, stderr="ffmpeg boom")

    video_path = tmp_path / "ep.mp4"
    video_path.write_bytes(b"video")

    with pytest.raises(RuntimeError, match="BGM mix failed"):
        video._apply_artlist_bgm(
            video_path=video_path,
            tmp_dir=tmp_path,
            query="q",
            volume=0.15,
            run_checked=run_checked,
            subprocess_timeout=lambda n: n,
        )


# --- runner: cancellation propagates -----------------------------------------


def test_compose_episode_cancellation(monkeypatch, tmp_path):
    from novelvideo.task_backend.cancel import TaskCancelled
    from novelvideo.task_backend.runners import video

    monkeypatch.setattr(video, "get_task_manager", lambda: MagicMock())

    def _raise(*a, **k):
        raise TaskCancelled()

    monkeypatch.setattr(video, "raise_if_envelope_cancel_requested", _raise)

    envelope = {
        "episode": 1,
        "payload": {
            "output_dir": str(tmp_path),
            "beats": [{"beat_number": 1}],
            "add_bgm": False,
        },
    }

    with pytest.raises(TaskCancelled):
        video.run_compose_episode(envelope, MagicMock())


# --- runner: cancel/timeout during the BGM step propagates -------------------


@pytest.mark.parametrize("exc_factory", ["cancelled", "timed_out"])
def test_compose_episode_bgm_control_flow_propagates(monkeypatch, tmp_path, exc_factory):
    """A cancellation/timeout raised *inside* the BGM step must propagate.

    Regression: the BGM block caught bare ``Exception`` and converted every
    failure into a "Background music skipped" log line, so ``TaskCancelled`` /
    ``TaskTimedOut`` (both subclasses of ``Exception``) raised during the
    Artlist fetch or ffmpeg mix were silently swallowed and the compose was
    reported as a success. The step must re-raise these control-flow signals.
    """
    from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
    from novelvideo.task_backend.runners import video

    if exc_factory == "cancelled":
        control_exc: Exception = TaskCancelled()
        expected = TaskCancelled
    else:
        control_exc = TaskTimedOut(timeout_seconds=30 * 60)
        expected = TaskTimedOut

    # A single beat with a real video file so composition reaches the BGM step.
    video_dir = tmp_path / "videos" / "beats" / "ep001"
    video_dir.mkdir(parents=True)
    (video_dir / "beat_01.mp4").write_bytes(b"video")

    def fake_run(cmd, **_kwargs):
        # ffprobe (audio-stream detection) reports no audio; ffmpeg succeeds.
        if cmd and cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout="\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: MagicMock())
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)
    monkeypatch.setattr(video, "raise_if_envelope_cancel_requested", lambda *a, **k: None)

    def _raise_during_bgm(*_a, **_k):
        raise control_exc

    monkeypatch.setattr(video, "_apply_artlist_bgm", _raise_during_bgm)

    envelope = {
        "episode": 1,
        "payload": {
            "output_dir": str(tmp_path),
            "beats": [{"beat_number": 1}],
            "add_bgm": True,
            "bgm_source": "artlist",
        },
    }

    # Must propagate — NOT be converted into a successful compose / skip result.
    with pytest.raises(expected):
        video.run_compose_episode(envelope, MagicMock())
