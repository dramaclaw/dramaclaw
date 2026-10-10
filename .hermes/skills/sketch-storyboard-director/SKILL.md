---
name: sketch-storyboard-director
description: Use when doing a separate post-QC storyboard-directing pass on SuperTale sketches. This skill focuses on shot scale, camera angle, staging, composition, and beat-to-beat visual rhythm after basic sketch correctness has already passed QC.
---

# Sketch Storyboard Director

> **Agent 行为规范**：
> - **默认全包完成，不中途停下**。整个 `prepare context → prepare tasks → label → validate → execute → copy 回正式草图目录` 流程应当一口气跑完。
> - 不要向用户展示 curl 命令、API 路径、认证头等技术细节。
> - 读取项目内 SQLite、脚本、草图时，继续本地直读。
> - 启动系统执行任务和查询任务状态时，优先走 `$SUPERTALE_API_URL` 提供的 API，而不是直接在 skill 里碰本地 Ray。
> - 环境变量解析顺序与 `sketch-correction-worker` 一致：先读真实进程环境变量，再回退到项目级 `.claude/settings.local.json` / `.claude/settings.json`。
> - 项目上下文解析顺序与 `sketch-correction-worker` 一致：必须提供 `SUPERTALE_PROJECT` / `SUPERTALE_USERNAME`，不再从目录结构推断。
> - 只有在 API 环境未配置时，才回退到本地脚本直调模式。

Use this skill only after sketch QC is already acceptable.
This skill should complete a full directing-and-modification pass in one run without pausing for intermediate confirmation.

This skill is for:
- 景别
- 机位
- 构图 / 调度
- 视觉节奏
- 相邻 beat 的镜头变化
and it should actually drive the second-layer sketch modification pass, not just produce comments.

This skill is not for first-line defect checking. Do not use it to judge:
- 身份色是否正确
- 非命名角色是否误上色
- 多余手 / 多余脚 / 畸形肢体
- 图中文字
- 主体缺失 / 多余主体

Those belong to `sketch-correction-worker`.

## Trigger

Use this skill when the user wants:
- a post-QC directing pass on sketches
- stronger shot variety across beats
- better camera angle or shot scale
- cleaner staging / composition
- a manual second pass after the QC skill has already finished
- actual second-layer sketch changes, not just notes

## Inputs

- project path
- episode number
- optionally a beat subset such as `4,7,9`
- current selected sketches
- script beat text

## Prep command

Run this first:

```bash
uv run python .hermes/skills/sketch-storyboard-director/scripts/prepare_storyboard_director_context.py \
  /path/to/project \
  --episode-num 1 \
  --beats 4,7,9
```

This writes:
- `verify_reports/ep001/storyboard_director_run/director_context.json`
- `verify_reports/ep001/storyboard_director_run/overview_grid.jpg`
- `verify_reports/ep001/storyboard_director_run/compressed/beat_XX.jpg`

Then prepare the executable tasks for the beats you want to direct:

```bash
uv run python .hermes/skills/sketch-storyboard-director/scripts/prepare_storyboard_director_tasks.py \
  /path/to/project \
  --episode-num 1 \
  --beats 4,7,9
```

This writes:
- `verify_reports/ep001/storyboard_tasks.jsonl`

## Workflow

1. Confirm the requested beats have already passed `sketch-correction-worker`.
   - for now, trust the user or the immediately previous workflow step; do not try to invent a hidden marker file
2. Run the prep command to generate `director_context.json` and `overview_grid.jpg`.
3. Run the task-prep command to generate `storyboard_tasks.jsonl` for the requested beats.
4. If directing 3 or more beats, read `overview_grid.jpg` first as the primary whole-episode directing view.
5. If directing fewer than 3 targeted beats, inspect the corresponding per-beat compressed images directly first, then use `overview_grid.jpg` only as optional context.
6. Read the current selected sketches for the requested beats only when a beat needs drill-down.
7. Use image-first reasoning: describe what is actually visible before naming a directing issue.
8. Apply anti-projection discipline: do not invent crowding, emptiness, weak separation, or rhythm repetition unless it is actually visible in the images.
9. Read the corresponding beat text.
10. Judge only directing dimensions:
   - shot scale
   - camera angle
   - subject placement
   - interaction geometry
   - visual rhythm across nearby beats
11. Ignore basic QC issues unless the user explicitly asks to combine them.
12. Read `references/output_schema.md`, then write only the beats that should actually be changed into:
   - `verify_reports/epXXX/storyboard_labels.jsonl`
   - before the first append, start from an empty file: truncate the old file or recreate it from scratch
   - it is good to inspect one beat and append one row at a time to `storyboard_labels.jsonl`
   - after the last row is written, also write `verify_reports/epXXX/storyboard_labels_summary.json` as the completion marker
   - if there are no rows, still write an empty `storyboard_labels.jsonl` plus `storyboard_labels_summary.json` with `label_count: 0`
   - but do not start validate or execute until the full `storyboard_labels.jsonl` file has been completely written and `storyboard_labels_summary.json` has been written
13. If `storyboard_labels_summary.json` records `label_count: 0`, stop there:
   - validate is optional
   - skip execute
   - skip copy-back
   - optionally write `storyboard_director_notes.md` saying no director changes are needed
14. Validate the labels:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/validate_storyboard_director_labels.py verify_reports/epXXX/storyboard_labels.jsonl`
15. Execute the second-layer sketch changes:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/start_storyboard_director_execute_job.py /path/to/project --episode-num 1 --labels-name storyboard_labels.jsonl`
   - then wait with:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/wait_for_storyboard_director_execute.py /path/to/project --episode-num 1 --scope <scope>`
16. After execute completes, copy the generated candidate cells back onto `sketches/epXXX/` for the directed beats, using:
   - `verify_reports/epXXX/storyboard_director_execute_summary.json`
17. Optionally also write a concise human-readable note file:
   - `verify_reports/epXXX/storyboard_director_notes.md`

## Rules

- Assume QC has already passed.
- Prefer small, targeted directing changes over full regeneration.
- Use `overview_grid.jpg` as the primary directing surface when reviewing 3 or more beats together.
- For targeted subsets smaller than 3 beats, direct from the per-beat images first.
- Use neighboring beats when rhythm or repetition matters.
- It is valid to leave a beat unchanged if the current shot already works.
- Do not turn every note into a grand cinematic rewrite.
- This skill is a modifier, not a note-only reviewer.
- If a beat should stay unchanged, omit it from `storyboard_labels.jsonl` rather than forcing a rewrite.
- Do not let validate or execute consume a partially written `storyboard_labels.jsonl`.
- Treat `storyboard_labels_summary.json` as the completion marker for the full directing label pass.

## Output files

Primary executable output:
- `verify_reports/epXXX/storyboard_labels.jsonl`
- `verify_reports/epXXX/storyboard_labels_summary.json`
- beat rows use the same executable shape as correction-worker labels; read [references/output_schema.md](references/output_schema.md) before writing
- each row should still include:
  - `project_dir`
  - `episode_num`
  - `beat_number`
  - `execution_mode`
  - `sketch_path`
  - `beat`
  - `sketch_colors`
  - `result`
  - `raw_text`
- `storyboard_labels_summary.json` should contain at least:
  - `project_dir`
  - `episode_num`
  - `label_count`
  - `output_jsonl`

Optional human-readable summary:
- `verify_reports/epXXX/storyboard_director_notes.md`

If you also write notes, use this structure:

```md
# Episode N Storyboard Notes

- Beat 3: 保持不动。
- Beat 4: 改成更近的中近景，保留两人位置关系。
- Beat 7: 机位略下压，主体左下/右上分离，留出动作空隙。
```

Keep each beat note short and directly actionable.

## Output style

Write short, concrete storyboard notes such as:
- `改成更近的中近景，保留两人位置关系。`
- `机位下压一点，让前景压迫感更直接。`
- `避免连续三个平视中景，这拍改成略俯视。`
- `主体左下/右上分离，留出动作空隙。`

## Final reporting discipline

When summarizing the completed director pass:
- explicitly separate `modified beats` from `unchanged beats`
- do not say the whole episode was updated if only a subset of beats was regenerated
- do not state that the entire episode rhythm is now definitively improved unless you actually re-review the full updated overview after execute
- if no post-execute whole-episode re-review happened, describe rhythm changes as the goal or expected effect of this pass, not as a proven final result
