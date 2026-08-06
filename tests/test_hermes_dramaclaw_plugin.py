from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


def _load_plugin_module():
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: value
    registry_module.tool_result = lambda value: value
    sys.modules.setdefault("tools", tools_module)
    sys.modules.setdefault("tools.registry", registry_module)

    path = Path(__file__).resolve().parents[1] / ".hermes" / "plugins" / "dramaclaw" / "__init__.py"
    spec = importlib.util.spec_from_file_location("test_dramaclaw_plugin", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_dramaclaw_plugin_adds_chat_error_without_replacing_task_error():
    plugin = _load_plugin_module()
    raw_error = "Content filter triggered. Finish reason: 'content_filter'"

    result = plugin._with_chat_error_hints(
        {
            "ok": True,
            "data": [
                {
                    "status": "failed",
                    "error": raw_error,
                    "metadata": {"provider_response_id": "resp_123"},
                }
            ],
        }
    )

    task = result["data"][0]
    assert task["error"] == raw_error
    assert task["chat_error"] == plugin.TEXT_CONTENT_FILTER_CHAT_ERROR
    assert "Do not quote the raw provider JSON" in task["agent_instruction"]


def test_dramaclaw_plugin_adds_voice_prereq_chat_error():
    plugin = _load_plugin_module()
    raw_error = "Beat 03 解说声线缺失：项目解说人声线未配置，请上传或录制解说人音频"

    result = plugin._with_chat_error_hints(
        {
            "status_code": 200,
            "ok": False,
            "code": "voice_prereq_required",
            "error": raw_error,
        }
    )

    assert result["error"] == raw_error
    assert "配音任务没有成功启动" in result["chat_error"]
    assert "虾塘" in result["chat_error"]
    assert raw_error in result["chat_error"]
    assert "Do not start another tool" in result["agent_instruction"]


def test_dramaclaw_plugin_adds_render_prereq_chat_error():
    plugin = _load_plugin_module()
    raw_error = (
        "Render 重生未生成可用图片（mode=1x1_2-3, beats=[1, 2, 3]）："
        "Render 模式需要草图但未找到覆盖 beat 1-1 的草图"
    )

    result = plugin._with_chat_error_hints(
        {
            "ok": True,
            "data": [
                {
                    "status": "failed",
                    "error": raw_error,
                }
            ],
        }
    )

    task = result["data"][0]
    assert task["error"] == raw_error
    assert "Render 任务没有生成可用图片" in task["chat_error"]
    assert "虾塘" in task["chat_error"]
    assert raw_error in task["chat_error"]
    assert "Do not start another tool" in task["agent_instruction"]
