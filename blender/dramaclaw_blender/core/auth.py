"""令牌失效后的收尾。

网页上「断开」只吊销服务端的授权，本机令牌还留着；面板只看本机有没有令牌，会一直
画成已连接、没有「连接」按钮。所以任何带令牌的请求吃到 401，就把本机令牌也清掉。

跟 `core/` 下别的模块一样不 import bpy。`prefs` 只要有 `token` 和 `last_error` 两个属性。
"""

from __future__ import annotations

REVOKED_MESSAGE = "授权已失效，请重新连接"


def forget_revoked_token(prefs, status: int) -> bool:
    """`status` 是 401 就清掉本机令牌并留下原因，返回是否清了。

    只认 401：403/404/5xx 都不说明令牌失效，清掉只会逼人白配对一次。
    项目选择不动——重新配对多半还是同一个账号。
    """
    if status != 401:
        return False
    prefs.token = ""
    prefs.last_error = REVOKED_MESSAGE
    return True
