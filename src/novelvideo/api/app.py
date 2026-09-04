"""Standalone ASGI app for the 2.0 REST API."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from novelvideo.api import OPENAPI_TAGS, api_router, register_verification_routes
from novelvideo.api.auth import get_api_user
from novelvideo.api.routes.files import preview_project_media_file
from novelvideo.ports.authz import AuthzError, authz_error_payload
from novelvideo.shared.billing_errors import (
    BILLING_RULE_NOT_CONFIGURED_MESSAGE,
    INSUFFICIENT_CREDITS_MESSAGE,
    BillingError,
    BillingRuleNotConfiguredError,
    InsufficientCreditsError,
    billing_error_payload,
    billing_rule_not_configured_payload,
    insufficient_credits_payload,
)
from novelvideo.shared.api_coverage import mount_api_coverage_middleware
from novelvideo.task_backend.limit_logging import log_task_limit_rejection
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)
from novelvideo.utils.upload_safety import MAX_PROJECT_UPLOAD_BYTES

logger = logging.getLogger("novelvideo.api.app")

# Per durability plan §N: reject oversized request bodies before they
# reach a handler. 5 MB covers the largest legitimate freezone canvas
# (50k nodes × ~80 bytes JSON each) with comfortable headroom; anything
# bigger is almost certainly a runaway client / DoS attempt.
MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_REQUEST_BODY_BYTES = MAX_PROJECT_UPLOAD_BYTES
_RESOURCE_REQUEST_COUNTS: Counter[str] = Counter()
_RESOURCE_REQUEST_TOTAL = 0
_RESOURCE_REQUEST_LOCK = threading.Lock()


def _request_body_limit(request: Request) -> int:
    content_type = request.headers.get("content-type", "").lower()
    if (
        request.url.path.startswith("/api/v1/projects/")
        and (
            request.url.path.endswith("/upload")
            or request.url.path.endswith("/reference-file-upload")
        )
        and "multipart/form-data" in content_type
    ):
        return MAX_UPLOAD_REQUEST_BODY_BYTES
    return MAX_REQUEST_BODY_BYTES


def _is_freezone_audio_voice_upload(request: Request) -> bool:
    return (
        request.method.upper() == "POST"
        and request.url.path.startswith("/api/v1/projects/")
        and request.url.path.endswith("/freezone/audio/voices")
    )


def _resource_request_key(path: str) -> str | None:
    if path.startswith("/static/"):
        return path

    if not path.startswith("/api/v1/projects/"):
        return None

    parts = path.split("/")
    if len(parts) >= 6 and parts[4] in {"media", "files"}:
        return path
    return None


def _record_resource_request(resource_key: str) -> tuple[int, int]:
    global _RESOURCE_REQUEST_TOTAL
    with _RESOURCE_REQUEST_LOCK:
        _RESOURCE_REQUEST_TOTAL += 1
        _RESOURCE_REQUEST_COUNTS[resource_key] += 1
        return _RESOURCE_REQUEST_TOTAL, _RESOURCE_REQUEST_COUNTS[resource_key]


def create_app() -> FastAPI:
    register_verification_routes()

    application = FastAPI(title="NovelVideo API", openapi_tags=OPENAPI_TAGS)
    mount_api_coverage_middleware(application)

    @application.exception_handler(ProjectTaskLimitExceeded)
    async def _project_task_limit_exceeded(
        request: Request,
        exc: ProjectTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="project")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": f"当前项目 {exc.queue_kind} 队列任务已满，请等待已有任务完成后再提交",
                "data": {
                    "project_id": exc.project_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "project",
                },
            },
        )

    @application.exception_handler(ProjectUserTaskLimitExceeded)
    async def _project_user_task_limit_exceeded(
        request: Request,
        exc: ProjectUserTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="user")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": (
                    f"你在当前项目 {exc.queue_kind} 队列任务已满，"
                    "请等待自己的任务完成后再提交"
                ),
                "data": {
                    "project_id": exc.project_id,
                    "requester_user_id": exc.requester_user_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "user",
                },
            },
        )

    @application.exception_handler(GlobalLaneQueueLimitExceeded)
    async def _global_lane_queue_limit_exceeded(
        request: Request,
        exc: GlobalLaneQueueLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="global_lane_queue")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": f"当前节点 {exc.queue_kind} 队列已满，请稍后再提交",
                "data": {
                    "project_id": exc.project_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "queued": exc.queued,
                    "limit_scope": "global_lane_queue",
                },
            },
        )

    @application.exception_handler(ChannelTaskLimitExceeded)
    async def _channel_task_limit_exceeded(
        request: Request,
        exc: ChannelTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        limit_scope = "platform" if exc.scope_kind == "platform" else "channel"
        log_task_limit_rejection(exc, limit_scope=limit_scope)
        if exc.scope_kind == "platform":
            # 共享池(``org_id is None``)拦下的是不归属任何渠道的请求,对他们
            # 说"渠道"没有对应概念;而池子是全平台共享的,"等待已有任务完成"
            # 也无从等起 —— 撞闸的人自己可能一个任务都没在跑。
            message = f"当前平台 {exc.queue_kind} 队列任务已满，请稍后再试"
        else:
            message = (
                f"当前渠道 {exc.queue_kind} 队列任务已满，请等待已有任务完成后再提交"
            )
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": message,
                "data": {
                    "scope_kind": exc.scope_kind,
                    "org_id": exc.org_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": limit_scope,
                },
            },
        )

    @application.exception_handler(UserTaskLimitExceeded)
    async def _user_task_limit_exceeded(
        request: Request,
        exc: UserTaskLimitExceeded,
    ) -> JSONResponse:
        _ = request
        log_task_limit_rejection(exc, limit_scope="user")
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "error": (
                    f"你在 {exc.queue_kind} 队列的在途任务已满，"
                    "请等待自己的任务完成后再提交"
                ),
                "data": {
                    "requester_user_id": exc.requester_user_id,
                    "queue_kind": exc.queue_kind,
                    "limit": exc.limit,
                    "active": exc.active,
                    "limit_scope": "user",
                },
            },
        )

    @application.exception_handler(InsufficientCreditsError)
    async def _insufficient_credits(
        request: Request,
        exc: InsufficientCreditsError,
    ) -> JSONResponse:
        _ = request
        payload = insufficient_credits_payload(exc)
        return JSONResponse(
            status_code=402,
            content={
                "ok": False,
                "error": INSUFFICIENT_CREDITS_MESSAGE,
                "data": payload,
            },
        )

    @application.exception_handler(BillingRuleNotConfiguredError)
    async def _billing_rule_not_configured(
        request: Request,
        exc: BillingRuleNotConfiguredError,
    ) -> JSONResponse:
        _ = request
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "error": BILLING_RULE_NOT_CONFIGURED_MESSAGE,
                "data": billing_rule_not_configured_payload(exc),
            },
        )

    @application.exception_handler(BillingError)
    async def _billing_error(
        request: Request,
        exc: BillingError,
    ) -> JSONResponse:
        _ = request
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "ok": False,
                "error": exc.user_message,
                "data": billing_error_payload(exc),
            },
        )

    @application.exception_handler(AuthzError)
    async def _authz_error(
        request: Request,
        exc: AuthzError,
    ) -> JSONResponse:
        # Without this handler the denial escaped to Starlette's
        # ServerErrorMiddleware, which answers text/plain 500 — no machine code
        # for the frontend and, because nothing on this path logged, no trace
        # for whoever triages it.
        logger.warning(
            "organization authorization denied: code=%s status=%s method=%s path=%s",
            exc.code,
            exc.http_status,
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "ok": False,
                "error": exc.user_message,
                "data": authz_error_payload(exc),
            },
        )

    @application.middleware("http")
    async def _limit_body_size(request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl:
            try:
                limit = _request_body_limit(request)
                if int(cl) > limit:
                    if _is_freezone_audio_voice_upload(request):
                        return JSONResponse(
                            status_code=200,
                            content={
                                "ok": False,
                                "error": "参考音频超过 5MB 上限，请压缩或裁剪后重新上传",
                                "data": {
                                    "code": "freezone_audio_voice_too_large",
                                    "field": "file",
                                    "limit": limit,
                                    "got": int(cl),
                                },
                            },
                        )
                    return JSONResponse(
                        status_code=413,
                        content={
                            "detail": {
                                "code": "canvas_payload_too_large",
                                "field": "body",
                                "limit": limit,
                                "got": int(cl),
                            }
                        },
                    )
            except ValueError:
                pass
        return await call_next(request)

    @application.middleware("http")
    async def _log_resource_requests(request: Request, call_next):
        resource_key = _resource_request_key(request.url.path)
        if resource_key is None:
            return await call_next(request)

        started_at = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - started_at) * 1000
        total_count, same_resource_count = _record_resource_request(resource_key)

        query = request.url.query
        range_header = request.headers.get("range", "")
        content_length = response.headers.get("content-length", "")
        content_type = response.headers.get("content-type", "")
        logger.info(
            "resource request total=%s same_resource=%s method=%s status=%s "
            "duration_ms=%.1f path=%s query=%s range=%s bytes=%s content_type=%s",
            total_count,
            same_resource_count,
            request.method,
            response.status_code,
            duration_ms,
            resource_key,
            query or "-",
            range_header or "-",
            content_length or "-",
            content_type or "-",
        )
        return response

    @application.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @application.on_event("startup")
    async def startup() -> None:
        try:
            from novelvideo.ports.registry import ensure_bootstrap, get_port

            ensure_bootstrap()
            await get_port("lifecycle").on_startup(register_as_worker=True)

            from novelvideo.sqlite_pragmas import litestream_enabled

            if litestream_enabled():
                from novelvideo.backup.wal_migrator import migrate_state_tree
                from novelvideo.config import STATE_DIR

                try:
                    await asyncio.to_thread(migrate_state_tree, Path(STATE_DIR))
                except Exception:
                    logger.exception("WAL migration sweep failed (non-fatal)")

            from novelvideo.official_media_catalog_remote import (
                run_official_media_catalog_updater,
            )
            from novelvideo.shared.runtime_env import is_ce_effective

            if is_ce_effective():
                application.state.official_media_catalog_updater = (
                    asyncio.create_task(
                        run_official_media_catalog_updater(),
                        name="official-media-catalog-updater",
                    )
                )
        except Exception:
            logger.exception("API startup failed while connecting to control-plane")
            raise

    @application.on_event("shutdown")
    async def shutdown() -> None:
        from novelvideo.ports.registry import PortNotRegistered, get_port

        updater = getattr(application.state, "official_media_catalog_updater", None)
        if updater is not None:
            updater.cancel()
            with suppress(asyncio.CancelledError):
                await updater

        try:
            lifecycle = get_port("lifecycle")
        except PortNotRegistered:
            return
        await lifecycle.on_shutdown()

    application.include_router(api_router)

    @application.get(
        "/static/projects/{project}/{file_path:path}", include_in_schema=False
    )
    async def static_project_media(
        project: str,
        file_path: str,
        request: Request,
        st_thumb: str | None = None,
        user: dict = Depends(get_api_user),
    ):
        return await preview_project_media_file(
            project, file_path, user, st_thumb=st_thumb, request=request
        )

    @application.get("/static/{legacy_path:path}", include_in_schema=False)
    async def legacy_static_media(legacy_path: str):
        _ = legacy_path
        return PlainTextResponse(
            "legacy static path; use /static/projects/<project_id>/...\n",
            status_code=410,
        )

    # 原生/便携部署(无 nginx)时由后端直接伺服 SPA:设 DRAMACLAW_FRONTEND_DIST
    # 指向前端构建产物目录才挂载;Docker/EE 路径不设该变量,行为不变。
    # 挂在所有路由之后,/api、/healthz、/static 仍然优先命中。
    frontend_dist = os.environ.get("DRAMACLAW_FRONTEND_DIST", "").strip()
    if frontend_dist and Path(frontend_dist).is_dir():
        from fastapi.staticfiles import StaticFiles
        from starlette.exceptions import HTTPException as _StarletteHTTPException

        class _SpaStaticFiles(StaticFiles):
            """SPA fallback: unknown extensionless paths serve index.html.

            StaticFiles 未命中时 raise HTTPException(404)(仅 dist 含 404.html
            时才返回 404 响应),回落必须捕获异常;带扩展名的缺失资产照常 404。
            """

            async def get_response(self, path: str, scope):  # type: ignore[override]
                try:
                    return await super().get_response(path, scope)
                except _StarletteHTTPException as exc:
                    if exc.status_code == 404 and "." not in Path(path).name:
                        return await super().get_response("index.html", scope)
                    raise

        application.mount(
            "/", _SpaStaticFiles(directory=frontend_dist, html=True), name="spa"
        )

    return application


app = create_app()
