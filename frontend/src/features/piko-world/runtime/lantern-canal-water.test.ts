// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { pointInPolygon } from "./navigation-geometry";
import { PikoEnvironmentSchema } from "./map-package-schema";

const environment = PikoEnvironmentSchema.parse(JSON.parse(readFileSync(
  "public/piko/world/maps/lantern-canal-street/data/environment.json", "utf8")));
const water = environment.effects.filter(effect => effect.layer === "water");

it("animates both sides of the bridge and the southeast shallows without painting the bridge or banks", () => {
  expect(water.map(effect => effect.id)).toEqual([
    "canal-upper-river-water", "canal-lower-river-water", "canal-southeast-shallows-water",
  ]);
  expect(water.map(effect => effect.opacity)).toEqual([0.3, 0.3, 0.2]);
  expect(water.map(effect => effect.animation?.startStep ?? 0)).toEqual([0, 5, 10]);
  for (const effect of water) {
    expect(effect.src).toBe("effects/river-water-v1.png");
    expect(effect.animation).toMatchObject({ columns: 4, rows: 4, frames: 16, fps: 2, inset: 3 });
    expect(effect.region).toBeDefined();
  }
  const covers = (x: number, y: number) => water.some(effect =>
    pointInPolygon({ x, y }, effect.region!.points));
  expect(covers(1100, 250)).toBe(true); // Upstream river.
  expect(covers(1040, 800)).toBe(true); // Downstream river.
  expect(covers(1900, 1080)).toBe(true); // Shallow water below the dock.
  expect(covers(960, 90)).toBe(true); // West bank water near the greenhouse.
  expect(covers(1115, 40)).toBe(true); // East edge of the upstream river.
  expect(covers(1110, 440)).toBe(true); // River immediately before the bridge rail.
  expect(covers(1190, 720)).toBe(true); // East edge below the bridge.
  expect(covers(720, 1115)).toBe(true); // West edge near the downstream exit.
  expect(covers(1100, 510)).toBe(false); // Stone bridge deck.
  expect(covers(1450, 700)).toBe(false); // Southeast meadow.
  expect(covers(1370, 1000)).toBe(false); // Shallow bank trees and stones.
  expect(covers(1250, 720)).toBe(false); // East riverbank beyond the stones.
});
