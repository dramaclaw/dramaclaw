// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  EAST_WILLOW_CANOPY_LOOP_SECONDS,
  EAST_WILLOW_CANOPY_PHASE_SECONDS,
  EAST_WILLOW_CANOPY_PLACEMENT,
  WEST_GARDEN_CANOPY_ATLAS_COLUMNS,
  WEST_GARDEN_CANOPY_ATLAS_ROWS,
  WEST_GARDEN_CANOPY_ATLAS_SRC,
  WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC,
  WEST_GARDEN_CANOPY_FPS,
  WEST_GARDEN_CANOPY_FRAME_COUNT,
  WEST_GARDEN_CANOPY_LOOP_SECONDS,
  WEST_GARDEN_CANOPY_PHASE_SECONDS,
  WEST_GARDEN_CANOPY_PLACEMENT,
  WEST_GARDEN_CANOPY_SEQUENCE,
  eastWillowCanopyWindStepAt,
  westGardenCanopyWindStepAt,
} from "./west-garden-canopy-breeze";

it("keeps the west-garden canopy atlas contract internally consistent", () => {
  const png = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_GARDEN_CANOPY_ATLAS_SRC}`);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(2172);
  expect(png.readUInt32BE(20)).toBe(724);
  expect(png[25]).toBe(6); // PNG color type 6: RGBA.
  expect(WEST_GARDEN_CANOPY_FRAME_COUNT).toBe(2);
  expect(WEST_GARDEN_CANOPY_FRAME_COUNT).toBeLessThan(
    WEST_GARDEN_CANOPY_ATLAS_COLUMNS * WEST_GARDEN_CANOPY_ATLAS_ROWS,
  );
  expect(WEST_GARDEN_CANOPY_PLACEMENT).toEqual({ x: 478, y: 523, width: 188, height: 149 });
  const plate = readFileSync(`public/piko/world/maps/welcome-courtyard/${WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC}`);
  expect(plate.subarray(1, 4).toString()).toBe("PNG");
  expect(plate.readUInt32BE(16)).toBe(1672);
  expect(plate.readUInt32BE(20)).toBe(941);
  expect(plate[25]).toBe(2); // PNG color type 2: RGB.
});

it("copies the shrub to the east lawn while keeping the original in place", () => {
  expect(WEST_GARDEN_CANOPY_PLACEMENT).toEqual({ x: 478, y: 523, width: 188, height: 149 });
  expect(EAST_WILLOW_CANOPY_PLACEMENT).toEqual({ x: 1759, y: 685, width: 152, height: 121 });
  expect(EAST_WILLOW_CANOPY_LOOP_SECONDS).toBe(4.9);
  expect(EAST_WILLOW_CANOPY_PHASE_SECONDS).toBeCloseTo(0.08);
  expect(eastWillowCanopyWindStepAt(1050)).not.toBe(westGardenCanopyWindStepAt(1050));

  const occlusion = JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/occlusion.json", "utf8"));
  const shrub = occlusion.occluders.find((item: { id: string }) => item.id === "east-willow-canopy");
  expect(shrub.depthY).toBe(800);
});

it("follows the shared gust early using only the first two poses", () => {
  expect(WEST_GARDEN_CANOPY_SEQUENCE).toEqual([0, 1, 1, 0]);
  expect(WEST_GARDEN_CANOPY_LOOP_SECONDS).toBe(3.8);
  expect(WEST_GARDEN_CANOPY_PHASE_SECONDS).toBeGreaterThan(0);
  expect(WEST_GARDEN_CANOPY_FPS).toBeCloseTo(4 / 3.8);
  expect(westGardenCanopyWindStepAt(1300)).toBe(1);
});
