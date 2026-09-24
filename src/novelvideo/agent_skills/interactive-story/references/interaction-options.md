# 互动选项与 CTA

仅在规划反馈、选择循环、画面锚点、长按或 CTA 时读取；基础 StoryDraft/Patch 载荷见 [故事契约](story-contract.md)。播放器在片尾显示选择，不支持按任意视频时间戳触发。

## 选择反馈与循环

可见 Choice 的 `feedback_text` 是确认选择后显示的可选短句，不改变视频资产。数值效果在播放器显示变量语义标签和升降方向，不显示数值。Automatic Choice 必须清空 `feedback_text` 和可见交互，但可保留 effects。

有出边 Choice 的 Segment 可设共用的 `choice_loop`：`description` 必填，`production_notes` 与 `media` 可省略，默认为空说明与占位媒体。主片播完后，只有 loop media 就绪才播放循环；否则冻结主片尾帧，主片也缺失时显示占位卡。不要循环主 `media` 或把文字描述说成已生成的动态画面。短时、固定机位、轻微环境运动有利于无缝衔接；真实效果须试玩确认。

## 呈现与手势

可见 Choice 省略 `interaction` 时使用底部 `overlay`。`object_anchor` 在归一化 `(x,y)` 上渲染前端选项；`baked_video` 要求成片已有可见 UI，再叠加透明热点，anchor 还需 `width`、`height`，以中心计算的矩形须留在画幅内。最终画面未知时不猜坐标。支持 `glass/tag/warning` 样式、`fade/pop/pulse` 入场和 `fade/flash/cut` 转场。

`trigger` 为 `click` 或 `hold`；长按阈值 `hold_ms` 为 300–5000，默认 1000。提前松手、移开或失焦只取消本次长按；到阈值才选中该项。限时选择到期走默认项，与长按取消无关；一次长按不能按持续时间自动分出多档结果。视频里画出的按钮不能自行点击，热点需配置并在成片上核验。涉及烘焙 UI 时还读 [提示词保真](prompt-fidelity.md)。

## CTA

CTA 仅用于 ending Segment：`cta: {"label":"预约试驾","url":""}` 可保存未配置草稿，`cta:null` 用于 Patch 清除。只有用户提供的真实 HTTPS 地址才可配置为可用外链；播放器打开链接，不收集线索。广告方案与验收见 [互动广告](interactive-ads.md)。
