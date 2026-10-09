const CANVAS_EXECUTION_PROTOCOL_MARKERS = [
  "canvas_chat_commands.v1",
  "canvas_context_request.v1",
  "canvas_command_emitted",
];

export function looksLikeCanvasExecutionNarration(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  // Only hide text that contains explicit protocol envelopes/tool results.
  // User-facing replies may mention implementation terms such as
  // `run_node_action`; those should remain visible next to the execution card.
  return CANVAS_EXECUTION_PROTOCOL_MARKERS.some((marker) => normalized.includes(marker));
}
