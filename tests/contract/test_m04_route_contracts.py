from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import CharacterIdentity, NovelCharacter, NovelProp, StyleConfig

pytestmark = pytest.mark.m04


_PROJECT = "demo"
_CHARACTER = "林昭"
_IDENTITY_ID = "林昭_青年"
_IDENTITY_NAME = "青年"
_PROP = "玉佩"


def _png_bytes() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (2, 2), color=(20, 40, 60)).save(buf, format="PNG")
    return buf.getvalue()


class _M04Store:
    def __init__(self):
        self.project_dir = ""
        identity = CharacterIdentity(
            identity_id=_IDENTITY_ID,
            character_name=_CHARACTER,
            identity_name=_IDENTITY_NAME,
            appearance_details="青衣佩剑",
            face_prompt="clear eyes",
            age_group="youth",
        )
        character = NovelCharacter(
            name=_CHARACTER,
            role="主角",
            is_main=True,
            face_prompt="sharp eyes",
            description="少年侠客",
        )
        character.identities = [identity]
        self.characters = {character.name: character}
        self.props = {
            _PROP: NovelProp(
                name=_PROP,
                aliases=["玉坠"],
                prop_type="artifact",
                visual_prompt="warm jade pendant",
                description="通透玉佩",
                owner=_CHARACTER,
            )
        }

    def get_all_characters(self):
        return list(self.characters.values())

    def get_character(self, name: str):
        return self.characters.get(name)

    async def add_character(self, character: NovelCharacter):
        self.characters[character.name] = character

    async def update_character(self, name: str, **updates):
        character = self.characters[name]
        for key, value in updates.items():
            setattr(character, key, value)

    async def rename_character(self, old_name: str, new_name: str):
        character = self.characters.pop(old_name)
        character.name = new_name
        self.characters[new_name] = character
        return True

    async def delete_character(self, name: str):
        self.characters.pop(name, None)
        return True

    async def add_character_identity(self, name: str, identity: CharacterIdentity):
        character = self.characters[name]
        character.identities = [*character.identities, identity]

    async def update_character_identity(self, name: str, identity_id: str, **updates):
        character = self.characters[name]
        identities = character.identities
        for identity in identities:
            if identity.identity_id == identity_id:
                for key, value in updates.items():
                    setattr(identity, key, value)
        character.identities = identities
        return True

    async def delete_character_identity(self, name: str, identity_id: str):
        character = self.characters[name]
        character.identities = [
            identity for identity in character.identities if identity.identity_id != identity_id
        ]
        return True

    async def delete_identity_image(self, name: str, identity_id: str):
        await self.update_character_identity(name, identity_id, reference_images=[])
        return True

    async def list_props(self):
        return list(self.props.values())

    async def get_prop(self, name: str):
        return self.props.get(name)

    async def add_prop(self, prop: NovelProp):
        self.props[prop.name] = prop

    async def update_prop(self, name: str, **updates):
        prop = self.props[name]
        for key, value in updates.items():
            setattr(prop, key, value)
        return True

    async def rename_prop(self, old_name: str, new_name: str):
        prop = self.props.pop(old_name)
        prop.name = new_name
        self.props[new_name] = prop
        return True

    async def delete_prop(self, name: str):
        return self.props.pop(name, None) is not None

    async def list_episodes(self):
        return []

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "speaker": "",
                "narration_segment": "风起。",
            }
        ]


class _FakeTaskBackend:
    def __init__(self, backend: str):
        self.backend = backend
        self.queue = "inline" if backend == "inline" else "default"
        self.calls: list[dict] = []

    async def enqueue_project_task(self, ctx, **kwargs):
        self.calls.append({"ctx": ctx, **kwargs})
        task_type = kwargs["task_type"]
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{self.backend}-{task_type}"),
            backend=self.backend,
            queue=self.queue,
        )


@pytest.fixture()
def m04_client_factory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from novelvideo import project_config
    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import characters, generation, projects, props, styles
    from novelvideo.services.style_service import StyleService

    store = _M04Store()
    project_dir = tmp_path / "output" / "alice" / _PROJECT
    state_dir = tmp_path / "state" / "alice" / _PROJECT
    runtime_dir = tmp_path / "runtime" / "alice" / _PROJECT
    for path in (project_dir, state_dir, runtime_dir):
        path.mkdir(parents=True, exist_ok=True)
    store.project_dir = str(project_dir)
    (project_dir / "assets" / "characters" / _CHARACTER).mkdir(parents=True, exist_ok=True)
    portrait = project_dir / "assets" / "characters" / _CHARACTER / "portrait.png"
    portrait.write_bytes(_png_bytes())
    portrait.with_name("portrait_20260101010101.png").write_bytes(_png_bytes())
    source_audio = project_dir / "audio" / "ep001" / "beat_01.mp3"
    source_audio.parent.mkdir(parents=True, exist_ok=True)
    source_audio.write_bytes(b"voice-source")

    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "output", raising=False)
    monkeypatch.setattr(project_config, "STATE_DIR", tmp_path / "state", raising=False)
    monkeypatch.setattr(
        characters,
        "character_image_selection_options",
        lambda: {"mock": "Mock Image"},
    )
    monkeypatch.setattr(characters, "get_character_image_selection", lambda: "mock")
    monkeypatch.setattr(characters, "get_image_usage_summary", lambda **_: {"total": 0})
    monkeypatch.setattr(characters, "load_project_config", lambda *_: {"visual_style": "mock"})
    monkeypatch.setattr(characters, "load_project_config_file", lambda *_: {})
    monkeypatch.setattr(characters, "update_project_config_file", lambda *_, **__: None)
    monkeypatch.setattr(props, "load_project_config_file", lambda *_: {"visual_style": "mock"})

    ctx = SimpleNamespace(
        project_id="proj_m04",
        project_name=_PROJECT,
        owner_username="alice",
        owner_project_label=f"alice/{_PROJECT}",
        output_dir=project_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )
    resolution = ProjectResolution(
        ctx=ctx,
        username="alice",
        project_name=_PROJECT,
        project_dir=project_dir,
        output_dir=str(project_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
    )

    async def resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        assert project == _PROJECT
        return resolution

    async def resolve_project_context(
        *, user: dict, project_id: str, required_role: str = "viewer"
    ):
        assert project_id == _PROJECT
        return ctx

    async def resolve_character_project(project: str, user: dict, *, required_role: str = "editor"):
        assert project == _PROJECT
        return ctx, "alice", _PROJECT, project_dir, str(project_dir), store

    async def make_store_for_context(_ctx):
        return store

    async def make_store(_username: str, _project: str):
        return store

    def static_url(_ctx, rel_path: str, local_path=None):
        return f"/static/projects/proj_m04/{rel_path}"

    for module in (characters, props, styles, generation):
        monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(projects, "resolve_project_context", resolve_project_context)
    monkeypatch.setattr(generation, "_resolve_generation_project", resolve_project_scope)
    monkeypatch.setattr(characters, "_resolve_character_project", resolve_character_project)
    monkeypatch.setattr(props, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(props, "make_sqlite_store", make_store)
    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(generation, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(generation, "make_sqlite_store", make_store)
    monkeypatch.setattr(generation, "get_state_dir", lambda *_: str(state_dir))
    for module in (characters, props, projects):
        monkeypatch.setattr(module, "make_static_url_for_context", static_url)

    async def no_prereq_errors(**_kwargs):
        return []

    monkeypatch.setattr(generation, "_collect_audio_prereq_errors", no_prereq_errors)
    monkeypatch.setattr(
        characters,
        "trim_existing_character_voice_file",
        lambda **_: ("assets/characters/林昭/voice/default.mp3", "sha-trim", "2026-01-01T00:00:00"),
    )
    monkeypatch.setattr(
        projects,
        "trim_voice_sample_content",
        lambda content, **_: (b"trimmed-voice", "voice.mp3"),
    )

    async def fake_character_reference(**kwargs):
        out_dir = Path(kwargs["output_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "generated.png"
        target.write_bytes(_png_bytes())
        return [str(target)]

    async def fake_identity_image(**kwargs):
        Path(kwargs["output_path"]).write_bytes(_png_bytes())
        return {"success": True}

    import novelvideo.generators as generators_pkg
    from novelvideo.generators import image_generator

    monkeypatch.setattr(
        image_generator, "generate_character_reference_unified", fake_character_reference
    )
    monkeypatch.setattr(
        generators_pkg, "generate_character_reference_unified", fake_character_reference
    )
    monkeypatch.setattr(image_generator, "generate_identity_image_unified", fake_identity_image)

    custom_style = StyleConfig(
        id="custom_drama",
        name="自定义剧集风格",
        label="自定义剧集风格",
        style_instructions="cinematic",
        avoid_instructions="flat",
        style_tag="LIVE",
    )
    monkeypatch.setattr(StyleService, "list_all_styles", lambda **_: [custom_style.model_dump()])
    monkeypatch.setattr(StyleService, "get_style", lambda style_id, **_: custom_style)
    monkeypatch.setattr(StyleService, "get_preset", lambda style_id: None)
    monkeypatch.setattr(StyleService, "save_custom_style", lambda *_, **__: True)
    monkeypatch.setattr(StyleService, "delete_custom_style", lambda *_, **__: True)

    from novelvideo.generators import style_analyzer

    class FakeStyleAnalyzer:
        async def analyze(self, content: bytes, *, mime_type: str):
            return {"style": "cinematic", "bytes": len(content), "mime_type": mime_type}

    monkeypatch.setattr(style_analyzer, "StyleAnalyzer", FakeStyleAnalyzer)

    def build(backend: str = "inline"):
        task_backend = _FakeTaskBackend(backend)
        for module in (characters, props, generation):
            monkeypatch.setattr(module, "get_task_backend", lambda tb=task_backend: tb)
        app = FastAPI()
        app.include_router(characters.router, prefix="/api/v1")
        app.include_router(props.router, prefix="/api/v1")
        app.include_router(styles.router, prefix="/api/v1")
        app.include_router(projects.router, prefix="/api/v1")
        app.include_router(generation.router, prefix="/api/v1")
        user = {
            "id": "local",
            "user_id": "local",
            "username": "alice",
            "role": "owner",
        }
        for dep in (
            api_auth.get_api_user,
            characters.get_api_user,
            props.get_api_user,
            styles.get_api_user,
            projects.get_api_user,
            generation.get_api_user,
        ):
            app.dependency_overrides[dep] = lambda user=user: user
        return TestClient(app), task_backend, project_dir

    return build


def _assert_ok(response):
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    return payload


def _assert_task_shape(payload: dict, *, backend: str, task_type: str):
    assert payload["ok"] is True
    assert payload["task_type"] == task_type
    assert payload["task_id"]
    assert payload["task_key"]
    assert payload["backend"] == backend
    assert payload["queue"] == ("inline" if backend == "inline" else "default")


def test_prop_reference_generation_accepts_image_source_model(m04_client_factory):
    client, task_backend, _project_dir = m04_client_factory("inline")

    payload = client.post(
        f"/api/v1/projects/{_PROJECT}/props/{_PROP}/reference/generate-async",
        json={"model": "newapi_nanobanana2"},
    ).json()
    _assert_task_shape(
        payload,
        backend="inline",
        task_type="prop_reference_asset",
    )

    assert payload["ok"] is True
    assert task_backend.calls[-1]["payload"]["model"] == "newapi_nanobanana2"


def test_m04_l2_exercises_all_57_endpoint_contracts(m04_client_factory):
    client, _backend, project_dir = m04_client_factory("inline")
    png = _png_bytes()
    voice_data_url = f"data:audio/wav;base64,{base64.b64encode(b'voice').decode('ascii')}"

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/characters"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/characters", json={"name": "秦昭"}))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/characters/build"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/character-image-selection"))
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/character-image-selection",
            json={"character_image_selection": "mock"},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/character-image-usage"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities"))
    _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/asset-history",
            params={"kind": "portrait"},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/asset-history/restore",
            json={"kind": "portrait", "history_id": "portrait_20260101010101.png"},
        )
    )
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}",
            json={"description": "updated"},
        )
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/characters/秦昭/delete"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/voice-samples"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/voice-samples/default/upload",
            files={"file": ("voice.wav", b"voice", "audio/wav")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/voice-samples/default/record",
            json={"data_url": voice_data_url},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/voice-samples/default/trim",
            json={
                "source_path": "assets/characters/林昭/voice/default.wav",
                "start_seconds": 0,
                "duration_seconds": 1,
            },
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/voice-samples/default/delete"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities",
            json={"identity_name": "少年", "appearance_details": "短衣"},
        )
    )
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/林昭_少年",
            json={"appearance_details": "短衣劲装"},
        )
    )
    _assert_ok(
        client.delete(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/林昭_少年")
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/portrait-async"))
    _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/portrait", json={})
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/portrait/upload",
            files={"file": ("portrait.png", png, "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_NAME}/upload",
            files={"file": ("identity.png", png, "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/image/delete"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/costume/upload",
            files={"file": ("costume.png", png, "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/costume/delete"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/portrait/upload",
            files={"file": ("identity-portrait.png", png, "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/portrait/generate-async"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/portrait/generate"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/generate-async"
        )
    )
    _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/attempts"
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/generate"
        )
    )

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/props", params={"scope": "all"}))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/props",
            json={"name": "令牌", "visual_prompt": "bronze token"},
        )
    )
    (project_dir / "assets" / "props" / "令牌").mkdir(parents=True, exist_ok=True)
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/props/令牌",
            json={"name": "铜令", "description": "updated"},
        )
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/props/铜令/delete"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/props/{_PROP}/reference/generate-async"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/props/reference/batch-generate"))

    _assert_ok(client.get("/api/v1/styles", params={"project": _PROJECT}))
    _assert_ok(client.get("/api/v1/styles/custom_drama", params={"project": _PROJECT}))
    assert (
        client.get("/api/v1/styles/custom_drama/preview", params={"project": _PROJECT}).status_code
        == 200
    )
    _assert_ok(
        client.post(
            "/api/v1/styles",
            json={
                "id": "fresh_style",
                "name": "新风格",
                "project": _PROJECT,
                "config": {"style_instructions": "cinematic"},
            },
        )
    )
    _assert_ok(client.delete("/api/v1/styles/fresh_style", params={"project": _PROJECT}))
    assert (
        client.post("/api/v1/styles/custom_drama/preview", json={"project": _PROJECT}).status_code
        == 200
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/styles/analyze",
            files={"file": ("style.png", png, "image/png")},
        )
    )

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/narrator-voice"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/narrator-voice/sources"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/narrator-voice/upload",
            files={"file": ("voice.wav", b"voice", "audio/wav")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/narrator-voice/record",
            json={"data_url": voice_data_url},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/narrator-voice/copy",
            json={"source_path": str(project_dir / "audio" / "ep001" / "beat_01.mp3")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/narrator-voice/trim",
            json={"start_seconds": 0, "duration_seconds": 1},
        )
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/narrator-voice/delete"))

    assert (
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/tts/generate", json={}).status_code
        == 410
    )
    assert (
        client.post(f"/api/v1/projects/{_PROJECT}/tts/preview", json={"text": "hello"}).status_code
        == 410
    )
    assert client.get(f"/api/v1/projects/{_PROJECT}/tts/voices").status_code == 410
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/audio/generate", json={}))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/audio"))


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_m04_task_backend_responses_are_ce_ee_isomorphic(m04_client_factory, backend: str):
    client, task_backend, _project_dir = m04_client_factory(backend)

    cases = [
        (
            "build_characters",
            client.post(f"/api/v1/projects/{_PROJECT}/characters/build"),
        ),
        (
            "character_portrait",
            client.post(f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/portrait-async"),
        ),
        (
            "identity_image",
            client.post(
                f"/api/v1/projects/{_PROJECT}/characters/{_CHARACTER}/identities/{_IDENTITY_ID}/generate-async"
            ),
        ),
        (
            "prop_reference_asset",
            client.post(f"/api/v1/projects/{_PROJECT}/props/{_PROP}/reference/generate-async"),
        ),
        (
            "batch_prop_ref",
            client.post(f"/api/v1/projects/{_PROJECT}/props/reference/batch-generate"),
        ),
        (
            "audio_generation_indextts2",
            client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/audio/generate", json={}),
        ),
        (
            "audio_generation_indextts2",
            client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/audio"),
        ),
    ]

    for task_type, response in cases:
        assert response.status_code == 200
        _assert_task_shape(response.json(), backend=backend, task_type=task_type)

    assert [call["task_type"] for call in task_backend.calls] == [
        "build_characters",
        "character_portrait",
        "identity_image",
        "prop_reference_asset",
        "batch_prop_ref",
        "audio_generation_indextts2",
        "audio_generation_indextts2",
    ]


def test_m04_legacy_tts_routes_return_410_with_indextts2_hint(m04_client_factory):
    client, _backend, _project_dir = m04_client_factory("inline")

    responses = [
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/tts/generate", json={}),
        client.post(f"/api/v1/projects/{_PROJECT}/tts/preview", json={"text": "hello"}),
        client.get(f"/api/v1/projects/{_PROJECT}/tts/voices"),
    ]

    for response in responses:
        assert response.status_code == 410
        assert "IndexTTS2" in json.dumps(response.json(), ensure_ascii=False)
