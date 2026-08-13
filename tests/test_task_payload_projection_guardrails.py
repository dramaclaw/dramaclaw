"""The three protocol guardrails around the payload projection.

These are deliberately separate from the coverage contract (T1): they are the
rails that keep a *future* field from silently breaking the envelope, blowing up
the payload, or forcing a lockstep restart.
"""

from __future__ import annotations

import re

import pytest


def _normalize(key: str) -> str:
    """The envelope's own key normalization (``envelope.py:141``)."""
    return re.sub(r"[^a-z0-9]", "", key.casefold())


# --- guardrail 1: field names must clear the envelope's blacklist -------------


def test_no_declared_requirement_name_hits_the_envelope_blacklist() -> None:
    """A blacklisted field name rejects the *whole* envelope, not just the field."""
    from novelvideo.task_backend.envelope import _SENSITIVE_PAYLOAD_FIELDS
    from novelvideo.task_backend.projection import PROJECTION_REQUIREMENTS

    for task_type, required in PROJECTION_REQUIREMENTS.items():
        for name in required:
            assert _normalize(name) not in _SENSITIVE_PAYLOAD_FIELDS, (task_type, name)


@pytest.mark.parametrize("bad_name", ["access_token", "API-Key", "Authorization", "token"])
def test_blacklisted_field_name_raises_on_the_delivery_side(bad_name: str) -> None:
    from novelvideo.task_backend.projection import assert_projection_is_deliverable

    projection = {
        "projection_version": 1,
        "task_type": "mainline_frame_from_context",
        "fields": {bad_name: "x"},
    }
    with pytest.raises(ValueError, match="敏感字段名"):
        assert_projection_is_deliverable(projection)


def test_blacklist_check_reaches_nested_keys() -> None:
    """Projected DB rows are nested dicts; a bad column name must not slip through."""
    from novelvideo.task_backend.projection import assert_projection_is_deliverable

    projection = {
        "projection_version": 1,
        "task_type": "mainline_frame_from_context",
        "fields": {"characters": [{"name": "阿茶", "refresh_token": "x"}]},
    }
    with pytest.raises(ValueError, match="敏感字段名"):
        assert_projection_is_deliverable(projection)


def test_ordinary_projection_passes_the_blacklist() -> None:
    from novelvideo.task_backend.projection import assert_projection_is_deliverable

    assert_projection_is_deliverable(
        {
            "projection_version": 1,
            "task_type": "mainline_sketch_from_context",
            "fields": {"scenes": [{"name": "皇宫·大殿", "aliases": []}]},
        }
    )


# --- guardrail 2: size cap, checked on the delivery side ----------------------


def test_size_cap_is_256_kib() -> None:
    from novelvideo.task_backend.projection import MAX_PROJECTION_BYTES

    assert MAX_PROJECTION_BYTES == 256 * 1024


def test_oversized_projection_raises_on_the_delivery_side() -> None:
    """It has to fail while still on the machine that built it, so it is attributable."""
    from novelvideo.task_backend.projection import (
        MAX_PROJECTION_BYTES,
        assert_projection_is_deliverable,
    )

    projection = {
        "projection_version": 1,
        "task_type": "mainline_sketch_from_context",
        "fields": {"scenes": ["x" * (MAX_PROJECTION_BYTES + 1)]},
    }
    with pytest.raises(ValueError, match="超出体积上限"):
        assert_projection_is_deliverable(projection)


def test_read_projection_does_not_enforce_the_size_cap() -> None:
    """The worker is the wrong place to find out: by then it is someone else's machine."""
    from novelvideo.task_backend.projection import MAX_PROJECTION_BYTES, read_projection

    payload = {
        "projection": {
            "projection_version": 1,
            "task_type": "mainline_sketch_from_context",
            "fields": {"scenes": ["x" * (MAX_PROJECTION_BYTES + 1)]},
        }
    }
    assert read_projection(payload) is not None


# --- guardrail 3: version tolerance window, both directions ------------------


def test_version_window_holds_two_values() -> None:
    from novelvideo.task_backend.projection import (
        CURRENT_PROJECTION_VERSION,
        SUPPORTED_PROJECTION_VERSIONS,
    )

    assert SUPPORTED_PROJECTION_VERSIONS == frozenset({1, 2})
    assert CURRENT_PROJECTION_VERSION in SUPPORTED_PROJECTION_VERSIONS
    # At most two values: a window wider than one release is how a "temporary"
    # compatibility shim becomes permanent.
    assert len(SUPPORTED_PROJECTION_VERSIONS) == 2


@pytest.mark.parametrize("version", [1, 2])
def test_both_versions_in_the_window_are_accepted(version: int) -> None:
    """Rolling upgrade, both directions: an older reader must accept the newer
    producer's version and vice versa, or adding a field means downtime."""
    from novelvideo.task_backend.projection import read_projection

    payload = {
        "projection": {
            "projection_version": version,
            "task_type": "mainline_sketch_from_context",
            "fields": {"scenes": []},
        }
    }
    proj = read_projection(payload)
    assert proj is not None
    assert proj.projection_version == version


@pytest.mark.parametrize("version", [0, 3, "1", None])
def test_versions_outside_the_window_raise(version: object) -> None:
    from novelvideo.task_backend.projection import read_projection

    payload = {
        "projection": {
            "projection_version": version,
            "task_type": "mainline_sketch_from_context",
            "fields": {"scenes": []},
        }
    }
    with pytest.raises(ValueError, match="投射版本"):
        read_projection(payload)


def test_unknown_fields_are_kept_not_rejected() -> None:
    """Producer-first field rollout: a reader that does not know a field ignores it."""
    from novelvideo.task_backend.projection import read_projection

    payload = {
        "projection": {
            "projection_version": 1,
            "task_type": "mainline_sketch_from_context",
            "fields": {"scenes": [], "a_field_from_a_newer_release": 1},
        }
    }
    proj = read_projection(payload)
    assert proj is not None
    assert proj.get("a_field_from_a_newer_release") == 1
