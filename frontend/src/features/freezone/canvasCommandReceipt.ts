// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasChatCommandApplyResult } from "@/features/canvas/core/commands/types";
import {
  canvasCommandAgentHintFromResult,
  canvasCommandUserMessageFromResult,
} from "@/features/freezone/canvasCommandUserMessages";


export type CanvasReceiptTranslate = (key: string, options: { defaultValue: string }) => string;

export type CanvasApplyStatus = "accepted" | "applied" | "pending" | "partially_applied" | "failed" | "cancelled_by_user" | "unverified";
export type BackgroundExecutionStatus = "running" | "succeeded" | "failed" | "cancelled" | "unverified";

const workflowResultUnverifiedMessage = (translate: CanvasReceiptTranslate) => translate(
  "freezone.chat.workflowResultUnverifiedMessage",
  { defaultValue: "本轮部分结果待核实。请先核对画布已有素材，暂勿重复生成，以免产生额外费用。" },
);
const WORKFLOW_RESULT_UNVERIFIED_HINT =
  "The workflow has stopped, but some historical receipts cannot be reliably matched to actions. " +
  "Their results are unverified, not failed, running, or fully successful. " +
  "Check existing canvas artifacts and the workflow record before taking any further action. " +
  "Do not rerun generation or suggest retrying; this may duplicate successful work and incur extra charges.";

const workflowResultSyncPendingMessage = (translate: CanvasReceiptTranslate) => translate(
  "freezone.chat.workflowOutputSyncPendingMessage",
  { defaultValue: "工作流已完成，画布节点产物待同步；请稍后刷新画布核对结果，暂勿重复生成。" },
);
const WORKFLOW_RESULT_SYNC_PENDING_HINT =
  "The server workflow completed, but the canvas node output is not visible yet. " +
  "Do not claim the artifact is ready. Do not rerun generation. Ask the user to wait and refresh the canvas.";
const workflowReconciliationPendingMessage = (translate: CanvasReceiptTranslate) => translate(
  "freezone.chat.workflowReconciliationPendingMessage",
  { defaultValue: "画布产物已生成，服务端仍在核对任务产物；请稍后检查运行状态，暂勿重复生成。" },
);
const WORKFLOW_RECONCILIATION_PENDING_HINT =
  "The canvas output is visible, but the server is still verifying the task artifact. " +
  "Do not claim the workflow finished. Do not rerun generation. Ask the user to check the run status later.";

export type CanvasCommandToolResultPayload = {
  type: "canvas.command.result";
  received_at?: number;
  turn_id?: string | null;
  anchor_text_prefix?: string | null;
  bridge_key: string;
  followup?: boolean;
  project_id: string | null;
  canvas_id: string | null;
  agent_id?: string | null;
  tool_call_status: "completed" | "cancelled" | "failed";
  canvas_apply_status: CanvasApplyStatus;
  background_execution_status?: BackgroundExecutionStatus;
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

function workflowExecutionFailed(result: CanvasChatCommandApplyResult): boolean {
  const workflowCommandIndexes = new Set(
    result.commandResults
      .filter((step) => step.type === "run_workflow")
      .map((step) => step.commandIndex),
  );
  return result.commandResults.some((step) =>
    step.status === "error" && workflowCommandIndexes.has(step.commandIndex));
}

export function canvasApplyStatusFromResult(result: CanvasChatCommandApplyResult): CanvasApplyStatus {
  if (result.commandResults.some((step) => step.status === "unverified")) return "unverified";
  if (workflowExecutionFailed(result)) return "failed";
  const successCount = result.commandResults.filter((step) => step.status === "success").length;
  const errorCount = result.commandResults.filter((step) => step.status === "error").length;
  if (successCount > 0 && errorCount > 0) return "partially_applied";
  if (errorCount > 0 || result.errors.length > 0) return "failed";
  if (result.commandResults.some((step) => step.status === "pending")) return "pending";
  return "applied";
}

export function buildCanvasCommandToolResultPayload({
  translate,
  bridgeKey,
  turnId,
  anchorTextPrefix,
  projectId,
  canvasId,
  agentId,
  result,
  cancelled = false,
  accepted = false,
  followup = false,
}: {
  translate: CanvasReceiptTranslate;
  bridgeKey?: string | null;
  turnId?: string | null;
  anchorTextPrefix?: string | null;
  projectId?: string | null;
  canvasId?: string | null;
  agentId?: string | null;
  result?: CanvasChatCommandApplyResult;
  cancelled?: boolean;
  accepted?: boolean;
  followup?: boolean;
}): CanvasCommandToolResultPayload {
  const workflowFailed = result ? workflowExecutionFailed(result) : false;
  const canvasApplyStatus: CanvasApplyStatus = accepted
    ? "accepted"
    : cancelled
    ? "cancelled_by_user"
    : result
      ? canvasApplyStatusFromResult(result)
      : "failed";
  const reconciliationPending = result?.commandResults.some((step) =>
    step.status === "pending" && step.output?.reason === "workflow_server_reconciliation_pending") ?? false;
  const userMessage = accepted
    ? undefined
    : cancelled
    ? "画布操作已取消，没有应用到画布。"
    : canvasApplyStatus === "unverified"
      ? workflowResultUnverifiedMessage(translate)
    : canvasApplyStatus === "pending"
      ? reconciliationPending ? workflowReconciliationPendingMessage(translate) : workflowResultSyncPendingMessage(translate)
    : canvasApplyStatus === "failed"
      ? canvasCommandUserMessageFromResult(result?.errors, result?.commandResults)
      : undefined;
  const agentHint = accepted
    ? "The canvas command has been submitted and is still running in the background. Reply briefly that generation is in progress and the status will update automatically. Do not claim completion."
    : cancelled
    ? "Do not claim the canvas change was applied; ask the user before retrying."
    : canvasApplyStatus === "unverified"
      ? WORKFLOW_RESULT_UNVERIFIED_HINT
    : canvasApplyStatus === "pending"
      ? reconciliationPending ? WORKFLOW_RECONCILIATION_PENDING_HINT : WORKFLOW_RESULT_SYNC_PENDING_HINT
    : canvasApplyStatus === "failed"
      ? canvasCommandAgentHintFromResult(result?.errors, result?.commandResults)
      : undefined;
  return {
    type: "canvas.command.result",
    received_at: Date.now(),
    turn_id: turnId ?? null,
    anchor_text_prefix: anchorTextPrefix ?? null,
    bridge_key: bridgeKey ?? "",
    ...(followup ? { followup: true } : {}),
    project_id: projectId ?? null,
    canvas_id: canvasId ?? null,
    agent_id: agentId ?? null,
    tool_call_status: cancelled ? "cancelled" : canvasApplyStatus === "failed" ? "failed" : "completed",
    canvas_apply_status: canvasApplyStatus,
    background_execution_status: canvasApplyStatus === "unverified"
      ? "unverified"
      : accepted || canvasApplyStatus === "pending"
      ? "running"
      : cancelled || canvasApplyStatus === "cancelled_by_user"
        ? "cancelled"
        : canvasApplyStatus === "failed"
          ? "failed"
          : "succeeded",
    applied: accepted || (!cancelled && !workflowFailed && canvasApplyStatus !== "pending"
      && canvasApplyStatus !== "unverified"
      && Boolean(result && (result.applied > 0 || result.openedUiActions > 0))),
    cancelled,
    errors: result?.errors ?? [],
    applied_count: result?.applied ?? 0,
    opened_ui_actions: result?.openedUiActions ?? 0,
    created_node_ids: result?.createdNodeIds ?? [],
    command_results: result?.commandResults ?? [],
    message: accepted
      ? "Canvas command was submitted and is running in the background."
      : cancelled
      ? "画布操作已取消，没有应用到画布。"
      : canvasApplyStatus === "unverified"
        ? workflowResultUnverifiedMessage(translate)
      : canvasApplyStatus === "pending"
        ? userMessage ?? workflowResultSyncPendingMessage(translate)
      : canvasApplyStatus === "failed"
        ? userMessage ?? "画布操作没有完成，我会换一种方式再试。"
        : "Canvas command finished; see canvas_apply_status for the outcome.",
    ...(userMessage ? { user_message: userMessage } : {}),
    ...(agentHint ? { agent_hint: agentHint } : {}),
  };
}

