// SPDX-License-Identifier: Elastic-2.0
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import { isValidPikoProfile, normalizePikoProfile } from "./piko-profile";

export type PikoPlayerGender = "male" | "female";
export const PIKO_MALE_PLAYER_MOTION_SRC = "/piko/world/characters/player-male-motion-v5.png";
export const PIKO_FEMALE_PLAYER_MOTION_SRC = "/piko/world/characters/player-female-motion-v6.png";
export const PIKO_PLAYER_MOTION_COLUMNS = 6;
export const PIKO_PLAYER_WALK_COLUMNS = [3, 4, 5, 4] as const;
export const PIKO_PLAYER_SEATED_ART = {
  male: { base: "/piko/world/characters/player-male-sit-front-v2.png", idle: "/piko/world/characters/player-male-sit-idle-v2.png" },
  female: { base: "/piko/world/characters/player-female-sit-front-v2.png", idle: "/piko/world/characters/player-female-sit-idle-v2.png" },
} as const;
// Shared 2048px maps: a typical 1800px crossing takes about 11.7 seconds.
export const PIKO_PLAYER_SPEED = 153.9;
export const PIKO_PLAYER_GAIT_CYCLE_SOURCE_PIXELS = 56;
export const PIKO_PLAYER_IDLE_CYCLE_MS = 8000;
const PLAYER_IDLE_TIMELINE = [
  { frame: 0, durationMs: 1800 },
  { frame: 2, durationMs: 180 },
  { frame: 0, durationMs: 820 },
  { frame: 1, durationMs: 1600 },
  { frame: 0, durationMs: 1700 },
  { frame: 2, durationMs: 180 },
  { frame: 0, durationMs: 1720 },
] as const;
export function pikoPlayerIdleFrameAt(elapsedMs: number, facing?: string): number {
  let remaining = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) % PIKO_PLAYER_IDLE_CYCLE_MS : 0;
  for (const step of PLAYER_IDLE_TIMELINE) {
    if (remaining < step.durationMs) return facing === "north" && step.frame === 2 ? 0 : step.frame;
    remaining -= step.durationMs;
  }
  return 0;
}
export const PIKO_PLAYER_ART = {
  male: { src: "/piko/world/onboarding/player-male-v2.png", baseline: 1367, top: 99, height: 1476 },
  female: { src: "/piko/world/onboarding/player-female-v2.png", baseline: 1270, top: 0, height: 1270 },
} as const;
export const PIKO_ONBOARDING_BACKGROUND = "/piko/world/onboarding/welcome-hillside-v3.png";
export const PIKO_INTRO_VIDEO = "/piko/world/onboarding/intro-v1.mp4";
export type PikoPlayer = { version: 1; gender: PikoPlayerGender; nickname: string };
const key = (owner: string | null) => `dramaclaw.piko-world.player.v1:${JSON.stringify(owner)}`;
export function readPikoPlayer(owner: string | null): PikoPlayer | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(owner)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const p = value as Record<string, unknown>;
    if (p.version !== 1 || (p.gender !== "male" && p.gender !== "female") || typeof p.nickname !== "string") return null;
    const profile = normalizePikoProfile({ nickname: p.nickname, bio: "" });
    return isValidPikoProfile(profile) ? { version: 1, gender: p.gender, nickname: profile.nickname } : null;
  } catch { return null; }
}
export function savePikoPlayer(owner: string | null, gender: PikoPlayerGender, nickname: string): boolean {
  const profile = normalizePikoProfile({ nickname, bio: "" });
  if ((gender !== "male" && gender !== "female") || !isValidPikoProfile(profile)) return false;
  return safeLocalStorageSet(key(owner), JSON.stringify({ version: 1, gender, nickname: profile.nickname }));
}

/** Temporary development replay: clear only this account's Piko creation state. */
export function clearPikoPlayer(owner: string | null) {
  try { localStorage.removeItem(key(owner)); localStorage.removeItem(`dramaclaw.piko-world.profile.v1:${JSON.stringify(owner)}`); } catch { /* Replay still starts with an empty in-memory form. */ }
}
