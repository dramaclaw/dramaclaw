# Chat 展示映射边界（#559 第二阶段）

本阶段是兼容迁移，不改变审批顺序、工具执行、模型列表或生成参数。
它不代表 #559 全部完成，也不替代 #575 的结构化执行证据校验。

## 已迁出的职责

`chat/presentation.py` 只依赖 Python 标准库，处理 canonical UI-spec：

- JSON 尾部修复及校验，包括既有 legacy component props 兼容；
- UI-spec JSON / block / bundle 封装和正文、卡片分离；
- 媒体卡片按既有类别合并、冲突键重命名及去重。

依赖方向为 `chat/service.py -> chat/presentation.py -> Python 标准库`。
展示模块不能导入 Application、Runtime Adapter、Session Registry、数据库、
模型 SDK 或 API 客户端。`tests/test_chat_presentation.py` 用依赖约束测试守住边界。

错误日志由 Application 通过 `log_error` 回调注入；展示模块不选择文件路径、
不读取项目身份、不写日志文件。`service.py` 保留旧 helper 名称以及两个薄委托，
现有调用方可以逐步迁移。原有排序、错误提示和非法卡片跳过策略保持不变。

本次按原算法机械迁移，没有顺带修复嵌套卡片合并等历史语义；此类行为变更应
单独提交回归测试和修复，不能混入结构拆分。

## 验证策略

迁移前先运行现有 JSON-render / UI-spec characterization tests；迁移后同时验证
新模块和旧入口。覆盖 legacy props、输入不变性、JSON 修复、非法引用、bundle
往返、类别顺序、合并、去重，以及 Application 日志回调兼容。
随后运行完整后端回归与 Workflow 生成契约检查。

## #559 后续边界（仍未完成）

1. `chat/runtime_event_evidence.py` 已从 Application 迁出 Freezone 工具结果的
   纯解析、画布写入回执校验、预校验失败和重试身份计算；`service.py` 暂保留旧
   helper 导出供现有调用方使用。Runtime Adapter 仍需收拢 provider-native 历史
   与其他原始事件解析，使 Application 只消费标准化事件及交付证据。
2. 继续迁出正文归一化、工具结果展示映射和显示工具 fallback；其中 API
   查询留在独立应用服务，不能为了减少行数搬进纯展示模块。
3. Session Registry / Delivery Evidence 独立，沿用 #555 / #558 的运行身份
   和 durable bridge 约束，并与 #575 执行证据契约协调。
4. Freezone 路由按 Canvas、Catalog、Workflow、ProductOperation、Asset
   逐域提取；每个域先固化兼容测试，再保留旧路由薄委托。
5. 前端巨型编排模块继续拆分；稳定 Workflow 契约继续使用 #572 的生成源，
   动态模型目录保持运行时读取，不能固化进生成契约。

只有上述边界及原 issue 验收条件全部验证后，才应关闭 #559。
