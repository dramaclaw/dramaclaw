// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isImageGenNode, type CanvasNode, type CanvasEdge, type ImageGenNodeData } from '../../domain/canvasNodes';
import { snapToAllowedAspectRatio } from '../../domain/aspectRatio';
import { IMAGE_ASPECT_OPTIONS, IMAGE_SIZE_OPTIONS } from '../../domain/imageGenerationOptions';
import { isSystemManagedNodeData } from '../../domain/mainlineNodeFlags';
import { SHARED_MODELS, type ModelOption } from '../../domain/modelOptions';
import { orderedReferenceUrlsWithOwnFirst, upstreamNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import { extractUpstreamContent, joinUpstreamText } from '../graphContentResolver';
import type { CompileWorkflowNodePromptInput } from '../workflowRecipeRuntime';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export interface ImageGenerationRequestContext {
  /** Latest canvas, as in the canvas store. */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  nodeId: string;
  projectId: string;
  /** The page's canvas id, with the browser's 'default' fallback already applied. */
  canvasId: string;
  /** The resolved catalog; the caller supplies any list-level fallback. */
  imageModels: ModelOption[];
  executionSource: 'manual' | 'workflow';
  productOperation: WorkflowProductOperationContext | null;
}

export type ImagePromptCompileInput = Omit<
  CompileWorkflowNodePromptInput,
  'nodeId' | 'nodeData' | 'executionSource' | 'onCompileMetadata'
>;

export interface ImageGenerationHttpRequest {
  method: 'POST';
  /** Relative to the API base. */
  path: string;
  body: Record<string, unknown>;
}

export type ImageGenerationRequestResult =
  | { ok: true; requests: ImageGenerationHttpRequest[] }
  | {
      ok: false;
      code: 'not_image_generation_node' | 'no_model' | 'no_effective_prompt' | 'reference_limit_exceeded' | 'inline_media_reference';
      message: string;
    };

const NOT_IMAGE_GENERATION_NODE = 'The target node must be an image generation node.';

function nodeData(ctx: ImageGenerationRequestContext): ImageGenNodeData | undefined {
  const node = ctx.nodes.find((candidate) => candidate.id === ctx.nodeId);
  return node && isImageGenNode(node) ? node.data : undefined;
}

function referenceUrls(ctx: ImageGenerationRequestContext, data: ImageGenNodeData): string[] {
  const ownReference = data.referenceImageUrl;
  const upstreamUrls = upstreamNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId)
    .map(extractUpstreamContent)
    .flatMap((content) => typeof content.imageUrl === 'string' && content.imageUrl.length > 0
      ? [content.imageUrl] : []);
  return orderedReferenceUrlsWithOwnFirst(
    typeof ownReference === 'string' && ownReference.length > 0 ? ownReference : null,
    upstreamUrls,
  );
}

/**
 * Inputs for recipe compilation, before any user edits to the prompt draft.
 * Throws when the target is missing or is not an image generation node.
 */
export function imagePromptCompileInput(ctx: ImageGenerationRequestContext): ImagePromptCompileInput {
  const data = nodeData(ctx);
  if (!data) throw new Error(NOT_IMAGE_GENERATION_NODE);
  const upstreamContents = upstreamNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId)
    .map(extractUpstreamContent);
  const upstreamText = joinUpstreamText(upstreamContents);
  const ownPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  const source = data.__freezone_source;
  const role = source && typeof source === 'object' && 'role' in source ? source.role : undefined;
  const inlineUpstream = role === 'scene_master' || role === 'scene_reverse_master';
  // With no user override, the hook's effect seeds an empty scene prompt draft
  // from upstream text before submission (without changing the stored prompt).
  const nodePrompt = inlineUpstream ? ownPrompt || upstreamText.trim() : ownPrompt;
  return {
    nodeKind: 'image',
    nodePrompt,
    upstreamText,
    upstreamContents,
    fallbackPrompt: inlineUpstream
      ? nodePrompt
      : [upstreamText, ownPrompt].filter((text) => text.length > 0).join('\n\n'),
    referenceMedia: referenceUrls(ctx, data).map((_, index) => ({
      kind: 'image', label: `reference-${index + 1}`,
    })),
  };
}

/** Recipe metadata to persist after compilation; the caller supplies the timestamp. */
export function imagePromptCompileMetadataPatch(
  { mode, prompt, recipeIds }: Parameters<NonNullable<CompileWorkflowNodePromptInput['onCompileMetadata']>>[0],
  compiledAt: string,
) {
  return {
    workflowRecipeCompileMode: mode,
    workflowRecipeCompiledAt: compiledAt,
    workflowRecipeCompiledPrompt: prompt,
    prompt,
    workflowRecipeIds: recipeIds,
  };
}

/**
 * Build the shared image form's HTTP requests without submitting them.
 * Recipe compilation and media uploads happen before this call. Replace inline
 * references in the supplied canvas with their uploaded URLs before building. Billing-rule
 * checks require a price lookup and remain the caller's responsibility.
 */
export function buildImageGenerationRequest(
  ctx: ImageGenerationRequestContext & { prompt: string },
): ImageGenerationRequestResult {
  const data = nodeData(ctx);
  if (!data) return { ok: false, code: 'not_image_generation_node', message: NOT_IMAGE_GENERATION_NODE };
  const persistedModel = typeof data.model === 'string' && data.model.length > 0 ? data.model : null;
  const model = (persistedModel ? ctx.imageModels.find((item) => item.id === persistedModel) : undefined)
    ?? ctx.imageModels[0];
  if (!model) return { ok: false, code: 'no_model', message: 'No image model is available.' };
  // Match submitDisabled before recipe compilation, even when a caller supplies
  // a compiled prompt. References alone do not enable the browser form.
  if (!imagePromptCompileInput(ctx).fallbackPrompt) {
    return { ok: false, code: 'no_effective_prompt', message: 'An image prompt or upstream text is required.' };
  }
  const references = referenceUrls(ctx, data);
  if (model.referenceImageMax != null && references.length > model.referenceImageMax) {
    return {
      ok: false, code: 'reference_limit_exceeded',
      message: `The selected model supports at most ${model.referenceImageMax} reference images.`,
    };
  }
  if (references.some((url) => url.startsWith('data:'))) {
    return { ok: false, code: 'inline_media_reference', message: 'Upload inline media before building an image request.' };
  }

  const configuredSizes = model.resolutionOptions?.map((item) => item.trim()).filter(Boolean);
  const sizes = configuredSizes?.length ? configuredSizes : IMAGE_SIZE_OPTIONS;
  const size = typeof data.size === 'string' && data.size.trim() ? data.size : '2K';
  const configuredRatios = model.ratioOptions?.map((item) => item.trim()).filter(Boolean);
  const ratios = configuredRatios?.length ? configuredRatios : IMAGE_ASPECT_OPTIONS.map((item) => item.value);
  const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio ? data.aspectRatio : '16:9';
  const quality = data.quality ?? 'medium';
  const qualities = (model.qualityOptions ?? []).map((item) => item.trim()).filter(Boolean);
  const effectiveQuality = qualities.find((option) => option.toLowerCase() === quality.toLowerCase())
    ?? qualities.find((option) => option.toLowerCase() === 'medium')
    ?? qualities[0]
    ?? 'medium';
  const camera = data.cameraSelection;
  const hasCamera = Boolean(camera && (camera.cameraBodyId || camera.lensId || camera.focalLengthMm || camera.aperture));
  const styleTemplateId = typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
    ? data.styleTemplateId : null;
  const effectiveCount = data.autoCommitOnGenerate === true && isSystemManagedNodeData(data) ? 1 : data.count ?? 1;
  const total = Math.min(Math.max(effectiveCount, 1), 4);
  const batchVariants = total > 1 && (
    ctx.executionSource === 'workflow' || Boolean(ctx.productOperation?.generationAttemptId)
  );
  const modelId = model.catalogId ?? model.id;
  const body: ImageGenerationHttpRequest['body'] = {
    prompt: ctx.prompt,
    ...(batchVariants ? { variant_count: total } : {}),
    aspect_ratio: snapToAllowedAspectRatio(aspectRatio, ratios, ratios[0] ?? '1:1'),
    image_size: sizes.includes(size) ? size : sizes[0],
    // Deduplication precedes API cleanup; do not deduplicate again after stripping queries.
    reference_urls: references.filter((url) => url.trim().length > 0).map((url) => url.split('?')[0]),
    camera: hasCamera ? {
      camera_body: camera?.cameraBodyId ?? '',
      lens: camera?.lensId ?? '',
      focal_length_mm: camera?.focalLengthMm ?? 0,
      aperture: camera?.aperture ?? '',
    } : null,
    style: styleTemplateId ? { template_id: styleTemplateId } : null,
    provider: model.providerId ?? null,
    model: model.apiModel ?? SHARED_MODELS.find((item) => item.id === model.id)?.apiModel ?? model.id,
    ...(modelId ? { model_id: modelId } : {}),
    gen_mode: references.length > 0 ? 'image_to_image' : 'text_to_image',
    quality: qualities.length > 0 ? effectiveQuality : null,
    ...(ctx.canvasId ? { canvas_id: ctx.canvasId } : {}),
    ...(ctx.nodeId ? { node_id: ctx.nodeId } : {}),
    ...(data.modelParams ? { model_params: data.modelParams } : {}),
    ...(ctx.productOperation?.generationAttemptId ? {
      product_operation_id: ctx.productOperation.operationId,
      generation_attempt_id: ctx.productOperation.generationAttemptId,
    } : {}),
  };
  return {
    ok: true,
    requests: Array.from({ length: batchVariants ? 1 : total }, () => ({
      method: 'POST', path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/gen`, body,
    })),
  };
}
