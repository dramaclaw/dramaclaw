// SPDX-License-Identifier: Elastic-2.0
import type { PikoPoint } from './navigation-geometry';
import type { PikoOccluder } from './map-package-schema';

/** Conservative body envelope, including the raised head before settling.
 * Reject overlap with scenery bounds rather than accept a partially hidden rest.
 */
export function isPetRestVisible(point: PikoPoint, occluders: readonly PikoOccluder[]) {
  return !occluders.some(item => {
    if (point.y >= item.depthY) return false;
    const outline = item.outline;
    const xs = outline?.map(p => p.x) ?? [0, item.frame?.width ?? 0];
    const ys = outline?.map(p => p.y) ?? [0, item.frame?.height ?? 0];
    return point.x + 48 >= item.position.x + Math.min(...xs)
      && point.x - 48 <= item.position.x + Math.max(...xs)
      && point.y >= item.position.y + Math.min(...ys)
      && point.y - 75 <= item.position.y + Math.max(...ys);
  });
}
