// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

/**
 * Cross-asset reference index ("which beats use this asset").
 *
 * References are served by `GET /projects/{p}/assets/references`, which makes
 * a single pass over the beats table only after the caller names an asset. This
 * used to be derived on the client by fetching every episode's beats and
 * scanning them here — one request per episode, each carrying the full beat
 * payload (sketch/frame/video URLs plus an ffprobe per audio clip) so the FE
 * could read three fields per beat.
 * That cost grew with episode count and is why opening the assets page fired
 * dozens of `beats` requests.
 *
 * `useAssetReferences` requests the beat list only for assets whose usage
 * surface the user actually opened. Asset grids deliberately show no global
 * usage badges: even a compact count response requires scanning every beat on
 * every visit, while the count is neither core workflow data nor an
 * authoritative deletion guard.
 *
 * Reference keys are `"{type}:{id}"`. Id semantics follow the persisted beat
 * contract: identity → `identity_id`, scene → `scene_ref.scene_id`, prop →
 * prop name. Matching happens server-side, at the source of those ids, so a
 * backend rename can no longer silently detach a requested usage list.
 */

export type AssetRefType = "identity" | "scene" | "prop";

export interface AssetRef {
  type: AssetRefType;
  id: string;
}

export interface BeatReference {
  episode: number;
  beatNumber: number;
}

/** Identities + props that share a beat with a given scene. */
export interface SceneCoOccurrence {
  identities: string[];
  props: string[];
}

export interface AssetReferences {
  /** Beat list for one of the requested assets. Empty when not requested. */
  referencesFor: (type: AssetRefType, id: string) => BeatReference[];
  /** Identities/props co-appearing in beats where this scene is used. */
  coOccurrenceForScene: (sceneId: string) => SceneCoOccurrence;
  isLoading: boolean;
}

interface AssetReferencesPayload {
  references: Record<string, { episode: number; beat_number: number }[]>;
  scene_co_occurrence: Record<string, { identities: string[]; props: string[] }>;
}

function refKey(type: AssetRefType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Drop the index after a mutation changes which assets a beat references —
 * beat text/scene edits, manual-shot insert/delete, identity detection, colour
 * binding. Call it alongside the `queryKeys.beats` invalidation those mutations
 * already do; the index lives under its own project-wide key, so invalidating a
 * single episode's beats no longer reaches it.
 *
 * Per-asset detail keys share this project prefix, so one invalidation covers
 * every usage surface that is currently open.
 *
 * Do not treat the 30s staleTime as a safety net: staleTime only marks an entry
 * stale, it never schedules a refetch. A page that stays mounted keeps showing
 * old references indefinitely. Only a remount (or an explicit invalidation)
 * refetches — so every mutation that moves a beat/asset relation must call this.
 */
export function invalidateAssetReferences(
  qc: QueryClient,
  project: string,
): void {
  qc.invalidateQueries({ queryKey: queryKeys.assetReferences(project) });
}

const EMPTY: BeatReference[] = [];
const EMPTY_CO: SceneCoOccurrence = { identities: [], props: [] };

/**
 * Beat lists for a specific set of assets — pass only what is rendered.
 *
 * `refs` may be rebuilt on every render; it is reduced to a sorted, deduped
 * signature so an unchanged set is one cache entry regardless of array identity
 * or ordering. An empty set issues no request.
 */
export function useAssetReferences(
  project: string,
  refs: AssetRef[],
): AssetReferences {
  // JSON, not `.join(" ")`. Asset ids are user-authored names and legitimately
  // contain spaces (`prop:red wine glass`, `scene:New York Office`), so any
  // unescaped separator round-trips into different ids than went in — silently,
  // as an empty beat list rather than an error. JSON.stringify of the sorted
  // array is both a stable cache signature and an exact inverse.
  const signature = JSON.stringify(
    [
      ...new Set(refs.filter((r) => r.id).map((r) => refKey(r.type, r.id))),
    ].sort(),
  );

  const keys = useMemo(() => JSON.parse(signature) as string[], [signature]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.assetReferenceDetail(project, signature),
    queryFn: ({ signal }) => {
      const searchParams = new URLSearchParams();
      for (const key of keys) searchParams.append("ids", key);
      return api
        .get(p`api/v1/projects/${project}/assets/references`, {
          signal,
          searchParams,
        })
        .json<OkResponse<AssetReferencesPayload>>();
    },
    enabled: !!project && keys.length > 0,
  });

  const { map, sceneCo } = useMemo(() => {
    const acc = new Map<string, BeatReference[]>();
    const co = new Map<string, SceneCoOccurrence>();
    for (const [key, list] of Object.entries(data?.data?.references ?? {})) {
      acc.set(
        key,
        list.map((ref) => ({
          episode: ref.episode,
          beatNumber: ref.beat_number,
        })),
      );
    }
    for (const [sceneId, bucket] of Object.entries(
      data?.data?.scene_co_occurrence ?? {},
    )) {
      co.set(sceneId, {
        identities: bucket.identities ?? [],
        props: bucket.props ?? [],
      });
    }
    return { map: acc, sceneCo: co };
  }, [data]);

  return useMemo(
    () => ({
      referencesFor: (type, id) => map.get(refKey(type, id)) ?? EMPTY,
      coOccurrenceForScene: (sceneId) => sceneCo.get(sceneId) ?? EMPTY_CO,
      isLoading: keys.length > 0 && isLoading,
    }),
    [map, sceneCo, isLoading, keys.length],
  );
}
