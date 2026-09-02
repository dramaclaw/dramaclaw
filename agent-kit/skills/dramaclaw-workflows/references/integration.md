# Agent Host Integration

This Skill and the Workflow MCP are host-neutral. An agent host needs two boundaries:

1. Start `python -m novelvideo.chat.workflow_mcp` as a standard stdio MCP server. Set
   `DRAMACLAW_USERNAME` when user-scoped catalog overlays are required.
2. Provide an authorized DramaClaw MCP adapter for draft persistence, approval, canvas commit, and
   workflow execution. Do not copy write or approval logic into the portable Workflow MCP.

The portable MCP supports progressive discovery through:

- `workflow_catalog_search`
- `workflow_skill_get`
- `workflow_recipe_get`
- `workflow_intent_compile`
- `workflow_graph_compile`
- `dramaclaw-workflow://skills/{skill_id}` resources
- `dramaclaw-workflow://recipes/{recipe_id}` resources

The host's authorized adapter must expose the high-level write contract used by this Skill:

- `freezone_prepare_workflow_draft`
- `freezone_patch_workflow_draft`
- `freezone_confirm_workflow_draft`
- `freezone_prepare_workflow_plan_draft`
- `freezone_run_workflow`

Keep the portable MCP read/compile-only. This ensures every host can reuse the same Skill and Recipe
plans while retaining its own identity, authorization, approval UI, idempotency, and delivery path.

For image/video execution, the host must collect one current-request parameter selection before the
approval or commit boundary. Historical selections and persisted node values may prefill the UI but
must not suppress it. The authorized adapter must also fail closed when required generation choices
are absent. Return `status="clarification_required"`, `code="generation_parameters_required"`, the
affected nodes, and their missing fields. The host must collect all relevant user-facing choices in
one structured clarification, then retry the same idempotent draft/plan with the answers. Shared workflow answers
use the portable `intent.inputs` keys documented in the main Skill; exact custom plans put the
equivalent fields directly in each media node's `data`. This rule does not apply to empty-node
creation, layout, grouping, connections, text, or standalone audio settings.

The portable model value `"recommended"` represents an explicit request to use the host's current
recommended/default model; it is not a provider model id. The authorized adapter must resolve or
remove this sentinel immediately before commit so the local canvas applies its live default. Agents
must not invent a concrete model id or regenerate a complete graph only to replace this sentinel.
