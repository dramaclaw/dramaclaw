# Backend workflow operations

`freezone_prepare_workflow` takes exactly one `intent` or `plan`, the admitted `operation_id`,
optional `run_after_create`, and optional `bindings`. It returns the persisted identity, revision,
digest, preview and next action, not the full compiled graph. It does not execute the canvas.

Bindings refer to existing plan node IDs:

```json
{"source":"brief","target":"image","usage":"prompt","prompt":"Actual generation prompt"}
```

Usage is `prompt`, `context`, `reference`, `dependency`, or `composition`. A planning/context
source used as a generation prompt requires actual prompt text: the backend creates a separate
`input_text` node and the two typed edges. It never changes the source's semantic role, invents
prompt content, removes existing edges, or relaxes exact-count constraints. Invalid existing edges
must be corrected in the complete source plan. Documentation-only content should be grouped with
its generator rather than connected as a prompt.

`freezone_revise_workflow` takes `draft_id`, integer `expected_revision`, and `changes`:

- Compact intent: only changed intent fields (`inputs` merges; optional null fields are removed).
- Exact plan: `step_updates` and/or `bindings`. A step update contains `node_id`, optional `prompt`,
  and optional `settings`. Settings include supported model, aspect_ratio, resolution, quality,
  duration_seconds, generate_audio, variants, or voice_ref for that node type. Existing custom voice
  and generation-parameter rules still apply. Do not mix these changes with compact intent fields.

All edits are revalidated before a compare-and-swap revision update. Unknown fields and invalid
edges are rejected without modifying the stored draft. A revision conflict requires reading and
reviewing current state; do not blindly retry with the new revision.

`freezone_get_workflow` returns compact draft/confirmation state. `submitted` and `confirming`
mean await receipt. `confirmed` means canvas confirmation, not completed media generation; inspect
the workflow run for media completion. Do not repeat preparation or confirmation after a timeout.


Preparation, revision, and confirmation all recheck live model capabilities on the backend.
The authenticated request identity selects the catalog. Unsupported parameters or unavailable
catalogs block explicit model requests; fix the reported fields without changing user requirements.
Missing live queue information is advisory; execution admission still enforces queue limits.

`freezone_observe_workflow_run` accepts `run_id`, optional `wait_seconds` (0–20), and optional `after`
(the previous `observation_token`). It reconciles durable tasks and artifact evidence, then returns
progress, counts, terminal state, and per-node recovery decisions. Bounded waiting reduces agent
polling; this is not a continuously running background scheduler.

Transient query failures may be retried as reads of the same run. An ambiguous generation timeout
requires reconciliation before any retry. `retry_after_confirmation` requires authorization and the
existing runner's resume path. Observation never enqueues media, overrides a runner lease, confirms
an approval, or repeats paid generation. Preserve the returned recovery decision rather than
inferring retries from raw error text. A terminal run must not be polled indefinitely.
