# Workflow error recovery

- `skill_id_required` or multiple matches: ask the user to select one workflow type.
- Invalid Skill input: correct only the fields named by the returned input contract.
- Invalid intent: correct the reported intent path and retry the same draft preparation once.
- Invalid plan or Recipe: correct the same complete Plan with only the selected Skill package's node
  capabilities and Recipe IDs. Do not switch an exact topology to compact Intent compilation.
- Revision conflict: read the existing draft and use its current revision; do not create a new draft.
- Awaiting approval or timeout: keep the same operation/draft identity and wait for or report the
  existing approval state. Never replay the write as standalone commands.
- Audio generation: Freezone has no preset/system voice fallback. Preserve a valid custom
  `voiceRef`; if none is selected, skip the audio node without submitting TTS and continue the
  remaining workflow. Never choose a catalog voice or open the picker automatically.
- Batch/schema failure: do not degrade to single-node tools. Return the blocking validation detail if
  one corrected retry cannot satisfy the schema.
- Historical failures do not satisfy that retry requirement. On a later user retry, attempt the same
  complete write once in that turn; only a same-turn result can establish that the current adapter
  remains blocked.
- Never submit a reduced, placeholder, smoke-test, or diagnostic graph to the user's canvas.
  `workflow_graph_compile` is read-only, but it must still receive the same complete graph being
  recovered: preserve every business node, dependency edge, group, exact count, and user value.
  Never call it with probe nodes, omitted nodes, or `edges: []` for a multi-node workflow. Correct
  only the returned failing fields. A failed 53-node request must remain a failed 53-node request;
  it must never become a successful two-node write or a sequence of visible compiler probes.
