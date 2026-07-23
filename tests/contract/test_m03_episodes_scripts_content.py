from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m03


def _reset_port_modules():
    import novelvideo.ports as ports
    import novelvideo.ports.local as local_ports
    import novelvideo.ports.registry as registry

    registry = importlib.reload(registry)
    ports = importlib.reload(ports)
    local_ports = importlib.reload(local_ports)
    return registry, ports, local_ports


def _patch_roots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"

    import novelvideo.api.deps as deps
    import novelvideo.config as config
    import novelvideo.project_config as project_config
    import novelvideo.project_context as project_context
    import novelvideo.utils.project_paths as project_paths

    for module in (config, deps, project_paths):
        monkeypatch.setattr(module, "OUTPUT_DIR", str(output), raising=False)
        monkeypatch.setattr(module, "STATE_DIR", str(state), raising=False)
        monkeypatch.setattr(module, "RUNTIME_DIR", str(runtime), raising=False)
    monkeypatch.setattr(project_config, "OUTPUT_DIR", str(state), raising=False)
    monkeypatch.setattr(project_config, "STATE_DIR", str(state), raising=False)
    monkeypatch.setattr(project_context, "resolve_worker_id", lambda: "node_local")


class _M03Store:
    def __init__(self, project_dir: Path):
        from novelvideo.models import NovelEpisode

        self.project_dir = str(project_dir)
        self.episode = NovelEpisode(
            number=1,
            title="第一集",
            raw_content="第一章 启程\n秦王入宫。",
            beat_source_text="",
            content_summary="旧摘要",
            identity_ids=[],
            key_events=["入宫"],
            character_names=["秦"],
        )
        self.episode.scene_menu = [{"scene_id": "palace", "base_scene_id": "palace"}]
        self.episode.prop_menu = [{"prop_id": "jade", "prop_type": "object"}]
        self.beats: list[dict] = []
        self.novel_text = "第一章 启程\n秦王入宫。\n第二章 风起\n宫门起风。"

    def get_all_episodes(self):
        return [self.episode]

    def get_episode(self, episode_num: int):
        return self.episode if episode_num == self.episode.number else None

    async def update_episode(self, episode_number: int, **updates):
        if episode_number != self.episode.number:
            raise ValueError("missing episode")
        for key, value in updates.items():
            setattr(self.episode, key, value)

    def load_novel_content(self):
        return self.novel_text

    async def load_episode_content(self, episode_num: int):
        episode = self.get_episode(episode_num)
        return getattr(episode, "raw_content", "") if episode else ""

    async def save_episode_content(self, episode_num: int, content: str):
        episode = self.get_episode(episode_num)
        if episode is None:
            raise ValueError(f"剧集 {episode_num} 不存在")
        episode.raw_content = content

    async def load_adapted_content(self, episode_num: int):
        episode = self.get_episode(episode_num)
        return getattr(episode, "adapted_content", "") if episode else ""

    async def save_adapted_content(self, episode_num: int, content: str):
        episode = self.get_episode(episode_num)
        if episode is None:
            raise ValueError(f"剧集 {episode_num} 不存在")
        episode.adapted_content = content

    async def load_graph_state(self):
        return None

    def get_all_characters(self):
        return []

    async def get_beats_as_dicts(self, episode_num: int):
        if episode_num != self.episode.number:
            return []
        return [dict(beat) for beat in sorted(self.beats, key=lambda item: item["shot_order"])]

    async def get_script_as_dict(self, episode_num: int):
        if episode_num != self.episode.number or not self.beats:
            return None
        return {
            "episode_number": episode_num,
            "title": self.episode.title,
            "beats": await self.get_beats_as_dicts(episode_num),
            "scene_menu": [{"scene_id": "palace"}],
            "prop_menu": [{"prop_id": "jade"}],
            "sketch_colors": {},
        }

    async def persist_beats_from_script(self, episode_num: int, beats: list[dict]):
        self.beats = []
        for index, beat in enumerate(beats, start=1):
            payload = {
                "episode_number": episode_num,
                "beat_number": int(beat.get("beat_number") or index),
                "shot_order": int(beat.get("shot_order") or index * 10),
                "narration_segment": beat.get("narration_segment", ""),
                "visual_description": beat.get("visual_description", ""),
                "audio_type": beat.get("audio_type", "narration"),
                "speaker": beat.get("speaker", ""),
                "video_mode": beat.get("video_mode", "first_frame"),
                "video_prompt": beat.get("video_prompt", ""),
                "keyframe_prompt": beat.get("keyframe_prompt", ""),
                "seedance2_config_json": beat.get("seedance2_config_json", "{}"),
                "is_manual_shot": bool(beat.get("is_manual_shot", False)),
                "scene_ref": beat.get("scene_ref"),
                "time_of_day": beat.get("time_of_day", ""),
                "detected_identities": beat.get("detected_identities", []),
                "detected_props": beat.get("detected_props", []),
            }
            self.beats.append(payload)

    async def update_beat_asset(self, episode_number: int, beat_number: int, **updates):
        for beat in self.beats:
            if int(beat["beat_number"]) == int(beat_number):
                beat.update(updates)
                return True
        return False

    async def add_visual_beats(self, visual_beats):
        for beat in visual_beats:
            self.beats.append(
                {
                    "episode_number": beat.episode_number,
                    "beat_number": beat.beat_number,
                    "shot_order": beat.shot_order,
                    "narration_segment": beat.narration,
                    "visual_description": beat.visual_description,
                    "audio_type": beat.audio_type,
                    "speaker": beat.speaker,
                    "video_mode": beat.video_mode,
                    "video_prompt": beat.video_prompt,
                    "keyframe_prompt": beat.keyframe_prompt,
                    "seedance2_config_json": beat.seedance2_config_json,
                    "is_manual_shot": beat.is_manual_shot,
                    "scene_ref": {},
                    "time_of_day": beat.time_of_day,
                    "detected_identities": json.loads(beat.detected_identities_json),
                    "detected_props": json.loads(beat.detected_props_json),
                }
            )

    async def delete_manual_beat(self, episode_number: int, beat_number: int):
        before = len(self.beats)
        self.beats = [
            beat
            for beat in self.beats
            if not (int(beat["beat_number"]) == int(beat_number) and beat.get("is_manual_shot"))
        ]
        return len(self.beats) != before


@pytest.fixture()
def m03_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _reset_port_modules()
    _patch_roots(monkeypatch, tmp_path)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")
    (tmp_path / "novel.txt").write_text("测试原文", encoding="utf-8")

    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import content, episodes, scripts

    store = _M03Store(tmp_path)
    ctx = SimpleNamespace(project_id="proj_m03", output_dir=tmp_path, state_dir=tmp_path / "state")

    async def resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        return ProjectResolution(
            ctx=ctx,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    async def make_store_for_context(_ctx):
        return store

    async def make_store(username: str, project: str):
        return store

    queued = SimpleNamespace(
        task_state=SimpleNamespace(task_id="task-m03"),
        backend="inline",
        queue="inline",
    )

    async def enqueue_project_task(_ctx, **kwargs):
        queued.task_state = SimpleNamespace(task_id=f"task-{kwargs['task_type']}")
        queued.backend = "inline"
        queued.queue = "inline"
        return queued

    for module in (episodes, scripts):
        monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
        monkeypatch.setattr(module, "make_sqlite_store_for_context", make_store_for_context)
        monkeypatch.setattr(module, "make_cognee_store_for_context", make_store_for_context)
        monkeypatch.setattr(module, "make_sqlite_store", make_store)
        monkeypatch.setattr(module, "make_cognee_store", make_store)
        monkeypatch.setattr(
            module,
            "get_task_backend",
            lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task),
        )

    async def fake_rewrite_episode_content(*args, **kwargs):
        return "改写第一行\n改写第二行"

    async def fake_seedance2_prompt_for_panel(**kwargs):
        from novelvideo.seedance2_i2v.models import dump_seedance2_config

        return dump_seedance2_config(
            {
                "final_prompt": "seedance final prompt",
                "prompt_source": "generated",
            }
        )

    monkeypatch.setattr(
        "novelvideo.agents.content_rewriter.rewrite_episode_content",
        fake_rewrite_episode_content,
    )
    monkeypatch.setattr(
        "novelvideo.seedance2_i2v.panel_service.generate_seedance2_prompt_for_panel",
        fake_seedance2_prompt_for_panel,
    )

    app = FastAPI()
    app.include_router(episodes.router, prefix="/api/v1")
    app.include_router(scripts.router, prefix="/api/v1")
    app.include_router(content.router, prefix="/api/v1")
    app.dependency_overrides[api_auth.get_api_user] = lambda: {
        "id": "local",
        "user_id": "local",
        "username": "alice",
        "role": "owner",
    }
    app.dependency_overrides[content.get_sqlite_store] = lambda: store

    return TestClient(app), store


def test_m03_l2_covers_episodes_scripts_and_content_endpoints(m03_client):
    client, store = m03_client

    chapters = client.get("/api/v1/projects/demo/chapters")
    assert chapters.status_code == 200
    assert chapters.json()["data"]["count"] == 2

    episodes_list = client.get("/api/v1/projects/demo/episodes")
    assert episodes_list.status_code == 200
    assert episodes_list.json()["data"][0]["identity_ids"] == []

    plan = client.post("/api/v1/projects/demo/episodes/plan", json={"target_episodes": 2})
    assert plan.status_code == 200
    assert plan.json()["task_type"] == "build_episodes"
    assert plan.json()["backend"] == "inline"
    assert plan.json()["queue"] == "inline"

    detail = client.get("/api/v1/projects/demo/episodes/1")
    assert detail.status_code == 200
    assert {"raw_content", "beat_source_text", "content_summary", "scene_menu", "prop_menu"} <= set(
        detail.json()["data"]
    )

    updated = client.patch(
        "/api/v1/projects/demo/episodes/1",
        json={"summary": "新摘要", "identity_ids": ["秦_青年"]},
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["summary"] == "新摘要"
    assert updated.json()["data"]["identity_ids"] == ["秦_青年"]

    raw_saved = client.put(
        "/api/v1/projects/demo/episodes/1/raw-content",
        json={"content": "原文一\n原文二"},
    )
    assert raw_saved.status_code == 200
    assert raw_saved.json()["data"]["length"] == 7

    raw_loaded = client.get("/api/v1/projects/demo/episodes/1/raw-content")
    assert raw_loaded.status_code == 200
    assert raw_loaded.json()["data"] == {"episode": 1, "content": "原文一\n原文二"}

    adapted_saved = client.put(
        "/api/v1/projects/demo/episodes/1/adapted-content",
        json={"content": "改写稿"},
    )
    assert adapted_saved.status_code == 200
    assert adapted_saved.json()["data"]["length"] == 3

    adapted_loaded = client.get("/api/v1/projects/demo/episodes/1/adapted-content")
    assert adapted_loaded.status_code == 200
    assert adapted_loaded.json()["data"]["content"] == "改写稿"

    adapted_missing = client.put(
        "/api/v1/projects/demo/episodes/99/adapted-content",
        json={"content": "missing"},
    )
    assert adapted_missing.status_code == 400
    assert "不存在" in adapted_missing.json()["detail"]

    adapted_deleted = client.delete("/api/v1/projects/demo/episodes/1/adapted-content")
    assert adapted_deleted.status_code == 200
    assert adapted_deleted.json()["data"]["episode"] == 1

    store.episode.raw_content = ""
    rewrite_empty = client.post("/api/v1/projects/demo/episodes/1/rewrite/generate", json={})
    assert rewrite_empty.status_code == 200
    assert rewrite_empty.json()["ok"] is False
    store.episode.raw_content = "原文一"
    rewrite = client.post("/api/v1/projects/demo/episodes/1/rewrite/generate", json={})
    assert rewrite.status_code == 200
    assert rewrite.json()["data"]["adapted_content"] == "改写第一行\n改写第二行"
    assert store.episode.beat_source_text == "改写第一行\n改写第二行"

    missing_script = client.get("/api/v1/projects/demo/episodes/1/script")
    assert missing_script.status_code == 200
    assert missing_script.json()["data"] is None

    store.episode.identity_ids = []
    blocked = client.post("/api/v1/projects/demo/episodes/1/script/generate", json={})
    assert blocked.status_code == 200
    assert blocked.json()["code"] == "identity_plan_required"

    store.episode.identity_ids = ["秦_青年"]
    generated = client.post("/api/v1/projects/demo/episodes/1/script/generate", json={})
    assert generated.status_code == 200
    assert generated.json()["task_type"] == "script_writer"
    assert generated.json()["backend"] == "inline"

    saved = client.put(
        "/api/v1/projects/demo/episodes/1/script",
        json={
            "beats": [
                {
                    "beat_number": 1,
                    "narration_segment": "旁白一",
                    "visual_description": "画面一",
                    "video_mode": "first_frame",
                },
                {
                    "beat_number": 2,
                    "narration_segment": "旁白二",
                    "visual_description": "画面二",
                    "video_mode": "first_frame",
                },
            ]
        },
    )
    assert saved.status_code == 200
    assert saved.json()["data"] == {"episode": 1, "beats_count": 2}

    script = client.get("/api/v1/projects/demo/episodes/1/script")
    assert script.status_code == 200
    assert script.json()["data"]["beats"][0]["narration_segment"] == "旁白一"

    beats = client.get("/api/v1/projects/demo/episodes/1/beats")
    assert beats.status_code == 200
    assert beats.json()["data"][0]["sketch_url"] == ""
    assert beats.json()["data"][0]["audio_duration_seconds"] is None

    patched = client.patch(
        "/api/v1/projects/demo/episodes/1/beats/1",
        json={"visual_description": "更新画面", "audio_type": "dialogue", "speaker": "秦"},
    )
    assert patched.status_code == 200
    assert patched.json()["data"]["visual_description"] == "更新画面"

    missing_beat = client.patch(
        "/api/v1/projects/demo/episodes/1/beats/404",
        json={"visual_description": "missing"},
    )
    assert missing_beat.status_code == 404

    video_prompt = client.post(
        "/api/v1/projects/demo/episodes/1/beats/1/video-prompt/generate",
        json={"language": "zh"},
    )
    assert video_prompt.status_code == 200
    assert video_prompt.json()["task_type"] == "beat_video_prompt"
    assert video_prompt.json()["backend"] == "inline"

    seedance = client.post(
        "/api/v1/projects/demo/episodes/1/beats/1/seedance2-prompt/generate",
        json={"prompt_guidance": "更紧张"},
    )
    assert seedance.status_code == 200
    assert seedance.json()["data"]["final_prompt"] == "seedance final prompt"
    assert "seedance2_config_json" in seedance.json()["data"]

    manual = client.post(
        "/api/v1/projects/demo/episodes/1/beats/insert-manual",
        json={"after_beat_number": 1, "visual_description": "手工镜头"},
    )
    assert manual.status_code == 200
    assert manual.json()["data"]["is_manual_shot"] is True
    manual_number = manual.json()["data"]["beat_number"]

    deleted = client.delete(
        f"/api/v1/projects/demo/episodes/1/beats/{manual_number}/manual-shot"
    )
    assert deleted.status_code == 200
    assert all(not beat.get("is_manual_shot") for beat in deleted.json()["data"]["beats"])


def test_m03_routes_return_no_5xx_for_representative_requests(m03_client):
    client, store = m03_client
    store.episode.identity_ids = ["秦_青年"]
    client.put(
        "/api/v1/projects/demo/episodes/1/script",
        json={"beats": [{"beat_number": 1, "visual_description": "画面"}]},
    )

    probes = [
        ("GET", "/api/v1/projects/demo/chapters", None),
        ("GET", "/api/v1/projects/demo/episodes", None),
        ("POST", "/api/v1/projects/demo/episodes/plan", {"target_episodes": 1}),
        ("GET", "/api/v1/projects/demo/episodes/1", None),
        ("PATCH", "/api/v1/projects/demo/episodes/1", {"summary": "摘要"}),
        ("GET", "/api/v1/projects/demo/episodes/1/beats", None),
        ("POST", "/api/v1/projects/demo/episodes/1/beats/insert-manual", {"visual_description": "手工"}),
        ("DELETE", "/api/v1/projects/demo/episodes/1/beats/404/manual-shot", None),
        ("GET", "/api/v1/projects/demo/episodes/1/script", None),
        ("POST", "/api/v1/projects/demo/episodes/1/script/generate", {}),
        ("PATCH", "/api/v1/projects/demo/episodes/1/beats/1", {"visual_description": "v"}),
        ("POST", "/api/v1/projects/demo/episodes/1/beats/1/video-prompt/generate", {}),
        ("POST", "/api/v1/projects/demo/episodes/1/beats/1/seedance2-prompt/generate", {}),
        ("PUT", "/api/v1/projects/demo/episodes/1/script", {"beats": []}),
        ("GET", "/api/v1/projects/demo/episodes/1/raw-content", None),
        ("PUT", "/api/v1/projects/demo/episodes/1/raw-content", {"content": "原文"}),
        ("GET", "/api/v1/projects/demo/episodes/1/adapted-content", None),
        ("PUT", "/api/v1/projects/demo/episodes/1/adapted-content", {"content": "改写"}),
        ("DELETE", "/api/v1/projects/demo/episodes/1/adapted-content", None),
        ("POST", "/api/v1/projects/demo/episodes/1/rewrite/generate", {}),
    ]

    for method, path, payload in probes:
        response = client.request(method, path, json=payload)
        assert response.status_code < 500, f"{method} {path}: {response.text}"
