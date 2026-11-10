// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../../core/environment';
import type { AudioNodeData } from '../../domain/canvasNodes';
import { isVoicePrerequisiteError } from '../../nodes/audioVoicePrerequisite';
import { generationTaskDescriptor } from '../generationTaskDescriptor';
import type { GenerationErrorInfo } from './generationSubmitError';

export interface AudioGenerationTaskRef {
  task_key: string;
  task_type: string;
  job_id: string;
}
export interface AudioGenerationHookOutput {
  audioUrl?: string;
  skipped?: boolean;
  reason?: string;
}
export interface AudioGenerationHookError {
  /** Error.message for Errors, String(thrown) otherwise; never the translated display. */
  message: string;
  isError: boolean;
  /** isVoicePrerequisiteError(thrown), including its String conversion for non-Errors. */
  voicePrerequisite: boolean;
}
export type AudioGenerationOutcome = { kind: 'completed'; url: string }
  | ({ kind: 'failed' } & AudioGenerationHookError);
export type AudioGenerationOutcomeResult = {
  patches: Partial<AudioNodeData>[];
} & ({ hookOutput: AudioGenerationHookOutput } | { hookError: AudioGenerationHookError });

/** useAudioGeneration.ts:163: start clears only generationError, retaining previous media/diagnostics/handles. */
export function audioGenerationStartPatch(startedAtMs: number): Partial<AudioNodeData> {
  return { isGenerating: true, generationStartedAt: startedAtMs, generationError: null };
}

/** useAudioGeneration.ts:259: persisted descriptor only, without resetting loading or previous media. */
export function audioGenerationAcceptedPatch(ref: AudioGenerationTaskRef) {
  return generationTaskDescriptor(ref);
}

/**
 * audioVoicePrerequisite.ts:12 matches an unanchored, case-sensitive message:
 * voice unconfigured; missing ... voice; configure or select voice first; or
 * upload or record ... audio. Each `.*` excludes line terminators. No error
 * class, status, structured code, translated display or diagnostics are checked.
 * For submit Errors use describeGenerationSubmitFailure/describeGenerationError;
 * task Errors use describeGenerationError or the same raw message. This adapter
 * tests info.message only. For arbitrary non-Errors classify the original thrown
 * value with isVoicePrerequisiteError before serializing String(thrown), since
 * describeGenerationError may substitute a fallback for a non-Error message.
 */
export function isAudioVoicePrerequisiteFailure(info: GenerationErrorInfo): boolean {
  return isVoicePrerequisiteError(new Error(info.message));
}

const clearedTaskFields = {
  isGenerating: false, generationStartedAt: null,
  generationTaskKey: null, generationTaskType: null, generationTaskJobId: null,
};

/**
 * Apply start, any audioPromptCompileMetadataPatch (useAudioGeneration.ts:214),
 * accepted, then these patches in order. Compilation is skipped for the literal
 * voice recipe (useAudioGeneration.ts:189); early request skips never start.
 *
 * useAudioGeneration.ts:260-272 ignores the completion payload and fetches the
 * audio-specific job result; completed.url is that result.url, including ''.
 * Success clears the task handle/loading, resets durationMs, stores even an empty
 * audioUrl, clears only generationError, and returns {} for an empty URL.
 * Failure (useAudioGeneration.ts:273-282) also clears the handle/loading but
 * retains media/duration; Error.message is written verbatim, even when empty.
 * Non-Errors write the translated fallback but are rethrown unchanged; hookError
 * retains String(thrown) for publication (nodeActionResult.ts:107).
 * Cancellation and poll timeout have no special handling here: their handles
 * are cleared, preventing handle-based resumption despite the timeout contract
 * in api/tasks.ts:65. No phase writes generationErrorDetails/RequestId or clears
 * workflowResultStale (useAudioGeneration.ts:163,214,259,266,278).
 *
 * AudioNode.tsx:129-143 then handles voice prerequisites with a second write and
 * a successful skip, including agent_instruction; other failures publish errors.
 */
export function audioGenerationOutcomePatch(input: {
  outcome: AudioGenerationOutcome;
  translate: CanvasEnvironment['translate'];
}): AudioGenerationOutcomeResult {
  const { outcome, translate } = input;
  if (outcome.kind === 'completed') {
    return { patches: [{ ...clearedTaskFields, audioUrl: outcome.url, durationMs: null, generationError: null }],
      hookOutput: outcome.url ? { audioUrl: outcome.url } : {} };
  }
  const patches: Partial<AudioNodeData>[] = [{ ...clearedTaskFields,
    generationError: outcome.isError ? outcome.message : translate('node.audioNode.generateFailed') }];
  if (outcome.voicePrerequisite) {
    patches.push({ isGenerating: false, generationStartedAt: null, voiceAvailable: false,
      generationError: '未选择可用自定义声线，已跳过生成' }); // i18n-exempt -- exact subscriber skip patch
  }
  return { patches, hookError: { message: outcome.message, isError: outcome.isError,
    voicePrerequisite: outcome.voicePrerequisite } };
}

/**
 * AudioNode.tsx:114-143: skipped hook output passes through unchanged. Otherwise
 * the latest truthy string audioUrl overrides the hook URL; empty/nonstring store
 * values do not erase the hook URL. Caller supplies latestNodeData only for an
 * audio node (undefined for a removed node or changed type), as at AudioNode.tsx:118.
 * No generationError field is consulted on successful hook completion.
 * Error.message / String(thrown) is published exactly (nodeActionResult.ts:107).
 */
export function audioGenerationActionResult(input: {
  latestNodeData: Record<string, unknown> | undefined;
} & ({ hookOutput: AudioGenerationHookOutput } | { hookError: AudioGenerationHookError })):
  | { status: 'success'; output: AudioGenerationHookOutput & { agent_instruction?: string } }
  | { status: 'error'; error: string } {
  if ('hookError' in input) {
    return input.hookError.voicePrerequisite
      ? { status: 'success', output: { skipped: true, reason: 'missing_custom_voice',
          agent_instruction: '未选择自定义声线，本音频节点已跳过，继续其它工作流节点。' } } // i18n-exempt -- exact subscriber action protocol
      : { status: 'error', error: input.hookError.message };
  }
  if (input.hookOutput.skipped) return { status: 'success', output: input.hookOutput };
  const latestAudioUrl = input.latestNodeData?.audioUrl;
  return { status: 'success', output: {
    ...(input.hookOutput.audioUrl ? { audioUrl: input.hookOutput.audioUrl } : {}),
    ...(typeof latestAudioUrl === 'string' && latestAudioUrl ? { audioUrl: latestAudioUrl } : {}),
  } };
}
