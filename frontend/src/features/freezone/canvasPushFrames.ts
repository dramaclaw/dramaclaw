// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export function canvasPushReloadRevision(
  frame: unknown,
  { canvasId, currentRevision, requestedRevision, isOwnSave }: {
    canvasId: string;
    currentRevision: number | null;
    requestedRevision: number | null;
    isOwnSave: (id: unknown) => boolean;
  },
): number | null {
  if (
    typeof frame !== "object" || frame === null ||
    !("type" in frame) ||
    (frame.type !== "canvas.patch" && frame.type !== "canvas.reset") ||
    !("canvas_id" in frame) || frame.canvas_id !== canvasId ||
    !("revision" in frame) || typeof frame.revision !== "number" ||
    !Number.isInteger(frame.revision)
  ) {
    return null;
  }
  if (
    frame.type === "canvas.patch" &&
    isOwnSave("client_save_id" in frame ? frame.client_save_id : undefined)
  ) {
    return null;
  }
  if (requestedRevision != null && frame.revision <= requestedRevision) return null;
  // An unknown local revision still needs a full fetch after a reset.
  if (frame.type === "canvas.reset" && currentRevision == null) return frame.revision;
  return frame.revision > Math.max(currentRevision ?? -1, requestedRevision ?? -1)
    ? frame.revision
    : null;
}
