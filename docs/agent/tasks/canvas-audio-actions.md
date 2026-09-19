# 画布动作注册表与音频截取 / 变速

**状态**：已完成
**最后更新**：2026-09-19
**基线**：`3238af61`；本线在该提交上独立追加，未混入三类受保护本地资料
**认领者**：`codex/canvas-audio-actions-20260919`
**相关文档**：`docs/guides/canvas-architecture.md` 第九、十二节；`docs/guides/liblib-canvas-parity.md` 零点三与零点八
**相关分支 / PR**：`main`

## 目标

建立可渐进迁移的画布动作描述契约，并用音频节点的“截取”和“变速”完成第一条端到端切片：
用户在有音频的节点上选择源区间与速度，系统以本地 ffmpeg 异步生成下游音频节点，保留源节点、
依赖边、参数、任务状态和刷新恢复能力；不原地覆盖源音频。

## 非目标

- 本轮不做智能切分、自定义多段切分、音频降噪、音高独立调整或波形编辑器重构。
- 不把全部图片/视频工具一次性迁入动作注册表；只固化契约并接入音频动作，避免大爆炸重构。
- 不实现故事板、创意片头、主体消除、图层分离或 Agent 自动执行。
- 不改变现有音频生成、音色选择和下载转码行为。

## 现状与证据

- `AudioNodeData` 已保存 URL、时长和通用生成任务句柄；`AudioNode` 已能展示异步状态和刷新后的失败。
- 音频节点工具条当前只有下载/格式转换，没有截取和变速。
- 视频合成时间线已有 trim/speed 的前端概念，但后端 compose 要求至少一个视频，不能拿黑色视频
  包装音频处理，也不能把音频动作伪装成视频合成。
- 后端已有 ffmpeg 队列、同源静态地址解析、任务注册、SSE/轮询和通用结果读取，可复用这些底座。
- LibTV 登录态真实音频节点工具条确认有“截取 / 变速 / 智能切分 / 自定义切分”；本轮只做前两项。
- `git status` 在基线提交后只剩 `.playwright-cli/`、`_to_delete/`、`曹操.md`，均不属于本线。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md`、本台账、本线 claim | 协调 | 登记状态、冲突与交接 |
| 相关既有 claim 文件 | 协调 | 为共享热点补充本线的双向声明 |
| `frontend/src/features/canvas/application/canvasActionRegistry.ts` | 独占 | 动作元数据、可用性与副作用契约 |
| `frontend/src/features/canvas/application/audioTransform.ts` | 独占 | 音频区间/速度校验、派生节点数据与结果投影 |
| `frontend/src/features/canvas/ui/AudioTransformMenu.tsx` | 独占 | 截取/变速输入和确认 UI |
| `frontend/src/features/canvas/ui/NodeActionToolbar.tsx` | 共享 | 挂载音频动作，保留既有视频/拉片入口 |
| `frontend/src/features/canvas/domain/canvasNodes.ts` | 共享 | 显式声明音频派生来源和参数字段 |
| `frontend/src/api/ops.ts` | 共享 | 音频 transform 请求与结果任务类型 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 新增用户文案，按键合并 |
| `src/novelvideo/freezone/audio_transform.py` | 独占 | ffmpeg 裁剪和保音高变速 |
| `src/novelvideo/api/schemas.py` | 共享 | transform 请求 schema |
| `src/novelvideo/api/routes/freezone.py` | 共享 | 同源校验、排队、结果路径 |
| `src/novelvideo/task_backend/runners/freezone.py` | 共享 | 本地 leaf 分类、执行和任务注册 |
| `src/novelvideo/api/routes/tasks.py` | 共享 | 任务中心中文标签 |
| `tests/test_freezone_audio_transform.py` | 独占 | ffmpeg 命令与输出契约 |
| `tests/test_freezone_audio_transform_backend.py` | 独占 | API、队列、结果路径契约 |
| `tests/test_p0g4i_freezone_leaf_classification.py` | 共享 | 把本地 ffmpeg leaf 纳入显式出网分类护栏 |
| `frontend/src/__tests__/features/canvas/canvas-action-registry.test.ts` | 独占 | 动作注册/可见性/副作用契约 |
| `frontend/src/__tests__/features/canvas/audio-transform.test.ts` | 独占 | 区间、速度和投影纯逻辑 |

## 协调与冲突

- **相关工作线**：`liblib-canvas-parity`、`shot-breakdown`、`depth-motion-da3`、`local-stack`。
- **本地已有改动**：目标业务文件无未提交改动；三类受保护本地资料不触碰。
- **远端重复实现**：现有远端重拍分支只涉及视频，没有音频截取/变速实现；不复用其状态机。
- **共享文件顺序**：上述相关线均为待验收，已提交实现不再写；本线只在当前 HEAD 上串行追加
  音频 hunk，并在双方 claim 中互认。三语翻译只加键，不整文件覆盖。
- **架构边界**：动作注册表本轮不接管旧视频动作；音频处理独立 task type，不能偷用
  `freezone_video_compose`，也不能在浏览器内生成不可恢复的临时 Blob 作为最终节点资产。

## 实施方案

1. 建立动作描述和音频 transform 纯契约——完成条件：测试覆盖显示条件、`spawn/paid-job` 副作用、
   0≤start<end≤duration、0.5–2.0 倍速度和派生节点元数据。
2. 新增本地 ffmpeg leaf 与异步任务——完成条件：输入只接受项目同源文件；输出固定为 M4A/AAC；
   `atempo` 保持音高；ffmpeg 缺失、区间非法、任务失败均有稳定失败路径。
3. 在音频工具条接入“截取/变速”——完成条件：确认后创建下游音频节点和系统依赖边，任务完成
   回写 URL/时长，失败可见，刷新可通过持久化任务句柄继续观察。
4. 跑聚焦测试、i18n、ruff、类型构建并手工走本地画布——完成条件：现有下载不回归，源音频不变，
   派生音频可播放且时长与速度计算一致。

## 风险与回退

- **风险**：大型音频转码耗时；损坏音频可能让 ffmpeg 报错；新增 task type 若漏注册会停在队列；
  工具条是共享热点；速度改变后的时长容易用源时长误写。
- **控制**：限制源区间和速度；用 ffmpeg `-vn -af atempo` 输出 AAC；结果节点时长按
  `(end-start)/speed` 先估算，播放器 metadata 再校准；任务句柄在提交后立即持久化。
- **回退**：删除独占模块/测试，并只回退共享文件中的本线小块和 i18n 键；不 restore 整文件。

## 验收标准

- [x] `uv run pytest tests/test_freezone_audio_transform.py tests/test_freezone_audio_transform_backend.py tests/test_p0g4i_freezone_leaf_classification.py`（23 passed）。
- [x] `cd frontend && pnpm exec vitest run src/__tests__/features/canvas/canvas-action-registry.test.ts src/__tests__/features/canvas/audio-transform.test.ts`（7 passed）。
- [x] `uv run ruff check` 覆盖本轮 Python 文件；前后端 i18n 棘轮、CE 端口闭合、导入/词汇门禁通过。
- [x] `cd frontend && pnpm build` 通过。
- [x] 真实画布：4 秒源音频截取 0.5–2.5 秒得到 2 秒下游节点，2× 得到 2 秒下游节点；刷新后两者仍可恢复播放，源节点保持 4 秒。
- [x] 本轮所有 Git diff 都在写入边界内，三类受保护本地资料未改变；浏览器生成的临时节点与媒体文件已清理。

## 进展记录

### 2026-09-19 · 端到端实现与真实画布验收完成

做了什么：新增动作注册表、音频 transform 纯契约、截取/变速弹层、三语文案和派生节点绑定；
新增 `freezone_audio_transform` API、ffmpeg leaf、任务 runner、结果路由、任务中心名称与 23 项后端/
边界测试。提交任务成功后才创建下游节点，节点保存 task key/type/job id，完成后回写 M4A URL。

为什么这么做：音频截取和变速是确定性本地媒体操作，独立 task type 能复用任务恢复与同源文件护栏，
又不需要伪装成视频合成；动作注册表只声明稳定身份、源类型、副作用和能力，避免继续把条件散落到巨型工具条。

怎么验证的：前端 7 项纯测试、后端/leaf 23 项测试、生产构建、ruff、前后端 i18n、CE 端口闭合、
CE 导入/违禁词门禁均通过。Playwright 真实进入 `test` 画布，上传 4 秒临时 M4A；首次跑出任务完成但结果
GET 422，定位为结果路由 `Literal` 漏枚举并补回归测试；修复后截取与 2× 变速均生成可播放 2 秒节点，
刷新仍存在。验收结束删除 4 个临时节点和 4 个本地媒体文件，当前画布恢复为空。此前误用
`pnpm test -- ...` 触发过全套测试，暴露的是存量 `local-storage-quota` 环境参数和 `ingest` MSW/FormData
失败；已改用 `pnpm exec vitest run <两文件>`，本线聚焦测试全部通过。

### 2026-09-19 · 方案门完成，准备实现

做了什么：盘点音频节点、工具条、视频时间线、任务队列与结果链，确定新增独立音频 transform
任务，并列出精确共享路径和双向 claim。

为什么这么做：复用视频 compose 会制造“音频任务必须伪造视频”的错误协议；浏览器内 Blob
无法稳定跨刷新和协作。独立本地 ffmpeg leaf 最符合已有任务/恢复架构。

怎么验证的：对回 `AudioNodeData`、`useAudioGeneration`、`freezone_video_compose`、任务 runner、
通用结果路由和 LibTV 实机工具条；业务实现尚未开始。

## 已定下来的决策

- **截取和变速产出下游音频节点，不覆盖源节点。** 便于对比、复用和追溯。
- **速度范围一期为 0.5–2.0，使用 ffmpeg `atempo` 保持音高。** 不把变速实现成改播放控件。
- **新增 `freezone_audio_transform`，不复用视频合成 task type。** 任务语义和结果媒体都不同。
- **动作注册表渐进迁移。** 本轮只接音频新动作，不重写已有图片/视频工具。
- **真正提交任务前才创建派生节点。** 取消面板不污染画布，也不启动 ffmpeg。

## 待办

- [x] 实现纯契约与测试。
- [x] 实现后端 leaf、API、runner 与测试。
- [x] 实现工具条 UI、派生节点生命周期和三语文案。
- [x] 自动测试、构建与浏览器验收。

## 阻塞

无。该任务是纯本地 ffmpeg，不依赖 OSS relay 或模型供应商。全套前端测试中的两类存量失败与本线
无关，聚焦测试和生产构建均通过。

## 交接摘要

- **最后完成到**：动作注册、音频截取/变速的前后端、恢复句柄、三语、自动测试和真实画布验收均完成。
- **下一步唯一动作**：若继续 LibTV 对齐，另开工作线做“智能切分/自定义切分”或故事板，不在本线追加。
- **先读这些文件**：本台账、`canvasActionRegistry.ts`、`audioTransform.ts`、`audio_transform.py`。
- **不要动这些文件 / 决策**：不整文件重写工具条；不覆盖源音频；不把 audio transform 塞进 video compose。
