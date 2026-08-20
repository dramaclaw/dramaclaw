"""API 共享依赖。

提供路径计算、Store 创建等公共函数。
项目级 API 必须先解析为 ProjectContext；username/project 只保留给路径显示与脚本工具。
"""

import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, AsyncIterator

from fastapi import Depends, HTTPException

from novelvideo.api.auth import get_api_user
from novelvideo.config import OUTPUT_DIR, RUNTIME_DIR, STATE_DIR
from novelvideo.project_context import (
    ProjectContext,
    require_project_home_node,
    resolve_project_context,
)
from novelvideo.ports.project import PROJECT_ROLE_EDITOR, role_allows
from novelvideo.utils.project_paths import ProjectPaths
from novelvideo.utils.static_urls import project_static_url

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.sqlite_store import SQLiteStore

PROJECT_TRASH_DIRNAME = "_trash"
ACCOUNT_ASSET_DIRNAME = "_account"
RESERVED_PROJECT_PREFIX = "_"


@dataclass(frozen=True)
class ProjectResolution:
    """Resolved project scope for project_id-based API routes."""

    ctx: ProjectContext
    username: str
    project_name: str
    project_dir: Path
    output_dir: str
    state_dir: str
    runtime_dir: str


def get_user_base_dir(username: str) -> Path:
    """获取用户根目录。"""
    return Path(OUTPUT_DIR) / username


def get_user_project_roots(username: str) -> tuple[Path, Path]:
    """获取用户项目根目录（state 为主，兼容 output）。"""
    return (
        Path(STATE_DIR) / username,
        Path(OUTPUT_DIR) / username,
    )


def list_user_projects(username: str) -> list[str]:
    """列出用户的全部项目名（state 为主，兼容 output）。"""
    project_names: set[str] = set()
    for user_root in get_user_project_roots(username):
        if not user_root.exists():
            continue
        for entry in user_root.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") or entry.name in {
                PROJECT_TRASH_DIRNAME,
                ACCOUNT_ASSET_DIRNAME,
            }:
                continue
            project_names.add(entry.name)
    return sorted(name for name in project_names if get_project_paths(username, name).exists())


def get_project_paths(username: str, project: str) -> ProjectPaths:
    return ProjectPaths(username, project)


def get_project_paths_for_context(ctx: ProjectContext) -> ProjectPaths:
    return ProjectPaths.from_context(ctx)


def project_exists(username: str, project: str) -> bool:
    paths = get_project_paths(username, project)
    return paths.exists()


def get_project_dir(username: str, project: str) -> Path:
    """获取项目目录，不存在则抛 404。"""
    project_dir = get_project_paths(username, project).output_dir
    if not project_exists(username, project):
        raise HTTPException(status_code=404, detail=f"Project '{project}' not found")
    return project_dir


async def resolve_project_scope(
    project: str,
    user: dict,
    *,
    required_role: str = "viewer",
) -> ProjectResolution:
    """Resolve a route project_id to ProjectContext-backed local paths."""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role=required_role,
    )
    require_project_home_node(ctx, operation="resolve project files")
    return ProjectResolution(
        ctx=ctx,
        username=ctx.owner_username,
        project_name=ctx.project_name,
        project_dir=Path(ctx.output_dir),
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
        runtime_dir=str(ctx.runtime_dir),
    )


def may_run_asset_repair(ctx: ProjectContext | None) -> bool:
    """存量资产名自愈能不能在这个请求里跑。

    自愈会 ``shutil.move`` 资产目录、改 SQLite 主键、刷 ``updated_at``——这是一次写操作，
    却挂在 ``required_role="viewer"`` 的列表接口上：只读协作者打开一次资产页就会替整个
    项目做迁移。把它收到 editor 及以上，只读的人看到的还是原样（他们本来也删不掉、生不
    出图），第一个有写权限的人打开资产页时统一治好。

    ``ctx`` 为 ``None`` 是单机 / CE 路径，没有协作者概念，按有写权限处理。
    """

    if ctx is None:
        return True
    return role_allows(getattr(ctx, "effective_role", "") or "", PROJECT_ROLE_EDITOR)


def validate_project_name(name: str):
    """验证项目名称格式。"""
    if not name or not re.match(r"^[a-zA-Z0-9_]+$", name):
        raise HTTPException(
            status_code=400,
            detail="Project name must contain only letters, digits, and underscores",
        )
    if name.startswith(RESERVED_PROJECT_PREFIX):
        raise HTTPException(
            status_code=400,
            detail="Project name must not start with underscore",
        )


def get_output_dir(username: str, project: str) -> str:
    """获取项目输出目录（绝对路径字符串，供 task backend 使用）。"""
    return str(Path(OUTPUT_DIR) / username / project)


def get_state_dir(username: str, project: str) -> str:
    """获取项目状态目录（绝对路径字符串，供 task backend 使用）。"""
    return str(Path(STATE_DIR) / username / project)


def get_runtime_dir(username: str, project: str) -> str:
    """获取项目运行时目录（绝对路径字符串，供 task backend 使用）。"""
    return str(Path(RUNTIME_DIR) / username / project)


async def make_cognee_store(username: str, project: str) -> "CogneeStore":
    """按请求创建 CogneeStore 实例。

    旧 API/任务路径仍直接 await 这个函数；FastAPI dependency 使用下面的
    ``*_store_scope`` 包装，避免一次性改动所有调用点。
    """
    from novelvideo.cognee import CogneeStore

    project_name = f"{username}/{project}"
    output_dir = get_output_dir(username, project)
    state_dir = get_state_dir(username, project)
    store = CogneeStore(project_name, output_dir=output_dir, state_dir=state_dir)
    await store.initialize()
    return store


async def make_sqlite_store(username: str, project: str) -> "SQLiteStore":
    """按请求创建 SQLiteStore 实例。"""
    from novelvideo.sqlite_store import SQLiteStore

    project_name = f"{username}/{project}"
    output_dir = get_output_dir(username, project)
    state_dir = get_state_dir(username, project)
    store = SQLiteStore(project_name, output_dir=output_dir, state_dir=state_dir)
    await store.initialize()
    await store.load_graph_state()
    return store


async def make_sqlite_store_for_context(ctx: ProjectContext) -> "SQLiteStore":
    """Create a SQLiteStore from the resolved project owner/home paths."""
    from novelvideo.sqlite_store import SQLiteStore

    require_project_home_node(ctx, operation="open project SQLite store")
    project_name = ctx.owner_project_label
    store = SQLiteStore(
        project_name,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await store.initialize()
    await store.load_graph_state()
    return store


async def make_cognee_store_for_context(ctx: ProjectContext) -> "CogneeStore":
    """Create a CogneeStore from the resolved project owner/home paths."""
    from novelvideo.cognee import CogneeStore

    require_project_home_node(ctx, operation="open project graph store")
    store = CogneeStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await store.initialize()
    return store


async def _make_cognee_store_scope(username: str, project: str) -> AsyncIterator["CogneeStore"]:
    store = await make_cognee_store(username, project)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def _make_sqlite_store_scope(username: str, project: str) -> AsyncIterator["SQLiteStore"]:
    store = await make_sqlite_store(username, project)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


sqlite_store_scope = asynccontextmanager(_make_sqlite_store_scope)
cognee_store_scope = asynccontextmanager(_make_cognee_store_scope)


async def get_sqlite_store(
    project: str,
    user: dict = Depends(get_api_user),
) -> AsyncIterator["SQLiteStore"]:
    """FastAPI dependency: 当前 project_id 作用域的 SQLiteStore。"""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role="viewer",
    )
    store = await make_sqlite_store_for_context(ctx)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def get_cognee_store(
    project: str,
    user: dict = Depends(get_api_user),
) -> AsyncIterator["CogneeStore"]:
    """FastAPI dependency: 当前 project_id 作用域的 CogneeStore。"""
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role="viewer",
    )
    store = await make_cognee_store_for_context(ctx)
    try:
        yield store
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


async def get_project_context_dependency(
    project_id: str,
    user: dict = Depends(get_api_user),
) -> ProjectContext:
    return await resolve_project_context(user=user, project_id=project_id)


def make_project_static_url(
    ctx: ProjectContext,
    relative_path: str,
    local_path: str | Path | None = None,
) -> str:
    """Build the canonical protected project static URL."""
    resolved_local_path = (
        local_path if local_path is not None else Path(ctx.output_dir) / relative_path
    )
    return project_static_url(ctx.project_id, relative_path, local_path=resolved_local_path)


def make_static_url_for_context(
    ctx: ProjectContext,
    relative_path: str,
    local_path: str | Path | None = None,
) -> str:
    return make_project_static_url(ctx, relative_path, local_path=local_path)
