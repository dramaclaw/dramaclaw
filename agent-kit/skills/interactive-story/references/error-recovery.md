# 互动故事写入恢复

仅适用于 Create/Patch 失败，不适用于媒体生成。只有下述两个明确的冲突或写入前拒绝场景允许恢复；其他情况读取当前状态并停止。

- `revision_conflict`：服务在应用写入前拒绝了请求。优先重新读取同一画布或同一故事，保留并发编辑，只重建仍获授权的变更。若冲突回执明确给出 `current_revision`，且原操作在新状态下仍明确安全，也可直接以该 revision 和新 `idempotency_key` 重试一次；同一字段被并发修改或意图含糊时必须先读取，无法确认就停止。冲突再次发生时停止。
- `tool_arguments_invalid` 且 `phase=tool_validation`：这是确定性的写入前参数拒绝。修正每个返回的 `details.path`，保留未报告字段和故事语义，重新读取当前状态，然后在同一轮中用当前 revision 和新 key 重试一次。不要猜测其他 envelope；第二次调用无论如何失败都停止。
- `idempotency_conflict`：停止；不得通过更换 key 隐藏冲突。
- 没有上述明确 `phase=tool_validation` 证据时，`invalid_story`、HTTP 422 和 `request_validation_error` 不能证明可以安全重试。`invalid_story` 可能发生在持久化成功后读取保存结果的阶段。读取当前状态并报告错误，不覆盖或自动重试。缺少诊断路径不授权猜测修正。
- Timeout、cancellation、结果缺失、cached receipt 和其他结果不明的情况不授权重放。安全时读取当前状态，报告已知信息并结束当前轮次。

如果 automatic Choice 的校验路径只指出 `feedback_text` 非空，只清空该字段。Automatic Choice 可以保留 effects；除非另一条返回路径或用户要求修改故事，否则不要移动、删除或重写 effects。
