"""Formatting failures must be corrected without changing the user's direction."""

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from novelvideo.freezone.h3_prompt_optimizer import canonical_prompt, preview_prompt


@pytest.fixture
def local_formatter(monkeypatch):
    from novelvideo.freezone import h3_prompt_optimizer

    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Installed grammar")
    return h3_prompt_optimizer.local_format_prompt


def test_local_preserves_every_line_and_builds_shot_times(local_formatter):
    source = "人物：【{{Mixed 1}}是演员】\n人物位置：保持原位。\n\n【镜头1】起身\n时长：5秒\n运镜：\n固定镜头。\n声音：\n衣料声。\n\n【镜头2】转身\n时长：7秒\n" + SOURCE
    opt = options(["image"], "allReference")
    result = local_formatter(source, opt)
    assert "[Shot 1] At 00:00.000" in result
    assert "[Shot 2] At 00:05.000" in result
    assert all(line.strip() in result for line in source.splitlines() if line.strip())
    assert "overall_soundscape:\n衣料声。" in result
    assert "retention_analysis:\nN/A" in result
    assert local_formatter(result, opt) == result


@pytest.mark.parametrize("source", [
    "【镜头1】\n时长：5秒\n固定。\n【镜头2】\n转身。",
    "【镜头1】\n时长：5秒\n【镜头2】\n时长：8秒",
    "【镜头1】\n时长：0秒\n【镜头2】\n时长：12秒",
    "【镜头一】\n时长：5秒\n【镜头二】\n时长：7秒",
    "【镜头1】\n时长：5秒\n时长：7秒",
])
def test_local_never_guesses_ambiguous_timing(local_formatter, source):
    with pytest.raises(ValueError):
        local_formatter(source, options())


def test_local_plain_single_shot_and_mixed_order(local_formatter):
    source = "{{Mixed 2}} 保持原样。\n" + SOURCE
    result = local_formatter(source, options(["video", "image"]))
    assert source in result
    assert "[Shot 1] At 00:00.000" in result


@pytest.mark.parametrize("mode", ["firstFrame", "imageToVideo", "firstLastFrame"])
def test_local_keyframe_mode_has_alignment_instruction(local_formatter, mode):
    result = local_formatter(SOURCE, options(["image", "image"], mode))
    assert "{{Mixed 1}}" in result
    if mode == "firstLastFrame":
        assert "{{Mixed 2}}" in result
        assert "12.00-second" in result
    assert SOURCE in result


def test_local_keyframe_mode_requires_images(local_formatter):
    with pytest.raises(ValueError, match="requires 2 image"):
        local_formatter(SOURCE, options(["image"], "firstLastFrame"))


def test_local_rejects_missing_media(local_formatter):
    with pytest.raises(ValueError, match="unavailable"):
        local_formatter("{{Mixed 2}} " + SOURCE, options(["image"]))


def test_local_existing_shot_markers_are_not_duplicated(local_formatter):
    source = "[Shot 1] At 00:00.000\nduration: 5s\nHold.\n[Shot 2]\nduration: 7s\nTurn."
    result = local_formatter(source, options())
    assert result.count("[Shot 1]") == 1
    assert result.count("[Shot 2]") == 1
    assert "[Shot 2] At 00:05.000" in result
    with pytest.raises(ValueError, match="conflicts"):
        local_formatter(source.replace("00:00.000", "00:02.000"), options())


def options(kinds=(), mode="textToVideo"):
    return {"mode": mode, "duration_sec": 12, "reference_order": list(kinds)}


SOURCE = "镜头保持固定，人物缓慢向左转身，窗外的光照和背景陈设保持不变。"


def base_draft(description=SOURCE):
    return (f"integrated_multimodal_description: [Shot 1] {description}\n"
            "overall_soundscape: N/A\nnon_diegetic_music: N/A")


@pytest.mark.parametrize("label", ["<Picture 1>", "Picture 1", "<picture 1>", "人物<Picture 1>保持原样"])
def test_picture_label_boundaries(label):
    assert canonical_prompt(label, options(["image"])) == label


@pytest.mark.parametrize("filename", ["Picture 99.png", "Video 42.mp4", "Audio 8.wav", "somePicture 2", "Picture 12abc"])
def test_filenames_are_not_reference_labels(filename):
    assert canonical_prompt(filename, options()) == filename


def test_interleaved_media_bindings_remain_separate():
    opt = options(["image", "video", "image", "audio"])
    assert canonical_prompt("{{Mixed 3}} / {{Mixed 2}} / {{Mixed 4}}", opt) == "<Picture 2> / <Video 1> / <Audio 1>"


def test_bad_label_error_explains_the_allowlist():
    with pytest.raises(ValueError, match=r"<Audio 1>.*Allowed references: <Picture 1>"):
        canonical_prompt("<Audio 1>", options(["image"]))


def test_sentence_punctuation_does_not_hide_missing_reference():
    with pytest.raises(ValueError, match="<Audio 1>"):
        canonical_prompt("Refer to Audio 1. Keep the scene.", options(["image"]))


def test_deepseek_format_uses_bindings_and_preserves_normal_vision_validation():
    from novelvideo.freezone.text_node import (
        text_writer_request_references, validate_text_writer_references_model,
    )

    model = "deepseek-ai/DeepSeek-V4-Flash"
    refs = [{"node_id": "image", "text": "Actor", "image_url": "/static/actor.png"},
            {"node_id": "video", "text": "Motion", "video_url": "/static/clip.mp4"}]
    bound = text_writer_request_references(model, refs, options(["image", "video"]))
    validate_text_writer_references_model(model, bound)
    assert bound[0]["text"].startswith("<Picture 1>")
    assert bound[1]["text"].startswith("<Video 1>")
    assert all("image_url" not in item and "video_url" not in item for item in bound)
    assert refs[0]["image_url"] == "/static/actor.png"
    with pytest.raises(ValueError, match="video references require"):
        validate_text_writer_references_model(model, text_writer_request_references(model, refs, None))


def test_format_skill_excludes_creative_examples(tmp_path, monkeypatch):
    from novelvideo.freezone.h3_prompt_optimizer import skill_system_prompt

    (tmp_path / "references").mkdir()
    (tmp_path / "SKILL.md").write_text("Write all sections in English.", encoding="utf-8")
    (tmp_path / "references/base-en.txt").write_text(base_draft() + "\nInvent <Audio 99> for dramatic music.", encoding="utf-8")
    monkeypatch.setenv("H3_PROMPT_SKILL_DIR", str(tmp_path))
    rules = skill_system_prompt(options(["image"]))
    assert "integrated_multimodal_description:" in rules
    assert "<Picture 1>" in rules
    assert "<Audio 99>" not in rules
    assert "Write all sections in English." not in rules


def test_unknown_picture_must_not_be_rebound_to_a_real_picture():
    with pytest.raises(ValueError, match="<Picture 12>"):
        canonical_prompt("<Picture 12>", options(["image"]))


def test_bad_mixed_reference_remains_an_error():
    with pytest.raises(ValueError, match="Mixed reference"):
        canonical_prompt("{{Mixed 2}}", options(["image"]))


def test_format_keeps_camera_and_description():
    assert preview_prompt(base_draft(), options(), SOURCE) == base_draft()
    with pytest.raises(ValueError, match="changed an original description"):
        preview_prompt(base_draft("镜头快速推进，人物向右转身。"), options(), SOURCE)


def test_short_camera_instruction_is_protected():
    with pytest.raises(ValueError, match="changed an original description"):
        preview_prompt(base_draft("镜头摇移。"), options(), "运镜：\n固定镜头。")


def test_reference_definition_can_change_structure_without_changing_binding():
    source = "人物：【{{Mixed 1}}是胡来】【{{Mixed 2}}是林小满】【{{Mixed 3}}是委托人】"
    output = ("subject_definitions: <Subject 1> 胡来来自<Picture 1>，<Subject 2> 林小满来自<Picture 2>，<Subject 3> 委托人来自<Picture 3>\n"
              "summary: 原人物保持不变\nretention_analysis: fully_preserved\n"
              f"detailed_description: [Shot 1] {SOURCE}\noverall_soundscape: N/A\nnon_diegetic_music: N/A")
    result = preview_prompt(output, options(["image"] * 3, "allReference"), source)
    assert "来自{{Mixed 1}}" in result
    assert "<Picture" not in result


@pytest.mark.parametrize("change", ["missing_field", "late_cut"])
def test_other_invalid_formats_still_fail(change):
    draft = base_draft().replace("overall_soundscape:", "sound:") if change == "missing_field" else base_draft(SOURCE + " [Shot 2] At 00:12.000, stop.")
    with pytest.raises(ValueError):
        preview_prompt(draft, options(), SOURCE)


@pytest.mark.asyncio
async def test_invalid_generated_audio_reference_is_corrected_in_same_task(monkeypatch):
    from novelvideo.freezone import h3_prompt_optimizer, text_node

    calls = []

    async def respond(messages, info):
        calls.append(messages)
        if len(calls) == 1:
            assert "FORMAT CONVERSION ONLY" in str(messages)
            assert "BEGIN IMMUTABLE SOURCE" in str(messages)
        text = base_draft(SOURCE + " <Audio 1>") if len(calls) == 1 else base_draft()
        return ModelResponse(parts=[TextPart(text)])

    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only.")
    monkeypatch.setattr(text_node, "create_freezone_text_writer_agent", lambda *a, **kw: Agent(FunctionModel(respond), output_type=str, retries={"output": kw.get("output_retries", 1)}))
    _, output = await text_node.generate_freezone_text(prompt=SOURCE, model="deepseek-ai/DeepSeek-V4-Flash", h3_options=options())
    assert len(calls) == 2
    assert output == (
        f"integrated_multimodal_description:\n[Shot 1] At 00:00.000\n{SOURCE}\n\n"
        "overall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A"
    )
    assert any("Allowed references: none" in str(part) for message in calls[-1] for part in message.parts)


@pytest.mark.asyncio
async def test_retry_does_not_accept_rewritten_direction(monkeypatch):
    from novelvideo.freezone import h3_prompt_optimizer, text_node

    calls = []

    async def respond(messages, info):
        calls.append(messages)
        return ModelResponse(parts=[TextPart(base_draft("The camera moves fast."))])

    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only.")
    monkeypatch.setattr(text_node, "create_freezone_text_writer_agent", lambda *a, **kw: Agent(FunctionModel(respond), output_type=str, retries={"output": kw.get("output_retries", 1)}))
    with pytest.raises(ValueError, match="after retries: H3 formatting changed an original description at source line 1"):
        await text_node.generate_freezone_text(prompt=SOURCE, model="deepseek-ai/DeepSeek-V4-Flash", h3_options=options())
    assert len(calls) == 3
