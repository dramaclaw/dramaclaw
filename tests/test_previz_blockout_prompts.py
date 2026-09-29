from __future__ import annotations

from novelvideo.director_world.blockout.dsl_parser import (
    _SPEC,
    parse_blockout_program,
)
from novelvideo.director_world.blockout.plausibility import check_plausibility
from novelvideo.director_world.blockout.prompts import (
    BLOCKOUT_EXAMPLE_PROGRAM,
    MAX_DESCRIPTION_CHARS,
    build_blockout_prompt,
    build_blockout_retry_prompt,
)


def test_the_example_in_the_prompt_is_a_valid_plausible_program():
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)

    assert check_plausibility(scene).errors == ()
    assert len(scene.solids) == 6


def test_prompt_names_every_instruction_and_argument_the_parser_accepts():
    prompt = build_blockout_prompt()

    missing = [
        f"{instruction}.{argument}"
        for instruction, (required, optional) in _SPEC.items()
        for argument in (*required, *optional)
        if f"scene.{instruction}(" not in prompt
        or argument not in prompt.split(f"scene.{instruction}(", 1)[1].split(")`", 1)[0]
    ]

    assert missing == []


def test_prompt_tells_the_model_not_to_write_the_header_from_the_old_proposal():
    assert "不要写 `scene = ...`" in build_blockout_prompt()


def test_prompt_without_a_description_has_no_user_section():
    assert "用户补充说明" not in build_blockout_prompt(description="  \n ")


def test_description_is_flattened_and_capped():
    prompt = build_blockout_prompt(description="门宽\n0.9 米\n\n" + "长" * 1000)

    note = prompt.split("## 用户补充说明", 1)[1]
    assert "门宽 0.9 米 长" in note
    assert note.count("长") == MAX_DESCRIPTION_CHARS - len("门宽 0.9 米 ")


def test_prompt_states_the_aspect_ratio_of_the_image_that_is_sent():
    prompt = build_blockout_prompt(image_size=(1280, 720))

    assert "图片 1280 × 720 像素，宽高比 1.78" in prompt


def test_retry_prompt_carries_the_previous_program_and_every_error():
    prompt = build_blockout_retry_prompt(
        base_prompt=build_blockout_prompt(),
        previous_program="scene.box(id='a')\n",
        errors=("line 1: box is missing position", "camera is required"),
    )

    assert "```\nscene.box(id='a')\n```" in prompt
    assert "- line 1: box is missing position\n- camera is required\n" in prompt
    assert prompt.startswith(build_blockout_prompt())
