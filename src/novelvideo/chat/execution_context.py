"""Server-authoritative identity and policy for one project chat turn."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from novelvideo.chat.store import ChatScope
from novelvideo.project_context import ProjectContext

AgentSurface = Literal["director", "freezone"]
AgentToolMode = Literal["default", "freezone_canvas"]


@dataclass(frozen=True)
class AgentExecutionContext:
    """Immutable execution facts resolved after authentication and project lookup.

    Browser-provided prompt text and surface metadata are intentionally absent.
    They are business input, not authorization input.
    """

    requester_user_id: str
    requester_username: str
    requester_principals: tuple[tuple[str, str], ...]
    project_id: str
    surface: AgentSurface
    canvas_id: str | None
    agent_id: str
    agent_profile: str
    tool_mode: AgentToolMode
    tool_policy: str
    billing_surface: str

    @classmethod
    def from_project_scope(
        cls,
        *,
        scope: ChatScope,
        project: ProjectContext,
    ) -> "AgentExecutionContext":
        is_freezone = scope.kind == "freezone" or (
            scope.kind == "project" and scope.surface == "freezone"
        )
        if is_freezone:
            agent_id = str(scope.agent_id or "main").strip() or "main"
            canvas_id = str(scope.canvas_id or "default").strip() or "default"
            return cls(
                requester_user_id=project.requester_user_id,
                requester_username=project.requester_username,
                requester_principals=project.requester_principals,
                project_id=project.project_id,
                surface="freezone",
                canvas_id=canvas_id,
                agent_id=agent_id,
                agent_profile=f"freezone:{agent_id}",
                tool_mode="freezone_canvas",
                tool_policy="freezone_canvas",
                billing_surface="freezone_assistant",
            )
        return cls(
            requester_user_id=project.requester_user_id,
            requester_username=project.requester_username,
            requester_principals=project.requester_principals,
            project_id=project.project_id,
            surface="director",
            canvas_id=None,
            agent_id="main",
            agent_profile="main",
            tool_mode="default",
            tool_policy="project",
            billing_surface="assistant",
        )

    def normalized_surface_context(
        self,
        client_context: dict[str, object] | None,
    ) -> dict[str, object] | None:
        if self.surface != "freezone":
            return None
        context = dict(client_context or {})
        context["freezone_canvas_id"] = self.canvas_id or "default"
        return context
