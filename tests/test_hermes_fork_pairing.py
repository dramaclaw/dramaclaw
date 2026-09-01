"""A DramaClaw that authenticates per turn must not run on a stock Hermes.

The failure it prevents is the one that cost the most to find: a stock Hermes
accepts the ACP prompt, drops the `_meta` extension the credential travels in,
and the worker then refuses to egress. The OpenAI SDK wraps that refusal as a
connection error and retries three times, so the symptom appears fourteen
seconds later, names the network, and the gateway sees no request at all.

There is no legacy mode to fall back to. One existed and was worse than none:
it put the real key back on disk while the worker kept the placeholder and the
latch, so a "legacy" deployment carried the old design's exposure and the new
design's behaviour at the same time.

The probe runs in the worker's interpreter, not this one. DramaClaw does not
import Hermes — it launches it as a subprocess, usually from a different
virtualenv — so importing here would answer about the wrong environment in both
directions: an API process without Hermes would refuse despite a correct fork
being installed for the worker, and one that happened to have a stock Hermes
importable would refuse despite the worker using a good one. These tests
therefore build real interpreter environments rather than patching sys.modules.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

from novelvideo.chat import hermes_fork_requirement as requirement

FORK_SERVER = '''
def _recover_turn_meta(kwargs):
    direct = kwargs.get("_meta") or kwargs.get("meta")
    if isinstance(direct, dict):
        return direct
    return {k: v for k, v in kwargs.items() if "." in k}
'''

STOCK_SERVER = '''
def _recover_turn_meta(kwargs):
    # Upstream reads _meta as a mapping and never sees the splatted keys.
    return kwargs.get("_meta") or {}
'''

CREDENTIAL = '''
def apply_to_headers(headers, url): return False
def refuse_foreign_endpoint(url): return None
'''


def _this_python(tmp_path: pathlib.Path) -> pathlib.Path:
    """A console script whose shebang names the interpreter running the tests.

    Passed explicitly so the probe never consults PATH: what `hermes` resolves
    to during a test run is whatever the developer happens to have installed,
    and on this machine it is not python.
    """
    cli = tmp_path / "hermes-cli"
    cli.write_text(f"#!{sys.executable}\n")
    cli.chmod(0o755)
    return cli


def test_a_stock_hermes_is_refused(tmp_path, monkeypatch):
    """The whole point: upstream drops the extension and must not be accepted."""
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "site"))
    site = tmp_path / "site"
    (site / "acp_adapter").mkdir(parents=True)
    (site / "acp_adapter" / "__init__.py").write_text("")
    (site / "acp_adapter" / "server.py").write_text(STOCK_SERVER)

    installed, detail = requirement.hermes_fork_is_installed(_this_python(tmp_path), extra_path=site)
    assert not installed
    assert "_meta" in detail


def test_the_fork_is_accepted(tmp_path, monkeypatch):
    site = tmp_path / "site"
    (site / "acp_adapter").mkdir(parents=True)
    (site / "acp_adapter" / "__init__.py").write_text("")
    (site / "acp_adapter" / "server.py").write_text(FORK_SERVER)
    (site / "agent").mkdir()
    (site / "agent" / "__init__.py").write_text("")
    (site / "agent" / "gateway_credential.py").write_text(CREDENTIAL)

    installed, detail = requirement.hermes_fork_is_installed(_this_python(tmp_path), extra_path=site)
    assert installed, detail


def test_a_half_installed_fork_is_refused(tmp_path, monkeypatch):
    """The recovery present, the credential module absent, is not a fork."""
    site = tmp_path / "site"
    (site / "acp_adapter").mkdir(parents=True)
    (site / "acp_adapter" / "__init__.py").write_text("")
    (site / "acp_adapter" / "server.py").write_text(FORK_SERVER)

    installed, detail = requirement.hermes_fork_is_installed(_this_python(tmp_path), extra_path=site)
    assert not installed
    assert "importable" in detail or "incomplete" in detail


def test_no_hermes_at_all_is_refused(tmp_path, monkeypatch):
    site = tmp_path / "empty"
    site.mkdir()
    installed, _ = requirement.hermes_fork_is_installed(_this_python(tmp_path), extra_path=site)
    assert not installed


def test_the_refusal_names_the_cause_and_the_fix(tmp_path, monkeypatch):
    site = tmp_path / "empty"
    site.mkdir()
    with pytest.raises(requirement.HermesForkMissing) as caught:
        requirement.require_hermes_fork(_this_python(tmp_path), extra_path=site)
    message = str(caught.value)
    assert "_meta" in message, "the message must name what is actually missing"
    assert "HERMES_INSTALL_SPEC" in message, "and how to fix it"


def test_the_probe_reads_the_interpreter_from_a_cli_shebang(tmp_path):
    """The mechanism that makes this answer about the worker's environment."""
    cli = tmp_path / "hermes"
    cli.write_text("#!/opt/venv/bin/python\n")
    cli.chmod(0o755)
    assert requirement._worker_interpreter(cli) == "/opt/venv/bin/python"


def test_a_cli_without_a_shebang_falls_back_rather_than_guessing(tmp_path):
    cli = tmp_path / "hermes"
    cli.write_bytes(b"\x7fELF binary")
    cli.chmod(0o755)
    assert requirement._worker_interpreter(cli) is None


def test_an_env_style_shebang_resolves_to_the_interpreter_not_to_env(tmp_path):
    """`#!/usr/bin/env python3` is what real virtualenv scripts carry.

    Taking the first word hands back `/usr/bin/env`, which rejects the probe's
    arguments — so the check would report every correctly installed fork as a
    failed probe, and refuse to start a deployment that was fine.
    """
    cli = tmp_path / "hermes"
    cli.write_text("#!/usr/bin/env python3.12\n")
    cli.chmod(0o755)
    assert requirement._worker_interpreter(cli) == "python3.12"


def test_an_env_shebang_with_variables_still_finds_the_interpreter(tmp_path):
    cli = tmp_path / "hermes"
    cli.write_text("#!/usr/bin/env PYTHONHASHSEED=0 python3\n")
    cli.chmod(0o755)
    assert requirement._worker_interpreter(cli) == "python3"


def test_a_launcher_that_is_not_python_is_reported_not_mis_run(tmp_path):
    """A wrapper on PATH must not be executed as if it were the interpreter.

    `shutil.which("hermes")` can resolve to a shell script or a compiled
    launcher. Running the probe through one produces shell errors that read
    like a broken fork, which would send an operator looking in the wrong place.
    """
    cli = tmp_path / "hermes"
    cli.write_text("#!/bin/bash\nexec real-hermes \"$@\"\n")
    cli.chmod(0o755)

    installed, detail = requirement.hermes_fork_is_installed(cli)
    assert not installed
    assert "cannot drive" in detail
    assert "HERMES_CLI_PATH" in detail, "the message must say what to set"
