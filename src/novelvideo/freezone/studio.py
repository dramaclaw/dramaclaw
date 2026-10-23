"""Bridge Dramaclaw's video-compose timeline to an OpenFilm Studio project.

A compose node's timeline becomes a film folder (`film.html` + `assets/`) under the
project, and a lazily started OpenFilm Studio serves it. The Studio owns editing and
preview; Dramaclaw keeps the timeline, upstream media, tasks and storage.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode, urlsplit

import httpx

from novelvideo.config import STATE_DIR
from novelvideo.freezone.paths import resolve_static_url_to_path

if TYPE_CHECKING:
    from novelvideo.api.schemas import FreezoneVideoComposeTrack

_MEDIA_SUFFIXES = {
    ".mp4",
    ".m4v",
    ".mov",
    ".webm",
    ".mkv",
    ".avi",
    ".m4a",
    ".mp3",
    ".wav",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".aiff",
    ".wma",
}
_STAGE = {"720p": (1280, 720), "1080p": (1920, 1080)}
_MAX_SAFE_NAME = 48
_HEX_COLOR = re.compile(
    r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})"
)

_BUILD_LOCK = threading.Lock()
_SESSION_LOCK = asyncio.Lock()
# Studio 是第三方 Node 进程，只给它运行所需的系统变量；MODEL_API_KEY、DSN、
# 会话密钥等 API 环境一律不继承。
_STUDIO_ENV_PASSTHROUGH = (
    "PATH",
    "HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "LOGNAME",
    "SYSTEMROOT",
    "WINDIR",
)
_STALE_CLIP_NAME = re.compile(r"^clip-\d+-")


class StudioError(RuntimeError):
    """A user-facing Studio bridge failure with an HTTP status."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _state_dir() -> Path:
    return Path(STATE_DIR) / "openfilm"


def _studio_home() -> Path:
    return _state_dir() / "home"


def _state_file() -> Path:
    return _state_dir() / "studio.json"


def _log_file() -> Path:
    return _state_dir() / "studio.log"


def _safe_segment(value: str, fallback: str) -> str:
    raw = (value or "").strip()
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-_")[:_MAX_SAFE_NAME]
    if slug and slug == raw:
        return slug
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"{slug or fallback}-{digest}"


def _film_dir(project_dir: Path, canvas_id: str, node_id: str) -> Path:
    folder = (
        project_dir
        / "freezone"
        / "studio"
        / _safe_segment(canvas_id or "default", "canvas")
        / _safe_segment(node_id or "default", "node")
    )
    resolved = folder.resolve()
    try:
        resolved.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise StudioError("studio folder escapes the project", 400) from exc
    return resolved


def _number(value: float) -> str:
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return "0" if text in {"", "-0"} else text


def _request_payload(
    *,
    resolution: str,
    background_color: str,
    keep_original_audio: bool,
    tracks: list[FreezoneVideoComposeTrack],
) -> dict[str, Any]:
    return {
        "version": 1,
        "resolution": resolution,
        "background_color": background_color,
        "keep_original_audio": keep_original_audio,
        "tracks": [
            {
                "track_id": track.track_id,
                "kind": track.kind,
                "items": [
                    {
                        "item_id": item.item_id,
                        "source_url": item.source_url,
                        "timeline_start": item.timeline_start,
                        "source_start": item.source_start,
                        "source_end": item.source_end,
                        "volume": item.volume,
                        "muted": item.muted,
                        "speed": item.speed,
                    }
                    for item in track.items
                ],
            }
            for track in tracks
        ],
    }


def _request_hash(request: dict[str, Any]) -> str:
    encoded = json.dumps(request, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _document_hash(document: str) -> str:
    return hashlib.sha256(document.encode("utf-8")).hexdigest()


def _document_differs_from_build(film_dir: Path, manifest: dict[str, Any]) -> bool:
    """Studio saves edits straight into film.html, so a document that no longer hashes to what
    this module wrote was cut by hand."""
    built = manifest.get("document_hash")
    document_path = film_dir / "film.html"
    if not document_path.is_file():
        return False
    if not built:
        # 升级前生成的 film 没留下基线，判断不了是不是手改。宁可多问一次，也不静默覆盖。
        return True
    try:
        document = document_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return _document_hash(document) != built


def _film_was_edited(film_dir: Path) -> bool:
    manifest = _read_manifest(film_dir / "manifest.json")
    return bool(manifest) and _document_differs_from_build(film_dir, manifest)


def _can_reuse(film_dir: Path, request_hash: str) -> bool:
    manifest = _read_manifest(film_dir / "manifest.json")
    if not manifest or manifest.get("request_hash") != request_hash:
        return False
    if not (film_dir / "film.html").is_file():
        return False
    # A hand-cut film keeps its cut. The asset list below only says what the host copied in:
    # media replaced or deleted in Studio would fail it, and rebuilding would rewrite the
    # document — the one thing the editor cannot give back.
    if _document_differs_from_build(film_dir, manifest):
        return True
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        return False
    return all((film_dir / "assets" / str(name)).is_file() for name in assets)


_TITLE_TAG = re.compile(r"(?is)<title>.*?</title>")


def _sync_title(film_dir: Path, title: str) -> None:
    """Follow a canvas rename onto a film that is kept as it is. The editor shows the film's own
    ``<title>`` as its heading, and rebuilding the document to change one word would throw away
    whatever was cut in it by hand."""
    name = (title or "").strip()
    if not name:
        return
    document_path = film_dir / "film.html"
    try:
        document = document_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    updated, hits = _TITLE_TAG.subn(
        lambda _match: f"<title>{html.escape(name)}</title>", document, count=1
    )
    retitled = bool(hits) and updated != document
    if retitled:
        _write_text_atomic(document_path, updated)
    manifest = _read_manifest(film_dir / "manifest.json")
    if manifest is None:
        return
    changes: dict[str, Any] = {}
    if manifest.get("title") != name:
        changes["title"] = name
    # Retitling is this module's own write, so a film nobody cut by hand keeps its asset check;
    # one that was already edited keeps the older baseline and stays on the keep path.
    built = manifest.get("document_hash")
    if retitled and built and _document_hash(document) == built:
        changes["document_hash"] = _document_hash(updated)
    if changes:
        _write_text_atomic(
            film_dir / "manifest.json",
            json.dumps({**manifest, **changes}, ensure_ascii=False, indent=2) + "\n",
        )


def _resolve_source(source_url: str, project_dir: Path) -> Path:
    try:
        path = resolve_static_url_to_path(source_url, project_dir)
    except ValueError as exc:
        raise StudioError(str(exc), 400) from exc
    if not path.exists():
        raise StudioError(f"compose source not found: {source_url}", 404)
    if not path.is_file():
        raise StudioError(f"compose source is not a file: {source_url}", 400)
    suffix = path.suffix.lower()
    if suffix not in _MEDIA_SUFFIXES:
        raise StudioError(f"unsupported compose source type: {suffix or 'none'}", 400)
    return path


def _copy_asset(source: Path, destination: Path) -> None:
    """Copy via a temp name so Studio never sees a half-written asset."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        delete=False,
    ) as handle:
        temp = Path(handle.name)
    temp.unlink(missing_ok=True)
    try:
        try:
            os.link(source, temp)
        except OSError:
            shutil.copyfile(source, temp)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def _write_text_atomic(path: Path, text: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        handle.write(text)
        temp = Path(handle.name)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _clip_markup(
    *,
    kind: str,
    index: int,
    item_id: str,
    asset_name: str,
    item: Any,
    muted: bool,
) -> str:
    attrs = [
        f'id="clip-{index}"',
        f'data-dramaclaw-item-id="{html.escape(item_id, quote=True)}"',
        f'src="assets/{asset_name}#t={_number(item.source_start)},{_number(item.source_end)}"',
        f'at="{_number(item.timeline_start)}"',
        f'volume="{_number(item.volume)}"',
    ]
    if abs(float(item.speed) - 1.0) > 1e-9:
        attrs.append(f'speed="{_number(item.speed)}"')
    if muted:
        attrs.append("muted")
    tag = "audio" if kind == "audio" else "video"
    return f"<{tag} {' '.join(attrs)}></{tag}>"


def _film_html(
    *,
    title: str,
    resolution: str,
    background_color: str,
    keep_original_audio: bool,
    tracks: list[FreezoneVideoComposeTrack],
    assets: list[str],
) -> str:
    width, height = _STAGE[resolution]
    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        f'<meta name="viewport" content="width={width}, height={height}">',
        f"<title>{html.escape(title)}</title>",
        "<style>",
        f"html, body {{ margin: 0; background: {html.escape(background_color)}; }}",
        "</style>",
        "</head>",
        "<body>",
    ]
    index = 0
    has_video = False
    for track in tracks:
        if not track.items:
            continue
        lines.append("<section>")
        for item in track.items:
            if track.kind == "video":
                has_video = True
            muted = item.muted or (
                track.kind == "video" and not keep_original_audio
            )
            lines.append(
                _clip_markup(
                    kind=track.kind,
                    index=index,
                    item_id=item.item_id,
                    asset_name=assets[index],
                    item=item,
                    muted=muted,
                )
            )
            index += 1
        lines.append("</section>")
    if not has_video:
        raise StudioError("video compose requires at least one video item", 400)
    lines.extend(["</body>", "</html>", ""])
    return "\n".join(lines)


def build_studio_film(
    *,
    project_dir: Path,
    canvas_id: str,
    node_id: str,
    title: str,
    resolution: str,
    background_color: str,
    keep_original_audio: bool,
    tracks: list[FreezoneVideoComposeTrack],
    rebuild: bool = False,
) -> Path:
    """Write (or reuse) the OpenFilm film folder for a compose timeline."""
    if resolution not in _STAGE:
        raise StudioError(f"unsupported resolution: {resolution}", 400)
    if not _HEX_COLOR.fullmatch(background_color or ""):
        raise StudioError("background_color must be a hex color", 400)
    if not tracks:
        raise StudioError("tracks is required", 400)

    request = _request_payload(
        resolution=resolution,
        background_color=background_color,
        keep_original_audio=keep_original_audio,
        tracks=tracks,
    )
    request_hash = _request_hash(request)
    film_dir = _film_dir(project_dir, canvas_id, node_id)

    with _BUILD_LOCK:
        if not rebuild and _can_reuse(film_dir, request_hash):
            _sync_title(film_dir, title)
            return film_dir
        # Regenerating would replace a film someone cut by hand; the host asks first and
        # resends with rebuild=True once they agree.
        if not rebuild and _film_was_edited(film_dir):
            raise StudioError(
                "the film was edited in Studio; pass rebuild to replace it", 409
            )

        resolved: list[tuple[Any, Path]] = []
        for track in tracks:
            for item in track.items:
                if item.source_end <= item.source_start:
                    raise StudioError(
                        f"compose item {item.item_id} has invalid source range: "
                        "source_end must be > source_start",
                        400,
                    )
                if item.speed < 0.25:
                    raise StudioError(
                        f"compose item {item.item_id} speed must be at least 0.25",
                        400,
                    )
                resolved.append((item, _resolve_source(item.source_url, project_dir)))

        film_dir.mkdir(parents=True, exist_ok=True)
        assets_dir = film_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        asset_names = [
            f"clip-{index}-{_safe_segment(item.item_id, 'clip')[:24]}"
            f"{source.suffix.lower()}"
            for index, (item, source) in enumerate(resolved)
        ]
        # 先落新素材，再清旧拷贝：反过来一旦拷贝失败，旧素材已经删掉，
        # film 目录会停在一个素材缺失的状态。
        for (_, source), asset_name in zip(resolved, asset_names):
            _copy_asset(source, assets_dir / asset_name)
        # Studio 的素材库直接扫描 assets 目录；时间线里删掉的片段如果还留着
        # 旧拷贝，同一条片段会在库里出现两份。只清理本模块生成的素材名，
        # 目录里用户自己放的文件不动。
        keep = set(asset_names)
        for stale in assets_dir.iterdir():
            if (
                _STALE_CLIP_NAME.match(stale.name)
                and stale.name not in keep
                and (stale.is_file() or stale.is_symlink())
            ):
                stale.unlink(missing_ok=True)

        document = _film_html(
            title=title or "视频合成",
            resolution=resolution,
            background_color=background_color,
            keep_original_audio=keep_original_audio,
            tracks=tracks,
            assets=asset_names,
        )
        _write_text_atomic(film_dir / "film.html", document)
        manifest = {
            **request,
            "request_hash": request_hash,
            "document_hash": _document_hash(document),
            "canvas_id": canvas_id,
            "node_id": node_id,
            "title": title,
            "assets": asset_names,
            "built_at": datetime.now(timezone.utc).isoformat(),
        }
        _write_text_atomic(
            film_dir / "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        return film_dir


def _validate_host_back(value: str | None) -> str | None:
    if not value:
        return None
    target = value.strip()
    if len(target) > 2000:
        raise StudioError("host_back is too long", 400)
    parts = urlsplit(target)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise StudioError("host_back must be an http(s) URL", 400)
    return target


# Dramaclaw's locale tags → the codes OpenFilm actually ships a catalogue for.
# Vietnamese has no Studio catalogue, so it gets the fallback the editor would
# have picked anyway; anything unmapped is dropped rather than guessed at.
_STUDIO_LANGUAGES = {"zh": "zh-CN", "en": "en", "vi": "en"}


def _studio_language(value: str | None) -> str | None:
    if not value:
        return None
    return _STUDIO_LANGUAGES.get(value.strip()[:16].lower().split("-")[0])


def studio_open_url(
    *,
    origin: str,
    key: str,
    project_id: str,
    host_back: str | None = None,
    host_back_label: str | None = None,
    lang: str | None = None,
) -> str:
    """The Studio address that signs the frame in and remembers the host's way back."""
    if not re.fullmatch(r"[\w-]{1,64}", project_id or ""):
        raise StudioError("Studio returned an invalid project id", 502)
    target = f"/projects/{project_id}"
    extra: dict[str, str] = {}
    back = _validate_host_back(host_back)
    if not back:
        raise StudioError("host_back is required: the editor only runs embedded", 400)
    extra["hostBack"] = back
    if host_back_label and host_back_label.strip():
        extra["hostBackLabel"] = host_back_label.strip()[:60]
    language = _studio_language(lang)
    if language:
        extra["lang"] = language
    if extra:
        target = f"{target}?{urlencode(extra)}"
    query = urlencode({"key": key, "to": target})
    return f"{origin.rstrip('/')}/open?{query}"


def _read_state() -> dict[str, Any] | None:
    try:
        value = json.loads(_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _write_state(state: dict[str, Any]) -> None:
    _state_dir().mkdir(parents=True, exist_ok=True)
    path = _state_file()
    _write_text_atomic(path, json.dumps(state) + "\n")
    path.chmod(0o600)


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _pick_ports() -> int:
    try:
        start = int(os.environ.get("SUPERTALE_OPENFILM_STUDIO_PORT", "4747"))
    except ValueError:
        start = 4747
    for port in range(start, start + 200):
        if _port_free(port) and _port_free(port + 1):
            return port
    raise StudioError("no free port pair for OpenFilm Studio", 503)


def _runtime_installed() -> bool:
    return (
        _repo_root()
        / "vendor"
        / "openfilm"
        / "node_modules"
        / "playwright-core"
        / "package.json"
    ).is_file()


def _log_tail(limit: int = 4000) -> str:
    try:
        with _log_file().open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - limit))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _studio_env(port: int, key: str, ready: Path) -> dict[str, str]:
    env = {
        name: os.environ[name] for name in _STUDIO_ENV_PASSTHROUGH if name in os.environ
    }
    env.update(
        {
            "OPENFILM_HOME": str(_studio_home()),
            "OPENFILM_STUDIO_PORT": str(port),
            "OPENFILM_STUDIO_KEY": key,
            "OPENFILM_STUDIO_READY_FILE": str(ready),
        }
    )
    return env


def _stop_process(proc: subprocess.Popen[bytes]) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def _spawn_studio() -> dict[str, Any]:
    if not _runtime_installed():
        raise StudioError(
            "OpenFilm Studio runtime is not installed; run "
            "`(cd vendor/openfilm && npm install --omit=dev)`",
            503,
        )
    node = shutil.which("node")
    if not node:
        raise StudioError("Node.js is required to run OpenFilm Studio", 503)
    runner = _repo_root() / "scripts" / "openfilm_studio" / "run.mjs"
    if not runner.is_file():
        raise StudioError("OpenFilm Studio runner is missing", 500)

    _state_dir().mkdir(parents=True, exist_ok=True)
    ready = _state_dir() / f"ready-{os.getpid()}-{int(time.time() * 1000)}.json"
    ready.unlink(missing_ok=True)
    port = _pick_ports()
    key = secrets.token_hex(24)
    env = _studio_env(port, key, ready)

    _studio_home().mkdir(parents=True, exist_ok=True)
    log_path = _log_file()
    log_path.touch(mode=0o600, exist_ok=True)
    with log_path.open("ab", buffering=0) as log:
        log.write(
            f"\n[{datetime.now(timezone.utc).isoformat()}] starting Studio on {port}\n".encode()
        )
        try:
            proc = subprocess.Popen(
                [node, str(runner)],
                cwd=str(_repo_root()),
                env=env,
                stdout=log,
                stderr=log,
                stdin=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise StudioError(
                f"could not start OpenFilm Studio: {exc}", 503
            ) from exc

    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if ready.is_file():
            try:
                said = json.loads(ready.read_text(encoding="utf-8"))
            except ValueError:
                said = None
            ready.unlink(missing_ok=True)
            if (
                isinstance(said, dict)
                and isinstance(said.get("origin"), str)
                and isinstance(said.get("filmOrigin"), str)
            ):
                state = {
                    "pid": proc.pid,
                    "origin": said["origin"],
                    "film_origin": said["filmOrigin"],
                    "port": said.get("port", port),
                    "key": key,
                    "started_at": datetime.now(timezone.utc).isoformat(),
                }
                _write_state(state)
                return state
        if proc.poll() is not None:
            break
        time.sleep(0.1)

    ready.unlink(missing_ok=True)
    if proc.poll() is None:
        _stop_process(proc)
        raise StudioError("OpenFilm Studio did not start in time", 503)
    tail = _log_tail()
    raise StudioError(
        f"OpenFilm Studio failed to start: {tail or 'no log'}", 503
    )


async def _health(origin: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            response = await client.get(f"{origin.rstrip('/')}/api/health")
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        said = response.json()
    except ValueError:
        return None
    if not isinstance(said, dict) or said.get("product") != "openfilm-studio":
        return None
    return said


async def _ensure_studio() -> dict[str, Any]:
    async with _SESSION_LOCK:
        external = os.environ.get("SUPERTALE_OPENFILM_STUDIO_ORIGIN", "").strip()
        external_key = os.environ.get("SUPERTALE_OPENFILM_STUDIO_KEY", "").strip()
        if external:
            said = await _health(external)
            if not said or not external_key:
                raise StudioError(
                    "OpenFilm Studio is configured but not reachable with a key",
                    503,
                )
            return {
                "origin": external.rstrip("/"),
                "film_origin": str(said.get("filmOrigin") or ""),
                "key": external_key,
                "port": None,
            }
        state = _read_state()
        if state and isinstance(state.get("origin"), str):
            said = await _health(state["origin"])
            if said:
                state["film_origin"] = str(
                    said.get("filmOrigin") or state.get("film_origin") or ""
                )
                return state
        return await asyncio.to_thread(_spawn_studio)


async def _studio_post(
    state: dict[str, Any], path: str, body: dict[str, Any]
) -> dict[str, Any]:
    origin = str(state["origin"]).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=20.0, trust_env=False) as client:
            response = await client.post(
                f"{origin}{path}",
                json=body,
                headers={"x-studio-key": str(state["key"])},
            )
    except httpx.HTTPError as exc:
        raise StudioError(f"OpenFilm Studio request failed: {exc}", 502) from exc
    if response.status_code >= 400:
        raise StudioError(
            f"OpenFilm Studio refused the request: {response.status_code} "
            f"{response.text[:500]}",
            502,
        )
    try:
        said = response.json()
    except ValueError as exc:
        raise StudioError("OpenFilm Studio returned invalid JSON", 502) from exc
    if not isinstance(said, dict):
        raise StudioError("OpenFilm Studio returned an invalid project", 502)
    return said


async def ensure_studio_session(
    film_dir: Path,
    *,
    host_back: str | None = None,
    host_back_label: str | None = None,
    lang: str | None = None,
) -> dict[str, Any]:
    """Open the film folder in Studio and return a signed editor address."""
    # 先把宿主回址验掉：参数不对就直接 400，不必先拉起 Node 进程、登记项目目录。
    back = _validate_host_back(host_back)
    if not back:
        raise StudioError("host_back is required: the editor only runs embedded", 400)
    state = await _ensure_studio()
    said = await _studio_post(
        state,
        "/api/projects",
        {"path": str(film_dir), "create": True},
    )
    project = said.get("project")
    project_id = project.get("id") if isinstance(project, dict) else None
    if not isinstance(project_id, str):
        raise StudioError("OpenFilm Studio returned no project id", 502)
    return {
        "url": studio_open_url(
            origin=str(state["origin"]),
            key=str(state["key"]),
            project_id=project_id,
            host_back=back,
            host_back_label=host_back_label,
            lang=lang,
        ),
        "origin": str(state["origin"]),
    }
