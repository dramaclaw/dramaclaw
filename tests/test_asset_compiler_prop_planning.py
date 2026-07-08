from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from novelvideo.utils.screenplay_quality import build_import_format_check
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks


STANDARD_DRAMA_PROP_SCRIPT = """第1集 开始
1-1、地下室 深夜 内
人物：陆辰、沈月白
△昏暗地下室里尘埃翻涌。
陆辰：这里有东西。
沈月白：别碰。
陆辰：我只是看看。
沈月白：小心。
陆辰：这本羊皮笔记本不对劲。
沈月白：把强光手电给我。
陆辰：你看封面。
沈月白：命运之书。
"""


class _FakeSQLiteStore:
    async def load_working_content(self, episode_number: int) -> str:
        return ""

    async def list_props(self) -> list:
        return []

    async def get_prop(self, name: str):
        return None


class _FakeCogneeStore:
    def __init__(self, raw_content: str = ""):
        self.raw_content = raw_content
        self.sqlite_store = _FakeSQLiteStore()
        self.updated: list[tuple[int, dict]] = []

    async def load_episode_content(self, episode_number: int) -> str:
        return self.raw_content

    async def update_episode(self, episode_number: int, **updates) -> None:
        self.updated.append((episode_number, updates))


def test_standard_drama_prop_sample_matches_current_import_format_rules():
    result = build_import_format_check(STANDARD_DRAMA_PROP_SCRIPT, has_chapters=True)
    blocks = parse_scene_blocks(STANDARD_DRAMA_PROP_SCRIPT)

    assert result["level"] == "ok"
    assert result["issues"] == []
    assert len(blocks) == 1
    assert blocks[0].header_line == "1-1、地下室 深夜 内"
    assert blocks[0].location == "地下室"
    assert blocks[0].time_of_day == "深夜"
    assert blocks[0].interior_exterior == "内"


def test_prop_requirements_reject_model_string_list_output():
    from novelvideo.agents.asset_compiler import BlockPropRequirements

    with pytest.raises(ValidationError) as exc_info:
        BlockPropRequirements.model_validate(
            {"requirements": ["手电筒", "羊皮笔记本"]},
            context={
                "block_text": STANDARD_DRAMA_PROP_SCRIPT,
                "allowed_existing_names": set(),
            },
        )

    error_locations = {tuple(error["loc"]) for error in exc_info.value.errors()}
    assert ("requirements", 0) in error_locations
    assert ("requirements", 1) in error_locations


def test_block_prop_prompt_explicitly_forbids_string_list_and_synonym_names():
    from novelvideo.agents.asset_compiler import BLOCK_PROP_PROMPT

    assert "requirements 必须是对象数组" in BLOCK_PROP_PROMPT
    assert "不能是字符串" in BLOCK_PROP_PROMPT
    assert "原文是“强光手电”，不要写“手电筒”" in BLOCK_PROP_PROMPT


@pytest.mark.asyncio
async def test_standard_drama_prop_planner_reports_string_list_validation_error(
    monkeypatch,
):
    import novelvideo.agents.asset_compiler as asset_compiler

    captured: dict[str, object] = {}

    def fake_newapi_model(model_env: str, default_model: str) -> str:
        return "prop-model"

    def fake_settings(thinking_env: str, default_thinking_level: str) -> dict[str, str]:
        return {"openai_reasoning_effort": default_thinking_level}

    class FakeAgent:
        def __init__(self, model, **kwargs):
            captured["agent_kwargs"] = kwargs

        async def run(self, task: str):
            captured["task"] = task
            kwargs = captured["agent_kwargs"]
            output_type = kwargs["output_type"]
            return SimpleNamespace(
                output=output_type.model_validate(
                    {"requirements": ["手电筒", "羊皮笔记本"]},
                    context=kwargs["validation_context"],
                )
            )

    monkeypatch.setattr(asset_compiler, "get_newapi_text_pydantic_model", fake_newapi_model)
    monkeypatch.setattr(
        asset_compiler,
        "get_newapi_text_pydantic_model_settings",
        fake_settings,
    )
    monkeypatch.setattr(asset_compiler, "Agent", FakeAgent)

    store = _FakeCogneeStore(raw_content=STANDARD_DRAMA_PROP_SCRIPT)
    compiler = asset_compiler.AssetCompiler(store)
    logs: list[str] = []

    with pytest.raises(ValueError, match="requirements 必须是对象数组"):
        await compiler.compile_episode_props(
            SimpleNamespace(number=1, beat_source_text=STANDARD_DRAMA_PROP_SCRIPT),
            on_log=logs.append,
        )

    assert logs[0] == "[AssetCompiler] 共识别 1 个场景块"
    assert any("requirements 必须是对象数组" in log for log in logs)
    assert store.updated == []
    assert "1-1、地下室 深夜 内" in captured["task"]
    assert "强光手电" in captured["task"]


def test_prop_name_must_be_exact_source_substring_or_existing_candidate():
    from novelvideo.agents.asset_compiler import BlockPropRequirements

    block_text = "沈月白：把强光手电给我。"

    with pytest.raises(ValidationError, match="未在当前场景块文本中出现"):
        BlockPropRequirements.model_validate(
            {
                "requirements": [
                    {
                        "prop_name": "手电筒",
                        "visual_prompt": "黑色金属手电筒，冷白光束",
                    }
                ]
            },
            context={"block_text": block_text, "allowed_existing_names": set()},
        )

    accepted = BlockPropRequirements.model_validate(
        {
            "requirements": [
                {
                    "prop_name": "强光手电",
                    "visual_prompt": "黑色金属强光手电，冷白光束",
                }
            ]
        },
        context={"block_text": block_text, "allowed_existing_names": set()},
    )

    assert [req.prop_name for req in accepted.requirements] == ["强光手电"]


@pytest.mark.asyncio
async def test_short_block_reuses_prior_episode_prop_without_ai_reanalysis(monkeypatch):
    import novelvideo.agents.asset_compiler as asset_compiler

    blocks = [
        SimpleNamespace(
            header_line="场次（4）地点：旧书店一楼，晨，内；出场人物：陆辰",
            lines=[
                "第二天清晨。陆辰迫不及待地翻开笔记本，新的预言果然出现了。",
                "特写：【6月15日 17:10 青鹿河老码头 李家幼子 溺水】。",
                "陆辰呼吸急促，他死死攥着笔记本，眼神在挣扎后变得坚定。",
            ],
        ),
        SimpleNamespace(
            header_line="场次（7）地点：梦境火场，夜，外；出场人物：陆辰、祖父",
            lines=[
                "祖父的身影伫立在烈火中心，随着火势的蔓延，他的轮廓逐渐扭曲、消散。",
                "陆辰：（梦呓）爷爷……不……",
                "陆辰在梦中惊醒，浑身大汗淋漓，面前的羊皮笔记本在黑暗中散发着令人胆寒的沉寂。",
            ],
        ),
    ]
    calls: list[str] = []

    async def fake_analyze(self, block, preselected, prior_selected_prop_ids):
        calls.append(block.header_line)
        if "梦境火场" in block.header_line:
            raise ValueError("should not call AI for short prior-prop-only block")
        return [
            asset_compiler.PropRequirement(
                prop_name="笔记本",
                prop_type="object",
                owner="陆辰",
                visual_prompt="一本有些陈旧的硬皮笔记本，纸页泛黄",
                description="陆辰查看预言的笔记本",
            )
        ]

    monkeypatch.setattr(asset_compiler.AssetCompiler, "_analyze_block_props", fake_analyze)

    store = _FakeCogneeStore()
    compiler = asset_compiler.AssetCompiler(store)
    logs: list[str] = []

    prop_menu = await compiler._compile_props(blocks, SimpleNamespace(number=1), logs.append)

    assert [item.prop_id for item in prop_menu] == ["笔记本"]
    assert calls == ["场次（4）地点：旧书店一楼，晨，内；出场人物：陆辰"]
    assert logs == [
        "  道具[1]: 笔记本 [本集局部]",
        "  道具[2]: 笔记本 [本集复用]",
    ]
