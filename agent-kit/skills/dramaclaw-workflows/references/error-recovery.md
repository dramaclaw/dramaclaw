# Workflow error recovery

- `skill_id_required` or multiple matches: ask the user to select one workflow type.
- Invalid Skill input: correct only the fields named by the returned input contract.
- Invalid intent: correct the reported intent path and retry the same draft preparation once.
- Invalid plan or Recipe: use only the selected Skill package's node capabilities and Recipe IDs.
- Revision conflict: read the existing draft and use its current revision; do not create a new draft.
- Awaiting approval or timeout: keep the same operation/draft identity and wait for or report the
  existing approval state. Never replay the write as standalone commands.
- Batch/schema failure: do not degrade to single-node tools. Return the blocking validation detail if
  one corrected retry cannot satisfy the schema.
