"""Browser-facing URLs for the hosted Studio; its launch key stays on the API host."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from novelvideo.freezone.studio import StudioError
from novelvideo.shared import runtime_env

PREVIEW_PREFIX = "/api/v1/openfilm-preview"
_ID = re.compile(r"^[\w-]{6,40}$", re.ASCII)
_READ = {"GET", "HEAD"}


def _public_origin(name: str) -> str:
    value = os.environ.get(name, "").strip().rstrip("/")
    parts = urlsplit(value)
    local = parts.hostname in {"localhost", "127.0.0.1", "::1"}
    try:
        parts.port
    except ValueError as exc:
        raise StudioError(f"{name} has an invalid port", 503) from exc
    if (
        parts.scheme not in ({"http", "https"} if local else {"https"})
        or not parts.netloc
        or parts.username
        or parts.password
        or parts.path
        or parts.query
        or parts.fragment
        or any(c.isspace() or ord(c) < 32 for c in value)
        or (not local and not re.fullmatch(r"[A-Za-z0-9.-]+", parts.hostname or ""))
    ):
        raise StudioError(f"{name} must be a public HTTPS origin", 503)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    default_port = 443 if parts.scheme == "https" else 80
    return f"{parts.scheme}://{host}" + (
        f":{port}" if port and port != default_port else ""
    )


@dataclass(frozen=True)
class HostedOrigins:
    editor: str
    preview: str


def hosted_origins() -> HostedOrigins | None:
    names = (
        "SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN",
        "SUPERTALE_OPENFILM_STUDIO_PREVIEW_ORIGIN",
    )
    if not any(os.environ.get(name, "").strip() for name in names):
        if runtime_env.is_ce_effective():
            return None
        raise StudioError(
            "Hosted OpenFilm requires editor and isolated preview origins", 503
        )
    origins = HostedOrigins(*(_public_origin(name) for name in names))
    if origins.editor == origins.preview:
        raise StudioError(
            "OpenFilm preview must use an origin separate from the application", 503
        )
    return origins


def editor_prefix(project: str, canvas: str, node: str) -> str:
    return (
        f"/api/v1/projects/{quote(project, safe='')}/freezone/studio/"
        f"{quote(canvas, safe='')}/{quote(node, safe='')}/editor"
    )


def public_session(session: dict, *, project: str, canvas: str, node: str) -> dict:
    origins = hosted_origins()
    if origins is None:
        return session
    # The local bridge has already validated this target and registered the film.
    target = parse_qs(urlsplit(session["url"]).query).get("to", [""])[0]
    parts = urlsplit(target)
    if not re.fullmatch(r"/projects/[\w-]{6,40}", parts.path, re.ASCII):
        raise StudioError("Studio returned an invalid project address", 502)
    if "key" in parse_qs(parts.query):
        raise StudioError("Studio returned an unexpected credential", 502)
    prefix = editor_prefix(project, canvas, node)
    return {"url": origins.editor + prefix + target, "origin": origins.editor}


def loopback_origin(value: str) -> str:
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError as exc:
        raise StudioError("Hosted Studio has an invalid local port", 503) from exc
    if (
        parts.scheme != "http"
        or parts.hostname not in {"localhost", "127.0.0.1", "::1"}
        or not port
        or parts.username
        or parts.password
        or parts.path
        or parts.query
        or parts.fragment
    ):
        raise StudioError("Hosted Studio upstream must be a local listener", 503)
    return value


def validate_browser_paths(value) -> None:
    """File edits must not turn the Studio history repository into executable Git config."""
    names = {"path", "paths", "name", "src", "from", "to", "into", "folder"}

    def check(item):
        if isinstance(item, str):
            segments = unquote(item).replace("\\", "/").split("/")
            if any(
                s.rstrip(". ").lower() == ".git" or re.fullmatch(r"git~\d+", s, re.I)
                for s in segments
            ):
                raise StudioError("Git internals cannot be edited through Studio", 403)
        elif isinstance(item, list):
            for child in item:
                check(child)

    if isinstance(value, dict):
        for key, item in value.items():
            if key in names or (
                key == "value" and value.get("field") in {"src", "path"}
            ):
                check(item)
            if isinstance(item, (dict, list)):
                validate_browser_paths(item)
    elif isinstance(value, list):
        for child in value:
            validate_browser_paths(child)


def film_id(folder: Path) -> str:
    try:
        value = (folder / ".film/id").read_text().strip()
    except OSError as exc:
        raise StudioError(
            "Open this compose workspace before accessing its editor", 404
        ) from exc
    if not _ID.fullmatch(value):
        raise StudioError("Invalid Studio project identifier", 502)
    return value


def allowed_editor_path(path: str, method: str, project_id: str) -> bool:
    """Expose the current film, never Studio's host filesystem or other projects."""
    plain = unquote(path)
    if "\\" in plain or any(p in {".", ".."} for p in plain.split("/")):
        return False
    if any(ord(c) < 32 for c in plain):
        return False
    if plain in {"", f"projects/{project_id}"} or plain.startswith("assets/"):
        return method in _READ
    if plain == "api/prefs":
        return method in _READ | {"PATCH"}
    if plain in {
        "api/health",
        "api/version",
        "api/projects",
        "api/examples",
        "api/skills",
    }:
        return method in _READ
    prefix = f"api/projects/{project_id}"
    if plain == prefix:
        return method in _READ
    if not plain.startswith(prefix + "/"):
        return False
    rest = plain[len(prefix) + 1 :]
    # Rendering must go through Dramaclaw's existing task/canvas writeback API,
    # not the desktop Studio queue in the API pod.
    if rest == "exports":
        return method in _READ
    if rest.startswith("exports/"):
        return False
    # Saved is the OS account's library, shared by every Studio project.
    if rest == "saved" or rest.startswith("saved/"):
        return False
    # Host-local dialogs/imports accept absolute paths. Project deletion, rename,
    # arbitrary disk exports and app launching are not remote browser operations.
    if rest in {"files/bring", "files/relink", "locate", "reveal", "folder"}:
        return False
    safe_roots = {
        "opened",
        "edit",
        "settings",
        "markers",
        "media",
        "files",
        "cover",
        "history",
        "fonts",
        "proxies",
        "preview-cache",
        "events",
        "subtitles",
        "captions",
        "transition-pages",
        "folders",
    }
    return rest.split("/", 1)[0] in safe_roots


def rewrite_json(
    value, *, state: dict, origins: HostedOrigins, prefix: str, folder: Path
):
    if isinstance(value, dict):
        return {
            key: (
                item
                if key in {"doc", "value", "text", "settings", "markers"}
                else None
                if key == "projectsFolder"
                else "film/.film/exports"
                if key == "folder" and isinstance(item, str) and item.startswith("/")
                else rewrite_json(
                    item, state=state, origins=origins, prefix=prefix, folder=folder
                )
            )
            for key, item in value.items()
            if not (key == "key" and item == state.get("key"))
        }
    if isinstance(value, list):
        return [
            rewrite_json(
                item, state=state, origins=origins, prefix=prefix, folder=folder
            )
            for item in value
        ]
    if isinstance(value, str):
        if value == state["film_origin"]:
            return origins.preview + PREVIEW_PREFIX
        if value == state["origin"]:
            return origins.editor + prefix
        if value.startswith(state["film_origin"] + "/"):
            return origins.preview + PREVIEW_PREFIX + value[len(state["film_origin"]) :]
        if value.startswith(state["origin"] + "/"):
            return origins.editor + prefix + value[len(state["origin"]) :]
        if value.startswith("/api/"):
            return prefix + value
        if value.startswith(str(folder)):
            return "film" + value[len(str(folder)) :]
        if value.startswith("/"):
            return Path(value).name
    return value


def editor_document(body: str, prefix: str) -> str:
    base = json.dumps(prefix).replace("<", "\\u003c")
    # The vendored router uses origin-root URLs. Scope its history to this film
    # without changing the host application's own window or its routes.
    bootstrap = """<script>(()=>{const base=BASE;
for(const name of ['pushState','replaceState']){const original=history[name];
history[name]=function(state,title,to){if(to!=null){const u=new URL(to,location.href);
if(u.origin===location.origin){if(!u.pathname.startsWith(base+'/'))u.pathname=base+u.pathname;
const old=new URLSearchParams(location.search);for(const k of ['hostBack','hostBackLabel','lang']){
if(!u.searchParams.has(k)&&old.has(k))u.searchParams.set(k,old.get(k));}to=u.href;}}
return original.call(this,state,title,to);};}})();</script>""".replace("BASE", base)
    return (
        body.replace('src="/assets/', f'src="{prefix}/assets/')
        .replace('href="/assets/', f'href="{prefix}/assets/')
        .replace("<head>", "<head>" + bootstrap, 1)
    )


def editor_chunk(body: str, prefix: str) -> str:
    # Exact counts make a vendor update fail closed instead of silently sending
    # browser traffic to the host application's unrelated /api or /projects.
    socket_path = "${location.host}/api/"
    export_click = 'onClick:()=>{b?i.showError(`${r("project.filmCannotExport")} ${b}`):At>0?Ou(!0):i.show(r("project.filmNotReady"))}'
    if (
        body.count("location.pathname") != 3
        or body.count(socket_path) != 1
        or body.count(export_click) != 1
    ):
        raise StudioError(
            "The vendored Studio router needs a hosted adapter update", 503
        )
    body = body.replace('"/api/', '"' + prefix + "/api/")
    body = body.replace("`/api/", "`" + prefix + "/api/")
    body = body.replace(socket_path, "${location.host}" + prefix + "/api/")
    body = body.replace("/assets/", prefix + "/assets/")
    body = body.replace(
        export_click,
        export_click.replace(
            "Ou(!0)",
            'window.parent.postMessage({type:"dramaclaw:studio-export"},location.origin)',
        ),
    )
    return body.replace("location.pathname", f"location.pathname.slice({len(prefix)})")
