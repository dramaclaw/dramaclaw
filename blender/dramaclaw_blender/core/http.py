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

TIMEOUT_SECONDS = 600


class ApiError(Exception):
    """服务端明确拒绝了。`status` 和消息都要原样给用户看。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


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
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(f"{value}\r\n".encode())

    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    )
    chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
    chunks.append(payload)
    chunks.append(f"\r\n--{boundary}--\r\n".encode())

    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _send(request: urllib.request.Request) -> Any:
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
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


def post_json(url: str, payload: dict, *, token: str | None = None) -> Any:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return _send(request)


def get_json(url: str, *, token: str | None = None) -> Any:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return _send(request)


def post_multipart(
    url: str,
    *,
    fields: dict[str, str | None],
    filename: str,
    payload: bytes,
    mime: str,
    token: str,
) -> Any:
    body, content_type = encode_multipart(
        fields=fields, filename=filename, payload=payload, mime=mime
    )
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", content_type)
    request.add_header("Authorization", f"Bearer {token}")
    return _send(request)
