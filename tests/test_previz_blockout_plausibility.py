from __future__ import annotations

from pathlib import Path

from novelvideo.director_world.blockout.dsl_parser import parse_blockout_program
from novelvideo.director_world.blockout.plausibility import check_plausibility

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
ROOM = "scene.room(id='room', width=8, depth=6, height=3)\n"
CAMERA = "scene.camera(id='cam', position=(0, 1.6, -5), target=(0, 1.2, 1), fov=65)\n"
TABLE = "scene.box(id='table', position=(0, 0, 0), size=(1.2, 0.75, 0.7), semantic_type='table')\n"


def _check(body: str, camera: str = CAMERA):
    return check_plausibility(parse_blockout_program(ROOM + camera + body))


def test_golden_scene_is_clean():
    report = check_plausibility(
        parse_blockout_program(
            (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
        )
    )

    assert report.errors == ()
    assert report.warnings == ()


def test_object_below_the_floor_is_an_error():
    report = _check(
        "scene.box(id='sunk', position=(0, -0.4, 0), size=(1, 0.8, 1), semantic_type='table')\n"
    )

    assert len(report.errors) == 1
    assert "'sunk' is below the floor" in report.errors[0]


def test_camera_looking_toward_the_viewer_is_an_error():
    report = _check(
        TABLE,
        "scene.camera(id='cam', position=(0, 1.6, 2), target=(0, 1.2, -1))\n",
    )

    assert len(report.errors) == 1
    assert "looks toward -z" in report.errors[0]


def test_camera_under_the_floor_is_an_error():
    report = _check(
        TABLE, "scene.camera(id='cam', position=(0, -1, -5), target=(0, 1.2, 1))\n"
    )

    assert ["at or below the floor" in error for error in report.errors] == [True]


def test_objects_outside_the_view_are_an_error():
    report = _check(
        "scene.box(id='a', position=(-3.5, 0, -2.5), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
        "scene.box(id='b', position=(3.5, 0, -2.5), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
        "scene.box(id='c', position=(0, 0, 1), size=(0.5, 1.2, 0.5), semantic_type='prop')\n",
        "scene.camera(id='cam', position=(0, 1.6, -2.6), target=(0, 1.2, 1), fov=40)\n",
    )

    assert len(report.errors) == 1
    assert "only 1 of 3 objects are inside" in report.errors[0]


def test_half_of_the_objects_in_view_is_enough():
    report = _check(
        "scene.box(id='a', position=(-3.5, 0, -2.5), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
        "scene.box(id='c', position=(0, 0, 1), size=(0.5, 1.2, 0.5), semantic_type='prop')\n",
        "scene.camera(id='cam', position=(0, 1.6, -2.6), target=(0, 1.2, 1), fov=40)\n",
    )

    assert report.errors == ()


def test_a_portrait_image_sees_less_to_the_sides_than_its_fov_suggests():
    body = (
        "scene.box(id='high', position=(0, 2.6, 1), size=(0.3, 0.3, 0.3), semantic_type='prop')\n"
    )
    camera = "scene.camera(id='cam', position=(0, 1.5, -2), target=(0, 1.5, 1), fov=40)\n"
    scene = parse_blockout_program(ROOM + camera + body)

    assert check_plausibility(scene, image_aspect=16 / 9).errors != ()
    assert check_plausibility(scene, image_aspect=9 / 16).errors == ()


def test_floating_object_is_only_a_warning():
    report = _check(
        "scene.box(id='lamp', position=(0, 2.4, 0), size=(0.4, 0.3, 0.4), semantic_type='prop')\n"
    )

    assert report.errors == ()
    assert report.warnings == ("'lamp' floats 2.4 m above the floor with nothing under it",)


def test_object_resting_on_another_is_not_floating():
    report = _check(
        TABLE
        + "scene.box(id='vase', position=(0.2, 0.75, 0.1), size=(0.2, 0.3, 0.2), semantic_type='prop')\n"
    )

    assert report.errors == ()
    assert report.warnings == ()


def test_heavy_overlap_is_a_warning():
    report = _check(
        TABLE
        + "scene.box(id='chair', position=(0.1, 0, 0.1), size=(0.5, 0.9, 0.5), semantic_type='chair')\n"
    )

    assert report.errors == ()
    assert report.warnings == ("'table' and 'chair' overlap by 83% of the smaller one",)


def test_touching_objects_do_not_overlap():
    report = _check(
        TABLE
        + "scene.box(id='chair', position=(0.85, 0, 0), size=(0.5, 0.9, 0.5), semantic_type='chair')\n"
    )

    assert report.warnings == ()


def test_object_outside_every_floor_is_a_warning():
    report = _check(
        "scene.box(id='far', position=(0, 0, 5), size=(1, 1, 1), semantic_type='prop')\n"
    )

    assert report.errors == ()
    assert report.warnings == ("'far' stands outside every floor",)


def test_top_resting_on_two_legs_is_not_floating():
    report = _check(
        "scene.box(id='leg_l', position=(-0.9, 0, 0), size=(0.2, 0.5, 0.7), semantic_type='prop')\n"
        "scene.box(id='leg_r', position=(0.9, 0, 0), size=(0.2, 0.5, 0.7), semantic_type='prop')\n"
        "scene.box(id='top', position=(0, 0.5, 0), size=(2.4, 0.1, 0.9), semantic_type='table')\n"
    )

    assert report.warnings == ()


def test_piece_beside_a_supporter_but_not_over_it_still_floats():
    report = _check(
        TABLE
        + "scene.box(id='shelf', position=(2, 0.75, 0), size=(0.5, 0.1, 0.5), semantic_type='shelf')\n"
    )

    assert report.warnings == (
        "'shelf' floats 0.75 m above the floor with nothing under it",
    )


def test_piece_hung_on_a_wall_is_not_floating():
    # room 8 × 6: the back wall's inner face is at z = 2.9, the left wall's at x = -3.9
    report = _check(
        "scene.box(id='scroll', position=(1, 1.4, 2.82), size=(1.2, 1.6, 0.06), semantic_type='prop')\n"
        "scene.box(id='lattice', position=(-3.85, 1.0, 0.5), size=(0.08, 1.5, 1.8), semantic_type='window')\n"
    )

    assert report.warnings == ()


def test_piece_above_the_top_of_a_wall_still_floats():
    report = _check(
        "scene.box(id='sign', position=(1, 3.2, 2.82), size=(1.2, 0.4, 0.06), semantic_type='prop')\n"
    )

    assert report.warnings == (
        "'sign' floats 3.2 m above the floor with nothing under it",
    )


def test_piece_past_the_end_of_a_wall_still_floats():
    report = check_plausibility(
        parse_blockout_program(
            "scene.floor(id='ground', center=(0, 0), size=(8, 6))\n"
            "scene.wall(id='w', start=(-1, 2), end=(1, 2), height=3)\n"
            + CAMERA
            + "scene.box(id='far', position=(3, 1.4, 1.85), size=(1, 1, 0.06), semantic_type='prop')\n"
        )
    )

    assert report.warnings == (
        "'far' floats 1.4 m above the floor with nothing under it",
    )


def test_camera_beside_the_room_is_an_error():
    report = _check(
        TABLE, "scene.camera(id='cam', position=(-4.7, 1.6, -5), target=(0, 1.2, 1))\n"
    )

    assert len(report.errors) == 1
    assert (
        "camera 'cam' stands outside room 'room': position.x = -4.7 is beyond "
        "the left wall (x = -4)"
    ) in report.errors[0]
    assert "keep position.x between -4 and 4" in report.errors[0]


def test_camera_beyond_the_right_wall_is_an_error():
    report = _check(
        TABLE, "scene.camera(id='cam', position=(4.5, 1.6, -5), target=(0, 1.2, 1))\n"
    )

    assert ["beyond the right wall (x = 4)" in error for error in report.errors] == [
        True
    ]


def test_camera_behind_the_back_wall_is_an_error():
    report = _check(
        "scene.box(id='far', position=(0, 0, 6), size=(1, 1, 1), semantic_type='prop')\n",
        "scene.camera(id='cam', position=(0, 1.6, 3.5), target=(0, 1.2, 6))\n",
    )

    assert ["behind the back wall (z = 3)" in error for error in report.errors] == [
        True
    ]


def test_camera_in_front_of_the_open_side_is_fine_however_far_back():
    report = _check(
        TABLE, "scene.camera(id='cam', position=(3.9, 1.6, -30), target=(0, 1.2, 1))\n"
    )

    assert report.errors == ()


def test_camera_inside_any_one_room_is_enough():
    report = check_plausibility(
        parse_blockout_program(
            "scene.room(id='a', width=4, depth=4, height=3, center=(-3, 0))\n"
            "scene.room(id='b', width=4, depth=4, height=3, center=(3, 0))\n"
            "scene.box(id='t', position=(3, 0, 0), size=(1, 1, 1), semantic_type='table')\n"
            "scene.camera(id='cam', position=(3, 1.6, -4), target=(3, 1.2, 1))\n"
        )
    )

    assert report.errors == ()


def test_scene_without_a_room_has_no_rule_about_where_the_camera_stands():
    report = check_plausibility(
        parse_blockout_program(
            "scene.floor(id='ground', center=(0, 0), size=(8, 6))\n"
            "scene.wall(id='w', start=(-4, -3), end=(-4, 3), height=3)\n"
            + TABLE
            + "scene.camera(id='cam', position=(-6, 1.6, -5), target=(0, 1.2, 1))\n"
        )
    )

    assert report.errors == ()


def test_piece_hung_against_a_wall_is_not_reported_as_floating():
    report = _check(
        "scene.box(id='scroll', against='room_back', offset=3, bottom=1.2, size=(0.8, 1.4, 0.04), semantic_type='prop')\n"
        "scene.box(id='desk', against='room_left', offset=4, size=(1.6, 0.8, 0.6), semantic_type='desk')\n"
        "scene.cylinder(id='vase', on='desk', radius=0.1, height=0.3, semantic_type='prop')\n"
        "scene.seen(id='scroll', left=0.4, right=0.48, bottom=0.48)\n"
        "scene.seen(id='desk', left=0.0, right=0.16, bottom=0.77)\n"
        "scene.seen(id='vase', left=0.07, right=0.1)\n"
    )

    assert report.errors == ()
    assert report.warnings == ()


# Three pieces with no sighting at all: the minimum-sightings rule fires, nothing else.
THREE_PIECES = (
    TABLE
    + "scene.box(id='a', position=(-2, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
    "scene.box(id='b', position=(2, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
)
# CAMERA stands 8 m in front of the 8 m back wall with fov 65 and a slight downward
# tilt, so the wall spans 0.5 ± 4 / (8 · 2 · tan 32.5°) ≈ 0.10 .. 0.90 of the picture
# width, and its foot lies at 0.68 of the picture height.
BACK_WALL_SEEN = "scene.seen(id='room_back', left=0.1, right=0.9)\n"


def _sightings(body: str, seen: str, camera: str = CAMERA):
    report = check_plausibility(
        parse_blockout_program(ROOM + camera + body + seen), picture_check=True
    )
    return [error for error in report.errors if "scene.seen" in error or "declared" in error]


def test_sightings_that_agree_with_the_projection_are_clean():
    errors = _sightings(
        THREE_PIECES,
        BACK_WALL_SEEN
        + "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='b', left=0.72, right=0.8)\n",
    )

    assert errors == []


def test_three_or_more_pieces_need_at_least_three_sightings():
    errors = _sightings(THREE_PIECES, BACK_WALL_SEEN)

    assert len(errors) == 1
    assert "at least 3" in errors[0]
    assert "scene.seen" in errors[0]


def test_two_pieces_need_no_sightings():
    report = check_plausibility(
        parse_blockout_program(
            ROOM + CAMERA + TABLE
            + "scene.box(id='a', position=(-2, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
        )
    )

    assert report.errors == ()


def test_a_sighting_on_the_wrong_side_of_the_picture_is_an_error():
    errors = _sightings(
        THREE_PIECES,
        BACK_WALL_SEEN
        + "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='b', left=0.2, right=0.28)\n",
    )

    assert len(errors) == 1
    assert errors[0].startswith("'b' is declared at 20%..28% of the picture width")
    assert "lands at 72%..80%" in errors[0]
    assert "too far to the right" in errors[0]


def test_a_sighting_much_wider_than_the_projection_is_an_error():
    errors = _sightings(
        THREE_PIECES,
        "scene.seen(id='room_back', left=0.3, right=0.7)\n"
        "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='b', left=0.72, right=0.8)\n",
    )

    assert len(errors) == 1
    assert errors[0].startswith("'room_back' is declared at 30%..70%")
    assert "lands at 10%..90%" in errors[0]
    assert "too wide" in errors[0]


def test_a_sighting_with_the_wrong_bottom_is_an_error():
    # The wall meets the floor 8 m ahead of a camera 1.6 m up, looking slightly down.
    clean = _sightings(
        THREE_PIECES,
        "scene.seen(id='room_back', left=0.1, right=0.9, bottom=0.68)\n"
        "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='b', left=0.72, right=0.8)\n",
    )
    wrong = _sightings(
        THREE_PIECES,
        "scene.seen(id='room_back', left=0.1, right=0.9, bottom=0.95)\n"
        "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='b', left=0.72, right=0.8)\n",
    )

    assert clean == []
    assert len(wrong) == 1
    assert "bottom at 95%" in wrong[0]
    assert "lands" in wrong[0] and "bottom at 68%" in wrong[0]
    assert "too high in the picture" in wrong[0]


def test_a_sighting_of_a_piece_behind_the_camera_is_an_error():
    errors = _sightings(
        THREE_PIECES
        + "scene.box(id='behind', position=(0, 0, -7), size=(0.5, 0.5, 0.5), semantic_type='prop')\n",
        BACK_WALL_SEEN
        + "scene.seen(id='a', left=0.2, right=0.28)\n"
        "scene.seen(id='behind', left=0.4, right=0.6)\n",
    )

    assert len(errors) == 1
    assert "'behind' is declared" in errors[0]
    assert "behind the camera" in errors[0]


def test_a_wall_running_past_the_camera_is_clipped_not_dropped():
    # The camera stands inside the room, 1 m from the left wall, which runs from
    # 2 m behind it to 4 m ahead. Its near corners cannot be projected; the part
    # ahead of the camera still fills the left fifth of the picture. Were the
    # wall's corners behind the camera simply dropped, the two far corners would
    # be left, both at 21%, and the wall would be reported as too narrow.
    inside = "scene.camera(id='cam', position=(-3, 1.6, -1), target=(-2.5, 1.2, 3), fov=65)\n"
    errors = _sightings(
        THREE_PIECES,
        "scene.seen(id='room_left', left=0.0, right=0.2)\n"
        "scene.seen(id='room_back', left=0.2, right=1.0)\n"
        "scene.seen(id='a', left=0.65, right=0.9)\n",
        camera=inside,
    )

    assert errors == []


def test_sightings_are_not_checked_while_the_camera_itself_is_wrong():
    report = check_plausibility(
        parse_blockout_program(
            ROOM
            + "scene.camera(id='cam', position=(0, 1.6, 2), target=(0, 1.2, -1))\n"
            + THREE_PIECES
        )
    )

    assert len(report.errors) == 1
    assert "looks toward -z" in report.errors[0]


def test_sightings_are_ignored_unless_the_picture_check_is_on():
    # Neither the missing sightings nor a wrong one count without the option.
    scene = parse_blockout_program(
        ROOM + CAMERA + THREE_PIECES + "scene.seen(id='b', left=0.2, right=0.28)\n"
    )

    assert check_plausibility(scene).errors == ()
    assert check_plausibility(scene, picture_check=True).errors != ()
