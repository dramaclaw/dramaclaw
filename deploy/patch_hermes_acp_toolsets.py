#!/usr/bin/env python3
"""Build-time patch: make hermes-agent ACP honour workspace enabled_toolsets.

Some hermes-agent ACP adapter versions create the ACP agent with
``enabled_toolsets=["hermes-acp"]``. That ignores the per-user ``config.yaml``
managed by DramaClaw, so repo plugin tools can be discovered but still not
exposed to the model. The Dockerfile installs the version pinned in
the fork branch; this patch is intentionally self-verifying so a Hermes
source change fails the image build instead of silently regressing tool
injection.
"""

from __future__ import annotations

import glob
import os
import sys
from pathlib import Path


CANDIDATE_PATTERNS = [
    str(Path.home() / ".local/share/uv/tools/hermes-agent/lib/python*/site-packages/acp_adapter/session.py"),
    "/root/.local/share/uv/tools/hermes-agent/lib/python*/site-packages/acp_adapter/session.py",
    "/home/appuser/.local/share/uv/tools/hermes-agent/lib/python*/site-packages/acp_adapter/session.py",
    # An editable install from a clone, which is how the image gets the fork:
    # upstream refuses to build a wheel, so `uv tool install` cannot be used and
    # the source stays where it was cloned rather than landing in site-packages.
    "/opt/hermes-agent/acp_adapter/session.py",
    str(Path(os.environ.get("HERMES_SOURCE_DIR", "/nonexistent")) / "acp_adapter/session.py"),
]
if override := os.environ.get("HERMES_AGENT_SESSION_PY"):
    CANDIDATE_PATTERNS.insert(0, override)
CANDIDATES = sorted({candidate for pattern in CANDIDATE_PATTERNS for candidate in glob.glob(pattern)})
if len(CANDIDATES) != 1:
    sys.exit(f"PATCH FAIL: expected 1 acp_adapter/session.py, found {CANDIDATES}")
path = CANDIDATES[0]

OLD = (
    '            "enabled_toolsets": _expand_acp_enabled_toolsets(\n'
    '                ["hermes-acp"],\n'
    "                mcp_server_names=configured_mcp_servers,\n"
)
NEW = (
    '            "enabled_toolsets": _expand_acp_enabled_toolsets(\n'
    '                config.get("enabled_toolsets") or ["hermes-acp"],\n'
    "                mcp_server_names=configured_mcp_servers,\n"
)

with open(path, encoding="utf-8") as handle:
    src = handle.read()

if NEW in src:
    print(f"patch_hermes_acp_toolsets: already patched ({path})")
    sys.exit(0)

count = src.count(OLD)
if count != 1:
    sys.exit(
        "PATCH FAIL: expected exactly 1 occurrence of the ACP enabled_toolsets "
        f"factory block, found {count} in {path}. hermes-agent likely changed; "
        "re-verify the fork branch and this patch."
    )

with open(path, "w", encoding="utf-8") as handle:
    handle.write(src.replace(OLD, NEW))
print(f"patch_hermes_acp_toolsets: patched {path} (ACP now honours config.enabled_toolsets)")
