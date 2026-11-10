// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  buildImageGenerationRequest, imagePromptCompileInput, imagePromptCompileMetadataPatch,
  imageGenerationStartPatch, imageGenerationSubmitPatch, imageGenerationAcceptedPatch, imageGenerationOutcomePatch,
  type ImageGenerationOutcome, type ImageGenerationOutcomeInput, type ImageGenerationRequestContext,
  type ImageGenerationTaskRef,
} from '../application/generationRequests';
import { imageModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { SHARED_MODELS } from '../domain/modelOptions';
import { isRecord, isFiniteNumber } from '@/features/freezone/canvasCommandEnvelope';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';
import { invalidRequest, parseCanvasPayload } from './requestPayload';

function parseProductOperation(value: unknown): ImageGenerationRequestContext['productOperation'] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.operationId !== 'string' ||
    (value.generationAttemptId !== undefined && typeof value.generationAttemptId !== 'string')) invalidRequest('Invalid product operation');
  return { projectId: value.projectId, operationId: value.operationId, generationAttemptId: value.generationAttemptId };
}

export async function serveImageGenerationRequest(payload: unknown) {
  if (!isRecord(payload)) invalidRequest('An image generation request is required');
  // This operation has no command envelopes; share the existing canvas validation.
  const { canvas } = parseCanvasPayload({ ...payload, envelopes: [] });
  const { node_id, env } = payload;
  if (typeof node_id !== 'string' || !isRecord(env) ||
    (env.locale !== undefined && typeof env.locale !== 'string') ||
    typeof env.project !== 'string' || typeof env.canvasId !== 'string' ||
    (env.catalogs !== undefined && !isRecord(env.catalogs)) ||
    (env.executionSource !== 'workflow' && env.executionSource !== 'manual') ||
    (env.prompt !== undefined && typeof env.prompt !== 'string')) invalidRequest('Invalid image generation environment or node_id');
  const context: ImageGenerationRequestContext = {
    ...canvas, nodeId: node_id, projectId: env.project, canvasId: env.canvasId,
    imageModels: env.catalogs?.image === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(env.catalogs.image),
    executionSource: env.executionSource, productOperation: parseProductOperation(env.productOperation),
  };
  const prompt = env.prompt;
  return runServerRequest(env.locale, async () => {
    // Compile recipes from compile_input first, then call again with env.prompt.
    let compile_input;
    try {
      compile_input = imagePromptCompileInput(context);
    } catch (error) {
      const request = buildImageGenerationRequest({ ...context, prompt: prompt ?? '' });
      if (!request.ok && request.code === 'not_image_generation_node') return { compile_input: request, request };
      throw error;
    }
    return { compile_input, request: buildImageGenerationRequest({ ...context, prompt: prompt ?? compile_input.fallbackPrompt }) };
  });
}

function parseTask(value: unknown): ImageGenerationTaskRef {
  if (!isRecord(value) || typeof value.task_key !== 'string' || typeof value.task_type !== 'string' || typeof value.job_id !== 'string') invalidRequest('Invalid image generation task');
  return { task_key: value.task_key, task_type: value.task_type, job_id: value.job_id };
}

function parseOutcome(value: unknown): ImageGenerationOutcome {
  if (!isRecord(value)) invalidRequest('An image generation outcome is required');
  if (value.kind === 'completed') {
    if ((value.result !== null && !isRecord(value.result)) ||
      (value.fallbackUrl !== undefined && value.fallbackUrl !== null && typeof value.fallbackUrl !== 'string')) invalidRequest('Invalid completed outcome');
    return { kind: value.kind, result: value.result, fallbackUrl: value.fallbackUrl };
  }
  if ((value.kind !== 'failed' && value.kind !== 'cancelled' && value.kind !== 'reference_invalid' && value.kind !== 'compile_failed') ||
    typeof value.message !== 'string') invalidRequest('Invalid image generation outcome kind or message');
  return { kind: value.kind, message: value.message };
}

type CompileMetadata = Parameters<typeof imagePromptCompileMetadataPatch>[0];
function parseCompileMetadata(value: unknown): CompileMetadata {
  if (!isRecord(value) || typeof value.prompt !== 'string' || !isStringArray(value.recipeIds) ||
    (value.mode !== 'deterministic' && value.mode !== 'memory_cache' && value.mode !== 'persistent_cache' &&
      value.mode !== 'model' && value.mode !== 'timeout_fallback')) invalidRequest('Invalid image compile metadata');
  return { mode: value.mode, prompt: value.prompt, recipeIds: value.recipeIds };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

type ImageGenerationPatch =
  | { phase: 'start' | 'submit'; startedAtMs: number }
  | { phase: 'accepted'; task: ImageGenerationTaskRef }
  | { phase: 'compile_metadata'; metadata: CompileMetadata; compiledAt: string }
  | { phase: 'outcome'; locale?: string; input: Omit<ImageGenerationOutcomeInput, 'translate'> };

function parsePatch(payload: unknown): ImageGenerationPatch {
  if (!isRecord(payload)) invalidRequest('An image generation patch is required');
  switch (payload.phase) {
    case 'start':
    case 'submit':
      if (!isFiniteNumber(payload.started_at_ms)) invalidRequest('started_at_ms must be a finite number');
      return { phase: payload.phase, startedAtMs: payload.started_at_ms };
    case 'accepted': return { phase: payload.phase, task: parseTask(payload.task) };
    case 'compile_metadata':
      if (typeof payload.compiled_at !== 'string') invalidRequest('compiled_at must be a string');
      return { phase: payload.phase, metadata: parseCompileMetadata(payload.metadata), compiledAt: payload.compiled_at };
    case 'outcome': {
      if ((payload.locale !== undefined && typeof payload.locale !== 'string') ||
        typeof payload.node_id !== 'string' || !isRecord(payload.node_data) ||
        (payload.task_key !== null && typeof payload.task_key !== 'string') ||
        !isFiniteNumber(payload.run_index) || !isFiniteNumber(payload.total) ||
        !isStringArray(payload.completed_urls) || typeof payload.attach_story_frame !== 'boolean') invalidRequest('Invalid image generation outcome input');
      return { phase: payload.phase, locale: payload.locale, input: {
        nodeId: payload.node_id, nodeData: payload.node_data, taskKey: payload.task_key,
        firstAcceptedTask: payload.first_accepted_task === null ? null : parseTask(payload.first_accepted_task),
        runIndex: payload.run_index, total: payload.total, completedUrls: payload.completed_urls,
        attachStoryFrame: payload.attach_story_frame, outcome: parseOutcome(payload.outcome),
      } };
    }
    default: return invalidRequest('Unknown image generation patch phase');
  }
}

export async function serveImageGenerationPatch(payload: unknown) {
  const input = parsePatch(payload);
  const locale = input.phase === 'outcome' ? input.locale : undefined;
  return runServerRequest(locale, async () => {
    switch (input.phase) {
      case 'start': return imageGenerationStartPatch(input.startedAtMs);
      case 'submit': return imageGenerationSubmitPatch(input.startedAtMs);
      case 'accepted': return imageGenerationAcceptedPatch(input.task);
      case 'compile_metadata': return imagePromptCompileMetadataPatch(input.metadata, input.compiledAt);
      case 'outcome': return imageGenerationOutcomePatch({ ...input.input, translate: await createServerTranslate(locale) });
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  });
}
