from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import CharacterIdentity, NovelCharacter, NovelEpisode, NovelProp, NovelScene
from novelvideo.project_context import ProjectContext

pytestmark = pytest.mark.m06


_PROJECT = "demo"
_PROJECT_ID = "proj_m06"
_USER = "alice"
_CHARACTER = "林昭"
_IDENTITY_ID = "林昭_青年"
_SCENE = "雨巷"
_PROP = "旧伞"


def _png_bytes() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=(90, 120, 150)).save(buf, format="PNG")
    return buf.getvalue()


def _write_png(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_png_bytes())
    return path


def _write_media(path: Path, content: bytes = b"media") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


class _M06Store:
    def __init__(self):
        identity = CharacterIdentity(
            identity_id=_IDENTITY_ID,
            character_name=_CHARACTER,
            identity_name="青年",
            appearance_details="青衣短打",
            face_prompt="clear eyes",
            age_group="youth",
        )
        character = NovelCharacter(
            name=_CHARACTER,
            role="主角",
            is_main=True,
            face_prompt="sharp eyes",
            description="雨巷少年",
        )
        character.identities = [identity]
        self._characters = {character.name: character}
        self._episodes = {
            1: NovelEpisode(
                number=1,
                title="雨巷初遇",
                raw_content="第一章 雨巷初遇\n林昭撑伞走进雨巷。",
            )
        }
        self._scenes = {
            _SCENE: NovelScene(
                name=_SCENE,
                scene_type="exterior",
                environment_prompt="wet stone alley",
                description="雨夜石板巷",
            )
        }
        self._props = {
            _PROP: NovelProp(
                name=_PROP,
                prop_type="artifact",
                visual_prompt="old oil-paper umbrella",
                description="旧油纸伞",
                owner=_CHARACTER,
            )
        }
        self._sketch_colors = {1: {_IDENTITY_ID: "#6b8cff"}}

    def get_all_characters(self):
        return list(self._characters.values())

    def get_character(self, name: str):
        return self._characters.get(name)

    async def add_character_identity(self, name: str, identity: CharacterIdentity):
        self._characters[name].identities = [*self._characters[name].identities, identity]

    async def update_character_identity(self, name: str, identity_id: str, **updates):
        for identity in self._characters[name].identities:
            if identity.identity_id == identity_id:
                for key, value in updates.items():
                    setattr(identity, key, value)
        return True

    async def touch_identity(self, _name: str, _identity_id: str):
        return True

    async def list_props(self):
        return list(self._props.values())

    async def list_scenes(self):
        return list(self._scenes.values())

    async def get_episode_from_graph(self, episode: int):
        return self._episodes[episode]

    async def get_graph_snapshot(self):
        return {
            "nodes": [
                {
                    "id": "character-1",
                    "label": _CHARACTER,
                    "type": "Entity",
                    "degree": 1,
                    "properties": {"description": "雨巷少年"},
                },
                {
                    "id": "scene-1",
                    "label": _SCENE,
                    "type": "Entity",
                    "degree": 1,
                    "properties": {},
                },
            ],
            "edges": [
                {
                    "id": "edge-1",
                    "source": "character-1",
                    "target": "scene-1",
                    "relation": "appears_in",
                    "properties": {},
                }
            ],
            "total_nodes": 2,
            "total_edges": 1,
            "truncated": False,
        }

    async def list_visual_beats(self):
        return []

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "episode_number": 1,
                "visual_description": "林昭在{{林昭_青年}}身旁撑起[[旧伞]]。",
                "narration_segment": "雨声压低了脚步。",
                "scene_id": _SCENE,
                "detected_identities": [_IDENTITY_ID],
                "detected_props": [_PROP],
            }
        ]

    def get_sketch_colors(self, episode: int):
        return dict(self._sketch_colors.get(int(episode), {}))

    async def set_sketch_colors(self, episode: int, colors: dict):
        self._sketch_colors[int(episode)] = dict(colors or {})

    async def close(self):
        return None


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


class _FakeTaskManager:
    def __init__(self):
        self.tasks: dict[tuple[str, str], SimpleNamespace] = {}

    def set_completed(self, task_type: str, job_id: str, result: dict | None = None):
        self.tasks[(task_type, job_id)] = SimpleNamespace(
            status="completed",
            result=result or {},
            error=None,
            logs=[],
            current_task="done",
        )

    def get_task_for_project(self, _ctx, task_type: str, _episode: int, *, scope: str):
        return self.tasks.get((task_type, scope))

    def get_task(self, task_type: str, _username: str, _project: str, _episode: int, *, scope: str):
        return self.tasks.get((task_type, scope))


@pytest.fixture()
def m06_client_factory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import freezone, ingest
    from novelvideo.freezone.paths import uploads_dir
    from novelvideo.utils.path_resolver import (
        canonical_beat_director_env_only_path,
        canonical_beat_selected_background_path,
        canonical_identity_path,
        canonical_portrait_path,
        canonical_prop_reference_path,
        canonical_scene_master_path,
        canonical_scene_reverse_master_path,
    )

    store = _M06Store()
    project_dir = tmp_path / "output" / _USER / _PROJECT
    state_dir = tmp_path / "state" / _USER / _PROJECT
    runtime_dir = tmp_path / "runtime" / _USER / _PROJECT
    for path in (project_dir, state_dir, runtime_dir):
        path.mkdir(parents=True, exist_ok=True)

    source_image = _write_png(uploads_dir(project_dir) / "source.png")
    mask_image = _write_png(uploads_dir(project_dir) / "mask.png")
    video_file = _write_media(uploads_dir(project_dir) / "clip.mp4", b"video")
    audio_file = _write_media(uploads_dir(project_dir) / "voice.mp3", b"audio")
    scene_master = _write_png(canonical_scene_master_path(project_dir, _SCENE))
    scene_reverse = _write_png(canonical_scene_reverse_master_path(project_dir, _SCENE))
    selected_background = _write_png(canonical_beat_selected_background_path(project_dir, 1, 1))
    env_only = _write_png(canonical_beat_director_env_only_path(project_dir, 1, 1))
    portrait = _write_png(canonical_portrait_path(project_dir, _CHARACTER))
    identity = _write_png(canonical_identity_path(project_dir, _CHARACTER, _IDENTITY_ID))
    prop = _write_png(canonical_prop_reference_path(project_dir, _PROP))
    uploads_dir(project_dir).mkdir(parents=True, exist_ok=True)

    ctx = ProjectContext(
        project_id=_PROJECT_ID,
        project_name=_PROJECT,
        owner_type="user",
        owner_id="user-alice",
        owner_username=_USER,
        requester_user_id="user-alice",
        requester_username=_USER,
        requester_principals=(("user", "user-alice"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=project_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )
    resolution = ProjectResolution(
        ctx=ctx,
        username=_USER,
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

    async def make_store_for_context(_ctx):
        return store

    async def beat_for_capture(*_args, **_kwargs):
        return (await store.get_beats_as_dicts(1))[0]

    async def compute_impact(_username, _project_name, target):
        return [{"episode": 1, "beat": 1, "kind": target.kind}]

    async def build_beat_context(**_kwargs):
        return {
            "beat_data": (await store.get_beats_as_dicts(1))[0],
            "refs": [],
            "sketch_context": {"sketch_colors": {}, "prop_marker_colors": {}},
        }

    def static_url(_ctx, rel_path: str, local_path=None):
        return f"/static/projects/{_PROJECT_ID}/{rel_path}"

    monkeypatch.setattr(ingest, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(freezone, "resolve_project_context", resolve_project_context)
    monkeypatch.setattr(freezone, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(freezone, "make_cognee_store_for_context", make_store_for_context)
    monkeypatch.setattr(freezone, "make_static_url_for_context", static_url)
    monkeypatch.setattr(freezone, "_beat_for_capture", beat_for_capture)
    monkeypatch.setattr(freezone, "compute_slot_impact", compute_impact)
    monkeypatch.setattr(freezone, "build_beat_preset_context", build_beat_context)

    assets = SimpleNamespace(
        image_url=f"/static/{_USER}/{_PROJECT}/freezone/_uploads/source.png",
        mask_url=f"/static/{_USER}/{_PROJECT}/freezone/_uploads/mask.png",
        video_url=f"/static/{_USER}/{_PROJECT}/freezone/_uploads/clip.mp4",
        audio_url=f"/static/{_USER}/{_PROJECT}/freezone/_uploads/voice.mp3",
        scene_master_url=f"/static/{_USER}/{_PROJECT}/assets/scenes/{_SCENE}/master.png",
        scene_reverse_url=f"/static/{_USER}/{_PROJECT}/assets/scenes/{_SCENE}/reverse_master.png",
        selected_background_url=(
            f"/static/{_USER}/{_PROJECT}/director_control_frames/ep001/"
            "beat_01/selected_background.png"
        ),
        source_image=source_image,
        mask_image=mask_image,
        video_file=video_file,
        audio_file=audio_file,
        scene_master=scene_master,
        scene_reverse=scene_reverse,
        selected_background=selected_background,
        env_only=env_only,
        portrait=portrait,
        identity=identity,
        prop=prop,
        ctx=ctx,
        freezone=freezone,
    )

    def build(backend: str = "inline"):
        task_backend = _FakeTaskBackend(backend)
        task_manager = _FakeTaskManager()
        monkeypatch.setattr(ingest, "get_task_backend", lambda tb=task_backend: tb)
        monkeypatch.setattr(freezone, "get_task_backend", lambda tb=task_backend: tb)
        monkeypatch.setattr(freezone, "get_task_manager", lambda tm=task_manager: tm)
        app = FastAPI()
        app.include_router(ingest.router, prefix="/api/v1")
        app.include_router(freezone.router, prefix="/api/v1")
        user = {
            "id": "user-alice",
            "user_id": "user-alice",
            "username": _USER,
            "role": "owner",
        }
        app.dependency_overrides[api_auth.get_api_user] = lambda user=user: user
        app.dependency_overrides[ingest.get_api_user] = lambda user=user: user
        app.dependency_overrides[freezone.get_api_user] = lambda user=user: user

        async def override_cognee_store():
            yield store

        app.dependency_overrides[ingest.get_cognee_store] = override_cognee_store
        return TestClient(app), task_backend, task_manager, project_dir, assets, store

    return build


def _assert_ok(response):
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    return payload


def _task_data(payload: dict) -> dict:
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


def _assert_task_shape(payload: dict, *, backend: str, task_type: str) -> dict:
    data = _task_data(payload)
    assert data["task_type"] == task_type
    assert data["job_id"]
    assert data["task_key"]
    assert data["backend"] == backend
    assert data["queue"] == ("inline" if backend == "inline" else "default")
    assert data.get("task_id")
    return data


def _assert_freezone_http_task_shape(payload: dict, *, task_type: str) -> dict:
    data = _task_data(payload)
    assert data["task_type"] == task_type
    assert data["job_id"]
    assert data["task_key"]
    return data


def _assert_helper_task_shape(payload: dict, *, backend: str, task_type: str) -> dict:
    data = _task_data(payload)
    assert data["task_type"] == task_type
    assert data["job_id"]
    assert data["task_key"]
    assert data["backend"] == backend
    assert data["queue"] == ("inline" if backend == "inline" else "default")
    assert data.get("task_id")
    return data


def _assert_skill_task_shape(payload: dict, *, task_type: str):
    assert payload["status"] == "queued"
    assert payload["task_type"] == task_type
    assert payload["job_id"]
    assert payload["task_key"]
    assert payload["run_id"] == f"{task_type}:{payload['job_id']}"


def test_m06_ingest_upload_preview_and_unsupported_format(m06_client_factory):
    client, _backend, _task_manager, _project_dir, _assets, _store = m06_client_factory("inline")

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/ingest/upload",
        files={
            "file": (
                "novel.txt",
                "第一章 雨巷\n林昭撑伞。\n\n第二章 归途\n雨停了。",
                "text/plain",
            )
        },
    )
    payload = _assert_ok(response)
    data = payload["data"]
    assert data["filename"] == "novel.txt"
    assert data["size"] > 0
    assert data["chapters"]

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/ingest/upload",
        files={"file": ("archive.zip", b"zip", "application/zip")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error_type"] == "unsupported"


def test_m06_ingest_exposes_real_knowledge_graph_snapshot(m06_client_factory):
    client, _backend, _task_manager, _project_dir, _assets, _store = m06_client_factory("inline")

    response = client.get(f"/api/v1/projects/{_PROJECT}/ingest/graph")
    payload = _assert_ok(response)

    assert payload["data"]["total_nodes"] == 2
    assert payload["data"]["total_edges"] == 1
    assert payload["data"]["nodes"][0]["label"] == _CHARACTER
    assert payload["data"]["edges"][0]["relation"] == "appears_in"


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_m06_ingest_start_task_shape_is_ce_ee_isomorphic(m06_client_factory, backend: str):
    client, task_backend, _task_manager, project_dir, _assets, _store = m06_client_factory(backend)
    upload = project_dir / "uploads" / "novel.txt"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_text("第一章 雨巷\n林昭撑伞。", encoding="utf-8")

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/ingest/start",
        json={"filename": "novel.txt", "rebuild": False},
    )
    payload = _assert_ok(response)
    assert payload["task_type"] == "ingest_fast"
    assert payload["task_key"]
    assert payload["backend"] == backend
    assert payload["queue"] == ("inline" if backend == "inline" else "default")
    assert [call["task_type"] for call in task_backend.calls] == ["ingest_fast"]


def _freezone_task_cases(client: TestClient, assets: SimpleNamespace):
    p = _PROJECT
    image = assets.image_url
    video = assets.video_url
    return [
        (
            "freezone_gen",
            client.post(f"/api/v1/projects/{p}/freezone/gen", json={"prompt": "rain alley"}),
        ),
        (
            "sketch_generation",
            client.post(
                f"/api/v1/projects/{p}/freezone/sketch-from-context",
                json={"episode": 1, "beat": 1, "source_kind": "beat"},
            ),
        ),
        (
            "mainline_frame_from_context",
            client.post(
                f"/api/v1/projects/{p}/freezone/frame-from-context",
                json={"episode": 1, "beat": 1, "sketch_url": image},
            ),
        ),
        (
            "stage_asset",
            client.post(
                f"/api/v1/projects/{p}/freezone/scene-360",
                json={"reference_url": assets.scene_master_url, "mode": "candidate"},
            ),
        ),
        (
            "freezone_edit",
            client.post(
                f"/api/v1/projects/{p}/freezone/multi-view",
                json={"source_url": image, "prompt": "front view"},
            ),
        ),
        (
            "freezone_edit",
            client.post(
                f"/api/v1/projects/{p}/freezone/relight",
                json={"source_url": image, "prompt": "soft light"},
            ),
        ),
        (
            "freezone_edit",
            client.post(
                f"/api/v1/projects/{p}/freezone/template-edit",
                json={"source_url": image, "mode": "story_pitch_four_grid"},
            ),
        ),
        (
            "freezone_image_to_3gs",
            client.post(
                f"/api/v1/projects/{p}/freezone/image-to-3gs",
                json={"source_url": image, "source_kind": "master"},
            ),
        ),
        (
            "freezone_edit",
            client.post(f"/api/v1/projects/{p}/freezone/upscale", json={"source_url": image}),
        ),
        (
            "freezone_edit",
            client.post(f"/api/v1/projects/{p}/freezone/outpaint", json={"source_url": image}),
        ),
        (
            "freezone_edit",
            client.post(
                f"/api/v1/projects/{p}/freezone/redraw",
                json={"source_url": image, "prompt": "redraw"},
            ),
        ),
        (
            "freezone_image_reverse_prompt",
            client.post(
                f"/api/v1/projects/{p}/freezone/image/reverse-prompt",
                json={"source_url": image},
            ),
        ),
        (
            "freezone_edit",
            client.post(
                f"/api/v1/projects/{p}/freezone/edit",
                json={"base_url": image, "prompt": "edit"},
            ),
        ),
        (
            "freezone_extract",
            client.post(
                f"/api/v1/projects/{p}/freezone/extract-frames",
                json={"video_url": video, "max_frames": 3},
            ),
        ),
        (
            "freezone_analyze",
            client.post(
                f"/api/v1/projects/{p}/freezone/analyze-shots",
                json={"frame_urls": [image]},
            ),
        ),
        (
            "freezone_video_story",
            client.post(
                f"/api/v1/projects/{p}/freezone/analyze-video-story",
                json={"video_url": video, "max_frames": 3},
            ),
        ),
        (
            "freezone_video_gen",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/gen",
                json={"prompt": "rain alley video"},
            ),
        ),
        (
            "freezone_video_gen",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/i2v",
                json={"image_urls": [image], "prompt": "move"},
            ),
        ),
        (
            "freezone_video_gen",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/keyframes",
                json={"first_frame_url": image, "prompt": "move"},
            ),
        ),
        (
            "freezone_video_gen",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/omni-gen",
                json={
                    "prompt": "omni",
                    "references": [{"type": "image", "url": image, "role": "reference"}],
                },
            ),
        ),
        (
            "freezone_video_erase",
            client.post(f"/api/v1/projects/{p}/freezone/video/erase", json={"source_url": video}),
        ),
        (
            "freezone_video_upscale",
            client.post(f"/api/v1/projects/{p}/freezone/video/upscale", json={"source_url": video}),
        ),
        (
            "freezone_audio_separate",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/audio-separate",
                json={"source_url": video},
            ),
        ),
        (
            "freezone_video_compose",
            client.post(
                f"/api/v1/projects/{p}/freezone/video/compose",
                json={
                    "title": "compose",
                    "tracks": [
                        {
                            "track_id": "v1",
                            "kind": "video",
                            "items": [
                                {
                                    "item_id": "clip1",
                                    "source_url": video,
                                    "source_start": 0,
                                    "source_end": 1,
                                }
                            ],
                        }
                    ],
                },
            ),
        ),
        (
            "freezone_text_translate",
            client.post(
                f"/api/v1/projects/{p}/freezone/text/translate",
                json={"text": "hello", "node_type": "text"},
            ),
        ),
        (
            "freezone_story_script",
            client.post(
                f"/api/v1/projects/{p}/freezone/text/story-script",
                json={"source_text": "雨巷里，林昭撑伞。"},
            ),
        ),
        (
            "freezone_audio_speech",
            client.post(
                f"/api/v1/projects/{p}/freezone/audio/speech",
                json={"text": "雨声压低了脚步。"},
            ),
        ),
        (
            "freezone_audio_eleven_music",
            client.post(
                f"/api/v1/projects/{p}/freezone/audio/eleven-music",
                json={"input": "cinematic rain-soaked suspense music"},
            ),
        ),
    ]


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_m06_freezone_task_backend_responses_are_ce_ee_isomorphic(
    m06_client_factory, backend: str
):
    client, task_backend, _task_manager, _project_dir, assets, _store = m06_client_factory(backend)

    cases = _freezone_task_cases(client, assets)
    assert len(cases) == 28
    for task_type, response in cases:
        assert response.status_code == 200, response.text
        _assert_freezone_http_task_shape(response.json(), task_type=task_type)

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/freezone/skills/freezone.sketch_from_context/run",
        json={
            "schema_version": "skill.v1",
            "skill_node_id": "skill-node",
            "canvas_id": "canvas-skill",
            "parameters": {"aspect_ratio": "2:3"},
            "resolved_inputs": [
                {
                    "role": "beat_context",
                    "node_id": "beat",
                    "node_type": "beatContextNode",
                    "beat_context": {
                        "episode": 1,
                        "beat": 1,
                        "visual_description": "林昭在雨巷中。",
                    },
                },
                {
                    "role": "background",
                    "node_id": "bg",
                    "node_type": "imageNode",
                    "image_url": assets.image_url,
                },
            ],
        },
    )
    assert response.status_code == 200, response.text
    _assert_skill_task_shape(response.json(), task_type="mainline_sketch_from_context")

    assert len(task_backend.calls) == len(cases) + 1
    assert {call["task_type"] for call in task_backend.calls} >= {
        "freezone_gen",
        "freezone_edit",
        "freezone_image_to_3gs",
        "freezone_extract",
        "freezone_analyze",
        "freezone_video_story",
        "freezone_video_gen",
        "freezone_video_compose",
        "freezone_text_translate",
        "freezone_story_script",
        "freezone_audio_speech",
        "freezone_audio_eleven_music",
    }


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_m06_freezone_task_backend_l1_helper_payloads_keep_backend_and_queue(
    m06_client_factory, backend: str
):
    _client, _task_backend, _task_manager, project_dir, assets, _store = m06_client_factory(backend)
    freezone = assets.freezone

    async def run_helpers():
        image = await freezone._start_or_enqueue_freezone_gen_job(
            ctx=assets.ctx,
            username=_USER,
            project=_PROJECT,
            project_dir=project_dir,
            output_dir=str(project_dir),
            prompt="l1 image",
            aspect_ratio="1:1",
            image_size="2K",
            reference_urls=[],
            camera=None,
            style=None,
            provider=None,
            model=None,
            quality="medium",
        )
        text = await freezone._enqueue_freezone_background_job(
            ctx=assets.ctx,
            project_dir=project_dir,
            task_type="freezone_text_translate",
            job_id="l1-text",
            payload={"text": "hello", "node_type": "text"},
        )
        return image, text

    image_payload, text_payload = asyncio.run(run_helpers())
    _assert_helper_task_shape(image_payload, backend=backend, task_type="freezone_gen")
    _assert_helper_task_shape(text_payload, backend=backend, task_type="freezone_text_translate")


def test_m06_freezone_job_result_reads_terminal_output(m06_client_factory):
    client, _backend, task_manager, project_dir, _assets, _store = m06_client_factory("inline")

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/freezone/gen",
        json={"prompt": "terminal output"},
    )
    data = _assert_freezone_http_task_shape(response.json(), task_type="freezone_gen")
    out = project_dir / "freezone" / "_outputs" / "freezone_gen" / f"{data['job_id']}.png"
    _write_png(out)
    task_manager.set_completed("freezone_gen", data["job_id"], {"output_path": str(out)})

    result = _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/freezone/jobs/freezone_gen/{data['job_id']}/result"
        )
    )
    assert result["data"]["url"].startswith(f"/static/projects/{_PROJECT_ID}/")
    assert out.parent.name == "freezone_gen"


def test_m06_freezone_canvas_crud_revision_idempotency_history_and_default_guard(
    m06_client_factory,
):
    client, _backend, _task_manager, _project_dir, _assets, _store = m06_client_factory("inline")

    first_init = _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/freezone/init"))
    second_init = _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/freezone/init"))
    assert first_init["data"]["default_canvas"]["canvas_id"] == "default"
    assert second_init["data"]["default_canvas"]["canvas_id"] == "default"

    created = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/freezone/canvases:from-preset",
            json={"scope": "blank", "canvas_id": "acceptance_canvas"},
        )
    )
    canvas_id = created["data"]["canvas_id"]
    assert canvas_id.startswith("blank_")
    assert created["data"]["reused"] is False

    listing = _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/freezone/canvases"))
    assert any(item["id"] == canvas_id for item in listing["data"])
    canvas = _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}"))
    revision = canvas["data"]["revision"]
    assert canvas["data"]["revision"] == revision
    assert revision >= 1

    saved = _assert_ok(
        client.put(
            f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}",
            json={
                "base_revision": revision,
                "client_save_id": "save-1",
                "nodes": [{"id": "node-1", "type": "textNode", "data": {"text": "hello"}}],
                "edges": [],
            },
        )
    )
    assert saved["data"]["revision"] == revision + 1
    idempotent = _assert_ok(
        client.put(
            f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}",
            json={
                "base_revision": revision,
                "client_save_id": "save-1",
                "nodes": [{"id": "node-1", "type": "textNode", "data": {"text": "hello"}}],
                "edges": [],
            },
        )
    )
    assert idempotent["data"]["client_save_id"] == "save-1"

    history = _assert_ok(
        client.get(f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}/history")
    )
    assert history["data"]
    history_id = history["data"][0]["history_id"]
    restored = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}/restore",
            json={"history_id": history_id, "base_revision": revision + 1},
        )
    )
    assert restored["data"]["restored"] is True

    deleted_default = _assert_ok(
        client.delete(f"/api/v1/projects/{_PROJECT}/freezone/canvases/default")
    )
    assert deleted_default["data"]["deleted"] is True
    deleted = _assert_ok(client.delete(f"/api/v1/projects/{_PROJECT}/freezone/canvases/{canvas_id}"))
    assert deleted["data"]["deleted"] is True


def test_m06_build_projection_from_preset_returns_local_graph_without_canvas_side_effect(
    m06_client_factory,
):
    client, _backend, _task_manager, project_dir, _assets, _store = m06_client_factory("inline")

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/freezone/projections:build-from-preset",
        json={
            "scope": "beat",
            "episode": 1,
            "beat": 1,
            "primary_slot": "sketch",
            "projection_key": "beat:1:1:sketch",
            "base_revision": 0,
        },
    )

    payload = _assert_ok(response)
    data = payload["data"]
    assert set(data) == {"projection_key", "facts_signature", "nodes", "edges", "metadata"}
    assert data["projection_key"] == "beat:1:1:sketch"
    assert data["facts_signature"]
    assert isinstance(data["nodes"], list)
    assert isinstance(data["edges"], list)
    assert data["metadata"]["last_projection_key"] == "beat:1:1:sketch"
    assert (
        data["metadata"]["projections"]["beat:1:1:sketch"]["facts_signature"]
        == data["facts_signature"]
    )
    assert not (project_dir / "freezone" / "canvases").exists()


def test_m06_build_projection_from_preset_rejects_invalid_preset_request(
    m06_client_factory,
):
    client, _backend, _task_manager, _project_dir, _assets, _store = m06_client_factory("inline")

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/freezone/projections:build-from-preset",
        json={
            "scope": "asset",
            "projection_key": "asset:missing",
            "base_revision": 0,
        },
    )

    assert response.status_code == 400
    assert "asset" in response.text


def test_m06_freezone_assets_are_m06_scoped_and_identity_creation_works(m06_client_factory):
    """api-coverage:40 keeps /freezone/assets in M06, not the M09 /projects/{p}/assets API."""
    client, _backend, _task_manager, _project_dir, assets, store = m06_client_factory("inline")

    asset_response = _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/freezone/assets"))
    assert any(item.get("tab") == "characters" for item in asset_response["data"])
    assert all("/projects/{p}/assets" not in item.get("id", "") for item in asset_response["data"])
    assert client.get(f"/api/v1/projects/{_PROJECT}/assets").status_code == 404

    beat_context = _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/freezone/assets/beat-context",
            params={"episode": 1, "beat": 1},
        )
    )
    assert beat_context["data"]["scope"] == {"episode": 1, "beat": 1}

    scene_assets = _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/freezone/scene-assets-for-beat",
            params={"episode": 1, "beat": 1},
        )
    )
    assert scene_assets["data"]["scene_id"] == _SCENE

    manifest = _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/freezone/director-capture",
            params={"episode": 1, "beat": 1},
        )
    )
    assert manifest["data"]["episode"] == 1
    synced = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/freezone/director-capture/sync-background",
            params={"episode": 1, "beat": 1},
        )
    )
    assert synced["data"]["beat"] == 1

    created = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/freezone/assets/identities",
            json={
                "source_url": assets.image_url,
                "character": _CHARACTER,
                "identity_name": "雨夜",
                "appearance_details": "湿发青衣",
            },
        )
    )
    assert created["data"]["identity_id"] == f"{_CHARACTER}_雨夜"
    assert any(i.identity_id == f"{_CHARACTER}_雨夜" for i in store.get_character(_CHARACTER).identities)


def test_m06_freezone_push_impact_writes_canonical_backup_and_stale_count(
    m06_client_factory,
):
    client, _backend, _task_manager, _project_dir, assets, _store = m06_client_factory("inline")
    target = {"kind": "identity", "character": _CHARACTER, "identity_id": _IDENTITY_ID}

    impact = _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/freezone/impact", json={"target": target})
    )
    assert impact["data"]["affected_count"] == 1

    pushed = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/freezone/push",
            json={"source_url": assets.image_url, "target": target, "mark_stale": True},
        )
    )
    data = pushed["data"]
    assert data["target_path"] == str(assets.identity)
    assert data["target_url"].startswith(f"/static/projects/{_PROJECT_ID}/")
    assert data["backup"]
    assert data["affected_count"] == 1
    assert data["stale_marked"] >= 0
