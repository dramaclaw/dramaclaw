"""事件提取器：从章节中提取独立事件/场景。

用于 AI 规划模式，支持将章节拆分为更细粒度的事件，
从而实现 10章→20集 的灵活映射。
"""

from typing import List, Optional

from pydantic import BaseModel, Field
from rich.console import Console

from .pipeline import NovelEvent

console = Console()


class ExtractedEvent(BaseModel):
    description: str = Field(description="事件描述（20字以内）")
    location: str = Field(default="", description="地点")
    time_marker: str = Field(default="", description="时间标记")
    characters: list[str] = Field(default_factory=list, description="参与角色")
    start_text: str = Field(default="", description="事件开始的前20个字")
    end_text: str = Field(default="", description="事件结束的后20个字")
    causes: list[str] = Field(default_factory=list, description="前置事件的description")


class ExtractedEventList(BaseModel):
    events: list[ExtractedEvent] = Field(default_factory=list)


class EventExtractor:
    """从章节中提取事件。

    每个事件是一个完整的叙事单位：
    - 一次对话
    - 一个场景
    - 一个动作序列

    划分原则：
    1. 地点或时间变化通常意味着新事件
    2. 保持因果关系连贯
    3. 标注 Freytag 叙事结构角色
    """

    def __init__(self):
        pass

    async def extract_events(
        self,
        chapter_num: int,
        chapter_content: str,
        on_log: Optional[callable] = None,
    ) -> List[NovelEvent]:
        """提取章节中的事件。

        Args:
            chapter_num: 章节编号
            chapter_content: 章节内容
            on_log: 日志回调函数

        Returns:
            事件列表
        """
        from pydantic_ai import Agent
        from novelvideo.config import (
            get_newapi_structured_output_model_settings,
            get_pydantic_model,
        )

        def log(msg: str):
            if on_log:
                on_log(msg)
            console.print(f"[dim]{msg}[/dim]")

        log(f"开始提取第 {chapter_num} 章事件...")

        # 如果章节内容过长，截取
        truncated = chapter_content[:12000] if len(chapter_content) > 12000 else chapter_content
        if len(chapter_content) > 12000:
            log(f"章节内容过长 ({len(chapter_content)} 字)，已截取前 12000 字")

        prompt = f"""分析以下章节内容，识别其中的独立事件/场景。

章节内容：
{truncated}

事件划分原则：
1. 每个事件是一个完整的叙事单位（一次对话、一个场景、一个动作序列）
2. 地点或时间变化通常意味着新事件
3. 保持因果关系连贯
4. 标注 Freytag 叙事结构角色：
   - exposition: 开场/背景介绍
   - rising_action: 情节上升/冲突发展
   - climax: 高潮
   - falling_action: 情节下降/结果展开
   - resolution: 结局/收尾
   - narrative: 普通叙事（默认）
5. 每章通常有 3-8 个事件"""

        try:
            agent = Agent(
                get_pydantic_model(),
                model_settings=get_newapi_structured_output_model_settings(),
                output_type=ExtractedEventList,
            )
            ai_result = await agent.run(prompt)

            events_data = ai_result.output.events
            log(f"LLM 返回 {len(events_data)} 个事件")

        except Exception as e:
            log(f"事件提取失败: {e}")
            # 回退：整个章节作为一个事件
            return [
                NovelEvent(
                    event_id=f"ch{chapter_num}_e1",
                    chapter_num=chapter_num,
                    description=f"第{chapter_num}章内容",
                    content=chapter_content,
                    text_start=0,
                    text_end=len(chapter_content),
                )
            ]

        # 解析事件并定位原文位置
        events = []
        for i, e in enumerate(events_data):
            # 在原文中定位事件边界
            start_text = e.start_text
            end_text = e.end_text

            start_pos = chapter_content.find(start_text) if start_text else -1
            end_pos = chapter_content.find(end_text) if end_text else -1

            if end_pos > 0:
                end_pos += len(end_text)

            # 如果定位失败，使用默认值
            if start_pos < 0:
                start_pos = 0
            if end_pos <= start_pos:
                end_pos = len(chapter_content)

            # 提取事件原文
            event_content = chapter_content[start_pos:end_pos]

            event = NovelEvent(
                event_id=f"ch{chapter_num}_e{i+1}",
                chapter_num=chapter_num,
                description=e.description,
                location=e.location,
                time_marker=e.time_marker,
                characters=e.characters,
                text_start=start_pos,
                text_end=end_pos,
                content=event_content,
                causes=e.causes,
            )
            events.append(event)

        log(f"第 {chapter_num} 章提取完成: {len(events)} 个事件")
        return events

    async def extract_all_chapters(
        self,
        chapters: List[dict],  # [{"number": 1, "content": "..."}]
        on_progress: Optional[callable] = None,
        on_log: Optional[callable] = None,
    ) -> List[NovelEvent]:
        """批量提取所有章节的事件。

        Args:
            chapters: 章节列表，每个元素包含 number 和 content
            on_progress: 进度回调 (progress: float, task: str)
            on_log: 日志回调

        Returns:
            所有事件列表
        """
        all_events = []
        total = len(chapters)

        for i, chapter in enumerate(chapters):
            if on_progress:
                progress = i / total
                on_progress(progress, f"提取第 {chapter['number']} 章事件...")

            events = await self.extract_events(
                chapter_num=chapter["number"],
                chapter_content=chapter["content"],
                on_log=on_log,
            )
            all_events.extend(events)

        if on_progress:
            on_progress(1.0, f"事件提取完成，共 {len(all_events)} 个事件")

        return all_events
