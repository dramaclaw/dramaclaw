"""Sandbox data roots follow configured NOVELVIDEO_*_DIR values."""

import json
from pathlib import Path

import pytest

from novelvideo.security.sandbox_wrap import (
    SUPERTALE_ROOT,
    SandboxSpec,
    _data_dir,
    _expand_aliases,
    _fallback_or_raise,
    _wrap_linux,
    build_macos_profile,
)


def test_data_dir_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    assert _data_dir("state") == tmp_path / "state"

    monkeypatch.delenv("NOVELVIDEO_STATE_DIR")
    assert _data_dir("state") == SUPERTALE_ROOT / "state"


def test_data_dir_absolutizes_relative_env(monkeypatch):
    """Regression: a relative NOVELVIDEO_*_DIR must anchor to SUPERTALE_ROOT.

    A relative value (e.g. `.env` had NOVELVIDEO_OUTPUT_DIR=output) previously
    reached the Seatbelt profile as `(subpath "output")`, which Seatbelt never
    matches — silently leaving that data root's peer-read deny disabled.
    """
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", "output")
    got = _data_dir("output")
    assert got.is_absolute()
    assert got == SUPERTALE_ROOT / "output"


def test_expand_aliases_rejects_relative_path():
    """Belt-and-suspenders: no relative path may ever reach a subpath block."""
    with pytest.raises(ValueError, match="must be absolute"):
        _expand_aliases([Path("output")])


def test_data_roots_and_self_paths_use_configured_data_roots(monkeypatch, tmp_path):
    state = tmp_path / "state"
    output = tmp_path / "output"
    runtime = tmp_path / "runtime"
    for root in (state, output, runtime):
        for name in ("alice", "bob", "_shared"):
            (root / name).mkdir(parents=True)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(output))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(runtime))

    spec = SandboxSpec(user="alice")

    assert spec.resolved_hermes_home() == state / "alice" / ".hermes"
    assert set(spec.self_business_paths()) == {
        state / "alice",
        output / "alice",
        runtime / "alice",
    }
    assert set(spec.data_roots()) == {state, output, runtime}


def test_macos_profile_denies_peer_roots_wholesale(monkeypatch, tmp_path):
    """P0/H3: peer reads are denied by root, not by session-start enumeration.

    A sibling user dir created AFTER the profile was built must still be
    unreadable — the earlier iterdir() approach missed those (TOCTOU).
    """
    state = tmp_path / "state"
    output = tmp_path / "output"
    runtime = tmp_path / "runtime"
    for root in (state, output, runtime):
        (root / "alice").mkdir(parents=True)
        (root / "_shared").mkdir(parents=True)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(output))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(runtime))

    profile = build_macos_profile(SandboxSpec(user="alice"))

    # The whole data roots are denied for read...
    assert f'(deny file-read*\n  (subpath "{state}")' in profile
    assert f'(subpath "{output}")' in profile
    assert f'(subpath "{runtime}")' in profile
    # ...then this user's own slice + _shared are allowed back.
    assert f'(subpath "{state / "alice"}")' in profile
    assert f'(subpath "{state / "_shared"}")' in profile

    # Deny of the root must precede the allow-back (last-match-wins re-opens
    # only alice's slice); and no peer dir is ever named explicitly.
    deny_root_at = profile.index(f'(deny file-read*\n  (subpath "{state}")')
    allow_self_at = profile.rindex(f'(subpath "{state / "alice"}")')
    assert deny_root_at < allow_self_at
    assert "bob" not in profile  # a future/other peer is covered by root deny, never listed

    # Host secrets are denied LAST so nothing re-opens them.
    assert profile.rstrip().count("file-read*")  # sanity: read rules present
    ssh_deny_at = profile.rindex(str(Path.home() / ".ssh"))
    assert ssh_deny_at > allow_self_at


def test_linux_wrapper_uses_current_codex_sandbox_cli(monkeypatch, tmp_path):
    sandbox_binary = tmp_path / "codex-linux-sandbox"
    sandbox_binary.write_text("#!/bin/sh\n", encoding="utf-8")
    hermes_home = tmp_path / "state" / "alice" / ".hermes"
    hermes_home.mkdir(parents=True)
    monkeypatch.setattr(
        "novelvideo.security.sandbox_wrap.shutil.which",
        lambda _name: str(sandbox_binary),
    )

    wrapped = _wrap_linux(
        ["hermes", "run"],
        SandboxSpec(user="alice", hermes_home=hermes_home),
    )

    assert wrapped[0] == str(sandbox_binary)
    assert "--sandbox" not in wrapped
    assert "--writable-root" not in wrapped
    assert wrapped[-3:] == ["--", "hermes", "run"]
    assert wrapped[1:3] == ["--sandbox-policy-cwd", str(hermes_home)]
    assert wrapped[3:5] == ["--command-cwd", str(hermes_home)]
    profile = json.loads(wrapped[wrapped.index("--permission-profile") + 1])
    assert profile["type"] == "managed"
    assert profile["network"] == "restricted"
    assert {
        "path": {"type": "path", "path": str(hermes_home)},
        "access": "write",
    } in profile["file_system"]["entries"]


def _clear_sandbox_env(monkeypatch) -> None:
    for name in (
        "SUPERTALE_ENV",
        "ST_CONTROL_PLANE_DSN",
        "SUPERTALE_ALLOW_UNSANDBOXED",
    ):
        monkeypatch.delenv(name, raising=False)


def test_fallback_fails_closed_in_production(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("SUPERTALE_ENV", "production")
    with pytest.raises(RuntimeError, match="sandbox required"):
        _fallback_or_raise(["hermes"], "no backend")


def test_fallback_fails_closed_when_control_plane_connected(monkeypatch):
    # EE 多租户:连了控制面即使没设 production,也必须拒绝裸跑。
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    with pytest.raises(RuntimeError, match="sandbox required"):
        _fallback_or_raise(["hermes"], "no backend")


def test_fallback_fails_closed_in_dev_without_optin(monkeypatch):
    # 本地 CE 开发默认也 fail-close,除非显式开开关。
    _clear_sandbox_env(monkeypatch)
    with pytest.raises(RuntimeError, match="SUPERTALE_ALLOW_UNSANDBOXED"):
        _fallback_or_raise(["hermes"], "no backend")


def test_fallback_allows_dev_with_explicit_optin(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        result = _fallback_or_raise(["hermes", "run"], "no backend")
    assert result == ["hermes", "run"]


def test_dev_optin_cannot_override_required_sandbox(monkeypatch):
    # 开关只对本地开发生效;生产/EE 下即便设了也必须拒绝。
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    with pytest.raises(RuntimeError, match="sandbox required"):
        _fallback_or_raise(["hermes"], "no backend")
