import { api } from "@/lib/api";

export const FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT = "freezone/canvas-context-tool-result";
export const FREEZONE_CANVAS_CONTEXT_ACTIVITY_EVENT = "freezone/canvas-context-activity";

export type CanvasContextActivityPayload = {
  type: "canvas.context.activity";
  turn_id?: string | null;
  anchor_text_prefix?: string | null;
  received_at?: number;
  surface_order?: number;
  external_mcp_command?: boolean;
  bridge_key: string;
  canvas_id: string | null;
  agent_id?: string | null;
  status: "running" | "done" | "failed";
  labels: string[];
  errors: string[];
};

export type CanvasContextToolResultPayload = {
  type: "canvas.context.result";
  turn_id?: string | null;
  anchor_text_prefix?: string | null;
  received_at?: number;
  bridge_key: string;
  project_id: string | null;
  canvas_id: string | null;
  agent_id?: string | null;
  tool_call_status: "completed" | "cancelled" | "failed";
  canvas_context_status: "resolved" | "failed";
  ok: boolean;
  responses: Array<Record<string, unknown>>;
  errors: string[];
  message: string;
};

export function emitCanvasContextActivity({
  turnId,
  anchorTextPrefix,
  bridgeKey,
  canvasId,
  agentId,
  status,
  labels,
  errors = [],
  receivedAt,
  surfaceOrder,
  externalMcpCommand,
}: {
  turnId?: string | null;
  anchorTextPrefix?: string | null;
  bridgeKey: string;
  canvasId?: string | null;
  agentId?: string | null;
  status: CanvasContextActivityPayload["status"];
  labels: string[];
  errors?: string[];
  receivedAt?: number;
  surfaceOrder?: number;
  externalMcpCommand?: boolean;
}) {
  const payload: CanvasContextActivityPayload = {
    type: "canvas.context.activity",
    turn_id: turnId ?? null,
    anchor_text_prefix: anchorTextPrefix ?? null,
    received_at: receivedAt ?? Date.now(),
    surface_order: surfaceOrder ?? receivedAt ?? Date.now(),
    ...(externalMcpCommand === true ? { external_mcp_command: true } : {}),
    bridge_key: bridgeKey,
    canvas_id: canvasId ?? null,
    agent_id: agentId ?? null,
    status,
    labels,
    errors,
  };
  window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_CONTEXT_ACTIVITY_EVENT, { detail: payload }));
}

export function reportCanvasContextToolResult({
  turnId,
  anchorTextPrefix,
  bridgeKey,
  projectId,
  canvasId,
  agentId,
  responses,
  errors = [],
}: {
  turnId?: string | null;
  anchorTextPrefix?: string | null;
  bridgeKey?: string | null;
  projectId?: string | null;
  canvasId?: string | null;
  agentId?: string | null;
  responses?: Array<Record<string, unknown>>;
  errors?: string[];
}) {
  if (!bridgeKey) return;
  const ok = errors.length === 0;
  const payload: CanvasContextToolResultPayload = {
    type: "canvas.context.result",
    turn_id: turnId ?? null,
    anchor_text_prefix: anchorTextPrefix ?? null,
    received_at: Date.now(),
    bridge_key: bridgeKey,
    project_id: projectId ?? null,
    canvas_id: canvasId ?? null,
    agent_id: agentId ?? null,
    tool_call_status: ok ? "completed" : "failed",
    canvas_context_status: ok ? "resolved" : "failed",
    ok,
    responses: responses ?? [],
    errors,
    message: ok
      ? "Frontend returned requested canvas context."
      : "Frontend failed to resolve requested canvas context.",
  };
  window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT, { detail: payload }));
  const { type: _type, ...body } = payload;
  void api.post("api/v1/chat/canvas-context-tool-result", {
    json: body,
    timeout: 30_000,
  }).catch((error) => {
    console.warn("[freezone-canvas-context] failed to report canvas context result", error);
  });
}
