---
name: dramaclaw-workflows
description: Create, revise, confirm, run, or resume multi-node DramaClaw Freezone canvas workflows. Use for requests involving a workflow, several connected nodes, grouped production stages, storyboards, or text/image/video/audio pipelines; do not use for one standalone canvas operation.
---

# DramaClaw Workflows

Build one coherent workflow transaction, not a sequence of standalone canvas edits.

## Required behavior

- Planning authors topology, Recipe selection, dependencies, confirmed parameters, and short
  node task briefs. Each node prompt should state its task, scope, upstream outputs, and reference
  roles in one or two concise sentences. Preserve user-provided story facts and source material.
  Do not invent finished scripts, detailed shot-by-shot storyboards, dialogue, camera choreography,
  sound cues, or final media prompts before upstream stages execute. Execution-time Recipe
  compilation uses actual upstream outputs to produce executable prompts.

- Read this Skill and its references only through the exact locator advertised by the current host.
  Never invent `project://` paths. Use a canvas summary already supplied by the host; if current
  canvas data must be refreshed, call `freezone_get_canvas_ontology` instead of inventing a
  `canvas://` resource. MCP clients must use only resource URIs returned by `resources/list` or
  `resources/templates/list`. The Workflow MCP intentionally returns an empty static
  `resources/list`; this is supported and does not mean the catalog is unavailable.
  Discover accessible Skill/Recipe IDs with `workflow_catalog_search`, then use the
  advertised templates for resource reads. Do not enumerate or guess another user's
  private catalog IDs.
- The Skill package/server display name does not determine a host's MCP registration key. Use the
  exact `server` returned by the host. In DramaClaw's Codex adapter, filesystem-backed Skill files
  are read from `dramaclaw`; workflow catalog resources use `dramaclaw_workflows` (underscore).
  Never call `resources/read` with an inferred `dramaclaw-workflows` server key.
- Use the portable `dramaclaw-workflows` MCP server for catalog discovery and deterministic
  compilation when it is available. Use the authorized DramaClaw MCP server for draft persistence,
  approval, canvas commit, and execution. Tool names are host-neutral; call them through the MCP
  mechanism supported by the current agent.
- `dramaclaw-workflows` is this Agent Skill package/server name, not a Workflow catalog `skill_id`.
  Never pass it to `workflow_skill_get`, `freezone_get_workflow_skill`, or an intent's `skill_id`.
  Select the matching production Workflow Skill returned by the catalog instead.
- Never implement a multi-node request by repeatedly calling `freezone_create_node`,
  `freezone_create_edge`, `freezone_group_nodes`, or other single-operation tools.
- Never fall back to repeated single-operation writes after a workflow validation or schema error.
  Correct the workflow intent/plan or report the blocking error.
- A failure from an earlier chat turn is diagnostic history, not proof that the current adapter is
  still blocked. When the user repeats the original create/run request, explicitly asks to retry,
  or has restarted the service, retry the same complete workflow write once in the current turn.
  Never declare the current environment blocked without a same-turn write result showing the same
  failure.
- A confirmed workflow must be committed as one operation and must produce one approval surface.
- The deterministic workflow compiler owns node IDs, same-batch references, grouping, layout,
  selection, and the final `canvas_chat_commands.v1` batch.
- An explicit imperative to create or run authorizes submission to the protected canvas write tool.
  Do not ask for a duplicate create/run confirmation and do not claim that the host cannot display
  the approval surface; the write tool emits it. In `auto_execute`, the host applies the ordinary
  approval event after required image/video parameters are known.
- Use `freezone_request_user_clarification` for structured questions. Never substitute a host's
  built-in `request_user_input`, `update_plan`, or `create_goal` for canvas work.
- For Skill/Recipe authoring, read and follow
  `references/skill-studio-authoring-guide.md` before asking questions or drafting.

## Route the request

Before creating a draft or graph that will actually run image or video generation, inspect the
user request, selected Recipe input contract, existing target-node data, and the host-provided
canvas execution mode. For every new generation request, call
`freezone_request_user_clarification` exactly once before any canvas write in both
`manual_confirm` and `auto_execute`. Historical clarification answers, prior-turn parameters,
existing node values, and Recipe defaults may prefill recommended choices, but never count as the
user's selection for the current request. After the clarification result returns for that request,
do not ask again.

- In `manual_confirm`, apply the preliminary answers to the plan, then submit the protected write.
  The normal approval card is still shown and remains the final parameter editor.
- In `auto_execute`, apply the preliminary answers and submit the protected write immediately. A
  normal approval event is still emitted and may be auto-applied. Explicit human-review
  requirements may still pause execution.
- If the host does not provide a valid mode, treat it as `manual_confirm`.

The image/video choices are:

- Image: model preference, aspect ratio, resolution/quality, and variants per node.
- Video: model or generation mode, aspect ratio, resolution, duration, sound generation, and output
  variants per node.
- Provider thinking/reasoning level is server-managed. Never ask the user to choose
  `thinking_level`, reasoning effort, or low/medium/high thinking options, and never add such a
  question from a live model parameter schema.

Do not include audio voice-source selection in this preliminary clarification. Never ask the user
to choose system voice versus custom voice. A speech node uses an already selected custom
`voiceRef`; if none is selected, its generation is skipped as defined under Execution and
completion.

Offer a recommended/default option so the user does not need to understand provider-specific
fields. In either execution mode, do not draft, commit, approve, or run until the required
clarification result returns. This is an explicit exception to a host's general rule not to ask about model
parameters. It applies only to image and video generation for now, and only when the operation will
generate media (including `run_after_create=true`); do not ask when the user only wants empty nodes,
connections, grouping, layout, or edits without generation. Choices explicit in the current user
request, Recipe, existing node data, or history should be preselected in the card, not used to skip
the card.

The portable workflow intent carries confirmed shared choices in `inputs`:

```json
{
  "image_model": "<catalog model id>",
  "image_aspect_ratio": "16:9",
  "image_resolution": "2K",
  "image_quality": "medium",
  "image_variants_per_node": 1,
  "video_model": "<catalog model id>",
  "video_aspect_ratio": "16:9",
  "video_resolution": "720P",
  "video_duration_seconds": 5,
  "video_generate_audio": false,
  "video_variants_per_node": 1
}
```

`image_count` and `video_count`, when declared by a selected Skill, describe workflow deliverable
or node counts. Never use them as per-node generation counts. Only
`image_variants_per_node` / `video_variants_per_node` map to canvas node `data.count`, and their
portable supported values are `1`, `2`, and `4`.

Use only the image or video keys relevant to the selected plan. For an exact custom topology,
shared confirmed choices may remain in `plan.inputs`; preparation applies each image/video choice
to every matching generated node that leaves the field unset. Node `data` may instead pin the
equivalent canvas or portable field for a step, and an explicit node value always takes
precedence over the shared choice (the same rule the standard planner follows); only two aliases
of the same setting with different values on one node are rejected. If a write returns
`code="generation_parameters_required"`, do not retry unchanged. Call
`freezone_request_user_clarification` once for all returned missing choices, passing already
confirmed choices (at least the model) in `answers` so the recommendation comes from the same
catalog entry. The clarification result carries `node_data.<node_type>` with the exact canvas
fields; copy them verbatim into each matching node of the same intent/plan and retry the same
operation. A recommended action always returns concrete values; a result with
`status="generation_answers_incomplete"` means the choice is still missing and must be asked
again, never defaulted. Approval behavior remains controlled by the execution mode.

When the user does not specify internal media settings, use `"recommended"` only for the media
model preference in the portable intent or Plan. The authorized preflight resolves it to a concrete
model id and compatible parameters from one scoped live Catalog snapshot before saving the draft.
The final draft preview must contain concrete values. If the configured preferred model is absent
or its capabilities do not support the requested values, stop on the returned blocker and ask the
user to choose a product-level alternative. Never submit `"recommended"` as size, quality, or
resolution, and never select the first Catalog model by position.

Generation clarification must use one question per missing portable field; never combine model,
ratio, resolution, duration, sound, or count into a single recommended-settings preset. Read the
live node create schema for each relevant image/video node type, then query it again with the
selected `model_id` before choosing model-dependent parameters. Use the second response's exact
options; do not reuse defaults from the model-agnostic schema or rewrite a user's selected value.
A `video_resolution` question must expose every resolution supported by the selected/live model,
including `480P` whenever the schema lists it.

1. Identify the single matching workflow Skill from the user's explicit goal. Use
   `workflow_catalog_search(kind="skills")` when discovery is needed. If several materially
   different Skills match, ask the user to choose; do not guess.
2. Read the selected package with `workflow_skill_get`, or with
   `freezone_get_workflow_skill` when the standalone server is unavailable. Use only
   the returned Recipe summaries and input contract.
3. Call `freezone_begin_agent_product_generation` with `product_kind="workflow_result"`, a stable
   generation session, `skill_id`, `skill_version`, `artifact_id="<skill_id>@<skill_version>"`,
   and the normalized inputs before authoring the result. These Skill identities must match the
   later compiled result.
4. For a normal workflow, submit one compact `freezone_workflow_intent.v1` and the admitted
   `operation_id` to `freezone_prepare_workflow`. The backend compiles and validates it; do not
   run a separate compile first.
5. Present the returned preview. Adjust it with `freezone_revise_workflow`, sending the same
   `draft_id`, `expected_revision`, and only changed fields.
6. After explicit user confirmation, call `freezone_confirm_workflow_draft` once with the exact
   `draft_id` and `revision`.

Route between the normal draft flow and the exact topology path in this priority order:

1. An explicit planner instruction wins. When the user names the standard planner or a Skill's
   standard flow ("use the standard planner", "按标准模板"), submit a compact Intent to
   `freezone_prepare_workflow(intent=...)` even if the message also lists nodes and dependencies:
   compare the listed topology with that Skill's standard template first, and treat a same-shape
   list (same stages, order, and dependencies) as a restatement of the template, not a custom
   request.
2. Otherwise, when the user explicitly names required nodes and their dependency order that
   deviate from the matching Skill's template, use the exact topology path in
   [references/custom-topology.md](references/custom-topology.md), preparing the complete Plan as
   a persisted draft even when a production Skill also matches.
3. When an explicit planner instruction and the listed topology genuinely conflict (for example
   the standard planner is named but a mandatory template stage is dropped), ask one
   single-question clarification with `freezone_request_user_clarification` before choosing a
   path; never pick a side silently.

The prepared draft records which path was taken (`preview.planner.mode` is
`deterministic_standard` or `agent_authored`) so the choice can be audited. For error recovery,
read [references/error-recovery.md](references/error-recovery.md).

When packaging this Skill for another agent host, read
[references/integration.md](references/integration.md).

## Server-owned workflow operations

On third-party hosts, call `freezone_get_workflow_capabilities` once before using the write path.
The `workflow-operations.v1` capability provides prepare, revise, input binding, and compact query.
Use `freezone_prepare_workflow(plan=...)` for an exact topology; preserve its complete graph and
constraints. Use `freezone_get_workflow(draft_id=...)` to inspect a timeout or pending confirmation.
See [references/workflow-operations.md](references/workflow-operations.md) for binding and patch fields.
Legacy adapters may use `freezone_prepare_workflow_draft`, `freezone_prepare_workflow_plan_draft`,
and `freezone_patch_workflow_draft`; do not fall back to another write after an ambiguous timeout.

## Execution and completion

- When graph creation or draft confirmation uses `run_after_create=true`, its approved batch already
  contains the only `run_workflow` request. Do not call `freezone_run_workflow` again in the same
  turn. Start another run only after a terminal failure and a later explicit user retry.
- Observe an existing run with `freezone_observe_workflow_run(run_id=..., wait_seconds=20)`;
  reuse the returned `observation_token` as `after` for a later bounded wait. The backend reconciles
  tasks and artifacts and returns compact progress and recovery decisions. A query timeout permits
  another read of the same run, not resubmission of generation.
- To continue or resume an existing workflow, call `freezone_run_workflow`; do not traverse and run
  nodes individually.
- A workflow containing exactly one executable node is still a workflow. If the user calls the
  target a workflow and asks to run, execute, continue, or resume it, call `freezone_run_workflow`
  directly without reading node detail first; never downgrade it to `freezone_run_node_action`.
- Freezone speech uses custom/reference voices only; never select or generate with a preset/system
  voice. Preserve an existing valid `voiceRef`. If no valid custom voice is selected, skip that
  audio node without submitting TTS and continue the remaining workflow. Never select the first
  available voice automatically or open `open_voice_picker` unless the user explicitly requests it.
- Treat `awaiting_approval`, `accepted`, and `running` as non-final states. Do not claim that canvas
  creation or generation completed until the corresponding result says it did.
- Use `operation_id`, `draft_id`, `revision`, and returned idempotency identifiers unchanged on
  retries. Never create a replacement draft merely because delivery was retried.
