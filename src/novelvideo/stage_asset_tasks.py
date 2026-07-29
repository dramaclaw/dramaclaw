"""3GS stage asset build steps (subprocess wrappers).

Each function is a synchronous subprocess invocation that produces a deterministic
output file under
`<project_dir>/director_worlds/<scene_safe>/v1/`. They update
`stage_manifest.json` after each step so other parts of the system (paths.py,
DirectorWorldService.make_3gs_editor_url, sketch_studio dual-entry) can find the
3GS assets via the manifest.

These run in the task backend runner; the caller wraps them and reports progress.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from novelvideo.director_world import block_world_builder, pano_sharp, stage_manifest
from novelvideo.director_world.paths import safe_name, world_path
from novelvideo.ports import get_usage_meter
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.subprocesses import run_project_subprocess
from novelvideo.utils.path_resolver import (
    compute_scene_master_path,
    compute_scene_reverse_master_path,
    compute_scene_spatial_layout_path,
)

logger = logging.getLogger(__name__)


SPATIAL_CONTRACT_SCHEMA_VERSION = "scene_spatial_contract_v8_topology_only_locks"
SPATIAL_CONTRACT_DEFAULT_MODEL = "openai/gpt-5.5"
SAFE_SEAM_SPHERE_YAW_DEG = -90.0


def _run_credit_coro(coro_factory):
    """Run async credit helpers from this synchronous subprocess wrapper."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro_factory())

    ctx = contextvars.copy_context()
    result: dict[str, Any] = {}

    def runner() -> None:
        try:
            result["value"] = ctx.run(lambda: asyncio.run(coro_factory()))
        except BaseException as exc:  # noqa: BLE001
            result["error"] = exc

    thread = threading.Thread(target=runner, name="stage-asset-credit", daemon=True)
    thread.start()
    thread.join()
    if "error" in result:
        raise result["error"]
    return result.get("value")


def _clean_trace_value(value: Any) -> str:
    return str(value or "").strip()


def _read_scene_360_provider_trace(generation_dir: Path) -> dict[str, str]:
    manifest_path = Path(generation_dir) / "scene_360_manifest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.debug("scene_360 trace manifest unavailable: %s", exc)
        return {}
    if not isinstance(payload, dict):
        return {}
    request_id = _clean_trace_value(
        payload.get("request_id")
        or payload.get("provider_request_id")
        or payload.get("newapi_request_id")
    )
    provider_task_id = _clean_trace_value(
        payload.get("provider_task_id") or payload.get("task_id")
    )
    response_id = _clean_trace_value(
        payload.get("response_id") or payload.get("provider_response_id")
    )
    trace: dict[str, str] = {}
    if request_id:
        trace["request_id"] = request_id
    if provider_task_id:
        trace["provider_task_id"] = provider_task_id
    if response_id:
        trace["response_id"] = response_id
    return trace


def _scene_360_credit_billing_params(
    *,
    image_size: str,
    quality: str,
) -> dict[str, str]:
    params: dict[str, str] = {}
    clean_size = str(image_size or "").strip().lower()
    if clean_size:
        params["size"] = clean_size
    clean_quality = str(quality or "").strip().lower()
    if clean_quality:
        params["quality"] = clean_quality
    return params


def _reserve_scene_360_model_call(
    model: str,
    *,
    provider: str,
    image_size: str,
    quality: str,
) -> str:
    model_name = str(model or "").strip()
    if not model_name:
        return ""

    async def _reserve() -> str:
        return await get_usage_meter().reserve_current_model_call_credit(
            model=model_name,
            resource_kind="render",
            billing_kind="image",
            billing_params=_scene_360_credit_billing_params(
                image_size=image_size,
                quality=quality,
            ),
            metadata={"source": "scene_360_subprocess", "provider": provider},
        )

    return str(_run_credit_coro(_reserve) or "")


def _refund_scene_360_model_call(
    reservation_id: str,
    *,
    provider: str,
    error: str,
) -> None:
    if not reservation_id:
        return

    async def _refund() -> None:
        await get_usage_meter().refund_model_call_credit_reservation(
            reservation_id,
            metadata={
                "source": "scene_360_subprocess",
                "provider": provider,
                "error": error[:200],
            },
        )

    try:
        _run_credit_coro(_refund)
    except Exception as exc:  # noqa: BLE001
        logger.debug("scene_360 credit refund failed: %s", exc)


def _confirm_scene_360_model_call(
    *,
    model: str,
    reservation_id: str,
    provider: str,
    provider_request_id: str = "",
    provider_task_id: str = "",
    provider_response_id: str = "",
) -> None:
    if not reservation_id:
        return

    async def _confirm() -> None:
        await get_usage_meter().bump_model_call(
            user_id=None,
            model=model,
            resource_kind="render",
            provider_request_id=provider_request_id,
            provider_task_id=provider_task_id,
            credit_reservation_id=reservation_id,
            metadata={
                "source": "scene_360_subprocess",
                "provider": provider,
                **({"response_id": provider_response_id} if provider_response_id else {}),
            },
        )

    try:
        _run_credit_coro(_confirm)
    except Exception as exc:  # noqa: BLE001
        logger.debug("scene_360 credit confirm failed: %s", exc)


def resolve_scene_360_image_provider(provider: str = "") -> str:
    """Return the provider used by scene 360 image generation."""
    return (
        (
            provider
            or os.environ.get("SCENE_360_IMAGE_PROVIDER")
            or os.environ.get("SCENE_360_PROVIDER")
            or os.environ.get("NANOBANANA_PROVIDER")
            or "newapi"
        )
        .strip()
        .lower()
    )


def resolve_scene_360_image_model(provider: str = "", model: str = "") -> str:
    """Return the model used by scene 360 image generation."""
    resolved_provider = resolve_scene_360_image_provider(provider)
    resolved_model = str(model or "").strip()
    if resolved_model:
        from novelvideo.config import IMAGE_GENERATION_SELECTIONS

        selection = IMAGE_GENERATION_SELECTIONS.get(resolved_model)
        if selection and selection.get("provider") == resolved_provider:
            return str(selection.get("model") or "").strip()
        return resolved_model
    if resolved_provider in {"huimeng", "huimengi"}:
        return (
            os.environ.get("SCENE_360_HUIMENG_MODEL")
            or os.environ.get("HUIMENG_IMAGE_MODEL")
            or "image-2"
        )
    if resolved_provider == "openai":
        return os.environ.get("OPENAI_IMAGE_MODEL") or "gpt-image-2"
    if resolved_provider == "newapi":
        return (
            os.environ.get("SCENE_360_IMAGE_MODEL")
            or os.environ.get("NEWAPI_IMAGE_MODEL")
            or "gpt-image-2"
        )
    if resolved_provider == "openrouter":
        return (
            os.environ.get("SCENE_360_OPENROUTER_MODEL")
            or os.environ.get("OPENROUTER_GPT_IMAGE2_MODEL")
            or "openai/gpt-5.4-image-2"
        )
    return ""


def _json_file_has_schema(path: Path, schema_version: str) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return data.get("schema_version") == schema_version


def splat_transform_executable() -> Path:
    """Locate the splat-transform CLI (PLY→SOG compression).

    Resolution: ``ST_SPLAT_TRANSFORM_BIN`` env override → on PATH. Install with
    ``npm install -g @playcanvas/splat-transform`` (the CE Docker image does this
    when built with ``INSTALL_WORLD=1``). Metadata in pyproject.toml
    ``[tool.supertale.external-tools.splat-transform]``.
    """
    override = os.environ.get("ST_SPLAT_TRANSFORM_BIN", "").strip()
    if override:
        candidate = Path(override)
        if candidate.exists():
            return candidate
    on_path = shutil.which("splat-transform")
    if on_path:
        return Path(on_path)
    raise FileNotFoundError(
        "splat-transform not found on PATH. Install it with "
        "`npm install -g @playcanvas/splat-transform` "
        "(or set ST_SPLAT_TRANSFORM_BIN to its path)."
    )


SCENE_PACKAGE_SUFFIXES = {".ply", ".sog", ".splat", ".ksplat"}


def _keep_raw_3gs_ply() -> bool:
    return str(os.environ.get("KEEP_RAW_3GS_PLY") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _sog_path_for_ply(path: Path) -> Path:
    return Path(path).with_suffix(".sog")


def _compress_ply_to_sog(
    ply_path: Path,
    sog_path: Path | None = None,
    *,
    timeout_seconds: int = 1800,
    progress_callback: Callable[[float, str], None] | None = None,
) -> Path:
    """Compress a generated PLY into PlayCanvas SOG format.

    SHARP emits PLY. Browser-facing assets should use SOG because raw PLY files
    are too large to load repeatedly in Freezone / supertale-fe.
    """
    src = Path(ply_path)
    if src.suffix.lower() != ".ply":
        return src
    if not src.exists():
        raise FileNotFoundError(f"PLY not found for SOG compression: {src}")
    dest = Path(sog_path) if sog_path is not None else _sog_path_for_ply(src)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cli = splat_transform_executable()
    cmd = [str(cli), "-w"]
    iterations = str(os.environ.get("SOG_COMPRESSION_ITERATIONS") or "").strip()
    if iterations:
        cmd.extend(["-i", iterations])
    gpu = str(os.environ.get("SOG_COMPRESSION_GPU") or "").strip()
    if gpu:
        cmd.extend(["-g", gpu])
    cmd.extend([str(src), str(dest)])
    if progress_callback:
        progress_callback(0.88, "压缩 3GS PLY → SOG...")
    logger.info("running splat-transform SOG compression: %s", " ".join(cmd))
    proc = run_project_subprocess(
        cmd,
        cwd=dest.parent,
        capture_output=True,
        text=True,
        timeout=int(timeout_seconds),
    )
    if proc.returncode != 0 or not dest.exists():
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"PLY → SOG 压缩失败: {message[-2000:]}")
    return dest


def _archive_existing(path: Path, timestamp: str) -> Path | None:
    if not path.exists():
        return None
    archived = path.with_name(f"{path.stem}_{timestamp}{path.suffix}")
    path.replace(archived)
    return archived


def _cleanup_raw_ply(*paths: Path | None) -> None:
    if _keep_raw_3gs_ply():
        return
    for path in paths:
        if path is None:
            continue
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            logger.warning("failed to remove raw 3GS PLY: %s", path)


def upload_scene_package(
    project_dir: Path,
    scene_id: str,
    src_asset: Path,
    *,
    target_name: str | None = None,
) -> dict[str, Any]:
    """Copy a user-provided custom 3GS scene package into the v1 stage directory."""
    src = Path(src_asset)
    if not src.exists():
        raise FileNotFoundError(f"3GS scene package not found: {src}")
    suffix = src.suffix.lower()
    if suffix not in SCENE_PACKAGE_SUFFIXES:
        raise ValueError("Custom scene package must be .ply, .sog, .splat, or .ksplat")
    out_dir = stage_manifest.stage_dir(project_dir, scene_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    if target_name is None:
        target_name = f"custom{suffix}"
    dest = out_dir / target_name
    if suffix == ".ply":
        raw_dest = out_dir / Path(target_name).with_suffix(".ply").name
        shutil.copy2(src, raw_dest)
        dest = out_dir / Path(target_name).with_suffix(".sog").name
        _compress_ply_to_sog(raw_dest, dest)
        _cleanup_raw_ply(raw_dest)
    else:
        shutil.copy2(src, dest)

    stage_manifest.update_manifest(
        project_dir,
        scene_id,
        clear_fields=[
            "collision_glb_path",
            "voxel_json_path",
            "pano_sharp_args",
            "single_face_sharp_args",
            "splat_transform_args",
        ],
        ply_path=dest.name,
        custom_scene_path=dest.name,
        source="custom_scene",
    )
    return {"ok": True, "scene_path": str(dest)}


def run_splat_collision(
    project_dir: Path,
    scene_id: str,
    ply_path: Path | None = None,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Run `splat-transform -K <ply> <out>.voxel.json` to produce a collision GLB.

    The CLI's `-K` flag emits a `.voxel.json` AND a sibling `.collision.glb`.
    We glob the output dir for `*.collision.glb` afterwards because the exact
    filename is determined by the CLI, not us.
    """
    out_dir = stage_manifest.stage_dir(project_dir, scene_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    if ply_path is None:
        resolved = stage_manifest.resolve_ply_path(project_dir, scene_id)
        if resolved is None:
            raise FileNotFoundError(
                f"No PLY found in manifest for scene {scene_id!r}. Upload one first."
            )
        ply_path = resolved
    ply_path = Path(ply_path)
    if not ply_path.exists():
        raise FileNotFoundError(f"PLY not found: {ply_path}")

    voxel_out = out_dir / "scene.voxel.json"
    cli = splat_transform_executable()

    seed_pos = os.environ.get("STAGE_COLLISION_SEED_POS", "0,0,0").strip() or "0,0,0"
    profiles = [
        {
            "name": "standard",
            "label": "降级",
            "voxel_params": os.environ.get("STAGE_COLLISION_VOXEL_PARAMS", "0.16,0.38"),
            "voxel_carve": os.environ.get("STAGE_COLLISION_VOXEL_CARVE", "1.8,0.35"),
        },
        {
            "name": "coarse",
            "label": "粗略",
            "voxel_params": "0.24,0.5",
            "voxel_carve": "2.2,0.5",
        },
        {
            "name": "very_coarse",
            "label": "超粗略",
            "voxel_params": "0.32,0.62",
            "voxel_carve": "2.6,0.65",
        },
    ]

    archived_glbs: list[tuple[Path, Path]] = []
    archived_voxel: tuple[Path, Path] | None = None
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    def report(progress: float, message: str) -> None:
        if progress_callback:
            progress_callback(progress, message)

    def restore_archived_outputs() -> None:
        for original, archived in archived_glbs:
            if archived.exists() and not original.exists():
                try:
                    archived.replace(original)
                except OSError:
                    logger.warning("failed to restore archived collision GLB: %s", archived)
        if archived_voxel is not None:
            original, archived = archived_voxel
            if archived.exists() and not original.exists():
                try:
                    archived.replace(original)
                except OSError:
                    logger.warning("failed to restore archived voxel JSON: %s", archived)

    def remove_fresh_outputs() -> None:
        if voxel_out.exists():
            try:
                voxel_out.unlink()
            except OSError:
                logger.warning("failed to remove partial voxel JSON: %s", voxel_out)
        for fresh in out_dir.glob("*.collision.glb"):
            try:
                fresh.unlink()
            except OSError:
                logger.warning("failed to remove partial collision GLB: %s", fresh)

    def is_scale_failure(proc: subprocess.CompletedProcess[str]) -> bool:
        text = f"{proc.stdout or ''}\n{proc.stderr or ''}"
        return any(
            marker in text
            for marker in (
                "Map maximum size exceeded",
                "JavaScript heap out of memory",
                "Allocation failed",
                "Array buffer allocation failed",
            )
        )

    # Move stale collision GLBs aside so glob below picks only fresh output.
    # If splat-transform fails, restore the last known-good files.
    for stale in out_dir.glob("*.collision.glb"):
        try:
            archived = stale.with_name(f"{stale.name}.{timestamp}.bak")
            stale.replace(archived)
            archived_glbs.append((stale, archived))
        except OSError:
            pass

    if voxel_out.exists():
        try:
            archived = voxel_out.with_name(f"{voxel_out.name}.{timestamp}.bak")
            voxel_out.replace(archived)
            archived_voxel = (voxel_out, archived)
        except OSError:
            pass

    failures: list[str] = []
    proc: subprocess.CompletedProcess[str] | None = None
    selected_profile: dict[str, str] | None = None
    for idx, profile in enumerate(profiles):
        remove_fresh_outputs()
        cmd = [
            str(cli),
            "-w",
            "-K",
            "--seed-pos",
            seed_pos,
            "--voxel-params",
            str(profile["voxel_params"]),
            "--voxel-carve",
            str(profile["voxel_carve"]),
            str(ply_path),
            str(voxel_out),
        ]
        report(0.40 + idx * 0.10, f"生成调度区域（{profile['label']}精度）...")
        logger.info("running splat-transform: %s", " ".join(cmd))
        proc = run_project_subprocess(
            cmd,
            cwd=out_dir,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode == 0:
            selected_profile = profile
            break

        failures.append(
            f"profile={profile['name']} exit={proc.returncode} "
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
        )
        if not is_scale_failure(proc) or idx == len(profiles) - 1:
            restore_archived_outputs()
            raise RuntimeError("splat-transform failed: " + "\n".join(failures))
        report(0.45 + idx * 0.10, "调度区域过细，自动降低精度重试...")

    if proc is None or selected_profile is None:
        restore_archived_outputs()
        raise RuntimeError("splat-transform failed before starting")

    glbs = list(out_dir.glob("*.collision.glb"))
    if not glbs:
        restore_archived_outputs()
        raise RuntimeError(
            "splat-transform completed but no *.collision.glb produced in "
            f"{out_dir}. stdout={proc.stdout!r} stderr={proc.stderr!r}"
        )
    collision_glb = sorted(glbs, key=lambda p: p.stat().st_mtime, reverse=True)[0]

    voxel_name = voxel_out.name if voxel_out.exists() else None
    stage_manifest.update_manifest(
        project_dir,
        scene_id,
        collision_glb_path=collision_glb.name,
        voxel_json_path=voxel_name,
        splat_transform_args={
            "flag": "-K",
            "overwrite": True,
            "profile": selected_profile["name"],
            "seed_pos": seed_pos,
            "voxel_params": selected_profile["voxel_params"],
            "voxel_carve": selected_profile["voxel_carve"],
        },
    )

    for _, archived in archived_glbs:
        try:
            archived.unlink()
        except OSError:
            pass
    if archived_voxel is not None:
        try:
            archived_voxel[1].unlink()
        except OSError:
            pass

    return {
        "ok": True,
        "collision_glb_path": str(collision_glb),
        "voxel_json_path": str(voxel_out) if voxel_out.exists() else None,
        "profile": selected_profile["name"],
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "stdout_tail": (proc.stdout or "")[-2000:],
        "retry_failures": failures,
    }


def run_pano_sharp(
    project_dir: Path,
    scene_id: str,
    pano_path: Path | None = None,
    *,
    artifact_dir: Path | None = None,
    update_manifest: bool = True,
    depth_source: str = "da2",
    depth_device: str = "auto",
    device: str = "auto",
    geometry_mode: str = "pano-depth",
    pano_depth_width: int = 2048,
    pano_depth_point_scale: float = 0.72,
    pano_depth_min_scale: float = 0.0008,
    pano_depth_max_scale: float = 0.045,
    pano_depth_opacity: float = 0.96,
    pano_depth_radius_scale: float = 1.0,
    face_size: int = 768,
    internal_size: int = 1536,
    max_gaussians_per_face: int = 1_000_000,
    timeout_seconds: int = 1800,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Run the package SHARP module to build a 360-derived PLY."""

    def report(progress: float, message: str) -> None:
        if progress_callback:
            progress_callback(progress, message)

    project_dir = Path(project_dir)
    out_dir = (
        Path(artifact_dir)
        if artifact_dir is not None
        else stage_manifest.stage_dir(project_dir, scene_id)
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    if pano_path is None:
        resolved = stage_manifest.resolve_pano_path(project_dir, scene_id)
        if resolved is None:
            raise FileNotFoundError("缺少 pano_360.png。请先上传或生成 360 全景。")
        pano_path = resolved
    pano_path = Path(pano_path)
    if not pano_path.exists():
        raise FileNotFoundError(f"pano_360.png not found: {pano_path}")

    if not pano_sharp.sharp_available():
        raise pano_sharp.Sharp3DUnavailable()

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    run_dir = out_dir / "pano_sharp_runs" / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    geometry_mode = str(geometry_mode or "pano-depth").strip().lower().replace("_", "-")
    if geometry_mode in {"pano-depth-debug", "depth-debug", "depth"}:
        geometry_mode = "pano-depth"
    if geometry_mode not in {"pano-depth", "sharp"}:
        raise ValueError(f"unknown pano geometry_mode: {geometry_mode}")
    output_name = "pano_depth.ply" if geometry_mode == "pano-depth" else "pano_sharp_merged.ply"
    generated_ply = run_dir / output_name
    dest_ply = out_dir / output_name
    dest_sog = _sog_path_for_ply(dest_ply)

    depth_source = str(depth_source or "da2").strip().lower()
    if depth_source == "da2" and not pano_sharp.da2_available():
        logger.warning("DA-2 package is not installed; falling back to constant depth.")
        report(0.18, "DA-2 未安装，降级使用 constant depth；几何质量会降低。")
        depth_source = "constant"
    depth_device = (
        str(depth_device or os.environ.get("PANO_SHARP_DEPTH_DEVICE") or "auto").strip().lower()
    )
    device = str(device or os.environ.get("PANO_SHARP_DEVICE") or "auto").strip().lower()
    face_size = int(face_size)
    internal_size = int(internal_size)
    max_gaussians_per_face = int(max_gaussians_per_face)
    # Viewer pano_correction is a display-only initial-view adjustment. The
    # pano->PLY path must cut the raw 2:1 panorama using the production topology
    # contract; otherwise a saved viewer yaw can rotate every cubemap face.
    front_yaw_deg = 0.0
    sphere_yaw_deg = 0.0
    sphere_pitch_deg = 0.0
    sphere_roll_deg = 0.0

    def _fallback_unavailable_mps(name: str) -> str:
        if name != "mps":
            return name
        try:
            import torch  # type: ignore

            if torch.backends.mps.is_available():
                return name
        except Exception:
            pass
        return "auto"

    device = _fallback_unavailable_mps(device)
    depth_device = _fallback_unavailable_mps(depth_device)

    cmd = [
        sys.executable,
        "-m",
        "novelvideo.director_world.pano_sharp",
        "--pano",
        str(pano_path),
        "--output-dir",
        str(run_dir),
        "--depth-source",
        depth_source,
        "--depth-device",
        depth_device,
        "--geometry-mode",
        geometry_mode,
        "--device",
        device,
    ]
    if geometry_mode == "pano-depth":
        cmd.extend(
            [
                "--pano-depth-width",
                str(int(pano_depth_width)),
                "--pano-depth-radius-scale",
                str(float(pano_depth_radius_scale)),
                "--pano-depth-point-scale",
                str(float(pano_depth_point_scale)),
                "--pano-depth-min-scale",
                str(float(pano_depth_min_scale)),
                "--pano-depth-max-scale",
                str(float(pano_depth_max_scale)),
                "--pano-depth-opacity",
                str(float(pano_depth_opacity)),
                "--pano-depth-output-name",
                output_name,
            ]
        )
    else:
        cmd.extend(
            [
                "--face-size",
                str(face_size),
                "--internal-size",
                str(internal_size),
            ]
        )
        if max_gaussians_per_face > 0:
            cmd.extend(["--max-gaussians-per-face", str(max_gaussians_per_face)])

    report(
        0.20,
        (
            "启动 360 → depth 3GS..."
            if geometry_mode == "pano-depth"
            else "启动 pano_sharp：360 → cubemap → SHARP → 3GS..."
        ),
    )
    logger.info("running pano ply builder: %s", " ".join(cmd[:2] + ["..."]))
    proc = run_project_subprocess(
        cmd,
        capture_output=True,
        text=True,
        timeout=int(timeout_seconds),
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"pano_sharp 失败: {message[-2000:]}")

    if not generated_ply.exists():
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(
            "360 PLY 生成器成功退出，但没有写出目标 PLY: " f"{generated_ply}. {message[-1000:]}"
        )

    archived_sog = _archive_existing(dest_sog, timestamp)
    archived_ply: Path | None = None
    try:
        _compress_ply_to_sog(
            generated_ply,
            dest_sog,
            timeout_seconds=max(300, min(int(timeout_seconds), 1800)),
            progress_callback=progress_callback,
        )
    except Exception:
        dest_sog.unlink(missing_ok=True)
        if archived_sog is not None and archived_sog.exists():
            archived_sog.replace(dest_sog)
        raise

    if _keep_raw_3gs_ply():
        archived_ply = _archive_existing(dest_ply, timestamp)
        shutil.copy2(generated_ply, dest_ply)
    else:
        _cleanup_raw_ply(generated_ply, dest_ply)
    if archived_sog is not None:
        archived_sog.unlink(missing_ok=True)
        archived_sog = None

    report(0.90, f"{dest_sog.name} 已写入 3GS 资产包")
    if update_manifest:
        existing_source = (stage_manifest.load_manifest(project_dir, scene_id) or {}).get("source")
        manifest_source = (
            existing_source
            if existing_source in {"uploaded_360", "uploaded_master", "text_to_360"}
            else "uploaded_360"
        )
        stage_manifest.update_manifest(
            project_dir,
            scene_id,
            clear_fields=[
                "collision_glb_path",
                "voxel_json_path",
                "splat_transform_args",
            ],
            ply_path=dest_sog.name,
            pano_ply_path=dest_sog.name,
            pano_depth_ply_path=(dest_sog.name if geometry_mode == "pano-depth" else None),
            source=manifest_source,
            pano_sharp_args={
                "script": "novelvideo.director_world.pano_sharp",
                "geometry_mode": geometry_mode,
                "depth_source": depth_source,
                "depth_device": depth_device,
                "device": device,
                "face_size": face_size,
                "internal_size": internal_size,
                "max_gaussians_per_face": max_gaussians_per_face,
                "pano_depth_width": int(pano_depth_width),
                "pano_depth_radius_scale": float(pano_depth_radius_scale),
                "pano_depth_point_scale": float(pano_depth_point_scale),
                "pano_depth_min_scale": float(pano_depth_min_scale),
                "pano_depth_max_scale": float(pano_depth_max_scale),
                "pano_depth_opacity": float(pano_depth_opacity),
                "global_depth_align": geometry_mode == "sharp",
                "global_depth_warp_strength": 1.0 if geometry_mode == "sharp" else None,
                "front_yaw_deg": front_yaw_deg,
                "sphere_correction_deg": {
                    "yaw": sphere_yaw_deg,
                    "pitch": sphere_pitch_deg,
                    "roll": sphere_roll_deg,
                },
                "run_dir": str(run_dir),
            },
        )

    return {
        "ok": True,
        "scene_id": scene_id,
        "pano_path": str(pano_path),
        "ply_path": str(dest_sog),
        "sog_path": str(dest_sog),
        "raw_ply_path": str(dest_ply) if dest_ply.exists() else None,
        "run_dir": str(run_dir),
        "archived_ply": str(archived_ply) if archived_ply else None,
        "archived_sog": str(archived_sog) if archived_sog else None,
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "stdout_tail": (proc.stdout or "")[-2000:],
        "stderr_tail": (proc.stderr or "")[-2000:],
    }


def run_single_face_sharp(
    project_dir: Path,
    scene_id: str,
    image_path: Path | None = None,
    *,
    artifact_dir: Path | None = None,
    update_manifest: bool = True,
    source_kind: str = "master",
    face_name: str = "front",
    depth_meters: float = 8.0,
    device: str = "auto",
    face_size: int = 768,
    internal_size: int = 1536,
    max_gaussians_per_face: int = 1_000_000,
    timeout_seconds: int = 1800,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Run SHARP directly on one perspective image and save it as a source-specific PLY."""

    def report(progress: float, message: str) -> None:
        if progress_callback:
            progress_callback(progress, message)

    project_dir = Path(project_dir)
    out_dir = (
        Path(artifact_dir)
        if artifact_dir is not None
        else stage_manifest.stage_dir(project_dir, scene_id)
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    source_kind = str(source_kind or "master").strip().lower()
    if source_kind not in {"master", "reverse"}:
        raise ValueError(f"unknown single-face source_kind: {source_kind}")

    if image_path is None:
        if source_kind == "reverse":
            reverse_path = compute_scene_reverse_master_path(project_dir, scene_id)
            if not reverse_path:
                raise FileNotFoundError("缺少 reverse_master.png。请先生成 reverse master。")
            image_path = Path(reverse_path)
        else:
            master_path = compute_scene_master_path(project_dir, scene_id)
            if not master_path:
                raise FileNotFoundError("缺少 master.png。请先上传或生成场景源图。")
            image_path = Path(master_path)
    image_path = Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"single-face source image not found: {image_path}")

    if not pano_sharp.sharp_available():
        raise pano_sharp.Sharp3DUnavailable()

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    run_dir = out_dir / "single_face_sharp_runs" / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    generated_ply = run_dir / "pano_sharp_merged.ply"
    dest_ply = out_dir / ("reverse_sharp.ply" if source_kind == "reverse" else "master_sharp.ply")
    dest_sog = _sog_path_for_ply(dest_ply)

    device = str(device or os.environ.get("PANO_SHARP_DEVICE") or "auto").strip().lower()
    if device == "mps":
        try:
            import torch  # type: ignore

            if not torch.backends.mps.is_available():
                device = "auto"
        except Exception:
            device = "auto"

    cmd = [
        sys.executable,
        "-m",
        "novelvideo.director_world.pano_sharp",
        "--image",
        str(image_path),
        "--output-dir",
        str(run_dir),
        "--single-face-name",
        str(face_name or "front"),
        "--depth-source",
        "constant",
        "--depth-meters",
        str(float(depth_meters)),
        "--device",
        device,
        "--face-size",
        str(int(face_size)),
        "--internal-size",
        str(int(internal_size)),
    ]
    if int(max_gaussians_per_face) > 0:
        cmd.extend(["--max-gaussians-per-face", str(int(max_gaussians_per_face))])

    report(0.20, f"启动 single-face SHARP：{source_kind} → 单面 3GS...")
    logger.info("running single-face sharp: %s", " ".join(cmd[:2] + ["..."]))
    proc = run_project_subprocess(
        cmd,
        capture_output=True,
        text=True,
        timeout=int(timeout_seconds),
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"single-face SHARP 失败: {message[-2000:]}")

    if not generated_ply.exists():
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(
            "single-face SHARP 成功退出，但没有写出 pano_sharp_merged.ply: "
            f"{generated_ply}. {message[-1000:]}"
        )

    archived_sog = _archive_existing(dest_sog, timestamp)
    archived_ply: Path | None = None
    try:
        _compress_ply_to_sog(
            generated_ply,
            dest_sog,
            timeout_seconds=max(300, min(int(timeout_seconds), 1800)),
            progress_callback=progress_callback,
        )
    except Exception:
        dest_sog.unlink(missing_ok=True)
        if archived_sog is not None and archived_sog.exists():
            archived_sog.replace(dest_sog)
        raise

    if _keep_raw_3gs_ply():
        archived_ply = _archive_existing(dest_ply, timestamp)
        shutil.copy2(generated_ply, dest_ply)
    else:
        _cleanup_raw_ply(generated_ply, dest_ply)
    if archived_sog is not None:
        archived_sog.unlink(missing_ok=True)
        archived_sog = None

    report(0.90, f"{source_kind} single-face SOG 已写入 3GS 资产包")
    path_field = "reverse_ply_path" if source_kind == "reverse" else "master_ply_path"
    args_field = "reverse_sharp_args" if source_kind == "reverse" else "master_sharp_args"
    manifest_source = "single_face_reverse" if source_kind == "reverse" else "single_face_master"
    args_payload = {
        "script": "novelvideo.director_world.pano_sharp",
        "source_kind": source_kind,
        "image_path": str(image_path),
        "face_name": str(face_name or "front"),
        "depth_meters": float(depth_meters),
        "device": device,
        "face_size": int(face_size),
        "internal_size": int(internal_size),
        "max_gaussians_per_face": int(max_gaussians_per_face),
        "run_dir": str(run_dir),
    }
    if update_manifest:
        stage_manifest.update_manifest(
            project_dir,
            scene_id,
            clear_fields=[
                "collision_glb_path",
                "voxel_json_path",
                "splat_transform_args",
            ],
            ply_path=dest_sog.name,
            source=manifest_source,
            single_face_sharp_args=args_payload,
            **{path_field: dest_sog.name, args_field: args_payload},
        )

    return {
        "ok": True,
        "scene_id": scene_id,
        "image_path": str(image_path),
        "ply_path": str(dest_sog),
        "sog_path": str(dest_sog),
        "raw_ply_path": str(dest_ply) if dest_ply.exists() else None,
        "run_dir": str(run_dir),
        "archived_ply": str(archived_ply) if archived_ply else None,
        "archived_sog": str(archived_sog) if archived_sog else None,
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "stdout_tail": (proc.stdout or "")[-2000:],
        "stderr_tail": (proc.stderr or "")[-2000:],
    }


def _with_pano_voxel_ref_instructions(description: str) -> str:
    return "\n\n".join(
        [
            description.strip(),
            "参考图来源：REFERENCE 1 是 spatial_layout.png。不要使用 360 四视图作为模型输入。",
            "参考图顺序：spatial_layout。",
            (
                "REFERENCE 1 spatial_layout.png 是 TOP-DOWN / FLOOR PLAN / 俯视平面布局图。"
                "它不是透视照片、不是相机视角、不是墙面立面图。"
                "请把图中 2D 平面位置解释为 voxel world 的 X/Z 地面坐标；"
                "垂直高度 Y 由物体类别推断。"
            ),
            (
                "房间边界、门窗、柜台、桌椅组、通道、固定物件的相对位置和数量"
                "优先服从 spatial_layout.png。"
            ),
            (
                "请生成语义 voxel world.json：保持主要固定物件的相对位置和可编辑性，"
                "不要放人物、剧情动作或临时道具。"
            ),
        ]
    )


def _compress_model_reference(
    source_path: Path,
    output_dir: Path,
    *,
    max_side: int = 960,
    jpeg_quality: int = 72,
) -> Path:
    """Write a compact JPEG copy for multimodal model submission."""
    from PIL import Image

    source_path = Path(source_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    target_path = output_dir / f"{source_path.stem}.model_ref.jpg"
    with Image.open(source_path) as image:
        image = image.convert("RGB")
        width, height = image.size
        longest = max(width, height)
        if max_side > 0 and longest > max_side:
            scale = max_side / longest
            image = image.resize(
                (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
                Image.Resampling.LANCZOS,
            )
        image.save(
            target_path,
            format="JPEG",
            quality=max(40, min(95, int(jpeg_quality))),
            optimize=True,
        )
    return target_path


def run_scene_360(
    project_dir: Path,
    scene_id: str,
    *,
    source: str,
    description: str = "",
    provider: str = "",
    model: str = "",
    style: str = "",
    image_size: str = "",
    quality: str = "",
    master_path_override: str | Path | None = None,
    reverse_master_path_override: str | Path | None = None,
    artifact_dir: str | Path | None = None,
    update_manifest: bool = True,
    timeout_seconds: int = 1800,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Generate `pano_360.png` from a scene master image or text description."""

    def report(progress: float, message: str) -> None:
        if progress_callback:
            progress_callback(progress, message)

    project_dir = Path(project_dir)
    source = str(source or "").strip().lower()
    if source not in {"master", "text"}:
        raise ValueError("scene 360 source must be 'master' or 'text'")

    out_dir = (
        Path(artifact_dir) if artifact_dir else stage_manifest.stage_dir(project_dir, scene_id)
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    generation_dir = out_dir / "scene_360_generation"
    generation_dir.mkdir(parents=True, exist_ok=True)

    provider = resolve_scene_360_image_provider(provider)
    resolved_model = resolve_scene_360_image_model(provider=provider, model=model)
    style = (style or os.environ.get("SCENE_360_STYLE") or "realistic").strip()
    image_size = (image_size or os.environ.get("SCENE_360_IMAGE_SIZE") or "2K").strip()
    quality = (
        quality
        or os.environ.get("SCENE_360_IMAGE_QUALITY")
        or os.environ.get("HUIMENG_IMAGE_QUALITY")
        or "medium"
    ).strip()
    description = description.strip() or "\n".join(
        [
            f"场景名称：{scene_id}",
            "请生成 2:1 equirectangular 360 全景，用于 3GS 片场生成。",
            "只包含固定场景环境，不放人物、动作或剧情道具。",
            (
                "硬性要求：水平首尾闭合无缝；在 360 查看器里墙线、门窗、地面和天花板"
                "连续稳定；不要普通广角图、鱼眼、cubemap、多宫格、边框、文字水印、"
                "镜像重复、畸变拉伸、极点黑洞或断裂 seam。"
            ),
        ]
    )

    cmd = [
        sys.executable,
        "-m",
        "novelvideo.director_world.scene_360_builder",
        "--scene-name",
        scene_id,
        "--output-dir",
        str(generation_dir),
        "--provider",
        provider,
        "--scene-description",
        description,
        "--style",
        style,
        "--image-size",
        image_size,
        "--quality",
        quality,
    ]
    if resolved_model:
        cmd.extend(["--model", resolved_model])

    manifest_source = "text_to_360"
    master_path = ""
    reverse_master_path = ""
    overlap_analysis_path = ""
    spatial_contract_path = ""
    spatial_contract_model = (
        os.environ.get("SCENE_SPATIAL_CONTRACT_MODEL")
        or os.environ.get("OPENROUTER_VISION_MODEL")
        or SPATIAL_CONTRACT_DEFAULT_MODEL
    )
    pano_correction_payload: dict[str, Any] | None = None
    if source == "master":
        master_path = (
            str(Path(master_path_override))
            if master_path_override
            else compute_scene_master_path(project_dir, scene_id)
        )
        if not master_path:
            source = "text"
        else:
            cmd.extend(["--master", master_path])
            reverse_master_path = (
                str(Path(reverse_master_path_override))
                if reverse_master_path_override
                else compute_scene_reverse_master_path(project_dir, scene_id) or ""
            )
            if reverse_master_path:
                cmd.extend(["--reverse-master", reverse_master_path])
                pano_correction_payload = {
                    "front_yaw_deg": 0.0,
                    "sphere_correction_deg": {
                        "yaw": SAFE_SEAM_SPHERE_YAW_DEG,
                        "pitch": 0.0,
                        "roll": 0.0,
                    },
                    "source": "scene_360_master_reverse_safe_seam",
                }
                analysis_path = (
                    Path(master_path).parent
                    / "overlap_continuation_test"
                    / "overlap_continuation_analysis.json"
                )
                overlap_analysis_path = str(analysis_path)
                latest_input_mtime = max(
                    Path(master_path).stat().st_mtime,
                    Path(reverse_master_path).stat().st_mtime,
                )
                needs_analysis = (
                    not analysis_path.exists() or analysis_path.stat().st_mtime < latest_input_mtime
                )
                if needs_analysis and os.environ.get("OPENROUTER_API_KEY"):
                    report(0.12, "分析 master/reverse 侧边 overlap 和 continuation...")
                    analyzer_cmd = [
                        sys.executable,
                        "-m",
                        "novelvideo.director_world.scene_overlap_analyzer",
                        "--scene-name",
                        scene_id,
                        "--master",
                        master_path,
                        "--reverse",
                        reverse_master_path,
                        "--output-dir",
                        str(analysis_path.parent),
                    ]
                    try:
                        analyzer_proc = run_project_subprocess(
                            analyzer_cmd,
                            capture_output=True,
                            text=True,
                            timeout=240,
                        )
                        if analyzer_proc.returncode != 0:
                            logger.warning(
                                "scene overlap analyzer failed for %s: %s",
                                scene_id,
                                (analyzer_proc.stderr or analyzer_proc.stdout or "")[-800:],
                            )
                    except (TaskCancelled, TaskTimedOut):
                        raise
                    except Exception as exc:
                        logger.warning("scene overlap analyzer failed for %s: %s", scene_id, exc)
                contract_path = (
                    Path(master_path).parent
                    / "scene_spatial_contract"
                    / "scene_spatial_contract.json"
                )
                spatial_contract_path = str(contract_path)
                contract_input_mtimes = [
                    Path(master_path).stat().st_mtime,
                    Path(reverse_master_path).stat().st_mtime,
                ]
                if analysis_path.exists():
                    contract_input_mtimes.append(analysis_path.stat().st_mtime)
                latest_contract_input_mtime = max(contract_input_mtimes)
                needs_contract = (
                    not contract_path.exists()
                    or contract_path.stat().st_mtime < latest_contract_input_mtime
                    or not _json_file_has_schema(
                        contract_path,
                        SPATIAL_CONTRACT_SCHEMA_VERSION,
                    )
                )
                if needs_contract and os.environ.get("OPENROUTER_API_KEY"):
                    report(0.14, f"分析 master/reverse 空间合同 ({spatial_contract_model})...")
                    contract_cmd = [
                        sys.executable,
                        "-m",
                        "novelvideo.director_world.scene_spatial_contract",
                        "--scene-name",
                        scene_id,
                        "--master",
                        master_path,
                        "--reverse",
                        reverse_master_path,
                        "--output-dir",
                        str(contract_path.parent),
                        "--overlap-analysis",
                        str(analysis_path),
                        "--model",
                        spatial_contract_model,
                    ]
                    try:
                        contract_proc = run_project_subprocess(
                            contract_cmd,
                            capture_output=True,
                            text=True,
                            timeout=240,
                        )
                        if contract_proc.returncode != 0:
                            logger.warning(
                                "scene spatial contract failed for %s: %s",
                                scene_id,
                                (contract_proc.stderr or contract_proc.stdout or "")[-800:],
                            )
                    except (TaskCancelled, TaskTimedOut):
                        raise
                    except Exception as exc:
                        logger.warning("scene spatial contract failed for %s: %s", scene_id, exc)
            manifest_source = "uploaded_master"
    if source == "text":
        cmd.append("--text-only")

    generated = generation_dir / "scene_panorama_2to1.png"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    if generated.exists():
        generated.replace(generation_dir / f"scene_panorama_2to1_{timestamp}.png")

    report(0.20, f"启动 {provider} 生成 {image_size}/{quality} 360 全景...")
    logger.info(
        "scene_360 start: scene_id=%s source=%s provider=%s model=%s image_size=%s "
        "quality=%s style=%s has_master=%s has_reverse_master=%s text_only=%s timeout_seconds=%s",
        scene_id,
        source,
        provider,
        resolved_model,
        image_size,
        quality,
        style,
        bool(master_path),
        bool(reverse_master_path),
        source == "text",
        timeout_seconds,
    )
    logger.info("running scene 360 generator: %s", " ".join(cmd[:2] + ["..."]))
    reservation_id = _reserve_scene_360_model_call(
        resolved_model,
        provider=provider,
        image_size=image_size,
        quality=quality,
    )
    try:
        proc = run_project_subprocess(
            cmd,
            capture_output=True,
            text=True,
            timeout=int(timeout_seconds),
        )
        if proc.returncode != 0:
            message = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(f"360 全景生成失败: {message[-1200:]}")

        if not generated.exists():
            raise RuntimeError(f"360 生成器成功退出，但没有写出结果: {generated}")

        provider_trace = _read_scene_360_provider_trace(generation_dir)
        pano_path = out_dir / "pano_360.png"
        archived: Path | None = None
        if update_manifest and pano_path.exists():
            archived = pano_path.with_name(f"pano_360_{timestamp}.png")
            pano_path.replace(archived)
        shutil.copy2(generated, pano_path)

        report(
            0.90,
            "pano_360.png 已写入 3GS 资产包" if update_manifest else "360 全景候选已写入画布输出",
        )
        if update_manifest:
            stage_manifest.update_manifest(
                project_dir,
                scene_id,
                clear_fields=[
                    "ply_path",
                    "pano_ply_path",
                    "collision_glb_path",
                    "voxel_json_path",
                    "pano_sharp_args",
                    "single_face_sharp_args",
                    "splat_transform_args",
                ],
                pano_path=pano_path.name,
                source=manifest_source,
                scene_360_args={
                    "provider": provider,
                    "model": resolved_model,
                    "style": style,
                    "image_size": image_size,
                    "quality": quality,
                    "source": source,
                    "topology": "master_reverse_safe_side_seam" if pano_correction_payload else "",
                    "master_path": master_path,
                    "reverse_master_path": reverse_master_path,
                    "spatial_contract_path": spatial_contract_path,
                    "spatial_contract_model": (
                        spatial_contract_model if spatial_contract_path else ""
                    ),
                    "overlap_analysis_path": overlap_analysis_path,
                },
                pano_correction=pano_correction_payload,
            )
        result = {
            "ok": True,
            "scene_id": scene_id,
            "pano_path": str(pano_path),
            "output_path": str(pano_path),
            "source": manifest_source,
            "provider": provider,
            "model": resolved_model,
            "image_size": image_size,
            "quality": quality,
            "generation_dir": str(generation_dir),
            "archived_path": str(archived) if archived else None,
            "manifest_updated": bool(update_manifest),
            "pano_correction": pano_correction_payload,
            "request_id": provider_trace.get("request_id", ""),
            "provider_task_id": provider_trace.get("provider_task_id", ""),
            "response_id": provider_trace.get("response_id", ""),
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "stdout_tail": (proc.stdout or "")[-2000:],
        }
    except BaseException as exc:
        _refund_scene_360_model_call(
            reservation_id,
            provider=provider,
            error=exc.__class__.__name__,
        )
        raise

    _confirm_scene_360_model_call(
        model=resolved_model,
        reservation_id=reservation_id,
        provider=provider,
        provider_request_id=provider_trace.get("request_id", ""),
        provider_task_id=provider_trace.get("provider_task_id", ""),
        provider_response_id=provider_trace.get("response_id", ""),
    )
    return result


def run_voxel_world_from_360(
    project_dir: Path,
    scene_id: str,
    *,
    description: str = "",
    max_blocks: int = 80_000,
    max_abs_coord: int = 96,
    max_y: int = 64,
    timeout_seconds: int = 1800,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Generate legacy DirectorWorld `world.json` from the scene spatial layout.

    This is intentionally synchronous and UI-free. It runs inside a task worker,
    compresses spatial_layout.png, then calls the block-world generator.
    """

    def report(progress: float, message: str) -> None:
        if progress_callback:
            progress_callback(progress, message)

    project_dir = Path(project_dir)
    spatial_layout_path = compute_scene_spatial_layout_path(project_dir, scene_id)
    if not spatial_layout_path:
        raise FileNotFoundError("缺少 spatial_layout.png。请先在场景工作台生成位置图。")

    if not block_world_builder.node_available():
        raise block_world_builder.BlockWorldUnavailable()

    report(0.20, "准备 spatial_layout voxel 参考图...")
    model_refs_dir = stage_manifest.stage_dir(project_dir, scene_id) / "voxel_model_refs"
    if model_refs_dir.exists():
        shutil.rmtree(model_refs_dir)

    scene_world_path = world_path(project_dir, scene_id)
    scene_world_path.parent.mkdir(parents=True, exist_ok=True)

    base_description = description.strip() or "\n".join(
        [
            f"场景名称：{scene_id}",
            "请只根据 spatial_layout.png 生成可编辑的 voxel DirectorWorld。",
            "只放固定场景物件，不放人物、动作或剧情道具。",
        ]
    )
    full_description = _with_pano_voxel_ref_instructions(base_description)
    model_spatial_layout_path = _compress_model_reference(
        Path(spatial_layout_path),
        model_refs_dir,
        max_side=1152,
        jpeg_quality=76,
    )

    cmd = [
        sys.executable,
        "-m",
        "novelvideo.director_world.block_world_builder",
        "--description",
        full_description,
        "--output",
        str(scene_world_path),
        "--scene-id",
        safe_name(scene_id),
        "--display-name",
        scene_id,
        "--max-blocks",
        str(int(max_blocks)),
        "--max-abs-coord",
        str(int(max_abs_coord)),
        "--max-y",
        str(int(max_y)),
        "--image",
        str(model_spatial_layout_path),
    ]

    archived: Path | None = None
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    if scene_world_path.exists():
        archived = scene_world_path.with_name(f"world_{timestamp}.json")
        scene_world_path.replace(archived)

    report(0.55, "正在生成 voxel world.json...")
    logger.info("running voxel world generator: %s", " ".join(cmd[:2] + ["..."]))
    proc = run_project_subprocess(
        cmd,
        capture_output=True,
        text=True,
        timeout=int(timeout_seconds),
    )

    if proc.returncode != 0:
        failed_path: Path | None = None
        if scene_world_path.exists():
            failed_path = scene_world_path.with_name(f"world_failed_{timestamp}.json")
            scene_world_path.replace(failed_path)
        if archived is not None and archived.exists() and not scene_world_path.exists():
            archived.replace(scene_world_path)
        message = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(
            "DirectorWorld 生成失败: "
            f"{message[-1000:]}" + (f"；失败输出已保留: {failed_path}" if failed_path else "")
        )

    if not scene_world_path.exists():
        if archived is not None and archived.exists():
            archived.replace(scene_world_path)
        raise RuntimeError(
            "DirectorWorld 生成器成功退出，但没有写出 world.json: " f"{scene_world_path}"
        )

    report(0.90, "voxel world.json 已写出")
    return {
        "ok": True,
        "scene_id": scene_id,
        "world_path": str(scene_world_path),
        "pano_path": "",
        "spatial_layout_path": str(spatial_layout_path),
        "refs_dir": "",
        "ref_paths": [],
        "model_refs_dir": str(model_refs_dir),
        "model_ref_paths": [str(model_spatial_layout_path)],
        "archived_path": str(archived) if archived else None,
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "stdout_tail": (proc.stdout or "")[-2000:],
    }
