// SPDX-License-Identifier: Elastic-2.0
import { MAP_EXIT_MARKERS, type PikoExitMarkerDefinition } from "../piko-map-connections";
import { isPikoMapId, type PikoMapId } from "../piko-map-transitions";
import { canStand } from "./character-movement";
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";
import type { PikoNavigation } from "./map-package-schema";
import { loadPikoMapManifest, loadPikoMapNavigation, loadPikoMapOcclusion, loadPikoMapEnvironment } from "./map-package-loader";

export type MapLocation = { mapId: PikoMapId; spawnId?: string };
export type MapExit = PikoNavigation["exits"][number] & { action?: PikoExitMarkerDefinition["action"] };
export function enabledMapExits(navigation: PikoNavigation): MapExit[] {
  if (!isPikoMapId(navigation.mapId)) return [];
  const markers = MAP_EXIT_MARKERS[navigation.mapId] ?? [];
  return navigation.exits.flatMap(exit => {
    const marker = markers.find(marker => exit.id === marker.exitId && exit.targetMapId === marker.targetMapId);
    return marker ? [{ ...exit, ...(marker.action ? { action: marker.action } : {}) }] : [];
  });
}

export const TRANSPORT_INTERACTION_DISTANCE = 140;
export function canActivateTransport(marker: PikoExitMarkerDefinition, position: PikoPoint, active: boolean) {
  return active && Boolean(marker.action)
    && Math.hypot(position.x - marker.position.x, position.y - marker.position.y)
      <= (marker.interactionDistance ?? TRANSPORT_INTERACTION_DISTANCE);
}

/** A held/re-entered trigger cannot submit another transfer until the player leaves it. */
export function createExitGate(exits: readonly MapExit[]) {
  let occupied: string | undefined;
  return (position: PikoPoint, active: boolean) => {
    const exit = exits.find(candidate => !candidate.action && pointInPolygon(position, candidate.trigger.points));
    if (!exit) occupied = undefined;
    if (!active || !exit || occupied === exit.id) return undefined;
    occupied = exit.id;
    return exit;
  };
}

export async function prepareMapTravel(source: PikoMapId, exit: MapExit, signal: AbortSignal) {
  if (!isPikoMapId(exit.targetMapId)) throw new Error("Unknown destination");
  const target = exit.targetMapId;
  if (!MAP_EXIT_MARKERS[source]?.some(marker => marker.exitId === exit.id && marker.targetMapId === target)) {
    throw new Error("This connection is not open");
  }
  const manifest = await loadPikoMapManifest(target, signal);
  const [navigation] = await Promise.all([
    loadPikoMapNavigation(target, manifest.data.navigation, signal),
    loadPikoMapOcclusion(target, manifest.data.occlusion, signal),
    loadPikoMapEnvironment(target, manifest.data.environment, signal),
  ]);
  const spawn = navigation.spawnPoints.find(point => point.id === exit.targetSpawnId);
  const back = enabledMapExits(navigation).find(candidate => candidate.targetMapId === source);
  if (!spawn || !canStand(spawn.position, navigation) || !back
    || navigation.exits.some(candidate => pointInPolygon(spawn.position, candidate.trigger.points))) {
    throw new Error("Destination requires a safe arrival and return connection");
  }
  return { destination: { mapId: target, spawnId: spawn.id } satisfies MapLocation,
    fallback: { mapId: source, spawnId: back.targetSpawnId } satisfies MapLocation };
}
