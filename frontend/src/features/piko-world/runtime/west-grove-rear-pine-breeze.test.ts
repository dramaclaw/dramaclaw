// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  WEST_GROVE_REAR_CLEAN_PATCH_PLACEMENT,
  WEST_GROVE_REAR_CLEAN_INSET,
  WEST_GROVE_REAR_PINE_ATLAS_SRC,
  WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC,
  WEST_GROVE_REAR_PINE_FPS,
  WEST_GROVE_REAR_PINE_FRAME_COUNT,
  WEST_GROVE_REAR_PINE_LOOP_SECONDS,
  WEST_GROVE_REAR_PINE_PHASE_SECONDS,
  WEST_GROVE_REAR_PINE_PLACEMENT,
  WEST_GROVE_REAR_PINE_SEQUENCE,
  westGroveRearPineWindStepAt,
} from "./west-grove-rear-pine-breeze";

it("keeps the rear-grove replacement assets registered to the baked tree", () => {
  const atlas = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_GROVE_REAR_PINE_ATLAS_SRC}`);
  expect([atlas.readUInt32BE(16), atlas.readUInt32BE(20), atlas[25]]).toEqual([1536, 1024, 6]);
  expect(atlas.readUInt32BE(16) % WEST_GROVE_REAR_PINE_FRAME_COUNT).toBe(0);
  const patch = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC}`);
  expect([patch.readUInt32BE(16), patch.readUInt32BE(20), patch[25]]).toEqual([1254, 1254, 2]);
  expect(WEST_GROVE_REAR_PINE_PLACEMENT).toEqual({ x: 119, y: 428, width: 173, height: 273 });
  expect(WEST_GROVE_REAR_CLEAN_PATCH_PLACEMENT).toEqual({ x: 64, y: 420, width: 320, height: 320 });
  expect(WEST_GROVE_REAR_CLEAN_INSET).toBeCloseTo(0.78);
});

it("uses two frames with a distinct but related courtyard wind response", () => {
  expect(WEST_GROVE_REAR_PINE_SEQUENCE).toEqual([0, 1, 1, 0]);
  expect(WEST_GROVE_REAR_PINE_LOOP_SECONDS).toBe(4.1);
  expect(WEST_GROVE_REAR_PINE_PHASE_SECONDS).toBeCloseTo(0.06);
  expect(WEST_GROVE_REAR_PINE_FPS).toBeCloseTo(4 / 4.1);
  expect(westGroveRearPineWindStepAt(1300)).toBe(1);
});

it("reuses the authored root collider and full-tree occluder", () => {
  const navigation = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/navigation.json", "utf8"));
  const root = navigation.colliders.find((item: { id: string }) => item.id === "west-grove-rear-root");
  expect(root.kind).toBe("prop");
  expect(Math.max(...root.points.map((point: { y: number }) => point.y))
    - Math.min(...root.points.map((point: { y: number }) => point.y))).toBeLessThan(20);
  const occlusion = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/occlusion.json", "utf8"));
  const tree = occlusion.occluders.find((item: { id: string }) => item.id === "west-grove-rear-pine");
  expect(tree.depthY).toBe(651);
  expect(tree.outline.length).toBeGreaterThan(50);
});

it("removes the five marked grass clumps from the environment package", () => {
  const environment = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/environment.json", "utf8"));
  const ids = new Set(environment.effects.map((effect: { id: string }) => effect.id));
  expect([
    "grass-breeze-west-pine-north",
    "grass-breeze-east-path-pine",
    "grass-breeze-east-willow-bank",
    "grass-breeze-southeast-grove",
    "grass-breeze-southwest-edge",
  ].every(id => !ids.has(id))).toBe(true);
});
