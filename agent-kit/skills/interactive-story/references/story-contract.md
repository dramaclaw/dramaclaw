# 互动故事工具契约

仅在构造 Create 或 Patch 参数时读取本文档。本文档定义持久化故事的数据结构和写入硬约束。可选的选择呈现、choice loop、反馈和 CTA 见 [interaction-options.md](interaction-options.md)。

## 工具与写入

Codex MCP 和 Hermes adapter 中的四个业务工具名称和语义一致：

- `dramaclaw_create_interactive_story`：`base_revision`、`idempotency_key` 和完整 `story`。
- `dramaclaw_get_interactive_story`：`story_id`。
- `dramaclaw_patch_interactive_story`：`story_id`、`base_revision`、`idempotency_key` 和 `operations`。
- `dramaclaw_validate_interactive_story`：`story_id`。

会话已经绑定项目和画布时可省略 `project_id`、`canvas_id`。成功写入返回 `canvas_id`、`revision` 和 `refresh_canvas=true`。

Create 和 Patch 通过 `InteractiveStoryService` 原子写入画布，不使用普通 Freezone 节点命令的 browser bridge。同一授权阶段的相关操作合并到一个 Patch。后续阶段可在 Get 刷新当前 revision 后再次 Patch，例如取得真实尾帧之后。

Agent 生成 StoryDraftV2 和 Patch 数据对象，不生成 Ink 源码。前端在预览或导出时把画布故事组确定性编译为 Ink。

产品内 Agent 从成功的 `agent.tool.updated` 帧刷新匹配画布；存在未保存的本地编辑时保留本地副本并进入冲突状态。外部 stdio 客户端收到相同写入回执，但需要宿主自行实现刷新适配，否则用户必须刷新或重新打开画布。

## StoryDraftV2

```json
{
  "schema_version": "story_draft.v2",
  "story_id": "midnight_station",
  "revision": 0,
  "title": "午夜站台",
  "synopsis": "一句话梗概",
  "start_segment_id": "arrival",
  "characters": [],
  "variables": [],
  "flags": [],
  "segments": [],
  "choices": []
}
```

- 所有 ID 使用稳定、简短的 ASCII slug。
- Story、Segment、Choice、Character 的 ID 可包含字母、数字、`_`、`-`，且必须以字母或数字开头。
- Variable 的 `name` 必须兼容 Ink：以字母或 `_` 开头，之后只能包含字母、数字、`_`。
- 创建时 story revision 设为 `0`；服务返回持久化后的画布 revision。
- 提交前检查内部引用闭合：片段的 `character_ids` 必须存在于 `characters`，起点及选项两端必须存在于 `segments`，条件与效果引用的变量或开关必须已声明。局部编辑保留 Get 返回的现有实体，不用删掉人物定义的完整故事重建。

### Character

```json
{"id":"traveler","name":"旅人","description":"身份、目标和性格","visual_description":"稳定外观"}
```

### Variable 与 Flag

```json
{"name":"courage","label":"勇气","initial":0,"minimum":0,"maximum":5}
```

数值变量使用整数，初始值必须位于可选边界内。

```json
{"name":"has_key","label":"已拿到钥匙","initial":false}
```

Flag 表示是/否剧情事实。Variable 和 Flag 的名称共用一个命名空间且必须唯一。

### Segment

```json
{
  "id": "arrival",
  "title": "抵达无名站",
  "script": "玩家看到或听到的内容。",
  "kind": "scene",
  "ending_label": null,
  "character_ids": ["traveler"],
  "choice_time_limit_sec": null,
  "production_notes": "镜头与连续性提示",
  "video_prompt": "夜间站台，中景镜头缓慢推进；旅人停在站牌前。",
  "media": {"source":"placeholder","status":"missing","version":1}
}
```

`kind=ending` 必须有 `ending_label` 且没有出边 Choice；scene 使用 null `ending_label`。限时选择为 1–300 秒，同一来源的可见 Choice 应恰有一个默认项。

Segment 的可选 `choice_loop` 字段、必填说明及媒体语义见 [interaction-options.md](interaction-options.md)。

`video_prompt` 是独立、面向模型且不超过 20,000 字符的视频描述。它映射到画布视频节点的 `prompt`；`script` 映射到 `narration`，`production_notes` 映射到 `storyProductionNotes`。Create/Get/Patch 分别保存三者。空 `video_prompt` 表示清空，Patch 中省略表示保留。批量生成不会用 narrative 或 notes 替代空提示词。

### Choice

```json
{
  "id":"arrival_follow",
  "source_segment_id":"arrival",
  "target_segment_id":"follow_signal",
  "mode":"visible",
  "text":"跟随灯光",
  "order":0,
  "condition":null,
  "effects":[],
  "feedback_text":"",
  "is_default":false
}
```

同一来源的 Choice 必须具有不同的 `order`。结局 Segment 不能作为 Choice 来源。

源片段结束后需由系统自动选路时，将 `mode` 设为 `automatic`，并使用空 `text`、`feedback_text`。自动转场按 `order` 升序检查；最后一个无条件 automatic Choice 是兜底，不是限时默认 Choice。每个 automatic Choice 使用 `is_default:false` 和默认 interaction，但可以保留 `effects`。只有条件自动转场的来源在条件均不满足时可以停止。无条件自动兜底不能与可见 Choice 混用。

```json
{
  "id":"merge_after_left",
  "source_segment_id":"left_path",
  "target_segment_id":"reunion",
  "mode":"automatic",
  "text":"",
  "order":0,
  "condition":null,
  "effects":[],
  "feedback_text":"",
  "is_default":false
}
```

### 条件与效果

数值变量条件：

```json
{"kind":"variable","variable":"courage","operator":">=","value":2}
```

访问条件：

```json
{"kind":"visited","segment_id":"arrival","operator":">=","value":1}
```

Flag 条件：

```json
{"kind":"flag","flag":"has_key","value":true}
```

扁平条件组：

```json
{"kind":"group","join":"and","items":[{"kind":"variable","variable":"courage","operator":">=","value":2}]}
```

数值增量：

```json
{"kind":"increment","variable":"courage","delta":1}
```

设置 Flag：

```json
{"kind":"set_flag","flag":"has_key","value":true}
```

## Patch 操作

```json
{
  "story_id":"midnight_station",
  "base_revision":3,
  "idempotency_key":"patch-midnight-r3-ending",
  "operations":[
    {
      "op":"add_segment",
      "segment":{
        "id":"stay_until_dawn",
        "title":"等到天亮",
        "script":"你留在站台，第一班车终于驶入晨雾。",
        "kind":"ending",
        "ending_label":"等候者"
      }
    },
    {
      "op":"add_choice",
      "choice":{
        "id":"arrival_stay",
        "source_segment_id":"arrival",
        "target_segment_id":"stay_until_dawn",
        "mode":"visible",
        "text":"留在站台",
        "order":1,
        "is_default":false
      }
    }
  ]
}
```

每次调用必须包含 `story_id`、`base_revision`、`idempotency_key` 和非空 `operations` 数组。不能只发送故事 ID、版本和幂等键。以下示例可直接作为 MCP 工具参数；`schema_version` 属于领域模型，不是 MCP Patch 工具的顶层参数。

每项操作必须带 `op`，其余字段按下表传入：

| op | 必填载荷字段 | 语义 |
| --- | --- | --- |
| `update_story_metadata` | `changes` | 局部更新 title、synopsis |
| `set_story_start` | `segment_id` | 设置起点 |
| `add_segment` | `segment` | 新增完整片段 |
| `update_segment` | `segment_id`、`changes` | 局部更新片段 |
| `remove_segment` | `segment_id` | 删除片段 |
| `add_choice` | `choice` | 新增完整选项 |
| `update_choice` | `choice_id`、`changes` | 局部更新选项 |
| `remove_choice` | `choice_id` | 删除选项 |
| `upsert_character` | `character` | 新增或整体替换角色 |
| `remove_character` | `character_id` | 删除角色 |
| `upsert_variable` | `variable` | 新增或整体替换变量 |
| `remove_variable` | `variable_name` | 删除变量 |
| `upsert_flag` | `flag` | 新增或整体替换 Flag |
| `remove_flag` | `flag_name` | 删除 Flag |

**只有 `update_*` 使用 `changes`。`upsert_*` 必须使用 `character`、`variable` 或 `flag`，不能套用 `changes`。** 更新既有实体时，先从 Get 结果保留其余字段，再传完整实体，避免整体替换时丢失设定。

增加分支时，在同一个 Patch 中同时增加目标 Segment 和对应 Choice。不要把 Get 返回的完整 Story 作为 Patch 发送。

### 示例：新增角色并在已有路径中插入片段

假设 Get 已确认故事 `stealth_offtime` 的版本为 214，既有选项 `stairs_auto_end` 从 `stairs` 指向 `ending_ontime`，且角色 `hero` 已存在。一次 Patch 加入小美、插入相遇片段、重定向原有选项并连接回原结局。ID 和版本须替换为当前 Get 的真实结果，不得直接重放示例。

```json
{
  "story_id":"stealth_offtime",
  "base_revision":214,
  "idempotency_key":"insert-meimei-scene-r214",
  "operations":[
    {
      "op":"upsert_character",
      "character":{
        "id":"meimei",
        "name":"同事小美",
        "description":"机灵的同事，撞见主角悄悄下班。",
        "visual_description":"扎马尾，穿浅色针织开衫。"
      }
    },
    {
      "op":"add_segment",
      "segment":{
        "id":"meet_meimei",
        "title":"楼梯间偶遇小美",
        "script":"主角下楼时撞见小美，两人会心一笑。",
        "kind":"scene",
        "character_ids":["hero","meimei"]
      }
    },
    {
      "op":"update_choice",
      "choice_id":"stairs_auto_end",
      "changes":{"target_segment_id":"meet_meimei"}
    },
    {
      "op":"add_choice",
      "choice":{
        "id":"meimei_leave",
        "source_segment_id":"meet_meimei",
        "target_segment_id":"ending_ontime",
        "mode":"visible",
        "text":"和小美一起离开",
        "order":0,
        "is_default":false
      }
    }
  ]
}
```

### 省略、空值和 null

- 从 `changes` 省略字段表示保留现值。
- 使用 `condition:null` 删除 Choice 条件；ending 改为 scene 时使用 `ending_label:null`；使用 `choice_time_limit_sec:null` 删除计时器。
- 使用 `media:null` 恢复占位媒体，`choice_loop:null` 删除选择动画，`cta:null` 清除 CTA。不要手工构造空 media 对象。
- 使用 `video_prompt:""`、`production_notes:""`、`synopsis:""`、`feedback_text:""` 清空字符串；使用 `effects:[]`、`character_ids:[]` 清空列表。
- `title`、`synopsis`、`script`、`kind`、`character_ids`、`production_notes`、`video_prompt`、Choice 的 `source_segment_id`/`target_segment_id`、`mode`、`text`、`order`、`effects`、`feedback_text`、`interaction`、`is_default` 不能发送 null。Patch 中这些字段可省略以保留现值，但可省略不代表可传 null。

把可见 Choice 改为 automatic 时，在同一操作中清空全部仅可见状态：

```json
{
  "op":"update_choice",
  "choice_id":"arrival_follow",
  "changes":{
    "mode":"automatic",
    "text":"",
    "feedback_text":"",
    "interaction":{},
    "is_default":false
  }
}
```
