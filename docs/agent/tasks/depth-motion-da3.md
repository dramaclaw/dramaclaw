# 画布深度动作参考：Depth Anything 3

**状态**：执行中
**最后更新**：2026-09-18
**基线**：`246ad1634162`；本地未提交；共享适配层与 shot-breakdown、远端重拍分支重叠
**相关文档**：`docs/guides/depth-motion-da3.md`（模型边界、执行链路、API、参数依据）
**相关分支 / PR**：无，工作区未提交

## 目标

画布视频节点上「逐帧拉片」的动态维度：产出一段近白远黑的灰度深度视频，
作为下游生成的空间结构与动作参考。**不是** BVH/SMPL 骨骼，不输出米制测距，
也不保证下游生成器按像素级遵从——这条边界要在 UI 文案里守住。

## 非目标

- 不输出 BVH / SMPL 骨骼，不承诺米制深度，也不把整套拉片三维度都归入本线。
- 不在本轮替换远端分支已有的浏览器端 depth capture；先明确它与服务端 DA3 的产品边界。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `src/novelvideo/freezone/depth_motion.py` | 新增 | 隔离启动子进程与取消 |
| `src/novelvideo/freezone/depth_motion_worker.py` | 新增 | 模型加载、场景分段、量化、导出 |
| `src/novelvideo/api/routes/freezone.py` | 修改 | 项目权限与产物 URL |
| `src/novelvideo/api/schemas.py`、`api/routes/tasks.py` | 修改 | 请求 schema 与任务中心名称 |
| `src/novelvideo/task_backend/runners/freezone.py` | 修改 | 本地 leaf 分类 |
| `frontend/src/features/canvas/nodes/VideoNode.tsx` | 修改 | 画布交互与任务恢复 |
| `frontend/src/features/canvas/domain/canvasNodes.ts`、`frontend/src/api/ops.ts` | 修改 | 节点持久字段与 API 客户端 |
| `src/novelvideo/freezone/video_node.py` | 修改 | 深度参考进入全能视频时的结构语义 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | Depth UI 三语词条，只按 key 合并 |
| `tests/test_depth_motion_limits.py`、`tests/test_freezone_depth_motion.py` | 新增 | |
| `frontend/src/__tests__/api/freezone-depth-motion.test.ts` | 新增 | |

新增的 `depth_motion*.py` 与三份聚焦测试是本线独占。API schema / route / runner、节点契约、
`VideoNode.tsx`、API client 与三语 locale 是共享文件，只能按 Depth hunk 与 shot-breakdown / LibTV 线串行集成。

## 协调与冲突

- shot-breakdown 同时修改 `src/novelvideo/api/routes/freezone.py` 与
  `src/novelvideo/task_backend/runners/freezone.py`；接口与 leaf 分类应先确定共同 schema，再串行落代码。
- `origin/feat/canvas-video-reshoot-breakdown` 已包含另一套前端 depth capture，并改同一批 API / runner / VideoNode。
  两者可能是浏览器端局部深度与服务端 DA3 视频的互补能力，也可能产品入口重复；未审计前不得互相替换。
- `freezone.py` 还被 `origin/main` 修改。最终集成顺序：先同步 API 基线，再合 shot 公共契约，最后接 DA3 leaf。

## 实施方案（后续）

1. 只读比较远端 depth capture 与 DA3 的输入、产物、执行位置和 UI 入口，确认互补 / 取代关系。
2. 与 shot-breakdown 共用的 schema、任务类型、runner 分类先写成一份集成决定，再拆独占模块提交。
3. 在模型环境真跑 480p / 720p，记录性能、黑边、硬切和方向；通过后再标完成。

## 风险与回退

- 风险是把两套同名“深度动作”误合成一个协议，导致前端期望的浏览器产物与服务端 manifest 不兼容。
- 独占模块可按本线提交撤销；共享路由与 runner 不得整文件回退。

## 进展记录

### 2026-09-18 · Depth 全契约通过，先拆纯模块提交

做了什么：运行 DA3 的纯函数、真实 FFmpeg 三帧 fixture、路由 / runner 合同和前端 API 合同；同时把
早期误标为单线独占的 `schemas.py`、`ops.ts`、`canvasNodes.ts` 改成 Depth / 拉片 / LibTV 互认共享，
并把 `video_node.py` 与两份全局 runner 护栏测试从历史未归属区转回 Depth。

为什么这么做：17 项契约虽然全绿，但共享文件混有三条线的相邻 hunk；先提交 DA3 子进程、worker、
技术方案和纯资源上限测试，能获得可恢复基点，再在下一提交逐 hunk 集成 API / UI，避免夹带拉片与 LibTV。

怎么验证的：`uv run pytest tests/test_depth_motion_limits.py tests/test_freezone_depth_motion.py -q`
通过（15 passed）；`pnpm exec vitest run src/__tests__/api/freezone-depth-motion.test.ts` 通过（2 passed）；
ruff 通过。第一笔提交只以 `tests/test_depth_motion_limits.py` 作为纯模块门禁；其余集成测试留给下一笔共享层提交。

### 2026-09-18 · 确认浏览器 DA2 与服务端 DA3 是互补能力

做了什么：重审 `origin/feat/canvas-video-reshoot-breakdown` 的 depthCapture 目录、worker、节点体与测试，
并与本线 DA3 子进程链路逐项对比。远端能力在浏览器 Web Worker 中跑 Depth Anything V2 Small，结果作为
Blob 上传；本线在受控 CUDA worker 上跑 DA3-SMALL，输出 MP4 + manifest 和镜头级一致性处理。

为什么这么做：两者虽然都叫“深度动作”，但执行位置、模型、产物协议和适用场景不同。结论是保留两个入口：
浏览器 DA2 用于短片即时、无服务端模型环境；服务端 DA3 用于受控环境的较高质量、可追溯产物。不能互相覆盖，
共享 UI 需用清晰的能力名和环境可用性区分。

怎么验证的：用 `git ls-tree` / `git grep` 只读审计远端分支的 5 个 depthCapture 模块、3 份测试、
`DepthCaptureBody.tsx` 与 `VideoNode.tsx` 接入；确认远端没有服务端 DA3 worker / manifest 协议，
本线也没有浏览器 WebGPU / WASM worker。尚未修改共享适配层。

### 2026-09-18 · 补齐共享边界与机器 scope

做了什么：只更新台账和 scope，明确 DA3 独占模块、与 shot 共用的 API / runner、
与 LibTV 共用的 VideoNode；没有修改深度业务代码。

为什么这么做：两套 depth 能力和两条拉片线同时触及共享适配层，必须先让 guard 识别重叠并阻止并发写。

怎么验证的：待全局 `agent_guard check` 通过；DA3 真机仍未验证。

## 已定下来的决策（不要回头改）

- **默认 DA3-SMALL（0.08B，Apache 2.0）**，备选 DA3-BASE（0.12B，同许可证）。
  **不默认引入 Large/Giant**——非商业许可。
- **DA3 的 `Prediction.depth` 是 z-depth（值大表示远）**，不能套用 DA2 的「值大表示近」转换。
  这是最容易踩错的一条。
- **导出分辨率确定性给定**：480p = 832×480，720p = 1248×720。
  不要把模型的 `process_res=504` 和导出分辨率混为一谈。
- **推理进程不在 API 进程里导入 torch**，走独立解释器子进程（`ST_DA3_PYTHON`）。
- **任务不临时联网下载权重**，模型位置是运维配置（`ST_DA3_MODEL_DIR`），永远不是用户输入。
- **GPU/world 任务与其他重任务共享容量**，保留单并发和排队上限。

## 待办

- [ ] 在配好 `ST_DA3_MODEL_DIR` / `ST_DA3_PYTHON` 的机器上真跑一次，记录：
      单镜头耗时、显存占用、黑边检测是否正确、硬切检测是否漏切
- [ ] 确认 480p / 720p 两档在非 26:15 画幅的源片上的行为（文档里的档位是按那个样本推的）

## 阻塞

本机是否配了 `ST_DA3_MODEL_DIR` / `ST_DA3_PYTHON` 未记录。没有权重就只能跑单测，跑不了链路。

## 验收标准

- `uv run pytest tests/test_depth_motion_limits.py tests/test_freezone_depth_motion.py` 全绿。
- 对一段含硬切的源片跑 720p，产出的 MP4：近白远黑、无音频、帧数与源片一致、黑边处是远景（0）。
- 派生节点带 `referenceOnly` / `depthMotionRole` / `depthManifestUrl`，
  连入全能参考的视频节点后 role 为 `depth_motion`。

## 交接摘要

- **最后完成到**：一期服务端 DA3 链路和单测已在本地，真机与远端同类能力未审计。
- **下一步唯一动作**：比较远端 depth capture 与本地 DA3 的契约和入口，形成保留关系。
- **先读这些文件**：`docs/guides/depth-motion-da3.md`、两个 `depth_motion*.py`、远端 depthCapture 目录。
- **不要动这些文件 / 决策**：不要改 z-depth 方向、许可证模型选择和子进程隔离决定。
