from types import SimpleNamespace

import pytest

STAGE_ASSET_DISPATCH_CASES = (
    ("single_face_sharp", "run_single_face_sharp", {"image_path": "source.png"}),
    ("pano_sharp", "run_pano_sharp", {"pano_path": "pano.png"}),
    ("splat_collision", "run_splat_collision", {"ply_path": "scene.ply"}),
    ("voxel_world_from_360", "run_voxel_world_from_360", {}),
    (
        "upload_scene_package",
        "upload_scene_package",
        {"src_asset": "package.zip"},
    ),
    ("pano_from_master", "run_scene_360", {"master_path": "master.png"}),
    ("pano_from_text", "run_scene_360", {}),
)

STAGE_ASSET_TASK_FUNCTIONS = (
    "run_single_face_sharp",
    "run_pano_sharp",
    "run_splat_collision",
    "run_voxel_world_from_360",
    "upload_scene_package",
    "run_scene_360",
)


def test_supported_stage_asset_steps_are_exported_exactly():
    from novelvideo.task_backend.runners.stage_asset import (
        SUPPORTED_STAGE_ASSET_STEPS,
    )

    assert SUPPORTED_STAGE_ASSET_STEPS == frozenset(
        {
            "single_face_sharp",
            "pano_sharp",
            "splat_collision",
            "voxel_world_from_360",
            "upload_scene_package",
            "pano_from_master",
            "pano_from_text",
        }
    )


def test_stage_asset_dispatch_cases_match_supported_steps_exactly():
    from novelvideo.task_backend.runners.stage_asset import (
        SUPPORTED_STAGE_ASSET_STEPS,
    )

    assert frozenset(
        step for step, _handler, _params in STAGE_ASSET_DISPATCH_CASES
    ) == (SUPPORTED_STAGE_ASSET_STEPS)


@pytest.mark.parametrize(
    ("step", "expected_handler", "case_params"),
    STAGE_ASSET_DISPATCH_CASES,
    ids=[case[0] for case in STAGE_ASSET_DISPATCH_CASES],
)
def test_supported_stage_asset_step_dispatches_to_expected_handler(
    step,
    expected_handler,
    case_params,
    tmp_path,
    monkeypatch,
):
    from novelvideo import stage_asset_tasks
    from novelvideo.task_backend.runners import stage_asset

    calls: list[str] = []
    sentinel = object()

    def unexpected_handler(name):
        def fail(*_args, **_kwargs):
            raise AssertionError(f"unexpected handler: {name}")

        return fail

    def expected(*_args, **_kwargs):
        calls.append(expected_handler)
        return sentinel

    for function_name in STAGE_ASSET_TASK_FUNCTIONS:
        monkeypatch.setattr(
            stage_asset_tasks,
            function_name,
            unexpected_handler(function_name),
        )
    monkeypatch.setattr(stage_asset_tasks, expected_handler, expected)
    monkeypatch.setattr(
        stage_asset,
        "get_task_manager",
        lambda: SimpleNamespace(
            update_progress_for_project=lambda *_args, **_kwargs: None
        ),
    )
    monkeypatch.setattr(
        stage_asset,
        "raise_if_envelope_cancel_requested",
        lambda *_args, **_kwargs: None,
    )
    params = {
        key: (
            str(tmp_path / value)
            if key.endswith("path") or key == "src_asset"
            else value
        )
        for key, value in case_params.items()
    }

    result = stage_asset.run_stage_asset(
        {
            "scope": f"scene_asset_{step}",
            "payload": {
                "scene_name": "Hall",
                "step": step,
                "params": params,
                "project_dir": str(tmp_path),
            },
        },
        SimpleNamespace(project_id="proj", output_dir=tmp_path),
    )

    assert result is sentinel
    assert calls == [expected_handler]


def test_unknown_stage_asset_step_is_rejected_before_side_effects(
    tmp_path, monkeypatch
):
    from novelvideo import stage_asset_tasks
    from novelvideo.task_backend.runners import stage_asset

    calls: list[str] = []

    def unexpected_call(name):
        def fail(*_args, **_kwargs):
            calls.append(name)
            raise AssertionError(f"unexpected call: {name}")

        return fail

    monkeypatch.setattr(stage_asset, "get_task_manager", unexpected_call("manager"))
    monkeypatch.setattr(
        stage_asset,
        "raise_if_envelope_cancel_requested",
        unexpected_call("cancel"),
    )
    for function_name in (
        "run_single_face_sharp",
        "run_pano_sharp",
        "run_splat_collision",
        "run_voxel_world_from_360",
        "upload_scene_package",
        "run_scene_360",
    ):
        monkeypatch.setattr(
            stage_asset_tasks,
            function_name,
            unexpected_call(function_name),
        )

    with pytest.raises(ValueError, match="^unknown stage_asset step: not_supported$"):
        stage_asset.run_stage_asset(
            {
                "scope": "scene_asset",
                "payload": {
                    "scene_name": "Hall",
                    "step": "not_supported",
                    "project_dir": str(tmp_path),
                },
            },
            SimpleNamespace(project_id="proj", output_dir=tmp_path),
        )

    assert calls == []
