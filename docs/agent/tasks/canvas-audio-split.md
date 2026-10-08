# 画布音频智能切分 / 自定义切分

**状态**：已完成
**最后更新**：2026-09-19
**基线**：`1697323a`；`main` 与 `zhonggwv/main` 同步；工作区仅有受保护的 `.playwright-cli/`、`_to_delete/`、`曹操.md`
**认领者**：`codex/canvas-audio-split-20260919`
**相关文档**：`docs/guides/liblib-canvas-parity.md`
**相关分支 / PR**：`main` ｜ 功能提交 `4b578509` ｜ 无 PR

## 目标

为画布音频节点补齐可实际使用的“智能切分”和“自定义切分”：智能模式按静音区间给出可审阅
的分段建议，自定义模式按用户输入的切点给出分段预览；用户确认后，每段生成一个与源音频相连、
可独立恢复和失败隔离的派生音频节点。完成标准是自动测试、构建以及真实画布的两种路径均通过。

## 非目标

- 不在本轮实现逐字稿、说话人分离、节拍识别、故事板、创意片头或通用多轨时间线。
- 不把切分结果覆盖回源节点，不引入一任务多文件的新结果协议。
- 不宣称复制 LibTV 未取证的私有算法；“智能”在本轮明确指可配置的静音检测。

## 现状与证据

- `docs/guides/liblib-canvas-parity.md` 的运行时取证确认 LibTV 音频工具条存在“智能切分”和
  “自定义切分”，但没有取得其算法或请求字段，不能从按钮名称臆造供应商实现。
- 基线已具备 `audio.trim` / `audio.speed` 动作注册、`freezone_audio_transform` 本地 ffmpeg
  任务、派生节点投影和刷新恢复。切分确认后扇出这条已验收链路，比另造多产物任务更可靠。
- `git status --short --branch` 在基线只显示三类受保护未跟踪资料；目标文件没有本地 diff。
  `zhonggwv/main` 与本地同步。`origin/main` 的旧上游线上述共享文件均有差异，但没有专门的
  audio split 分支；本线以当前已审计并推送的本地基线串行追加，不 pull/rebase 或整文件覆盖。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md`、本台账、本线 claim 与互惠 claim | 协调 | 登记生命周期、共享热点与机器拦截 |
| `docs/guides/liblib-canvas-parity.md` | 共享 | 把差距矩阵更新为可追溯的实际落地状态 |
| `frontend/src/features/canvas/application/canvasActionRegistry.ts` | 共享 | 增加两种切分动作的稳定身份 |
| `frontend/src/features/canvas/application/audioSplit.ts` | 独占 | 纯前端切点解析、分段校验与显示模型 |
| `frontend/src/features/canvas/ui/AudioSplitMenu.tsx` | 独占 | 智能分析、自定义切点和确认预览 UI |
| `frontend/src/features/canvas/ui/NodeActionToolbar.tsx` | 共享 | 挂载动作并复用音频截取任务扇出派生节点 |
| `frontend/src/api/ops.ts` | 共享 | 智能分段预览 API 客户端 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 三语可见文案 |
| `src/novelvideo/freezone/audio_split.py` | 独占 | ffprobe + silencedetect 分析及稳定分段算法 |
| `src/novelvideo/api/schemas.py`、`src/novelvideo/api/routes/freezone.py` | 共享 | 参数校验、项目内媒体解析和预览端点 |
| `tests/test_freezone_audio_split.py` | 独占 | 后端算法、子进程和路由契约 |
| `frontend/src/__tests__/features/canvas/audio-split.test.ts` | 独占 | 切点解析与边界测试 |
| `frontend/src/__tests__/features/canvas/canvas-action-registry.test.ts` | 共享 | 注册表动作全集契约 |

机器可读的同范围声明在 `docs/agent/claims/canvas-audio-split.toml`。

## 协调与冲突
- 2026-09-27：中文项目命名线串行补充 LibTV 原名称保存 / 来源入口 / 预读名称与回归；既有导入合并和首次重试语义保留，由 project-chinese-names 集成。

- 2026-09-26 与 `text-node-liblib-visual-parity` 串行共享 API schema, Freezone route and ops client：该线只修改 DeepSeek 文本模型选择与透传，由其集成；本线原有功能及写入边界保持不变。

- **相关工作线**：`canvas-audio-actions`、`liblib-canvas-parity`、`shot-breakdown`、
  `depth-motion-da3`、`local-stack`。
- **本地已有改动**：目标业务文件在开工前无 diff；三类未跟踪本地资料不属于本线且禁止触碰。
- **远端重复实现**：未发现同名 audio split 分支；`origin/main` 与当前基线在热点文件上的差异
  属于尚未审计的旧上游差异，本线不把它们倒灌进来。
- **共享文件顺序**：已完成的 audio actions 先提供单段任务合同，本线只在其后追加动作和扇出；
  其他画布线保留原块。集成采用小块 patch 和聚焦测试，禁止整文件重写。

## 实施方案

1. 建立纯分段合同——自定义切点转换为连续、不重叠、覆盖全时长的片段；完成条件：边界、乱序、
   重复和数量上限都有单测。
2. 后端提供智能预览——只解析项目内静态音频，以 ffprobe 取时长、ffmpeg `silencedetect` 取
   静音区间，在静音中点切割并过滤过短片段；完成条件：端点返回类型化片段且不写产物。
3. 接入动作 UI——两种模式都先展示片段数量/时段，确认后逐段提交现有 transform；完成条件：
   每段都有独立任务描述、派生节点、源边和错误状态，部分失败不撤销已成功片段。
4. 完成三语、文档、静态门和真实浏览器验收；完成条件：刷新后结果仍存在且可播放。

## 风险与回退

- **风险**：长音频静音检测占用 ffmpeg；设置 120 秒墙钟上限和最多 24 段。阈值不适合音乐时
  可能只返回一段，UI 必须如实提示而不是假装完成切分。批量确认会创建多个任务，客户端串行提交
  并保留部分成功结果。
- **回退**：按本线精确路径撤销新文件和新增小块；已有截取/变速任务与源音频数据不受影响。
  禁止整树 reset / restore。

## 验收标准

- [x] `uv run pytest tests/test_freezone_audio_split.py tests/test_freezone_audio_transform.py tests/test_freezone_audio_transform_backend.py` → 17 项后端聚焦测试全过
- [x] `cd frontend && pnpm exec vitest run src/__tests__/features/canvas/audio-split.test.ts src/__tests__/features/canvas/canvas-action-registry.test.ts frontend/src/__tests__/api-ops.test.ts` → 10 项前端合同全过
- [x] `python3 scripts/check_backend_i18n.py && python3 scripts/check_frontend_i18n.py` → 后端预算未增加、前端保持 0 命中
- [x] `uv run ruff check .` 与 `cd frontend && pnpm build` → 静态检查、类型和生产构建通过
- [x] 真实画布：智能预览、自定义切点、批量生成、部分结果播放、刷新恢复均符合预期
- [x] 本轮改动全部在写入边界内，无未解释 diff；三语、文档和交接记录完整

## 进展记录

### 2026-09-29 · 公开 origin 集成共享路径协调

本线既有已提交实现先于 `sync-main-remotes`；后者在独立 `codex/public-origin-sync` 检出中作为唯一后序集成者，仅对同名 claim 互认的精确路径解决公开上游三方冲突。本线旧产品合同、验证结果和业务所有权不因协调改写；最终合并验证与公开 PR 交付由同步线记录。

### 2026-09-19 · 独立 DCO 提交已推送

做了什么：将本线 23 个精确 claim 文件作为 `4b578509 feat(canvas): add audio split actions`
独立提交并推送到 `zhonggwv/main`；三类受保护未跟踪资料没有进入提交。

为什么这么改（尤其是与原计划分叉的地方）：沿用一工作线一提交，避免把浏览器运行日志、旧原型
和故事样例公开，也让音频切分可以单独审阅、回退和追责；实现方案没有再分叉。

怎么验证的（命令 / 界面路径 / 结果）：提交钩子中的密钥扫描、工作线守栏和违禁词检查均通过；
`git push zhonggwv main` 返回 `1697323a..4b578509 main -> main`。

### 2026-09-19 · 两种切分路径完成并通过真实画布验收

做了什么：新增项目内音频只读分析端点、静音中点分段算法、前端切点纯函数和两种预览菜单；
在动作注册表登记 `audio.split.smart` / `audio.split.custom`，确认后复用既有单段 transform，逐段
生成独立任务、派生音频节点和源边；同步补齐三语、后端与前端合同测试及本对标文档。

为什么这么改（尤其是与原计划分叉的地方）：真实画布第一次批量验证时，连续提交命中了项目级
ffmpeg 队列容量 1，后两段稳定返回 429，因此从“串行发请求”收紧为“等待每段进入终态后再提交
下一段”；另一次验证发现 `findNodePosition` 后两参是节点宽高而非坐标偏移，改为统一传 480×210，
让既有碰撞布局自行寻找空位，避免派生节点相互遮盖。这两项均是沿用现有合同，不改队列或布局底座。

怎么验证的（命令 / 界面路径 / 结果）：后端 17 项聚焦测试、前端 10 项聚焦测试、`ruff check .`、
前后端 i18n 棘轮、`git diff --check` 和 `pnpm build` 全部通过。真实画布上传 6 秒音频后，智能模式
得到 3 段并全部完成；自定义 `2,4` 得到 3 个 2 秒节点，自定义 `3` 得到 2 个 3 秒节点；任务中心
无 429，派生节点可播放，刷新后源节点和结果节点仍存在。浏览器仅有与本功能无关的头像 404。

### 2026-09-19 · 方案门与冲突审计完成

做了什么：确认 LibTV 只取证到两个入口名称；审阅现有动作注册、音频 transform 任务和恢复路径，
确定采用“预览方案 + 多个既有单段任务”，登记精确写入边界和共享声明。

为什么这么做（尤其是与原方案分叉的地方）：一任务多产物会迫使通用结果端点、节点任务描述和
刷新恢复同时改协议；复用单段任务能让每段独立恢复、重试和报错，也保留源节点。

怎么验证的（命令 / 界面路径 / 结果）：已运行 `git status --short --branch`、目标路径 diff、
`HEAD..origin/main` 重叠检查和相关分支枚举；业务代码尚未修改，功能未验证。

## 已定下来的决策

- **智能切分 = 可配置静音检测，不冒充 LibTV 私有算法**——现有证据只有入口文案。
- **先预览、后确认**——分析本身不写图、不生成媒体，避免误操作和任务洪泛。
- **确认后扇出已验收的单段 transform**——每个派生节点有独立任务和刷新恢复合同。
- **切点取静音区间中点并保留完整时长**——不静默丢掉静音内容，也不制造片段间空洞。
- **最多 24 段**——限制节点与任务扇出；超出时要求用户提高最短静音或改用自定义切点。
- **分段任务必须等前一段终态再提交**——项目级 ffmpeg 队列容量为 1；只等待创建请求返回仍会 429。
- **`findNodePosition` 最后两参固定传派生节点宽高 480×210**——它们不是偏移量；位置由碰撞布局计算。

## 待办

- [x] 实现并验证后端智能预览合同。
- [x] 实现并验证两种前端预览与批量派生节点。
- [x] 完成真实浏览器验收与文档收口。
- [x] 完成独立 DCO 提交并推送；提交号为 `4b578509`。

## 阻塞

无。

## 交接摘要

- **最后完成到**：代码、测试、构建、i18n、真实画布验收、独立 DCO 提交和推送全部完成。
- **下一步唯一动作**：本线无遗留动作；若增强节拍/语义切分，必须另开工作线并重新取证。
- **先读这些文件**：本台账、`audioSplit.ts`、`AudioSplitMenu.tsx`、后端 `audio_split.py`。
- **不要动这些文件 / 决策**：不碰三类受保护本地资料；不并发扇出 ffmpeg；不覆盖源节点。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。

### 2026-09-26 · 视频副本工具条共享协调

本线原工具条功能先完成；video-node-duplicate 后串行追加副本按钮，复用 store 入边复制，当前 Codex 会话集成，不变更本线操作。

### 2026-09-26 · 时间分镜拆分协调

本线先完成，video-prompt-split 后串行集成，保留原功能；当前会话集成共享路径：frontend/src/features/canvas/ui/NodeActionToolbar.tsx, frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：frontend/src/api/ops.ts, frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json, src/novelvideo/api/routes/freezone.py。

### 2026-09-27 · 引用合同串行协调
既有 schemas 实现已提交；允许 multi-provider-models 串行修复 H3 格式绑定数量校验，保持本线媒体生成合同，由该线最终集成。
