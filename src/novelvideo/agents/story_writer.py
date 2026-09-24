# ruff: noqa: E501 - 长提示词有意保持可读，方便直接改词
"""创作阶段的写手 agent。

两个刻意的设计取舍：

1. **单集剧本走结构化输出，不让模型直接吐格式文本。**
   下游导入对场次头的格式要求很硬（`X-Y地点 日/夜 内/外` + `人物：`），
   让模型自由输出再回头校验，等于把格式正确率押在模型的格式遵循能力上——
   而这正是模型最容易漂的地方，尤其是长文本写到后半段。改成模型只输出
   「这一场在哪、什么时辰、内景外景、有谁、说了什么」，**格式由代码渲染**，
   于是格式正确率是 100% 而不是「大概率」。

2. **方案/角色/目录这三步反而用纯文本。**
   它们的下游消费者是人和模型，不是解析器，结构化只会把创作束缚成填表。

模型走 newAPI 网关。**这里必须填 newAPI 里已注册的逻辑别名，不能填上游原名**——
项目所有 agent 都走 `DC-*-LLM` 这套别名（见 official_defaults.DEFAULT_TEXT_MODEL_BY_ENV），
newAPI 按别名选通道；填 `deepseek-ai/DeepSeek-V4-Flash` 这种上游模型名会直接 502。

默认复用内容改写那条别名：同样是中文长文生成，通道已经provisioned，不需要新建。
真正执行的模型由通道决定——CE 本地安装里文本通道指向硅基流动，且
`local_gateway._forward_to_siliconflow()` 会用 `config.text_model` 覆盖请求里的模型名，
所以实际跑的就是那边配置的 `deepseek-ai/DeepSeek-V4-Flash`。
要换模型改通道或 `SILICONFLOW_TEXT_MODEL`，不是改这里。

`STORY_WRITER_MODEL` 环境变量可覆盖本别名。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator
from pydantic_ai import Agent

from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_newapi_text_pydantic_model,
)
from novelvideo.model_gateway_runtime import model_gateway_output_retries

# newAPI 逻辑别名，不是上游模型名。见模块 docstring。
STORY_WRITER_DEFAULT_MODEL = "DC-content-rewriter-LLM"

TIME_OF_DAY_VALUES = ("日", "夜", "晨", "黄昏")


class SceneOutput(BaseModel):
    """一个场次。字段直接对应导入契约里场次头的各个部分。"""

    location: str = Field(description="地点，例：洛阳·司空府正堂。不要带时间和内外景")
    time_of_day: Literal["日", "夜", "晨", "黄昏"] = Field(description="时辰")
    interior: bool = Field(description="true 为内景，false 为外景")
    characters: list[str] = Field(default_factory=list, description="本场出场人物")
    lines: list[str] = Field(
        default_factory=list,
        description=(
            "本场正文，一行一条。动作与画面描写以「△ 」开头；"
            "台词写成「角色名：「内容」」，可带括号注明语气或动作"
        ),
    )

    @model_validator(mode="after")
    def _clean(self) -> "SceneOutput":
        self.location = str(self.location or "").strip()
        self.characters = [str(c).strip() for c in self.characters if str(c or "").strip()]
        self.lines = [str(line).strip() for line in self.lines if str(line or "").strip()]
        if not self.location:
            raise ValueError("location 不能为空")
        if not self.lines:
            raise ValueError("lines 不能为空")
        return self


class EpisodeOutput(BaseModel):
    title: str = Field(description="本集标题，四到八字")
    scenes: list[SceneOutput] = Field(description="本集场次，建议 4-6 场")

    @model_validator(mode="after")
    def _clean(self) -> "EpisodeOutput":
        self.title = str(self.title or "").strip()
        if not self.scenes:
            raise ValueError("scenes 不能为空")
        return self


EPISODE_SYSTEM_PROMPT = """你是微短剧编剧，为竖屏短剧写单集剧本。

用户会先给你一组**创作约束**，再给你这一集的现有内容（可能是空的）。

铁律：
- 约束里的每一条都不可违反。禁止清单命中任意一条即为不合格。
- 【本阶段额外要求】是这一集必须做到的事，不是参考建议。
- 只写这一集，不要续写下一集，不要写集末预告。

写法要求：
- 每场 4-10 行，一场只做一件事，不要在一场里塞多个转折
- 台词短、有压迫感，符合约束里给定的台词风格
- 动作与画面描写用「△ 」开头，写镜头看得见的东西，不写心理活动
- 人物只用约束里出现过的名字，不要自创主要角色
"""

PROSE_SYSTEM_PROMPT = """你是微短剧编剧，负责创作方案、角色体系、分集目录这类文档。

用户会先给你一组**创作约束**，再给你当前内容（可能是空的）。

铁律：
- 约束里的每一条都不可违反；【角色锁】【结构锁】里已经定好的，必须原样保留，
  你只能在其基础上补充，不能改名、不能改绑定关系、不能改顺序。
- 直接输出成稿正文，不要写「好的，我来帮你」这类开场白，不要用代码块包裹。
"""


def build_episode_agent() -> Agent[None, EpisodeOutput]:
    return Agent(
        get_newapi_text_pydantic_model(
            "STORY_WRITER_MODEL",
            STORY_WRITER_DEFAULT_MODEL,
            capability="text.generate.agent",
        ),
        system_prompt=EPISODE_SYSTEM_PROMPT,
        output_type=EpisodeOutput,
        output_retries=model_gateway_output_retries(3),
        model_settings=get_newapi_structured_output_model_settings(),
    )


def build_prose_agent() -> Agent[None, str]:
    return Agent(
        get_newapi_text_pydantic_model(
            "STORY_WRITER_MODEL",
            STORY_WRITER_DEFAULT_MODEL,
            capability="text.generate.agent",
        ),
        system_prompt=PROSE_SYSTEM_PROMPT,
        output_retries=model_gateway_output_retries(2),
    )


def render_episode(episode_number: int, episode: EpisodeOutput) -> str:
    """把结构化场次渲染成导入契约格式。

    格式在这里成型，模型碰不到——所以它不可能写错场次头。
    """
    chunks: list[str] = []
    for index, scene in enumerate(episode.scenes, start=1):
        header = (
            f"{episode_number}-{index}  {scene.location}  "
            f"{scene.time_of_day}  {'内' if scene.interior else '外'}"
        )
        people = "、".join(scene.characters) if scene.characters else "—"
        body = "\n".join(scene.lines)
        chunks.append(f"{header}\n人物：{people}\n{body}")
    return "\n\n".join(chunks)
