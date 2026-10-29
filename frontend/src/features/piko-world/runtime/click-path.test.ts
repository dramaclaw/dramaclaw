// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import { clearWalkSegment, findClickPath } from "./click-path";
import { PikoNavigationSchema } from "./map-package-schema";
import { readFileSync } from "node:fs";
const nav = PikoNavigationSchema.parse(JSON.parse(readFileSync("public/piko/world/maps/welcome-courtyard/data/navigation.json", "utf8")));
it("routes around the fountain without crossing collision regions", () => {
  const start = { x: 1250, y: 550 }, target = { x: 900, y: 550 };
  const path = findClickPath(start, target, nav);
  expect(path.length).toBeGreaterThan(1);
  expect(path[path.length - 1]).toEqual(target);
  let previous = start;
  for (const point of path) {
    expect(clearWalkSegment(previous, point, nav)).toBe(true);
    previous = point;
  }
});
it("rejects blocked destinations and takes direct routes across clear ground", () => {
  const start = { x: 1190, y: 485 };
  expect(findClickPath(start, { x: 1060, y: 560 }, nav)).toEqual([]);
  const target = { x: 1210, y: 485 };
  expect(findClickPath(start, target, nav)).toEqual([target]);
});
