# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Configuration for server-side Agent canvas writes."""

import os
from typing import Literal

from novelvideo.shared.failure_signals import CONFIGURATION


class AgentCanvasConfigError(RuntimeError):
    """An invalid Agent canvas execution configuration."""

    failure_kind = CONFIGURATION


def agent_canvas_executor() -> Literal["browser", "server"]:
    value = os.environ.get("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    if value == "browser":
        return "browser"
    if value == "server":
        return "server"
    raise AgentCanvasConfigError("DRAMACLAW_AGENT_CANVAS_EXECUTOR must be browser or server")


def canvas_patch_push_enabled() -> bool:
    value = os.environ.get("DRAMACLAW_CANVAS_PATCH_PUSH", "").strip().lower()
    if not value:
        return os.environ.get("DRAMACLAW_AGENT_CANVAS_EXECUTOR") == "server"
    return value in {"1", "true", "yes", "on"}


def validate_agent_canvas_config() -> None:
    if agent_canvas_executor() == "server" and not canvas_patch_push_enabled():
        raise AgentCanvasConfigError(
            "DRAMACLAW_AGENT_CANVAS_EXECUTOR=server conflicts with a disabled or unrecognized "
            "DRAMACLAW_CANVAS_PATCH_PUSH value. Unset DRAMACLAW_CANVAS_PATCH_PUSH or set it to 1."
        )
