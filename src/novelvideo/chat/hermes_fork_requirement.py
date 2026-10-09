"""DramaClaw and the Hermes fork are installed as a pair, and this enforces it.

Workers authenticate per turn unconditionally: `build_hermes_child_env` gives
every worker a placeholder credential and the per-turn latch, and the real key
travels in the ACP `_meta` extension. A stock Hermes drops that extension —
the ACP router splats `_meta` into keyword arguments and upstream never reads
it back — so a mismatched pair produces workers that fail closed on every turn
and report it as a connection error three retries later.

There used to be a `legacy_environment` mode meant to cover this. It was worse
than nothing: it put the real key back on disk while the worker kept the
placeholder and the latch, so a "legacy" deployment ran with the exposure of
the old design and the behaviour of the new one. It is gone. Pairing is the
contract, so an unpaired install fails at startup, loudly, rather than at the
first turn, obscurely.
"""
from __future__ import annotations

import logging

_log = logging.getLogger(__name__)


class HermesForkMissing(RuntimeError):
    """The installed Hermes cannot carry a per-turn credential."""


#: Probed in the worker's own interpreter, not this one.
#:
#: The first version imported the modules here and was wrong in both
#: directions. DramaClaw does not import Hermes — it launches it as a
#: subprocess, often from a different virtualenv — so an API process that has
#: never installed Hermes would refuse to start even with a correct fork
#: installed for the worker, while an API process that happened to have a stock
#: Hermes importable would refuse despite the worker using a good one. The only
#: interpreter whose answer matters is the one that will run the worker.
_PROBE = """
import json, sys
result = {"ok": False, "detail": ""}
try:
    from acp_adapter.server import _recover_turn_meta
    recovered = _recover_turn_meta({"session_id": "s", "dramaclaw.probe": "v"})
    if recovered.get("dramaclaw.probe") != "v":
        result["detail"] = "_recover_turn_meta does not recover splatted _meta keys"
    else:
        from agent.gateway_credential import apply_to_headers, refuse_foreign_endpoint
        result = {"ok": True, "detail": "hermes fork present"}
except ImportError as error:
    result["detail"] = "hermes is not importable or is incomplete: %s" % error
except Exception as error:
    result["detail"] = "the probe raised %s" % type(error).__name__
print(json.dumps(result))
"""


def hermes_fork_is_installed(cli_path=None, extra_path=None) -> tuple[bool, str]:
    """Whether the Hermes that will serve turns understands the per-turn contract.

    Probed by behaviour, not by version. The fork keeps upstream's version
    string, so `hermes --version` cannot tell them apart; and a commit pin
    would need updating for fork changes that do not matter here. What this
    deployment depends on is that `_meta` survives the router, which has a
    direct answer.
    """
    import json
    import os
    import subprocess
    import sys

    # Only an interpreter this probe can actually drive. `shutil.which("hermes")`
    # can resolve to a wrapper, a shell script or a compiled launcher — on this
    # machine it found something that is not python at all — and running the
    # probe through it produces a shell error that reads like a broken fork.
    # An unusable launcher is reported as unknown, not as a mismatch: refusing
    # to start on it would be a worse answer than the one we can support.
    interpreter = _worker_interpreter(cli_path)
    if interpreter and not _looks_like_python(interpreter):
        return False, (f"the hermes launcher at {cli_path or 'PATH'} names "
                       f"{interpreter!r}, which this probe cannot drive; set "
                       f"HERMES_CLI_PATH to the fork's console script")
    interpreter = interpreter or sys.executable
    # The worker's own site-packages, which is what the interpreter alone does
    # not settle: a venv's python finds its own packages, but a shim or a
    # system python needs to be told. Absent, the probe simply answers about
    # `interpreter`, which is the correct fallback.
    environment = dict(os.environ)
    if extra_path:
        environment["PYTHONPATH"] = str(extra_path)
    try:
        completed = subprocess.run(
            [interpreter, "-c", _PROBE],
            capture_output=True, text=True, timeout=30, env=environment)
    except Exception as error:            # noqa: BLE001 - any failure is a mismatch
        return False, f"could not probe {interpreter}: {type(error).__name__}"
    if completed.returncode != 0:
        return False, f"the probe failed in {interpreter}: {completed.stderr.strip()[:200]}"
    try:
        result = json.loads(completed.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return False, f"the probe produced no verdict: {completed.stdout.strip()[:200]}"
    return bool(result.get("ok")), str(result.get("detail") or "no detail")


def _looks_like_python(interpreter: str) -> bool:
    """Whether a shebang target is plausibly a python we can run `-c` with."""
    import pathlib
    return "python" in pathlib.Path(interpreter).name.lower()


def _worker_interpreter(cli_path) -> str | None:
    """The python that runs the hermes CLI, if it can be established.

    A console script's shebang names the interpreter its package is installed
    into, which is exactly the environment the worker will import from.
    """
    import pathlib
    import shutil

    resolved = str(cli_path) if cli_path else shutil.which("hermes")
    if not resolved:
        return None
    try:
        first = pathlib.Path(resolved).read_text(errors="ignore").splitlines()[0]
    except (OSError, IndexError):
        return None
    if not first.startswith("#!"):
        return None
    parts = first[2:].strip().split()
    if not parts:
        return None
    # `#!/usr/bin/env python3` is common in real virtualenv scripts, and taking
    # the first word would hand back `/usr/bin/env`, which does not accept the
    # arguments the probe passes. The interpreter is the argument after `env`.
    if pathlib.Path(parts[0]).name == "env":
        parts = [part for part in parts[1:] if "=" not in part]
        return parts[0] if parts else None
    return parts[0]


def require_hermes_fork(cli_path=None, extra_path=None) -> None:
    """Refuse to serve with a Hermes that cannot carry a per-turn credential.

    Raised at startup rather than warned about. A warning would be read once,
    in a log nobody is watching, and the symptom it predicts — every turn
    failing with a connection error — gives no hint of the cause.
    """
    installed, detail = hermes_fork_is_installed(cli_path, extra_path)
    if installed:
        _log.info("hermes fork verified: %s", detail)
        return
    raise HermesForkMissing(
        f"the installed Hermes cannot carry a per-turn credential: {detail}. "
        "DramaClaw and the Hermes fork are installed as a pair; a stock Hermes "
        "drops the _meta extension the credential travels in, so every turn "
        "would fail closed and report a connection error. Install the fork "
        "(HERMES_INSTALL_SPEC) or run a DramaClaw from before per-turn "
        "credentials.")
