# Freezone canvas reply outcome contract

The host, not the model, decides what a Freezone (虾画) turn changed. Every
canvas write goes through a DramaClaw MCP tool whose result carries the
receipt, so the turn's recorded tool results are the only evidence. The
model's final reply is plain text (or Markdown) for the user. It never
restates receipts, and no JSON envelope or `outputSchema` is involved
(dramaclaw/dramaclaw#862).

## Evidence

Each observed canvas write tool call has its own lifecycle state. A completed
tool transport is not sufficient: a successful browser apply must carry a
bridge receipt, and a direct apply must carry a saved revision. Both must
match the current project and canvas. Catalog-only Skill saves are not canvas
writes. A ready Workflow draft remains pending user confirmation; it is not
evidence that nodes already exist. An answered clarification by itself is not
a failed canvas write.

## Outcome rules (`finalize_canvas_reply`)

Evaluated in order, from the turn's `attempts` / `receipts`, never from the
model's prose:

1. Any attempt `failed` → `画布操作未完成：<failure>`; one successful write
   cannot hide a different unsuccessful tool call.
2. Any attempt `timeout` / `cancelled` / still pending → the matching
   host message.
3. Workflow draft ready and no attempts → the pending-confirmation notice.
4. The user clearly requested a canvas write (`_freezone_canvas_write_requested`)
   and there was zero write attempts → the host states
   `画布操作未完成：本轮没有可验证的画布写入回执` first and keeps the model's
   reply only as explicitly unverified explanation. This is the fail-closed
   guard; it never turns user text into success evidence.
5. Otherwise the model's reply is delivered as written. If writes verifiably
   succeeded but the reply is empty, the host reports what was saved /
   admitted from the receipts.

The adapter never scans the assistant's prose for success keywords, and there
is no format-repair second turn: a reply in an unexpected shape is just text.

## Transport

The App Server receives no `outputSchema` for canvas chat. Program-consumed
answers that genuinely need a schema (the exact audio action plan) keep
theirs. Structured output plus tools is therefore no longer forced on every
canvas turn, which matters for Chat-only upstreams behind the gateway.

Host-authored notices (stage-confirmation-not-written, exact-audio dispatch
results) are plain text too and bypass the write-request guard.

## Compatibility with pre-#862 threads

Threads opened under the previous contract carry envelope-shaped assistant
history and a model may keep imitating it for a while. The Freezone thread
protocol version is bumped so existing threads are recreated, and
`unwrap_legacy_canvas_envelope` additionally accepts a complete legacy
envelope (optionally fenced) or a truncated one whose `message` string is
complete, delivering only its `message`. Any other JSON is treated as the
model's actual answer.

## Cancellation and streaming

On runtime cancellation, Freezone discards the unvalidated reply and emits
and persists only an explicit cancellation notice; cancellation does not roll
back tool operations that already completed. Freezone assistant prose is
still buffered until the outcome rules above have run, because they may
replace it with a host message. Tool progress and approval/clarification
cards continue to stream. Mainline Codex, Claude, Hermes, write
authorization, and the Inbox/Outbox transport are unchanged.
