#!/usr/bin/env python3
"""Render one host MCP configuration without modifying the host's settings."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


HOST_FILES = {
    "codex": "config.toml",
    "claude-code": "mcp.json",
    "openclaw": "mcp.json",
    "workbuddy": "mcp.json",
    "generic": "mcp.json",
}


def _escaped(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)[1:-1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=sorted(HOST_FILES), required=True)
    parser.add_argument("--ce-dir", required=True)
    parser.add_argument("--username", default="local")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--canvas-id", default="")
    parser.add_argument("--api-url", default="http://127.0.0.1:8780")
    parser.add_argument("--output")
    args = parser.parse_args()

    kit_root = Path(__file__).resolve().parents[1]
    ce_root = Path(args.ce_dir).expanduser().resolve()
    template = kit_root / "hosts" / args.host / HOST_FILES[args.host]
    text = template.read_text(encoding="utf-8")
    replacements = {
        "__PYTHON__": sys.executable,
        "__LAUNCHER__": str(kit_root / "scripts" / "launch_mcp.py"),
        "__DRAMACLAW_CE_DIR__": str(ce_root),
        "__DRAMACLAW_API_URL__": args.api_url,
        "__DRAMACLAW_USERNAME__": args.username,
        "__DRAMACLAW_PROJECT_ID__": args.project_id,
        "__DRAMACLAW_CANVAS_ID__": args.canvas_id,
    }
    for marker, value in replacements.items():
        text = text.replace(marker, _escaped(value))

    if args.output:
        target = Path(args.output).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
