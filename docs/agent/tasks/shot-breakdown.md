# 逐帧拉片：分镜 / 动态 / 音乐三维度

**状态**：待验收
**最后更新**：2026-09-18
**基线**：`38484897`；本地未提交；共享 API / runner 与 depth、远端重拍分支重叠
**相关文档**：`output/local/liblib_canvas_import_review/liblib-shot-breakdown-teardown.md`
（LibTV 侧实测拆解，**不在 git 里，随时会丢**）；动态维度另见 `docs/guides/depth-motion-da3.md`
**相关分支 / PR**：无，工作区未提交

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

## 实施方案（后续）

1. 先把易丢的 LibTV 拉片取证移入 `docs/guides/`，固定需求证据。
2. 做本地与远端 breakdown 契约表：请求、任务状态、产物节点、计费、权限、取消 / 恢复。
3. 确认保留关系后，先拆纯函数 / 纯模块与测试，再由一个集成者处理共享 API / runner。
4. 真跑分镜、音乐正常 / 降级、动态三条路径，记录结果后收线。

## 风险与回退

- 风险是两套 breakdown 生命周期并存，造成重复任务类型、重复节点或价格显示不一致。
- 独占模块可单独撤销；共享 API / runner 必须按拆分提交回退，禁止整文件 restore。

## 进展记录

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

## 待办

- [ ] 把 `liblib-shot-breakdown-teardown.md` 从 `output/` 挪进 `docs/guides/`，
      它是取证结果不是运行产物，放在 gitignore 的目录里等于随时会丢
- [ ] 三个维度各产出一次真实产物并记录：分镜归纳的准确度、深度视频的可用性、
      伴奏轨在装了 / 没装 demucs 两种情况下的表现
- [ ] 确认前端节点名在降级时确实变了（决策里说了要变，没找到验证记录）

## 阻塞

demucs 未安装 → 音乐维度当前只能验证降级路径，正常路径未验证。

## 验收标准

- `uv run pytest tests/test_shot_breakdown.py tests/test_bgm_separate.py` 全绿。
- 对同一段参考视频跑三个维度，画布上落出三个节点，节点名能区分伴奏 / 原声。
- 归纳出的主导景别与主导运镜，人工看片能认同（长尾噪声被压掉）。

## 交接摘要

- **最后完成到**：三维度本地实现和单测在，真实产物、远端重复实现与集成策略未验收。
- **下一步唯一动作**：把 `liblib-shot-breakdown-teardown.md` 移入 guides 后，制作远端 / 本地契约差异表。
- **先读这些文件**：易丢取证文档、三个新增模块、远端 video breakdown 测试。
- **不要动这些文件 / 决策**：不要合并作者意图与反编译结果，不要静默降级音乐模式。
