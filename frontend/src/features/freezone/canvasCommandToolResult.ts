import type { CanvasChatCommandApplyResult } from "@/features/freezone/canvasChatCommands";
import {
  canvasCommandAgentHintFromResult,
  canvasCommandUserMessageFromResult,
} from "@/features/freezone/canvasCommandUserMessages";
import { api } from "@/lib/api";

type CanvasApplyStatus = "accepted" | "applied" | "partially_applied" | "failed" | "cancelled_by_user";

export const FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT = "freezone/canvas-command-tool-result";
const CANVAS_COMMAND_RECEIPTS_STORAGE_KEY = "dramaclaw.canvas-command-receipts.v1";
const CANVAS_COMMAND_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const CANVAS_COMMAND_RECEIPT_LIMIT = 100;

export type CanvasCommandToolResultPayload = {
  type: "canvas.command.result";
  received_at?: number;
  turn_id?: string | null;
  anchor_text_prefix?: string | null;
  bridge_key: string;
  project_id: string | null;
  canvas_id: string | null;
  agent_id?: string | null;
  tool_call_status: "completed" | "cancelled" | "failed";
  canvas_apply_status: CanvasApplyStatus;
  applied: boolean;
  cancelled: boolean;
  errors: string[];
  applied_count: number;
  opened_ui_actions: number;
  created_node_ids: string[];
  command_results: Array<Record<string, unknown>>;
  message: string;
  user_message?: string;
  agent_hint?: string;
};

type StoredCanvasCommandReceipt = {
  storedAt: number;
  payload: CanvasCommandToolResultPayload;
};

function loadCanvasCommandReceipts(): Record<string, StoredCanvasCommandReceipt> {
  if (typeof window === "undefined") return {};
  try {
    const decoded = JSON.parse(window.localStorage.getItem(CANVAS_COMMAND_RECEIPTS_STORAGE_KEY) ?? "{}");
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, StoredCanvasCommandReceipt>
      : {};
  } catch {
    return {};
  }
}

function storeCanvasCommandReceipt(payload: CanvasCommandToolResultPayload) {
  if (typeof window === "undefined" || !payload.bridge_key) return;
  const now = Date.now();
  const receipts = Object.entries(loadCanvasCommandReceipts())
    .filter(([, receipt]) => receipt?.storedAt >= now - CANVAS_COMMAND_RECEIPT_TTL_MS)
    .sort(([, left], [, right]) => left.storedAt - right.storedAt)
    .slice(-(CANVAS_COMMAND_RECEIPT_LIMIT - 1));
  const next = Object.fromEntries(receipts);
  next[payload.bridge_key] = { storedAt: now, payload };
  try {
    window.localStorage.setItem(CANVAS_COMMAND_RECEIPTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing and storage quotas must not block result delivery.
  }
}

function removeCanvasCommandReceipt(bridgeKey: string) {
  if (typeof window === "undefined" || !bridgeKey) return;
  const receipts = loadCanvasCommandReceipts();
  if (!(bridgeKey in receipts)) return;
  delete receipts[bridgeKey];
  try {
    window.localStorage.setItem(CANVAS_COMMAND_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
  } catch {
    // A failed cleanup only causes a harmless idempotent replay on reconnect.
  }
}

export function readCanvasCommandReceipt(
  bridgeKey: string,
): CanvasCommandToolResultPayload | null {
  const receipt = loadCanvasCommandReceipts()[bridgeKey];
  if (!receipt || receipt.storedAt < Date.now() - CANVAS_COMMAND_RECEIPT_TTL_MS) return null;
  return receipt.payload?.bridge_key === bridgeKey ? receipt.payload : null;
}

function emitCanvasCommandToolResult(payload: CanvasCommandToolResultPayload) {
  window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT, { detail: payload }));
  const { type: _type, ...body } = payload;
  void api.post("api/v1/chat/canvas-command-tool-result", {
    json: body,
    timeout: 30_000,
  }).then(() => {
    removeCanvasCommandReceipt(payload.bridge_key);
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to report canvas command result", error);
  });
}

export function replayCanvasCommandToolResult(payload: CanvasCommandToolResultPayload) {
  emitCanvasCommandToolResult(payload);
}

function canvasApplyStatusFromResult(result: CanvasChatCommandApplyResult): CanvasApplyStatus {
  const successCount = result.commandResults.filter((step) => step.status === "success").length;
  const errorCount = result.commandResults.filter((step) => step.status === "error").length;
  if (successCount > 0 && errorCount > 0) return "partially_applied";
  if (errorCount > 0 || result.errors.length > 0) return "failed";
  return "applied";
}

export function reportCanvasCommandToolResult({
  bridgeKey,
  turnId,
  anchorTextPrefix,
  projectId,
  canvasId,
  agentId,
  result,
  cancelled = false,
  accepted = false,
}: {
  bridgeKey?: string | null;
  turnId?: string | null;
  anchorTextPrefix?: string | null;
  projectId?: string | null;
  canvasId?: string | null;
  agentId?: string | null;
  result?: CanvasChatCommandApplyResult;
  cancelled?: boolean;
  accepted?: boolean;
}) {
  if (!bridgeKey) return;
  const payload = buildCanvasCommandToolResultPayload({
    bridgeKey,
    turnId,
    anchorTextPrefix,
    projectId,
    canvasId,
    agentId,
    result,
    cancelled,
    accepted,
  });
  storeCanvasCommandReceipt(payload);
  emitCanvasCommandToolResult(payload);
}

function buildCanvasCommandToolResultPayload({
  bridgeKey,
  turnId,
  anchorTextPrefix,
  projectId,
  canvasId,
  agentId,
  result,
  cancelled = false,
  accepted = false,
}: {
  bridgeKey?: string | null;
  turnId?: string | null;
  anchorTextPrefix?: string | null;
  projectId?: string | null;
  canvasId?: string | null;
  agentId?: string | null;
  result?: CanvasChatCommandApplyResult;
  cancelled?: boolean;
  accepted?: boolean;
}): CanvasCommandToolResultPayload {
  const canvasApplyStatus: CanvasApplyStatus = accepted
    ? "accepted"
    : cancelled
    ? "cancelled_by_user"
    : result
      ? canvasApplyStatusFromResult(result)
      : "failed";
  const userMessage = accepted
    ? undefined
    : cancelled
    ? "画布操作已取消，没有应用到画布。"
    : canvasApplyStatus === "failed"
      ? canvasCommandUserMessageFromResult(result?.errors, result?.commandResults)
      : undefined;
  const agentHint = accepted
    ? "The canvas command has been submitted to the canvas. Reply briefly that it has been submitted; do not say a tool was opened or ask the user to operate it manually."
    : cancelled
    ? "Do not claim the canvas change was applied; ask the user before retrying."
    : canvasApplyStatus === "failed"
      ? canvasCommandAgentHintFromResult(result?.errors, result?.commandResults)
      : undefined;
  return {
    type: "canvas.command.result",
    received_at: Date.now(),
    turn_id: turnId ?? null,
    anchor_text_prefix: anchorTextPrefix ?? null,
    bridge_key: bridgeKey ?? "",
    project_id: projectId ?? null,
    canvas_id: canvasId ?? null,
    agent_id: agentId ?? null,
    tool_call_status: cancelled ? "cancelled" : canvasApplyStatus === "failed" ? "failed" : "completed",
    canvas_apply_status: canvasApplyStatus,
    applied: accepted || (!cancelled && Boolean(result && (result.applied > 0 || result.openedUiActions > 0))),
    cancelled,
    errors: result?.errors ?? [],
    applied_count: result?.applied ?? 0,
    opened_ui_actions: result?.openedUiActions ?? 0,
    created_node_ids: result?.createdNodeIds ?? [],
    command_results: result?.commandResults ?? [],
    message: accepted
      ? "Canvas command was submitted to the canvas."
      : cancelled
      ? "画布操作已取消，没有应用到画布。"
      : canvasApplyStatus === "failed"
        ? userMessage ?? "画布操作没有完成，我会换一种方式再试。"
        : "Frontend executor reported the canvas command result.",
    ...(userMessage ? { user_message: userMessage } : {}),
    ...(agentHint ? { agent_hint: agentHint } : {}),
  };
}

export const buildCanvasCommandToolResultPayloadForTest = buildCanvasCommandToolResultPayload;
