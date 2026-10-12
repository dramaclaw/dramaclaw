# Output Schema

When this skill is used as the second-layer director pass, it should write:

- one JSON object per line to `storyboard_labels.jsonl`
- one completion marker file at `storyboard_labels_summary.json`

Use the same executable row shape as sketch edit execute:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 3,
  "beat_number": 7,
  "execution_mode": "polish",
  "sketch_path": "/abs/path/to/sketch.png",
  "beat": {
    "beat_number": 7,
    "narration_segment": "...",
    "visual_description": "..."
  },
  "sketch_colors": [],
  "result": {
    "decision": "revise",
    "main_problem": "staging_unclear",
    "reasoning": "1-3 concise sentences.",
    "edit_instruction": "删除... 改成... 保留... 不要...",
    "confidence": 0.88
  },
  "raw_text": ""
}
```

After the final row has been written, also write `storyboard_labels_summary.json`:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 3,
  "label_count": 5,
  "output_jsonl": "/abs/path/to/project/verify_reports/ep003/storyboard_labels.jsonl"
}
```

## Constraints

- every row must be `decision=revise`
- `execution_mode` must remain `polish`
- write rows only for beats that the director pass actually wants to modify
- it is valid to append one row at a time while reviewing beats
- but `storyboard_labels_summary.json` must only be written after the full `storyboard_labels.jsonl` file is complete
- downstream `validate / execute` treat `storyboard_labels_summary.json` as the completion marker
- use the shared executable `labels.jsonl` shape so the existing validate / execute / copy-back flow can be reused
- keep `main_problem` inside the shared executable set:
  - `staging_unclear`
  - `pose_action_wrong`
  - `scene_mismatch`
  - `character_count_wrong`
- prefer `staging_unclear` for shot scale / camera angle / placement / composition upgrades

## Director-layer `edit_instruction`

This layer is not fixing color identity or malformed anatomy first. Assume the correction worker already made the panel usable.

Use `edit_instruction` to direct:
- shot scale
- camera angle
- subject placement
- interaction geometry
- beat-to-beat shot variation

Preferred structure:
- `删除...`
- `改成...`
- `保留...`
- `不要...`

Good examples:
- `删除当前过远的双人中景。改成更近的中近景，主角在左前，晚翠在右后，保留递银动作。保留两人身份色和单床场景。不要新增第三人，不要遮住手部动作。`
- `删除当前与上一拍重复的平视站姿。改成略俯视机位，让主体右上/左下分离，保留两人对话关系。不要改身份色，不要新增彩色配角。`
