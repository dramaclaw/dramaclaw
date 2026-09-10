"""Project task runner registration package.

Importing this package registers every built-in project task runner.
"""

from novelvideo.task_backend.runners import (  # noqa: F401
    audio,
    character_image,
    episode_assets,
    freezone,
    graph_build,
    identity,
    ingest,
    prop_reference,
    render,
    scene_reference,
    script,
    skill_import,
    sketch,
    sketch_edit_execute,
    stage_asset,
    video,
)
