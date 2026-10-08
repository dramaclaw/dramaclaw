from types import SimpleNamespace

import pytest


def test_scene_360_provider_defaults_to_newapi_when_env_is_empty(monkeypatch):
    from novelvideo import stage_asset_tasks

    monkeypatch.setenv("SCENE_360_IMAGE_PROVIDER", "")
    monkeypatch.setenv("SCENE_360_PROVIDER", "")
    monkeypatch.setenv("NANOBANANA_PROVIDER", "")

    assert stage_asset_tasks.resolve_scene_360_image_provider() == "newapi"


def test_scene_360_model_accepts_registered_gateway_model_for_provider():
    from novelvideo import stage_asset_tasks
    from novelvideo.config import NEWAPI_IMAGE_MODEL

    assert (
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="newapi",
            model=NEWAPI_IMAGE_MODEL,
        )
        == NEWAPI_IMAGE_MODEL
    )


def test_scene_360_model_rejects_unknown_selection_instead_of_raw_passthrough():
    from novelvideo import stage_asset_tasks

    with pytest.raises(
        stage_asset_tasks.Scene360ImageModelSelectionError,
        match="unknown scene 360 image model selection",
    ):
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="newapi",
            model="attacker-controlled-model",
        )


def test_scene_360_model_rejects_provider_mismatch_instead_of_raw_passthrough():
    from novelvideo import stage_asset_tasks

    with pytest.raises(
        stage_asset_tasks.Scene360ImageModelSelectionError,
        match="does not use provider",
    ):
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="openai",
            model="newapi_gpt_image2",
        )


def test_scene_360_runs_catalog_model_with_verified_authority(monkeypatch, tmp_path):
    from novelvideo import stage_asset_tasks

    model = "organization-authorized-pano-model"
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

    def fake_run(cmd, **_kwargs):
        output_dir = stage_asset_tasks.Path(cmd[cmd.index("--output-dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "scene_panorama_2to1.png").write_bytes(b"png")
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(stage_asset_tasks, "run_project_subprocess", fake_run)

    result = stage_asset_tasks.run_scene_360(
        tmp_path / "project",
        "Hall",
        source="text",
        provider="newapi",
        model=model,
        artifact_dir=tmp_path / "candidate",
        update_manifest=False,
        model_authority=stage_asset_tasks.Scene360CatalogModelAuthority(
            catalog_id="catalog-pano",
            provider="newapi",
            model=model,
        ),
    )

    assert result["ok"] is True
    assert result["model"] == model


def test_scene_360_newapi_model_defaults_to_lingshan_without_env(monkeypatch):
    from novelvideo import stage_asset_tasks

    monkeypatch.delenv("SCENE_360_IMAGE_MODEL", raising=False)
    monkeypatch.delenv("NEWAPI_IMAGE_MODEL", raising=False)

    assert stage_asset_tasks.resolve_scene_360_image_model(provider="newapi") == "LingShan-G2"


@pytest.mark.parametrize(
    ("scene_model", "gateway_model", "expected"),
    [
        ("", "", "LingShan-G2"),
        ("", "gateway-custom-model", "gateway-custom-model"),
        ("pano-custom-model", "gateway-custom-model", "pano-custom-model"),
    ],
)
def test_scene_360_newapi_model_keeps_env_override_priority(
    monkeypatch, scene_model, gateway_model, expected
):
    from novelvideo import stage_asset_tasks

    monkeypatch.setenv("SCENE_360_IMAGE_MODEL", scene_model)
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", gateway_model)

    assert stage_asset_tasks.resolve_scene_360_image_model(provider="newapi") == expected


def test_scene_360_openai_model_keeps_native_default(monkeypatch):
    from novelvideo import stage_asset_tasks

    monkeypatch.delenv("OPENAI_IMAGE_MODEL", raising=False)
    monkeypatch.setenv("SCENE_360_IMAGE_MODEL", "LingShan-G2")
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", "LingShan-G2")

    assert stage_asset_tasks.resolve_scene_360_image_model(provider="openai") == "gpt-image-2"


def test_scene_360_default_model_reaches_builder_with_panorama_parameters(monkeypatch, tmp_path):
    from novelvideo import stage_asset_tasks

    for name in (
        "SCENE_360_IMAGE_MODEL", "NEWAPI_IMAGE_MODEL", "SCENE_360_IMAGE_SIZE",
        "SCENE_360_IMAGE_QUALITY", "HUIMENG_IMAGE_QUALITY",
    ):
        monkeypatch.delenv(name, raising=False)

    def fake_run(cmd, **_kwargs):
        assert cmd[cmd.index("--model") + 1] == "LingShan-G2"
        assert cmd[cmd.index("--image-size") + 1] == "2K"
        assert cmd[cmd.index("--quality") + 1] == "medium"
        output_dir = stage_asset_tasks.Path(cmd[cmd.index("--output-dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "scene_panorama_2to1.png").write_bytes(b"png")
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(stage_asset_tasks, "run_project_subprocess", fake_run)
    result = stage_asset_tasks.run_scene_360_feature_billed(
        tmp_path / "project",
        "Hall",
        source="text",
        provider="newapi",
        artifact_dir=tmp_path / "candidate",
        update_manifest=False,
    )
    assert result["ok"] is True
    assert result["model"] == "LingShan-G2"
