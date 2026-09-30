#!/usr/bin/env python3
"""Launch a DramaClaw MCP server from a local dramaclaw-ce checkout."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from urllib.parse import urlparse


LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
MODULES = {
    "tools": "novelvideo.chat.dramaclaw_mcp",
    "workflows": "novelvideo.chat.workflow_mcp",
}


def _is_ce_root(path: Path) -> bool:
    return all(
        target.exists()
        for target in (
            path / "pyproject.toml",
            path / "src" / "novelvideo" / "chat" / "dramaclaw_mcp.py",
            path / "src" / "novelvideo" / "chat" / "workflow_mcp.py",
            path / ".hermes" / "plugins" / "dramaclaw" / "__init__.py",
            path / ".hermes" / "plugins" / "freezone" / "__init__.py",
        )
    )


def _find_ce_root(explicit: str) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    configured = os.environ.get("DRAMACLAW_CE_DIR", "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.extend((Path.cwd(), Path(__file__).resolve().parents[2]))
    for start in candidates:
        current = start.expanduser().resolve()
        for candidate in (current, *current.parents):
            if _is_ce_root(candidate):
                return candidate
    raise SystemExit(
        "Cannot locate dramaclaw-ce. Set DRAMACLAW_CE_DIR to its checkout directory."
    )


def _python_for_ce(root: Path) -> Path:
    configured = os.environ.get("DRAMACLAW_PYTHON", "").strip()
    candidates = [
        Path(configured).expanduser() if configured else None,
        root / ".venv" / "bin" / "python",
        root / ".venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            # Do not resolve a virtualenv interpreter symlink. On uv-managed
            # environments that points at the base interpreter and loses the
            # virtualenv's site-packages when executed directly.
            return candidate.absolute()
    raise SystemExit(
        "Cannot find the dramaclaw-ce Python environment. Run `uv sync` in the CE checkout "
        "or set DRAMACLAW_PYTHON."
    )


def _truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _configure_tools_env(env: dict[str, str], ce_root: Path) -> None:
    api_url = env.setdefault("DRAMACLAW_API_URL", "http://127.0.0.1:8780")
    hostname = (urlparse(api_url).hostname or "").lower()
    has_token = bool(
        env.get("DRAMACLAW_AGENT_TOKEN", "").strip()
        or env.get("DRAMACLAW_AGENT_TOKEN_FILE", "").strip()
    )
    if not has_token:
        env.setdefault("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    if _truthy(env.get("DRAMACLAW_LOCAL_AGENT_TRUST", "")) and hostname not in LOOPBACK_HOSTS:
        raise SystemExit(
            "DRAMACLAW_LOCAL_AGENT_TRUST is allowed only for a loopback DRAMACLAW_API_URL. "
            "Use a short-lived agent token for non-loopback APIs."
        )

    username = (
        env.get("DRAMACLAW_USERNAME")
        or env.get("DRAMACLAW_USER")
        or env.get("ST_LOCAL_USERNAME")
        or "local"
    ).strip() or "local"
    env.setdefault("DRAMACLAW_USERNAME", username)
    env.setdefault("DRAMACLAW_USER", username)
    env.setdefault("ST_LOCAL_USERNAME", username)
    env.setdefault("DRAMACLAW_EXTERNAL_MCP", "1")
    env.setdefault("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", "0")
    env.setdefault("DRAMACLAW_CHAT_SURFACE", "freezone")
    env.setdefault("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    env.setdefault("DRAMACLAW_AGENT_PROFILE", "freezone:main")
    if not env.get("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "").strip():
        env["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"] = str(
            ce_root
            / "state"
            / username
            / ".hermes-freezone"
            / "tmp"
            / "supertale_canvas_command_bridge"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=sorted(MODULES))
    parser.add_argument("--ce-dir", default="")
    args = parser.parse_args()

    ce_root = _find_ce_root(args.ce_dir)
    python = _python_for_ce(ce_root)
    env = os.environ.copy()
    env["DRAMACLAW_CE_DIR"] = str(ce_root)
    if args.mode == "tools":
        _configure_tools_env(env, ce_root)
    else:
        env.setdefault(
            "DRAMACLAW_USERNAME",
            env.get("DRAMACLAW_USER", "").strip() or "local",
        )
    os.chdir(ce_root)
    os.execve(str(python), [str(python), "-m", MODULES[args.mode]], env)


if __name__ == "__main__":
    main()
