// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PikoNavigation } from "./map-package-schema";

export type PikoPoint = { x: number; y: number };

function pointOnSegment(point: PikoPoint, start: PikoPoint, end: PikoPoint): boolean {
  const cross =
    (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > Number.EPSILON * 100) return false;
  const dot =
    (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < 0) return false;
  const squaredLength = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return dot <= squaredLength;
}

export function pointInPolygon(point: PikoPoint, polygon: readonly PikoPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const start = polygon[previous];
    const end = polygon[current];
    if (pointOnSegment(point, start, end)) return true;
    const crossesRay =
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x;
    if (crossesRay) inside = !inside;
  }
  return inside;
}

export function isPositionNavigable(point: PikoPoint, navigation: PikoNavigation): boolean {
  const insideWalkableArea = navigation.walkableAreas.some((area) =>
    pointInPolygon(point, area.points),
  );
  if (!insideWalkableArea) return false;
  return !navigation.colliders.some((collider) => pointInPolygon(point, collider.points));
}
