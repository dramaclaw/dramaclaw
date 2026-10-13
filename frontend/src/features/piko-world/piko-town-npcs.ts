// SPDX-License-Identifier: Elastic-2.0
import type { PikoResidentId } from "./piko-residents";
import type { Point } from "./runtime/character-movement";

export type PikoTownNpc = {
  id: string;
  residentId: PikoResidentId;
  mapId: string;
  position: Point;
  idleOffsetMs: number;
  scale?: number;
};

export const PIKO_TOWN_NPCS: readonly PikoTownNpc[] = [
  { id: "town-m01", residentId: "m01",
    mapId: "artisan-market", position: { x: 810, y: 435 }, idleOffsetMs: 0 },
  { id: "town-f01", residentId: "f01",
    mapId: "artisan-market", position: { x: 1230, y: 430 }, idleOffsetMs: 2700 },
  { id: "town-m02", residentId: "m02",
    mapId: "lantern-canal-street", position: { x: 1420, y: 432 }, scale: 0.9, idleOffsetMs: 1300 },
  { id: "hall-bookkeeper", residentId: "f02",
    mapId: "town-hall-interior", position: { x: 1630, y: 425 }, idleOffsetMs: 700 },
];

/** NPC copy lives in the locale files, keyed by NPC id. */
export const townNpcTextKey = (npc: PikoTownNpc, field: "nickname" | "bio" | "greeting") =>
  `pikoWorld.townNpcs.${npc.id}.${field}`;

export const townNpcsForMap = (mapId: string) => PIKO_TOWN_NPCS.filter(npc => npc.mapId === mapId);
export const townNpcIdleSrc = (npc: PikoTownNpc) => `/piko/world/characters/town-npcs-hd-v1/${npc.residentId}-idle.png`;
