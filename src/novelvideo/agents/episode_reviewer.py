"""分集规划质量审核 Agent。

使用 LLM 评估分集规划的叙事质量、节奏控制、人物弧线等。
同时保留规则检查作为基础验证。
"""

from enum import Enum
from typing import Callable, Optional, Union

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import get_pydantic_model


# =============================================================================
# 数据模型
# =============================================================================


class EpisodePlanIssueType(str, Enum):
    """分集规划问题类型。

    注：以下检查项已前置到 Pydantic 模型验证层（EpisodePlan 生成阶段自动校验）：
    - missing_title → Field(min_length=2)
    - missing_summary → Field(min_length=10)
    - missing_cliffhanger → Field(min_length=5)
    - empty_key_events → Field(min_length=1)
    - empty_characters → Field(min_length=1)
    """

    # 章节问题 (critical)
    CHAPTER_GAP = "chapter_gap"
    CHAPTER_OVERLAP = "chapter_overlap"
    CHAPTER_OUT_OF_RANGE = "chapter_out_of_range"

    # 角色问题 (warning)
    INVALID_CHARACTER = "invalid_character"

    # 叙事问题 (LLM 评估)
    NARRATIVE_DISCONTINUITY = "narrative_discontinuity"
    PACING_ISSUE = "pacing_issue"
    CHARACTER_ARC_BROKEN = "character_arc_broken"
    WEAK_CLIFFHANGER = "weak_cliffhanger"
    POOR_TITLE = "poor_title"


class EpisodePlanIssue(BaseModel):
    """分集规划问题。"""

    issue_type: EpisodePlanIssueType
    severity: str = Field(
        default="warning",
        description="问题严重程度: critical/warning/info",
    )
    episode_number: Optional[Union[int, list[int]]] = Field(
        default=None,
        description="相关集数（单个整数或整数列表）",
    )
    message: str = Field(description="问题描述")
    suggestion: str = Field(default="", description="修复建议")


class EpisodePlanReport(BaseModel):
    """分集规划质量报告。"""

    score: float = Field(ge=0, le=10, description="质量得分 0-10")
    issues: list[EpisodePlanIssue] = Field(default_factory=list)
    summary: str = Field(default="", description="总结")

    # 统计信息
    total_episodes: int = Field(default=0)
    chapter_coverage: str = Field(default="")
    covered_chapters: int = Field(default=0)
    missing_chapters: list[int] = Field(default_factory=list)

    # LLM 评估维度得分 - 新增
    narrative_score: float = Field(default=0.0, description="叙事连贯性得分 0-10")
    pacing_score: float = Field(default=0.0, description="节奏控制得分 0-10")
    character_arc_score: float = Field(default=0.0, description="人物弧线得分 0-10")
    cliffhanger_score: float = Field(default=0.0, description="悬念设置得分 0-10")

    @property
    def passed(self) -> bool:
        """是否通过质量检查。

        通过条件：
        1. 无 critical 问题（必须全部修复）
        2. 分数 >= 8.0（整体质量达标）

        info 问题不影响通过判定。
        """
        has_critical = any(i.severity == "critical" for i in self.issues)
        return self.score >= 8.0 and not has_critical

    @property
    def critical_issues(self) -> list[EpisodePlanIssue]:
        """获取严重问题。"""
        return [i for i in self.issues if i.severity == "critical"]

    @property
    def warnings(self) -> list[EpisodePlanIssue]:
        """获取警告。"""
        return [i for i in self.issues if i.severity == "warning"]


# =============================================================================
# LLM Agent Prompt
# =============================================================================


EPISODE_REVIEWER_PROMPT = """# 你是专业的短视频分集规划审核员

## 评估维度（按权重排序）

| 维度 | 权重 | 说明 |
|------|------|------|
| 叙事连贯性 | 30% | 故事线是否流畅？情节转折是否合理？ |
| 节奏控制 | 25% | 每集是否张弛有度？高潮位置是否恰当？ |
| 人物弧线 | 20% | 角色发展是否连贯？动机是否清晰？ |
| 悬念设置 | 15% | 结尾悬念是否吸引人？能否留住观众？ |
| 格式规范 | 10% | 章节范围是否连续？角色名是否有效？ |

## 工具使用

在审核过程中，你可以调用以下工具获取更多上下文：

| 工具 | 用途 |
|------|------|
| `get_character_evolution(name)` | 查询角色在小说中的发展变化 |
| `get_chapter_content(start, end)` | 获取指定章节的内容摘要 |
| `get_novel_themes()` | 获取小说的主题和核心冲突 |
| `check_plot_continuity(ep1, ep2)` | 检查两集之间的情节连贯性 |

## 审核检查清单

### 1. 叙事连贯性检查
- [ ] 各集之间情节是否自然过渡？
- [ ] 是否有情节跳跃或断裂？
- [ ] 因果关系是否清晰？

### 2. 节奏控制检查
- [ ] 每集是否有起承转合？
- [ ] 高潮/冲突是否分布合理？
- [ ] 是否有连续多集平淡无高潮？

### 3. 人物弧线检查
- [ ] 主要角色是否有发展变化？
- [ ] 角色动机是否清晰一致？
- [ ] 角色出场是否符合剧情需要？

### 4. 悬念设置检查
- [ ] 每集结尾是否留有悬念？
- [ ] 悬念是否足够吸引人？
- [ ] 悬念是否在后续集中得到回应？

### 5. 格式规范检查
- [ ] 章节范围是否连续无间隔？
- [ ] 角色名是否使用已分析的有效名称？
- [ ] 标题是否具有吸引力？

## 评分标准

| 分数 | 等级 | 说明 |
|------|------|------|
| 9-10 | 优秀 | 叙事流畅，节奏紧凑，悬念设置巧妙 |
| 8-8.9 | 良好 | 整体不错，有少量可优化之处 |
| 7-7.9 | 合格 | 基本可用，但有明显问题需修复 |
| 6-6.9 | 及格 | 问题较多，需要较大修改 |
| <6 | 不合格 | 存在严重问题，需要重新规划 |

## 问题严重程度

- **critical**: 必须修复，否则无法使用（如章节间隔、角色无法出场）
- **warning**: 应该修复，影响质量（如叙事断裂、节奏问题）
- **info**: 建议优化（如标题可更吸引人）

## 输出要求

请输出 EpisodePlanReport，包含：
1. score: 综合得分 (0-10)
2. issues: 发现的问题列表
3. summary: 审核总结
4. 各维度得分: narrative_score, pacing_score, character_arc_score, cliffhanger_score

**重要**: 在给出问题和建议时，请确保：
1. 调用工具验证你的判断
2. 给出具体的集数和内容
3. 提供可操作的修复建议
"""


# =============================================================================
# LLM Agent 创建
# =============================================================================


def create_episode_reviewer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """创建分集规划审核 Agent。

    Args:
        tools: 审核工具函数列表

    Returns:
        配置好的 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=EPISODE_REVIEWER_PROMPT,
        output_type=EpisodePlanReport,
        tools=tools or [],
        name="分集规划审核员",
    )


# =============================================================================
# 规则检查器（保留，用于基础验证）
# =============================================================================


class EpisodePlanReviewer:
    """分集规划规则检查器。

    提供基础的规则验证，作为 LLM 审核的补充。
    主要检查：章节连续性、角色名有效性、结构完整性。
    """

    WEIGHTS = {
        "chapter_continuity": 0.35,
        "chapter_coverage": 0.25,
        "character_validity": 0.20,
        "structure": 0.20,
    }

    def review(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
        total_chapters: int,
    ) -> EpisodePlanReport:
        """规则审核分集规划。

        Args:
            plan: 待审核的分集规划
            available_characters: 已分析的角色名集合
            total_chapters: 小说总章节数

        Returns:
            EpisodePlanReport
        """
        issues: list[EpisodePlanIssue] = []
        scores: dict[str, float] = {}

        # 1. 检查章节连续性
        cont_score, cont_issues, coverage_info = self._check_chapter_continuity(
            plan, total_chapters
        )
        scores["chapter_continuity"] = cont_score
        issues.extend(cont_issues)

        # 2. 检查章节覆盖完整性
        cov_score, cov_issues = self._check_chapter_coverage(
            plan, total_chapters, coverage_info
        )
        scores["chapter_coverage"] = cov_score
        issues.extend(cov_issues)

        # 3. 检查角色名一致性
        char_score, char_issues = self._check_character_names(plan, available_characters)
        scores["character_validity"] = char_score
        issues.extend(char_issues)

        # 4. 检查结构完整性
        struct_score, struct_issues = self._check_structure(plan)
        scores["structure"] = struct_score
        issues.extend(struct_issues)

        # 计算加权得分
        final_score = sum(scores[k] * self.WEIGHTS[k] for k in self.WEIGHTS)

        # 生成章节覆盖描述
        chapter_coverage_str = self._format_chapter_coverage(coverage_info, total_chapters)

        # 生成总结
        summary = self._generate_summary(scores, issues)

        return EpisodePlanReport(
            score=round(final_score, 1),
            issues=issues,
            summary=summary,
            total_episodes=len(plan.episodes),
            chapter_coverage=chapter_coverage_str,
            covered_chapters=coverage_info.get("covered_count", 0),
            missing_chapters=coverage_info.get("missing", []),
        )

    def _check_chapter_continuity(
        self,
        plan: "SeriesPlan",
        total_chapters: int,
    ) -> tuple[float, list[EpisodePlanIssue], dict]:
        """检查章节连续性。"""
        issues = []
        coverage_info: dict = {"covered": set(), "missing": [], "covered_count": 0}

        if not plan.episodes:
            return 0, [
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                    severity="critical",
                    message="分集规划为空",
                    suggestion="需要生成分集规划",
                )
            ], coverage_info

        sorted_episodes = sorted(plan.episodes, key=lambda e: e.chapter_start)
        penalty = 0.0

        for i, ep in enumerate(sorted_episodes):
            for ch in range(ep.chapter_start, ep.chapter_end + 1):
                coverage_info["covered"].add(ch)

            if ep.chapter_start > ep.chapter_end:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"第 {ep.number} 集章节范围无效: {ep.chapter_start}-{ep.chapter_end}",
                        suggestion="chapter_start 应该 <= chapter_end",
                    )
                )
                penalty += 2.0

            if ep.chapter_end > total_chapters:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_OUT_OF_RANGE,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"第 {ep.number} 集结束章节 {ep.chapter_end} 超出总章节数 {total_chapters}",
                        suggestion=f"调整章节范围不超过 {total_chapters}",
                    )
                )
                penalty += 1.5

            if ep.chapter_start < 1:
                issues.append(
                    EpisodePlanIssue(
                        issue_type=EpisodePlanIssueType.CHAPTER_OUT_OF_RANGE,
                        severity="critical",
                        episode_number=ep.number,
                        message=f"第 {ep.number} 集起始章节 {ep.chapter_start} 小于 1",
                        suggestion="章节编号从 1 开始",
                    )
                )
                penalty += 1.5

            if i < len(sorted_episodes) - 1:
                next_ep = sorted_episodes[i + 1]

                if next_ep.chapter_start > ep.chapter_end + 1:
                    gap_start = ep.chapter_end + 1
                    gap_end = next_ep.chapter_start - 1
                    issues.append(
                        EpisodePlanIssue(
                            issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                            severity="critical",
                            episode_number=ep.number,
                            message=f"第 {ep.number} 集和第 {next_ep.number} 集之间缺少第 {gap_start}-{gap_end} 章",
                            suggestion=f"扩展相邻剧集的章节范围",
                        )
                    )
                    penalty += 2.0

                if next_ep.chapter_start <= ep.chapter_end:
                    issues.append(
                        EpisodePlanIssue(
                            issue_type=EpisodePlanIssueType.CHAPTER_OVERLAP,
                            severity="critical",
                            episode_number=ep.number,
                            message=f"第 {ep.number} 集和第 {next_ep.number} 集章节重叠",
                            suggestion="调整章节边界，避免重叠",
                        )
                    )
                    penalty += 2.0

        coverage_info["covered_count"] = len(coverage_info["covered"])
        all_chapters = set(range(1, total_chapters + 1))
        coverage_info["missing"] = sorted(all_chapters - coverage_info["covered"])

        score = max(0, 10 - penalty)
        return score, issues, coverage_info

    def _check_chapter_coverage(
        self,
        plan: "SeriesPlan",
        total_chapters: int,
        coverage_info: dict,
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """检查章节覆盖完整性。"""
        issues = []

        covered = coverage_info.get("covered_count", 0)
        missing = coverage_info.get("missing", [])

        if total_chapters <= 0:
            return 10.0, []

        coverage_ratio = covered / total_chapters

        if missing:
            missing_ranges = self._ranges_to_str(missing)
            severity = "critical" if len(missing) > 5 else "warning"
            issues.append(
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.CHAPTER_GAP,
                    severity=severity,
                    message=f"缺少 {len(missing)} 章内容: {missing_ranges}",
                    suggestion="扩展相邻剧集的章节范围以覆盖缺失章节",
                )
            )

        score = coverage_ratio * 10
        return score, issues

    def _check_character_names(
        self,
        plan: "SeriesPlan",
        available_characters: set[str],
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """检查角色名一致性。"""
        issues = []

        if not available_characters:
            return 10.0, []

        all_plan_chars: set[str] = set()
        char_to_episodes: dict[str, list[int]] = {}

        for ep in plan.episodes:
            for char in ep.characters:
                all_plan_chars.add(char)
                if char not in char_to_episodes:
                    char_to_episodes[char] = []
                char_to_episodes[char].append(ep.number)

        invalid_chars = all_plan_chars - available_characters
        valid_count = len(all_plan_chars) - len(invalid_chars)

        for char in invalid_chars:
            episodes_str = ", ".join(str(e) for e in char_to_episodes[char][:3])
            if len(char_to_episodes[char]) > 3:
                episodes_str += "..."

            issues.append(
                EpisodePlanIssue(
                    issue_type=EpisodePlanIssueType.INVALID_CHARACTER,
                    severity="warning",
                    message=f"角色 '{char}' 不在已分析的角色列表中 (出现在第 {episodes_str} 集)",
                    suggestion=f"使用已分析的角色名",
                )
            )

        if not all_plan_chars:
            return 10.0, []

        score = (valid_count / len(all_plan_chars)) * 10
        return score, issues

    def _check_structure(
        self,
        plan: "SeriesPlan",
    ) -> tuple[float, list[EpisodePlanIssue]]:
        """检查结构完整性。

        注：title/summary/cliffhanger/key_events/characters 的非空检查
        已前置到 EpisodePlan 的 Pydantic Field 约束中，此处不再重复检查。
        """
        # 结构检查已全部前置到 Pydantic 模型验证层
        return 10.0, []

    def _ranges_to_str(self, numbers: list[int]) -> str:
        """将数字列表转换为范围字符串。"""
        if not numbers:
            return ""

        ranges = []
        start = numbers[0]
        end = numbers[0]

        for n in numbers[1:]:
            if n == end + 1:
                end = n
            else:
                if start == end:
                    ranges.append(str(start))
                else:
                    ranges.append(f"{start}-{end}")
                start = end = n

        if start == end:
            ranges.append(str(start))
        else:
            ranges.append(f"{start}-{end}")

        return ", ".join(ranges)

    def _format_chapter_coverage(
        self,
        coverage_info: dict,
        total_chapters: int,
    ) -> str:
        """格式化章节覆盖描述。"""
        covered = coverage_info.get("covered", set())
        missing = coverage_info.get("missing", [])

        if not covered:
            return "无覆盖"

        min_ch = min(covered)
        max_ch = max(covered)

        if not missing:
            return f"{min_ch}-{max_ch}"
        else:
            missing_str = self._ranges_to_str(missing)
            return f"{min_ch}-{max_ch} (缺 {missing_str})"

    def _generate_summary(
        self,
        scores: dict[str, float],
        issues: list[EpisodePlanIssue],
    ) -> str:
        """生成审核总结。"""
        critical_count = len([i for i in issues if i.severity == "critical"])
        warning_count = len([i for i in issues if i.severity == "warning"])

        parts = []

        avg_score = sum(scores.values()) / len(scores) if scores else 0
        if avg_score >= 8:
            parts.append("规则检查通过")
        elif avg_score >= 6:
            parts.append("规则检查一般")
        else:
            parts.append("规则检查较差")

        if critical_count > 0:
            parts.append(f"{critical_count} 个严重问题")
        if warning_count > 0:
            parts.append(f"{warning_count} 个警告")

        return "，".join(parts) + "。" if parts else "审核完成。"


def create_episode_plan_reviewer() -> EpisodePlanReviewer:
    """创建分集规划规则检查器。"""
    return EpisodePlanReviewer()


# 类型提示的前向引用
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from novelvideo.agents.episode_planner import SeriesPlan, EpisodePlan
