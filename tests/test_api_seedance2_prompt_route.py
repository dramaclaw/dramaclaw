from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo.project_context import ProjectContext


pytestmark = pytest.mark.m09


@dataclass
class DummySqliteStore:
    beats: list[dict]
    updates: list[dict] = field(default_factory=list)
    characters: list[dict] = field(default_factory=list)
    sketch_colors: dict[str, str] = field(default_factory=dict)

    async def get_script_as_dict(self, episode: int):
        return {"episode": episode, "beats": [dict(beat) for beat in self.beats]}

    def get_all_characters(self):
        return list(self.characters)

    def get_sketch_colors(self, episode_num: int):
        return dict(self.sketch_colors)

    async def update_beat_asset(self, episode_number: int, beat_number: int, **updates):
        self.updates.append(
            {"episode": episode_number, "beat": beat_number, "updates": updates}
        )
        for beat in self.beats:
            if int(beat.get("beat_number") or 0) == beat_number:
                beat.update(updates)
                return True
        return False


class DummyCogneeStore:
    pass


class DummyUsageMeter:
    def __init__(self):
        self.reserve_calls: list[dict] = []
        self.confirm_calls: list[tuple[str, dict | None]] = []
        self.refund_calls: list[tuple[str, dict | None]] = []
        self.contexts: list[dict] = []
        self.clear_count = 0

    async def reserve_feature_start_credits(self, **kwargs):
        self.reserve_calls.append(kwargs)
        return {"id": "seedance2-prompt-reservation", "cost": 9}

    async def confirm_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata=None,
    ):
        self.confirm_calls.append((reservation_id, metadata))

    async def refund_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata=None,
    ):
        self.refund_calls.append((reservation_id, metadata))

    def set_llm_usage_context(
        self,
        user_id: str,
        project_id: str = "",
        resource_kind: str = "",
        billing_metadata: dict | None = None,
    ):
        self.contexts.append(
            {
                "user_id": user_id,
                "project_id": project_id,
                "resource_kind": resource_kind,
                "billing_metadata": billing_metadata or {},
            }
        )

    def clear_llm_usage_context(self):
        self.clear_count += 1


def _client(
    monkeypatch,
    tmp_path,
    beats: list[dict],
    *,
    ctx=None,
    usage_meter=None,
):
    from novelvideo.api.routes import scripts
    from novelvideo.api.deps import ProjectResolution

    sqlite_store = DummySqliteStore(beats)

    async def _make_sqlite_store(username: str, project: str):
        return sqlite_store

    async def _make_cognee_store(username: str, project: str):
        return DummyCogneeStore()

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(scripts, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(scripts, "make_sqlite_store", _make_sqlite_store)
    monkeypatch.setattr(
        scripts,
        "make_sqlite_store_for_context",
        lambda _ctx: _make_sqlite_store("admin", "demo"),
    )
    monkeypatch.setattr(scripts, "make_cognee_store", _make_cognee_store)
    if usage_meter is not None:
        monkeypatch.setattr(scripts, "get_usage_meter", lambda: usage_meter)

    app = FastAPI()
    app.include_router(scripts.router)
    app.dependency_overrides[scripts.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app), sqlite_store


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="admin",
        requester_user_id="user_editor",
        requester_username="admin",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def test_generate_seedance2_prompt_updates_config_json(monkeypatch, tmp_path):
    from novelvideo.seedance2_i2v import panel_service

    saved_json = json.dumps(
        {
            "mode": "first_frame",
            "duration": 5,
            "resolution": "720p",
            "ratio": "9:16",
            "final_prompt": "optimized seedance2 prompt",
            "prompt_guidance": "more camera motion",
            "prompt_source": "generated",
        }
    )
    seen = {}

    async def _generate_seedance2_prompt_for_panel(**kwargs):
        seen.update(kwargs)
        beat = kwargs["beat"]
        beat["seedance2_config_json"] = saved_json
        await kwargs["store"].update_beat_asset(
            episode_number=kwargs["episode"],
            beat_number=int(beat["beat_number"]),
            seedance2_config_json=saved_json,
        )
        return saved_json

    monkeypatch.setattr(
        panel_service,
        "generate_seedance2_prompt_for_panel",
        _generate_seedance2_prompt_for_panel,
    )
    client, store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "seedance2_config_json": json.dumps(
                    {
                        "mode": "first_frame",
                        "duration": 5,
                        "resolution": "720p",
                        "ratio": "9:16",
                        "final_prompt": "current seedance2 prompt",
                    }
                ),
            },
            {"beat_number": 2},
        ],
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/seedance2-prompt/generate",
        json={
            "manual_prompt_reference": "current seedance2 prompt",
            "prompt_guidance": "more camera motion",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["final_prompt"] == "optimized seedance2 prompt"
    assert payload["data"]["seedance2_config_json"] == saved_json
    assert payload["data"]["beat"]["seedance2_config_json"] == saved_json
    assert seen["manual_prompt_reference"] == "current seedance2 prompt"
    assert seen["prompt_guidance"] == "more camera motion"
    assert seen["next_beat"]["beat_number"] == 2
    assert store.updates == [
        {
            "episode": 1,
            "beat": 1,
            "updates": {"seedance2_config_json": saved_json},
        }
    ]


def test_generate_seedance2_prompt_reserves_feature_credit_and_confirms(
    monkeypatch,
    tmp_path,
):
    from novelvideo.seedance2_i2v import panel_service

    saved_json = json.dumps(
        {
            "mode": "first_frame",
            "duration": 5,
            "resolution": "720p",
            "ratio": "9:16",
            "final_prompt": "optimized seedance2 prompt",
            "prompt_source": "generated",
        }
    )

    async def _generate_seedance2_prompt_for_panel(**kwargs):
        beat = kwargs["beat"]
        beat["seedance2_config_json"] = saved_json
        await kwargs["store"].update_beat_asset(
            episode_number=kwargs["episode"],
            beat_number=int(beat["beat_number"]),
            seedance2_config_json=saved_json,
        )
        return saved_json

    monkeypatch.setattr(
        panel_service,
        "generate_seedance2_prompt_for_panel",
        _generate_seedance2_prompt_for_panel,
    )
    usage_meter = DummyUsageMeter()
    ctx = _project_ctx(tmp_path)
    client, _store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "seedance2_config_json": json.dumps(
                    {
                        "mode": "first_frame",
                        "duration": 5,
                        "resolution": "720p",
                        "ratio": "9:16",
                    }
                ),
            }
        ],
        ctx=ctx,
        usage_meter=usage_meter,
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/seedance2-prompt/generate",
        json={"prompt_guidance": "more camera motion"},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert usage_meter.reserve_calls[0]["feature_key"] == "seedance2_prompt"
    assert usage_meter.reserve_calls[0]["resource_kind"] == "script"
    assert usage_meter.reserve_calls[0]["require_price_rule"] is True
    assert usage_meter.reserve_calls[0]["require_positive_cost"] is True
    assert usage_meter.contexts[0]["billing_metadata"][
        "model_call_credit_policy"
    ] == "feature_included"
    assert usage_meter.contexts[0]["billing_metadata"][
        "feature_credit_reservation_id"
    ] == "seedance2-prompt-reservation"
    assert usage_meter.confirm_calls[0][0] == "seedance2-prompt-reservation"
    assert usage_meter.refund_calls == []
    assert usage_meter.clear_count == 1


def test_generate_seedance2_prompt_refunds_feature_credit_on_failure(
    monkeypatch,
    tmp_path,
):
    from novelvideo.seedance2_i2v import panel_service

    async def _generate_seedance2_prompt_for_panel(**kwargs):
        raise ValueError("seedance2 prompt invalid")

    monkeypatch.setattr(
        panel_service,
        "generate_seedance2_prompt_for_panel",
        _generate_seedance2_prompt_for_panel,
    )
    usage_meter = DummyUsageMeter()
    client, _store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "seedance2_config_json": json.dumps(
                    {
                        "mode": "first_frame",
                        "duration": 5,
                        "resolution": "720p",
                        "ratio": "9:16",
                    }
                ),
            }
        ],
        ctx=_project_ctx(tmp_path),
        usage_meter=usage_meter,
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/seedance2-prompt/generate",
        json={"prompt_guidance": "more camera motion"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "seedance2 prompt invalid"}
    assert usage_meter.confirm_calls == []
    assert usage_meter.refund_calls[0][0] == "seedance2-prompt-reservation"
    assert usage_meter.clear_count == 1


def test_generate_seedance2_prompt_requires_next_beat_for_first_last_mode(
    monkeypatch, tmp_path
):
    client, store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "seedance2_config_json": json.dumps(
                    {
                        "mode": "first_last_frame",
                        "final_prompt": "current seedance2 prompt",
                    }
                ),
            }
        ],
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/seedance2-prompt/generate",
        json={"manual_prompt_reference": "current seedance2 prompt"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "error": "这是最后一个 Beat，无法使用首尾帧模式",
    }
    assert store.updates == []


def test_generate_beat_video_prompt_updates_first_frame_video_prompt(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import scripts

    seen = {}

    async def _generate_single_beat_video_prompt(**kwargs):
        seen.update(kwargs)
        return "generated first frame motion prompt"

    monkeypatch.setattr(
        scripts,
        "_generate_single_beat_video_prompt",
        _generate_single_beat_video_prompt,
    )
    client, store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
            },
            {"beat_number": 2},
        ],
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/video-prompt/generate",
        json={"language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["field"] == "video_prompt"
    assert payload["data"]["prompt"] == "generated first frame motion prompt"
    assert payload["data"]["beat"]["video_prompt"] == "generated first frame motion prompt"
    assert seen["beat"]["beat_number"] == 1
    assert seen["language"] == "en"
    assert store.updates == [
        {
            "episode": 1,
            "beat": 1,
            "updates": {"video_prompt": "generated first frame motion prompt"},
        }
    ]


def test_generate_beat_video_prompt_enqueues_project_task_in_celery_mode(
    monkeypatch, tmp_path
):
    from types import SimpleNamespace

    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import scripts

    ctx = _project_ctx(tmp_path)
    store = DummySqliteStore(
        [
            {
                "beat_number": 1,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
            },
            {"beat_number": 2},
        ]
    )
    enqueued = {}

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    async def fake_make_sqlite_store_for_context(ctx_arg):
        assert ctx_arg is ctx
        return store

    async def fake_enqueue_project_task(ctx_arg, **kwargs):
        enqueued.update({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_prompt_1"),
            backend="celery",
            queue="queue:default",
        )

    monkeypatch.setattr(scripts, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        scripts,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
    )
    monkeypatch.setattr(scripts, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))

    app = FastAPI()
    app.include_router(scripts.router)
    app.dependency_overrides[scripts.get_api_user] = lambda: {"username": "admin"}
    client = TestClient(app)

    response = client.post(
        "/projects/demo/episodes/1/beats/1/video-prompt/generate",
        json={"language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["task_type"] == "beat_video_prompt"
    assert payload["task_id"] == "task_prompt_1"
    assert payload["task_key"].startswith("task:beat_video_prompt:project:proj_123:")
    assert enqueued["ctx"] is ctx
    assert enqueued["task_type"] == "beat_video_prompt"
    assert enqueued["queue_kind"] == "default"
    assert enqueued["episode"] == 1
    assert enqueued["beat_num"] == 1
    assert enqueued["payload"] == {
        "episode": 1,
        "beat_num": 1,
        "field": "video_prompt",
        "language": "en",
        "output_dir": str(tmp_path),
        "display_name": "生成提示词 · EP1 / Beat 1",
    }
    assert store.updates == []


@pytest.mark.asyncio
async def test_generate_beat_video_prompt_does_not_save_fallback_on_agent_failure(
    monkeypatch, tmp_path
):
    from novelvideo.agents import global_video_optimizer
    from novelvideo.api.routes import scripts
    from novelvideo.utils.path_resolver import PathResolver

    sketch_path = PathResolver(str(tmp_path), 1).sketch(1)
    sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color=(20, 20, 20)).save(sketch_path)

    captured = {}

    class FakeOptimizer:
        async def optimize_single_beat(self, **kwargs):
            captured.update(kwargs)
            raise RuntimeError("model unavailable")

    monkeypatch.setattr(
        global_video_optimizer,
        "get_global_video_optimizer",
        lambda: FakeOptimizer(),
    )
    monkeypatch.setattr(
        global_video_optimizer,
        "_build_color_appearance_map",
        lambda *args, **kwargs: {"#00ff00 GREEN": {"appearance": "黑衣男子"}},
    )

    store = DummySqliteStore(
        [
            {
                "beat_number": 1,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "visual_description": "一个人推开门向前走",
            }
        ]
    )

    with pytest.raises(RuntimeError, match="model unavailable"):
        await scripts._generate_and_save_beat_video_prompt(
            store=store,
            output_dir=tmp_path,
            episode_num=1,
            beat_num=1,
            language="en",
        )

    assert captured["character_color_map"] == {"#00ff00 GREEN": {"appearance": "黑衣男子"}}
    assert store.beats[0]["video_prompt"] == "old prompt"
    assert store.updates == []


@pytest.mark.asyncio
async def test_generate_beat_video_prompt_uses_superpower_single_beat_optimizer(
    monkeypatch, tmp_path
):
    from novelvideo.agents import global_video_optimizer
    from novelvideo.api.routes import scripts
    from novelvideo.utils.path_resolver import PathResolver

    sketch_path = PathResolver(str(tmp_path), 1).sketch(1)
    sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color=(0, 255, 0)).save(sketch_path)

    map_seen = {}
    optimizer_seen = {}

    def fake_build_color_appearance_map(beats, characters, output_dir, project, **kwargs):
        map_seen.update(
            {
                "beats": beats,
                "characters": characters,
                "output_dir": output_dir,
                "project": project,
                **kwargs,
            }
        )
        return {"#00ff00 GREEN": {"appearance": "黑衣男子"}}

    class FakeOptimizer:
        async def optimize_single_beat(self, **kwargs):
            optimizer_seen.update(kwargs)
            return {"beat_number": 1, "video_mode": "first_frame", "prompt": "superpower prompt"}

    monkeypatch.setattr(
        global_video_optimizer,
        "_build_color_appearance_map",
        fake_build_color_appearance_map,
    )
    monkeypatch.setattr(
        global_video_optimizer,
        "get_global_video_optimizer",
        lambda: FakeOptimizer(),
    )
    store = DummySqliteStore(
        [
            {
                "beat_number": 1,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "visual_description": "{{男主_青年}}推开墙砖",
            },
            {"beat_number": 2, "visual_description": "下一个镜头"},
        ],
        characters=[
            {
                "name": "男主",
                "identities": [
                    {
                        "identity_id": "男主_青年",
                        "appearance_details": "黑衣",
                    }
                ],
            }
        ],
        sketch_colors={"男主_青年": "#00ff00 GREEN"},
    )

    result = await scripts._generate_and_save_beat_video_prompt(
        store=store,
        output_dir=tmp_path,
        project_name="demo",
        episode_num=1,
        beat_num=1,
        language="en",
    )

    assert result["prompt"] == "superpower prompt"
    assert optimizer_seen["sketch_image_path"] == str(sketch_path)
    assert optimizer_seen["character_color_map"] == {
        "#00ff00 GREEN": {"appearance": "黑衣男子"}
    }
    assert optimizer_seen["next_beat"]["beat_number"] == 2
    assert map_seen["project"] == "demo"
    assert map_seen["cognee_store"] is store
    assert store.updates == [
        {
            "episode": 1,
            "beat": 1,
            "updates": {"video_prompt": "superpower prompt"},
        }
    ]


def test_generate_beat_video_prompt_updates_keyframe_prompt(monkeypatch, tmp_path):
    from novelvideo.api.routes import scripts

    seen = {}

    async def _generate_single_beat_keyframe_prompt(**kwargs):
        seen.update(kwargs)
        return "generated first last frame prompt"

    monkeypatch.setattr(
        scripts,
        "_generate_single_beat_keyframe_prompt",
        _generate_single_beat_keyframe_prompt,
    )
    client, store = _client(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "video_mode": "keyframe",
                "keyframe_prompt": "old keyframe prompt",
            },
            {"beat_number": 2},
        ],
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/video-prompt/generate",
        json={},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["field"] == "keyframe_prompt"
    assert payload["data"]["prompt"] == "generated first last frame prompt"
    assert payload["data"]["beat"]["keyframe_prompt"] == "generated first last frame prompt"
    assert seen["next_beat"]["beat_number"] == 2
    assert store.updates == [
        {
            "episode": 1,
            "beat": 1,
            "updates": {"keyframe_prompt": "generated first last frame prompt"},
        }
    ]


def test_generate_beat_video_prompt_requires_next_beat_for_keyframe(
    monkeypatch, tmp_path
):
    client, store = _client(
        monkeypatch,
        tmp_path,
        [{"beat_number": 1, "video_mode": "keyframe"}],
    )

    response = client.post(
        "/projects/demo/episodes/1/beats/1/video-prompt/generate",
        json={},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "error": "这是最后一个 Beat，无法生成首尾帧过渡提示词",
    }
    assert store.updates == []
