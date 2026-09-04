# Interactive Story Tool Contract

The four business tools have the same names and semantics in the Codex MCP and Hermes adapter. `project_id` and `canvas_id` may be omitted when the session already binds them. Successful writes return `canvas_id`, `revision`, and `refresh_canvas=true`, which the host can use to refresh the current canvas.

Create and Patch write the canvas atomically through `InteractiveStoryService`; they do not use the browser bridge for ordinary Freezone node commands. The in-product Agent refreshes the matching canvas from a successful `agent.tool.updated` frame. If unsaved local edits exist, the frontend preserves a local copy and enters conflict state. An external stdio MCP client receives only the write receipt; unless its host implements a refresh adapter, the user must refresh or reopen the canvas.

The Agent produces `StoryDraftV1` and Patch data objects, not Ink source. The frontend deterministically compiles the canvas story group to Ink when previewing or exporting. Validate does not currently compile Ink.

## Tools

- `dramaclaw_create_interactive_story`: `base_revision`, `idempotency_key`, and a complete `story`.
- `dramaclaw_get_interactive_story`: `story_id`.
- `dramaclaw_patch_interactive_story`: `story_id`, `base_revision`, `idempotency_key`, and `operations`.
- `dramaclaw_validate_interactive_story`: `story_id`.

Do not call Create and Patch in the same user turn, and do not call Patch twice in one user turn.

## StoryDraftV1

```json
{
  "schema_version": "story_draft.v1",
  "story_id": "midnight_station",
  "revision": 0,
  "title": "午夜站台",
  "synopsis": "一句话梗概",
  "start_segment_id": "arrival",
  "characters": [],
  "variables": [],
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

V1 supports integer variables only. The initial value must be within the optional bounds.

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
  "media": {"source":"placeholder","status":"missing","version":1},
  "choice_loop": {
    "description": "角色保持等待姿势，雨水和灯光轻微流动。",
    "production_notes": "2–4 秒无缝循环；固定镜头；互动对象不得漂移；首尾帧连续。",
    "media": {"source":"placeholder","status":"missing","version":1}
  }
}
```

`kind=ending` requires an `ending_label` and must have no outgoing Choice. A scene must have a null `ending_label`. A timed choice must use 1–300 seconds and should have exactly one default Choice among Choices with the same source.

`choice_loop` is optional and is valid only on a Segment with outgoing Choices. It is one dedicated short animation shared by the entire choice point, not one clip per Choice. The main Segment `media` always plays once. When choices appear, the player switches to ready `choice_loop.media`; when it is missing, the player freezes the main video's tail frame. Describe a 2–4 second seamless loop with a fixed camera, stable first and last composition, stationary props/characters used by anchors, and only subtle ambient motion. Do not bake branch logic into this clip; Choice `interaction` still owns the UI or hotspot.

### Choice

```json
{
  "id":"arrival_follow",
  "source_segment_id":"arrival",
  "target_segment_id":"follow_signal",
  "text":"跟随灯光",
  "order":0,
  "condition":null,
  "effects":[],
  "feedback_text":"她没有立刻回答，却把手电筒递给了你。",
  "interaction":{"presentation":"object_anchor","anchor":{"x":0.68,"y":0.64,"object_label":"手电筒"},"ui_style":"glass","motion":"pop","transition":"fade"},
  "is_default":false
}
```

Choices from the same source must have unique `order` values. An ending segment must not be a Choice source.

`feedback_text` is an optional, short line shown immediately after a player confirms a Choice. Keep it sparse: omit it for routine Choices, and use it only for a relationship turn, information reveal, or another clearly felt state change (for example, “她的戒备似乎少了一些。”). When that Choice also has variable effects, the player sees each variable's semantic label with an ↑/↓ direction (for example, `信任 ↑`), never the numeric value. It does not generate, replace, or alter a video asset.

`interaction` is optional. `overlay` is the default bottom-choice presentation. `object_anchor` renders a real frontend choice at the normalized `anchor` point in the video frame; use `object_label` to name the prop or character it belongs to. `baked_video` expects visible UI to already exist in the video and creates only an accessible transparent rectangular hotspot. Its `anchor.x`/`anchor.y` are the rectangle center and `anchor.width`/`anchor.height` are required normalized dimensions; the full rectangle must stay within the source frame. Anchored interactions can use `glass`, `tag`, or `warning` UI styles, `fade`, `pop`, or `pulse` entrance motion, and `fade`, `flash`, or `cut` branch transition.

Variable condition:

```json
{"kind":"variable","variable":"courage","operator":">=","value":2}
```

Visited condition:

```json
{"kind":"visited","segment_id":"arrival","operator":">=","value":1}
```

Flat condition group:

```json
{"kind":"group","join":"and","items":[{"kind":"variable","variable":"courage","operator":">=","value":2}]}
```

V1 supports integer increments as its only effect:

```json
{"kind":"increment","variable":"courage","delta":1}
```

## Patch Operations

```json
{
  "story_id":"midnight_station",
  "base_revision":3,
  "idempotency_key":"patch-midnight-r3-ending",
  "operations":[]
}
```

Supported operations:

- `update_story_metadata`: `changes {title?, synopsis?}`
- `set_story_start`: `segment_id`
- `add_segment` / `update_segment` / `remove_segment`
- `add_choice` / `update_choice` / `remove_choice`
- `upsert_variable` / `remove_variable`
- `upsert_character` / `remove_character`

When adding a branch, add both the target Segment and its Choice in the same Patch. Do not send the complete Story returned by Get as a Patch.

Set `update_segment.changes.media` to `null` to clear existing media and restore a placeholder. Set `update_segment.changes.choice_loop` to `null` to remove the dedicated choice animation. Do not construct an empty media object manually.

## Validation Results

- `error` blocks later publication.
- `warning` identifies a production or experience issue that should be addressed.
- `info` is non-blocking guidance.
- Common issue codes include `missing_video`, `media_url_unresolved`, `timed_choice_uses_first_default`, `unreachable`, and `leaf_no_ending`.
