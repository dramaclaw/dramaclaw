// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { PanoViewerManifest } from "@/features/viewer-kit/pano/panoManifest";
import type { DirectorStageManifest } from "@/features/viewer-kit/three-d/directorManifest";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ApiResponse, ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { Beat } from "@/types/episode";

// Mirrors backend `PoolImage` (novelvideo/models.py) plus the route-injected
// `cell_url` / `grid_url` / `stale` fields from `GET /grids`.
export interface PoolImage {
  id: string;
  type: "render" | "sketch";
  mode: string;
  grid_index: number;
  cell_index: number;
  row: number;
  col: number;
  original_beat: number;
  cell_url: string;
  grid_url: string;
  cell_path?: string | null;
  grid_path: string;
  generated_at?: string | null;
  stale: boolean;
  beat_content_hash?: string | null;
}

export interface GridsData {
  episode: number;
  modes: Record<string, unknown>;
  images: PoolImage[];
  // beat_number (string) → pool_id of the assigned image.
  beat_assignments: Record<string, string>;
}

// Backend returns `data: null` when no pool exists yet.
export type GridsResponse = OkResponse<GridsData | null>;

export interface SketchGenerateParams {
  grid_index?: number;
  style?: string | null;
  model?: string;
  sketch_scene_grouping?: boolean;
  aspect_ratio?: "2:3" | "16:9";
  image_generation_selection?: string;
}

export interface RenderGenerationSettings {
  imageGenerationSelection?: string;
  sketchAspectPadding?: boolean;
}

function renderGenerationSettingsJson(settings: RenderGenerationSettings) {
  return {
    ...(settings.imageGenerationSelection
      ? { image_generation_selection: settings.imageGenerationSelection }
      : {}),
    ...(settings.sketchAspectPadding !== undefined
      ? { sketch_aspect_padding: settings.sketchAspectPadding }
      : {}),
  };
}

export function useGrids(project: string, episode: number) {
  return useQuery({
    queryKey: queryKeys.grids(project, episode),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}/grids`, { signal })
        .json<GridsResponse>(),
    enabled: !!project && episode > 0,
  });
}

export function useRebuildPoolIndex(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/grids/rebuild-pool`,
          { json: {} },
        )
        .json<OkResponse<{ episode: number; image_count: number }>>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

export function useGenerateSketches(project: string, episode: number) {
  return useMutation({
    mutationFn: (params?: SketchGenerateParams) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/sketches/generate`,
          { json: { grid_index: 0, ...(params ?? {}) } },
        )
        .json<TaskResponse | ErrorResponse>(),
  });
}

export function useRegenerateGrid(project: string, episode: number) {
  return useMutation({
    mutationFn: ({
      gridIndex,
      style,
      model = "nanobanana",
      sceneGrouping = false,
      characterGrouping = false,
      imageGenerationSelection,
      sketchAspectPadding,
    }: {
      gridIndex: number;
      style?: string | null;
      model?: string;
      sceneGrouping?: boolean;
      characterGrouping?: boolean;
    } & RenderGenerationSettings) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/grids/${gridIndex}/regenerate`,
          {
            json: {
              ...(style ? { style } : {}),
              model,
              scene_grouping: sceneGrouping,
              character_grouping: characterGrouping,
              ...renderGenerationSettingsJson({
                imageGenerationSelection,
                sketchAspectPadding,
              }),
            },
          },
        )
        .json<TaskResponse | ErrorResponse>(),
  });
}

export function useBeatPanoBackgroundManifest(
  project: string,
  episode: number,
  beatNum: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.beatPanoBackgroundManifest(project, episode, beatNum),
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/pano-background/manifest`,
          { signal },
        )
        .json<ApiResponse<PanoViewerManifest>>(),
    enabled: enabled && !!project && episode > 0 && beatNum > 0,
  });
}

export function useBeatDirectorStageManifest(
  project: string,
  episode: number,
  beatNum: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.beatDirectorStageManifest(project, episode, beatNum),
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/director-stage/manifest`,
          { signal },
        )
        .json<ApiResponse<DirectorStageManifest>>(),
    enabled: enabled && !!project && episode > 0 && beatNum > 0,
    // Freezone can commit this manifest from a separate app/query cache.
    // Treat mainline reads as externally mutable so tab focus refreshes it.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export interface BeatBackgroundAnchorItem {
  id: string;
  label: string;
  current: boolean;
  exists: boolean;
  path?: string;
  rel_path?: string | null;
  url?: string | null;
  snapshot_to_selected_background?: boolean;
}

export interface BeatBackgroundAnchorsData {
  episode: number;
  beat_num: number;
  scene_id: string;
  can_choose: boolean;
  render_anchor_id?: string;
  current_source?: string;
  current_anchor: string;
  current_reference?: BeatBackgroundReference | null;
  display_reference?: BeatBackgroundReference | null;
  render_input?: BeatBackgroundReference | null;
  anchors: BeatBackgroundAnchorItem[];
  error?: string;
}

export interface BeatBackgroundReference {
    id: string;
    label: string;
    anchor_id?: string;
    path?: string;
    rel_path?: string | null;
    url?: string | null;
}

export function useBeatBackgroundAnchors(project: string, episode: number, beatNum: number) {
  return useQuery({
    queryKey: queryKeys.beatBackgroundAnchors(project, episode, beatNum),
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/background-anchors`,
          { signal },
        )
        .json<ApiResponse<BeatBackgroundAnchorsData>>(),
    enabled: !!project && episode > 0 && beatNum > 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useUpdateBeatBackgroundAnchor(project: string, episode: number, beatNum: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ anchorId }: { anchorId: string }) =>
      api
        .patch(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/background-anchor`,
          { json: { anchor_id: anchorId } },
        )
        .json<ApiResponse<BeatBackgroundAnchorsData>>(),
    onSuccess: (data) => {
      if (data.ok) {
        qc.setQueryData(queryKeys.beatBackgroundAnchors(project, episode, beatNum), data);
      }
      qc.invalidateQueries({ queryKey: queryKeys.beatBackgroundAnchors(project, episode, beatNum) });
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

export function useUploadBeatBackgroundAnchor(project: string, episode: number, beatNum: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file }: { file: File }) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/background-anchor/upload`,
          { body: form },
        )
        .json<ApiResponse<BeatBackgroundAnchorsData>>();
    },
    onSuccess: (data) => {
      if (data.ok) {
        qc.setQueryData(queryKeys.beatBackgroundAnchors(project, episode, beatNum), data);
      }
      qc.invalidateQueries({ queryKey: queryKeys.beatBackgroundAnchors(project, episode, beatNum) });
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

export interface BeatBackgroundAnchorCropParams {
  anchorId: string;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function useCropBeatBackgroundAnchor(project: string, episode: number, beatNum: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ anchorId, crop }: BeatBackgroundAnchorCropParams) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/background-anchor/crop`,
          {
            json: {
              anchor_id: anchorId,
              x: crop.x,
              y: crop.y,
              width: crop.width,
              height: crop.height,
            },
          },
        )
        .json<ApiResponse<BeatBackgroundAnchorsData>>(),
    onSuccess: (data) => {
      if (data.ok) {
        qc.setQueryData(queryKeys.beatBackgroundAnchors(project, episode, beatNum), data);
      }
      qc.invalidateQueries({ queryKey: queryKeys.beatBackgroundAnchors(project, episode, beatNum) });
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

// Mirrors backend response from /sketches/generate-missing-manual:
// scopes / segments are surfaced for diagnostics only (not currently rendered).
export interface GenerateMissingManualResult {
  dispatched: number;
  scopes: string[];
  segments: number[][];
}

export function useGenerateMissingManualSketches(
  project: string,
  episode: number,
) {
  return useMutation({
    mutationFn: () =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/sketches/generate-missing-manual`,
          { json: {} },
        )
        .json<
          | (TaskResponse & { data: GenerateMissingManualResult })
          | { ok: false; error: string; data?: GenerateMissingManualResult }
        >(),
  });
}

// Raised when /pool-select responds with `{ok: false, stale: true}` — the
// candidate is flagged as belonging to an outdated script. Callers can catch
// this specific error and retry with `force: true` after user confirmation.
export class StalePoolSelectError extends Error {
  readonly stale = true;
  constructor(message: string) {
    super(message);
    this.name = "StalePoolSelectError";
  }
}

interface PoolSelectResponse {
  ok: boolean;
  error?: string;
  stale?: boolean;
  data?: {
    beat_num: number;
    pool_id: string;
    image_type?: "sketch" | "render";
    sketch_url?: string;
    frame_url?: string;
  };
}

export function usePoolSelect(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      beatNum,
      poolId,
      force,
    }: {
      beatNum: number;
      poolId: string;
      force?: boolean;
    }) => {
      const res = await api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/pool-select`,
          { json: { pool_id: poolId, force: force ?? false } },
        )
        .json<PoolSelectResponse>();
      if (!res.ok) {
        const msg = res.error ?? "选择失败";
        if (res.stale) throw new StalePoolSelectError(msg);
        throw new Error(msg);
      }
      return res;
    },
    // Patch caches in place instead of invalidating the episode-wide list.
    // Sketch selection updates the canonical sketch file; render selection
    // updates the render assignment and canonical frame file.
    onSuccess: (res, { beatNum, poolId }) => {
      const patched = res.data;
      if (patched?.frame_url) {
        qc.setQueryData<GridsResponse>(
          queryKeys.grids(project, episode),
          (old) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: {
                ...old.data,
                beat_assignments: {
                  ...old.data.beat_assignments,
                  [String(beatNum)]: poolId,
                },
              },
            };
          },
        );
        qc.setQueryData<OkResponse<Beat[]>>(
          queryKeys.beats(project, episode),
          (old) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: old.data.map((b) =>
                b.beat_number === beatNum
                  ? { ...b, frame_url: patched.frame_url }
                  : b,
              ),
            };
          },
        );
      }
      if (patched?.sketch_url) {
        qc.invalidateQueries({
          queryKey: queryKeys.sketchPoseEditor(project, episode, beatNum),
        });
        qc.setQueryData<OkResponse<Beat[]>>(
          queryKeys.beats(project, episode),
          (old) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: old.data.map((b) =>
                b.beat_number === beatNum
                  ? { ...b, sketch_url: patched.sketch_url }
                  : b,
              ),
            };
          },
        );
      }
    },
  });
}

export interface AssignColorsResult {
  colors: Record<string, string>;
  count: number;
  prop_colors?: Record<string, string>;
  prop_count?: number;
}

// Mirrors the backend envelope: `{ok:false, error}` is a 200 JSON payload,
// not an HTTP error — callers must check `ok` before touching `data`.
export function useAssignColors(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts?: { force?: boolean }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/sketches/assign-colors`,
          opts?.force
            ? { searchParams: { force: "true" } }
            : undefined,
        )
        .json<ApiResponse<AssignColorsResult>>(),
    onSuccess: (res) => {
      if (!res.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
      // Palette lives on the script JSON's sketch_colors map, so the chip
      // strip only refreshes if we invalidate the script query too.
      qc.invalidateQueries({ queryKey: queryKeys.script(project, episode) });
      qc.invalidateQueries({
        queryKey: queryKeys.episodeDetail(project, episode),
      });
    },
  });
}

const AI_DETECT_IDENTITIES_TIMEOUT_MS = 180_000;

export interface DetectIdentitiesResult {
  // Backend returns string keys (JSON-compatible) mapping beat_number → identity ids.
  detections: Record<string, string[]>;
  identity_detections?: Record<string, string[]>;
  prop_detections?: Record<string, string[]>;
  total_beats: number;
  total_identities: number;
  total_props?: number;
  review_message?: string;
}

export function useDetectIdentities(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<ApiResponse<DetectIdentitiesResult>>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/sketches/detect-identities`,
          {
            timeout: AI_DETECT_IDENTITIES_TIMEOUT_MS,
            throwHttpErrors: false,
          },
        ),
      ),
    onSuccess: (res) => {
      if (!res.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.script(project, episode) });
    },
  });
}

export interface BeatImageUploadResult {
  beat_num: number;
  pool_id: string;
  sketch_url?: string;
  frame_url?: string;
}

export function useUploadBeatImage(
  project: string,
  episode: number,
  imageType: "sketch" | "render",
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ beatNum, file }: { beatNum: number; file: File }) => {
      const body = new FormData();
      body.append("file", file, file.name);
      return api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/${imageType}/upload`,
          { body },
        )
        .json<ApiResponse<BeatImageUploadResult>>();
    },
    onSuccess: (res) => {
      if (!res.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
    },
  });
}

export interface DirectorControlFrameStatus {
  episode: number;
  beat_num: number;
  ready: boolean;
  path?: string | null;
  rel_path?: string | null;
  url?: string | null;
  scope: string;
}

export function useDirectorControlFrameStatus(
  project: string,
  episode: number,
  beatNum: number,
) {
  return useQuery({
    queryKey: queryKeys.directorControlFrame(project, episode, beatNum),
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/director-control-frame`,
          { signal },
        )
        .json<ApiResponse<DirectorControlFrameStatus>>(),
    enabled: !!project && episode > 0 && beatNum > 0,
  });
}

export function useDirectorControlToSketch(
  project: string,
  episode: number,
  beatNum: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/director-control-to-sketch`,
        )
        .json<
          | (TaskResponse & { data?: DirectorControlFrameStatus })
          | (ErrorResponse & { data?: DirectorControlFrameStatus })
        >(),
    onSuccess: (res) => {
      qc.invalidateQueries({
        queryKey: queryKeys.directorControlFrame(project, episode, beatNum),
      });
      if (!res.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.beats(project, episode) });
    },
  });
}

export function useRegenerateSketches(project: string, episode: number) {
  return useMutation({
    mutationFn: (params: {
      beatIndices: number[];
      modeKey?: string;
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/sketches/regenerate`,
          {
            json: {
              beat_indices: params.beatIndices,
              mode_key: params.modeKey ?? "1x1_2-3_sketch",
            },
          },
        )
        .json<TaskResponse | ErrorResponse>(),
  });
}

export function useRegenerateRenderBeats(project: string, episode: number) {
  return useMutation({
    mutationFn: (params: {
      beatIndices: number[];
      modeKey?: string;
    } & RenderGenerationSettings) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/regenerate`,
          {
            json: {
              beat_indices: params.beatIndices,
              mode_key: params.modeKey ?? "1x1_2-3",
              ...renderGenerationSettingsJson(params),
            },
          },
        )
        .json<TaskResponse | ErrorResponse>(),
  });
}

export interface GridUploadResult {
  grid_index: number;
  grid_type: "render" | "sketch";
  mode_key: string;
  beat_numbers: number[];
  grid_path: string;
  grid_url: string;
}

export function useUploadGrid(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      gridIndex,
      file,
      gridType = "render",
      modeKey,
      beatNumbers,
    }: {
      gridIndex: number;
      file: File;
      gridType?: "render" | "sketch";
      modeKey: string;
      beatNumbers: number[];
    }) => {
      const body = new FormData();
      body.append("file", file, file.name);
      body.append("grid_type", gridType);
      body.append("mode_key", modeKey);
      body.append("beat_numbers", beatNumbers.join(","));
      return api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/grids/${gridIndex}/upload`,
          { body },
        )
        .json<ApiResponse<GridUploadResult>>();
    },
    onSuccess: (res) => {
      if (!res.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

export interface GridPromptResult {
  grid_index: number;
  grid_type: "render" | "sketch";
  mode_key: string;
  beat_numbers: number[];
  prompt: string;
  prompt_path: string;
}

export interface GridSketchPreviewResult {
  grid_index: number;
  rows: number;
  cols: number;
  beat_numbers: number[];
  preview_path: string;
  preview_url: string;
}

export function useSketchGridPreview(
  project: string,
  episode: number,
  {
    gridIndex,
    rows,
    cols,
    beatNumbers,
    enabled,
  }: {
    gridIndex: number;
    rows: number;
    cols: number;
    beatNumbers: number[];
    enabled: boolean;
  },
) {
  return useQuery({
    queryKey: [
      ...queryKeys.grids(project, episode),
      "sketch-preview",
      gridIndex,
      rows,
      cols,
      beatNumbers.join(","),
    ],
    queryFn: ({ signal }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/grids/${gridIndex}/sketch-preview`,
          {
            json: {
              rows,
              cols,
              beat_numbers: beatNumbers,
            },
            signal,
          },
        )
        .json<ApiResponse<GridSketchPreviewResult>>(),
    enabled: enabled && !!project && episode > 0 && beatNumbers.length > 0,
  });
}

export function useExportGridPrompt(project: string, episode: number) {
  return useMutation({
    mutationFn: ({
      gridIndex,
      gridType = "render",
      modeKey,
      beatNumbers,
    }: {
      gridIndex: number;
      gridType?: "render" | "sketch";
      modeKey: string;
      beatNumbers: number[];
    }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/grids/${gridIndex}/prompt`,
          {
            searchParams: {
              grid_type: gridType,
              mode_key: modeKey,
              beat_numbers: beatNumbers.join(","),
            },
          },
        )
        .json<ApiResponse<GridPromptResult>>(),
  });
}

export function useCutGrid(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      gridIndex,
      rows,
      cols,
      modeKey,
      beatNumbers,
      gridType = "sketch",
    }: {
      gridIndex: number;
      rows: number;
      cols: number;
      modeKey?: string;
      beatNumbers: number[];
      gridType?: "render" | "sketch";
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/grids/${gridIndex}/cut`,
          {
            json: {
              grid_type: gridType,
              ...(modeKey ? { mode_key: modeKey } : {}),
              rows,
              cols,
              beat_start: beatNumbers[0] ?? 1,
              beat_end: beatNumbers[beatNumbers.length - 1] ?? 1,
              beat_numbers: beatNumbers,
            },
          },
        )
        .json<ApiResponse<unknown>>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.grids(project, episode) });
    },
  });
}

export function useGridsByBeat(project: string, episode: number) {
  const { data: gridsRes } = useGrids(project, episode);
  const data = gridsRes?.data;
  // Memo dep must track the inner payload, not the wrapper — TanStack allocates
  // a new response object per fetch even when data is structurally identical,
  // which would cascade new Map/assignments identities through every card.
  return useMemo(() => {
    const images = data?.images ?? [];
    const assignments = data?.beat_assignments ?? {};
    const byBeat = new Map<number, PoolImage[]>();
    for (const img of images) {
      let arr = byBeat.get(img.original_beat);
      if (!arr) {
        arr = [];
        byBeat.set(img.original_beat, arr);
      }
      arr.push(img);
    }
    return { byBeat, assignments };
  }, [data]);
}
