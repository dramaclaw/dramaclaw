"""Blender 插件接口。

这一组路由有三种鉴权，混了会出事，所以写在一个文件里、彼此看得见：

- 配对开始与轮询：**不需要**任何凭证。插件此刻还没有凭证，这是先有鸡还是先有蛋
  的那个蛋。保护靠的是 `pairing_id` 的随机性、5 分钟有效期、只兑一次，和频率限制。
- 配对确认、管理已连接插件、下载插件包、认领投递：浏览器会话（`get_api_user`）。
  这些都是登录的人在页面上做的事。
- 其余：插件令牌（`get_blender_client`，见本文件下方）。这是第三类凭证，**只在这个
  文件里生效**——`novelvideo/api/auth.py` 顶上那段注释说得很清楚，长期外部密钥
  不进主鉴权链路。
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import secrets
import zipfile
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import novelvideo
from novelvideo import blender_store
from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.freezone.paths import uploads_dir
from novelvideo.ports import get_project_access, get_project_registry
from novelvideo.ports.project import PROJECT_ROLE_EDITOR, role_allows
from novelvideo.project_context import user_id_from_api_user
from novelvideo.utils.upload_safety import (
    MAX_PROJECT_UPLOAD_BYTES,
    UploadTooLargeError,
    is_safe_upload_target,
    sanitize_upload_filename,
    stream_to_file_with_limit,
)

logger = logging.getLogger("novelvideo.api.blender")

router = APIRouter()

PAIRING_START_LIMIT = 10
PAIRING_APPROVE_LIMIT = 10
# 插件每 2 秒轮询一次，一分钟 30 次；留到 120 是给同一个出口 IP 后面坐着
# 好几个人的情况（公司 NAT）。
PAIRING_POLL_LIMIT = 120
RATE_WINDOW_SECONDS = 60


def _db() -> Path:
    return blender_store.default_db_path()


def _client_bucket(request: Request, prefix: str) -> str:
    host = request.client.host if request.client else "unknown"
    return f"{prefix}:{host}"


def _enforce_rate_limit(bucket: str, limit: int) -> None:
    if not blender_store.hit_rate_limit(
        _db(), bucket, limit=limit, window=RATE_WINDOW_SECONDS
    ):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")


async def get_blender_client(
    authorization: str = Header(default=""),
) -> blender_store.BlenderClient:
    """插件令牌鉴权。**只给这个文件里的路由用。**

    刻意不写进 `novelvideo/api/auth.py`：那里只接受浏览器会话和短时 agent bearer，
    而插件令牌活 30 天。把它接进主链路，等于给整个 API 配一把 30 天的钥匙——
    爆炸半径完全不同。这里窄到只能碰 `/blender/*`。
    """
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="缺少插件令牌")

    client = blender_store.verify_token(_db(), token.strip())
    if client is None:
        raise HTTPException(status_code=401, detail="插件令牌无效或已过期")
    return client


class PairingApproveRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)


@router.post("/blender/pairing/start")
async def start_pairing(request: Request) -> dict:
    _enforce_rate_limit(_client_bucket(request, "blender-start"), PAIRING_START_LIMIT)
    blender_store.purge_expired(_db())
    pairing = blender_store.create_pairing(_db())
    return {
        "pairing_id": pairing.pairing_id,
        "code": pairing.code,
        "expires_in": blender_store.PAIRING_TTL_SECONDS,
    }


@router.post("/blender/pairing/approve")
async def approve_pairing(
    payload: PairingApproveRequest,
    user: dict = Depends(get_api_user),
) -> dict:
    username = user["username"]
    _enforce_rate_limit(f"blender-approve:{username}", PAIRING_APPROVE_LIMIT)
    if not blender_store.approve_pairing(_db(), payload.code, user_id=username):
        # 不区分「码不对」「码过期」「码用过了」——区分了就是在帮人猜。
        raise HTTPException(status_code=400, detail="配对码无效或已过期")
    return {"ok": True}


@router.get("/blender/pairing/{pairing_id}")
async def poll_pairing(pairing_id: str, request: Request) -> dict:
    _enforce_rate_limit(_client_bucket(request, "blender-poll"), PAIRING_POLL_LIMIT)
    result = blender_store.consume_pairing(_db(), pairing_id)
    if result.status == "approved":
        return {
            "status": "approved",
            "token": result.token,
            "expires_in": blender_store.TOKEN_TTL_SECONDS,
        }
    return {"status": result.status}


@router.get("/blender/projects")
async def list_projects(
    client: blender_store.BlenderClient = Depends(get_blender_client),
) -> dict:
    """插件面板的项目下拉框：配对账号能投进去的项目，给出 `id` 和 `name`。

    插件显示 `name`，但**存下来、拼进投递地址的必须是 `id`**：投递接口走
    `resolve_project_scope`，按注册表 id 查。以前这里返回目录名，插件拿名字去投，
    每一次都是 `Project not found`。名字也当不了地址——别人共享给你的项目可能跟你
    自己的同名。

    来源跟前端 `GET /projects` 是同一个注册表，所以共享给你的项目也在；只列
    editor 及以上（投递要 editor，列出一个投不进去的项目只会换来一个 403），
    回收站里的和已清除的不列。
    """
    user_id = await user_id_from_api_user({"username": client.user_id})
    registry = get_project_registry()
    access = get_project_access()
    principals = await access.resolve_requester_principals(user_id)
    records = await registry.list_accessible_projects(
        [(p.type, p.id) for p in principals]
    )
    projects = []
    for record in records:
        if record.purged_at or record.status == "deleted":
            continue
        role = await access.effective_project_role(record, principals)
        if role and role_allows(role, PROJECT_ROLE_EDITOR):
            projects.append({"id": record.id, "name": record.name})
    return {"projects": projects}


@router.get("/blender/clients")
async def list_clients(user: dict = Depends(get_api_user)) -> dict:
    clients = blender_store.list_tokens(_db(), user_id=user["username"])
    return {
        "clients": [
            {
                "token_id": item.token_id,
                "label": item.label,
                "created_at": item.created_at,
                "expires_at": item.expires_at,
                "last_seen": item.last_seen,
            }
            for item in clients
        ]
    }


@router.delete("/blender/clients/{token_id}")
async def revoke_client(token_id: str, user: dict = Depends(get_api_user)) -> dict:
    if not blender_store.revoke_token(_db(), token_id, user_id=user["username"]):
        raise HTTPException(status_code=404, detail="插件不存在或已断开")
    return {"ok": True}


ADDON_DIST_ENV = "DRAMACLAW_BLENDER_ADDON_DIST"
ADDON_URL_ENV = "DRAMACLAW_BLENDER_ADDON_URL"
PUBLIC_BASE_URL_ENV = "DRAMACLAW_PUBLIC_BASE_URL"
ADDON_CONFIG_PATH = "dramaclaw_blender/config.json"
# 发版时每个版本传一份带版本号的（不覆盖，留着回滚），再覆盖这一份 latest。
# 与官方媒体目录同一个 bucket，见 `official_media_catalog_remote.py`。
DEFAULT_ADDON_URL = (
    "https://dramaclaw-dl.oss-cn-chengdu.aliyuncs.com/"
    "blender-addon/dramaclaw_blender-latest.zip"
)
# 真包 30KB 上下。这个上限只防 URL 配错指到一个大文件，把整个文件读进内存。
MAX_ADDON_BYTES = 10 * 1024 * 1024
_ADDON_FETCH_TIMEOUT_SECONDS = 15.0
_ADDON_ZIP_NAME = re.compile(r"dramaclaw_blender-(\d+)\.(\d+)\.(\d+)\.zip")
# 与 `blender/build.py::read_version` 同一条正则：文件名里的版本号就是它读出来的。
_BL_INFO_VERSION = re.compile(r'"version":\s*\((\d+),\s*(\d+),\s*(\d+)\)')
_ADDON_INIT_PATH = "dramaclaw_blender/__init__.py"


def _addon_dist_dir() -> Path:
    """本地插件 zip 所在目录。

    默认按源码树推到仓库根的 `blender/dist/`（editable 与 `src` 布局都成立）。
    这里有包就用这里的——跑过 `blender/build.py` 的开发机下载到的就是刚打的包；
    镜像里没有这个目录，自然走 OSS。环境变量 `DRAMACLAW_BLENDER_ADDON_DIST`
    可覆盖（测试和非源码树部署用）。
    """
    override = os.environ.get(ADDON_DIST_ENV, "").strip()
    if override:
        return Path(override)
    return Path(novelvideo.__file__).resolve().parents[2] / "blender" / "dist"


def _addon_url() -> str:
    return os.environ.get(ADDON_URL_ENV, "").strip() or DEFAULT_ADDON_URL


def _addon_http_client() -> httpx.AsyncClient:
    """单独一层，测试替换成 MockTransport。"""
    return httpx.AsyncClient(
        timeout=_ADDON_FETCH_TIMEOUT_SECONDS, follow_redirects=True
    )


async def _fetch_remote_addon(url: str) -> bytes:
    """从 OSS 取原包。取不到一律 502：错在上游，不在用户，也不在本服务。

    正文不带 URL 和上游状态码，这些进日志——和下面「插件包损坏」同一个理由：
    `HTTPException` 不会被任何 handler 打日志，不在这里记，运维什么都看不到。
    """
    try:
        async with _addon_http_client() as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_ADDON_BYTES:
                        raise ValueError(f"超过 {MAX_ADDON_BYTES} 字节")
                    chunks.append(chunk)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("插件包下载失败：%s（%s）", url, exc)
        raise HTTPException(
            status_code=502, detail="插件包暂时下载不了，请稍后再试"
        ) from exc
    return b"".join(chunks)


def _addon_filename(raw: bytes) -> str:
    """远端包按 bl_info 的版本号命名。

    OSS 上网页指向的是 `-latest.zip`，原样当文件名的话，用户下载目录里一堆 latest，
    分不清装的是哪一版。读不出版本就退回不带版本号的名字，不为这个让下载失败。
    """
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            source = archive.read(_ADDON_INIT_PATH).decode("utf-8")
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError):
        return "dramaclaw_blender.zip"
    match = _BL_INFO_VERSION.search(source)
    if match is None:
        return "dramaclaw_blender.zip"
    return f"dramaclaw_blender-{'.'.join(match.groups())}.zip"


def _pick_addon_zip(dist: Path) -> Path | None:
    """只认 `dramaclaw_blender-<x.y.z>.zip`，多个时按数字版本取最大。

    `blender/build.py` 只清理同版本的旧包，不同版本会并存，所以不能「取第一个」。
    """
    if not dist.is_dir():
        return None
    best: tuple[tuple[int, int, int], Path] | None = None
    for candidate in dist.iterdir():
        match = _ADDON_ZIP_NAME.fullmatch(candidate.name)
        if match is None or not candidate.is_file():
            continue
        version = (int(match[1]), int(match[2]), int(match[3]))
        if best is None or version > best[0]:
            best = (version, candidate)
    return None if best is None else best[1]


def _has_inner_whitespace(value: str) -> bool:
    """两头 strip 过之后还夹着空白——说明这个值本身是坏的，不是格式宽松。"""
    return any(ch.isspace() for ch in value)


def _public_base_url(request: Request) -> str:
    """后端自己的对外地址。

    仓库里没有任何「对外地址」的配置项，也没有用 `request.base_url` 的先例，所以这三级
    是新的。环境变量排第一，是给那些两种转发头都不可靠的部署留的出口。它**必须自带
    scheme**（`https://drama.example.com`）：这里是原样透传，写成 `drama.example.com`
    会被整段抄进 config.json，插件那边 urllib 拼出来的根本不是个能发的地址。末尾多一个
    斜杠没关系，会被去掉。
    """
    override = os.environ.get(PUBLIC_BASE_URL_ENV, "").strip()
    if override:
        return override.rstrip("/")
    # 取**最后**一个值而不是第一个。覆盖式代理（nginx `proxy_set_header
    # X-Forwarded-Host $host;`）本来就只有一个值，两种取法完全一样；追加式的链路里
    # 最后一个是离应用最近的那一跳写的、最可信，第一个则是客户端自己塞进来的。
    # 所以 `[-1]` 不会比 `[0]` 差，追加式下严格更好。
    #
    # 但这一级并**不是可信输入**：uvicorn 的 ProxyHeadersMiddleware 压根不处理
    # x-forwarded-host，也不会把转发头从 scope 里摘掉；再往下兜底的 `request.base_url`
    # 同样来自客户端可控的 Host 头。真正的止损是响应上的 `Cache-Control: no-store`
    # ——伪造出来的地址只会落进伪造者自己下载的那个包。代理保证不了覆盖这两个头的
    # 部署，请直接配 `DRAMACLAW_PUBLIC_BASE_URL`，别指望这里。
    proto = request.headers.get("x-forwarded-proto", "").split(",")[-1].strip()
    host = request.headers.get("x-forwarded-host", "").split(",")[-1].strip()
    # 切完、strip 完还夹着空白（`a.example.com\tevil` 这种），这一级就当没有。
    # CRLF 有 h11 挡着，所以这不是响应头注入，但拼出来是个谁也连不上的地址——
    # 宁可整级作废回落到 base_url，也不要把坏地址写进用户的包里。
    if (
        proto
        and host
        and not _has_inner_whitespace(proto)
        and not _has_inner_whitespace(host)
    ):
        return f"{proto}://{host}".rstrip("/")
    return str(request.base_url).rstrip("/")


def _referer_origin(request: Request) -> str:
    """用户是从哪个页面点的下载。

    默认的 referrer policy 是 `strict-origin-when-cross-origin`：**同源**请求发的是
    完整 URL（连路径带查询串），只有跨源才降级成裸 origin。下载链接恰恰是同源的
    `<a download>` 导航，所以这里通常拿到的是 `https://drama.example.com/projects?x=1`
    这种——下面那步 urlsplit 砍回 origin 不是多余的保险，是必需的一步，不砍就把页面
    路径写进插件配置了。被 referrer policy 整个剥掉时返回空串，调用方回落到后端地址，
    那就是今天的行为，不会更差。

    这个值是客户端可控的，而且它只会被写进**下载者自己**那个包里，影响不了别人。
    但话要说完：那个被写进去的错页面是**攻击者控制**的，用户在插件面板点「连接」时
    会把配对码送过去。链条到此为止——确认配对要的是真站点上的浏览器会话，而仓库里
    没装任何 CORSMiddleware，攻击者的页面发不出那个 POST；配对码本身也换不到令牌，
    `blender_store.consume_pairing` 是按 `pairing_id` 查的，那个 id 只在插件进程里存在。
    所以最坏是一个钓鱼面，不是一次接管。即便如此也绝不拿它做服务端决策。
    """
    referer = request.headers.get("referer", "").strip()
    if not referer:
        return ""
    parsed = urlsplit(referer)
    if not parsed.scheme or not parsed.netloc:
        return ""
    # userinfo 一律拒掉，而不是拿 `parsed.hostname` + `parsed.port` 重拼：重拼会把
    # 主机名小写化、丢掉 IPv6 的方括号，端口写坏时 `parsed.port` 还会直接抛
    # ValueError。Referer 里正常不可能出现 userinfo，出现了就当这个头不可用，让调用
    # 方回落到后端地址。端口要保留，开发环境就是 :5174。
    #
    # 夹空白的 netloc 顺手也挡掉，但别高估这一半：urlsplit 按 WHATWG 会先把 \t\r\n
    # 剥干净（`https://a.com\tevil/p` 到这里已经是 `a.comevil` 了），剩下还能拦的只有
    # 空格、`\x0b`、`\x0c`、NBSP 这类不被剥的空白。而浏览器会把空格百分号编码，所以
    # 这半边在真实客户端路径上基本不可达，纯是第二道锁——主力是上面那个 `@`。
    if "@" in parsed.netloc or _has_inner_whitespace(parsed.netloc):
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _repack_with_config(raw: bytes, config: dict) -> bytes:
    """把原包逐条抄进新包，再多塞一个 config.json。

    包只有 30KB 上下，整包在内存里重打的成本可以忽略。不用「往原 zip 后面追加」
    那种写法——那会改动 dist 里的文件，而它是所有人共享的。

    这里的 `ZIP_DEFLATED` 只管下面新写的那条 config.json：抄进来的条目各走各的
    `item.compress_type`，原样保留。所以哪天 build.py 改成 ZIP_STORED，这里也不会
    顺手替它重压一遍。
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as original:
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as repacked:
            for item in original.infolist():
                # 原包里已经有同名条目就跳过：否则写出两条重名记录（Python 只给个
                # UserWarning），读的人拿到哪一条全看实现。build.py 只打 *.py，今天
                # 走不到这行；但一行的代价远小于将来对着重名记录发懵。
                if item.filename == ADDON_CONFIG_PATH:
                    continue
                repacked.writestr(item, original.read(item.filename))
            repacked.writestr(
                ADDON_CONFIG_PATH,
                json.dumps(config, ensure_ascii=False, indent=2) + "\n",
            )
    return buffer.getvalue()


@router.get("/blender/addon")
async def download_addon(
    request: Request,
    _user: dict = Depends(get_api_user),
) -> Response:
    """项目管理中心「Blender 插件」按钮。给浏览器用，不给插件用。

    下载时把服务器地址和网页地址写进包里，用户装完不用手填。**只写地址，不写令牌**：
    写令牌能做到「装完即已连接」，但那样这个 zip 本身就是一张通行证，谁拿到谁就能
    以下载者的身份往他的项目里传东西。理由详见设计文档第 11 节。
    """
    # 本地有包用本地的（开发机刚打的包），没有就去 OSS 取。故意不做「OSS 取不到再
    # 回落本地」：生产上本地本来就没有，回落只会把 OSS 的故障藏成一个莫名的 404。
    target = _pick_addon_zip(_addon_dist_dir())
    if target is not None:
        raw = await run_in_threadpool(target.read_bytes)
        filename = target.name
    else:
        raw = await _fetch_remote_addon(_addon_url())
        filename = _addon_filename(raw)
    server_url = _public_base_url(request)
    try:
        payload = await run_in_threadpool(
            _repack_with_config,
            raw,
            {
                "server_url": server_url,
                "web_url": _referer_origin(request) or server_url,
            },
        )
    except zipfile.BadZipFile as exc:
        # 不拦就是个裸 500，正文只有「File is not a zip file」，连是哪个文件都不说，
        # 运维拿不到任何线索。而这不是理论情况：`blender/build.py` 直接往最终路径写，
        # 没有临时文件加改名，重新打包的同时来一次下载，真能读到半截包。照本文件里
        # `deliver` 的做法把失败显式映射掉，别让它逃出路由。
        # 正文只报文件名，绝对路径进日志。dist 目录是 ADDON_DIST_ENV 配出来的，
        # 把服务器文件系统布局写进 HTTP 正文没必要；但换成 HTTPException 之后
        # FastAPI 不会再为它打任何日志（app.py 里的 handler 全是业务异常，没有兜底
        # 5xx 日志），不补这行的话，唯一看见「哪个包坏了」的人是点下载的那个用户，
        # 真正要查的运维反而什么都看不到——比原来那个带 traceback 的裸 500 还少。
        logger.warning(
            "插件包损坏，无法重新打包：%s",
            target if target is not None else _addon_url(),
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"插件包损坏，无法重新打包：{filename}"
        ) from exc
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            # 内容现在因人因请求而异，任何中间层都不许留副本。
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = MAX_PROJECT_UPLOAD_BYTES

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _looks_like(kind: str, head: bytes) -> bool:
    """按真实字节判断这是什么。

    `kind` 是插件报上来的，属于不可信输入——限额是按 kind 挑的，报错 kind 就能拿
    视频的额度塞图片。落地之后复核一遍，不一致就当场删掉。
    """
    if kind == "image":
        return head.startswith(_PNG_MAGIC)
    # MP4/MOV 都是 ISO BMFF：前 4 字节是 box 长度，紧接着 'ftyp'。
    return len(head) >= 12 and head[4:8] == b"ftyp"


def _unique_target(target_dir: Path, safe_name: str) -> Path:
    """同名不覆盖。

    文件名里有到秒的时间戳，撞名要同一秒投两次——少见，但覆盖掉用户上一次的渲染
    是不可逆的，代价远大于名字后面多四个字符。
    """
    candidate = target_dir / safe_name
    if not candidate.exists():
        return candidate
    stem, dot, suffix = safe_name.rpartition(".")
    stem = stem or safe_name
    suffix = f"{dot}{suffix}" if dot else ""
    return target_dir / f"{stem}-{secrets.token_hex(2)}{suffix}"


@router.post("/projects/{project}/blender/deliver")
async def deliver(
    project: str,
    file: Annotated[UploadFile, File()],
    kind: Annotated[Literal["image", "video"], Form()],
    camera: Annotated[str, Form()] = "",
    frame: Annotated[int | None, Form()] = None,
    frame_start: Annotated[int | None, Form()] = None,
    frame_end: Annotated[int | None, Form()] = None,
    fps: Annotated[float | None, Form()] = None,
    width: Annotated[int | None, Form()] = None,
    height: Annotated[int | None, Form()] = None,
    client: blender_store.BlenderClient = Depends(get_blender_client),
) -> dict:
    """插件投递一张白模图或一段白模视频。

    文件落进项目的 `freezone/_uploads/`，素材库立刻能看见；收件箱里再记一行，
    供前端调用下面的 `take_inbox`（`POST .../blender/inbox:take`）认领上画布。
    **不碰画布**——画布是带乐观锁的整体替换（`freezone.py:12767` 的 `PUT`），
    从这里写进去必然会跟前端的自动保存打架。
    """
    scope = await resolve_project_scope(
        project, {"username": client.user_id}, required_role="editor"
    )

    target_dir = uploads_dir(scope.project_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    safe_name = sanitize_upload_filename(
        file.filename, fallback="blockout.png" if kind == "image" else "blockout.mp4"
    )
    if not is_safe_upload_target(target_dir, safe_name):
        raise HTTPException(status_code=400, detail="文件名不合法")
    target = _unique_target(target_dir, safe_name)

    max_bytes = MAX_IMAGE_BYTES if kind == "image" else MAX_VIDEO_BYTES
    try:
        size = await run_in_threadpool(
            stream_to_file_with_limit, file.file, target, max_bytes=max_bytes
        )
    except UploadTooLargeError as exc:
        # `stream_to_file_with_limit` 已经把半截文件删了。
        raise HTTPException(status_code=413, detail=str(exc)) from exc

    with target.open("rb") as handle:
        head = handle.read(16)
    if not _looks_like(kind, head):
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文件内容与声明的类型不符")

    relative = target.relative_to(scope.project_dir).as_posix()
    url = make_static_url_for_context(scope.ctx, relative, local_path=target)

    delivery_id = blender_store.record_delivery(
        _db(),
        user_id=client.user_id,
        project_id=scope.project_name,
        url=url,
        kind=kind,
        filename=target.name,
        camera=camera,
        frame=frame,
        frame_start=frame_start,
        frame_end=frame_end,
        fps=fps,
        width=width,
        height=height,
    )

    return {
        "ok": True,
        "delivery_id": delivery_id,
        "url": url,
        "filename": target.name,
        "size": size,
    }


_INBOX_FIELDS = (
    "delivery_id",
    "url",
    "kind",
    "filename",
    "camera",
    "frame",
    "frame_start",
    "frame_end",
    "fps",
    "width",
    "height",
    "created_at",
)


@router.post("/projects/{project}/blender/inbox:take")
async def take_inbox(
    project: str,
    user: dict = Depends(get_api_user),
) -> dict:
    """画布页认领 Blender 投来的素材。**取走即删**。

    浏览器会话认证，不是插件令牌——这是登录的人在页面上做的事。

    收件箱的行本身带 user_id，但项目权限必须**单独**验一次：行是投递那一刻写的，
    这人现在还有没有权限是另一回事。

    冒号动词照 `freezone.py` 里 `canvases:from-preset` 的先例——这不是读资源，
    是个有副作用的动作。
    """
    scope = await resolve_project_scope(project, user, required_role="editor")
    # 没有像 `poll_pairing` 那样挂 `_enforce_rate_limit`：这条路由要浏览器会话，
    # 冒充不了；而 `hit_rate_limit` 自己也是一次 `BEGIN IMMEDIATE` 写事务，加上去
    # 等于让每次轮询多抢一次写锁——这次调用本来就要为 `blender_store.take_inbox`
    # 抢一次写锁了，不该再自己加一次。
    #
    # 丢进线程池，不在事件循环上跑。这个文件里别的 store 调用都是直接同步调的
    # （比如 `start_pairing` 里的 `purge_expired`），但 `take_inbox` 是第一个
    # **既要抢写锁、又高频**的：busy_timeout 是 10 秒，而每个开着画布的标签页
    # 每 5 秒就来一次。真撞上锁，同步调用会把整个事件循环堵住。
    rows = await run_in_threadpool(
        blender_store.take_inbox,
        _db(),
        user_id=user["username"],
        project_id=scope.project_name,
    )
    # 显式挑字段，不 `dict(row)` 整行发出去：表以后加列不该自动泄漏到响应里。
    # 用 `.get` 而不是 `row[key]`：走到这里 take_inbox 的 COMMIT 已经落了，行已经
    # 删掉了。这里抛 KeyError 换来的不是「失败得响亮」，是这批投递永久丢失。
    # schema 漂移时宁可发个 null 出去，也不要把用户的渲染吞掉。这个降级对
    # `url`/`delivery_id` 这种 NOT NULL 列只算半个办法——前端会拿到一个建不出来
    # 的节点。但「建坏一个节点」是看得见、能重来的，「吞掉一次渲染」不是。
    return {"items": [{key: row.get(key) for key in _INBOX_FIELDS} for row in rows]}
