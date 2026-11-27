# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The API image must ship and start the server-side canvas worker bundle."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone import canvas_core_pool

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "Dockerfile"


def _dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_canvas_build_caches_dependencies_and_copies_only_bundle_inputs() -> None:
    source = _dockerfile()
    stage_header = "FROM node:22-bookworm-slim AS canvas-core-build\n"
    assert stage_header in source
    stage = source.split(stage_header, 1)[1].split("\nFROM ", 1)[0]
    assert "RUN corepack enable" in stage
    install = "RUN pnpm install --frozen-lockfile"
    assert install in stage
    before_install, after_install = stage.split(install, 1)
    assert [line for line in before_install.splitlines() if line.startswith("COPY ")] == [
        "COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./"
    ]
    assert [line for line in after_install.splitlines() if line.startswith("COPY ")] == [
        "COPY frontend/tsconfig*.json frontend/vite.canvas-server.config.ts ./",
        "COPY frontend/src ./src",
        "COPY frontend/public/locales ./public/locales",
    ]
    build = "RUN pnpm run build:canvas-server"
    assert build in after_install
    assert (
        after_install.index("COPY frontend/src ./src")
        < after_install.index("COPY frontend/public/locales ./public/locales")
        < after_install.index(build)
    )
    assert "COPY frontend " not in source
    assert "COPY frontend/ " not in source


def test_image_bundle_destination_matches_default_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DRAMACLAW_CANVAS_CORE_BUNDLE", raising=False)
    monkeypatch.setattr(canvas_core_pool, "_pool", None)
    pool = canvas_core_pool.get_canvas_core_pool()
    try:
        relative_dir = pool.bundle_path.parent.relative_to(REPO_ROOT).as_posix()
    finally:
        pool.close()
        canvas_core_pool._pool = None

    final_stage = _dockerfile().rsplit("\nFROM ", 1)[1]
    assert (
        f"COPY --from=canvas-core-build /canvas-core/dist-canvas-server /app/{relative_dir}"
        in final_stage
    )


def test_image_warms_and_closes_default_pool_after_uv_sync() -> None:
    final_stage = _dockerfile().rsplit("\nFROM ", 1)[1]
    smoke = (
        'RUN /app/.venv/bin/python -c "from novelvideo.freezone.canvas_core_pool '
        "import get_canvas_core_pool; pool = get_canvas_core_pool(); "
        'pool.warm(); pool.close()"'
    )
    assert smoke in final_stage
    assert final_stage.rindex("uv sync --frozen") < final_stage.index(smoke)
    assert final_stage.index("COPY --from=canvas-core-build ") < final_stage.index(smoke)
