"""Per-beat prompt override storage for RunPod-based render/identity-swap
providers: Qwen-Image-Edit-2511 (`runpod_qwen_edit_render` / `_multi`) and,
since 2026-10-18, Qwen-Image 2.1 (`runpod_qwen21_render` / `_multi`).

There is no DB column for this — the render pipeline already writes a
`submitted.json` per grid under `{output_dir}/grids/epNNN/render/prompts/`,
so a small JSON sidecar file next to it, keyed by episode/beat, is
consistent with how this pipeline already persists render-time artifacts
rather than adding a migration for a dev-only feature.

Loaded by `regenerate_selected_beats()` (nanobanana_grid.py) so the single
beat "Render" button's batch path (which always re-resolves the prompt
itself) picks up a previously reviewed/AI-rewritten/hand-edited prompt
without the caller having to thread it through every call site; written by
`api/routes/generation.py`'s `qwen-edit-prompt/generate` route (AI
rewrite) and `beats/regenerate` route (hand-edited prompt from the review
dialog's Confirm).

`namespace` keeps the two providers' saved prompts from colliding on the
same beat — see `RENDER_PROMPT_NAMESPACE_BY_PROVIDER` below, used by
`task_backend/runners/render.py` and the `render_review_registry`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

# Keyed by `NanoBananaGridGenerator.provider` — generators must not import
# api.routes, and the task runner needs this mapping to pick the right
# sidecar namespace without hardcoding a provider-to-namespace `if` chain
# at every call site.
RENDER_PROMPT_NAMESPACE_BY_PROVIDER = {
    "runpod_qwen_edit": "qwen_edit",
    "runpod_qwen21_render": "qwen21_render",
}


def _sidecar_path(
    output_dir: str | Path, episode: int, beat_num: int, *, namespace: str = "qwen_edit"
) -> Path:
    return (
        Path(output_dir)
        / "prompts"
        / namespace
        / f"ep{episode:03d}"
        / f"beat_{beat_num:02d}.json"
    )


def load_qwen_edit_prompts(
    output_dir: str | Path, episode: int, beat_num: int, *, namespace: str = "qwen_edit"
) -> Optional[dict[str, Any]]:
    """Returns `{full_prompt, scene_prompt, inpaint_prompts, source,
    updated_at}` or `None` if nothing has been saved for this beat yet."""
    path = _sidecar_path(output_dir, episode, beat_num, namespace=namespace)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_qwen_edit_prompts(
    output_dir: str | Path,
    episode: int,
    beat_num: int,
    *,
    full_prompt: str = "",
    scene_prompt: str = "",
    inpaint_prompts: Optional[dict[str, str]] = None,
    source: str = "manual",
    namespace: str = "qwen_edit",
) -> None:
    from datetime import datetime, timezone

    path = _sidecar_path(output_dir, episode, beat_num, namespace=namespace)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "full_prompt": full_prompt,
        "scene_prompt": scene_prompt,
        "inpaint_prompts": inpaint_prompts or {},
        "source": source,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
