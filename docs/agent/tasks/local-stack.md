# 命令行 CE 本地栈：local_gateway + 本地 ComfyUI 图像

**状态**：待验收
**最后更新**：2026-09-27
**基线**：`945baa9f`；刚完成集成的codex/sync-main-remotes，主目录main及其既有未提交文档不动。
**认领者**：`codex/local-restart-20260927`
**相关文档**：`启动说明.md`（仓库根目录，可移植安装说明）
**相关分支 / PR**：`main`（`54b7e30e`、`5cb7af29`）；来源分支 `codex/local-stack-startup-fix`

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

- 2026-09-27：pending-code-checkpoint 在本线之后串行追加 `.gitignore` 精确规则，排除用户凭据附件和未提交本地工作流；当前会话集成，只提交已有代码。

- 2026-09-26 与 `text-node-liblib-visual-parity` 串行共享 local gateway and Freezone route：该线只修改 DeepSeek 文本模型选择与透传，由其集成；本线原有功能及写入边界保持不变。

- 2026-09-26：tv-director-implementation持唯一锁串行集成`config.py`回环文本HTTP代理默认行为，发现真实模型请求受系统代理影响；本线现有wildcard shared claim允许，最终集成/测试归Director线。仅默认loopback绕代理，显式NEWAPI_TEXT_TRUST_ENV与远端保持原逻辑；不修改本线gateway/启动器/凭据及其他图像配置。

- `src/novelvideo/generators/nanobanana_grid.py` 同时被 `origin/main` 修改。必须先看上游修复语义，
  再把“回环地址绕代理”移植到新基线，不能提交旧文件整段。
- `config/local/community/` 是本机下载的原始参考工作流，不参与运行，已按精确路径忽略；只提交四份最小 API 模板。
- `启动说明.md` 与脚本已不含作者绝对路径；机器值只放 `.dramaclaw-local/local.env`。

## 2026-09-26 Krea 本机接通方案

- 用户授权接通图片节点的本机 Krea2 并实际测试生成；复用现有 ComfyUI，任务按队列执行。
- 证据：运行服务只有 Krea2 FP8，现有本地副本要求 INT8；编码器、VAE、Qwen 编辑及 Lightning LoRA 都存在。bootstrap 还会把 FP8 副本覆盖为 INT8，违反保留用户工作流的既有决定。
- 写入：共享 `local_gateway.py` 仅初始化复制策略和模型标签；共享 `src/novelvideo/config.py` 仅 Krea 标签；独占 `tests/test_local_gateway.py`，共享 `tests/test_image_generation_selection.py` 仅同步 Krea 标签断言；忽略目录两份 `krea2_turbo_*_api.json` 仅模型文件名及必要运行兼容修复，先备份。台账/STATE 同步。保留文本模型透传 hunks，不改画布布局/节点数据。
- 顺序：修复 bootstrap 只为缺失文件创建副本；改为通用本地 ComfyUI 标签；本机两份副本指定已安装 FP8；跑针对性测试；通过运行网关提交文生图及引用图编辑并检查真实产物。
- 重叠：本地远端引用中 origin/main 只有原 gateway 提交；当前未提交 gateway hunk 全部来自文本节点模型透传，串行保留。无其他锁。
- 风险/回退：公开文件不写机器绝对路径或密钥；备份本地 JSON 后可逐文件恢复。已有自定义工作流不再隐式升级，结构兼容错误应显式处理。保留已运行的 H3 任务。
- 验证：pytest tests/test_local_gateway.py；ruff 针对改动文件；实际网关图片生成/编辑，记录分辨率、种子、状态、耗时与产物。安全钩子尝试因当前 venv 缺 pre_commit 未执行，继续寻找本机现有工具。

## 2026-09-26 独立“编辑”工作流

用户明确要求另加“编辑”且不改变原工作流。新增独立模型 ID `Krea-2-Identity-Edit-local`、目录标签“编辑”，单独 API JSON；旧 Krea 文生图/Qwen+Krea 编辑及其副本全部保持。现有本机 Identity Edit v1.2 LoRA、GroundedEncode 和 ModelPatch 节点齐全。单图编辑本图；双图遵循本机工作流的训练顺序：图1场景、图2角色。最多2图，无图拒绝，禁止静默降级文生图。

本轮写入仅 `local_gateway.py`、`config.py`、`generators/nanobanana_grid.py` 的本地模型白名单（让新编辑模型走 multipart，不误用 OSS relay）、新增 `config/local/krea2_identity_edit_api.json` 和忽略副本、台账/claims/STATE。保留已有脏改动；远端引用未发现同类实现。默认沿用本机样例 10步/CFG1/LoRA1/ref_boost4，grounding768。通过新模型独立路由、重启目录可见性和一张对比产物验收；原文件哈希前后保持。回退删除新模型目录条目与新增分支即可，不改已有用户选择。接口复用既有 multipart，不扩展公用API合同。

## 实施方案（后续）

### 2026-09-27 · 用户要求重启项目

本机四端均无监听，实际网络健康检查也连接失败，无需终止其他进程。用户随后明确选择945baa9f；复用主目录既有配置/数据与.env，不切换主目录分支、不迁移项目、不运行付费生成、不修改业务代码。目标worktree没有.env/.venv：.env仅用被忽略的符号链接复用；独立.venv按现有uv.lock以frozen/dev安装并复用缓存，不改主目录共享虚拟环境（目录型ignore不适合.venv符号链接）。明确数据/配置目录并让当前分支使用自己的src；沿原start-local-stack脚本启动ComfyUI、gateway、API和前端，使用既有8781/5173/3001/8188端口。

本轮手工跟踪写入仅STATE/本台账/同名claim的运行交接；日志和链接属于忽略运行态，不提交凭据或机器路径。先核验原配置和工具可用性、无端口所有者，再启动；健康验收为四端及前端代理HTTP200、API项目读取恢复，进程cwd和源模块指向目标版本。若启动失败只处理本次启动进程，保留原配置和数据，说明真实失败，不清库、不重置；未复验图片/视频供应商效果。停止可以在本次启动终端Ctrl+C，脚本只收回自己启动的进程。

1. 用一台无作者路径假设的环境按说明启动，记录 ComfyUI、gateway、API 与前端健康检查结果。
2. 记录 Krea 2 Turbo Int8 的机器配置、耗时与质量结论；它仍是实验选项。
3. 后续同步 `origin/main` 时，在新版生成器上同时保留归档直拷与本地 multipart / 绕代理语义。
4. 审计并移植 `13bc829c`、`e5bef904`：仅合入启动器、local gateway 健康身份、聚焦测试、说明和台账；
   不触碰已完成的 creative-intro 代码或三类受保护未跟踪资料。完成后重跑真实重复启动与四端健康检查。
5. 修复一键启动的本机复用与端口预检——完成条件：已有 ComfyUI 时无需 `COMFYUI_DIR` 即可复用；
   默认 API / gateway / 前端端口冲突时选择空闲备用端口，显式配置冲突则清晰失败；实际脚本能启动并通过四个健康检查。
6. 补齐二次启动幂等性——完成条件：目标 `3001` 已是健康 DramaClaw local gateway 时直接复用，
   不再重复绑定；非目标服务占用时不得误判为可复用实例。
7. 补齐并发启动互斥——同一配置目录只能有一个 launcher 管理进程；第二次执行等待首个实例完成启动，
   健康后直接报告复用，失效锁可安全接管，避免两个脚本分别抢到 gateway/API/frontend 的一部分。

## 风险与回退

- 风险是误提交模型路径 / 密钥，或覆盖上游生成器并发 / 输出路径修复。
- 回退按网关、启动脚本、生成器适配三个独立提交进行；本机私有目录不纳入 Git 回退。

## 进展记录

### 2026-09-27 · 最新同步分支启动并恢复原数据

用户明确选择945baa9f版本。启动前四端实际均未监听；独立worktree以 `uv sync --frozen --group dev` 安装194个锁定包，.env只链接原文件，配置和数据目录明确指向原主目录，未迁移或清空数据库。按原 `bash scripts/start-local-stack.sh` 拉起ComfyUI/网关/API/前端，运行目录核验为该worktree及其frontend，项目代码无改动。

实际健康结果：8188/system_stats、3001/healthz、8781/api/v1/config、5173首页与5173/api/v1/config均HTTP200，网关ok=true且密钥配置存在（未输出值）；项目接口HTTP200，按真实data字段读取6个原有项目。未创建任何生成任务。日志保存在被忽略的本机配置目录；部分ComfyUI插件缺triton、AppleSilicon-FP8加速内核编译失败而禁用，服务已就绪，但依赖这些插件的具体图片工作流未测，不宣称全部图像功能验收。用户新增要求同步主目录main，由sync-main-remotes线另行保护原5份未提交交接后执行；本线只提交运行交接，不复制环境、日志或凭据。

### 2026-09-26 · 按用户要求排除工作流 JSON 后提交

用户要求工作流 JSON 不提交，其余代码提交。首次 acquire 因 STATE 状态未同步被拒绝；调用编排未及时阻止可选条件补丁，已停止后续写入并同步状态、重新 acquire/preflight 审查精确 diff。提交前将 Identity Edit bootstrap 改为模板存在才可复制，且只有本地工作流文件就绪才新增模型目录项，防止其他机器因未提交模板而启动失败；本机副本和原流程继续保留。只写 local_gateway.py 两个可选配置条件及本台账；已完成可选配置条件；依赖关系以静态 diff 审查，不重跑测试。补齐状态后 acquire/preflight 已通过，补丁已核对。工作流 JSON 保留为本地未跟踪文件，不进入暂存区。现有待提交代码按画布布局、文本节点、本地 Krea 三条线拆分，协调台账独立提交；不推送远端。

### 2026-09-26 · 新增独立“编辑”入口（Krea2 Identity Edit）

新增独立 `Krea-2-Identity-Edit-local` 目录项，标签“编辑”，单独 `config/local/krea2_identity_edit_api.json` 和忽略副本。旧 Krea 文生图及 Qwen/Krea 组合流程保留，旧副本 SHA256 前后相同。共享生成器仅增加新模型本地 multipart 识别及宽高透传，避免走 OSS；默认模型未改。单图直接编辑；双图训练顺序为场景先、角色后，最多2张，缺图/超量显式拒绝。

新工作流为 Krea2 FP8 + Identity Edit v1.2 LoRA，10步/CFG1/LoRA1/ref_boost4/grounding768。单图已通过实际运行网关生成：768×768，seed260927，与上一轮同图同提示词，HTTP200，56.9秒；Comfy prompt `e3d0a450-c0d9-4041-92b9-9867c319b770` completed/success。已查看产物，木凳场景生效，角色外观较接近原图，仍有局部重绘，不能据此保证角色完全一致。产物 `.dramaclaw-local/tests/krea-20260926/identity-edit-0.png`。双图分支依据本机节点 schema 和原生工作流接线，未实际出图验收。

运行目录已返回新模型“编辑”及 referenceImageMax=2；原模型条目保留。没有修改画布内容/布局。guard/diff检查通过，本轮未新增或运行单元测试，上一轮63项结果不冒充本轮回归。原安全钩子安装问题见上一条记录。应用栈重启以加载新增本地上传白名单及宽高透传；ComfyUI继续复用。


### 2026-09-26 · Windows 本机 Krea2 FP8 文生图 / 参考图编辑实测成功

做了什么：保留文本模型工作线的网关改动，仅将 Krea 本机两份工作流映射到已安装 FP8，原件备份到忽略目录。bootstrap 改为仅复制缺失副本，避免每次启动将 FP8 强制换回 INT8；Krea 默认及历史自动标签统一为本地 ComfyUI，用户自定义标签仍保留。未直接编辑任何画布数据。

为什么：本机 RTX 5070 Ti（16 GB）有 Krea2 FP8、Qwen3VL 4B 编码器及 Qwen Image VAE，但没有旧模板的 INT8 文件。纯文生图走 Krea；参考图沿用既有 Qwen Image Edit 2511 Q4 + Lightning 4 步，再 Krea 8 步 / denoise 0.42 细化的组合。

怎么验证：真实运行网关 `/v1/images/generations`（768×768，seed 260926，8 步）HTTP 200，42.6 秒；`/v1/images/edits` 上传上一张图（768×768，seed 260927）HTTP 200，193.5 秒。Comfy 两项均 completed/success：`08b0475d-9e0f-4423-8105-15046c65a6e0`、`4a498052-5764-4019-91ee-8d3be8d90184`。已查看两张产物，青蛙身份大体保留、苔石成功换成木凳。请求、响应、history 和图片存于忽略目录 `.dramaclaw-local/tests/krea-20260926/`。这是运行网关实测，未从浏览器点击图片节点提交。

回归：`pytest tests/test_local_gateway.py tests/test_image_generation_selection.py tests/test_newapi_image_gateway.py -q` 为 63 passed；ruff 通过；guard 为 20 workstreams / 518 claims。首次模型目录回归仅因旧标签断言失败，更新对应断言后全部通过。重启应用栈后 gateway/API/frontend 全部 200，图片目录已返回新标签，两份 JSON 仍为 FP8；ComfyUI 原进程复用。

安全钩子：已尝试执行；首次缺 pre_commit，随后改用忽略目录工具环境。Git Schannel 失败后本命令使用 OpenSSL 完成仓库初始化，但 gitleaks 环境反复停留在安装阶段，无扫描完成结果，已中止安装。该钩子未验证；代码未新增任何密钥或机器路径，工作流及图片均保持忽略状态。

后续：本机 FP8 功能已完成；Mac INT8 性能及完全干净新机器安装仍待独立验收。模型替换仅本机工作流副本，公开 INT8 模板保持原样；启动配置不会再自动覆盖已有副本。


### 2026-09-24 · 主检出目录集成与重复启动验收完成

做了什么：在 creative-intro 工作线收口、主目录锁释放后，将隔离分支两阶段修复按 hunk 移植到
当前 `main`；保留 `051d3081` 的 creative-intro 完成记录与三类受保护未跟踪资料，没有覆盖相邻业务代码。

为什么：用户已确认主锁释放，需要让日常使用的 `scripts/start-local-stack.sh` 直接获得已实测的服务复用、
并发互斥、TIME_WAIT 处理和无关进程保护，而不是继续依赖隔离 worktree。

怎么验证：main 上 12 项聚焦测试、bash、ruff、pre-commit 与 guard 全绿。原命令首次启动后，
`3001/8781/5173/8188` 四端和前端 API 代理均健康；第二次执行同一脚本识别 PID `37604`，输出
“Reusing the running local stack”并以 0 退出，未产生第二次 bind。最终服务保持运行供用户直接使用。

### 2026-09-24 · 二次启动复用与并发互斥通过实机验收

做了什么：local gateway 健康响应加入不泄露路径的配置实例标识；启动器只复用同一配置实例，
同目录失去健康响应的旧 gateway 可正常终止后重启，无关服务一律不杀。配置目录增加原子启动锁，
第二次命令等待首个实例健康后直接返回复用结果。端口探针启用 `SO_REUSEADDR`，不再把 `TIME_WAIT`
误报为活动监听者。

为什么：首次验收栈与用户命令发生重复启动后，出现过 gateway `3001` 重复 bind；进一步并发复现时，
两个脚本分别抢到 gateway 与 API/frontend，形成残缺栈。只做端口预检存在检查到 bind 的竞态，
而无条件杀端口进程会误伤其他项目，因此必须同时有实例身份、所有权校验与启动互斥。

怎么验证：12 项 `test_local_gateway.py`、bash 语法、ruff 与 diff 检查通过。真实完整栈在
`3001/8781/5173/8188` 四端健康；运行中第二次执行输出“Reusing the running local stack”并以 0 退出，
没有第二次 bind。另用临时 HTTP 服务占用 `3015`，脚本明确拒绝复用且不终止该进程，退出时原子锁已释放。

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

- **最后完成到**：2026-09-27按用户选定945baa9f重启成功，四端/前端代理HTTP200且原6项目可读取；未生成媒体。旧Windows图像验收与本机Mac插件警告分开保留。
- **下一步唯一动作**：用户访问5173使用已启动工作台；需要Mac具体图片工作流时先确认triton/FP8插件兼容，不将服务健康等同图片效果通过。
- **先读这些文件**：`local_gateway.py`、`start-local-stack.sh`、`启动说明.md`、上游生成器 diff。
- **不要动这些文件 / 决策**：不要把路由泛化；不要整文件覆盖 `nanobanana_grid.py`。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。

### 2026-09-26 · 时间分镜拆分协调

本线先完成，video-prompt-split 后串行集成，保留原功能；当前会话集成共享路径：frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。

2026-09-26 协调：h3-prompt-optimizer 在既有模型选择上串行加入 gateway SSE 透传与回归；最终集成由 H3 工作线负责，不改其他网关行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：src/novelvideo/local_gateway.py, src/novelvideo/generators/nanobanana_grid.py, frontend/src/components/settings/settings-dialog.tsx, frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json, src/novelvideo/api/routes/freezone.py。

2026-09-27 协调：multi-provider-models 后续串行补齐云视频首帧直传和严格路由测试，保留其他路径。
