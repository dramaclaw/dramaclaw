import i18next from "i18next";
import { api } from "@/lib/api";
import { buildCanvasCommandToolResultPayload, type CanvasCommandToolResultPayload } from "./canvasCommandReceipt";

export const FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT = "freezone/canvas-command-tool-result";
const CANVAS_COMMAND_RECEIPTS_STORAGE_KEY = "dramaclaw.canvas-command-receipts.v1";
const CANVAS_COMMAND_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const CANVAS_COMMAND_RECEIPT_LIMIT = 100;

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
  next[receiptStorageKey(payload)] = { storedAt: now, payload };
  try {
    window.localStorage.setItem(CANVAS_COMMAND_RECEIPTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing and storage quotas must not block result delivery.
  }
}

function receiptStorageKey(payload: CanvasCommandToolResultPayload): string {
  return payload.followup ? `${payload.bridge_key}:followup` : payload.bridge_key;
}

function removeCanvasCommandReceipt(payload: CanvasCommandToolResultPayload) {
  if (typeof window === "undefined" || !payload.bridge_key) return;
  const receipts = loadCanvasCommandReceipts();
  const key = receiptStorageKey(payload);
  if (!(key in receipts)) return;
  delete receipts[key];
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
    removeCanvasCommandReceipt(payload);
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to report canvas command result", error);
  });
}

export function replayCanvasCommandToolResult(payload: CanvasCommandToolResultPayload) {
  emitCanvasCommandToolResult(payload);
}

export function replayPendingCanvasCommandFollowups() {
  const now = Date.now();
  for (const receipt of Object.values(loadCanvasCommandReceipts())) {
    if (receipt?.payload?.followup && receipt.storedAt >= now - CANVAS_COMMAND_RECEIPT_TTL_MS) {
      emitCanvasCommandToolResult(receipt.payload);
    }
  }
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
  followup = false,
}: Omit<Parameters<typeof buildCanvasCommandToolResultPayload>[0], 'translate'>) {
  if (!bridgeKey) return;
  const payload = buildCanvasCommandToolResultPayload({
    translate: (key, options) => i18next.t(key, options),
    bridgeKey,
    turnId,
    anchorTextPrefix,
    projectId,
    canvasId,
    agentId,
    result,
    cancelled,
    accepted,
    followup,
  });
  storeCanvasCommandReceipt(payload);
  emitCanvasCommandToolResult(payload);
}
