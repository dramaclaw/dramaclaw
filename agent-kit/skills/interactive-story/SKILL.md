---
name: interactive-story
description: "Create, inspect, validate, or incrementally edit a playable branching interactive movie story in DramaClaw. Use for interactive films, branching narratives, story trees, choices, automatic transitions, multiple endings, story state, per-segment video production planning (models, durations, references and prompts), and Chinese requests such as 互动短剧、互动剧、互动影游、互动电影、分支剧情、剧情树、自动跳转、多结局、剧情状态. Do not use for the linear novel-to-video episode pipeline or ordinary script uploads."
---

# Interactive Story Creation

Turn a natural-language idea into a playable branching story on the canvas. Discuss the story, outline, choices, and endings in the user's language. Do not ask the user to provide JSON, Ink, node IDs, revisions, or idempotency keys.

## User-facing guidance

For an end-to-end interactive short drama, guide the user through three stages: **定故事 → 审制作 → 看成品** (use the user's language). These are conversation milestones, not nine separate approval steps or a mandatory wizard for every request.

- **定故事**: propose the creative direction, branches, endings and a target viewing duration for one playthrough. If the user has no duration preference, recommend an estimate rather than asking them to assign seconds to each segment. After outline approval, create and validate the story. Offer placeholder playtesting as an optional way to revise the story, not a required checkpoint.
- **审制作**: after story creation, briefly introduce production preparation as the next step. If the user requested the complete video work, continue into a reviewable production plan; if they requested only a story or placeholder prototype, offer this next step without preparing or writing all production fields. Read production-planning.md for the combined asset, timing, settings, reference, tail-frame and prompt plan. Present a short summary first and segment details on request; let the user revise exceptions in one reply rather than configuring each node.
- **看成品**: after production-plan approval and explicit generation authorization, apply the agreed preparation and generate in dependency-aware batches using available tools. Finalize downstream prompts against real tail frames when available. Continue routine work within the approved scope without repeated confirmations; surface missing inputs or material changes in creative direction, settings or spending scope. Preserve the failure-handling rules below. Invite playback review and targeted revisions; export only when requested and supported, without claiming automatic publication.

Recommend coherent defaults from the user's intent and actual model capabilities. The Agent owns per-segment analysis; the user reviews creative choices and exceptions. Do not ask separately about every asset, model, duration or reference. A plan-only confirmation does not authorize paid generation. Existing approval remains valid for unchanged scope. For a local edit, inspection or wording-only request, perform only that task rather than restarting these stages.

## Responsibilities

The Agent plans story semantics, segment timing, assets and prompts. Story tools own
story persistence and validation; canvas tools own production settings and references;
the existing runner executes media generation. Use returned IDs, revisions and results,
and do not recreate these responsibilities through direct canvas JSON or simulated results.

## Boundaries

- Handle interactive stories only. Do not route the request into the linear novel-to-video pipeline.
- Interactive short dramas (互动短剧/互动剧) use this Skill even when the user calls the deliverable a 剧情画布. Its story tools take precedence over generic workflow or canvas-command instructions. If the four story tools are unavailable after tool discovery, report that story creation is blocked. Never fall back to ordinary text nodes, generic canvas commands or workflow edges and call that an interactive story.
- Create and Patch are write operations. Combine related edits into one atomic Patch per preparation stage. An authorized multi-stage task may write again after new media or tool results become available; Get the latest story before each stage and validate each successful story write. Never replay an ambiguous write.
- Do not write canvas JSON directly or replace the four story tools with generic REST tools. Production-only node parameters use the existing Freezone node-edit tools described below; they are not StoryDraft fields.
- Missing final video does not block story creation. Start with placeholder media, then import or generate video later.
- Validate covers the schema, fallback ordering and bounded condition-aware path analysis, including automatic cycles. Analysis may report incomplete coverage. It does not compile Ink or replace playback verification.
- If the session has no bound project, stop and ask the user to open a project. If a write result is ambiguous, do not submit it again.

Read [references/story-contract.md](references/story-contract.md) in full whenever constructing Create or Patch arguments.

## Create

1. Converge on genre, protagonist goal, branch budget, and ending direction. Ask only for information that would materially change the story.
2. Present a natural-language outline first: title, synopsis, protagonist and conflict, segment/choice/ending counts, key branches, variables, timed choices, and an estimated viewing-duration budget for the main paths (separate from player decision time).
3. Obtain approval for the concrete outline before creating it on the canvas, unless the user has already approved that outline. Story creation does not authorize paid media generation.
4. Read the current canvas revision with `dramaclaw_get_freezone_canvas`.
5. Call `dramaclaw_create_interactive_story` once with the complete StoryDraftV2. Never replay a successful or ambiguous write. An explicit deterministic pre-write validation rejection may be corrected once under the rules below.
6. After success, call `dramaclaw_validate_interactive_story` and report the title, size, revision, and validation summary.

If Create succeeds but validation reveals a repair that is still within the approved outline, call Get before Patch. Do not reuse the revision from the Create receipt because canvas refresh or another writer may already have advanced it.

When the user has no preference, default to about seven story segments, two major choice points, and two endings. Prefer converging branches, use boolean flags for simple facts, avoid unnecessary numeric variables, and begin with placeholder media. `feedback_text` is optional: prefer short in-story feedback when it adds meaningful information or emotion. Avoid repetitive feedback; consecutive Choices may each have feedback when the story benefits. When a feedback Choice has variable effects, the player sees the variables' semantic labels with ↑/↓ rather than their numeric values, so choose labels such as “信任” or “危险” instead of generic scores. When present, feedback must acknowledge the behavior in-story and must not claim a new video was generated. Default every visible Choice to the bottom `overlay` presentation by omitting `interaction`; this makes the decision explicit and remains reliable before final video composition exists. Use `object_anchor` or `baked_video` only when the user explicitly requests an in-frame interaction and the target position in the final media is known. Never invent precise anchor coordinates from a placeholder or script alone. Never loop a Segment's main `media`. When motion should continue while the player chooses, put one dedicated `choice_loop` on that source Segment. A 2–4 second loop with a fixed camera and subtle ambient motion is a useful default, not a required creative format. Adapt duration and motion to the scene while keeping the loop transition stable and any clickable targets usable. All outgoing Choices share it. If its media is missing, the player freezes the main video on its tail frame.

Default to a reachable ending with no outgoing Choices. Use the player’s restart control for replay; do not add a final-to-start Choice merely to offer replay. Explicitly requested narrative loops are an exception: explain that their loop segment is not an ending and preserve a reachable exit. Validate and actual playback are separate checks.

## Edit

1. Confirm the story ID. If it is unknown, read the canvas, find a group node whose `data.storyGroup` is `true`, match its `data.label` or `data.displayName` to the requested title, and use its `data.interactiveStoryId`. Never use the group node's `id` as `story_id`. If multiple groups match, ask the user which story they mean.
2. Call `dramaclaw_get_interactive_story`; treat the returned story and revision as authoritative.
3. Apply explicitly requested edits directly when the target and scope are clear, including deletion or start changes. Ask for clarification or confirmation only when the intent is ambiguous or the operation has material consequences outside the requested scope; explain those consequences.
4. Combine all operations for the same user intent into one `dramaclaw_patch_interactive_story` call.
5. Validate after success and explain the result using story-facing names.

`remove_segment` cascades to directly connected Choices. When removing the start segment, set a new start in the same Patch. When removing an entity referenced by a condition, update that condition in the same Patch.

## Prepare video production

For production preparation of even one segment, including requests to write prompts,
connect references, assess tail frames, or make clips ready to generate, first read
[references/production-planning.md](references/production-planning.md).
A request to plan produces a combined reviewable plan with prompt drafts; after
approval, apply the agreed node parameters and finalize prompts from real references.
This does not authorize video generation.
For any prompt preparation or correction, first read
[references/prompt-fidelity.md](references/prompt-fidelity.md).
For an explicitly wording-only edit, preserve existing settings and use actual reference
mentions from node detail; never treat story choice edges as media inputs. This narrow
exception does not establish generation readiness: report any unchecked duration or
continuity as unverified. Before saying a clip is ready or submitting generation, complete
the per-segment readiness check in production-planning.md; prompt/reference writes alone
are not completion evidence.


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
Use production-planning.md for timing, actual node settings, references and tail-frame
readiness; use prompt-fidelity.md for narrative fidelity and prompt wording.
Preserve existing media and branching rules. Do not prepare all prompts during
ordinary placeholder story creation unless the user requested video preparation.

## Execution and completion

For authorized generation or resume requests, follow the execution handoff in
[references/production-planning.md](references/production-planning.md). Submit only
prepared story segments and preserve existing results unless regeneration was requested.
An accepted or running request is not a completed video; do not submit another run
merely because the first request has not finished.

## Read and Failure Handling

- Use Get before explaining an existing story. Use Validate alone for read-only validation.
- Never replay a successful or ambiguous write. After a failed Create/Patch, stop and
  report it unless the explicit revision-conflict recovery or deterministic pre-write
  validation correction applies. Before any recovery attempt, read
  [references/error-recovery.md](references/error-recovery.md) and follow its retry limits.
- `missing_video` is a production task, not a story-creation failure.
