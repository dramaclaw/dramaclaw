# 命令行 CE 本地栈：local_gateway + 本地 ComfyUI 图像

**状态**：执行中
**最后更新**：2026-09-24
**基线**：`051d3081`；主检出目录 tracked 文件干净，仅保留三类受保护的未跟踪资料
**认领者**：`codex/local-stack-main-integrate-20260924`
**相关文档**：`启动说明.md`（仓库根目录，可移植安装说明）
**相关分支 / PR**：`codex/local-stack-startup-fix`（两阶段修复待移植）

## 目标

不用 Docker 就能在一台开发机上跑起完整 CE：文本 / embedding / 音频走硅基流动，
图像走本机 ComfyUI（Qwen-Image / Krea 2 Turbo Int8），配置与密钥放在一个升级不会覆盖的目录里。

## 非目标

- 不把这套本机路由升级成面向所有 provider 的通用代理。
- 不把作者机器的安装路径、密钥或工作流运行态提交进公开仓库。
- 不在本线改动标准 Docker 部署路径。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `src/novelvideo/local_gateway.py` | 新增 | 本地 OpenAI 兼容路由，自己决定 provider |
| `scripts/start-local-stack.sh` | 新增 | 一键起栈，含 ComfyUI 拉起与等待 |
| `config/local/*.json` | 新增 | 四份已审查的 Qwen / Krea 文生图与图片编辑 API 工作流 |
| `config/local/local.env.example` | 新增 | 无密钥、无机器路径的本机配置模板 |
| `src/novelvideo/config.py` | 修改 | 加 `LOCAL_QWEN_IMAGE_MODEL` / `LOCAL_KREA_IMAGE_MODEL` 两个选择项，`DRAMACLAW_LOCAL_MODELS_ONLY=1` 时只露本地两项 |
| `src/novelvideo/generators/nanobanana_grid.py` | 修改 | 回环地址绕开桌面代理；本地图片编辑改用 multipart，跳过 OSS relay |
| `scripts/start-ce.sh` | 修改 | 保留 wrapper 指定的 API 地址并关闭旧 provisioner |
| `tests/test_local_gateway.py` | 新增 | |
| `tests/test_freezone_image_backend.py`、`test_newapi_image_gateway.py`、`test_image_generation_selection.py` | 修改 | |
| `frontend/src/components/layout/header.tsx`、`components/settings/settings-dialog.tsx` | 修改 | 本地路由健康状态及设置页说明，不再误导用户初始化 NewAPI |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 本地路由设置页三语文案，仅按 key 合并 |
| `src/novelvideo/api/routes/freezone.py` | 修改 | 合并本地模型目录后按已声明的 `sortOrder` 排序 |

`local_gateway.py`、`start-local-stack.sh`、本地工作流模板与 `test_local_gateway.py` 可视为本线独占；
`config.py`、`nanobanana_grid.py`、`start-ce.sh` 是共享基础设施文件。
`frontend/vite.config.ts` 的当前脏改动实际属于 LOD 分包优化，本线只保留保护性 shared claim，禁止随本线提交。

## 协调与冲突

- `src/novelvideo/generators/nanobanana_grid.py` 同时被 `origin/main` 修改。必须先看上游修复语义，
  再把“回环地址绕代理”移植到新基线，不能提交旧文件整段。
- `config/local/community/` 是本机下载的原始参考工作流，不参与运行，已按精确路径忽略；只提交四份最小 API 模板。
- `启动说明.md` 与脚本已不含作者绝对路径；机器值只放 `.dramaclaw-local/local.env`。

## 实施方案（后续）

1. 用一台无作者路径假设的环境按说明启动，记录 ComfyUI、gateway、API 与前端健康检查结果。
2. 记录 Krea 2 Turbo Int8 的机器配置、耗时与质量结论；它仍是实验选项。
3. 后续同步 `origin/main` 时，在新版生成器上同时保留归档直拷与本地 multipart / 绕代理语义。
4. 审计并移植 `13bc829c`、`e5bef904`：仅合入启动器、local gateway 健康身份、聚焦测试、说明和台账；
   不触碰已完成的 creative-intro 代码或三类受保护未跟踪资料。完成后重跑真实重复启动与四端健康检查。
4. 修复一键启动的本机复用与端口预检——完成条件：已有 ComfyUI 时无需 `COMFYUI_DIR` 即可复用；
   默认 API / gateway / 前端端口冲突时选择空闲备用端口，显式配置冲突则清晰失败；实际脚本能启动并通过四个健康检查。

## 风险与回退

- 风险是误提交模型路径 / 密钥，或覆盖上游生成器并发 / 输出路径修复。
- 回退按网关、启动脚本、生成器适配三个独立提交进行；本机私有目录不纳入 Git 回退。

## 进展记录

### 2026-09-24 · 主检出目录集成开始

做什么：确认 creative-intro 工作线已收口、主目录无活动锁且 tracked 文件干净；准备把隔离分支两阶段
启动修复移植到当前 `main`，冲突仅按 hunk 合并台账，不回退 `051d3081` 已完成内容。

为什么：用户已确认主锁释放，需要让日常使用的 `scripts/start-local-stack.sh` 直接获得已实测的服务复用、
并发互斥、TIME_WAIT 处理和无关进程保护，而不是继续依赖隔离 worktree。

怎么验证：隔离分支已完成 12 项测试、重复启动与无关端口占用实测；主线集成后重新执行相同聚焦门禁与真实启动。

### 2026-09-24 · 已有 ComfyUI 复用与端口冲突修复通过实机验收

做了什么：启动器改为先访问 `COMFYUI_BASE_URL/system_stats`，健康时直接复用，不再预先要求
`COMFYUI_DIR`。gateway/API/前端的默认端口在启动前用 socket bind 校验；默认值冲突时在后续
20 个端口中选择第一个空闲值，显式配置冲突则停止并指出具体变量。最终 API 端口同步到
`VITE_API_URL`，避免前端仍代理旧端口。启动说明和聚焦测试同步更新。

为什么这么改：本机 ComfyUI 已经健康运行，旧顺序却先报安装路径缺失；绕过后，Docker 占用默认
API 端口又让旧就绪探测可能读到别的服务。两处都属于“真实依赖可用但启动器判断顺序错误”，不能
靠用户反复试环境变量解决。

怎么验证：`bash -n`、9 项 `test_local_gateway.py`、ruff、agent guard 与 diff 检查通过。实机原样
启动时成功复用既有 ComfyUI，识别默认 API 端口被占并选择下一空闲端口；gateway health、API
config、前端页面、前端到 API 的代理及 ComfyUI system stats 全部返回成功。退出隔离验收栈后，
gateway/API/前端端口均释放，复用的 ComfyUI 保持运行；主检出目录另写入被忽略且不含密钥的本机
配置后，用户原命令也已成功启动并保持运行。

### 2026-09-24 · 一键启动错误复现并进入修复

做什么：原样运行 `bash scripts/start-local-stack.sh`，再绕过首层检查继续验证 gateway、API 与前端。
修复范围只含启动脚本及其聚焦测试，不修改 ComfyUI、网关业务或主工作区在途前端代码。

为什么：本机 `127.0.0.1:8188` 的 ComfyUI 已健康运行，但脚本在健康检查前先要求 `COMFYUI_DIR`，
误报缺配置；继续启动后发现 `8780` 被 Docker 占用，旧就绪探测又可能把占用者误认成本轮 API。

怎么验证：修复前已稳定复现两层错误；修复后计划执行 shell 语法、聚焦 pytest、真实脚本启动、
gateway/API/frontend/ComfyUI 健康检查及退出清理验证。

### 2026-09-19 · 补齐本地路由的目录排序与设置页表面

做了什么：`freezone.py` 在合并本地与默认媒体目录后按 `sortOrder` 保持稳定排序；设置对
`dramaclaw-local-router` 识别为已配置，页头不再显示 OSS relay 警告，设置页改为本地路由摘要并补齐三语。

为什么这么做：本地栈无需 NewAPI 数据库和 OSS relay；此前正确运行时仍提示未配置，且节点会优先落到
远端建议模型，违背本地模式的明确选择。

怎么验证的：claim preflight 通过；`uv run pytest tests/test_freezone_image_backend.py -q` 为 278 passed；
前端 i18n 棘轮为 0 命中，`pnpm exec tsc -b && pnpm build` 通过。真实第二台 ComfyUI 验收仍未完成。

### 2026-09-19 · 重审基线与共享路由边界

做了什么：将基线推进到 `508c9b21`，重审本轮只涉及本地目录排序与设置页；`freezone.py` 的相邻
Depth、拉片和 LibTV endpoint 均未写入。

为什么这么做：先前本线已待验收，继续提交新增用户可见 hunk 前必须重审最新画布与素材替换提交后的边界。

怎么验证的：按 hunk 检查 `freezone.py` 只有 `_merge_media_model_catalog_defaults` 的稳定排序，且 claims 与三个
共享工作线互认；待 guard preflight 继续验证。

### 2026-09-18 · 完成可移植启动配置与回归门禁

做了什么：移除脚本和说明中的作者绝对路径，启动器改为读取被忽略的
`.dramaclaw-local/local.env`；加入无密钥示例和四份最小 API workflow，首次启动自动复制本机副本；
标准 CE 恢复只显示官方模型，本地模式只显示 Qwen / Krea；退出时回收本轮启动的应用进程。
`config/local/community/` 原始参考导出按精确路径忽略，不作为运行依赖提交。

为什么这么做：可迁移配置必须将“代码默认值”和“作者机器事实”分开；同时不能为了本地模式改变标准 CE
的产品列表。把四份运行时 workflow 固化成最小模板后，干净机器不再依赖作者目录里的手工副本。

怎么验证的：四个相关测试文件共 334 passed；ruff 通过；`bash -n` 通过；四份 workflow 均通过 JSON 解析；
脚本、环境示例和说明的 `/Users` / `/home` 扫描零命中；分别在默认环境和
`DRAMACLAW_LOCAL_MODELS_ONLY=1` 子进程断言两组模型列表。尚未在第二台带完整 ComfyUI 模型的机器做真实启动，
因此状态为“待验收”。

### 2026-09-18 · 重审上游重叠与本机配置边界

做了什么：以 `f4db7d2e` 为新基线重审本线全部文件；确认 `origin/main` 对生成器新增的是归档结果直拷、
并发输出隔离等语义，本地新增的是回环绕代理和本地编辑 multipart，功能不同但落在同一函数；检查
`config/local/` 与 `.dramaclaw-local/`，确认密钥只存在被忽略的 secrets 目录，公开模板没有作者绝对路径。

为什么这么做：Story 提交后旧基线失效，守卫按设计阻止继续写；生成器若按整文件取舍，会在本地路由能力和
上游归档修复之间二选一，必须记录成未来同步时的双向保留项。

怎么验证的：相关 332 项测试运行到 331 passed / 1 failed；唯一失败是标准 CE 被错误暴露本地 Qwen 选项，
已定位为 `VISIBLE_IMAGE_GENERATION_SELECTION_KEYS` 的默认分支。ruff 另发现一处新测试未使用导入；
`bash -n` 与三份运行时 workflow JSON 解析通过。机器路径扫描只命中启动脚本和旧说明，正是本轮要拔除的内容。

### 2026-09-18 · 补齐基础设施边界与机器 scope

做了什么：只更新台账和 scope，区分本线独占的 gateway / launcher / workflow 与共享的配置、生成器和启动文件；
没有修改本地栈业务代码或私有配置。

为什么这么做：基础设施文件很容易被相邻任务顺手覆盖，机器 scope 必须在继续可移植性改造前先建立。

怎么验证的：待全局 `agent_guard check` 通过；本轮没有重跑本地栈。

## 已定下来的决策（不要回头改）

- **路由自己拥有 provider 选择权**，不做成可配置的通用代理。硅基流动管文本/embedding/音频，
  本机 ComfyUI 管 Qwen Image，写死在代码里。
- **密钥与工作流副本放在用户自管、被 gitignore 的目录**（`.dramaclaw-local/`），
  升级 DramaClaw 不会替换它们。
- **数据目录沿用已有 `./state`**（如果存在），不强制迁移。
  否则老用户切到这个 wrapper 会以为项目消失了；新装才用 `~/.local/share/dramaclaw-local`。
- **回环 HTTP 必须绕开桌面代理**。走代理会让本机 ComfyUI 请求打不通。
- **macOS 上设 `PYTORCH_ENABLE_MPS_FALLBACK=1`**：MPS 后端缺 Krea ConvRot 权重用的 int8 矩阵算子。

## 待办

- [x] 机器专属路径已移到 `.dramaclaw-local/local.env`，tracked 文件不再包含作者路径
- [x] 启动说明已补齐依赖、密钥放置、启动 / 停止、健康检查、数据目录与排错步骤
- [ ] Krea 2 Turbo Int8 标着「Mac 实验」，实验结论没记录——能不能用、慢多少、质量如何

## 阻塞

代码无阻塞；最终验收需要另一台装好对应模型 / 节点的 ComfyUI 机器。

## 验收标准

- 在一台干净的机器上照 `启动说明.md` 能起起来（待外部环境验收）。
- [x] 当前机器不配置 `COMFYUI_DIR` 也能复用健康 ComfyUI，并在默认 API 端口冲突时完整启动。
- `uv run pytest tests/test_local_gateway.py` 全绿。
- `DRAMACLAW_LOCAL_MODELS_ONLY=1` 时设置面板里只出现本地两个图像选项。

## 交接摘要

- **最后完成到**：可移植配置、四份运行模板与 334 项回归测试已完成；标准 CE 模型列表未被污染。
- **下一步唯一动作**：在第二台装好 ComfyUI 模型 / 节点的机器按说明真实启动并记录四个健康检查。
- **先读这些文件**：`local_gateway.py`、`start-local-stack.sh`、`启动说明.md`、上游生成器 diff。
- **不要动这些文件 / 决策**：不要把路由泛化；不要整文件覆盖 `nanobanana_grid.py`。
