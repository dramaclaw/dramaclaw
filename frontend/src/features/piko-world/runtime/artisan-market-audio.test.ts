// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import environment from "../../../../public/piko/world/maps/artisan-market/data/environment.json";
import { ARTISAN_MARKET_ANIMALS } from "./courtyard-animals";
import { DOG_MAPS } from "./dog-world-routes";
import { zoneVolume } from "./environment-audio";

it("keeps market ambience in the groves while leaving the workbench plaza clear", () => {
  const wind = environment.audioZones.find(zone => zone.id === "leaves")!;
  const insects = environment.audioZones.find(zone => zone.id === "insects")!;
  const birds = environment.audioZones.find(zone => zone.id === "birds")!;
  const pockets = [insects.region, ...(insects.additionalRegions ?? [])];

  expect(pockets.length).toBeGreaterThanOrEqual(7);
  expect([wind.region, ...(wind.additionalRegions ?? [])].length).toBeGreaterThanOrEqual(6);
  for (const pocket of pockets) {
    const center = {
      x: pocket.points.reduce((sum, point) => sum + point.x, 0) / pocket.points.length,
      y: pocket.points.reduce((sum, point) => sum + point.y, 0) / pocket.points.length,
    };
    expect(zoneVolume(center, insects), pocket.id).toBe(insects.volume);
    expect(zoneVolume(center, wind), pocket.id).toBeGreaterThan(0);
  }

  for (const point of [{ x: 1000, y: 580 }, { x: 900, y: 700 }, { x: 1100, y: 650 }]) {
    expect(zoneVolume(point, insects)).toBe(0);
    expect(zoneVolume(point, wind)).toBe(0);
    expect(zoneVolume(point, birds)).toBe(birds.volume);
  }
});

it("retains position based calls for the market's visible hens and roaming dog", () => {
  expect(DOG_MAPS).toContain("artisan-market");
  const hens = ARTISAN_MARKET_ANIMALS.filter(animal => animal.kind === "hen");
  expect(hens.length).toBeGreaterThanOrEqual(6);
  expect(hens.some(hen => hen.position.x < 800)).toBe(true);
  expect(hens.some(hen => hen.position.x > 1500)).toBe(true);
});
