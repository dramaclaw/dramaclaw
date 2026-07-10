"""原生便携/安装形态的应用内自更新。

范围:仅覆盖 DRAMACLAW_FRONTEND_DIST 生效的原生运行(Windows 安装器 /
macOS 便携目录);Docker/网页部署的版本更新由镜像发布与前端 version.json
监测负责,不走本模块。

形态(mode):
- self_update:Windows 经 Inno per-user 安装器安装(HKCU 卸载键在)→
  下载新 Setup.exe 静默重装;macOS 便携目录 → 下载新 zip 原地替换。
- manual:原生运行但无法安全自更新(Windows 绿色 zip、未知布局)→
  前端只给下载链接。
- none:非原生运行(Docker/开发态)。

安全约束:资产必须命中 GitHub Release 的平台命名且带 sha256 digest,
下载后本地校验一致才执行;任何一步失败只置 failed 状态,不动现有安装。
Windows 拉起安装器走 WMI Win32_Process.Create——安装器会经 _stop.ps1
杀掉本进程树,直接子进程会被连坐,WMI 创建的进程不在本树内。
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from packaging.version import InvalidVersion, Version

PACKAGE_NAME = "supertale-ce"
GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/dramaclaw/dramaclaw/releases/latest"
# release 源可覆盖:E2E 测试指向本地假服务;将来国内镜像兜底也走这里
RELEASE_URL_ENV = "DRAMACLAW_UPDATE_RELEASE_URL"
RELEASE_CACHE_TTL_SECONDS = 5 * 60
RELEASE_FAILURE_CACHE_TTL_SECONDS = 60
DOWNLOAD_TIMEOUT_SECONDS = 30 * 60
# Inno 安装器 AppId(packaging 仓 dramaclaw.iss),HKCU 卸载键名 = {GUID}_is1
INNO_APP_ID = "{70C990CA-F409-4DC6-9136-7C1B516E4384}"

Fetcher = Callable[[], Awaitable[dict[str, Any]]]


class UpdateError(RuntimeError):
    pass


@dataclass(frozen=True)
class UpdateAsset:
    name: str
    url: str
    size: int
    sha256: str


@dataclass(frozen=True)
class UpdateProgress:
    phase: str = "idle"  # idle | downloading | verifying | launching | failed
    percent: int = 0
    error: str | None = None
    target_tag: str | None = None


_progress_lock = threading.Lock()
_progress = UpdateProgress()
_apply_task_running = False


def _set_progress(**kwargs: Any) -> None:
    global _progress
    with _progress_lock:
        _progress = replace(_progress, **kwargs)


def get_progress() -> UpdateProgress:
    with _progress_lock:
        return _progress


def _current_version() -> str | None:
    import importlib.metadata

    try:
        return importlib.metadata.version(PACKAGE_NAME)
    except importlib.metadata.PackageNotFoundError:
        return None


def _version_from_tag(tag: str | None) -> Version | None:
    if not tag:
        return None
    value = tag[1:] if tag.lower().startswith("v") else tag
    try:
        return Version(value)
    except InvalidVersion:
        return None


def _is_newer(latest: Version | None, current: str | None) -> bool:
    if latest is None or current is None:
        return False
    try:
        return latest > Version(current)
    except InvalidVersion:
        return False


def _native_package_root() -> Path | None:
    """原生运行的包根:DRAMACLAW_FRONTEND_DIST 指向 <root>/frontend。"""
    dist = os.environ.get("DRAMACLAW_FRONTEND_DIST", "").strip()
    if not dist:
        return None
    root = Path(dist).resolve().parent
    return root if root.exists() else None


def _windows_installed_dir() -> Path | None:
    """Inno per-user 安装目录(HKCU 卸载键 InstallLocation),非安装器形态返回 None。"""
    if sys.platform != "win32":
        return None
    import winreg

    key_path = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{INNO_APP_ID}_is1"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            location, _ = winreg.QueryValueEx(key, "InstallLocation")
    except OSError:
        return None
    path = Path(str(location).rstrip("\\/"))
    return path if path.exists() else None


def detect_mode() -> tuple[str, Path | None]:
    """返回 (mode, root)。root 仅在 self_update 时有意义。"""
    root = _native_package_root()
    if root is None:
        return "none", None
    if sys.platform == "win32":
        installed = _windows_installed_dir()
        if installed is not None and installed.resolve() == root.resolve():
            return "self_update", installed
        return "manual", root
    if sys.platform == "darwin":
        python3 = root / "runtime" / "python" / "bin" / "python3"
        start = root / "DramaClaw-Start.command"
        if python3.exists() and start.exists():
            return "self_update", root
        return "manual", root
    return "manual", root


def expected_asset_name(tag: str) -> str | None:
    if sys.platform == "win32":
        return f"DramaClaw-Setup-{tag}.exe"
    if sys.platform == "darwin":
        return f"DramaClaw-macos-arm64-portable-{tag}.zip"
    return None


def pick_asset(payload: dict[str, Any], tag: str) -> UpdateAsset:
    wanted = expected_asset_name(tag)
    if wanted is None:
        raise UpdateError("unsupported platform")
    for asset in payload.get("assets") or []:
        if str(asset.get("name")) != wanted:
            continue
        digest = str(asset.get("digest") or "")
        if not digest.startswith("sha256:"):
            raise UpdateError(f"asset {wanted} has no sha256 digest")
        url = str(asset.get("browser_download_url") or "")
        if not url:
            raise UpdateError(f"asset {wanted} has no download url")
        return UpdateAsset(
            name=wanted,
            url=url,
            size=int(asset.get("size") or 0),
            sha256=digest.removeprefix("sha256:").lower(),
        )
    raise UpdateError(f"release {tag} has no asset {wanted}")


async def _fetch_latest_release() -> dict[str, Any]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"dramaclaw-app-update/{_current_version() or 'unknown'}",
    }
    url = os.environ.get(RELEASE_URL_ENV, "").strip() or GITHUB_LATEST_RELEASE_URL
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise UpdateError("unexpected release payload")
    return payload


_release_cache_lock = asyncio.Lock()
_release_cache: dict[str, Any] | None = None
_release_cache_until = 0.0
_release_failure_until = 0.0


async def latest_release(*, fetcher: Fetcher | None = None) -> dict[str, Any] | None:
    global _release_cache, _release_cache_until, _release_failure_until
    now = time.monotonic()
    async with _release_cache_lock:
        if _release_cache is not None and now < _release_cache_until:
            return _release_cache
        if now < _release_failure_until:
            return None
        try:
            payload = await (fetcher or _fetch_latest_release)()
        except Exception:
            _release_failure_until = now + RELEASE_FAILURE_CACHE_TTL_SECONDS
            return None
        _release_cache = payload
        _release_cache_until = now + RELEASE_CACHE_TTL_SECONDS
        _release_failure_until = 0.0
        return payload


async def status(*, fetcher: Fetcher | None = None) -> dict[str, Any]:
    mode, _root = detect_mode()
    current = _current_version()
    result: dict[str, Any] = {
        "mode": mode,
        "current_version": current,
        "update_available": False,
        "latest_tag": None,
        "release_url": None,
        "asset_name": None,
        "asset_size": None,
        "progress": get_progress().__dict__,
    }
    if mode == "none":
        return result
    payload = await latest_release(fetcher=fetcher)
    if payload is None:
        return result
    tag = str(payload.get("tag_name") or "").strip() or None
    latest = _version_from_tag(tag)
    if tag is None or not _is_newer(latest, current):
        return result
    result["update_available"] = True
    result["latest_tag"] = tag
    result["release_url"] = str(payload.get("html_url") or "") or None
    if mode == "self_update":
        try:
            asset = pick_asset(payload, tag)
        except UpdateError as exc:
            # 资产缺失/无 digest:退化为 manual,前端只给链接
            result["mode"] = "manual"
            result["mode_reason"] = str(exc)
        else:
            result["asset_name"] = asset.name
            result["asset_size"] = asset.size
    return result


async def _download(asset: UpdateAsset, dest: Path) -> None:
    digest = hashlib.sha256()
    received = 0
    async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_SECONDS, follow_redirects=True) as client:
        async with client.stream("GET", asset.url) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or asset.size or 0)
            with dest.open("wb") as fh:
                async for chunk in response.aiter_bytes(1024 * 512):
                    fh.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                    if total > 0:
                        _set_progress(phase="downloading", percent=min(99, received * 100 // total))
    if digest.hexdigest().lower() != asset.sha256:
        raise UpdateError("downloaded asset sha256 mismatch")


def _launch_windows_installer(setup_path: Path) -> None:
    command = (
        f'"{setup_path}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART '
        "/FORCECLOSEAPPLICATIONS /STARTAPP"
    )
    script = (
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        "-Arguments @{CommandLine=$env:DRAMACLAW_UPDATE_CMD}; "
        "if ($r.ReturnValue -ne 0) { exit 1 }"
    )
    env = {**os.environ, "DRAMACLAW_UPDATE_CMD": command}
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        env=env,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError(
            "failed to launch installer: "
            + (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
        )


_MACOS_UPDATER = """#!/bin/sh
# DramaClaw self-update helper (generated; applies zip then relaunches)
set -e
PID="$1"; ZIP="$2"; ROOT="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "waiting for pid $PID to exit"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 1; i=$((i+1)); done
TMP=$(mktemp -d)
unzip -q "$ZIP" -d "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
test -d "$SRC/runtime" && test -d "$SRC/frontend"
rm -rf "$ROOT/runtime" "$ROOT/frontend"
cp -R "$SRC/runtime" "$ROOT/runtime"
cp -R "$SRC/frontend" "$ROOT/frontend"
for f in DramaClaw-Start.command DramaClaw-Stop.command README-macOS.txt; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$ROOT/$f"; fi
done
chmod +x "$ROOT/DramaClaw-Start.command" "$ROOT/DramaClaw-Stop.command" 2>/dev/null || true
rm -rf "$TMP" "$ZIP"
echo "update applied, relaunching"
open "$ROOT/DramaClaw-Start.command"
"""


def _launch_macos_updater(zip_path: Path, root: Path) -> None:
    workdir = Path(tempfile.mkdtemp(prefix="dramaclaw-update-"))
    script = workdir / "apply.sh"
    script.write_text(_MACOS_UPDATER, encoding="utf-8")
    script.chmod(0o755)
    log = workdir / "update.log"
    subprocess.Popen(
        ["/bin/sh", str(script), str(os.getpid()), str(zip_path), str(root), str(log)],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _schedule_self_exit() -> None:
    """macOS:给响应留出回程时间后优雅退出,更新脚本等我们死透再动文件。"""
    import signal

    def _exit() -> None:
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Timer(1.5, _exit).start()


async def apply(*, fetcher: Fetcher | None = None) -> dict[str, Any]:
    """启动自更新(幂等:进行中重复调用直接返回当前进度)。"""
    global _apply_task_running
    with _progress_lock:
        if _apply_task_running:
            return {"started": False, "progress": _progress.__dict__}
        _apply_task_running = True
    try:
        mode, root = detect_mode()
        if mode != "self_update" or root is None:
            raise UpdateError(f"self update unavailable in mode {mode}")
        payload = await latest_release(fetcher=fetcher)
        if payload is None:
            raise UpdateError("release info unavailable")
        tag = str(payload.get("tag_name") or "").strip()
        if not _is_newer(_version_from_tag(tag), _current_version()):
            raise UpdateError("already up to date")
        asset = pick_asset(payload, tag)
        _set_progress(phase="downloading", percent=0, error=None, target_tag=tag)
        workdir = Path(tempfile.mkdtemp(prefix="dramaclaw-update-"))
        dest = workdir / asset.name
        await _download(asset, dest)
        _set_progress(phase="verifying", percent=100)
        if sys.platform == "win32":
            _set_progress(phase="launching")
            _launch_windows_installer(dest)
        elif sys.platform == "darwin":
            _set_progress(phase="launching")
            _launch_macos_updater(dest, root)
            _schedule_self_exit()
        else:  # pragma: no cover - detect_mode 已挡住
            raise UpdateError("unsupported platform")
        return {"started": True, "progress": get_progress().__dict__}
    except UpdateError as exc:
        _set_progress(phase="failed", error=str(exc))
        raise
    except Exception as exc:
        _set_progress(phase="failed", error=f"{type(exc).__name__}: {exc}")
        raise UpdateError(str(exc)) from exc
    finally:
        with _progress_lock:
            _apply_task_running = False


def reset_state_for_tests() -> None:
    global _progress, _apply_task_running, _release_cache, _release_cache_until, _release_failure_until
    with _progress_lock:
        _progress = UpdateProgress()
        _apply_task_running = False
    _release_cache = None
    _release_cache_until = 0.0
    _release_failure_until = 0.0
