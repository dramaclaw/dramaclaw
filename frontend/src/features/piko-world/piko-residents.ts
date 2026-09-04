// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const PIKO_RESIDENT_OPTIONS = [
  { id: "m01", src: "/piko/world/residents/resident-m01-front-transparent-v1.png" },
  { id: "m02", src: "/piko/world/residents/resident-m02-front-transparent-v1.png" },
  { id: "m03", src: "/piko/world/residents/resident-m03-front-transparent-v1.png" },
  { id: "m04", src: "/piko/world/residents/resident-m04-front-transparent-v1.png" },
  { id: "m05", src: "/piko/world/residents/resident-m05-front-transparent-v1.png" },
  { id: "f01", src: "/piko/world/residents/resident-f01-front-transparent-v1.png" },
  { id: "f02", src: "/piko/world/residents/resident-f02-front-transparent-v1.png" },
  { id: "f03", src: "/piko/world/residents/resident-f03-front-transparent-v1.png" },
  { id: "f04", src: "/piko/world/residents/resident-f04-front-transparent-v1.png" },
  { id: "f05", src: "/piko/world/residents/resident-f05-front-transparent-v1.png" },
] as const;

export type PikoResidentId = (typeof PIKO_RESIDENT_OPTIONS)[number]["id"];

export const DEFAULT_PIKO_RESIDENT_ID: PikoResidentId = "m01";
export const PIKO_RESIDENT_STORAGE_KEY = "dramaclaw.piko-world.resident-id.v1";

export function resolvePikoResidentId(value: string | null): PikoResidentId {
  return PIKO_RESIDENT_OPTIONS.some((resident) => resident.id === value)
    ? (value as PikoResidentId)
    : DEFAULT_PIKO_RESIDENT_ID;
}

export function readSelectedPikoResidentId(): PikoResidentId {
  if (typeof window === "undefined") return DEFAULT_PIKO_RESIDENT_ID;
  try {
    return resolvePikoResidentId(window.localStorage.getItem(PIKO_RESIDENT_STORAGE_KEY));
  } catch {
    return DEFAULT_PIKO_RESIDENT_ID;
  }
}
