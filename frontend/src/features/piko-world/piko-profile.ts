// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";

export type PikoProfile = { nickname: string; bio: string };
export const PIKO_NICKNAME_MAX = 16;
export const PIKO_BIO_MAX = 160;
const profileKey = (username: string | null) => `dramaclaw.piko-world.profile.v1:${JSON.stringify(username)}`;

export function normalizePikoProfile(profile: PikoProfile): PikoProfile {
  return { nickname: profile.nickname.replace(/\s+/gu, " ").trim(), bio: profile.bio.trim() };
}

export function isValidPikoProfile(profile: PikoProfile): boolean {
  return profile.nickname.length > 0 && Array.from(profile.nickname).length <= PIKO_NICKNAME_MAX
    && Array.from(profile.bio).length <= PIKO_BIO_MAX;
}

export function readPikoProfile(username: string | null): PikoProfile {
  const fallback = { nickname: username ?? "", bio: "" };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(profileKey(username)) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const data = value as Record<string, unknown>;
    if (typeof data.nickname !== "string" || typeof data.bio !== "string") return fallback;
    const profile = normalizePikoProfile({ nickname: data.nickname, bio: data.bio });
    return isValidPikoProfile(profile) ? profile : fallback;
  } catch {
    return fallback;
  }
}

/** Account-scoped profile cache; offline previews require successful persistence. */
export function usePikoProfile(username: string | null) {
  const [state, setState] = useState(() => ({ owner: username, profile: readPikoProfile(username) }));
  // Reconcile on account change before rendering children, without leaking the old nickname.
  if (state.owner !== username) setState({ owner: username, profile: readPikoProfile(username) });
  const profile = state.owner === username ? state.profile : readPikoProfile(username);
  const applyProfile = (draft: PikoProfile, persistenceRequired: boolean): boolean => {
    const next = normalizePikoProfile(draft);
    if (!isValidPikoProfile(next)) return false;
    const persisted = safeLocalStorageSet(profileKey(username), JSON.stringify(next));
    if (persistenceRequired && !persisted) return false;
    setState({ owner: username, profile: next });
    return true;
  };
  return {
    profile,
    saveProfile: (draft: PikoProfile) => applyProfile(draft, true),
    // A successful server write must not be reported as failed because the cache is full.
    cacheProfile: (draft: PikoProfile) => applyProfile(draft, false),
  };
}
