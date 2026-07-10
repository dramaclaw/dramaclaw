from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from novelvideo import app_update


@pytest.fixture(autouse=True)
def _reset_state() -> Any:
    app_update.reset_state_for_tests()
    yield
    app_update.reset_state_for_tests()


@pytest.fixture()
def darwin_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """伪造 macOS 便携包布局并把进程切到该形态。"""
    root = tmp_path / "DramaClaw-macos-arm64"
    (root / "runtime" / "python" / "bin").mkdir(parents=True)
    (root / "runtime" / "python" / "bin" / "python3").touch()
    (root / "frontend").mkdir()
    (root / "DramaClaw-Start.command").touch()
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("DRAMACLAW_FRONTEND_DIST", str(root / "frontend"))
    return root


def _payload(tag: str = "v9.9.9", assets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "tag_name": tag,
        "html_url": f"https://github.com/dramaclaw/dramaclaw/releases/tag/{tag}",
        "assets": assets if assets is not None else [],
    }


def _asset(name: str, digest: str | None = "sha256:" + "ab" * 32) -> dict[str, Any]:
    item: dict[str, Any] = {
        "name": name,
        "browser_download_url": f"https://example.invalid/{name}",
        "size": 123,
    }
    if digest is not None:
        item["digest"] = digest
    return item


def _fetcher(payload: dict[str, Any]):
    async def fetch() -> dict[str, Any]:
        return payload

    return fetch


def test_detect_mode_none_outside_native_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DRAMACLAW_FRONTEND_DIST", raising=False)
    assert app_update.detect_mode() == ("none", None)


def test_detect_mode_darwin_package_is_self_update(darwin_package: Path) -> None:
    mode, root = app_update.detect_mode()
    assert mode == "self_update"
    assert root == darwin_package


def test_detect_mode_darwin_without_bundled_python_is_manual(
    darwin_package: Path,
) -> None:
    (darwin_package / "runtime" / "python" / "bin" / "python3").unlink()
    mode, _root = app_update.detect_mode()
    assert mode == "manual"


def test_pick_asset_requires_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    name = "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    with pytest.raises(app_update.UpdateError, match="digest"):
        app_update.pick_asset(_payload(assets=[_asset(name, digest=None)]), "v9.9.9")


def test_pick_asset_matches_platform_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    name = "DramaClaw-Setup-v9.9.9.exe"
    asset = app_update.pick_asset(_payload(assets=[_asset(name)]), "v9.9.9")
    assert asset.name == name
    assert asset.sha256 == "ab" * 32
    with pytest.raises(app_update.UpdateError, match="no asset"):
        app_update.pick_asset(_payload(assets=[_asset("other.exe")]), "v9.9.9")


def test_status_reports_update_with_asset(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "1.0.0")
    name = "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    payload = _payload(assets=[_asset(name)])

    result = asyncio.run(app_update.status(fetcher=_fetcher(payload)))

    assert result["mode"] == "self_update"
    assert result["update_available"] is True
    assert result["latest_tag"] == "v9.9.9"
    assert result["asset_name"] == name


def test_status_degrades_to_manual_when_asset_unusable(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "1.0.0")
    result = asyncio.run(app_update.status(fetcher=_fetcher(_payload(assets=[]))))

    assert result["update_available"] is True
    assert result["mode"] == "manual"
    assert "no asset" in result["mode_reason"]


def test_status_offline_keeps_quiet(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom() -> dict[str, Any]:
        raise RuntimeError("offline")

    result = asyncio.run(app_update.status(fetcher=boom))
    assert result["update_available"] is False


def test_latest_release_caches_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    async def boom() -> dict[str, Any]:
        calls["n"] += 1
        raise RuntimeError("offline")

    assert asyncio.run(app_update.latest_release(fetcher=boom)) is None
    assert asyncio.run(app_update.latest_release(fetcher=boom)) is None
    assert calls["n"] == 1


def test_apply_downloads_verifies_and_launches(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "1.0.0")
    name = "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    payload = _payload(assets=[_asset(name)])
    seen: dict[str, Any] = {}

    async def fake_download(asset: app_update.UpdateAsset, dest: Path) -> None:
        seen["asset"] = asset
        dest.write_bytes(b"zip")

    def fake_launch(zip_path: Path, root: Path) -> None:
        seen["launched"] = (zip_path.name, root)

    monkeypatch.setattr(app_update, "_download", fake_download)
    monkeypatch.setattr(app_update, "_launch_macos_updater", fake_launch)
    monkeypatch.setattr(app_update, "_schedule_self_exit", lambda: seen.setdefault("exit", True))

    result = asyncio.run(app_update.apply(fetcher=_fetcher(payload)))

    assert result["started"] is True
    assert seen["asset"].name == name
    assert seen["launched"] == (name, darwin_package)
    assert seen["exit"] is True
    assert app_update.get_progress().phase == "launching"
    assert app_update.get_progress().target_tag == "v9.9.9"


def test_apply_rejects_when_already_up_to_date(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "9.9.9")

    with pytest.raises(app_update.UpdateError, match="up to date"):
        asyncio.run(app_update.apply(fetcher=_fetcher(_payload())))
    assert app_update.get_progress().phase == "failed"


def test_apply_download_failure_lands_in_progress(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "1.0.0")
    name = "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    payload = _payload(assets=[_asset(name)])

    async def bad_download(asset: app_update.UpdateAsset, dest: Path) -> None:
        raise app_update.UpdateError("downloaded asset sha256 mismatch")

    monkeypatch.setattr(app_update, "_download", bad_download)

    with pytest.raises(app_update.UpdateError, match="sha256"):
        asyncio.run(app_update.apply(fetcher=_fetcher(payload)))
    progress = app_update.get_progress()
    assert progress.phase == "failed"
    assert "sha256" in (progress.error or "")


def _route_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from novelvideo.api.app import create_app
    from novelvideo.api.auth import get_api_user

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("DRAMACLAW_FRONTEND_DIST", raising=False)
    app = create_app()
    app.dependency_overrides[get_api_user] = lambda: {"username": "local"}
    return TestClient(app)


def test_status_route_returns_ok_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _route_client(monkeypatch).get("/api/v1/app-update/status")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["mode"] == "none"
    assert body["data"]["update_available"] is False


def test_apply_route_rejects_outside_native_run(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _route_client(monkeypatch).post("/api/v1/app-update/apply")

    assert response.status_code == 409


def test_release_url_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    class FakeResponse:
        def raise_for_status(self) -> None: ...
        def json(self) -> dict[str, Any]:
            return {"tag_name": "v9.9.9", "assets": []}

    class FakeClient:
        def __init__(self, **kwargs: Any) -> None: ...
        async def __aenter__(self) -> "FakeClient":
            return self
        async def __aexit__(self, *args: Any) -> None: ...
        async def get(self, url: str, headers: dict[str, str]) -> FakeResponse:
            seen["url"] = url
            return FakeResponse()

    monkeypatch.setenv(app_update.RELEASE_URL_ENV, "http://127.0.0.1:8999/latest.json")
    monkeypatch.setattr(app_update.httpx, "AsyncClient", FakeClient)

    payload = asyncio.run(app_update._fetch_latest_release())

    assert seen["url"] == "http://127.0.0.1:8999/latest.json"
    assert payload["tag_name"] == "v9.9.9"
