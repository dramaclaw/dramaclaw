from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.brainclaw_contract import (
    BrainClawProfile,
    BrainClawProfileVariant,
)
from novelvideo.freezone import recipe_runtime
from novelvideo.freezone.agent_catalog_schema import validate_agent_recipe_config


def test_builtin_text_recipes_produce_final_deliverables():
    recipe_root = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
    )
    text_recipe_ids: list[str] = []
    for recipe_path in sorted(recipe_root.glob("*.json")):
        payload = json.loads(recipe_path.read_text(encoding="utf-8"))
        if payload.get("output_kind") != "text":
            continue
        validated = validate_agent_recipe_config(payload)
        text_recipe_ids.append(str(validated["id"]))

    assert len(text_recipe_ids) == 24
    assert "general-text" in text_recipe_ids
    assert "ecommerce-text-plan" in text_recipe_ids


def test_text_recipe_rejects_second_stage_model_instruction():
    with pytest.raises(ValueError, match="must produce the final deliverable"):
        validate_agent_recipe_config(
            {
                "id": "invalid-text-recipe",
                "name": "Invalid text Recipe",
                "output_kind": "text",
                "action_keys": ["invalid-text-recipe"],
                "system_prompt": "不要自己编写大纲，只输出能指导 LLM 的指令。",
                "planning_prompt": "生成大纲",
                "result_summary": "大纲",
            }
        )


def test_retro_skill_keeps_entry_guard_out_of_recipe_runtime_constraints():
    skill_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/skills"
        / "retro-hong-kong-kungfu-comedy-video.json"
    )
    skill = json.loads(skill_path.read_text(encoding="utf-8"))

    constraints = recipe_runtime._skill_constraints(skill)
    compiled_constraints = "\n".join(constraints["hard_constraints"])

    assert "请先上传至少一张角色参考图或一句文字灵感" not in compiled_constraints
    assert "暂停等待导演确认" not in compiled_constraints
    assert "阶段标题使用【模块名】格式" not in constraints["prompt_guide"]
    assert "一次性在草稿中列出完整工作流" in skill["planning"]["planning_notes"]


def test_outdoor_stage_duel_character_elements_use_one_turnaround_reference():
    recipe_path = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/freezone/agent_catalog/builtins/recipes"
        / "outdoor-stage-duel-key-elements.json"
    )
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))

    assert "正面、侧面、背面" in recipe["system_prompt"]
    assert "全身三视图" in "\n".join(recipe["must_have_items"])


def test_recipe_compiler_uses_the_dedicated_brainclaw_profile(monkeypatch):
    captured: dict[str, object] = {}

    def fake_model(model_env, default_model=None, **kwargs):
        captured.update(
            model_env=model_env,
            default_model=default_model,
            **kwargs,
        )
        return "model"

    class FakeAgent:
        def __init__(self, model, **kwargs):
            captured.update(model=model, agent_kwargs=kwargs)

        async def run(self, _task, **kwargs):
            captured.update(run_kwargs=kwargs)
            return SimpleNamespace(output="compiled prompt")

    from novelvideo import config

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_model)
    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)

    result = asyncio.run(recipe_runtime._run_recipe_compiler("compile this"))

    assert result == "compiled prompt"
    assert captured["brainclaw_profile"] is BrainClawProfile.FREEZONE_RECIPE_COMPILATION
    assert captured["run_kwargs"] == {
        "model_settings": {"openai_reasoning_effort": "none"}
    }


def test_build_recipe_compiler_task_checks_output_kind():
    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="incompatible"):
        recipe_runtime.build_recipe_compiler_task(
            recipe={
                "id": "image-only",
                "output_kind": "image",
                "system_prompt": "refine",
            },
            node_kind="video",
            node_prompt="rotate product",
        )


def test_build_recipe_compiler_task_contains_runtime_context():
    task = recipe_runtime.build_recipe_compiler_task(
        recipe={"id": "scene", "output_kind": "image", "system_prompt": "商业摄影"},
        node_kind="image",
        node_prompt="北欧厨房",
        user_goal="生成三张咖啡机商品图",
        upstream_text="银色金属机身",
        reference_media=[{"kind": "image", "label": "产品参考图"}],
        confirmed_inputs={"aspect_ratio": "9:16", "language": "zh"},
        skill_constraints={
            "hard_constraints": ["不得虚构产品功能", "不要字幕"],
            "prompt_guide": "高端商业摄影",
        },
        skill_id="ecommerce",
        skill_version="2.1.0",
    )

    assert "商业摄影" in task
    assert "北欧厨房" in task
    assert "银色金属机身" in task
    assert "产品参考图" in task
    assert '"aspect_ratio": "9:16"' in task
    assert "不得虚构产品功能" in task
    assert "高端商业摄影" in task
    assert '"version": "2.1.0"' in task


def test_get_skill_for_runtime_enforces_version_and_recipe_whitelist(monkeypatch):
    monkeypatch.setattr(
        recipe_runtime,
        "list_user_agent_config_items",
        lambda _username, kind: (
            [
                {
                    "id": "ecommerce",
                    "version": "2.1.0",
                    "allowed_recipe_ids": ["product-image"],
                }
            ]
            if kind == "skills"
            else []
        ),
    )

    skill = recipe_runtime.get_skill_for_runtime(
        username="local",
        skill_id="ecommerce",
        skill_version="2.1.0",
        recipe_id="product-image",
    )
    assert skill is not None

    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="version mismatch"):
        recipe_runtime.get_skill_for_runtime(
            username="local",
            skill_id="ecommerce",
            skill_version="1.0.0",
            recipe_id="product-image",
        )
    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="not allowed"):
        recipe_runtime.get_skill_for_runtime(
            username="local",
            skill_id="ecommerce",
            recipe_id="other-image",
        )
def test_combined_recipe_preserves_pipeline_order():
    combined = recipe_runtime._combined_recipe(
        [
            {
                "id": "shotlist",
                "name": "分镜方法",
                "version": 1,
                "output_kind": "image",
                "system_prompt": "先确定镜头信息。",
            },
            {
                "id": "lighting",
                "name": "布光方法",
                "version": 2,
                "output_kind": "image",
                "system_prompt": "再设计光线。",
            },
        ]
    )

    assert combined["id"] == "shotlist+lighting"
    assert combined["system_prompt"].index("先确定镜头信息") < combined[
        "system_prompt"
    ].index("再设计光线")


def test_recipe_compiler_priority_places_skill_before_recipe():
    assert (
        "confirmed inputs, Skill hard constraints"
        in recipe_runtime._RECIPE_COMPILER_SYSTEM_PROMPT
    )
    assert (
        "Recipe method, then defaults" in recipe_runtime._RECIPE_COMPILER_SYSTEM_PROMPT
    )


def test_build_recipe_compiler_task_limits_large_upstream_context():
    upstream = "A" * 20_000 + "B" * 20_000
    task = recipe_runtime.build_recipe_compiler_task(
        recipe={"id": "scene", "output_kind": "image", "system_prompt": "商业摄影"},
        node_kind="image",
        node_prompt="厨房",
        upstream_text=upstream,
    )

    assert "[context truncated]" in task
    assert "A" * 100 in task
    assert "B" * 100 in task
    assert len(task) < 18_000


@pytest.mark.asyncio
async def test_compile_recipe_prompt_loads_server_recipe_and_returns_only_prompt(
    monkeypatch, tmp_path
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    calls = 0
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "trusted internal method",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, task, **_kwargs):
            nonlocal calls
            calls += 1
            assert "trusted internal method" in task
            return SimpleNamespace(output="最终可执行提示词")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )

    compiled = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
    )
    cached = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
    )

    assert compiled.prompt == "最终可执行提示词"
    assert compiled.mode == "model"
    assert cached.prompt == compiled.prompt
    assert cached.mode == "memory_cache"
    assert calls == 1

    recipe_runtime._prompt_cache.clear()
    persisted = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
    )
    assert persisted.prompt == compiled.prompt
    assert persisted.mode == "persistent_cache"
    assert calls == 1

    compatible_prompt = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
    )
    assert compatible_prompt == compiled.prompt


@pytest.mark.asyncio
async def test_compile_recipe_prompt_deduplicates_concurrent_model_calls(
    monkeypatch, tmp_path
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "trusted internal method",
        },
    )
    calls = 0

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, _task, **_kwargs):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return SimpleNamespace(output="共享提示词")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )
    kwargs = {
        "username": "local",
        "recipe_id": "scene",
        "recipe_version": "1",
        "node_kind": "image",
        "node_prompt": "厨房场景",
    }

    results = await asyncio.gather(
        recipe_runtime.compile_recipe_prompt(**kwargs),
        recipe_runtime.compile_recipe_prompt(**kwargs),
    )

    assert results == ["共享提示词", "共享提示词"]
    assert calls == 1


@pytest.mark.asyncio
async def test_compile_recipe_prompt_uses_fallback_on_timeout_and_caches_late_result(
    monkeypatch,
    tmp_path,
):
    recipe_runtime._prompt_cache.clear()
    recipe_runtime._prompt_inflight.clear()
    monkeypatch.setattr(recipe_runtime, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "scene",
            "version": 1,
            "output_kind": "image",
            "system_prompt": "可信的商品摄影方法",
        },
    )

    async def slow_compiler(_task: str) -> str:
        await asyncio.sleep(0.03)
        return "后台完成的精炼提示词"

    monkeypatch.setattr(recipe_runtime, "_run_recipe_compiler", slow_compiler)
    monkeypatch.setattr(
        recipe_runtime, "_recipe_compiler_timeout_seconds", lambda: 0.01
    )

    fallback_result = await recipe_runtime.compile_recipe_prompt_result(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
        user_goal="生成咖啡机商品图",
    )

    assert fallback_result.mode == "timeout_fallback"
    assert fallback_result.recipe_ids == ("scene",)
    assert "生成咖啡机商品图" in fallback_result.prompt
    assert "厨房场景" in fallback_result.prompt
    assert "可信的商品摄影方法" in fallback_result.prompt

    await asyncio.sleep(0.04)
    assert recipe_runtime._prompt_inflight == {}
    assert "后台完成的精炼提示词" in recipe_runtime._prompt_cache.values()

    cached = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="scene",
        recipe_version="1",
        node_kind="image",
        node_prompt="厨房场景",
        user_goal="生成咖啡机商品图",
    )
    assert cached == "后台完成的精炼提示词"


@pytest.mark.asyncio
async def test_compile_recipe_prompt_skips_model_for_deterministic_strategy(
    monkeypatch,
):
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "video",
            "output_kind": "video",
            "system_prompt": "refine video prompt",
        },
    )

    class UnexpectedAgent:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("deterministic strategy must not create an Agent")

    monkeypatch.setattr(recipe_runtime, "Agent", UnexpectedAgent)
    result = await recipe_runtime.compile_recipe_prompt(
        username="local",
        recipe_id="video",
        node_kind="video",
        node_prompt="镜头缓慢推进",
        upstream_text="商品分镜",
        prompt_strategy="previous_output",
    )

    assert result == "商品分镜\n\n镜头缓慢推进"


@pytest.mark.asyncio
async def test_compile_recipe_prompt_batch_preserves_order_and_bounds_concurrency(
    monkeypatch,
):
    active = 0
    max_active = 0

    async def fake_compile(**kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        if kwargs["recipe_id"] == "broken":
            raise recipe_runtime.RecipeRuntimeError("invalid recipe")
        return recipe_runtime.RecipeCompileResult(
            prompt=f"compiled:{kwargs['recipe_id']}",
            mode="model",
            recipe_ids=(kwargs["recipe_id"],),
        )

    monkeypatch.setattr(recipe_runtime, "compile_recipe_prompt_result", fake_compile)
    outcomes = await recipe_runtime.compile_recipe_prompt_batch(
        [
            {"recipe_id": "first"},
            {"recipe_id": "broken"},
            {"recipe_id": "third"},
            {"recipe_id": "fourth"},
        ],
        concurrency=2,
    )

    assert max_active == 2
    assert isinstance(outcomes[0], recipe_runtime.RecipeCompileResult)
    assert outcomes[0].prompt == "compiled:first"
    assert isinstance(outcomes[1], recipe_runtime.RecipeRuntimeError)
    assert isinstance(outcomes[2], recipe_runtime.RecipeCompileResult)
    assert outcomes[2].prompt == "compiled:third"
    assert isinstance(outcomes[3], recipe_runtime.RecipeCompileResult)


def test_recipe_pipeline_rejects_explicit_conflicts(monkeypatch):
    recipes = {
        "base": {
            "id": "base",
            "output_kind": "image",
            "conflicts_with": [],
        },
        "overlay": {
            "id": "overlay",
            "output_kind": "image",
            "conflicts_with": ["base"],
        },
    }
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda recipe_id, **_kwargs: recipes[recipe_id],
    )

    with pytest.raises(recipe_runtime.RecipeRuntimeError, match="conflicts with"):
        recipe_runtime.get_recipe_pipeline_for_runtime(
            username="local",
            primary_recipe=recipes["base"],
            recipe_pipeline=["overlay"],
            node_kind="image",
        )


@pytest.mark.asyncio
async def test_generate_recipe_text_executes_compiled_instruction(monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "ecommerce-text-plan",
            "version": "1.0.0",
            "output_kind": "text",
            "system_prompt": "生成三屏详情页方案",
            "_catalog_source": "builtin",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, task):
            assert "生成三屏详情页方案" in task
            assert "Produce the final text deliverable now" in task
            return SimpleNamespace(output="# 详情页方案")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *args, **kwargs: captured.update(model_env=args[0], **kwargs) or object(),
    )

    result = await recipe_runtime.generate_recipe_text(
        username="local",
        recipe_id="ecommerce-text-plan",
        node_kind="text",
        node_prompt="咖啡机",
    )

    assert result == "# 详情页方案"
    assert captured["model_env"] == "FREEZONE_TEXT_WRITER_MODEL"
    assert captured["timeout_seconds_override"] == 300.0
    assert captured["capability"] == "freezone.text.generate"
    assert captured["brainclaw_profile"] is (
        BrainClawProfile.FREEZONE_RECIPE_TEXT_GENERATION
    )
    assert captured["brainclaw_profile_variant"] == BrainClawProfileVariant(
        "recipe/ecommerce-text-plan@1.0.0"
    )


@pytest.mark.asyncio
async def test_generate_recipe_text_omits_variant_for_user_recipe(monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        recipe_runtime,
        "get_recipe_for_runtime",
        lambda **_kwargs: {
            "id": "private-recipe",
            "version": "1.0.0",
            "output_kind": "text",
            "system_prompt": "生成正文",
            "_catalog_source": "user",
        },
    )

    class FakeAgent:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, _task):
            return SimpleNamespace(output="正文")

    monkeypatch.setattr(recipe_runtime, "Agent", FakeAgent)
    monkeypatch.setattr(
        "novelvideo.config.get_newapi_text_pydantic_model",
        lambda *_args, **kwargs: captured.update(kwargs) or object(),
    )

    assert (
        await recipe_runtime.generate_recipe_text(
            username="local",
            recipe_id="private-recipe",
            node_kind="text",
            node_prompt="写作",
        )
        == "正文"
    )
    assert captured["brainclaw_profile_variant"] is None
