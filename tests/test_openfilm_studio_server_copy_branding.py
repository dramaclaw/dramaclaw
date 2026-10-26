# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The vendored server writes strings the platform ends up showing: toast copy, an error the editor
re-throws verbatim, a diagnostics file name, git metadata on the user's film. Renaming those is the
part a re-vendor silently undoes — the UI bundle is guarded, this half was not.

The scan skips comment lines (upstream's own prose about its product is not shipped to anyone) and
keeps an explicit exemption list for the few branded strings that must stay: upstream release-asset
URLs and the GitHub examples index, whose spelling is the address, not the name the user sees."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER = REPO_ROOT / "vendor" / "openfilm" / "studio" / "server"

BRAND = re.compile(r"(?<![A-Za-z0-9_$])OpenFilm(?![A-Za-z0-9_$])")
COMMENT = re.compile(r"^\s*(?:/?\*|//)")

# Branded text that is a machine-facing address: renaming it breaks the request rather than the copy.
EXEMPT = (
    "raw.githubusercontent.com/openfilm",
    "/mac/${arch}/OpenFilm-${arch}.dmg",
    "/win/${arch}/OpenFilm-Setup-${arch}.exe",
)


def test_no_branded_copy_survives_outside_comments() -> None:
    offenders = []
    for source in sorted(SERVER.rglob("*.mjs")):
        for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
            if COMMENT.match(line) or not BRAND.search(line):
                continue
            if any(marker in line for marker in EXEMPT):
                continue
            offenders.append(f"{source.relative_to(SERVER)}:{number}: {line.strip()[:110]}")
    assert offenders == [], "user-facing OpenFilm copy came back with the vendored server:\n" + "\n".join(offenders)


def test_provider_errors_point_at_the_embedded_chrome() -> None:
    """The embed replaces the wordmark with a settings gear, so copy that tells the person where the
    logo was points at something this build never shows."""
    for name in ["get.mjs", "captions.mjs", "providers/index.mjs", "providers/common.mjs", "providers/pixabay.mjs"]:
        source = (SERVER / name).read_text(encoding="utf-8")
        assert "OpenFilm logo" not in source, name
    assert "the gear at the top left" in (SERVER / "get.mjs").read_text(encoding="utf-8")


def test_film_history_and_diagnostics_are_attributed_to_dramaclaw() -> None:
    history = (SERVER / "history-store.mjs").read_text(encoding="utf-8")
    assert "GIT_AUTHOR_NAME: 'Dramaclaw Studio'" in history
    assert "OpenFilm" not in history
    assert "Dramaclaw diagnostics" in (SERVER / "diagnostics.mjs").read_text(encoding="utf-8")


def test_outbound_requests_do_not_identify_the_vendored_editor() -> None:
    assert "'user-agent': 'Dramaclaw-Studio'" in (SERVER / "fetch-github.mjs").read_text(encoding="utf-8")
    assert "compatible; Dramaclaw" in (SERVER / "providers/web.mjs").read_text(encoding="utf-8")
