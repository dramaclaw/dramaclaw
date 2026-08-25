---
name: dramaclaw-workflows
description: Create, revise, confirm, run, or resume multi-node DramaClaw Freezone canvas workflows. Use for requests involving a workflow, several connected nodes, grouped production stages, storyboards, or text/image/video/audio pipelines; do not use for one standalone canvas operation.
---

# DramaClaw Workflows

Build one coherent workflow transaction, not a sequence of standalone canvas edits.

## Required behavior

- Use the portable `dramaclaw-workflows` MCP server for catalog discovery and deterministic
  compilation when it is available. Use the authorized DramaClaw MCP server for draft persistence,
  approval, canvas commit, and execution. Tool names are host-neutral; call them through the MCP
  mechanism supported by the current agent.
- Never implement a multi-node request by repeatedly calling `freezone_create_node`,
  `freezone_create_edge`, `freezone_group_nodes`, or other single-operation tools.
- Never fall back to repeated single-operation writes after a workflow validation or schema error.
  Correct the workflow intent/plan or report the blocking error.
- A confirmed workflow must be committed as one operation and must produce one approval surface.
- The deterministic workflow compiler owns node IDs, same-batch references, grouping, layout,
  selection, and the final `canvas_chat_commands.v1` batch.

## Route the request

1. Identify the single matching workflow Skill from the user's explicit goal. Use
   `workflow_catalog_search(kind="skills")` when discovery is needed. If several materially
   different Skills match, ask the user to choose; do not guess.
2. Read the selected package with `workflow_skill_get`, or with
   `freezone_get_workflow_skill(compact=true)` when the standalone server is unavailable. Use only
   the returned Recipe summaries and input contract.
3. For a normal workflow, call `freezone_prepare_workflow_draft` and follow its quote/confirmation
   response. After planning is authorized, submit one compact `freezone_workflow_intent.v1` with
   `planning_confirmed=true`.
4. Present the returned preview. Adjust it only with `freezone_patch_workflow_draft`.
5. After explicit user confirmation, call `freezone_confirm_workflow_draft` once with the exact
   `draft_id` and `revision`.

When the user explicitly specifies an exact topology that the standard planner cannot represent,
read [references/custom-topology.md](references/custom-topology.md). For error recovery, read
[references/error-recovery.md](references/error-recovery.md).

When packaging this Skill for another agent host, read
[references/integration.md](references/integration.md).

## Execution and completion

- To continue or resume an existing workflow, call `freezone_run_workflow`; do not traverse and run
  nodes individually.
- Treat `awaiting_approval`, `accepted`, and `running` as non-final states. Do not claim that canvas
  creation or generation completed until the corresponding result says it did.
- Use `operation_id`, `draft_id`, `revision`, and returned idempotency identifiers unchanged on
  retries. Never create a replacement draft merely because delivery was retried.
