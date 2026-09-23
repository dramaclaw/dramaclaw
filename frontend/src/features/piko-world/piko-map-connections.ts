// SPDX-License-Identifier: Elastic-2.0
import type { PikoMapId } from "./piko-map-transitions";
import type { PikoPoint } from "./runtime/navigation-geometry";

/** Ground marker positions; navigation owns the paired trigger and arrival. */
export interface PikoExitMarkerDefinition {
  exitId: string;
  targetMapId: PikoMapId;
  position: PikoPoint;
  direction: "north" | "east" | "south" | "west";
  /** Explicit transport interaction instead of automatic walking transfer. */
  action?: "sail" | "returnShore" | "ascend" | "returnSlope";
  /** Local vertical adjustment for labels near the map's top edge. */
  labelOffsetY?: number;
}

export const COURTYARD_EXIT_MARKER: PikoExitMarkerDefinition = {
  exitId: "to-artisan-market",
  targetMapId: "artisan-market",
  position: { x: 65, y: 270 },
  direction: "west",
};

export const MAP_EXIT_MARKERS: Record<PikoMapId, readonly PikoExitMarkerDefinition[]> = {
  "welcome-courtyard": [
    COURTYARD_EXIT_MARKER,
    { exitId: "to-lantern-canal-street", targetMapId: "lantern-canal-street",
      position: { x: 1995, y: 505 }, direction: "east" },
    { exitId: "to-cloudtop-slope", targetMapId: "cloudtop-slope",
      position: { x: 940, y: 40 }, direction: "east", labelOffsetY: 12 },
    { exitId: "to-amber-wilds", targetMapId: "amber-wilds",
      position: { x: 1060, y: 1110 }, direction: "south" },
  ],
  "artisan-market": [
    { exitId: "to-welcome-courtyard", targetMapId: "welcome-courtyard",
      position: { x: 1990, y: 550 }, direction: "east" },
    { exitId: "to-wind-garden-gate", targetMapId: "wind-garden-gate",
      position: { x: 65, y: 525 }, direction: "west" },
  ],
  "wind-garden-gate": [
    { exitId: "to-artisan-market", targetMapId: "artisan-market",
      position: { x: 1985, y: 635 }, direction: "east" },
    { exitId: "to-whispering-meadow", targetMapId: "whispering-meadow",
      position: { x: 610, y: 280 }, direction: "north" },
  ],
  "lantern-canal-street": [
    { exitId: "to-welcome-courtyard", targetMapId: "welcome-courtyard",
      position: { x: 165, y: 435 }, direction: "north" },
    { exitId: "to-starlight-dock", targetMapId: "starlight-dock",
      position: { x: 1990, y: 565 }, direction: "east" },
  ],
  "starlight-dock": [
    { exitId: "to-lantern-canal-street", targetMapId: "lantern-canal-street",
      position: { x: 65, y: 510 }, direction: "west" },
    { exitId: "to-starfall-tidal-wetland", targetMapId: "starfall-tidal-wetland",
      position: { x: 700, y: 1065 }, direction: "south" },
  ],
  "whispering-meadow": [
    { exitId: "to-wind-garden-gate", targetMapId: "wind-garden-gate",
      position: { x: 1980, y: 750 }, direction: "east" },
    { exitId: "to-whispering-forest", targetMapId: "whispering-forest",
      position: { x: 230, y: 300 }, direction: "west" },
  ],
  "whispering-forest": [
    { exitId: "to-whispering-meadow", targetMapId: "whispering-meadow",
      position: { x: 1970, y: 775 }, direction: "east" },
  ],
  "cloudtop-slope": [
    { exitId: "to-welcome-courtyard", targetMapId: "welcome-courtyard",
      position: { x: 1000, y: 1100 }, direction: "south" },
    { exitId: "to-frostmoon-tundra", targetMapId: "frostmoon-tundra",
      position: { x: 1090, y: 70 }, direction: "north" },
    { exitId: "to-whalesong-skyport", targetMapId: "whalesong-skyport",
      position: { x: 1200, y: 330 }, direction: "north", action: "ascend" },
  ],
  "frostmoon-tundra": [
    { exitId: "to-cloudtop-slope", targetMapId: "cloudtop-slope",
      position: { x: 980, y: 1090 }, direction: "south" },
  ],
  "amber-wilds": [
    { exitId: "to-welcome-courtyard", targetMapId: "welcome-courtyard",
      position: { x: 600, y: 130 }, direction: "north" },
    { exitId: "to-crimson-canyon", targetMapId: "crimson-canyon",
      position: { x: 1400, y: 1100 }, direction: "south" },
  ],
  "crimson-canyon": [
    { exitId: "to-amber-wilds", targetMapId: "amber-wilds",
      position: { x: 530, y: 70 }, direction: "north" },
    { exitId: "to-startrace-coast", targetMapId: "startrace-coast",
      position: { x: 1705, y: 835 }, direction: "east" },
  ],
  "startrace-coast": [
    { exitId: "to-crimson-canyon", targetMapId: "crimson-canyon",
      position: { x: 310, y: 865 }, direction: "west" },
    { exitId: "to-starfall-tidal-wetland", targetMapId: "starfall-tidal-wetland",
      position: { x: 590, y: 75 }, direction: "north" },
    { exitId: "to-boundless-sea", targetMapId: "boundless-sea",
      position: { x: 1000, y: 435 }, direction: "south", action: "sail" },
  ],
  "starfall-tidal-wetland": [
    { exitId: "to-starlight-dock", targetMapId: "starlight-dock",
      position: { x: 135, y: 583 }, direction: "west" },
    { exitId: "to-startrace-coast", targetMapId: "startrace-coast",
      position: { x: 1730, y: 970 }, direction: "south" },
  ],
  "changfeng-sea": [
    { exitId: "to-boundless-sea", targetMapId: "boundless-sea",
      position: { x: 150, y: 1040 }, direction: "west" },
  ],
  "boundless-sea": [
    { exitId: "to-changfeng-sea", targetMapId: "changfeng-sea",
      position: { x: 1940, y: 130 }, direction: "east" },
    { exitId: "to-startrace-coast", targetMapId: "startrace-coast",
      position: { x: 185, y: 880 }, direction: "west", action: "returnShore" },
  ],
  "whalesong-skyport": [
    { exitId: "to-cloudtop-slope", targetMapId: "cloudtop-slope",
      position: { x: 275, y: 785 }, direction: "west", action: "returnSlope" },
  ],
};
