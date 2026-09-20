# Chat 展示映射边界（#559 第二阶段）

本阶段是兼容迁移，不改变审批顺序、工具执行、模型列表或生成参数。
它不代表 #559 全部完成，也不替代 #575 的结构化执行证据校验。

## 已迁出的职责

`chat/presentation.py` 只依赖 Python 标准库，处理 canonical UI-spec：

- JSON 尾部修复及校验，包括既有 legacy component props 兼容；
- UI-spec JSON / block / bundle 封装和正文、卡片分离；
- 媒体卡片按既有类别合并、冲突键重命名及去重。

Chat 展示路径的其余转换也已拆出：

- `chat/presentation_text.py` 处理历史回放去重、流式文本合并、路径遮盖和正文清理；
- `chat/presentation_mapping.py` 处理 UI-spec 规范化、工具结果展示/错误映射及提示词筛选；
- `chat/media_presentation.py` 处理消息媒体链接提取、规范化和去重；
- `chat/display_fallback.py` 读取权威媒体详情并组装展示卡片。

`service.py` 保留旧函数入口、项目目录解析、错误日志写入、API 读取注入和事件
发送顺序。展示模块不持有会话、数据库或画布写入状态。

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
   helper 导出供现有调用方使用。`chat/runtime_event_mapper.py` 已统一三条运行时
   流的生命周期、进度和 SDK 工具事件对外载荷，以及 Hermes 原始工具更新的
   生命周期判定；事件发送时机仍由 Application 管理。Runtime Adapter 仍需收拢
   其他原始事件解析，使 Application 只消费标准化事件及交付证据。
   `chat/runtime_history.py` 已承接 Codex 原生历史条目到聊天记录的纯解析；
   历史读取、时间戳、媒体补全及缓存写入仍由 `service.py` 负责。
   随后的独立修复补上 SDK `UserInput.root` 展开，避免读取原生线程历史时
   漏掉用户消息；该修复不改当前轮消息写入路径。
2. Chat 展示转换和显示工具 fallback 已迁出；后续调整展示行为时继续以
   `presentation.py` 的 canonical UI-spec 边界和权威媒体 API 为准。
3. Session Registry / Delivery Evidence 独立，沿用 #555 / #558 的运行身份
   和 durable bridge 约束，并与 #575 执行证据契约协调。
   `chat/session_registry.py` 已承接锁范围、记录解析、过期判断、文件抢占、
   心跳及释放，以及 Agent/Codex 会话状态与活动轮次的文件格式、读写和作用域键。
   `service.py` 保留路径选择、协议版本、原子写入与文件锁注入，以及现有入口。
   旧项目聊天库的迁移、建表、消息与设置项读写、轨迹替换，以及输入历史文件
   已迁至 `chat/message_repository.py`；路径选择、消息媒体补全和展示仍留在
   Application。新作用域聊天存储仍由 `chat/store.py` 负责。
4. Freezone 路由按 Canvas、Catalog、Workflow、ProductOperation、Asset
   逐域提取；每个域先固化兼容测试，再保留旧路由薄委托。
5. 前端巨型编排模块继续拆分；稳定 Workflow 契约继续使用 #572 的生成源，
   动态模型目录保持运行时读取，不能固化进生成契约。

只有上述边界及原 issue 验收条件全部验证后，才应关闭 #559。
