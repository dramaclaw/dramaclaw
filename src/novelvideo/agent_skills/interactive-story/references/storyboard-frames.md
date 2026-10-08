# 分镜图批量制作

仅在已确认的互动故事镜头缺少必要开场图时读取。先按 [制作规划](production-planning.md) 判断镜头承接：已用 `continuityMode=auto` 接续前镜尾帧的镜头，不再规划独立开场分镜图；只为确实缺图的独立开场镜头建图片工作流。复用已有且已生成的角色、场景、产品图片。视频参数和故事结构不属于图片 Plan。用户只要求制作分镜图时，只询问缺失的图片生成参数；不要先问视频声音、模型、分辨率或时长。若图片工作流的预检要求视频参数，先检查执行范围是否错误扩展到已有视频节点，不把视频问题转给用户。

## 创建与提交

1. 先用 `freezone_get_workflow_skill(skill_id="text-to-image-video")` 获取当前版本与 `available_recipes`，确认其中有 `general-image`，再用 `freezone_begin_agent_product_generation(product_kind="workflow_result", generation_session_id=本次会话ID, skill_id="text-to-image-video", skill_version=当前版本, normalized_inputs=已确认输入)` 取得许可。沿用返回的项目、画布和原始 `operation_id`；无有效许可就停止，不改用逐图画布命令。
2. 准备一个 `freezone_workflow_plan.v1`：每个缺图镜头恰好一个 `imageGenNode`，显式使用允许的 Recipe；`source_context.story_id` 及 `source_context.targets[]` 的 `plan_node_id`、`story_segment_id`、`video_node_id` 记录每张分镜与已有视频的精确映射，供图片完成后自动接回。已生成且本镜需要的人物、场景、产品图片作为 `external_inputs`，用 `media_input_for` 连到对应分镜；宿主会在分镜完成后将这些图片也接到目标视频。没有共用图片时，以一个 `stage=input` 的非执行文本简报节点用 `prompt_for` 扇出。图片分支互不串联；`groups` 为数组，分组只含新图片，Plan 不创建视频节点，也不把剧情选择线或已有视频节点作为 Plan 边。
3. `freezone_prepare_workflow_plan_draft` 使用原始 `operation_id`；用户已授权创建并生成时设 `run_after_create=true`，仅授权创建时设 `false`。展示预览，确认后只调用一次 `freezone_confirm_workflow_draft`。前者由编译器一次提交图片生成，不再逐节点运行或重复调用 `freezone_run_workflow`。

产品、角色和场景参考图属于前置素材，分镜图属于具体镜头，分别核实用途与完成状态。图片批次使用已保存故事的规划，不添加可执行策划或视频节点。同一 `plan_node_id` 不能同时出现在 `targets` 与 `asset_targets`；需要两种产物时分别制作节点，或把已有参考图作为分镜的上游引用。不要为修复校验错误改变图片用途或把阶段合并。

角色／场景图片的完整范例、提交前映射检查，以及图片批次误报缺少阶段时的恢复，见 [参考图图片批次](reference-images.md)。同一规则适用于本节分镜批次：先修复映射或多余执行节点，不补策划／视频来通过校验。

## 回读与连接

草稿确认、画布落图和图片完成是不同状态。按 `workflowInstanceId`、`workflowPlanNodeId` 回读真实节点映射；运行中不修改图片工作流的图。宿主在图片完成后核对故事与片段映射，并自动把成功的独立开场图接到对应视频；自动承接尾帧的镜头不接冗余分镜。再次 Get 画布与目标节点，核对实际图片连线及 `reference_media`；自动接图失败时报告具体镜头，不把它说成已就绪。失败镜头保持待准备，不重复建图或重放整个 Plan。

已确认要使用的人物、场景和产品图片也须按镜头用途连到现有视频，并回读真实 `reference_media`。宿主按引用顺序在视频提示词中补足缺失的 `@图片N` 及用途；Agent 只维护剧情和镜头动作，不猜编号或重复写入素材用途。引用缺失或模型不支持当前时长、模式、参考数的镜头仍待准备；其他已就绪镜头可继续。只有 `accepted` 而无执行终态时，报告图片已提交，不声称已接图或视频已生成。

先前只创建图片、后来获得生成授权，或继续已有工作流的未完成图片时，用一次 `freezone_run_workflow(node_ids=未完成图片节点ID, direction="node", regenerate=false)`；不覆盖已完成图片。图片生成失败不自动重试，按 [生成执行](generation-execution.md) 处理授权与状态。
