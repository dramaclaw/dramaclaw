# 已有故事的角色与场景参考图

用户要求“生成角色图”“制作产品参考图”或“生成场景图”时读取。先 Get 最新故事、画布和阶段进度，按已保存资产定义及用户请求确定本批用途。角色定义已完整时直接准备图片计划；不重建故事，不把生成请求当作阶段完成确认。

## 图片批次契约

使用 `text-to-image-video` 的 `general-image` Recipe，但已有故事提供策划和视频目标，本批不执行策划或视频阶段。读当前 `freezone_get_workflow_skill` 的版本与 Recipe，取得 `freezone_begin_agent_product_generation` 的原始 `operation_id`，然后用完整 Plan 调用 `freezone_prepare_workflow_plan_draft`，不使用会展开完整视频模板的普通 Intent。

- `nodes` 只含本次新图片，以及可选的非执行简报。简报用 `textAnnotationNode`、节点级 `stage="input"`、`data.content`，不带 Recipe；用 `prompt_for` 向独立图片分支扇出，不串联图片。
- `source_context.story_id` 来自真实故事。人物、产品、车辆或重要物品在 `characters` 中的资产均使用 `asset_targets` 的 `kind="subject"`；场景在 `scenes` 中的资产用 `kind="scene"`。`entity_id` 必须是对应资产 ID，`segment_ids` 是实际使用它且已在故事声明该用途的非空、唯一片段列表。
- 每个 `imageGenNode.id` 在 `asset_targets` 与 `targets` 合计恰好映射一次。镜头开场分镜才使用 `targets`，字段为 `plan_node_id`、`story_segment_id`、`video_node_id`。角色批次不为了挂接视频而添加分镜映射。
- 同一图片即使含人物和环境，也只登记一种本次制作用途。例如车辆角色的车内控件图映射为车辆主体；若用户要求的是座舱场景图，则映射到已规划的座舱场景。不能将同一个 `cockpit_ref` 同时登记为场景、车辆主体或分镜。只有用户要求两种独立产物时才分别建图片节点；后续复用已生成图片时通过 `external_inputs` 和 `media_input_for` 引用，不重复登记目标。
- `groups` 为数组，只分组本次图片。已有故事视频留在 Plan 外，生成后由宿主按目标回连。用户要求生成时显式传 `run_after_create=true`，只创建时为 `false`；展示返回预览并按现有草稿确认入口执行，不逐节点补跑。

## 完整范例：驾驶员与车辆角色参考图

示例假设最新故事 `story-driving` 已定义 `driver`、`vehicle` 两个主体，`opening`、`escape` 两个片段的 `character_ids` 均包含它们，用户已要求生成这两项角色图。ID、视觉简报和参数必须替换为当前故事及用户输入；`skill.version` 的示例值为 2，实际从本次规划包复制，并与生成准入一致。未指定模型时用 `recommended`，由宿主解析当前可用参数；不询问视频参数。

```json
{
  "schema_version": "freezone_workflow_plan.v1",
  "skill": {"id": "text-to-image-video", "version": 2},
  "title": "驾驶员与车辆角色参考图",
  "source_context": {
    "story_id": "story-driving",
    "asset_targets": [
      {"plan_node_id": "driver_ref", "kind": "subject", "entity_id": "driver", "segment_ids": ["opening", "escape"]},
      {"plan_node_id": "cockpit_ref", "kind": "subject", "entity_id": "vehicle", "segment_ids": ["opening", "escape"]}
    ]
  },
  "expected_node_count": 3,
  "expected_node_counts": {"textAnnotationNode": 1, "imageGenNode": 2},
  "nodes": [
    {
      "id": "brief",
      "node_type": "textAnnotationNode",
      "stage": "input",
      "data": {"content": "沿用已确认故事中的驾驶员与车辆设定，制作人物外观和车辆座舱控件参考图，保持统一视觉风格。"}
    },
    {
      "id": "driver_ref",
      "node_type": "imageGenNode",
      "stage": "image",
      "data": {
        "displayName": "驾驶员角色参考图",
        "prompt": "根据已保存的驾驶员角色设定和共用视觉简报制作外观参考图。",
        "model": "recommended",
        "workflowCatalog": {"skillId": "text-to-image-video", "recipeId": "general-image"}
      }
    },
    {
      "id": "cockpit_ref",
      "node_type": "imageGenNode",
      "stage": "image",
      "data": {
        "displayName": "车辆角色参考图",
        "prompt": "根据已保存的车辆主体设定和共用视觉简报制作座舱控件参考图，作为车辆角色资产。",
        "model": "recommended",
        "workflowCatalog": {"skillId": "text-to-image-video", "recipeId": "general-image"}
      }
    }
  ],
  "edges": [
    {"source": "brief", "target": "driver_ref", "link_type": "prompt_for"},
    {"source": "brief", "target": "cockpit_ref", "link_type": "prompt_for"}
  ],
  "groups": [{"label": "角色参考图", "node_ids": ["driver_ref", "cockpit_ref"]}]
}
```

## 提交前检查与恢复

提交前核对完整 `nodes`、当前工具 Schema、Skill 身份和 Recipe；图片 ID 集合必须等于两种目标中的 ID 集合，且无重复。逐个核对 `entity_id` 的资产类型、片段存在性和最新故事中的 `character_ids` / `scene_refs`；确认没有执行策划节点、视频节点或范围外的资产。缺少资产定义时，只按已获授权的设定补齐故事规划并回读，不猜测映射，不要求用户填写内部 ID。

如果图片草稿返回 `skill_stage_missing`（缺少策划／视频），先检查为何没有命中已有故事图片契约：`story_id`、遗漏或重复的映射、将参考图错放到 `targets`、带 Recipe 的简报及额外执行节点。修正原始完整图片 Plan，保持原 `operation_id` 和用户范围；不能直接补可执行策划或视频，不能改用完整视频模板、逐节点操作或建议放宽校验。

明确为草稿提交前的契约拒绝时，修正后最多重试一次；同一错误路径仍失败就停止，报告“我提交的图片计划尚未符合契约，角色图尚未提交生成”，并给出具体校验项。次数不证明平台不支持纯图片工作流，不将自己的计划错误归因于用户流程或平台能力。已有草稿按原草稿修订；确认或生成结果不明时先回读，不能用本节授权重放媒体生成。生成成功、失败和状态核实分别按 [生成执行](generation-execution.md) 处理。
