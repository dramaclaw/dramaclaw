// SPDX-License-Identifier: Elastic-2.0
/** Authored depth perspective on the two hillside maps, in world coordinates. */
export function mapPerspectiveScale(mapId: string, y: number) {
  return mapId === 'amber-wilds' || mapId === 'cloudtop-slope'
    ? 0.65 + Math.max(0, Math.min(1152, y)) / 1152 * 0.35
    : 1;
}
