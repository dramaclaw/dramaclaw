# 运行模式（两种）

用户在配置完成后（init.md 决策树第 5 步）选择运行模式。两种模式共用同一套
pipeline 步骤顺序与专用工具，只是「是否每步解释并确认」不同；两种模式都不能在一轮里连续启动多个写任务。

模式由用户本轮明确表达或外围虾导输入框的模式按钮决定，并在本会话内保持：
- 当前消息包含 `[DRAMACLAW_RUN_MODE]` 且 `mode=episode_auto` → 用户已经通过外围虾导的“本集自动”按钮授权自动推进；不要再次询问运行模式或每步确认。任务完成后由后端自动协调器发起新的自动续跑轮次，每轮仍只执行一个写任务
- 用户说「每步确认 / 一步步 / 手动 / 每步问我」→ **逐步确认模式**（见下）
- 用户说「一次性 / 全自动 / 自动驾驶 / 一口气跑完 / 不用问我」→ **自动推进模式（每轮一步）**；这些说法只表示下次“继续”时不重复解释流程，不表示本轮可以跑完整集
- 用户没说 → 默认先问一句「要我**每步确认**还是**自动推进（每轮一步）**？」，问完按回答走

跨阶段大任务始终遵守根 `SKILL.md` 的拆解确认协议；运行模式不能绕过该协议。

开启外围“本集自动”时先做声线前置预检。配音已经完成或所需声线已就绪时不增加询问；无法确认或发现缺失时，启动确认必须让用户选择“缺失声线由虾导匹配系统声线”或“到虾塘上传/录制自定义声线”。该选择作为本次自动会话的 `voice_policy` 保存：`system` 表示用户已提前明确授权，后续到 `voice_setup` 可直接调用一次系统声线准备；`custom` 表示不得替换为系统声线，届时缺失仍存在则暂停等待上传。

---

## 模式一：逐步确认模式（step-by-step）

**核心规则：一次只推进一个步骤，每步之前先停下问用户，得到确认才执行；绝不连续跳步。**

### 每一步的固定动作

1. **报下一步**（一句话，不展开）：
   - 要做什么（步骤中文名）+ 会调用的工具 + 前置是否已满足
   - 例：「下一步：分集规划（`dramaclaw_plan_episodes`，目标 10 集）。原文与角色已就绪，可执行。」
2. **停下来问**：「执行这一步吗？（继续 / 跳过 / 调整参数 / 停）」
   —— 然后**结束本轮输出，等用户回复**。不要自动往下做。
3. 用户回复后：
   - 「继续 / 执行 / 好 / 下一步」→ 先查当前任务状态；若已有 queued/running，告知后台正在生成中并停止；若没有运行中任务，调对应专用工具启动当前一步 → **立即收口**，询问稍后是否继续查看进度或执行下一步
   - 「跳过」→ 不执行，直接报「再下一步」
   - 「改成 N 集 / 用某风格 …」→ 按调整后的参数执行该步
   - 「停 / 暂停」→ 停在当前步，等用户下次指令

### 不允许的行为

- ❌ 一次确认后连跑多步（哪怕用户只说「继续」，也只推进**一步**）
- ❌ 不问就执行写操作（plan/build/generate/compose 这类触发任务的步骤）
- ❌ 把「报结果」和「执行下一步」合并——必须报完结果/启动状态后结束本轮，等用户下一条消息
- ❌ 启动异步任务后继续轮询到 completed，再自动进入下一步

### 步骤来源

- 当前项目准备顺序只读 `playbooks/init.md`。
- 逐集制作顺序只读 `playbooks/episode.md`。
- 本文件只决定执行前是否再次询问用户，不增加、删除或重排步骤。
- 每完成一集后，询问是否继续下一集。

### 状态回执（每步执行后）

- 触发后最多做一次必要的 `dramaclaw_get_task(task_type=..., episode=...)` 状态查询
- 若状态为 queued/running：告诉用户后台正在生成中，等待完成后再继续；不要轮询到 completed
- 成功：按下表读取或展示完成数据；不要只说“完成”
- 失败：报 `task.error` / `error_code`，**停在该步**，不要自动重试或跳过

### 完成数据展示规则

每个步骤完成后，必须展示或汇总该步骤的真实产物。媒体类必须调用对应展示工具；文本/列表类用 markdown 表格或简短列表。没有可展示数据时，如实说明“已完成，但当前接口未返回可展示产物”，不要拼 URL、猜路径或拿旧数据充数。

| 步骤 | 完成后读取 / 展示 |
|------|-------------------|
| 摄入 | `dramaclaw_pipeline_status` 汇总 ingested/configured 状态；不要展示原文全文 |
| 配置项目 | `dramaclaw_get(path="/projects/{project}")` 汇总视觉风格、叙事方式、节奏、音频/视频配置 |
| 角色提取 | `dramaclaw_get(path="/projects/{project}/characters")` 展示角色列表 |
| 角色 face_prompt 检查/补齐 | `dramaclaw_get(path="/projects/{project}/characters")` 检查核心角色 `face_prompt`；缺失时先补齐并展示已补角色 |
| 分集规划 | `dramaclaw_get(path="/projects/{project}/episodes")` 展示分集列表 |
| 角色肖像 | `dramaclaw_get_character_media(media_kind="portrait")` 展示肖像 |
| 身份规划 | `dramaclaw_get_character_media(media_kind="identity")` 或角色 identities 接口汇总身份列表；没有身份图时只列身份 |
| 身份图生成 | `dramaclaw_get_character_media(media_kind="identity")` 展示身份图 |
| 脚本生成 | `dramaclaw_get_episode_script(episode=N)` 展示 beat 摘要 |
| 场景规划 | `dramaclaw_get(path="/projects/{project}/scenes")` 展示场景列表 |
| 道具规划 | `dramaclaw_get(path="/projects/{project}/props")` 展示道具列表 |
| 场景参考图 | `dramaclaw_get_scene_images()` 展示场景图 |
| 草图生成 | `dramaclaw_get_sketches(episode=N)` 展示草图 |
| AI 检测 | `dramaclaw_get_episode_script(episode=N)` 或 beats 接口汇总每个 beat 检测到的身份/道具；不要重复调用检测 |
| 全局视频优化 | `dramaclaw_get_episode_script(episode=N)` 或 beats 接口汇总 video_mode / video_prompt 就绪情况 |
| 首帧生成 | `dramaclaw_get_first_frames(episode=N)` 展示首帧 |
| 音频生成 | `dramaclaw_get_episode_media(episode=N, media_type="audio")` 展示音频 |
| 单 beat 视频 | `dramaclaw_get_episode_media(episode=N, media_type="video")` 展示视频片段 |
| 合成导出 | `dramaclaw_get_final_video(episode=N)` 展示最终成片 |
| 最终成片展示 | `dramaclaw_get_final_video(episode=N)`，若不存在则只说明暂无成片 |

---

## 模式二：自动推进模式（bounded auto）

自动推进不是单轮跑完整集。为了避免聊天超时和队列拥塞，自动推进也必须遵守：

- 一次用户消息最多启动 1 个写操作/异步任务。
- 启动任务成功后立即收口，告诉用户“已进入队列/已启动”，并提示下一步等任务完成后继续。
- 不在同一轮等待长任务完成，不继续提交下一步。
- 任何失败、429、前置缺失、任务不存在、404 或网络错误都立即停止并反馈错误原文。

自动推进的含义是：按 `pipeline/status.next_step` 自动选择下一步，不需要每步重新解释流程；但每轮仍只推进一个任务。用户通过文字选择自动模式时，由用户下次说“继续”触发；消息带有 UI 注入的 `mode=episode_auto` 时，任务完成后由后端自动协调器持久化触发下一轮。

外围 UI 自动续跑仍必须在以下情况暂停并回到手动模式：一般任务失败或取消、覆盖摄入、删除或清空、声线等必要选择缺失、无法安全自动补齐的前置条件、结果不完整、存在无法安全判断的多个方案，以及最终成片完成。身份图任务明确只因某个指定角色缺少 Portrait 而失败时，后端自动协调器可授权一轮白名单恢复：仅生成该角色 Portrait，同一角色最多自动尝试一次；补图完成后再由下一轮恢复身份图流程。外围虾导不收取 Agent 积分，也不要展示虾画 Agent 积分报价。

### 自动运行中的用户消息

- 用户可以在本集自动运行或任务生成期间继续发消息。
- 问答、解释、查看状态和进度不改变运行模式；后端自动续跑会等待当前聊天轮结束。
- 虾导判断消息可能要求修改、重做、替换或配置变更时，先调用 `dramaclaw_control_episode_auto(action="suspend")` 暂停后续推进，再询问确认；本轮不得执行该修改。
- 用户否认修改、说“算了/保持原样/继续自动”等意思时，调用 `action="resume"` 恢复同一自动会话。
- 用户确认修改时先调用 `action="pause"` 退出自动模式，再按普通单轮写入规则处理最多一个已确认修改；这样修改任务的状态与完成通知继续沿用手动模式。修改完成后再询问是否重新启用本集自动。
- 用户明确要求停止或切换手动时调用 `action="pause"`。
- `suspend`、`resume`、`pause` 都不取消当前 queued/running 任务。只有用户明确确认取消具体任务时，才走任务取消流程。
