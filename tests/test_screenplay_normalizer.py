import pytest

from novelvideo.cognee.screenplay_normalizer import (
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

    expected = ["无", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"]

    block_schema = NormalizedSceneBlock.model_json_schema()["properties"]["time_of_day"]

    assert block_schema["enum"] == expected


def test_time_of_day_agent_no_value_round_trips_to_internal_empty_string():

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
    assert block.time_of_day == ""
    assert block.interior_exterior == ""


def test_time_of_day_agent_outputs_normalize_before_literal_validation():

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
    assert block.time_of_day == "夜晚"


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


@pytest.mark.parametrize(
    ("raw_name", "expected_name", "expected_time"),
    [
        ("Seoul Subway Station 11:47 PM", "Seoul Subway Station", "夜晚"),
        ("Living Room - NIGHT", "Living Room", "夜晚"),
        ("Park, daytime", "Park", "白天"),
        ("Studio 54", "Studio 54", ""),
    ],
)
def test_clean_scene_name_and_time_removes_english_time_suffixes(
    raw_name, expected_name, expected_time
):
    name, tod = clean_scene_name_and_time(raw_name, "")

    assert name == expected_name
    assert tod == expected_time


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


def test_scene_heading_suffix_strip_removes_time_markers():
    """The name cleanup a per-block model call used to be needed for."""
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("演武场外墙·夜") == "演武场外墙"
    assert strip_scene_heading_suffix("演武场外墙・夜") == "演武场外墙"
    assert strip_scene_heading_suffix("凤鸣皇城·废弃粮仓夜") == "凤鸣皇城·废弃粮仓"


def test_scene_heading_suffix_strip_never_generalizes_a_location():
    """It removes heading markers, never part of the place itself."""
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("兰州拉面馆") == "兰州拉面馆"
    assert strip_scene_heading_suffix("春熙路的3D大屏下") == "春熙路的3D大屏下"


def test_an_attached_interior_marker_is_left_for_adjudication():
    """"商务车内" is a place; "郑玉琴办公室内" is a marker. One rule cannot tell.

    Deciding between them needs every candidate in view at once — whether a
    sibling spelling exists, and which one the script uses more — which is what
    adjudication has and a name-cleanup rule does not.
    """
    from novelvideo.cognee.pipeline import strip_scene_heading_suffix

    assert strip_scene_heading_suffix("商务车内") == "商务车内"
    assert strip_scene_heading_suffix("郑家别墅外") == "郑家别墅外"
    assert strip_scene_heading_suffix("郑玉琴办公室内") == "郑玉琴办公室内"


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
async def test_standard_headings_are_normalized_without_a_model_call():
    """A standard heading already states location, time and interior/exterior.

    Asking a model to restate them is a round trip per scene, and a heading is
    about fourteen characters long.
    """

    class _NeverCalled:
        async def run(self, prompt: str):
            raise AssertionError("a standard heading must not reach the model")

    scenes = await normalize_screenplay_scenes(
        "1-1 寝殿 夜 内\n人物：悟空\n悟空：师父。\n"
        "1-2 山门 日 外\n人物：悟空、童子\n△悟空走出山门。",
        agent=_NeverCalled(),
    )

    assert [scene.location for scene in scenes] == ["寝殿", "山门"]
    assert [scene.interior_exterior for scene in scenes] == ["内", "外"]
    assert [scene.content_lines for scene in scenes] == [
        ["悟空：师父。"],
        ["△悟空走出山门。"],
    ]


async def test_headings_the_parser_cannot_resolve_go_to_the_model_in_one_batch():
    from novelvideo.cognee.screenplay_normalizer import (
        BatchSceneHeaderItem,
        NormalizedSceneHeaderBatch,
    )

    class _BatchAgent:
        def __init__(self):
            self.prompts: list[str] = []

        async def run(self, prompt: str):
            self.prompts.append(prompt)
            return _FakeRunResult(
                NormalizedSceneHeaderBatch(
                    scenes=[
                        BatchSceneHeaderItem(
                            index=0, episode_number=3, scene_no="1",
                            location="凤鸣皇城·苏鸾寝殿", time_of_day="亥时",
                            interior_exterior="内", aliases=["苏鸾寝殿"],
                        ),
                        BatchSceneHeaderItem(
                            index=1, episode_number=3, scene_no="2",
                            location="御花园", time_of_day="日",
                            interior_exterior="外",
                        ),
                    ]
                )
            )

    agent = _BatchAgent()
    # Neither heading states interior/exterior, so the parser cannot finish
    # either one and both must travel to the model.
    scenes = await normalize_screenplay_scenes(
        "3-1、凤鸣皇城·苏鸾寝殿\n人物：苏糖、沈晚、锦绣\n△寝殿内，床帐放下。\n"
        "3-2、御花园\n人物：苏糖\n△苏糖走过回廊。",
        agent=agent,
    )

    # Both unresolved headings travelled in a single request.
    assert len(agent.prompts) == 1
    assert "凤鸣皇城·苏鸾寝殿" in agent.prompts[0]
    assert "御花园" in agent.prompts[0]

    assert len(scenes) == 2
    by_location = {scene.location: scene for scene in scenes}
    assert by_location["凤鸣皇城·苏鸾寝殿"].time_of_day == "夜晚"
    assert by_location["凤鸣皇城·苏鸾寝殿"].characters == ["苏糖", "沈晚", "锦绣"]
    assert by_location["凤鸣皇城·苏鸾寝殿"].content_lines == ["△寝殿内，床帐放下。"]


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
