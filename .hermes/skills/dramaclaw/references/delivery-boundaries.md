# 媒体展示与交付边界

只交付用户请求对应的业务结果，不交付 API、JSON、文件系统路径、调试过程或猜测出来的链接。

## 展示原则

- 图片、视频、音频等媒体必须调用对应 DramaClaw 展示工具；路径和 URL 只作为工具输入，不直接输出给用户。
- 不使用 Markdown 图片、HTML 媒体标签、纯文本 URL、`/static` 路径、文件名列表或文字描述代替展示。
- 一旦本轮调用展示工具，最终自然语言只做简短说明，不再重复媒体地址或内部渲染信息。
- 展示工具必须使用 API 返回的正式 `*_url`；不得使用任务结果里的本地 `*_path`，不得拼 host、改 query、去掉版本参数、猜 `/files` 或下载路由。
- `*_url` 为空表示尚未生成完成。只说明暂无可展示媒体，不拿旧资源、候选图或其它阶段产物替代。
- `vision_analyze` 等看图工具不是用户展示手段。
- 角色、剧集、进度、任务、脚本、表格和普通长文本使用 Markdown，不调用媒体展示工具。

## 工具选择

| 用户要看 | 使用方式 | 约束 |
|---|---|---|
| 人物肖像 | `dramaclaw_get_character_media(media_kind="portrait", name="角色名或别名片段")` | `name` 只匹配角色名/别名，不混入身份图 |
| 身份图 | `dramaclaw_get_character_media(media_kind="identity", name="角色名或身份名片段")` | `name` 可匹配角色名、别名、身份名或身份 ID；仅按描述查找时用 `query` |
| 当前草图 | `dramaclaw_get_sketches(episode=N, beat=M)` | 只展示正式 `sketch_url`，不回退到候选池或首帧 |
| 草图候选 | `dramaclaw_get_sketch_candidates(episode=N, beat=M)` | 候选池与当前草图是不同产物 |
| 首帧 | `dramaclaw_get_first_frames(episode=N, beat=M)` | 不使用任务结果里的本地图片路径 |
| 场景图 | `dramaclaw_get_scene_images(name="场景名片段")` | 多关键词用 `names`，序号用 `index`/`scene_indices`，类型用 `scene_type` |
| 视频片段 | `dramaclaw_get_episode_media(episode=N, media_type="video", beat=M)` | 内容检索用 `query`，多个 beat 用 `beat_indices` |
| 音频/配音 | `dramaclaw_get_episode_media(episode=N, media_type="audio", beat=M)` | 内容检索用 `query`，多个 beat 用 `beat_indices` |
| 最终成片 | 单集用 `dramaclaw_get_final_video(episode=N)`；全部成片省略 `episode`，分页用 `offset` + `limit` | 仅在正式成片存在时展示；“全部成片”只调用一次工具 |

批量媒体统一用 `offset` + `limit` 分页，不为展示而遍历任务列表或扫描文件系统。

## 最终成片

- 某集流水线完成合成且接口返回正式成片结果时，主动调用成片展示工具。
- 用户只是要求继续制作时，按当前步骤推进；不要把“继续到成片”解释成必须立即交付链接。
- 合成任务完成但接口没有正式结果时，只说明“合成已完成，但当前没有可展示的正式成片结果”。
- 没有正式结果时，不重新触发合成，不探测文件或导出路由，不拿旧 `video_url` 充当本次结果。
- 用户要求下载或导出时，只使用 API 明确支持并实际返回的交付结果；仍不得拼接绝对 URL。

## 生成结果判定

- 启动成功不等于生成完成；`generated: true` 也不等于已经返回新媒体路径。
- 单 beat 视频启动后没有 `result.video_path` 时，按任务状态汇报，不重复 POST，不交付 beat 上的旧 `video_url`。
- 任务显示 completed 但正式媒体字段为空时，按异常断点处理：说明任务完成但产物不可展示，并停在当前步骤。
- 展示工具没有返回媒体时，如实说明暂无可展示结果，不手写媒体结构。

## 禁止

- 暴露 API 端点、请求参数、认证信息或文件系统路径。
- 把 API 地址、localhost、测试域名或相对静态路径当作用户交付物。
- 批量猜测 mp4/png/jpg/mp3/zip 路径。
- 为查找结果重复生成、重新合成或扩大用户请求范围。
