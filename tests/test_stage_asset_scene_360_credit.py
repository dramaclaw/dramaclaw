from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_scene_360_reserves_and_confirms_credit(monkeypatch, tmp_path):
    from novelvideo import stage_asset_tasks

    calls = []

    monkeypatch.setenv("SCENE_360_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("SCENE_360_IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setattr(
        stage_asset_tasks,
        "_reserve_scene_360_model_call",
        lambda model, *, provider, image_size, quality: calls.append(
            ("reserve", model, provider, image_size, quality)
        )
        or "res_1",
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "_confirm_scene_360_model_call",
        lambda **kwargs: calls.append(("confirm", kwargs)),
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "_refund_scene_360_model_call",
        lambda *args, **kwargs: calls.append(("refund", args, kwargs)),
    )

    def fake_run(cmd, **_kwargs):
        output_dir = tmp_path
        for idx, item in enumerate(cmd):
            if item == "--output-dir":
                output_dir = stage_asset_tasks.Path(cmd[idx + 1])
                break
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "scene_panorama_2to1.png").write_bytes(b"png")
        (output_dir / "scene_360_manifest.json").write_text(
            '{"request_id":"req_360","response_id":"resp_360"}',
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(stage_asset_tasks, "run_project_subprocess", fake_run)

    result = stage_asset_tasks.run_scene_360(
        tmp_path / "project",
        "Hall",
        source="text",
        provider="newapi",
    )

    assert result["ok"] is True
    assert result["model"] == "gpt-image-2"
    assert result["request_id"] == "req_360"
    assert result["response_id"] == "resp_360"
    assert calls[0] == ("reserve", "gpt-image-2", "newapi", "2K", "medium")
    assert calls[1] == (
        "confirm",
        {
            "model": "gpt-image-2",
            "reservation_id": "res_1",
            "provider": "newapi",
            "provider_request_id": "req_360",
            "provider_task_id": "",
            "provider_response_id": "resp_360",
        },
    )
    assert len(calls) == 2


def test_scene_360_refunds_reserved_credit_on_subprocess_failure(monkeypatch, tmp_path):
    from novelvideo import stage_asset_tasks

    calls = []

    monkeypatch.setenv("SCENE_360_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("SCENE_360_IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setattr(
        stage_asset_tasks,
        "_reserve_scene_360_model_call",
        lambda model, *, provider, image_size, quality: calls.append(
            ("reserve", model, provider, image_size, quality)
        )
        or "res_1",
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "_confirm_scene_360_model_call",
        lambda **kwargs: calls.append(("confirm", kwargs)),
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "_refund_scene_360_model_call",
        lambda reservation_id, *, provider, error: calls.append(
            ("refund", reservation_id, provider, error)
        ),
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "run_project_subprocess",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout="", stderr="boom"),
    )

    with pytest.raises(RuntimeError, match="360 全景生成失败"):
        stage_asset_tasks.run_scene_360(
            tmp_path / "project",
            "Hall",
            source="text",
            provider="newapi",
        )

    assert calls == [
        ("reserve", "gpt-image-2", "newapi", "2K", "medium"),
        ("refund", "res_1", "newapi", "RuntimeError"),
    ]


def test_scene_360_candidate_artifact_does_not_update_manifest(monkeypatch, tmp_path):
    from novelvideo import stage_asset_tasks

    project_dir = tmp_path / "project"
    master = project_dir / "assets" / "scenes" / "Hall" / "master.png"
    reverse = project_dir / "assets" / "scenes" / "Hall" / "reverse.png"
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"master")
    reverse.write_bytes(b"reverse")
    artifact_dir = project_dir / "freezone" / "_outputs" / "mainline_scene_360" / "job_360"

    monkeypatch.setattr(
        stage_asset_tasks,
        "_reserve_scene_360_model_call",
        lambda *_args, **_kwargs: "",
    )
    monkeypatch.setattr(
        stage_asset_tasks,
        "_confirm_scene_360_model_call",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        stage_asset_tasks.stage_manifest,
        "update_manifest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("candidate 360 must not update manifest")
        ),
    )

    def fake_run(cmd, **_kwargs):
        output_dir = tmp_path
        for idx, item in enumerate(cmd):
            if item == "--output-dir":
                output_dir = stage_asset_tasks.Path(cmd[idx + 1])
                break
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "scene_panorama_2to1.png").write_bytes(b"png")
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(stage_asset_tasks, "run_project_subprocess", fake_run)

    result = stage_asset_tasks.run_scene_360(
        project_dir,
        "Hall",
        source="master",
        provider="newapi",
        model="gpt-image-2",
        master_path_override=master,
        reverse_master_path_override=reverse,
        artifact_dir=artifact_dir,
        update_manifest=False,
    )

    assert result["manifest_updated"] is False
    assert result["output_path"] == str(artifact_dir / "pano_360.png")
    assert (artifact_dir / "pano_360.png").exists()
    assert not (project_dir / "director_worlds" / "Hall" / "v1" / "pano_360.png").exists()


def test_scene_360_credit_billing_params_normalizes_size_and_quality():
    from novelvideo import stage_asset_tasks

    assert stage_asset_tasks._scene_360_credit_billing_params(
        image_size="2K",
        quality="Medium",
    ) == {"size": "2k", "quality": "medium"}
