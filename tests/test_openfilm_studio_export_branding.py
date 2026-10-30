# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Exports leave the product: a deck opened in PowerPoint or an FCPXML imported into Final Cut shows the
name the generator wrote into it. Assert the vendored generators name Dramaclaw there, so a re-vendor that
restores the upstream product name fails here instead of shipping attribution the platform never claims."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER = REPO_ROOT / "vendor" / "openfilm" / "studio" / "server"

# Guarded so a `DramaclawProject`-style identifier key never counts as visible copy.
BRAND = re.compile(r"(?<![A-Za-z0-9_$])OpenFilm(?![A-Za-z0-9_$])")


@pytest.mark.parametrize(
    "name", ["slides.mjs", "fcpxml.mjs", "transcripts.mjs", "exports.mjs", "nle.mjs"]
)
def test_export_generator_never_names_the_vendored_product(name: str) -> None:
    assert not BRAND.search((SERVER / name).read_text(encoding="utf-8"))


def test_pptx_carries_dramaclaw_attribution() -> None:
    source = (SERVER / "slides.mjs").read_text(encoding="utf-8")
    assert "<dc:creator>Dramaclaw</dc:creator>" in source
    assert "<Application>Dramaclaw</Application>" in source
    assert source.count("themeXml('Dramaclaw") == 2, "the deck and notes themes lost their name"


def test_fcpxml_timeline_names_are_dramaclaw() -> None:
    source = (SERVER / "fcpxml.mjs").read_text(encoding="utf-8")
    assert "`Dramaclaw A${i + 1}`" in source
    assert 'role="titles.Dramaclaw Subtitles"' in source
    assert '<gap name="Dramaclaw"' in source


def test_subtitle_cuts_are_attributed_to_dramaclaw() -> None:
    """CUT_NOTE is written into every exported and cut-back .vtt, so it names the product the
    viewer is told they cut the subtitles in."""
    assert "as cut by hand in Dramaclaw." in (SERVER / "transcripts.mjs").read_text(encoding="utf-8")


def test_untitled_exports_are_named_for_dramaclaw() -> None:
    """An untitled export names its own file and the Final Cut project — both surface on
    someone else's machine."""
    assert "|| 'Dramaclaw'" in (SERVER / "exports.mjs").read_text(encoding="utf-8")
    assert "opts.title || 'Dramaclaw'" in (SERVER / "nle.mjs").read_text(encoding="utf-8")
