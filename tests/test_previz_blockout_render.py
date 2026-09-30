from __future__ import annotations

import io
import json
from pathlib import Path

from PIL import Image

from novelvideo.director_world.blockout.render import render_blockout

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
GOLDEN = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))


def _decode(png: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png)).convert("RGB")


def _colours(image: Image.Image) -> set[tuple[int, int, int]]:
    return set(image.getdata())


def test_render_is_a_png_with_the_aspect_of_the_reference_picture():
    png = render_blockout(GOLDEN["compiled"]["objects"], image_aspect=16 / 9)

    image = _decode(png)
    assert image.size == (1024, 576)
    # A 4:3 picture gets a 4:3 render, so what the model sees lines up with the reference.
    assert _decode(
        render_blockout(GOLDEN["compiled"]["objects"], image_aspect=4 / 3, width=400)
    ).size == (400, 300)


def test_render_draws_the_scene_from_the_reference_camera():
    png = render_blockout(GOLDEN["compiled"]["objects"], image_aspect=16 / 9)

    # The golden room fills the view from its camera: many shades, not one flat background.
    assert len(_colours(_decode(png))) > 50


def test_render_is_deterministic():
    objects = GOLDEN["compiled"]["objects"]

    assert render_blockout(objects, image_aspect=16 / 9) == render_blockout(
        objects, image_aspect=16 / 9
    )


def test_a_wall_between_the_camera_and_the_room_is_left_out():
    # A camera just outside the back wall, looking in. With the wall drawn, the
    # picture is one flat wall; without it, the room behind shows through.
    room = {
        "id": "floor",
        "kind": "prop",
        "assetUrl": "plane",
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [6, 1, 6]},
        "blockout": {"id": "floor", "semanticType": "floor"},
    }
    wall = {
        "id": "wall",
        "kind": "prop",
        "assetUrl": "cube",
        "transform": {"position": [0, 0, -3], "rotation": [0, 0, 0], "scale": [6, 3, 0.2]},
        "blockout": {"id": "wall", "semanticType": "wall"},
    }
    crate = {
        "id": "crate",
        "kind": "prop",
        "assetUrl": "cube",
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]},
        "blockout": {"id": "crate", "semanticType": "prop"},
    }
    camera = {
        "id": "cam",
        "kind": "camera",
        "transform": {"position": [0, 1.5, -4], "rotation": [-5, 180, 0], "scale": [1, 1, 1]},
        "focalMm": 24,
        "blockout": {"id": "cam", "semanticType": "reference_camera"},
    }

    with_wall = _decode(render_blockout([room, wall, crate, camera], image_aspect=16 / 9))
    without_wall = _decode(render_blockout([room, crate, camera], image_aspect=16 / 9))

    assert with_wall.tobytes() == without_wall.tobytes()


def test_labels_name_each_piece_but_not_walls_or_floors():
    objects = GOLDEN["compiled"]["objects"]

    labelled = _decode(render_blockout(objects, image_aspect=16 / 9))
    plain = _decode(render_blockout(objects, image_aspect=16 / 9, labels=False))

    # Labels change the picture; walls and floors carry none, so a scene of
    # only room pieces renders the same with or without them.
    assert labelled.tobytes() != plain.tobytes()
    room_only = [
        o
        for o in objects
        if o["kind"] == "camera" or o["blockout"]["semanticType"] in ("wall", "floor")
    ]
    assert render_blockout(room_only, image_aspect=16 / 9) == render_blockout(
        room_only, image_aspect=16 / 9, labels=False
    )
