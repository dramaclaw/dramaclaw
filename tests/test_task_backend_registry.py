import ast
from pathlib import Path


def test_importing_runners_registers_builtin_project_task_runners():
    import novelvideo.task_backend.runners  # noqa: F401
    from novelvideo.task_backend.registry import (
        get_project_task_runner,
        registered_project_task_types,
    )

    names = set(registered_project_task_types())

    assert len(names) >= 25
    for task_type in {
        "single_video",
        "sketch_generation",
        "sketch_grid_generation",
        "director_control_to_sketch",
        "audio_generation_indextts2",
        "build_scenes",
    }:
        assert task_type in names
        assert get_project_task_runner(task_type) is not None

    for removed_task_type in {"batch_render", "video_generation", "render_plan"}:
        assert removed_task_type not in names
        assert get_project_task_runner(removed_task_type) is None


def test_removed_render_plan_runner_does_not_import_deleted_scope_helper():
    source = "src/novelvideo/task_backend/runners/render.py"
    text = open(source, encoding="utf-8").read()

    assert "render_plan_scope" not in text


def test_every_literal_enqueued_project_task_has_registered_runner():
    import novelvideo.task_backend.runners  # noqa: F401
    from novelvideo.task_backend.registry import registered_project_task_types

    route_dir = Path("src/novelvideo/api/routes")
    enqueued: set[str] = set()
    for path in route_dir.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name != "enqueue_project_task":
                continue
            for keyword in node.keywords:
                if (
                    keyword.arg == "task_type"
                    and isinstance(keyword.value, ast.Constant)
                    and isinstance(keyword.value.value, str)
                ):
                    enqueued.add(keyword.value.value)

    missing = enqueued - set(registered_project_task_types())
    assert missing == set()
