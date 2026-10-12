// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const MAP_TITLE_ROOT = "/piko/world/ui/map-titles";

export const PIKO_MAP_TRANSITIONS = {
  "town-hall-interior": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-town-hall-interior-v1.png`,
  },
  "welcome-courtyard": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-welcome-courtyard-v1.png`,
  },
  "artisan-market": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-artisan-market-v1.png`,
  },
  "lantern-canal-street": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-lantern-canal-street-v1.png`,
  },
  "wind-garden-gate": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-wind-garden-gate-v1.png`,
  },
  "starlight-dock": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-starlight-dock-v1.png`,
  },
  "whispering-meadow": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whispering-meadow-v1.png`,
  },
  "starfall-tidal-wetland": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-starfall-tidal-wetland-v1.png`,
  },
  "cloudtop-slope": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-cloudtop-slope-v1.png`,
  },
  "amber-wilds": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-amber-wilds-v1.png`,
  },
  "startrace-coast": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-startrace-coast-v1.png`,
  },
  "changfeng-sea": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-changfeng-sea-v1.png`,
  },
  "boundless-sea": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-boundless-sea-v1.png`,
  },
  "whispering-forest": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whispering-forest-v1.png`,
  },
  "frostmoon-tundra": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-frostmoon-tundra-v1.png`,
  },
  "crimson-canyon": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-crimson-canyon-v1.png`,
  },
  "whalesong-skyport": {
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whalesong-skyport-v1.png`,
  },
} as const;

export type PikoMapId = keyof typeof PIKO_MAP_TRANSITIONS;

/** Map copy lives in the locale files, keyed by map id. */
export const pikoMapTitleKey = (mapId: PikoMapId) => `pikoWorld.maps.${mapId}.title`;
export const pikoMapSubtitleKey = (mapId: PikoMapId) => `pikoWorld.maps.${mapId}.subtitle`;

export function isPikoMapId(mapId: string): mapId is PikoMapId {
  return Object.prototype.hasOwnProperty.call(PIKO_MAP_TRANSITIONS, mapId);
}
