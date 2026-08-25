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
- `freezone_create_workflow_graph`
- `freezone_run_workflow`

Keep the portable MCP read/compile-only. This ensures every host can reuse the same Skill and Recipe
plans while retaining its own identity, authorization, approval UI, idempotency, and delivery path.
