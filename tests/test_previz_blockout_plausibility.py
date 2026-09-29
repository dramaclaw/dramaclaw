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
        "scene.camera(id='cam', position=(0, 1.6, 5), target=(0, 1.2, -1))\n",
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
