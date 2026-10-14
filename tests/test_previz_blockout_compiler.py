from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.director_world.blockout.compiler import (
    camera_rotation_degrees,
    compile_scene,
    focal_mm_from_horizontal_fov,
)
from novelvideo.director_world.blockout.dsl_parser import parse_blockout_program
from novelvideo.director_world.blockout.scene_ir import (
    MAX_COMPILED_OBJECTS,
    BlockoutLimitError,
)

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
CAMERA = 'scene.camera(id="cam", position=(0, 1.6, -5), target=(0, 1.6, 0))\n'


def _compile(body: str) -> dict:
    return compile_scene(parse_blockout_program(CAMERA + body))


def _by_id(result: dict) -> dict[str, dict]:
    return {item["id"]: item for item in result["objects"]}


@pytest.mark.parametrize(
    ("start", "end", "position", "rotation_y", "length"),
    [
        # along +x: the cube's own x axis already points that way
        ((-4, 3), (4, 3), [0.0, 0.0, -3.0], 0.0, 8.0),
        # along +z (away from the camera) is previz -z, a +90° turn in three.js
        ((-4, -3), (-4, 3), [-4.0, 0.0, 0.0], 90.0, 6.0),
        # diagonal, right and away
        ((1, 0), (3, 2), [2.0, 0.0, -1.0], 45.0, 2.8284),
        # diagonal, right and toward the camera
        ((1, 0), (3, -2), [2.0, 0.0, 1.0], -45.0, 2.8284),
    ],
)
def test_wall_is_one_cube_along_its_run(start, end, position, rotation_y, length):
    wall = _by_id(
        _compile(f"scene.wall(id='w', start={start}, end={end}, height=3, thickness=0.2)\n")
    )["blockout-w"]

    assert wall["assetUrl"] == "cube"
    assert wall["assetFormat"] == "primitive"
    assert wall["transform"] == {
        "position": position,
        "rotation": [0.0, rotation_y, 0.0],
        "scale": [length, 3.0, 0.2],
    }
    assert wall["blockout"] == {"id": "w", "semanticType": "wall"}


def test_door_splits_a_wall_into_left_lintel_and_right():
    result = _compile(
        "scene.wall(id='w', start=(-4, 3), end=(4, 3), height=3, thickness=0.2)\n"
        "scene.opening(id='d', wall='w', offset=1, width=1, height=2.1)\n"
    )

    pieces = [item for item in result["objects"] if item["kind"] == "prop"]
    assert [(p["id"], p["name"]) for p in pieces] == [
        ("blockout-w-1", "墙 1-段 1"),
        ("blockout-w-2", "墙 1-门楣 1"),
        ("blockout-w-3", "墙 1-段 2"),
    ]
    assert [p["transform"]["position"] for p in pieces] == [
        [-3.5, 0.0, -3.0],
        [-2.5, 2.1, -3.0],
        [1.0, 0.0, -3.0],
    ]
    assert [p["transform"]["scale"] for p in pieces] == [
        [1.0, 3.0, 0.2],
        [1.0, 0.9, 0.2],
        [6.0, 3.0, 0.2],
    ]
    assert {p["blockout"]["id"] for p in pieces} == {"w"}


def test_window_adds_a_sill_piece():
    result = _compile(
        "scene.wall(id='w', start=(-4, 3), end=(4, 3), height=3, thickness=0.2)\n"
        "scene.opening(id='o', wall='w', kind='window', offset=1, width=2, height=1.2, sill=0.9)\n"
    )

    pieces = [item for item in result["objects"] if item["kind"] == "prop"]
    assert [p["name"] for p in pieces] == [
        "墙 1-段 1",
        "墙 1-门楣 1",
        "墙 1-窗台 1",
        "墙 1-段 2",
    ]
    assert pieces[1]["transform"]["position"] == [-2.0, 2.1, -3.0]
    assert pieces[1]["transform"]["scale"] == [2.0, 0.9, 0.2]
    assert pieces[2]["transform"]["position"] == [-2.0, 0.0, -3.0]
    assert pieces[2]["transform"]["scale"] == [2.0, 0.9, 0.2]


def test_a_window_above_a_door_cuts_the_wall_into_lintel_sills_and_spandrel():
    result = _compile(
        "scene.wall(id='w', start=(-4, 3), end=(4, 3), height=5, thickness=0.2)\n"
        "scene.opening(id='door', wall='w', offset=3, width=1, height=2)\n"
        "scene.opening(id='win', wall='w', kind='window', offset=2.5, width=2, height=1, sill=3)\n"
    )

    pieces = [item for item in result["objects"] if item["kind"] == "prop"]
    # Left of both, one lintel over the whole window, sills either side of the
    # door, the spandrel between door and window, right of both.
    assert [p["name"] for p in pieces] == [
        "墙 1-段 1",
        "墙 1-门楣 1",
        "墙 1-窗台 1",
        "墙 1-腰墙 1",
        "墙 1-窗台 2",
        "墙 1-段 2",
    ]
    assert [p["transform"]["position"] for p in pieces] == [
        [-2.75, 0.0, -3.0],
        [-0.5, 4.0, -3.0],
        [-1.25, 0.0, -3.0],
        [-0.5, 2.0, -3.0],
        [0.25, 0.0, -3.0],
        [2.25, 0.0, -3.0],
    ]
    assert [p["transform"]["scale"] for p in pieces] == [
        [2.5, 5.0, 0.2],
        [2.0, 1.0, 0.2],
        [0.5, 3.0, 0.2],
        [1.0, 1.0, 0.2],
        [0.5, 3.0, 0.2],
        [3.5, 5.0, 0.2],
    ]
    assert [p["id"] for p in pieces] == [f"blockout-w-{i}" for i in range(1, 7)]


def test_pieces_thinner_than_a_centimetre_are_dropped():
    result = _compile(
        "scene.wall(id='w', start=(0, 3), end=(4, 3), height=3, thickness=0.2)\n"
        "scene.opening(id='a', wall='w', offset=0, width=1, height=3)\n"
        "scene.opening(id='b', wall='w', offset=3, width=1, height=2.995)\n"
    )

    pieces = [item for item in result["objects"] if item["kind"] == "prop"]
    assert [p["transform"]["scale"] for p in pieces] == [[2.0, 3.0, 0.2]]
    assert pieces[0]["transform"]["position"] == [2.0, 0.0, -3.0]


def test_openings_on_a_diagonal_wall_follow_the_wall():
    result = _compile(
        "scene.wall(id='w', start=(0, 0), end=(3, 4), height=3, thickness=0.2)\n"
        "scene.opening(id='d', wall='w', offset=2, width=1, height=2)\n"
    )

    pieces = [item for item in result["objects"] if item["kind"] == "prop"]
    # unit direction (0.6, 0.8); the lintel is centred 2.5 m along the wall
    assert pieces[1]["transform"]["position"] == [1.5, 2.0, -2.0]
    assert {p["transform"]["rotation"][1] for p in pieces} == {53.1301}


def test_solid_position_is_the_bottom_centre_and_z_is_flipped():
    result = _by_id(
        _compile(
            "scene.box(id='b', position=(2.5, 0.4, 1.0), size=(2.0, 1.1, 0.6), "
            "rotation_y=30, semantic_type='counter')\n"
            "scene.cylinder(id='c', position=(-2, 0, 0.5), radius=0.2, height=0.7, "
            "semantic_type='chair')\n"
            "scene.stairs(id='s', position=(-3, 0, 2), size=(1.2, 1.0, 2.0), rotation_y=-90)\n"
        )
    )

    assert result["blockout-b"]["transform"] == {
        "position": [2.5, 0.4, -1.0],
        "rotation": [0.0, 30.0, 0.0],
        "scale": [2.0, 1.1, 0.6],
    }
    assert result["blockout-b"]["name"] == "柜台 1"
    assert result["blockout-c"]["assetUrl"] == "cylinder"
    assert result["blockout-c"]["transform"]["scale"] == [0.4, 0.7, 0.4]
    assert result["blockout-s"]["assetUrl"] == "wedge"
    assert result["blockout-s"]["transform"]["rotation"] == [0.0, -90.0, 0.0]
    assert result["blockout-s"]["blockout"] == {"id": "s", "semanticType": "stairs"}


def test_rotation_is_wrapped_into_a_half_turn():
    result = _by_id(
        _compile(
            "scene.box(id='a', position=(0, 0, 0), size=(1, 1, 1), rotation_y=270, semantic_type='prop')\n"
            "scene.box(id='b', position=(0, 0, 0), size=(1, 1, 1), rotation_y=-180, semantic_type='prop')\n"
            "scene.box(id='c', position=(0, 0, 0), size=(1, 1, 1), rotation_y=360, semantic_type='prop')\n"
        )
    )

    assert result["blockout-a"]["transform"]["rotation"][1] == -90.0
    assert result["blockout-b"]["transform"]["rotation"][1] == 180.0
    assert result["blockout-c"]["transform"]["rotation"][1] == 0.0


def test_floor_is_a_plane_scaled_to_its_size():
    floor = _by_id(_compile("scene.floor(id='g', center=(1, 2), size=(8, 6))\n"))[
        "blockout-g"
    ]

    assert floor["assetUrl"] == "plane"
    assert floor["transform"] == {
        "position": [1.0, 0.0, -2.0],
        "rotation": [0.0, 0.0, 0.0],
        "scale": [8.0, 1.0, 6.0],
    }
    assert floor["name"] == "地面 1"


def test_unknown_semantic_type_is_used_as_the_name():
    result = _by_id(
        _compile("scene.box(id='b', position=(0, 0, 0), size=(1, 1, 1), semantic_type='jukebox')\n")
    )

    assert result["blockout-b"]["name"] == "jukebox 1"


@pytest.mark.parametrize(
    ("position", "target", "rotation"),
    [
        # looking straight away from the viewer is previz -z: no rotation at all
        ((0, 1.6, 5), (0, 1.6, 0), [0.0, 0.0, 0.0]),
        # previz +x is to the right: a right turn is a negative yaw
        ((0, 1.6, 5), (5, 1.6, 0), [0.0, -45.0, 0.0]),
        ((0, 1.6, 5), (-5, 1.6, 0), [0.0, 45.0, 0.0]),
        ((0, 1.6, 0), (0, 1.6, 5), [0.0, 180.0, 0.0]),
        # looking down is a negative pitch
        ((0, 5, 5), (0, 0, 0), [-45.0, 0.0, 0.0]),
        ((0, 0, 5), (0, 5, 0), [45.0, 0.0, 0.0]),
        # straight down: yaw is undefined, stays 0
        ((0, 5, 0), (0, 0, 0), [-90.0, 0.0, 0.0]),
    ],
)
def test_camera_rotation(position, target, rotation):
    assert camera_rotation_degrees(position, target) == rotation


def test_camera_is_compiled_into_the_previz_frame():
    result = compile_scene(
        parse_blockout_program(
            "scene.floor(id='g', center=(0, 0), size=(8, 6))\n"
            "scene.camera(id='cam', position=(1, 1.6, -5), target=(0, 1.2, 1), fov=65)\n"
        )
    )
    camera = _by_id(result)["blockout-cam"]

    assert result["reference_camera_id"] == "blockout-cam"
    assert camera == {
        "id": "blockout-cam",
        "kind": "camera",
        "name": "参考机位",
        "transform": {
            "position": [1.0, 1.6, 5.0],
            "rotation": [-3.7623, 9.4623, 0.0],
            "scale": [1.0, 1.0, 1.0],
        },
        "visible": True,
        "locked": False,
        "focalMm": 28.2543,
        "aperture": 2.8,
        "sensor": "ff",
        "cameraBody": "cine",
        "lensSeries": "prime",
        "blockout": {"id": "cam", "semanticType": "reference_camera"},
    }


@pytest.mark.parametrize(
    ("fov", "focal"),
    [(65, 28.2543), (90, 18.0), (40, 49.4546), (170, 12.0), (5, 200.0), (112.62, 12.0)],
)
def test_focal_length_follows_the_frontend_formula(fov, focal):
    assert focal_mm_from_horizontal_fov(fov) == focal


def test_every_transform_is_three_plain_floats():
    result = compile_scene(
        parse_blockout_program(
            (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
        )
    )

    for item in result["objects"]:
        for key in ("position", "rotation", "scale"):
            triple = item["transform"][key]
            assert isinstance(triple, list) and len(triple) == 3, item["id"]
            assert all(type(value) is float for value in triple), item["id"]
            assert "-0.0" not in json.dumps(triple), item["id"]
    assert len({item["id"] for item in result["objects"]}) == len(result["objects"])


def test_compiling_twice_gives_identical_bytes():
    source = (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")

    first = json.dumps(compile_scene(parse_blockout_program(source)), sort_keys=True)
    second = json.dumps(compile_scene(parse_blockout_program(source)), sort_keys=True)

    assert first == second


def test_golden_fixture_matches_the_compiler():
    source = (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
    golden = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))

    assert compile_scene(parse_blockout_program(source)) == golden["compiled"]


def test_object_count_is_capped():
    def program(count: int) -> str:
        ids = ", ".join(f'"b{index}"' for index in range(count))
        positions = ", ".join("(0, 0, 0)" for _ in range(count))
        return (
            CAMERA
            + f"scene.repeat(primitive='box', ids=[{ids}], positions=[{positions}], "
            "size=(1, 1, 1), semantic_type='prop')\n"
        )

    allowed = compile_scene(parse_blockout_program(program(MAX_COMPILED_OBJECTS)))
    assert allowed["counts"] == {"prop": MAX_COMPILED_OBJECTS, "camera": 1}

    with pytest.raises(BlockoutLimitError, match="151 objects > 150"):
        compile_scene(parse_blockout_program(program(MAX_COMPILED_OBJECTS + 1)))


def test_label_names_the_piece_and_repeats_are_numbered():
    result = _by_id(
        _compile(
            "scene.box(id='kang', position=(0, 0, 1), size=(2, 0.5, 1), "
            "semantic_type='platform', label='炕')\n"
            "scene.repeat(primitive='box', ids=['a', 'b'], positions=[(-1, 0, 0), (-2, 0, 0)], "
            "size=(0.5, 0.9, 0.5), semantic_type='chair', label='圈椅')\n"
            "scene.box(id='plain', position=(2, 0, 1), size=(1, 1, 1), semantic_type='table')\n"
        )
    )

    assert [result[key]["name"] for key in (
        "blockout-kang", "blockout-a", "blockout-b", "blockout-plain"
    )] == ["炕", "圈椅", "圈椅 2", "桌子 1"]
    assert result["blockout-kang"]["blockout"] == {"id": "kang", "semanticType": "platform"}
