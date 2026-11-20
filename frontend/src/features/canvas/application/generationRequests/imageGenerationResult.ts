// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Pure image acceptance, per-run patches, batch settlement and action publication. */
import type { GenerationErrorInfo } from './generationSubmitError';
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
  | { kind: 'failed'; message: string; error?: GenerationErrorInfo }
  | { kind: 'cancelled'; message: string; error?: GenerationErrorInfo }
  | { kind: 'reference_invalid'; message: string }
  | { kind: 'compile_failed'; message: string; error?: GenerationErrorInfo };
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
  /** Browser submissions retain the render-time auto-commit decision. */
  canAutoCommitOnGenerate?: boolean;
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

/**
 * Retain acceptedRefs in acceptance order. handled returns immediately without
 * writing a descriptor or waiting again. For accepted, retain the new refs and
 * apply imageGenerationAcceptedPatch(task) only when applyPatch is true.
 */
export function imageGenerationRunAccepted(input: {
  runIndex: number;
  acceptedRefs: readonly ImageGenerationTaskRef[];
  task: ImageGenerationTaskRef;
}):
  | { action: 'handled'; acceptedRefs: ImageGenerationTaskRef[] }
  | { action: 'accepted'; applyPatch: boolean; acceptedRefs: ImageGenerationTaskRef[] } {
  const { runIndex, acceptedRefs, task } = input;
  if (acceptedRefs.some((ref) => ref.task_key === task.task_key)) {
    return { action: 'handled', acceptedRefs: [...acceptedRefs] };
  }
  return {
    action: 'accepted',
    applyPatch: runIndex === 0 || acceptedRefs.length === 0,
    acceptedRefs: [...acceptedRefs, {
      task_key: task.task_key, task_type: task.task_type, job_id: task.job_id,
    }],
  };
}

/**
 * Submitted-mode completion rejection: apply directly, even after invalidation,
 * sibling success, cancellation or reference failure. Only run 0 resets loading.
 * Pass the raw Error.message and describeGenerationError's info as for failed
 * outcomes; diagnostics use message (or the empty-message Error name), not
 * error.details/requestId. Without info, message represents an ordinary Error.
 */
export function imageGenerationBackgroundFailurePatch(input: {
  runIndex: number;
  message: string;
  error?: GenerationErrorInfo;
  translate: CanvasEnvironment['translate'];
}): Record<string, unknown> {
  const { runIndex, message, error, translate } = input;
  const raw = message || error?.name || 'Error';
  return {
    ...(runIndex === 0 ? { isGenerating: false, generationStartedAt: null } : {}),
    generationError: error ? error.display : message ? humanizeTaskError(message, translate) : translate('common.error'),
    generationErrorDetails: raw,
    generationErrorRequestId: extractRequestId(raw),
  };
}

export type ImageGenerationSettledRun =
  | { status: 'fulfilled'; value: 'completed' | 'submitted' | 'ignored' | 'handled' }
  | { status: 'rejected'; message: string };
export type ImageGenerationSettleOutcome =
  | { kind: 'output'; output: Record<string, unknown> }
  | { kind: 'rethrow'; runIndex: number }
  | { kind: 'undefined' }
  | { kind: 'no_result'; patch: Record<string, unknown>; error: { message: string } };

/**
 * Reduce the ordered Promise.allSettled data after the UI clears album pending
 * count and invokes its settled callback. Use the resolved completion mode:
 * workflow batch variants force completed mode and submit once with variantCount.
 * output: assign the caller's accumulated actionOutput and return it.
 * rethrow: throw the original rejection at runIndex, preserving its identity.
 * undefined: return undefined without writing an error.
 * no_result: apply patch, then throw an Error with error.message.
 * In every case the caller's finally releases the in-flight guard and resolves
 * duplicate-submit waiters with actionOutput (undefined on rejection/ignored).
 * Submitted completion keeps running after this return; its failures use the
 * background patch rather than the completed-mode outcome arbitration.
 */
export function imageGenerationSettleOutcome(input: {
  settled: readonly ImageGenerationSettledRun[];
  completedUrls: readonly string[];
  acceptedRefs: readonly ImageGenerationTaskRef[];
  completionMode: 'completed' | 'submitted';
  translate: CanvasEnvironment['translate'];
}): ImageGenerationSettleOutcome {
  const { settled, completedUrls, acceptedRefs, completionMode, translate } = input;
  if (completedUrls.length > 0) {
    return { kind: 'output', output: batchOutput(acceptedRefs[0] ?? null, completedUrls) };
  }
  const runIndex = settled.findIndex((run) => run.status === 'rejected');
  if (runIndex !== -1) return { kind: 'rethrow', runIndex };
  const ref = acceptedRefs[0];
  if (completionMode === 'submitted' && ref) {
    return { kind: 'output', output: {
      submitted: true,
      task_key: ref.task_key, taskKey: ref.task_key,
      task_type: ref.task_type, taskType: ref.task_type,
      job_id: ref.job_id, jobId: ref.job_id,
    } };
  }
  if (settled.length > 0 && settled.every((run) => run.status === 'fulfilled' && run.value === 'ignored')) {
    return { kind: 'undefined' };
  }
  const message = '图片生成未提交任务，也没有返回图片地址'; // i18n-exempt -- exact browser aggregate fallback text
  return { kind: 'no_result', error: { message }, patch: {
    isGenerating: false, generationStartedAt: null,
    generationTaskKey: null, generationTaskType: null, generationTaskJobId: null,
    generationError: humanizeTaskError(message, translate),
    generationErrorDetails: message, generationErrorRequestId: null,
  } };
}

/**
 * ImageGenNode's generate_image subscriber publishes the hook output unchanged,
 * including success without output for ignored runs; it never rereads node data.
 * Supply the same ordered settled data for rethrow. For errors thrown before
 * settlement, errorMessage is Error.message or String(thrown), exactly as in
 * publishNodeActionError. Request/node/action envelope fields belong to the caller.
 * The subscriber requests completed mode; submitted handles still pass through
 * this publication mapping if supplied by another caller.
 */
export function imageGenerationActionResult(input:
  | { settleOutcome: ImageGenerationSettleOutcome; settled: readonly ImageGenerationSettledRun[] }
  | { errorMessage: string },
): { status: 'success'; output?: Record<string, unknown> } | { status: 'error'; error: string } {
  if ('errorMessage' in input) return { status: 'error', error: input.errorMessage };
  const outcome = input.settleOutcome;
  switch (outcome.kind) {
    case 'output': return { status: 'success', output: outcome.output };
    case 'undefined': return { status: 'success' };
    case 'no_result': return { status: 'error', error: outcome.error.message };
    case 'rethrow': {
      const run = input.settled[outcome.runIndex];
      if (run?.status !== 'rejected') throw new Error('Expected the original rejected run');
      return { status: 'error', error: run.message };
    }
  }
}

function batchOutput(ref: ImageGenerationTaskRef | null, urls: readonly string[]): Record<string, unknown> {
  return {
    ...(ref ? { task_key: ref.task_key, task_type: ref.task_type, job_id: ref.job_id } : {}),
    imageUrl: urls[0], imageUrls: [...urls],
  };
}

/** The browser writes this before its catch performs failure arbitration. */
export function imageGenerationMissingUrlOutcome(runIndex: number, completedUrls: readonly string[]) {
  return {
    message: '图片生成完成但未返回图片地址', // i18n-exempt -- existing manual failure text
    patch: runIndex === 0 && completedUrls.length === 0
      ? { isGenerating: false, generationStartedAt: null } : undefined,
  };
}

/**
 * Per-run completed-mode writes. The caller owns the browser attempt counter
 * and ignores invalidated attempts before applying these patches.
 * For a submit failure, pass the raw Error.message as message and the result of
 * describeGenerationError as error on the failed outcome. If error.referenceIssues
 * is non-empty, pass reference_invalid with the same raw message instead.
 * Omitting error retains the existing task-failure display and diagnostics.
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
    const submitError = 'error' in outcome ? outcome.error : undefined;
    const raw = submitError ? message || submitError.name
      : message || ((outcome.kind === 'cancelled' || (outcome.kind === 'failed' && taskKey))
        ? 'TaskCompletionError' : 'Error');
    return write({
      ...prefix,
      generationError: submitError ? submitError.display : humanizeTaskError(message, translate),
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
      if (first && (input.canAutoCommitOnGenerate
        ?? (nodeData.autoCommitOnGenerate === true && isSystemManagedNodeData(nodeData)))) {
        effects.push({ kind: 'commit_node', nodeId: input.nodeId, auto: true });
      }
      return write({
        ...(first ? buildImageGenerationSuccessPatch(completedUrls[0]) : {}),
        ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
      }, { output: batchOutput(input.firstAcceptedTask, completedUrls) }, effects);
    }
    const missing = imageGenerationMissingUrlOutcome(runIndex, completedUrls);
    missingUrlPatch = missing.patch ?? {};
    message = missing.message;
  } else message = outcome.message;

  // Catch order matters: a successful sibling wins over reference errors and cancellation.
  if (completedUrls.length > 0) return write({}, { output: batchOutput(input.firstAcceptedTask, completedUrls) });
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
