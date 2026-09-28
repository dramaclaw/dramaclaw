// SPDX-License-Identifier: Elastic-2.0
import { readFileSync, statSync } from "node:fs";
import { expect, it } from "vitest";
import { zoneVolume } from "./environment-audio";
import { PikoEnvironmentSchema } from "./map-package-schema";

const packageRoot = "public/piko/world/maps/lantern-canal-street/";
const environment = PikoEnvironmentSchema.parse(JSON.parse(readFileSync(
  `${packageRoot}data/environment.json`, "utf8")));

it("keeps river and shallow surf audible in their own parts of canal street", () => {
  const river = environment.audioZones.find(zone => zone.id === "river")!;
  const waves = environment.audioZones.find(zone => zone.id === "sea-waves")!;
  expect(zoneVolume({ x: 1080, y: 520 }, river)).toBeGreaterThan(0.2);
  expect(zoneVolume({ x: 1080, y: 520 }, waves)).toBe(0);
  expect(zoneVolume({ x: 1850, y: 1050 }, waves)).toBeGreaterThan(0.2);
  expect(zoneVolume({ x: 1850, y: 1050 }, river)).toBe(0);
  expect(statSync(`${packageRoot}${river.src}`).size).toBeGreaterThan(0);
  expect(statSync(`${packageRoot}${waves.src}`).size).toBeGreaterThan(0);
});
