// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Pure decision logic for the Freezone canvas save protocol. Extracted from
 * `useCanvasSync` so it can be exercised in isolation by `canvasSyncCore.test.ts`
 * without spinning up React / ReactFlow / a backend.
 *
 * The hook collects a `SaveSnapshot` from the React refs + zustand stores, asks
 * `decideSaveAction` what to do, and — if the action is `"send"` — feeds the
 * decision into `buildSavePayload` to assemble the PUT body. Every branch the
 * hook can take is therefore expressible as a data-in / data-out test case.
 *
 * The split intentionally avoids hidden coupling to React state: every input is
 * passed in explicitly and every output is a plain object.
 */

import type {
  CanvasBackupStatus,
  CanvasSaveSource,
  FreezoneCanvasPayload,
} from "@/api/canvas";
import type { CanvasMutationSource } from "@/stores/canvasStore";

/**
 * Caps on canvas payload size. Mirror of the backend's Pydantic / body
 * middleware limits.
 *
 * - `MAX_NODES` / `MAX_EDGES` are **hard** caps on the client: counts that
 *   high only come from runaway loops, and the backend's Pydantic validator
 *   rejects them with 422 anyway. Hitting either stops autosave with an
 *   error overlay.
 *
 * - `MAX_BODY_BYTES` is **advisory** on the client. Real freezone canvases
 *   (with image preview data URLs / per-node metadata) routinely cross 5 MB,
 *   and the backend's 5 MB middleware is not deployed everywhere yet. The
 *   hook logs a `console.warn` but still issues the PUT; if the backend
 *   actually rejects with 413, `classifySaveError` already routes that to
 *   a fatal-error overlay.
 *
 * Source of truth: backend `MAX_NODES` / `MAX_EDGES` + 5 MB request body
 * middleware in SuperTale2's freezone routes. Keep both in sync — if the
 * backend ever raises these limits, bump both ends.
 */
export const MAX_NODES = 50_000;
export const MAX_EDGES = 200_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Snapshot of everything `decideSaveAction` needs to make a call. Derived from
 * the React refs (`hydratedRef`, `switchingRef`, `lastRemoteNodeCountRef`,
 * `pendingClientSaveIdRef`'s shadow) plus the live zustand state
 * (`nodes.length`, `userEditsSinceHydrate`, `lastMutationSource`,
 * `pendingClearIntent`).
 */
export interface SaveSnapshot {
  /** False while the GET hydrate is still in flight. */
  hydrated: boolean;
  /** True while canvas/project is changing. */
  switching: boolean;
  nodeCount: number;
  edgeCount: number;
  /** Node count returned by the most recent successful GET / PUT response. */
  lastRemoteNodeCount: number;
  userEditsSinceHydrate: number;
  lastMutationSource: CanvasMutationSource | null;
  pendingClearIntent: boolean;
}

export type SaveBlockReason =
  | "not_hydrated"
  | "switching"
  | "dangerous_empty";

export type SaveDecision =
  | { kind: "skip"; reason: "not_hydrated" | "switching" }
  | { kind: "block"; reason: "dangerous_empty"; lastRemoteNodeCount: number }
  | {
      kind: "send";
      saveSource: CanvasSaveSource;
      allowEmptyOverwrite: boolean;
    };

/**
 * Five-state decision machine, applied each time the debounced save timer
 * fires.
 *
 * Inputs / outputs:
 * 1. Not hydrated yet → `skip` (the GET is still in flight, nothing the user
 *    sees has been pushed into the store yet).
 * 2. Canvas / project is switching → `skip` (refs are mid-reset).
 * 3. Local canvas is empty, the server's last known state was non-empty, and
 *    the user explicitly asked to clear (`pendingClearIntent` or
 *    `lastMutationSource === "manual_clear"`) → `send` as `manual_clear`
 *    with `allow_empty_overwrite: true`.
 * 4. Local canvas is empty, the server's last known state was non-empty, and
 *    the user emptied it by deleting nodes one by one
 *    (`lastMutationSource === "delete_to_empty"`) → auto-promote to the same
 *    `manual_clear` payload so the autosave is accepted without forcing the
 *    user to press a "clear canvas" button.
 * 5. Local canvas is empty, the server's last known state was non-empty, and
 *    the mutation source does NOT match an intentional clear → `block`.
 *    This catches HMR / Zustand reset accidents where the store flipped to
 *    `[]` without any user input, which is exactly the failure mode the
 *    backend's `dangerous_empty_canvas_overwrite` guard exists to catch.
 *
 * In every other case (non-empty save, or empty-on-both-sides) we send a
 * vanilla autosave with `allow_empty_overwrite: false`. The dangerous-empty
 * guard is intentionally narrow: only fires when local is empty AND server
 * was non-empty, so noop autosaves on a brand-new empty canvas still go
 * through.
 */
export function decideSaveAction(snap: SaveSnapshot): SaveDecision {
  if (!snap.hydrated) {
    return { kind: "skip", reason: "not_hydrated" };
  }
  if (snap.switching) {
    return { kind: "skip", reason: "switching" };
  }

  const localEmpty = snap.nodeCount === 0;
  const remoteWasNonEmpty = snap.lastRemoteNodeCount > 0;

  if (localEmpty && remoteWasNonEmpty) {
    if (snap.pendingClearIntent || snap.lastMutationSource === "manual_clear") {
      return {
        kind: "send",
        saveSource: "manual_clear",
        allowEmptyOverwrite: true,
      };
    }
    if (snap.lastMutationSource === "delete_to_empty") {
      // User deleted nodes one at a time until the canvas was empty. Treat
      // this as an implicit clear so the autosave is accepted; the user does
      // not need to press a dedicated "clear" button.
      return {
        kind: "send",
        saveSource: "manual_clear",
        allowEmptyOverwrite: true,
      };
    }
    return {
      kind: "block",
      reason: "dangerous_empty",
      lastRemoteNodeCount: snap.lastRemoteNodeCount,
    };
  }

  return {
    kind: "send",
    saveSource: "autosave",
    allowEmptyOverwrite: false,
  };
}

export interface BuildSavePayloadInput {
  nodes: unknown[];
  edges: unknown[];
  viewport?: unknown;
  metadata?: Record<string, unknown> | null;
  baseRevision: number | null;
  clientSaveId: string;
  decision: Extract<SaveDecision, { kind: "send" }>;
  envelope?: Partial<FreezoneCanvasPayload>;
  canvasId: string;
}

/**
 * Last-line defense against `previewImageUrl` shipping as a `data:image/...`
 * base64 blob in the save payload.
 *
 * The intended contract is: every node-creation site that calls
 * `uploadLocalImageToBackend` writes the returned static URL into BOTH
 * `imageUrl` and `previewImageUrl` (see RotateEditorOverlay / RedrawOverlay
 * for the canonical pattern). Historically a few sites only updated
 * `imageUrl`, leaving `previewImageUrl` as the local `data:` URL produced by
 * `prepareNodeImage` (which is a passthrough on the web). That base64 then
 * flowed straight into PUT /default, bloating the canvas to MBs and saturating
 * the request body cap.
 *
 * This sanitizer rewrites any `previewImageUrl` that still looks like a data
 * URL to the node's `imageUrl` (or `null` if `imageUrl` itself is unusable).
 * It runs at the single serialization chokepoint so we also clean up
 * already-polluted historical canvases the next time the user saves them.
 *
 * StoryboardSplitNode keeps per-frame `imageUrl` + `previewImageUrl` inside
 * `data.frames`, so we walk that list too. We log a single grouped `warn` per
 * save if anything was rewritten — that surfaces any new leak path without
 * spamming console for the steady-state historical-cleanup case.
 */
function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function pickUsableUrl(url: unknown): string | null {
  return typeof url === "string" && url && !url.startsWith("data:") ? url : null;
}

interface SanitizedNodeRecord {
  nodeId: string;
  scope: "node" | `frame[${number}]`;
  replacedWith: "imageUrl" | "null";
}

export function sanitizePreviewImageUrls(nodes: unknown[]): unknown[] {
  const rewrites: SanitizedNodeRecord[] = [];

  const sanitized = nodes.map((rawNode) => {
    if (!rawNode || typeof rawNode !== "object") {
      return rawNode;
    }
    const node = rawNode as { id?: unknown; data?: unknown };
    const data = node.data;
    if (!data || typeof data !== "object") {
      return rawNode;
    }
    const dataRecord = data as Record<string, unknown>;
    const nodeId = typeof node.id === "string" ? node.id : "<unknown>";

    let nextData: Record<string, unknown> | null = null;

    if (isDataUrl(dataRecord.previewImageUrl)) {
      const fallback = pickUsableUrl(dataRecord.imageUrl);
      nextData = { ...dataRecord, previewImageUrl: fallback };
      rewrites.push({
        nodeId,
        scope: "node",
        replacedWith: fallback ? "imageUrl" : "null",
      });
    }

    const frames = dataRecord.frames;
    if (Array.isArray(frames)) {
      let framesChanged = false;
      const nextFrames = frames.map((frame, index) => {
        if (!frame || typeof frame !== "object") {
          return frame;
        }
        const frameRecord = frame as Record<string, unknown>;
        if (!isDataUrl(frameRecord.previewImageUrl)) {
          return frame;
        }
        const fallback = pickUsableUrl(frameRecord.imageUrl);
        framesChanged = true;
        rewrites.push({
          nodeId,
          scope: `frame[${index}]`,
          replacedWith: fallback ? "imageUrl" : "null",
        });
        return { ...frameRecord, previewImageUrl: fallback };
      });
      if (framesChanged) {
        nextData = { ...(nextData ?? dataRecord), frames: nextFrames };
      }
    }

    return nextData ? { ...node, data: nextData } : rawNode;
  });

  if (rewrites.length > 0) {
    console.warn(
      `[canvasSync] stripped base64 previewImageUrl from ${rewrites.length} field(s) before PUT`,
      rewrites,
    );
  }

  return sanitized;
}

/**
 * Materialize the PUT body for a "send" decision. Keeps the envelope merge in
 * one place so callers do not silently drop `base_revision` / `client_save_id`
 * when refactoring.
 */
export function buildSavePayload(
  input: BuildSavePayloadInput,
): FreezoneCanvasPayload {
  const payload: FreezoneCanvasPayload = {
    ...input.envelope,
    canvas_id: input.canvasId,
    nodes: sanitizePreviewImageUrls(input.nodes),
    edges: input.edges,
    ...(input.viewport ? { viewport: input.viewport } : {}),
    metadata: input.metadata ?? null,
    client_save_id: input.clientSaveId,
    save_source: input.decision.saveSource,
    allow_empty_overwrite: input.decision.allowEmptyOverwrite,
  };
  if (input.baseRevision != null) {
    payload.base_revision = input.baseRevision;
  }
  return payload;
}

export interface PayloadLimitViolation {
  field: "nodes" | "edges" | "body";
  actual: number;
  limit: number;
}

/**
 * Check the prepared PUT body against the four hard caps before firing the
 * request. Returns `null` when within bounds; otherwise the first-violated
 * field is reported (we do not enumerate all violations — one is enough for
 * the user to take action).
 *
 * `serializedSize` is optional because computing `JSON.stringify` twice (once
 * here, once inside ky) is wasteful when nodes/edges already short-circuit.
 * `useCanvasSync` calls this with the count-only check first and only falls
 * back to the body-size check when counts pass.
 */
export function checkPayloadLimits(
  nodeCount: number,
  edgeCount: number,
  serializedSize: number | null,
): PayloadLimitViolation | null {
  if (nodeCount > MAX_NODES) {
    return { field: "nodes", actual: nodeCount, limit: MAX_NODES };
  }
  if (edgeCount > MAX_EDGES) {
    return { field: "edges", actual: edgeCount, limit: MAX_EDGES };
  }
  if (serializedSize != null && serializedSize > MAX_BODY_BYTES) {
    return { field: "body", actual: serializedSize, limit: MAX_BODY_BYTES };
  }
  return null;
}

/**
 * Human-readable message for a payload-limit violation, used by the hook to
 * set the conflict / error string. Kept here so the test asserts the wording
 * once instead of testing the hook indirectly.
 */
export function describePayloadViolation(v: PayloadLimitViolation): string {
  if (v.field === "nodes") {
    return `节点数量 ${v.actual} 超出上限 ${v.limit}，已暂停保存。请删除部分节点后再继续。`;
  }
  if (v.field === "edges") {
    return `连线数量 ${v.actual} 超出上限 ${v.limit}，已暂停保存。请精简连接后再继续。`;
  }
  return `画布数据 ${Math.round(v.actual / 1024)} KB 超出 ${Math.round(v.limit / 1024)} KB 上限，已暂停保存。`;
}

export interface SaveErrorBody {
  detail?: { code?: unknown };
}

export type SaveResponseOutcome =
  | { kind: "ok"; revision: number; backupStatus: CanvasBackupStatus | undefined }
  | {
      kind: "ok_with_warning";
      revision: number | null;
      backupStatus: "pending";
      message: string;
    }
  | { kind: "conflict"; message: string }
  | { kind: "dangerous_empty"; message: string }
  | { kind: "retry"; afterMs: number; code: "canvas_lock_busy" }
  | { kind: "fatal"; code: string; message: string }
  | { kind: "error"; message: string };

/**
 * Map a save response (success or thrown ApiError-equivalent) to the
 * UX action the hook should take. Keeping this pure makes the per-code
 * behavior auditable in tests without faking the ky/HTTP stack.
 *
 * The hook stays responsible for actually applying the outcome (setStatus,
 * setError, retry timer); this function only decides which outcome applies.
 */
export function classifySaveError(
  status: number | null,
  body: SaveErrorBody | undefined,
  fallbackMessage: string,
): SaveResponseOutcome {
  const code = typeof body?.detail?.code === "string" ? body.detail.code : null;

  if (status === 409) {
    // Three backend conditions land on 409, but only two are distinguishable
    // here: `canvas_revision_conflict` and `canvas_idempotency_conflict` carry
    // a `detail.code`, while `CanvasBaseRevisionRequired` raises a bare string
    // detail and therefore still falls through to the canonical message.
    // `canvas_idempotency_conflict` is one client replaying a client_save_id
    // with a different body — telling that user "another window" sends them
    // hunting for a tab that does not exist. Only the plain revision conflict
    // really means someone else wrote to the canvas.
    if (code === "canvas_idempotency_conflict") {
      return {
        kind: "conflict",
        message: "同一次保存被重复提交且内容不一致，请刷新后重试",
      };
    }
    return {
      kind: "conflict",
      message: "画布已被其他窗口或用户修改",
    };
  }
  if (status === 400 && code === "dangerous_empty_canvas_overwrite") {
    return {
      kind: "dangerous_empty",
      message: "本地画布为空，但服务器还有节点 — 请刷新后再编辑",
    };
  }
  if (status === 503 && code === "canvas_lock_busy") {
    return { kind: "retry", afterMs: 1_000, code: "canvas_lock_busy" };
  }
  if (status === 503 && code === "canvas_backup_pending") {
    return {
      kind: "ok_with_warning",
      revision: null,
      backupStatus: "pending",
      message: "本地已保存，云端备份待重试",
    };
  }
  if (status === 413 || (status === 422 && code === "canvas_payload_too_large")) {
    return {
      kind: "fatal",
      code: code ?? "canvas_payload_too_large",
      message: "画布数据量超出后端上限",
    };
  }
  if (
    status === 500 &&
    (code === "canvas_needs_migration" || code === "canvas_backup_failed")
  ) {
    return {
      kind: "fatal",
      code,
      message:
        code === "canvas_needs_migration"
          ? "后端画布数据需要迁移，请联系管理员"
          : "云端备份失败，请稍后再试",
    };
  }
  return { kind: "error", message: fallbackMessage };
}
