import pytest

from novelvideo.cognee.screenplay_normalizer import (
    NormalizedSceneHeader,
    NormalizedSceneBlock,
    clean_scene_name_and_time,
    normalize_time_of_day,
    normalize_screenplay_scenes,
)


def test_normalize_time_of_day_maps_classical_terms_to_closed_choices():
    assert normalize_time_of_day("亥时") == "夜晚"
    assert normalize_time_of_day("三更") == "夜晚"
    assert normalize_time_of_day("深夜") == "夜晚"
    assert normalize_time_of_day("凌晨") == "夜晚"
    assert normalize_time_of_day("拂晓") == "清晨"
    assert normalize_time_of_day("午时") == "正午"
    assert normalize_time_of_day("日") == "白天"
    assert normalize_time_of_day("白天") == "白天"


def test_time_of_day_agent_outputs_expose_closed_enum_schema():
    from novelvideo.cognee import pipeline

    expected = ["无", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"]

    block_schema = NormalizedSceneBlock.model_json_schema()["properties"]["time_of_day"]
    scene_schema = pipeline.SceneNormalization.model_json_schema()["properties"]["time_of_day"]

    assert block_schema["enum"] == expected
    assert scene_schema["enum"] == expected


def test_time_of_day_agent_no_value_round_trips_to_internal_empty_string():
    from novelvideo.cognee import pipeline

    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1、凤鸣皇城·苏鸾寝殿 无 无",
        location="凤鸣皇城·苏鸾寝殿",
        time_of_day="无",
        interior_exterior="无",
        characters=[],
        aliases=[],
        scene_type="interior",
        evidence_lines=[],
        content_lines=[],
    )
    scene = pipeline.SceneNormalization(
        name="凤鸣皇城·苏鸾寝殿",
        aliases=[],
        scene_type="interior",
        time_of_day="无",
        interior=True,
        characters=[],
    )

    assert block.time_of_day == ""
    assert block.interior_exterior == ""
    assert scene.time_of_day == ""


def test_time_of_day_agent_outputs_normalize_before_literal_validation():
    from novelvideo.cognee import pipeline

    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1、凤鸣皇城·苏鸾寝殿 亥时 内",
        location="凤鸣皇城·苏鸾寝殿",
        time_of_day="亥时",
        interior_exterior="内",
        characters=[],
        aliases=[],
        scene_type="interior",
        evidence_lines=[],
        content_lines=[],
    )
    scene = pipeline.SceneNormalization(
        name="凤鸣皇城·苏鸾寝殿",
        aliases=[],
        scene_type="interior",
        time_of_day="凌晨",
        interior=True,
        characters=[],
    )

    assert block.time_of_day == "夜晚"
    assert scene.time_of_day == "夜晚"


def test_clean_scene_name_and_time_removes_trailing_classical_time():
    name, tod = clean_scene_name_and_time("凤鸣皇城·苏鸾寝殿 亥时", "")

    assert name == "凤鸣皇城·苏鸾寝殿"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_removes_attached_night_token_after_location():
    name, tod = clean_scene_name_and_time("凤鸣皇城·废弃粮仓夜", "")

    assert name == "凤鸣皇城·废弃粮仓"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_removes_attached_time_after_parenthesized_location_note():
    name, tod = clean_scene_name_and_time("御花园（东侧）夜", "")

    assert name == "御花园（东侧）"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_preserves_non_location_phrase_ending_with_single_time():
    name, tod = clean_scene_name_and_time("除夕夜", "")

    assert name == "除夕夜"
    assert tod == ""


def test_clean_scene_name_and_time_removes_attached_multi_char_time_token():
    name, tod = clean_scene_name_and_time("凤鸣皇城·废弃粮仓深夜", "")

    assert name == "凤鸣皇城·废弃粮仓"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_removes_dot_separated_night_token():
    name, tod = clean_scene_name_and_time("凤鸣皇城·演武场外墙·夜", "")

    assert name == "凤鸣皇城·演武场外墙"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_removes_nakaguro_separated_night_token():
    name, tod = clean_scene_name_and_time("演武场外墙・夜", "")

    assert name == "演武场外墙"
    assert tod == "夜晚"


def test_clean_scene_name_and_time_preserves_specific_location_anchor():
    name, tod = clean_scene_name_and_time("春熙路的3D大屏下", "")

    assert name == "春熙路的3D大屏下"
    assert tod == ""


def test_normalized_scene_block_validator_cleans_location_time():
    block = NormalizedSceneBlock(
        episode_number=3,
        scene_no="1",
        raw_header="3-1、凤鸣皇城·苏鸾寝殿 亥时 内",
        location="凤鸣皇城·苏鸾寝殿 亥时",
        time_of_day="",
        interior_exterior="内",
        characters=["苏糖", "沈晚"],
        aliases=[],
        scene_type="interior",
        evidence_lines=["3-1、凤鸣皇城·苏鸾寝殿 亥时 内"],
        content_lines=["△烛火跳动。"],
    )

    assert block.location == "凤鸣皇城·苏鸾寝殿"
    assert block.time_of_day == "夜晚"


def test_select_scene_primary_name_accepts_time_suffix_cleanup():
    from novelvideo.cognee.pipeline import _select_scene_primary_name

    assert _select_scene_primary_name("演武场外墙·夜", "演武场外墙") == "演武场外墙"
    assert _select_scene_primary_name("演武场外墙・夜", "演武场外墙") == "演武场外墙"
    assert (
        _select_scene_primary_name("凤鸣皇城·废弃粮仓夜", "凤鸣皇城·废弃粮仓")
        == "凤鸣皇城·废弃粮仓"
    )
    assert _select_scene_primary_name("兰州拉面馆", "面馆") == "兰州拉面馆"


def test_scene_candidates_fill_missing_episode_from_raw_header():
    from novelvideo.cognee.pipeline import _scene_candidates_from_normalized_blocks

    candidates = _scene_candidates_from_normalized_blocks(
        [
            NormalizedSceneBlock(
                episode_number=0,
                scene_no="1",
                raw_header="3-1、凤鸣皇城·苏鸾寝殿 夜 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="夜",
                interior_exterior="内",
                characters=["苏糖"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["3-1、凤鸣皇城·苏鸾寝殿 夜 内"],
                content_lines=["△苏糖醒来。"],
            ),
            NormalizedSceneBlock(
                episode_number=0,
                scene_no="1",
                raw_header="5-1、凤鸣皇城·苏鸾寝殿 亥时 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="亥时",
                interior_exterior="内",
                characters=["沈晚"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["5-1、凤鸣皇城·苏鸾寝殿 亥时 内"],
                content_lines=["△沈晚推门。"],
            ),
        ]
    )

    assert candidates[0]["episodes"] == [3, 5]


class _FakeRunResult:
    def __init__(self, output):
        self.output = output


class _FakeAgent:
    def __init__(self, output):
        self.output = output
        self.prompts = []

    async def run(self, prompt: str):
        self.prompts.append(prompt)
        return _FakeRunResult(self.output)


@pytest.mark.asyncio
async def test_normalize_screenplay_scenes_uses_agent_output():
    fake_agent = _FakeAgent(
        NormalizedSceneHeader(
            episode_number=3,
            scene_no="1",
            location="凤鸣皇城·苏鸾寝殿",
            time_of_day="亥时",
            interior_exterior="内",
            aliases=["苏鸾寝殿"],
            scene_type="interior",
        )
    )

    scenes = await normalize_screenplay_scenes(
        "3-1、凤鸣皇城·苏鸾寝殿 亥时 内\n人物：苏糖、沈晚、锦绣\n△寝殿内，床帐放下。",
        agent=fake_agent,
    )

    assert len(scenes) == 1
    assert scenes[0].location == "凤鸣皇城·苏鸾寝殿"
    assert scenes[0].time_of_day == "夜晚"
    assert scenes[0].characters == ["苏糖", "沈晚", "锦绣"]
    assert scenes[0].content_lines == ["△寝殿内，床帐放下。"]
    assert "3-1、凤鸣皇城·苏鸾寝殿 亥时 内" in fake_agent.prompts[0]
    assert "<scene_header>" in fake_agent.prompts[0]
    assert "</scene_header>" in fake_agent.prompts[0]
    assert "人物：苏糖、沈晚、锦绣" not in fake_agent.prompts[0]
    assert "<scene_context>" in fake_agent.prompts[0]
    assert "△寝殿内，床帐放下。" in fake_agent.prompts[0]
    assert "location 是稳定物理地点" not in fake_agent.prompts[0]


@pytest.mark.asyncio
async def test_normalize_screenplay_scenes_returns_empty_without_calling_agent():
    fake_agent = _FakeAgent(NormalizedSceneHeader(location="不会调用"))

    scenes = await normalize_screenplay_scenes(" \n\t ", agent=fake_agent)

    assert scenes == []
    assert fake_agent.prompts == []


@pytest.mark.asyncio
async def test_normalize_screenplay_scenes_calls_agent_once_per_scene_block():
    class _HeaderAgent:
        def __init__(self):
            self.prompts: list[str] = []

        async def run(self, prompt: str):
            self.prompts.append(prompt)
            location = "寝殿" if "1-1" in prompt else "山门"
            return _FakeRunResult(
                NormalizedSceneHeader(
                    episode_number=1,
                    scene_no=str(len(self.prompts)),
                    location=location,
                    time_of_day="夜晚" if location == "寝殿" else "白天",
                    interior_exterior="内" if location == "寝殿" else "外",
                )
            )

    fake_agent = _HeaderAgent()
    scenes = await normalize_screenplay_scenes(
        "1-1 寝殿 夜 内\n人物：悟空\n悟空：师父。\n"
        "1-2 山门 日 外\n人物：悟空、童子\n△悟空走出山门。",
        agent=fake_agent,
    )

    assert len(scenes) == 2
    assert [scene.location for scene in scenes] == ["寝殿", "山门"]
    assert [scene.content_lines for scene in scenes] == [
        ["悟空：师父。"],
        ["△悟空走出山门。"],
    ]
    assert len(fake_agent.prompts) == 2
    assert "1-2 山门 日 外" not in fake_agent.prompts[0]
    assert "悟空：师父。" in fake_agent.prompts[0]
    assert "△悟空走出山门。" not in fake_agent.prompts[0]
    assert "1-1 寝殿 夜 内" not in fake_agent.prompts[1]
    assert "△悟空走出山门。" in fake_agent.prompts[1]
    assert "悟空：师父。" not in fake_agent.prompts[1]


@pytest.mark.asyncio
async def test_extract_scenes_from_script_prefers_ai_normalized_blocks(monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1、凤鸣皇城·苏鸾寝殿 深夜 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="深夜",
                interior_exterior="内",
                characters=["苏糖"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["1-1、凤鸣皇城·苏鸾寝殿 深夜 内"],
                content_lines=["△苏糖猛地从床榻上坐起。"],
            ),
            NormalizedSceneBlock(
                episode_number=3,
                scene_no="1",
                raw_header="3-1、凤鸣皇城·苏鸾寝殿 亥时 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="亥时",
                interior_exterior="内",
                characters=["苏糖", "沈晚", "锦绣"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["3-1、凤鸣皇城·苏鸾寝殿 亥时 内"],
                content_lines=["△寝殿内，床帐放下。"],
            ),
        ]

    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="正面：寝殿床榻与床帐。\n左侧：屏风。\n右侧：窗台。\n背面：殿门。",
            description="公主寝殿",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1、凤鸣皇城·苏鸾寝殿 深夜 内\n△苏糖醒来。\n"
        "3-1、凤鸣皇城·苏鸾寝殿 亥时 内\n△刺杀开始。"
    )

    assert len(scenes) == 1
    assert scenes[0].name == "凤鸣皇城·苏鸾寝殿"
    assert scenes[0].aliases == ["苏鸾寝殿"]
    assert scenes[0].scene_type == "interior"
    assert scenes[0].time_of_day == ""
    assert "observed_times: 夜晚×2" in scenes[0].notes


@pytest.mark.asyncio
async def test_extract_scenes_from_script_falls_back_when_ai_returns_partial_blocks(
    monkeypatch,
):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1、凤鸣皇城·苏鸾寝殿 深夜 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="深夜",
                interior_exterior="内",
                characters=["苏糖"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["1-1、凤鸣皇城·苏鸾寝殿 深夜 内"],
                content_lines=["△苏糖醒来。"],
            )
        ]

    class FakeLegacyNormalizerAgent:
        async def run(self, prompt: str):
            if "御花园" in prompt:
                scene = pipeline.SceneNormalization(
                    name="凤鸣皇城·御花园",
                    aliases=["御花园"],
                    scene_type="exterior",
                    time_of_day="清晨",
                    interior=False,
                    characters=["苏糖", "沈晚"],
                )
            else:
                scene = pipeline.SceneNormalization(
                    name="凤鸣皇城·苏鸾寝殿",
                    aliases=["苏鸾寝殿"],
                    scene_type="interior",
                    time_of_day="深夜",
                    interior=True,
                    characters=["苏糖"],
                )
            return _FakeRunResult(pipeline.SceneNormalizationList(scenes=[scene]))

    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="正面：主体。\n左侧：侧墙。\n右侧：侧墙。\n背面：入口。",
            description="",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "_create_scene_build_agent",
        lambda *_args, **_kwargs: FakeLegacyNormalizerAgent(),
    )
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1、凤鸣皇城·苏鸾寝殿 深夜 内\n"
        "人物：苏糖\n"
        "△苏糖醒来。\n\n"
        "1-2、凤鸣皇城·御花园 清晨 外\n"
        "人物：苏糖、沈晚\n"
        "△两人在花径边低声交谈。"
    )

    assert [scene.name for scene in scenes] == [
        "凤鸣皇城·苏鸾寝殿",
        "凤鸣皇城·御花园",
    ]


@pytest.mark.asyncio
async def test_extract_scenes_from_script_falls_back_when_ai_returns_empty(monkeypatch):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return []

    class FakeLegacyNormalizerAgent:
        async def run(self, prompt: str):
            scene = pipeline.SceneNormalization(
                name="凤鸣皇城·苏鸾寝殿",
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                time_of_day="亥时",
                interior=True,
                characters=["苏糖", "沈晚"],
            )
            return _FakeRunResult(pipeline.SceneNormalizationList(scenes=[scene]))

    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="正面：场景主体。\n左侧：侧向空间。\n右侧：侧向空间。\n背面：反向空间。",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "_create_scene_build_agent",
        lambda *_args, **_kwargs: FakeLegacyNormalizerAgent(),
    )
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "3-1、凤鸣皇城·苏鸾寝殿 亥时 内\n人物：苏糖、沈晚\n△烛火跳动。"
    )

    assert len(scenes) == 1
    assert scenes[0].name == "凤鸣皇城·苏鸾寝殿"


@pytest.mark.asyncio
async def test_extract_scenes_from_script_falls_back_when_ai_merges_distinct_locations(
    monkeypatch,
):
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    async def fake_normalize(_text: str):
        return [
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="1",
                raw_header="1-1、凤鸣皇城·苏鸾寝殿 深夜 内",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="深夜",
                interior_exterior="内",
                characters=["苏糖"],
                aliases=["苏鸾寝殿"],
                scene_type="interior",
                evidence_lines=["1-1、凤鸣皇城·苏鸾寝殿 深夜 内"],
                content_lines=["△苏糖醒来。"],
            ),
            NormalizedSceneBlock(
                episode_number=1,
                scene_no="2",
                raw_header="1-2、凤鸣皇城·御花园 清晨 外",
                location="凤鸣皇城·苏鸾寝殿",
                time_of_day="清晨",
                interior_exterior="外",
                characters=["苏糖", "沈晚"],
                aliases=["苏鸾寝殿"],
                scene_type="exterior",
                evidence_lines=["1-2、凤鸣皇城·御花园 清晨 外"],
                content_lines=["△两人在花径边低声交谈。"],
            ),
        ]

    class FakeLegacyNormalizerAgent:
        async def run(self, prompt: str):
            if "御花园" in prompt:
                scene = pipeline.SceneNormalization(
                    name="凤鸣皇城·御花园",
                    aliases=["御花园"],
                    scene_type="exterior",
                    time_of_day="清晨",
                    interior=False,
                    characters=["苏糖", "沈晚"],
                )
            else:
                scene = pipeline.SceneNormalization(
                    name="凤鸣皇城·苏鸾寝殿",
                    aliases=["苏鸾寝殿"],
                    scene_type="interior",
                    time_of_day="深夜",
                    interior=True,
                    characters=["苏糖"],
                )
            return _FakeRunResult(pipeline.SceneNormalizationList(scenes=[scene]))

    async def fake_enrich_scene_environment_from_context(**kwargs):
        return NovelScene(
            name=kwargs["scene_name"],
            aliases=kwargs.get("aliases") or [],
            scene_type=kwargs["scene_type"],
            environment_prompt="正面：主体。\n左侧：侧墙。\n右侧：侧墙。\n背面：入口。",
            description="",
        )

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "_create_scene_build_agent",
        lambda *_args, **_kwargs: FakeLegacyNormalizerAgent(),
    )
    monkeypatch.setattr(
        pipeline,
        "enrich_scene_environment_from_context",
        fake_enrich_scene_environment_from_context,
    )

    scenes = await pipeline.extract_scenes_from_script(
        "1-1、凤鸣皇城·苏鸾寝殿 深夜 内\n"
        "人物：苏糖\n"
        "△苏糖醒来。\n\n"
        "1-2、凤鸣皇城·御花园 清晨 外\n"
        "人物：苏糖、沈晚\n"
        "△两人在花径边低声交谈。"
    )

    assert [scene.name for scene in scenes] == [
        "凤鸣皇城·苏鸾寝殿",
        "凤鸣皇城·御花园",
    ]
