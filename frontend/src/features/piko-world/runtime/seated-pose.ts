// SPDX-License-Identifier: Elastic-2.0
/** Shared 64px seated-art geometry; world placement lives in seat-actions. */
export const SEATED_POSE = {
  pivot: { x: 32, y: 32 },
  scale: 1.05,
  footY: 54,
  headOffset: 18,
  accessory: [0, -27] as const,
  idleCycleMs: 8000,
  idleStartMs: 3200,
  idleEndMs: 4400,
} as const;
export const SEATED_FOOT_OFFSET = SEATED_POSE.footY - SEATED_POSE.pivot.y;
