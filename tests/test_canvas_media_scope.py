# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""画布媒体引用的作用域守卫。

判定只有一条：媒体 URL 里的 project id ≠ 画布所属项目 = 外项目引用。不看个人/组织，
所以源项目的所有者本人也绕不过去——静态资源本来就按 URL 里的项目 id 独立鉴权，
换个合法成员打开就是 403。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone import canvas_store
from novelvideo.project_context import ProjectContext
from novelvideo.freezone.canvas_media_scope import (
    CanvasMediaScopeError,
    ForeignMediaRef,
    reject_new_foreign_media_refs,
    scan_foreign_media_refs,
)


def _node(node_id: str, data: dict) -> dict:
    return {"id": node_id, "type": "image", "position": {"x": 0, "y": 0}, "data": data}


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------


def test_scan_finds_a_foreign_static_url_on_a_node() -> None:
    payload = {"nodes": [_node("n1", {"imageUrl": "/static/projects/proj_src/a.png"})]}

    refs = scan_foreign_media_refs(payload, project_id="proj_dst")

    assert refs == [
        ForeignMediaRef(
            node_id="n1",
            field="imageUrl",
            url="/static/projects/proj_src/a.png",
            source_project_id="proj_src",
        )
    ]


def test_scan_finds_the_api_media_form_too() -> None:
    url = "/api/v1/projects/proj_src/media/freezone/_uploads/a.mp4"
    payload = {"nodes": [_node("n1", {"videoUrl": url})]}

    refs = scan_foreign_media_refs(payload, project_id="proj_dst")

    assert [(r.field, r.source_project_id) for r in refs] == [("videoUrl", "proj_src")]


def test_scan_ignores_media_that_belongs_to_the_canvas_project() -> None:
    payload = {
        "nodes": [
            _node("n1", {"imageUrl": "/static/projects/proj_dst/a.png?v=1"}),
            _node("n2", {"videoUrl": "/api/v1/projects/proj_dst/media/b.mp4"}),
        ]
    }

    assert scan_foreign_media_refs(payload, project_id="proj_dst") == []


def test_scan_ignores_everything_that_is_not_a_project_asset_url() -> None:
    payload = {
        "nodes": [
            _node(
                "n1",
                {
                    "imageUrl": "data:image/png;base64,AAAA",
                    "videoUrl": "https://cdn.example.com/a.mp4",
                    # legacy 形式没有项目 id，后端已经 410，也没法按项目授权。
                    "posterUrl": "/static/alice/rigeng/a.png",
                    "title": "/static/projects/proj_src/not-a-url-field.png",
                },
            )
        ]
    }

    assert scan_foreign_media_refs(payload, project_id="proj_dst") == []


def test_scan_walks_nested_node_data() -> None:
    """叠卡画册 / 分镜帧把 URL 藏在数组和子对象里，字段白名单靠不住。"""
    payload = {
        "nodes": [
            _node(
                "n1",
                {
                    "cells": [
                        {"imageUrl": "/static/projects/proj_dst/ok.png"},
                        {"imageUrl": "/static/projects/proj_src/bad.png"},
                    ],
                    "cover": {"thumbnailUrl": "/static/projects/proj_other/thumb.png"},
                },
            )
        ]
    }

    refs = scan_foreign_media_refs(payload, project_id="proj_dst")

    assert [(r.field, r.source_project_id) for r in refs] == [
        ("cells[1].imageUrl", "proj_src"),
        ("cover.thumbnailUrl", "proj_other"),
    ]


def test_scan_reports_each_offending_node_separately() -> None:
    payload = {
        "nodes": [
            _node("n1", {"imageUrl": "/static/projects/proj_src/a.png"}),
            _node("n2", {"imageUrl": "/static/projects/proj_src/b.png"}),
        ]
    }

    refs = scan_foreign_media_refs(payload, project_id="proj_dst")

    assert [r.node_id for r in refs] == ["n1", "n2"]


def test_scan_survives_a_payload_without_usable_nodes() -> None:
    assert scan_foreign_media_refs(None, project_id="proj_dst") == []
    assert scan_foreign_media_refs({}, project_id="proj_dst") == []
    assert scan_foreign_media_refs({"nodes": "nonsense"}, project_id="proj_dst") == []
    assert scan_foreign_media_refs({"nodes": [None, 7]}, project_id="proj_dst") == []


# ---------------------------------------------------------------------------
# 守卫：只拦本次新引入的
# ---------------------------------------------------------------------------


def test_guard_rejects_a_newly_introduced_foreign_reference() -> None:
    incoming = {"nodes": [_node("n1", {"imageUrl": "/static/projects/proj_src/a.png"})]}

    with pytest.raises(CanvasMediaScopeError) as excinfo:
        reject_new_foreign_media_refs(incoming, existing=None, project_id="proj_dst")

    assert [r.url for r in excinfo.value.refs] == ["/static/projects/proj_src/a.png"]


def test_guard_lets_a_reference_that_is_already_stored_through() -> None:
    """生产上那些 403 的老画布还得能存能编辑，否则一个脏节点就把整张画布锁死。"""
    stored_url = "/static/projects/proj_src/a.png"
    existing = {"nodes": [_node("n1", {"imageUrl": stored_url})]}
    incoming = {
        "nodes": [
            _node("n1", {"imageUrl": stored_url}),
            _node("n2", {"label": "新加的干净节点"}),
        ]
    }

    reject_new_foreign_media_refs(incoming, existing=existing, project_id="proj_dst")


def test_guard_matches_stored_references_by_url_not_by_node() -> None:
    """老 URL 挪到别的节点上（拖动重组）不算新引入。"""
    stored_url = "/static/projects/proj_src/a.png"
    existing = {"nodes": [_node("n1", {"imageUrl": stored_url})]}
    incoming = {"nodes": [_node("n9", {"imageUrl": stored_url})]}

    reject_new_foreign_media_refs(incoming, existing=existing, project_id="proj_dst")


def test_guard_still_rejects_a_new_reference_next_to_a_grandfathered_one() -> None:
    stored_url = "/static/projects/proj_src/a.png"
    existing = {"nodes": [_node("n1", {"imageUrl": stored_url})]}
    incoming = {
        "nodes": [
            _node("n1", {"imageUrl": stored_url}),
            _node("n2", {"imageUrl": "/static/projects/proj_src/b.png"}),
        ]
    }

    with pytest.raises(CanvasMediaScopeError) as excinfo:
        reject_new_foreign_media_refs(incoming, existing=existing, project_id="proj_dst")

    assert [r.url for r in excinfo.value.refs] == ["/static/projects/proj_src/b.png"]


def test_guard_ignores_the_cache_bust_query_when_matching_stored_references() -> None:
    """`?v=` 每次读都可能被重新盖一遍，不能因此把老引用当成新引入。"""
    existing = {"nodes": [_node("n1", {"imageUrl": "/static/projects/proj_src/a.png?v=1"})]}
    incoming = {"nodes": [_node("n1", {"imageUrl": "/static/projects/proj_src/a.png?v=2"})]}

    reject_new_foreign_media_refs(incoming, existing=existing, project_id="proj_dst")


def test_guard_accepts_a_canvas_whose_media_all_belongs_to_the_project() -> None:
    incoming = {"nodes": [_node("n1", {"imageUrl": "/static/projects/proj_dst/a.png"})]}

    reject_new_foreign_media_refs(incoming, existing=None, project_id="proj_dst")


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

USER = {"id": "user_bob", "username": "bob"}
FOREIGN = "/static/projects/proj_src/freezone/_uploads/a.png"
LOCAL = "/static/projects/proj_dst/freezone/_uploads/b.png"


def _ctx(tmp_path: Path, project_id: str, *, owner: str = "bob") -> ProjectContext:
    return ProjectContext(
        project_id=project_id,
        project_name="vlog",
        owner_type="user",
        owner_id=f"user_{owner}",
        owner_username=owner,
        requester_user_id="user_bob",
        requester_username="bob",
        requester_principals=(("user", "user_bob"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / project_id,
        state_dir=tmp_path / "state" / project_id,
        runtime_dir=tmp_path / "runtime" / project_id,
        is_home_node=True,
    )


def _patch_project(monkeypatch: pytest.MonkeyPatch, ctx: ProjectContext) -> None:
    async def fake_resolve_project_context(*, user, project_id=None, project_name=None,
                                           required_role="viewer") -> ProjectContext:
        if project_id != ctx.project_id:
            raise HTTPException(status_code=404, detail="Project not found")
        return ctx

    monkeypatch.setattr(freezone_routes, "resolve_project_context", fake_resolve_project_context)


def _node_payload(url: str | None, *, node_id: str = "n1") -> list[dict]:
    data: dict = {"label": "节点"}
    if url is not None:
        data["imageUrl"] = url
    return [{"id": node_id, "type": "image", "position": {"x": 0, "y": 0}, "data": data}]


async def _save(project: str, nodes: list[dict], *, base_revision: int | None = None) -> dict:
    return await freezone_routes.put_canvas(
        project=project,
        canvas_id="default",
        body=CanvasPayload(nodes=nodes, base_revision=base_revision),
        user=USER,
    )


async def test_put_canvas_rejects_a_newly_introduced_foreign_media_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_project(monkeypatch, _ctx(tmp_path, "proj_dst"))

    with pytest.raises(HTTPException) as excinfo:
        await _save("proj_dst", _node_payload(FOREIGN))

    assert excinfo.value.status_code == 422
    detail = excinfo.value.detail
    assert detail["code"] == "canvas_media_scope_mismatch"
    assert detail["project_id"] == "proj_dst"
    assert detail["refs"] == [
        {
            "node_id": "n1",
            "field": "imageUrl",
            "url": FOREIGN,
            "source_project_id": "proj_src",
        }
    ]


async def test_put_canvas_writes_nothing_when_it_rejects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = _ctx(tmp_path, "proj_dst")
    _patch_project(monkeypatch, ctx)
    saved = await _save("proj_dst", _node_payload(LOCAL))
    revision = saved["data"]["revision"]

    with pytest.raises(HTTPException):
        await _save("proj_dst", _node_payload(FOREIGN, node_id="n2"), base_revision=revision)

    stored = canvas_store.read_canvas(Path(ctx.state_dir), "default")
    assert stored["revision"] == revision
    assert [n["id"] for n in stored["nodes"]] == ["n1"]


async def test_put_canvas_accepts_media_that_belongs_to_the_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_project(monkeypatch, _ctx(tmp_path, "proj_dst"))

    result = await _save("proj_dst", _node_payload(LOCAL))

    assert result["data"]["saved"] is True


async def test_put_canvas_rejects_even_the_source_project_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """判定只看 URL 里的项目 id：源素材是自己的也一样拦，否则组织画布又会存下别人读不到的引用。"""
    _patch_project(monkeypatch, _ctx(tmp_path, "proj_dst", owner="bob"))

    with pytest.raises(HTTPException) as excinfo:
        await _save("proj_dst", _node_payload(FOREIGN))

    assert excinfo.value.detail["code"] == "canvas_media_scope_mismatch"


async def test_put_canvas_still_saves_a_canvas_that_already_carried_a_foreign_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """生产上那些 403 老画布：一个历史脏节点不能把整张画布锁成永远存不了。"""
    ctx = _ctx(tmp_path, "proj_dst")
    _patch_project(monkeypatch, ctx)
    state_dir = Path(ctx.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    canvas_store.save_canvas(
        state_dir,
        "default",
        base_revision=None,
        build_payload=lambda existing: {
            "schema_version": 2,
            "canvas_id": "default",
            "project_id": "proj_dst",
            "revision": 1,
            "nodes": _node_payload(FOREIGN),
            "edges": [],
        },
    )

    nodes = _node_payload(FOREIGN) + _node_payload(LOCAL, node_id="n2")
    result = await freezone_routes.put_canvas(
        project="proj_dst",
        canvas_id="default",
        body=CanvasPayload(nodes=nodes, base_revision=1),
        user=USER,
    )

    assert result["data"]["saved"] is True


async def test_get_canvas_reports_the_foreign_media_references_it_serves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """读取期诊断：前端据此显示「素材属于其他项目」，不再只给一片裂图。"""
    ctx = _ctx(tmp_path, "proj_dst")
    _patch_project(monkeypatch, ctx)
    state_dir = Path(ctx.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    canvas_store.save_canvas(
        state_dir,
        "default",
        base_revision=None,
        build_payload=lambda existing: {
            "schema_version": 2,
            "canvas_id": "default",
            "project_id": "proj_dst",
            "revision": 1,
            "nodes": _node_payload(FOREIGN),
            "edges": [],
        },
    )

    response = await freezone_routes.get_canvas(
        project="proj_dst", canvas_id="default", user=USER
    )

    assert response["foreign_media"] == [
        {
            "node_id": "n1",
            "field": "imageUrl",
            "url": FOREIGN,
            "source_project_id": "proj_src",
        }
    ]


async def test_get_canvas_omits_the_diagnostics_when_every_reference_is_local(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_project(monkeypatch, _ctx(tmp_path, "proj_dst"))
    await _save("proj_dst", _node_payload(LOCAL))

    response = await freezone_routes.get_canvas(
        project="proj_dst", canvas_id="default", user=USER
    )

    assert "foreign_media" not in response
