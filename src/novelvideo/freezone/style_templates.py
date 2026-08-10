# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""短剧风格模板清单的加载与兜底。

模板正文(标签、分类、封面/示例图相对路径、提示词)放在 `style_templates.json`,
随包发布;运维想换一套风格库时把 `STYLE_GALLERY_MANIFEST` 指到外部文件即可,
不必改代码重新发版 —— 和图片走 `STYLE_GALLERY_ASSET_BASE` 是同一个思路。

外部清单读坏了(文件不在、JSON 语法错、字段缺失)一律降级回内置那份并打一条
warning:风格是锦上添花的能力,不该因为一个配置文件把出图接口整个拖死。内置
那份读不出来才抛 —— 那是打包坏了,必须吵。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

MANIFEST_ENV = "STYLE_GALLERY_MANIFEST"
BUILTIN_MANIFEST_PATH = Path(__file__).with_name("style_templates.json")

# 每条模板必须有的非空字符串字段。samples 允许为空列表(只有封面也能用)。
_REQUIRED_TEXT_FIELDS = ("id", "label", "category", "cover", "style_prompt")

_CacheKey = tuple[Any, ...]
_cache: Optional[tuple[_CacheKey, str, list[dict]]] = None


class StyleManifestError(ValueError):
    """清单结构不合法。"""


def _manifest_path() -> Path:
    override = os.environ.get(MANIFEST_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return BUILTIN_MANIFEST_PATH


def _cache_key(path: Path) -> _CacheKey:
    """带上 mtime/size:运维原地替换清单文件后下一次请求就能生效。"""
    try:
        stat = path.stat()
    except OSError:
        return (str(path), None)
    return (str(path), stat.st_mtime_ns, stat.st_size)


def _parse_manifest(raw: Any) -> tuple[str, list[dict]]:
    """接受 `{"version": ..., "templates": [...]}`,也接受裸数组。"""
    if isinstance(raw, list):
        version, templates = "", raw
    elif isinstance(raw, dict):
        version = str(raw.get("version") or "")
        templates = raw.get("templates")
    else:
        raise StyleManifestError("清单顶层必须是对象或数组")

    if not isinstance(templates, list) or not templates:
        raise StyleManifestError("templates 必须是非空数组")

    seen: set[str] = set()
    parsed: list[dict] = []
    for index, item in enumerate(templates):
        if not isinstance(item, dict):
            raise StyleManifestError(f"第 {index} 条模板不是对象")
        for field in _REQUIRED_TEXT_FIELDS:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise StyleManifestError(f"第 {index} 条模板缺少字段 {field}")
        samples = item.get("samples", [])
        if not isinstance(samples, list) or any(
            not isinstance(sample, str) or not sample.strip() for sample in samples
        ):
            raise StyleManifestError(f"模板 {item['id']} 的 samples 必须是字符串数组")
        if item["id"] in seen:
            raise StyleManifestError(f"模板 id 重复: {item['id']}")
        seen.add(item["id"])
        parsed.append(
            {
                "id": item["id"],
                "label": item["label"],
                "category": item["category"],
                "cover": item["cover"],
                "samples": list(samples),
                "style_prompt": item["style_prompt"],
            }
        )
    return version, parsed


def _read_manifest(path: Path) -> tuple[str, list[dict]]:
    return _parse_manifest(json.loads(path.read_text(encoding="utf-8")))


def _load() -> tuple[str, list[dict]]:
    global _cache

    path = _manifest_path()
    key = _cache_key(path)
    if _cache is not None and _cache[0] == key:
        return _cache[1], _cache[2]

    try:
        version, templates = _read_manifest(path)
    except (OSError, ValueError) as exc:
        if path == BUILTIN_MANIFEST_PATH:
            raise RuntimeError(f"内置风格清单不可用: {path}") from exc
        logger.warning(
            "[freezone] 风格清单 %s 不可用(%s),回落到内置清单", path, exc
        )
        version, templates = _read_manifest(BUILTIN_MANIFEST_PATH)

    _cache = (key, version, templates)
    return version, templates


def reset_style_template_cache() -> None:
    """改环境变量或原地换文件后强制重读;测试用。"""
    global _cache
    _cache = None


def load_style_templates() -> list[dict]:
    return list(_load()[1])


def get_style_manifest_version() -> str:
    return _load()[0]
