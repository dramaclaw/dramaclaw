---
name: sketch-correction-worker
description: Use when doing single-beat sketch quality control and preparing correction labels from a SuperTale project path and episode number. This skill turns one episode's selected sketches plus local script beat data into select_result.jsonl, select_summary.json, tasks.jsonl, and labels.jsonl for edit execution. Prefer using the current local coding agent model directly as the teacher unless the user explicitly asks to call an external model.
compatibility: Designed for skill-aware coding agents. Requires Python 3.10+ and access to local project files, selected sketches, and verify_reports.
metadata:
  {"openclaw":{"emoji":"✏️","primaryEnv":"SUPERTALE_API_KEY"}}
---

# Sketch Correction Worker

> **Agent 行为规范**：
> - **默认全包完成，不中途停下**。整个 `select → prepare tasks → label → validate → execute → copy 回正式草图目录` 流程应当一口气跑完。不要在中间阶段暂停等待用户确认，只有在遇到真正无法自动处理的错误时才停下来报告。
> - 不要向用户展示 curl 命令、API 路径、认证头等技术细节。
> - 读取项目内 SQLite、脚本、草图、验证报告时，继续本地直读。
> - 启动系统执行任务和查询任务状态时，优先走 `$SUPERTALE_API_URL` 提供的 API，而不是直接在 skill 里碰本地 Ray。
> - 环境变量解析顺序：
>   - 先读真实进程环境变量
>   - 再回退到项目级 `.claude/settings.local.json` / `.claude/settings.json` 里的 `env`
> - 项目上下文解析顺序：
>   - 必须提供 `SUPERTALE_PROJECT` / `SUPERTALE_USERNAME`
>   - 可来自真实进程环境变量，或项目级 `.claude/settings.local.json` / `.claude/settings.json`
>   - 不再从 `output/<user>/<project>` 目录结构推断项目身份
> - 只有在这两层都没有配置 `SUPERTALE_API_URL` / `SUPERTALE_API_KEY` 时，才回退到本地脚本直调模式。

Use this skill when the user wants:
- a teacher workflow to quality-check beat sketches from a project directory
- correction notes for hard sketch defects instead of shot design advice
- the current Claude Code model to directly produce `labels.jsonl`
- or, if explicitly requested, the freedom to swap in a stronger remote model later

## Inputs
- A SuperTale project path that contains `data.db` or `scripts/epXXX_script.json`
- An episode number
- Optionally an output path and beat limit

## Local-first principle
- Read local SQLite and local files directly whenever possible:
  - `data.db`
  - `scripts/epXXX_script.json`
  - `sketches/epXXX/*.png`
  - `verify_reports/epXXX/*.json`
  - generated `tasks.jsonl` and `labels.jsonl`
- Do not route those reads through HTTP APIs unless the user explicitly asks for API-level testing.
- Treat the skill scripts here as thin local entrypoints over shared Python modules in `src/novelvideo/...`.
- Avoid direct writes to durable business truth (for example selected sketches or beat records) from ad-hoc SQL; use shared modules or existing task flows for writes.

## Default workflow
1. When the user asks for episode-level `select`, do not ask them to run a prep step manually.
   Treat `select` as `always recompute` by default.
   Do not reuse an existing `select_result.jsonl` just because it already exists, unless the user explicitly asks to read the previous result without recomputing.
   Before recomputing, do NOT open, summarize, quote, or inspect the old `verify_reports/epXXX/select_result.jsonl`.
   The skill should first run:
   - `.hermes/skills/sketch-correction-worker/scripts/prepare_sketch_select_context.py`
   This clears and rebuilds `verify_reports/epXXX/select_run/`, moves any existing formal `select_result.jsonl` / `select_summary.json` into `select_run/`, and writes `verify_reports/epXXX/select_run/select_context.json`.
2. Then use the current local coding agent model directly to read `select_context.json`, inspect the generated low-token assets, and write:
   - one row per beat into `select_result.jsonl`
   - one small episode summary into `select_summary.json`
   - it is good to inspect one beat and append one row at a time to `select_result.jsonl`
   - but `prepare tasks` must not start until the full episode's `select_result.jsonl` has been completely written and `select_summary.json` has been written as the completion marker
   - inspect the per-beat compressed images directly, beat by beat
   - you must actually open and inspect image files in this recompute pass; do not regenerate `select_result.jsonl` from memory, prior discussion, or previous judgments
   - use a strict **image-first, text-second** order for each beat:
     - first write a short pure visual observation from the image only
     - only after that, compare against the beat's `visual_description`
     - only after that, decide `accept` or `edit`
   - do not let `visual_description` become the first-pass description of the image
   - do not paraphrase the script text as if it were the observed image content
   - before writing `select_result.jsonl`, you must have inspected at least one current `select_run/compressed/beat_XX.jpg` for every beat you judge in this recompute pass
   - if you have not inspected those images yet, stop and inspect them before writing the result file
   - do not inspect the old `select_result.jsonl` during this recompute pass
   - overwrite `verify_reports/epXXX/select_result.jsonl` and `verify_reports/epXXX/select_summary.json` with the newly recomputed result
   - for each beat, choose `selected_pool_id`
   - assign a `keepability_score` between `0.0` and `1.0`
   - judge color identity by broad hue family and usable tint range, not exact hex matching
   - if a visible named identity is clearly read in the wrong color family, default to `edit`; do not `accept` it away as a minor issue
   - if a beat has no fresh alternate candidates, treat the current selected sketch as the base candidate and still perform normal `accept` / `edit` triage
   - for each beat, explicitly write:
     - `observed_image_summary`: what is actually visible in the sketch
     - `mismatch_summary`: the concrete gap, only when the image materially disagrees with the beat
   - the final `reason` must be grounded in `observed_image_summary` first, not in script wording
3. The same skill then decides `accept` or `edit` from:
   - `selected_pool_id`
   - `keepability_score`
   - visible identity-color correctness
   - image-correctness hard failures
   - all `edit` beats now flow through the same polish-style reference edit pipeline
   - even when a beat needs strong restaging, keep it under `recommended_action: "edit"` and express the strength in the `edit_instruction` itself
4. Prepare episode-level `tasks.jsonl` locally only for the beats you have already decided should enter `edit`:
   - `.hermes/skills/sketch-correction-worker/scripts/prepare_sketch_edit_tasks.py`
   - this is local preparation, not an actor job
5. The local preparation step writes `tasks.jsonl`.
6. Then use the current Claude Code model to read `tasks.jsonl`, inspect the referenced images, and write one label row per task into `labels.jsonl`
   - `labels.jsonl` is an execute input, not a training dataset
   - write rows only for beats that will actually be edited
   - do not write `keep` rows into `labels.jsonl`
   - before the first append, start from an empty file: truncate the old file or recreate it from scratch
   - it is good to inspect one task and append one row at a time to `labels.jsonl`
   - after the last row is written, also write `labels_summary.json` as the completion marker
   - if there are no rows, still write an empty `labels.jsonl` plus `labels_summary.json` with `label_count: 0` to record that the pass completed and no edits are needed
   - but do not start validate or execute until the full `labels.jsonl` file has been completely written and `labels_summary.json` has been written
   - judge each edit beat as an isolated single-beat correction task
   - do not inject neighboring-shot, episode-level, or previous-verification reasoning into the correction instruction
7. After writing `labels.jsonl`, always run the validator before any execute step:
   - `.hermes/skills/sketch-correction-worker/scripts/validate_sketch_edit_labels.py`
   - if validation fails, fix the file first; do not submit execute against an invalid JSONL
8. After validation passes, automatically execute the edits in batch grid mode:
   - `.hermes/skills/sketch-correction-worker/scripts/start_sketch_edit_execute_job.py`
   - then wait for terminal completion with:
   - `.hermes/skills/sketch-correction-worker/scripts/wait_for_task_result.py`
   - use `.hermes/skills/sketch-correction-worker/scripts/read_task_result.py` only for spot checks or debugging while the job is still running
   - when API env vars are configured, this execution step must go through the API-backed job flow
   - do not ask the user whether to execute — just do it
9. After execute completes, automatically copy the generated edited sketches back to the formal sketch directory (`sketches/epXXX/`), replacing the old selected sketches for the edited beats. Do not ask the user — just do it.
   - execute writes `verify_reports/epXXX/sketch_edit_execute_summary.json`
   - inspect `grid_results[].candidate_cell_paths` in that summary
   - each `candidate_cell_paths` entry is a project-relative path to the edited single-beat image produced by execute
   - copy each candidate cell image onto its corresponding formal target:
     - source example: `grids/ep001/sketch/beat_04_t20260409134228.png`
     - target example: `sketches/ep001/beat_04.png`
   - match by `beat_nums` order inside each grid result; do not guess from arbitrary filenames
   - if execute partially fails, only copy back beats that have a concrete generated candidate cell path in the completed summary
   - do not overwrite formal sketches for beats that failed to render in this execute run
10. If the user also wants shot / camera / staging upgrades after hard-defect correction, run `sketch-storyboard-director` as the second-layer pass.

## Single-beat QC focus

This skill is a sketch quality-control worker, not a storyboard director.

Keep its attention on the current beat only:
- current sketch image
- current beat text
- current beat identity-color map
- visible hard defects

Do not rely on:
- neighboring sketches
- episode-overview rhythm judgments
- previous verification conclusions
- "this shot could be better" style direction

## Unified sketch judgment rubric

Use one consistent rubric derived from the actual sketch-generation prompt.

Ignore rhythm, repetition, continuity, and neighboring-shot variety signals here.
Those belong to `sketch-storyboard-director`, not to this correction layer.

Overall threshold:
- `select` is a **usable / not usable** gate, not a search for the best possible shot
- if the beat reads clearly, the named identity colors read correctly, and the image itself has no obvious hard defects, prefer `accept`
- do not send a beat to `edit` just because a stronger angle, tighter framing, or cleaner composition might exist
- only escalate to `edit` when the current sketch is materially misleading, materially confusing, identity-color wrong, or visibly malformed as an image

Decision order:
1. Check named identity colors first.
2. Then check image-correctness hard failures such as malformed anatomy, duplicate limbs / hands / fingers, text overlays, missing/extra named subjects, or unreadable staging.
3. Only after those checks decide whether the panel is already usable.

Primary pass / what to judge:
- Is the core story moment readable at a glance
- Is the image itself free of obvious hard defects
- Are the named characters present in the right count and rough relationships
- Are pose and staging readable
- Are named identity colors separated correctly enough to read who is who
- Are unnamed people and extras kept neutral / gray enough to avoid competing with named identities
- Are props and environment kept as line art / neutral support instead of stealing character-color attention
- Does the image still read as a minimal stick-figure storyboard rather than a rendered illustration
- Is there any accidental text / labels / numbering rendered into the image
- Is the image still functioning as a clean storyboard sketch rather than drifting into noisy rendering

Color interpretation inside this rubric:
- sketch colors are identity markers only; they are not final costume, skin, or hair colors
- first read the beat's explicit identity markers from `visual_description`; judge color against those identities, not against a generic “looks plausible” standard
- identify characters by readable color tint first, not by exact rendered hex
- if a figure has the assigned color tint, even when pale, washed out, partially desaturated, or slightly shifted within the same identity hue family, it still counts as identity-consistent
- nearby hue / tint / saturation variants are acceptable only when they still stay within the intended identity's readable color family
- absent identities are not errors; only visible identities need to be checked
- color should be treated as a strong signal, not an absolute oracle
- escalate color to a major problem when it swaps one named identity into another identity's color family, collapses two visible identities into the same readable color family, or makes the beat materially hard to parse
- for timeline pairs such as `重生前` vs `重生后`, preserving the separation between their identity color families is critical; if they visually collapse into the wrong family, do not dismiss it as minor tint drift
- if a visible named identity is in the wrong readable color family, treat that as a serious storyboard failure and send it to `edit`
- if an unnamed extra, servant, guard, passerby, or prop-side figure is color-filled like a named identity instead of staying neutral gray, treat that as a serious storyboard failure and send it to `edit`
- do not let "the scene is otherwise readable" override a named identity-color failure

Ignore or heavily downweight these during sketch `select`:
- prose-only atmosphere wording such as `寒意`, `铁锈感`, `压抑感`
- missing or weak background detail by itself
- final lighting polish
- material realism
- texture richness
- detailed anatomy polish
- costume fabric detail
- render-stage finish
- "could be stronger"
- "could be tighter"
- "could be more cinematic"
- "another angle might be better"

Background rule:
- do not trigger `edit` just because the background is sparse, simplified, or partially missing
- only escalate background / prop support to a real problem when that omission makes the spatial setup, action, or beat meaning hard to read

Allowed `reason` dimensions for `select`:
- `image_correctness`
- `character_count_relationships`
- `pose_staging`
- `story_readability`
- `identity_color`
- `prop_support_clarity`

Do not use prose/render vocabulary as the main reason for `select` decisions.
In particular, do not justify `accept` / `edit` with terms like:
- `寒意`
- `铁锈感`
- `压迫感`
- `冷肃氛围`
- `情绪强度`
- `氛围不够`
- `质感`
- `光影质感`
- `材质`

If such words appear at all, they must be secondary commentary only.
The actual decision must be explained through the allowed storyboard dimensions above.

Treat these as real sketch failures:
- the beat is hard to read
- the image structure collapses spatially
- a visible character has extra, duplicate, or malformed limbs, hands, or fingers
- the image has obvious body-part corruption, merged anatomy, or broken hand readability
- the wrong named identity is color-read
- two named identities become ambiguous
- a named character is missing, replaced, or wrongly emphasized
- an unnamed extra is color-filled like a named identity instead of staying neutral gray
- extras or props are color-filled in a way that competes with named identities
- the image stops reading as a clean stick-figure storyboard
- text, labels, or numbering appear inside the sketch image
- the sketch is cluttered enough that the storyboard function breaks

If none of the failures above are present, prefer `accept`.

Anti-projection rule:
- never describe an action, subject, or relationship in `reason` unless it is actually visible in the sketch
- when the script says one thing and the image shows another, describe the image first, then name the mismatch
- if you catch yourself writing script language such as `捏下巴`, `围殴`, `独角蜷缩`, etc., verify that the exact action is plainly visible in the image before keeping it in the final reason

## Local-first select command

```bash
uv run python .hermes/skills/sketch-correction-worker/scripts/prepare_sketch_select_context.py \
  /path/to/project \
  --episode-num 1
```

This defaults to:
- `verify_reports/ep001/select_run/select_context.json`
- `verify_reports/ep001/select_run/compressed/beat_XX.jpg`

Then the skill should read that file, inspect the current beat images, and write:
- `verify_reports/ep001/select_result.jsonl`
- `verify_reports/ep001/select_summary.json`

Read [references/select_result_schema.md](references/select_result_schema.md) before writing `select_result.jsonl`.

## Actor-backed task commands

**API 模式**（仅执行步骤使用）：Base URL `$SUPERTALE_API_URL/api/v1`，认证 `X-API-Key: $SUPERTALE_API_KEY`。

```bash
uv run python .hermes/skills/sketch-correction-worker/scripts/prepare_sketch_edit_tasks.py \
  /path/to/project \
  --episode-num 1 \
  --output /tmp/sketch_edit_tasks_ep001.jsonl
```

```bash
uv run python .hermes/skills/sketch-correction-worker/scripts/start_sketch_edit_execute_job.py \
  /path/to/project \
  --episode-num 1 \
  --labels-name labels.jsonl
```

```bash
uv run python .hermes/skills/sketch-correction-worker/scripts/wait_for_task_result.py \
  /path/to/project \
  --task-type sketch_edit_execute \
  --episode-num 1 \
  --scope edit_execute__...
```

## Task row shape
Each prepared task row contains:
- `task_type`
- `task_id`
- `project_dir`
- `episode_num`
- `beat_number`
- `execution_mode`
- `sketch_path`
- `narration_segment`
- `visual_description`
- `sketch_colors`
- `teacher_output_schema`

These task rows should stay intentionally slim.
Include only the context needed to decide how to edit the current sketch; do not repeat the full episode payload.

Read [references/output_schema.md](references/output_schema.md) before writing labels.

## Select result shape
Write one JSON object per line to `select_result.jsonl`.

Each row should contain at least:
- `beat_number`
- `selected_pool_id`
- `keepability_score`
- `observed_image_summary`
- `mismatch_summary` (optional for `accept`, required for `edit`)
- `reason`
- `recommended_action`
- `edit_mode` (optional compatibility metadata only; execute does not branch on it, preferred value `polish`)

Also write one small `select_summary.json` with:
- `episode_num`
- `project_dir`
- `summary`
- `beat_count`
- `accept_count`
- `edit_count`
- `output_jsonl`

`select` does not require multiple candidates.
If there is only the current selected sketch for a beat, the skill should still:
- assess whether that base image is already usable
- decide whether it should be accepted as-is or edited
- if it needs effectively full restaging, keep it under `edit` and write a stronger `edit_instruction`; do not split into a separate execute path
- avoid wording that implies a richer candidate comparison happened when it did not

Before writing the final file, verify this minimum inspection rule:
- every beat judged in this run has had its own `compressed/beat_XX.jpg` inspected in the current run
- if that did not happen, do not write `select_result.jsonl` yet
- do not treat a partially written `select_result.jsonl` as complete; only `select_summary.json` marks the end of the select pass

## Current-Claude-Code teacher mode
When using this skill in current-Claude-Code mode:
- treat `select` as a local file-reading task first, not an actor job
- use actor jobs only for long-running preparation or execution steps
- run the prep script yourself before starting model judgment
- always recompute `select`; do not short-circuit by summarizing an old `select_result.jsonl`
- during recompute, do not read the existing `select_result.jsonl` at all before finishing the new judgment
- do not call any external API unless the user explicitly asks for it
- only use the current selected sketches by default; do not read historical pool candidates unless the user explicitly asks
- inspect the compressed per-beat images inside `select_run/compressed/`
- do not claim `select` is finished unless those image inspections actually happened in the current run
- after `select`, continue through `tasks.jsonl -> labels.jsonl -> validate -> execute -> copy back` by default
- keep `raw_text` empty unless you intentionally want to preserve the free-form draft
- treat `labels_summary.json` as the completion marker for the full labels pass

## Validation command

```bash
uv run python .hermes/skills/sketch-correction-worker/scripts/validate_sketch_edit_labels.py \
  /tmp/sketch_edit_labels_ep001.jsonl
```

## Important constraints
- Prefer the two-step workflow: prepare tasks first, then label
- In default mode, the teacher is the current Claude Code model, not an external API
- `edit_instruction` should be directly executable
- `edit_instruction` is a short, directly executable correction instruction, not a long review paragraph
- carry `execution_mode` from `tasks.jsonl` into each `labels.jsonl` row unchanged; it is compatibility metadata and should remain `polish`
- treat every `revise` case as a constrained correction: fix the actual defect, do not redesign the shot unless the defect itself requires it
- when the correction requires removing old content, say so explicitly:
  - `后景只保留一个...`
  - `删除原有第二个人形`
  - `不要保留旧的重复主体`
- when subject count matters, state the exact visible count or exclusivity:
  - `只保留一个前世人物`
  - `前景仅一人，背景仅一人`
- each panel's edit_instruction should target at most 2 named identities
- this limits what edit_instruction can control, not what is allowed to exist in a sketch
- repeated appearances of the same identity do not count as extra identities
- unnamed extras may exist, but they must stay neutral / gray and must not become a third named identity target
- do not write vague notes like `增强情绪`, `更有张力`, `优化构图`, `提升氛围`
- for `edit_instruction`, prefer this structure:
  - `删除...`
  - `改成...`
  - `保留...`
  - `不要...`
- when old wrong content is present, put `删除...` first so the model does not over-preserve outdated figures, actions, or staging
- inside `改成...`, focus on the defect that actually needs correction:
  - `身份色...`
  - `删除多余主体/肢体/手指...`
  - `补回缺失主体...`
  - `修正人数/关系/遮挡...`
  - `去掉图中文字...`
- only specify `景别 / 角度 / 构图` when the defect itself is a staging or readability problem
- default goal: repair the image to a usable storyboard state, not to invent a better cinematic shot
- when a panel has 2 named identities, explicitly anchor the relationship:
  - who is left / right
  - who is front / back when relevant
  - who must remain fully readable
  - who must not block whom
  - whether there must be visible space between them
- for feeding, confrontation, restraint, handing-over, or any other two-person interaction, do not stop at `左右对峙`
- instead, state the concrete geometry:
  - `A 在右下床沿，B 在左上床面`
  - `A 不要挡住 B 的脸和上半身`
  - `两人之间留出明确空隙`
  - `勺子/手臂/道具跨过空隙递向对方`
- for non-symmetric interactions such as grabbing, restraining, feeding, forcing, handing-over, or pressing, also state:
  - who is the active actor and who is passive
  - how many visible arms / hands each side should contribute
  - whether one side wraps / covers / pins the other from above, below, front, or back
  - that the passive side must not mirror, answer, or turn into an equal gesture
  - explicit negatives such as `不要画成对称握手` or `不要双向回应` when needed
- For `select`, judge the image as a storyboard sketch, not as a final render.
- Follow the unified sketch judgment rubric above; do not create a second competing rubric here.
- Downweight narration-only atmosphere wording and render-finish concerns.
- infer visible identities mainly from the sketch, the beat text, and visible color-coded relationships
- use `sketch_colors` to verify visible identity-color alignment; absent identities are not errors
- when identities are mentioned, use the exact identity and hex color from the task payload
- do not use vague phrases like “粉色人物” or “橙色人物”
- The exact identity + hex requirement applies to `edit_instruction`, not to `select` acceptance thresholds
- but for `select`, a visible named identity landing in the wrong color family is still a major error and should normally force `edit`
- keep the teacher output concise and structured
