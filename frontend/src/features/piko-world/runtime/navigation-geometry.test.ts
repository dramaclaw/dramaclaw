// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import navigationDocument from "../../../../public/piko/world/maps/welcome-courtyard/data/navigation.json";
import manifestDocument from "../../../../public/piko/world/maps/welcome-courtyard/manifest.json";
import { PikoNavigationSchema } from "./map-package-schema";
import { canStand } from "./character-movement";
import { navigationIssues } from "./navigation-editor";
import { isPositionNavigable, pointInPolygon } from "./navigation-geometry";

const navigation = PikoNavigationSchema.parse(navigationDocument);

describe("pointInPolygon", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("treats polygon edges as part of the region", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 0, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 11, y: 5 }, square)).toBe(false);
  });
});

describe("welcome courtyard navigation", () => {
  it("keeps the reviewed draft inventory and every coordinate inside the map", () => {
    expect(navigationIssues(navigation)).toEqual([]);
    expect(canStand({x:1190,y:485},navigation)).toBe(true);
    expect(navigation.walkableAreas).toHaveLength(1);
    expect(navigation.colliders).toHaveLength(37);
    expect(navigation.spawnPoints).toHaveLength(3);
    expect(navigation.exits).toHaveLength(4);

    const polygons = [
      ...navigation.walkableAreas,
      ...navigation.colliders,
      ...navigation.exits.map((exit) => exit.trigger),
    ];
    const polygonIds = polygons.map((polygon) => polygon.id);
    expect(new Set(polygonIds).size).toBe(polygonIds.length);

    for (const polygon of polygons) {
      for (const point of polygon.points) {
        expect(point.x, `${polygon.id}.x`).toBeGreaterThanOrEqual(0);
        expect(point.x, `${polygon.id}.x`).toBeLessThanOrEqual(manifestDocument.size.width);
        expect(point.y, `${polygon.id}.y`).toBeGreaterThanOrEqual(0);
        expect(point.y, `${polygon.id}.y`).toBeLessThanOrEqual(manifestDocument.size.height);
      }
    }
  });

  it("keeps every spawn point on traversable ground", () => {
    for (const spawn of navigation.spawnPoints) {
      expect(canStand(spawn.position, navigation), spawn.id).toBe(true);
    }
  });

  it("allows open ground but rejects the fountain and outside the map", () => {
    expect(isPositionNavigable({ x: 850, y: 560 }, navigation)).toBe(true);
    expect(isPositionNavigable({ x: 1060, y: 550 }, navigation)).toBe(false);
    expect(isPositionNavigable({ x: 2049, y: 100 }, navigation)).toBe(false);
  });
});
