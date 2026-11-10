// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from "@/features/canvas/core/environment";

/** Deterministic environment that numbers ids and records lifecycle notifications. */
export function recordingEnvironment(idPrefix: string): {
  environment: CanvasEnvironment;
  events: string[];
} {
  const events: string[] = [];
  let counter = 0;
  const environment: CanvasEnvironment = {
    ids: { next: () => `${idPrefix}-${(counter += 1)}` },
    translate: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
    onCanvasReplaced: () => events.push("canvas replaced"),
    onNodeDeleted: (nodeId) => events.push(`deleted ${nodeId}`),
  };
  return { environment, events };
}
