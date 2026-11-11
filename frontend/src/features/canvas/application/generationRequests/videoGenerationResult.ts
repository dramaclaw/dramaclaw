// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../../core/environment';
import type { ReferenceIssue } from '../../domain/referenceIssues';
import { referenceDurationIssues } from '../../domain/referenceDurationIssues';
import { generationTaskDescriptor } from '../generationTaskDescriptor';
import { describeGenerationError, type GenerationErrorInfo } from './generationSubmitError';
import type { VideoGenerationRequestResult } from './videoGenerationRequest';
import { resolveOutputUrl } from './videoOutputUrl';

type Translate = CanvasEnvironment['translate'];
type Patch = Record<string, unknown>;
export interface VideoGenerationTaskRef { task_key: string; task_type: string; job_id: string }
export type VideoGenerationNotice =
  | { kind: 'reference_issues'; issues: ReferenceIssue[] }
  | { kind: 'still_running' }
  | { kind: 'error_dialog'; message: string; title: string; details: string | null }
  | { kind: 'partial_failure'; ok: number; total: number }
  | null;
export type VideoGenerationRunError =
  | { kind: 'failed'; error: GenerationErrorInfo }
  | { kind: 'poll_timeout' };
export type VideoGenerationRunOutcome =
  | { kind: 'completed'; result: Record<string, unknown> | null; fallbackUrl: string | null }
  | { kind: 'failed'; error: GenerationErrorInfo }
  | { kind: 'cancelled' }
  | { kind: 'poll_timeout' };
export interface VideoGenerationRunInput {
  runIndex: number;
  total: number;
  completedUrls: string[];
  outcome: VideoGenerationRunOutcome;
}
type RequestRefusal = Extract<VideoGenerationRequestResult, { ok: false }>;
export type VideoGenerationRefusalInput =
  | (Extract<RequestRefusal, { code: 'reference_duration_invalid' }> & { startedAtMs: number })
  | (Omit<Exclude<RequestRefusal, { code: 'reference_duration_invalid' }>, 'phase'> & {
      startedAtMs: number;
      phase?: 'guard' | 'keyframes' | 'images' | 'source_video' | 'references' | 'unsupported_mode';
      isHappyHorseModel?: boolean;
    });

/** Start before compile; the old album survives early returns. */
export function videoGenerationStartPatch(startedAtMs: number): Patch {
  return { isGenerating: true, generationStartedAt: startedAtMs,
    generationError: null, generationErrorDetails: null, generationErrorRequestId: null };
}
/** A separate write immediately before starting the runs. */
export function videoGenerationSubmitPatch(): Patch { return { generationBatch: null }; }
/** Caller applies this for run 0 only, regardless of acceptance order. */
export function videoGenerationAcceptedPatch(ref: VideoGenerationTaskRef): Patch {
  return generationTaskDescriptor(ref);
}
const resetLoading = { isGenerating: false, generationStartedAt: null };
function referenceErrorPatch(translate: Translate): Patch {
  return { generationError: translate('referenceValidation.title'),
    generationErrorDetails: null, generationErrorRequestId: null };
}

/**
 * Exact early-return writes, including start when the branch is reached after compile.
 * A code alone is ambiguous: missing_media is either submitDisabled (phase guard),
 * Missing keyframes (keyframes), or missing submittable images (images). Source video
 * may likewise disappear during compile (source_video). Supply the observed phase.
 * For duration, supply the same resolved min/max limits used by the browser validator.
 *
 * Model/busy/capability/cap/prompt/media guards do no writes.
 * No project returns before start (also videoUpscale.ts:73).
 * Missing keyframes writes a node error after start.
 * Missing images/video just resets loading.
 * Unsupported omni is normally a silent admission guard.
 * Its defensive branch (unsupported_mode) would show
 * a dialog and reset loading, but is shadowed by that same capability guard.
 * Empty omni references resets loading after start.
 * Duration opens reference issues and writes the title error.
 *
 * not_video_node and extend_clip_not_prepared are pure request-boundary refusals.
 * inline_media_reference usually has no corresponding browser early return, except
 * an inline-only preview takes the empty-image/keyframe branch (images/keyframes). Otherwise
 * there is no synthetic browser patch or notice here. The browser prepares clips
 * itself; inline sources can be forwarded, while inline links hit the document
 * guard.
 * Missing upscale source is an action error before submit, not a dialog or node write.
 * videoUpscaleActionResult represents that action error.
 */
export function videoGenerationRefusalOutcome(refusal: VideoGenerationRefusalInput, translate: Translate): {
  patches: Patch[]; notice: VideoGenerationNotice;
} {
  const start = videoGenerationStartPatch(refusal.startedAtMs);
  switch (refusal.code) {
    case 'missing_media':
    case 'inline_media_reference':
      if (refusal.phase === 'keyframes') return { patches: [start, { ...resetLoading,
        generationError: translate('node.videoNode.generation.missingKeyframe') }], notice: null };
      return { patches: refusal.phase === 'images' ? [start, { ...resetLoading }] : [], notice: null };
    case 'missing_source_video':
      return { patches: refusal.phase === 'source_video' ? [start, { ...resetLoading }] : [], notice: null };
    case 'missing_references':
      return { patches: refusal.phase === 'references' ? [start, { ...resetLoading }] : [], notice: null };
    case 'mode_unsupported_by_model':
      if (refusal.phase !== 'unsupported_mode') return { patches: [], notice: null };
      return { patches: [start, { ...resetLoading }], notice: { kind: 'error_dialog',
        message: translate(refusal.isHappyHorseModel ? 'node.videoNode.allReference.happyHorseUnsupported'
          : 'node.videoNode.allReference.modelUnsupported'), title: translate('common.error'), details: null } };
    case 'reference_duration_invalid':
      return { patches: [start, { ...resetLoading, ...referenceErrorPatch(translate) }],
        notice: { kind: 'reference_issues', issues: referenceDurationIssues(refusal.media, refusal.rejection, refusal.durationLimits) } };
    case 'not_video_node':
    case 'no_model':
    case 'no_project':
    case 'generation_in_progress':
    case 'no_effective_prompt':
    case 'reference_limit_exceeded':
    case 'model_capability_error':
    case 'extend_clip_not_prepared':
    case 'missing_upscale_source':
      return { patches: [], notice: null };
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

/**
 * The outer catch leaves diagnostics/handles alone. Caller
 * clears album pending count and, for continuity preparation, emits error.display
 * as a toast.
 */
export function videoGenerationFailurePatch(error: GenerationErrorInfo): Patch {
  return { ...resetLoading, generationError: error.display };
}

/**
 * Mirror runOne without awaiting or mutating input. fallbackUrl is null when the
 * job-result lookup was not needed, failed, or returned an empty URL; otherwise pass
 * its url. A direct result always wins. The caller performs the lookup if needed.
 * For task failure use describeGenerationError(new TaskCompletionError(message,
 * 'failed', taskKey), translate, translate('node.videoNode.generation.failed')).
 * For submit failure use describeGenerationSubmitFailure with that same fallback.
 * Detect cancellation and the real TaskPollTimeoutError before describing failures.
 *
 * Browser quirks:
 * - only run 0 owns the handle; duplicates are appended, never deduplicated.
 * - first URL in completion order wins and clears errors, not task handles.
 * - no URL only errors for run 0 with no successes; never a runErrors entry.
 * - cancellation adds no run error; only run 0 without success resets loading.
 * - failure/timeout is recorded even after success; successes suppress writes.
 * - a nonzero failed run writes diagnostics without ending loading.
 * - no stale-task arbitration; busy tasks are refused at admission.
 */
export function videoGenerationRunOutcome(input: VideoGenerationRunInput, translate: Translate): {
  patch: Patch | null; completedUrls: string[]; runError: VideoGenerationRunError | null;
} {
  const { outcome, runIndex, total } = input;
  const completedUrls = [...input.completedUrls];
  const finish = (patch: Patch | null, runError: VideoGenerationRunError | null = null) => ({ patch, completedUrls, runError });
  if (outcome.kind === 'completed') {
    const url = resolveOutputUrl(outcome.result) || outcome.fallbackUrl;
    if (url) {
      completedUrls.push(url);
      return finish({ ...(completedUrls.length === 1 ? { videoUrl: url, ...resetLoading,
        sourceFileName: null, generationError: null, generationErrorDetails: null, generationErrorRequestId: null } : {}),
      ...(total > 1 ? { generationBatch: [...completedUrls] } : {}) });
    }
    return finish(runIndex === 0 && completedUrls.length === 0 ? { ...resetLoading,
      generationError: translate('node.videoNode.generation.noResult'),
      generationErrorDetails: null, generationErrorRequestId: null } : null);
  }
  if (outcome.kind === 'cancelled') return finish(runIndex === 0 && !completedUrls.length ? { ...resetLoading } : null);
  if (outcome.kind === 'poll_timeout') return finish(null, { kind: 'poll_timeout' });
  const { error } = outcome;
  return finish(completedUrls.length ? null : {
    ...(runIndex === 0 ? resetLoading : {}), generationError: error.display,
    generationErrorDetails: error.details, generationErrorRequestId: error.requestId,
  }, { kind: 'failed', error });
}

/**
 * Mirror post-allSettled. runErrors is in catch/push order,
 * not index order; first error controls reference issues and the single dialog.
 * Caller owns album pending count (set before runs, clear after settle and outer
 * failure), panel collapse on first acceptance, and history refresh after settle
 * except reference issues (early return). All-timeout also refreshes history.
 * Caller enriches reference issues with unique upstream nodeId/label using the
 * pre-run reference snapshot, and opens the issue panel.
 * The returned issues retain the backend values, before that graph projection.
 */
export function videoGenerationSettleOutcome(input: {
  completedUrls: string[]; runErrors: VideoGenerationRunError[]; total: number;
  supportsHumanReview: boolean; humanReview: boolean;
}, translate: Translate): { patch: Patch | null; notice: VideoGenerationNotice } {
  const { completedUrls, runErrors, total } = input;
  const first = runErrors[0];
  if (!first) return { patch: null, notice: null };
  if (completedUrls.length) return { patch: null, notice: { kind: 'partial_failure', ok: completedUrls.length, total } };
  if (first.kind === 'failed' && first.error.referenceIssues.length) return {
    patch: referenceErrorPatch(translate), notice: { kind: 'reference_issues', issues: first.error.referenceIssues },
  };
  if (runErrors.every((error) => error.kind === 'poll_timeout')) return { patch: null, notice: { kind: 'still_running' } };
  // api/tasks.ts:81: the same first timeout still supplies the dialog when mixed with failures.
  const error = first.kind === 'failed' ? first.error : describeGenerationError(
    new Error('task polling detached: no server activity'), translate, translate('node.videoNode.generation.failed'));
  const faceBlocked = input.supportsHumanReview && !input.humanReview
    && `${error.display}\n${error.details ?? ''}`.includes('InputImageSensitiveContentDetected.PrivateInformation');
  return { patch: null, notice: { kind: 'error_dialog',
    message: faceBlocked ? translate('node.videoNode.generation.faceBlockedMessage') : error.display,
    title: translate(faceBlocked ? 'node.videoNode.generation.faceBlockedTitle' : 'common.error'), details: error.details } };
}

export type VideoGenerationActionResult =
  | { status: 'success'; output: Record<string, unknown> }
  | { status: 'error'; error: string };
/**
 * After handleSubmit resolves, publish current node error
 * or URL. Single mode still waits for all runs, then adds submitted:true. Silent
 * refusals/timeouts may publish the previous URL (unless a previous error remains).
 * Missing/removed node data behaves as an empty object. No task fields are cleared.
 */
export function videoGenerationActionResult(finalNodeData: Record<string, unknown> | null | undefined,
  executionMode: string | undefined): VideoGenerationActionResult {
  if (typeof finalNodeData?.generationError === 'string' && finalNodeData.generationError) {
    return { status: 'error', error: finalNodeData.generationError };
  }
  return videoSuccessResult(finalNodeData, executionMode);
}
function videoSuccessResult(data: Record<string, unknown> | null | undefined, executionMode: string | undefined): VideoGenerationActionResult {
  const videoUrl = typeof data?.videoUrl === 'string' ? data.videoUrl : undefined;
  return { status: 'success', output: { ...(videoUrl ? { videoUrl } : {}),
    ...(executionMode === 'single' ? { submitted: true } : {}) } };
}
/** videoUpscale.ts:79-83: unlike ordinary video, only generationError is cleared. */
export function videoUpscaleStartPatch(startedAtMs: number): Patch {
  return { isGenerating: true, generationStartedAt: startedAtMs, generationError: null };
}
/** videoUpscale.ts:92: upscale persists its accepted handle. */
export function videoUpscaleAcceptedPatch(ref: VideoGenerationTaskRef): Patch { return generationTaskDescriptor(ref); }
export type VideoUpscaleOutcome =
  | { kind: 'completed'; result: Record<string, unknown> | null; fallbackUrl: string }
  | { kind: 'failed'; message: string }
  | { kind: 'poll_timeout' };
/**
 * videoUpscale.ts:96-107: only output_url is read; otherwise use the job-result
 * fallback, including an empty URL. Caller owns fallback fetch; a failed fetch is
 * a failed outcome (ordinary video swallows that fetch failure). videoUpscale.ts:108-119: timeout
 * gives no patch and calls notifyTaskStillRunning() without a translator. Other
 * failures write raw thrown Error.message (or String(thrown)), never display text.
 * videoUpscale.ts:102-107: success retains sourceFileName, diagnostics and task handle fields.
 */
export function videoUpscaleOutcomePatch(outcome: VideoUpscaleOutcome): Patch | null {
  if (outcome.kind === 'poll_timeout') return null;
  if (outcome.kind === 'failed') return { ...resetLoading, generationError: outcome.message };
  const url = outcome.result?.output_url || outcome.fallbackUrl;
  return { videoUrl: url, ...resetLoading, generationError: null };
}
/**
 * Source absence publishes an error before submit. Otherwise
 * the resolved upscale helper ALWAYS publishes success, even with a node error.
 * No project returns silently (videoUpscale.ts:73-75), so the old URL is published.
 * Caller must retain the admission source value if node data changes while waiting.
 */
export function videoUpscaleActionResult(finalNodeData: Record<string, unknown> | null | undefined,
  executionMode: string | undefined): VideoGenerationActionResult {
  if (typeof finalNodeData?.upscaleSourceUrl !== 'string' || !finalNodeData.upscaleSourceUrl) {
    return { status: 'error', error: '缺少高清视频源' }; // i18n-exempt -- exact subscriber action error
  }
  return videoSuccessResult(finalNodeData, executionMode);
}
