// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  WEST_HALL_PINE_ATLAS_SRC,
  WEST_HALL_PINE_ATLAS_COLUMNS,
  WEST_HALL_PINE_CLEAN_PLATE_SRC,
  WEST_HALL_PINE_CLEAN_PLATE_OUTLINE,
  WEST_HALL_PINE_FPS,
  WEST_HALL_PINE_FRAME_COUNT,
  WEST_HALL_PINE_LOOP_SECONDS,
  WEST_HALL_PINE_PHASE_SECONDS,
  WEST_HALL_PINE_PLACEMENT,
  WEST_HALL_PINE_SEQUENCE,
  westHallPineWindStepAt,
} from "./west-hall-pine-breeze";

it("keeps the west-hall pine assets and placement stable", () => {
  const atlas = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_HALL_PINE_ATLAS_SRC}`);
  expect([atlas.readUInt32BE(16), atlas.readUInt32BE(20), atlas[25]]).toEqual([2049, 768, 6]);
  expect(atlas.readUInt32BE(16) % WEST_HALL_PINE_ATLAS_COLUMNS).toBe(0);
  expect(WEST_HALL_PINE_FRAME_COUNT).toBeLessThan(WEST_HALL_PINE_ATLAS_COLUMNS);
  const plate = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_HALL_PINE_CLEAN_PLATE_SRC}`);
  expect([plate.readUInt32BE(16), plate.readUInt32BE(20), plate[25]]).toEqual([1672, 941, 2]);
  expect(WEST_HALL_PINE_PLACEMENT).toEqual({ x: 499, y: 186, width: 150, height: 256 });
  expect(WEST_HALL_PINE_CLEAN_PLATE_OUTLINE.length).toBeGreaterThanOrEqual(20);
});

it("follows the shared gust using only the first two poses", () => {
  expect(WEST_HALL_PINE_SEQUENCE).toEqual([0, 1, 1, 0]);
  expect(WEST_HALL_PINE_LOOP_SECONDS).toBe(4.4);
  expect(WEST_HALL_PINE_PHASE_SECONDS).toBeLessThan(0);
  expect(WEST_HALL_PINE_FPS).toBeCloseTo(4 / 4.4);
  expect(westHallPineWindStepAt(1300)).toBe(1);
});

it("separates the root collider from the full-tree occlusion layer", () => {
  const navigation = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/navigation.json", "utf8"));
  const root = navigation.colliders.find((item: { id: string }) => item.id === "west-hall-pine-root");
  expect(root.kind).toBe("vegetation");
  expect(Math.max(...root.points.map((point: { x: number }) => point.x))
    - Math.min(...root.points.map((point: { x: number }) => point.x))).toBeLessThan(40);
  const occlusion = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/occlusion.json", "utf8"));
  const tree = occlusion.occluders.find((item: { id: string }) => item.id === "west-hall-pine");
  expect(tree.depthY).toBe(410);
  expect(tree.outline.length).toBeGreaterThan(30);
});
