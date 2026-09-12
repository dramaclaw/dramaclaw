// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ANIMAL_SHEETS, animalClipDuration, animalFrameAt, COURTYARD_ANIMALS, createAnimalMotion } from "./courtyard-animals";
import { PikoNavigationSchema } from "./map-package-schema";
import { isPositionNavigable } from "./navigation-geometry";

it("keeps every original sheet in its registered transparent four-cell format", () => {
  for (const sheet of Object.values(ANIMAL_SHEETS)) {
    const png = readFileSync(`public/piko/world/maps/welcome-courtyard/${sheet.src}`);
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]]).toEqual([2048, 2048, 6]);
    expect(sheet.anchors).toHaveLength(4);
    expect(sheet.anchors.every(anchor => anchor.every(value => value > 0 && value < 1024))).toBe(true);
  }
});

it("holds grazing and sleeping poses instead of rapidly cycling through all four frames", () => {
  expect(animalFrameAt("rabbitGraze", 4)).toBe(0);
  expect(animalFrameAt("rabbitGraze", 5.3)).toBe(1);
  expect(animalFrameAt("rabbitGraze", 6.5)).toBe(2);
  expect(animalFrameAt("rabbitGraze", 7.5)).toBe(3);
  expect(animalFrameAt("catIdle", 6)).toBe(2);
  expect(animalFrameAt("catIdle", animalClipDuration("catIdle"))).toBe(0);
});

it("stops the dog for exactly two complete bark cycles, then resumes walking", () => {
  const motion = createAnimalMotion({ id: "dog", kind: "dog", scale: 1, position: { x: 0, y: 0 },
    route: [{ x: 23, y: 0 }, { x: 0, y: 0 }] }, () => 0.5);
  for (let index = 0; index < 11; index++) motion.update(0.1);
  expect(motion.state.clip).toBe("dogBark");
  expect(motion.state.position).toEqual({ x: 23, y: 0 });
  const frames: number[] = [];
  for (let index = 0; index < 23; index++) {
    motion.update(0.1);
    expect(motion.state.position).toEqual({ x: 23, y: 0 });
    if (frames[frames.length - 1] !== motion.state.frame) frames.push(motion.state.frame);
  }
  expect(frames).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  motion.update(0.2);
  expect(motion.state.clip).toBe("dogWalk");
  motion.update(0.1);
  expect(motion.state.position.x).toBeLessThan(23);
  expect(motion.state.facing).toBe(-1);
});

it("keeps all ground habitats and entire roaming segments clear of map collision geometry", () => {
  const navigation = PikoNavigationSchema.parse(JSON.parse(readFileSync(
    "public/piko/world/maps/welcome-courtyard/data/navigation.json", "utf8")));
  for (const placement of COURTYARD_ANIMALS.filter(item => item.kind !== "butterfly")) {
    const points = [placement.position, ...(placement.route ?? []), placement.position];
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1], end = points[index];
      for (let step = 0; step <= 100; step++) {
        for (const offset of [{ x: -7, y: 0 }, { x: 0, y: 0 }, { x: 7, y: 0 },
          { x: 0, y: -4 }, { x: 0, y: 4 }]) {
          const point = { x: start.x + (end.x - start.x) * step / 100 + offset.x,
            y: start.y + (end.y - start.y) * step / 100 + offset.y };
          expect(isPositionNavigable(point, navigation), `${placement.id}: ${JSON.stringify(point)}`).toBe(true);
        }
      }
    }
  }
});

it("never moves a grazing rabbit or sleeping cat, alternates calf actions, and bounds butterfly flight", () => {
  for (const placement of COURTYARD_ANIMALS.filter(item => !item.route)) {
    const motion = createAnimalMotion(placement, () => 0.5);
    const clips = new Set<string>();
    for (let index = 0; index < 1000; index++) {
      motion.update(0.1);
      clips.add(motion.state.clip);
      if (placement.kind === "butterfly") {
        expect(Math.abs(motion.state.position.x - placement.position.x)).toBeLessThanOrEqual(23);
        expect(Math.abs(motion.state.position.y - placement.position.y)).toBeLessThanOrEqual(12);
        expect(motion.state.lift).toBeGreaterThanOrEqual(13);
        expect(motion.state.lift).toBeLessThanOrEqual(23);
      } else expect(motion.state.position).toEqual(placement.position);
    }
    if (placement.kind === "calf") expect(clips).toEqual(new Set(["calfChew", "calfGraze"]));
  }
});

it("stops at blocked terrain instead of letting a walking animal pass through it", () => {
  const motion = createAnimalMotion({ id: "hen", kind: "hen", position: { x: 0, y: 0 }, scale: 1,
    route: [{ x: 10, y: 0 }] }, () => 0.5, () => false);
  motion.update(0.1);
  expect(motion.state.position).toEqual({ x: 0, y: 0 });
  expect(motion.state.clip).toBe("henPeck");
});

it("waits for the grazing loop boundary after a calf's dwell time expires", () => {
  const motion = createAnimalMotion({ id: "calf", kind: "calf", scale: 1, position: { x: 0, y: 0 } }, () => 0);
  // 10 seconds of dwell expires with playback still partway through frame zero.
  for (let index = 0; index < 103; index++) motion.update(0.1);
  expect(motion.state.clip).toBe("calfGraze");
  for (let index = 0; index < 43; index++) motion.update(0.1);
  expect(motion.state.clip).toBe("calfChew");
});
