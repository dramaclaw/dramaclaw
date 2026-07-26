"""工具调用日志模块。

使用 Rich Console 输出美观的工具调用日志，便于调试分析。
支持结构化日志输出和工具调用统计。
"""

import json
import os
from datetime import datetime
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeVar

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

# Rich Console 实例
console = Console()

# 全局 verbose 开关
_VERBOSE = False

# 工具调用统计
_TOOL_STATS: Dict[str, Dict[str, Any]] = {}

# 结构化日志缓冲
_TRACE_LOG: List[Dict[str, Any]] = []

# 日志文件路径（如果设置）
_LOG_FILE_PATH: Optional[Path] = None


def set_verbose(enabled: bool) -> None:
    """设置 verbose 模式。"""
    global _VERBOSE
    _VERBOSE = enabled


def is_verbose() -> bool:
    """检查是否开启 verbose 模式。"""
    return _VERBOSE or os.getenv("NOVELVIDEO_VERBOSE", "0") == "1"


def _format_value(value: Any, max_length: int = 200) -> str:
    """格式化值，截断过长的内容。"""
    text = str(value)
    if len(text) > max_length:
        return text[:max_length] + "..."
    return text


def _log_tool_call(
    tool_name: str,
    args: tuple,
    kwargs: dict,
    result: Any = None,
    error: Exception = None,
    duration_ms: float = 0,
) -> None:
    """打印工具调用日志并记录结构化数据。"""
    timestamp = datetime.now()
    success = error is None

    # 始终更新统计（无论 verbose 是否开启）
    _update_stats(tool_name, duration_ms, success)

    # 记录结构化日志
    trace = {
        "timestamp": timestamp.isoformat(),
        "tool": tool_name,
        "args": [_format_value(a, 500) for a in args] if args else [],
        "kwargs": {k: _format_value(v, 500) for k, v in kwargs.items()} if kwargs else {},
        "duration_ms": duration_ms,
        "success": success,
        "result_preview": _format_value(result, 200) if result else None,
        "error": str(error) if error else None,
    }
    _record_trace(trace)

    # 如果没有开启 verbose，不打印到控制台
    if not is_verbose():
        return

    timestamp_str = timestamp.strftime("%H:%M:%S")

    # 构建输入参数显示
    inputs = []
    if args:
        inputs.extend(_format_value(a) for a in args)
    if kwargs:
        inputs.extend(f"{k}={_format_value(v)}" for k, v in kwargs.items())
    input_str = ", ".join(inputs) if inputs else "()"

    # 输出颜色
    if error:
        color = "red"
        status = "FAIL"
    else:
        color = "green"
        status = "OK"

    # 打印工具调用头
    header = Text()
    header.append(f"[{timestamp_str}] ", style="dim")
    header.append(f"{tool_name}", style=f"bold {color}")
    header.append(f"({input_str})", style="dim")
    header.append(f" [{duration_ms:.0f}ms]", style="dim italic")

    console.print(header)

    # 打印结果或错误
    if error:
        console.print(f"    [red]Error: {error}[/red]")
    elif result is not None:
        result_str = _format_value(result, max_length=300)
        # 多行结果缩进显示
        lines = result_str.split("\n")
        if len(lines) > 1:
            console.print(f"    [dim]Output:[/dim]")
            for line in lines[:5]:  # 最多显示5行
                console.print(f"      {line}")
            if len(lines) > 5:
                console.print(f"      [dim]... ({len(lines) - 5} more lines)[/dim]")
        else:
            console.print(f"    [dim]Output:[/dim] {result_str}")


F = TypeVar("F", bound=Callable)


def tool_logger(tool_name: str = None) -> Callable[[F], F]:
    """工具日志装饰器。

    用法:
        @tool_logger("search_chapter")
        async def tool_search_chapter(chapter: int) -> str:
            ...

    或者不带参数（自动使用函数名）:
        @tool_logger()
        def tool_get_character(name: str) -> str:
            ...
    """
    def decorator(func: F) -> F:
        name = tool_name or func.__name__

        # 判断是否是异步函数
        if hasattr(func, "__wrapped__"):
            # 已经被包装过
            is_async = hasattr(func.__wrapped__, "__await__")
        else:
            import asyncio
            is_async = asyncio.iscoroutinefunction(func)

        if is_async:
            @wraps(func)
            async def async_wrapper(*args, **kwargs):
                start = datetime.now()
                try:
                    result = await func(*args, **kwargs)
                    duration = (datetime.now() - start).total_seconds() * 1000
                    _log_tool_call(name, args, kwargs, result=result, duration_ms=duration)
                    return result
                except Exception as e:
                    duration = (datetime.now() - start).total_seconds() * 1000
                    _log_tool_call(name, args, kwargs, error=e, duration_ms=duration)
                    raise
            return async_wrapper  # type: ignore
        else:
            @wraps(func)
            def sync_wrapper(*args, **kwargs):
                start = datetime.now()
                try:
                    result = func(*args, **kwargs)
                    duration = (datetime.now() - start).total_seconds() * 1000
                    _log_tool_call(name, args, kwargs, result=result, duration_ms=duration)
                    return result
                except Exception as e:
                    duration = (datetime.now() - start).total_seconds() * 1000
                    _log_tool_call(name, args, kwargs, error=e, duration_ms=duration)
                    raise
            return sync_wrapper  # type: ignore

    return decorator


def log_agent_start(agent_name: str, task: str = "") -> None:
    """打印 Agent 开始执行日志。"""
    if not is_verbose():
        return

    console.print()
    console.print(Panel(
        f"[bold blue]{agent_name}[/bold blue]\n[dim]{task[:100]}...[/dim]" if task else f"[bold blue]{agent_name}[/bold blue]",
        title="Agent Start",
        border_style="blue",
    ))


def log_agent_end(agent_name: str, success: bool = True, result: str = "") -> None:
    """打印 Agent 执行结束日志。"""
    if not is_verbose():
        return

    color = "green" if success else "red"
    status = "Success" if success else "Failed"

    content = f"[bold {color}]{agent_name}[/bold {color}] - {status}"
    if result:
        content += f"\n[dim]{_format_value(result, 200)}[/dim]"

    console.print(Panel(
        content,
        title="Agent End",
        border_style=color,
    ))
    console.print()


def log_warning(message: str) -> None:
    """打印警告日志。"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    header = Text()
    header.append(f"[{timestamp}] ", style="dim")
    header.append("⚠ WARNING ", style="bold yellow")
    header.append(f"{message}", style="yellow")
    console.print(header)


def log_llm_call(model: str, prompt_preview: str = "", tokens: int = 0) -> None:
    """打印 LLM 调用日志。"""
    if not is_verbose():
        return

    timestamp = datetime.now().strftime("%H:%M:%S")
    header = Text()
    header.append(f"[{timestamp}] ", style="dim")
    header.append("LLM ", style="bold magenta")
    header.append(f"{model}", style="magenta")
    if tokens:
        header.append(f" [{tokens} tokens]", style="dim")

    console.print(header)
    if prompt_preview:
        preview = _format_value(prompt_preview, 150)
        console.print(f"    [dim]Prompt:[/dim] {preview}")


# =============================================================================
# 结构化日志和统计功能
# =============================================================================


def set_log_file(path: str) -> None:
    """设置日志文件路径。

    Args:
        path: 日志文件路径
    """
    global _LOG_FILE_PATH
    _LOG_FILE_PATH = Path(path)
    _LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)


def _record_trace(trace: Dict[str, Any]) -> None:
    """记录结构化日志。"""
    global _TRACE_LOG
    _TRACE_LOG.append(trace)

    # 如果设置了日志文件，追加写入
    if _LOG_FILE_PATH:
        try:
            with open(_LOG_FILE_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(trace, ensure_ascii=False, default=str) + "\n")
        except Exception:
            pass  # 静默失败


def _update_stats(tool_name: str, duration_ms: float, success: bool) -> None:
    """更新工具调用统计。"""
    global _TOOL_STATS

    if tool_name not in _TOOL_STATS:
        _TOOL_STATS[tool_name] = {
            "call_count": 0,
            "success_count": 0,
            "error_count": 0,
            "total_duration_ms": 0,
            "min_duration_ms": float("inf"),
            "max_duration_ms": 0,
        }

    stats = _TOOL_STATS[tool_name]
    stats["call_count"] += 1
    stats["total_duration_ms"] += duration_ms

    if success:
        stats["success_count"] += 1
    else:
        stats["error_count"] += 1

    if duration_ms < stats["min_duration_ms"]:
        stats["min_duration_ms"] = duration_ms
    if duration_ms > stats["max_duration_ms"]:
        stats["max_duration_ms"] = duration_ms


def get_tool_stats() -> Dict[str, Dict[str, Any]]:
    """获取工具调用统计。

    Returns:
        各工具的统计信息
    """
    result = {}
    for tool_name, stats in _TOOL_STATS.items():
        result[tool_name] = {
            **stats,
            "avg_duration_ms": (
                stats["total_duration_ms"] / stats["call_count"]
                if stats["call_count"] > 0
                else 0
            ),
        }
    return result


def get_trace_log() -> List[Dict[str, Any]]:
    """获取结构化日志。

    Returns:
        日志条目列表
    """
    return _TRACE_LOG.copy()


def clear_stats() -> None:
    """清空统计和日志。"""
    global _TOOL_STATS, _TRACE_LOG
    _TOOL_STATS = {}
    _TRACE_LOG = []


def print_tool_stats() -> None:
    """打印工具调用统计摘要。"""
    stats = get_tool_stats()
    if not stats:
        console.print("[dim]No tool call statistics yet[/dim]")
        return

    console.print("\n[bold]Tool Call Statistics[/bold]")
    console.print("-" * 70)

    # 按调用次数排序
    sorted_stats = sorted(stats.items(), key=lambda x: -x[1]["call_count"])

    for tool_name, s in sorted_stats:
        success_rate = (
            s["success_count"] / s["call_count"] * 100 if s["call_count"] > 0 else 0
        )
        console.print(
            f"  {tool_name:30} "
            f"calls: {s['call_count']:3}  "
            f"success: {success_rate:5.1f}%  "
            f"avg: {s['avg_duration_ms']:7.1f}ms"
        )

    console.print("-" * 70)


def export_trace_log(path: str) -> None:
    """导出完整日志到 JSON 文件。

    Args:
        path: 输出文件路径
    """
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    export_data = {
        "exported_at": datetime.now().isoformat(),
        "stats": get_tool_stats(),
        "traces": _TRACE_LOG,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(export_data, f, ensure_ascii=False, indent=2, default=str)

    console.print(f"[green]Logs exported to: {path}[/green]")
