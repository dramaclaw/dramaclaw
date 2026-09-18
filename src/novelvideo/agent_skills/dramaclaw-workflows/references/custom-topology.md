# Exact custom workflow topology

Use this path whenever the user explicitly names the required nodes and dependencies. A matching
production Skill does not turn an exact topology request into the normal draft flow.

1. Load exactly one matching production Workflow Skill. Prefer
   `workflow_skill_get(skill_id=...)` on the standalone workflow MCP server; that reader is always
   compact. When the standalone server is unavailable, use
   `freezone_get_workflow_skill(skill_id=...)`.
2. Author one complete `freezone_workflow_plan.v1` using only that Skill's allowed node capabilities
   and Recipe IDs returned in `available_recipes`.
   Node prompts are short task briefs, not final production prompts. Describe the node's task and
   which actual upstream outputs/reference assets it must consume. Do not prewrite generated
   scripts, shot-by-shot storyboards, dialogue, or camera/sound details. Preserve user-supplied
   content and constraints; execution-time Recipe compilation produces the executable prompt.
   Author semantic Plan fields only. Do not construct `canvas_chat_commands.v1` yourself: the graph
   compiler owns command defaults, stable IDs, layout, grouping, and final static command validation.
   Use only canonical `node_type` for each node's portable kind. The public MCP contract rejects
   the legacy canvas-command alias `type` and all unknown top-level fields.
   Keep input/resource `stage` at node level. Use only canonical `link_type` on edges.
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
4. Put all new nodes and semantic edges in the same plan. To consume an existing canvas image,
   declare `external_inputs: [{"id":"source_image","node_id":"<existing canvas node id>","media_kind":"image"}]`
   and use `source_image` as the source of a `media_input_for` edge. The server verifies the real
   node and its media at prepare and confirmation. Do not copy the source into `nodes`, put its URL
   in the target data, or include it in `run_workflow` selection. Other references use logical plan
   IDs; the compiler turns new nodes into same-batch `client_id` values.
   Before choosing an edge `link_type`, use the injected compatibility information or call
   `freezone_get_link_type_catalog` once when compatibility is not already explicit. Never guess a
   link type and never trial several link types through repeated compiler calls.
   dependency_for only controls execution order and does not consume the source output. A target
   whose task brief says it uses, follows, continues, adapts, or is based on actual upstream output
   must not use dependency_for for that input. Use `context_for` when a text node consumes upstream
   text as context, `prompt_for` when an image/video/audio/HTML or compatible text step consumes
   upstream text, and `media_input_for` when a target consumes upstream image/video/audio. Before
   submission, self-check every claimed upstream input against a consuming edge; preserve
   dependency_for only for a genuine wait where the target remains independent of the source
   output.
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
   Every edge endpoint must match an `id` in `nodes` or a declared external input alias. Never
   invent a source such as `source` or `input` without a matching declaration.
7. Call `freezone_prepare_workflow(plan=...)` once. It strictly validates the complete Plan,
   obtains an operation-bound planning quote and server receipt, then persists an exact preview
   without writing canvas nodes. After the user reviews that preview, call
   `freezone_confirm_workflow_draft` with its exact `draft_id` and `revision`. Do not call
   `workflow_graph_compile` as a routine preflight before preparing the first draft. Use the read-only compiler
   only to diagnose and correct a validation failure. After a recovery compile succeeds, immediately
   prepare that exact corrected Plan with `freezone_prepare_workflow(plan=...)`; do not stop after
   reporting that compilation passed.

The user's imperative does not replace an exact billing confirmation receipt. Follow the quote
response, present the persisted preview, and confirm only the returned draft revision.

Do not call `freezone_emit_canvas_command` for this path. Do not separately create nodes, edges,
groups, or layout after the graph call. Never write placeholder or diagnostic nodes such as `A/B`,
`T1/T2`, or “测试节点” to the user's canvas. If read-only diagnosis is required, pass the same
complete plan to `workflow_graph_compile`; never compile a reduced probe or a multi-node plan with
an empty `edges` array.

For compact Intent submissions, composition policy belongs at `intent.include_compose`
and must not be placed inside `intent.planner`. The planner object contains only its
advertised planning fields; `include_compose` is a sibling of `planner` and `items`.
