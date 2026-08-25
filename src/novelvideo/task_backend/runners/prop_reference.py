"""Celery runners for prop reference image generation."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager
from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)


def _image_egress_context(envelope: dict[str, Any]) -> TrustedEgressContext | None:
    if type(envelope) is not TrustedRunnerEnvelope:
        return None
    context = envelope.get(TRUSTED_EGRESS_CONTEXT_KEY)
    if type(context) is not TrustedEgressContext:
        raise TypeError("trusted runner envelope is missing egress context")
    return context


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
    from novelvideo.generators.nanobanana_grid import scene_reference_feature_billing

    payload = envelope.get("payload") or {}
    prop_name = str(payload["prop_name"])
    style = str(payload.get("style") or "")
    model = str(payload.get("model") or "")
    output_dir = Path(str(payload.get("output_dir") or ctx.output_dir))
    scope = envelope.get("scope")
    manager = get_task_manager()
    egress_context = _image_egress_context(envelope)

    store = CogneeStore(
        ctx.owner_project_label,
        output_dir=str(output_dir),
        state_dir=str(ctx.state_dir),
    )
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
        with scene_reference_feature_billing():
            result_path = await generate_prop_reference(
                visual_prompt=visual_prompt,
                output_path=str(output_path),
                style=style,
                project_dir=str(output_dir),
                state_dir=str(ctx.state_dir),
                model=model,
                egress_context=egress_context,
            )
        if not result_path:
            raise RuntimeError("图像 API 未返回有效图像")
        await store.sqlite_store.touch_prop_asset(prop.name)
        return {"prop_name": prop.name, "path": str(result_path), "style": style}
    finally:
        await store.close()


register_project_task_runner("prop_reference_asset", run_prop_reference_asset)
