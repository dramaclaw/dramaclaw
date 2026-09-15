# 互动故事可选交互

仅在使用可见 Choice 反馈、choice loop、非默认选择呈现或手势、互动广告 CTA 时读取本文档。StoryDraft 和 Patch 的硬契约仍以 [story-contract.md](story-contract.md) 为准。

## 选择反馈

`feedback_text` 是玩家确认可见 Choice 后显示的可选短句。仅在它能提供有意义的信息或情绪时使用，不把反馈作为强制确认语。Choice 改变数值变量时，播放器显示变量的语义标签和 ↑/↓，不显示数值，因此使用“信任”“危险”等标签。反馈不会改变视频资产，也不能声称已经生成新视频。

Automatic Choice 的 `feedback_text` 必须为空；其 effects 仍然有效，不能仅为清空反馈而移动或删除 effects。

## Choice loop

`choice_loop` 可选，且只允许出现在有出边 Choice 的 Segment 上。它是整个选择点共用的一段短动画，不是每个 Choice 一段。Segment 主媒体播放一次；选择出现后，播放器切换到已就绪的 loop media；loop 缺失时冻结主视频尾帧。

先区分配置与媒体：`description` 仅是待制作内容，`source:placeholder`、`status:missing` 或没有可播放媒体不能证明动画存在。主视频也缺失时使用占位卡，不承诺存在可冻结的真实尾帧。已有相同配置时无需重复写入，但仍按实际媒体状态解释，不能说“已经能看到热气运动”。例如：“已保存等待选择时的画面设计：咖啡热气缓缓上升。目前尚未制作这段视频，试玩时暂时看不到这个动态效果。”只有实际播放检查后才能宣称循环衔接已验证。

不得循环 Segment 的主 `media`。2–4 秒、固定机位和轻微环境运动是实用默认值，不是强制格式。保持首尾切换稳定并确保点击目标可用。不要把分支逻辑烘焙进 loop；UI 或热点仍由 Choice `interaction` 负责。

`choice_loop.description` 为必填非空字符串；`production_notes` 和 `media` 可省略，分别默认空说明和占位媒体。以下对象放入 Segment 的 `choice_loop` 字段：

```json
{
  "description": "人物保持等待姿势，背景灯光轻微流动。",
  "production_notes": "固定机位，首尾衔接稳定，点击目标保持位置。",
  "media": {"source":"placeholder","status":"missing","version":1}
}
```

## 选择呈现与手势

可见 Choice 的 `interaction` 可省略；省略时使用底部 `overlay`。只有用户要求画面内互动且最终媒体中的目标位置已知时，才使用 `object_anchor` 或 `baked_video`；不得从占位媒体或剧本文字推断精确坐标。

- `object_anchor` 在视频画幅的归一化坐标处渲染可见前端 Choice；`object_label` 标明所属道具或人物。
- `baked_video` 要求视频中已经存在可见 UI，并增加可访问的透明热点。anchor 表示矩形中心；必须提供归一化 `width`、`height`，且整个矩形位于画幅内。
- 锚点交互可使用 `glass`、`tag`、`warning` 样式，`fade`、`pop`、`pulse` 入场动效，以及 `fade`、`flash`、`cut` 分支转场。
- `interaction.trigger` 接受 `click` 或 `hold`。`hold_ms` 范围为 300–5000，默认 1000。overlay Choice 同样支持可取消的长按及持续按住 Space/Enter。

click、hold 等选择交互在现有的片尾选择点激活，不能绑定到视频中任意时间戳。

长按达到该选项的单一阈值后确认选择；提前松手、移开或失焦只取消本次长按，不触发另一分支。限时选择到期走默认选项是独立计时逻辑，不等于松手事件。不能将同一次长按描述成按持续时间自动选择多档结果；需要不同结果时提出显式选项或经用户确认的分段方案。

Automatic Choice 使用序列化默认 interaction：`overlay`、null anchor、`glass`、`fade`、`fade`、`click`、`hold_ms:1000`；工具 schema 允许默认值时也可省略该对象。

准备烘焙 UI 或其他面向模型的 UI 视觉时，额外读取 [prompt-fidelity.md](prompt-fidelity.md)。生成出的按钮本身不可点击，必须配置并核验真实播放器热点。

## CTA 字段

Ending Segment 可使用 `cta: {"label":"预约试驾","url":""}`。空 URL 表示明确尚未配置的草稿。只使用用户提供的真实 HTTPS 地址，不能编造；Patch 中使用 `cta:null` 清除。CTA 只允许出现在 ending 上。播放器负责打开链接，不负责收集线索。

广告创作、无 CTA 方案和交付验收见 [interactive-ads.md](interactive-ads.md)。
