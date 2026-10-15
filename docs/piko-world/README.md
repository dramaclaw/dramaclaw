# Piko 小镇维护入口

- [产品说明](product-overview.md)：面向运营的精简介绍，包含定位、进入流程、主要体验和当前边界。
- [地图运行状态](map-runtime.md)：当前 17 图、已选素材版本、切图连接和后续碰撞计划。
- [单条聊天翻译](chat-translation.md)：按需翻译交互、接口及多人接入边界。
- [BGM 分组与播放行为](map-bgm-2026-09-14.md)：9 首曲目的分组与播放规则；当前 17 图归属以运行时配置为准，暖光会厅使用庭院暖调曲目。
- [音频来源与校验](bgm-assets-2026-09-14.json)：运行时音频 SHA-256、来源与时长。
- [OST 当前命名](ost-naming-options.md)：已采用的 9 首曲名与场景分组。
- [角色制作规范](default-piko-pixel-production-spec.md)：角色源稿、动作脚本与验收约束。
- [玩家动作构建](player-motion-production-2026-09-17.md)：当前图集、必需源图、重建与锚点校验。
- [庭院河鱼](river-fish.md)：透明素材、游动范围、水面层级与资源生命周期。
- [角色配饰](wardrobe-accessory-selection-2026-09-17.md)：六件配饰、方向适配与本机保存规则。
- [头顶任务标签](task-status-label.md)：已确认展示规则、素材要求与待接入的数据边界。
- [界面设计规范](../../DESIGN.md)：产品与 Piko 场景组件的当前规则。

2026-09-16 清理已被替代的地图候选、UI预览、重复字图、旧音频与过期交接/审计文档。保留角色制作与测试依赖、庭院效果说明、现用设计源稿及仍有用途的世界/剧情规划。运行时资源保持在 frontend/public/piko/。

历史制作与审计记录见 [制作历史](history/player-motion-production-2026-09-17.md) 和 [当日审计](history/daily-audit-2026-09-17.md)，其中旧命令与参数不作为当前维护指引。

## 多人聊天维护边界

默认 `PIKO_WORLD_BACKEND=demo` 使用 SQLite 和进程内房间，只适用于单个 API worker。`distributed` 使用 PostgreSQL 和 Redis，并依赖完整的 EE 控制平面端口。部署必须在完成 PostgreSQL 建表、数据迁移和就绪验证后显式设置 `PIKO_WORLD_BACKEND=distributed`，不能仅凭存在 `ST_CONTROL_PLANE_DSN` 或 `ST_REDIS_URL` 自动切换持久化后端。

分布式模式下，同一场景优先装满当前房间再创建下一房间，默认容量为 200 人，可通过 `PIKO_WORLD_SCENE_CAPACITY` 调整（范围 10–500）。服务端随世界快照返回从 1 开始的分区号，界面在地图名称旁显示为 A区、B区；单机模式固定显示 A区。

分布式代码需要 `piko_characters`、`piko_character_locations`、`piko_chat_conversations`、`piko_chat_participants` 和 `piko_chat_messages` 五张 PostgreSQL 表。本社区库未包含对应 PostgreSQL 建表迁移，启用前须核实部署的控制平面迁移、字段和唯一约束，不能仅凭配置了数据库地址就认定可用。模拟 Redis 测试覆盖房间、登录接管和消息流，真实 PostgreSQL/Redis 部署的联调应在部署环境完成。

客户端发送消息时附带可选的 `client_message_id`。服务端通过消息回显或 `chat.sent` 确认接受；限流与会话失效通过带同一标识的 `error` 返回。前端在确认前保留草稿，超时或断线允许重试，不自动重复提交。旧客户端不带标识时继续接收原有消息回显。修改角色资料只更新在线展示，保持现有连接和私聊。

公聊保留最近 100 条网络消息，私聊缓冲保留最近 200 条；欢迎内容作为 NPC/向导提示保留，不伪造当前玩家发言。两种后端共用协议校验、发送回执和生命周期契约测试：`uv run pytest tests/test_piko_hub_contract.py tests/test_piko_distributed.py tests/test_piko_world.py`。
