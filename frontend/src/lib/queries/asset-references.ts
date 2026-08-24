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
 * Served by `GET /projects/{p}/assets/references` in one request: the backend
 * makes a single pass over the beats table and returns only the reverse index.
 * This used to be derived on the client by fetching every episode's beats and
 * scanning them here — one request per episode, each carrying the full beat
 * payload (sketch/frame/video URLs plus an ffprobe per audio clip) so the FE
 * could read three fields per beat. That cost grew with episode count and is
 * why opening the assets page fired dozens of `beats` requests.
 *
 * Reference keys are `"{type}:{id}"`. Id semantics follow the persisted beat
 * contract: identity → `identity_id`, scene → `scene_ref.scene_id`, prop →
 * prop name. Matching now happens server-side, at the source of those ids, so
 * a backend rename can no longer silently zero out every usage count.
 */

export type AssetRefType = "identity" | "scene" | "prop";

export interface BeatReference {
  episode: number;
  beatNumber: number;
}

/** Identities + props that share a beat with a given scene. */
export interface SceneCoOccurrence {
  identities: string[];
  props: string[];
}

export interface AssetReferenceIndex {
  /** Lookup references for one asset. Empty array when none / still loading. */
  referencesFor: (type: AssetRefType, id: string) => BeatReference[];
  /** Convenience: usage count for one asset. */
  countFor: (type: AssetRefType, id: string) => number;
  /** Identities/props co-appearing in beats where this scene is used. */
  coOccurrenceForScene: (sceneId: string) => SceneCoOccurrence;
  /** True while the index is still loading. */
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
 * binding. Call it alongside the `queryKeys.beats` invalidation those
 * mutations already do; the index lives under its own project-wide key, so
 * invalidating a single episode's beats no longer reaches it.
 *
 * Missing a call site here degrades to stale usage counts, not wrong data: the
 * index inherits the default 30s staleTime and the assets page is its own
 * route, so returning to it refetches. Prefer adding the call anyway.
 */
export function invalidateAssetReferences(
  qc: QueryClient,
  project: string,
): void {
  qc.invalidateQueries({ queryKey: queryKeys.assetReferences(project) });
}

const EMPTY: BeatReference[] = [];
const EMPTY_CO: SceneCoOccurrence = { identities: [], props: [] };

export function useAssetReferenceIndex(project: string): AssetReferenceIndex {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.assetReferences(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/assets/references`, { signal })
        .json<OkResponse<AssetReferencesPayload>>(),
    enabled: !!project,
  });

  const { map, sceneCo } = useMemo(() => {
    const acc = new Map<string, BeatReference[]>();
    const co = new Map<string, SceneCoOccurrence>();
    for (const [key, refs] of Object.entries(data?.data?.references ?? {})) {
      acc.set(
        key,
        refs.map((ref) => ({ episode: ref.episode, beatNumber: ref.beat_number })),
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
      countFor: (type, id) => map.get(refKey(type, id))?.length ?? 0,
      coOccurrenceForScene: (sceneId) => sceneCo.get(sceneId) ?? EMPTY_CO,
      isLoading,
    }),
    [map, sceneCo, isLoading],
  );
}
