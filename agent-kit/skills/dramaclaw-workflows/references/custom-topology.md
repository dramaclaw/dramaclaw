# Exact custom workflow topology

Use this path whenever the user explicitly names the required nodes and dependencies. A matching
production Skill does not turn an exact topology request into the normal draft flow.

1. Load exactly one matching production Workflow Skill. Prefer
   `workflow_skill_get(skill_id=...)` on the standalone workflow MCP server; that reader is always
   compact, so `compact` is optional compatibility input. When the standalone server is unavailable,
   use `freezone_get_workflow_skill(skill_id=..., compact=true)`.
2. Author one complete `freezone_workflow_plan.v1` using only that Skill's allowed node capabilities
   and Recipe IDs returned in `available_recipes`.
   Author semantic Plan fields only. Do not construct `canvas_chat_commands.v1` yourself: the graph
   compiler owns command defaults, stable IDs, layout, grouping, and final static command validation.
   Use only canonical `node_type` for each node's portable kind. The public MCP contract rejects
   the legacy canvas-command alias `type` and all unknown top-level fields.
   Keep input/resource `stage` at node level when possible; `data.stage` is accepted for canvas
   compatibility. Use only canonical `link_type` on edges.
3. Every executable node must contain an explicit `data.workflowCatalog.recipeId`. Input/resource
   text nodes may omit a Recipe when they only carry user-provided material, but they must set
   `stage` to `input`, `resource`, or `asset`. A terminal `videoComposeNode` has no Recipe.
   Put executable options inside `data` as well; do not place them beside `id`/`node_type`.
   For example, a background-music node must use this shape (with the actual Recipe returned by
   the selected Skill):

   ```json
   {
     "id": "bgm",
     "node_type": "audioNode",
     "data": {
       "workflowCatalog": {"recipeId": "general-audio"},
       "audioKind": "music",
       "text": "无歌词、纯音乐的背景氛围配乐"
     }
   }
   ```

   Do not use ad-hoc top-level fields such as `audioKind`, `musicLengthMs`, `forceInstrumental`,
   or `respectSectionsDurations`; if supported by the live node schema, put them under `data`.
4. Put all nodes and semantic edges in the same plan. Use logical plan IDs only; the compiler turns
   them into same-batch `client_id` values.
   Before choosing an edge `link_type`, use the injected compatibility information or call
   `freezone_get_link_type_catalog` once when compatibility is not already explicit. Never guess a
   link type and never trial several link types through repeated compiler calls.
   Before submission, treat graph connectivity as an Agent-owned planning invariant rather than a
   detail the user must specify. Traverse the proposed graph as undirected and make sure every node
   belongs to one connected component. When the user's requested units are intentionally independent
   (for example Beats or shots that must fail, skip, and retry without affecting siblings), do not
   chain those units together. Add one non-executable input/root node and fan it out to each unit's
   input node instead. This satisfies whole-plan connectivity while preserving independent execution
   branches. A user does not need to ask for this structural root or name any `link_type`.
5. When the user states exact totals, copy them into `expected_node_count` and
   `expected_node_counts`. Counts refer to Plan/business nodes; the generated group node is not
   included. Never lower these expectations to make a partial plan validate.
6. Requests that explicitly enumerate Beats, shots, nodes, or dependency order always stay on this
   full Plan path, including requests above the compact Intent planner's item limit. Do not switch to
   `workflow_intent_compile`, a smaller sample plan, or standalone node tools after a validation error.
   Every edge endpoint must match an `id` in the same `nodes` array. Never invent a source such as
   `source` or `input` unless that exact node is present; remove an optional edge rather than
   leaving a dangling reference.
7. Call `freezone_prepare_workflow_plan_draft` once. It strictly validates the complete Plan,
   obtains an operation-bound planning quote and server receipt, then persists an exact preview
   without writing canvas nodes. After the user reviews that preview, call
   `freezone_confirm_workflow_draft` with its exact `draft_id` and `revision`. Do not call
   `workflow_graph_compile` as a routine preflight before preparing the first draft. Use the read-only compiler
   only to diagnose and correct a validation failure. After a recovery compile succeeds, immediately
   prepare that exact corrected Plan with `freezone_prepare_workflow_plan_draft`; do not stop after
   reporting that compilation passed.

The user's imperative does not replace an exact billing confirmation receipt. Follow the quote
response, present the persisted preview, and confirm only the returned draft revision.

Do not call `freezone_emit_canvas_command` for this path. Do not separately create nodes, edges,
groups, or layout after the graph call. Never write placeholder or diagnostic nodes such as `A/B`,
`T1/T2`, or “测试节点” to the user's canvas. If read-only diagnosis is required, pass the same
complete plan to `workflow_graph_compile`; never compile a reduced probe or a multi-node plan with
an empty `edges` array.
