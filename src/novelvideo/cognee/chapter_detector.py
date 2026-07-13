"""自动检测小说章节结构。"""
import re
from dataclasses import dataclass
from typing import List, Optional

from novelvideo.utils.screenplay_quality import extract_screenplay_candidate_lines


@dataclass
class ChapterInfo:
    """章节信息。"""
    number: int           # 章节序号
    title: Optional[str]  # 章节标题（如果有）
    start_line: int       # 起始行号
    end_line: int         # 结束行号
    content: str          # 章节内容
    is_fallback: bool = False  # 是否为“未检测到章节时自动按单章回退”


class ChapterDetector:
    """检测小说章节结构。

    支持多种章节标记格式：
    - 第X章: "第一章", "第10章", "《书名》第1章"
    - 第X集: "第一集", "第10集"
    - Chapter N: "Chapter 1", "Chapter 10"
    - Episode N: "Episode 1"

    使用示例:
        detector = ChapterDetector()
        chapters = detector.detect(novel_text)
        print(f"检测到 {len(chapters)} 个章节")
        for ch in chapters:
            print(f"第{ch.number}章: {len(ch.content)} 字")
    """

    # 支持的章节标题模式（优先级从高到低）
    # 只匹配标题行开头，避免把对白/旁白里的“原著第X章”误切成新章节。
    # 标题编号后面必须是行尾、空白或常见标题分隔符；
    # 空白后接正文句子时再用标题尾部形态排除，避免把“第一集 已经结束。”
    # /“Episode 1 Ends here.” 这类正文句子误切成新章节。
    PATTERNS = [
        r"^(?:#{1,6}\s*)?(?:《[^》\n]{1,40}》\s*)?第\s*([一二三四五六七八九十百千\d]+)\s*章(?=$|[\s:：《（(【\[\-—–、.。．])",
        r"^(?:#{1,6}\s*)?(?:《[^》\n]{1,40}》\s*)?第\s*([一二三四五六七八九十百千\d]+)\s*集(?=$|[\s:：《（(【\[\-—–、.。．])",
        r"^(?:#{1,6}\s*)?Chapter\s*(\d+)(?=$|[\s:：(\[\-—–.。．])",
        r"^(?:#{1,6}\s*)?Episode\s*(\d+)(?=$|[\s:：(\[\-—–.。．])",
    ]

    # 中文数字到阿拉伯数字的映射
    CN_NUM_MAP = {
        "零": 0, "〇": 0,
        "一": 1, "壹": 1,
        "二": 2, "贰": 2, "两": 2,
        "三": 3, "叁": 3,
        "四": 4, "肆": 4,
        "五": 5, "伍": 5,
        "六": 6, "陆": 6,
        "七": 7, "柒": 7,
        "八": 8, "捌": 8,
        "九": 9, "玖": 9,
        "十": 10, "拾": 10,
        "百": 100, "佰": 100,
        "千": 1000, "仟": 1000,
    }

    def detect(self, text: str) -> List[ChapterInfo]:
        """检测章节并返回章节列表。

        Args:
            text: 小说全文

        Returns:
            检测到的章节列表，按章节号排序
        """
        lines = text.split("\n")
        chapters = []
        current_start = None
        current_num = None

        for i, line in enumerate(lines):
            chapter_num = self._match_chapter(line.strip())
            if chapter_num is not None:
                # 保存上一章
                if current_start is not None:
                    chapters.append(ChapterInfo(
                        number=current_num,
                        title=None,
                        start_line=current_start,
                        end_line=i,
                        content="\n".join(lines[current_start:i])
                    ))
                current_start = i
                current_num = chapter_num

        # 保存最后一章
        if current_start is not None:
            chapters.append(ChapterInfo(
                number=current_num,
                title=None,
                start_line=current_start,
                end_line=len(lines),
                content="\n".join(lines[current_start:])
            ))

        if not chapters:
            fallback_content = self._prepare_fallback_content(text or "")
            if fallback_content:
                chapters.append(ChapterInfo(
                    number=1,
                    title="第1章",
                    start_line=0,
                    end_line=len(fallback_content.splitlines()) or len(lines),
                    content=fallback_content,
                    is_fallback=True,
                ))

        return chapters

    def has_chapters(self, text: str, min_chapters: int = 2) -> bool:
        """快速检测文本是否包含章节结构。

        Args:
            text: 小说全文
            min_chapters: 最少章节数（默认2）

        Returns:
            是否包含至少 min_chapters 个章节
        """
        chapters = self.detect(text)
        return len(chapters) >= min_chapters

    def get_chapter_count(self, text: str) -> int:
        """获取章节数量。

        Args:
            text: 小说全文

        Returns:
            章节数量
        """
        return len(self.detect(text))

    def _match_chapter(self, line: str) -> Optional[int]:
        """匹配章节标记，返回章节号。

        Args:
            line: 去除首尾空格后的行文本

        Returns:
            章节号，如果不是章节标记则返回 None
        """
        for pattern in self.PATTERNS:
            match = re.search(pattern, line, re.IGNORECASE)
            if match and self._is_valid_title_tail(line[match.end():]):
                return self._parse_number(match.group(1))
        return None

    def _is_valid_title_tail(self, tail: str) -> bool:
        """Return whether text after the chapter marker still looks like a title."""
        stripped = tail.strip()
        if not stripped:
            return True
        if stripped[0] in ".。．":
            return not self._looks_like_sentence_tail(stripped[1:].strip())
        if stripped[0] in ":：《（(【[-—–、":
            return True
        return not self._looks_like_sentence_tail(stripped)

    def _looks_like_sentence_tail(self, tail: str) -> bool:
        return bool(re.search(r"[。\.…]\s*$", tail))

    def _parse_number(self, s: str) -> int:
        """解析数字（支持中文数字）。

        支持的格式：
        - 阿拉伯数字: "1", "10", "123"
        - 简单中文数字: "一", "二", "十"
        - 复合中文数字: "十一", "二十", "一百零一"

        Args:
            s: 数字字符串

        Returns:
            整数值
        """
        # 阿拉伯数字
        if s.isdigit():
            return int(s)

        # 单个中文数字
        if s in self.CN_NUM_MAP:
            return self.CN_NUM_MAP[s]

        # 复合中文数字
        return self._parse_chinese_number(s)

    def _parse_chinese_number(self, s: str) -> int:
        """解析复合中文数字。

        支持: 十一, 二十, 二十三, 一百, 一百零一, 一百二十三, 一千零一

        Args:
            s: 中文数字字符串

        Returns:
            整数值
        """
        result = 0
        temp = 0  # 当前累积的数字

        i = 0
        while i < len(s):
            char = s[i]

            if char in self.CN_NUM_MAP:
                num = self.CN_NUM_MAP[char]

                if num == 10:  # 十
                    if temp == 0:
                        temp = 1  # "十" 开头表示 10
                    result += temp * 10
                    temp = 0
                elif num == 100:  # 百
                    if temp == 0:
                        temp = 1
                    result += temp * 100
                    temp = 0
                elif num == 1000:  # 千
                    if temp == 0:
                        temp = 1
                    result += temp * 1000
                    temp = 0
                elif num == 0:  # 零
                    # "零" 通常是占位，继续处理下一个字符
                    pass
                else:
                    temp = num

            i += 1

        result += temp
        return result if result > 0 else 1

    def _prepare_fallback_content(self, text: str) -> str:
        """无章节时的单章回退内容。

        对普通小说保持原文；对 B 档剧本优先裁掉梗概/人物小传等前言区，
        让单章回退只保留正文。
        """
        raw = (text or "").strip()
        if not raw:
            return ""
        candidate_lines = extract_screenplay_candidate_lines(text)
        candidate_text = "\n".join(candidate_lines).strip()
        if not candidate_text:
            return raw
        if candidate_text != raw:
            return candidate_text
        return raw
