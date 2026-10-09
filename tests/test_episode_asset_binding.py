# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Regression tests for asset planning before and after literal script creation."""

from hashlib import sha256
import sqlite3
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from novelvideo.agents.asset_compiler import AssetCompiler
from novelvideo.cognee.pipeline import NovelEpisode
from novelvideo.cognee.store import CogneeStore
from novelvideo.models import (
    NovelProp,
    NovelScene,
    NovelVisualBeat,
    PropMenuItem,
    SceneMenuItem,
)
from novelvideo.sqlite_store import SQLITE_SCHEMA_SQL, SQLiteStore
from novelvideo.workflows.literal_script_writing import (
    LiteralBeatMetaOutput,
    LiteralScriptWritingWorkflow,
)
from novelvideo.workflows.script_writing import create_script_writing_workflow

SOURCE = "1-1 场景：地医房 深夜 内\n△月牙铁剪摆在石台上。\n1-2 场景：石台前 深夜 内\n△烛火照亮墙壁。"
MENU = [SceneMenuItem(scene_id="地医房"), SceneMenuItem(scene_id="石台前")]
SOURCE_SHA256 = sha256(SOURCE.encode("utf-8")).hexdigest()


@pytest.fixture
async def store(tmp_path):
    result = SQLiteStore(
        "test/project", output_dir=str(tmp_path), state_dir=str(tmp_path)
    )
    await result.initialize()
    await result.add_episodes(
        [NovelEpisode(number=1, title="第一集", beat_source_text=SOURCE)]
    )
    yield result
    await result.close()


async def test_version_four_project_upgrades_generation_source_without_data_loss(
    tmp_path,
):
    db_path = tmp_path / "data.db"
    with sqlite3.connect(db_path) as db:
        db.executescript(
            SQLITE_SCHEMA_SQL.replace(
                "    source_text_sha256     TEXT DEFAULT '',\n", ""
            )
        )
        assert "source_text_sha256" not in {
            row[1] for row in db.execute("PRAGMA table_info(beats)")
        }
        db.execute("PRAGMA journal_mode=WAL")
        db.execute(
            "CREATE TABLE novelvideo_schema_components (component TEXT PRIMARY KEY, version INTEGER NOT NULL)"
        )
        db.execute(
            "INSERT INTO novelvideo_schema_components VALUES ('project_store', 4)"
        )
        db.execute(
            "INSERT INTO beats (episode_number, beat_number, narration, visual_description) VALUES (1, 1, '原旁白。', '旧镜头。')"
        )
    upgraded = SQLiteStore(
        "test/upgraded", output_dir=str(tmp_path), state_dir=str(tmp_path)
    )
    try:
        await upgraded.initialize()
        async with (await upgraded._ensure_db()).execute(
            "SELECT version FROM novelvideo_schema_components WHERE component = 'project_store'"
        ) as cursor:
            assert (await cursor.fetchone())[0] >= 5
        await upgraded.add_visual_beats(
            [
                NovelVisualBeat(
                    episode_number=1, beat_number=2, source_text_sha256=SOURCE_SHA256
                )
            ]
        )
        beats = await upgraded.get_beats_for_episode(1)
        assert beats[0].narration == "原旁白。"
        assert beats[0].visual_description == "旧镜头。"
        assert beats[0].source_text_sha256 == ""
        assert beats[1].source_text_sha256 == SOURCE_SHA256
    finally:
        await upgraded.close()


@pytest.mark.parametrize("key", ["valid_identity_ids", "valid_prop_ids"])
def test_explicit_empty_asset_scope_rejects_unknown_markers(key):
    description = (
        "{{未知_青年}}走到窗边。"
        if key == "valid_identity_ids"
        else "石台上放着[[未知玉佩]]。"
    )
    with pytest.raises(ValidationError, match="非法"):
        LiteralBeatMetaOutput.model_validate(
            {"visual_description": description},
            context={key: set()},
        )


def test_explicit_empty_scene_scope_discards_unknown_scene():
    output = LiteralBeatMetaOutput.model_validate(
        {"visual_description": "烛光照亮昏暗的房间。", "scene_id": "未知场景"},
        context={"valid_scene_ids": set()},
    )
    assert output.scene_id == ""


def test_absent_validation_context_keeps_standalone_outputs_usable():
    output = LiteralBeatMetaOutput.model_validate(
        {
            "visual_description": "{{未知_青年}}拿着[[未知玉佩]]。",
            "scene_id": "未知场景",
        }
    )
    assert output.scene_id == "未知场景"


@pytest.mark.parametrize("shared", [False, True])
async def test_script_generation_prepares_missing_menus_before_metadata(
    monkeypatch, tmp_path, shared
):
    class ScriptStore:
        output_dir = str(tmp_path)
        _props = {"月牙铁剪": NovelProp(name="月牙铁剪")}

        def __init__(self):
            self.episode = SimpleNamespace(
                number=1,
                title="第一集",
                identity_ids=[],
                identity_default_map={},
                scene_menu=[],
                prop_menu=[],
                beat_source_text="旧工作稿",
            )

        async def load_graph_state(self):
            pass

        async def get_episode_from_graph(self, number):
            return self.episode

        def get_episode(self, number):
            return self.episode

        def get_all_characters(self):
            return []

        async def persist_narration_script(self, script):
            self.script = script

    script_store = ScriptStore()
    planned = []

    async def plan_scenes(self, episode, **kwargs):
        planned.append(("scenes", episode.beat_source_text))
        return MENU, 0

    async def plan_props(self, episode, **kwargs):
        planned.append(("props", episode.beat_source_text))
        return [PropMenuItem(prop_id="月牙铁剪")]

    class Agent:
        async def run(self, prompt):
            assert len(planned) == 2, "metadata ran before missing asset planning"
            assert "月牙铁剪" in prompt if "1/2" in prompt else True
            return SimpleNamespace(
                output=LiteralBeatMetaOutput(
                    visual_description="烛光照亮昏暗的房间。",
                )
            )

    monkeypatch.setattr(AssetCompiler, "compile_episode_scenes", plan_scenes)
    monkeypatch.setattr(AssetCompiler, "compile_episode_props", plan_props)
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow, "agent", property(lambda self: Agent())
    )
    workflow = (
        create_script_writing_workflow(script_store)
        if shared
        else LiteralScriptWritingWorkflow(script_store)
    )
    result = await workflow.run(episode_num=1, source_text=SOURCE)
    assert [
        beat.scene_ref.scene_id if beat.scene_ref else None for beat in result.beats
    ] == ["地医房", "石台前"]
    assert planned == [("scenes", SOURCE), ("props", SOURCE)]
    assert script_store.episode.beat_source_text == "旧工作稿"


async def test_late_scene_planning_fills_only_missing_generated_shots(
    store, monkeypatch
):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1,
                beat_number=1,
                visual_description="月牙铁剪摆在石台上。",
                source_text_sha256=SOURCE_SHA256,
            ),
            NovelVisualBeat(
                episode_number=1,
                beat_number=2,
                visual_description="烛火照亮墙壁。",
                scene_ref_json='{"scene_id":"已选场景","variant_id":"雨夜"}',
                source_text_sha256=SOURCE_SHA256,
            ),
            NovelVisualBeat(
                episode_number=1,
                beat_number=99,
                visual_description="手工空镜。",
                is_manual_shot=True,
                shot_order=15,
            ),
        ]
    )

    async def normalize(self, blocks, log):
        return blocks

    async def reconcile(self, *args):
        return []

    async def compile_scenes(self, *args):
        return MENU, []

    monkeypatch.setattr(AssetCompiler, "_normalize_scene_block_headers", normalize)
    monkeypatch.setattr(AssetCompiler, "_reconcile_base_scenes_from_text", reconcile)
    monkeypatch.setattr(AssetCompiler, "_compile_scenes", compile_scenes)

    await AssetCompiler(store).compile_episode_scenes(store.get_episode(1))
    rows = {row["beat_number"]: row for row in await store.get_beats_as_dicts(1)}
    assert rows[1]["scene_ref"] is not None
    assert rows[1]["scene_ref"]["scene_id"] == "地医房"
    assert rows[2]["scene_ref"]["scene_id"] == "已选场景"
    assert rows[2]["scene_ref"]["variant_id"] == "雨夜"
    assert rows[99]["scene_ref"] is None
    assert rows[1]["visual_description"] == "月牙铁剪摆在石台上。"


async def test_backfill_refuses_source_and_generated_shot_count_mismatch(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, visual_description="旧版本镜头。"
            ),
        ]
    )
    count = await AssetCompiler(store).backfill_missing_scene_refs(
        store.get_episode(1), MENU
    )
    assert count == 0
    assert (await store.get_beats_as_dicts(1))[0]["scene_ref"] is None


async def test_backfill_does_not_bind_old_shots_to_same_length_edited_source(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1,
                beat_number=1,
                visual_description="月牙铁剪摆在石台上。",
                source_text_sha256=SOURCE_SHA256,
            ),
            NovelVisualBeat(
                episode_number=1,
                beat_number=2,
                visual_description="烛火照亮墙壁。",
                source_text_sha256=SOURCE_SHA256,
            ),
        ]
    )
    await store.patch_episode(1, beat_source_text=SOURCE.replace("地医房", "御书房"))
    count = await AssetCompiler(store).backfill_missing_scene_refs(
        store.get_episode(1),
        [SceneMenuItem(scene_id="御书房"), SceneMenuItem(scene_id="石台前")],
    )
    assert count == 0
    assert all(row["scene_ref"] is None for row in await store.get_beats_as_dicts(1))


async def test_backfill_skips_legacy_shots_without_generation_source(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, visual_description="旧镜头一。"
            ),
            NovelVisualBeat(
                episode_number=1, beat_number=2, visual_description="旧镜头二。"
            ),
        ]
    )
    assert (
        await AssetCompiler(store).backfill_missing_scene_refs(
            store.get_episode(1), MENU
        )
        == 0
    )
    assert all(row["scene_ref"] is None for row in await store.get_beats_as_dicts(1))


async def test_generated_source_survives_persistence_and_allows_safe_backfill(
    store, monkeypatch
):
    await store.patch_episode(
        1, scene_menu=MENU, prop_menu=[PropMenuItem(prop_id="月牙铁剪")]
    )
    cognee_store = CogneeStore("test/project", sqlite_store=store)

    class Agent:
        async def run(self, prompt):
            return SimpleNamespace(
                output=LiteralBeatMetaOutput(visual_description="昏暗的室内画面。")
            )

    monkeypatch.setattr(
        LiteralScriptWritingWorkflow, "agent", property(lambda self: Agent())
    )
    await LiteralScriptWritingWorkflow(cognee_store).run(
        episode_num=1, source_text=SOURCE
    )
    db = await store._ensure_db()
    await db.execute("UPDATE beats SET scene_ref_json = '' WHERE episode_number = 1")
    await db.commit()
    count = await AssetCompiler(cognee_store).backfill_missing_scene_refs(
        store.get_episode(1), MENU
    )
    assert count == 2
    beats = await store.get_beats_for_episode(1)
    assert [beat.scene_id for beat in beats] == ["地医房", "石台前"]
    assert all(
        getattr(beat, "source_text_sha256", "") == SOURCE_SHA256 for beat in beats
    )


async def test_storage_backfill_rejects_replaced_generation(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, source_text_sha256="new-generation"
            )
        ]
    )
    count = await store.fill_missing_beat_scene_refs(
        1,
        [
            {
                "beat_number": 1,
                "scene_ref": {"scene_id": "地医房"},
                "source_text_sha256": "old-generation",
            }
        ],
    )
    assert count == 0
    assert (await store.get_beats_as_dicts(1))[0]["scene_ref"] is None


async def test_editing_generated_shot_invalidates_automatic_source_alignment(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, source_text_sha256=SOURCE_SHA256
            )
        ]
    )
    await store.update_beat_asset(1, 1, visual_description="改为御书房内的新镜头。")
    count = await store.fill_missing_beat_scene_refs(
        1,
        [
            {
                "beat_number": 1,
                "scene_ref": {"scene_id": "地医房"},
                "source_text_sha256": SOURCE_SHA256,
            }
        ],
    )
    assert count == 0


async def test_storage_backfill_preserves_scene_selected_after_snapshot(store):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1,
                beat_number=1,
                visual_description="石台上的铁剪。",
                source_text_sha256=SOURCE_SHA256,
            ),
            NovelVisualBeat(
                episode_number=1,
                beat_number=99,
                visual_description="手工空镜。",
                is_manual_shot=True,
            ),
        ]
    )
    # A stale planner snapshot still shows no scene, but a user has since saved
    # one. The database predicate must preserve that selection.
    await store.update_beat_asset(1, 1, scene_ref={"scene_id": "用户刚选的场景"})
    count = await store.fill_missing_beat_scene_refs(
        1,
        [
            {
                "beat_number": 1,
                "scene_ref": {"scene_id": "地医房"},
                "source_text_sha256": SOURCE_SHA256,
            },
            {
                "beat_number": 99,
                "scene_ref": {"scene_id": "地医房"},
                "source_text_sha256": SOURCE_SHA256,
            },
        ],
    )
    rows = {row["beat_number"]: row for row in await store.get_beats_as_dicts(1)}
    assert count == 0
    assert rows[1]["scene_ref"]["scene_id"] == "用户刚选的场景"
    assert rows[99]["scene_ref"] is None


async def test_script_asset_preparation_failure_keeps_old_beats(store, monkeypatch):
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, visual_description="旧镜头。"
            ),
        ]
    )

    async def plan_scenes(self, episode, *, backfill_existing_beats=True, **kwargs):
        assert backfill_existing_beats is False
        return MENU, 0

    async def plan_props(self, episode, **kwargs):
        raise ValueError("prop planning failed")

    monkeypatch.setattr(AssetCompiler, "compile_episode_scenes", plan_scenes)
    monkeypatch.setattr(AssetCompiler, "compile_episode_props", plan_props)
    with pytest.raises(ValueError, match="prop planning failed"):
        await AssetCompiler(store).ensure_episode_menus(
            store.get_episode(1), source_text=SOURCE
        )
    old = (await store.get_beats_as_dicts(1))[0]
    assert old["scene_ref"] is None
    assert old["visual_description"] == "旧镜头。"


async def test_headerless_literal_text_can_keep_unknown_scene(store, monkeypatch):
    async def scene_planning(self, *args, **kwargs):
        pytest.fail("headerless literal text must not require a scene")

    async def prop_planning(self, *args, **kwargs):
        return []

    monkeypatch.setattr(AssetCompiler, "compile_episode_scenes", scene_planning)
    monkeypatch.setattr(AssetCompiler, "compile_episode_props", prop_planning)
    episode = store.get_episode(1)
    await AssetCompiler(store).ensure_episode_menus(episode, source_text="黑屏。")
    assert episode.scene_menu == []


async def test_narrated_generation_accepts_legitimate_empty_scene_plan(
    store, monkeypatch
):
    async def no_scene_requirements(self, *args):
        return []

    async def no_prop_requirements(self, *args):
        return []

    class Agent:
        async def run(self, prompt):
            return SimpleNamespace(
                output=LiteralBeatMetaOutput(
                    visual_description="抽象的光影画面。", audio_type="narration"
                )
            )

    monkeypatch.setattr(
        AssetCompiler, "_analyze_narrated_scene_requirements", no_scene_requirements
    )
    monkeypatch.setattr(AssetCompiler, "_analyze_block_props", no_prop_requirements)
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow, "agent", property(lambda self: Agent())
    )
    workflow = LiteralScriptWritingWorkflow(
        CogneeStore("test/project", sqlite_store=store), audio_type_mode="narrated"
    )
    result = await workflow.run(
        episode_num=1, source_text="一个人的成功并不是偶然。\n它需要耐心与勇气。"
    )
    assert len(result.beats) == 2
    assert all(beat.scene_ref is None for beat in result.beats)
    assert (await store.get_episode_from_graph(1)).scene_menu == []


async def test_narrated_planning_failure_is_not_treated_as_legitimate_empty_scope(
    store, monkeypatch
):
    import novelvideo.agents.asset_compiler as module

    class BrokenAgent:
        async def run(self, prompt):
            raise RuntimeError("network unavailable")

    monkeypatch.setattr(module, "Agent", lambda *args, **kwargs: BrokenAgent())
    monkeypatch.setattr(
        module, "get_newapi_text_pydantic_model", lambda *args, **kwargs: None
    )
    await store.patch_episode(1, prop_menu=[PropMenuItem(prop_id="已有道具")])
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1, beat_number=1, visual_description="现有镜头。"
            )
        ]
    )
    compiler = AssetCompiler(store)
    compiler.spine_template = "narrated"
    with pytest.raises(ValueError, match="场景分析失败"):
        await compiler.ensure_episode_menus(
            store.get_episode(1),
            source_text="I walked into the emergency department.\nThe doctor checked my wrist.",
        )
    assert (await store.get_beats_for_episode(1))[0].visual_description == "现有镜头。"
    assert (await store.get_episode_from_graph(1)).scene_menu == []


async def test_scene_backfill_resolves_exact_alias_within_episode_scope(store):
    source = "1-1 场景：急诊部 白天 内\n△医生在柜台前停下。"
    await store.patch_episode(1, beat_source_text=source)
    await store.add_scene(NovelScene(name="医院急诊科", aliases=["急诊部"]))
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1,
                beat_number=1,
                source_text_sha256=sha256(source.encode("utf-8")).hexdigest(),
            )
        ]
    )
    count = await AssetCompiler(store).backfill_missing_scene_refs(
        store.get_episode(1), [SceneMenuItem(scene_id="医院急诊科")]
    )
    assert count == 1
    assert (await store.get_beats_for_episode(1))[0].scene_id == "医院急诊科"


async def test_scene_backfill_does_not_guess_between_ambiguous_partial_names(store):
    source = "1-1 场景：医院 白天 内\n△医生在柜台前停下。"
    await store.patch_episode(1, beat_source_text=source)
    await store.add_visual_beats(
        [
            NovelVisualBeat(
                episode_number=1,
                beat_number=1,
                source_text_sha256=sha256(source.encode("utf-8")).hexdigest(),
            )
        ]
    )
    count = await AssetCompiler(store).backfill_missing_scene_refs(
        store.get_episode(1),
        [SceneMenuItem(scene_id="医院急诊科"), SceneMenuItem(scene_id="医院门诊")],
    )
    assert count == 0
    assert (await store.get_beats_as_dicts(1))[0]["scene_ref"] is None


@pytest.mark.parametrize("kind", ["scene", "prop"])
async def test_automatic_planning_preserves_menu_selected_while_model_runs(
    store, monkeypatch, kind
):
    if kind == "scene":
        await store.patch_episode(1, prop_menu=[PropMenuItem(prop_id="预先道具")])
    else:
        await store.patch_episode(1, scene_menu=MENU)
    snapshot = await store.get_episode_from_graph(1)

    async def normalize(self, blocks, log):
        return blocks

    async def reconcile(self, *args):
        return []

    async def scenes(self, *args):
        await store.patch_episode(
            1, scene_menu=[SceneMenuItem(scene_id="用户选的御书房")]
        )
        return MENU, []

    async def props(self, *args):
        await store.patch_episode(1, prop_menu=[PropMenuItem(prop_id="用户选的玉佩")])
        return [PropMenuItem(prop_id="自动铁剪")]

    monkeypatch.setattr(AssetCompiler, "_normalize_scene_block_headers", normalize)
    monkeypatch.setattr(AssetCompiler, "_reconcile_base_scenes_from_text", reconcile)
    monkeypatch.setattr(AssetCompiler, "_compile_scenes", scenes)
    monkeypatch.setattr(AssetCompiler, "_compile_props", props)
    await AssetCompiler(store).ensure_episode_menus(snapshot, source_text=SOURCE)
    persisted = await store.get_episode_from_graph(1)
    if kind == "scene":
        assert [item.scene_id for item in persisted.scene_menu] == ["用户选的御书房"]
        assert [item.scene_id for item in snapshot.scene_menu] == ["用户选的御书房"]
    else:
        assert [item.prop_id for item in persisted.prop_menu] == ["用户选的玉佩"]
        assert [item.prop_id for item in snapshot.prop_menu] == ["用户选的玉佩"]
