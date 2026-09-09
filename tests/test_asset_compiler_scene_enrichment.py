from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo.models import NovelScene

ENRICHED_ENVIRONMENT_PROMPT = "正面：临街玻璃窗\n左侧：咖啡吧台\n右侧：木质书架\n背面：入口木门"


async def _return_async(value):
    return value


class _FakeSQLiteStore:
    def __init__(
        self, scenes: list[NovelScene] | None = None, *, raw_content: str = ""
    ):
        # The real SQLiteStore owns episode content; CogneeStore only delegates
        # to it. Keeping the fake the same way round means planners that talk to
        # the SQLite store directly resolve content exactly as they do in
        # production.
        self.raw_content = raw_content
        self.scenes = {scene.name: scene for scene in scenes or []}
        self.added: list[NovelScene] = []
        self.updated: list[tuple[str, dict]] = []
        self.patched: list[tuple[int, dict]] = []

    async def load_episode_content(self, ep_num: int):
        return self.raw_content

    async def get_scene(self, name: str):
        return self.scenes.get(name)

    async def list_scenes(self):
        return list(self.scenes.values())

    async def add_scene(self, scene: NovelScene):
        self.added.append(scene)
        self.scenes[scene.name] = scene

    async def update_scene(self, name: str, **updates):
        self.updated.append((name, updates))
        scene = self.scenes[name]
        for key, value in updates.items():
            setattr(scene, key, value)
        return True

    async def patch_episode(self, episode_number: int, **updates):
        # Menu writes go through the column-level patch so concurrent scene and
        # prop planning cannot overwrite each other.
        self.patched.append((episode_number, updates))
        return None


class _FakeCogneeStore:
    def __init__(
        self,
        scenes: list[NovelScene] | None = None,
        *,
        raw_content: str = "",
        project_dir: str = "",
    ):
        self.sqlite_store = _FakeSQLiteStore(scenes, raw_content=raw_content)
        self.project_dir = project_dir
        self.raw_content = raw_content
        self.updated: list[tuple[int, dict]] = []

    async def load_episode_content(self, ep_num: int):
        return await self.sqlite_store.load_episode_content(ep_num)

    async def update_episode(self, episode_number: int, **updates):
        self.updated.append((episode_number, updates))
        return None


def _block(location: str = "咖啡馆", time_of_day: str = "夜"):
    return SimpleNamespace(
        location=location,
        interior_exterior="内",
        time_of_day=time_of_day,
        characters=["陆辰", "沈月白"],
        header_line=f"场次（1）地点：{location}，{time_of_day}，内；出场人物：陆辰、沈月白",
        lines=[
            "窗外暴雨如注，雨滴重重砸在玻璃上。",
            "咖啡馆内只有他们这一桌，昏黄的灯光将两人的影子拉得很长。",
            "沈月白将自己的手机推到桌子中央。",
        ],
    )


@pytest.mark.asyncio
async def test_drama_scene_planning_uses_screenplay_normalizer_as_primary(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler
    from novelvideo.cognee.screenplay_normalizer import NormalizedSceneHeader

    calls = []

    async def fake_normalize(header_line, **hints):
        calls.append((header_line, hints))
        return NormalizedSceneHeader(
            episode_number=1,
            scene_no="2",
            location="菩提寝房",
            time_of_day="夜",
            interior_exterior="内",
        )

    monkeypatch.setattr(asset_compiler, "normalize_screenplay_scene_header", fake_normalize)

    compiler = asset_compiler.AssetCompiler(_FakeCogneeStore())
    original = SimpleNamespace(
        header_line="1-2 菩提寝房 夜 内",
        location="菩提寝房",
        time_of_day="夜",
        interior_exterior="内",
        characters=["孙悟空", "菩提祖师"],
        lines=["孙悟空跪坐在蒲团上。"],
    )
    blocks = await compiler._normalize_scene_block_headers(
        [original],
        lambda _message: None,
    )

    assert calls == [
        (
            "1-2 菩提寝房 夜 内",
            {
                "location_hint": "菩提寝房",
                "time_of_day_hint": "夜",
                "interior_exterior_hint": "内",
                "context_lines": ["孙悟空跪坐在蒲团上。"],
            },
        )
    ]
    assert len(blocks) == 1
    assert blocks[0].location == "菩提寝房"
    assert blocks[0].characters == ["孙悟空", "菩提祖师"]
    assert blocks[0].lines == ["孙悟空跪坐在蒲团上。"]


@pytest.mark.asyncio
async def test_drama_scene_planning_rejects_empty_normalizer_output(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_normalize(_header_line, **_hints):
        return None

    monkeypatch.setattr(asset_compiler, "normalize_screenplay_scene_header", fake_normalize)

    compiler = asset_compiler.AssetCompiler(_FakeCogneeStore())
    with pytest.raises(ValueError, match="AI 未识别到第 1 个有效场景头"):
        await compiler._normalize_scene_block_headers(
            [_block()],
            lambda _message: None,
        )


@pytest.mark.asyncio
async def test_compile_episode_scenes_reconciles_base_scene_before_planning(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="雨夜咖啡馆",
        )

    async def fake_derived(self, scene_name, block):
        return []

    async def fake_reconcile(self, source_text, episode, log):
        scene = await fake_enrich(
            scene_name="咖啡馆",
            scene_type="interior",
            context_lines=["窗外暴雨如注。"],
        )
        await self.cognee_store.sqlite_store.add_scene(scene)
        log("  AI补全基础场景: 咖啡馆")
        return ["咖啡馆"]

    async def fake_load_scene_blocks(self, episode):
        return [_block()]

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        lambda self, blocks, log: _return_async(blocks),
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fake_reconcile,
    )

    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="第一集", beat_source_text="场次（1）地点：咖啡馆"),
        lambda _message: None,
    )

    assert scene_menu[0].scene_id == "咖啡馆"
    assert new_count == 0
    assert [scene.name for scene in store.sqlite_store.added] == ["咖啡馆"]
    assert store.sqlite_store.scenes["咖啡馆"].environment_prompt.startswith("正面：临街玻璃窗")


@pytest.mark.asyncio
async def test_compile_episode_scenes_backfills_existing_empty_scene_prompt(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    existing = NovelScene(name="咖啡馆", scene_type="interior", environment_prompt="")

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type="interior",
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="雨夜咖啡馆",
        )

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore([existing])
    compiler = asset_compiler.AssetCompiler(store)

    _scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert pending_scenes == []
    assert store.sqlite_store.updated == [
        (
            "咖啡馆",
            {
                "scene_type": "interior",
                "environment_prompt": ENRICHED_ENVIRONMENT_PROMPT,
                "description": "雨夜咖啡馆",
            },
        )
    ]
    assert existing.environment_prompt.startswith("正面：临街玻璃窗")


@pytest.mark.asyncio
async def test_compile_episode_scenes_keeps_existing_prompt(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    existing = NovelScene(
        name="咖啡馆",
        scene_type="interior",
        environment_prompt="已有完整空间合同",
        description="已有描述",
    )
    enrich_calls = []

    async def fake_enrich(**kwargs):
        enrich_calls.append(kwargs)
        return NovelScene(name=kwargs["scene_name"], environment_prompt="不应使用")

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore([existing])
    compiler = asset_compiler.AssetCompiler(store)

    _scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert pending_scenes == []
    assert store.sqlite_store.updated == []
    assert enrich_calls == []
    assert existing.environment_prompt == "已有完整空间合同"


@pytest.mark.asyncio
async def test_compile_episode_scenes_creates_empty_time_plate_slot_for_repeated_time(
    monkeypatch,
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=[],
            scene_type="interior",
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="咖啡馆",
        )

    async def fake_derived(self, scene_name, block):
        return []

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="咖啡馆",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
                description="咖啡馆",
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block(time_of_day="夜"), _block(time_of_day="夜")],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["咖啡馆", "咖啡馆_夜晚"]
    assert scene_menu[1].base_scene_id == "咖啡馆"
    assert scene_menu[1].variant_id == ""
    assert scene_menu[1].time_of_day == "夜晚"
    time_plate = next(scene for scene in pending_scenes if scene.name == "咖啡馆_夜晚")
    assert time_plate.base_scene_id == "咖啡馆"
    assert time_plate.variant_id == ""
    assert time_plate.time_of_day == "夜晚"
    assert "空 plate 槽位" in time_plate.notes


@pytest.mark.asyncio
async def test_compile_episode_scenes_uses_narrated_fallback_without_scene_headers(
    monkeypatch, tmp_path
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_extract(self, source_text, episode, log):
        assert "医院走廊" in source_text
        return [
            NovelScene(
                name="医院走廊",
                scene_type="interior",
                environment_prompt="正面：护士站与急诊指示牌\n左侧：病房门\n右侧：候诊椅\n背面：电梯间",
                description="急诊楼医院走廊",
            )
        ]

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_extract_narrated_episode_scenes",
        fake_extract,
        raising=False,
    )
    monkeypatch.setattr(
        asset_compiler,
        "normalize_screenplay_scene_header",
        lambda *_args, **_kwargs: pytest.fail("解说剧不应调用 screenplay normalizer"),
    )

    store = _FakeCogneeStore(
        raw_content="林晚冲进医院走廊，护士站前的灯牌闪烁。",
        project_dir=str(tmp_path),
    )
    compiler = asset_compiler.AssetCompiler(store)
    compiler.spine_template = "narrated"
    episode = SimpleNamespace(number=1, title="第一集", beat_source_text="")

    scene_menu, new_count = await compiler.compile_episode_scenes(episode, lambda _message: None)

    assert new_count == 1
    assert scene_menu[0].scene_id == "医院走廊"
    assert store.sqlite_store.added[0].name == "医院走廊"
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]


@pytest.mark.asyncio
async def test_drama_without_scene_headers_uses_semantic_scene_planning(monkeypatch, tmp_path):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_load_scene_blocks(self, episode):
        return [
            SimpleNamespace(
                header_line="",
                location="",
                time_of_day="",
                interior_exterior="",
                characters=[],
                lines=["林晚冲进医院走廊，护士站前的灯牌闪烁。"],
            )
        ]

    async def fake_extract(self, source_text, episode, log):
        assert "医院走廊" in source_text
        return [
            NovelScene(
                name="医院走廊",
                scene_type="interior",
                environment_prompt="正面：护士站\n左侧：病房门\n右侧：候诊椅\n背面：电梯间",
                description="急诊楼医院走廊",
            )
        ]

    async def fail_normalize(self, scene_blocks, log):
        pytest.fail("无场景头的历史精品剧不应调用 screenplay normalizer")

    async def fail_reconcile(self, source_text, episode, log):
        pytest.fail("语义 fallback 不应进入场景头校对链路")

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_extract_narrated_episode_scenes",
        fake_extract,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        fail_normalize,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fail_reconcile,
    )

    store = _FakeCogneeStore(
        raw_content="林晚冲进医院走廊，护士站前的灯牌闪烁。",
        project_dir=str(tmp_path),
    )
    compiler = asset_compiler.AssetCompiler(store)
    compiler.spine_template = "drama"
    logs: list[str] = []

    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="第一集", beat_source_text=""),
        logs.append,
    )

    assert new_count == 1
    assert [item.scene_id for item in scene_menu] == ["医院走廊"]
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]
    assert any("项目类型仍保持精品剧" in message for message in logs)


@pytest.mark.asyncio
async def test_compile_scenes_promotes_stable_visual_states_to_pending_scenes(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="雨夜咖啡馆",
        )

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="暴雨版",
                description="窗外暴雨，玻璃挂满水痕",
                lighting="昏黄灯光",
                atmosphere="潮湿雨夜空气",
            )
        ]

    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="咖啡馆",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
                description="雨夜咖啡馆",
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["咖啡馆", "咖啡馆_暴雨版"]
    assert scene_menu[1].base_scene_id == "咖啡馆"
    assert scene_menu[1].variant_id == "暴雨版"
    assert [scene.name for scene in pending_scenes] == ["咖啡馆_暴雨版"]
    derived_scene = pending_scenes[0]
    assert derived_scene.name == "咖啡馆_暴雨版"
    assert not hasattr(derived_scene, "base_scene")
    assert derived_scene.aliases == ["咖啡馆"]
    assert derived_scene.environment_prompt == ""
    assert derived_scene.description == "窗外暴雨，玻璃挂满水痕"
    assert "窗外暴雨，玻璃挂满水痕" in derived_scene.variant_prompt
    assert "昏黄灯光" in derived_scene.variant_prompt
    assert "潮湿雨夜空气" in derived_scene.variant_prompt
    assert "正面：临街玻璃窗" not in derived_scene.variant_prompt


@pytest.mark.asyncio
async def test_compile_scenes_reuses_existing_derived_scene(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="暴雨版",
                description="窗外暴雨，玻璃挂满水痕",
                lighting="昏黄灯光",
                atmosphere="潮湿雨夜空气",
            )
        ]

    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="咖啡馆",
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            ),
            NovelScene(
                name="咖啡馆_暴雨版",
                scene_type="interior",
                base_scene_id="咖啡馆",
                variant_id="暴雨版",
                variant_prompt="已有暴雨版",
            ),
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    scene_menu, pending_scenes = await compiler._compile_scenes(
        [_block()],
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert [item.scene_id for item in scene_menu] == ["咖啡馆", "咖啡馆_暴雨版"]
    assert pending_scenes == []


@pytest.mark.asyncio
async def test_compile_episode_scenes_persists_base_and_derived_as_normal_scenes(
    monkeypatch, tmp_path
):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_load_scene_blocks(self, episode):
        return [_block()]

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            description="雨夜咖啡馆",
        )

    async def fake_derived(self, scene_name, block):
        return [
            asset_compiler.DerivedSceneRequirement(
                label="暴雨版",
                description="窗外暴雨，玻璃挂满水痕",
                lighting="昏黄灯光",
                atmosphere="潮湿雨夜空气",
            )
        ]

    async def fake_reconcile(self, source_text, episode, log):
        scene = await fake_enrich(
            scene_name="咖啡馆",
            scene_type="interior",
            context_lines=["窗外暴雨如注。"],
        )
        await self.cognee_store.sqlite_store.add_scene(scene)
        return ["咖啡馆"]

    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_load_scene_blocks",
        fake_load_scene_blocks,
    )
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_normalize_scene_block_headers",
        lambda self, blocks, log: _return_async(blocks),
    )
    monkeypatch.setattr(asset_compiler, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_derived_scenes", fake_derived)
    monkeypatch.setattr(
        asset_compiler.AssetCompiler,
        "_reconcile_base_scenes_from_text",
        fake_reconcile,
    )

    store = _FakeCogneeStore(project_dir=str(tmp_path))
    compiler = asset_compiler.AssetCompiler(store)
    scene_menu, new_count = await compiler.compile_episode_scenes(
        SimpleNamespace(number=1, title="第一集"),
        lambda _message: None,
    )

    assert new_count == 1
    assert [scene.name for scene in store.sqlite_store.added] == ["咖啡馆", "咖啡馆_暴雨版"]
    assert [item.scene_id for item in scene_menu] == ["咖啡馆", "咖啡馆_暴雨版"]
    assert scene_menu[1].base_scene_id == "咖啡馆"
    assert scene_menu[1].variant_id == "暴雨版"
    # Both tracks take the column-level patch, so concurrent scene and prop
    # planning cannot overwrite each other's menu.
    assert store.sqlite_store.patched == [(1, {"scene_menu": scene_menu})]


@pytest.mark.asyncio
async def test_base_scene_reconcile_strips_english_time_before_persisting(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    async def fake_enrich(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type=kwargs["scene_type"],
            environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
        )

    monkeypatch.setattr(
        asset_compiler,
        "enrich_scene_environment_from_context",
        fake_enrich,
    )
    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)

    created = await compiler._apply_base_scene_reconcile_output(
        asset_compiler.EpisodeBaseSceneReconcileOutput(
            scenes=[
                asset_compiler.BaseSceneReconcileDecision(
                    action="create",
                    scene_name="Seoul Subway Station 11:47 PM",
                    scene_type="interior",
                    evidence_lines=["Location: Seoul Subway Station"],
                )
            ]
        ),
        "Location: Seoul Subway Station\nTime: 11:47 PM",
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert created == ["Seoul Subway Station"]
    assert sorted(store.sqlite_store.scenes) == ["Seoul Subway Station"]


@pytest.mark.asyncio
async def test_base_scene_reconcile_does_not_create_existing_alias():
    import novelvideo.agents.asset_compiler as asset_compiler

    store = _FakeCogneeStore(
        [
            NovelScene(
                name="医院走廊",
                aliases=["急诊走廊"],
                scene_type="interior",
                environment_prompt=ENRICHED_ENVIRONMENT_PROMPT,
            )
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    created = await compiler._apply_base_scene_reconcile_output(
        asset_compiler.EpisodeBaseSceneReconcileOutput(
            scenes=[
                asset_compiler.BaseSceneReconcileDecision(
                    action="create",
                    scene_name="急诊走廊",
                    scene_type="interior",
                    evidence_lines=["急诊走廊里灯牌闪烁。"],
                )
            ]
        ),
        "急诊走廊里灯牌闪烁。",
        SimpleNamespace(number=1),
        lambda _message: None,
    )

    assert created == []
    assert sorted(store.sqlite_store.scenes) == ["医院走廊"]


@pytest.mark.asyncio
async def test_find_matching_scene_treats_independent_underscore_scene_as_base_candidate():
    import novelvideo.agents.asset_compiler as asset_compiler

    store = _FakeCogneeStore(
        [
            NovelScene(name="地下", aliases=[], scene_type="interior"),
            NovelScene(name="地下_主控室", aliases=["主控室"], scene_type="interior"),
            NovelScene(
                name="地下_漏水",
                base_scene_id="地下",
                variant_id="漏水",
                scene_type="interior",
            ),
        ]
    )
    compiler = asset_compiler.AssetCompiler(store)

    matched = await compiler._find_matching_scene("主控室")

    assert matched is not None
    assert matched.name == "地下_主控室"


def test_derived_scene_normalization_filters_plain_time_but_keeps_stable_light_plate():
    import novelvideo.agents.asset_compiler as asset_compiler

    normalized = asset_compiler.AssetCompiler._build_derived_scene_specs(
        [
            asset_compiler.DerivedSceneRequirement(label="夜晚", description="普通夜间时段"),
            asset_compiler.DerivedSceneRequirement(
                label="暴雨夜霓虹版",
                description="暴雨夜晚，霓虹灯在积水中反射",
                lighting="高对比霓虹反光",
                atmosphere="雨幕和湿冷空气",
            ),
            asset_compiler.DerivedSceneRequirement(label="特写", description="镜头语言"),
        ]
    )

    assert [item.label for item in normalized] == ["暴雨夜霓虹版"]


@pytest.mark.asyncio
async def test_menu_writes_go_through_the_column_patch(tmp_path):
    """Every project gets the race-free write, whichever track it is on."""
    import json

    from novelvideo.agents.asset_compiler import AssetCompiler
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED,
    )

    state_dir = tmp_path / "structured"
    state_dir.mkdir()
    (state_dir / "project_config.json").write_text(
        json.dumps({KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED}),
        encoding="utf-8",
    )

    store = _FakeCogneeStore(project_dir=str(state_dir))
    store.state_dir = str(state_dir)
    compiler = AssetCompiler(store)
    await compiler._write_menus(1, scene_menu=[])

    assert store.sqlite_store.patched == [(1, {"scene_menu": []})]
    assert store.updated == []
