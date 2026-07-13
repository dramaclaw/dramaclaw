from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import EpisodeUpdate
from novelvideo.models import CharacterIdentity, NovelCharacter, NovelEpisode, NovelProp

pytestmark = pytest.mark.m03


def test_episode_plan_route_precedes_episode_detail_route():
    from novelvideo.api.routes.episodes import router

    paths = [route.path for route in router.routes]

    assert paths.index("/projects/{project}/episodes/plan") < paths.index(
        "/projects/{project}/episodes/{episode_num}"
    )


def test_episode_asset_task_scope_is_stable_per_episode_and_kind():
    from novelvideo.api.routes.episodes import _episode_asset_task_scope

    assert _episode_asset_task_scope("prop", 4) == "prop_run_ep004"
    assert _episode_asset_task_scope("prop", 4) == "prop_run_ep004"
    assert _episode_asset_task_scope("scene", 4) == "scene_run_ep004"
    assert _episode_asset_task_scope("prop", 5) == "prop_run_ep005"


class _EpisodeStore:
    def __init__(self, episode: NovelEpisode):
        self.episode = episode
        self.updates: list[tuple[int, dict]] = []

    def get_episode(self, number: int):
        if number == self.episode.number:
            return self.episode
        return None

    def get_all_episodes(self):
        return [self.episode]

    async def update_episode(self, episode_number: int, **updates):
        self.updates.append((episode_number, updates))
        for key, value in updates.items():
            if key == "identity_default_map":
                self.episode.identity_default_map = value
            elif hasattr(self.episode, key):
                setattr(self.episode, key, value)
        return None


class _CogneeEpisodeStore:
    def __init__(self, episode: NovelEpisode):
        self.episode = episode
        self.loaded = False
        self.sqlite_store = _PropRecordingStore()

    async def load_graph_state(self):
        self.loaded = True

    def get_all_episodes(self):
        return [self.episode]

    def get_all_characters(self):
        character = NovelCharacter(name="秦")
        character.identities = [
            CharacterIdentity(
                character_name="秦",
                identity_id="秦_青年",
                identity_name="青年",
                appearance_details="青衣",
            )
        ]
        return [character]

    def get_cached_prop(self, name: str):
        return self.sqlite_store.cached_props.get(name)


class _PropRecordingStore:
    def __init__(self):
        self.cached_props: dict[str, NovelProp] = {}
        self.added_props: list[NovelProp] = []

    async def list_props(self):
        return list(self.cached_props.values())

    async def add_prop(self, prop: NovelProp):
        self.cached_props[prop.name] = prop
        self.added_props.append(prop)


class _FakeAssetCompiler:
    def __init__(self, store: _CogneeEpisodeStore):
        self.store = store

    async def compile_episode_scenes(self, episode, on_log=None):
        if on_log:
            on_log("planned scenes")
        scene_menu = [{"scene_id": "宫门"}]
        self.store.episode.scene_menu = scene_menu
        return self.store.episode.scene_menu, 1

    async def compile_episode_props(self, episode, on_log=None):
        if on_log:
            on_log("planned props")
        prop_menu = [{"prop_id": "玉佩", "prop_type": "object"}]
        self.store.episode.prop_menu = prop_menu
        return self.store.episode.prop_menu


class _FakeIdentityPlanner:
    def __init__(self, store: _CogneeEpisodeStore):
        self.store = store

    async def plan_single_episode(self, episode, on_log=None):
        if on_log:
            on_log("planned identity")
        self.store.episode.identity_ids = ["秦_青年"]
        self.store.episode.character_names = ["秦"]
        self.store.episode.identity_default_map = {"秦": "秦_青年"}
        return 0, 1


def _patch_project_and_store(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _EpisodeStore,
) -> None:
    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=None,
            username=user.get("username", "admin"),
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def make_store(username: str, project: str):
        return store

    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "make_sqlite_store", make_store)


def _patch_project_and_cognee_store(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _CogneeEpisodeStore,
) -> None:
    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=None,
            username=user.get("username", "admin"),
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def make_store(username: str, project: str):
        return store

    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "make_cognee_store", make_store)
    monkeypatch.setattr(module, "AssetCompiler", _FakeAssetCompiler, raising=False)


def _patch_celery_episode_asset_planner(
    monkeypatch: pytest.MonkeyPatch,
    module,
):
    ctx = SimpleNamespace(project_id="proj_123")
    calls: list[dict] = []

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=Path("/tmp/demo"),
            output_dir="/tmp/demo/output",
            state_dir="/tmp/demo/state",
            runtime_dir="/tmp/demo/runtime",
        )

    async def enqueue_project_task(ctx_arg, **kwargs):
        calls.append({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-123"),
            backend="celery",
            queue="node.node_a.default",
        )

    async def fail_if_sync_store_is_used(*args, **kwargs):
        raise AssertionError("episode asset planning must enqueue a Celery task")
    monkeypatch.setattr(module, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(module, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task))
    monkeypatch.setattr(module, "make_cognee_store_for_context", fail_if_sync_store_is_used)
    monkeypatch.setattr(
        module,
        "_episode_asset_task_scope",
        lambda kind, episode_num: f"{kind}_run_test",
    )
    return calls


@pytest.mark.asyncio
async def test_get_episode_detail_returns_nicegui_fields(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(
        number=1,
        title="第一集",
        raw_content="原文",
        beat_source_text="分镜源文本",
        content_summary="摘要",
        character_names=["秦"],
        key_events=["入宫"],
        cliffhanger="悬念",
        identity_ids=["秦_幼年"],
        identity_default_map={"秦": "秦_幼年"},
        scene_menu=[{"scene_id": "宫门", "scene_name": "宫门"}],
        prop_menu=[{"prop_id": "玉佩", "prop_name": "玉佩"}],
    )
    _patch_project_and_store(
        monkeypatch,
        episodes,
        tmp_path,
        _EpisodeStore(episode),
    )

    response = await episodes.get_episode_detail(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"] == {
        "number": 1,
        "title": "第一集",
        "summary": "摘要",
        "raw_content": "原文",
        "beat_source_text": "分镜源文本",
        "content_summary": "摘要",
        "character_names": ["秦"],
        "key_events": ["入宫"],
        "cliffhanger": "悬念",
        "identity_ids": ["秦_幼年"],
        "identity_default_map": {"秦": "秦_幼年"},
        "scene_menu": [
            {
                "scene_id": "宫门",
                "base_scene_id": "",
                "variant_id": "",
                "time_of_day": "",
            }
        ],
        "prop_menu": [
            {
                "prop_id": "玉佩",
                "prop_type": "object",
                "visual_prompt": "",
                "description": "",
                "owner_identity_id": "",
                "marker_color": "",
            }
        ],
    }


@pytest.mark.asyncio
async def test_list_episodes_returns_fields_needed_by_react_workbench(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(
        number=1,
        title="第一集",
        content_summary="摘要",
        identity_ids=["秦_幼年", "赵_青年"],
        key_events=["入宫", "交锋"],
        scene_menu=[{"scene_id": "宫门"}],
        prop_menu=[{"prop_id": "玉佩", "prop_type": "object"}],
    )
    _patch_project_and_store(
        monkeypatch,
        episodes,
        tmp_path,
        _EpisodeStore(episode),
    )

    response = await episodes.list_episodes(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"] == [
        {
            "number": 1,
            "title": "第一集",
            "summary": "摘要",
            "identity_ids": ["秦_幼年", "赵_青年"],
            "key_events": ["入宫", "交锋"],
            "scene_menu": [
                {
                    "scene_id": "宫门",
                    "base_scene_id": "",
                    "variant_id": "",
                    "time_of_day": "",
                }
            ],
            "prop_menu": [
                {
                    "prop_id": "玉佩",
                    "prop_type": "object",
                    "visual_prompt": "",
                    "description": "",
                    "owner_identity_id": "",
                    "marker_color": "",
                }
            ],
        }
    ]


@pytest.mark.asyncio
async def test_patch_episode_source_fields_persists_and_returns_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    episode = NovelEpisode(number=1, title="第一集")
    store = _EpisodeStore(episode)
    _patch_project_and_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.update_episode(
        project="demo",
        episode_num=1,
        body=EpisodeUpdate(
            beat_source_text="新分镜源文本",
            identity_default_map={"秦": "秦_青年"},
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["beat_source_text"] == "新分镜源文本"
    assert response["data"]["identity_default_map"] == {"秦": "秦_青年"}
    assert store.updates == [
        (
            1,
            {
                "beat_source_text": "新分镜源文本",
                "identity_default_map": {"秦": "秦_青年"},
            },
        )
    ]


@pytest.mark.asyncio
async def test_plan_episode_identities_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    ctx = SimpleNamespace(project_id="proj_123")
    calls: list[dict] = []

    async def resolve_project_scope(project: str, user: dict, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=Path("/tmp/demo"),
            output_dir="/tmp/demo/output",
            state_dir="/tmp/demo/state",
            runtime_dir="/tmp/demo/runtime",
        )

    async def enqueue_project_task(ctx_arg, **kwargs):
        calls.append({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-identity"),
            backend="celery",
            queue="node.node_a.default",
        )

    async def fail_if_sync_store_is_used(*args, **kwargs):
        raise AssertionError("identity planning API must enqueue a Celery task")
    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task))
    monkeypatch.setattr(episodes, "make_cognee_store", fail_if_sync_store_is_used)

    response = await episodes.plan_episode_identities(
        project="proj_123",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["task_type"] == "identity_planner"
    assert response["task_id"] == "task-identity"
    assert response["task_key"] == "task:identity_planner:project:proj_123:1"
    assert response["backend"] == "celery"
    assert response["queue"] == "node.node_a.default"
    assert response["data"] == {"target_episode": 1}
    assert calls == [
        {
            "ctx": ctx,
            "task_type": "identity_planner",
            "queue_kind": "default",
            "episode": 1,
            "payload": {"episode": 1},
        }
    ]


@pytest.mark.asyncio
async def test_plan_episode_scenes_returns_updated_episode_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes
    episode = NovelEpisode(number=1, title="第一集", beat_source_text="第一行")
    store = _CogneeEpisodeStore(episode)
    _patch_project_and_cognee_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.plan_episode_scenes(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert store.loaded is True
    assert response["data"]["kind"] == "scene"
    assert response["data"]["new_count"] == 1
    assert response["data"]["total_count"] == 1
    expected_menu_item = {
        "scene_id": "宫门",
        "base_scene_id": "",
        "variant_id": "",
        "time_of_day": "",
    }
    assert response["data"]["scene_menu"] == [expected_menu_item]
    assert response["data"]["episode"]["scene_menu"] == [expected_menu_item]
    assert response["data"]["logs"] == ["planned scenes"]


@pytest.mark.asyncio
async def test_plan_episode_scenes_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    calls = _patch_celery_episode_asset_planner(monkeypatch, episodes)

    response = await episodes.plan_episode_scenes(
        project="proj_123",
        episode_num=4,
        user={"username": "admin"},
    )

    assert response == {
        "ok": True,
        "task_type": "episode_scene_planner",
        "scope": "scene_run_test",
        "task_id": "task-123",
        "task_key": "task:episode_scene_planner:project:proj_123:4:scene_run_test",
        "backend": "celery",
        "queue": "node.node_a.default",
        "data": {"target_episode": 4, "asset_kind": "scene"},
        "message": "第 4 集场景规划已进入队列",
    }
    assert calls == [
        {
            "ctx": calls[0]["ctx"],
            "task_type": "episode_scene_planner",
            "queue_kind": "default",
            "episode": 4,
            "scope": "scene_run_test",
            "payload": {"episode": 4, "asset_kind": "scene"},
        }
    ]


@pytest.mark.asyncio
async def test_plan_episode_props_returns_updated_episode_detail(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes
    episode = NovelEpisode(number=1, title="第一集", beat_source_text="第一行")
    store = _CogneeEpisodeStore(episode)
    _patch_project_and_cognee_store(monkeypatch, episodes, tmp_path, store)

    response = await episodes.plan_episode_props(
        project="demo",
        episode_num=1,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert store.loaded is True
    assert response["data"]["kind"] == "prop"
    assert response["data"]["total_count"] == 1
    assert response["data"]["prop_menu"] == [
        {
            "prop_id": "玉佩",
            "prop_type": "object",
            "visual_prompt": "",
            "description": "",
            "owner_identity_id": "",
            "marker_color": "",
        }
    ]
    assert response["data"]["episode"]["prop_menu"] == [
        {
            "prop_id": "玉佩",
            "prop_type": "object",
            "visual_prompt": "",
            "description": "",
            "owner_identity_id": "",
            "marker_color": "",
        }
    ]
    assert response["data"]["logs"] == ["planned props"]
    assert [prop.name for prop in store.sqlite_store.added_props] == ["玉佩"]
    assert store.sqlite_store.cached_props["玉佩"].prop_type == "object"
    assert store.get_cached_prop("玉佩") is not None


@pytest.mark.asyncio
async def test_plan_episode_props_enqueues_celery_task(monkeypatch):
    from novelvideo.api.routes import episodes

    calls = _patch_celery_episode_asset_planner(monkeypatch, episodes)

    response = await episodes.plan_episode_props(
        project="proj_123",
        episode_num=4,
        user={"username": "admin"},
    )

    assert response == {
        "ok": True,
        "task_type": "episode_prop_planner",
        "scope": "prop_run_test",
        "task_id": "task-123",
        "task_key": "task:episode_prop_planner:project:proj_123:4:prop_run_test",
        "backend": "celery",
        "queue": "node.node_a.default",
        "data": {"target_episode": 4, "asset_kind": "prop"},
        "message": "第 4 集道具规划已进入队列",
    }
    assert calls == [
        {
            "ctx": calls[0]["ctx"],
            "task_type": "episode_prop_planner",
            "queue_kind": "default",
            "episode": 4,
            "scope": "prop_run_test",
            "payload": {"episode": 4, "asset_kind": "prop"},
        }
    ]
