"""Celery runner for scene stage/3GS asset jobs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import (
    raise_if_envelope_cancel_requested,
    remaining_timeout_seconds,
)
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_identity import project_task_state_key
from novelvideo.task_state import get_task_manager


def _splat_format_for_path(path: Path) -> str:
    suffix = path.suffix.lower().lstrip(".")
    return suffix if suffix in {"ply", "sog", "splat", "ksplat"} else "unknown"


def _publish_freezone_splat_result(
    result: dict[str, Any],
    *,
    project_dir: Path,
    ctx: ProjectContext,
) -> None:
    from novelvideo.api.deps import make_static_url_for_context

    ply_path_text = result.get("ply_path") or result.get("sog_path")
    if not ply_path_text:
        return
    ply_path = Path(str(ply_path_text))
    if not ply_path.exists():
        return

    try:
        rel = ply_path.relative_to(project_dir).as_posix()
    except ValueError:
        return
    output_url = make_static_url_for_context(ctx, rel)
    result["output_url"] = output_url
    result["url"] = output_url
    result["ply_url"] = output_url
    result["splat_url"] = output_url
    result["ply_path"] = output_url
    if result.get("sog_path"):
        result["sog_path"] = output_url
    result["splat_format"] = _splat_format_for_path(ply_path)
    result["media_type"] = "file"


def run_stage_asset(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any] | None:
    from novelvideo import stage_asset_tasks
    from novelvideo.api.deps import make_static_url_for_context

    payload = envelope.get("payload") or {}
    scene_name = str(payload["scene_name"])
    step = str(payload["step"])
    params = dict(payload.get("params") or {})
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    scope = envelope.get("scope")
    manager = get_task_manager()

    def check_cancel() -> None:
        raise_if_envelope_cancel_requested(envelope, task_type="stage_asset", scope=scope)

    def local_runner_timeout(default_seconds: int) -> int | None:
        return remaining_timeout_seconds(envelope, default_seconds=default_seconds)

    def update(progress: float, current_task: str) -> None:
        check_cancel()
        manager.update_progress_for_project(
            ctx,
            "stage_asset",
            0,
            scope=scope,
            progress=progress,
            current_task=current_task,
            logs=[current_task],
        )

    update(0.10, f"启动 {step}...")

    if step == "splat_collision":
        ply_param = params.get("ply_path")
        result = stage_asset_tasks.run_splat_collision(
            project_dir,
            scene_name,
            Path(ply_param) if ply_param else None,
            progress_callback=update,
        )
    elif step == "upload_scene_package":
        result = stage_asset_tasks.upload_scene_package(
            project_dir,
            scene_name,
            Path(params["src_asset"]),
            target_name=params.get("target_name"),
        )
    elif step == "pano_sharp":
        result = stage_asset_tasks.run_pano_sharp(
            project_dir,
            scene_name,
            pano_path=Path(params["pano_path"]) if params.get("pano_path") else None,
            depth_source=params.get("depth_source", "da2"),
            depth_device=params.get("depth_device", "auto"),
            device=params.get("device", "auto"),
            geometry_mode=params.get("geometry_mode", "pano-depth"),
            pano_depth_width=int(params.get("pano_depth_width", 2048)),
            pano_depth_point_scale=float(params.get("pano_depth_point_scale", 0.72)),
            pano_depth_min_scale=float(params.get("pano_depth_min_scale", 0.0008)),
            pano_depth_max_scale=float(params.get("pano_depth_max_scale", 0.045)),
            pano_depth_opacity=float(params.get("pano_depth_opacity", 0.96)),
            pano_depth_radius_scale=float(params.get("pano_depth_radius_scale", 1.0)),
            face_size=int(params.get("face_size", 768)),
            internal_size=int(params.get("internal_size", 1536)),
            max_gaussians_per_face=int(params.get("max_gaussians_per_face", 1_000_000)),
            timeout_seconds=local_runner_timeout(int(params.get("timeout_seconds", 7200))),
            progress_callback=update,
        )
    elif step == "single_face_sharp":
        image_path_param = params.get("image_path")
        result = stage_asset_tasks.run_single_face_sharp(
            project_dir,
            scene_name,
            source_kind=params.get("source_kind", "master"),
            image_path=Path(image_path_param) if image_path_param else None,
            face_name=params.get("face_name", "front"),
            depth_meters=float(params.get("depth_meters", 8.0)),
            device=params.get("device", "auto"),
            face_size=int(params.get("face_size", 768)),
            internal_size=int(params.get("internal_size", 1536)),
            max_gaussians_per_face=int(params.get("max_gaussians_per_face", 1_000_000)),
            timeout_seconds=local_runner_timeout(int(params.get("timeout_seconds", 7200))),
            progress_callback=update,
        )
    elif step == "voxel_world_from_360":
        result = stage_asset_tasks.run_voxel_world_from_360(
            project_dir,
            scene_name,
            description=params.get("description", ""),
            max_blocks=int(params.get("max_blocks", 80_000)),
            max_abs_coord=int(params.get("max_abs_coord", 96)),
            max_y=int(params.get("max_y", 64)),
            progress_callback=update,
        )
    elif step in {"pano_from_master", "pano_from_text"}:
        source = "master" if step == "pano_from_master" else "text"
        artifact_dir = params.get("artifact_dir")
        result = stage_asset_tasks.run_scene_360(
            project_dir,
            scene_name,
            source=source,
            description=params.get("description", ""),
            provider=params.get("provider", ""),
            model=params.get("model", ""),
            style=params.get("style", ""),
            image_size=params.get("image_size", ""),
            quality=params.get("quality", ""),
            master_path_override=(
                Path(params["master_path"]) if params.get("master_path") else None
            ),
            reverse_master_path_override=(
                Path(params["reverse_master_path"]) if params.get("reverse_master_path") else None
            ),
            artifact_dir=Path(artifact_dir) if artifact_dir else None,
            update_manifest=bool(params.get("update_manifest", True)),
            timeout_seconds=local_runner_timeout(int(params.get("timeout_seconds", 1800))),
            progress_callback=update,
        )
    else:
        raise ValueError(f"unknown stage_asset step: {step}")

    check_cancel()
    if isinstance(result, dict):
        pano_path_text = result.get("pano_path") or result.get("output_path")
        if pano_path_text:
            pano_path = Path(str(pano_path_text))
            if pano_path.exists():
                try:
                    rel = pano_path.relative_to(project_dir).as_posix()
                    output_url = make_static_url_for_context(ctx, rel)
                    result.setdefault("output_url", output_url)
                    result.setdefault("url", output_url)
                    result.setdefault("image_url", output_url)
                    result.setdefault("media_type", "image")
                except ValueError:
                    pass
        ply_path_text = result.get("ply_path")
        if ply_path_text:
            ply_path = Path(str(ply_path_text))
            if ply_path.exists():
                try:
                    rel = ply_path.relative_to(project_dir).as_posix()
                    output_url = make_static_url_for_context(ctx, rel)
                    result.setdefault("output_url", output_url)
                    result.setdefault("url", output_url)
                    result.setdefault("ply_url", output_url)
                    result.setdefault("splat_url", output_url)
                    result.setdefault("splat_format", _splat_format_for_path(ply_path))
                    result.setdefault("media_type", "file")
                except ValueError:
                    pass
    return result


register_project_task_runner("stage_asset", run_stage_asset)


def run_freezone_image_to_3gs(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    from novelvideo import stage_asset_tasks
    from novelvideo.freezone.jobs import ensure_freezone_dirs
    from novelvideo.freezone.paths import outputs_dir

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    scene_id = str(payload["scene_id"])
    source_path = Path(str(payload["source_path"]))
    source_kind = str(payload["source_kind"])
    params = dict(payload.get("params") or {})
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    scope = envelope.get("scope") or job_id
    manager = get_task_manager()

    def check_cancel() -> None:
        raise_if_envelope_cancel_requested(
            envelope,
            task_type="freezone_image_to_3gs",
            scope=scope,
        )

    def local_runner_timeout(default_seconds: int) -> int | None:
        return remaining_timeout_seconds(envelope, default_seconds=default_seconds)

    def update(progress: float, current_task: str) -> None:
        check_cancel()
        manager.update_progress_for_project(
            ctx,
            "freezone_image_to_3gs",
            0,
            scope=scope,
            progress=progress,
            current_task=current_task,
            logs=[current_task],
        )

    ensure_freezone_dirs(project_dir)
    artifact_dir = outputs_dir(project_dir, "freezone_image_to_3gs") / job_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    update(0.10, "准备 Freezone 3GS 输出目录...")

    if source_kind == "pano":
        result = stage_asset_tasks.run_pano_sharp(
            project_dir,
            scene_id,
            pano_path=source_path,
            artifact_dir=artifact_dir,
            update_manifest=False,
            depth_source=params.get("depth_source", "da2"),
            depth_device=params.get("depth_device", "auto"),
            device=params.get("device", "auto"),
            geometry_mode=params.get("geometry_mode", "pano-depth"),
            pano_depth_width=int(params.get("pano_depth_width", 2048)),
            pano_depth_point_scale=float(params.get("pano_depth_point_scale", 0.72)),
            pano_depth_min_scale=float(params.get("pano_depth_min_scale", 0.0008)),
            pano_depth_max_scale=float(params.get("pano_depth_max_scale", 0.045)),
            pano_depth_opacity=float(params.get("pano_depth_opacity", 0.96)),
            pano_depth_radius_scale=float(params.get("pano_depth_radius_scale", 1.0)),
            face_size=int(params.get("face_size", 768)),
            internal_size=int(params.get("internal_size", 1536)),
            max_gaussians_per_face=int(params.get("max_gaussians_per_face", 1_000_000)),
            timeout_seconds=local_runner_timeout(int(params.get("timeout_seconds", 7200))),
            progress_callback=update,
        )
    else:
        result = stage_asset_tasks.run_single_face_sharp(
            project_dir,
            scene_id,
            image_path=source_path,
            artifact_dir=artifact_dir,
            update_manifest=False,
            source_kind=source_kind,
            face_name=params.get("face_name", "front"),
            depth_meters=float(params.get("depth_meters", 8.0)),
            device=params.get("device", "auto"),
            face_size=int(params.get("face_size", 768)),
            internal_size=int(params.get("internal_size", 1536)),
            max_gaussians_per_face=int(params.get("max_gaussians_per_face", 1_000_000)),
            timeout_seconds=local_runner_timeout(int(params.get("timeout_seconds", 7200))),
            progress_callback=update,
        )

    check_cancel()
    if isinstance(result, dict):
        result["job_id"] = job_id
        result["scene_id"] = scene_id
        result["source_kind"] = source_kind
        _publish_freezone_splat_result(result, project_dir=project_dir, ctx=ctx)
        node_id = str(payload.get("node_id") or "").strip()
        if node_id:
            from novelvideo.freezone.history import (
                append_generation_history,
                build_node_history_record,
            )

            history_record = append_generation_history(
                project_dir=project_dir,
                canvas_id=str(payload.get("canvas_id") or "default"),
                node_id=node_id,
                record=build_node_history_record(
                    task_type="freezone_image_to_3gs",
                    job_id=job_id,
                    task_key=project_task_state_key(
                        "freezone_image_to_3gs",
                        ctx.project_id,
                        0,
                        scope=job_id,
                    ),
                    status="completed",
                    media_type="file",
                    result=result,
                    prompt=payload.get("prompt"),
                    extra={"scene_id": scene_id, "source_kind": source_kind},
                ),
            )
            if history_record is not None:
                result["generation_history_record"] = {
                    key: value for key, value in history_record.items() if key != "result"
                }
    return result


register_project_task_runner("freezone_image_to_3gs", run_freezone_image_to_3gs)
