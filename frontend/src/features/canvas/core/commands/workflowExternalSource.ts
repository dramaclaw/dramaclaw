// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { extractUpstreamContent } from "@/features/canvas/application/graphContentResolver";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

/** Error when a workflow external input no longer holds the media its draft verified. */
export function workflowExternalSourceMismatch(
  source: CanvasNode | undefined,
  sourceId: string,
  expected: { imageUrl?: unknown; videoUrl?: unknown },
): string | null {
  const content = source ? extractUpstreamContent(source) : undefined;
  if (typeof expected.videoUrl === "string" && expected.videoUrl.trim() &&
    content?.videoUrl !== expected.videoUrl) {
    return `workflow source video changed: ${sourceId}`;
  }
  if (typeof expected.imageUrl === "string" && expected.imageUrl.trim() &&
    content?.imageUrl !== expected.imageUrl) {
    return `workflow source image changed: ${sourceId}`;
  }
  return null;
}
