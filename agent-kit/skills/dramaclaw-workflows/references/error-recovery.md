# Workflow error recovery

- `skill_id_required` or multiple matches: ask the user to select one workflow type.
- Invalid Skill input: correct only the fields named by the returned input contract.
- Invalid intent: correct the reported intent path and retry the same draft preparation once.
- Invalid plan or Recipe: correct the same complete Plan with only the selected Skill package's node
  capabilities and Recipe IDs. Do not switch an exact topology to compact Intent compilation.
- Existing-story image batch reporting `skill_stage_missing`: inspect `source_context.story_id`,
  full and unique coverage of image IDs across `asset_targets` and `targets`, live story assets,
  and extraneous executable nodes. Follow `interactive-story`'s `references/reference-images.md`.
  Repair the same image Plan once; do not add executable planning or video nodes, change image
  purposes, or switch to single-node tools. If the same path still fails, report that the authored
  image plan has not met the contract and images remain unsubmitted. Repeated validation failures
  do not establish that the platform lacks image-only workflows; do not suggest relaxed validation
  or ask the user to change their production scope to accommodate an internal planning error.
- Disconnected nodes: inspect connected components in the same complete Plan. Preserve independent
  Beat/shot failure isolation; do not serialize sibling branches merely to satisfy validation. Add or
  restore one non-executable common input/root and connect it to every independent branch input, then
  compile the corrected complete Plan once. Do not ask the user to describe this internal topology.
- Incompatible edge type: read `freezone_get_link_type_catalog` once and select a listed type for the
  exact source/target node kinds. Do not guess alternatives through repeated compiler calls. A
  text/script node feeding an audio node uses `prompt_for`, never `context_for`. Successful recovery
  compilation is not completion: immediately submit the exact same corrected Plan to
  `freezone_prepare_workflow_plan_draft`.
- Revision conflict: call `freezone_get_workflow`, inspect the updated preview and requested changes,
  and obtain authorization for the resulting revision before confirmation. Never silently adopt a
  new revision or create a replacement draft.
- Awaiting approval or timeout: call `freezone_get_workflow` with the same draft identity; report the
  existing approval state. Never replay the write as standalone commands.
- Audio generation: Freezone has no preset/system voice fallback. Preserve a valid custom
  `voiceRef`; if none is selected, skip the audio node without submitting TTS and continue the
  remaining workflow. Never choose a catalog voice or open the picker automatically.
- Batch/schema failure: do not degrade to single-node tools. Return the blocking validation detail if
  one corrected retry cannot satisfy the schema. For `invalid_compiled_command_schema`, correct only
  a semantic Plan field explicitly named by `errors[].path`; never hand-author canvas commands. If
  the named field is compiler-owned, stop retrying and report an adapter/compiler defect.
- Historical failures do not satisfy that retry requirement. On a later user retry, attempt the same
  complete write once in that turn; only a same-turn result can establish that the current adapter
  remains blocked.
- Never submit a reduced, placeholder, smoke-test, or diagnostic graph to the user's canvas.
  `workflow_graph_compile` is read-only, but it must still receive the same complete graph being
  recovered: preserve every business node, dependency edge, group, exact count, and user value.
  Never call it with probe nodes, omitted nodes, or `edges: []` for a multi-node workflow. Correct
  only the returned failing fields. A failed 53-node request must remain a failed 53-node request;
  it must never become a successful two-node write or a sequence of visible compiler probes.
