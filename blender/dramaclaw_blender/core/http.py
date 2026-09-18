"""对服务端说话。

只用标准库：Blender 自带的 Python 里没有 `requests`，而往那个解释器里装第三方包
会跟别的插件抢版本、在只读安装目录上失败、在每次升级 Blender 后消失。
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.request
from typing import Any

# 上传要传几十上百 MB，慢是正常的。
TIMEOUT_SECONDS = 600
# 控制面的调用（配对、拉项目列表）跑在主线程上，卡住就是整个 Blender 卡住。
# 它们收发的都是几百字节，十秒还没回来就是真的不通了，没必要陪着等十分钟。
CONTROL_TIMEOUT_SECONDS = 10


class ApiError(Exception):
    """服务端明确拒绝了。`status` 和消息都要原样给用户看。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _header_token(value: str) -> str:
    """把一个字符串弄成能安全放进 `Content-Disposition` 引号里的样子。

    引号会提前闭合参数，CR/LF 会开出新的 header 行甚至新的 part。按 WHATWG 的
    form-data 规则做百分号转义，而不是把字符删掉——删字符会让两个不同的名字撞成
    同一个，转义则是可逆的。

    调用方目前传的都是清洗过的文件名或写死的字段名，唯一的例外是 `camera` 字段发的
    是 `scene.camera.name` 原文。别让这道收口依赖「调用方保证」。
    """
    return (
        value.replace("\r", "%0D").replace("\n", "%0A").replace('"', "%22")
    )


def _field_value(value: str) -> str:
    """字段值里的裸 CR/LF 会让 part 的边界变得可争辩，转义掉。

    `camera` 发的是 `scene.camera.name` 原文，用户想在相机名里放什么都行。
    """
    return str(value).replace("\r", "%0D").replace("\n", "%0A")


def encode_multipart(
    *,
    fields: dict[str, str | None],
    filename: str,
    payload: bytes,
    mime: str,
) -> tuple[bytes, str]:
    """拼一个 multipart/form-data 请求体。

    值为 None 的字段直接不发——图片没有 fps，发一个 "None" 过去，服务端会拿它当
    真值去 parse。
    """
    while True:
        boundary = f"----dramaclaw{secrets.token_hex(16)}"
        if boundary.encode() not in payload:
            break

    chunks: list[bytes] = []
    for name, value in fields.items():
        if value is None:
            continue
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{_header_token(name)}"\r\n\r\n'.encode()
        )
        chunks.append(f"{_field_value(value)}\r\n".encode())

    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        f'Content-Disposition: form-data; name="file";'
        f' filename="{_header_token(filename)}"\r\n'.encode()
    )
    chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
    chunks.append(payload)
    chunks.append(f"\r\n--{boundary}--\r\n".encode())

    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _send(request: urllib.request.Request, *, timeout: float) -> Any:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise ApiError(exc.code, _error_message(exc)) from exc
    except urllib.error.URLError as exc:
        raise ApiError(0, f"连不上服务器：{exc.reason}") from exc
    return json.loads(body.decode("utf-8")) if body else {}


def _error_message(exc: urllib.error.HTTPError) -> str:
    try:
        detail = json.loads(exc.read().decode("utf-8")).get("detail")
    except Exception:
        detail = None
    return str(detail) if detail else f"服务器返回 {exc.code}"


def post_json(
    url: str,
    payload: dict,
    *,
    token: str | None = None,
    timeout: float = CONTROL_TIMEOUT_SECONDS,
) -> Any:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return _send(request, timeout=timeout)


def get_json(
    url: str,
    *,
    token: str | None = None,
    timeout: float = CONTROL_TIMEOUT_SECONDS,
) -> Any:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return _send(request, timeout=timeout)


def post_multipart(
    url: str,
    *,
    fields: dict[str, str | None],
    filename: str,
    payload: bytes,
    mime: str,
    token: str,
    timeout: float = TIMEOUT_SECONDS,
) -> Any:
    body, content_type = encode_multipart(
        fields=fields, filename=filename, payload=payload, mime=mime
    )
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", content_type)
    request.add_header("Authorization", f"Bearer {token}")
    return _send(request, timeout=timeout)
