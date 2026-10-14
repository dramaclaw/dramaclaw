// SPDX-License-Identifier: Elastic-2.0
/** Logical 64px seated geometry; 256px art and seat-actions share these anchors. */
export const SEATED_POSE = {
  pivot: { x: 32, y: 32 },
  scale: 1.05,
  footY: 54,
  headOffset: 18,
  accessory: [0, -27] as const,
  idleCycleMs: 4000,
  idleStartMs: 1800,
  idleEndMs: 1980,
} as const;
export const SEATED_FOOT_OFFSET = SEATED_POSE.footY - SEATED_POSE.pivot.y;
