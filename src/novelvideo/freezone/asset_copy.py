"""跨项目素材拷贝：把源项目的一个文件复制成目标项目 `freezone/_uploads/` 下的新文件。

跨项目粘贴节点时，节点 data 里的 URL 还指向源项目。之前前端要把每个文件
fetch 下来再 POST 到目标项目的 upload 接口，字节走两遍；这里改成后端直接拷：

1. 生产环境 `OUTPUT_DIR` 是 ossfs 挂载，优先让 OSS 在服务端 CopyObject，字节不
   经过 pod；
2. OSS 不可用、源对象还没写回（或还是旧版本）、单对象超过 CopyObject 上限、拷完
   在挂载点上看不见——都回退成普通文件系统拷贝，正确性不依赖 OSS。

URL 解析只认 `/static/projects/<pid>/<rel>` 与 `/api/v1/projects/<pid>/media/<rel>`
两种同源 canonical 形式；`/static/<user>/<project>/...` 这类老式路径拿不到项目 id，
本来也不会出现在需要跨项目授权的场景里，一律不认。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit

from novelvideo.freezone.paths import safe_upload_filename
from novelvideo.utils import oss_client

logger = logging.getLogger("novelvideo.freezone.asset_copy")

MAX_SOURCES_PER_REQUEST = 200
MAX_SOURCE_URL_LENGTH = 2048

# 目标文件名 = 时间戳前缀(23) + 源文件名；源文件名再长也截到这个数，免得撞上文件系统
# 单段 255 字节的上限——`safe_upload_filename` 把非 ASCII 全换成 `_`，字符数即字节数。
_MAX_TARGET_BASENAME = 120
_MAX_KEPT_EXTENSION = 16

# OSS 单次 CopyObject 只支持 1 GB 以内的对象；更大的走 UploadPartCopy，这里不做。
_OSS_COPY_OBJECT_LIMIT_BYTES = 1024 * 1024 * 1024

_STATIC_PREFIX = "/static/projects/"
_MEDIA_PREFIX = "/api/v1/projects/"
_MEDIA_MARKER = "/media/"

CopyMethod = Literal["oss", "filesystem"]
FailureReason = Literal["invalid_source", "not_found", "forbidden", "unavailable", "copy_failed"]


class AssetCopyError(Exception):
    """单个源文件失败；`reason` 会原样回给前端，不带路径细节。"""

    def __init__(self, reason: FailureReason, detail: str = ""):
        super().__init__(detail or reason)
        self.reason: FailureReason = reason


def parse_project_asset_url(url: str) -> tuple[str, str] | None:
    """把同源素材 URL 拆成 `(project_id, 项目内相对路径)`；不认的形式返回 None。"""
    raw = (url or "").strip()
    if not raw or "\\" in raw:
        return None
    try:
        parts = urlsplit(raw)
    except ValueError:
        # `http://[` 这类畸形 URL：urlsplit 自己就会炸（Invalid IPv6 URL），同样不是本站文件。
        return None
    # 只接受同源路径：带 scheme/netloc 的（含 data:/blob:/协议相对形式）都不是本站文件。
    if parts.scheme or parts.netloc:
        return None
    path = parts.path
    if path.startswith(_STATIC_PREFIX):
        remainder = path[len(_STATIC_PREFIX) :]
        project_id, sep, rel = remainder.partition("/")
    elif path.startswith(_MEDIA_PREFIX) and _MEDIA_MARKER in path[len(_MEDIA_PREFIX) :]:
        remainder = path[len(_MEDIA_PREFIX) :]
        project_id, sep, rel = remainder.partition(_MEDIA_MARKER)
    else:
        return None
    if not sep:
        return None
    project_id = unquote(project_id)
    rel = unquote(rel)
    if not project_id or "/" in project_id or project_id in {".", ".."}:
        return None
    if not rel or "\\" in rel:
        return None
    # 解码后冒出来的控制字符（`%00` 等）不是文件名，Path 也会在 resolve 时炸掉。
    if _has_control_chars(project_id) or _has_control_chars(rel):
        return None
    return project_id, rel


def _has_control_chars(value: str) -> bool:
    return any(ord(ch) < 32 or ch == "\x7f" for ch in value)


def resolve_source_file(project_dir: Path, rel: str) -> Path:
    """把项目内相对路径落成真实文件；越界或不是普通文件都按失败处理。"""
    try:
        root = project_dir.resolve()
        candidate = (project_dir / rel).resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        # 空字节、超长路径、符号链接环……都是这一条源坏了，不是整批坏了。
        raise AssetCopyError("invalid_source", f"unresolvable path {rel!r}: {exc}") from exc
    if candidate == root or not candidate.is_relative_to(root):
        raise AssetCopyError("invalid_source", f"path escapes project: {rel!r}")
    try:
        is_file = candidate.is_file()
    except OSError as exc:
        raise AssetCopyError("not_found", f"cannot stat {rel!r}: {exc}") from exc
    if not is_file:
        raise AssetCopyError("not_found", f"not a regular file: {rel!r}")
    return candidate


def bounded_upload_basename(name: str, limit: int = _MAX_TARGET_BASENAME) -> str:
    """把源文件名截到 `limit` 个字符以内，尽量保住扩展名。"""
    base = (name or "").split("/")[-1].split("\\")[-1] or "upload"
    if len(base) <= limit:
        return base
    stem, dot, ext = base.rpartition(".")
    if not dot or not stem or len(ext) > _MAX_KEPT_EXTENSION:
        return base[:limit]
    return f"{stem[: limit - len(ext) - 1]}.{ext}"


def allocate_target_path(target_dir: Path, source_name: str) -> Path:
    """在目标 `_uploads/` 下给源文件挑一个还不存在的新名字。"""
    base = bounded_upload_basename(source_name)
    try:
        target = target_dir / safe_upload_filename(base)
        while target.exists():
            target = target_dir / safe_upload_filename(base)
    except OSError as exc:
        raise AssetCopyError("copy_failed", f"cannot allocate target for {source_name!r}: {exc}") from exc
    return target


def _copy_via_oss(source: Path, target: Path) -> bool:
    bucket = oss_client.get_bucket()
    if bucket is None:
        return False
    source_key = oss_client.local_path_to_key(source)
    target_key = oss_client.local_path_to_key(target)
    if not source_key or not target_key:
        return False
    try:
        size = source.stat().st_size
    except OSError:
        return False
    if size > _OSS_COPY_OBJECT_LIMIT_BYTES:
        return False
    # ossfs 写回有延迟：刚落盘的源文件可能还没成为 OSS 对象（CopyObject 会 404），
    # 原地覆盖过的文件则可能 OSS 上还是旧版本、大小都一样——只有确认远端就是本地
    # 这个版本才敢让 OSS 拷，否则旧内容会被当成功结果永久留在目标项目里。
    if not oss_client.object_matches_local(source_key, source):
        return False
    try:
        bucket.copy_object(bucket.bucket_name, source_key, target_key)
    except Exception as exc:  # noqa: BLE001 - 任何 OSS 异常都退回文件系统拷贝
        logger.warning("OSS copy_object failed %s -> %s: %s", source_key, target_key, exc)
        return False
    # 挂载点上必须能看到（并且大小对得上），否则返回给前端的 URL 会 404。
    try:
        visible = target.is_file() and target.stat().st_size == size
    except OSError:
        visible = False
    if not visible:
        logger.warning("OSS copy_object done but %s not visible on mount; falling back", target)
    return visible


def copy_project_file(source: Path, target: Path) -> CopyMethod:
    """把 `source` 复制到 `target`，优先 OSS 服务端拷贝，失败回退文件系统。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    if _copy_via_oss(source, target):
        return "oss"
    shutil.copyfile(source, target)
    return "filesystem"
