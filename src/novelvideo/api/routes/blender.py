"""Blender 插件接口。

这一组路由有三种鉴权，混了会出事，所以写在一个文件里、彼此看得见：

- 配对开始与轮询：**不需要**任何凭证。插件此刻还没有凭证，这是先有鸡还是先有蛋
  的那个蛋。保护靠的是 `pairing_id` 的随机性、5 分钟有效期、只兑一次，和频率限制。
- 配对确认：浏览器会话（`get_api_user`）。授权只能由登录的人做出。
- 其余：插件令牌（`get_blender_client`，见本文件下方）。这是第三类凭证，**只在这个
  文件里生效**——`novelvideo/api/auth.py` 顶上那段注释说得很清楚，长期外部密钥
  不进主鉴权链路。
"""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Annotated, Literal

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from novelvideo import blender_store
from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    list_user_projects,
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.freezone.paths import uploads_dir
from novelvideo.utils.upload_safety import (
    MAX_PROJECT_UPLOAD_BYTES,
    UploadTooLargeError,
    is_safe_upload_target,
    sanitize_upload_filename,
    stream_to_file_with_limit,
)

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
    """插件面板的项目下拉框。范围严格等于配对时那个账号的项目。"""
    return {"projects": list_user_projects(client.user_id)}


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
    供前端认领上画布（二期）。**不碰画布**——画布是带乐观锁的整体替换
    （`freezone.py:12767` 的 `PUT`），从这里写进去必然会跟前端的自动保存打架。
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
