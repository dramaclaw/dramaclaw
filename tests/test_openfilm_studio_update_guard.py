# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The vendored editor updates *itself* from npm: Settings → About asks the npm registry
for the `openfilm` package and POST /api/update runs `npx -y openfilm@<latest> update`,
which replaces vendor/openfilm — Dramaclaw's patched chunk and vendored server included —
and runs upstream code on the host. Nothing in the product may reach that path."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPO_ROOT / "scripts" / "openfilm_studio" / "run.mjs"
SERVER = REPO_ROOT / "vendor" / "openfilm" / "studio" / "server" / "server.mjs"


def test_launcher_starts_studio_with_update_checks_off() -> None:
    source = LAUNCHER.read_text(encoding="utf-8")
    assert re.search(
        r'process\.env\.OPENFILM_NO_UPDATE_CHECK\s*=\s*"1"', source
    ), "run.mjs must force the flag, not inherit it: a host without it leaves the editor updatable"


def test_update_endpoint_refuses_when_checks_are_off() -> None:
    source = SERVER.read_text(encoding="utf-8")
    handler = source[source.index("parts[0] === 'update'"):]
    guard = handler[: handler.index("runUpdate")]
    assert "OPENFILM_NO_UPDATE_CHECK" in guard, (
        "the /api/version flag only hides the button; the POST has to refuse too, or any caller "
        "that knows the studio key can still run an upstream self-update"
    )
