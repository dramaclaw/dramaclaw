import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from novelvideo.prompt_preview.registry import PreviewScope, all_steps, get_step


class _FakeStore:
    def __init__(self, characters=None, beats=None):
        self._characters = characters or []
        self._beats = beats or []

    async def list_characters(self):
        return self._characters

    async def get_beats_as_dicts(self, episode):
        return self._beats


def _scope(tmp_path: Path, store, episode=None) -> PreviewScope:
    return PreviewScope(
        project_dir=tmp_path,
        state_dir=str(tmp_path / "state"),
        store=store,
        config={"ethnicity": "Vietnamese"},
        episode=episode,
    )


def _run(coro):
    return asyncio.run(coro)


def test_steps_follow_pipeline_order_and_flag_unsupported():
    steps = {s.step: s for s in all_steps()}
    order = [s.step for s in all_steps()]
    assert order.index("portraits") < order.index("script") < order.index("video")
    assert steps["portraits"].supported and steps["video"].supported
    assert not steps["episodes"].supported


def test_portrait_preview_contains_full_prompt_frame_and_last_sent(tmp_path):
    char = SimpleNamespace(name="Tesla", face_prompt="sharp cheekbones", identities=[])
    audit = tmp_path / "prompts" / "characters" / "Tesla_portrait.prompt.txt"
    audit.parent.mkdir(parents=True)
    audit.write_text("OLD PROMPT", encoding="utf-8")

    spec = get_step("portraits")
    scope = _scope(tmp_path, _FakeStore([char]))
    targets = _run(spec.targets_fn(scope))
    assert [t.id for t in targets] == ["Tesla"]

    preview = _run(spec.build_fn(scope, "Tesla"))
    text = preview.parts[0].text
    for marker in ("STRICT REQUIREMENTS", "MUST AVOID", "VISUAL STYLE", "sharp cheekbones"):
        assert marker in text
    assert "Vietnamese" in text
    assert preview.last_sent.text == "OLD PROMPT"


def test_portrait_preview_without_face_prompt_returns_note(tmp_path):
    char = SimpleNamespace(name="Tesla", face_prompt="", identities=[])
    preview = _run(get_step("portraits").build_fn(_scope(tmp_path, _FakeStore([char])), "Tesla"))
    assert preview.parts == [] and "face_prompt" in preview.note


def test_video_preview_shows_stored_prompts(tmp_path):
    beats = [
        {
            "beat_number": 3,
            "video_prompt": "slow dolly in",
            "seedance2_config_json": json.dumps({"final_prompt": "FINAL"}),
        }
    ]
    scope = _scope(tmp_path, _FakeStore(beats=beats), episode=1)
    spec = get_step("video")
    assert [t.id for t in _run(spec.targets_fn(scope))] == ["3"]
    labels = [p.label for p in _run(spec.build_fn(scope, "3")).parts]
    assert labels == ["seedance2.final_prompt", "video_prompt"]


def test_grid_preview_rejects_path_traversal(tmp_path):
    grids = tmp_path / "grids" / "ep001" / "sketch" / "prompts"
    grids.mkdir(parents=True)
    (grids / "g1.prompt.txt").write_text("GRID", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    spec = get_step("sketches")
    scope = _scope(tmp_path, _FakeStore(), episode=1)

    ids = [t.id for t in _run(spec.targets_fn(scope))]
    assert ids == ["sketch/prompts/g1.prompt.txt"]
    assert _run(spec.build_fn(scope, ids[0])).last_sent.text == "GRID"
    bad = _run(spec.build_fn(scope, "../../../secret.txt"))
    assert bad.last_sent is None and "not found" in bad.note


# --- phase 2: LLM steps ---------------------------------------------------------------------------


def test_llm_steps_registered_with_notes():
    steps = {s.step: s for s in all_steps()}
    for name in ("characters", "identity_plan", "script", "global_optimize"):
        assert steps[name].supported, name
    assert not steps["episodes"].supported and "LLM" in steps["episodes"].note
    assert not steps["coloring"].supported and steps["coloring"].note


def test_character_chunk_prompt_builder_matches_what_the_agent_sends():
    from novelvideo.story_analysis import chunk_source_text
    from novelvideo.structured_extraction import build_character_chunk_prompt
    from novelvideo.utils.source_language import asset_language_instruction

    chunk = chunk_source_text("第一章\n林默回到了家。", "narrated")[0]
    text = build_character_chunk_prompt(chunk, "zh")
    assert text == (
        f"{asset_language_instruction('zh')}\n\n【片段 {chunk.section_label}】\n{chunk.text}"
    )


def test_default_identity_task_builder_keeps_prompt_structure():
    from novelvideo.agents.identity_planner import (
        build_default_identity_system_prompt,
        build_default_identity_task,
    )

    task = build_default_identity_task(
        episode_number=2,
        episode_title="雨夜",
        cast_names=["林默", "苏晴"],
        identity_info="### 林默",
        graph_context="ctx",
        content_text="原文内容",
    )
    assert task.startswith("分析第 2 集《雨夜》")
    for marker in ("## 出场角色\n林默, 苏晴", "## 图谱上下文\nctx", "## 本集原文\n原文内容"):
        assert marker in task
    assert "## 图谱上下文" not in build_default_identity_task(
        episode_number=1, episode_title="t", cast_names=["a"], identity_info="",
        graph_context=None, content_text="x",
    )
    assert build_default_identity_system_prompt("原文内容").startswith("# 你是影视角色主线形态分析师")


def test_identity_preview_uses_rows_not_store_cache(tmp_path):
    ident = SimpleNamespace(
        identity_id="lin_default", appearance_details="黑色风衣", face_prompt="", age_group="youth"
    )
    char = SimpleNamespace(
        name="林默", aliases=["小默"], gender="male", age_group="youth",
        face_prompt="", body_type="", identities=[ident],
    )

    class Store(_FakeStore):
        async def list_episodes(self):
            return [SimpleNamespace(number=1, title="雨夜")]

        async def load_episode_content(self, ep):
            return "林默走进雨里。"

    scope = _scope(tmp_path, Store([char]), episode=1)
    preview = _run(get_step("identity_plan").build_fn(scope, "pass_a"))
    task = preview.parts[1].text
    assert "`lin_default`: 黑色风衣" in task and "林默走进雨里。" in task
    assert preview.parts[0].role == "system"


def test_script_and_optimizer_show_system_prompt_only(tmp_path):
    scope = _scope(tmp_path, _FakeStore(), episode=1)
    for step, marker in (("script", "逐行分镜标注师"), ("global_optimize", "Global Video Motion Director")):
        preview = _run(get_step(step).build_fn(scope, "system"))
        assert [p.role for p in preview.parts] == ["system"]
        assert marker in preview.parts[0].text and preview.note
