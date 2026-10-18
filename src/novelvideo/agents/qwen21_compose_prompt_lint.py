"""Lint for `generators/prompt_builder.build_qwen21_compose_prompt()` —
the sketch-free Qwen-Image 2.1 "compose" render mode (`runpod_qwen21_compose`,
added 2026-10-18). Deliberately a separate, simpler module from
`qwen21_render_prompt_lint.py`: that module's `stage` (`full`/`scene_only`/
`inpaint`) and fixed `<image2>` maximum don't apply here — a compose
prompt's image count varies per beat (1 background + N identities + M
props), and there is no review dialog surfacing these as UI-facing
severities (see `RUNPOD_QWEN21_COMPOSE_SELECTION_KEYS`'s docstring in
config.py for why no `RenderReviewStrategy` is registered for this mode
in v1) — this is a dev-time sanity check only, called by
`_build_qwen21_compose_plan()` and logged as a warning, never a hard
failure, matching how other render paths treat lint as advisory.
"""

from __future__ import annotations

import re

_IMAGE_TAG_RE = re.compile(r"<image(\d+)>")
_RESOLUTION_TOKEN_RE = re.compile(r"\b\d+:\d+\b|\b\d+K\b", re.IGNORECASE)


def lint_qwen21_compose_prompt(prompt: str, n_images: int) -> list[str]:
    """Returns a list of human-readable problem descriptions — empty means
    clean. `n_images` is the total image count including the background
    (`<image1>`), i.e. `1 + len(identity_images) + len(prop_images)`."""
    issues: list[str] = []

    if not prompt or not prompt.strip():
        issues.append("empty prompt")
        return issues

    if "\n" in prompt:
        issues.append("prompt contains a newline — must be a single paragraph")

    if '"' in prompt:
        issues.append('prompt contains a double quote (") — not allowed for this task')

    if "{{" in prompt or "}}" in prompt:
        issues.append("unresolved {{...}} identity marker left in prompt")
    if "[[" in prompt or "]]" in prompt:
        issues.append("unresolved [[...]] prop marker left in prompt")

    found_tags = {int(m.group(1)) for m in _IMAGE_TAG_RE.finditer(prompt)}

    if n_images <= 1:
        if found_tags:
            issues.append(
                f"N={n_images} (background only) must use no <imageN> tags at all, found {sorted(found_tags)}"
            )
    else:
        expected = set(range(1, n_images + 1))
        missing = sorted(expected - found_tags)
        extra = sorted(found_tags - expected)
        if missing:
            issues.append(f"missing tag(s) for N={n_images}: {missing}")
        if extra:
            issues.append(f"tag(s) out of range for N={n_images}: {extra}")

    if "photorealistic" not in prompt.lower():
        issues.append(
            "prompt does not explicitly say 'photorealistic' — rendering medium "
            "survives an edit unless explicitly targeted (real regression seen "
            "2026-10-18: output degraded to line-art without this)"
        )

    if _RESOLUTION_TOKEN_RE.search(prompt):
        issues.append("prompt contains a resolution/aspect-ratio token — output size is decided downstream")

    return issues
