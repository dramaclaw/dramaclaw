// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../../core/environment';
import { isSystemManagedNodeData } from '../../domain/mainlineNodeFlags';
import { TaskCompletionError } from '../../domain/taskCompletionError';
import { humanizeTaskError } from '../../domain/taskErrorText';
import { extractRequestId } from '../../domain/generationRequestId';
import {
  GENERATION_ERROR_CLEARED_PATCH, buildImageGenerationSuccessPatch,
  hasGeneratedMedia, isStaleGenerationTask, shouldWriteGenerationError,
} from '../generationTaskArbitration';
import { generationTaskDescriptor } from '../generationTaskDescriptor';
import { imageGenerationResultUrls } from '../imageGenerationResults';

export interface ImageGenerationTaskRef {
  task_key: string;
  task_type: string;
  job_id: string;
}
export type ImageGenerationOutcome =
  | { kind: 'completed'; result: Record<string, unknown> | null; fallbackUrl?: string | null }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'reference_invalid'; message: string }
  | { kind: 'compile_failed'; message: string };
export type ImageGenerationEffect =
  | { kind: 'attach_story_frame'; nodeId: string }
  | { kind: 'attach_story_asset'; nodeId: string }
  | { kind: 'commit_node'; nodeId: string; auto: true };
export interface ImageGenerationOutcomeInput {
  nodeId: string;
  nodeData: Record<string, unknown>;
  taskKey: string | null;
  /** First ref in acceptance order, retained after success clears the node's handle. */
  firstAcceptedTask: ImageGenerationTaskRef | null;
  runIndex: number;
  /** Effective count after clamping and the auto-commit rule. */
  total: number;
  completedUrls: string[];
  attachStoryFrame: boolean;
  outcome: ImageGenerationOutcome;
  translate: CanvasEnvironment['translate'];
}
export type ImageGenerationOutcomeResult =
  | { action: 'ignore' }
  | {
      action: 'write';
      patch: Record<string, unknown>;
      completedUrls: string[];
      effects: ImageGenerationEffect[];
      /** Batch output so far; return it after all runs settle. */
      output?: Record<string, unknown>;
      /** Per-run rejection; after settling choose the first rejected run by index. */
      error?: { message: string };
    };

/** Loading feedback before compilation, which can fail before clearing the old batch. */
export function imageGenerationStartPatch(startedAtMs: number): Record<string, unknown> {
  return { isGenerating: true, generationStartedAt: startedAtMs, ...GENERATION_ERROR_CLEARED_PATCH };
}
/** Combined start and pre-request writes for a successfully compiled submission. */
export function imageGenerationSubmitPatch(startedAtMs: number): Record<string, unknown> {
  return { ...imageGenerationStartPatch(startedAtMs), generationBatch: null };
}
/** Apply for run 0, or for the first accepted run if run 0 has not been accepted yet. */
export function imageGenerationAcceptedPatch(ref: ImageGenerationTaskRef): Record<string, unknown> {
  return generationTaskDescriptor(ref);
}
function batchOutput(input: ImageGenerationOutcomeInput, urls: string[]): Record<string, unknown> {
  const ref = input.firstAcceptedTask;
  return {
    ...(ref ? { task_key: ref.task_key, task_type: ref.task_type, job_id: ref.job_id } : {}),
    imageUrl: urls[0], imageUrls: [...urls],
  };
}

/**
 * Completed-mode writes only. The browser's invalidateInFlightGeneration attempt
 * counter has no server equivalent and is deliberately omitted.
 * Callers must classify InsufficientCreditsError, BillingRuleNotConfiguredError
 * and ProjectQueueLimitError before passing their display text through `failed`.
 * Effects describe calls, including story attachment calls that may be no-ops.
 */
export function imageGenerationOutcomePatch(input: ImageGenerationOutcomeInput): ImageGenerationOutcomeResult {
  const { nodeData, taskKey, runIndex, total, outcome, translate } = input;
  const completedUrls = [...input.completedUrls];
  const resetLoading = runIndex === 0 ? { isGenerating: false, generationStartedAt: null } : {};
  const write = (
    patch: Record<string, unknown>,
    extra: Pick<Extract<ImageGenerationOutcomeResult, { action: 'write' }>, 'output' | 'error'> = {},
    effects: ImageGenerationEffect[] = [],
  ): ImageGenerationOutcomeResult => ({ action: 'write', patch, completedUrls, effects, ...extra });
  const failure = (message: string, prefix: Record<string, unknown>) => {
    // An Error with an empty message falls back to String(error) for diagnostics.
    const raw = message || ((outcome.kind === 'cancelled' || (outcome.kind === 'failed' && taskKey))
      ? 'TaskCompletionError' : 'Error');
    return write({
      ...prefix,
      generationError: humanizeTaskError(message, translate),
      generationErrorDetails: raw,
      generationErrorRequestId: extractRequestId(raw),
    }, { error: { message } });
  };
  if (outcome.kind === 'compile_failed') {
    return failure(outcome.message, {
      isGenerating: false, generationStartedAt: null,
      generationTaskKey: null, generationTaskType: null, generationTaskJobId: null,
    });
  }
  let message: string;
  let missingUrlPatch: Record<string, unknown> = {};
  if (outcome.kind === 'completed') {
    let urls = imageGenerationResultUrls(outcome.result);
    if (urls.length === 0 && outcome.fallbackUrl) urls = [outcome.fallbackUrl];
    if (urls.length > 0) {
      const first = completedUrls.length === 0;
      const fresh = urls.filter((url) => !completedUrls.includes(url));
      if (fresh.length === 0) return { action: 'ignore' };
      completedUrls.push(...fresh);
      const effects: ImageGenerationEffect[] = [];
      if (first && input.attachStoryFrame) {
        effects.push({ kind: 'attach_story_frame', nodeId: input.nodeId }, { kind: 'attach_story_asset', nodeId: input.nodeId });
      }
      if (first && nodeData.autoCommitOnGenerate === true && isSystemManagedNodeData(nodeData)) {
        effects.push({ kind: 'commit_node', nodeId: input.nodeId, auto: true });
      }
      return write({
        ...(first ? buildImageGenerationSuccessPatch(completedUrls[0]) : {}),
        ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
      }, { output: batchOutput(input, completedUrls) }, effects);
    }
    if (runIndex === 0 && completedUrls.length === 0) missingUrlPatch = resetLoading;
    message = '图片生成完成但未返回图片地址'; // i18n-exempt -- must equal the browser hook's error text
  } else message = outcome.message;

  // Catch order matters: a successful sibling wins over reference errors and cancellation.
  if (completedUrls.length > 0) return write({}, { output: batchOutput(input, completedUrls) });
  if (outcome.kind === 'reference_invalid' && runIndex === 0) {
    return write({
      isGenerating: false, generationStartedAt: null,
      generationError: translate('referenceValidation.title'),
      generationErrorDetails: null, generationErrorRequestId: null,
    }, { error: { message } });
  }
  const error = outcome.kind === 'cancelled'
    ? new TaskCompletionError(message, 'cancelled', taskKey ?? '') : new Error(message);
  if (taskKey && outcome.kind === 'cancelled' && hasGeneratedMedia(nodeData)) {
    return runIndex === 0 ? write(resetLoading) : { action: 'ignore' };
  }
  if (runIndex === 0 && taskKey) {
    if (isStaleGenerationTask({ nodeData, taskKey })) {
      // No-URL completion resets loading before entering the stale-task catch.
      return Object.keys(missingUrlPatch).length > 0 ? write(missingUrlPatch) : { action: 'ignore' };
    }
    if (!shouldWriteGenerationError({ nodeData, taskKey, error })) return write(resetLoading);
  }
  return failure(message, { ...missingUrlPatch, ...resetLoading });
}
