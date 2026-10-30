# 画布命令推送：本地验收与发布准备

日期：2026-10-30。实施分支：`feat/canvas-command-push`。

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
