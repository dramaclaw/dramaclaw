# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The compose workspace runs the vendored editor from inside the API image. These guard the
image's half of that contract: a missing tree, Node, browser or font must fail the build (the
smoke run) instead of a user's 「视频合成与剪辑」 click."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "Dockerfile"
DOCKERIGNORE = REPO_ROOT / ".dockerignore"
STUDIO = REPO_ROOT / "src" / "novelvideo" / "freezone" / "studio.py"


def _dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_image_ships_the_studio_tree_node_and_its_dependency() -> None:
    source = _dockerfile()
    assert "FROM node:22-bookworm-slim AS node-runtime" in source
    assert "COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node" in source
    assert "COPY vendor/openfilm ./vendor/openfilm" in source
    assert (
        "COPY --from=openfilm-deps /openfilm/node_modules ./vendor/openfilm/node_modules"
        in source
    )
    assert "COPY scripts/openfilm_studio ./scripts/openfilm_studio" in source
    assert "npm ci --omit=dev --ignore-scripts" in source, (
        "dependencies must come from the vendored lockfile, not from the build context"
    )


def test_image_installs_the_pinned_browser_and_chinese_fonts() -> None:
    source = _dockerfile()
    assert (
        "playwright-core/cli.js install --with-deps --only-shell chromium" in source
    ), "the editor's thumbnails, covers and exports need Playwright's own headless shell"
    assert "fonts-noto-cjk" in source, (
        "the headless shell carries no fonts; Chinese titles and subtitles would render as boxes"
    )
    assert "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright" in source


def test_image_browser_path_reaches_the_spawned_studio() -> None:
    assert "PLAYWRIGHT_BROWSERS_PATH=" in _dockerfile()
    assert '"PLAYWRIGHT_BROWSERS_PATH"' in STUDIO.read_text(encoding="utf-8"), (
        "studio.py drops every env var it does not pass through; a browser installed under "
        "the image's PLAYWRIGHT_BROWSERS_PATH would not be found by the spawned server"
    )


def test_image_runs_the_studio_smoke() -> None:
    assert "RUN node scripts/openfilm_studio/smoke.mjs" in _dockerfile(), (
        "without the build-time smoke a stale vendor tree or unlaunchable browser ships silently"
    )


def test_build_context_excludes_node_modules() -> None:
    assert "**/node_modules" in DOCKERIGNORE.read_text(encoding="utf-8").splitlines()
