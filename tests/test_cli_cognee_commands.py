"""锚住:cli.py 中依赖已删除的 filter_characters_simple 的死命令/死分支不再暴露。

背景:EE 侧 d5faed2a 删除 character_filter 模块（filter_characters /
filter_characters_simple）后，cli.py 仍残留两处调用——cognee-filter 命令整体、
cognee-profile 的 --auto-filter 分支——一旦触达即 NameError（ruff F821）。
下列测试锚住"死接口不再暴露给用户"的契约：改前红（仍存在），删除后绿。
"""
from typer.testing import CliRunner

from novelvideo.cli import app

runner = CliRunner()


def test_cognee_filter_command_removed():
    """cognee-filter 每条路径都调用未定义函数，整条命令不应再注册。"""
    result = runner.invoke(app, ["cognee-filter", "--help"])
    assert result.exit_code != 0
    assert "No such command" in result.output


def test_cognee_profile_drops_dead_auto_filter_options():
    """cognee-profile 的 --auto-filter/--dry-run 依赖死分支，应移除；命令本身保留可用。"""
    result = runner.invoke(app, ["cognee-profile", "--help"])
    assert result.exit_code == 0
    assert "--auto-filter" not in result.output
    assert "--dry-run" not in result.output
