"""SceneIR: the validated, metre-based intermediate representation of a blockout.

Everything here stays in the DSL frame: x right, y up, z forward (away from the
reference camera), metres. Conversion to the previz frame happens in compiler.py
and nowhere else.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

BLOCKOUT_COMPILER_VERSION = 1

MAX_PROGRAM_CHARS = 20_000
MAX_AST_NODES = 5_000
MAX_COMPILED_OBJECTS = 150
MAX_COORDINATE_ABS = 100.0
MAX_EDGE_METERS = 100.0
MIN_PIECE_METERS = 0.01

Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]


class BlockoutProgramError(ValueError):
    """The program is invalid. The model may fix it, so this triggers a retry."""

    def __init__(self, message: str, *, line: int | None = None) -> None:
        self.message = message
        self.line = line
        super().__init__(f"line {line}: {message}" if line else message)


class BlockoutLimitError(ValueError):
    """The scene is valid but too large to import. Retrying will not help."""


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class OpeningIR(_Frozen):
    id: str
    kind: Literal["door", "window", "arch"]
    offset: float
    width: float
    height: float
    sill: float


class FloorIR(_Frozen):
    id: str
    semantic_type: str
    name_hint: str = ""
    center: Vec2
    size: Vec2


class WallIR(_Frozen):
    id: str
    semantic_type: str
    name_hint: str = ""
    start: Vec2
    end: Vec2
    height: float
    thickness: float
    openings: tuple[OpeningIR, ...] = ()


class SolidIR(_Frozen):
    id: str
    semantic_type: str
    shape: Literal["box", "cylinder", "wedge"]
    position: Vec3
    size: Vec3
    rotation_y: float


class CameraIR(_Frozen):
    id: str
    position: Vec3
    target: Vec3
    fov: float


class SceneIR(_Frozen):
    compiler_version: int = BLOCKOUT_COMPILER_VERSION
    floors: tuple[FloorIR, ...]
    walls: tuple[WallIR, ...]
    solids: tuple[SolidIR, ...]
    camera: CameraIR
