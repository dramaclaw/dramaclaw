# Output Schema

When this skill is used with the current Claude Code model as the teacher, it should write:

- one JSON object per line to `labels.jsonl`
- one completion marker file at `labels_summary.json`

`labels.jsonl` is the execute input for edited beats only, not a full-dataset export.

Each row should look like:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 1,
  "beat_number": 4,
  "execution_mode": "polish",
  "sketch_path": "/abs/path/to/sketch.png",
  "beat": {
    "beat_number": 4,
    "narration_segment": "...",
    "visual_description": "...",
    "location": "...",
    "time_of_day": "...",
    "audio_type": "...",
    "speaker": "...",
    "set_description": "..."
  },
  "sketch_colors": [
    {
      "identity": "苏长明_官员时期",
      "color_name": "BURNT SIENNA",
      "color_value": "#C95B3E",
      "raw": "#C95B3E BURNT SIENNA"
    }
  ],
  "result": {
    "decision": "revise",
    "main_problem": "character_count_wrong",
    "reasoning": "1-3 concise sentences.",
    "edit_instruction": "删除... 改成... 保留... 不要...",
    "confidence": 0.92
  },
  "raw_text": ""
}
```

After the final row has been written, also write `labels_summary.json`:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 1,
  "label_count": 3,
  "output_jsonl": "/abs/path/to/project/verify_reports/ep001/labels.jsonl"
}
```

## Constraints

- `execution_mode` must be `polish`
- copy `execution_mode` forward from the task row unchanged
- every row in `labels.jsonl` must be a revise row for an actually edited beat
- before the first append, truncate the old file or start from an empty new file
- it is valid to append one row at a time while reviewing tasks
- `labels_summary.json` must only be written after the full `labels.jsonl` file is complete
- if no edits are needed, still write an empty `labels.jsonl` and `labels_summary.json` with `label_count: 0`
- downstream `validate / execute` treat `labels_summary.json` as the completion marker
- `result.decision` must be `revise`
- `result.main_problem` must be one of:
  - `identity_color_mismatch`
  - `staging_unclear`
  - `scene_mismatch`
  - `character_count_wrong`
  - `pose_action_wrong`
- `edit_instruction` must be directly executable
- `edit_instruction` should read like a short image-edit execution instruction, not a review paragraph
- `edit_instruction` should stay within about 120-180 Chinese characters
- infer visible identities mainly from the sketch itself, beat text, and visible color-coded relationships
- `sketch_colors` is for verifying visible identity-color alignment; absent identities are not errors
- when `decision=revise` and the revision involves identity color correction, `edit_instruction` should include at least one `#RRGGBB` color reference
- if identities are mentioned in `edit_instruction`, use exact `identity + hex color`
- each edited panel should involve at most 2 named identities; repeated appearances of the same identity still count as 1
- unnamed extras may remain, but they must stay neutral / gray and should not become a third named identity target
- do not use vague color phrases such as `粉色人物` or `橙色人物`

## `edit_instruction` writing rule

Treat every `revise` case as a directed re-generation with constraints.
Do not write vague feedback like:
- `加强情绪`
- `更有张力`
- `优化构图`
- `提升氛围`

Instead, write a concrete instruction that tells the image model:
- what to keep
- what to change
- what to remove
- what identity colors must be preserved or corrected
- what should not appear
- whether subject count / occlusion / malformed body parts must be fixed

Preferred structure:
- `删除...`
- `改成...`
- `保留...`
- `不要...`

When old wrong content is still visible, put `删除...` first so the model does not over-preserve outdated figures, actions, or staging.
Inside `改成...`, focus on the real defect:
- `身份色...`
- `删除多余主体/肢体/手指...`
- `补回缺失主体...`
- `修正人数/关系/遮挡...`
- `去掉图中文字...`
- only mention `景别 / 角度 / 构图` when the defect itself is a staging or readability problem

Good `edit_instruction` dimensions:
- removal / cardinality: 删除谁、不要保留什么、只保留几个主体
- identity color: exact `identity + #RRGGBB`
- image correctness: 删除多余手/手指/肢体，修掉畸形人体，补回缺失主体
- readability: 修正遮挡、主体关系、人数错误、图中文字
- staging / shot terms: only when needed to fix a real readability defect, not to upgrade the shot aesthetically

When the panel contains 2 named identities, the instruction should also make the relationship layout explicit:
- state who is on the left / right or front / back
- state who may not block whom
- state that both main figures must stay readable
- if an object or gesture crosses between them, say it crosses the gap rather than merging the bodies

When the defect is a non-symmetric two-person action, do not stop at a verb like `攥住` or `递向`.
Make the action geometry explicit:
- who is the active actor and who is passive
- exactly how many arms / hands are visibly involved on each side
- whether one side is wrapped / covered / pinned / held from above or below
- whether the passive side must not respond, mirror, or form a symmetric gesture
- if needed, explicitly say `不要画成对称握手` / `不要双向回应`

When the correction is about duplicate or leftover figures, be explicit:
- say `删除原有第二个人形`
- say `后景只保留一个前世人物`
- say `不要保留旧的重复主体`
- do not assume the image model will infer removals from composition changes alone

Bad example:
- `压迫感不够，增强情绪和氛围。`

Good example:
- `删除多余灰色家丁和重复手部。改成只保留苏清柔_皇后宫装时期洞房造型 #FF6B00 与苏清晏_重生前 #FF00FF 两个主体，苏清晏_重生前 #FF00FF 身体完整可读。保留上下压制关系。不要额外彩色配角、不要多余手指、不要图中文字。`
- `删除当前对称交握手势。改成苏清晏_重生后 #CCFF00 双手从上下包住晚翠_相府丫鬟时期 #FF00FF 的单手，苏清晏是主动抓握方，晚翠是被动承受方。保留苏清晏前倾。不要把晚翠画成主动回握，不要双人对称伸双臂。`
