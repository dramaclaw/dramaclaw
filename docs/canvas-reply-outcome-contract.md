# Freezone Codex final response contract

Issue #575 removes user-text classification from canvas receipt enforcement.
The legacy `_freezone_canvas_write_requested` helper is not an execution or
authorization boundary and is no longer used by the Codex streaming adapter.

## Evidence and declarations

Each observed canvas write tool call has its own lifecycle state. A completed
tool transport is not sufficient: a successful browser apply must carry a bridge
receipt, and a direct apply must carry a saved revision. Both must match the
current project and canvas. Catalog-only Skill saves are not canvas writes.

The App Server receives `outputSchema` on every Freezone turn, including resumed
threads. The final response contains:

```json
{
  "message": "节点已创建。",
  "mode": "mutation",
  "canvas_receipts": [{"bridge_key": "actual-bridge-key", "revision": null}]
}
```

- `read_only`: explanations, checks, proposals, clarification answers, and
  catalog-only changes; no canvas success declarations or receipt references.
- `blocked`: no canvas write was performed because of a limitation; no receipts.
- `mutation`: success declarations refer to the complete set of verified
  same-turn receipts. A direct receipt uses `bridge_key: null` and its integer
  `revision`. Historical or wrong-scope receipts cannot satisfy the declaration.

The adapter validates structured declarations, not natural-language keywords.
The model must not put canvas success claims in a `read_only` message; this is a
response-protocol obligation, not a second prose classifier. Missing/invalid
structured responses fail closed and never fall back to unverified raw prose.

## Non-success states and compatibility

Failed, timed-out, cancelled, and pending-approval operations are distinct from
success. One successful write cannot hide a different unsuccessful tool call.
This conservative rule also reports an incomplete turn if an earlier write
attempt failed even when a later attempt succeeded; recovery within a single
turn requires a future explicit operation/supersession contract, not guessing
from similar arguments or user text.

A ready Workflow draft remains pending user confirmation; it is not evidence
that nodes already exist. An answered clarification by itself is not a failed
canvas write. Runtime timeout/cancellation retains the existing runtime reason.

Freezone assistant prose is buffered until the response is validated. Tool
progress and approval/clarification cards continue to stream. JSON transport
fields are not shown as the user-facing answer. Mainline Codex, Claude, Hermes,
write authorization, and the #571 Inbox/Outbox transport are unchanged.

The Freezone thread protocol version is bumped so existing threads are recreated
with the new developer instructions. No database migration is needed.
