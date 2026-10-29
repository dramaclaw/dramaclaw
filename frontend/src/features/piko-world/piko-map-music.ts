// SPDX-License-Identifier: Elastic-2.0
import type { PikoMapId } from "./piko-map-transitions";
const ROOT = "/piko/world/audio/bgm";
export const PIKO_MUSIC_PLAYLISTS = {
  courtyard: [`${ROOT}/welcome-courtyard-01.mp3`],
  courtyardWarm: [`${ROOT}/welcome-courtyard-warm.mp3`],
  lanternWaterfront: [`${ROOT}/lantern-waterfront.mp3`],
  tidalSeas: [`${ROOT}/tidal-seas.mp3`],
  meadowGate: [`${ROOT}/meadow-gate.mp3`],
  forest: [`${ROOT}/whispering-forest.mp3`],
  cloudtopFrostmoon: [`${ROOT}/cloudtop-frostmoon.mp3`],
  amberCanyon: [`${ROOT}/amber-canyon.mp3`],
  skyport: [`${ROOT}/whalesong-skyport.mp3`],
} as const;
const p = PIKO_MUSIC_PLAYLISTS;
const courtyardMapTracks = [...p.courtyard, ...p.courtyardWarm];
// Every association follows the supplied filenames or explicit user confirmation.
export const PIKO_MAP_MUSIC: Record<PikoMapId, readonly string[] | null> = {
  "town-hall-interior": p.courtyardWarm,
  "welcome-courtyard": courtyardMapTracks,
  "artisan-market": courtyardMapTracks,
  "wind-garden-gate": p.meadowGate,
  "lantern-canal-street": p.lanternWaterfront,
  "starlight-dock": p.lanternWaterfront,
  "whispering-meadow": p.meadowGate,
  "cloudtop-slope": p.cloudtopFrostmoon,
  "amber-wilds": p.amberCanyon,
  "starfall-tidal-wetland": p.tidalSeas,
  "startrace-coast": p.tidalSeas,
  "boundless-sea": p.tidalSeas,
  "changfeng-sea": p.tidalSeas,
  "whispering-forest": p.forest,
  "frostmoon-tundra": p.cloudtopFrostmoon,
  "crimson-canyon": p.amberCanyon,
  "whalesong-skyport": p.skyport,
};
