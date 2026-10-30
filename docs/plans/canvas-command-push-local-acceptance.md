# 画布命令推送：本地验收与发布准备

日期：2026-10-30。实施分支：`feat/canvas-command-push`。

最新范围说明：用户已明确不考虑 3060。本轮代码整改和本地验证已完成；
下文未部署、未实机验收等为事实记录，不再作为本轮未完成项。
稳定后的兼容清理仍保留后续执行，不提前删除回退机制。

本地实现与定向验收完成。未部署；Linux / 3060 同款内核与文件系统、实际入口、
真实磁盘压力及线上稳定性尚未验收。实施清单中这些项目保持未勾选。

## 基线与提交

实施前已重新 fetch `origin/staging`，基线仍为 `30c7afae`。
工作在清单指定的独立 worktree；根工作区已有的 Dockerfile、CLAUDE.md、
诊断脚本等其它修改未纳入。适用独立 worktree 的 AGENTS.md。

| 提交 | 内容 | 对应步骤 |
| --- | --- | --- |
| `d2e3281d` | 只读 bridge、独立过期、TTL、提交后原子信号、结果等待 | 2、4 |
| `73a6aafc` | 共享监听、目录快照、deadline / 对账调度、空闲诊断脚本 | 5、6 |
| `df354c56` | 旧轮询同步 IO 有界执行、旧 JSON 导入后的原子领取 | 3 |
| `f6c8a9dc` | Cookie 鉴权 SSE、订阅过滤及连接清理 | 7 |
| `db1cafb0` | WebSocket 各 bridge 通道共用 hub | 8 |
| `4d30ece3` | EventSource、退避、回退、agent 变化和页面生命周期 | 9 |
| `3e51f02c` | 读取 agent 存储不触发重连递归，增加真实存储集成回归 | 9 |
| `bcc890f4` | 监听降级恢复、取消清理、故障与锁竞争回归、诊断指标 | 6、10 |

步骤 2 与 4 共用一次 bridge 提交；后续各通道独立提交，便于审阅和回退。
没有新增运行依赖；`watchfiles`、`anyio`、`sse-starlette` 已在现有依赖中。

## 实现边界

- SQLite 仍是事实来源。只读读取不创建存储、不清理记录、不发送信号。
- 写事务提交后，以临时文件加原子替换发送 `canvas_command.signal`；通知失败不撤销成功写入。
  JSON 镜像写完后再通知，补齐兼容写入窗口。
- `canvas_command` 业务 TTL 为 600 秒；领取时在取得 SQLite 写锁后重新检查。
  15 秒投递租约及至少一次投递语义不变。
- 每 worker 一个 hub，一个聚合 `awatch`。同目录所有订阅共享只读快照，
  不因 SSE / WebSocket 连接数量增加数据库读取。
- 原生监听启动时主动替换信号，确认收到事件后补拉；繁忙目录不依赖空闲回调确认启动。
  只监听信号及旧 `*.pending.json`，过滤数据库事件。
- 正常模式每目录 30 秒对账；只在已知业务期限到达时执行过期事务。
  租约到期重新唤醒；过期租约不会形成忙循环。
- 原生异常或启动探针失败时降级为 10 秒检查，包括旧 JSON；重建监听并验证成功后恢复。
  已验证的监听空闲不会因为“没有事件”进入降级。
- WebSocket 命令、上下文、skill studio、澄清通道均使用 hub，避免遗留通道继续每 0.4 秒扫描。
  旧 JSON 清理、陈旧判断与投递标记都在有界线程中；导入旧命令时保留原业务年龄。
- 旧 POST 接口保留。其目录解析、SQLite、glob、stat 整体在线程中执行，
  只在发现已过期记录时执行独立过期处理。
- SSE 复用项目授权和 `st_session` Cookie；只领取外部 MCP 命令；事件 ID 为 bridge_key，
  使用原 frame、25 秒心跳，禁用缓存和代理缓冲。
- 前端每画布一条 EventSource；隐藏不主动断开，恢复前台重新补拉；agent 变化重建。
  手动退避为 1、2、5、10、20、30 秒；连续三次错误后开始每 5 秒旧接口轮询。
  原生 EventSource 不提供 HTTP 状态，因此旧后端 404 通过连续错误路径回退。
- 原有 `service.py` 的最长 600 秒等待已用独立 `asyncio.to_thread`，保持不变；
  不占 hub 的 CapacityLimiter。未增加 applying 或无人打开画布时执行的能力。

## 本地验证

Python 环境复用已有环境，并显式使用本 worktree 的 `src`。
前端用锁文件安装依赖。现有 Cognee 会主动覆盖加载宿主 `.env`，
因此测试显式设置 `PYTHON_DOTENV_DISABLED=1`，避免开发机生产配置污染。

最终后端定向集覆盖下列文件：

```bash
PYTHON_DOTENV_DISABLED=1 PIKO_WORLD_BACKEND=demo PYTHONPATH=src python -m pytest \
  tests/test_canvas_command_bridge.py tests/test_canvas_command_push.py \
  tests/test_canvas_command_stream.py tests/test_chat_project_bridge_paths.py \
  tests/test_chat_route_prewarm.py tests/test_chat_timeout_diagnostics.py -q
```

记录：133 项组合回归通过；随后新增启动窗口注入和等待写锁跨 TTL 的两项测试分别通过，
共 135 项。现有依赖有弃用提示，不影响通过结果。
macOS 原生事件测试需要运行在允许原生文件事件的环境；当前执行沙箱会静默屏蔽事件，
已用沙箱外运行确认系统支持通知，另有静默监听测试确认降级路径。

前端验证：

```bash
cd frontend
pnpm exec vitest run src/features/freezone/canvasCommandStream.test.ts \
  src/__tests__/features/freezone/canvas-chat-commands.test.ts \
  src/__tests__/features/freezone/freezone-chat-visibility.test.tsx \
  src/__tests__/features/freezone/canvas-agents.test.ts
pnpm exec tsc -b --pretty false
```

261 项相关前端测试通过，TypeScript 检查通过。
改动涉及的 Python 文件 Ruff 检查与 `git diff --check` 通过。

具体故障验证：

| 条件 | 结果 |
| --- | --- |
| 跨进程提交与原子通知 | 写入进程退出后约 0.055～0.086 秒发现命令 |
| 子进程 commit 后在通知函数内立即退出 | 默认 30 秒对账在 29.610 秒补获 |
| 两个独立进程竞争同一命令 | 仅一个领取成功 |
| 已投递命令无结果 | 缩短计时的回归验证租约到期可再次领取；15 秒常量保持不变 |
| 查询后业务 TTL 到期 | 待处理查询与原子领取均拒绝；独立过期持久化超时结果 |
| 等待写锁期间跨过 TTL | 获得锁后校验拒绝领取 |
| 监听重建期间无通知写入 | 重建后补拉恢复 |
| 原生监听已启动、首次确认补拉尚未执行时写入 | 可控时序注入回归通过 |
| 初始目录不存在、运行时删除重建 | 创建、重新监听及补拉通过 |
| 原生监听异常与静默失效 | 降级检查、旧 JSON 检查及验证恢复通过 |
| 订阅建立时取消、最后订阅退出 | 无目录引用与后台任务遗留 |
| WebSocket 历史去重集合已有 key | 持久化命令租约到期仍允许合法重投 |
| 40 个默认线程池长等待 | hub 有界短查询仍能完成 |
| SSE 连接与回写 | 外部命令过滤、事件格式、结果读取、连接计数与订阅清理通过 |

### 600 秒空闲观测

运行 `PYTHONPATH=src python scripts/benchmark_canvas_command_watch.py --duration 600`。
macOS 本地文件系统，32 个目录，每目录 4 个订阅，共 128 个订阅；预热结束后计量。

| 指标 | 观测 |
| --- | --- |
| 测量时间 | 600.023 秒 |
| 只读开库次数 | 640 |
| 每目录最多开库次数 | 20 |
| 相邻开库最短间隔 | 30.003 秒 |
| 非只读开库 / 写事务 / 目录扫描 | 0 / 0 / 0 |
| 进程 CPU 时间 | 4.265 秒，约单核 0.71% |
| Python 线程数 | 3 |
| 操作系统线程总数 | 另一次 32 目录原型观测为 6，Python 线程为 3 |
| 事件循环延迟 P99 / 最大 | 1.294 / 21.393 ms |
| 降级次数 | 0 |

该结果验证本地空闲 IO 预算，不代替 3060 慢盘、实际 `/healthz`、多 worker
完整入口、真实浏览器外部 MCP 到画布执行的端到端延迟验收。

## 指标和入口核对

已增加鉴权只读诊断接口 `GET /api/v1/diagnostics/canvas-command-push`，返回 worker PID、
共享目录数、订阅数、SSE 连接数、目录读取尝试数、对账补获次数、降级及恢复次数。
不返回目录、项目、命令内容或凭据。指标是单 worker、进程生命周期内的值，
跨 worker 需按 PID 采集；`reads` 是快照读取尝试，不等同于底层真实开库数。
CPU、sda IO 与端到端延迟仍需部署侧观测。

仓内 `frontend/docker/nginx.conf.template` 的 `/api/` 已使用 HTTP/1.1，
关闭响应缓冲、缓存和请求缓冲，读写超时均为 86400 秒，可覆盖新路由。
本轮未读取或修改 3060 实际 OpenResty / ingress 配置。
实际入口应使用带浏览器 Cookie 的事件流客户端验证，避免在截图、终端日志或文档暴露 Cookie。
确认空闲心跳不会被缓冲，断连后能补领，两个 worker 同时订阅也只有一个租约领取者。

## 发布顺序与回滚

1. 在 3060 同款内核、文件系统和接近生产数据量的 staging 完成清单剩余实机验收。
   先核对入口缓冲及空闲超时，采集稳定版基线与新版本相同条件下的指标。
2. 先发布后端，保持旧前端；确认旧 POST、WebSocket、租约、过期结果及运行指标正常。
3. 再发布前端，观察 SSE 连接和重连、5 秒回退、CPU、sda IO、补获、降级与端到端延迟。
4. 稳定后另开兼容清理提交。旧 HTTP 接口须保留至少一个兼容版本；本轮不删除回退机制。

前端回滚：重新部署先前前端构建产物；新后端继续支持旧 POST 和 WebSocket。

后端回滚：重新部署基线后端产物，保留 bridge SQLite 和 JSON 数据。
新前端连接旧后端收到错误后，连续三次失败即回退到 5 秒轮询；也可先回滚前端，
减少回退等待时间。没有 schema 迁移，不需要删除数据库或清空目录。
回滚后旧后端可能重新带来原有高频扫描和写事务开销，需继续观测。

混合版本限制：通知前退出靠对账恢复；旧进程不发信号的命令按补查路径发现。
旧 JSON 仍作为兼容镜像处理；混合部署维持至少一次语义，不承诺执行绝不重复。
未实现 applying 协议，浏览器现有 bridge_key 去重仍是执行层的一部分。
无人打开画布时命令仍需等待浏览器或超时。

本轮未创建发版计划、未改动周更流程、未发布后端或前端；这些动作与 3060 实机验收
按实施清单继续保持待办。

## 后续补齐记录（2026-10-30）

清单剩余仓内实现分为两个仓库的独立分支，未混入根工作区原有未提交修改：

| 仓库 / 分支 | 提交 | 内容 |
| --- | --- | --- |
| CE `feat/canvas-command-push` | `53dfabd8` | 一次性 Linux 验收镜像、真实 healthz ASGI 压测、Linux/HTTP 指标采集工具 |
| CE `feat/canvas-command-push` | `8c24d483` | Linux/macOS 原生监听 CI，保留真实进程故障测试 |
| EE `feat/canvas-command-push-ops` | `0f049e3bf` | OpenResty 按查询参数路由 canvas SSE 至项目归属节点，容器端到端代理验收 |
| EE `feat/canvas-command-push-ops` | `8328bffed` | 每周一北京时间 09:00 固定两个 main SHA，生成发布证据记录及后端先行流程 |

### Linux 原生事件

一次性 Linux Python 3.12 容器中 22 项 bridge 测试通过，包含原生跨进程通知、
真实 commit 后退出、重建窗口、静默降级、目录恢复、TTL 与写锁竞争。
写入进程退出后约 0.091 秒发现命令；通知前退出后在 29.687 秒补获。
该容器内核为 `7.2.12-orbstack-00394-gbecdd6130068`，临时目录是 overlayfs；
尚未核对 3060 内核和数据目录文件系统，因此不代替清单要求的同环境实机验收。

可重复运行：

```bash
docker build -f scripts/acceptance/Dockerfile.canvas-command-push \
  -t canvas-command-push-acceptance:local .
docker run --rm --mount type=bind,source="$PWD",target=/source,readonly \
  canvas-command-push-acceptance:local
```

### 多画布与 healthz 对比

新增 `scripts/benchmark_canvas_command_health.py`，使用真实应用的 `/healthz` 路由和
中间件，经 HTTP ASGI transport 测量；不运行 lifespan，避免启动无关 worker。
以 `30c7afae` 的 bridge 源码作为旧版本，单次顺序对比相同本机、32 目录、
每目录 4 订阅、30 秒、每秒 10 条目标写入。生产入口和磁盘验收另行记录。

| 指标 | 旧扫描实现 | 新推送实现 |
| --- | --- | --- |
| 实际发送 / 收到 | 263 / 263 | 277 / 277 |
| healthz 请求数 | 460 | 571 |
| healthz P99 | 48.114 ms | 3.395 ms |
| 事件循环延迟 P99 | 58.433 ms | 1.227 ms |
| 投递延迟 P99 | 397.486 ms | 127.579 ms |
| 开库次数 | 9532 | 3572 |
| 写事务开始次数 | 9269 | 2742 |
| 进程 CPU 时间 | 6.649 s | 8.623 s |

CPU 时间有所增加；本地延迟和事务数据不能关闭 3060 的 CPU / sda IO 恢复目标。
压测器停止时会等待在途写入完成再冻结发送数，避免取消线程等待导致计数失配。

### OpenResty 路由与发布流程

原模板只有 `/api/v1/projects/...` 的项目归属路由，新 `/chat/.../stream` 会落入默认节点。
已补专用 location，按与 FastAPI 一致的 URL 解码、重复参数取末值和去空白规则提取项目 ID，
经现有归属映射转发，继续由上游执行 Cookie 与项目授权，关闭 SSE 缓冲和缓存。
在独立 Redis、真实 OpenResty 和临时上游容器中验证：归属节点正确、Cookie 透传、
首个事件 11.704 ms、重复及编码参数一致、缺少项目参数返回 400。

EE 中 `scripts/acceptance/verify_canvas_proxy.py` 可重跑代理验收，仅创建和清理自己的容器。
5 项代理契约与 5 项周发布候选测试通过；两个新增 workflow 通过 actionlint 1.7.12。
每周流程生成固定 SHA 的候选与证据模板，生产发布继续使用既有受保护的后端、前端流程。
代码合入 main 后定时准备才会生效，本轮没有发布或改动线上 BOM。

### 实机采集与当前外部条件

新增 `scripts/acceptance/collect_canvas_push_evidence.py`：读取 Linux 主机 CPU、指定磁盘
扇区 / IO 时间、显式选定本地 API PID 的 CPU / 读写字节，以及 HTTP healthz 和鉴权诊断。
Cookie 从本地 Netscape cookie 文件读取，不写入报告或日志；缺失设备、PID 重启和不可用计数
返回 null，避免误报零 IO。采集边界的两项回归与 Linux 容器实读通过。

当前 kubeconfig 只有本地 Docker/OrbStack context，没有 3060；SSH 配置没有 3060 主机；
对既有流程引用的 GitOps 仓库查询返回 404。已向用户请求 3060 连接和实际入口。
因此实际 ingress 核对、生产入口验收、发布、生产数据量压测及版本稳定观察仍保留待办。
兼容轮询删除需在后端全部升级、至少一个兼容版本及稳定观察完成后另开提交，遵守原清单顺序。

## 用户委托复测（2026-10-30 17:28–17:30）

按用户要求重新实际执行。本轮 CE 测试版本为 `7aba7ccb`，EE 干净运维分支版本为
`1d86f4e9d`。范围为本地定向回归、原生事件、代理集成及命令负载；未扩大到整站人工浏览器验收。

| 验证 | 本轮结果 |
| --- | --- |
| 后端 7 个定向测试文件 | 137 passed，52.62 秒 |
| 前端 4 个定向测试文件 | 261 passed，23.93 秒 |
| TypeScript `tsc -b --pretty false` | 通过 |
| Linux 一次性验收容器 | 22 passed，36.57 秒 |
| Linux 通知前退出故障恢复 | 29.673 秒 |
| EE 代理契约与周发布候选 | 10 passed |
| 真实 OpenResty 代理集成 | 归属路由、Cookie 透传、重复/编码参数及缺参拒绝通过，首事件 19.280 ms |
| 改动相关 Python Ruff、git diff 检查 | 通过 |

随后独立运行 30 秒命令负载测试，32 个目录、每目录 4 个订阅，目标每秒 10 条命令。
使用真实应用 `/healthz` 的 ASGI 路由与中间件，不启动无关服务 lifespan。

| 指标 | 本轮结果 |
| --- | --- |
| 实际发送 / 收到 | 275 / 275 |
| 投递延迟 P99 | 132.662 ms |
| healthz 请求数 | 571 |
| healthz 延迟 P99 | 4.211 ms |
| 事件循环延迟 P99 | 1.358 ms |
| 降级 | false |
| 进程 CPU 时间 | 9.586 秒 |

本轮未发现失败用例或丢失命令，无需修改实现代码。
依赖已有的弃用提示、Node localStorage 实验性提示及 EE Ruff 配置弃用提示不影响测试结果。

## ego 浏览器验收与修复（2026-10-30）

使用 ego-browser 操作真实 Vite 页面及真实后端。原运行服务仍使用旧源码，
因此另外启动整改工作区的隔离测试服务与临时数据，在空白测试项目中验收。
本轮没有重启或切换原有服务，没有调用生成模型或修改既有项目。

发现并修复：空画布没有命令时，开发代理会等首个 25 秒心跳才让 EventSource 完成打开。
实测旧行为约 25.111 秒。`2507e0f2` 在订阅建立后立即输出 SSE comment 握手；
注释不会产生 message frame，也不改变命令格式，修复后浏览器实测 72 ms 打开。
新增空队列立即握手回归，修复后完整定向后端测试为 138 passed，51.38 秒。
改动文件 Ruff 与 diff 检查通过。

| 实际浏览器操作 | 结果 |
| --- | --- |
| 空画布正常连接 | 1 条活跃命令 SSE，0 次旧命令轮询 |
| 写入一条普通文本节点命令 | 125 ms 后浏览器收到 `canvas.command` |
| 在真实审批卡点击确认执行 | 文本节点出现；后端等待取得 ok=true、applied_count=1、errors=[] |
| 仅阻断 SSE 请求 | 连续失败后回退，3 次 POST 均为 200，相邻间隔 5039 / 5048 ms |
| 解除阻断并恢复连接 | 恢复为 1 条活跃 SSE；再观察超过一个轮询周期，无新增轮询 |
| 用第二个临时标签页真实切换前后台 | hidden 时仍保留 1 条连接，visible 恢复后也只有 1 条 |
| 返回项目列表卸载画布，再重新进入 | 卸载后 0 条，挂载后 1 条；仍只有 1 个文本节点、1 次该命令投递 |
| 额外实际 TCP 断连检查 | 后端由 1 连接 / 2 目录订阅降至 0 / 0 |

本次使用正常初始化生命周期的本地 CE 后端。最初隔离启动误用 lifespan=off，
导致未初始化的鉴权返回 503；已修正测试启动方式，未将其记作产品回归。
浏览器探针只观测 EventSource 和请求元数据；断网检查结束已解除阻断。
截图、命令回执和连接生命周期 JSON 保留在本机临时 QA 目录。

ego 任务空间已正常完成并关闭，临时前后端均已清理。
原有服务进程未重启，原前后端端口复查均为 HTTP 200。
Ego Lite 提示有可用更新，本轮沿用当前版本，没有执行升级。
