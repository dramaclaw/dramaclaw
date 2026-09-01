import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import type { CanvasEventMap } from "@/features/canvas/application/ports";

type RunNodeActionPayload = CanvasEventMap["freezone/run-node-action"];

const PENDING_NODE_ACTION_TTL_MS = 60_000;

const pendingNodeActions = new Map<string, {
  payload: RunNodeActionPayload;
  createdAt: number;
}>();

function pendingNodeActionKey(payload: RunNodeActionPayload): string | null {
  return payload.requestId ?? null;
}

function prunePendingNodeActions(now = Date.now()): void {
  for (const [key, pending] of pendingNodeActions.entries()) {
    if (now - pending.createdAt > PENDING_NODE_ACTION_TTL_MS) {
      pendingNodeActions.delete(key);
    }
  }
}

export function dispatchNodeAction(payload: RunNodeActionPayload): number {
  prunePendingNodeActions();
  const key = pendingNodeActionKey(payload);
  if (key) {
    pendingNodeActions.set(key, {
      payload,
      createdAt: Date.now(),
    });
  }
  return canvasEventBus.publish("freezone/run-node-action", payload);
}

export function clearPendingNodeAction(requestId: string | undefined): void {
  if (!requestId) return;
  pendingNodeActions.delete(requestId);
}

export function subscribeNodeAction(
  handler: (payload: RunNodeActionPayload) => void,
): () => void {
  let active = true;
  const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", handler);

  queueMicrotask(() => {
    if (!active) return;
    prunePendingNodeActions();
    for (const { payload } of pendingNodeActions.values()) {
      if (!active) return;
      handler(payload);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

export function publishNodeActionAccepted(
  requestId: string | undefined,
  nodeId: string,
  action: string,
): void {
  if (!requestId) return;
  clearPendingNodeAction(requestId);
  canvasEventBus.publish("freezone/node-action-accepted", {
    requestId,
    nodeId,
    action,
  });
}

export function publishNodeActionSuccess(
  requestId: string | undefined,
  nodeId: string,
  action: string,
  output?: Record<string, unknown>,
): void {
  if (!requestId) return;
  clearPendingNodeAction(requestId);
  canvasEventBus.publish("freezone/node-action-result", {
    requestId,
    nodeId,
    action,
    status: "success",
    ...(output ? { output } : {}),
  });
}

export function publishNodeActionError(
  requestId: string | undefined,
  nodeId: string,
  action: string,
  error: unknown,
): void {
  if (!requestId) return;
  clearPendingNodeAction(requestId);
  canvasEventBus.publish("freezone/node-action-result", {
    requestId,
    nodeId,
    action,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  });
}
