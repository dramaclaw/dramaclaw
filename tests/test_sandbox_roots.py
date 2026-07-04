"""Sandbox data roots follow configured NOVELVIDEO_*_DIR values."""

import json

from novelvideo.security.sandbox_wrap import (
    SUPERTALE_ROOT,
    SandboxSpec,
    _data_dir,
    _wrap_linux,
)


def test_data_dir_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    assert _data_dir("state") == tmp_path / "state"

    monkeypatch.delenv("NOVELVIDEO_STATE_DIR")
    assert _data_dir("state") == SUPERTALE_ROOT / "state"


def test_other_user_paths_use_configured_data_roots(monkeypatch, tmp_path):
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
    others = set(spec.other_user_paths())

    assert spec.resolved_hermes_home() == state / "alice" / ".hermes"
    assert set(spec.self_business_paths()) == {
        state / "alice",
        output / "alice",
        runtime / "alice",
    }
    assert {state / "bob", output / "bob", runtime / "bob"} <= others
    assert state / "alice" not in others
    assert state / "_shared" not in others


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
