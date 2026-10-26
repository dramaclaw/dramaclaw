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
from urllib.parse import quote, urlencode, urlsplit

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
            muted = item.muted or (track.kind == "video" and not keep_original_audio)
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
            raise StudioError(f"could not start OpenFilm Studio: {exc}", 503) from exc

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
    raise StudioError(f"OpenFilm Studio failed to start: {tail or 'no log'}", 503)


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


# ---------------------------------------------------------------------------
# Agent access to a compose node's film.
#
# Once a compose node has been opened in the workspace, its film.html is the
# truth of the cut: the person edits it in Studio and the agent edits it through
# Studio's clip-id operations below. Nothing here touches the node's
# draftTimeline, so the canvas seed and the hand-cut film never fight.
# ---------------------------------------------------------------------------

_IMPORT_SUFFIXES = _MEDIA_SUFFIXES | {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_STILL_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_SOUND_SUFFIXES = {
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
_IMPORT_PREFIX = "import-"
_PROBE_LIMIT = 40
_MAX_EDIT_OPS = 200
_EXPORT_POLL_SECONDS = 1.0
_EXPORT_TIMEOUT_SECONDS = 30 * 60
_EXPORT_TERMINAL = {"done", "failed", "cancelled"}


def film_dir_for_node(project_dir: Path, canvas_id: str, node_id: str) -> Path:
    """The film folder a compose node is cut in (it may not exist yet)."""
    return _film_dir(Path(project_dir), canvas_id, node_id)


def studio_film_exists(film_dir: Path) -> bool:
    return (Path(film_dir) / "film.html").is_file()


def studio_film_was_edited(film_dir: Path) -> bool:
    """Whether the film no longer hashes to what the canvas timeline built.

    An export of such a node must render the film, not the canvas timeline:
    the timeline no longer describes the cut.
    """
    return _film_was_edited(Path(film_dir))


def studio_export_film_dir(
    project_dir: Path, canvas_id: str, node_id: str
) -> Path | None:
    """The film to render for a compose export, or None to keep the ffmpeg path.

    Only a film that was cut by hand (in Studio, or by the agent through it)
    takes over the export; an untouched film is the timeline itself, and the
    timeline keeps rendering exactly as before.
    """
    if not canvas_id or not node_id:
        return None
    try:
        film_dir = _film_dir(Path(project_dir), canvas_id, node_id)
    except StudioError:
        return None
    if not studio_film_exists(film_dir) or not studio_film_was_edited(film_dir):
        return None
    return film_dir


def _require_film(project_dir: Path, canvas_id: str, node_id: str) -> Path:
    film_dir = _film_dir(Path(project_dir), canvas_id, node_id)
    if not studio_film_exists(film_dir):
        raise StudioError(
            "this compose node has no Studio film yet: open its compose workspace "
            "once so the timeline becomes a film",
            404,
        )
    return film_dir


async def _studio_request(
    state: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = 20.0,
) -> tuple[int, Any]:
    """One call to Studio's API. Returns (status, decoded body); 4xx is the caller's."""
    origin = str(state["origin"]).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.request(
                method,
                f"{origin}{path}",
                json=body,
                headers={"x-studio-key": str(state["key"])},
            )
    except httpx.HTTPError as exc:
        raise StudioError(f"OpenFilm Studio request failed: {exc}", 502) from exc
    try:
        said = response.json()
    except ValueError:
        said = {"error": response.text[:500]}
    return response.status_code, said


def _studio_error_text(said: Any, fallback: str) -> str:
    if isinstance(said, dict):
        for key in ("error", "message"):
            value = said.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


async def _studio_project_id(state: dict[str, Any], film_dir: Path) -> str:
    said = await _studio_post(
        state, "/api/projects", {"path": str(film_dir), "create": True}
    )
    project = said.get("project")
    project_id = project.get("id") if isinstance(project, dict) else None
    if not isinstance(project_id, str) or not project_id:
        raise StudioError("OpenFilm Studio returned no project id", 502)
    return project_id


def _project_api(project_id: str, suffix: str = "") -> str:
    path = f"/api/projects/{quote(project_id, safe='')}"
    return f"{path}/{suffix}" if suffix else path


def _clip_kind(src: str, raw: dict[str, Any]) -> str:
    if raw.get("sound") is True:
        return "sound"
    suffix = Path(str(src).split("#", 1)[0]).suffix.lower()
    if suffix in _SOUND_SUFFIXES:
        return "sound"
    if suffix in _STILL_SUFFIXES:
        return "still"
    if suffix in _MEDIA_SUFFIXES:
        return "video"
    return "page"


def _number_or_none(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _pair_or_none(value: Any) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 2:
        return None
    first, second = _number_or_none(value[0]), _number_or_none(value[1])
    if first is None or second is None:
        return None
    return [first, second]


def _node_label(node: dict[str, Any] | None) -> str:
    data = node.get("data") if isinstance(node, dict) else None
    if not isinstance(data, dict):
        return ""
    for key in ("label", "displayName", "title", "name"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _source_index(film_dir: Path, canvas: dict[str, Any] | None, node_id: str):
    """Map an asset path to the canvas it came from: item ids, node ids, labels."""
    manifest = _read_manifest(film_dir / "manifest.json") or {}
    items: list[dict[str, Any]] = []
    for track in manifest.get("tracks") or []:
        if isinstance(track, dict):
            items.extend(
                item for item in track.get("items") or [] if isinstance(item, dict)
            )
    sources: dict[str, dict[str, Any]] = {}
    assets = manifest.get("assets") if isinstance(manifest.get("assets"), list) else []
    for index, asset_name in enumerate(assets):
        item = items[index] if index < len(items) else {}
        sources[f"assets/{asset_name}"] = {
            "item_id": str(item.get("item_id") or ""),
            "source_url": str(item.get("source_url") or ""),
        }
    imports = manifest.get("imports")
    if isinstance(imports, dict):
        for asset_name, info in imports.items():
            if isinstance(info, dict):
                sources[f"assets/{asset_name}"] = {
                    "item_id": "",
                    "source_url": str(info.get("source_url") or ""),
                    "node_id": str(info.get("node_id") or ""),
                    "label": str(info.get("label") or ""),
                }

    nodes_by_id: dict[str, dict[str, Any]] = {}
    draft_clips: dict[str, dict[str, Any]] = {}
    if isinstance(canvas, dict):
        for node in canvas.get("nodes") or []:
            if isinstance(node, dict) and isinstance(node.get("id"), str):
                nodes_by_id[node["id"]] = node
        compose = nodes_by_id.get(node_id)
        data = compose.get("data") if isinstance(compose, dict) else None
        draft = data.get("draftTimeline") if isinstance(data, dict) else None
        tracks = draft.get("tracks") if isinstance(draft, dict) else None
        for track in tracks or []:
            if not isinstance(track, dict):
                continue
            for clip in track.get("clips") or []:
                if isinstance(clip, dict) and isinstance(clip.get("id"), str):
                    draft_clips[clip["id"]] = clip

    for info in sources.values():
        item_id = info.get("item_id") or ""
        clip = draft_clips.get(item_id) if item_id else None
        if clip is not None:
            source_node = str(clip.get("nodeId") or "")
            if source_node:
                info["node_id"] = source_node
            name = clip.get("displayName")
            if isinstance(name, str) and name.strip():
                info["label"] = name.strip()
        source_node = info.get("node_id") or ""
        if source_node and not info.get("label"):
            info["label"] = _node_label(nodes_by_id.get(source_node))
        info.setdefault("node_id", "")
        info.setdefault("label", "")
    return sources


def _summarize_film(
    doc: Any,
    *,
    sources: dict[str, dict[str, Any]],
    probes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    stage_raw = doc.get("stage") if isinstance(doc, dict) else None
    stage = {
        "width": (
            int(stage_raw.get("w"))
            if isinstance(stage_raw, dict) and _number_or_none(stage_raw.get("w"))
            else 1920
        ),
        "height": (
            int(stage_raw.get("h"))
            if isinstance(stage_raw, dict) and _number_or_none(stage_raw.get("h"))
            else 1080
        ),
    }
    tracks_out: list[dict[str, Any]] = []
    film_end = 0.0
    raw_tracks = doc.get("tracks") if isinstance(doc, dict) else None
    for index, track in enumerate(raw_tracks or []):
        if not isinstance(track, dict):
            continue
        clips_out: list[dict[str, Any]] = []
        for raw in track.get("clips") or []:
            if not isinstance(raw, dict):
                continue
            src = str(raw.get("src") or "")
            kind = _clip_kind(src, raw)
            at = _number_or_none(raw.get("at")) or 0.0
            time = _pair_or_none(raw.get("time"))
            speed = _number_or_none(raw.get("speed")) or 1.0
            probe = probes.get(src.split("#", 1)[0], {})
            source_duration = _number_or_none(probe.get("duration"))
            if time is not None:
                length = max(0.0, time[1] - time[0])
            elif isinstance(raw.get("time"), list) and len(raw["time"]) == 1:
                start = _number_or_none(raw["time"][0]) or 0.0
                length = max(0.0, source_duration - start) if source_duration else None
            else:
                length = source_duration
            duration = (length / speed) if length is not None and speed > 0 else None
            fade = None
            overrides = raw.get("overrides")
            if isinstance(overrides, list):
                for entry in overrides:
                    if isinstance(entry, dict) and "at" not in entry:
                        fade = _pair_or_none(entry.get("fade"))
            clip: dict[str, Any] = {
                "id": str(raw.get("id") or ""),
                "kind": kind,
                "src": src,
                "at": round(at, 3),
                "time": time,
                "duration": round(duration, 3) if duration is not None else None,
                "end": round(at + duration, 3) if duration is not None else None,
                "speed": speed,
                "volume": _number_or_none(raw.get("volume")),
                "fade": fade,
                "box": raw.get("box") if isinstance(raw.get("box"), dict) else None,
                "source": sources.get(src.split("#", 1)[0]) or {},
            }
            if duration is not None:
                film_end = max(film_end, at + duration)
            clips_out.append(clip)
        tracks_out.append(
            {
                "index": index,
                "locked": bool(track.get("locked")),
                "hidden": bool(track.get("hidden")),
                "muted": bool(track.get("muted")),
                "clips": clips_out,
            }
        )
    return {"stage": stage, "duration": round(film_end, 3), "tracks": tracks_out}


def _clip_sources(doc: Any) -> list[str]:
    seen: list[str] = []
    raw_tracks = doc.get("tracks") if isinstance(doc, dict) else None
    for track in raw_tracks or []:
        if not isinstance(track, dict):
            continue
        for raw in track.get("clips") or []:
            if not isinstance(raw, dict):
                continue
            src = str(raw.get("src") or "").split("#", 1)[0]
            if src and src not in seen and _clip_kind(src, raw) != "page":
                seen.append(src)
    return seen


async def _probe_media(
    state: dict[str, Any], project_id: str, paths: list[str]
) -> dict[str, dict[str, Any]]:
    probes: dict[str, dict[str, Any]] = {}
    for path in paths[:_PROBE_LIMIT]:
        query = urlencode({"path": path, "what": "probe"})
        try:
            status, said = await _studio_request(
                state, "GET", f"{_project_api(project_id, 'media')}?{query}"
            )
        except StudioError:
            continue
        if status < 400 and isinstance(said, dict):
            probes[path] = {
                key: said.get(key)
                for key in ("duration", "width", "height", "fps", "audio")
                if key in said
            }
    return probes


def _media_list(probes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"path": path, **facts} for path, facts in probes.items()]


async def read_studio_film(
    *,
    project_dir: Path,
    state_dir: Path,
    canvas_id: str,
    node_id: str,
) -> dict[str, Any]:
    """The film of a compose node as the agent reads it: clips by id, with where they came from."""
    from novelvideo.freezone import canvas_store

    film_dir = _require_film(project_dir, canvas_id, node_id)
    state = await _ensure_studio()
    project_id = await _studio_project_id(state, film_dir)
    status, said = await _studio_request(state, "GET", _project_api(project_id))
    if status >= 400 or not isinstance(said, dict):
        raise StudioError(
            f"OpenFilm Studio could not read the film: {_studio_error_text(said, str(status))}",
            502,
        )
    doc = said.get("doc") if isinstance(said.get("doc"), dict) else said.get("value")
    try:
        canvas = canvas_store.read_canvas(Path(state_dir), canvas_id)
    except Exception:  # noqa: BLE001 - a corrupt canvas only loses the labels
        canvas = None
    sources = _source_index(film_dir, canvas, node_id)
    probes = await _probe_media(state, project_id, _clip_sources(doc))
    problems = said.get("problems") if isinstance(said.get("problems"), list) else []
    return {
        "ok": True,
        "status": "studio_film",
        "node_id": node_id,
        "rev": str(said.get("rev") or ""),
        "problems": problems,
        "film": _summarize_film(doc, sources=sources, probes=probes),
        "media": _media_list(probes),
        "studio": {
            "project_id": project_id,
            "edited_by_hand": studio_film_was_edited(film_dir),
        },
    }


def _check_ops(ops: Any) -> list[dict[str, Any]]:
    if not isinstance(ops, list) or not ops:
        raise StudioError("ops must be a non-empty list of film operations", 400)
    if len(ops) > _MAX_EDIT_OPS:
        raise StudioError(f"at most {_MAX_EDIT_OPS} operations per edit", 400)
    clean: list[dict[str, Any]] = []
    for index, op in enumerate(ops):
        if not isinstance(op, dict) or not isinstance(op.get("op"), str):
            raise StudioError(f"ops[{index}] must be an object with an 'op' name", 400)
        clean.append(op)
    return clean


async def edit_studio_film(
    *,
    project_dir: Path,
    state_dir: Path,
    canvas_id: str,
    node_id: str,
    base_rev: str | None,
    ops: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply clip-id operations to the film through Studio.

    A conflict (the film changed since ``base_rev`` and an operation names a
    clip that is gone) or an invalid edit comes back as ``ok: False`` with the
    reason, never as an exception: the agent re-reads the film and decides.
    """
    from novelvideo.freezone import canvas_store

    clean_ops = _check_ops(ops)
    film_dir = _require_film(project_dir, canvas_id, node_id)
    state = await _ensure_studio()
    project_id = await _studio_project_id(state, film_dir)
    status, said = await _studio_request(
        state,
        "POST",
        _project_api(project_id, "edit"),
        {"base": base_rev or None, "ops": clean_ops},
    )
    if status in {409, 422}:
        conflict = status == 409
        return {
            "ok": False,
            "status": "studio_edit_conflict" if conflict else "studio_edit_invalid",
            "code": "studio_edit_conflict" if conflict else "studio_edit_invalid",
            "error": _studio_error_text(said, "Studio refused the edit"),
            "node_id": node_id,
            "rev": str(said.get("rev") or "") if isinstance(said, dict) else "",
            "retryable": conflict,
            "next_action": ("reread_film_and_retry" if conflict else "fix_operations"),
        }
    if status >= 400 or not isinstance(said, dict):
        raise StudioError(
            f"OpenFilm Studio refused the edit: {_studio_error_text(said, str(status))}",
            502,
        )
    doc = said.get("doc") if isinstance(said.get("doc"), dict) else said.get("value")
    try:
        canvas = canvas_store.read_canvas(Path(state_dir), canvas_id)
    except Exception:  # noqa: BLE001
        canvas = None
    sources = _source_index(film_dir, canvas, node_id)
    probes = await _probe_media(state, project_id, _clip_sources(doc))
    return {
        "ok": True,
        "status": "studio_film_edited",
        "node_id": node_id,
        "rev": str(said.get("rev") or ""),
        "rebased": bool(said.get("rebased")),
        "ops_applied": len(clean_ops),
        "film": _summarize_film(doc, sources=sources, probes=probes),
        "media": _media_list(probes),
    }


def _resolve_import_source(source_url: str, project_dir: Path) -> Path:
    try:
        path = resolve_static_url_to_path(source_url, project_dir)
    except ValueError as exc:
        raise StudioError(str(exc), 400) from exc
    if not path.exists():
        raise StudioError(f"media source not found: {source_url}", 404)
    if not path.is_file():
        raise StudioError(f"media source is not a file: {source_url}", 400)
    suffix = path.suffix.lower()
    if suffix not in _IMPORT_SUFFIXES:
        raise StudioError(f"unsupported media type: {suffix or 'none'}", 400)
    return path


def _record_import(
    film_dir: Path, asset_name: str, *, source_url: str, node_id: str, label: str
) -> None:
    manifest = _read_manifest(film_dir / "manifest.json")
    if manifest is None:
        return
    imports = (
        manifest.get("imports") if isinstance(manifest.get("imports"), dict) else {}
    )
    imports = {
        **imports,
        asset_name: {"source_url": source_url, "node_id": node_id, "label": label},
    }
    _write_text_atomic(
        film_dir / "manifest.json",
        json.dumps({**manifest, "imports": imports}, ensure_ascii=False, indent=2)
        + "\n",
    )


async def import_media_to_film(
    *,
    project_dir: Path,
    canvas_id: str,
    node_id: str,
    source_url: str,
    source_node_id: str = "",
    label: str = "",
) -> dict[str, Any]:
    """Copy a project media file into the film's assets so a clip can use it."""
    film_dir = _require_film(project_dir, canvas_id, node_id)
    source = _resolve_import_source(source_url, Path(project_dir))
    digest = hashlib.sha1(source_url.encode("utf-8")).hexdigest()[:8]
    stem = _safe_segment((label or source.stem)[:24], "media")[:24]
    asset_name = f"{_IMPORT_PREFIX}{digest}-{stem}{source.suffix.lower()}"
    destination = film_dir / "assets" / asset_name
    with _BUILD_LOCK:
        if not destination.is_file():
            _copy_asset(source, destination)
        _record_import(
            film_dir,
            asset_name,
            source_url=source_url,
            node_id=source_node_id,
            label=label,
        )
    kind = _clip_kind(asset_name, {})
    facts: dict[str, Any] = {}
    try:
        state = await _ensure_studio()
        project_id = await _studio_project_id(state, film_dir)
        facts = (await _probe_media(state, project_id, [f"assets/{asset_name}"])).get(
            f"assets/{asset_name}", {}
        )
    except StudioError:
        facts = {}
    return {
        "ok": True,
        "status": "studio_media_imported",
        "node_id": node_id,
        "asset_path": f"assets/{asset_name}",
        "kind": kind,
        "media": [{"path": f"assets/{asset_name}", **facts}],
        "source": {"source_url": source_url, "node_id": source_node_id, "label": label},
    }


async def export_studio_film(
    *,
    film_dir: Path,
    output_path: Path,
    fps: int = 30,
    poll_seconds: float = _EXPORT_POLL_SECONDS,
    timeout_seconds: float = _EXPORT_TIMEOUT_SECONDS,
) -> Path:
    """Render the film through Studio's export queue into ``output_path`` (an mp4).

    Studio keeps its own list of exports and offers to open each file where it
    wrote it, so the render stays in ``studio-exports/`` beside the job output;
    the job's mp4 is a hard link to it (a copy when the disk cannot link).
    """
    film_dir = Path(film_dir)
    if not studio_film_exists(film_dir):
        raise StudioError("the compose node has no Studio film to export", 404)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    folder = output_path.parent / "studio-exports"
    folder.mkdir(parents=True, exist_ok=True)

    state = await _ensure_studio()
    project_id = await _studio_project_id(state, film_dir)
    ask: dict[str, Any] = {"kind": "video", "codec": "h264"}
    if fps:
        ask["fps"] = int(fps)
    status, said = await _studio_request(
        state,
        "POST",
        _project_api(project_id, "exports"),
        {"jobs": [ask], "folder": str(folder)},
    )
    if status >= 400 or not isinstance(said, dict):
        raise StudioError(
            f"OpenFilm Studio refused the export: {_studio_error_text(said, str(status))}",
            502,
        )
    jobs = said.get("exports")
    job = (
        jobs[0]
        if isinstance(jobs, list) and jobs and isinstance(jobs[0], dict)
        else None
    )
    job_id = str(job.get("id") or "") if job else ""
    if not job_id:
        raise StudioError("OpenFilm Studio returned no export job", 502)

    deadline = time.monotonic() + timeout_seconds
    while True:
        status, said = await _studio_request(
            state, "GET", _project_api(project_id, "exports")
        )
        current = None
        if status < 400 and isinstance(said, dict):
            for entry in said.get("exports") or []:
                if isinstance(entry, dict) and entry.get("id") == job_id:
                    current = entry
                    break
        if current is None:
            raise StudioError("OpenFilm Studio lost the export job", 502)
        state_name = str(current.get("status") or "")
        if state_name in _EXPORT_TERMINAL:
            if state_name != "done":
                raise StudioError(
                    f"OpenFilm Studio export {state_name}: "
                    f"{str(current.get('error') or '').strip() or 'no detail'}",
                    502,
                )
            outputs = [
                Path(str(item))
                for item in current.get("outputs") or []
                if isinstance(item, str) and str(item).lower().endswith(".mp4")
            ]
            rendered = next((item for item in outputs if item.is_file()), None)
            if rendered is None:
                raise StudioError("OpenFilm Studio export produced no mp4", 502)
            output_path.unlink(missing_ok=True)
            try:
                os.link(rendered, output_path)
            except OSError:
                shutil.copyfile(rendered, output_path)
            return output_path
        if time.monotonic() > deadline:
            await _studio_request(
                state, "DELETE", _project_api(project_id, f"exports/{job_id}")
            )
            raise StudioError("OpenFilm Studio export timed out", 504)
        await asyncio.sleep(poll_seconds)
