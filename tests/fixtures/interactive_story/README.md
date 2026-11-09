# 互动剧情共享语义样例

Python 校验器、TypeScript 校验器和真实 Ink 执行共同消费 `cases/*.json`。
预期结果由人根据业务语义指定，不从任何一端的实际输出生成。
本目录只约束已有语义，不改变运行架构或发布流程。

## 样例格式

- `story`：符合 `StoryDraftV2` 的领域数据。Python 使用正式 Pydantic 模型检查。
- `expectedIssues`：完整的问题集合，精确比较 `code`、`severity`、`entityId`，忽略顺序。
  故事级问题的 `entityId` 统一为 `null`；节点和选择使用领域 ID。
- `playthroughs`：人工指定选择 ID、经过的片段和最终变量/Flag。
  `expectedChoices` 指定轨迹结束时仍可选择的选项文本，默认空数组。
  `expectedRuntimeErrors` 指定预期 Ink 错误的稳定文本片段，默认不允许错误。
- 含 error 的故事检查正式 `compileStoryGroup` 门禁拒绝编译，不执行危险循环。
  warning 不等于可正常完成游戏，例如缺少自动兜底的故事可能运行报错。

前端测试中只有一个字段适配器，将领域字段转成校验器/编译器的画布输入；
不执行条件判断、不生成预期结果、不承担生产映射器的回归覆盖。
增加本适配器尚不支持的领域字段时，须同时补适配和相关断言。

## 覆盖

- 数值与 Flag 条件、AND/OR 组合、累加和设置 Flag，正反两条路径。
- 自动分支按 order 优先执行（数组顺序刻意打乱）、无条件兜底。
- 自动条件全部不满足：静态警告及实际 Ink 运行错误。
- 节点访问次数：直接自跳和经过其他片段后返回。
- 数值超过上下界：错误与不可达目标、编译门禁拒绝。
- 自动循环：错误和编译门禁拒绝。
- 超过 2,000 个分析状态：不完整警告，而非误报不可达；短路径仍可执行。

## 访问次数回归

`visit-count.json` 验证直接自跳后第二次显示片段时解锁 `finish`，并验证自跳前后
保存、恢复 Ink 状态仍能抵达结局。`automatic-visit-count.json` 验证自动自跳、
效果执行次数，以及内部中转节点名称不与用户变量和 Flag 冲突。
编译器用不产生播放内容的中转 knot 处理自跳，使 Ink 的访问计数与领域分析一致。
这些样例均为普通通过测试，不再保留预期失败标记。

`conditional-dead-end.json` 的 `ran out of content` 是缺少兜底产生的实际运行错误；
样例明确声明该错误，不将它报告为正常抵达结局。

## 执行与维护

在仓库根目录：

```sh
uv run pytest tests/test_interactive_story_semantics_contract.py -q
```

在 `frontend` 目录：

```sh
pnpm test src/__tests__/features/canvas/story/sharedSemantics.test.ts
```

两个测试均由现有 pytest / Vitest 默认收集。后端 CI 对所有变更运行；前端 CI
已将 `tests/fixtures/interactive_story/**` 加入 push/pull_request 触发路径，单独修改
样例也会运行两端校验。

修改剧情语义时，先写清预期和样例，再同步实现。不要只修改预期以消除红灯。
