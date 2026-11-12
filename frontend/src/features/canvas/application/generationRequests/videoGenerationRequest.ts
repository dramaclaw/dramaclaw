// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoEnhancementModel, FreezoneVideoTargetFps, FreezoneVideoSlowdown, FreezoneVideoScene } from '@/api/ops';
import {
  isAudioNode, isExportImageNode, isImageEditNode, isImageGenNode, isStoryboardGenNode,
  isUploadNode, isVideoNode, type CanvasNode, type CanvasEdge, type VideoNodeData,
} from '../../domain/canvasNodes';
import { selectVideoModel } from '../../domain/catalogVideoModels';
import { snapToAllowedAspectRatio } from '../../domain/aspectRatio';
import { CAMERA_MOVEMENT_PRESETS, findCameraMovementPreset } from '../../domain/cameraMovementPresets';
import type { CameraMovementPreset } from '../../domain/cameraMovementPresets';
import { FALLBACK_VIDEO_ASPECT_OPTIONS } from '../../domain/mediaModelOptions';
import type { ModelOption } from '../../domain/modelOptions';
import { sortUpstreamByReferenceOrder, videoReferenceNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import {
  DEFAULT_DURATION_MIN, videoQualityOptionsForModel, normalizeVideoQuality, videoDurationBoundsForModel,
  sceneOptimizeOptionsForModel, defaultSceneOptimizeForModel, normalizeSceneOptimize,
} from '../../nodes/shared/videoGenerationOptions';
import { clampVideoDuration, hasConfiguredReferenceCaps, referenceCapsForMode } from '../../nodes/shared/videoFormOptions';
import {
  audioReferenceDurationRejection, type AudioDurationRejection, referenceDurationLimitsMs,
  isSeedance2VideoModel, isVideoModeSupportedByModel, MIN_AUDIO_REFERENCE_DURATION_MS,
  MAX_AUDIO_REFERENCE_DURATION_MS, MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  resolveVideoKeyframeUrls, videoModeForcesAutomaticAspectRatio, videoModeRequiresMedia,
  videoModeRequiresPrompt, videoModelDefaultGenerateAudio, videoModelReferenceDisabledReason,
  videoModelSupportsGenerateAudio, videoSubmitMediaRejectionReason,
} from '../../nodes/shared/videoModelCapabilities';
import { VIDEO_UPSCALE_RESOLUTIONS } from '../../domain/videoUpscaleResolutions';
import { referenceVideoUrl } from '../../nodes/referenceMedia';
import { extendRangeNeedsTrim, formatTimecode, type ExtendClipRange } from '../videoExtendClip';
import { extractUpstreamContent, joinUpstreamText } from '../graphContentResolver';
import type { CompileWorkflowNodePromptInput } from '../workflowRecipeRuntime';
import { nodeContextWireFields } from './nodeContextWire';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export interface VideoGenerationRequestContext {
  /** Current graph, after any continuity/media preparation and mode normalization. */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  nodeId: string;
  projectId: string;
  /** Page canvas id, with the browser's 'default' fallback applied by the caller. */
  canvasId: string;
  /** Resolved catalog; the caller supplies any list-level fallback. */
  videoModels: ModelOption[];
  /** Resolved camera templates; null or an empty list uses the bundled presets. */
  cameraTemplates: ReadonlyArray<CameraMovementPreset> | null;
  executionSource: 'manual' | 'workflow';
  productOperation: WorkflowProductOperationContext | null;
  inlineMedia?: 'refuse' | 'forward';
  /** URL-keyed probe results in milliseconds. A missing key is unprobed; null records failure. */
  mediaDurationsMs?: Record<string, number | null>;
  /** Translation used by the component; required when an extension prefix is needed. */
  translate?: (key: string, options?: Record<string, unknown>) => string;
  /** Uploaded replacement for exactly the source URL and range requested below. */
  preparedExtendClip?: {
    sourceUrl: string; startMs: number; endMs: number; url: string; durationMs: number;
  };
  /** Resolved task activity, when available; mirrors the browser task-state hook. */
  isGenerating?: boolean;
}

export type VideoPromptCompileInput = Omit<CompileWorkflowNodePromptInput,
  'nodeId' | 'nodeData' | 'executionSource' | 'onCompileMetadata'>;
export interface VideoGenerationHttpRequest {
  method: 'POST';
  /** Relative to the API base. */
  path: string;
  body: Record<string, unknown>;
}
export type VideoGenerationRefusalCode = 'not_video_node' | 'no_model'
  | 'no_project' | 'generation_in_progress' | 'no_effective_prompt' | 'missing_media'
  | 'reference_limit_exceeded' | 'model_capability_error' | 'inline_media_reference'
  | 'missing_source_video' | 'missing_references' | 'mode_unsupported_by_model'
  | 'extend_clip_not_prepared' | 'reference_duration_invalid' | 'missing_upscale_source';
export type VideoGenerationRequestResult = { ok: true; requests: VideoGenerationHttpRequest[] }
  | { ok: false; code: Exclude<VideoGenerationRefusalCode, 'reference_duration_invalid'>;
    message: string; phase: 'guard' | 'keyframes' | 'images' | 'references' }
  | { ok: false; code: 'reference_duration_invalid'; message: string; phase: 'duration';
    media: 'audio' | 'video'; rejection: AudioDurationRejection;
    durationLimits: { minMs?: number; maxMs?: number } };

/**
 * Browser outcomes: busy/model/capability/cap/prompt/media/project guards and
 * missing source/references return silently (subscriber publishes SUCCESS).
 * Unsupported omni's branch shows a dialog and returns SUCCESS without a node
 * error; normal mounting can normalize the mode before that branch is reachable.
 * Duration rejection writes referenceValidation.title as a node error, which the
 * subscriber publishes as an error. Missing upscale source is a published error.
 * Wrong-node is a pure boundary check. Inline URLs and missing
 * prepared clips are caller preparation refusals: the browser can forward inline
 * media/files, blocks inline links as invalid, and performs its own trim/upload.
 */
const NOT_VIDEO_NODE = 'The target node must be a video node.';
function refuse(code: Exclude<VideoGenerationRefusalCode, 'reference_duration_invalid'>, message: string,
  phase: 'guard' | 'keyframes' | 'images' | 'references' = 'guard'): VideoGenerationRequestResult {
  return { ok: false, code, message, phase };
}
function nodeData(ctx: VideoGenerationRequestContext): VideoNodeData | undefined {
  const node = ctx.nodes.find((candidate) => candidate.id === ctx.nodeId);
  return isVideoNode(node) ? node.data : undefined;
}

// Preview URLs enable the form, but submission only consumes source images.
function imageUrls(node: CanvasNode): { preview: string | null; source: string | null } {
  if (isImageGenNode(node)) {
    const ref = typeof node.data.referenceImageUrl === 'string' && node.data.referenceImageUrl.length > 0
      ? node.data.referenceImageUrl : null;
    return { preview: node.data.previewImageUrl || node.data.imageUrl || ref,
      source: node.data.imageUrl || ref };
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node) || isStoryboardGenNode(node)) {
    return { preview: node.data.previewImageUrl || node.data.imageUrl || null, source: node.data.imageUrl || null };
  }
  return { preview: null, source: null };
}
function upstream(ctx: VideoGenerationRequestContext) {
  return videoReferenceNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId);
}

function extensionRange(data: VideoNodeData): ExtendClipRange | null {
  return data.isExtendMode && typeof data.extendStartMs === 'number' && typeof data.extendEndMs === 'number'
    ? { startMs: data.extendStartMs, endMs: data.extendEndMs } : null;
}
function extensionNeedsTrim(ctx: VideoGenerationRequestContext, range: ExtendClipRange): boolean {
  const data = nodeData(ctx);
  const source = sortUpstreamByReferenceOrder(upstream(ctx), data?.referenceOrder).find(referenceVideoUrl);
  // Prefix/trim selection uses stored source duration only, never a measured probe.
  const duration = source?.data.durationMs;
  return extendRangeNeedsTrim(range, typeof duration === 'number' && duration > 0 ? duration : null);
}

/** Exact source and range for the browser trim call; null when no clip is submitted. */
export function videoExtendTrimRequirement(
  ctx: VideoGenerationRequestContext,
): { videoUrl: string; startMs: number; endMs: number } | null {
  const data = nodeData(ctx);
  if (!data || data.isUpscaleNode || data.genMode !== 'allReference') return null;
  const range = extensionRange(data);
  if (!range || !extensionNeedsTrim(ctx, range)) return null;
  const model = selectVideoModel(ctx.videoModels, data.model);
  const caps = referenceCapsForMode(model, 'allReference');
  if (!caps || caps.video <= 0) return null;
  const video = collectOmniReferences(ctx, data, model).videoRefs[0];
  return video ? { videoUrl: video.url, ...range } : null;
}

function extensionPrefix(ctx: VideoGenerationRequestContext, data: VideoNodeData): string {
  const range = extensionRange(data);
  if (!range) return '';
  if (!ctx.translate) throw new Error('An extension prompt requires context.translate.');
  const sourceName = typeof data.extendSourceName === 'string' ? data.extendSourceName : '';
  const name = sourceName.trim() || ctx.translate('canvas.videoExtend.defaultSourceName');
  return extensionNeedsTrim(ctx, range)
    ? ctx.translate('canvas.videoExtend.promptPrefixTrimmed', { name })
    : ctx.translate('canvas.videoExtend.promptPrefix', {
      name, start: formatTimecode(range.startMs), end: formatTimecode(range.endMs),
    });
}

interface DurationReference { url: string; nodeId: string; label: string; durationMs: number | null }
interface MediaReference { type: 'image' | 'video' | 'audio' | 'file' | 'link'; url: string; role: string; label: string }
function audioLabel(node: CanvasNode): string {
  return (typeof node.data.sourceFileName === 'string' ? node.data.sourceFileName : '')
    || (typeof node.data.displayName === 'string' ? node.data.displayName : '');
}
function durationReference(ctx: VideoGenerationRequestContext, node: CanvasNode, url: string,
  media: 'audio' | 'video', index: number): DurationReference {
  const rawLabel = media === 'audio' ? audioLabel(node) : '';
  const key = media === 'audio' ? 'node.videoNode.audio.clipFallbackLabel'
    : 'node.videoNode.referenceDuration.videoFallbackLabel';
  return { url, nodeId: node.id, label: rawLabel || (ctx.translate?.(key, { index }) ?? key),
    durationMs: typeof node.data.durationMs === 'number' ? node.data.durationMs : null };
}

function collectOmniReferences(ctx: VideoGenerationRequestContext, data: VideoNodeData,
  model: ModelOption | null | undefined) {
  const caps = referenceCapsForMode(model, 'allReference') ?? { image: 9, video: 3, audio: 3 };
  const total = hasConfiguredReferenceCaps(model) ? caps.image + caps.video + caps.audio : 12;
  const references: MediaReference[] = [];
  const audioRefs: DurationReference[] = [];
  const videoRefs: DurationReference[] = [];
  let imageCount = 0;
  for (const node of sortUpstreamByReferenceOrder(upstream(ctx), data.referenceOrder)) {
    if (references.length >= total) break;
    const videoUrl = referenceVideoUrl(node);
    if (videoUrl) {
      if (videoRefs.length < caps.video) {
        references.push({ type: 'video', url: videoUrl, role: '', label: '' });
        videoRefs.push(durationReference(ctx, node, videoUrl, 'video', videoRefs.length + 1));
      }
    } else if (isAudioNode(node)) {
      const url = typeof node.data.audioUrl === 'string' ? node.data.audioUrl : '';
      if (url && audioRefs.length < caps.audio) {
        const label = audioLabel(node);
        references.push({ type: 'audio', url, role: '配乐参考', label }); // i18n-exempt -- exact wire or subscriber contract
        audioRefs.push(durationReference(ctx, node, url, 'audio', audioRefs.length + 1));
      }
    } else {
      const url = imageUrls(node).source;
      if (url && imageCount < caps.image) {
        references.push({ type: 'image', url, role: '', label: '' });
        imageCount += 1;
      }
    }
  }
  if (data.referenceFileUrl?.trim()) {
    references.push({ type: 'file', url: data.referenceFileUrl.trim(), role: '文件参考', label: data.referenceFileName ?? '' }); // i18n-exempt -- exact wire or subscriber contract
  } else if (data.referenceLink?.trim()) {
    references.push({ type: 'link', url: data.referenceLink.trim(), role: '网页参考', label: '' }); // i18n-exempt -- exact wire or subscriber contract
  }
  return { references, audioRefs, videoRefs };
}

function durationLimits(model: ModelOption, media: 'audio' | 'video') {
  const configured = referenceDurationLimitsMs(model, media);
  const familyFallback = media === 'audio' && isSeedance2VideoModel(model.apiModel ?? model.id);
  return {
    minMs: configured.minMs ?? (familyFallback ? MIN_AUDIO_REFERENCE_DURATION_MS : undefined),
    maxMs: configured.maxMs ?? (familyFallback ? MAX_AUDIO_REFERENCE_DURATION_MS : undefined),
    totalMinMs: configured.totalMinMs,
    totalMaxMs: configured.totalMaxMs ?? (familyFallback ? MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS : undefined),
  };
}
function validateDurations(ctx: VideoGenerationRequestContext, model: ModelOption,
  media: 'audio' | 'video', refs: DurationReference[]): VideoGenerationRequestResult | null {
  const limits = durationLimits(model, media);
  if (!refs.length || Object.values(limits).every((value) => value == null)) return null;
  const rejection = audioReferenceDurationRejection(refs.map((ref, index) => ({
    ...ref, index: index + 1, durationMs: typeof ref.durationMs === 'number' && ref.durationMs > 0
      ? ref.durationMs : ctx.mediaDurationsMs?.[ref.url] ?? null,
  })), { minMs: limits.minMs ?? null, maxMs: limits.maxMs ?? null, totalMinMs: limits.totalMinMs,
    totalLimitMs: limits.totalMaxMs ?? null, perClipLimits: limits.minMs != null || limits.maxMs != null });
  // The component writes referenceValidation.title to the node; the subscriber publishes an error.
  return rejection ? { ok: false, code: 'reference_duration_invalid',
    message: 'Reference duration is outside the model limits.', phase: 'duration', media, rejection,
    durationLimits: { ...(limits.minMs !== undefined ? { minMs: limits.minMs } : {}),
      ...(limits.maxMs !== undefined ? { maxMs: limits.maxMs } : {}) } } : null;
}

function documentReferenceInvalid(data: VideoNodeData, model: ModelOption): boolean {
  const file = data.referenceFileUrl?.trim();
  const link = data.referenceLink?.trim();
  if (file && link) return true;
  if (file) {
    if ((model.referenceFileMax ?? 0) < 1) return true;
    let extension = '';
    try { extension = new URL(file, 'https://canvas.example.test').pathname.split('.').pop()?.toLowerCase() ?? ''; }
    catch { /* The component treats an unparseable file URL as an empty extension. */ }
    return Boolean(model.referenceFileTypes?.length && !model.referenceFileTypes.includes(extension));
  }
  if (link) {
    if ((model.referenceLinkMax ?? 0) < 1) return true;
    try {
      const parsed = new URL(link);
      return !((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
        && !parsed.username && !parsed.password);
    } catch { return true; }
  }
  return false;
}

function requestResult(ctx: VideoGenerationRequestContext, route: string, body: Record<string, unknown>, count = 1): VideoGenerationRequestResult {
  return { ok: true, requests: Array.from({ length: count }, () => ({ method: 'POST',
    path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/video/${route}`, body: structuredClone(body) })) };
}
export function videoUpscaleInput(data: VideoNodeData | Record<string, unknown>): {
  sourceUrl: string; resolution: typeof VIDEO_UPSCALE_RESOLUTIONS[number];
  enhancementModel?: VideoEnhancementModel;
  targetFps?: FreezoneVideoTargetFps;
  slowdown?: FreezoneVideoSlowdown;
  smartInterpolation?: boolean;
  scene?: FreezoneVideoScene;
  faceEnhance?: boolean;
} {
  const settings: Partial<ReturnType<typeof videoUpscaleInput>> = {};
  if (data.upscaleEnhancementModel === 'standard' || data.upscaleEnhancementModel === 'topaz') settings.enhancementModel = data.upscaleEnhancementModel;
  if (data.upscaleTargetFps === 'auto' || (typeof data.upscaleTargetFps === 'number'
    && Number.isFinite(data.upscaleTargetFps) && data.upscaleTargetFps > 0)) settings.targetFps = data.upscaleTargetFps;
  if (data.upscaleSlowdown === 'auto' || data.upscaleSlowdown === '2x' || data.upscaleSlowdown === '3x'
    || data.upscaleSlowdown === '4x' || data.upscaleSlowdown === '5x') settings.slowdown = data.upscaleSlowdown;
  if (typeof data.upscaleSmartInterpolation === 'boolean') settings.smartInterpolation = data.upscaleSmartInterpolation;
  if (data.upscaleScene === 'realistic' || data.upscaleScene === 'anime') settings.scene = data.upscaleScene;
  if (typeof data.upscaleFaceEnhance === 'boolean') settings.faceEnhance = data.upscaleFaceEnhance;
  return { sourceUrl: typeof data.upscaleSourceUrl === 'string' ? data.upscaleSourceUrl : '',
    resolution: VIDEO_UPSCALE_RESOLUTIONS.find(value => value === data.upscaleResolution) ?? '1080p', ...settings };
}

export function videoUpscaleWireRequest(input: Pick<VideoGenerationRequestContext,
  'projectId' | 'canvasId' | 'nodeId' | 'productOperation'> & ReturnType<typeof videoUpscaleInput>): VideoGenerationHttpRequest {
  return { method: 'POST', path: `projects/${encodeURIComponent(input.projectId)}/freezone/video/upscale`,
    body: { source_url: input.sourceUrl.split('?')[0], enhancement_model: input.enhancementModel ?? 'standard',
      resolution: input.resolution,
      ...(input.targetFps === undefined ? {} : { target_fps: input.targetFps === 'auto' ? null : input.targetFps }),
      slowdown: input.slowdown ?? 'auto', smart_interpolation: input.smartInterpolation ?? true,
      scene: input.scene ?? 'realistic', face_enhance: input.faceEnhance ?? false,
      ...nodeContextWireFields(input) } };
}

function buildUpscale(ctx: VideoGenerationRequestContext, data: VideoNodeData): VideoGenerationRequestResult {
  const input = videoUpscaleInput(data);
  // Published directly by the subscriber, before checking project/model/busy state.
  if (!input.sourceUrl) return refuse('missing_upscale_source', '缺少高清视频源'); // i18n-exempt -- exact wire or subscriber contract
  // A missing project silently returns; the subscriber then publishes success.
  if (!ctx.projectId) return refuse('no_project', 'A project is required.');
  if (ctx.inlineMedia !== 'forward' && input.sourceUrl.startsWith('data:')) return refuse('inline_media_reference', 'Upload inline media before building a video request.');
  return { ok: true, requests: [videoUpscaleWireRequest({ ...ctx, ...input })] };
}

function collectEditReferences(ctx: VideoGenerationRequestContext, data: VideoNodeData, model: ModelOption) {
  const ordered = sortUpstreamByReferenceOrder(upstream(ctx), data.referenceOrder);
  const caps = referenceCapsForMode(model, 'videoEdit');
  const images = ordered.flatMap(node => {
    const url = imageUrls(node).source;
    return url ? [url] : [];
  });
  const audioRefs = ordered.filter(isAudioNode).map((node, index) => durationReference(ctx, node,
    typeof node.data.audioUrl === 'string' ? node.data.audioUrl : '', 'audio', index + 1))
    .filter(ref => ref.url.length > 0).slice(0, caps?.audio ?? 0);
  return { videoUrl: ordered.map(referenceVideoUrl).find(url => url !== null) ?? '',
    images, imageLimit: caps?.image ?? 5, audioRefs };
}

function preparedOmniReferences(ctx: VideoGenerationRequestContext, data: VideoNodeData, model: ModelOption) {
  const collected = collectOmniReferences(ctx, data, model);
  const requirement = videoExtendTrimRequirement(ctx);
  const clip = ctx.preparedExtendClip;
  const prepared = !requirement || Boolean(clip && clip.sourceUrl === requirement.videoUrl
    && clip.startMs === requirement.startMs && clip.endMs === requirement.endMs);
  if (requirement && prepared && clip) {
    const ref = collected.references.find(item => item.type === 'video');
    if (ref) ref.url = clip.url;
    collected.videoRefs[0] = { ...collected.videoRefs[0], url: clip.url, durationMs: clip.durationMs };
  }
  return { ...collected, prepared };
}

export function videoEditImageOverflow(ctx: VideoGenerationRequestContext): { limit: number; ignored: number } | null {
  const data = nodeData(ctx);
  if (!data || data.isUpscaleNode || data.genMode !== 'videoEdit') return null;
  const model = selectVideoModel(ctx.videoModels, data.model);
  if (!model) return null;
  const { images, imageLimit } = collectEditReferences(ctx, data, model);
  return images.length > imageLimit ? { limit: imageLimit, ignored: images.length - imageLimit } : null;
}

/** Probe one media stage at a time; audio rejection prevents probing later video references. */
export function videoReferenceDurationProbe(ctx: VideoGenerationRequestContext): {
  media: 'audio' | 'video'; urls: string[];
} | null {
  const data = nodeData(ctx);
  if (!data || data.isUpscaleNode || (data.genMode !== 'videoEdit' && data.genMode !== 'allReference')) return null;
  const model = selectVideoModel(ctx.videoModels, data.model);
  if (!model) return null;
  const stages: { media: 'audio' | 'video'; refs: DurationReference[] }[] = [];
  if (data.genMode === 'videoEdit') {
    stages.push({ media: 'audio', refs: collectEditReferences(ctx, data, model).audioRefs });
  } else {
    const refs = preparedOmniReferences(ctx, data, model);
    if (!refs.prepared) return null;
    stages.push({ media: 'audio', refs: refs.audioRefs }, { media: 'video', refs: refs.videoRefs });
  }
  for (const { media, refs } of stages) {
    if (Object.values(durationLimits(model, media)).every(value => value == null)) continue;
    const urls = refs.filter(ref => !(typeof ref.durationMs === 'number' && ref.durationMs > 0)
      && !Object.prototype.hasOwnProperty.call(ctx.mediaDurationsMs ?? {}, ref.url)).map(ref => ref.url);
    if (urls.length) return { media, urls };
    if (validateDurations(ctx, model, media, refs)) return null;
  }
  return null;
}

function buildVideoMediaRequest(ctx: VideoGenerationRequestContext, data: VideoNodeData, model: ModelOption,
  mode: 'videoEdit' | 'videoExtend' | 'allReference', body: Record<string, unknown>, count: number): VideoGenerationRequestResult {
  const { prompt, camera_template_id, marks, aspect_ratio, resolution, duration_seconds,
    generate_audio, model: modelId, model_id, gen_mode, human_review, scene_optimize } = body;
  const inline = (urls: string[]) => ctx.inlineMedia !== 'forward' && urls.some(url => url.startsWith('data:'));
  const context = nodeContextWireFields({ ...ctx, modelParams: data.modelParams });
  if (mode === 'videoEdit' || mode === 'videoExtend') {
    const edit = collectEditReferences(ctx, data, model);
    const imageUrlsToSubmit = mode === 'videoEdit' ? edit.images.slice(0, edit.imageLimit) : [];
    const audioRefs = mode === 'videoEdit' ? edit.audioRefs : [];
    const audioUrls = audioRefs.map(ref => ref.url);
    if (inline([edit.videoUrl, ...imageUrlsToSubmit, ...audioUrls])) {
      return refuse('inline_media_reference', 'Upload inline media before building a video request.');
    }
    const rejection = validateDurations(ctx, model, 'audio', audioRefs);
    if (rejection) return rejection;
    return mode === 'videoEdit'
      ? requestResult(ctx, 'video-edit', { video_url: edit.videoUrl, image_urls: imageUrlsToSubmit,
        audio_urls: audioUrls, prompt, camera_template_id, marks, resolution, audio_setting: 'auto',
        generate_audio, model: modelId, model_id, gen_mode, human_review, ...context }, count)
      : requestResult(ctx, 'video-extend', { video_url: edit.videoUrl, prompt, camera_template_id,
        resolution, duration_seconds, generate_audio, model: modelId, model_id, gen_mode, human_review, ...context }, count);
  }
  const { references, audioRefs, videoRefs, prepared } = preparedOmniReferences(ctx, data, model);
  if (!references.length) return refuse('missing_references', 'At least one reference is required.', 'references');
  if (!prepared) return refuse('extend_clip_not_prepared', 'Prepare the selected extension clip before building the request.', 'references');
  if (inline(references.map(ref => ref.url))) {
    return refuse('inline_media_reference', 'Upload inline media before building a video request.');
  }
  const rejection = validateDurations(ctx, model, 'audio', audioRefs) ?? validateDurations(ctx, model, 'video', videoRefs);
  if (rejection) return rejection;
  return requestResult(ctx, 'omni-gen', { prompt, theme: '', camera_template_id, references, marks,
    aspect_ratio, resolution, duration_seconds, generate_audio, model: modelId, model_id, gen_mode,
    ...(data.isExtendMode ? { continuation: true } : {}), human_review, scene_optimize, ...context }, count);
}

function submitAspectRatio(data: VideoNodeData, model: ModelOption): string {
  if (videoModeForcesAutomaticAspectRatio(data.genMode ?? 'textToVideo') || Boolean(data.isExtendMode)) return 'auto';
  const ratios = (model.ratioOptions ?? []).map((item) => item.trim()).filter(Boolean);
  const storedRatio = String(data.aspectRatio);
  if (ratios.length) return ratios.includes(storedRatio) ? storedRatio : ratios[0];
  const fallbackRatios = FALLBACK_VIDEO_ASPECT_OPTIONS.filter((ratio) => ratio !== 'auto');
  const ratio = FALLBACK_VIDEO_ASPECT_OPTIONS.includes(storedRatio) ? storedRatio
    : snapToAllowedAspectRatio(String(data.aspectRatio ?? ''), fallbackRatios, '16:9');
  if (ratio !== 'auto') return ratio;
  const dimensions = typeof data.widthPx === 'number' && typeof data.heightPx === 'number'
    && data.widthPx > 0 && data.heightPx > 0 ? `${data.widthPx}:${data.heightPx}` : '';
  return snapToAllowedAspectRatio(dimensions, fallbackRatios, '16:9');
}

/**
 * Recipe compiler input for the VideoNode agent path. The graph must already
 * contain any prepared continuity frames and prompt. Throws for a non-video target.
 */
export function videoPromptCompileInput(ctx: VideoGenerationRequestContext): VideoPromptCompileInput {
  const data = nodeData(ctx);
  if (!data) throw new Error(NOT_VIDEO_NODE);
  const upstreamContents = upstream(ctx).map(extractUpstreamContent);
  const upstreamText = joinUpstreamText(upstreamContents);
  const nodePrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  const fragment = cameraFragment(ctx, data);
  const userPrompt = [upstreamText, nodePrompt].filter((text) => text.length > 0).join('\n\n');
  return {
    nodeKind: 'video', nodePrompt, upstreamText, upstreamContents,
    fallbackPrompt: extensionPrefix(ctx, data) + (fragment ? userPrompt ? `${fragment}，${userPrompt}` : fragment : userPrompt),
  };
}

function cameraFragment(ctx: VideoGenerationRequestContext, data: VideoNodeData) {
  const templates = ctx.cameraTemplates?.length ? ctx.cameraTemplates : CAMERA_MOVEMENT_PRESETS;
  return findCameraMovementPreset(templates, data.cameraMovement)?.promptFragment;
}

/** Continuity replaces the prompt after preparation, retaining render-time upstream text. */
export function videoContinuityCompileInput(ctx: VideoGenerationRequestContext, livePrompt: unknown): VideoPromptCompileInput {
  const base = videoPromptCompileInput(ctx);
  const data = nodeData(ctx);
  if (!data) throw new Error(NOT_VIDEO_NODE);
  const renderPrompt = typeof data.prompt === 'string' ? data.prompt : '';
  const nodePrompt = String(livePrompt ?? renderPrompt).trim();
  const continuity = [base.upstreamText, nodePrompt].filter(Boolean).join('\n\n');
  const fragment = cameraFragment(ctx, data);
  return { ...base, nodePrompt, fallbackPrompt: continuity
    ? fragment ? `${fragment}，${continuity}` : continuity : base.fallbackPrompt };
}

/** Recipe metadata to persist after compilation; the caller supplies the timestamp. */
export function videoPromptCompileMetadataPatch(
  { mode, prompt, recipeIds }: Parameters<NonNullable<CompileWorkflowNodePromptInput['onCompileMetadata']>>[0],
  compiledAt: string,
) {
  return { workflowRecipeCompileMode: mode, workflowRecipeCompiledAt: compiledAt,
    workflowRecipeCompiledPrompt: prompt, prompt, workflowRecipeIds: recipeIds };
}

/**
 * Build VideoNode HTTP JSON without submitting. Recipe compilation, continuity
 * preparation, trimmed-clip uploads, measured durations, billing-rule checks and
 * model-access checks stay with the caller. Inline media is refused unless forwarding is requested.
 * Supply a normalized graph snapshot for each phase: references are reread after compilation.
 * These modes send the compiled prompt unchanged. Supply normalized mode/model state and an explicit
 * translator for extension prefixes. Refusals describe browser outcomes above;
 * applying the corresponding node error/result patch is the caller's next step.
 */
export function buildVideoGenerationRequest(
  ctx: VideoGenerationRequestContext & { prompt: string },
): VideoGenerationRequestResult {
  const data = nodeData(ctx);
  if (!data) return refuse('not_video_node', NOT_VIDEO_NODE);
  const mode = data.genMode ?? 'textToVideo';
  if (data.isUpscaleNode === true) return buildUpscale(ctx, data);
  const model = selectVideoModel(ctx.videoModels, data.model);
  if (!model) return refuse('no_model', 'No video model is available.');
  if (ctx.isGenerating ?? data.isGenerating) return refuse('generation_in_progress', 'Video generation is already running.');
  const nodes = upstream(ctx);
  const counts = { images: 0, videos: 0, audios: 0 };
  for (const node of nodes) {
    if (typeof node.data.videoUrl === 'string' && node.data.videoUrl.length > 0) counts.videos += 1;
    else if (isAudioNode(node)) { if (node.data.audioUrl) counts.audios += 1; }
    else if (imageUrls(node).preview) counts.images += 1;
  }
  // VideoNode's videoExtend caps ignore catalog overrides (unlike the form helper).
  const caps = mode === 'videoExtend' ? { image: 0, video: 1, audio: 0 } : referenceCapsForMode(model, mode);
  if ((mode === 'videoEdit' || mode === 'videoExtend') && counts.videos === 0) {
    return refuse('missing_source_video', 'An upstream source video is required.');
  }
  if (mode === 'allReference' && !isVideoModeSupportedByModel(mode, model)) {
    return refuse('mode_unsupported_by_model', 'The model does not support all-reference generation.');
  }
  const capabilityError = videoModelReferenceDisabledReason(model, counts);
  if (capabilityError) return refuse('model_capability_error', 'The model cannot consume these references.');
  if (caps && (counts.images > caps.image || counts.videos > caps.video || counts.audios > caps.audio)) {
    return refuse('reference_limit_exceeded', 'The references exceed the selected mode limits.');
  }
  if (videoSubmitMediaRejectionReason(mode, model, counts)) {
    return refuse('model_capability_error', 'The model cannot consume these inputs in this mode.');
  }
  const compileInput = videoPromptCompileInput(ctx);
  // Camera fragments do not satisfy the component's prompt-required guard.
  if (videoModeRequiresPrompt(mode) && !compileInput.nodePrompt && !compileInput.upstreamText && !extensionRange(data)) {
    return refuse('no_effective_prompt', 'A video prompt or upstream text is required.');
  }
  if (ctx.inlineMedia !== 'forward' && mode !== 'videoEdit' && mode !== 'videoExtend' && mode !== 'allReference' && nodes.some((node) => [imageUrls(node).source, imageUrls(node).preview,
    node.data.videoUrl, node.data.audioUrl].some((url) => typeof url === 'string' && url.startsWith('data:')))) {
    return refuse('inline_media_reference', 'Upload inline media before building a video request.');
  }
  if (mode !== 'videoEdit' && mode !== 'videoExtend' && mode !== 'allReference' && videoModeRequiresMedia(mode) && counts.images === 0) return refuse('missing_media', 'An upstream image is required.');
  if (mode === 'allReference') {
    if (documentReferenceInvalid(data, model)) {
      return refuse('model_capability_error', 'The model cannot consume these document references.');
    }
    if (counts.images + counts.videos + counts.audios === 0 && !(data.referenceFileUrl || data.referenceLink?.trim())) {
      return refuse('missing_references', 'At least one reference is required.');
    }
  }
  if (!ctx.projectId) return refuse('no_project', 'A project is required.');

  const aspectRatio = submitAspectRatio(data, model);
  const quality = normalizeVideoQuality(data.quality, videoQualityOptionsForModel(model));
  const bounds = videoDurationBoundsForModel(model);
  const duration = clampVideoDuration(
    typeof data.durationSec === 'number' ? data.durationSec : DEFAULT_DURATION_MIN, bounds,
  );
  const sceneOptimize = normalizeSceneOptimize(
    data.sceneOptimize, sceneOptimizeOptionsForModel(model), defaultSceneOptimizeForModel(model),
  );
  const modelId = model.catalogId ?? model.id;
  const body: Record<string, unknown> = {
    prompt: ctx.prompt,
    camera_template_id: typeof data.cameraMovement === 'string' ? data.cameraMovement : null,
    marks: [], aspect_ratio: aspectRatio, resolution: quality,
    duration_seconds: Math.max(clampVideoDuration(duration, bounds), 1),
    generate_audio: videoModelSupportsGenerateAudio(model)
      && (typeof data.generateAudio === 'boolean' ? data.generateAudio : videoModelDefaultGenerateAudio(model)),
    ...(modelId ? { model: modelId, model_id: modelId } : {}),
    gen_mode: mode, human_review: mode !== 'textToVideo' && model.humanReview === true && Boolean(data.humanReview),
    scene_optimize: sceneOptimize ?? null,
  };
  const count = Math.min(Math.max(data.count ?? 1, 1), 4);
  if (mode === 'videoEdit' || mode === 'videoExtend' || mode === 'allReference') {
    return buildVideoMediaRequest(ctx, data, model, mode, body, count);
  }
  const context = nodeContextWireFields({ ...ctx, modelParams: data.modelParams });
  const ordered = sortUpstreamByReferenceOrder(nodes, data.referenceOrder);
  if (mode === 'firstFrame' || mode === 'firstLastFrame') {
    const keyframes = resolveVideoKeyframeUrls(ordered.flatMap((node) => {
      const url = imageUrls(node).source;
      if (!url) return [];
      const edge = ctx.edges.find((candidate) => candidate.source === node.id && candidate.target === ctx.nodeId);
      return [{ url, slot: edge?.data?.keyframeSlot,
        legacyDisplayName: typeof node.data.displayName === 'string' ? node.data.displayName : null }];
    }), mode);
    const first_frame_url = keyframes.firstFrameUrl;
    const last_frame_url = mode === 'firstLastFrame' ? keyframes.lastFrameUrl : null;
    if (!first_frame_url && !last_frame_url) return refuse('missing_media', 'A source keyframe is required.', 'keyframes');
    return requestResult(ctx, 'keyframes', { first_frame_url, last_frame_url, ...body, ...context }, count);
  } else if (mode === 'imageToVideo' || mode === 'imageReference') {
    const imageUrlsToSubmit = ordered.flatMap((node) => {
      const url = imageUrls(node).source;
      return url ? [url] : [];
    }).slice(0, caps?.image ?? 9);
    if (!imageUrlsToSubmit.length) return refuse('missing_media', 'An upstream source image is required.', 'images');
    return requestResult(ctx, 'i2v', { image_urls: imageUrlsToSubmit, ...body, ...context }, count);
  }
  const { prompt, camera_template_id, ...rest } = body;
  return requestResult(ctx, 'gen', { prompt, camera_template_id, character_ids: [], ...rest, ...context }, count);
}
