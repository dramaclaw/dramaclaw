# Interactive Story Tool Contract

The four business tools have the same names and semantics in the Codex MCP and Hermes adapter. `project_id` and `canvas_id` may be omitted when the session already binds them. Successful writes return `canvas_id`, `revision`, and `refresh_canvas=true`, which the host can use to refresh the current canvas.

Create and Patch write the canvas atomically through `InteractiveStoryService`; they do not use the browser bridge for ordinary Freezone node commands. The in-product Agent refreshes the matching canvas from a successful `agent.tool.updated` frame. If unsaved local edits exist, the frontend preserves a local copy and enters conflict state. An external stdio MCP client receives only the write receipt; unless its host implements a refresh adapter, the user must refresh or reopen the canvas.

The Agent produces `StoryDraftV2` and Patch data objects, not Ink source. The frontend deterministically compiles the canvas story group to Ink when previewing or exporting. Validate does not currently compile Ink.

## Tools

- `dramaclaw_create_interactive_story`: `base_revision`, `idempotency_key`, and a complete `story`.
- `dramaclaw_get_interactive_story`: `story_id`.
- `dramaclaw_patch_interactive_story`: `story_id`, `base_revision`, `idempotency_key`, and `operations`.
- `dramaclaw_validate_interactive_story`: `story_id`.

Combine related operations atomically per stage. Authorized later stages may Patch after Get refreshes the current revision, for example after obtaining a real tail frame. Do not repeat successful writes or replay ambiguous results.

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

- Use stable, short ASCII slugs for every ID.
- `story_id` and Segment, Choice, and Character IDs may contain letters, digits, `_`, and `-`, and must begin with a letter or digit.
- A Variable `name` is an Ink-compatible identifier: begin with a letter or `_`, followed only by letters, digits, or `_`.
- Set the story revision to `0` when creating. The service returns the persisted canvas revision.

### Character

```json
{"id":"traveler","name":"旅人","description":"身份、目标和性格","visual_description":"稳定外观"}
```

### Variable

```json
{"name":"courage","label":"勇气","initial":0,"minimum":0,"maximum":5}
```

Numeric variables use integer values. The initial value must be within the optional bounds.

### Flag

```json
{"name":"has_key","label":"已拿到钥匙","initial":false}
```

Flags represent simple yes/no story facts. Variable and flag names share one namespace and must be unique.

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
  "video_prompt": "夜间站台，中景镜头缓慢推进；旅人停在站牌前，雨水沿大衣滴落，末尾停在旅人等待决定的画面。",
  "media": {"source":"placeholder","status":"missing","version":1},
  "choice_loop": {
    "description": "角色保持等待姿势，雨水和灯光轻微流动。",
    "production_notes": "2–4 秒无缝循环；固定镜头；互动对象不得漂移；首尾帧连续。",
    "media": {"source":"placeholder","status":"missing","version":1}
  }
}
```

`kind=ending` requires an `ending_label` and must have no outgoing Choice. A scene must have a null `ending_label`. A timed choice must use 1–300 seconds and should have exactly one default Choice among Choices with the same source.

`video_prompt` is the independent, model-facing video description (at most 20,000
characters, default empty). It maps to the existing canvas video node `prompt`;
`script` maps to `narration` and `production_notes` to `storyProductionNotes`.
Create/Get/Patch preserve all three independently. Use `update_segment.changes.video_prompt`
to prepare or revise a prompt; use an empty string to clear it, not null. Omission
in a Patch preserves the existing value. Preparing prompts must not clear media.
Batch generation uses only non-empty video prompts, never narrative or notes as
fallback. Existing nodes without prompts remain playable placeholders/imported
clips but must have prompts prepared before generating missing video.

`choice_loop` is optional and is valid only on a Segment with outgoing Choices. It is one dedicated short animation shared by the entire choice point, not one clip per Choice. The main Segment `media` always plays once. When choices appear, the player switches to ready `choice_loop.media`; when it is missing, the player freezes the main video's tail frame. A 2–4 second loop with a fixed camera and subtle ambient motion is a useful default, not a required creative format. Adapt duration and motion to the scene while keeping the loop transition stable and any clickable targets usable. Do not bake branch logic into this clip; Choice `interaction` still owns the UI or hotspot.

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
  "feedback_text":"她没有立刻回答，却把手电筒递给了你。",
  "is_default":false
}
```

Choices from the same source must have unique `order` values. An ending segment must not be a Choice source.

Set `mode` to `automatic` and use an empty `text` when the system should choose the path after the source clip finishes. Automatic transitions are checked by ascending `order`. Use one final automatic transition without a condition as the fallback. Here, fallback means “the last unconditional automatic Choice by `order`”; it is not a timed default Choice. Every automatic Choice must use `is_default:false`, `text:""`, and `feedback_text:""`, and must use the default interaction: omit `interaction`, use `{}`, or preserve the serialized default object (`overlay`, null anchor, `glass`, `fade`, `fade`). Automatic Choices may apply `effects`; the empty feedback rule does not require moving or removing those effects. A source with only conditional automatic transitions and no fallback can stop when no rule matches. Do not mix an unconditional automatic fallback with visible Choices.

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

`feedback_text` is an optional, short line shown immediately after a player confirms a Choice. Prefer feedback when it adds meaningful information or emotion (for example, “她的戒备似乎少了一些。”). Avoid repetitive feedback; consecutive Choices may each have feedback when the story benefits. When that Choice also has variable effects, the player sees each variable's semantic label with an ↑/↓ direction (for example, `信任 ↑`), never the numeric value. It does not generate, replace, or alter a video asset.

`interaction` is optional. Omit it by default so the player sees an explicit bottom `overlay` decision. Use `object_anchor` or `baked_video` only after the user requests an in-frame interaction and the final media target position is known; do not infer precise coordinates from placeholder media or script text. `object_anchor` renders a real frontend choice at the normalized `anchor` point in the video frame; use `object_label` to name the prop or character it belongs to. `baked_video` expects visible UI to already exist in the video and creates only an accessible transparent rectangular hotspot. Its `anchor.x`/`anchor.y` are the rectangle center and `anchor.width`/`anchor.height` are required normalized dimensions; the full rectangle must stay within the source frame. Anchored interactions can use `glass`, `tag`, or `warning` UI styles, `fade`, `pop`, or `pulse` entrance motion, and `fade`, `flash`, or `cut` branch transition.

Variable condition:

```json
{"kind":"variable","variable":"courage","operator":">=","value":2}
```

Visited condition:

```json
{"kind":"visited","segment_id":"arrival","operator":">=","value":1}
```

Flag condition:

```json
{"kind":"flag","flag":"has_key","value":true}
```

Flat condition group:

```json
{"kind":"group","join":"and","items":[{"kind":"variable","variable":"courage","operator":">=","value":2}]}
```

Numeric increment:

```json
{"kind":"increment","variable":"courage","delta":1}
```

Set a flag:

```json
{"kind":"set_flag","flag":"has_key","value":true}
```

## Patch Operations

```json
{
  "schema_version":"story_patch.v2",
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

Supported operations:

- `update_story_metadata`: `changes {title?, synopsis?}`
- `set_story_start`: `segment_id`
- `add_segment` / `update_segment` / `remove_segment`
- `add_choice` / `update_choice` / `remove_choice`
- `upsert_variable` / `remove_variable`
- `upsert_flag` / `remove_flag`
- `upsert_character` / `remove_character`

When adding a branch, add both the target Segment and its Choice in the same Patch. Do not send the complete Story returned by Get as a Patch.

Set `update_segment.changes.media` to `null` to clear existing media and restore a placeholder. Set `update_segment.changes.choice_loop` to `null` to remove the dedicated choice animation. Do not construct an empty media object manually.

Every Patch operation uses the exact `{"op":"...", ...}` envelope shown above. `add_segment` wraps its value in `segment`; `add_choice` wraps it in `choice`; updates put changed fields under `changes`. Never substitute `type`, `operation`, `data`, or `value` for these names.

### Omission, empty values, and null

- Omit a field from `changes` to preserve its stored value.
- Use `condition:null` to remove a Choice condition, `ending_label:null` when changing an ending to a scene, and `choice_time_limit_sec:null` to remove a timer.
- Use `media:null` to restore placeholder media and `choice_loop:null` to remove the choice animation.
- Use `video_prompt:""`, `production_notes:""`, `synopsis:""`, or `feedback_text:""` to clear those strings; use `effects:[]` or `character_ids:[]` to clear those lists.
- Do not send null for `title`, `script`, `kind`, `character_ids`, `production_notes`, `video_prompt`, Choice IDs, `mode`, `text`, `order`, `effects`, `feedback_text`, `interaction`, or `is_default`. Omit them when unchanged.

For example, convert a visible Choice into an automatic transition atomically so no visible-only state survives:

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

## Validation Results

- `error` blocks later publication.
- `warning` identifies a production or experience issue that should be addressed.
- `info` is non-blocking guidance.
- Bounded condition-aware analysis also checks automatic cycles and unreachable conditional paths. Treat `path_analysis_incomplete` as incomplete coverage, not proof of correctness; test actual playback separately.
- Common issue codes include `missing_video`, `media_url_unresolved`, `timed_choice_uses_first_default`, `unreachable`, and `leaf_no_ending`.
