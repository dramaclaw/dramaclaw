// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { getFreezoneCanvas, type FreezoneCanvasPayload } from "@/api/canvas";
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";

export type RemoteCanvasMerge = (
  remoteNodes: CanvasNode[],
  remoteEdges: CanvasEdge[],
  localNodes: CanvasNode[],
  localEdges: CanvasEdge[],
) => { nodes: CanvasNode[]; edges: CanvasEdge[] };

export interface RemoteCanvasApplyOptions {
  /**
   * Refuse to replace the open canvas when it contains edits that have not
   * reached the server yet. Remote writes initiated by the current Agent use
   * this guard: a clean canvas can adopt the Agent's new revision silently,
   * while genuine concurrent local work still gets the recovery overlay.
   */
  protectUnsavedLocalEdits?: boolean;
  conflictMessage?: string;
}

type RemoteCanvasApplier = (
  remote: FreezoneCanvasPayload,
  merge?: RemoteCanvasMerge,
  options?: RemoteCanvasApplyOptions,
) => boolean;

type CanvasFlush = () => Promise<boolean>;

export interface LocalProjectionPayload {
  projectionKey: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  metadata?: Record<string, unknown> | null;
}

type LocalProjectionApplier = (
  projection: LocalProjectionPayload,
) => boolean;
type LocalProjectionRemover = (projectionKey: string) => boolean;

interface RemoteCanvasRuntime {
  project: string;
  canvasId: string;
  apply: RemoteCanvasApplier;
  flush?: CanvasFlush;
  applyLocalProjection?: LocalProjectionApplier;
  removeLocalProjection?: LocalProjectionRemover;
}

let currentRuntime: RemoteCanvasRuntime | null = null;
const pendingLocalProjections = new Map<string, LocalProjectionPayload[]>();

function runtimeKey(project: string, canvasId: string): string {
  return `${project}\u0000${canvasId}`;
}

export function registerFreezoneCanvasRuntime(
  project: string,
  canvasId: string,
  apply: RemoteCanvasApplier,
  flush?: CanvasFlush,
  applyLocalProjection?: LocalProjectionApplier,
  removeLocalProjection?: LocalProjectionRemover,
): () => void {
  const runtime = { project, canvasId, apply, flush, applyLocalProjection, removeLocalProjection };
  currentRuntime = runtime;
  return () => {
    if (currentRuntime === runtime) {
      currentRuntime = null;
    }
  };
}

export function applyRemoteFreezoneCanvas(
  project: string,
  canvasId: string,
  remote: FreezoneCanvasPayload,
  merge?: RemoteCanvasMerge,
  options?: RemoteCanvasApplyOptions,
): boolean {
  if (!currentRuntime || currentRuntime.project !== project || currentRuntime.canvasId !== canvasId) {
    return false;
  }
  return currentRuntime.apply(remote, merge, options);
}

export async function refreshRemoteFreezoneCanvas(
  project: string,
  canvasId: string,
  options?: RemoteCanvasApplyOptions,
): Promise<boolean> {
  const remote = await getFreezoneCanvas(project, canvasId);
  return applyRemoteFreezoneCanvas(project, canvasId, remote, undefined, options);
}

export async function flushFreezoneCanvasRuntime(
  project: string,
  canvasId: string,
): Promise<boolean | null> {
  if (!currentRuntime || currentRuntime.project !== project || currentRuntime.canvasId !== canvasId) {
    return null;
  }
  if (!currentRuntime.flush) {
    return null;
  }
  return await currentRuntime.flush();
}

export function queueLocalFreezoneProjection(
  project: string,
  canvasId: string,
  projection: LocalProjectionPayload,
): void {
  const key = runtimeKey(project, canvasId);
  const existing = pendingLocalProjections.get(key) ?? [];
  pendingLocalProjections.set(key, [
    ...existing.filter((item) => item.projectionKey !== projection.projectionKey),
    projection,
  ]);
}

export function consumeQueuedLocalFreezoneProjections(
  project: string,
  canvasId: string,
): boolean {
  if (
    !currentRuntime ||
    currentRuntime.project !== project ||
    currentRuntime.canvasId !== canvasId ||
    !currentRuntime.applyLocalProjection
  ) {
    return false;
  }
  const key = runtimeKey(project, canvasId);
  const queued = pendingLocalProjections.get(key);
  if (!queued || queued.length === 0) {
    return false;
  }
  const remaining: LocalProjectionPayload[] = [];
  let applied = false;
  for (const projection of queued) {
    if (currentRuntime.applyLocalProjection(projection)) {
      applied = true;
    } else {
      remaining.push(projection);
    }
  }
  if (remaining.length > 0) {
    pendingLocalProjections.set(key, remaining);
  } else {
    pendingLocalProjections.delete(key);
  }
  return applied;
}

export function removeLocalFreezoneProjection(
  project: string,
  canvasId: string,
  projectionKey: string,
): boolean {
  if (
    !currentRuntime ||
    currentRuntime.project !== project ||
    currentRuntime.canvasId !== canvasId ||
    !currentRuntime.removeLocalProjection
  ) {
    return false;
  }
  return currentRuntime.removeLocalProjection(projectionKey);
}
