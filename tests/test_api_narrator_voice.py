from __future__ import annotations

import base64
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m04


@dataclass
class DummyStore:
    project_dir: str

    def get_all_characters(self):
        return []


def _client(monkeypatch, tmp_path):
    from novelvideo import project_config
    from novelvideo.api.routes import projects

    project_dir = tmp_path / "output" / "admin" / "demo"
    project_dir.mkdir(parents=True)
    state_root = tmp_path / "state"
    monkeypatch.setattr(project_config, "STATE_DIR", state_root)
    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "output")

    fake_ctx = SimpleNamespace(
        project_id="demo",
        project_name="demo",
        owner_username="admin",
        owner_project_label="admin/demo",
        output_dir=project_dir,
        state_dir=state_root / "admin" / "demo",
        is_home_node=True,
    )

    async def fake_resolve_project_context(*, user, project_id, required_role="viewer"):
        return fake_ctx

    store = DummyStore(str(project_dir))

    async def fake_make_sqlite_store_for_context(ctx):
        return store

    def fake_make_static_url_for_context(ctx, relative_path, local_path=None):
        return f"/static/admin/demo/{relative_path}"

    monkeypatch.setattr(projects, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(
        projects, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(projects, "make_static_url_for_context", fake_make_static_url_for_context)

    app = FastAPI()
    app.include_router(projects.router)
    app.dependency_overrides[projects.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app), project_config, project_dir, fake_ctx.state_dir


def test_narrator_voice_upload_persists_project_reference(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    project_config.set_narrator_reference_audio_in_state_dir(
        state_dir,
        relative_path="",
        sha256="",
    )

    response = client.post(
        "/projects/demo/narrator-voice/upload",
        files={"file": ("voice.wav", b"voice-bytes", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["reference_path"] == "assets/narrator/voice.wav"
    assert payload["data"]["reference_url"].startswith(
        "/static/admin/demo/assets/narrator/voice.wav"
    )
    saved = project_config.load_narrator_reference_audio_from_state_dir(state_dir)
    assert saved["path"] == "assets/narrator/voice.wav"
    assert saved["sha256"]
    assert (project_dir / "assets/narrator/voice.wav").read_bytes() == b"voice-bytes"


def test_narrator_voice_record_accepts_data_url(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    encoded = base64.b64encode(b"recorded-voice").decode("ascii")

    response = client.post(
        "/projects/demo/narrator-voice/record",
        json={"data_url": f"data:audio/wav;base64,{encoded}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["reference_path"] == "assets/narrator/voice.wav"
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == (
        "assets/narrator/voice.wav"
    )
    assert (project_dir / "assets/narrator/voice.wav").read_bytes() == b"recorded-voice"


def test_narrator_voice_sources_and_copy(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    source = project_dir / "audio/ep001/beat_01.mp3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source-voice")

    sources = client.get("/projects/demo/narrator-voice/sources")
    assert sources.status_code == 200
    assert sources.json()["data"]["options"] == [
        {
            "label": "已生成音频 · beat_01.mp3",
            "path": str(source),
            "rel_path": "audio/ep001/beat_01.mp3",
        }
    ]

    response = client.post(
        "/projects/demo/narrator-voice/copy",
        json={"source_path": str(source)},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == (
        "assets/narrator/voice.mp3"
    )
    assert (project_dir / "assets/narrator/voice.mp3").read_bytes() == b"source-voice"


def test_narrator_voice_delete_renames_file_and_clears_metadata(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    target = project_dir / "assets/narrator/voice.wav"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"voice")
    project_config.set_narrator_reference_audio_in_state_dir(
        state_dir,
        relative_path="assets/narrator/voice.wav",
        sha256="sha",
    )

    response = client.post("/projects/demo/narrator-voice/delete")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == ""
    assert not target.exists()
    assert list((project_dir / "assets/narrator").glob("voice_*.wav"))
