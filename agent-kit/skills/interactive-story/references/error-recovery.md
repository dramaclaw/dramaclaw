# 互动故事写入恢复

适用于故事 Create/Patch 和画布写入失败，不适用于媒体生成。故事写入仅在下述明确的冲突或写入前拒绝场景允许恢复；其他情况读取当前状态并停止。

画布批次另按逐命令回执恢复：`Conflict` 或部分落图后，先读取最新画布、实际创建节点 ID、连线与逐命令结果。只有能证明未生效、且不会覆盖并发修改的写入，才用当前 revision 重建缺失部分并最多重试一次。已创建图片或已存在连线不得重复创建；状态不明、生成已提交或第二次冲突时停止并报告。此规则不授权重放图片／视频生成请求。

- `revision_conflict`：故事 Create/Patch 的版本冲突。服务在应用故事写入前拒绝了请求；重新读取同一故事及画布，保留并发编辑，只重建仍获授权的变更。若回执给出 `current_revision`，且读取后原操作仍明确安全，可用新 `idempotency_key` 最多重试一次；状态不明或第二次冲突时停止。
- `canvas_revision_conflict`：画布保存的版本冲突。`current_revision` 只用于定位最新状态，不能单凭版本号重放整批命令。先读取最新画布与逐命令回执，确认哪些写入没有生效，再仅重建安全的缺失部分；不得重放已提交的媒体生成。
- `tool_arguments_invalid` 且 `phase=tool_validation`：这是确定性的写入前参数拒绝。修正每个返回的 `details.path`，保留未报告字段和故事语义，重新读取当前状态，然后在同一轮中用当前 revision 和新 key 重试一次。不要猜测其他 envelope；第二次调用无论如何失败都停止。
- `idempotency_conflict`：停止；不得通过更换 key 隐藏冲突。
- `outline_not_confirmed`：停止，Create 入口与后端均硬校验此门禁。不得重试或换 key；请用户在画布方案卡确认大纲后再来。
- 没有上述明确 `phase=tool_validation` 证据时，`invalid_story`、HTTP 422 和 `request_validation_error` 不能证明可以安全重试。`invalid_story` 可能发生在持久化成功后读取保存结果的阶段。读取当前状态并报告错误，不覆盖或自动重试。缺少诊断路径不授权猜测修正。
- Timeout、cancellation、结果缺失、cached receipt 和其他结果不明的情况不授权重放。安全时读取当前状态，报告已知信息并结束当前轮次。

如果 automatic Choice 的校验路径只指出 `feedback_text` 非空，只清空该字段。Automatic Choice 可以保留 effects；除非另一条返回路径或用户要求修改故事，否则不要移动、删除或重写 effects。
