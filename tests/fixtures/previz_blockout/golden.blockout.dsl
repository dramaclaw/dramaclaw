# Shared golden scene. Deliberately asymmetric: nothing here survives a mirrored
# axis or a flipped rotation sign unnoticed.
scene.room(id="room", width=8.0, depth=6.0, height=3.0)
scene.opening(id="door", wall="room_back", kind="door", offset=1.0, width=1.0, height=2.1)
scene.opening(id="win", wall="room_left", kind="window", offset=2.0, width=1.5, height=1.2, sill=0.9)
scene.wall(id="partition", start=(1.0, 0.0), end=(3.0, 2.0), height=2.4, thickness=0.1)
scene.box(id="counter", position=(2.8, 0.0, -1.2), size=(2.0, 1.1, 0.6), rotation_y=30, semantic_type="counter")
scene.cylinder(id="stool", position=(-2.0, 0.0, 0.5), radius=0.2, height=0.7, semantic_type="chair")
scene.stairs(id="steps", position=(-3.0, 0.0, 2.0), size=(1.2, 1.0, 2.0), rotation_y=90)
scene.repeat(
    primitive="box",
    ids=["table_1", "table_2"],
    positions=[(-1.0, 0.0, -1.0), (1.0, 0.0, -1.0)],
    size=(1.2, 0.75, 0.7),
    semantic_type="table",
)
scene.camera(id="cam", position=(1.0, 1.6, -5.0), target=(0.0, 1.2, 1.0), fov=65)
# Where the pieces lie in the picture, read off the picture; the check projects
# the scene through the camera above and must land on the same spots. No
# `bottom` here: it depends on the picture's aspect ratio, and tests feed this
# program pictures of several shapes.
scene.seen(id="room_back", left=0.17, right=0.96)
scene.seen(id="steps", left=0.08, right=0.33)
scene.seen(id="stool", left=0.19, right=0.27)
