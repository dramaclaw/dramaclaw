// SPDX-License-Identifier: Elastic-2.0
import type { Point } from "./character-movement";

export type PikoSeatAction = { seat: Point; approach: Point; radius: number };

/** Seat coordinates are authored separately from the visible hit polygon. */
const SEATS: Record<string, PikoSeatAction> = {
  "welcome-east-bench": { seat: { x: 1490, y: 496 }, approach: { x: 1490, y: 566 }, radius: 78 },
};

export function pikoSeatAction(actionId: string): PikoSeatAction | null {
  return SEATS[actionId] ?? null;
}
