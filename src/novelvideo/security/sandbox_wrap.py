"""Cross-platform sandbox wrapper for Hermes worker subprocesses.

Design (per plan):
- READ:  whitelist (system libs + self business dirs + shared repo resources).
         Host secrets (~/.ssh etc.) and other users explicitly denied.
- WRITE: only HERMES_HOME (state/{user}/.hermes/). Business writes go via API.

Linux:  codex-linux-sandbox binary (bwrap + seccomp; workspace-write mode).
macOS:  /usr/bin/sandbox-exec + dynamically composed sbpl profile
        (base policy copied from openai/codex, MIT licensed,
         in deploy/sandbox/seatbelt_base_policy.sbpl).
"""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import tempfile
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

_log = logging.getLogger(__name__)

# SuperTale repo root: src/novelvideo/security/sandbox_wrap.py → parents[3]
SUPERTALE_ROOT = Path(__file__).resolve().parents[3]
SANDBOX_PROFILES_DIR = SUPERTALE_ROOT / "deploy" / "sandbox"
SEATBELT_BASE_POLICY = SANDBOX_PROFILES_DIR / "seatbelt_base_policy.sbpl"
SEATBELT_NETWORK_POLICY = SANDBOX_PROFILES_DIR / "seatbelt_network_policy.sbpl"


def _data_dir(kind: str) -> Path:
    env = os.environ.get(f"NOVELVIDEO_{kind.upper()}_DIR", "").strip()
    if env:
        p = Path(env).expanduser()
        # A relative override (e.g. NOVELVIDEO_OUTPUT_DIR=output) MUST be
        # anchored to SUPERTALE_ROOT — mirroring the no-override default below.
        # A relative path here would reach the Seatbelt profile as
        # `(subpath "output")`, which Seatbelt silently never matches, leaving
        # the wholesale peer-read deny disabled for that tree. Always absolute.
        return p if p.is_absolute() else (SUPERTALE_ROOT / p)
    return SUPERTALE_ROOT / kind


@dataclass
class SandboxSpec:
    """Per-user sandbox configuration.

    Only `user` is required. Other fields auto-derive defaults sensible for
    the SuperTale layout (state/{user}/, output/{user}/, runtime/{user}/).
    """

    user: str
    hermes_home: Path | None = None  # default state/{user}/.hermes
    extra_read_paths: list[Path] = field(default_factory=list)

    def resolved_hermes_home(self) -> Path:
        return self.hermes_home or (_data_dir("state") / self.user / ".hermes")

    def self_business_paths(self) -> list[Path]:
        """The user's own state/output/runtime trees (read+write for hermes_home,
        read-only for the rest — sandbox enforces write side)."""
        return [
            _data_dir("state") / self.user,
            _data_dir("output") / self.user,
            _data_dir("runtime") / self.user,
        ]

    def shared_read_paths(self) -> list[Path]:
        """Project-wide read-only resources."""
        paths: list[Path] = [
            _data_dir("state") / "_shared",
            SUPERTALE_ROOT / "src",
            SUPERTALE_ROOT / "integrations",
            SUPERTALE_ROOT / ".hermes",  # repo-pinned Hermes skills
            SUPERTALE_ROOT / ".venv",  # SuperTale's main venv for skill scripts
        ]
        return paths

    def data_roots(self) -> list[Path]:
        """The per-user data roots (state/output/runtime tops).

        The macOS profile denies reads on these wholesale and then allows back
        only this user's own slice + ``_shared`` — so every peer (existing or
        created mid-session) is denied without enumeration.
        """
        return [_data_dir("state"), _data_dir("output"), _data_dir("runtime")]


def wrap_command(cmd: list[str], spec: SandboxSpec) -> list[str]:
    """Return `cmd` wrapped with OS sandbox.

    Linux:  prefixes with codex-linux-sandbox CLI (bwrap-based).
    macOS:  prefixes with /usr/bin/sandbox-exec -p '<profile>' -- ...
    Other (e.g. Windows): no sandbox backend → fallback path below.

    Fallback (sandbox binary missing or no backend for this OS):
    - SUPERTALE_ENV=production → raise (must sandbox in prod).
    - Otherwise → warn and return raw cmd (dev convenience).
    """
    system = platform.system()
    if system == "Linux":
        return _wrap_linux(cmd, spec)
    if system == "Darwin":
        return _wrap_macos(cmd, spec)
    return _fallback_or_raise(cmd, f"no sandbox backend on {system}")


# One-time result of the "can this host actually create a sandbox?" probe,
# keyed by binary path. Populated lazily by _sandbox_can_run; tests clear it.
_SANDBOX_PROBE_CACHE: dict[str, bool] = {}


def _linux_sandbox_argv(binary: str, hermes_home: Path, cmd: list[str]) -> list[str]:
    """Build the codex-linux-sandbox argv wrapping ``cmd`` (no capability check).

    Shared by the real wrap path and the functional probe so both exercise the
    identical invocation shape (restricted fs + outbound network).
    """
    permission_profile = {
        "type": "managed",
        "file_system": {
            "type": "restricted",
            "entries": [
                {
                    "path": {"type": "special", "value": {"kind": "root"}},
                    "access": "read",
                },
                {
                    "path": {"type": "path", "path": str(hermes_home)},
                    "access": "write",
                },
            ],
        },
        # Outbound network is allowed, matching the macOS Seatbelt profile
        # (`(allow network-outbound)`). codex's "restricted" network mode
        # `--unshare-net`s the sandbox — no egress at all — which would strangle
        # Hermes's required calls to the project API (DRAMACLAW_API_URL) and the
        # model gateway; the `/bin/true` probe cannot see that break. The two
        # platforms stay consistent here; tightening egress to an allowlist
        # (project API + model gateway only) on BOTH platforms is #346 P1②.
        "network": "enabled",
    }
    args = [
        binary,
        "--sandbox-policy-cwd",
        str(hermes_home),
        "--command-cwd",
        str(hermes_home),
        "--permission-profile",
        json.dumps(permission_profile, separators=(",", ":")),
        "--",
    ]
    return args + cmd


def _sandbox_can_run(binary: str) -> bool:
    """Functional probe: can ``binary`` actually create a sandbox on this host?

    A present binary is not sufficient — codex-linux-sandbox's default pipeline
    execs bubblewrap, which needs unprivileged user namespaces; on a kernel that
    lacks them the binary exists but every sandboxed exec fails at runtime, which
    the missing-binary check never catches. Runs ``/bin/true`` inside a throwaway
    sandbox once and caches the verdict (keyed by binary path)."""
    cached = _SANDBOX_PROBE_CACHE.get(binary)
    if cached is not None:
        return cached
    ok = False
    try:
        with tempfile.TemporaryDirectory(prefix="hermes-sbx-probe-") as tmp:
            home = Path(tmp) / ".hermes"
            home.mkdir(parents=True)
            probe = _linux_sandbox_argv(binary, home, ["/bin/true"])
            proc = subprocess.run(probe, capture_output=True, timeout=30)
            ok = proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    _SANDBOX_PROBE_CACHE[binary] = ok
    return ok


def _wrap_linux(cmd: list[str], spec: SandboxSpec) -> list[str]:
    binary = shutil.which("codex-linux-sandbox") or "/usr/local/bin/codex-linux-sandbox"
    if not Path(binary).exists():
        return _fallback_or_raise(cmd, "codex-linux-sandbox not found on PATH")
    if not _sandbox_can_run(binary):
        # Binary present but the sandbox cannot be created (host kernel most
        # likely lacks unprivileged user namespaces for bubblewrap). Route
        # through the same fail-close/degrade decision as a missing binary:
        # EE/production raises, CE single-tenant with the opt-in runs raw.
        return _fallback_or_raise(
            cmd,
            "codex-linux-sandbox present but sandbox creation failed "
            "(host kernel likely lacks unprivileged user namespaces)",
        )

    hermes_home = spec.resolved_hermes_home()
    return _linux_sandbox_argv(binary, hermes_home, cmd)


def _wrap_macos(cmd: list[str], spec: SandboxSpec) -> list[str]:
    profile = build_macos_profile(spec)
    return ["/usr/bin/sandbox-exec", "-p", profile, "--", *cmd]


def _aliases(p: Path) -> list[Path]:
    """Both literal path and /private-resolved form (macOS firmlinks).

    `/tmp` and `/etc` and `/var` are symlinks to `/private/tmp` etc., and
    Seatbelt rules need the *real* paths to match syscalls reliably.
    """
    s = str(p)
    out = [p]
    if s.startswith("/tmp/") or s == "/tmp":
        out.append(Path("/private" + s))
    elif s.startswith("/etc/") or s == "/etc":
        out.append(Path("/private" + s))
    elif s.startswith("/var/") or s == "/var":
        out.append(Path("/private" + s))
    return out


def _expand_aliases(paths: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for p in paths:
        # Fail loud, never silent: Seatbelt `(subpath "…")` only matches
        # absolute paths. A relative one never matches, so a relative deny would
        # silently leave a tree open (see _data_dir). Refuse to emit one.
        if not p.is_absolute():
            raise ValueError(
                f"sandbox profile path must be absolute, got relative {p!r}; "
                f"a relative subpath silently disables the Seatbelt rule"
            )
        for alt in _aliases(p):
            s = str(alt)
            if s not in seen:
                out.append(alt)
                seen.add(s)
    return out


def build_macos_profile(spec: SandboxSpec) -> str:
    """Compose full Seatbelt profile (base + per-user dynamic section).

    Order matters: Seatbelt uses *last-match-wins*. We arrange so that
    base (deny default) → broad allows → specific denies → final HERMES_HOME write allow.
    """
    if not SEATBELT_BASE_POLICY.is_file():
        raise FileNotFoundError(
            f"Seatbelt base policy missing: {SEATBELT_BASE_POLICY} "
            f"(run `cp ~/Documents/GitHub/codex/codex-rs/sandboxing/src/"
            f"seatbelt_base_policy.sbpl deploy/sandbox/`)"
        )
    base = SEATBELT_BASE_POLICY.read_text(encoding="utf-8")
    # codex's base profile is intentionally split — it requires the network
    # policy to be appended to function. Without it, sandbox-exec aborts
    # silently when the child process tries platform services (mach-lookup,
    # sysctl, etc.). See codex-rs/sandboxing/src/seatbelt.rs:292.
    if SEATBELT_NETWORK_POLICY.is_file():
        base = base + "\n" + SEATBELT_NETWORK_POLICY.read_text(encoding="utf-8")

    home = spec.resolved_hermes_home()

    parts: list[str] = ["\n;; ===== SuperTale per-user dynamic policy =====\n"]

    # Hermes workers need outbound network access for the configured LLM
    # provider and SuperTale API calls. File writes and agent-side tools remain
    # constrained by the rules below and by the per-user toolset whitelist.
    parts.append("\n;; NETWORK: allow outbound LLM/API calls\n")
    parts.append("(allow network-outbound)\n")

    # --- READ allow: broad ((subpath "/") — same as codex workspace-write mode) ---
    # Rationale: macOS dyld needs many paths to launch even `cat`; strict
    # subpath whitelist is unmaintainable. Defense relies on the specific DENY
    # rules below (per-user data roots + host secrets), which override this
    # broad allow via Seatbelt last-match-wins.
    parts.append(";; READ: broad allow; specific denies below override\n")
    parts.append("(allow file-read* (subpath \"/\"))\n")

    # --- READ deny: per-user data roots, WHOLESALE ---
    # Deny reads on the entire state/output/runtime roots rather than
    # enumerating sibling users at session start. Enumeration (iterdir) only
    # captured users that existed when the profile was built, so a peer dir
    # created mid-session stayed readable (TOCTOU). Denying the roots then
    # allowing back only this user's own slice + _shared closes that gap and
    # covers all future peers with no enumeration.
    parts.append(
        "\n;; READ deny: per-user data roots wholesale "
        "(blocks all peers incl. future — no enumeration)\n"
    )
    parts.append(_deny_read_block(_expand_aliases(spec.data_roots())))

    # --- READ allow-back: this user's own trees + shared read-only resources ---
    # Comes AFTER the data-root deny so last-match-wins re-opens only the
    # current user's slice and the shared resources.
    allow_back = _expand_aliases(
        [*spec.self_business_paths(), *spec.shared_read_paths()]
    )
    parts.append(
        "\n;; READ allow-back: own dirs + shared resources override root deny\n"
    )
    parts.append(_allow_read_block(allow_back))

    # --- READ deny: host secrets (LAST so nothing above can re-open them) ---
    parts.append("\n;; READ deny: host secrets — overrides every allow above\n")
    parts.append(_deny_read_block(_expand_aliases([
        Path.home() / ".ssh",
        Path.home() / ".gnupg",
        Path.home() / ".aws",
        Path.home() / ".kube",
        Path.home() / ".docker",
        Path("/etc/shadow"),
        Path("/etc/sudoers"),
        Path("/etc/sudoers.d"),
    ])))

    # --- WRITE: base profile is `deny default`, so peer/other-user writes
    #     (existing AND future) are already denied without enumeration. Only
    #     HERMES_HOME is allowed, last, so it wins over the /tmp deny. ---
    parts.append("\n;; WRITE deny: host /tmp (must use $TMPDIR=$HERMES_HOME/tmp)\n")
    parts.append(_deny_write_block(_expand_aliases([Path("/tmp")])))

    # --- WRITE allow: HERMES_HOME (LAST so last-match-wins keeps it allowed even if
    #     HERMES_HOME happens to live under /tmp during dev) ---
    parts.append("\n;; WRITE: only HERMES_HOME (last so this wins over /tmp deny)\n")
    parts.append(_allow_write_block(_expand_aliases([home])))

    return base + "".join(parts)


def _allow_read_block(paths: Iterable[Path]) -> str:
    lines = ["(allow file-read*"]
    for p in paths:
        lines.append(f'  (subpath "{p}")')
    lines.append(")\n")
    return "\n".join(lines)


def _deny_read_block(paths: Iterable[Path]) -> str:
    lines = ["(deny file-read*"]
    for p in paths:
        lines.append(f'  (subpath "{p}")')
    lines.append(")\n")
    return "\n".join(lines)


def _allow_write_block(paths: Iterable[Path]) -> str:
    lines = ["(allow file-write*"]
    for p in paths:
        lines.append(f'  (subpath "{p}")')
    lines.append(")\n")
    return "\n".join(lines)


def _deny_write_block(paths: Iterable[Path]) -> str:
    lines = ["(deny file-write*"]
    for p in paths:
        lines.append(f'  (subpath "{p}")')
    lines.append(")\n")
    return "\n".join(lines)


def _sandbox_required() -> bool:
    """多租户/生产必须强制沙箱,不允许裸跑。

    两个独立触发条件,满足其一即视为"必须沙箱":
    - ``SUPERTALE_ENV=production`` —— 显式生产标记;
    - ``ST_CONTROL_PLANE_DSN`` 非空 —— EE 控制面已接入,即多用户模式。

    刻意不只依赖容易漏配的 ``SUPERTALE_ENV``:只要连了控制面(EE),哪怕忘了设
    生产标记,也必须 fail-close。
    """
    if os.environ.get("SUPERTALE_ENV", "").strip().lower() == "production":
        return True
    if os.environ.get("ST_CONTROL_PLANE_DSN", "").strip():
        return True
    return False


def _dev_unsandboxed_opt_in() -> bool:
    """本地无沙箱开发必须走醒目的显式开关,而不是静默降级。"""
    return os.environ.get("SUPERTALE_ALLOW_UNSANDBOXED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _fallback_or_raise(cmd: list[str], reason: str) -> list[str]:
    if _sandbox_required():
        raise RuntimeError(
            f"sandbox required (production or EE control-plane) but {reason}; "
            f"refusing to run Hermes worker unsandboxed"
        )
    if not _dev_unsandboxed_opt_in():
        # CE 本地开发也默认 fail-close:必须显式开 SUPERTALE_ALLOW_UNSANDBOXED=1
        # 才允许裸跑,杜绝"漏配就静默无沙箱"。
        raise RuntimeError(
            f"sandbox unavailable ({reason}) and SUPERTALE_ALLOW_UNSANDBOXED is not "
            f"set; refusing to run unsandboxed. Set SUPERTALE_ALLOW_UNSANDBOXED=1 to "
            f"explicitly allow unsandboxed workers in local development only"
        )
    msg = (
        f"sandbox unavailable ({reason}); running UNSANDBOXED because "
        f"SUPERTALE_ALLOW_UNSANDBOXED is set — dev only, never in multi-user"
    )
    _log.warning(msg)
    warnings.warn(msg, RuntimeWarning, stacklevel=3)
    return cmd
