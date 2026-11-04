"""Project-authorized editor proxy and a separate read-only preview origin."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from urllib.parse import quote, urlsplit

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.websockets import WebSocketDisconnect

from novelvideo.api.auth import get_api_user
from novelvideo.freezone import studio
from novelvideo.freezone import studio_proxy as hosted

logger = logging.getLogger(__name__)
router = APIRouter()
_EDITOR_ROUTE = "/projects/{project}/freezone/studio/{canvas}/{node}/editor/{path:path}"
_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
_REQUEST_HEADERS = {"accept", "accept-language", "content-type", "range", "if-range"}
_RESPONSE_HEADERS = {
    "content-type",
    "content-range",
    "accept-ranges",
    "content-disposition",
}
_BODY_LIMIT = 8 * 1024 * 1024
_UPLOAD_LIMIT = 200 * 1024 * 1024


def _origins(connection, *, preview=False):
    if not studio.openfilm_studio_enabled():
        raise HTTPException(404, "not found")
    try:
        origins = hosted.hosted_origins()
    except studio.StudioError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    if origins is None:
        raise HTTPException(404, "not found")
    expected = origins.preview if preview else origins.editor
    if connection.headers.get("host", "").lower() != urlsplit(expected).netloc.lower():
        raise HTTPException(404, "not found")
    return origins


async def _film(project, canvas, node, user):
    from novelvideo.api.routes.freezone import (
        _resolve_freezone_project,
        _studio_route_scope,
    )

    _studio_route_scope(canvas, node)
    _ctx, _username, _name, project_dir, _output = await _resolve_freezone_project(
        project, user
    )
    folder = studio.film_dir_for_node(project_dir, canvas, node)
    try:
        project_id = hosted.film_id(folder)
        state = await studio._ensure_studio()
        hosted.loopback_origin(state["origin"])
        hosted.loopback_origin(state["film_origin"])
        registered_id = await studio._studio_project_id(state, folder)
        if registered_id != project_id:
            raise studio.StudioError(
                "Studio project changed; reopen the workspace", 409
            )
    except studio.StudioError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return folder, project_id, state


async def _body(request):
    result = bytearray()
    async for chunk in request.stream():
        result.extend(chunk)
        if len(result) > _BODY_LIMIT:
            raise HTTPException(413, "Studio request is too large")
    return bytes(result)


async def _upload(request):
    """Match Nginx's media upload limit without buffering a video in the API."""
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _UPLOAD_LIMIT:
            raise HTTPException(413, "Studio upload is too large")
        yield chunk


def _headers(response):
    return {
        **{
            key: value
            for key, value in response.headers.items()
            if key.lower() in _RESPONSE_HEADERS
        },
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-accel-buffering": "no",
    }


async def _close(response, client):
    await response.aclose()
    await client.aclose()


async def _stream(response, client):
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await asyncio.shield(_close(response, client))


@router.api_route(_EDITOR_ROUTE, methods=_METHODS, include_in_schema=False)
async def editor_proxy(
    project: str,
    canvas: str,
    node: str,
    path: str,
    request: Request,
    user: dict = Depends(get_api_user),
):
    origins = _origins(request)
    if request.method not in {"GET", "HEAD"} and user.get("credential_kind") not in {
        "agent_session",
        "local_trusted_agent",
    }:
        if request.headers.get("origin") != origins.editor:
            raise HTTPException(403, "Studio writes must come from the application")
    folder, project_id, state = await _film(project, canvas, node, user)
    if not hosted.allowed_editor_path(path, request.method, project_id):
        raise HTTPException(403, "This operation is unavailable in the hosted editor")
    if any(name in request.query_params for name in {"key", "token", "access_token"}):
        raise HTTPException(400, "Studio launch credentials are not browser parameters")
    prefix = hosted.editor_prefix(project, canvas, node)
    if path in {"api/skills", "api/examples"}:
        # Desktop libraries belong to the server OS account, not this user.
        return JSONResponse(
            {path.split("/")[-1]: []}, headers={"cache-control": "private, no-store"}
        )
    upload = path == f"api/projects/{project_id}/files" and request.method == "PUT"
    body = _upload(request) if upload else await _body(request)
    payload = {}
    try:
        hosted.validate_browser_paths({"path": path})
        for name, value in request.query_params.multi_items():
            hosted.validate_browser_paths({name: value})
        # Studio's readJson parses control bodies regardless of Content-Type.
        # Only the raw file-import endpoint accepts an opaque request stream.
        if not upload and body:
            payload = json.loads(body)
            hosted.validate_browser_paths(payload)
    except studio.StudioError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    except ValueError:
        raise HTTPException(400, "Invalid Studio JSON request") from None
    if path == "api/prefs" and request.method == "PATCH":
        # Only the shared vendor release-notes marker is safe to update here.
        if not isinstance(payload, dict) or set(payload) != {"seenVersion"}:
            raise HTTPException(
                403, "Host preferences cannot be changed through Studio"
            )
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() in _REQUEST_HEADERS
    }
    headers.update({"x-studio-key": state["key"], "accept-encoding": "identity"})
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(None, connect=5, write=60, pool=5), trust_env=False
    )
    upstream_path = f"api/projects/{project_id}" if path == "api/projects" else path
    try:
        upstream = await client.send(
            client.build_request(
                request.method,
                state["origin"] + "/" + quote(upstream_path, safe="/-_.~"),
                params=list(request.query_params.multi_items()),
                headers=headers,
                content=body,
            ),
            stream=True,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "OpenFilm editor request failed: %s (project=%s, node=%s)",
            type(exc).__name__,
            project,
            node,
        )
        await client.aclose()
        raise HTTPException(502, "Studio is temporarily unavailable") from None
    except BaseException:
        # Upload rejection and cancellation can happen while httpx consumes the
        # request stream, before there is a response for _stream to close.
        await asyncio.shield(client.aclose())
        raise
    response_headers = _headers(upstream)
    if upstream.status_code >= 500:
        logger.warning(
            "OpenFilm editor returned %s (project=%s, node=%s)",
            upstream.status_code,
            project,
            node,
        )
        await _close(upstream, client)
        return JSONResponse(
            {"error": "Studio is temporarily unavailable"},
            status_code=502,
            headers={"cache-control": "private, no-store"},
        )
    kind = upstream.headers.get("content-type", "")
    transform = (
        "application/json" in kind
        or "text/html" in kind
        or path.endswith((".js", ".css"))
    )
    if transform:
        try:
            raw = await upstream.aread()
            if "application/json" in kind:
                value = json.loads(raw)
                if path == "api/projects" and upstream.is_success:
                    value = {"projects": [value["project"]]}
                value = hosted.rewrite_json(
                    value,
                    state=state,
                    origins=origins,
                    prefix=prefix,
                    folder=folder,
                )
                return JSONResponse(
                    value, status_code=upstream.status_code, headers=response_headers
                )
            text = raw.decode()
            if "text/html" in kind:
                text = hosted.editor_document(text, prefix)
                response_headers["content-security-policy"] = (
                    "frame-ancestors 'self'; object-src 'none'; base-uri 'none'"
                )
                response_headers["permissions-policy"] = (
                    f'autoplay=(self "{origins.preview}")'
                )
            elif ".dramaclaw" in path:
                text = hosted.editor_chunk(text, prefix)
            elif path.endswith(".css"):
                text = text.replace("/assets/", prefix + "/assets/")
            return Response(
                text, status_code=upstream.status_code, headers=response_headers
            )
        except studio.StudioError as exc:
            raise HTTPException(exc.status_code, str(exc)) from exc
        except (ValueError, UnicodeError):
            raise HTTPException(502, "Studio returned an invalid response") from None
        finally:
            await _close(upstream, client)
    return StreamingResponse(
        _stream(upstream, client),
        status_code=upstream.status_code,
        headers=response_headers,
    )


@router.websocket(_EDITOR_ROUTE)
async def editor_events(
    websocket: WebSocket, project: str, canvas: str, node: str, path: str
):
    try:
        origins = _origins(websocket)
        if websocket.headers.get("origin") != origins.editor:
            raise HTTPException(403, "Studio socket origin is not the application")
        # Reuse session verification and the central project scope boundary.
        scope = {**websocket.scope, "type": "http", "method": "GET"}
        user = await get_api_user(Request(scope))
        folder, project_id, state = await _film(project, canvas, node, user)
        if path not in {"api/events", f"api/projects/{project_id}/events"}:
            raise HTTPException(403, "This event stream is not the current film")
        upstream_url = (
            state["origin"].replace("http://", "ws://", 1)
            + f"/api/projects/{project_id}/events"
        )
        async with websockets.connect(
            upstream_url,
            additional_headers={"x-studio-key": state["key"]},
            proxy=None,
            open_timeout=5,
            max_size=_BODY_LIMIT,
        ) as upstream:
            await websocket.accept()
            prefix = hosted.editor_prefix(project, canvas, node)

            async def receive():
                while True:
                    message = await websocket.receive_text()
                    await upstream.send(message)

            async def send():
                async for message in upstream:
                    value = hosted.rewrite_json(
                        json.loads(message),
                        state=state,
                        origins=origins,
                        prefix=prefix,
                        folder=folder,
                    )
                    await websocket.send_json(value)

            tasks = [asyncio.create_task(receive()), asyncio.create_task(send())]
            try:
                done, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except HTTPException:
        await websocket.close(code=1008)
    except (WebSocketDisconnect, websockets.ConnectionClosed):
        pass
    except (OSError, httpx.HTTPError, websockets.WebSocketException, ValueError):
        logger.warning("OpenFilm event stream disconnected", exc_info=True)
        await websocket.close(code=1011)


@router.api_route(
    "/openfilm-preview/{path:path}",
    methods=["GET", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def preview_proxy(path: str, request: Request):
    origins = _origins(request, preview=True)
    # This is the existing Studio HMAC capability, not its API launch key. It
    # permits only read-only files for the named film, on a separate origin.
    if not re.fullmatch(r"p/[A-Za-z0-9_-]{24}(?:/.*)?", path) or "\\" in path:
        raise HTTPException(404, "not found")
    if any(segment in {".", ".."} for segment in path.split("/")):
        raise HTTPException(404, "not found")
    headers = {
        "access-control-allow-origin": origins.editor,
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Range",
        "access-control-expose-headers": "Content-Range, Accept-Ranges",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": (
            "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; "
            "style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' blob:; "
            "object-src 'none'; form-action 'none'; base-uri 'none'; "
            f"frame-ancestors {origins.editor}; sandbox allow-scripts allow-same-origin"
        ),
    }
    if request.method == "OPTIONS":
        if request.headers.get("origin") != origins.editor:
            raise HTTPException(403, "Unexpected preview origin")
        return Response(status_code=204, headers=headers)
    try:
        # A signed read-only preview must not start a process on an anonymous
        # request. The authenticated session/editor routes own startup.
        state = studio._read_state()
        if not state:
            raise HTTPException(404, "Open the compose workspace again")
        hosted.loopback_origin(state["origin"])
        target = hosted.loopback_origin(state["film_origin"])
    except studio.StudioError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5), trust_env=False)
    try:
        upstream = await client.send(
            client.build_request(
                request.method,
                target + "/" + quote(path, safe="/-_.~"),
                params=list(request.query_params.multi_items()),
                headers={
                    **{
                        key: value
                        for key, value in request.headers.items()
                        if key.lower() in _REQUEST_HEADERS
                    },
                    "accept-encoding": "identity",
                },
            ),
            stream=True,
        )
    except httpx.HTTPError as exc:
        logger.warning("OpenFilm preview request failed: %s", type(exc).__name__)
        await client.aclose()
        raise HTTPException(502, "Studio preview is temporarily unavailable") from None
    headers.update(
        {
            key: value
            for key, value in _headers(upstream).items()
            if key in _RESPONSE_HEADERS
        }
    )
    if "text/html" in upstream.headers.get("content-type", ""):
        try:
            text = (await upstream.aread()).decode()
            text = text.replace(state["origin"], origins.editor)
            text = text.replace(
                state["film_origin"], origins.preview + hosted.PREVIEW_PREFIX
            )
            return Response(text, status_code=upstream.status_code, headers=headers)
        finally:
            await _close(upstream, client)
    return StreamingResponse(
        _stream(upstream, client),
        status_code=upstream.status_code,
        headers=headers,
    )
