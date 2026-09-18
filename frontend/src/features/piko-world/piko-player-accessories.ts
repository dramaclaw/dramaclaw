// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import type { Facing } from "./runtime/character-movement";

export const PLAYER_ACCESSORIES = [
  { id: "dark-knight-mask", name: "darkKnightMask", file: "mask-dark-knight", crop: [18,33,93,62], width: 15, x: -1, y: -1, forehead: true, hideFromBack: true, mirrorWithFacing: true },
  { id: "red-bow", name: "redBow", file: "bow-red", crop: [13,24,101,79], width: 10, x: 7, y: 2, forehead: false, hideFromBack: true, mirrorWithFacing: true },
  { id: "diver-goggles", name: "diverGoggles", file: "goggles-diver", crop: [7,43,115,43], width: 20, x: 0, y: 1, forehead: true, hideFromBack: true, mirrorWithFacing: true },
  { id: "bamboo-hat", name: "bambooHat", file: "hat-bamboo", crop: [8,31,112,66], width: 24, x: 0, y: -5, forehead: false, hideFromBack: false, mirrorWithFacing: false },
  { id: "gary-snail", name: "garySnail", file: "snail-gary", crop: [10,11,108,106], width: 12, x: 0, y: -7, forehead: false, hideFromBack: false, mirrorWithFacing: true },
  { id: "wizard-hat", name: "wizardHat", file: "hat-wizard", crop: [9,20,109,89], width: 25, x: 0, y: -9, forehead: false, hideFromBack: false, mirrorWithFacing: true },
] as const;
export type PlayerAccessoryId = typeof PLAYER_ACCESSORIES[number]["id"];
export type PlayerAccessorySelection = PlayerAccessoryId | null;
export const accessoryDefinition = (id: PlayerAccessorySelection) => PLAYER_ACCESSORIES.find(item => item.id === id);
export const accessorySrc = (item: typeof PLAYER_ACCESSORIES[number]) => `/piko/accessories/${item.file}.png`;
export function accessoryPose(id: PlayerAccessoryId, facing: Facing) {
  const item = accessoryDefinition(id)!;
  const side = facing === "west" || facing === "east";
  const direction = facing === "west" ? -1 : 1;
  return { x: side ? direction * (item.forehead ? 5 : item.x ? 6 : 0) + (item.forehead ? item.x : 0) : item.x,
    y: item.y, width: item.width * (side && item.forehead ? 0.55 : 1),
    height: item.width * item.crop[3] / item.crop[2],
    visible: !(facing === "north" && item.hideFromBack), flip: facing === "west" && item.mirrorWithFacing };
}
const storageKey = (owner: string | null) => `dramaclaw.piko-world.accessory.v1:${JSON.stringify(owner)}`;
export function readPlayerAccessory(owner: string | null): PlayerAccessorySelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(owner)) ?? "null");
    return PLAYER_ACCESSORIES.some(item => item.id === value) ? value as PlayerAccessoryId : null;
  } catch { return null; }
}
export function savePlayerAccessory(owner: string | null, id: PlayerAccessorySelection): boolean {
  if (id !== null && !accessoryDefinition(id)) return false;
  return safeLocalStorageSet(storageKey(owner), JSON.stringify(id));
}
export function usePlayerAccessory(owner: string | null) {
  const [state, setState] = useState(() => ({ owner, id: readPlayerAccessory(owner) }));
  if (state.owner !== owner) setState({ owner, id: readPlayerAccessory(owner) });
  return { accessory: state.owner === owner ? state.id : readPlayerAccessory(owner),
    saveAccessory(id: PlayerAccessorySelection) {
      if (!savePlayerAccessory(owner, id)) return false;
      setState({ owner, id }); return true;
    } };
}
