// SPDX-License-Identifier: Elastic-2.0
import type { Point } from "./character-movement";

export type PikoSeatAction = { seat: Point; approach: Point; radius: number; depthY?: number };

/** Seat coordinates are authored separately from the visible hit polygon. */
const SEATS: Record<string, PikoSeatAction> = {
  "welcome-east-bench": { seat: { x: 1490, y: 496 }, approach: { x: 1490, y: 566 }, radius: 78 },
  "market-west-bench": { seat: { x: 560, y: 730 }, approach: { x: 560, y: 786 }, radius: 78 },
  // This seat is in front of the overhanging east canopy (depth 783).
  "market-east-bench": { seat: { x: 1330, y: 684 }, approach: { x: 1330, y: 757 }, radius: 78, depthY: 784 },
};

export function pikoSeatAction(actionId: string): PikoSeatAction | null {
  return SEATS[actionId] ?? null;
}
