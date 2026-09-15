# 互动故事校验

调用 Validate 或解释其结果前读取本文档。

Validate 检查持久化故事的 schema、图可达性、自动兜底顺序、限时选择默认项、媒体就绪状态和运行路径行为。运行路径分析从初始故事状态出发，模拟 variables、flags、访问次数、Choice 条件及 effects，可以识别：

- `condition_unreachable`：在所有可达状态变化下都不可能出现的 Choice。
- `runtime_unreachable`：结构连线可达，但在可达条件下无法进入的 Segment。
- `variable_out_of_bounds`：Choice effect 会让变量超出声明范围。
- `automatic_cycle`：自动转场形成始终不等待玩家输入的循环。
- `path_analysis_incomplete`：有界模拟达到安全上限；这表示覆盖不完整，不能证明其余路径正确。

其他常见结果包括 `missing_video`、`media_url_unresolved`、`timed_choice_uses_first_default`、`automatic_no_fallback`、`automatic_fallback_order`、`unreachable`、`leaf_no_ending`。

- `error` 表示无效或不安全的故事状态，会阻塞后续预览/导出门禁。
- `warning` 表示应修复或明确接受的制作、体验问题。
- `info` 是不阻塞流程的提示。

Validate 不编译 Ink，也不执行播放器。校验通过不等于已经验证试玩行为；`missing_video` 也不会让占位故事创建失败。用户需要可玩行为保证时，另行执行真实试玩验证。
