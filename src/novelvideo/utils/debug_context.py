"""通用 AI 调用上下文调试工具。

用于记录 AI 调用的完整上下文，方便调试和排查问题。
"""

import json
import re
from pathlib import Path
from datetime import datetime
from typing import Any, Optional

# 默认调试输出目录
DEBUG_OUTPUT_DIR = Path("/tmp/novelvideo_debug")

# 全局开关
DEBUG_ENABLED = True


class DebugContext:
    """记录 AI 调用的完整上下文，用于调试和排查。

    使用示例:
        debug = create_debug_context("video_prompt_builder")
        debug.add("episode_number", 5)
        debug.add("beat_number", 3)
        debug.add_section("input_params", {...})
        debug.save()
        debug.print_summary()
    """

    def __init__(self, name: str, enabled: bool = True):
        self.name = name
        self.enabled = enabled
        self.data: dict[str, Any] = {}
        self.timestamp = datetime.now().isoformat()
        self.warnings: list[str] = []

    def add(self, key: str, value: Any) -> "DebugContext":
        """添加上下文数据。"""
        if self.enabled:
            self.data[key] = value
        return self

    def add_section(self, section: str, data: dict) -> "DebugContext":
        """添加一个数据段。"""
        if self.enabled:
            self.data[section] = data
        return self

    def add_warning(self, warning: str) -> "DebugContext":
        """添加警告信息。"""
        if self.enabled:
            self.warnings.append(warning)
            print(f"[DebugContext] ⚠️ {warning}")
        return self

    def save(self, filename: Optional[str] = None) -> Optional[Path]:
        """保存上下文到文件。

        Returns:
            保存的文件路径，或 None（如果禁用）
        """
        if not self.enabled:
            return None

        DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        if filename is None:
            # 使用时间戳生成唯一文件名
            ts = self.timestamp.replace(":", "-").replace(".", "-")
            filename = f"{self.name}_{ts}.json"

        output_path = DEBUG_OUTPUT_DIR / filename

        # 同时保存为固定名称（方便快速查看最新的）
        latest_path = DEBUG_OUTPUT_DIR / f"{self.name}_latest.json"

        content = {
            "name": self.name,
            "timestamp": self.timestamp,
            "warnings": self.warnings,
            "data": self.data,
        }

        # 自定义序列化器处理 Path 等类型
        def default_serializer(obj):
            if isinstance(obj, Path):
                return str(obj)
            return str(obj)

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2, default=default_serializer)

            with open(latest_path, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2, default=default_serializer)

            print(f"[DebugContext] {self.name} context saved to: {latest_path}")
            return latest_path
        except Exception as e:
            print(f"[DebugContext] Save failed: {e}")
            return None

    def print_summary(self):
        """打印关键信息摘要。"""
        if not self.enabled:
            return

        print(f"\n=== {self.name} Debug Summary ===")

        # 先打印警告
        if self.warnings:
            print("⚠️ WARNINGS:")
            for w in self.warnings:
                print(f"  - {w}")

        # 打印数据摘要
        for key, value in self.data.items():
            if isinstance(value, dict):
                print(f"{key}:")
                for k, v in value.items():
                    v_str = str(v)[:100] + "..." if len(str(v)) > 100 else str(v)
                    print(f"  {k}: {v_str}")
            else:
                v_str = str(value)[:100] + "..." if len(str(value)) > 100 else str(value)
                print(f"{key}: {v_str}")
        print("=" * 40)


def create_debug_context(name: str) -> DebugContext:
    """创建调试上下文实例。

    Args:
        name: 上下文名称（如 "video_prompt_builder"）

    Returns:
        DebugContext 实例
    """
    return DebugContext(name, enabled=DEBUG_ENABLED)


def extract_episode_from_path(path: str) -> Optional[int]:
    """从路径中提取 episode 号。

    支持的格式:
    - ep001, ep005 等
    - episode_1, episode_5 等

    Args:
        path: 文件路径字符串

    Returns:
        episode 号，或 None（如果无法提取）
    """
    if not path:
        return None

    # 匹配 ep001, ep005 等格式
    match = re.search(r'ep(\d{3})', path)
    if match:
        return int(match.group(1))

    # 匹配 episode_1, episode_5 等格式
    match = re.search(r'episode[_-]?(\d+)', path, re.IGNORECASE)
    if match:
        return int(match.group(1))

    return None


def validate_episode_consistency(
    frame_image_path: str,
    episode_number: int,
    context_name: str = "unknown",
) -> tuple[bool, Optional[str]]:
    """验证图片路径与 episode 号是否一致。

    Args:
        frame_image_path: 图片文件路径
        episode_number: 预期的 episode 号
        context_name: 调用上下文名称（用于日志）

    Returns:
        (is_valid, warning_message) 元组
        - is_valid: 是否一致
        - warning_message: 不一致时的警告信息，一致时为 None
    """
    if not frame_image_path or not episode_number:
        return True, None

    path_episode = extract_episode_from_path(frame_image_path)
    if path_episode is None:
        return True, None  # 无法从路径提取 episode，跳过验证

    if path_episode != episode_number:
        warning = (
            f"EPISODE MISMATCH in {context_name}: "
            f"path contains ep{path_episode:03d} but episode_number={episode_number}"
        )
        return False, warning

    return True, None
