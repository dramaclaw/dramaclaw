# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Guard tests that start the real Node canvas core.

The CI job installing Node 22 and building frontend/dist-canvas-server sets
DRAMACLAW_TEST_REQUIRE_CANVAS_CORE=1 so missing prerequisites fail instead of skipping.
"""

import os
from pathlib import Path
import shutil

import pytest

CANVAS_CORE_BUNDLE = (
    Path(__file__).resolve().parents[1] / "frontend/dist-canvas-server/canvas-core-worker.mjs"
)
REQUIRE_ENV = "DRAMACLAW_TEST_REQUIRE_CANVAS_CORE"


def _skip_unless_required(missing: bool, reason: str):
    return pytest.mark.skipif(missing and os.environ.get(REQUIRE_ENV) != "1", reason=reason)


requires_node = _skip_unless_required(
    shutil.which("node") is None,
    "node unavailable: put Node 22 on PATH",
)
requires_canvas_core_bundle = _skip_unless_required(
    shutil.which("node") is None or not CANVAS_CORE_BUNDLE.is_file(),
    "Build frontend with pnpm run build:canvas-server and put Node 22 on PATH",
)
