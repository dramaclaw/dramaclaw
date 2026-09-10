// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PikoMapManifestSchema,
  PikoNavigationSchema,
  PikoOcclusionSchema,
  PikoEnvironmentSchema,
  type PikoEnvironment,
  type PikoMapManifest,
  type PikoNavigation,
  type PikoOcclusion,
} from "./map-package-schema";

export const PIKO_WORLD_MAP_ROOT = "/piko/world/maps";

function assertRequestedMapId(requestedMapId: string, receivedMapId: string) {
  if (receivedMapId === requestedMapId) return;
  throw new Error(
    `Piko map package id mismatch: requested ${requestedMapId}, received ${receivedMapId}`,
  );
}

export function pikoMapPackageUrl(mapId: string): string {
  return `${PIKO_WORLD_MAP_ROOT}/${encodeURIComponent(mapId)}/`;
}

export function resolvePikoMapAssetUrl(mapId: string, relativePath: string): string {
  const packageUrl = new URL(pikoMapPackageUrl(mapId), window.location.origin);
  const assetUrl = new URL(relativePath, packageUrl);
  if (!assetUrl.pathname.startsWith(packageUrl.pathname)) {
    throw new Error(`Piko map asset escaped its package: ${relativePath}`);
  }
  return assetUrl.pathname;
}

export async function loadPikoMapManifest(
  mapId: string,
  signal?: AbortSignal,
): Promise<PikoMapManifest> {
  const response = await fetch(`${pikoMapPackageUrl(mapId)}manifest.json`, {
    cache: "no-cache",
    signal,
  });
  if (!response.ok) throw new Error(`Piko map manifest request failed: ${response.status}`);
  const manifest = PikoMapManifestSchema.parse(await response.json());
  assertRequestedMapId(mapId, manifest.mapId);
  return manifest;
}

export async function loadPikoMapNavigation(
  mapId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<PikoNavigation> {
  const response = await fetch(resolvePikoMapAssetUrl(mapId, relativePath), {
    cache: "no-cache",
    signal,
  });
  if (!response.ok) throw new Error(`Piko navigation request failed: ${response.status}`);
  const navigation = PikoNavigationSchema.parse(await response.json());
  assertRequestedMapId(mapId, navigation.mapId);
  return navigation;
}

export async function loadPikoMapOcclusion(
  mapId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<PikoOcclusion> {
  const response = await fetch(resolvePikoMapAssetUrl(mapId, relativePath), {
    cache: "no-cache",
    signal,
  });
  if (!response.ok) throw new Error(`Piko occlusion request failed: ${response.status}`);
  const occlusion = PikoOcclusionSchema.parse(await response.json());
  assertRequestedMapId(mapId, occlusion.mapId);
  return occlusion;
}

export async function loadPikoMapEnvironment(
  mapId: string, relativePath: string, signal?: AbortSignal,
): Promise<PikoEnvironment> {
  const response = await fetch(resolvePikoMapAssetUrl(mapId, relativePath), { cache: "no-cache", signal });
  if (!response.ok) throw new Error(`Piko environment request failed: ${response.status}`);
  const environment = PikoEnvironmentSchema.parse(await response.json());
  assertRequestedMapId(mapId, environment.mapId);
  return environment;
}
