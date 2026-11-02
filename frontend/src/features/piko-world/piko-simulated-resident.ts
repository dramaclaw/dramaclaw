// SPDX-License-Identifier: Elastic-2.0
import type { PlayablePikoResidentId } from "./piko-residents";

/** Legacy chat preview fixture; world placement lives in piko-town-npcs.ts. */
export const PIKO_SIMULATED_RESIDENT = {
  id: "local-simulation-f01",
  residentId: "f01" as PlayablePikoResidentId,
  // i18n-exempt-start: test-only fixture, never rendered by the product
  nickname: "小苔",
  bio: "喜欢庭院里的花，也喜欢认识新朋友。",
  // i18n-exempt-end
} as const;
