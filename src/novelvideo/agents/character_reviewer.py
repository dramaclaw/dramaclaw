"""角色审核 Agent。

审核角色列表，检测重复、泛称、身份错误等问题。
"""

from typing import Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)


class CharacterIssue(BaseModel):
    """角色问题。"""

    issue_type: str = Field(description="问题类型: duplicate/generic/identity_error")
    names: list[str] = Field(default_factory=list, description="相关角色名")
    reason: str = Field(description="问题原因")
    suggestion: str = Field(default="", description="修复建议")


class CharacterReviewReport(BaseModel):
    """角色审核报告。"""

    issues: list[CharacterIssue] = Field(default_factory=list)
    summary: str = Field(default="", description="审核总结")
    reviewed_count: int = Field(default=0, description="审核的角色数量")

    @property
    def has_issues(self) -> bool:
        """是否有问题。"""
        return len(self.issues) > 0


REVIEWER_INSTRUCTIONS = """你是一个角色审核专家。

## 任务
审核角色列表，找出以下问题：

1. **重复角色 (duplicate)**：
   - 同一角色的不同称呼（如"皇后娘娘"和"皇后"是同一人）
   - 角色名和别名（如"净臻"和"小和尚"可能是同一人）

2. **泛称角色 (generic)**：
   - 不是具体角色的通用称呼（如"娘娘"、"太监"、"宫女"）
   - 这些应该删除或合并到具体角色

3. **身份错误 (identity_error)**：
   - 角色身份与设定不符（如皇帝不应该是和尚）
   - 性别错误、职业错误等

## 工作流程
1. 首先调用 tool_get_all_characters 获取当前角色列表
2. 分析角色名，找出可能重复的组合
3. 对可疑的组合调用 tool_check_duplicate 验证
4. 对可疑身份调用 tool_verify_identity 确认
5. 对需要了解关系的角色调用 tool_search_relations
6. 整理问题，输出审核报告

## 输出格式
返回 JSON 格式的审核报告，包含：
- issues: 问题列表，每个问题包含 issue_type、names、reason、suggestion
- summary: 审核总结
- reviewed_count: 审核的角色数量

## 注意事项
- 重复角色的 names 应包含所有相关的名字
- 泛称角色的 names 只包含该泛称
- 身份错误的 names 只包含错误的角色名
- 每个问题都要有明确的 suggestion
"""


def create_character_reviewer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """创建角色审核 Agent。

    Args:
        tools: 角色审核工具列表

    Returns:
        Agent: 配置好的角色审核 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=REVIEWER_INSTRUCTIONS,
        output_type=CharacterReviewReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="角色审核员",
    )


# 默认实例（延迟初始化）
_reviewer_agent = None


def get_character_reviewer_agent() -> Agent:
    """获取角色审核 Agent 单例（无工具版本）。

    Returns:
        Agent: 角色审核 Agent 实例
    """
    global _reviewer_agent
    if _reviewer_agent is None:
        _reviewer_agent = create_character_reviewer_agent()
    return _reviewer_agent
