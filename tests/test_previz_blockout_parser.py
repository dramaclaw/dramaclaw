from __future__ import annotations

import ast
from pathlib import Path

import pytest

from novelvideo.director_world.blockout import dsl_parser
from novelvideo.director_world.blockout.dsl_parser import parse_blockout_program
from novelvideo.director_world.blockout.scene_ir import (
    MAX_PROGRAM_CHARS,
    BlockoutProgramError,
)

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
CAMERA = 'scene.camera(id="cam", position=(0, 1.6, -5), target=(0, 1.2, 1))\n'
FLOOR = 'scene.floor(id="ground", center=(0, 0), size=(8, 6))\n'


def _parse(body: str):
    return parse_blockout_program(FLOOR + CAMERA + body)


def test_golden_program_parses_into_the_expected_shape():
    scene = parse_blockout_program(
        (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
    )

    assert [floor.id for floor in scene.floors] == ["room_floor"]
    assert [wall.id for wall in scene.walls] == [
        "room_back",
        "room_left",
        "room_right",
        "partition",
    ]
    assert [opening.id for opening in scene.walls[0].openings] == ["door"]
    assert scene.walls[1].openings[0].sill == 0.9
    assert [solid.id for solid in scene.solids] == [
        "counter",
        "stool",
        "steps",
        "table_1",
        "table_2",
    ]
    assert scene.solids[1].size == (0.4, 0.7, 0.4)
    assert scene.solids[2].shape == "wedge"
    assert scene.solids[2].semantic_type == "stairs"
    assert scene.camera.fov == 65


def test_room_leaves_the_side_facing_the_camera_open():
    scene = parse_blockout_program(
        'scene.room(id="r", width=4, depth=6, height=3, center=(1, 2))\n' + CAMERA
    )

    assert scene.floors[0].center == (1, 2)
    assert {wall.id: (wall.start, wall.end) for wall in scene.walls} == {
        "r_back": ((-1, 5), (3, 5)),
        "r_left": ((-1, -1), (-1, 5)),
        "r_right": ((3, -1), (3, 5)),
    }


def test_window_defaults_to_a_raised_sill_and_door_to_none():
    scene = _parse(
        'scene.wall(id="w", start=(-4, 3), end=(4, 3), height=3)\n'
        'scene.opening(id="a", wall="w", kind="window", offset=1, width=1, height=1)\n'
        'scene.opening(id="b", wall="w", offset=3, width=1, height=2)\n'
    )

    assert [(o.id, o.kind, o.sill) for o in scene.walls[0].openings] == [
        ("a", "window", 0.9),
        ("b", "door", 0.0),
    ]


def test_opening_may_be_written_before_its_wall():
    scene = _parse(
        'scene.opening(id="a", wall="w", offset=1, width=1, height=2)\n'
        'scene.wall(id="w", start=(-4, 3), end=(4, 3), height=3)\n'
    )

    assert scene.walls[0].openings[0].id == "a"


def test_comments_and_blank_lines_are_ignored():
    scene = _parse('\n# a note\nscene.box(id="b", position=(0, 0, 0), size=(1, 1, 1), semantic_type="prop")\n')

    assert scene.solids[0].id == "b"


BOX = 'scene.box(id="b", position=(0, 0, 0), size=(1, 1, 1), semantic_type="prop")'


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ("import os", "got Import"),
        ("from os import system", "got ImportFrom"),
        ("x = 1", "got Assign"),
        ('scene = BlockoutScene(unit="meter")', "got Assign"),
        ("def f():\n    pass", "got FunctionDef"),
        ("for i in range(3):\n    pass", "got For"),
        ("if True:\n    pass", "got If"),
        ("while True:\n    pass", "got While"),
        ("class A:\n    pass", "got ClassDef"),
        ('"just a string"', "got Expr"),
        ("lambda: 1", "got Expr"),
        ('__import__("os").system("true")', "only calls on `scene`"),
        ('os.system("true")', "only calls on `scene`"),
        ("scene.a.box(id='b')", "only calls on `scene`"),
        ("scene()", "only calls on `scene`"),
        ("print(1)", "only calls on `scene`"),
        ("scene.ceiling(id='c')", "unknown instruction scene.ceiling"),
        ("scene.__class__()", "unknown instruction scene.__class__"),
        (BOX.replace("size=(1, 1, 1)", "size=(1, 1, 1), color='red'"), "unknown argument 'color'"),
        (BOX.replace("position=", "center="), "use position=(x, y, z)"),
        ("scene.box('b')", "positional arguments are not allowed"),
        ("scene.box(**{'id': 'b'})", "** arguments are not allowed"),
        ("scene.box(id='b')", "missing argument(s): semantic_type, size"),
        (BOX.replace("(1, 1, 1)", "(1 + 1, 1, 1)"), "got BinOp"),
        (BOX.replace("(1, 1, 1)", "(abs(1), 1, 1)"), "got Call"),
        (BOX.replace("(1, 1, 1)", "(x, 1, 1)"), "got Name"),
        (BOX.replace("(1, 1, 1)", "[i for i in range(3)]"), "got ListComp"),
        (BOX.replace("(1, 1, 1)", "sizes[0]"), "got Subscript"),
        (BOX.replace("(1, 1, 1)", "scene.size"), "got Attribute"),
        (BOX.replace('"prop"', 'f"{1}"'), "got JoinedStr"),
        (BOX.replace("(1, 1, 1)", "(+1, 1, 1)"), "got UnaryOp"),
        (BOX.replace("(1, 1, 1)", "(1e999, 1, 1)"), "number is not finite"),
        (BOX.replace("(1, 1, 1)", "(1j, 1, 1)"), "unsupported literal"),
        (BOX.replace("(1, 1, 1)", "(None, 1, 1)"), "unsupported literal"),
        (BOX.replace("(1, 1, 1)", "(True, 1, 1)"), "must be a tuple of 3 numbers"),
        (BOX.replace("(1, 1, 1)", "(1, 1)"), "must be a tuple of 3 numbers"),
        (BOX.replace("(1, 1, 1)", "((((1,),),),)"), "nested too deeply"),
        (BOX.replace("(1, 1, 1)", "(0, 1, 1)"), "must be greater than 0"),
        (BOX.replace("(1, 1, 1)", "(-1, 1, 1)"), "must be greater than 0"),
        (BOX.replace("(1, 1, 1)", "(100.5, 1, 1)"), "at most 100 metres"),
        (BOX.replace("(0, 0, 0)", "(0, 0, 100.5)"), "out of bounds"),
        (BOX.replace('"prop"', '"Dining Table"'), "lower_snake_case"),
        (BOX.replace('id="b"', 'id="1b"'), "id must start with a letter"),
        (BOX.replace('id="b"', "id=3"), "id must start with a letter"),
        (BOX + "\n" + BOX, "duplicate id 'b'"),
        (BOX.replace('id="b"', 'id="ground"'), "duplicate id 'ground'"),
        (BOX.replace("size=(1, 1, 1)", "size=(1, 1, 1), rotation_y=720"), "within ±360"),
        ("scene.wall(id='w', start=(1, 1), end=(1, 1), height=3)", "has no length"),
        ("scene.opening(id='o', wall='nope', offset=0, width=1, height=2)", "wall 'nope' does not exist"),
        (
            "scene.wall(id='w', start=(0, 0), end=(4, 0), height=3)\n"
            "scene.opening(id='o', wall='w', offset=3.5, width=1, height=2)",
            "runs past the end of wall 'w'",
        ),
        (
            "scene.wall(id='w', start=(0, 0), end=(4, 0), height=3)\n"
            "scene.opening(id='o', wall='w', offset=1, width=1, height=2, sill=1.5)",
            "is taller than wall 'w'",
        ),
        (
            "scene.wall(id='w', start=(0, 0), end=(4, 0), height=3)\n"
            "scene.opening(id='o', wall='w', offset=-1, width=1, height=2)",
            "must not be negative",
        ),
        (
            "scene.wall(id='w', start=(0, 0), end=(4, 0), height=3)\n"
            "scene.opening(id='o', wall='w', kind='hatch', offset=1, width=1, height=2)",
            "kind must be one of door, window, arch",
        ),
        (
            "scene.wall(id='w', start=(0, 0), end=(4, 0), height=3)\n"
            "scene.opening(id='o1', wall='w', offset=1, width=1, height=2)\n"
            "scene.opening(id='o2', wall='w', offset=1.5, width=1, height=2)",
            "'o2' overlaps 'o1'",
        ),
        (
            "scene.repeat(primitive='sphere', ids=['a'], positions=[(0, 0, 0)], size=(1, 1, 1), semantic_type='prop')",
            "primitive must be one of box, cylinder, wedge",
        ),
        (
            "scene.repeat(primitive='box', ids=['a', 'c'], positions=[(0, 0, 0)], size=(1, 1, 1), semantic_type='prop')",
            "same length",
        ),
        (
            "scene.repeat(primitive='box', ids=[], positions=[], size=(1, 1, 1), semantic_type='prop')",
            "same length",
        ),
        (
            "scene.repeat(primitive='cylinder', ids=['a'], positions=[(0, 0, 0)], size=(1, 1, 1), semantic_type='prop')",
            "takes radius and height",
        ),
        (
            "scene.repeat(primitive='box', ids=['a'], positions=[(0, 0, 0)], radius=1, semantic_type='prop')",
            "takes size",
        ),
        ("scene.cylinder(id='c', position=(0, 0, 0), radius=51, height=1, semantic_type='prop')", "'radius' must be at most 50"),
        ("scene.camera(id='cam2', position=(0, 1, -4), target=(0, 1, 0))", "exactly one camera"),
        ("scene.box(id='b', position=(0, 0, 0), size=(1, 1, 1), semantic_type='prop'", "syntax error"),
    ],
)
def test_rejects(body: str, fragment: str):
    with pytest.raises(BlockoutProgramError) as caught:
        _parse(body + "\n")

    assert fragment in str(caught.value)


def test_rejects_a_program_without_a_camera():
    with pytest.raises(BlockoutProgramError, match="required exactly once"):
        parse_blockout_program(FLOOR)


def test_rejects_a_camera_with_a_bad_fov_or_no_direction():
    with pytest.raises(BlockoutProgramError, match="between 0 and 180"):
        parse_blockout_program(
            FLOOR + 'scene.camera(id="c", position=(0, 1, -5), target=(0, 1, 0), fov=180)\n'
        )
    with pytest.raises(BlockoutProgramError, match="must differ"):
        parse_blockout_program(
            FLOOR + 'scene.camera(id="c", position=(0, 1, -5), target=(0, 1, -5))\n'
        )


def test_rejects_a_program_without_geometry():
    with pytest.raises(BlockoutProgramError, match="no geometry"):
        parse_blockout_program(CAMERA)


def test_error_carries_the_line_number():
    with pytest.raises(BlockoutProgramError) as caught:
        parse_blockout_program(FLOOR + CAMERA + "\n\nimport os\n")

    assert caught.value.line == 5
    assert str(caught.value).startswith("line 5: ")


def test_rejects_a_program_that_is_too_long():
    with pytest.raises(BlockoutProgramError, match="program is too long"):
        parse_blockout_program(FLOOR + CAMERA + "#" * MAX_PROGRAM_CHARS)


def test_rejects_a_program_with_too_many_syntax_nodes():
    positions = ",".join("(0,0,0)" for _ in range(1200))
    program = (
        FLOOR
        + CAMERA
        + f"scene.repeat(primitive='box', ids=['a'], positions=[{positions}], "
        "size=(1, 1, 1), semantic_type='prop')\n"
    )
    assert len(program) <= MAX_PROGRAM_CHARS

    with pytest.raises(BlockoutProgramError, match="program is too complex"):
        parse_blockout_program(program)


def test_rejects_an_integer_too_large_to_parse():
    with pytest.raises(BlockoutProgramError):
        _parse(BOX.replace("(1, 1, 1)", "(" + "9" * 5000 + ", 1, 1)") + "\n")


def test_a_hostile_program_has_no_side_effect(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    marker = tmp_path / "pwned"

    with pytest.raises(BlockoutProgramError):
        parse_blockout_program(
            FLOOR
            + CAMERA
            + f'__import__("pathlib").Path({str(marker)!r}).write_text("x")\n'
        )

    assert not marker.exists()
    assert list(tmp_path.iterdir()) == []


def test_the_blockout_package_never_runs_code():
    banned_calls = {"exec", "eval", "compile", "__import__"}
    banned_modules = {"subprocess", "importlib", "runpy", "code", "codeop", "pickle"}
    package = Path(dsl_parser.__file__).parent
    sources = sorted(package.glob("*.py"))
    # 防的是 glob 扫空后整条用例空转着通过。解析器落地时包里就是这三个文件，
    # 之后每加一个模块都会被这里一并扫到。
    assert len(sources) >= 3

    for source in sources:
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                assert node.func.id not in banned_calls, f"{source.name}: {node.func.id}"
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] not in banned_modules, source.name
            if isinstance(node, ast.ImportFrom):
                assert (node.module or "").split(".")[0] not in banned_modules, source.name


def test_label_is_kept_as_the_name_of_the_piece():
    scene = _parse(
        'scene.box(id="kang", position=(0, 0, 1), size=(2, 0.5, 1), semantic_type="platform", label="炕")\n'
        'scene.cylinder(id="stand", position=(1, 0, 1), radius=0.2, height=0.9, semantic_type="prop", label="花几")\n'
        'scene.wedge(id="slope", position=(2, 0, 1), size=(1, 0.3, 1), label="坡道")\n'
        'scene.stairs(id="steps", position=(3, 0, 1), size=(1, 0.3, 1), label="台阶")\n'
        'scene.repeat(primitive="box", ids=["a", "b"], positions=[(-1, 0, 0), (-2, 0, 0)], '
        'size=(0.5, 0.9, 0.5), semantic_type="chair", label="圈椅")\n'
        'scene.wall(id="screen", start=(-3, 2), end=(-1, 2), height=2, label="屏风")\n'
    )

    assert [solid.name_hint for solid in scene.solids] == [
        "炕",
        "花几",
        "坡道",
        "台阶",
        "圈椅",
        "圈椅",
    ]
    assert scene.walls[0].name_hint == "屏风"


def test_floor_label_is_kept():
    scene = parse_blockout_program(
        'scene.floor(id="yard", center=(0, 0), size=(8, 6), label="院子")\n' + CAMERA
    )

    assert scene.floors[0].name_hint == "院子"


def test_piece_without_a_label_has_no_name_hint():
    scene = _parse(
        'scene.box(id="b", position=(0, 0, 1), size=(1, 1, 1), semantic_type="prop")\n'
    )

    assert scene.solids[0].name_hint == ""


def test_label_is_flattened_and_capped():
    scene = _parse(
        'scene.box(id="b", position=(0, 0, 1), size=(1, 1, 1), semantic_type="prop", '
        'label="  紫檀\\n条案\\x00  ' + "长" * 40 + '")\n'
    )

    assert scene.solids[0].name_hint == ("紫檀 条案 " + "长" * 40)[:24]


def test_label_must_be_a_string():
    with pytest.raises(BlockoutProgramError) as caught:
        _parse(
            'scene.box(id="b", position=(0, 0, 1), size=(1, 1, 1), semantic_type="prop", label=3)\n'
        )

    assert "'label' must be a string" in caught.value.message


ANCHOR_ROOM = 'scene.room(id="room", width=7, depth=5.8, height=3)\n'


def _anchored(body: str, camera: str = CAMERA):
    scene = parse_blockout_program(ANCHOR_ROOM + camera + body)
    return {solid.id: solid for solid in scene.solids}


@pytest.mark.parametrize(
    ("placement", "position", "rotation_y"),
    [
        # Left wall runs from near to far: the long side of the piece follows it.
        ('against="room_left", offset=0.5', (-2.225, 0.0, -0.05), 90.0),
        ('against="room_right", offset=0.5', (2.225, 0.0, -0.05), 90.0),
        # Back wall runs from left to right.
        ('against="room_back", offset=0.5', (-0.65, 0.0, 1.625), 0.0),
        ('against="room_back", offset=0.5, bottom=1.2, gap=0.1', (-0.65, 1.2, 1.525), 0.0),
    ],
)
def test_box_against_a_wall_gets_its_position_and_rotation_from_the_wall(
    placement, position, rotation_y
):
    solids = _anchored(
        f'scene.box(id="kang", {placement}, size=(4.7, 0.38, 2.35), semantic_type="bed")\n'
    )

    assert solids["kang"].position == pytest.approx(position)
    assert solids["kang"].rotation_y == pytest.approx(rotation_y)
    assert solids["kang"].size == (4.7, 0.38, 2.35)


def test_cylinder_against_a_wall_touches_it():
    solids = _anchored(
        'scene.cylinder(id="vase", against="room_back", offset=6.0, radius=0.25, height=1.2, semantic_type="prop")\n'
    )

    assert solids["vase"].position == pytest.approx((2.75, 0.0, 2.55))
    assert solids["vase"].rotation_y == 0.0


@pytest.mark.parametrize(
    ("wall", "position", "rotation_y"),
    [
        ("start=(-2, 3), end=(2, 3)", (-1.0, 0.0, 2.65), 0.0),
        # Offset is measured from the start of the wall, whichever way it runs.
        ("start=(2, 3), end=(-2, 3)", (1.0, 0.0, 2.65), 180.0),
        ("start=(0, 4), end=(4, 0)", (0.45962, 0.0, 3.04541), -45.0),
    ],
)
def test_piece_against_a_free_wall_stands_on_the_side_of_the_camera(
    wall, position, rotation_y
):
    scene = _parse(
        f'scene.wall(id="w", {wall}, height=3)\n'
        'scene.box(id="b", against="w", offset=0.5, size=(1, 1, 0.5), semantic_type="cabinet")\n'
    )

    assert scene.solids[0].position == pytest.approx(position, abs=1e-4)
    assert scene.solids[0].rotation_y == pytest.approx(rotation_y)


def test_piece_may_be_written_before_the_wall_it_stands_against():
    scene = parse_blockout_program(
        'scene.box(id="b", against="room_back", offset=0.5, size=(1, 1, 0.5), semantic_type="cabinet")\n'
        + ANCHOR_ROOM
        + CAMERA
    )

    assert scene.solids[0].position == pytest.approx((-2.5, 0.0, 2.55))


def test_piece_on_another_rests_on_its_top_and_follows_its_rotation():
    solids = _anchored(
        'scene.box(id="desk", against="room_left", offset=1.0, size=(2.0, 0.8, 0.6), semantic_type="desk")\n'
        'scene.box(id="book", on="desk", size=(0.3, 0.05, 0.2), semantic_type="prop")\n'
        'scene.cylinder(id="vase", on="desk", shift=(0.1, 0.8), radius=0.1, height=0.3, semantic_type="prop")\n'
        'scene.box(id="tray", on="desk", rotation_y=20, size=(0.3, 0.02, 0.2), semantic_type="prop")\n'
    )

    desk = solids["desk"]
    assert desk.position == pytest.approx((-3.1, 0.0, -0.9))
    assert solids["book"].position == pytest.approx((-3.1, 0.8, -0.9))
    assert solids["book"].rotation_y == pytest.approx(90.0)
    # shift is written in scene axes: x to the right, z away from the camera.
    assert solids["vase"].position == pytest.approx((-3.0, 0.8, -0.1))
    assert solids["tray"].rotation_y == 20.0


def test_pieces_stack():
    solids = _anchored(
        'scene.box(id="table", position=(0, 0, 0), size=(1.2, 0.75, 0.7), semantic_type="table")\n'
        'scene.box(id="tray", on="table", size=(0.4, 0.02, 0.3), semantic_type="prop")\n'
        'scene.cylinder(id="cup", on="tray", radius=0.04, height=0.1, semantic_type="prop")\n'
    )

    assert solids["cup"].position == pytest.approx((0.0, 0.77, 0.0))


def test_piece_may_rest_on_one_item_of_a_repeat():
    solids = _anchored(
        'scene.repeat(primitive="box", ids=["t1", "t2"], positions=[(-1, 0, 0), (1, 0, 0)], size=(1, 0.75, 1), semantic_type="table")\n'
        'scene.cylinder(id="cup", on="t2", radius=0.04, height=0.1, semantic_type="prop")\n'
    )

    assert solids["cup"].position == pytest.approx((1.0, 0.75, 0.0))


def test_anchored_pieces_keep_their_place_in_the_program():
    solids = _anchored(
        'scene.box(id="a", position=(0, 0, 0), size=(1, 1, 1), semantic_type="table")\n'
        'scene.box(id="b", against="room_back", offset=0.5, size=(1, 1, 0.5), semantic_type="cabinet")\n'
        'scene.cylinder(id="c", on="a", radius=0.1, height=0.2, semantic_type="prop")\n'
        'scene.box(id="d", position=(2, 0, 0), size=(1, 1, 1), semantic_type="table")\n'
    )

    assert list(solids) == ["a", "b", "c", "d"]


ON_TABLE = 'scene.box(id="t", position=(0, 0, 0), size=(1.2, 0.75, 0.7), semantic_type="table")\n'


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        (
            'scene.box(id="b", size=(1, 1, 1), semantic_type="prop")',
            "scene.box: say where 'b' goes with exactly one of position, against, on",
        ),
        (
            'scene.cylinder(id="c", radius=0.2, height=1, semantic_type="prop")',
            "scene.cylinder: say where 'c' goes with exactly one of position, against, on",
        ),
        (
            'scene.box(id="b", position=(0, 0, 0), against="room_back", offset=0, size=(1, 1, 1), semantic_type="prop")',
            "exactly one of position, against, on",
        ),
        (
            ON_TABLE
            + 'scene.box(id="b", on="t", against="room_back", offset=0, size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "exactly one of position, against, on",
        ),
        (
            'scene.box(id="b", against="room_back", offset=0, rotation_y=90, size=(1, 1, 1), semantic_type="prop")',
            "'rotation_y' cannot be combined with 'against': the wall sets the rotation",
        ),
        (
            'scene.box(id="b", against="room_back", size=(1, 1, 1), semantic_type="prop")',
            "'against' needs 'offset'",
        ),
        (
            'scene.box(id="b", position=(0, 0, 0), offset=1, size=(1, 1, 1), semantic_type="prop")',
            "'offset' is only used together with 'against'",
        ),
        (
            'scene.box(id="b", position=(0, 0, 0), bottom=1, size=(1, 1, 1), semantic_type="prop")',
            "'bottom' is only used together with 'against'",
        ),
        (
            'scene.cylinder(id="c", position=(0, 0, 0), gap=1, radius=0.2, height=1, semantic_type="prop")',
            "'gap' is only used together with 'against'",
        ),
        (
            'scene.box(id="b", position=(0, 0, 0), shift=(0, 0), size=(1, 1, 1), semantic_type="prop")',
            "'shift' is only used together with 'on'",
        ),
        (
            'scene.box(id="b", against="nope", offset=0, size=(1, 1, 1), semantic_type="prop")',
            "scene.box: wall 'nope' does not exist; known walls: room_back, room_left, room_right",
        ),
        (
            'scene.box(id="b", against=3, offset=0, size=(1, 1, 1), semantic_type="prop")',
            "'against' must be a string",
        ),
        (
            'scene.box(id="b", against="room_left", offset=5, size=(1, 1, 1), semantic_type="prop")',
            "scene.box: 'b' runs past the end of wall 'room_left': offset 5 + width 1 > wall length 5.8",
        ),
        (
            'scene.cylinder(id="c", against="room_left", offset=5.5, radius=0.2, height=1, semantic_type="prop")',
            "scene.cylinder: 'c' runs past the end of wall 'room_left': offset 5.5 + width 0.4 > wall length 5.8",
        ),
        (
            'scene.box(id="b", against="room_left", offset=-1, size=(1, 1, 1), semantic_type="prop")',
            "'offset', 'bottom' and 'gap' must not be negative",
        ),
        (
            'scene.box(id="b", against="room_left", offset=0, bottom=-1, size=(1, 1, 1), semantic_type="prop")',
            "'offset', 'bottom' and 'gap' must not be negative",
        ),
        (
            'scene.box(id="b", against="room_left", offset=0, gap=-1, size=(1, 1, 1), semantic_type="prop")',
            "'offset', 'bottom' and 'gap' must not be negative",
        ),
        (
            'scene.box(id="b", against="room_left", offset=0, bottom=200, size=(1, 1, 1), semantic_type="prop")',
            "'bottom' is out of bounds",
        ),
        (
            'scene.box(id="b", on="nope", size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "scene.box: 'b' cannot rest on 'nope': no box or cylinder with that id is written above this line",
        ),
        (
            'scene.box(id="b", on="t", size=(0.2, 0.2, 0.2), semantic_type="prop")\n'
            + ON_TABLE,
            "no box or cylinder with that id is written above this line",
        ),
        (
            'scene.box(id="b", on="b", size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "no box or cylinder with that id is written above this line",
        ),
        (
            'scene.stairs(id="s", position=(0, 0, 0), size=(1, 1, 2))\n'
            'scene.box(id="b", on="s", size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "scene.box: 'b' cannot rest on 's': a ramp or stairs has no flat top",
        ),
        (
            ON_TABLE
            + 'scene.box(id="b", on="t", shift=(0.7, 0), size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "scene.box: 'b' would not rest on 't': shift (0.7, 0) puts its centre outside the top of 't', which is 1.2 wide and 0.7 deep",
        ),
        (
            'scene.cylinder(id="t", position=(0, 0, 0), radius=0.5, height=0.7, semantic_type="table")\n'
            'scene.box(id="b", on="t", shift=(0.4, 0.4), size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "puts its centre outside the top of 't', which is 1 across",
        ),
        (
            ON_TABLE
            + 'scene.box(id="b", on="t", shift=(0, 0, 0), size=(0.2, 0.2, 0.2), semantic_type="prop")',
            "'shift' must be a tuple of 2 numbers",
        ),
    ],
)
def test_rejects_bad_placement(body: str, fragment: str):
    with pytest.raises(BlockoutProgramError) as caught:
        parse_blockout_program(ANCHOR_ROOM + CAMERA + body + "\n")

    assert fragment in str(caught.value)


def test_placement_errors_carry_the_line_of_the_piece():
    with pytest.raises(BlockoutProgramError) as caught:
        parse_blockout_program(
            ANCHOR_ROOM
            + 'scene.box(id="b", against="room_left", offset=5, size=(1, 1, 1), semantic_type="prop")\n'
            + CAMERA
        )

    assert caught.value.line == 2


def test_free_wall_that_passes_through_the_camera_has_no_camera_side():
    with pytest.raises(BlockoutProgramError) as caught:
        _parse(
            'scene.wall(id="w", start=(0, -4), end=(0, 4), height=3)\n'
            'scene.box(id="b", against="w", offset=0.5, size=(1, 1, 0.5), semantic_type="cabinet")\n'
        )

    assert "cannot tell which side of wall 'w' faces the camera" in str(caught.value)


def test_room_is_recorded_so_that_checks_can_use_it():
    scene = parse_blockout_program(
        'scene.room(id="r", width=4, depth=6, height=3, center=(1, 2))\n' + CAMERA
    )

    assert [room.model_dump() for room in scene.rooms] == [
        {"id": "r", "center": (1.0, 2.0), "size": (4.0, 6.0), "height": 3.0}
    ]
    assert _parse(BOX + "\n").rooms == ()


def test_seen_records_where_a_piece_or_a_wall_lies_in_the_picture():
    scene = parse_blockout_program(
        "scene.room(id='room', width=8, depth=6, height=3)\n"
        + CAMERA
        + "scene.box(id='table', position=(0, 0, 0), size=(1.2, 0.75, 0.7), semantic_type='table')\n"
        "scene.seen(id='table', left=0.3, right=0.6, bottom=0.8)\n"
        "scene.seen(id='room_back', left=0.1, right=0.9)\n"
    )

    assert [(s.id, s.left, s.right, s.bottom) for s in scene.sightings] == [
        ("table", 0.3, 0.6, 0.8),
        ("room_back", 0.1, 0.9, None),
    ]


def test_seen_may_be_written_before_the_piece_it_describes():
    scene = _parse(
        "scene.seen(id='b', left=0.2, right=0.4)\n"
        "scene.box(id='b', position=(0, 0, 0), size=(1, 1, 1), semantic_type='prop')\n"
    )

    assert scene.sightings[0].id == "b"


@pytest.mark.parametrize(
    "body, fragment",
    [
        ("scene.seen(id='ghost', left=0.2, right=0.4)", "'ghost' is not a piece or a wall"),
        ("scene.seen(id='ground', left=0.2, right=0.4)", "'ground' is not a piece or a wall"),
        ("scene.seen(id='b', left=0.5, right=0.4)", "'left' must be smaller than 'right'"),
        ("scene.seen(id='b', left=-0.1, right=0.4)", "between 0 and 1"),
        ("scene.seen(id='b', left=0.1, right=0.4, bottom=1.2)", "between 0 and 1"),
        (
            "scene.seen(id='b', left=0.1, right=0.4)\nscene.seen(id='b', left=0.1, right=0.4)",
            "'b' is described twice",
        ),
    ],
)
def test_rejects_bad_sightings(body: str, fragment: str):
    with pytest.raises(BlockoutProgramError) as caught:
        _parse(
            "scene.box(id='b', position=(0, 0, 0), size=(1, 1, 1), semantic_type='prop')\n"
            + body
            + "\n"
        )

    assert fragment in str(caught.value)
