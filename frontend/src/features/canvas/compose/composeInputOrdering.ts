// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isVideoNode,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";

function isAvailableComposeMedia(node: CanvasNode): boolean {
  return (
    (isVideoNode(node) && Boolean(node.data.videoUrl))
    || (isAudioNode(node) && Boolean(node.data.audioUrl))
  );
}

function workflowPlanNodeId(node: CanvasNode): string | null {
  const value = node.data.workflowPlanNodeId;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Prefer the dynamic workflow's semantic plan order. Nodes manually added to a
 * compose graph have no plan id, so retain the existing top-to-bottom fallback
 * for those remaining media inputs.
 */
export function orderedComposeSeedNodeIds(
  upstreamNodes: CanvasNode[],
  compositionInputOrder?: readonly string[],
): string[] {
  const available = upstreamNodes.filter(isAvailableComposeMedia);
  const byPlanId = new Map<string, CanvasNode>();
  const byNodeId = new Map(available.map((node) => [node.id, node]));
  for (const node of available) {
    const planId = workflowPlanNodeId(node);
    if (planId) byPlanId.set(planId, node);
  }

  const ordered: CanvasNode[] = [];
  const seen = new Set<string>();
  for (const sourceId of compositionInputOrder ?? []) {
    const node = byPlanId.get(sourceId) ?? byNodeId.get(sourceId);
    if (node && !seen.has(node.id)) {
      ordered.push(node);
      seen.add(node.id);
    }
  }

  const remaining = available
    .filter((node) => !seen.has(node.id))
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

  return [...ordered, ...remaining].map((node) => node.id);
}
