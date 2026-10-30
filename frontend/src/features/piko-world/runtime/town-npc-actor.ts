// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import type { PikoTownNpc } from "../piko-town-npcs";
import { PIKO_PLAYER_IDLE_CYCLE_MS, pikoPlayerIdleFrameAt } from "../piko-player";
import { createCharacterActor } from "./character-actor";
import { RESIDENT_WORLD_SCALE } from "./resident-actor";
import { mapPerspectiveScale } from "./map-perspective";

export function createTownNpcActor(sheet: Texture, ticker: Ticker, isActive: () => boolean, npc: PikoTownNpc) {
  const actor = createCharacterActor(sheet, ticker, isActive, {
    label: npc.id, frameSize: 64, frameCount: 3, pivot: { x: 32, y: 57 },
    position: npc.position, scale: RESIDENT_WORLD_SCALE * (npc.scale ?? 1) * mapPerspectiveScale(npc.mapId, npc.position.y),
    shadow: { width: 24, height: 8 }, durationMs: PIKO_PLAYER_IDLE_CYCLE_MS,
    frameAt: ms => pikoPlayerIdleFrameAt((ms + npc.idleOffsetMs) % PIKO_PLAYER_IDLE_CYCLE_MS),
  });
  actor.container.zIndex = npc.position.y;
  return actor;
}
