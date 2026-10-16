# Freezone Codex final response contract

Receipt validation remains the source of truth for canvas success. The Codex
streaming adapter also uses `_freezone_canvas_write_requested` as a fail-closed
safety check: when an explicit write request ends as `read_only` without even
one write attempt, it reports that the operation did not complete. This check
never turns user text into success evidence or authorization.

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

The adapter never scans the assistant's prose for success keywords. The model
must not put canvas success claims in a `read_only` message. If the user clearly
requested a canvas write, a zero-attempt `read_only` response fails closed;
otherwise read-only explanations remain valid. Missing or invalid structured
responses fail closed and never fall back to unverified raw prose.

## Non-success states and compatibility

Failed, timed-out, cancelled, and pending-approval operations are distinct from
success. One successful write cannot hide a different unsuccessful tool call.
This conservative rule also reports an incomplete turn if an earlier write
attempt failed even when a later attempt succeeded; recovery within a single
turn requires a future explicit operation/supersession contract, not guessing
from similar arguments or user text.

A ready Workflow draft remains pending user confirmation; it is not evidence
that nodes already exist. An answered clarification by itself is not a failed
canvas write. Runtime timeout retains the existing runtime reason. On runtime
cancellation, Freezone discards all unvalidated structured output (including
partial JSON) and emits and persists only an explicit cancellation notice.
Cancellation does not roll back tool operations that already completed.

Freezone assistant prose is buffered until the response is validated. Tool
progress and approval/clarification cards continue to stream. JSON transport
fields are not shown as the user-facing answer. Mainline Codex, Claude, Hermes,
write authorization, and the #571 Inbox/Outbox transport are unchanged.

The Freezone thread protocol version is bumped so existing threads are recreated
with the new developer instructions. No database migration is needed.

Compatibility gateways may not expose the transport `outputSchema` to the
model. The Freezone developer instructions therefore also embed the complete
schema and a valid read-only greeting example. Greetings must produce the same
structured envelope; plain prose is not exempt from receipt validation.
After updating the backend, restart the API so it loads the new instructions
and thread protocol version. Prompt/schema unit tests do not replace a live
gateway smoke test.
