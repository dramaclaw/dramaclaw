// SPDX-License-Identifier: Elastic-2.0
export const PIKO_OST_TRACKS = [
  { key: "courtyard", duration: 151 },
  { key: "courtyardWarm", duration: 180 },
  { key: "lanternWaterfront", duration: 179 },
  { key: "tidalSeas", duration: 181 },
  { key: "meadowGate", duration: 179 },
  { key: "forest", duration: 180 },
  { key: "cloudtopFrostmoon", duration: 180 },
  { key: "amberCanyon", duration: 181 },
  { key: "skyport", duration: 159 },
] as const;

/** Track titles live in the locale files, keyed by track key. */
export const pikoOstTitleKey = (key: (typeof PIKO_OST_TRACKS)[number]["key"]) => `pikoWorld.music.tracks.${key}`;
