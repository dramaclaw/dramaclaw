"""SceneBlockoutDSL parser: program text → SceneIR.

The surface syntax is Python, but the program is only ever read with `ast.parse`
and checked against a whitelist. Nothing in this module evaluates, compiles or
runs the program.

A box or cylinder says where it goes in one of three ways: `position` (plain
coordinates), `against` (a wall) or `on` (another piece). The last two are
relations; they are turned into coordinates here, so SceneIR and everything
after it only ever see positions.
"""

from __future__ import annotations

import ast
import math
import re
from dataclasses import dataclass
from typing import Any

from novelvideo.director_world.blockout.scene_ir import (
    MAX_AST_NODES,
    MAX_COORDINATE_ABS,
    MAX_EDGE_METERS,
    MAX_LABEL_CHARS,
    MAX_PROGRAM_CHARS,
    MIN_PIECE_METERS,
    BlockoutProgramError,
    CameraIR,
    FloorIR,
    OpeningIR,
    RoomIR,
    SceneIR,
    SightingIR,
    SolidIR,
    Vec2,
    Vec3,
    WallIR,
)

DEFAULT_WALL_THICKNESS = 0.2
DEFAULT_WINDOW_SILL = 0.9
DEFAULT_CAMERA_FOV = 60.0
MAX_ROTATION_ABS = 360.0

_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_SEMANTIC_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_OPENING_KINDS = ("door", "window", "arch")
_REPEAT_PRIMITIVES = ("box", "cylinder", "wedge")
_MAX_LITERAL_DEPTH = 3
_PLACEMENTS = ("position", "against", "on")
_AGAINST_ONLY = ("offset", "bottom", "gap")
_PLACEMENT_ARGS = frozenset({*_PLACEMENTS, *_AGAINST_ONLY, "shift"})

# instruction → (required keyword names, optional keyword names)
_SPEC: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "room": (
        frozenset({"id", "width", "depth", "height"}),
        frozenset({"center", "wall_thickness"}),
    ),
    "floor": (
        frozenset({"id", "center", "size"}),
        frozenset({"semantic_type", "label"}),
    ),
    "wall": (
        frozenset({"id", "start", "end", "height"}),
        frozenset({"thickness", "semantic_type", "label"}),
    ),
    "opening": (
        frozenset({"id", "wall", "offset", "width", "height"}),
        frozenset({"kind", "sill"}),
    ),
    "box": (
        frozenset({"id", "size", "semantic_type"}),
        frozenset({"rotation_y", "label"}) | _PLACEMENT_ARGS,
    ),
    "cylinder": (
        frozenset({"id", "radius", "height", "semantic_type"}),
        frozenset({"label"}) | _PLACEMENT_ARGS,
    ),
    "wedge": (
        frozenset({"id", "position", "size"}),
        frozenset({"rotation_y", "semantic_type", "label"}),
    ),
    "stairs": (
        frozenset({"id", "position", "size"}),
        frozenset({"rotation_y", "label"}),
    ),
    "repeat": (
        frozenset({"primitive", "ids", "positions", "semantic_type"}),
        frozenset({"size", "radius", "height", "rotation_y", "label"}),
    ),
    "camera": (frozenset({"id", "position", "target"}), frozenset({"fov"})),
    "seen": (frozenset({"id", "left", "right"}), frozenset({"bottom"})),
}

_POSITION_HINT = (
    "use position=(x, y, z): x and z locate the centre of the footprint, "
    "y is the height of the bottom face (0 means standing on the floor)"
)


@dataclass(frozen=True)
class _Call:
    op: str
    line: int
    args: dict[str, Any]


def _fail(message: str, line: int | None) -> BlockoutProgramError:
    return BlockoutProgramError(message, line=line)


def _literal(node: ast.AST, line: int, depth: int = 0) -> Any:
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, (bool, str)):
            return value
        if isinstance(value, (int, float)):
            return _finite(value, line)
        raise _fail(f"unsupported literal {value!r}", line)
    if (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, ast.USub)
        and isinstance(node.operand, ast.Constant)
        and isinstance(node.operand.value, (int, float))
        and not isinstance(node.operand.value, bool)
    ):
        return -_finite(node.operand.value, line)
    if isinstance(node, (ast.Tuple, ast.List)):
        if depth >= _MAX_LITERAL_DEPTH:
            raise _fail("literal is nested too deeply", line)
        return [_literal(item, line, depth + 1) for item in node.elts]
    raise _fail(
        f"only literal values are allowed, got {type(node).__name__}", line
    )


def _finite(value: int | float, line: int) -> float:
    try:
        number = float(value)
    except OverflowError:
        raise _fail("number is not finite", line) from None
    if not math.isfinite(number):
        raise _fail("number is not finite", line)
    return number


def _read_calls(source: str) -> list[_Call]:
    if len(source) > MAX_PROGRAM_CHARS:
        raise _fail(
            f"program is too long: {len(source)} > {MAX_PROGRAM_CHARS} characters",
            None,
        )
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        raise _fail(f"syntax error: {exc.msg}", exc.lineno) from None
    except (ValueError, RecursionError, MemoryError) as exc:
        raise _fail(f"program cannot be parsed: {type(exc).__name__}", None) from None

    node_count = sum(1 for _ in ast.walk(tree))
    if node_count > MAX_AST_NODES:
        raise _fail(
            f"program is too complex: {node_count} > {MAX_AST_NODES} syntax nodes",
            None,
        )

    calls: list[_Call] = []
    for statement in tree.body:
        line = getattr(statement, "lineno", None)
        if not isinstance(statement, ast.Expr) or not isinstance(
            statement.value, ast.Call
        ):
            raise _fail(
                "only scene.<instruction>(...) calls are allowed, "
                f"got {type(statement).__name__}",
                line,
            )
        call = statement.value
        func = call.func
        if not (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "scene"
        ):
            raise _fail("only calls on `scene` are allowed", line)
        op = func.attr
        if op not in _SPEC:
            raise _fail(
                f"unknown instruction scene.{op}; allowed: {', '.join(sorted(_SPEC))}",
                line,
            )
        if call.args:
            raise _fail(
                f"scene.{op}: positional arguments are not allowed, use keywords",
                line,
            )
        required, optional = _SPEC[op]
        args: dict[str, Any] = {}
        for keyword in call.keywords:
            name = keyword.arg
            if name is None:
                raise _fail(f"scene.{op}: ** arguments are not allowed", line)
            if name in args:
                raise _fail(f"scene.{op}: argument '{name}' is repeated", line)
            if name not in required and name not in optional:
                hint = (
                    f"; {_POSITION_HINT}"
                    if name == "center" and "position" in required | optional
                    else ""
                )
                raise _fail(
                    f"scene.{op}: unknown argument '{name}'; allowed: "
                    f"{', '.join(sorted(required | optional))}{hint}",
                    line,
                )
            args[name] = _literal(keyword.value, line)
        missing = sorted(required - args.keys())
        if missing:
            raise _fail(
                f"scene.{op}: missing argument(s): {', '.join(missing)}", line
            )
        calls.append(_Call(op=op, line=line or 0, args=args))
    return calls


def _number(call: _Call, name: str, default: float | None = None) -> float:
    if name not in call.args:
        if default is None:
            raise _fail(f"scene.{call.op}: missing argument(s): {name}", call.line)
        return default
    value = call.args[name]
    if isinstance(value, bool) or not isinstance(value, float):
        raise _fail(f"scene.{call.op}: '{name}' must be a number", call.line)
    return value


def _length(call: _Call, name: str, default: float | None = None) -> float:
    value = _number(call, name, default)
    if not 0 < value <= MAX_EDGE_METERS:
        raise _fail(
            f"scene.{call.op}: '{name}' must be greater than 0 and at most "
            f"{MAX_EDGE_METERS:g} metres, got {value:g}",
            call.line,
        )
    return value


def _vector(
    call: _Call,
    name: str,
    length: int,
    *,
    value: Any = None,
    size: bool = False,
    default: tuple[float, ...] | None = None,
) -> tuple[float, ...]:
    if value is None:
        if name not in call.args:
            if default is None:
                raise _fail(
                    f"scene.{call.op}: missing argument(s): {name}", call.line
                )
            return default
        value = call.args[name]
    if (
        not isinstance(value, list)
        or len(value) != length
        or any(isinstance(item, bool) or not isinstance(item, float) for item in value)
    ):
        raise _fail(
            f"scene.{call.op}: '{name}' must be a tuple of {length} numbers",
            call.line,
        )
    for item in value:
        if size and not 0 < item <= MAX_EDGE_METERS:
            raise _fail(
                f"scene.{call.op}: every value in '{name}' must be greater than 0 "
                f"and at most {MAX_EDGE_METERS:g} metres, got {item:g}",
                call.line,
            )
        if not size and abs(item) > MAX_COORDINATE_ABS:
            raise _fail(
                f"scene.{call.op}: '{name}' is out of bounds: |{item:g}| > "
                f"{MAX_COORDINATE_ABS:g} metres",
                call.line,
            )
    return tuple(value)


def _text(call: _Call, name: str, default: str | None = None) -> str:
    if name not in call.args:
        if default is None:
            raise _fail(f"scene.{call.op}: missing argument(s): {name}", call.line)
        return default
    value = call.args[name]
    if not isinstance(value, str):
        raise _fail(f"scene.{call.op}: '{name}' must be a string", call.line)
    return value


def _semantic(call: _Call, default: str | None = None) -> str:
    value = _text(call, "semantic_type", default)
    if not _SEMANTIC_RE.match(value):
        raise _fail(
            f"scene.{call.op}: semantic_type must be lower_snake_case "
            f"(at most 32 characters), got {value!r}",
            call.line,
        )
    return value


def _label(call: _Call) -> str:
    """The display name the model gave the piece; cosmetic, so cleaned, not rejected."""
    value = _text(call, "label", "")
    printable = "".join(char if char.isprintable() else " " for char in value)
    return " ".join(printable.split())[:MAX_LABEL_CHARS].strip()


def _fraction(call: _Call, name: str, default: float | None = None) -> float:
    value = _number(call, name, default)
    if not 0.0 <= value <= 1.0:
        raise _fail(
            f"scene.{call.op}: '{name}' is a share of the picture and must be "
            f"between 0 and 1, got {value:g}",
            call.line,
        )
    return value


def _sighting(call: _Call) -> SightingIR:
    subject = call.args["id"]
    if not isinstance(subject, str) or not _ID_RE.match(subject):
        raise _fail("scene.seen: 'id' must name a piece or a wall", call.line)
    left, right = _fraction(call, "left"), _fraction(call, "right")
    if left >= right:
        raise _fail(
            f"scene.seen: 'left' must be smaller than 'right', got {left:g} and "
            f"{right:g}",
            call.line,
        )
    bottom = _fraction(call, "bottom") if "bottom" in call.args else None
    return SightingIR(id=subject, left=left, right=right, bottom=bottom)


def _rotation(call: _Call) -> float:
    value = _number(call, "rotation_y", 0.0)
    if abs(value) > MAX_ROTATION_ABS:
        raise _fail(
            f"scene.{call.op}: 'rotation_y' must be within ±{MAX_ROTATION_ABS:g} "
            f"degrees, got {value:g}",
            call.line,
        )
    return value


class _Ids:
    def __init__(self) -> None:
        self._seen: set[str] = set()

    def claim(self, value: Any, call: _Call, *, derived: bool = False) -> str:
        if not isinstance(value, str) or (not derived and not _ID_RE.match(value)):
            raise _fail(
                f"scene.{call.op}: id must start with a letter and contain only "
                f"letters, digits and underscores (at most 64 characters), "
                f"got {value!r}",
                call.line,
            )
        if value in self._seen:
            raise _fail(f"scene.{call.op}: duplicate id '{value}'", call.line)
        self._seen.add(value)
        return value


def _wall(
    call: _Call,
    wall_id: str,
    start: tuple[float, ...],
    end: tuple[float, ...],
    height: float,
    thickness: float,
    semantic_type: str,
    name_hint: str = "",
) -> WallIR:
    for point in (start, end):
        for item in point:
            if abs(item) > MAX_COORDINATE_ABS:
                raise _fail(
                    f"scene.{call.op}: wall '{wall_id}' is out of bounds: "
                    f"|{item:g}| > {MAX_COORDINATE_ABS:g} metres",
                    call.line,
                )
    length = math.hypot(end[0] - start[0], end[1] - start[1])
    if length < MIN_PIECE_METERS:
        raise _fail(
            f"scene.{call.op}: wall '{wall_id}' has no length (start equals end)",
            call.line,
        )
    if length > MAX_EDGE_METERS:
        raise _fail(
            f"scene.{call.op}: wall '{wall_id}' is longer than "
            f"{MAX_EDGE_METERS:g} metres",
            call.line,
        )
    return WallIR(
        id=wall_id,
        semantic_type=semantic_type,
        name_hint=name_hint,
        start=(start[0], start[1]),
        end=(end[0], end[1]),
        height=height,
        thickness=thickness,
    )


def _solid(
    call: _Call,
    solid_id: str,
    shape: str,
    position: tuple[float, ...],
    size: tuple[float, ...],
    rotation_y: float,
    semantic_type: str,
) -> SolidIR:
    return SolidIR(
        id=solid_id,
        semantic_type=semantic_type,
        name_hint=_label(call),
        shape=shape,
        position=(position[0], position[1], position[2]),
        size=(size[0], size[1], size[2]),
        rotation_y=rotation_y,
    )


def _cylinder_size(call: _Call) -> tuple[float, float, float]:
    radius = _length(call, "radius")
    height = _length(call, "height")
    if radius * 2 > MAX_EDGE_METERS:
        raise _fail(
            f"scene.{call.op}: 'radius' must be at most {MAX_EDGE_METERS / 2:g} metres",
            call.line,
        )
    return (radius * 2, height, radius * 2)


def _placement(call: _Call, object_id: str) -> str:
    """Which of position, against, on the piece uses. Exactly one is allowed."""
    given = [name for name in _PLACEMENTS if name in call.args]
    if len(given) != 1:
        raise _fail(
            f"scene.{call.op}: say where '{object_id}' goes with exactly one of "
            f"{', '.join(_PLACEMENTS)}; got {', '.join(given) or 'none of them'}",
            call.line,
        )
    kind = given[0]
    for name in _AGAINST_ONLY:
        if name in call.args and kind != "against":
            raise _fail(
                f"scene.{call.op}: '{name}' is only used together with 'against'",
                call.line,
            )
    if "shift" in call.args and kind != "on":
        raise _fail(
            f"scene.{call.op}: 'shift' is only used together with 'on'", call.line
        )
    if kind == "against":
        if "rotation_y" in call.args:
            raise _fail(
                f"scene.{call.op}: 'rotation_y' cannot be combined with 'against': "
                "the wall sets the rotation",
                call.line,
            )
        if "offset" not in call.args:
            raise _fail(
                f"scene.{call.op}: 'against' needs 'offset', the distance from the "
                "start of the wall to the near end of the piece",
                call.line,
            )
    return kind


def _moved(
    call: _Call, solid: SolidIR, position: Vec3, rotation_y: float
) -> SolidIR:
    for item in position:
        if abs(item) > MAX_COORDINATE_ABS:
            raise _fail(
                f"scene.{call.op}: '{solid.id}' ends up out of bounds: "
                f"|{item:g}| > {MAX_COORDINATE_ABS:g} metres",
                call.line,
            )
    return solid.model_copy(update={"position": position, "rotation_y": rotation_y})


def _against_wall(
    call: _Call,
    solid: SolidIR,
    walls: dict[str, WallIR],
    inside: dict[str, Vec2],
    camera: CameraIR,
) -> SolidIR:
    """Stand the piece against the face of the wall that looks into the scene.

    Its width runs along the wall, so it takes the rotation `compiler.py` gives
    the wall itself. `offset` is measured like the offset of an opening.
    """
    wall_id = _text(call, "against")
    wall = walls.get(wall_id)
    if wall is None:
        raise _fail(
            f"scene.{call.op}: wall '{wall_id}' does not exist; known walls: "
            f"{', '.join(sorted(walls)) or '(none)'}",
            call.line,
        )
    offset = _number(call, "offset")
    bottom = _number(call, "bottom", 0.0)
    gap = _number(call, "gap", 0.0)
    if offset < 0 or bottom < 0 or gap < 0:
        raise _fail(
            f"scene.{call.op}: 'offset', 'bottom' and 'gap' must not be negative",
            call.line,
        )
    for name, value in (("bottom", bottom), ("gap", gap)):
        if value > MAX_COORDINATE_ABS:
            raise _fail(
                f"scene.{call.op}: '{name}' is out of bounds: |{value:g}| > "
                f"{MAX_COORDINATE_ABS:g} metres",
                call.line,
            )
    run_x, run_z = wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]
    length = math.hypot(run_x, run_z)
    width, _, depth = solid.size
    if offset + width > length + 1e-9:
        raise _fail(
            f"scene.{call.op}: '{solid.id}' runs past the end of wall "
            f"'{wall_id}': offset {offset:g} + width {width:g} > "
            f"wall length {length:g}",
            call.line,
        )
    unit_x, unit_z = run_x / length, run_z / length
    normal_x, normal_z = -unit_z, unit_x
    # A wall of a room faces the middle of that room; any other wall faces the
    # reference camera, because the picture shows the side the camera sees.
    toward_x, toward_z = inside.get(wall_id, (camera.position[0], camera.position[2]))
    side = (toward_x - wall.start[0]) * normal_x + (toward_z - wall.start[1]) * normal_z
    if abs(side) < MIN_PIECE_METERS:
        raise _fail(
            f"scene.{call.op}: cannot tell which side of wall '{wall_id}' faces "
            f"the camera, because the camera stands in line with it; place "
            f"'{solid.id}' with position=(x, y, z) instead",
            call.line,
        )
    sign = 1.0 if side > 0 else -1.0
    along = offset + width / 2.0
    out = sign * (wall.thickness / 2.0 + gap + depth / 2.0)
    return _moved(
        call,
        solid,
        (
            wall.start[0] + unit_x * along + normal_x * out,
            bottom,
            wall.start[1] + unit_z * along + normal_z * out,
        ),
        0.0 if solid.shape == "cylinder" else math.degrees(math.atan2(run_z, run_x)),
    )


def _on_top(call: _Call, solid: SolidIR, above: dict[str, SolidIR]) -> SolidIR:
    """Rest the piece on the top face of one written earlier in the program."""
    base_id = _text(call, "on")
    base = above.get(base_id)
    if base is None:
        raise _fail(
            f"scene.{call.op}: '{solid.id}' cannot rest on '{base_id}': no box or "
            "cylinder with that id is written above this line",
            call.line,
        )
    if base.shape == "wedge":
        raise _fail(
            f"scene.{call.op}: '{solid.id}' cannot rest on '{base_id}': a ramp or "
            "stairs has no flat top; use position=(x, y, z) instead",
            call.line,
        )
    # shift is written along the base's own width and depth, the way its size
    # is: a piece against a wall is turned with the wall, and the model thinks
    # of "along the counter" in the counter's terms, not the scene's. Turning
    # the shift into scene axes here is what keeps that reading right.
    across, deep = _vector(call, "shift", 2, default=(0.0, 0.0))
    if base.shape == "cylinder":
        outside = math.hypot(across, deep) > base.size[0] / 2.0 + 1e-9
        top = f"{base.size[0]:g} across"
    else:
        outside = (
            abs(across) > base.size[0] / 2.0 + 1e-9
            or abs(deep) > base.size[2] / 2.0 + 1e-9
        )
        top = f"{base.size[0]:g} wide and {base.size[2]:g} deep"
    if outside:
        raise _fail(
            f"scene.{call.op}: '{solid.id}' would not rest on '{base_id}': shift "
            f"({across:g}, {deep:g}) puts its centre outside the top of "
            f"'{base_id}', which is {top}",
            call.line,
        )
    angle = math.radians(base.rotation_y)
    shift_x = across * math.cos(angle) - deep * math.sin(angle)
    shift_z = across * math.sin(angle) + deep * math.cos(angle)
    if solid.shape == "cylinder":
        rotation_y = 0.0
    elif "rotation_y" in call.args:
        rotation_y = _rotation(call)
    else:
        rotation_y = base.rotation_y
    return _moved(
        call,
        solid,
        (
            base.position[0] + shift_x,
            base.position[1] + base.size[1],
            base.position[2] + shift_z,
        ),
        rotation_y,
    )


def _place(
    solids: list[SolidIR],
    relations: dict[int, tuple[str, _Call]],
    walls: list[WallIR],
    inside: dict[str, Vec2],
    camera: CameraIR,
) -> list[SolidIR]:
    """Turn `against` and `on` into positions, in the order of the program."""
    by_id = {wall.id: wall for wall in walls}
    above: dict[str, SolidIR] = {}
    placed: list[SolidIR] = []
    for index, solid in enumerate(solids):
        if index in relations:
            kind, call = relations[index]
            solid = (
                _against_wall(call, solid, by_id, inside, camera)
                if kind == "against"
                else _on_top(call, solid, above)
            )
        above[solid.id] = solid
        placed.append(solid)
    return placed


def _openings_cross(a: OpeningIR, b: OpeningIR) -> bool:
    along = (
        a.offset < b.offset + b.width - 1e-9 and b.offset < a.offset + a.width - 1e-9
    )
    up = a.sill < b.sill + b.height - 1e-9 and b.sill < a.sill + a.height - 1e-9
    return along and up


def _attach_openings(
    walls: list[WallIR], opening_calls: list[_Call], ids: _Ids
) -> list[WallIR]:
    by_wall: dict[str, list[tuple[_Call, OpeningIR]]] = {}
    lengths = {
        wall.id: math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
        for wall in walls
    }
    heights = {wall.id: wall.height for wall in walls}
    for call in opening_calls:
        opening_id = ids.claim(call.args["id"], call)
        wall_id = _text(call, "wall")
        if wall_id not in lengths:
            raise _fail(
                f"scene.opening: wall '{wall_id}' does not exist; known walls: "
                f"{', '.join(sorted(lengths)) or '(none)'}",
                call.line,
            )
        kind = _text(call, "kind", "door")
        if kind not in _OPENING_KINDS:
            raise _fail(
                f"scene.opening: kind must be one of {', '.join(_OPENING_KINDS)}, "
                f"got {kind!r}",
                call.line,
            )
        offset = _number(call, "offset")
        width = _length(call, "width")
        height = _length(call, "height")
        sill = _number(call, "sill", DEFAULT_WINDOW_SILL if kind == "window" else 0.0)
        if offset < 0 or sill < 0:
            raise _fail(
                "scene.opening: 'offset' and 'sill' must not be negative", call.line
            )
        if offset + width > lengths[wall_id] + 1e-9:
            raise _fail(
                f"scene.opening: '{opening_id}' runs past the end of wall "
                f"'{wall_id}': offset {offset:g} + width {width:g} > "
                f"wall length {lengths[wall_id]:g}",
                call.line,
            )
        if sill + height > heights[wall_id] + 1e-9:
            raise _fail(
                f"scene.opening: '{opening_id}' is taller than wall '{wall_id}': "
                f"sill {sill:g} + height {height:g} > wall height "
                f"{heights[wall_id]:g}",
                call.line,
            )
        by_wall.setdefault(wall_id, []).append(
            (
                call,
                OpeningIR(
                    id=opening_id,
                    kind=kind,
                    offset=offset,
                    width=width,
                    height=height,
                    sill=sill,
                ),
            )
        )

    result: list[WallIR] = []
    for wall in walls:
        entries = by_wall.get(wall.id, [])
        # 洞口是墙面上的矩形：沿墙和竖直两个方向都有交集才算重叠，
        # 门正上方的高窗不算（编译器会把门窗之间的墙切成一块腰墙）。
        for index, (call, current) in enumerate(entries):
            for _, previous in entries[:index]:
                if _openings_cross(current, previous):
                    raise _fail(
                        f"scene.opening: '{current.id}' overlaps '{previous.id}' on "
                        f"wall '{wall.id}'",
                        call.line,
                    )
        entries = sorted(entries, key=lambda entry: entry[1].offset)
        result.append(
            wall.model_copy(
                update={"openings": tuple(opening for _, opening in entries)}
            )
        )
    return result


def parse_blockout_program(source: str) -> SceneIR:
    """Parse and validate a SceneBlockoutDSL program. Never executes it."""
    calls = _read_calls(source)
    ids = _Ids()
    floors: list[FloorIR] = []
    walls: list[WallIR] = []
    solids: list[SolidIR] = []
    rooms: list[RoomIR] = []
    opening_calls: list[_Call] = []
    # index into `solids` → how the piece is placed, for `against` and `on`
    relations: dict[int, tuple[str, _Call]] = {}
    # wall id → a point on the side of the wall that pieces stand on
    inside: dict[str, Vec2] = {}
    camera: CameraIR | None = None
    sightings: list[tuple[SightingIR, _Call]] = []

    for call in calls:
        if call.op == "opening":
            opening_calls.append(call)
            continue
        if call.op == "seen":
            sightings.append((_sighting(call), call))
            continue
        if call.op == "repeat":
            primitive = _text(call, "primitive")
            if primitive not in _REPEAT_PRIMITIVES:
                raise _fail(
                    f"scene.repeat: primitive must be one of "
                    f"{', '.join(_REPEAT_PRIMITIVES)}, got {primitive!r}",
                    call.line,
                )
            if primitive == "cylinder":
                if "size" in call.args:
                    raise _fail(
                        "scene.repeat: a cylinder takes radius and height, not size",
                        call.line,
                    )
                size: tuple[float, ...] = _cylinder_size(call)
            else:
                if "radius" in call.args or "height" in call.args:
                    raise _fail(
                        f"scene.repeat: a {primitive} takes size, "
                        "not radius or height",
                        call.line,
                    )
                size = _vector(call, "size", 3, size=True)
            repeat_ids = call.args["ids"]
            positions = call.args["positions"]
            if (
                not isinstance(repeat_ids, list)
                or not isinstance(positions, list)
                or not repeat_ids
                or len(repeat_ids) != len(positions)
            ):
                raise _fail(
                    "scene.repeat: 'ids' and 'positions' must be non-empty lists "
                    "of the same length",
                    call.line,
                )
            semantic_type = _semantic(call)
            rotation_y = _rotation(call)
            for repeat_id, position in zip(repeat_ids, positions):
                solids.append(
                    _solid(
                        call,
                        ids.claim(repeat_id, call),
                        primitive,
                        _vector(call, "positions", 3, value=position),
                        size,
                        rotation_y,
                        semantic_type,
                    )
                )
            continue

        object_id = ids.claim(call.args["id"], call)
        if call.op == "room":
            width = _length(call, "width")
            depth = _length(call, "depth")
            height = _length(call, "height")
            thickness = _length(call, "wall_thickness", DEFAULT_WALL_THICKNESS)
            cx, cz = _vector(call, "center", 2, default=(0.0, 0.0))
            half_w, half_d = width / 2, depth / 2
            rooms.append(
                RoomIR(
                    id=object_id, center=(cx, cz), size=(width, depth), height=height
                )
            )
            floors.append(
                FloorIR(
                    id=ids.claim(f"{object_id}_floor", call, derived=True),
                    semantic_type="floor",
                    name_hint="地面",
                    center=(cx, cz),
                    size=(width, depth),
                )
            )
            # The side facing the reference camera (z = cz - half_d) stays open.
            for suffix, hint, start, end in (
                ("back", "后墙", (cx - half_w, cz + half_d), (cx + half_w, cz + half_d)),
                ("left", "左墙", (cx - half_w, cz - half_d), (cx - half_w, cz + half_d)),
                ("right", "右墙", (cx + half_w, cz - half_d), (cx + half_w, cz + half_d)),
            ):
                wall_id = ids.claim(f"{object_id}_{suffix}", call, derived=True)
                inside[wall_id] = (cx, cz)
                walls.append(
                    _wall(call, wall_id, start, end, height, thickness, "wall", hint)
                )
        elif call.op == "floor":
            floors.append(
                FloorIR(
                    id=object_id,
                    semantic_type=_semantic(call, "floor"),
                    name_hint=_label(call),
                    center=_vector(call, "center", 2),
                    size=_vector(call, "size", 2, size=True),
                )
            )
        elif call.op == "wall":
            walls.append(
                _wall(
                    call,
                    object_id,
                    _vector(call, "start", 2),
                    _vector(call, "end", 2),
                    _length(call, "height"),
                    _length(call, "thickness", DEFAULT_WALL_THICKNESS),
                    _semantic(call, "wall"),
                    _label(call),
                )
            )
        elif call.op in {"box", "cylinder"}:
            kind = _placement(call, object_id)
            if kind != "position":
                relations[len(solids)] = (kind, call)
            solids.append(
                _solid(
                    call,
                    object_id,
                    call.op,
                    _vector(call, "position", 3, default=(0.0, 0.0, 0.0)),
                    _vector(call, "size", 3, size=True)
                    if call.op == "box"
                    else _cylinder_size(call),
                    _rotation(call) if call.op == "box" else 0.0,
                    _semantic(call),
                )
            )
        elif call.op in {"wedge", "stairs"}:
            solids.append(
                _solid(
                    call,
                    object_id,
                    "wedge",
                    _vector(call, "position", 3),
                    _vector(call, "size", 3, size=True),
                    _rotation(call),
                    "stairs" if call.op == "stairs" else _semantic(call, "ramp"),
                )
            )
        elif call.op == "camera":
            if camera is not None:
                raise _fail(
                    "scene.camera: exactly one camera is allowed", call.line
                )
            position = _vector(call, "position", 3)
            target = _vector(call, "target", 3)
            if math.dist(position, target) < MIN_PIECE_METERS:
                raise _fail(
                    "scene.camera: 'position' and 'target' must differ", call.line
                )
            fov = _number(call, "fov", DEFAULT_CAMERA_FOV)
            if not 0 < fov < 180:
                raise _fail(
                    f"scene.camera: 'fov' must be between 0 and 180 degrees, "
                    f"got {fov:g}",
                    call.line,
                )
            camera = CameraIR(
                id=object_id,
                position=(position[0], position[1], position[2]),
                target=(target[0], target[1], target[2]),
                fov=fov,
            )

    walls = _attach_openings(walls, opening_calls, ids)
    if camera is None:
        raise _fail("scene.camera(...) is required exactly once", None)
    if not floors and not walls and not solids:
        raise _fail("the scene has no geometry", None)
    projectable = {piece.id for piece in (*solids, *walls)}
    described: set[str] = set()
    for sighting, call in sightings:
        if sighting.id not in projectable:
            raise _fail(
                f"scene.seen: '{sighting.id}' is not a piece or a wall; it must be "
                "the id of a box, cylinder, wedge, stairs, repeat item or wall "
                "(the walls of a room are <room id>_back, _left and _right)",
                call.line,
            )
        if sighting.id in described:
            raise _fail(f"scene.seen: '{sighting.id}' is described twice", call.line)
        described.add(sighting.id)
    return SceneIR(
        floors=tuple(floors),
        walls=tuple(walls),
        solids=tuple(_place(solids, relations, walls, inside, camera)),
        camera=camera,
        rooms=tuple(rooms),
        sightings=tuple(sighting for sighting, _ in sightings),
    )
