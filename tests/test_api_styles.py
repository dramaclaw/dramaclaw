import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m04


def test_style_preview_upload_is_staged_and_finalized(tmp_path):
    from novelvideo.services.style_service import StyleService

    staged = StyleService.stage_style_preview(tmp_path, b"image-bytes", ".png")
    assert staged.startswith("assets/styles/.staging/")
    assert (tmp_path / staged).read_bytes() == b"image-bytes"

    final = StyleService.finalize_style_preview(tmp_path, "custom_drama", staged)
    assert final == "assets/styles/custom_drama/reference.png"
    assert (tmp_path / final).read_bytes() == b"image-bytes"
    assert not (tmp_path / staged).exists()


def test_finalizing_style_preview_removes_previous_extension(tmp_path):
    from novelvideo.services.style_service import StyleService

    old_preview = tmp_path / "assets/styles/custom_drama/reference.png"
    old_preview.parent.mkdir(parents=True)
    old_preview.write_bytes(b"old-image")
    staged = StyleService.stage_style_preview(tmp_path, b"new-image", ".jpg")

    final = StyleService.finalize_style_preview(tmp_path, "custom_drama", staged)

    assert final == "assets/styles/custom_drama/reference.jpg"
    assert not old_preview.exists()
    assert (tmp_path / final).read_bytes() == b"new-image"


def test_remove_style_previews_removes_all_supported_variants(tmp_path):
    from novelvideo.services.style_service import StyleService

    style_dir = tmp_path / "assets/styles/custom_drama"
    style_dir.mkdir(parents=True)
    for extension in (".png", ".jpg", ".webp"):
        (style_dir / f"reference{extension}").write_bytes(b"image")
    unrelated = style_dir / "notes.txt"
    unrelated.write_text("keep", encoding="utf-8")

    StyleService.remove_style_previews(tmp_path, "custom_drama")

    assert not list(style_dir.glob("reference.*"))
    assert unrelated.read_text(encoding="utf-8") == "keep"


def test_style_reference_upload_returns_final_path_without_ai_analysis(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert required_role == "editor"
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)

    response = _client().post(
        "/projects/demo/styles/preview-upload",
        data={"style_id": "custom_drama"},
        files={"file": ("reference.png", b"image-bytes", "image/png")},
    )

    assert response.status_code == 200
    preview_path = response.json()["data"]["preview_path"]
    assert preview_path == "assets/styles/custom_drama/reference.png"
    assert (tmp_path / preview_path).read_bytes() == b"image-bytes"


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ("reference.avif", "image/avif"),
        ("reference.heic", "image/heic"),
    ],
)
def test_style_reference_upload_rejects_unsupported_format(
    monkeypatch,
    tmp_path,
    filename,
    content_type,
):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)

    response = _client().post(
        "/projects/demo/styles/preview-upload",
        data={"style_id": "custom_drama"},
        files={"file": (filename, b"image-bytes", content_type)},
    )

    assert response.status_code == 415
    assert response.json()["detail"] == "Unsupported style preview image type"


def test_style_reference_upload_rejects_empty_file(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)

    response = _client().post(
        "/projects/demo/styles/preview-upload",
        data={"style_id": "custom_drama"},
        files={"file": ("reference.png", b"", "image/png")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "No preview image uploaded"


def _client():
    from novelvideo.api.routes import styles

    app = FastAPI()
    app.include_router(styles.router)
    app.dependency_overrides[styles.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app)


def test_style_preview_get_returns_image_without_generation():
    response = _client().get("/styles/anime/preview")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.content.startswith(b"\x89PNG\r\n\x1a\n")


def test_custom_style_list_includes_project_media_preview_url(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles
    from novelvideo.services.style_service import StyleService

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name="demo-project",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        StyleService,
        "list_all_styles",
        lambda **kwargs: [
            {
                "id": "custom_drama",
                "name": "Custom drama",
                "type": "custom",
                "preview_path": "assets/styles/custom_drama/reference.png",
            }
        ],
    )

    response = _client().get("/styles", params={"project": "demo"})

    assert response.status_code == 200
    assert response.json()["data"][0]["preview_url"] == (
        "/api/v1/projects/demo/media/"
        "assets/styles/custom_drama/reference.png"
    )


def test_custom_style_detail_includes_project_media_preview_url(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles
    from novelvideo.models import StyleConfig
    from novelvideo.services.style_service import StyleService

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name="demo-project",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        StyleService,
        "get_style",
        lambda *args, **kwargs: StyleConfig(
            id="custom_drama",
            name="Custom drama",
            preview_path="assets/styles/custom_drama/reference.png",
        ),
    )

    response = _client().get("/styles/custom_drama", params={"project": "demo"})

    assert response.status_code == 200
    assert response.json()["data"]["preview_url"] == (
        "/api/v1/projects/demo/media/"
        "assets/styles/custom_drama/reference.png"
    )


def test_style_preview_post_route_still_exists(monkeypatch, tmp_path):
    from novelvideo.generators import image_generator

    preview_path = tmp_path / "preview.png"
    preview_path.write_bytes(b"\x89PNG\r\n\x1a\n")

    async def fake_generate_character_reference_unified(**kwargs):
        return [str(preview_path)]

    monkeypatch.setattr(
        image_generator,
        "generate_character_reference_unified",
        fake_generate_character_reference_unified,
    )

    response = _client().post("/styles/anime/preview", json={})

    assert response.status_code == 200


def test_guoman_fantasy_is_listed_as_3d_animation_preset():
    response = _client().get("/styles")

    assert response.status_code == 200
    styles = response.json()["data"]
    guoman = next(style for style in styles if style["id"] == "guoman_fantasy")
    assert guoman["label"] == "3D玄幻国漫"
    assert guoman["style_family"] == "animation"
    assert guoman["animation_subtype"] == "3d"


def test_create_style_accepts_frontend_payload_with_top_level_id_and_name(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles
    from novelvideo.services.style_service import StyleService

    saved = []

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == "demo"
        assert user == {"username": "alice"}
        assert required_role == "editor"
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    def fake_save_custom_style(style_id, config, **kwargs):
        saved.append((style_id, config, kwargs))
        return True

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(StyleService, "save_custom_style", fake_save_custom_style)

    response = _client().post(
        "/styles",
        json={
            "id": "custom_drama",
            "name": "自定义剧集风格",
            "project": "demo",
            "config": {
                "label": "自定义剧集风格",
                "style_instructions": "cinematic live action",
                "avoid_instructions": "anime",
                "style_tag": "LIVE-ACTION",
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert len(saved) == 1
    style_id, config, kwargs = saved[0]
    assert style_id == "custom_drama"
    assert config.id == "custom_drama"
    assert config.name == "自定义剧集风格"
    assert config.label == "自定义剧集风格"
    assert kwargs == {"username": "alice", "project": "demo"}


def test_create_style_accepts_existing_published_preview_path(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles
    from novelvideo.services.style_service import StyleService

    saved = []

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        StyleService,
        "save_custom_style",
        lambda style_id, config, **kwargs: saved.append(config) or True,
    )
    preview = tmp_path / "assets/styles/custom_drama/reference.png"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"image")

    response = _client().post(
        "/styles",
        json={
            "id": "custom_drama",
            "name": "自定义剧集风格",
            "project": "demo",
            "preview_path": "assets/styles/custom_drama/reference.png",
            "config": {"style_instructions": "cinematic live action"},
        },
    )

    assert response.status_code == 200
    assert saved[0].preview_path == "assets/styles/custom_drama/reference.png"


def test_create_style_associates_published_preview_without_request_path(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles
    from novelvideo.services.style_service import StyleService

    saved = []
    preview = tmp_path / "assets/styles/custom_drama/reference.webp"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"image")

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        StyleService,
        "save_custom_style",
        lambda style_id, config, **kwargs: saved.append(config) or True,
    )

    response = _client().post(
        "/styles",
        json={
            "id": "custom_drama",
            "name": "Custom drama",
            "project": "demo",
            "config": {},
        },
    )

    assert response.status_code == 200
    assert saved[0].preview_path == "assets/styles/custom_drama/reference.webp"


def test_create_style_rejects_missing_published_preview_path(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import styles

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name=project,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)

    response = _client().post(
        "/styles",
        json={
            "id": "custom_drama",
            "name": "Custom drama",
            "project": "demo",
            "preview_path": "assets/styles/custom_drama/reference.png",
            "config": {},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Custom style preview does not exist"


def test_config_style_helpers_do_not_fallback_to_hardcoded_presets(monkeypatch):
    from novelvideo import config

    class BrokenStyleService:
        @staticmethod
        def get_style(*args, **kwargs):
            raise RuntimeError("style service unavailable")

        @staticmethod
        def get_style_labels(*args, **kwargs):
            raise RuntimeError("style service unavailable")

        @staticmethod
        def list_all_styles(*args, **kwargs):
            raise RuntimeError("style service unavailable")

    real_import = __import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "novelvideo.services.style_service":

            class Module:
                StyleService = BrokenStyleService

            return Module
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr("builtins.__import__", fake_import)

    with pytest.raises(RuntimeError, match="style service unavailable"):
        config.get_style_preset("chinese_period_drama")
    with pytest.raises(RuntimeError, match="style service unavailable"):
        config.get_style_labels()
    with pytest.raises(RuntimeError, match="style service unavailable"):
        config.list_available_styles()
