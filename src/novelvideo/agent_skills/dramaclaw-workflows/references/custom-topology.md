# Exact custom workflow topology

Use this path only when the user explicitly names the required nodes and dependencies and the
selected Skill's standard planner cannot preserve that topology.

1. Load exactly one matching workflow Skill with `freezone_get_workflow_skill(compact=true)`.
2. Author one complete `freezone_workflow_plan.v1` using only that Skill's allowed node capabilities
   and Recipe IDs returned in `available_recipes`.
3. Every executable node must contain an explicit `data.workflowCatalog.recipeId`. Input/resource
   text nodes may omit a Recipe when they only carry user-provided material.
4. Put all nodes and semantic edges in the same plan. Use logical plan IDs only; the compiler turns
   them into same-batch `client_id` values.
5. Call `freezone_create_workflow_graph` once. It deterministically adds grouping, layout, selection,
   and one canvas batch.

Do not call `freezone_emit_canvas_command` for this path. Do not separately create nodes, edges,
groups, or layout after the graph call.
