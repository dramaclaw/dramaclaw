"""Read a copyable LibTV share canvas with a local, uncommitted cookie file."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

COOKIE_FILENAME = "liblib.cookie.local.json"
DETAIL_URL = "https://api.liblib.tv/api/canvas/project/detail"
MAX_DETAIL_BYTES = 10 * 1024 * 1024


class LiblibImportError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class LiblibShareLink:
    space_id: str
    project_id: str
    url: str


def parse_liblib_share_url(value: str) -> LiblibShareLink:
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError as exc:
        raise LiblibImportError("invalid_liblib_share_url", "LibTV 分享链接格式无效") from exc
    if parsed.scheme != "https" or parsed.hostname not in {"www.liblib.tv", "liblib.tv"}:
        raise LiblibImportError("invalid_liblib_share_url", "请粘贴 LibTV 的 HTTPS 分享链接")
    if parsed.path.rstrip("/") != "/canvas/share" or port not in {None, 443}:
        raise LiblibImportError("invalid_liblib_share_url", "链接必须指向 LibTV 分享画布")
    query = parse_qs(parsed.query, keep_blank_values=True)
    space_ids = query.get("spaceId", [])
    project_ids = query.get("projectId", [])
    if len(space_ids) != 1 or len(project_ids) != 1:
        raise LiblibImportError("invalid_liblib_share_url", "分享链接缺少 spaceId 或 projectId")
    space_id = space_ids[0]
    project_id = project_ids[0].lower()
    if not space_id.isdecimal() or len(project_id) != 32 or any(c not in "0123456789abcdef" for c in project_id):
        raise LiblibImportError("invalid_liblib_share_url", "分享链接的画布标识无效")
    return LiblibShareLink(
        space_id=space_id,
        project_id=project_id,
        url=f"https://www.liblib.tv/canvas/share?spaceId={space_id}&projectId={project_id}",
    )


def liblib_cookie_path() -> Path:
    configured = os.environ.get("LIBLIB_COOKIE_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[3] / COOKIE_FILENAME


def read_liblib_cookie(path: Path | None = None) -> tuple[str, str]:
    cookie_path = path or liblib_cookie_path()
    try:
        raw = json.loads(cookie_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LiblibImportError(
            "liblib_cookie_missing",
            f"请在仓库根目录创建 {COOKIE_FILENAME}，填写 usertoken 和 webid",
            409,
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise LiblibImportError("liblib_cookie_invalid", "LibTV cookie 文件无法读取或 JSON 格式有误", 409) from exc
    if isinstance(raw, list):
        raw = {item.get("name"): item.get("value") for item in raw if isinstance(item, dict)}
    if not isinstance(raw, dict):
        raise LiblibImportError("liblib_cookie_invalid", "LibTV cookie 文件必须是 JSON 对象", 409)
    token = raw.get("usertoken")
    webid = raw.get("webid")
    if not isinstance(token, str) or not token.strip() or not isinstance(webid, str) or not webid.strip():
        raise LiblibImportError("liblib_cookie_invalid", "请填写有效的 usertoken 和 webid", 409)
    return token.strip(), webid.strip()


async def fetch_liblib_canvas_detail(share: LiblibShareLink) -> dict:
    token, webid = read_liblib_cookie()
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
            response = await client.get(
                DETAIL_URL,
                params={"uuid": share.project_id},
                headers={"token": token, "webid": webid, "x-language": "zh"},
            )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise LiblibImportError("liblib_unavailable", "无法连接 LibTV 画布接口", 502) from exc
    if len(response.content) > MAX_DETAIL_BYTES:
        raise LiblibImportError("liblib_detail_too_large", "LibTV 画布数据超过导入上限", 413)
    try:
        payload = response.json()
    except ValueError as exc:
        raise LiblibImportError("liblib_invalid_response", "LibTV 返回了无法解析的数据", 502) from exc
    if not isinstance(payload, dict):
        raise LiblibImportError("liblib_invalid_response", "LibTV 画布数据格式有误", 502)
    if payload.get("code") == 10001:
        # 409 keeps the local API client from treating LibTV's expired token
        # as an expired SuperTale session.
        raise LiblibImportError("liblib_unauthorized", f"LibTV 登录已失效，请更新 {COOKIE_FILENAME}", 409)
    if payload.get("code") != 0:
        raise LiblibImportError("liblib_remote_error", "LibTV 未能读取这张分享画布", 502)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise LiblibImportError("liblib_invalid_response", "LibTV 画布数据格式有误", 502)
    meta = data.get("projectMeta")
    if not isinstance(meta, dict) or str(meta.get("uuid", "")).lower() != share.project_id:
        raise LiblibImportError("liblib_project_mismatch", "返回的项目与分享链接不一致", 502)
    if str(meta.get("projectSpaceId")) != share.space_id:
        raise LiblibImportError("liblib_project_mismatch", "返回的空间与分享链接不一致", 502)
    access = meta.get("accessConfig")
    if not isinstance(access, dict) or access.get("accessPolicy") != 2 or access.get("allowCopy") is not True:
        raise LiblibImportError("liblib_not_copyable", "这张 LibTV 画布未开放复制", 403)
    if not isinstance(data.get("nodeList"), list) or not isinstance(data.get("connectionList"), list):
        raise LiblibImportError("liblib_invalid_response", "LibTV 画布缺少节点或连线", 502)
    return {
        "projectMeta": {
            "uuid": meta["uuid"],
            "name": meta.get("name") or "LibTV 画布",
            "projectSpaceId": meta["projectSpaceId"],
        },
        "projectDraft": data.get("projectDraft"),
        "nodeList": data["nodeList"],
        "connectionList": data["connectionList"],
    }
