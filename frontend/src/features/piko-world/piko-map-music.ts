// SPDX-License-Identifier: Elastic-2.0
import type { PikoMapId } from "./piko-map-transitions";
const ROOT = "/piko/world/audio/bgm";
export const PIKO_MUSIC_PLAYLISTS = {
  courtyard: [`${ROOT}/welcome-courtyard-01.mp3`],
  lanternWaterfront: [`${ROOT}/lantern-waterfront.mp3`],
  tidalSeas: [`${ROOT}/tidal-seas.mp3`],
  openHighlands: [`${ROOT}/open-highlands-v2.mp3`],
  forest: [`${ROOT}/whispering-forest.mp3`],
  tundra: [`${ROOT}/frostmoon-tundra.mp3`],
  canyon: [`${ROOT}/crimson-canyon.mp3`],
  skyport: [`${ROOT}/whalesong-skyport.mp3`],
} as const;
const p = PIKO_MUSIC_PLAYLISTS;
// Every association follows the supplied filenames or explicit user confirmation.
export const PIKO_MAP_MUSIC: Record<PikoMapId, readonly string[] | null> = {
  "welcome-courtyard": p.courtyard,
  "artisan-market": p.courtyard,
  "wind-garden-gate": p.openHighlands,
  "lantern-canal-street": p.lanternWaterfront,
  "starlight-dock": p.lanternWaterfront,
  "whispering-meadow": p.openHighlands,
  "cloudtop-slope": p.openHighlands,
  "amber-wilds": p.openHighlands,
  "starfall-tidal-wetland": p.tidalSeas,
  "startrace-coast": p.tidalSeas,
  "boundless-sea": p.tidalSeas,
  "whispering-forest": p.forest,
  "frostmoon-tundra": p.tundra,
  "crimson-canyon": p.canyon,
  "whalesong-skyport": p.skyport,
};
