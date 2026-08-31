# Exact custom workflow topology

Use this path whenever the user explicitly names the required nodes and dependencies. A matching
production Skill does not turn an exact topology request into the normal draft flow.

1. Load exactly one matching production Workflow Skill. Prefer
   `workflow_skill_get(skill_id=...)` on the standalone workflow MCP server; that reader is always
   compact, so `compact` is optional compatibility input. When the standalone server is unavailable,
   use `freezone_get_workflow_skill(skill_id=..., compact=true)`.
2. Author one complete `freezone_workflow_plan.v1` using only that Skill's allowed node capabilities
   and Recipe IDs returned in `available_recipes`.
   Use `node_type` for each node's portable kind. The public MCP contract also accepts the canvas
   compatibility alias `type`; if both are present they must contain the same stable enum value.
   Keep input/resource `stage` at node level when possible; `data.stage` is accepted for canvas
   compatibility. Use `link_type` on edges; the same stable `type` alias is also accepted.
3. Every executable node must contain an explicit `data.workflowCatalog.recipeId`. Input/resource
   text nodes may omit a Recipe when they only carry user-provided material, but they must set
   `stage` to `input`, `resource`, or `asset`. A terminal `videoComposeNode` has no Recipe.
4. Put all nodes and semantic edges in the same plan. Use logical plan IDs only; the compiler turns
   them into same-batch `client_id` values.
5. When the user states exact totals, copy them into `expected_node_count` and
   `expected_node_counts`. Counts refer to Plan/business nodes; the generated group node is not
   included. Never lower these expectations to make a partial plan validate.
6. Requests that explicitly enumerate Beats, shots, nodes, or dependency order always stay on this
   full Plan path, including requests above the compact Intent planner's item limit. Do not switch to
   `workflow_intent_compile`, a smaller sample plan, or standalone node tools after a validation error.
7. Call `freezone_create_workflow_graph` once. It deterministically adds grouping, layout, selection,
   and one canvas batch.

The user's imperative to create or run authorizes this protected write submission. Do not ask for a
second create/run confirmation. The graph call emits the approval surface; in `auto_execute`, the
host applies the ordinary approval event automatically after required media parameters are known.

Do not call `freezone_emit_canvas_command` for this path. Do not separately create nodes, edges,
groups, or layout after the graph call. Never write placeholder or diagnostic nodes such as `A/B`,
`T1/T2`, or “测试节点” to the user's canvas. If read-only diagnosis is required, pass the same
complete plan to `workflow_graph_compile`; never compile a reduced probe or a multi-node plan with
an empty `edges` array.
