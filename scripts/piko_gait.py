# SPDX-License-Identifier: Elastic-2.0
"""One authored eight-pose cycle shared by torso, shoulder and hip chains.

Contact / down / passing / up, repeated with the opposite support foot.
Coordinates are integer source pixels; the contact plane never bobs.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class GaitPose:
    swing: float
    feet: tuple[tuple[int, int], tuple[int, int]]


@dataclass(frozen=True)
class BodyPose:
    y: int


def body_pose(direction, phase):
    """Side body stays steady; front/back retains a one-pixel weight shift."""
    beat = phase % 4
    if direction in ("south", "north"):
        return BodyPose(y=(0, 1, 0, 0)[beat])
    return BodyPose(y=0)


POSES = (
    GaitPose(-1, ((-5, 0), (5, 0))),
    GaitPose(-0.7, ((-3, 1), (3, 0))),
    GaitPose(0, ((0, 3), (0, 0))),
    GaitPose(0.7, ((3, 2), (-3, 0))),
    GaitPose(1, ((5, 0), (-5, 0))),
    GaitPose(0.7, ((3, 0), (-3, 1))),
    GaitPose(0, ((0, 0), (0, 3))),
    GaitPose(-0.7, ((-3, 0), (3, 2))),
)
