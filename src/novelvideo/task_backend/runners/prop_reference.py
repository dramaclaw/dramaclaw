"""Celery runners for prop reference image generation."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager


def run_prop_reference_asset(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_prop_reference_asset(envelope, ctx),
            envelope,
            task_type="prop_reference_asset",
        )
    )


async def _run_prop_reference_asset(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    from novelvideo.cognee import CogneeStore
    from novelvideo.generators.nanobanana_prop import generate_prop_reference

    payload = envelope.get("payload") or {}
    prop_name = str(payload["prop_name"])
    style = str(payload.get("style") or "")
    model = str(payload.get("model") or "")
    output_dir = Path(str(payload.get("output_dir") or ctx.output_dir))
    scope = envelope.get("scope")
    manager = get_task_manager()

    store = CogneeStore(ctx.owner_project_label, output_dir=str(output_dir))
    await store.initialize()
    try:
        prop = await store.sqlite_store.get_prop(prop_name)
        if prop is None:
            raise RuntimeError(f"找不到道具: {prop_name}")
        visual_prompt = prop.visual_prompt or prop.description or prop.name
        prop_dir = output_dir / "assets" / "props" / prop.name
        prop_dir.mkdir(parents=True, exist_ok=True)
        output_path = prop_dir / "reference_3view.png"
        manager.update_progress_for_project(
            ctx,
            "prop_reference_asset",
            0,
            scope=scope,
            progress=0.50,
            current_task="调用图像模型生成三视图...",
        )
        result_path = await generate_prop_reference(
            visual_prompt=visual_prompt,
            output_path=str(output_path),
            style=style,
            project_dir=str(output_dir),
            model=model,
        )
        if not result_path:
            raise RuntimeError("图像 API 未返回有效图像")
        return {"prop_name": prop.name, "path": str(result_path), "style": style}
    finally:
        await store.close()


def run_batch_prop_ref(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_batch_prop_ref(envelope, ctx),
            envelope,
            task_type="batch_prop_ref",
        )
    )


async def _run_batch_prop_ref(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    from novelvideo.cognee import CogneeStore
    from novelvideo.generators.nanobanana_prop import generate_prop_reference

    payload = envelope.get("payload") or {}
    style = str(payload.get("style") or "")
    model = str(payload.get("model") or "")
    output_dir = Path(str(payload.get("output_dir") or ctx.output_dir))
    manager = get_task_manager()

    store = CogneeStore(ctx.owner_project_label, output_dir=str(output_dir))
    await store.initialize()
    await store.load_graph_state()
    try:
        props = await store.sqlite_store.list_props()
        props_to_gen = [
            prop
            for prop in props
            if not (output_dir / "assets" / "props" / prop.name / "reference_3view.png").exists()
        ]
        if not props_to_gen:
            return {"generated": 0}

        generated = 0
        for index, prop in enumerate(props_to_gen, start=1):
            current = f"生成三视图: {prop.name}..."
            manager.update_progress_for_project(
                ctx,
                "batch_prop_ref",
                0,
                progress=index / len(props_to_gen),
                current_task=current,
                logs=[current],
            )
            prop_dir = output_dir / "assets" / "props" / prop.name
            prop_dir.mkdir(parents=True, exist_ok=True)
            result = await generate_prop_reference(
                visual_prompt=prop.visual_prompt or prop.description or prop.name,
                output_path=str(prop_dir / "reference_3view.png"),
                style=style,
                project_dir=str(output_dir),
                model=model,
            )
            if result:
                generated += 1
        return {"generated": generated}
    finally:
        await store.close()


register_project_task_runner("prop_reference_asset", run_prop_reference_asset)
register_project_task_runner("batch_prop_ref", run_batch_prop_ref)
