from __future__ import annotations

from novelvideo.director_world.blockout.dsl_parser import (
    _SPEC,
    parse_blockout_program,
)
from novelvideo.director_world.blockout.plausibility import check_plausibility
from novelvideo.director_world.blockout.prompts import (
    BLOCKOUT_EXAMPLE_PROGRAM,
    BLOCKOUT_EXAMPLE_SIGHTINGS,
    BLOCKOUT_PROMPT_VERSION,
    MAX_DESCRIPTION_CHARS,
    SUGGESTED_OBJECT_COUNT,
    build_blockout_prompt,
    build_blockout_retry_prompt,
    build_blockout_review_prompt,
)


def test_the_example_in_the_prompt_is_a_valid_plausible_program():
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)

    assert check_plausibility(scene).errors == ()
    assert check_plausibility(scene).warnings == ()
    assert len(scene.solids) == 8


def _signatures(prompt: str, instruction: str) -> str:
    """Every `scene.<instruction>(...)` written as inline code, joined.

    The example program is not inline code, so an argument that only the example
    uses does not count as documented.
    """
    pieces = prompt.split(f"`scene.{instruction}(")[1:]
    return " ".join(piece.split(")`", 1)[0] for piece in pieces)


def test_prompt_names_every_instruction_and_argument_the_parser_accepts():
    prompt = build_blockout_prompt(picture_check=True)

    missing = [
        f"{instruction}.{argument}"
        for instruction, (required, optional) in _SPEC.items()
        for argument in (*required, *optional)
        if argument not in _signatures(prompt, instruction)
    ]

    assert missing == []


def test_without_the_picture_check_the_prompt_never_mentions_sightings():
    prompt = build_blockout_prompt()

    assert "scene.seen" not in prompt
    assert "画面核对" not in prompt
    # The example is part of the prompt, so it must not teach the instruction either.
    assert "scene.seen" not in BLOCKOUT_EXAMPLE_PROGRAM


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


def test_prompt_asks_for_one_box_per_piece_of_furniture():
    prompt = build_blockout_prompt()

    assert "一件家具只用一个几何体" in prompt
    assert "桌腿、椅背、台面不要单独摆" in prompt


def test_prompt_keeps_small_pieces_whole_instead_of_dropping_them():
    prompt = build_blockout_prompt()

    assert "小摆件不要摆" not in prompt
    assert "小摆件也摆，同样一件只用一个几何体" in prompt
    assert "画框和画芯、瓶身和瓶口不要分开摆" in prompt
    assert f"总数建议不超过 {SUGGESTED_OBJECT_COUNT} 件" in prompt
    assert SUGGESTED_OBJECT_COUNT <= 40


def test_prompt_places_large_pieces_before_small_ones():
    prompt = build_blockout_prompt()

    assert "先摆完大家具，再摆小摆件" in prompt
    assert "放在别的物件上的用 on 写" in prompt


def test_example_shows_a_small_piece_resting_on_a_larger_one():
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)
    solids = {solid.id: solid for solid in scene.solids}

    table, laptop = solids["table"], solids["laptop"]
    assert laptop.position[1] == table.position[1] + table.size[1]
    assert check_plausibility(scene).warnings == ()


def test_prompt_asks_which_wall_each_piece_stands_against_before_any_geometry():
    prompt = build_blockout_prompt()

    analysis = prompt.index("靠哪面墙")
    assert analysis < prompt.index("搭大结构")
    assert "正对后墙，还是斜着拍" in prompt


def test_prompt_asks_for_a_label_on_every_piece():
    assert "label 写这件东西的中文名" in build_blockout_prompt()


def test_example_shows_labels_and_the_layout_notes():
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)

    assert all(solid.name_hint for solid in scene.solids)
    assert "# 靠墙：" in BLOCKOUT_EXAMPLE_PROGRAM


def test_review_prompt_shows_the_program_and_the_render_and_asks_for_a_full_rewrite():
    prompt = build_blockout_review_prompt(
        base_prompt=build_blockout_prompt(), previous_program="scene.box(id='a')\n"
    )

    assert prompt.startswith(build_blockout_prompt())
    assert "## 渲染核对" in prompt
    assert "```\nscene.box(id='a')\n```" in prompt
    # The model is told what each picture is and what the colours and labels mean.
    assert "第一张图是参考图" in prompt and "第二张图" in prompt
    assert "id" in prompt and "颜色只用来区分类型" in prompt
    # Structure first, numbers second, and the whole program back.
    assert "要新增" in prompt and "要删掉" in prompt and "相机" in prompt
    assert "允许大改" in prompt
    assert "完整的程序" in prompt and "不要只输出改动的部分" in prompt


def test_prompt_says_shift_follows_the_base_piece_not_the_scene():
    prompt = build_blockout_prompt()

    assert "dx 沿下面那件的宽" in prompt and "dz 沿它的深" in prompt
    assert "dx 向右为正，dz 向远处为正，不能" not in prompt


def test_prompt_allows_a_high_window_right_above_a_door():
    prompt = build_blockout_prompt()

    assert "门正上方" in prompt
    assert "同一面墙上的洞口不能重叠。" not in prompt


def test_prompt_version_moves_with_the_wording():
    assert BLOCKOUT_PROMPT_VERSION == 11


def test_prompt_asks_for_relations_instead_of_coordinates_where_it_can():
    prompt = build_blockout_prompt()

    assert "靠墙的物件用 against 写" in prompt
    assert "放在别的物件上的用 on 写" in prompt
    assert "只有不靠墙、也不放在别的物件上的，才用 position 写坐标" in prompt
    assert "家具的长边通常顺着它靠的那面墙" in prompt
    assert "相机的 x 要落在左墙和右墙之间" in prompt


def test_example_places_pieces_by_relation():
    for placement in (
        'against="room_left"',
        'against="room_back"',
        'against="room_right"',
        'on="table"',
    ):
        assert placement in BLOCKOUT_EXAMPLE_PROGRAM


def test_prompt_asks_for_footprints_as_shares_of_the_room_before_any_geometry():
    prompt = build_blockout_prompt()

    assert prompt.index("占地：") < prompt.index("搭大结构")
    assert "用房间来量，不要凭感觉写米数" in prompt
    assert "占这面墙的几分之几" in prompt
    assert "从墙面伸进房间多远" in prompt
    assert "占比乘以房间的宽和深" in prompt


def test_prompt_warns_that_lengths_along_the_view_look_shorter_than_they_are():
    prompt = build_blockout_prompt()

    assert "沿着视线方向的长度在图里被压短了" in prompt
    assert "它就和这面墙一样长" in prompt


def test_prompt_treats_a_platform_that_carries_furniture_as_one_large_piece():
    prompt = build_blockout_prompt()

    assert "平台本身是一件大家具" in prompt
    assert "不要把它们摆到地上" in prompt


def test_prompt_gives_footprints_of_common_furniture_not_only_heights():
    prompt = build_blockout_prompt()

    for anchor in ("双人床", "三人沙发", "餐桌", "书桌", "炕桌"):
        assert anchor in prompt.split("定尺度")[1].split("定相机")[0]


def test_self_check_compares_sizes_with_the_shares_written_first():
    prompt = build_blockout_prompt()

    assert "和第 1 步写的占比对得上" in prompt.split("自查")[1]


def test_footprints_stated_in_the_example_match_its_geometry():
    assert (
        "# 占地：文件柜占左墙约四分之一；会议桌长占房间宽度的四成，宽占进深的两成"
        in BLOCKOUT_EXAMPLE_PROGRAM
    )
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)
    room = scene.rooms[0]
    pieces = {solid.id: solid for solid in scene.solids}

    assert round(pieces["cabinet"].size[0] / room.size[1], 2) == 0.24
    assert round(pieces["table"].size[0] / room.size[0], 2) == 0.4
    assert round(pieces["table"].size[2] / room.size[1], 2) == 0.2


def test_prompt_derives_the_camera_distance_from_the_back_wall_share():
    """A picture does not say how far the camera stood, but it does say how much of
    its width the back wall fills; the distance follows from that and the fov."""
    prompt = build_blockout_prompt()

    assert "后墙在画面里占了画面宽度的几分之几" in prompt
    assert "距离 = 后墙宽 ÷ 占比 ÷ k" in prompt
    assert "fov 50 取 0.93，60 取 1.15，70 取 1.40，80 取 1.68" in prompt
    assert "不要退到房间外面很远的地方" not in prompt
    assert "相机离后墙的距离是不是按后墙的占比算出来的" in prompt


def test_prompt_says_which_side_the_camera_stands_on_in_an_oblique_shot():
    """You see the face of the wall you are facing: the side wall that shows its
    face is the far one, and the camera stands on the opposite side."""
    prompt = build_blockout_prompt()

    assert "相机在它对面那一侧、朝它看" in prompt
    assert "只露出一条边贴着画面边缘的侧墙，相机就贴近它" in prompt


def test_example_camera_stands_as_far_back_as_its_stated_back_wall_share_says():
    import math

    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM)
    room = scene.rooms[0]
    back_z = room.center[1] + room.size[1] / 2.0
    front_z = room.center[1] - room.size[1] / 2.0
    camera = scene.camera

    assert "后墙占画面宽度约六成" in BLOCKOUT_EXAMPLE_PROGRAM
    expected = room.size[0] / 0.6 / (2.0 * math.tan(math.radians(camera.fov) / 2.0))
    assert abs((back_z - camera.position[2]) - expected) < 0.3
    assert camera.position[2] < front_z - 2.0


def test_prompt_asks_the_model_to_read_picture_positions_off_the_picture():
    prompt = build_blockout_prompt(picture_check=True)

    assert "至少给三件东西写 scene.seen" in prompt
    assert "离画面左边缘的距离" in prompt
    assert "离画面上边缘的距离" in prompt
    assert "不要反过来凑坐标" in prompt
    # The check runs on the model's own program, so the prompt has to say that
    # a mismatch comes back for the coordinates to change, not the sightings.
    assert "对不上就把差在哪里退回给你改" in prompt


def test_example_sightings_are_read_from_the_picture_the_example_describes():
    scene = parse_blockout_program(BLOCKOUT_EXAMPLE_PROGRAM + BLOCKOUT_EXAMPLE_SIGHTINGS)

    described = {sighting.id for sighting in scene.sightings}
    assert "room_back" in described
    assert len(described) >= 3
    # The sightings must agree with the example's own camera, or the example
    # would teach the model a program the check rejects.
    assert check_plausibility(scene, picture_check=True).errors == ()
    assert BLOCKOUT_EXAMPLE_SIGHTINGS in build_blockout_prompt(picture_check=True)
