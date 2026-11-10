// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
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
import { clampVideoDuration, referenceCapsForMode } from '../../nodes/shared/videoFormOptions';
import {
  resolveVideoKeyframeUrls, videoModeForcesAutomaticAspectRatio, videoModeRequiresMedia,
  videoModeRequiresPrompt, videoModelDefaultGenerateAudio, videoModelReferenceDisabledReason,
  videoModelSupportsGenerateAudio, videoSubmitMediaRejectionReason,
} from '../../nodes/shared/videoModelCapabilities';
import { extractUpstreamContent, joinUpstreamText } from '../graphContentResolver';
import type { CompileWorkflowNodePromptInput } from '../workflowRecipeRuntime';
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
  /** URL-keyed durations measured outside this pure module; reserved for media modes. */
  mediaDurationsMs?: Record<string, number | null>;
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
export type VideoGenerationRefusalCode = 'not_video_node' | 'mode_not_supported' | 'no_model'
  | 'no_project' | 'generation_in_progress' | 'no_effective_prompt' | 'missing_media'
  | 'reference_limit_exceeded' | 'model_capability_error' | 'inline_media_reference';
export type VideoGenerationRequestResult = { ok: true; requests: VideoGenerationHttpRequest[] }
  | { ok: false; code: VideoGenerationRefusalCode; message: string };

const NOT_VIDEO_NODE = 'The target node must be a video node.';
function refuse(code: VideoGenerationRefusalCode, message: string): VideoGenerationRequestResult {
  return { ok: false, code, message };
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
  const cameraTemplates = ctx.cameraTemplates?.length ? ctx.cameraTemplates : CAMERA_MOVEMENT_PRESETS;
  const fragment = findCameraMovementPreset(cameraTemplates, data.cameraMovement)?.promptFragment;
  const userPrompt = [upstreamText, nodePrompt].filter((text) => text.length > 0).join('\n\n');
  return {
    nodeKind: 'video', nodePrompt, upstreamText, upstreamContents,
    fallbackPrompt: fragment ? userPrompt ? `${fragment}，${userPrompt}` : fragment : userPrompt,
  };
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
 * preparation, uploads, billing-rule checks and model-access checks stay with the
 * caller. Upload inline media first. Supply a normalized graph snapshot for each
 * phase: the component rereads references after compilation. These modes send the
 * compiled prompt unchanged. Other media modes and upscale are deferred.
 */
export function buildVideoGenerationRequest(
  ctx: VideoGenerationRequestContext & { prompt: string },
): VideoGenerationRequestResult {
  const data = nodeData(ctx);
  if (!data) return refuse('not_video_node', NOT_VIDEO_NODE);
  const mode = data.genMode ?? 'textToVideo';
  if (data.isUpscaleNode || mode === 'videoEdit' || mode === 'videoExtend' || mode === 'allReference') {
    return refuse('mode_not_supported', 'This video mode is not supported by this builder yet.');
  }
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
  const caps = referenceCapsForMode(model, mode);
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
  if (videoModeRequiresPrompt(mode) && !compileInput.nodePrompt && !compileInput.upstreamText) {
    return refuse('no_effective_prompt', 'A video prompt or upstream text is required.');
  }
  if (nodes.some((node) => [imageUrls(node).source, imageUrls(node).preview,
    node.data.videoUrl, node.data.audioUrl].some((url) => typeof url === 'string' && url.startsWith('data:')))) {
    return refuse('inline_media_reference', 'Upload inline media before building a video request.');
  }
  if (videoModeRequiresMedia(mode) && counts.images === 0) return refuse('missing_media', 'An upstream image is required.');
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
    ...(ctx.canvasId ? { canvas_id: ctx.canvasId } : {}),
    ...(ctx.nodeId ? { node_id: ctx.nodeId } : {}),
    ...(data.modelParams ? { model_params: data.modelParams } : {}),
    ...(ctx.productOperation?.generationAttemptId ? {
      product_operation_id: ctx.productOperation.operationId, generation_attempt_id: ctx.productOperation.generationAttemptId,
    } : {}),
  };
  let route = 'gen';
  const ordered = sortUpstreamByReferenceOrder(nodes, data.referenceOrder);
  if (mode === 'firstFrame' || mode === 'firstLastFrame') {
    const keyframes = resolveVideoKeyframeUrls(ordered.flatMap((node) => {
      const url = imageUrls(node).source;
      if (!url) return [];
      const edge = ctx.edges.find((candidate) => candidate.source === node.id && candidate.target === ctx.nodeId);
      return [{ url, slot: edge?.data?.keyframeSlot,
        legacyDisplayName: typeof node.data.displayName === 'string' ? node.data.displayName : null }];
    }), mode);
    body.first_frame_url = keyframes.firstFrameUrl;
    body.last_frame_url = mode === 'firstLastFrame' ? keyframes.lastFrameUrl : null;
    if (!body.first_frame_url && !body.last_frame_url) return refuse('missing_media', 'A source keyframe is required.');
    route = 'keyframes';
  } else if (mode === 'imageToVideo' || mode === 'imageReference') {
    const imageUrlsToSubmit = ordered.flatMap((node) => {
      const url = imageUrls(node).source;
      return url ? [url] : [];
    }).slice(0, caps?.image ?? 9);
    if (!imageUrlsToSubmit.length) return refuse('missing_media', 'An upstream source image is required.');
    body.image_urls = imageUrlsToSubmit;
    route = 'i2v';
  } else {
    body.character_ids = [];
  }
  return { ok: true, requests: Array.from({ length: Math.min(Math.max(data.count ?? 1, 1), 4) }, () => ({
    method: 'POST', path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/video/${route}`, body,
  })) };
}
