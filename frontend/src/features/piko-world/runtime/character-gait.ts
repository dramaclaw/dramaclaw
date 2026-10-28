// SPDX-License-Identifier: Elastic-2.0
/** Advance the authored cycle by ground covered, not wall-clock time. */
export function advanceGait(distance: number, travelled: number, cycleDistance: number) {
  if (!Number.isFinite(travelled) || travelled <= 0) return distance;
  return (distance + travelled) % cycleDistance;
}
const RESIDENT_WALK_COLUMNS = [3, 4, 5, 6, 7, 8, 9, 10] as const;
export function gaitColumn(distance: number, cycleDistance: number, columns: readonly number[] = RESIDENT_WALK_COLUMNS) {
  return columns[Math.floor((distance % cycleDistance) / cycleDistance * columns.length)];
}

/** Contacts occur at the start and midpoint of a cycle, including the first step out of idle. */
export function crossesFootContact(distance: number, travelled: number, cycleDistance: number, wasMoving: boolean) {
  if (!Number.isFinite(travelled) || travelled <= 0.01) return false;
  return !wasMoving || Math.floor((distance + travelled) / (cycleDistance / 2)) > Math.floor(distance / (cycleDistance / 2));
}
