"""ProjectContext is the only project identity object for new code."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from novelvideo.ports import get_project_access, get_project_registry
from novelvideo.ports.project import (
    Principal,
    ProjectRecord,
    require_role_value,
)
from novelvideo.ports.registry import PortNotRegistered
from novelvideo.shared.node_identity import resolve_worker_id


@dataclass(frozen=True)
class ProjectContext:
    project_id: str
    project_name: str
    owner_type: str
    owner_id: str
    owner_username: str
    requester_user_id: str
    requester_username: str
    requester_principals: tuple[tuple[str, str], ...]
    effective_role: str
    home_node_id: str
    output_dir: Path
    state_dir: Path
    runtime_dir: Path
    is_home_node: bool

    @property
    def owner_project_label(self) -> str:
        return f"{self.owner_username}/{self.project_name}"


def require_project_home_node(
    ctx: ProjectContext,
    *,
    operation: str = "project data access",
) -> ProjectContext:
    """Reject share-nothing local filesystem access on non-home nodes."""
    if ctx.is_home_node:
        return ctx
    raise HTTPException(
        status_code=409,
        detail={
            "code": "project_not_on_this_node",
            "message": f"{operation} must run on the project home node",
            "project_id": ctx.project_id,
            "home_node_id": ctx.home_node_id,
        },
    )


def is_record_home_node(project: ProjectRecord) -> bool:
    """Return whether this process may access share-nothing project files."""
    if project.home_node_id == "local":
        return True
    return project.home_node_id == resolve_worker_id()


async def user_id_from_api_user(user: dict) -> str:
    user_id = str(user.get("user_id") or user.get("id") or "").strip()
    if user_id:
        return user_id
    username = str(user.get("username") or "").strip()
    resolved = await get_project_registry().resolve_user_id_by_username(username)
    if not resolved:
        raise HTTPException(status_code=401, detail="Unable to resolve user id")
    return resolved


def _ctx_from_record(
    *,
    project: ProjectRecord,
    requester_user_id: str,
    requester_username: str,
    principals: list[Principal],
    role: str,
) -> ProjectContext:
    principal_pairs = tuple((p.type, p.id) for p in principals)
    return ProjectContext(
        project_id=project.id,
        project_name=project.name,
        owner_type=project.owner_type,
        owner_id=project.owner_id,
        owner_username=project.owner_username,
        requester_user_id=requester_user_id,
        requester_username=requester_username,
        requester_principals=principal_pairs,
        effective_role=role,
        home_node_id=project.home_node_id,
        output_dir=Path(project.output_dir),
        state_dir=Path(project.state_dir),
        runtime_dir=Path(project.runtime_dir),
        is_home_node=is_record_home_node(project),
    )


async def resolve_project_context(
    *,
    user: dict,
    project_id: str | None = None,
    project_name: str | None = None,
    required_role: str = "viewer",
    media_read: bool = False,
    allow_purging: bool = False,
) -> ProjectContext:
    if media_read and required_role != "viewer":
        raise ValueError("media read authorization is viewer-only")
    try:
        registry = get_project_registry()
        access = get_project_access()
    except PortNotRegistered:
        raise HTTPException(status_code=503, detail="project backend not initialised")
    requester_username = str(user.get("username") or "").strip()
    requester_user_id = await user_id_from_api_user(user)
    if not requester_username:
        requester_username = await registry.resolve_username_by_user_id(requester_user_id) or ""
    principals = await access.resolve_requester_principals(requester_user_id)

    record = None
    if project_id:
        record = await registry.get_project(project_id)
    elif project_name:
        record = await registry.get_project_by_owner_name(requester_user_id, project_name)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(record, "purge_started_at", None) and not allow_purging:
        raise HTTPException(status_code=409, detail="Project purge is in progress")

    # Optional capability: old EE providers remain compatible and fully check
    # authorization. Only media-serving callers may opt into this read cache.
    media_resolver = getattr(access, "effective_media_read_role", None) if media_read else None
    if media_resolver is not None:
        role = await media_resolver(record, principals)
    else:
        role = await access.effective_project_role(record, principals)
    require_role_value(role, required_role)
    return _ctx_from_record(
        project=record,
        requester_user_id=requester_user_id,
        requester_username=requester_username,
        principals=principals,
        role=role or "",
    )


async def require_project_role(ctx: ProjectContext, role: str) -> ProjectContext:
    require_role_value(ctx.effective_role, role)
    return ctx
