// SPDX-License-Identifier: Elastic-2.0
import type { PlayablePikoResidentId } from "./piko-residents";

/** Temporary local interaction fixture; never represents a connected account. */
export const PIKO_SIMULATED_RESIDENT = {
  id: "local-simulation-f01",
  residentId: "f01" as PlayablePikoResidentId,
  nickname: "小苔",
  bio: "喜欢庭院里的花，也喜欢认识新朋友。",
  position: { x: 1320, y: 485 },
} as const;
