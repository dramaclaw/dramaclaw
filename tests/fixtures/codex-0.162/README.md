# Codex 0.162 protocol recordings

These are real JSON-RPC exchanges between a DramaClaw-style client and the Codex
app-server `codex-cli 0.162.0` (DramaClaw's runtime build). They were recorded
against a test model gateway with text-only turns and a standard-library echo MCP server.

Each JSONL line is one object with `seq`, `t_ms`, `conn`, `dir` (`send` or `recv`),
and `msg` (the JSON-RPC message). Pair requests with the first subsequent reply
on the same `conn` with the same `id` and a `result` or `error`. Request ids repeat
across connections. Notifications have `method` without `id`. Server requests
have both `method` and `id` and arrive as `recv`.

Machine-specific values were replaced with `<TMP_ROOT>`, `<HOSTNAME>`, `<PYTHON>`,
`<ARTIFACTS>`, `<GATEWAY_API_KEY>`, `<GATEWAY_BASE_URL>`, `<HOME>`, and `<USER>`.

| File | Recorded behavior |
| --- | --- |
| `02-thread-start-ce.jsonl` | `thread/start` returns paginated history, idle status, and no turns. |
| `03-turn-ce-plain.jsonl` | A plain text turn emits user and agent message items, replies `ready`, and completes with Unix-second turn timestamps. |
| `04-turn-additional-context-client-id.jsonl` | `turn/start` sends `clientUserMessageId` and `additionalContext` entries `application` and `untrusted`. These entries never appear as items, and `userMessage.clientId` carries the client id. |
| `05-history-reads.jsonl` | `thread/turns/list` defaults to newest first, supports `sortDirection: "asc"`, and returns empty item lists with `itemsView: "notLoaded"`. |
| `08-thread-b-tools-reasoning-inflight-resume.jsonl` | A resumed thread lists an `inProgress` turn while `thread/items/list` returns only its completed user message and shell command. The turn later completes an echo MCP call and an agent reply. |
| `09-turn-interrupt.jsonl` | Interrupting a streaming reply leaves an `interrupted` turn whose `thread/items/list` page contains only the user message. |
| `10-approval-decline.jsonl` | A command approval receives `{"decision": "decline"}`, then the command item completes with status `declined`. |
| `11-legacy-history-thread.jsonl` | `thread/start` accepts legacy history. Revert returns code `-32600` with message `thread/revert only supports paginated threads`. |
| `12-revert.jsonl` | Resume excludes turns. Reverting before the first turn clears history, returns a null turns cursor, emits `thread/reverted`, and leaves an empty turns page. |

Re-record these fixtures when the Codex runtime version changes. The ids and
timestamps are run-specific.
