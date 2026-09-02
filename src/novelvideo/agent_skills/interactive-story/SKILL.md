---
name: interactive-story
description: "Create, inspect, validate, or incrementally edit a playable branching interactive movie story in DramaClaw. Use for interactive films, branching narratives, story trees, choices, multiple endings, story variables, and Chinese requests such as 互动影游、互动电影、分支剧情、剧情树、选择分支、多结局、故事变量. Do not use for the linear novel-to-video episode pipeline or ordinary script uploads."
---

# Interactive Story Creation

Turn a natural-language idea into a playable branching story on the canvas. Discuss the story, outline, choices, and endings in the user's language. Do not ask the user to provide JSON, Ink, node IDs, revisions, or idempotency keys.

## Boundaries

- Handle interactive stories only. Do not route the request into the linear novel-to-video pipeline.
- Create and Patch are write operations. Call at most one story write tool per user message; Validate may follow a successful write.
- Do not write canvas JSON directly or replace the four story tools with generic REST tools.
- Missing final video does not block story creation. Start with placeholder media, then import or generate video later.
- Validate currently covers the StoryDraft schema and static graph structure. It does not compile Ink or prove that every condition combination is reachable.
- If the session has no bound project, stop and ask the user to open a project. If a write result is ambiguous, do not submit it again.

Read [references/story-contract.md](references/story-contract.md) in full whenever constructing Create or Patch arguments.

## Create

1. Converge on genre, protagonist goal, branch budget, and ending direction. Ask only for information that would materially change the story.
2. Present a natural-language outline first: title, synopsis, protagonist and conflict, segment/choice/ending counts, key branches, variables, and timed choices.
3. Explicitly ask whether to generate that outline on the canvas. Do not write until the user confirms the current outline.
4. Read the current canvas revision with `dramaclaw_get_freezone_canvas`.
5. Call `dramaclaw_create_interactive_story` exactly once. A retry of the same request must reuse the same idempotency key.
6. After success, call `dramaclaw_validate_interactive_story` and report the title, size, revision, and validation summary.

When the user has no preference, default to about seven story segments, two major choice points, and two endings. Prefer converging branches, avoid unnecessary numeric variables, and begin with placeholder media.

## Edit

1. Confirm the story ID. If it is unknown, locate the story by its canvas title first.
2. Call `dramaclaw_get_interactive_story`; treat the returned story and revision as authoritative.
3. Apply small, unambiguous edits directly. Explain the impact and ask for confirmation before deleting a segment, replacing the start, or substantially restructuring branches.
4. Combine all operations for the same user intent into one `dramaclaw_patch_interactive_story` call.
5. Validate after success and explain the result using story-facing names.

`remove_segment` cascades to directly connected Choices. When removing the start segment, set a new start in the same Patch. When removing an entity referenced by a condition, update that condition in the same Patch.

## Read and Failure Handling

- Use Get before explaining an existing story. Use Validate alone for read-only validation.
- `revision_conflict`: stop for this turn; Get again before constructing a new Patch in a later turn.
- `idempotency_conflict`: stop; do not hide the conflict by inventing a new key.
- `invalid_story`: explain the invalid entity or reference; do not bypass it by overwriting the entire tree.
- `missing_video` is a production task, not a story-creation failure.
