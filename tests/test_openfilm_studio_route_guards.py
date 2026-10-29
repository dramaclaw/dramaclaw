# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The frame is Studio's, the data is Dramaclaw's. Two Studio routes reach past the editor into the
host's own bookkeeping: PATCH /api/projects/:id moves the project folder — which is the node id the
host finds a film by, so renaming orphans every cut made in it — and the boot-time examples prefetch
calls GitHub from the server that holds every tenant's media. Hiding them in the UI is not enough:
the browser is handed the studio key, so both stay reachable without the editor asking."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPO_ROOT / "scripts" / "openfilm_studio" / "run.mjs"
SERVER = REPO_ROOT / "vendor" / "openfilm" / "studio" / "server" / "server.mjs"


def forced(source: str, flag: str) -> bool:
    return bool(re.search(rf'process\.env\.{flag}\s*=\s*"1"', source))


def test_launcher_forces_the_host_guards() -> None:
    source = LAUNCHER.read_text(encoding="utf-8")
    for flag in ["OPENFILM_NO_RENAME", "OPENFILM_NO_EXAMPLES"]:
        assert forced(source, flag), f"run.mjs must force {flag} rather than inherit it"


def test_rename_endpoint_refuses_when_renaming_is_off() -> None:
    source = SERVER.read_text(encoding="utf-8")
    handler = source[source.index("if (req.method === 'PATCH') {"):]
    guard = handler[: handler.index("renameProject(")]
    assert "OPENFILM_NO_RENAME" in guard, (
        "a rename moves the folder the host names the film by, so the cut left behind is unreachable: "
        "the route has to refuse, not just lose its button"
    )


def test_examples_are_not_fetched_from_github_at_boot() -> None:
    source = SERVER.read_text(encoding="utf-8")
    prefetch = [line for line in source.splitlines() if "void listExamples()" in line]
    assert prefetch, "the boot prefetch anchor moved"
    assert all("OPENFILM_NO_EXAMPLES" in line for line in prefetch), (
        "the vendored editor's example index lives on GitHub; a shared server fetching it at every "
        "start both phones home for each tenant and puts an OpenFilm address in the logs"
    )
