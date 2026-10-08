// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export interface SplitPlacementBox { x: number; y: number; width: number; height: number }

/** Keep consecutive segments on the source row so they remain easy to find. */
export function placeVideoSplitSegments(
  start: { x: number; y: number },
  size: { width: number; height: number },
  count: number,
  occupied: readonly SplitPlacementBox[],
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  let x = start.x;
  const y = start.y;
  for (let index = 0; index < count; index += 1) {
    // Every jump passes at least one obstacle; unrelated rows never move us.
    for (let attempt = 0; attempt <= occupied.length; attempt += 1) {
      const collisions = occupied.filter((box) => x < box.x + box.width + 24
        && x + size.width + 24 > box.x
        && y < box.y + box.height + 24 && y + size.height + 24 > box.y);
      if (!collisions.length) break;
      x = Math.max(...collisions.map((box) => box.x + box.width)) + 48;
    }
    positions.push({ x, y });
    x += size.width + 48;
  }
  return positions;
}
