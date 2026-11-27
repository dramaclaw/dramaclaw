// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasCommandEnvironment } from "@/features/canvas/core/commands/executor";
import type { CanvasEnvironment } from "@/features/canvas/core/environment";
import {
  VIDEO_REFERENCE_ENVELOPE,
  type VideoReferenceEnvelope,
} from "@/features/canvas/domain/videoReferenceLimits";

type RecordingOptions = {
  lastVideoModel?: string | null;
  videoReferenceEnvelope?: VideoReferenceEnvelope;
};

/** Deterministic environment that numbers ids and records what the store asked of it. */
export function recordingEnvironment(
  idPrefix: string,
  options: RecordingOptions = {},
): {
  environment: CanvasEnvironment;
  events: string[];
} {
  const events: string[] = [];
  let counter = 0;
  const environment: CanvasEnvironment = {
    ids: { next: () => `${idPrefix}-${(counter += 1)}` },
    translate: (key, translateOptions) =>
      translateOptions ? `${key} ${JSON.stringify(translateOptions)}` : key,
    onCanvasReplaced: () => events.push("canvas replaced"),
    onNodeDeleted: (nodeId) => events.push(`deleted ${nodeId}`),
    videoReferenceEnvelope: (videoNode) => {
      events.push(`envelope for ${videoNode.id}`);
      return options.videoReferenceEnvelope ?? { ...VIDEO_REFERENCE_ENVELOPE };
    },
    lastVideoModel: () => options.lastVideoModel ?? null,
  };
  return { environment, events };
}

/** Command host that accepts every envelope and records what the executor asked of it. */
export function recordingCommandEnvironment(): {
  commandEnvironment: CanvasCommandEnvironment;
  events: string[];
} {
  const events: string[] = [];
  const commandEnvironment: CanvasCommandEnvironment = {
    translate: (key) => key,
    validate: (envelopes, nodes) => {
      events.push(`validate ${envelopes.length} envelope against ${nodes.length} nodes`);
      return { ok: true, issues: [] };
    },
    afterNodesMeasured: () => events.push("measure requested"),
    removeProjection: (projectionKey) => events.push(`projection removed ${projectionKey}`),
    landSceneEdit: () => {
      throw new Error("scene edits are not available");
    },
    onNodeDataUpdated: (nodeId) => events.push(`node data updated ${nodeId}`),
  };
  return { commandEnvironment, events };
}
