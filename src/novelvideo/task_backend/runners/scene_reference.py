"""Celery runner for canonical scene reference images."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager


def run_scene_reference_asset(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_scene_reference_asset(envelope, ctx),
            envelope,
            task_type="scene_reference_asset",
        )
    )


async def _run_scene_reference_asset(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    from novelvideo.cognee import CogneeStore
    from novelvideo.config import (
        IMAGE_DEFAULT_STYLE,
        IMAGE_GENERATION_SELECTIONS,
        get_style_preset,
        normalize_image_generation_selection,
    )
    from novelvideo.generators.scene_reference_images import generate_scene_reference_image

    payload = envelope.get("payload") or {}
    scene_name = str(payload["scene_name"])
    kind = str(payload["kind"])
    style = str(payload.get("style") or "")
    model_selection = str(payload.get("model") or "").strip()
    scope = envelope.get("scope")
    output_dir = Path(str(payload.get("output_dir") or ctx.output_dir))
    manager = get_task_manager()

    if kind not in {"master", "spatial_layout", "reverse_master"}:
        raise ValueError(f"Unsupported scene reference kind: {kind}")

    def update(progress: float, current_task: str) -> None:
        manager.update_progress_for_project(
            ctx,
            "scene_reference_asset",
            0,
            scope=scope,
            progress=progress,
            current_task=current_task,
            logs=[current_task],
        )

    update(0.10, "加载场景数据...")
    store = CogneeStore(ctx.owner_project_label, output_dir=str(output_dir))
    await store.initialize()
    try:
        scene = await store.sqlite_store.get_scene(scene_name)
        if scene is None:
            raise RuntimeError(f"找不到场景: {scene_name}")
        base_scene = None
        base_scene_id = str(getattr(scene, "base_scene_id", "") or "").strip()
        if base_scene_id and base_scene_id != scene.name:
            base_scene = await store.sqlite_store.get_scene(base_scene_id)

        style_id = (style or IMAGE_DEFAULT_STYLE).strip() or IMAGE_DEFAULT_STYLE
        preset = get_style_preset(
            style_id,
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=str(output_dir),
        )
        style_prompt = str(preset.get("style_instructions", "") or "").strip()
        avoid_instructions = str(preset.get("avoid_instructions", "") or "").strip()
        style_label = preset.get("label") or style_id
        style_name = f"{style_label} ({style_id})"

        update(0.40, f"调用图像模型生成 {kind}...")
        provider = None
        model = None
        if model_selection:
            normalized_selection = normalize_image_generation_selection(model_selection)
            selected_image_source = IMAGE_GENERATION_SELECTIONS[normalized_selection]
            provider = selected_image_source["provider"]
            model = selected_image_source["model"]
        output_path = await generate_scene_reference_image(
            project_dir=output_dir,
            scene=scene,
            kind=kind,  # type: ignore[arg-type]
            provider=provider,
            model=model,
            style_name=style_name,
            style_prompt=style_prompt,
            avoid_instructions=avoid_instructions,
            base_scene=base_scene,
        )
        if kind == "spatial_layout":
            rel_path = str(Path(output_path).relative_to(output_dir))
            await store.sqlite_store.update_scene(scene_name, spatial_layout_image=rel_path)
        return {
            "scene_name": scene_name,
            "kind": kind,
            "path": str(output_path),
            "style": style_name,
        }
    finally:
        await store.close()


register_project_task_runner("scene_reference_asset", run_scene_reference_asset)
