"""令牌在服务端被吊销后，插件要自己回到「未连接」。

网页上点「断开」只吊销服务端的授权，本机令牌还在。面板只看本机有没有令牌，于是
一直画成已连接：没有「连接」按钮，投递一律 401，用户只能去偏好设置里手动断开。
"""

from __future__ import annotations

from types import SimpleNamespace

from dramaclaw_blender.core.auth import REVOKED_MESSAGE, forget_revoked_token


def _prefs():
    return SimpleNamespace(token="tok", last_error="", project="01JA", project_name="demo")


def test_401_clears_the_token_and_says_why():
    prefs = _prefs()

    assert forget_revoked_token(prefs, 401) is True

    assert prefs.token == ""
    assert prefs.last_error == REVOKED_MESSAGE


def test_401_keeps_the_selected_project():
    """重新配对多半还是同一个账号，不必再选一遍项目。"""
    prefs = _prefs()

    forget_revoked_token(prefs, 401)

    assert (prefs.project, prefs.project_name) == ("01JA", "demo")


def test_other_errors_leave_the_token_alone():
    """403/404/413/5xx 都不说明令牌失效，清掉只会逼人白配对一次。"""
    for status in (0, 400, 403, 404, 413, 500, 502):
        prefs = _prefs()

        assert forget_revoked_token(prefs, status) is False

        assert prefs.token == "tok"
        assert prefs.last_error == ""
