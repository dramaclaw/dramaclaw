---
name: interactive-story
description: "Create, inspect, validate, or incrementally edit a playable branching interactive movie story in DramaClaw. Use for interactive films, branching narratives, story trees, choices, automatic transitions, multiple endings, story state, per-segment video production planning (models, durations, references and prompts), and Chinese requests such as 互动影游、互动电影、分支剧情、剧情树、自动跳转、多结局、剧情状态. Do not use for the linear novel-to-video episode pipeline or ordinary script uploads."
---

# Interactive Story Creation

Turn a natural-language idea into a playable branching story on the canvas. Discuss the story, outline, choices, and endings in the user's language. Do not ask the user to provide JSON, Ink, node IDs, revisions, or idempotency keys.

## Boundaries

- Handle interactive stories only. Do not route the request into the linear novel-to-video pipeline.
- Create and Patch are write operations. Combine related edits into one atomic Patch per preparation stage. An authorized multi-stage task may write again after new media or tool results become available; Get the latest story before each stage and validate each successful story write. Never replay an ambiguous write.
- Do not write canvas JSON directly or replace the four story tools with generic REST tools. Production-only node parameters use the existing Freezone node-edit tools described below; they are not StoryDraft fields.
- Missing final video does not block story creation. Start with placeholder media, then import or generate video later.
- Validate covers the schema, fallback ordering and bounded condition-aware path analysis, including automatic cycles. Analysis may report incomplete coverage. It does not compile Ink or replace playback verification.
- If the session has no bound project, stop and ask the user to open a project. If a write result is ambiguous, do not submit it again.

Read [references/story-contract.md](references/story-contract.md) in full whenever constructing Create or Patch arguments.

## Create

1. Converge on genre, protagonist goal, branch budget, and ending direction. Ask only for information that would materially change the story.
2. Present a natural-language outline first: title, synopsis, protagonist and conflict, segment/choice/ending counts, key branches, variables, and timed choices.
3. Obtain approval for the concrete outline before creating it on the canvas, unless the user has already approved that outline. Story creation does not authorize paid media generation.
4. Read the current canvas revision with `dramaclaw_get_freezone_canvas`.
5. Call `dramaclaw_create_interactive_story` exactly once. Any permitted retry of the identical request must reuse the same idempotency key; do not retry an ambiguous result.
6. After success, call `dramaclaw_validate_interactive_story` and report the title, size, revision, and validation summary.

When the user has no preference, default to about seven story segments, two major choice points, and two endings. Prefer converging branches, use boolean flags for simple facts, avoid unnecessary numeric variables, and begin with placeholder media. `feedback_text` is intentionally sparse: omit it by default, and add one short in-story line only at a relationship turn, an information reveal, or another clearly felt state change. Do not add it to routine or consecutive Choices. When a feedback Choice has variable effects, the player sees the variables' semantic labels with ↑/↓ rather than their numeric values, so choose labels such as “信任” or “危险” instead of generic scores. When present, feedback must acknowledge the behavior in-story and must not claim a new video was generated. Default every visible Choice to the bottom `overlay` presentation by omitting `interaction`; this makes the decision explicit and remains reliable before final video composition exists. Use `object_anchor` or `baked_video` only when the user explicitly requests an in-frame interaction and the target position in the final media is known. Never invent precise anchor coordinates from a placeholder or script alone. Never loop a Segment's main `media`. When motion should continue while the player chooses, put one dedicated `choice_loop` on that source Segment. Describe a 2–4 second seamless loop with a fixed camera, stable first/last composition, stationary interaction targets, and only subtle ambient motion. All outgoing Choices share it. If its media is missing, the player freezes the main video on its tail frame.

Default to a reachable ending with no outgoing Choices. Use the player’s restart control for replay; do not add a final-to-start Choice merely to offer replay. Explicitly requested narrative loops are an exception: explain that their loop segment is not an ending and preserve a reachable exit. Validate and actual playback are separate checks.

## Edit

1. Confirm the story ID. If it is unknown, locate the story by its canvas title first.
2. Call `dramaclaw_get_interactive_story`; treat the returned story and revision as authoritative.
3. Apply small, unambiguous edits directly. Explain the impact and ask for confirmation before deleting a segment, replacing the start, or substantially restructuring branches.
4. Combine all operations for the same user intent into one `dramaclaw_patch_interactive_story` call.
5. Validate after success and explain the result using story-facing names.

`remove_segment` cascades to directly connected Choices. When removing the start segment, set a new start in the same Patch. When removing an entity referenced by a condition, update that condition in the same Patch.

## Prepare video production

For whole-story production planning, model/duration unification, or coordinated
reference and prompt preparation, or tail-frame continuity, first read
[references/production-planning.md](references/production-planning.md).
A request to plan produces a reviewable plan; after approval, apply the agreed
node parameters and prepare prompts. This does not authorize video generation.
For any prompt preparation or correction, first read
[references/prompt-fidelity.md](references/prompt-fidelity.md).
For a prompt-only edit, preserve existing settings and use actual reference
mentions from node detail; never treat story choice edges as media inputs.


When asked to prepare or generate story videos, Get the current story first. Keep
`script` as narrative, use `production_notes` for the production brief, and write
the final model-facing description into `video_prompt` through `update_segment`.
Do not merely copy narrative into the prompt. In the brief, describe the scene,
participating characters and their stable appearance, visible action, camera,
dialogue/sound intent, opening/ending composition, and continuity with adjacent
segments. Ask only about missing choices that materially affect production.
For converging branches, use an opening that works for all incoming paths rather
than assuming one predecessor. Describe only the current segment's visible action;
keep conditions, flags and outcome routing out of the video prompt.
Default to player-rendered choices, but allow requested decorative UI or baked
choice visuals. Baked visuals require real player hotspots to become clickable;
follow prompt-fidelity.md rather than adding a blanket UI prohibition.
Only request a stable ending when a choice pause or planned continuation needs it.
Plan tail-frame dependencies before media exists; bind a real captured frame and
finalize the opening prompt after the source video is ready. Do not invent assets.
Use the confirmed visual style and character descriptions consistently; do not
invent reference asset URLs. Resolution, duration, aspect ratio and audio support
remain generation settings, not guarantees established by prompt text. Verify
them in node settings; omit administrative boilerplate from model-facing prompts.
Preserve existing media and branching rules when preparing prompts. Preparing a
prompt does not submit a generation task, spend generation credits, or produce a
video; report these states separately. Missing prompts are skipped by batch video
generation. Do not prepare all prompts during ordinary placeholder story creation
unless the user has requested video preparation.

## Read and Failure Handling

- Use Get before explaining an existing story. Use Validate alone for read-only validation.
- `revision_conflict`: Get the latest story, preserve concurrent edits and rebuild only the still-authorized changes. Retry once with the new base revision and a new key for that changed payload; stop if the conflict repeats or the new state makes the intent ambiguous.
- `idempotency_conflict`: stop; do not hide the conflict by inventing a new key.
- `invalid_story`: explain the invalid entity or reference; do not bypass it by overwriting the entire tree.
- `missing_video` is a production task, not a story-creation failure.
