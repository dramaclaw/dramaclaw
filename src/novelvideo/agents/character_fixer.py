"""角色修复 Agent。

根据审核报告修复角色问题：合并重复、删除泛称、修正身份。
"""

from typing import Callable, Optional

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_pydantic_model,
)


class FixAction(BaseModel):
    """修复操作记录。"""

    action: str = Field(description="操作类型: merge/delete/update")
    target: str = Field(description="操作目标")
    result: str = Field(description="操作结果")
    success: bool = Field(default=True, description="是否成功")


class CharacterFixReport(BaseModel):
    """角色修复报告。"""

    fixed: list[FixAction] = Field(default_factory=list)
    summary: str = Field(default="", description="修复总结")
    total_actions: int = Field(default=0, description="总操作数")
    success_count: int = Field(default=0, description="成功数")

    @property
    def all_success(self) -> bool:
        """是否全部成功。"""
        return all(f.success for f in self.fixed)


FIXER_INSTRUCTIONS = """你是一个角色修复专家。

## 任务
根据审核报告修复角色问题。

## 工具
- tool_merge_characters(primary_name, alias_names): 合并重复角色
  - primary_name: 保留的主角色名
  - alias_names: 要合并的别名，逗号分隔（如 "皇后娘娘,娘娘"）

- tool_delete_character(name): 删除角色
  - 用于删除泛称或无效角色

- tool_update_character_field(name, field, value): 更新角色字段
  - field 可以是: gender, role, personality 等

- tool_get_character_detail(name): 获取角色详情
  - 用于确认修复前的状态

## 工作流程
1. 读取审核报告中的问题
2. 对每个问题：
   - duplicate: 调用 tool_merge_characters 合并
   - generic: 调用 tool_delete_character 删除
   - identity_error: 调用 tool_update_character_field 修正
3. 每个操作后确认结果
4. 输出修复报告

## 输出格式
返回 JSON 格式的修复报告：
- fixed: 操作列表，每个操作包含 action、target、result、success
- summary: 修复总结
- total_actions: 总操作数
- success_count: 成功数

## 注意事项
- 合并角色时，选择更具体的名字作为 primary（如"净臻"而非"小和尚"）
- 删除前先用 tool_get_character_detail 确认
- 每个操作都要记录是否成功
"""


def create_character_fixer_agent(tools: Optional[list[Callable]] = None) -> Agent:
    """创建角色修复 Agent。

    Args:
        tools: 角色修复工具列表

    Returns:
        Agent: 配置好的角色修复 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=FIXER_INSTRUCTIONS,
        output_type=CharacterFixReport,
        model_settings=get_newapi_structured_output_model_settings(),
        tools=tools or [],
        name="角色修复员",
    )


# 默认实例（延迟初始化）
_fixer_agent = None


def get_character_fixer_agent() -> Agent:
    """获取角色修复 Agent 单例（无工具版本）。

    Returns:
        Agent: 角色修复 Agent 实例
    """
    global _fixer_agent
    if _fixer_agent is None:
        _fixer_agent = create_character_fixer_agent()
    return _fixer_agent
