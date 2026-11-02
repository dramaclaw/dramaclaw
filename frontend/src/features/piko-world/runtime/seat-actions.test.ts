// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { Container } from "pixi.js";
import { expect, it } from "vitest";
import { canStand } from "./character-movement";
import { clearWalkSegment, findClickPath } from "./click-path";
import { createBakedActorOcclusion, isResidentHeadOccluded } from "./map-occlusion";
import { PikoInteractionsSchema, PikoNavigationSchema, PikoOcclusionSchema } from "./map-package-schema";
import { pointInPolygon } from "./navigation-geometry";
import { RESIDENT_WORLD_SCALE } from "./resident-actor";
import { pikoSeatAction } from "./seat-actions";
import { SEATED_FOOT_OFFSET, SEATED_POSE } from "./seated-pose";
import { mapPerspectiveScale } from "./map-perspective";

const read = (map: string, name: string) => JSON.parse(readFileSync(`public/piko/world/maps/${map}/data/${name}.json`, "utf8"));

it.each([
  { map: "welcome-courtyard", id: "welcome-east-bench", surface: { x: 1490, y: 518 } },
  { map: "artisan-market", id: "market-west-bench", surface: { x: 560, y: 743 } },
  { map: "artisan-market", id: "market-east-bench", surface: { x: 1330, y: 708 } },
  { map: "town-hall-interior", id: "hall-west-seat", surface: { x: 1572, y: 694 } },
  { map: "town-hall-interior", id: "hall-east-seat", surface: { x: 1682, y: 694 } },
])("reaches $id from map entrances and keeps seated head and legs visible", ({ map, id, surface }) => {
  const navigation = PikoNavigationSchema.parse(read(map, "navigation"));
  const interactions = PikoInteractionsSchema.parse(read(map, "interactions"));
  const occlusion = PikoOcclusionSchema.parse(read(map, "occlusion"));
  const interaction = interactions.interactions.find(item => item.actionId === id)!;
  expect(interaction.kind).toBe("seat");
  expect(pointInPolygon(surface, interaction.trigger.points)).toBe(true);
  const action = pikoSeatAction(interaction.actionId)!;
  expect(canStand(surface, navigation)).toBe(false);
  expect(canStand(action.approach, navigation)).toBe(true);
  expect(pointInPolygon(action.approach, interaction.trigger.points)).toBe(false);
  for (const spawn of navigation.spawnPoints) {
    const path = findClickPath(spawn.position, action.approach, navigation);
    expect(path.length, `${id} from ${spawn.id}`).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(action.approach);
    let previous = spawn.position;
    for (const point of path) {
      expect(clearWalkSegment(previous, point, navigation)).toBe(true);
      previous = point;
    }
  }
  const scale = RESIDENT_WORLD_SCALE * SEATED_POSE.scale * mapPerspectiveScale(map, action.seat.y);
  const depthY = action.depthY ?? action.seat.y + SEATED_FOOT_OFFSET * scale;
  const actor = new Container(); actor.position.copyFrom(action.seat); actor.zIndex = depthY;
  const masking = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 }, () => actor.zIndex);
  try {
    expect(isResidentHeadOccluded(action.seat, occlusion, scale, { depthY, headOffset: SEATED_POSE.headOffset })).toBe(false);
    if (actor.mask) {
      expect(masking.mask.containsPoint({ x: action.seat.x, y: action.seat.y + 30 })).toBe(true);
    }
  } finally { masking.destroy(); actor.destroy(); }
});
