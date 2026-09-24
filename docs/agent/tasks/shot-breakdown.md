# 逐帧拉片：分镜 / 动态 / 音乐三维度

**状态**：待验收
**最后更新**：2026-09-18
**基线**：`38c1f057bca1`；三层实现已独立提交；共享 API / runner 已按 hunk 集成
**相关文档**：`docs/guides/shot-breakdown.md`（实测证据、远端契约审计与收敛方案）；
动态维度另见 `docs/guides/depth-motion-da3.md`
**相关分支 / PR**：`main` 上 `9d1d4aad`、`8820f142`、`38c1f057`；已推送目标为
`zhonggwv/main`

## 目标

把一段参考视频的镜头语言反编译成可复用的「运镜素材」，挂到生成节点上供该节点使用。
三个维度：分镜（景别/运镜/基调归纳）、动态（深度视频，见 depth-motion 台账）、音乐（伴奏轨）。

## 非目标

- 不把参考片反编译结果写回作者意图的 `ShotMetadata`。
- 不为归纳层再调用一次模型；不把 demucs 变成社区版强依赖。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `src/novelvideo/freezone/shot_breakdown.py` | 新增 | 在逐帧结果之上做归纳统计层 |
| `src/novelvideo/freezone/bgm_separate.py` | 新增 | 音乐维度：人声分离取伴奏，可降级 |
| `src/novelvideo/freezone/jobs.py` | 修改 | 任务定义 |
| `src/novelvideo/api/routes/freezone.py` / `routes/tasks.py` / `api/schemas.py` | 修改 | 端点与 schema |
| `src/novelvideo/task_backend/runners/freezone.py` | 修改 | 本地 leaf 分类 |
| `frontend/src/features/canvas/application/shotBreakdownNodes.ts` | 新增 | 产物落成画布节点 |
| `frontend/src/api/ops.ts` / `api/tasks.ts` | 修改 | 前端接口 |
| `tests/test_shot_breakdown.py`、`tests/test_bgm_separate.py` | 新增 | |
| `frontend/src/__tests__/features/canvas/shot-breakdown-nodes.test.ts` | 新增 | |

三个新增领域模块 / 测试可按各自工作线独占；`freezone.py`、`tasks.py`、`schemas.py`、`jobs.py`、
`runners/freezone.py`、前端 `ops.ts` / `tasks.ts` 是共享集成层。

## 协调与冲突

- depth-motion 与本线共同修改 `freezone.py` 和 `runners/freezone.py`，且动态维度本身由 depth 台账负责；
  本线只拥有三维度编排与分镜 / 音乐产物，不应复制 DA3 实现。
- `origin/feat/canvas-video-reshoot-breakdown` 已有 video breakdown 后端、前端节点、生命周期和计费测试，
  并修改本线多数共享集成层。先比较任务生命周期、产物 schema 和计费 / 出网约束，不能默认本地版本更完整。
- `freezone.py`、`tasks.py`、`schemas.py` 同时有 `origin/main` 新改动。集成必须从最新共同基线开始，
  不把旧基线上的共享文件整段提交。
- `sync-main-remotes` 在本线提交之后串行处理 `VideoNode.tsx` 的最终三方合并；本线的流式拉片生命周期
  与产物落点必须保留，上游引用校验/续写和 H3 Mixed 行为由集成测试共同约束。

## 实施方案

1. 已把易丢的 LibTV 拉片证据移入 `docs/guides/shot-breakdown.md`。
2. 已完成远端 / 本地请求、任务、节点、计费、权限、取消与恢复契约审计。
3. 按“纯领域模块 → 后端共享层 → 前端共享层”拆提交，每层从暂存区快照验证。
4. 补上远端已经证明必要的计费、刷新复位、源节点删除保护，再真跑三维度。

## 风险与回退

- 风险是两套 breakdown 生命周期并存，造成重复任务类型、重复节点或价格显示不一致。
- 独占模块可单独撤销；共享 API / runner 必须按拆分提交回退，禁止整文件 restore。

## 进展记录

### 2026-09-18 · 三层提交完成，转真实环境验收

做了什么：按纯领域、后端任务链、前端流式画布拆为三个带 DCO 的提交；共享热点全部按 hunk
暂存，未带入 LibTV 重拍、续写、导入器或 LOD 的剩余工作树差异。

为什么这么改：一条大提交无法安全回退，也会让下一个模型误以为同文件中的所有历史改动都
属于拉片。三层提交把领域算法、任务协议和 UI 生命周期的责任边界固定下来。

怎么验证的：纯领域快照后端 26 passed、前端 14 passed；后端集成快照 62 passed；前端
集成快照 28 passed、i18n 0 命中、`tsc -b` 与 Vite production build 通过。未配置真实视觉
模型与 demucs，故没有把模拟测试冒充端到端验收。

### 2026-09-18 · 前端流式生命周期与计费通过干净构建

做了什么：新增拉片 API 与非终态 `onProgress` 投影；工具条真实提交按钮读取
`freezone.video_analyze` / `video_breakdown` 价格并在规则缺失时禁用；分镜、动态、音乐按
metadata 流式去重落节点；刷新时复位没有恢复句柄的进行态；源节点被删除后静默停止落孤儿
素材；补齐 zh/en/vi 文案。

为什么这么改：任务可能运行数分钟，必须同时覆盖“完成事件早于监听”“SSE 丢一跳”“刷新
后无法恢复”“用户中途删除源节点”四种生命周期。价签必须在真正提交任务的按钮上，不能写
死积分或只显示但仍允许点击。

怎么验证的：从暂存区导出的干净快照运行 4 个前端测试文件共 28 passed；前端 i18n 棘轮
0 命中；`tsc -b` 通过；Vite production build 通过（5404 modules transformed）。

### 2026-09-18 · 后端共享任务契约收口

做了什么：让拉片复用 `freezone.video_analyze` 计费族、operation=`video_breakdown`，
进入 ffmpeg 队列；路由完整传递有边界的镜头数、阈值、时长、维度和模型参数；runner 真正
执行 `max_frames` 的全片均匀上限，并保留细粒度本地 / 出网 leaf 分类。

为什么这么改：此前拉片绕过分析计费且进入默认队列，同时公开的 `max_frames` 参数被忽略，
长片可能无限增加视觉调用和画布节点。复用已有分析任务入口能让权限、计费和队列规则只有
一份事实来源。

怎么验证的：shot 领域、BGM、shot 后端契约和既有 video-story 契约合计 39 passed；首次
暂存快照触发出网/落点护栏 4 项失败后，逐条登记 3 个本地 leaf、5 个调用点、常量 helper
和 placement-free task；修订后从暂存区导出的干净快照 62 passed。相关代码 ruff 检查通过。

### 2026-09-18 · 纯领域层通过回归

做了什么：固化镜头切分、全片均匀 `max_frames` 上限、首尾采样、节点命名与分组布局；
固化 demucs 双轨和显式整轨降级；前端投影增加源节点已删除时不生成孤儿素材的保护。

为什么这么改：原实现接收 `max_frames` 却未执行，长片会无上限地产生视觉调用和节点；简单
截取前 N 镜又只覆盖片头，所以在完整时间序列上均匀取样并保留首尾。拉片是长任务，流式
结果到达前源节点可能被用户删除，此时产物没有合法来源，应静默停止落节点。

怎么验证的：`uv run pytest tests/test_shot_breakdown.py tests/test_bgm_separate.py -q`
26 passed；对应 `uv run ruff check ...` 通过；前端 `shot-breakdown-nodes.test.ts` 14 passed。

### 2026-09-18 · 固化实测证据并完成远端契约审计

做了什么：把 `output/` 下易丢的 LibTV 实测拆解整理为可提交的
`docs/guides/shot-breakdown.md`；逐项比较本地 `freezone_shot_breakdown` 与远端
`freezone_video_breakdown` 的入口、维度、产物、流式生命周期、计费、队列、取消和权限。

为什么这么改：两套实现目标相同但生命周期不同，整文件选边会丢掉本地流式产物、显式 BGM
降级，或重复引入一颗专用拉片节点。最终决定保留本地直接入口和流式素材契约，只吸收远端已
验证的计费、刷新复位与节点删除保护。

怎么验证的：只读审计远端 `be19c5d3` 的后端契约测试、前端计费/生命周期/分组测试及对应
源码；业务代码尚未在本条记录中修改，自动测试待拆提交时执行。

### 2026-09-18 · 补齐拆分边界与机器 scope

做了什么：只更新台账和 scope，将分镜 / BGM 模块与测试标为独占，将 API / runner 与 DA3 标为共享；
没有修改拉片业务代码。

为什么这么做：远端已有另一套 breakdown 生命周期，先锁住纯模块与共享集成层的先后顺序，避免双实现叠加。

怎么验证的：待全局 `agent_guard check` 通过；真实三维度产物本轮未验证。

## 已定下来的决策（不要回头改）

- **拉片产物和 `shotMetadataStore` 里的 `ShotMetadata` 不是同一层东西。**
  后者是**作者意图**（我想把片子拍成什么样），拉片产出的是**反编译结果**（这段参考片实际怎么拍的）。
  素材跟着视频走，挂到哪个生成节点就给那个节点供镜头语言；没挂的仍用全局默认。
  不要试图把两者合并成一张表。
- **归纳这一层用统计，不再套一层模型。** 逐帧结果已经是模型输出，再套一层只会引入新的漂移；
  众数统计是确定性的、可解释的、零成本的。
- **音乐维度允许降级，且降级必须如实上报。** demucs 要拉 torch（起步几个 G），
  为一个可选维度逼所有人装 torch 不合理。没配就降级成整轨提取，`mode` 是**必返字段**，
  调用方据此改节点名，用户一眼看得出手里是伴奏还是原声。**悄悄降级比报错更糟。**
- **不抽整条音轨当配乐参考。** 整轨是「对白 + 音效 + 配乐」，铺到新片上会把原片台词一起铺过去。
  LibTV 实测参数是 `mode: bgm_only`。
- **不引入第二颗专用拉片节点。** 当前视频节点直接入口已经能表达来源；远端专用节点的价值
  在生命周期契约，不在节点类型。吸收刷新复位、删除保护和计费，避免两个入口并存。
- **计费沿用 `freezone.video_analyze`，operation 使用 `video_breakdown`。** 不在前端写死
  积分数；价格规则未配置时必须禁用真实提交按钮。

## 待办

- [x] 把易丢的 `liblib-shot-breakdown-teardown.md` 证据整理进 `docs/guides/shot-breakdown.md`
- [ ] 三个维度各产出一次真实产物并记录：分镜归纳的准确度、深度视频的可用性、
      伴奏轨在装了 / 没装 demucs 两种情况下的表现
- [ ] 确认前端节点名在降级时确实变了（决策里说了要变，没找到验证记录）
- [ ] 真实任务中途刷新一次，确认任务中心可见且画布按钮不会永久锁死

## 阻塞

demucs 未安装 → 音乐维度当前只能验证降级路径，正常路径未验证。

## 验收标准

- `uv run pytest tests/test_shot_breakdown.py tests/test_bgm_separate.py` 全绿。
- 对同一段参考视频跑三个维度，画布上落出三个节点，节点名能区分伴奏 / 原声。
- 归纳出的主导景别与主导运镜，人工看片能认同（长尾噪声被压掉）。

## 交接摘要

- **最后完成到**：三层独立提交和干净快照验证完成；远端重复实现已审计并形成明确保留关系。
- **下一步唯一动作**：配置真实视觉模型后，用同一段 720p 硬切样片跑分镜 / 动态 / 音乐；
  先在无 demucs 环境确认“原声（含人声）”，再配置 `ST_DEMUCS_PYTHON` 确认“伴奏”。
- **先读这些文件**：`docs/guides/shot-breakdown.md`、两个新增后端模块、前端投影模块。
- **不要动这些文件 / 决策**：不要合并作者意图与反编译结果，不要静默降级音乐模式；不要
  从远端整套复制专用拉片节点，除非先废弃当前视频节点直接入口并写迁移方案。
