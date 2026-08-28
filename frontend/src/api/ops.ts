// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall, apiCallEnvelope, apiClient } from "./client";

// Per-node generation history -------------------------------------------- //

/**
 * Optional canvas/node context the backend uses to record a per-node
 * generation history entry. Generation-style endpoints accept these; omitting
 * them is harmless (the backend simply skips history recording). Mixed into
 * each generation payload via {@link FreezoneNodeContext}.
 */
export interface FreezoneNodeContext {
  /** Current canvas id, usually "default". */
  canvasId?: string | null;
  /** Id of the node that triggered the generation. */
  nodeId?: string | null;
  modelParams?: Record<string, unknown>;
}

/**
 * Map the camelCase node context to the backend's snake_case body fields,
 * emitting keys only when present so legacy callers stay byte-identical.
 */
function nodeContextBody(ctx: FreezoneNodeContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.canvasId) out.canvas_id = ctx.canvasId;
  if (ctx.nodeId) out.node_id = ctx.nodeId;
  if (ctx.modelParams) out.model_params = ctx.modelParams;
  return out;
}

/** One recorded generation attempt for a node (see generation-history GET). */
export interface FreezoneGenerationHistoryRecord {
  schema_version: number;
  canvas_id: string;
  node_id: string;
  /** ISO timestamp the backend recorded the attempt. */
  recorded_at: string;
  /** Stable record id, e.g. "freezone_gen:<job_id>". */
  id: string;
  task_type: string;
  task_key: string;
  job_id: string;
  /** "completed" | "failed" | other backend status strings. */
  status: string;
  /** "image" | "video" | "audio" | "text" | "3d" ... */
  media_type: string;
  /** Raw task result payload; shape varies by task_type. */
  result: Record<string, unknown>;
  /** 注册表模型 id（还原时回填 data.model）。旧记录无此字段。 */
  model?: string;
  /** 生成模式（视频 genMode / 图片 generationMode）。旧记录无此字段。 */
  gen_mode?: string;
}

/**
 * Read a node's recorded generation history (most recent first per the
 * backend). Returns `[]` when the node has no history yet. The endpoint is
 * independent of canvas JSON, so this never touches the saved-canvas flow.
 */
export async function fetchNodeGenerationHistory(
  project: string,
  canvasId: string,
  nodeId: string,
  limit = 100,
): Promise<FreezoneGenerationHistoryRecord[]> {
  const data = await apiCall<{ records?: FreezoneGenerationHistoryRecord[] }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/nodes/${encodeURIComponent(nodeId)}/generation-history?limit=${limit}`,
  );
  return data?.records ?? [];
}

/**
 * Read the whole canvas's generation history in one request (most recent
 * first). Unlike {@link fetchNodeGenerationHistory} this is not scoped to a
 * single node, and the backend aggregates across every node that ever recorded
 * history on this canvas — including nodes since deleted from the canvas — so
 * their past attempts stay visible in the history browser.
 */
export async function fetchCanvasGenerationHistory(
  project: string,
  canvasId: string,
  limit = 500,
): Promise<FreezoneGenerationHistoryRecord[]> {
  const data = await apiCall<{ records?: FreezoneGenerationHistoryRecord[] }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/generation-history?limit=${limit}`,
  );
  return data?.records ?? [];
}

/** Remove one entry from the history browser; the underlying media is retained. */
export async function deleteNodeGenerationHistoryRecord(
  project: string,
  canvasId: string,
  nodeId: string,
  recordId: string,
): Promise<{ deleted: boolean }> {
  return await apiCall<{ deleted: boolean }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/nodes/${encodeURIComponent(nodeId)}/generation-history?record_id=${encodeURIComponent(recordId)}`,
    { method: "DELETE" },
  );
}

// /freezone/gen ----------------------------------------------------------- //

export type FreezoneProvider =
  | "newapi"
  | "openrouter"
  | "huimeng"
  | "openai";

export interface FreezoneGenCamera {
  /** id from /freezone/image/camera-options.camera_bodies */
  cameraBodyId?: string | null;
  /** id from /freezone/image/camera-options.lenses */
  lensId?: string | null;
  focalLengthMm?: number | null;
  aperture?: string | null;
}

export interface FreezoneGenStyle {
  /** id from /freezone/image/style-templates */
  templateId?: string | null;
}

export interface FreezoneGenPayload extends FreezoneNodeContext {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  referenceUrls?: string[];
  camera?: FreezoneGenCamera | null;
  style?: FreezoneGenStyle | null;
  /** Override `NANOBANANA_PROVIDER` env default for the reference-image path. */
  provider?: FreezoneProvider | null;
  /** Override the provider's default model (e.g. "gpt-image-2"). */
  model?: string | null;
  /** 注册表模型 id（还原用；与 provider 拆分后的 model 串不同）。 */
  modelId?: string | null;
  /** 生成模式（还原用）：text_to_image / image_to_image / all_reference / image_reference。 */
  genMode?: string | null;
  /** Only honored by openai gpt-image-2 (low / medium / high / auto). */
  quality?: string | null;
}

export interface FreezoneJobRef {
  task_type:
    | "freezone_gen"
    | "freezone_edit"
    | "freezone_multi_view"
    | "freezone_relight"
    | "freezone_scene_360"
    | "freezone_template_edit"
    | "freezone_upscale"
    | "freezone_outpaint"
    | "freezone_redraw"
    | "freezone_video_gen"
    | "freezone_video_omni_gen"
    | "freezone_video_i2v"
    | "freezone_video_erase"
    | "freezone_video_compose"
    | "freezone_video_upscale"
    | "freezone_audio_separate"
    | "freezone_audio_speech"
    | "freezone_audio_eleven_music"
    | "freezone_image_reverse_prompt"
    | "freezone_text_generate"
    | "freezone_text_translate"
    | "freezone_story_script"
    | "freezone_analyze_video_story"
    | "stage_asset";
  job_id: string;
  task_key: string;
}

// /freezone/video/gen ----------------------------------------------------- //

export type FreezoneVideoAspectRatio = string;

export type FreezoneVideoResolution = string;

/** Local element marker on the source image, used to anchor subjects/objects. */
export interface FreezoneVideoMark {
  label: string;
  sourceUrl?: string;
  pointX?: number | null;
  pointY?: number | null;
  boxX?: number | null;
  boxY?: number | null;
  boxWidth?: number | null;
  boxHeight?: number | null;
  note?: string;
}

export interface FreezoneVideoGenPayload extends FreezoneNodeContext {
  prompt: string;
  /** e.g. locked_off / follow_tracking / orbit_up */
  cameraTemplateId?: string | null;
  characterIds?: string[];
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  /** seconds; spec only requires ≥1, the UI typically caps higher. */
  durationSeconds?: number;
  generateAudio?: boolean;
  /** Backend model id, e.g. huimeng_seedance20_fast / seedance_pro. */
  model?: string;
  /** 文生视频入口的固定业务模式。 */
  genMode: "textToVideo";
  /**
   * Real-person material review. Set `true` when the input contains real
   * human faces so the backend routes the job through the human-review path
   * (may take longer, approval not guaranteed). Omitted/false otherwise.
   */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoGen(
  project: string,
  payload: FreezoneVideoGenPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        camera_template_id: payload.cameraTemplateId ?? null,
        character_ids: payload.characterIds ?? [],
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/upscale ------------------------------------------------- //

/** Target clarity tier. Scales by long edge: 1080p=1920, 2k=2560, 4k=3840. */
export type FreezoneVideoUpscaleResolution = "1080p" | "2k" | "4k";

/** Denoise strength. none=off, 1x=light, 2x=medium. */
export type FreezoneVideoUpscaleDenoise = "none" | "1x" | "2x";

export interface FreezoneVideoUpscalePayload extends FreezoneNodeContext {
  /** Static URL of the source video to upscale. */
  sourceUrl: string;
  resolution?: FreezoneVideoUpscaleResolution;
  /** Base version only supports "none" (frame rate unchanged). */
  frameInterpolation?: "none";
  denoiseStrength?: FreezoneVideoUpscaleDenoise;
}

export async function submitFreezoneVideoUpscale(
  project: string,
  payload: FreezoneVideoUpscalePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/upscale`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        resolution: payload.resolution ?? "1080p",
        frame_interpolation: payload.frameInterpolation ?? "none",
        denoise_strength: payload.denoiseStrength ?? "1x",
        ...nodeContextBody(payload),
      },
    },
  );
}

export interface FreezoneVideoKeyframesPayload extends FreezoneNodeContext {
  /** Static URL of the first frame. At least one of first/last must be set. */
  firstFrameUrl?: string | null;
  lastFrameUrl?: string | null;
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  model?: string;
  /** 关键帧业务模式。首尾帧可只提供首帧、只提供尾帧或同时提供。 */
  genMode: "firstFrame" | "firstLastFrame";
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoKeyframes(
  project: string,
  payload: FreezoneVideoKeyframesPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/keyframes`,
    {
      method: "POST",
      json: {
        first_frame_url: payload.firstFrameUrl ?? null,
        last_frame_url: payload.lastFrameUrl ?? null,
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/i2v ----------------------------------------------------- //
//
// Unified endpoint for single-image 图生视频 and multi-image 图片参考. Both
// use image_reference provider semantics and never occupy the first-frame slot.

export interface FreezoneVideoI2vPayload extends FreezoneNodeContext {
  /** Image reference URLs. imageToVideo requires one; imageReference uses the catalog cap. */
  imageUrls: string[];
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  /** default huimeng_seedance10_fast (matches keyframes); multi-image prefers seedance 2.0. */
  model?: string;
  /** Required product entry; both values execute as image_reference. */
  genMode: "imageToVideo" | "imageReference";
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoI2v(
  project: string,
  payload: FreezoneVideoI2vPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/i2v`,
    {
      method: "POST",
      json: {
        image_urls: payload.imageUrls,
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/video-edit ---------------------------------------------- //
//
// 视频编辑：1 个源视频，并按媒体目录能力附带参考图片 / 独立参考音频。

export interface FreezoneVideoEditPayload extends FreezoneNodeContext {
  /** 源视频静态地址，必填。 */
  videoUrl: string;
  /** 0-5 张参考图静态地址。 */
  imageUrls?: string[];
  /** 独立参考音频静态地址；数量和时长上限由媒体模型目录决定。 */
  audioUrls?: string[];
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  resolution?: FreezoneVideoResolution;
  /** 视频编辑音频策略：auto 自动 / origin 保留原声。 */
  audioSetting?: "auto" | "origin";
  generateAudio?: boolean;
  /** default newapi_happyhorse-1.0. */
  model?: string;
  /** 视频编辑入口的固定业务模式。 */
  genMode: "videoEdit";
  humanReview?: boolean;
}

export async function submitFreezoneVideoEdit(
  project: string,
  payload: FreezoneVideoEditPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/video-edit`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        image_urls: payload.imageUrls ?? [],
        audio_urls: payload.audioUrls ?? [],
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        resolution: payload.resolution ?? "720p",
        audio_setting: payload.audioSetting ?? "auto",
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/omni-gen ------------------------------------------------ //

export type FreezoneVideoReferenceType = "image" | "video" | "audio" | "file" | "link";

export interface FreezoneVideoReferenceItem {
  type: FreezoneVideoReferenceType;
  url: string;
  role?: string;
  label?: string;
}

export interface FreezoneVideoOmniGenPayload extends FreezoneNodeContext {
  prompt: string;
  theme?: string;
  cameraTemplateId?: string | null;
  /** Mixed media references; file/link support and limits come from the model catalog. */
  references?: FreezoneVideoReferenceItem[];
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  /** default huimeng_seedance20_fast per backend default. */
  model?: string;
  /** 全能参考入口的固定业务模式。 */
  genMode: "allReference";
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoOmniGen(
  project: string,
  payload: FreezoneVideoOmniGenPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/omni-gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        theme: payload.theme ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        references: (payload.references ?? []).map((r) => ({
          type: r.type,
          url: r.url,
          role: r.role ?? "",
          label: r.label ?? "",
        })),
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

export async function submitFreezoneGen(
  project: string,
  payload: FreezoneGenPayload,
): Promise<FreezoneJobRef> {
  const camera = payload.camera
    ? {
        camera_body: payload.camera.cameraBodyId ?? "",
        lens: payload.camera.lensId ?? "",
        focal_length_mm: payload.camera.focalLengthMm ?? 0,
        aperture: payload.camera.aperture ?? "",
      }
    : null;
  const style = payload.style?.templateId
    ? { template_id: payload.style.templateId }
    : null;
  // 后端只能按静态路径打开引用图：任何 `data:` base64 先上传换成上传 URL，
  // 其余 http(s)/static 原样保留（仅剥掉 `?v=` 缓存串）。统一在此兜底，
  // 避免各调用方漏做净化把 base64 塞进 reference_urls。
  const referenceUrls = await ensureBackendImageUrls(
    project,
    payload.referenceUrls,
  );
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        aspect_ratio: payload.aspectRatio ?? "1:1",
        image_size: payload.imageSize ?? "2K",
        reference_urls: referenceUrls,
        camera,
        style,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        ...(payload.modelId ? { model_id: payload.modelId } : {}),
        ...(payload.genMode ? { gen_mode: payload.genMode } : {}),
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/erase --------------------------------------------------- //

/**
 * Per `FreezoneVideoEraseRequest` in openapi.json:
 * - `smart_subtitle`: backend auto-estimates the bottom subtitle band.
 * - `box`: front-end supplies a normalized box (0..1 against source frame).
 */
export type FreezoneVideoEraseMode = "smart_subtitle" | "box";

export interface FreezoneVideoEraseBox {
  /** Top-left x, normalized 0..1 against the source video frame. */
  x: number;
  /** Top-left y, normalized 0..1 against the source video frame. */
  y: number;
  /** Width, normalized (0, 1]. */
  width: number;
  /** Height, normalized (0, 1]. */
  height: number;
}

export interface FreezoneVideoErasePayload {
  sourceUrl: string;
  mode: FreezoneVideoEraseMode;
  /** Required when `mode === "box"`; ignored otherwise. */
  box?: FreezoneVideoEraseBox | null;
}

export async function submitFreezoneVideoErase(
  project: string,
  payload: FreezoneVideoErasePayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    source_url: payload.sourceUrl,
    mode: payload.mode,
  };
  if (payload.mode === "box" && payload.box) {
    body.box_x = payload.box.x;
    body.box_y = payload.box.y;
    body.box_width = payload.box.width;
    body.box_height = payload.box.height;
  }
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/erase`,
    { method: "POST", json: body },
  );
}

// /freezone/video/compose ------------------------------------------------- //

export type FreezoneVideoComposeResolution = "720p" | "1080p";
export type FreezoneVideoComposeTrackKind = "video" | "audio";

export interface FreezoneVideoComposeItemPayload {
  itemId: string;
  sourceUrl: string;
  /** Position on the output timeline, in seconds. */
  timelineStart?: number;
  /** Trim start within source media, in seconds. */
  sourceStart?: number;
  /** Trim end within source media, in seconds. Must be > sourceStart. */
  sourceEnd: number;
  volume?: number;
  muted?: boolean;
  /**
   * Playback rate (变速). 1 = original speed. ⚠️ Only honored if the BE compose
   * endpoint implements it; otherwise the field is ignored (export stays 1×).
   */
  speed?: number;
}

export interface FreezoneVideoComposeTrackPayload {
  trackId: string;
  kind: FreezoneVideoComposeTrackKind;
  items: FreezoneVideoComposeItemPayload[];
}

export interface FreezoneVideoComposePayload {
  title?: string;
  canvasId?: string;
  resolution?: FreezoneVideoComposeResolution;
  fps?: number;
  backgroundColor?: string;
  keepOriginalAudio?: boolean;
  /**
   * 封面图 URL（已上传到后端的稳定地址）。后端支持时会把它挂成 MP4 的封面流
   * （attached_pic，不改正片时长）；不支持时忽略，前端缩略图仍用同一个 url。
   */
  coverUrl?: string | null;
  tracks: FreezoneVideoComposeTrackPayload[];
}

export async function submitFreezoneVideoCompose(
  project: string,
  payload: FreezoneVideoComposePayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    title: payload.title ?? "",
    canvas_id: payload.canvasId ?? "",
    resolution: payload.resolution ?? "1080p",
    fps: payload.fps ?? 30,
    background_color: payload.backgroundColor ?? "#000000",
    keep_original_audio: payload.keepOriginalAudio ?? true,
    cover_url: payload.coverUrl ?? "",
    tracks: payload.tracks.map((track) => ({
      track_id: track.trackId,
      kind: track.kind,
      items: track.items.map((item) => ({
        item_id: item.itemId,
        source_url: item.sourceUrl,
        timeline_start: item.timelineStart ?? 0,
        source_start: item.sourceStart ?? 0,
        source_end: item.sourceEnd,
        volume: item.volume ?? 1,
        muted: item.muted ?? false,
        speed: item.speed ?? 1,
      })),
    })),
  };
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/compose`,
    { method: "POST", json: body },
  );
}

// /freezone/video/audio-separate ----------------------------------------- //

/**
 * Per `FreezoneAudioSeparateRequest` in openapi.json the only required field is
 * `source_url`. Backend returns two artifacts via the task SSE: the extracted
 * audio track and a silent (muted) version of the original video.
 */
export interface FreezoneAudioSeparatePayload {
  sourceUrl: string;
  /** 目标 beat;给定后分离出的音频会带上 beat_audio slot_target,可直接 commit。 */
  targetEpisode?: number;
  targetBeat?: number;
}

export async function submitFreezoneAudioSeparate(
  project: string,
  payload: FreezoneAudioSeparatePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/audio-separate`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

/**
 * Result shape for `freezone_audio_separate` isn't typed in openapi.json — the
 * endpoint declares `{}` (free-form). The light-version backend ships two
 * artifacts (audio track + silent video); callers walk the tree to find the
 * two URLs by extension.
 */
export async function fetchFreezoneAudioSeparateResult(
  project: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  return await apiCall<Record<string, unknown>>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_audio_separate/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/image/reverse-prompt ----------------------------------------- //

/**
 * `source_url` is required; `instruction` steers the returned prompt.
 */
export interface FreezoneReversePromptPayload extends FreezoneNodeContext {
  sourceUrl: string;
  instruction?: string;
}

export async function submitFreezoneReversePrompt(
  project: string,
  payload: FreezoneReversePromptPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/image/reverse-prompt`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        instruction: payload.instruction ?? "",
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/image/style-templates ---------------------------------------- //

export interface FreezoneStyleTemplate {
  id: string;
  label: string;
  /** 题材分类:古装 / 都市 / 年代 / 生活 / 科幻 / 类型 / 写意,图墙顶部按它分组。 */
  category: string;
  /** 封面图相对路径,需经 resolveStyleAssetUrl 解析。 */
  cover: string;
  /** 女 / 少 / 男 / 老 四张示例图的相对路径。 */
  samples: string[];
  /** 中文风格提示词全文,原样拼进生成 prompt。 */
  style_prompt: string;
}

export interface FreezoneStyleTemplateList {
  assetBase: string;
  /** 后端风格清单的版本号,图片和提示词对不上时用来定位是哪一份清单在生效。 */
  version: string;
  templates: FreezoneStyleTemplate[];
}

/**
 * 把后端吐回来的东西掰成风格模板数组。
 *
 * 这个端点的形状在两个仓库之间反复横跳过：早期 `data` 是裸列表，后来被换成
 * `{asset_base, version, templates}` 的对象（于是没跟进的前端 `templates.find(...)`
 * 当场抛 `is not a function`，整页白屏），现在又改回裸列表、元信息挂到信封同级。
 * 所以这里不信任何一种形状，四种常见包装都认，认不出就退空列表 —— 图墙空着是能
 * 看懂的降级，白屏不是。同一族的 {@link coerceCameraTemplateList} 就是这么做的。
 */
function coerceStyleTemplateList(payload: unknown): FreezoneStyleTemplate[] {
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.templates)) candidate = wrapper.templates;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else if (Array.isArray(wrapper.style_templates)) candidate = wrapper.style_templates;
  }
  if (!Array.isArray(candidate)) return [];
  const result: FreezoneStyleTemplate[] = [];
  for (const item of candidate) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    // 没 id 就没法回写到节点上，这条直接丢掉；其余字段缺了还能降级显示。
    const id = pickString(entry, "id", "template_id", "templateId", "key");
    if (!id) continue;
    result.push({
      id,
      label: pickString(entry, "label", "display_name", "displayName", "title", "name") ?? id,
      category: pickString(entry, "category", "group", "kind") ?? "",
      cover: pickString(entry, "cover", "cover_url", "coverUrl", "thumbnail") ?? "",
      samples: pickStringArray(entry, "samples", "sample_urls", "sampleUrls"),
      style_prompt:
        pickString(entry, "style_prompt", "stylePrompt", "prompt", "prompt_fragment") ?? "",
    });
  }
  return result;
}

export async function listFreezoneStyleTemplates(
  project: string,
): Promise<FreezoneStyleTemplateList> {
  // 走 apiCallEnvelope 而不是 apiCall：清单元信息挂在 `data` 同级（`data` 得留给
  // 裸列表，见后端路由注释）。元信息在 data 里的旧形状也照样能认出来。
  const envelope = await apiCallEnvelope<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/image/style-templates`,
  );
  const nested =
    envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : {};
  const meta = (key: string) =>
    pickString(envelope, key) ?? pickString(nested, key) ?? "";
  return {
    assetBase: meta("asset_base"),
    version: meta("version"),
    templates: coerceStyleTemplateList(envelope.data),
  };
}

// /freezone/image/camera-options ----------------------------------------- //

export interface FreezoneCameraIdLabel {
  id: string;
  label: string;
}

export interface FreezoneCameraOptions {
  camera_bodies: FreezoneCameraIdLabel[];
  lenses: FreezoneCameraIdLabel[];
  focal_lengths_mm: number[];
  apertures: string[];
}

export async function fetchFreezoneCameraOptions(
  project: string,
): Promise<FreezoneCameraOptions> {
  return await apiCall<FreezoneCameraOptions>(
    `projects/${encodeURIComponent(project)}/freezone/image/camera-options`,
  );
}

// /freezone/image/models -------------------------------------------------- //

export type MediaModelParameterControl = "select" | "number" | "switch" | "text" | "multiselect";
export interface MediaModelParameterDefinition {
  key: string;
  label: string;
  control: MediaModelParameterControl;
  requestPath: string;
  options?: Array<string | number | boolean>;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  modes?: string[];
}
export interface MediaModelRequestSchema {
  endpoint: "images/generations" | "video/generations" | "audio/speech";
  parameters?: MediaModelParameterDefinition[];
  omitPaths?: string[];
}

export interface FreezoneImageModelInfo {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"huimeng/gpt-image-2"`. */
  id: string;
  /** Provider tab id (`huimeng` / `openrouter` / `openai`). */
  providerId: FreezoneProvider;
  /** Value sent to backend `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  resolutionOptions?: string[];
  qualityOptions?: string[];
  ratioOptions?: string[];
  referenceImageMax?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model strings the backend may return without
// metadata (e.g. just a flat string list). Order matters — first match wins.
const MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().includes("/gemini"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("google/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("anthropic/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("openrouter/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("gpt-image"), providerId: "openai" },
  { match: (s) => s.toLowerCase().startsWith("dall-e"), providerId: "openai" },
];

function inferProvider(raw: string): FreezoneProvider {
  for (const hint of MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "huimeng";
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function pickStringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }
  return [];
}

function pickMediaRequestSchema(value: unknown): MediaModelRequestSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>;
  if (typeof schema.endpoint !== "string") return undefined;
  return schema as unknown as MediaModelRequestSchema;
}

function normalizeProviderId(raw: string | null): FreezoneProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (
    lowered === "newapi" ||
    lowered === "huimeng" ||
    lowered === "openrouter" ||
    lowered === "openai"
  ) {
    return lowered;
  }
  return null;
}

function modelEntryFromObject(entry: Record<string, unknown>): FreezoneImageModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferProvider(apiModel);
  const id = pickString(entry, "id") ?? `${providerId}/${apiModel}`;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    resolutionOptions: pickStringArray(entry, "resolutionOptions", "resolution_options"),
    qualityOptions: pickStringArray(entry, "qualityOptions", "quality_options"),
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    request: pickMediaRequestSchema(entry.request),
  };
}

function modelEntryFromString(raw: string): FreezoneImageModelInfo {
  const providerId = inferProvider(raw);
  return {
    id: `${providerId}/${raw}`,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

function coerceModelList(payload: unknown): FreezoneImageModelInfo[] {
  // Accept several shapes the backend might return — schema is empty in
  // openapi.json so we normalize defensively rather than guess one shape.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { huimeng: [...], openrouter: [...] }
      const flattened: FreezoneImageModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: `${providerId}/${item}`,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = modelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneImageModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(modelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = modelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}

export async function fetchFreezoneImageModels(
  project: string,
): Promise<FreezoneImageModelInfo[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/image/models`,
  );
  return coerceModelList(payload);
}

// /freezone/video/models -------------------------------------------------- //

/** Provider tab id for video generation models. */
export type FreezoneVideoProvider = "newapi" | "seedance" | "huimeng";

export interface FreezoneVideoModelInfo {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"seedance_2"` (backend currently keys by api id). */
  id: string;
  /** Provider tab id (`seedance` / `huimeng`). */
  providerId: FreezoneVideoProvider;
  /** Value sent to backend `/freezone/video/gen` `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  /** Supported output resolution values for this model, when advertised by backend. */
  resolutionOptions?: FreezoneVideoResolution[];
  humanReview?: boolean;
  /** Whether this model can produce native synchronized audio. Missing means legacy-supported. */
  supportsGenerateAudio?: boolean;
  /** Smallest supported duration in seconds, when advertised by backend. */
  minDuration?: number | null;
  /** Largest supported duration in seconds, when advertised by backend. */
  maxDuration?: number | null;
  /** Supported Seedance 2.0 Value style hints, when advertised by backend. */
  sceneOptimizeOptions?: Array<"anime" | "realistic">;
  /** Default Seedance 2.0 Value style hint, when advertised by backend. */
  defaultSceneOptimize?: "anime" | "realistic" | null;
  ratioOptions?: string[];
  supportedModes?: string[];
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
  referenceFileMax?: number | null;
  referenceLinkMax?: number | null;
  referenceFileTypes?: string[];
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  /**
   * 参考音频**总时长**上限（秒）。厂商 r2v 除了逐条 1.8~15.2s，还另有一条总和限制
   * （见 videoModelCapabilities 里的说明），这项就是它的后台可配值；没配时前端按
   * 15.2s 兜底。允许小数，别当成整数字段处理。
   */
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model ids the backend may return without
// metadata. Order matters — first match wins. Anything we don't recognize
// falls back to `seedance` (the primary provider).
const VIDEO_MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneVideoProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().startsWith("seedance"), providerId: "seedance" },
];

function inferVideoProvider(raw: string): FreezoneVideoProvider {
  for (const hint of VIDEO_MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "seedance";
}

function normalizeVideoProviderId(raw: string | null): FreezoneVideoProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === "newapi" || lowered === "seedance" || lowered === "huimeng") return lowered;
  return null;
}

function videoModelEntryFromObject(
  entry: Record<string, unknown>,
): FreezoneVideoModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeVideoProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferVideoProvider(apiModel);
  const id = pickString(entry, "id") ?? apiModel;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  const resolutionOptions = pickStringArray(entry, "resolutionOptions", "resolution_options");
  const sceneOptimizeOptions = pickStringArray(entry, "sceneOptimizeOptions", "scene_optimize_options")
    .map((value) => value.toLowerCase())
    .filter((value): value is "anime" | "realistic" =>
      value === "anime" || value === "realistic"
    );
  const defaultSceneOptimizeRaw = pickString(entry, "defaultSceneOptimize", "default_scene_optimize")
    ?.toLowerCase();
  const defaultSceneOptimize =
    defaultSceneOptimizeRaw === "anime" || defaultSceneOptimizeRaw === "realistic"
      ? defaultSceneOptimizeRaw
      : null;
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    ...(resolutionOptions.length > 0 ? { resolutionOptions } : {}),
    humanReview: pickBoolean(entry, "humanReview", "human_review"),
    supportsGenerateAudio: pickBoolean(
      entry,
      "supportsGenerateAudio",
      "supports_generate_audio",
    ),
    minDuration: pickNumber(entry, "minDuration", "min_duration"),
    maxDuration: pickNumber(entry, "maxDuration", "max_duration"),
    ...(sceneOptimizeOptions.length > 0 ? { sceneOptimizeOptions } : {}),
    defaultSceneOptimize,
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    supportedModes: pickStringArray(entry, "supportedModes", "supported_modes"),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    referenceVideoMax: pickNumber(entry, "referenceVideoMax", "reference_video_max"),
    referenceAudioMax: pickNumber(entry, "referenceAudioMax", "reference_audio_max"),
    referenceFileMax: pickNumber(entry, "referenceFileMax", "reference_file_max"),
    referenceLinkMax: pickNumber(entry, "referenceLinkMax", "reference_link_max"),
    referenceFileTypes: pickStringArray(entry, "referenceFileTypes", "reference_file_types"),
    referenceAudioMinSeconds: pickNumber(
      entry,
      "referenceAudioMinSeconds",
      "reference_audio_min_seconds",
    ),
    referenceAudioMaxSeconds: pickNumber(
      entry,
      "referenceAudioMaxSeconds",
      "reference_audio_max_seconds",
    ),
    referenceAudioTotalMinSeconds: pickNumber(
      entry,
      "referenceAudioTotalMinSeconds",
      "reference_audio_total_min_seconds",
    ),
    referenceAudioTotalMaxSeconds: pickNumber(
      entry,
      "referenceAudioTotalMaxSeconds",
      "reference_audio_total_max_seconds",
    ),
    referenceVideoMinSeconds: pickNumber(
      entry,
      "referenceVideoMinSeconds",
      "reference_video_min_seconds",
    ),
    referenceVideoMaxSeconds: pickNumber(
      entry,
      "referenceVideoMaxSeconds",
      "reference_video_max_seconds",
    ),
    referenceVideoTotalMinSeconds: pickNumber(
      entry,
      "referenceVideoTotalMinSeconds",
      "reference_video_total_min_seconds",
    ),
    referenceVideoTotalMaxSeconds: pickNumber(
      entry,
      "referenceVideoTotalMaxSeconds",
      "reference_video_total_max_seconds",
    ),
    request: pickMediaRequestSchema(entry.request),
  };
}

function videoModelEntryFromString(raw: string): FreezoneVideoModelInfo {
  const providerId = inferVideoProvider(raw);
  return {
    id: raw,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

function coerceVideoModelList(payload: unknown): FreezoneVideoModelInfo[] {
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { seedance: [...], huimeng: [...] }
      const flattened: FreezoneVideoModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeVideoProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: item,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = videoModelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneVideoModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(videoModelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = videoModelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}

export async function fetchFreezoneVideoModels(
  project: string,
): Promise<FreezoneVideoModelInfo[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/models`,
  );
  return coerceVideoModelList(payload);
}

// /freezone/video/camera-templates --------------------------------------- //

export interface FreezoneVideoCameraTemplate {
  /** Stable id used by the picker + sent to backend as `camera_template_id`. */
  id: string;
  /** Display label (e.g. "镜头下降"). */
  label: string;
  /** Prompt fragment prepended to the user's prompt when this template is active. */
  promptFragment: string;
  /** Optional preview video URL. Falls back to `/video/camera-presets/<id>.mp4`. */
  videoUrl: string | null;
}

function coerceCameraTemplateList(payload: unknown): FreezoneVideoCameraTemplate[] {
  // openapi.json schema is empty `{}` — backend shape isn't documented.
  // Accept several common envelopes defensively.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.templates)) candidate = wrapper.templates;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else if (Array.isArray(wrapper.camera_templates)) candidate = wrapper.camera_templates;
  }
  if (!Array.isArray(candidate)) return [];
  const result: FreezoneVideoCameraTemplate[] = [];
  for (const item of candidate) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = pickString(entry, "id", "template_id", "templateId", "name", "key");
    if (!id) continue;
    const label =
      pickString(entry, "label", "display_name", "displayName", "title", "name") ?? id;
    const promptFragment =
      pickString(
        entry,
        "promptFragment",
        "prompt_fragment",
        "prompt",
        "fragment",
        "description",
      ) ?? label;
    const videoUrl = pickString(
      entry,
      "videoUrl",
      "video_url",
      "previewUrl",
      "preview_url",
      "thumbnail",
      "thumbnail_url",
    );
    result.push({ id, label, promptFragment, videoUrl });
  }
  return result;
}

export async function fetchFreezoneVideoCameraTemplates(
  project: string,
): Promise<FreezoneVideoCameraTemplate[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/camera-templates`,
  );
  return coerceCameraTemplateList(payload);
}

// /freezone/edit ---------------------------------------------------------- //

export interface FreezoneEditPayload extends FreezoneNodeContext {
  prompt: string;
  baseUrl: string;
  extraReferenceUrls?: string[];
  aspectRatio?: string;
  imageSize?: string;
  provider?: FreezoneProvider | null;
  model?: string | null;
  /** 注册表模型 id（还原用；与 provider 拆分后的 model 串不同）。 */
  modelId?: string | null;
  /** 生成模式（还原用）：text_to_image / image_to_image / all_reference / image_reference。 */
  genMode?: string | null;
  quality?: string | null;
}

export async function submitFreezoneEdit(
  project: string,
  payload: FreezoneEditPayload,
): Promise<FreezoneJobRef> {
  // 基准图与额外引用图同样必须是后端可解析的静态 URL，base64 先上传。
  const baseUrl = await ensureBackendImageUrl(project, payload.baseUrl);
  const extraReferenceUrls = await ensureBackendImageUrls(
    project,
    payload.extraReferenceUrls,
  );
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/edit`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        base_url: baseUrl,
        extra_reference_urls: extraReferenceUrls,
        aspect_ratio: payload.aspectRatio ?? "2:3",
        image_size: payload.imageSize ?? "2K",
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        ...(payload.modelId ? { model_id: payload.modelId } : {}),
        ...(payload.genMode ? { gen_mode: payload.genMode } : {}),
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/sketch-from-context ------------------------------------------- //

export type FreezoneSketchContextSource =
  | "beat"
  | "selected_background"
  | "director_combined"
  | "background_candidate";

export interface FreezoneSketchFromContextPayload extends FreezoneNodeContext {
  episode: number;
  beat: number;
  sourceKind?: FreezoneSketchContextSource;
  sourceUrl?: string | null;
  provider?: FreezoneProvider | null;
  model?: string | null;
  quality?: string | null;
}

export async function submitFreezoneSketchFromContext(
  project: string,
  payload: FreezoneSketchFromContextPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/sketch-from-context`,
    {
      method: "POST",
      json: {
        episode: payload.episode,
        beat: payload.beat,
        source_kind: payload.sourceKind ?? "beat",
        source_url: payload.sourceUrl ?? null,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/frame-from-context -------------------------------------------- //

export interface FreezoneFrameFromContextPayload extends FreezoneNodeContext {
  episode: number;
  beat: number;
  sketchUrl: string;
  backgroundUrl?: string | null;
  provider?: FreezoneProvider | null;
  model?: string | null;
  quality?: string | null;
}

export async function submitFreezoneFrameFromContext(
  project: string,
  payload: FreezoneFrameFromContextPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/frame-from-context`,
    {
      method: "POST",
      json: {
        episode: payload.episode,
        beat: payload.beat,
        sketch_url: payload.sketchUrl,
        background_url: payload.backgroundUrl ?? null,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/image-to-3gs --------------------------------------------------- //

/** SHARP / 3GS 来源类型；master/reverse 单面 SOG，pano 用 360 全景生成。 */
export type FreezoneImageTo3GSKind = "master" | "reverse" | "pano";

export interface FreezoneImageTo3GSPayload extends FreezoneNodeContext {
  /** 源图静态地址，通常来自 Freezone 图片节点。 */
  sourceUrl: string;
  /** 默认 master；当前 3D 世界节点仅使用 master。 */
  sourceKind?: FreezoneImageTo3GSKind;
}

export async function submitFreezoneImageTo3GS(
  project: string,
  payload: FreezoneImageTo3GSPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/image-to-3gs`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        source_kind: payload.sourceKind ?? "master",
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/extract-frames ------------------------------------------------ //

export interface FreezoneExtractPayload {
  videoUrl: string;
  maxFrames?: number;
  sceneThreshold?: number;
}

export async function submitFreezoneExtract(
  project: string,
  payload: FreezoneExtractPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/extract-frames`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        max_frames: payload.maxFrames ?? 20,
        scene_threshold: payload.sceneThreshold ?? 0.3,
      },
    },
  );
}

// /freezone/analyze-shots ------------------------------------------------- //

export interface FreezoneAnalyzePayload {
  frameUrls: string[];
  /** Analysis is a backend capability; Freezone UI sends OpenRouter by default. */
  provider?: "openrouter" | null;
  /** Optional backend model override for internal/debug use. */
  model?: string | null;
}

export async function submitFreezoneAnalyze(
  project: string,
  payload: FreezoneAnalyzePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-shots`,
    {
      method: "POST",
      json: {
        frame_urls: payload.frameUrls,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
      },
    },
  );
}

// /freezone/redraw -------------------------------------------------------- //

export type FreezoneRedrawAspectRatio =
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

/**
 * 重绘接口自身接受的比例取值（与后端 `FreezoneRedrawRequest.aspect_ratio` 的
 * Literal 保持一致）。
 *
 * 这不是某个模型的能力，而是接口契约：即便后台给模型配了别的比例档位，重绘也
 * 只能提交这几个值，所以前端取「模型配置 ∩ 接口契约」。
 */
export const FREEZONE_REDRAW_ASPECT_RATIOS: readonly FreezoneRedrawAspectRatio[] = [
  "original",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
];

export interface FreezoneRedrawPayload {
  sourceUrl: string;
  /** Optional mask static URL. Transparent pixels = editable region (局部重绘). */
  maskUrl?: string | null;
  prompt?: string;
  aspectRatio?: FreezoneRedrawAspectRatio;
  numImages?: number;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneRedraw(
  project: string,
  payload: FreezoneRedrawPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/redraw`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        mask_url: payload.maskUrl ?? null,
        prompt: payload.prompt ?? "",
        aspect_ratio: payload.aspectRatio ?? "original",
        num_images: payload.numImages ?? 1,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/upscale ------------------------------------------------------- //

export type FreezoneUpscaleScaleFactor = 2 | 4 | 6;

export interface FreezoneUpscalePayload {
  sourceUrl: string;
  scaleFactor?: FreezoneUpscaleScaleFactor;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneUpscale(
  project: string,
  payload: FreezoneUpscalePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/upscale`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        scale_factor: payload.scaleFactor ?? 2,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/outpaint ------------------------------------------------------ //

export type FreezoneOutpaintAspectRatio =
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

export interface FreezoneOutpaintPayload {
  sourceUrl: string;
  targetAspectRatio?: FreezoneOutpaintAspectRatio;
  numImages?: number;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneOutpaint(
  project: string,
  payload: FreezoneOutpaintPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/outpaint`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        target_aspect_ratio: payload.targetAspectRatio ?? "original",
        num_images: payload.numImages ?? 1,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/multi-view ---------------------------------------------------- //

export type FreezoneMultiViewPreset =
  | "custom"
  | "fisheye"
  | "oblique"
  | "front"
  | "front_up"
  | "full_body"
  | "back";

export type FreezoneMultiViewShotSize =
  | "extreme_close_up"
  | "close_up"
  | "medium_close"
  | "medium"
  | "full_body"
  | "wide"
  | "extreme_wide";

export interface FreezoneMultiViewPayload {
  sourceUrl: string;
  preset?: FreezoneMultiViewPreset;
  yawDegrees?: number;
  pitchDegrees?: number;
  shotSize?: FreezoneMultiViewShotSize;
  prompt?: string;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneMultiView(
  project: string,
  payload: FreezoneMultiViewPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/multi-view`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        preset: payload.preset ?? "custom",
        yaw_degrees: payload.yawDegrees ?? 0,
        pitch_degrees: payload.pitchDegrees ?? 0,
        shot_size: payload.shotSize ?? "medium",
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/relight ------------------------------------------------------- //

export type FreezoneRelightScope = "global" | "local";

export type FreezoneRelightKeyLightDirection =
  | "left"
  | "top"
  | "right"
  | "front"
  | "bottom"
  | "back";

export interface FreezoneRelightPayload {
  sourceUrl: string;
  lightingReferenceUrl?: string | null;
  scope?: FreezoneRelightScope;
  smartMode?: boolean;
  brightness?: number;
  colorHex?: string;
  /** 色温（开尔文）。后端 `color_temperature_kelvin: int | null`，范围 1500-10000。 */
  colorTemperatureKelvin?: number | null;
  keyLightDirection?: FreezoneRelightKeyLightDirection;
  rimLight?: boolean;
  prompt?: string;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneRelight(
  project: string,
  payload: FreezoneRelightPayload,
): Promise<FreezoneJobRef> {
  // 源图与光照参考图都要走静态 URL，base64 先上传。
  const sourceUrl = await ensureBackendImageUrl(project, payload.sourceUrl);
  const lightingReferenceUrl = payload.lightingReferenceUrl
    ? await ensureBackendImageUrl(project, payload.lightingReferenceUrl)
    : null;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/relight`,
    {
      method: "POST",
      json: {
        source_url: sourceUrl,
        lighting_reference_url: lightingReferenceUrl,
        scope: payload.scope ?? "global",
        smart_mode: payload.smartMode ?? true,
        brightness: payload.brightness ?? 50,
        color_hex: payload.colorHex ?? "#ffffff",
        color_temperature_kelvin: payload.colorTemperatureKelvin ?? null,
        key_light_direction: payload.keyLightDirection ?? "front",
        rim_light: payload.rimLight ?? false,
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/scene-360 ----------------------------------------------------- //

export interface FreezoneScene360Payload {
  referenceUrl: string;
  imageSize?: string;
  model?: string;
  /** 媒体模型目录身份，后端据此按目录定价规则计费（与前端报价同口径）。 */
  catalogId?: string;
  quality?: string;
  mode?: "candidate" | "commit";
}

/**
 * **单图 360 (simple pipeline)** — 老路径,只把一张图当 reference 走通用
 * 图编辑生成 panorama。不做 master/reverse overlap 分析、空间合约、缝合,
 * 适合 freezone 自由画布上 \"拿任一张图试试 360\" 的快速生成。
 * Asset-scoped scene 360 generation uses the scenes asset API (复杂工作流),不是这条。
 */
export async function submitFreezoneScene360(
  project: string,
  payload: FreezoneScene360Payload,
): Promise<FreezoneJobRef> {
  // 参考图必须是后端可解析的静态 URL，base64 先上传。
  const referenceUrl = await ensureBackendImageUrl(project, payload.referenceUrl);
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/scene-360`,
    {
      method: "POST",
      json: {
        reference_url: referenceUrl,
        image_size: payload.imageSize ?? "2K",
        mode: payload.mode ?? "candidate",
        // 360 的最终产物合同固定为 2:1；上游比例适配属于后端实现细节。
        // 面板上没有模型选择器，报价和执行必须使用同一个固定模型。
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.catalogId ? { catalog_id: payload.catalogId } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
      },
    },
  );
}

// /freezone/template-edit ------------------------------------------------- //

export type FreezoneTemplateEditMode =
  | "multi_camera_nine_grid"
  | "story_pitch_four_grid"
  | "character_face_three_view"
  | "product_three_view"
  | "storyboard_25_grid"
  | "cinematic_light_correction"
  | "character_three_view_generation"
  | "image_projection_after_3s"
  | "image_projection_before_5s";

export interface FreezoneTemplateEditPayload {
  sourceUrl: string;
  mode: FreezoneTemplateEditMode;
  prompt?: string;
  imageSize?: string;
  model?: string;
  /** 媒体模型目录身份，后端据此按目录定价规则计费（与前端报价同口径）。 */
  catalogId?: string;
  quality?: string;
}

export async function submitFreezoneTemplateEdit(
  project: string,
  payload: FreezoneTemplateEditPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/template-edit`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        mode: payload.mode,
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        // 同 scene-360：报价按目录首模型算，执行也必须用同一个模型/画质。
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.catalogId ? { catalog_id: payload.catalogId } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
      },
    },
  );
}

// /freezone/jobs/{type}/{id}/result --------------------------------------- //

export interface FreezoneJobResult {
  url: string;
  size: number;
}

export async function fetchFreezoneJobResult(
  project: string,
  taskType:
    | "freezone_gen"
    | "freezone_edit"
    | "freezone_upscale"
    | "freezone_extract"
    | "freezone_analyze"
    | "freezone_multi_view"
    | "freezone_relight"
    | "freezone_scene_360"
    | "freezone_template_edit"
    | "freezone_outpaint"
    | "freezone_redraw"
    | "freezone_video_gen"
    | "freezone_video_omni_gen"
    | "freezone_video_i2v"
    | "freezone_video_erase"
    | "freezone_video_compose"
    | "freezone_video_upscale"
    | "freezone_audio_separate"
    | "freezone_audio_speech"
    | "freezone_audio_eleven_music"
    | "freezone_image_reverse_prompt"
    | "freezone_text_generate"
    | "freezone_text_translate"
    | "freezone_story_script"
    | "freezone_analyze_video_story"
    | "stage_asset",
  jobId: string,
): Promise<FreezoneJobResult> {
  return await apiCall<FreezoneJobResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/${encodeURIComponent(taskType)}/${encodeURIComponent(jobId)}/result`,
  );
}

/**
 * `freezone_image_reverse_prompt` results aren't files — the dedicated job
 * result endpoint returns `{ prompt: "..." }` directly. SSE `task.result` only
 * carries `{ output_format: "json" }`, so the text must be fetched here.
 */
export interface FreezoneReversePromptResult {
  prompt: string;
}

export async function fetchFreezoneReversePromptResult(
  project: string,
  jobId: string,
): Promise<FreezoneReversePromptResult> {
  return await apiCall<FreezoneReversePromptResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_image_reverse_prompt/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/audio/references + /freezone/audio/speech -------------------- //

/**
 * 后端定义的声线 scope。
 * - project_narrator: 项目解说人
 * - character_default: 角色默认声线
 * - character_age_group: 角色年龄段声线（需要 slot）
 * - identity: 身份自己的声线（需要 identity_id）
 * - identity_resolved: 按 身份→年龄段→角色默认 兜底解析后的实际声线
 */
export type FreezoneAudioVoiceRefScope =
  | "project_narrator"
  | "user_custom"
  | "character_default"
  | "character_age_group"
  | "identity"
  | "identity_resolved";

export interface FreezoneAudioVoiceRef {
  scope: FreezoneAudioVoiceRefScope;
  /** scope=character_* / identity* 时必填，匹配项目角色名。 */
  characterName?: string;
  /** scope=identity / identity_resolved 时必填。 */
  identityId?: string;
  /** scope=character_age_group 时必填：child/youth/middle/elder。 */
  slot?: string;
  /** scope=user_custom 时必填：来自 GET/POST /freezone/audio/voices。 */
  voiceId?: string;
}

/**
 * `GET /freezone/audio/references` 返回的单条记录。openapi 没给 schema（{}），
 * 这里按后端 description 推测，UI 防御性读取——遇到陌生字段就忽略。
 */
export interface FreezoneAudioReferenceItem {
  scope: FreezoneAudioVoiceRefScope;
  /** scope=character_* 或 identity* 时有值。 */
  character_name?: string | null;
  /** scope=identity / identity_resolved 时有值。 */
  identity_id?: string | null;
  /** scope=character_age_group 时有值：child/youth/middle/elder。 */
  slot?: string | null;
  /** scope=user_custom 时有值：账号级音色 ID（来自 POST /freezone/audio/voices）。 */
  voice_id?: string | null;
  /** 展示名（后端给的，若没给前端兜底拼）。 */
  label?: string | null;
  /** 语言/腔调说明。 */
  language?: string | null;
  /** 性别（如果后端给）。 */
  gender?: string | null;
  /** 预览音频静态 URL（如果后端给）。 */
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface FreezoneAudioReferencesResult {
  /** 项目内可用的声线引用列表。 */
  available: FreezoneAudioReferenceItem[];
  [key: string]: unknown;
}

export async function fetchFreezoneAudioReferences(
  project: string,
): Promise<FreezoneAudioReferencesResult> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/audio/references`,
  );
  // 容错：后端可能直接返回数组、或 { available: [...] }，或 { items: [...] }。
  if (Array.isArray(payload)) {
    return { available: payload as FreezoneAudioReferenceItem[] };
  }
  if (payload && typeof payload === "object") {
    const wrapper = payload as Record<string, unknown>;
    if (Array.isArray(wrapper.available)) {
      return wrapper as unknown as FreezoneAudioReferencesResult;
    }
    if (Array.isArray(wrapper.items)) {
      return { available: wrapper.items as FreezoneAudioReferenceItem[] };
    }
    if (Array.isArray(wrapper.data)) {
      return { available: wrapper.data as FreezoneAudioReferenceItem[] };
    }
  }
  return { available: [] };
}

export interface FreezoneAudioSpeechPayload {
  /** 要合成的台词 / 旁白文本。 */
  text: string;
  /** 情绪提示词，留空则用项目解说风格。例："紧张、压低声音、带一点恐惧感"。 */
  emotionPrompt?: string;
  /** 声线引用；不传则用项目默认解说人。 */
  voiceRef?: FreezoneAudioVoiceRef | null;
  /** 目标 beat;给定后生成的音频会带上 beat_audio slot_target,可直接 commit。 */
  targetEpisode?: number;
  targetBeat?: number;
}

export async function submitFreezoneAudioSpeech(
  project: string,
  payload: FreezoneAudioSpeechPayload,
): Promise<FreezoneJobRef> {
  const voiceRefBody = payload.voiceRef
    ? {
        scope: payload.voiceRef.scope,
        character_name: payload.voiceRef.characterName ?? "",
        identity_id: payload.voiceRef.identityId ?? "",
        slot: payload.voiceRef.slot ?? "",
        voice_id: payload.voiceRef.voiceId ?? "",
      }
    : null;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/audio/speech`,
    {
      method: "POST",
      json: {
        text: payload.text,
        emotion_prompt: payload.emotionPrompt ?? "",
        voice_ref: voiceRefBody,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

// /freezone/audio/eleven-music ------------------------------------------- //

/**
 * 文本生成音乐请求。除 input 外全部可选，不传走后端默认。
 * model / response_format / output_format 不需要前端传（走后端默认 LingShan-MU-11 / mp3 /
 * mp3_44100_128），故不在此暴露。
 */
export interface FreezoneAudioMusicPayload {
  /** 音乐描述 prompt（风格、乐器、氛围等）；映射到后端 `input`。 */
  prompt: string;
  /** 生成长度（毫秒），范围 3000–600000，留空走后端默认 30000。 */
  musicLengthMs?: number;
  /** 是否强制纯音乐，留空走后端默认 true。 */
  forceInstrumental?: boolean;
  /** 是否严格遵守音乐段落时长策略，留空走后端默认 true。 */
  respectSectionsDurations?: boolean;
  /** 目标 beat;给定后生成的音频会带上 beat_audio slot_target,可直接 commit。 */
  targetEpisode?: number;
  targetBeat?: number;
}

/**
 * 文本生成音乐。返回异步任务句柄，结果用
 * fetchFreezoneJobResult('freezone_audio_eleven_music') 取。
 */
export async function submitFreezoneAudioMusic(
  project: string,
  payload: FreezoneAudioMusicPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/audio/eleven-music`,
    {
      method: "POST",
      json: {
        input: payload.prompt,
        music_length_ms: payload.musicLengthMs,
        force_instrumental: payload.forceInstrumental,
        respect_sections_durations: payload.respectSectionsDurations,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

// /freezone/audio/voices ------------------------------------------------- //
//
// 「我的音色」(scope=user_custom) 的列表统一通过 /freezone/audio/references
// 拿（混在 available[] 里，按 scope 过滤）。这里只保留 POST：上传一段音频克
// 隆出账号级音色。

/**
 * POST /freezone/audio/voices 的响应。openapi 是空对象，按推测字段定义。
 * 调用方一般只需要 `voice_id`，其它仅用于上传后即时展示。
 */
export interface FreezoneAudioVoiceItem {
  voice_id: string;
  name?: string | null;
  language?: string | null;
  gender?: string | null;
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface CreateFreezoneAudioVoiceOptions {
  /** 同 uploadFreezoneImage：上传大文件时用 false 关闭 ky 默认 30s 超时。 */
  timeoutMs?: number | false;
}

export async function createFreezoneAudioVoice(
  project: string,
  file: File | Blob,
  name?: string,
  options?: CreateFreezoneAudioVoiceOptions,
): Promise<FreezoneAudioVoiceItem> {
  const fd = new FormData();
  fd.append(
    "file",
    file,
    file instanceof File ? file.name : "voice.wav",
  );
  if (name && name.trim()) fd.append("name", name.trim());
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/audio/voices`,
    {
      method: "POST",
      body: fd,
      timeout: options?.timeoutMs ?? false,
    },
  ).json<{ ok: boolean; data?: FreezoneAudioVoiceItem; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "voice upload failed");
  }
  return resp.data;
}

// /freezone/text/translate ------------------------------------------------ //

export interface FreezoneTextGeneratePayload extends FreezoneNodeContext {
  prompt: string;
}

export async function submitFreezoneTextGenerate(
  project: string,
  payload: FreezoneTextGeneratePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/generate`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        ...nodeContextBody(payload),
      },
    },
  );
}

export interface FreezoneTextGenerateResult {
  generated_text: string;
  model: string;
}

export async function fetchFreezoneTextGenerateResult(
  project: string,
  jobId: string,
): Promise<FreezoneTextGenerateResult> {
  return await apiCall<FreezoneTextGenerateResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_text_generate/${encodeURIComponent(jobId)}/result`,
  );
}

export type FreezoneTextTranslateNodeType =
  | "generic"
  | "image"
  | "video"
  | "audio"
  | "text";

export interface FreezoneTextTranslatePayload extends FreezoneNodeContext {
  text: string;
  /** Hints the translator at the calling node's tone. Defaults to "generic". */
  nodeType?: FreezoneTextTranslateNodeType;
}

export async function submitFreezoneTextTranslate(
  project: string,
  payload: FreezoneTextTranslatePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/translate`,
    {
      method: "POST",
      json: {
        text: payload.text,
        node_type: payload.nodeType ?? "generic",
        ...nodeContextBody(payload),
      },
    },
  );
}

export interface FreezoneTextTranslateResult {
  translated_text: string;
  source_language: "zh" | "en";
  target_language: "zh" | "en";
  node_type: FreezoneTextTranslateNodeType;
}

export async function fetchFreezoneTextTranslateResult(
  project: string,
  jobId: string,
): Promise<FreezoneTextTranslateResult> {
  return await apiCall<FreezoneTextTranslateResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_text_translate/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/text/story-script -------------------------------------------- //

/** 角色参考输入项（角色生成脚本用）。 */
export interface FreezoneStoryScriptCharacterRef {
  /** 角色名或角色标签。 */
  name?: string;
  /** 可选：已有角色描述。 */
  description?: string;
  /** 角色参考图静态 URL（/static/...）。 */
  imageUrl?: string;
  /** 可选：角色定位或叙事功能（如「女主」）。 */
  role?: string;
}

export interface FreezoneStoryScriptPayload extends FreezoneNodeContext {
  /**
   * 文本输入：剧本 / 情节文本。后端要求 source_text / source_url / video_url /
   * character_refs 至少给一个。
   */
  sourceText?: string;
  /** 文本资源静态 URL，后端拉取后走生成流程。 */
  sourceUrl?: string;
  /** 视频输入：已上传视频的静态 URL，后端会先解析视频再生成同样的故事脚本表。 */
  videoUrl?: string;
  /** 视频总时长（秒），让脚本表的时间戳更准。 */
  durationSec?: number;
  /** 角色参考输入：无文本 / 视频时，基于角色图和描述生成故事脚本表。 */
  characterRefs?: FreezoneStoryScriptCharacterRef[];
  /** 用户额外补充的提示词（steering），例如风格、镜头偏好等。 */
  prompt?: string;
}

export async function submitFreezoneStoryScript(
  project: string,
  payload: FreezoneStoryScriptPayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = { ...nodeContextBody(payload) };
  if (payload.sourceText != null) body.source_text = payload.sourceText;
  if (payload.sourceUrl != null) body.source_url = payload.sourceUrl;
  if (payload.videoUrl != null) body.video_url = payload.videoUrl;
  if (payload.durationSec != null) body.duration_sec = payload.durationSec;
  if (payload.prompt != null) body.prompt = payload.prompt;
  if (payload.characterRefs && payload.characterRefs.length > 0) {
    body.character_refs = payload.characterRefs.map((ref) => {
      const item: Record<string, unknown> = {};
      if (ref.name != null) item.name = ref.name;
      if (ref.description != null) item.description = ref.description;
      if (ref.imageUrl != null) item.image_url = ref.imageUrl;
      if (ref.role != null) item.role = ref.role;
      return item;
    });
  }
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/story-script`,
    { method: "POST", json: body },
  );
}

/**
 * 故事脚本表的一行。字段名必须和后端 `FreezoneStoryScriptRow`
 * （`src/novelvideo/api/schemas.py`）逐字对齐 —— 早期前端用的是
 * `character` / `action` 这类简写，后端从来没发过这些 key，表格里就只显示
 * 「-」（issue #207）。
 */
export interface FreezoneStoryScriptRow {
  shot_no?: string | number | null;
  duration?: string | number | null;
  visual_description?: string | null;
  character_1?: string | null;
  character_description_1?: string | null;
  /** 角色图1 URL，由后端按角色名匹配 character_refs 回填。 */
  character_image_1?: string | null;
  character_2?: string | null;
  character_description_2?: string | null;
  /** 角色图2 URL，由后端按角色名匹配 character_refs 回填。 */
  character_image_2?: string | null;
  /** 参考图 URL，视频参考模式下由后端按 keyframe_index 回填对应关键帧。 */
  reference?: string | null;
  /** 视频参考模式下这一镜对应的输入关键帧序号（1-based，0 表示无）。 */
  keyframe_index?: number | null;
  shot?: string | null;
  character_action?: string | null;
  emotion?: string | null;
  scene_tags?: string | null;
  lighting_mood?: string | null;
  sound?: string | null;
  dialogue?: string | null;
  shot_prompt?: string | null;
  video_motion_prompt?: string | null;
  [key: string]: unknown;
}

export interface FreezoneStoryScriptResult {
  title?: string | null;
  rows: FreezoneStoryScriptRow[];
  /** 视频参考模式下抽出的关键帧静态 URL，按顺序对应 keyframe_index。 */
  frame_urls?: string[] | null;
}

export async function fetchFreezoneStoryScriptResult(
  project: string,
  jobId: string,
): Promise<FreezoneStoryScriptResult> {
  return await apiCall<FreezoneStoryScriptResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_story_script/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/upload (multipart) -------------------------------------------- //

export interface FreezoneUploadResult {
  url: string;
  filename: string;
  size: number;
}

export interface FreezoneUploadOptions {
  /**
   * Override the upload timeout. Defaults to `false` (no timeout) — a clock on
   * an upload races the user's uplink rather than the server, and aborting
   * mid-body shows up as HTTP 499 at the edge with the file never delivered
   * (see uploadApi in lib/api.ts). Pass a number only to bound a specific call.
   */
  timeoutMs?: number | false;
}

export async function uploadFreezoneImage(
  project: string,
  file: File | Blob,
  filename?: string,
  options?: FreezoneUploadOptions,
): Promise<FreezoneUploadResult> {
  const fd = new FormData();
  fd.append("file", file, filename ?? (file instanceof File ? file.name : "upload.png"));
  // ky's `body: FormData` skips the json envelope helper, so we go direct.
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/upload`,
    {
      method: "POST",
      body: fd,
      timeout: options?.timeoutMs ?? false,
    },
  ).json<{ ok: boolean; data?: FreezoneUploadResult; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "upload failed");
  }
  return resp.data;
}

export async function uploadFreezoneReferenceFile(
  project: string,
  file: File,
): Promise<FreezoneUploadResult> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/reference-file-upload`,
    {
      method: "POST",
      body: fd,
      timeout: false,
    },
  ).json<{ ok: boolean; data?: FreezoneUploadResult; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "upload failed");
  }
  return resp.data;
}

/** Same endpoint as image upload — backend treats the upload as a generic blob. */
export async function uploadFreezoneVideo(
  project: string,
  file: File | Blob,
  filename?: string,
): Promise<FreezoneUploadResult> {
  // Timeouts are off by default for uploads (see FreezoneUploadOptions):
  // video files routinely run into the tens of MB and the body is streamed, so
  // any clock cancels the request before the server sees the end of it.
  return await uploadFreezoneImage(project, file, filename);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, payload = ""] = dataUrl.split(",", 2);
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch?.[1] ?? "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function extensionForMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

/**
 * Coerce an arbitrary image reference into a backend-resolvable static path.
 *
 * - `data:` URLs are uploaded via `/freezone/upload` first; the response URL
 *   is what backends like `/freezone/image/reverse-prompt` can actually open.
 * - Anything else (already a `/static/...` path, http(s) URL, blob:, etc.) is
 *   returned as-is, minus the `?v=<ts>` cache buster that breaks backend path
 *   lookup (same strip pattern as `RedrawOverlay`).
 */
export async function ensureBackendImageUrl(
  project: string,
  rawUrl: string,
): Promise<string> {
  if (rawUrl.startsWith("data:")) {
    const blob = dataUrlToBlob(rawUrl);
    const ext = extensionForMime(blob.type);
    const uploaded = await uploadFreezoneImage(
      project,
      blob,
      `paste-${Date.now()}.${ext}`,
    );
    return uploaded.url.split("?")[0];
  }
  return rawUrl.split("?")[0];
}

/**
 * Batch variant of {@link ensureBackendImageUrl}: coerce a list of image
 * references into backend-resolvable static URLs. Empty / blank entries are
 * dropped; original order is preserved; uploads run in parallel.
 */
export async function ensureBackendImageUrls(
  project: string,
  rawUrls: readonly string[] | null | undefined,
): Promise<string[]> {
  if (!rawUrls || rawUrls.length === 0) return [];
  const cleaned = rawUrls.filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  );
  return await Promise.all(
    cleaned.map((url) => ensureBackendImageUrl(project, url)),
  );
}

// /freezone/extract-frames + analyze-shots -------------------------------- //

export interface FreezoneExtractFramesPayload {
  videoUrl: string;
  maxFrames?: number;
  sceneThreshold?: number;
}

export async function submitFreezoneExtractFrames(
  project: string,
  payload: FreezoneExtractFramesPayload,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/extract-frames`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        max_frames: payload.maxFrames ?? 20,
        scene_threshold: payload.sceneThreshold ?? 0.3,
      },
    },
  );
}

export interface FreezoneAnalyzeShotsPayload {
  frameUrls: string[];
}

export async function submitFreezoneAnalyzeShots(
  project: string,
  payload: FreezoneAnalyzeShotsPayload,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-shots`,
    {
      method: "POST",
      json: {
        frame_urls: payload.frameUrls,
      },
    },
  );
}

// /freezone/analyze-video-story ------------------------------------------ //

export interface FreezoneAnalyzeVideoStoryPayload {
  /** /static/... URL inside the project. */
  videoUrl: string;
  /** 3..50, defaults to 20 backend-side. */
  maxFrames?: number;
  /** 0..1 ffmpeg scene threshold; defaults to 0.3 backend-side. */
  sceneThreshold?: number;
  /** Optional total duration (seconds) — improves table timestamp accuracy. */
  durationSec?: number;
}

export async function submitFreezoneAnalyzeVideoStory(
  project: string,
  payload: FreezoneAnalyzeVideoStoryPayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    video_url: payload.videoUrl,
  };
  if (payload.maxFrames != null) body.max_frames = payload.maxFrames;
  if (payload.sceneThreshold != null) body.scene_threshold = payload.sceneThreshold;
  if (payload.durationSec != null) body.duration_sec = payload.durationSec;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-video-story`,
    { method: "POST", json: body },
  );
}

// /freezone/video/character-library -------------------------------------- //

export type FreezoneAssetLibraryMedia = "image" | "video" | "audio";
export type FreezoneAssetLibrarySource =
  | "upload"
  | "character"
  | "scene"
  | "prop";

/** 用途类目。老条目没有该字段，读取侧按 source/media 兜底推导。 */
export type FreezoneAssetLibraryCategory =
  | "other"
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "audio";

/**
 * 用户自建的资产库文件夹。系统文件夹（主线 / 待分类资产 / 各类目同名目录）不落盘，
 * 由前端按保留 key 生成，只有这里的自建文件夹会从后端读回来。
 */
export interface FreezoneAssetLibraryFolder {
  id: string;
  name: string;
  /** 封面图 URL，取自文件夹内某个素材；没设过时为空,前端画默认文件夹图标。 */
  cover?: string | null;
  created_at?: string;
}

export interface FreezoneVideoCharacterLibraryItem {
  id?: string;
  name: string;
  media?: FreezoneAssetLibraryMedia;
  source?: FreezoneAssetLibrarySource;
  category?: FreezoneAssetLibraryCategory;
  /** 保存位置：系统文件夹 key 或自建文件夹 id。老条目没有，读取侧按类目兜底。 */
  folder?: string;
  image_urls?: string[];
  video_url?: string | null;
  audio_url?: string | null;
  cover_url?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface FreezoneAddVideoCharacterLibraryItemPayload {
  name: string;
  media?: FreezoneAssetLibraryMedia;
  imageUrls?: string[];
  videoUrl?: string;
  audioUrl?: string;
  category?: FreezoneAssetLibraryCategory;
  folder?: string;
}

export async function fetchFreezoneVideoCharacterLibrary(
  project: string,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library`,
  );
}

export async function submitFreezoneAddVideoCharacterLibraryItem(
  project: string,
  payload: FreezoneAddVideoCharacterLibraryItemPayload,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    name: payload.name,
    media: payload.media ?? "image",
  };
  if (payload.imageUrls && payload.imageUrls.length > 0) {
    body.image_urls = payload.imageUrls;
  }
  if (payload.videoUrl) body.video_url = payload.videoUrl;
  if (payload.audioUrl) body.audio_url = payload.audioUrl;
  if (payload.category) body.category = payload.category;
  if (payload.folder) body.folder = payload.folder;
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library`,
    { method: "POST", json: body },
  );
}

export async function fetchFreezoneAssetLibraryFolders(
  project: string,
): Promise<FreezoneAssetLibraryFolder[]> {
  return await apiCall<FreezoneAssetLibraryFolder[]>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders`,
  );
}

export async function createFreezoneAssetLibraryFolder(
  project: string,
  name: string,
): Promise<FreezoneAssetLibraryFolder> {
  return await apiCall<FreezoneAssetLibraryFolder>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders`,
    { method: "POST", json: { name } },
  );
}

/** 改名 / 换封面。只传要改的字段,另一个原样保留。 */
export async function updateFreezoneAssetLibraryFolder(
  project: string,
  folderId: string,
  patch: { name?: string; cover?: string },
): Promise<FreezoneAssetLibraryFolder> {
  return await apiCall<FreezoneAssetLibraryFolder>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders/${encodeURIComponent(folderId)}`,
    { method: "PATCH", json: patch },
  );
}

/** 整柜清空:删掉文件夹连同里面的素材。返回被删掉的素材条数。 */
export async function deleteFreezoneAssetLibraryFolder(
  project: string,
  folderId: string,
): Promise<{ deleted_items: number }> {
  return await apiCall<{ deleted_items: number }>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

/**
 * 把主线的人物/场景/道具参考图与人物语音幂等同步进资产库。后端按稳定合成 id
 * upsert,重复同步只更新不重复。返回同步后的完整库(apiCall 会解包 data)。
 */
export async function syncFreezoneAssetLibraryFromMainline(
  project: string,
): Promise<FreezoneVideoCharacterLibraryItem[]> {
  return await apiCall<FreezoneVideoCharacterLibraryItem[]>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/sync-from-mainline`,
    { method: "POST" },
  );
}

/**
 * 给资产库条目改名。只动展示名，素材地址不变——画布上已经引用它的节点不受影响。
 *
 * 主线同步来的条目改了名会在下次「从主线同步」时被覆盖回去，所以调用侧只对本地
 * 上传的条目开放这个入口。
 */
export async function renameFreezoneVideoCharacterLibraryItem(
  project: string,
  itemId: string,
  name: string,
): Promise<FreezoneVideoCharacterLibraryItem> {
  return await apiCall<FreezoneVideoCharacterLibraryItem>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library/${encodeURIComponent(itemId)}`,
    { method: "PATCH", json: { name } },
  );
}

export async function deleteFreezoneVideoCharacterLibraryItem(
  project: string,
  itemId: string,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

// /freezone/init ---------------------------------------------------------- //

export async function initFreezone(project: string): Promise<{ freezone_dir: string }> {
  return await apiCall<{ freezone_dir: string }>(
    `projects/${encodeURIComponent(project)}/freezone/init`,
    { method: "POST" },
  );
}
