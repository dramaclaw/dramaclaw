// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n from "i18next";
import { api, uploadApi } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { Beat } from "@/types/episode";

export const DEFAULT_VIDEO_BACKEND = "huimeng_seedance-1.0-pro-fast";

export interface VideoBackendOption {
  value: string;
  label: string;
  is_default: boolean;
  is_seedance2: boolean;
  is_happyhorse?: boolean;
  is_grok_video?: boolean;
  /** Dev-only: MiniMax H3 on the user's own RunPod serverless endpoint. */
  is_runpod_h3?: boolean;
  dialogue_only: boolean;
  min_duration?: number | null;
  max_duration?: number | null;
  resolution_options?: string[] | null;
  ratio_options?: string[] | null;
  supported_modes?: string[] | null;
  reference_image_max?: number | null;
  reference_video_max?: number | null;
  reference_audio_max?: number | null;
}

export interface NarratorVoiceStatusData {
  narration_style: string;
  source: string;
  reference_path: string;
  reference_url?: string;
  reference_sha256?: string;
  heading: string;
  /** 展示文案的稳定 code；前端按它查词条，heading/explanation 只作兜底。 */
  heading_code?: string;
  detail: string;
  explanation: string;
  explanation_code?: string;
  character_name?: string;
  identity_id?: string;
  identity_name?: string;
  error?: string;
  is_first_person: boolean;
}

export interface NarratorVoiceSourceOption {
  label: string;
  path: string;
  rel_path: string;
}

export interface NarratorVoiceSourcesData {
  options: NarratorVoiceSourceOption[];
}

export function useVideoBackends(project: string) {
  return useQuery({
    queryKey: queryKeys.videoBackends(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/video-backends`, { signal })
        .json<OkResponse<VideoBackendOption[]>>(),
    enabled: !!project,
  });
}

function invalidateNarratorVoiceQueries(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
) {
  qc.invalidateQueries({ queryKey: queryKeys.narratorVoice(project) });
  qc.invalidateQueries({ queryKey: queryKeys.narratorVoiceSources(project) });
  qc.invalidateQueries({ queryKey: queryKeys.audioBillingQuotes(project) });
  qc.invalidateQueries({ queryKey: seedance2BeatStatusProjectKey(project) });
}

export function useNarratorVoiceStatus(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.narratorVoice(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/narrator-voice`, { signal })
        .json<OkResponse<NarratorVoiceStatusData>>(),
    enabled: !!project && enabled,
  });
}

export function useNarratorVoiceSources(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.narratorVoiceSources(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/narrator-voice/sources`, { signal })
        .json<OkResponse<NarratorVoiceSourcesData>>(),
    enabled: !!project && enabled,
  });
}

export function useUploadNarratorVoice(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file, file.name);
      return uploadApi
        .post(p`api/v1/projects/${project}/narrator-voice/upload`, {
          body: formData,
        })
        .json<OkResponse<NarratorVoiceStatusData> | ErrorResponse>();
    },
    onSuccess: () => invalidateNarratorVoiceQueries(qc, project),
  });
}

export function useRecordNarratorVoice(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataUrl: string) =>
      api
        .post(p`api/v1/projects/${project}/narrator-voice/record`, {
          json: { data_url: dataUrl },
        })
        .json<OkResponse<NarratorVoiceStatusData> | ErrorResponse>(),
    onSuccess: () => invalidateNarratorVoiceQueries(qc, project),
  });
}

export function useCopyProjectNarratorVoice(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourcePath: string) =>
      api
        .post(p`api/v1/projects/${project}/narrator-voice/copy`, {
          json: { source_path: sourcePath },
        })
        .json<OkResponse<NarratorVoiceStatusData> | ErrorResponse>(),
    onSuccess: () => invalidateNarratorVoiceQueries(qc, project),
  });
}

export function useTrimNarratorVoice(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      startSeconds,
      durationSeconds,
    }: {
      startSeconds: number;
      durationSeconds: number;
    }) =>
      api
        .post(p`api/v1/projects/${project}/narrator-voice/trim`, {
          json: {
            start_seconds: startSeconds,
            duration_seconds: durationSeconds,
          },
        })
        .json<OkResponse<NarratorVoiceStatusData> | ErrorResponse>(),
    onSuccess: () => invalidateNarratorVoiceQueries(qc, project),
  });
}

export function useDeleteNarratorVoice(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(p`api/v1/projects/${project}/narrator-voice/delete`)
        .json<OkResponse<NarratorVoiceStatusData> | ErrorResponse>(),
    onSuccess: () => invalidateNarratorVoiceQueries(qc, project),
  });
}

export function useComposeEpisode(project: string, episode: number) {
  return useMutation({
    mutationFn: (params: {
      add_subtitles?: boolean;
      add_bgm?: boolean;
      resolution?: string;
    }) =>
      api
        .post(p`api/v1/projects/${project}/episodes/${episode}/videos/compose`, {
          json: params,
        })
        .json<TaskResponse>(),
  });
}

export interface FinalVideoData {
  exists: boolean;
  filename: string;
  video_url?: string;
}

// Hydrates the compose page on mount so a previously-composed episode shows
// the preview + download without requiring a fresh SSE event.
export function useFinalVideo(project: string, episode: number) {
  return useQuery({
    queryKey: queryKeys.finalVideo(project, episode),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}/final`, { signal })
        .json<OkResponse<FinalVideoData>>(),
    enabled: !!project && episode > 0,
  });
}

export function useGlobalOptimize(project: string, episode: number) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/optimize/video-global`,
          {
            json: {},
            throwHttpErrors: false,
          },
        ),
      ),
  });
}

// Mirrors backend `VideoPoolEntry` (novelvideo/models.py) plus route-injected
// `video_url` from `GET /video-pool`.
export interface VideoPoolEntry {
  id: string;
  beat_num: number;
  video_path: string;
  video_url: string;
  generated_at?: string | null;
  duration: number;
  video_mode: string;
  backend: string;
  prompt: string;
}

export interface VideoPoolData {
  episode: number;
  videos: VideoPoolEntry[];
  beat_assignments: Record<string, string>;
}

export type VideoPoolResponse = OkResponse<VideoPoolData | null>;

export function useVideoPool(project: string, episode: number) {
  return useQuery({
    queryKey: queryKeys.videoPool(project, episode),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}/video-pool`, {
          signal,
        })
        .json<VideoPoolResponse>(),
    enabled: !!project && episode > 0,
  });
}

interface VideoPoolSelectResponse {
  ok: boolean;
  error?: string;
  data?: { beat_num: number; pool_id: string; video_url: string };
}

export function useVideoPoolSelect(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      beatNum,
      poolId,
    }: {
      beatNum: number;
      poolId: string;
    }) => {
      const res = await api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/video-pool-select`,
          { json: { pool_id: poolId } },
        )
        .json<VideoPoolSelectResponse>();
      if (!res.ok) throw new Error(res.error ?? i18n.t("episode.video.switchFailed"));
      return res;
    },
    // Mirror usePoolSelect's pattern: patch caches in place to avoid an
    // episode-wide beats refetch that would reload every video element.
    onSuccess: (res, { beatNum, poolId }) => {
      qc.setQueryData<VideoPoolResponse>(
        queryKeys.videoPool(project, episode),
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
      const nextUrl = res.data?.video_url;
      if (nextUrl) {
        qc.setQueryData<OkResponse<Beat[]>>(
          queryKeys.beats(project, episode),
          (old) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: old.data.map((b) =>
                b.beat_number === beatNum
                  ? { ...b, video_url: nextUrl }
                  : b,
              ),
            };
          },
        );
      }
    },
  });
}

export interface Seedance2PromptResult {
  beat: Beat;
  seedance2_config_json: string;
  final_prompt: string;
  prompt_source?: string;
}

export interface BeatVideoPromptResult {
  beat: Beat;
  field: "video_prompt" | "keyframe_prompt";
  prompt: string;
}

export interface GlobalOptimizeBillingQuote {
  beat_numbers: number[];
  quantity: number;
  unit_cost: number;
  cost: number;
  display: string;
  original_cost?: number;
  discount_amount?: number;
  promotion?: import("@/lib/queries/generation-credit-cost").GenerationCreditCost["promotion"];
}

export function useGlobalOptimizeBillingQuote(
  project: string,
  episode: number,
  assetRevision = "",
) {
  return useQuery({
    queryKey: [
      "global-optimize-billing-quote",
      project,
      episode,
      assetRevision,
    ] as const,
    queryFn: ({ signal }) =>
      jsonWithBackendError<OkResponse<GlobalOptimizeBillingQuote>>(
        api.get(
          p`api/v1/projects/${project}/episodes/${episode}/optimize/video-global/billing-quote`,
          { signal, throwHttpErrors: false },
        ),
      ),
    enabled: !!project && episode > 0,
  });
}

export interface Seedance2BeatStatus {
  beat_number: number;
  audio_type: string;
  seedance2_config_json: string;
  media: {
    render_ready: boolean;
    audio_ready: boolean;
    video_ready: boolean;
  };
  voice: {
    required: boolean;
    ready: boolean;
    label: string;
    detail: string;
    speaker?: string;
  };
  prompt: {
    ready: boolean;
    source: string;
    status: string;
    has_guidance: boolean;
    text_overlay_enabled: boolean;
    text_overlay: Record<string, unknown>;
    inputs_stale: boolean;
  };
  assets: {
    total: number;
    selected: number;
    missing: number;
    images: number;
    audios: number;
    fallbacks: number;
    items: Array<{
      key: string;
      label: string;
      media_type: string;
      selected: boolean;
      exists: boolean;
      reference_label: string;
      note: string;
      identity_id?: string;
      path?: string;
      url?: string;
      abs_path?: string;
      crop_source_path?: string;
      crop_source_abs_path?: string;
      crop_source_url?: string;
      validation_error?: string;
      fallback_text?: string;
      can_crop?: boolean;
      can_trim?: boolean;
      can_delete?: boolean;
    }>;
  };
}

export type VideoInputCropTarget =
  | "reference_image"
  | "first_frame"
  | "last_frame";

const seedance2BeatStatusProjectKey = (project: string) =>
  ["seedance2-beat-status", project] as const;

export const seedance2BeatStatusKey = (
  project: string,
  episode: number,
  beatNum: number,
) => [...seedance2BeatStatusProjectKey(project), episode, beatNum] as const;

function patchSeedance2BeatConfig(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
  episode: number,
  beatNum: number,
  configJson: string,
) {
  if (!configJson) return;
  qc.setQueryData<OkResponse<Beat[]>>(
    queryKeys.beats(project, episode),
    (old) => {
      if (!old?.data) return old;
      return {
        ...old,
        data: old.data.map((b) =>
          b.beat_number === beatNum
            ? { ...b, seedance2_config_json: configJson }
            : b,
        ),
      };
    },
  );
}

export function useSeedance2BeatStatus(
  project: string,
  episode: number,
  beatNum: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: seedance2BeatStatusKey(project, episode, beatNum),
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2-status`,
          { signal },
        )
        .json<OkResponse<Seedance2BeatStatus> | ErrorResponse>(),
    enabled: enabled && !!project && !!episode && !!beatNum,
  });
}

export function useUploadSeedance2Asset(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ beatNum, file }: { beatNum: number; file: File }) => {
      const formData = new FormData();
      formData.append("file", file, file.name);
      return uploadApi
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2/assets/upload`,
          { body: formData },
        )
        .json<OkResponse<Seedance2BeatStatus> | ErrorResponse>();
    },
    onSuccess: (res, { beatNum }) => {
      qc.invalidateQueries({ queryKey: seedance2BeatStatusKey(project, episode, beatNum) });
      if (!res.ok) return;
      patchSeedance2BeatConfig(
        qc,
        project,
        episode,
        beatNum,
        res.data.seedance2_config_json,
      );
    },
  });
}

export function useDeleteSeedance2Asset(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      beatNum,
      mediaKind,
      path,
    }: {
      beatNum: number;
      mediaKind: "images" | "audios";
      path: string;
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2/assets/delete`,
          { json: { media_kind: mediaKind, path } },
        )
        .json<OkResponse<Seedance2BeatStatus> | ErrorResponse>(),
    onSuccess: (res, { beatNum }) => {
      qc.invalidateQueries({ queryKey: seedance2BeatStatusKey(project, episode, beatNum) });
      if (!res.ok) return;
      patchSeedance2BeatConfig(
        qc,
        project,
        episode,
        beatNum,
        res.data.seedance2_config_json,
      );
    },
  });
}

export function useCropSeedance2Asset(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      beatNum,
      assetKey,
      sourcePath,
      crop,
      target = "reference_image",
    }: {
      beatNum: number;
      assetKey: string;
      sourcePath: string;
      crop: { x: number; y: number; width: number; height: number };
      target?: VideoInputCropTarget;
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2/assets/crop`,
          {
            json: {
              asset_key: assetKey,
              source_path: sourcePath,
              target,
              ...crop,
            },
          },
        )
        .json<OkResponse<Seedance2BeatStatus> | ErrorResponse>(),
    onSuccess: (res, { beatNum }) => {
      qc.invalidateQueries({ queryKey: seedance2BeatStatusKey(project, episode, beatNum) });
      if (!res.ok) return;
      patchSeedance2BeatConfig(
        qc,
        project,
        episode,
        beatNum,
        res.data.seedance2_config_json,
      );
    },
  });
}

export function useTrimSeedance2Asset(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      beatNum,
      assetKey,
      sourcePath,
      startSeconds,
      durationSeconds,
    }: {
      beatNum: number;
      assetKey: string;
      sourcePath: string;
      startSeconds: number;
      durationSeconds: number;
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2/assets/audio-trim`,
          {
            json: {
              asset_key: assetKey,
              source_path: sourcePath,
              start_seconds: startSeconds,
              duration_seconds: durationSeconds,
            },
          },
        )
        .json<OkResponse<Seedance2BeatStatus> | ErrorResponse>(),
    onSuccess: (res, { beatNum }) => {
      qc.invalidateQueries({ queryKey: seedance2BeatStatusKey(project, episode, beatNum) });
      qc.invalidateQueries({ queryKey: queryKeys.narratorVoice(project) });
      if (!res.ok) return;
      patchSeedance2BeatConfig(
        qc,
        project,
        episode,
        beatNum,
        res.data.seedance2_config_json,
      );
    },
  });
}

export function useGenerateSeedance2Prompt(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      beatNum,
      manualPromptReference,
      promptGuidance,
      promptGuidanceTemplateKeys,
    }: {
      beatNum: number;
      manualPromptReference?: string;
      promptGuidance?: string;
      promptGuidanceTemplateKeys?: string[];
    }) =>
      jsonWithBackendError<OkResponse<Seedance2PromptResult> | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/seedance2-prompt/generate`,
          {
            json: {
              manual_prompt_reference: manualPromptReference ?? "",
              prompt_guidance: promptGuidance ?? "",
              prompt_guidance_template_keys: promptGuidanceTemplateKeys ?? [],
            },
            throwHttpErrors: false,
          },
        ),
      ),
    onSuccess: (res, { beatNum }) => {
      if (!res.ok) return;
      const patched = res.data.beat;
      qc.setQueryData<OkResponse<Beat[]>>(
        queryKeys.beats(project, episode),
        (old) => {
          if (!old?.data) return old;
          return {
            ...old,
            data: old.data.map((b) =>
              b.beat_number === beatNum ? { ...b, ...patched } : b,
            ),
          };
        },
      );
    },
  });
}

export function useGenerateBeatVideoPrompt(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ beatNum }: { beatNum: number }) =>
      jsonWithBackendError<OkResponse<BeatVideoPromptResult> | TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/video-prompt/generate`,
          {
            json: {},
            throwHttpErrors: false,
          },
        ),
      ),
    onSuccess: (res, { beatNum }) => {
      if (!res.ok) return;
      if (!("data" in res)) return;
      const patched = res.data.beat;
      qc.setQueryData<OkResponse<Beat[]>>(
        queryKeys.beats(project, episode),
        (old) => {
          if (!old?.data) return old;
          return {
            ...old,
            data: old.data.map((b) =>
              b.beat_number === beatNum ? { ...b, ...patched } : b,
            ),
          };
        },
      );
    },
  });
}

// Shared body shape for both the single-video generate request
// (`POST .../beats/{beatNum}/video`) and its dry-run counterpart
// (`POST .../beats/{beatNum}/video/review`) — the review endpoint is
// explicitly documented as taking "the same shape" plus the three
// `h3_*`/`review_fingerprint` fields below (dev-only, MiniMax H3 backend).
export interface SingleVideoRequestBody {
  videoBackend?: string;
  use_director_render?: boolean;
  // seedance-1.5-pro 等非 seedance2 后端的清晰度/时长（视频时长须 >= 音频，后端兜底）。
  resolution?: string;
  duration?: number;
  ratio?: string;
  mode?: string;
  seedance2ConfigJson?: string;
  audioSetting?: string;
  /** H3 review/regen flow: the user-edited prompt, saved into seedance2_config_json.final_prompt server-side. */
  final_prompt?: string;
  /** H3 review flow: ties a regen request back to the `/video/review` call it was confirmed from. */
  review_fingerprint?: string;
  h3_profile?: "formal" | "draft";
  h3_reference_keys?: string[];
}

function buildSingleVideoRequestJson(body: SingleVideoRequestBody) {
  return {
    video_backend: body.videoBackend ?? DEFAULT_VIDEO_BACKEND,
    use_director_render: body.use_director_render,
    ...(body.resolution !== undefined ? { resolution: body.resolution } : {}),
    ...(body.duration !== undefined ? { duration: body.duration } : {}),
    ...(body.ratio !== undefined ? { ratio: body.ratio } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.seedance2ConfigJson !== undefined
      ? { seedance2_config_json: body.seedance2ConfigJson }
      : {}),
    ...(body.audioSetting !== undefined ? { audio_setting: body.audioSetting } : {}),
    ...(body.final_prompt !== undefined ? { final_prompt: body.final_prompt } : {}),
    ...(body.review_fingerprint !== undefined
      ? { review_fingerprint: body.review_fingerprint }
      : {}),
    ...(body.h3_profile !== undefined ? { h3_profile: body.h3_profile } : {}),
    ...(body.h3_reference_keys !== undefined
      ? { h3_reference_keys: body.h3_reference_keys }
      : {}),
  };
}

/** `POST .../video` response when a stale `review_fingerprint` no longer
 * matches current server state — a plain 200, not an HTTP error. */
export interface VideoInputStaleResponse {
  ok: false;
  error: "input_stale";
  message: string;
}

export function useRegenerateBeatVideo(project: string, episode: number) {
  // Kick-off is an ack; the actual video_url lands on SSE task completion,
  // where the task controller handles invalidation. Invalidating here would
  // fire a redundant refetch before regeneration has finished.
  return useMutation({
    mutationFn: ({
      beatNum,
      ...body
    }: { beatNum: number } & SingleVideoRequestBody) =>
      jsonWithBackendError<TaskResponse | ErrorResponse | VideoInputStaleResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/video`,
          {
            json: buildSingleVideoRequestJson(body),
            throwHttpErrors: false,
          },
        ),
      ),
  });
}

export interface VideoReviewReference {
  tag: string;
  kind: string;
  identity_id: string;
  name: string;
  path: string;
  appearance_details: string;
}

export interface VideoReviewLintItem {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface VideoReviewData {
  ok: true;
  backend: string;
  mode: string;
  prompt: string;
  prompt_source: string;
  duration: number;
  ratio: string;
  frame_path: string | null;
  frame_missing: boolean;
  references: VideoReviewReference[];
  lint: VideoReviewLintItem[];
  worker_status: unknown;
  input_fingerprint: string;
}

export type VideoReviewResponse = VideoReviewData | ErrorResponse;

/** `POST .../video/review` — read-only / dry-run preview for the H3 review
 * dialog. Never enqueues a task. */
export function useVideoReview(project: string, episode: number) {
  return useMutation({
    mutationFn: ({
      beatNum,
      body,
    }: {
      beatNum: number;
      body: SingleVideoRequestBody;
    }) =>
      jsonWithBackendError<VideoReviewResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/video/review`,
          {
            json: buildSingleVideoRequestJson(body),
            throwHttpErrors: false,
          },
        ),
      ),
  });
}

export interface MiniMaxH3PromptResult {
  ok: true;
  prompt: string;
  plan: Record<string, unknown>;
  lint: VideoReviewLintItem[];
  mode: string;
  references: Array<{ tag: string; name: string; appearance_details: string }>;
}

export type MiniMaxH3PromptResponse = MiniMaxH3PromptResult | ErrorResponse;

/** `POST .../minimax-h3-prompt/generate` — LLM rewrite of the beat into the
 * MiniMax H3 prompt format. Saves server-side to seedance2_config_json.final_prompt. */
export function useGenerateMiniMaxH3Prompt(project: string, episode: number) {
  return useMutation({
    mutationFn: ({
      beatNum,
      duration,
    }: {
      beatNum: number;
      // Matches whatever duration `/video/review` is currently showing, so
      // the rewritten prompt's own timestamps describe the same clip
      // length that will actually be submitted — otherwise this route's
      // own duration resolution (independent of the review dialog's) can
      // silently disagree and the lint flags a timestamp mismatch.
      duration?: number;
    }) =>
      jsonWithBackendError<MiniMaxH3PromptResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/minimax-h3-prompt/generate`,
          {
            json: duration !== undefined ? { duration } : {},
            throwHttpErrors: false,
          },
        ),
      ),
  });
}
