"""Blender 插件接口。

这一组路由有三种鉴权，混了会出事，所以写在一个文件里、彼此看得见：

- 配对开始与轮询：**不需要**任何凭证。插件此刻还没有凭证，这是先有鸡还是先有蛋
  的那个蛋。保护靠的是 `pairing_id` 的随机性、5 分钟有效期、只兑一次，和频率限制。
- 配对确认：浏览器会话（`get_api_user`）。授权只能由登录的人做出。
- 其余：插件令牌（`get_blender_client`，见 Task 8）。这是第三类凭证，**只在这个
  文件里生效**——`novelvideo/api/auth.py` 顶上那段注释说得很清楚，长期外部密钥
  不进主鉴权链路。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from novelvideo import blender_store
from novelvideo.api.auth import get_api_user

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
