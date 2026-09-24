# Machine-readable workstream scopes

每个活动工作线有一份同名 TOML。任务台账解释为什么，scope 只给 `scripts/agent_guard.py`
回答机器必须判断的问题：基线是什么、哪些路径可写、重叠是否经过双方声明。
新工作线从 `docs/agent/CLAIM_TEMPLATE.toml.example` 复制，文件名必须与 slug 一致。

模式：

- `exclusive`：仅本工作线可写；与其他可写 scope 重叠会使全局检查失败。
- `shared`：确需多线串行修改；双方必须在 `shared_with` 互相声明，锁会阻止同时写。
- `read-only`：本线需要读取但承诺不写，不参与写冲突。
- `coordination`：台账 / STATE / scope 等协调文件；非执行状态也可持锁更新，但不能据此写业务代码。

目录认领只允许 `path/**`，不支持其他通配符。禁止认领仓库根或宽泛的 `src/**`、`frontend/**`。
状态、方案和进度不复制到 TOML，以任务台账与 STATE 为准；guard 会检查二者一致。
同一检出目录始终只有一个写锁；共享模式用于静态冲突审计和未来跨 worktree 集成，不允许在一个工作区并行写。
