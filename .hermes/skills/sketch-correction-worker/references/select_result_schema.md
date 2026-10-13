# `select_result.jsonl` row schema

`select` should now write:

- one row per beat to `verify_reports/epXXX/select_result.jsonl`
- one small episode summary to `verify_reports/epXXX/select_summary.json`

This keeps the per-beat judgment at the same granularity as the actual work:
inspect one image, decide one beat, write one row.

## `select_result.jsonl` row shape

Each line is one JSON object:

```json
{
  "beat_number": 1,
  "selected_pool_id": "current_selected",
  "keepability_score": 0.82,
  "observed_image_summary": "图中只有一名橙色人物被四名灰色家丁围住殴打。",
  "mismatch_summary": "当前图缺失地面的洋红受害者，也没有捏下巴动作，实际画面更像围殴场景。",
  "reason": "当前候选缺失关键主体关系和动作，画面本体信息已经读错，需要进入 edit。",
  "recommended_action": "edit",
  "edit_mode": "polish"
}
```

## Row field rules

- `beat_number`: integer, required
- `selected_pool_id`: string, required unless there are truly no usable candidates
- `keepability_score`: float in `[0.0, 1.0]`
- `observed_image_summary`: required; one short sentence describing only what is actually visible in the image
- `mismatch_summary`: required for `edit`; optional for `accept`
- `reason`: short natural-language justification, usually 1-3 sentences
- `recommended_action`: one of:
  - `accept`
  - `edit`
- `edit_mode`: optional metadata only when `recommended_action` is `edit`
  - compatibility metadata only; execute does not branch on it
  - preferred value: `polish`

## `select_summary.json` shape

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 1,
  "summary": "10 beats accept, 5 beats edit",
  "beat_count": 15,
  "accept_count": 10,
  "edit_count": 5,
  "output_jsonl": "/abs/path/to/project/verify_reports/ep001/select_result.jsonl"
}
```

The summary file is for quick reading only.
The real per-beat truth lives in `select_result.jsonl`.

## Mandatory inspection rule

`select_result.jsonl` must not be written from memory, old discussion, or a previous result file.

During the current recompute pass, the agent must inspect:
- at least one current `select_run/compressed/beat_XX.jpg` for every beat it judges in this run

If that image inspection did not happen, the agent must not claim that `select` is complete.

Mandatory reasoning order for every beat:
1. First write `observed_image_summary` from the image only.
2. Then compare it against the beat's `visual_description` internally.
3. Then write `mismatch_summary` as the concrete gap, only when needed.
4. Only after that write `reason` and choose `recommended_action`.

Do not skip directly from beat text to decision.
Do not paraphrase the script text as if it were the observed image content.

## Decision guidance

`select` is still valid when a beat has only one current base image.
In that case:
- treat the current selected sketch as the only candidate
- decide whether that base image should be `accept` / `edit`
- if it needs substantial restaging, keep it under `edit`; do not split into a separate execute path
- do not pretend a multi-candidate comparison happened if it did not
- prefer the generated current-only low-token assets:
  - `select_run/compressed/beat_XX.jpg` for per-beat QC follow-up

Use this color interpretation standard:
- sketch colors are identity markers only
- exact hex matching is not required at `select` time
- always compare color against the beat's explicit identity markers in `visual_description`
- pale / washed-out / desaturated tint variants still count when the intended identity remains readable
- small within-family hue shifts are acceptable only when they stay inside the intended identity's readable color family
- color becomes a major problem when it swaps a named identity into another identity's color family, creates ambiguity between visible identities, or materially hurts beat readability
- timeline-separated identities such as `重生前` / `重生后` should remain visually distinguishable by color family; if they collapse, treat that as a serious problem
- if a visible named character is read in the wrong identity color family, default to `edit`
- do not `accept` a beat that clearly swaps one visible named identity into another named identity's color family

Before deciding `accept` / `edit`, inspect the full image:
- character count and relationships
- pose / action / staging
- core beat readability and spatial setup
- color identity fit
- image-correctness hard failures

Image-first rule:
- describe the actually visible subjects, colors, actions, and staging before consulting the beat text
- if the image and text disagree, trust the visible image for `observed_image_summary`, then record the disagreement in `mismatch_summary`

Allowed primary reason dimensions:
- `image_correctness`
- `character_count_relationships`
- `pose_staging`
- `story_readability`
- `identity_color`

Overall threshold:
- `select` is a usable / not usable gate, not a hunt for the best possible shot
- if the beat reads clearly, the named identity colors read correctly, and the image itself has no obvious hard defects, prefer `accept`
- do not choose `edit` just because another angle, cleaner framing, or stronger composition might exist
- reserve `edit` for cases where the current image is materially misleading, materially confusing, identity-color wrong, or visibly malformed as an image
