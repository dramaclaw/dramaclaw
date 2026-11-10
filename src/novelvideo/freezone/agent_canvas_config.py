# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Configuration for server-side Agent canvas writes."""

import os
from typing import Literal


class AgentCanvasConfigError(RuntimeError):
    """An invalid Agent canvas execution configuration."""


def agent_canvas_executor() -> Literal["browser", "server"]:
    value = os.environ.get("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    if value == "browser":
        return "browser"
    if value == "server":
        return "server"
    raise AgentCanvasConfigError("DRAMACLAW_AGENT_CANVAS_EXECUTOR must be browser or server")


def canvas_patch_push_enabled() -> bool:
    return os.environ.get("DRAMACLAW_CANVAS_PATCH_PUSH", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def validate_agent_canvas_config() -> None:
    if agent_canvas_executor() == "server" and not canvas_patch_push_enabled():
        raise AgentCanvasConfigError(
            "DRAMACLAW_AGENT_CANVAS_EXECUTOR=server requires DRAMACLAW_CANVAS_PATCH_PUSH=1"
        )
