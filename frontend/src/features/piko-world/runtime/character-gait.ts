// SPDX-License-Identifier: Elastic-2.0
/** Advance the authored cycle by ground covered, not wall-clock time. */
export function advanceGait(distance: number, travelled: number, cycleDistance: number) {
  if (!Number.isFinite(travelled) || travelled <= 0) return distance;
  return (distance + travelled) % cycleDistance;
}
export function gaitColumn(distance: number, cycleDistance: number) {
  return 3 + Math.floor((distance % cycleDistance) / cycleDistance * 8);
}

/** Contacts occur at poses 0 and 4, including the first step out of idle. */
export function crossesFootContact(distance: number, travelled: number, cycleDistance: number, wasMoving: boolean) {
  if (!Number.isFinite(travelled) || travelled <= 0.01) return false;
  return !wasMoving || Math.floor((distance + travelled) / (cycleDistance / 2)) > Math.floor(distance / (cycleDistance / 2));
}
