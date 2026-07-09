"""Scene asset workbench endpoints."""

from __future__ import annotations

import io
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Query, UploadFile

from novelvideo.api.asset_metadata import newest_updated_at, tree_updated_at
from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    make_sqlite_store_for_context,
    make_static_url_for_context,
)
from novelvideo.api.schemas import (
    PanoViewerCorrection,
    SceneCreate,
    ScenePanoGenerateRequest,
    SceneUpdate,
)
from novelvideo.api.viewer_manifests import (
    build_director_stage_manifest,
    build_pano_viewer_manifest,
)
from novelvideo.director_world import stage_manifest
from novelvideo.models import (
    NovelScene,
    build_scene_effective_prompt,
    resolve_scene_plate_from_records,
)
from novelvideo.project_config import load_project_config_file
from novelvideo.project_context import ProjectContext, resolve_project_context
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.ports import get_task_backend
from novelvideo.task_scopes import scene_reference_asset_scope, stage_asset_scope
from novelvideo.task_identity import project_task_state_key
from novelvideo.utils.derived_scenes import (
    compose_derived_scene_name,
)
from novelvideo.utils.path_resolver import (
    canonical_scene_master_path,
    compute_scene_master_path,
    compute_scene_reverse_master_path,
)

router = APIRouter()

_SCENE_TIME_TOKENS = {
    "清晨",
    "晨",
    "上午",
    "正午",
    "午",
    "午后",
    "下午",
    "黄昏",
    "傍晚",
    "夜晚",
    "夜",
    "白天",
    "日",
}


def _project_style(username: str, project: str) -> str:
    config = load_project_config_file(username, project)
    return str(config.get("visual_style") or config.get("project_style") or "")


def _asset_url(ctx: ProjectContext, project_dir: Path, abs_path: str | Path) -> str:
    path = Path(abs_path)
    if not path.exists():
        return ""
    try:
        rel_path = path.relative_to(project_dir).as_posix()
    except ValueError:
        return ""
    return make_static_url_for_context(ctx, rel_path, local_path=path)


async def _resolve_scene_project(
    project: str,
    user: dict,
    *,
    required_role: str = "editor",
) -> tuple[ProjectContext, str, str, Path, str, SQLiteStore]:
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role=required_role,
    )
    store = await make_sqlite_store_for_context(ctx)
    return (
        ctx,
        ctx.owner_username,
        ctx.project_name,
        Path(ctx.output_dir),
        str(ctx.output_dir),
        store,
    )


async def _start_or_enqueue_stage_asset(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    scene_name: str,
    step: str,
    params: dict[str, Any],
) -> tuple[str, dict | None]:
    scope = stage_asset_scope(scene_name, step)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="stage_asset",
            queue_kind="world",
            episode=0,
            scope=scope,
            payload={
                "scene_name": scene_name,
                "step": step,
                "params": params,
                "project_dir": str(project_dir),
            },
        )
        return scope, {
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "stage_asset", ctx.project_id, 0, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
        }

    raise RuntimeError("片场资产生成需要 project context")


def _scene_360_description(scene: NovelScene) -> str:
    environment_prompt = str(
        scene.environment_prompt or scene.description or scene.name
    ).strip()
    return "\n".join(
        [
            f"场景名称：{scene.name}",
            f"场景类型：{scene.scene_type}",
            "环境描述是完整场景空间合同：应说明正面、背面、左侧、右侧、天花/天空、地面和固定物件关系。",
            "master 图代表正面半区：正面中心 + 左侧一半 + 右侧一半，并提供视觉风格锚点。",
            "reverse 图应代表背面半区：背面中心 + 左侧另一半 + 右侧另一半。",
            "360 需要把 environment_prompt 的四向空间合同展开成完整连续空间。",
            "如果某些方向没有明确写出，请基于场景类型和 master 视觉风格合理补全，"
            "但不要把正面物件机械复制到每个方向。",
            "环境描述：",
            environment_prompt,
        ]
    )


def _stage_file_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    path: Path | None,
) -> dict[str, Any]:
    if path is None:
        return {"ready": False, "path": "", "url": "", "size_bytes": 0, "size_mb": 0.0}
    size_bytes = path.stat().st_size if path.exists() else 0
    try:
        display_path = path.relative_to(project_dir).as_posix()
    except ValueError:
        display_path = path.name
    return {
        "ready": path.exists(),
        "path": display_path,
        "url": _asset_url(ctx, project_dir, path),
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else 0.0,
    }


def _stage_3gs_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_name: str,
) -> dict[str, Any]:
    stage_dir = stage_manifest.stage_dir(project_dir, scene_name)
    manifest = stage_manifest.load_manifest(project_dir, scene_name) or {}
    saved_world = stage_manifest.get_scene_director_world(project_dir, scene_name)
    saved_source_id = str(saved_world.get("active_source_id") or "").strip()
    saved_source = saved_world.get("active_source")
    saved_source = saved_source if isinstance(saved_source, dict) else {}
    kind_paths = {
        kind: stage_manifest.resolve_ply_path(project_dir, scene_name, ply_kind=kind)
        for kind in ("custom", "master", "reverse", "pano")
    }
    active_path = stage_manifest.resolve_ply_path(project_dir, scene_name)
    active_source = ""
    if saved_source_id:
        saved_source_type = str(saved_source.get("source_type") or "").strip()
        saved_kind = str(
            saved_source.get("source_kind")
            or saved_source.get("kind")
            or saved_source.get("label")
            or saved_source_id
        ).lower()
        if (
            saved_source_type == "pano360"
            or "360" in saved_kind
            or "pano" in saved_kind
        ):
            active_path = stage_manifest.resolve_pano_path(project_dir, scene_name)
            active_source = "360"
        elif "master" in saved_kind:
            active_path = kind_paths.get("master")
            active_source = "master"
        elif "reverse" in saved_kind:
            active_path = kind_paths.get("reverse")
            active_source = "reverse"
        elif "custom" in saved_kind:
            active_path = kind_paths.get("custom")
            active_source = "custom"
    if active_path is not None and not active_source:
        for kind, label in (
            ("custom", "custom"),
            ("pano", "360"),
            ("master", "master"),
            ("reverse", "reverse"),
        ):
            kind_path = kind_paths.get(kind)
            if kind_path is not None and kind_path.resolve() == active_path.resolve():
                active_source = label
                break

    try:
        stage_dir_display = stage_dir.relative_to(project_dir).as_posix()
    except ValueError:
        stage_dir_display = stage_dir.name

    return {
        "stage_dir": stage_dir_display,
        "manifest_ready": bool(manifest),
        "source": str(manifest.get("source") or ""),
        "active_source": active_source,
        "active": _stage_file_payload(
            ctx=ctx,
            project_dir=project_dir,
            path=active_path,
        ),
        "custom": _stage_file_payload(
            ctx=ctx,
            project_dir=project_dir,
            path=kind_paths["custom"],
        ),
        "master": _stage_file_payload(
            ctx=ctx,
            project_dir=project_dir,
            path=kind_paths["master"],
        ),
        "reverse": _stage_file_payload(
            ctx=ctx,
            project_dir=project_dir,
            path=kind_paths["reverse"],
        ),
        "pano": _stage_file_payload(
            ctx=ctx,
            project_dir=project_dir,
            path=kind_paths["pano"],
        ),
    }


def _copy_upload_to_temp_file(file: UploadFile, *, suffix: str) -> tuple[Path, int]:
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = Path(tmp.name)
            try:
                file.file.seek(0)
            except (AttributeError, OSError):
                pass
            shutil.copyfileobj(file.file, tmp)
            size = tmp.tell()
    except Exception:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise
    return tmp_path, size


def _move_dir_if_exists(old_dir: Path, new_dir: Path) -> None:
    if not old_dir.exists():
        return
    if new_dir.exists():
        raise ValueError(f"Target asset directory already exists: {new_dir}")
    new_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_dir), str(new_dir))


def _rename_scene_asset_dirs(project_dir: Path, old_name: str, new_name: str) -> None:
    _move_dir_if_exists(
        project_dir / "assets" / "scenes" / old_name,
        project_dir / "assets" / "scenes" / new_name,
    )

    old_stage_root = stage_manifest.stage_dir(project_dir, old_name).parent
    new_stage_root = stage_manifest.stage_dir(project_dir, new_name).parent
    _move_dir_if_exists(old_stage_root, new_stage_root)

    manifest = stage_manifest.load_manifest(project_dir, new_name)
    if manifest is not None:
        manifest["scene_id"] = new_name
        stage_manifest.save_manifest(project_dir, new_name, manifest)


def _scene_payload(
    scene: NovelScene,
    *,
    ctx: ProjectContext,
    project_dir: Path,
    derived_from_scene: str = "",
    base_scene: NovelScene | None = None,
) -> dict[str, Any]:
    base_scene_id = str(
        getattr(scene, "base_scene_id", "") or derived_from_scene or ""
    ).strip()
    variant_id = str(getattr(scene, "variant_id", "") or "").strip()
    time_of_day = str(getattr(scene, "time_of_day", "") or "").strip()
    if base_scene_id and not (variant_id or time_of_day):
        prefix = f"{base_scene_id}_"
        if scene.name.startswith(prefix):
            suffix = scene.name[len(prefix) :].strip()
            if suffix:
                variant_candidate, sep, time_candidate = suffix.rpartition("_")
                if sep and time_candidate in _SCENE_TIME_TOKENS:
                    variant_id = variant_candidate
                    time_of_day = time_candidate
                elif suffix in _SCENE_TIME_TOKENS:
                    time_of_day = suffix
                else:
                    variant_id = suffix
    master_path = compute_scene_master_path(project_dir, scene.name)
    reverse_master_path = compute_scene_reverse_master_path(project_dir, scene.name)
    pano_path = stage_manifest.resolve_pano_path(project_dir, scene.name)
    custom_scene_path = stage_manifest.resolve_ply_path(
        project_dir, scene.name, ply_kind="custom"
    )
    pano_url = _asset_url(ctx, project_dir, pano_path) if pano_path is not None else ""

    return {
        "name": scene.name,
        "aliases": scene.aliases,
        "scene_type": scene.scene_type,
        "base_scene_id": base_scene_id,
        "variant_id": variant_id,
        "time_of_day": time_of_day,
        "environment_prompt": scene.environment_prompt,
        "variant_prompt": getattr(scene, "variant_prompt", ""),
        "effective_environment_prompt": build_scene_effective_prompt(scene, base_scene),
        "description": scene.description,
        "derived_from_scene": derived_from_scene,
        "spatial_layout_image": scene.spatial_layout_image,
        "notes": scene.notes,
        "updated_at": newest_updated_at(
            getattr(scene, "updated_at", ""),
            tree_updated_at(project_dir / "assets" / "scenes" / scene.name),
            tree_updated_at(stage_manifest.stage_dir(project_dir, scene.name)),
        ),
        "master_path": master_path,
        "master_url": _asset_url(ctx, project_dir, master_path) if master_path else "",
        "reverse_master_path": reverse_master_path,
        "reverse_master_url": (
            _asset_url(ctx, project_dir, reverse_master_path)
            if reverse_master_path
            else ""
        ),
        "pano_path": str(pano_path) if pano_path is not None else "",
        "pano_url": pano_url,
        "custom_scene_path": (
            str(custom_scene_path) if custom_scene_path is not None else ""
        ),
        "custom_scene_url": (
            _asset_url(ctx, project_dir, custom_scene_path)
            if custom_scene_path is not None
            else ""
        ),
        "stage_3gs": _stage_3gs_payload(
            ctx=ctx,
            project_dir=project_dir,
            scene_name=scene.name,
        ),
    }


async def _require_scene(store: SQLiteStore, name: str) -> NovelScene | None:
    return await store.get_scene(name)


async def _derived_scene_names_for(store: SQLiteStore, scene_name: str) -> list[str]:
    scenes = await store.list_scenes()
    return sorted(
        str(scene.name).strip()
        for scene in scenes
        if str(scene.name or "").strip()
        and str(getattr(scene, "base_scene_id", "") or "").strip() == scene_name
    )


async def _is_derived_scene(store: SQLiteStore, scene_name: str) -> bool:
    scene = await store.get_scene(scene_name)
    return bool(scene and str(getattr(scene, "base_scene_id", "") or "").strip())


async def _derived_scene_guard_error(store: SQLiteStore, scene_name: str) -> str:
    derived_names = await _derived_scene_names_for(store, scene_name)
    if derived_names:
        preview = "、".join(derived_names[:5])
        suffix = "…" if len(derived_names) > 5 else ""
        return f"场景「{scene_name}」存在派生场景：{preview}{suffix}；请先处理派生场景"
    return ""


def _scene_plate_preview_payload(
    *,
    scene_id: str,
    variant_id: str,
    time_of_day: str,
    resolved_scene_name: str,
    time_baked: bool,
    planned_scene_name: str = "",
) -> dict[str, Any]:
    has_time = bool(str(time_of_day or "").strip())
    if not has_time:
        render_status = "no_time"
        render_relight = False
        render_label = f"Render：将使用 {resolved_scene_name}，锁图光"
        seedance_label = f"Seedance2：将喂入 {resolved_scene_name}，提示词时间：无"
    elif planned_scene_name and planned_scene_name != resolved_scene_name:
        render_status = "planned_missing"
        render_relight = True
        render_label = (
            f"Render：已规划 {planned_scene_name} 但暂无图，将使用 "
            f"{resolved_scene_name}，relight 到 {time_of_day}"
        )
        seedance_label = (
            f"Seedance2：将喂入 {resolved_scene_name}，提示词时间：{time_of_day}"
        )
    elif time_baked:
        render_status = "time_baked"
        render_relight = False
        render_label = f"Render：将使用 {resolved_scene_name}，锁图光"
        seedance_label = (
            f"Seedance2：将喂入 {resolved_scene_name}，提示词时间：{time_of_day}"
        )
    else:
        render_status = "relight"
        render_relight = True
        render_label = f"Render：将使用 {resolved_scene_name}，relight 到 {time_of_day}"
        seedance_label = (
            f"Seedance2：将喂入 {resolved_scene_name}，提示词时间：{time_of_day}"
        )

    return {
        "scene_id": scene_id,
        "variant_id": variant_id,
        "time_of_day": time_of_day,
        "resolved_scene_name": resolved_scene_name,
        "planned_scene_name": planned_scene_name,
        "time_baked": time_baked,
        "render": {
            "resolved_scene_name": resolved_scene_name,
            "planned_scene_name": planned_scene_name,
            "relight": render_relight,
            "status": render_status,
            "label": render_label,
        },
        "seedance2": {
            "resolved_scene_name": resolved_scene_name,
            "prompt_time_of_day": time_of_day,
            "label": seedance_label,
        },
    }


def _compose_scene_asset_name(
    name: str,
    base_scene_id: str = "",
    variant_id: str = "",
    time_of_day: str = "",
) -> str:
    base = str(base_scene_id or "").strip()
    variant = str(variant_id or "").strip()
    scene_time = str(time_of_day or "").strip()
    if not base:
        return str(name or "").strip()
    scene_name = base
    if variant:
        scene_name = compose_derived_scene_name(scene_name, variant)
    if scene_time:
        scene_name = compose_derived_scene_name(scene_name, scene_time)
    return scene_name


@router.get("/projects/{project}/scenes")
async def list_scenes(
    project: str,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="viewer")
    )
    scenes = await store.list_scenes()
    scenes_by_name = {
        scene.name: scene for scene in scenes if str(scene.name or "").strip()
    }
    return {
        "ok": True,
        "data": [
            _scene_payload(
                scene,
                ctx=ctx,
                project_dir=project_dir,
                derived_from_scene=str(
                    getattr(scene, "base_scene_id", "") or ""
                ).strip(),
                base_scene=scenes_by_name.get(
                    str(getattr(scene, "base_scene_id", "") or "")
                ),
            )
            for scene in scenes
        ],
    }


@router.get("/projects/{project}/scenes/plate-preview")
async def preview_scene_plate(
    project: str,
    scene_id: str = Query(default=""),
    variant_id: str = Query(default=""),
    time_of_day: str = Query(default=""),
    user: dict = Depends(get_api_user),
):
    scene_id = scene_id if isinstance(scene_id, str) else ""
    variant_id = variant_id if isinstance(variant_id, str) else ""
    time_of_day = time_of_day if isinstance(time_of_day, str) else ""
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="viewer")
    )
    scene_records = await store.list_scenes()
    resolved_scene_name, time_baked = resolve_scene_plate_from_records(
        scene_id,
        variant_id,
        time_of_day,
        scene_records,
    )
    planned_scene_name = ""
    if time_baked:
        resolved_master_path = compute_scene_master_path(
            project_dir, resolved_scene_name
        )
        if not resolved_master_path:
            planned_scene_name = resolved_scene_name
            resolved_scene_name, _unused_time_baked = resolve_scene_plate_from_records(
                scene_id,
                variant_id,
                "",
                scene_records,
            )
            time_baked = False
    return {
        "ok": True,
        "data": _scene_plate_preview_payload(
            scene_id=scene_id,
            variant_id=variant_id,
            time_of_day=time_of_day,
            resolved_scene_name=resolved_scene_name,
            time_baked=time_baked,
            planned_scene_name=planned_scene_name,
        ),
    }


@router.get("/projects/{project}/scenes/{name}/pano/manifest")
async def get_scene_pano_manifest(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="viewer")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    manifest = build_pano_viewer_manifest(
        ctx=ctx,
        project_dir=project_dir,
        scene_name=scene.name,
        mode="scene",
    )
    if manifest is None:
        return {"ok": False, "error": "当前场景没有 360 全景资产"}
    return {"ok": True, "data": manifest.model_dump(exclude_none=True)}


@router.patch("/projects/{project}/scenes/{name}/pano/correction")
async def update_scene_pano_correction(
    project: str,
    name: str,
    correction: PanoViewerCorrection,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="editor")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    stage_manifest.set_pano_correction(
        project_dir,
        scene.name,
        correction.model_dump(),
    )
    manifest = build_pano_viewer_manifest(
        ctx=ctx,
        project_dir=project_dir,
        scene_name=scene.name,
        mode="scene",
    )
    if manifest is None:
        return {"ok": False, "error": "当前场景没有 360 全景资产"}
    return {"ok": True, "data": manifest.model_dump(exclude_none=True)}


@router.get("/projects/{project}/scenes/{name}/director-stage/manifest")
async def get_scene_director_stage_manifest(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="viewer")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    manifest = build_director_stage_manifest(
        ctx=ctx,
        project_dir=project_dir,
        scene_name=scene.name,
        mode="scene",
    )
    if manifest is None:
        return {"ok": False, "error": "当前场景没有 3GS 资产"}
    return {"ok": True, "data": manifest.model_dump(exclude_none=True)}


@router.post("/projects/{project}/scenes/{name}/director-stage/world")
async def save_scene_director_world(
    project: str,
    name: str,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="editor")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    snapshot = body.get("snapshot")
    if not isinstance(snapshot, dict):
        return {"ok": False, "error": "snapshot is required"}
    source_id = str(body.get("active_source_id") or "").strip()
    try:
        active_source = body.get("active_source")
        saved = stage_manifest.save_scene_director_world(
            project_dir,
            scene.name,
            active_source_id=source_id,
            snapshot=snapshot,
            active_source=active_source if isinstance(active_source, dict) else None,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    manifest = build_director_stage_manifest(
        ctx=ctx,
        project_dir=project_dir,
        scene_name=scene.name,
        mode="scene",
    )
    return {
        "ok": True,
        "data": {
            **saved,
            "manifest": (
                manifest.model_dump(exclude_none=True) if manifest is not None else None
            ),
        },
    }


@router.post("/projects/{project}/scenes/{name}/director-stage/world/source")
async def save_scene_director_world_source(
    project: str,
    name: str,
    body: dict[str, Any],
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="editor")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    snapshot = body.get("snapshot")
    if not isinstance(snapshot, dict):
        return {"ok": False, "error": "snapshot is required"}
    source_id = str(body.get("source_id") or "").strip()
    try:
        source = body.get("source")
        saved = stage_manifest.save_scene_director_world_source(
            project_dir,
            scene.name,
            source_id=source_id,
            snapshot=snapshot,
            source=source if isinstance(source, dict) else None,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    manifest = build_director_stage_manifest(
        ctx=ctx,
        project_dir=project_dir,
        scene_name=scene.name,
        mode="scene",
    )
    return {
        "ok": True,
        "data": {
            **saved,
            "manifest": (
                manifest.model_dump(exclude_none=True) if manifest is not None else None
            ),
        },
    }


@router.post("/projects/{project}/scenes/{name}/director-stage/world/clear")
async def clear_scene_director_world(
    project: str,
    name: str,
    body: dict[str, Any] | None = None,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user, required_role="editor")
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    body = body or {}
    saved = stage_manifest.clear_scene_director_world(
        project_dir,
        scene.name,
        active_source_id=str(body.get("active_source_id") or "").strip() or None,
    )
    return {"ok": True, "data": saved}


@router.post("/projects/{project}/scenes")
async def create_scene(
    project: str,
    body: SceneCreate,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    name = _compose_scene_asset_name(
        body.name,
        body.base_scene_id,
        body.variant_id,
        body.time_of_day,
    )
    if not name:
        return {"ok": False, "error": "Scene name is required"}
    existing = await store.get_scene(name)
    if existing is not None:
        return {"ok": False, "error": f"Scene '{name}' already exists"}

    scene = NovelScene(
        name=name,
        aliases=body.aliases,
        scene_type=body.scene_type,
        base_scene_id=body.base_scene_id.strip(),
        variant_id=body.variant_id.strip(),
        time_of_day=body.time_of_day.strip(),
        environment_prompt=body.environment_prompt,
        variant_prompt=body.variant_prompt,
        description=body.description,
        spatial_layout_image=body.spatial_layout_image,
        notes=body.notes,
    )
    await store.add_scene(scene)
    return {
        "ok": True,
        "data": _scene_payload(
            scene,
            ctx=ctx,
            project_dir=project_dir,
        ),
    }


@router.patch("/projects/{project}/scenes/{name}")
async def update_scene(
    project: str,
    name: str,
    body: SceneUpdate,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    requested_name = str(updates.pop("name", "") or "").strip()
    next_base = str(
        updates.get("base_scene_id", getattr(scene, "base_scene_id", "")) or ""
    ).strip()
    next_variant = str(
        updates.get("variant_id", getattr(scene, "variant_id", "")) or ""
    ).strip()
    next_time = str(
        updates.get("time_of_day", getattr(scene, "time_of_day", "")) or ""
    ).strip()
    structured_name = _compose_scene_asset_name(
        requested_name or scene.name, next_base, next_variant, next_time
    )
    if next_base:
        requested_name = structured_name
    if requested_name and requested_name != scene.name:
        guard_error = await _derived_scene_guard_error(store, scene.name)
        if guard_error:
            return {"ok": False, "error": guard_error}
        if await store.get_scene(requested_name) is not None:
            return {"ok": False, "error": f"Scene '{requested_name}' already exists"}
        try:
            _rename_scene_asset_dirs(project_dir, scene.name, requested_name)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        renamed = await store.rename_scene(scene.name, requested_name)
        if not renamed:
            return {"ok": False, "error": f"Scene '{scene.name}' rename failed"}
        scene = await _require_scene(store, requested_name) or scene
    if updates:
        await store.update_scene(scene.name, **updates)
        scene = await _require_scene(store, scene.name) or scene

    return {
        "ok": True,
        "data": _scene_payload(
            scene,
            ctx=ctx,
            project_dir=project_dir,
        ),
    }


@router.post("/projects/{project}/scenes/{name}/delete")
async def delete_scene(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    guard_error = await _derived_scene_guard_error(store, scene.name)
    if guard_error:
        return {"ok": False, "error": guard_error}
    deleted = await store.delete_scene(scene.name)
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/scenes/build")
async def build_scenes(project: str, user: dict = Depends(get_api_user)):
    ctx, username, project_name, _project_dir, output_dir, store = (
        await _resolve_scene_project(
            project,
            user,
            required_role="editor",
        )
    )
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="build_scenes",
            queue_kind="default",
            episode=0,
            payload={"output_dir": output_dir},
        )
        return {
            "ok": True,
            "task_type": "build_scenes",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("build_scenes", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": "场景补充任务已进入队列",
        }

    return {"ok": False, "error": "场景补充需要 project context"}


@router.post("/projects/{project}/scenes/{name}/master/upload")
async def upload_scene_master(
    project: str,
    name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    try:
        from PIL import Image

        img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    except Exception as exc:
        return {"ok": False, "error": f"Invalid image file: {exc}"}

    master_path = canonical_scene_master_path(project_dir, scene.name)
    master_path.parent.mkdir(parents=True, exist_ok=True)
    if master_path.exists():
        master_path.replace(master_path.parent / f"master_{int(time.time())}.png")
    img.save(master_path, format="PNG")

    return {
        "ok": True,
        "data": _scene_payload(
            scene,
            ctx=ctx,
            project_dir=project_dir,
        ),
    }


@router.post("/projects/{project}/scenes/{name}/master/delete")
async def delete_scene_master(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    master_path = compute_scene_master_path(project_dir, scene.name)
    deleted = False
    if master_path:
        Path(master_path).unlink(missing_ok=True)
        deleted = True
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/scenes/{name}/master/generate-async")
async def generate_scene_master(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    return await _start_scene_reference_task(
        project=project,
        name=name,
        kind="master",
        user=user,
    )


@router.post("/projects/{project}/scenes/{name}/reverse/generate-async")
async def generate_scene_reverse_master(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    return await _start_scene_reference_task(
        project=project,
        name=name,
        kind="reverse_master",
        user=user,
    )


async def _start_scene_reference_task(
    *,
    project: str,
    name: str,
    kind: str,
    user: dict,
    store: SQLiteStore | None = None,
):
    (
        ctx,
        username,
        project_name,
        project_dir,
        output_dir,
        resolved_store,
    ) = await _resolve_scene_project(project, user)
    store = store or resolved_store
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    scope = scene_reference_asset_scope(scene.name, kind)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="scene_reference_asset",
            queue_kind="default",
            episode=0,
            scope=scope,
            payload={
                "scene_name": scene.name,
                "kind": kind,
                "style": _project_style(username, project_name),
                "output_dir": output_dir,
            },
        )
        return {
            "ok": True,
            "task_type": "scene_reference_asset",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "scene_reference_asset", ctx.project_id, 0, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"场景「{scene.name}」{kind} 生成任务已进入队列",
        }

    return {"ok": False, "error": "场景参考图生成需要 project context"}


@router.post("/projects/{project}/scenes/{name}/pano/upload")
async def upload_scene_pano(
    project: str,
    name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    try:
        from PIL import Image

        img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    except Exception as exc:
        return {"ok": False, "error": f"Invalid image file: {exc}"}

    width, height = img.size
    if height <= 0 or abs((width / height) - 2.0) > 0.08:
        return {
            "ok": False,
            "error": f"360 panorama must be close to 2:1 equirectangular; got {width}x{height}",
        }

    out_dir = stage_manifest.stage_dir(project_dir, scene.name)
    out_dir.mkdir(parents=True, exist_ok=True)
    pano_path = out_dir / "pano_360.png"
    if pano_path.exists():
        pano_path.replace(out_dir / f"pano_360_{int(time.time())}.png")
    img.save(pano_path, format="PNG")
    stage_manifest.update_manifest(
        project_dir,
        scene.name,
        clear_fields=[
            "ply_path",
            "collision_glb_path",
            "voxel_json_path",
            "pano_sharp_args",
            "splat_transform_args",
        ],
        pano_path=pano_path.name,
        source="uploaded_360",
    )

    return {
        "ok": True,
        "data": _scene_payload(
            scene,
            ctx=ctx,
            project_dir=project_dir,
        ),
    }


@router.post("/projects/{project}/scenes/{name}/pano/delete")
async def delete_scene_pano(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    pano_path = stage_manifest.resolve_pano_path(project_dir, scene.name)
    deleted = False
    if pano_path is not None:
        pano_path.unlink(missing_ok=True)
        deleted = True
    stage_manifest.update_manifest(
        project_dir,
        scene.name,
        clear_fields=[
            "source",
            "pano_path",
            "ply_path",
            "collision_glb_path",
            "voxel_json_path",
            "pano_sharp_args",
            "splat_transform_args",
        ],
    )
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/scenes/{name}/custom/upload")
async def upload_scene_custom_package(
    project: str,
    name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    suffix = Path(str(file.filename or "")).suffix.lower()
    if suffix not in {".ply", ".sog", ".splat", ".ksplat"}:
        return {
            "ok": False,
            "error": "Custom scene package must be .ply, .sog, .splat, or .ksplat",
        }

    tmp_path, size = _copy_upload_to_temp_file(file, suffix=suffix)
    if size == 0:
        tmp_path.unlink(missing_ok=True)
        return {"ok": False, "error": "Custom scene package is empty"}

    from novelvideo import stage_asset_tasks

    try:
        stage_asset_tasks.upload_scene_package(project_dir, scene.name, tmp_path)
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    return {
        "ok": True,
        "data": _scene_payload(
            scene,
            ctx=ctx,
            project_dir=project_dir,
        ),
    }


@router.post("/projects/{project}/scenes/{name}/custom/delete")
async def delete_scene_custom_package(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    custom_scene_path = stage_manifest.resolve_ply_path(
        project_dir, scene.name, ply_kind="custom"
    )
    active_ply_path = stage_manifest.resolve_ply_path(project_dir, scene.name)
    deleted = False
    if custom_scene_path is not None:
        custom_scene_path.unlink(missing_ok=True)
        deleted = True

    clear_fields = ["custom_scene_path"]
    manifest = stage_manifest.load_manifest(project_dir, scene.name) or {}
    if manifest.get("source") == "custom_scene" or (
        custom_scene_path is not None
        and active_ply_path is not None
        and custom_scene_path.resolve() == active_ply_path.resolve()
    ):
        clear_fields.extend(
            [
                "source",
                "ply_path",
                "collision_glb_path",
                "voxel_json_path",
                "splat_transform_args",
            ]
        )
    stage_manifest.update_manifest(project_dir, scene.name, clear_fields=clear_fields)

    return {"ok": True, "data": {"deleted": deleted}}


async def _start_3gs_single_face_task(
    *,
    project: str,
    name: str,
    source_kind: str,
    user: dict,
    store: SQLiteStore,
):
    ctx, username, project_name, project_dir, output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    source_kind = str(source_kind or "master").strip().lower()
    if source_kind == "reverse":
        if not compute_scene_reverse_master_path(project_dir, scene.name):
            return {
                "ok": False,
                "error": "缺少 reverse_master.png，请先生成 reverse master",
            }
    elif not compute_scene_master_path(project_dir, scene.name):
        return {"ok": False, "error": "缺少 master.png，请先上传或生成场景源图"}

    params = {
        "source_kind": source_kind,
        "face_name": "front",
        "depth_meters": 8.0,
        "device": "auto",
        "face_size": 768,
        "internal_size": 1536,
        "max_gaussians_per_face": 1_000_000,
        "timeout_seconds": 1800,
    }
    try:
        scope, queued = await _start_or_enqueue_stage_asset(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            scene_name=scene.name,
            step="single_face_sharp",
            params=params,
        )
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "task_type": "stage_asset",
        "scope": scope,
        "source": source_kind,
        **(queued or {}),
        "message": f"场景「{scene.name}」{source_kind} → SOG 任务已启动",
    }


@router.post("/projects/{project}/scenes/{name}/3gs/master-ply/generate-async")
async def generate_scene_3gs_master_ply(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    return await _start_3gs_single_face_task(
        project=project,
        name=name,
        source_kind="master",
        user=user,
        store=None,
    )


@router.post("/projects/{project}/scenes/{name}/3gs/reverse-ply/generate-async")
async def generate_scene_3gs_reverse_ply(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    return await _start_3gs_single_face_task(
        project=project,
        name=name,
        source_kind="reverse",
        user=user,
        store=None,
    )


@router.post("/projects/{project}/scenes/{name}/3gs/pano-ply/generate-async")
async def generate_scene_3gs_pano_ply(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}
    if stage_manifest.resolve_pano_path(project_dir, scene.name) is None:
        return {"ok": False, "error": "缺少 pano_360.png，请先上传或生成 360 全景"}

    params = {
        "geometry_mode": "pano-depth",
        "depth_source": "da2",
        "depth_device": "auto",
        "device": "auto",
        "pano_depth_width": 2048,
        "pano_depth_point_scale": 0.72,
        "pano_depth_min_scale": 0.0008,
        "pano_depth_max_scale": 0.045,
        "pano_depth_opacity": 0.96,
        "pano_depth_radius_scale": 1.0,
        "face_size": 768,
        "internal_size": 1536,
        "max_gaussians_per_face": 1_000_000,
        "timeout_seconds": 1800,
    }
    try:
        scope, queued = await _start_or_enqueue_stage_asset(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            scene_name=scene.name,
            step="pano_sharp",
            params=params,
        )
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "task_type": "stage_asset",
        "scope": scope,
        "source": "pano",
        **(queued or {}),
        "message": f"场景「{scene.name}」360 → SOG 任务已启动",
    }


@router.post("/projects/{project}/scenes/{name}/pano/generate-async")
async def generate_scene_pano(
    project: str,
    name: str,
    body: ScenePanoGenerateRequest,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, output_dir, store = (
        await _resolve_scene_project(project, user)
    )
    scene = await _require_scene(store, name)
    if scene is None:
        return {"ok": False, "error": f"Scene '{name}' not found"}

    source = body.source
    if source == "master" and not compute_scene_master_path(project_dir, scene.name):
        source = "text"
    step = f"pano_from_{source}"

    params: dict[str, Any] = {
        "description": _scene_360_description(scene),
        "style": body.style or _project_style(username, project_name),
        "timeout_seconds": body.timeout_seconds,
    }
    for key in ("provider", "model", "image_size", "quality"):
        value = getattr(body, key)
        if value:
            params[key] = value

    try:
        scope, queued = await _start_or_enqueue_stage_asset(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            scene_name=scene.name,
            step=step,
            params=params,
        )
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "task_type": "stage_asset",
        "scope": scope,
        "source": source,
        **(queued or {}),
        "message": f"场景「{scene.name}」360 全景生成任务已启动",
    }
