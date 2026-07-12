from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
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


def test_apply_rejects_when_disk_space_insufficient(
    darwin_package: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_update, "_current_version", lambda: "1.0.0")
    name = "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    asset = _asset(name)
    asset["size"] = 10 * 1024**3
    payload = _payload(assets=[asset])
    downloads: list[str] = []

    async def fake_download(asset_obj: app_update.UpdateAsset, dest: Path) -> None:
        downloads.append(asset_obj.name)
        dest.write_bytes(b"zip")

    monkeypatch.setattr(app_update, "_download", fake_download)
    monkeypatch.setattr(app_update, "_launch_macos_updater", lambda *_a: None)
    monkeypatch.setattr(app_update, "_schedule_self_exit", lambda: None)
    monkeypatch.setattr(
        shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(total=1024**4, used=0, free=512 * 1024**2),
    )

    with pytest.raises(app_update.UpdateError, match="disk space"):
        asyncio.run(app_update.apply(fetcher=_fetcher(payload)))

    assert downloads == []  # 预检必须发生在下载之前,GB 级包不能白下
    assert app_update.get_progress().phase == "failed"


def test_apply_route_keeps_background_task_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import app_update as app_update_routes

    async def fake_status() -> dict[str, Any]:
        return {"mode": "self_update", "update_available": True, "latest_tag": "v9.9.9"}

    async def fake_apply() -> dict[str, Any]:
        await asyncio.sleep(0)
        return {"started": True}

    monkeypatch.setattr(app_update, "status", fake_status)
    monkeypatch.setattr(app_update, "apply", fake_apply)

    async def scenario() -> tuple[Any, int, int]:
        response = await app_update_routes.post_app_update_apply(_user={"username": "local"})
        # asyncio 只持任务弱引用:路由必须自己收留,防 GC 中途回收下载任务
        tasks = getattr(app_update_routes, "_apply_tasks", set())
        held_during = len(tasks)
        for _ in range(100):
            if not getattr(app_update_routes, "_apply_tasks", set()):
                break
            await asyncio.sleep(0.01)
        return response, held_during, len(getattr(app_update_routes, "_apply_tasks", set()))

    response, held_during, held_after = asyncio.run(scenario())

    assert response.data["started"] is True
    assert response.data["target_tag"] == "v9.9.9"
    assert held_during == 1
    assert held_after == 0  # 任务完成后引用要释放,不能越攒越多


# ---------------------------------------------------------------------------
# macOS 更新脚本本体(_MACOS_UPDATER):happy path 与 fail-safe 负例
# ---------------------------------------------------------------------------

requires_posix_sh = pytest.mark.skipif(
    not Path("/bin/sh").exists() or shutil.which("unzip") is None,
    reason="needs /bin/sh and unzip",
)


def _make_portable_root(base: Path, marker: str) -> Path:
    root = base / "DramaClaw-macos-arm64"
    (root / "runtime" / "python" / "bin").mkdir(parents=True)
    (root / "runtime" / "python" / "bin" / "python3").touch()
    (root / "runtime" / "marker.txt").write_text(marker)
    (root / "frontend").mkdir()
    (root / "frontend" / "index.html").write_text(marker)
    (root / "DramaClaw-Start.command").write_text(f"#!/bin/sh\necho {marker}\n")
    return root


def _make_portable_zip(path: Path, marker: str) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        base = "DramaClaw-macos-arm64"
        zf.writestr(f"{base}/runtime/python/bin/python3", "")
        zf.writestr(f"{base}/runtime/marker.txt", marker)
        zf.writestr(f"{base}/frontend/index.html", marker)
        zf.writestr(f"{base}/DramaClaw-Start.command", f"#!/bin/sh\necho {marker}\n")


def _updater_env(tmp_path: Path, *, fail_cp: bool = False) -> tuple[dict[str, str], Path]:
    """PATH shim:拦下 macOS 专属的 open;fail_cp 模拟拷贝中途失败(如磁盘满)。"""
    shims = tmp_path / "shims"
    shims.mkdir()
    open_marker = tmp_path / "open-called.txt"
    open_shim = shims / "open"
    open_shim.write_text(f'#!/bin/sh\nprintf %s "$1" > "{open_marker}"\n')
    open_shim.chmod(0o755)
    if fail_cp:
        cp_shim = shims / "cp"
        cp_shim.write_text("#!/bin/sh\nexit 1\n")
        cp_shim.chmod(0o755)
    env = {**os.environ, "PATH": f"{shims}:{os.environ['PATH']}"}
    return env, open_marker


def _run_updater(
    tmp_path: Path,
    root: Path,
    zip_path: Path,
    pid: int,
    env: dict[str, str],
    wait_limit: int = 5,
    run_timeout: int = 30,
) -> subprocess.CompletedProcess[bytes]:
    script = tmp_path / "apply.sh"
    script.write_text(app_update._MACOS_UPDATER, encoding="utf-8")
    log = tmp_path / "update.log"
    return subprocess.run(
        ["/bin/sh", str(script), str(pid), str(zip_path), str(root), str(log), str(wait_limit)],
        env=env,
        capture_output=True,
        timeout=run_timeout,
    )


def _dead_pid() -> int:
    proc = subprocess.Popen(["/bin/sh", "-c", "exit 0"])
    proc.wait()
    return proc.pid


@requires_posix_sh
def test_macos_updater_swaps_and_relaunches(tmp_path: Path) -> None:
    root = _make_portable_root(tmp_path, "old")
    zip_path = tmp_path / "DramaClaw-macos-arm64-portable-v9.9.9.zip"
    _make_portable_zip(zip_path, "new")
    env, open_marker = _updater_env(tmp_path)

    result = _run_updater(tmp_path, root, zip_path, _dead_pid(), env)

    assert result.returncode == 0
    assert (root / "runtime" / "marker.txt").read_text() == "new"
    assert (root / "frontend" / "index.html").read_text() == "new"
    assert "echo new" in (root / "DramaClaw-Start.command").read_text()
    assert not zip_path.exists()
    assert open_marker.read_text() == str(root / "DramaClaw-Start.command")
    assert not (root / ".update-stage").exists()
    assert not (root / ".update-bak").exists()


@requires_posix_sh
def test_macos_updater_aborts_when_old_process_outlives_wait(tmp_path: Path) -> None:
    root = _make_portable_root(tmp_path, "old")
    zip_path = tmp_path / "portable.zip"
    _make_portable_zip(zip_path, "new")
    env, open_marker = _updater_env(tmp_path)
    hang = subprocess.Popen(["sleep", "60"])
    try:
        result = _run_updater(
            tmp_path, root, zip_path, hang.pid, env, wait_limit=1, run_timeout=15
        )
    finally:
        hang.kill()
        hang.wait()

    assert result.returncode != 0
    assert (root / "runtime" / "marker.txt").read_text() == "old"
    assert (root / "frontend" / "index.html").read_text() == "old"
    assert not open_marker.exists()


@requires_posix_sh
def test_macos_updater_keeps_current_install_when_copy_fails(tmp_path: Path) -> None:
    root = _make_portable_root(tmp_path, "old")
    zip_path = tmp_path / "portable.zip"
    _make_portable_zip(zip_path, "new")
    env, open_marker = _updater_env(tmp_path, fail_cp=True)

    result = _run_updater(tmp_path, root, zip_path, _dead_pid(), env)

    assert result.returncode != 0
    # 承诺:更新失败不动现有安装
    old_runtime = root / "runtime" / "marker.txt"
    old_frontend = root / "frontend" / "index.html"
    assert old_runtime.exists() and old_runtime.read_text() == "old"
    assert old_frontend.exists() and old_frontend.read_text() == "old"
    assert not open_marker.exists()


@requires_posix_sh
def test_macos_updater_rejects_zip_without_expected_layout(tmp_path: Path) -> None:
    root = _make_portable_root(tmp_path, "old")
    zip_path = tmp_path / "portable.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("DramaClaw-macos-arm64/readme.txt", "not a portable bundle")
    env, open_marker = _updater_env(tmp_path)

    result = _run_updater(tmp_path, root, zip_path, _dead_pid(), env)

    assert result.returncode != 0
    assert (root / "runtime" / "marker.txt").read_text() == "old"
    assert not open_marker.exists()
