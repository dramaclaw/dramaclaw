"""项目 CRUD 端点。"""

import logging
import shutil
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import JSONResponse

from novelvideo.api.auth import get_api_user, require_scope
from novelvideo.api.deps import (
    make_sqlite_store_for_context,
    make_static_url_for_context,
    validate_project_name,
)
from novelvideo.api.routes._project_audit import emit_project_audit
from novelvideo.api.schemas import (
    CharacterVoiceRecordRequest,
    NarratorVoiceCopyRequest,
    NarratorVoiceTrimRequest,
    ProjectCreate,
    ProjectStatusFilter,
    ProjectSummary,
    ProjectUpdate,
)
from novelvideo.config import ensure_project_dirs_at_paths
from novelvideo.embedding_models import (
    PROJECT_EMBEDDING_DIMENSION_KEY,
    PROJECT_EMBEDDING_MODEL_KEY,
    embedding_model_binding_for_new_project,
)
from novelvideo.ports import get_project_access, get_project_registry
from novelvideo.ports.project import ProjectRecord
from novelvideo.security import (
    ProjectStorageOwnershipError,
    assert_owned_project_storage,
)
from novelvideo.project_config import (
    default_aspect_ratio_for_spine_template,
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
    load_project_config_file_from_state_dir,
    load_project_config_from_state_dir,
    save_project_config_in_state_dir,
    set_narrator_reference_audio,
)
from novelvideo.project_context import (
    ProjectContext,
    is_record_home_node,
    require_project_home_node,
    resolve_project_context,
    user_id_from_api_user,
)
from novelvideo.seedance2_i2v.character_voice_storage import (
    VOICE_SAMPLE_EXTENSIONS,
    decode_recorded_audio_data_url,
    is_supported_voice_sample,
    trim_voice_sample_content,
    voice_content_sha256,
    voice_sample_extension,
)
from novelvideo.seedance2_i2v.voice_clone import (
    DEFAULT_NARRATION_STYLE,
    NARRATION_STYLES,
    resolve_narrator_source,
)

logger = logging.getLogger("novelvideo.api.projects")

router = APIRouter()
VOICE_SOURCE_ROOTS = ("audio", "seedance2_uploads", "assets", "uploads")
NARRATOR_VOICE_MODE_EXPLANATION = "第一人称解说使用解说主角声线；第三人称解说使用项目解说声线。"
SUPPORTED_VOICE_SAMPLE_COPY = "仅支持 mp3 / wav / m4a / aac / ogg"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_updated_at(paths) -> str | None:
    candidates = [
        paths.state_dir / "project_config.json",
        paths.state_dir / "data.db",
        paths.state_dir,
        paths.output_dir,
    ]
    latest = 0.0
    for path in candidates:
        try:
            if path.exists():
                latest = max(latest, path.stat().st_mtime)
        except OSError:
            continue
    if latest <= 0:
        return None
    return datetime.fromtimestamp(latest, tz=timezone.utc).isoformat()


def _project_counts(paths, status: str) -> tuple[int | None, int | None]:
    if status == "deleted":
        return None, None
    db_path = paths.data_db
    if not db_path.exists():
        return None, None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        try:
            ep_row = conn.execute("SELECT COUNT(*) FROM episodes").fetchone()
            beat_row = conn.execute("SELECT COUNT(*) FROM beats").fetchone()
            return int(ep_row[0]) if ep_row else 0, int(beat_row[0]) if beat_row else 0
        finally:
            conn.close()
    except sqlite3.Error:
        logger.debug("project count failed: %s", db_path, exc_info=True)
        return None, None


async def _summary_for_record(
    record: ProjectRecord,
    *,
    effective_role: str = "",
) -> ProjectSummary:
    if not is_record_home_node(record):
        return ProjectSummary(
            id=record.id,
            name=record.name,
            owner_type=record.owner_type,
            owner_id=record.owner_id,
            owner_username=record.owner_username,
            effective_role=effective_role,
            home_node_id=record.home_node_id,
            status=record.status,
            purged_at=record.purged_at,
            updated_at=record.updated_at or None,
            episode_count=None,
            beat_count=None,
        )

    from novelvideo.utils.project_paths import ProjectPaths

    paths = ProjectPaths(record.owner_username, record.name)
    paths._output_dir_override = Path(record.output_dir)
    paths._state_dir_override = Path(record.state_dir)
    paths._runtime_dir_override = Path(record.runtime_dir)
    config = load_project_config_file_from_state_dir(record.state_dir)
    status = record.status or "active"
    episode_count, beat_count = _project_counts(paths, status)
    return ProjectSummary(
        id=record.id,
        name=record.name,
        owner_type=record.owner_type,
        owner_id=record.owner_id,
        owner_username=record.owner_username,
        effective_role=effective_role,
        home_node_id=record.home_node_id,
        status=status,
        archived_at=config.get("archived_at"),
        deleted_at=config.get("deleted_at"),
        purged_at=record.purged_at,
        updated_at=_project_updated_at(paths),
        episode_count=episode_count,
        beat_count=beat_count,
    )


def _project_relative_path(project_dir: str | Path, path: str | Path) -> str:
    return Path(path).resolve().relative_to(Path(project_dir).resolve()).as_posix()


def _narrator_voice_sample_path(project_dir: str | Path, filename: str) -> Path:
    ext = voice_sample_extension(filename)
    return Path(project_dir) / "assets" / "narrator" / f"voice{ext}"


def _validated_owned_dirs(record: ProjectRecord) -> list[Path]:
    """校验三类目录确属 owner,返回去重后的真实路径;校验失败直接抛出。

    这是所有对项目整树的移动/删除的唯一入口,任一目录不在
    ``<root>/<owner>/`` 下即拒绝,禁止碰任何目录。
    """
    validated = assert_owned_project_storage(
        owner_username=record.owner_username,
        output_dir=record.output_dir,
        state_dir=record.state_dir,
        runtime_dir=record.runtime_dir,
    )
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in validated.as_tuple():
        if path in seen:
            continue
        seen.add(path)
        unique.append(path)
    return unique


def _cleanup_uncommitted_project_dirs(record: ProjectRecord) -> None:
    for path in _validated_owned_dirs(record):
        if path.exists():
            shutil.rmtree(path)


def _restore_quarantined_project_dirs(quarantined: list[tuple[Path, Path]]) -> None:
    for original, quarantine in reversed(quarantined):
        if not quarantine.exists():
            continue
        if original.exists():
            # 恢复隔离目录时,若原位置已被并发创建/重建占用,绝不递归删除它 ——
            # 那可能是另一个操作合法写入的新数据。保留双方并报警,交由人工处置。
            logger.error(
                "cannot restore isolated dir %s: original path already exists; "
                "leaving quarantine %s in place for manual recovery",
                original,
                quarantine,
            )
            continue
        quarantine.replace(original)


def _quarantine_project_dirs(
    record: ProjectRecord,
    *,
    project_id: str,
    reason: str,
) -> list[tuple[Path, Path]]:
    """Atomically detach project directories before releasing their registry name.

    仅在 ``record`` 的三类目录全部通过归属校验后才移动;任一目录不属于
    ``record.owner_username`` 时抛出,不移动任何目录。
    """
    quarantined: list[tuple[Path, Path]] = []
    token = uuid.uuid4().hex
    try:
        for original in _validated_owned_dirs(record):
            if not original.exists():
                continue
            quarantine = original.with_name(
                f".{original.name}.{reason}-{project_id}-{token}"
            )
            original.replace(quarantine)
            quarantined.append((original, quarantine))
    except Exception:
        _restore_quarantined_project_dirs(quarantined)
        raise
    return quarantined


def _delete_quarantined_project_dirs(quarantined: list[tuple[Path, Path]]) -> None:
    for _, quarantine in quarantined:
        try:
            if quarantine.exists():
                shutil.rmtree(quarantine)
        except OSError:
            logger.warning("failed to remove quarantined project directory: %s", quarantine)


def _narrator_identity_detail(resolution) -> str:
    if not resolution.character_name:
        return "未配置解说主角"
    if resolution.identity_name:
        return f"{resolution.character_name}（{resolution.identity_name}）"
    if resolution.identity_id:
        return f"{resolution.character_name}（{resolution.identity_id}）"
    return resolution.character_name


def _narrator_voice_display_lines(
    style: str,
    resolution,
    project_dir: str | Path,
) -> dict[str, str]:
    if style == "first_person":
        detail = _narrator_identity_detail(resolution)
        return {
            "heading": "第一人称解说主角声线",
            "detail": f"当前为第一人称：使用 {detail}",
            "explanation": NARRATOR_VOICE_MODE_EXPLANATION,
        }

    if resolution.audio_path:
        detail = _project_relative_path(project_dir, resolution.audio_path)
    else:
        detail = resolution.error or "第三人称项目解说声线未配置"
    return {
        "heading": "第三人称项目解说声线",
        "detail": detail,
        "explanation": "第三人称解说使用项目级声线；所有非对白 Beat 使用同一声线。",
    }


def _effective_narrator_voice_style(username: str, project: str) -> str:
    return load_effective_narration_style_for_voice(username, project) or DEFAULT_NARRATION_STYLE


def _narrator_voice_payload(ctx: ProjectContext, store) -> dict:
    style = _effective_narrator_voice_style(ctx.owner_username, ctx.project_name)
    stored = load_narrator_reference_audio(ctx.owner_username, ctx.project_name)
    resolution = resolve_narrator_source(
        store=store,
        narration_style=style,
        project_narrator_stored_path=stored.get("path", ""),
    )
    project_dir = Path(ctx.output_dir)
    display = _narrator_voice_display_lines(style, resolution, project_dir)
    rel_path = (
        _project_relative_path(project_dir, resolution.audio_path) if resolution.audio_path else ""
    )
    reference_sha256 = resolution.sha256
    if resolution.source == "project_narrator":
        reference_sha256 = reference_sha256 or stored.get("sha256", "")
    return {
        "narration_style": style,
        "style_label": NARRATION_STYLES.get(style, NARRATION_STYLES[DEFAULT_NARRATION_STYLE])[
            "label"
        ],
        "source": resolution.source or "",
        "reference_path": rel_path,
        "reference_url": (
            make_static_url_for_context(ctx, rel_path, local_path=resolution.audio_path)
            if rel_path and resolution.audio_path
            else ""
        ),
        "reference_sha256": reference_sha256,
        "reference_updated_at": stored.get("updated_at", ""),
        "heading": display["heading"],
        "detail": display["detail"],
        "explanation": display["explanation"],
        "character_name": resolution.character_name,
        "identity_id": resolution.identity_id,
        "identity_name": resolution.identity_name,
        "error": resolution.error,
        "is_first_person": style == "first_person",
    }


def _ensure_third_person_narrator(username: str, project: str) -> None:
    style = _effective_narrator_voice_style(username, project)
    if style == "first_person":
        raise ValueError(NARRATOR_VOICE_MODE_EXPLANATION)


def _persist_narrator_voice_content(
    *,
    username: str,
    project: str,
    project_dir: Path,
    filename: str,
    content: bytes,
) -> Path:
    if not is_supported_voice_sample(filename):
        raise ValueError(f"{SUPPORTED_VOICE_SAMPLE_COPY}（收到：{filename or '未知文件'}）")
    if not content:
        raise ValueError("音频内容为空")

    target = _narrator_voice_sample_path(project_dir, filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    for ext in VOICE_SAMPLE_EXTENSIONS:
        existing = target.with_suffix(ext)
        if existing.exists():
            existing.replace(
                existing.with_name(f"{existing.stem}_{int(time.time())}{existing.suffix}")
            )
    target.write_bytes(content)
    set_narrator_reference_audio(
        username,
        project,
        relative_path=_project_relative_path(project_dir, target),
        sha256=voice_content_sha256(content),
    )
    return target


def _trim_narrator_voice_content(
    *,
    username: str,
    project: str,
    project_dir: Path,
    start_seconds: float,
    duration_seconds: float,
) -> Path:
    stored = load_narrator_reference_audio(username, project)
    source = Path(stored.get("path", ""))
    if not str(source):
        raise ValueError("请先上传解说声线")
    if not source.is_absolute():
        source = project_dir / source
    source = source.resolve()
    try:
        source.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise ValueError("请选择项目内有效的音频文件") from exc
    if (
        not source.exists()
        or not source.is_file()
        or source.suffix.lower() not in VOICE_SAMPLE_EXTENSIONS
    ):
        raise ValueError("请选择项目内有效的音频文件")

    content, _filename = trim_voice_sample_content(
        source.read_bytes(),
        filename=source.name,
        start_seconds=start_seconds,
        duration_seconds=duration_seconds,
    )
    target = project_dir / "assets" / "narrator" / "voice.mp3"
    target.parent.mkdir(parents=True, exist_ok=True)
    for ext in VOICE_SAMPLE_EXTENSIONS:
        sibling = target.with_suffix(ext)
        if sibling.exists():
            sibling.replace(sibling.with_name(f"{sibling.stem}_{int(time.time())}{sibling.suffix}"))
    target.write_bytes(content)
    set_narrator_reference_audio(
        username,
        project,
        relative_path=_project_relative_path(project_dir, target),
        sha256=voice_content_sha256(content),
    )
    return target


def _project_voice_source_label(rel_path: str) -> str:
    filename = Path(rel_path).name
    if rel_path.startswith("audio/"):
        return f"已生成音频 · {filename}"
    if rel_path.startswith("assets/"):
        return f"资产音频 · {filename}"
    return f"{filename} · {rel_path}"


def _project_voice_source_options(project_dir: str | Path) -> list[dict[str, str]]:
    project_path = Path(project_dir)
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for root_name in VOICE_SOURCE_ROOTS:
        root = project_path / root_name
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in VOICE_SAMPLE_EXTENSIONS:
                continue
            rel_path = _project_relative_path(project_path, path)
            if rel_path in seen:
                continue
            seen.add(rel_path)
            options.append(
                {
                    "label": _project_voice_source_label(rel_path),
                    "path": str(path),
                    "rel_path": rel_path,
                }
            )
    return sorted(options, key=lambda item: item["rel_path"])


@router.get("/projects")
async def list_projects(user: dict = Depends(get_api_user)):
    """List project_ids accessible to the current user."""
    user_id = await user_id_from_api_user(user)
    access = get_project_access()
    registry = get_project_registry()
    principals = await access.resolve_requester_principals(user_id)
    records = await registry.list_accessible_projects([(p.type, p.id) for p in principals])
    records = [record for record in records if not record.purged_at]
    roles = {
        record.id: await access.effective_project_role(record, principals) for record in records
    }
    return {
        "ok": True,
        "data": [
            {
                "id": record.id,
                "name": record.name,
                "owner_username": record.owner_username,
                "owner_type": record.owner_type,
                "owner_id": record.owner_id,
                "effective_role": roles.get(record.id) or "",
                "home_node_id": record.home_node_id,
                "status": record.status,
            }
            for record in records
        ],
    }


@router.get("/projects/summaries")
async def list_project_summaries(
    status: ProjectStatusFilter = Query("visible"),
    user: dict = Depends(get_api_user),
):
    """List summaries for projects accessible to the current user."""
    user_id = await user_id_from_api_user(user)
    access = get_project_access()
    registry = get_project_registry()
    principals = await access.resolve_requester_principals(user_id)
    records = await registry.list_accessible_projects([(p.type, p.id) for p in principals])
    records = [record for record in records if not record.purged_at]
    summaries = []
    for record in records:
        role = await access.effective_project_role(record, principals)
        summaries.append(await _summary_for_record(record, effective_role=role or ""))
    if status == "visible":
        summaries = [s for s in summaries if s.status != "deleted"]
    elif status != "all":
        summaries = [s for s in summaries if s.status == status]
    rows = [s.model_dump() for s in summaries]
    for row in rows:
        if row.get("purged_at") is None:
            row.pop("purged_at", None)
    return {"ok": True, "data": rows}


@router.post("/projects")
async def create_project(
    body: ProjectCreate, user: dict = Depends(require_scope("projects:write"))
):
    """创建新项目。"""
    logger.info("create_project: %s", body.name)
    validate_project_name(body.name)
    user_id = await user_id_from_api_user(user)
    registry = get_project_registry()
    try:
        record = await registry.create_project(
            owner_user_id=user_id,
            owner_username=user["username"],
            name=body.name,
        )
    except asyncpg.exceptions.UniqueViolationError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Project '{body.name}' already exists",
        ) from exc
    except ValueError as exc:
        if "already exists" in str(exc):
            raise HTTPException(
                status_code=409,
                detail=f"Project '{body.name}' already exists",
            ) from exc
        raise
    try:
        orphaned_dirs = _quarantine_project_dirs(
            record,
            project_id=record.id,
            reason="orphaned",
        )
    except Exception as exc:
        try:
            await registry.delete_uncommitted_project(record.id)
        except Exception:
            logger.warning("failed to compensate uncommitted project registry row", exc_info=True)
        detail = (
            "Existing project data failed ownership validation; nothing was touched."
            if isinstance(exc, ProjectStorageOwnershipError)
            else "Existing project data could not be isolated. Project was not created."
        )
        raise HTTPException(status_code=500, detail=detail) from exc
    try:
        ensure_project_dirs_at_paths(
            output_dir=record.output_dir,
            state_dir=record.state_dir,
            runtime_dir=record.runtime_dir,
        )
        embedding_binding = embedding_model_binding_for_new_project()
        save_project_config_in_state_dir(
            record.state_dir,
            config={
                "user": user["username"],
                PROJECT_EMBEDDING_MODEL_KEY: embedding_binding.internal_model,
                PROJECT_EMBEDDING_DIMENSION_KEY: embedding_binding.dimensions,
            },
        )
    except Exception:
        try:
            _cleanup_uncommitted_project_dirs(record)
        except Exception:
            logger.warning("failed to cleanup uncommitted project directories", exc_info=True)
        try:
            _restore_quarantined_project_dirs(orphaned_dirs)
        except Exception:
            logger.error("failed to restore isolated project directories", exc_info=True)
        try:
            await registry.delete_uncommitted_project(record.id)
        except Exception:
            logger.warning("failed to compensate uncommitted project registry row", exc_info=True)
        raise
    _delete_quarantined_project_dirs(orphaned_dirs)
    return {"ok": True, "data": {"id": record.id, "project_id": record.id, "name": body.name}}


@router.get("/projects/{project}")
async def get_project(project: str, user: dict = Depends(get_api_user)):
    """获取项目配置。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    require_project_home_node(ctx, operation="read project config")
    config = load_project_config_from_state_dir(
        ctx.state_dir,
        username=ctx.owner_username,
        project=ctx.project_name,
    )
    record = await get_project_registry().get_project(ctx.project_id)
    data = dict(config)
    data.update(
        {
            "project_id": ctx.project_id,
            "name": ctx.project_name,
            "owner_username": ctx.owner_username,
            "effective_role": ctx.effective_role,
            "home_node_id": ctx.home_node_id,
            "status": record.status if record is not None else "active",
            "purged_at": record.purged_at if record is not None else None,
        }
    )
    return {"ok": True, "data": data}


@router.get("/projects/{project}/static-auth", include_in_schema=False)
async def authorize_project_static_media(project: str, user: dict = Depends(get_api_user)):
    await resolve_project_context(user=user, project_id=project, required_role="viewer")
    return Response(status_code=204)


@router.patch("/projects/{project}")
async def update_project(
    project: str,
    body: ProjectUpdate,
    user: dict = Depends(require_scope("projects:write")),
):
    """更新项目配置。"""
    logger.info("[%s] update_project: %s", project, list(body.model_dump(exclude_none=True).keys()))
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    require_project_home_node(ctx, operation="update project config")
    updates = body.model_dump(exclude_none=True)
    current_config = load_project_config_from_state_dir(
        ctx.state_dir,
        username=ctx.owner_username,
        project=ctx.project_name,
    )

    if body.spine_template is not None and body.spine_template != current_config.get(
        "spine_template", "drama"
    ):
        store = await make_sqlite_store_for_context(ctx)
        try:
            imported = bool(store.get_all_episodes())
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        if imported:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": "项目类型已锁定；如需切换请重新导入",
                },
            )
        if body.aspect_ratio is None:
            updates["aspect_ratio"] = default_aspect_ratio_for_spine_template(body.spine_template)

    # 校验 visual_style 合法性
    if body.visual_style is not None:
        from novelvideo.services.style_service import StyleService

        valid = StyleService.get_style_labels(username=ctx.owner_username, project=ctx.project_name)
        if body.visual_style not in valid:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": (
                        f"Invalid visual_style: '{body.visual_style}'. "
                        f"Valid: {list(valid.keys())}"
                    ),
                },
            )

    if updates:
        save_project_config_in_state_dir(ctx.state_dir, config=updates)
    config = load_project_config_from_state_dir(
        ctx.state_dir,
        username=ctx.owner_username,
        project=ctx.project_name,
    )
    return {"ok": True, "data": config}


@router.get("/projects/{project}/narrator-voice")
async def get_narrator_voice(
    project: str,
    user: dict = Depends(get_api_user),
):
    """获取项目解说声线状态。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    store = await make_sqlite_store_for_context(ctx)
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


@router.get("/projects/{project}/narrator-voice/sources")
async def list_narrator_voice_sources(project: str, user: dict = Depends(get_api_user)):
    """列出项目内可复制为解说声线的音频。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    require_project_home_node(ctx, operation="list project voice files")
    return {"ok": True, "data": {"options": _project_voice_source_options(ctx.output_dir)}}


@router.post("/projects/{project}/narrator-voice/upload")
async def upload_narrator_voice(
    project: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """上传第三人称项目解说声线。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    store = await make_sqlite_store_for_context(ctx)
    try:
        _ensure_third_person_narrator(ctx.owner_username, ctx.project_name)
        content = await file.read()
        _persist_narrator_voice_content(
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=ctx.output_dir,
            filename=file.filename or "",
            content=content,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


@router.post("/projects/{project}/narrator-voice/record")
async def record_narrator_voice(
    project: str,
    body: CharacterVoiceRecordRequest,
    user: dict = Depends(get_api_user),
):
    """保存浏览器录音为第三人称项目解说声线。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    store = await make_sqlite_store_for_context(ctx)
    try:
        _ensure_third_person_narrator(ctx.owner_username, ctx.project_name)
        content, extension = decode_recorded_audio_data_url(body.data_url)
        _persist_narrator_voice_content(
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=ctx.output_dir,
            filename=f"recorded{extension}",
            content=content,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


@router.post("/projects/{project}/narrator-voice/copy")
async def copy_project_audio_as_narrator_voice(
    project: str,
    body: NarratorVoiceCopyRequest,
    user: dict = Depends(get_api_user),
):
    """从项目内已有音频复制为第三人称项目解说声线。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    store = await make_sqlite_store_for_context(ctx)
    try:
        _ensure_third_person_narrator(ctx.owner_username, ctx.project_name)
        raw_path = Path(body.source_path)
        source_path = raw_path if raw_path.is_absolute() else ctx.output_dir / raw_path
        source_path = source_path.resolve()
        source_path.relative_to(ctx.output_dir.resolve())
        if not source_path.exists() or source_path.suffix.lower() not in VOICE_SAMPLE_EXTENSIONS:
            return {"ok": False, "error": "请选择项目内有效的音频文件"}
        _persist_narrator_voice_content(
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=ctx.output_dir,
            filename=source_path.name,
            content=source_path.read_bytes(),
        )
    except (ValueError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


@router.post("/projects/{project}/narrator-voice/trim")
async def trim_narrator_voice(
    project: str,
    body: NarratorVoiceTrimRequest,
    user: dict = Depends(get_api_user),
):
    """裁剪第三人称项目解说声线并写回项目声线槽位。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    store = await make_sqlite_store_for_context(ctx)
    try:
        _ensure_third_person_narrator(ctx.owner_username, ctx.project_name)
        _trim_narrator_voice_content(
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=ctx.output_dir,
            start_seconds=body.start_seconds,
            duration_seconds=body.duration_seconds,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


@router.post("/projects/{project}/narrator-voice/delete")
async def delete_narrator_voice(
    project: str,
    user: dict = Depends(get_api_user),
):
    """移除第三人称项目解说声线。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    store = await make_sqlite_store_for_context(ctx)
    stored = load_narrator_reference_audio(ctx.owner_username, ctx.project_name)
    target = Path(stored.get("path", ""))
    if str(target):
        if not target.is_absolute():
            target = ctx.output_dir / target
        if target.exists():
            target.replace(target.with_name(f"{target.stem}_{int(time.time())}{target.suffix}"))
    set_narrator_reference_audio(ctx.owner_username, ctx.project_name, relative_path="", sha256="")
    return {
        "ok": True,
        "data": _narrator_voice_payload(ctx, store),
    }


async def _set_project_status(
    ctx,
    status: str,
    *,
    archived_at: str | None = None,
    deleted_at: str | None = None,
    audit_action: str | None = None,
):
    require_project_home_node(ctx, operation="update project status")
    registry = get_project_registry()
    existing = await registry.get_project(ctx.project_id)
    if existing is not None and existing.purged_at:
        raise HTTPException(status_code=400, detail="Purged projects cannot change status.")
    updates = {}
    if archived_at is not None:
        updates["archived_at"] = archived_at
    if deleted_at is not None:
        updates["deleted_at"] = deleted_at
    if status == "active":
        updates["archived_at"] = ""
        updates["deleted_at"] = ""
    record = await registry.update_project_status(ctx.project_id, status)
    if record is None:
        existing = await registry.get_project(ctx.project_id)
        if existing is not None and existing.purged_at:
            raise HTTPException(status_code=400, detail="Purged projects cannot change status.")
        raise HTTPException(status_code=404, detail="Project not found.")
    if updates:
        save_project_config_in_state_dir(ctx.state_dir, config=updates)
    summary = await _summary_for_record(record, effective_role=ctx.effective_role)
    if audit_action:
        await emit_project_audit(
            action=audit_action,
            ctx=ctx,
            metadata={"status": status},
        )
    return {"ok": True, "data": summary.model_dump()}


@router.post("/projects/{project}/archive")
async def archive_project(
    project: str,
    user: dict = Depends(require_scope("projects:lifecycle")),
):
    ctx = await resolve_project_context(user=user, project_id=project, required_role="owner")
    return await _set_project_status(
        ctx,
        "archived",
        archived_at=_now_iso(),
        deleted_at="",
        audit_action="project.archive",
    )


@router.post("/projects/{project}/unarchive")
async def unarchive_project(
    project: str,
    user: dict = Depends(require_scope("projects:lifecycle")),
):
    ctx = await resolve_project_context(user=user, project_id=project, required_role="owner")
    return await _set_project_status(ctx, "active", audit_action="project.unarchive")


@router.post("/projects/{project}/delete")
async def soft_delete_project(
    project: str,
    user: dict = Depends(require_scope("projects:lifecycle")),
):
    ctx = await resolve_project_context(user=user, project_id=project, required_role="owner")
    return await _set_project_status(
        ctx,
        "deleted",
        archived_at="",
        deleted_at=_now_iso(),
        audit_action="project.delete",
    )


@router.post("/projects/{project}/restore")
async def restore_project(
    project: str,
    user: dict = Depends(require_scope("projects:lifecycle")),
):
    ctx = await resolve_project_context(user=user, project_id=project, required_role="owner")
    record = await get_project_registry().get_project(ctx.project_id)
    if record is not None and record.purged_at:
        raise HTTPException(status_code=400, detail="Purged projects cannot be restored.")
    return await _set_project_status(ctx, "active", audit_action="project.restore")


@router.post("/projects/{project}/purge")
async def purge_project(
    project: str,
    user: dict = Depends(require_scope("projects:purge")),
):
    """永久删除项目目录；只允许对已进入回收站的项目执行。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="owner")
    require_project_home_node(ctx, operation="purge project files")

    registry = get_project_registry()
    record = await registry.get_project(ctx.project_id)
    if record is None or record.status != "deleted":
        raise HTTPException(
            status_code=400,
            detail="Only deleted projects can be purged. Soft-delete first.",
        )
    if record.purged_at:
        raise HTTPException(status_code=400, detail="Project has already been purged.")
    try:
        quarantined_dirs = _quarantine_project_dirs(
            record,
            project_id=ctx.project_id,
            reason="purging",
        )
    except Exception as exc:
        detail = (
            "Project files failed ownership validation; nothing was permanently deleted."
            if isinstance(exc, ProjectStorageOwnershipError)
            else "Project files could not be isolated. Nothing was permanently deleted."
        )
        raise HTTPException(status_code=500, detail=detail) from exc
    try:
        record = await registry.mark_project_purged(ctx.project_id)
    except Exception:
        _restore_quarantined_project_dirs(quarantined_dirs)
        raise
    if record is None:
        _restore_quarantined_project_dirs(quarantined_dirs)
        raise HTTPException(status_code=400, detail="Project could not be marked purged.")
    try:
        await registry.delete_project_home(ctx.project_id)
    except Exception:
        logger.warning("failed to delete purged project home", exc_info=True)
    _delete_quarantined_project_dirs(quarantined_dirs)
    await emit_project_audit(action="project.purge", ctx=ctx, metadata={"status": "deleted"})
    return {
        "ok": True,
        "data": {
            "name": project,
            "status": "deleted",
            "deleted_at": None,
            "purged_at": record.purged_at,
            "archived_at": None,
            "updated_at": None,
            "episode_count": None,
            "beat_count": None,
        },
    }
