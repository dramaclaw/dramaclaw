// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export function canvasContextFailureErrors(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return [`读取画布上下文失败：${message}`];
}

export function buildCanvasContextToolResultBody({
  projectId, canvasId, responses, errors = [],
}: {
  projectId?: string | null;
  canvasId?: string | null;
  responses?: Array<Record<string, unknown>>;
  errors?: string[];
}) {
  const ok = errors.length === 0;
  return {
    project_id: projectId ?? null,
    canvas_id: canvasId ?? null,
    tool_call_status: ok ? "completed" as const : "failed" as const,
    canvas_context_status: ok ? "resolved" as const : "failed" as const,
    ok,
    responses: responses ?? [],
    errors,
    message: ok
      ? "Frontend returned requested canvas context."
      : "Frontend failed to resolve requested canvas context.",
  };
}
