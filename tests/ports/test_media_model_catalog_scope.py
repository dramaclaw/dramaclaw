from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone
from novelvideo.api.routes import model_credits
from novelvideo.ports import registry
from novelvideo.project_context import ProjectContext


def _catalog_entry(catalog_id: str) -> dict[str, object]:
    return {
        "catalogId": catalog_id,
        "catalog_id": catalog_id,
        "id": catalog_id,
        "provider": "newapi",
        "apiModel": catalog_id,
        "gatewayModel": catalog_id,
        "label": catalog_id,
    }


class ScopedCatalog:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def list_models(self, media_type: str) -> list[dict[str, object]]:
        raise AssertionError(f"unscoped catalog read is forbidden: {media_type}")

    async def list_models_for_user(
        self,
        media_type: str,
        *,
        user_id: str,
    ) -> list[dict[str, object]]:
        self.calls.append((media_type, user_id))
        if user_id == "user-a":
            return [_catalog_entry("model-a")]
        if user_id == "user-b":
            return [_catalog_entry("model-b")]
        return []


def _project_context(user_id: str) -> ProjectContext:
    return ProjectContext(
        project_id="project-1",
        project_name="demo",
        owner_type="user",
        owner_id=user_id,
        owner_username="owner",
        requester_user_id=user_id,
        requester_username="requester",
        requester_principals=(("user", user_id),),
        effective_role="owner",
        home_node_id="local",
        output_dir=Path("/tmp/project-1"),
        state_dir=Path("/tmp/project-1/state"),
        runtime_dir=Path("/tmp/project-1/runtime"),
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_scoped_catalog_never_uses_the_platform_wide_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = ScopedCatalog()
    monkeypatch.setitem(registry._PORTS, "media_model_catalog", catalog)

    models_a = await freezone._scoped_media_model_catalog(
        "image",
        requester_user_id="user-a",
    )
    models_b = await freezone._scoped_media_model_catalog(
        "image",
        requester_user_id="user-b",
    )

    assert [item["id"] for item in models_a or []] == ["model-a"]
    assert [item["id"] for item in models_b or []] == ["model-b"]
    assert catalog.calls == [("image", "user-a"), ("image", "user-b")]


@pytest.mark.asyncio
async def test_task_submission_rechecks_visibility_before_enqueue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = ScopedCatalog()
    monkeypatch.setitem(registry._PORTS, "media_model_catalog", catalog)

    with pytest.raises(HTTPException) as exc_info:
        await freezone._start_or_enqueue_freezone_gen_job(
            ctx=_project_context("user-b"),
            username="owner",
            project="demo",
            project_dir=Path("/tmp/project-1"),
            output_dir="/tmp/project-1",
            prompt="prompt",
            aspect_ratio="16:9",
            image_size="1K",
            reference_urls=[],
            camera=None,
            style=None,
            provider="newapi",
            model="model-a",
            quality="medium",
        )

    assert exc_info.value.status_code == 409
    assert "未对当前组织开放" in str(exc_info.value.detail)
    assert catalog.calls == [("image", "user-b")]


@pytest.mark.asyncio
async def test_video_rechecks_visibility_after_async_media_probe_before_enqueue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RevocableCatalog(ScopedCatalog):
        def __init__(self) -> None:
            super().__init__()
            self.enabled = True

        async def list_models_for_user(
            self,
            media_type: str,
            *,
            user_id: str,
        ) -> list[dict[str, object]]:
            self.calls.append((media_type, user_id))
            return [_catalog_entry("model-a")] if self.enabled else []

    catalog = RevocableCatalog()

    async def revoke_during_probe(paths: list[str]) -> float:
        assert paths == ["/tmp/reference.mp4"]
        catalog.enabled = False
        return 5.0

    async def unexpected_enqueue(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("task was enqueued after model access was revoked")

    monkeypatch.setitem(registry._PORTS, "media_model_catalog", catalog)
    monkeypatch.setattr(
        freezone,
        "probe_total_video_duration_seconds",
        revoke_during_probe,
    )
    monkeypatch.setattr(
        freezone,
        "get_task_backend",
        lambda: type(
            "UnexpectedBackend",
            (),
            {"enqueue_project_task": unexpected_enqueue},
        )(),
    )
    monkeypatch.setattr(
        model_credits,
        "freezone_video_generate_task_billing",
        lambda _payload: {"feature_key": "freezone.video_generate"},
    )

    with pytest.raises(HTTPException) as exc_info:
        await freezone._start_or_enqueue_freezone_video_gen(
            ctx=_project_context("user-a"),
            username="owner",
            project="demo",
            project_dir=Path("/tmp/project-1"),
            output_dir="/tmp/project-1",
            job_id="job-video",
            prompt="prompt",
            reference_items=[{"type": "video", "path": "/tmp/reference.mp4"}],
            aspect_ratio="16:9",
            resolution="720p",
            duration_seconds=5,
            generate_audio=False,
            human_review=False,
            scene_optimize=None,
            backend="model-a",
            catalog_id="model-a",
        )

    assert exc_info.value.status_code == 409
    assert "当前没有可用的视频模型" in str(exc_info.value.detail)
    assert catalog.calls == [("video", "user-a"), ("video", "user-a")]


@pytest.mark.asyncio
async def test_platform_or_organization_scope_failure_is_not_bypassed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DeniedCatalog(ScopedCatalog):
        async def list_models_for_user(
            self,
            media_type: str,
            *,
            user_id: str,
        ) -> list[dict[str, object]]:
            error = RuntimeError("denied")
            error.code = "MEDIA_MODEL_SCOPE_DENIED"  # type: ignore[attr-defined]
            raise error

    monkeypatch.setitem(registry._PORTS, "media_model_catalog", DeniedCatalog())

    with pytest.raises(HTTPException) as exc_info:
        await freezone._scoped_media_model_catalog(
            "video",
            requester_user_id="denied-user",
        )

    assert exc_info.value.status_code == 403
