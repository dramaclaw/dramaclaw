"""HTTP audio generation must use the IndexTTS2 dispatcher."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m04


class _FakeStore:
    async def get_beats_as_dicts(self, episode: int):
        assert episode == 3
        return [
            {
                "beat_number": 2,
                "audio_type": "dialogue",
                "narration_segment": "走。",
                "video_prompt": "镜头从角色正面缓慢推近。",
                "seedance2_config_json": '{"final_prompt": "参考图片1，镜头从角色正面缓慢推近。"}',
            }
        ]


class _FakeSeedance2Store:
    def __init__(self, beats):
        self.beats = beats
        self.updated = []

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 3
        return self.beats

    async def update_beat_asset(self, **kwargs):
        self.updated.append(kwargs)
        return True


def _patch_generation_project(
    monkeypatch,
    generation,
    tmp_path,
    *,
    username="alice",
    project="demo",
):
    async def fake_resolve_generation_project(
        project_arg, user, required_role="editor"
    ):
        assert project_arg == project
        assert user["username"] == username
        return SimpleNamespace(
            ctx=None,
            username=username,
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(
        generation,
        "get_state_dir",
        lambda username_arg, project_arg: str(tmp_path / "state"),
    )


def _patch_generation_celery(
    monkeypatch,
    generation,
    tmp_path,
    store,
    *,
    username="alice",
    project="demo",
):
    """Drive the supported Celery dispatch path (ctx present, task_backend=celery).

    The legacy non-celery branch has been removed, so audio/video dispatch is
    only exercised via Celery.
    """
    ctx = SimpleNamespace(project_id="proj-1", state_dir=tmp_path / "state")

    async def fake_resolve_generation_project(
        project_arg, user, required_role="editor"
    ):
        assert project_arg == project
        assert user["username"] == username
        return SimpleNamespace(
            ctx=ctx,
            username=username,
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    async def fake_make_sqlite_store_for_context(ctx_arg):
        assert ctx_arg is ctx
        return store

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    return ctx


def _fake_enqueue(calls):
    async def fake_enqueue_project_task(
        ctx, *, task_type, queue_kind, episode, payload, **extra
    ):
        calls.append(
            {
                "ctx": ctx,
                "task_type": task_type,
                "episode": episode,
                "payload": payload,
                **extra,
            }
        )
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-1"),
            backend="celery",
            queue="default",
        )

    return fake_enqueue_project_task


def test_happyhorse_video_backend_options_expose_mainline_limits() -> None:
    from novelvideo.api.routes import generation

    options = {
        item.value: item.model_dump()
        for item in generation._api_video_backend_options()
    }
    happyhorse = options["newapi_happyhorse-1.0"]

    assert happyhorse["is_happyhorse"] is True
    assert happyhorse["is_seedance2"] is False
    assert happyhorse["resolution_options"] == ["720p", "1080p"]
    assert happyhorse["ratio_options"] == ["16:9", "9:16", "1:1", "4:3", "3:4"]
    assert happyhorse["supported_modes"] == ["first_frame", "multimodal_reference"]
    assert happyhorse["reference_image_max"] == 9
    assert happyhorse["reference_video_max"] == 1
    assert happyhorse["reference_audio_max"] == 0


@pytest.mark.asyncio
async def test_audio_generate_route_dispatches_indextts2(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSGenerateRequest

    calls = []
    ctx = _patch_generation_celery(monkeypatch, generation, tmp_path, _FakeStore())
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )

    response = await generation.generate_audio(
        project="demo",
        episode_num=3,
        body=TTSGenerateRequest(mode="redo_selected", beat_numbers=[2]),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert response["task_type"] == "audio_generation_indextts2"
    assert calls == [
        {
            "ctx": ctx,
            "product_surface": "mainline",
            "task_type": "audio_generation_indextts2",
            "episode": 3,
            "payload": {
                "episode": 3,
                "mode": "redo_selected",
                "beat_numbers": [2],
                "output_dir": str(tmp_path),
                "state_dir": str(tmp_path / "state"),
                "billing": generation._audio_billing_payload([2], billable_chars=2),
            },
        }
    ]


@pytest.mark.asyncio
async def test_audio_generate_route_does_not_enqueue_when_voice_file_is_missing(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSGenerateRequest

    calls = []
    _patch_generation_celery(monkeypatch, generation, tmp_path, _FakeStore())

    async def fake_plan(**_kwargs):
        return (
            [],
            [
                "Beat 02 解说声线缺失：项目解说人声线已配置，"
                "但声线文件无法读取，请重新上传或检查项目存储"
            ],
            0,
        )

    monkeypatch.setattr(generation, "_audio_generation_plan", fake_plan)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )

    response = await generation.generate_audio(
        project="demo",
        episode_num=3,
        body=TTSGenerateRequest(mode="redo_selected", beat_numbers=[2]),
        user={"username": "alice"},
    )

    assert response == {
        "ok": False,
        "code": "voice_prereq_required",
        "error": (
            "Beat 02 解说声线缺失：项目解说人声线已配置，"
            "但声线文件无法读取，请重新上传或检查项目存储"
        ),
    }
    assert calls == []


def test_audio_generate_http_route_dispatches_indextts2(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    calls = []

    app = FastAPI()
    app.include_router(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}

    _patch_generation_celery(monkeypatch, generation, tmp_path, _FakeStore())
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )

    client = TestClient(app)
    response = client.post(
        "/projects/demo/episodes/3/audio/generate",
        json={"mode": "redo_selected", "beat_numbers": [2]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["task_type"] == "audio_generation_indextts2"
    assert body["message"] == "第 3 集语音批量生成已进入队列"
    assert calls[0]["task_type"] == "audio_generation_indextts2"
    assert calls[0]["payload"] == {
        "episode": 3,
        "mode": "redo_selected",
        "beat_numbers": [2],
        "output_dir": str(tmp_path),
        "state_dir": str(tmp_path / "state"),
        "billing": generation._audio_billing_payload([2], billable_chars=2),
    }


@pytest.mark.asyncio
async def test_audio_billing_quote_uses_server_planned_quantity(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSGenerateRequest
    from novelvideo.ports.credit_quote import CreditQuote

    captured = {}

    async def fake_make_sqlite_store(username, project):
        return _FakeStore()

    async def fake_plan(**kwargs):
        assert kwargs["mode"] == "redo_selected"
        assert kwargs["beat_numbers"] == [2, 4]
        return [2, 4], [], 9

    class FakeCreditQuote:
        async def generation_credit_quote(self, **kwargs):
            captured.update(kwargs)
            return CreditQuote(
                total_cost=5,
                display="6→5",
                unit="call",
                unit_cost=3,
                quantity=2,
                original_total_cost=6,
                discount_amount=1,
                promotion={
                    "id": "promo_audio",
                    "name": "配音优惠",
                    "discount_basis_points": 8000,
                },
            )

    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "_audio_generation_plan", fake_plan)
    monkeypatch.setattr(generation, "get_credit_quote", lambda: FakeCreditQuote())

    response = await generation.audio_generation_billing_quote(
        project="demo",
        episode_num=3,
        body=TTSGenerateRequest(mode="redo_selected", beat_numbers=[2, 4]),
        user={"id": "user_1", "username": "alice"},
    )

    assert response["data"]["beat_numbers"] == [2, 4]
    assert response["data"]["quantity"] == 2
    assert response["data"]["cost"] == 5
    assert response["data"]["original_cost"] == 6
    assert response["data"]["promotion"]["id"] == "promo_audio"
    assert captured == {
        "kind": "feature",
        "model": "mainline.beat_audio_generation",
        "params": generation._audio_billing_payload([2, 4], billable_chars=9),
        "quantity": 2,
        "product_surface": "mainline",
        "user_id": "user_1",
    }


@pytest.mark.asyncio
async def test_single_beat_audio_route_dispatches_indextts2(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    calls = []
    ctx = _patch_generation_celery(monkeypatch, generation, tmp_path, _FakeStore())
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )

    response = await generation.regenerate_beat_audio(
        project="demo",
        episode_num=3,
        beat_num=2,
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert response["task_type"] == "audio_generation_indextts2"
    assert response["message"] == "第 3 集 Beat 2 语音生成已进入队列"
    assert calls == [
        {
            "ctx": ctx,
            "product_surface": "mainline",
            "task_type": "audio_generation_indextts2",
            "episode": 3,
            "payload": {
                "episode": 3,
                "mode": "redo_selected",
                "beat_numbers": [2],
                "output_dir": str(tmp_path),
                "state_dir": str(tmp_path / "state"),
                "billing": generation._audio_billing_payload([2], billable_chars=2),
            },
        }
    ]


@pytest.mark.asyncio
async def test_audio_generate_without_celery_backend_errors_and_does_not_enqueue(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSGenerateRequest

    enqueue_calls = []

    async def fake_make_sqlite_store(username, project):
        return _FakeStore()

    async def fake_enqueue_project_task(*args, **kwargs):
        enqueue_calls.append((args, kwargs))

    # ctx=None drives the legacy / non-celery branch.
    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    response = await generation.generate_audio(
        project="demo",
        episode_num=3,
        body=TTSGenerateRequest(mode="redo_selected", beat_numbers=[2]),
        user={"username": "alice"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]
    assert enqueue_calls == []


@pytest.mark.asyncio
async def test_single_beat_audio_without_celery_backend_errors_and_does_not_enqueue(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation

    enqueue_calls = []

    async def fake_make_sqlite_store(username, project):
        return _FakeStore()

    async def fake_enqueue_project_task(*args, **kwargs):
        enqueue_calls.append((args, kwargs))

    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    response = await generation.regenerate_beat_audio(
        project="demo",
        episode_num=3,
        beat_num=2,
        user={"username": "alice"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]
    assert enqueue_calls == []


@pytest.mark.asyncio
async def test_seedance2_single_video_passes_prepared_config_and_duration(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    calls = []
    prepare_calls = []
    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "seedance2_config_json": '{"duration": 11, "final_prompt": "configured prompt"}',
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_prepare(**kwargs):
        prepare_calls.append(kwargs)
        return SimpleNamespace(
            prompt="configured prompt",
            seedance2_config_json='{"duration": 11, "final_prompt": "configured prompt"}',
            duration=11,
            mode=Seedance2I2VMode.FIRST_FRAME,
            image_path=str(frame),
            last_frame_path=None,
            references=[],
        )

    async def fake_audio_duration(*_args, **_kwargs):
        return 6.4

    _patch_generation_celery(monkeypatch, generation, tmp_path, store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )
    monkeypatch.setattr(generation, "prepare_seedance2_generation_inputs", fake_prepare)
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(video_backend="huimeng_seedance-2.0-fast"),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert prepare_calls[0]["duration"] == 6.4
    config = calls[0]["payload"]["config"]
    assert config["prompt"] == "configured prompt"
    assert config["video_duration"] == 11
    assert (
        config["seedance2_config"]
        == '{"duration": 11, "final_prompt": "configured prompt"}'
    )
    assert calls[0]["payload"]["billing"] == {
        "pricing_kind": "video",
        "pricing_model": "seedance-2.0-fast",
        "pricing_model_selection": "huimeng_seedance-2.0-fast",
        "pricing_params": {"resolution": "720p", "video_input": "none"},
        "pricing_quantity": 11,
        "pricing_metrics": {
            "call_count": 1,
            "item_count": 1,
            "duration_seconds": 11,
            "output_duration_seconds": 11,
            "input_video_duration_ms": 0,
            "input_video_billed_seconds": 0,
        },
        "resolution": "720p",
        "video_backend": "huimeng_seedance-2.0-fast",
        "video_input_present": False,
        "input_video_duration_seconds": 0.0,
    }


@pytest.mark.parametrize(
    ("requested_duration", "expected_duration"),
    [(1, 2), (100, 12)],
)
@pytest.mark.asyncio
async def test_single_video_normalizes_duration_before_billing_and_enqueue(
    monkeypatch,
    tmp_path,
    requested_duration,
    expected_duration,
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest

    calls = []
    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "镜头从角色正面缓慢推近。",
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_audio_duration(*_args, **_kwargs):
        return 0.0

    _patch_generation_celery(monkeypatch, generation, tmp_path, store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(
            video_backend="newapi_seedance-1.0-pro-fast",
            duration=requested_duration,
        ),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    payload = calls[0]["payload"]
    assert payload["config"]["video_duration"] == expected_duration
    assert payload["billing"]["pricing_quantity"] == expected_duration


@pytest.mark.asyncio
async def test_seedance2_single_video_applies_return_last_frame_request_override(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    calls = []
    prepare_calls = []
    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "seedance2_config_json": (
                    '{"duration": 4, "final_prompt": "configured prompt", '
                    '"return_last_frame": false}'
                ),
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_prepare(**kwargs):
        prepare_calls.append(kwargs)
        seedance2_config_json = kwargs["beat"]["seedance2_config_json"]
        return SimpleNamespace(
            prompt="configured prompt",
            seedance2_config_json=seedance2_config_json,
            duration=4,
            mode=Seedance2I2VMode.FIRST_FRAME,
            image_path=str(frame),
            last_frame_path=None,
            references=[],
        )

    async def fake_audio_duration(*_args, **_kwargs):
        return None

    _patch_generation_celery(monkeypatch, generation, tmp_path, store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )
    monkeypatch.setattr(generation, "prepare_seedance2_generation_inputs", fake_prepare)
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(
            video_backend="huimeng_seedance-2.0-fast",
            return_last_frame=True,
        ),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert (
        '"return_last_frame":true' in prepare_calls[0]["beat"]["seedance2_config_json"]
    )
    assert (
        '"return_last_frame":true' in calls[0]["payload"]["config"]["seedance2_config"]
    )
    assert (
        store.updated[-1]["seedance2_config_json"]
        == prepare_calls[0]["beat"]["seedance2_config_json"]
    )


@pytest.mark.asyncio
async def test_seedance2_single_video_applies_inline_request_config_controls(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode, parse_seedance2_config

    calls = []
    prepare_calls = []
    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "seedance2_config_json": (
                    '{"duration": 4, "final_prompt": "old prompt", '
                    '"ratio": "9:16", "generate_audio": true, "human_review": true}'
                ),
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_prepare(**kwargs):
        prepare_calls.append(kwargs)
        seedance2_config_json = kwargs["beat"]["seedance2_config_json"]
        return SimpleNamespace(
            prompt="fresh prompt",
            seedance2_config_json=seedance2_config_json,
            duration=9,
            mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
            image_path=str(frame),
            last_frame_path=None,
            references=[],
        )

    async def fake_audio_duration(*_args, **_kwargs):
        return None

    _patch_generation_celery(monkeypatch, generation, tmp_path, store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )
    monkeypatch.setattr(generation, "prepare_seedance2_generation_inputs", fake_prepare)
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(
            video_backend="huimeng_seedance-2.0-fast",
            mode="multimodal_reference",
            duration=9,
            ratio="16:9",
            generate_audio=False,
            human_review=False,
            final_prompt="fresh prompt",
            prompt_guidance="keep motion minimal",
        ),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert prepare_calls[0]["ratio"] == "16:9"
    merged_config = parse_seedance2_config(
        prepare_calls[0]["beat"]["seedance2_config_json"]
    )
    assert merged_config.mode == Seedance2I2VMode.MULTIMODAL_REFERENCE
    assert merged_config.duration == 9
    assert merged_config.ratio == "16:9"
    assert merged_config.generate_audio is False
    assert merged_config.generate_audio_user_set is True
    assert merged_config.human_review is False
    assert merged_config.human_review_user_set is True
    assert merged_config.final_prompt == "fresh prompt"
    assert merged_config.prompt_guidance == "keep motion minimal"
    assert (
        calls[0]["payload"]["config"]["seedance2_config"]
        == prepare_calls[0]["beat"]["seedance2_config_json"]
    )


@pytest.mark.asyncio
async def test_happyhorse_single_video_enqueues_prepared_references(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest

    calls = []
    prepare_calls = []
    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "old prompt",
                "seedance2_config_json": '{"final_prompt": "old prompt"}',
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_prepare_happyhorse(**kwargs):
        prepare_calls.append(kwargs)
        return {
            "prompt": "happyhorse prompt",
            "duration": 7,
            "resolution": "1080p",
            "ratio": "1:1",
            "image_path": None,
            "references": [
                {
                    "type": "image",
                    "path": "https://example.com/ref.png",
                    "role": "图片1",
                }
            ],
            "config_json": '{"final_prompt":"happyhorse prompt","ratio":"1:1"}',
        }

    async def fake_audio_duration(*_args, **_kwargs):
        return None

    _patch_generation_celery(monkeypatch, generation, tmp_path, store)
    monkeypatch.setattr(
        generation,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=_fake_enqueue(calls)),
    )
    monkeypatch.setattr(
        generation,
        "_prepare_happyhorse_api_beat",
        fake_prepare_happyhorse,
        raising=False,
    )
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(
            video_backend="newapi_happyhorse-1.0",
            mode="multimodal_reference",
            resolution="1080p",
            ratio="1:1",
            duration=7,
            audio_setting="origin",
        ),
        user={"username": "alice"},
    )

    assert response["ok"] is True
    assert prepare_calls[0]["ratio"] == "1:1"
    config = calls[0]["payload"]["config"]
    assert config["frame_path"] is None
    assert config["prompt"] == "happyhorse prompt"
    assert config["video_duration"] == 7
    assert config["resolution"] == "1080p"
    assert config["ratio"] == "1:1"
    assert config["references"] == [
        {"type": "image", "path": "https://example.com/ref.png", "role": "图片1"}
    ]
    assert config["audio_setting"] == "origin"
    assert (
        config["seedance2_config"]
        == '{"final_prompt":"happyhorse prompt","ratio":"1:1"}'
    )


@pytest.mark.asyncio
async def test_single_video_rejects_empty_1x_video_prompt(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest

    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "",
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_make_sqlite_store(username, project):
        return store

    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(video_backend="huimeng_seedance-1.0-pro-fast"),
        user={"username": "alice"},
    )

    assert response == {
        "ok": False,
        "error": "Beat 2 缺少视频提示词，请先点击“生成本 Beat 提示词”。",
    }


@pytest.mark.asyncio
async def test_single_video_rejects_empty_1x_keyframe_prompt(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest

    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "keyframe",
                "video_prompt": "first frame prompt should not satisfy keyframe",
                "keyframe_prompt": "",
            }
        ]
    )
    frames_dir = tmp_path / "frames" / "ep003"
    frames_dir.mkdir(parents=True)
    (frames_dir / "beat_02.png").write_bytes(b"frame")
    (frames_dir / "beat_03.png").write_bytes(b"next frame")

    async def fake_make_sqlite_store(username, project):
        return store

    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(video_backend="huimeng_seedance-1.0-pro-fast"),
        user={"username": "alice"},
    )

    assert response == {
        "ok": False,
        "error": "Beat 2 缺少视频提示词，请先点击“生成本 Beat 提示词”。",
    }


@pytest.mark.asyncio
async def test_seedance2_single_video_rejects_empty_final_prompt(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SingleVideoRequest
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    store = _FakeSeedance2Store(
        [
            {
                "beat_number": 2,
                "video_mode": "first_frame",
                "video_prompt": "",
                "seedance2_config_json": "{}",
            }
        ]
    )
    frame = tmp_path / "frames" / "ep003" / "beat_02.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"frame")

    async def fake_prepare(**_kwargs):
        return SimpleNamespace(
            prompt="",
            seedance2_config_json="{}",
            duration=5,
            mode=Seedance2I2VMode.FIRST_FRAME,
            image_path=None,
            last_frame_path=None,
            references=[],
        )

    async def fake_make_sqlite_store(username, project):
        return store

    async def fake_audio_duration(*_args, **_kwargs):
        return None

    _patch_generation_project(monkeypatch, generation, tmp_path)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "prepare_seedance2_generation_inputs", fake_prepare)
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", fake_audio_duration)

    response = await generation.generate_single_video(
        project="demo",
        episode_num=3,
        beat_num=2,
        body=SingleVideoRequest(video_backend="huimeng_seedance-2.0-fast"),
        user={"username": "alice"},
    )

    assert response["ok"] is False
    assert "Seedance 2.0 最终提示词为空" in response["error"]


@pytest.mark.asyncio
async def test_legacy_tts_generate_endpoint_is_gone():
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSGenerateRequest

    with pytest.raises(HTTPException) as exc:
        await generation.generate_tts(
            project="demo",
            episode_num=3,
            body=TTSGenerateRequest(),
            user={"username": "alice"},
        )

    assert exc.value.status_code == 410
    assert "/audio/generate" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_legacy_tts_preview_endpoint_is_gone():
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import TTSPreviewRequest

    with pytest.raises(HTTPException) as exc:
        await generation.preview_tts(
            project="demo",
            body=TTSPreviewRequest(text="hello"),
            user={"username": "alice"},
        )

    assert exc.value.status_code == 410
    assert "IndexTTS2" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_legacy_tts_voices_endpoint_is_gone():
    from novelvideo.api.routes import generation

    with pytest.raises(HTTPException) as exc:
        await generation.list_tts_voices(project="demo", user={"username": "alice"})

    assert exc.value.status_code == 410
    assert "IndexTTS2" in str(exc.value.detail)
