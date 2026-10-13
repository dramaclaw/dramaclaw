// SPDX-License-Identifier: Elastic-2.0
/** Map-specific character scale and hillside depth perspective, in world coordinates. */
export function mapPerspectiveScale(mapId: string, y: number) {
  if (mapId === 'town-hall-interior') return 1.26;
  return mapId === 'amber-wilds' || mapId === 'cloudtop-slope'
    ? 0.65 + Math.max(0, Math.min(1152, y)) / 1152 * 0.35
    : 1;
}
