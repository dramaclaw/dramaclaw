# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""画布媒体引用的作用域守卫。

静态资源按 URL 里的项目 id 独立鉴权，画布保存却从来不看这个：一张画布可以存下指向
**别的项目**的媒体地址，源项目的所有者本人打开一切正常，换个同样合法的项目成员打开
就是整片 403 裂图——项目可共享，内部依赖不可共享。

这里只做一件事：把画布载荷里的媒体引用扫出来，凡是 URL 里的项目 id ≠ 画布所属项目的
就是外项目引用。判定不区分个人 / 组织，所以源项目所有者本人也绕不过去。

守卫按「本次新引入的」拦：库里已经躺着的历史脏引用照常放行，否则一个脏节点就能把整张
老画布永久锁死（那些画布正是本守卫要解决的问题的受害者）。历史数据靠读取期诊断
（`GET` 带回的引用清单）和用户手动复制收敛。
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlsplit

from novelvideo.freezone.asset_copy import parse_project_asset_url
from novelvideo.freezone.canvas_static_urls import is_url_field_name

# 浏览器取资源时既不管 scheme/host 是不是写全了，也会先把 `..` 规范化掉。`parse_project_asset_url`
# 是 copy 接口的入口解析器，只认相对的 canonical 形式（故意的：那里不能拿外站 URL 当本地文件）。
# 两边语义不一致，守卫就会漏：`/static/projects/target/../source/a.png` 按 target 放行，浏览器
# 实际取的却是 source。所以扫描前先把 URL 还原成浏览器眼里的站点路径。
_LOCAL_URL_SCHEMES = {"", "http", "https"}


@dataclass(frozen=True)
class ForeignMediaRef:
    """一处指向别的项目的媒体引用。"""

    node_id: str
    """出问题的节点 id。"""
    field: str
    """节点 `data` 内的字段路径，例如 `cells[1].imageUrl`。"""
    url: str
    """载荷里的原始 URL（含查询串，前端要按原字符串回改）。"""
    source_project_id: str
    """URL 指向的项目。"""

    def as_dict(self) -> dict[str, str]:
        return {
            "node_id": self.node_id,
            "field": self.field,
            "url": self.url,
            "source_project_id": self.source_project_id,
        }


class CanvasMediaScopeError(Exception):
    """画布想持久化本项目之外的媒体引用。"""

    def __init__(self, refs: list[ForeignMediaRef]):
        super().__init__(f"canvas media scope mismatch: {len(refs)} foreign reference(s)")
        self.refs = refs


def scan_foreign_media_refs(payload: dict | None, *, project_id: str) -> list[ForeignMediaRef]:
    """列出载荷里所有不属于 `project_id` 的媒体引用，按节点、字段顺序。"""
    return list(_iter_foreign_refs(payload, project_id=project_id))


def reject_new_foreign_media_refs(
    payload: dict | None,
    *,
    existing: dict | None,
    project_id: str,
) -> None:
    """本次保存新引入了外项目引用就抛错；库里已有的那些原样放行。"""
    incoming = scan_foreign_media_refs(payload, project_id=project_id)
    if not incoming:
        return
    grandfathered = {
        _asset_identity(ref.url) for ref in scan_foreign_media_refs(existing, project_id=project_id)
    }
    # 同一个文件的 `?v=` 每次读都可能被重新盖一遍，按「项目 + 项目内路径」认，别按整串认。
    new_refs = [ref for ref in incoming if _asset_identity(ref.url) not in grandfathered]
    if new_refs:
        raise CanvasMediaScopeError(new_refs)


def _site_path(url: str) -> str | None:
    """把 URL 还原成浏览器实际会去取的站点路径；不是站点资源就回 `None`。

    只保留 path：`data:` / `blob:` 这类不是站点文件，直接不认；带 host 的完整 URL 按 path 归类
    （代价是外站 URL 只要路径长得跟项目资源一模一样也会被当成项目资源——宁可误拦，也不放过一个
    浏览器会当项目资源去取的地址）。
    """
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        # `http://[` 这类畸形 URL：urlsplit 自己就会炸，同样不是站点资源。
        return None
    if parts.scheme.lower() not in _LOCAL_URL_SCHEMES or not parts.path:
        return None
    # `%2e%2e` 在 URL 规范里也是双点段，浏览器照样会拿它回退一层；只还原点，不整串 unquote
    # （`%2f` 不是分隔符，整串 unquote 反而会把路径切错）。
    return posixpath.normpath(re.sub("%2e", ".", parts.path, flags=re.IGNORECASE))


def _parse_media_url(url: str) -> tuple[str, str] | None:
    path = _site_path(url)
    return parse_project_asset_url(path) if path is not None else None


def _asset_identity(url: str) -> tuple[str, str] | str:
    parsed = _parse_media_url(url)
    return parsed if parsed is not None else url


def _iter_foreign_refs(payload: dict | None, *, project_id: str) -> Iterator[ForeignMediaRef]:
    if not isinstance(payload, dict):
        return
    nodes = payload.get("nodes")
    if not isinstance(nodes, list):
        return
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or f"#{index}")
        data = node.get("data")
        if not isinstance(data, (dict, list)):
            continue
        yield from _iter_foreign_values(data, node_id=node_id, path="", project_id=project_id)


def _iter_foreign_values(
    value: object,
    *,
    node_id: str,
    path: str,
    project_id: str,
    key: str | None = None,
) -> Iterator[ForeignMediaRef]:
    if isinstance(value, dict):
        for child_key, child in value.items():
            child_key = str(child_key)
            child_path = f"{path}.{child_key}" if path else child_key
            yield from _iter_foreign_values(
                child,
                node_id=node_id,
                path=child_path,
                project_id=project_id,
                key=child_key,
            )
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_foreign_values(
                child,
                node_id=node_id,
                path=f"{path}[{index}]",
                project_id=project_id,
                key=key,
            )
        return
    if not isinstance(value, str) or not is_url_field_name(key):
        return
    parsed = _parse_media_url(value)
    if parsed is None:
        return
    source_project_id, _rel = parsed
    if source_project_id == project_id:
        return
    yield ForeignMediaRef(
        node_id=node_id,
        field=path,
        url=value,
        source_project_id=source_project_id,
    )
