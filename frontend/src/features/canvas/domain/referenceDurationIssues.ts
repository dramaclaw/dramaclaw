// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { formatAudioDurationSeconds, type AudioDurationRejection } from "../nodes/shared/videoModelCapabilities";
import type { ReferenceIssue } from "./referenceIssues";

export function referenceDurationIssues(
  media: "audio" | "video",
  rejection: AudioDurationRejection,
  limits: { minMs?: number; maxMs?: number },
): ReferenceIssue[] {
  const total = rejection.kind === "totalTooShort" || rejection.kind === "totalTooLong";
  const code = rejection.kind === "tooShort" ? "minDuration"
    : rejection.kind === "tooLong" ? "maxDuration"
      : rejection.kind === "totalTooShort" ? "totalMinDuration" : "totalMaxDuration";
  const expectedMs = total ? rejection.limitMs
    : rejection.kind === "tooShort" ? limits.minMs : limits.maxMs;
  return rejection.clips.map((clip, position) => ({
    media,
    index: clip.index ?? position + 1,
    name: clip.label,
    reference_key: clip.url ?? "",
    code,
    actual: formatAudioDurationSeconds(total ? rejection.totalMs : clip.durationMs),
    expected: formatAudioDurationSeconds(expectedMs ?? 0),
    nodeId: clip.nodeId,
  }));
}
