// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { getFreezoneCanvas } from "@/api/canvas";
import { applyRemoteFreezoneCanvas } from "@/features/freezone/canvasSyncRuntime";
import type { CanvasNode } from "@/stores/canvasStore";

const VIDEO_COMPOSE_PROJECTION_FIELDS = [
  "resultVideoUrl",
  "resultVideoTaskKey",
  "resultVideoJobId",
  "previewImageUrl",
  "isGenerating",
  "generationStartedAt",
  "generationTaskKey",
  "generationTaskType",
  "generationTaskJobId",
  "generationError",
] as const;

function dataRecord(node: CanvasNode | undefined): Record<string, unknown> | null {
  const data = node?.data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * Re-anchor the open canvas to the revision written by the compose worker.
 * Local graph edits stay intact; only the matching task's projection-owned
 * fields are accepted from the server before the browser adds its result node.
 */
export async function reconcileCompletedVideoComposeProjection(params: {
  projectId: string;
  canvasId: string;
  nodeId: string;
  taskKey: string;
  jobId: string;
}): Promise<boolean> {
  const { projectId, canvasId, nodeId, taskKey, jobId } = params;
  const remote = await getFreezoneCanvas(projectId, canvasId);
  return applyRemoteFreezoneCanvas(
    projectId,
    canvasId,
    remote,
    (remoteNodes, _remoteEdges, localNodes, localEdges) => {
      const remoteData = dataRecord(
        remoteNodes.find((node) => node.id === nodeId),
      );
      if (
        !remoteData ||
        remoteData.resultVideoTaskKey !== taskKey ||
        remoteData.resultVideoJobId !== jobId
      ) {
        return { nodes: localNodes, edges: localEdges };
      }

      const projectionPatch: Record<string, unknown> = {};
      for (const field of VIDEO_COMPOSE_PROJECTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(remoteData, field)) {
          projectionPatch[field] = remoteData[field];
        }
      }
      return {
        nodes: localNodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...(dataRecord(node) ?? {}),
                  ...projectionPatch,
                },
              }
            : node,
        ),
        edges: localEdges,
      };
    },
  );
}
