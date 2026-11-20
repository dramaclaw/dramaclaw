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
export type AudioGenerationHookOutput = {
  audioUrl?: string;
  skipped?: boolean;
  reason?: string;
};
export interface AudioGenerationHookError {
  /** Error.message for Errors, String(thrown) otherwise; never the translated display. */
  message: string;
  isError: boolean;
  /** isVoicePrerequisiteError(thrown), including its String conversion for non-Errors. */
  voicePrerequisite: boolean;
}
export function audioGenerationHookError(thrown: unknown): AudioGenerationHookError {
  return { message: thrown instanceof Error ? thrown.message : String(thrown),
    isError: thrown instanceof Error, voicePrerequisite: isVoicePrerequisiteError(thrown) };
}

export type AudioGenerationOutcome = { kind: 'completed'; url: string; durationMs?: number | null }
  | ({ kind: 'failed' } & AudioGenerationHookError);
export type AudioGenerationOutcomeResult = {
  patches: Partial<AudioNodeData>[];
} & ({ hookOutput: AudioGenerationHookOutput } | { hookError: AudioGenerationHookError });

/** Start clears only generationError, retaining previous media/diagnostics/handles. */
export function audioGenerationStartPatch(startedAtMs: number): Partial<AudioNodeData> {
  return { isGenerating: true, generationStartedAt: startedAtMs, generationError: null };
}

/** Persisted descriptor only, without resetting loading or previous media. */
export function audioGenerationAcceptedPatch(ref: AudioGenerationTaskRef) {
  return generationTaskDescriptor(ref);
}

/**
 * The voice prerequisite matcher matches an unanchored, case-sensitive message:
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
 * Apply start, compile metadata (except literal voice recipes), accepted, then outcome patches.
 * Completion uses the fetched job URL, including an empty string, ignoring the task payload.
 * Both outcomes clear task/loading fields and retain diagnostics and workflow staleness.
 * Failure retains media/duration and writes Error.message verbatim, even when empty;
 * non-Errors use the translated fallback. Cancellation and timeout also clear handles.
 * The hook writes the first patch; the subscriber applies the voice-prerequisite skip patch.
 */
export function audioGenerationOutcomePatch(input: {
  outcome: AudioGenerationOutcome;
  translate: CanvasEnvironment['translate'];
}): AudioGenerationOutcomeResult {
  const { outcome, translate } = input;
  if (outcome.kind === 'completed') {
    return { patches: [{ ...clearedTaskFields, audioUrl: outcome.url,
      durationMs: outcome.durationMs ?? null, generationError: null }],
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
 * Skipped output passes through. Otherwise the latest truthy string audioUrl overrides
 * the hook URL; empty/nonstring values do not erase it. The caller supplies latest data
 * only for an audio node. Successful completion ignores generationError; failures publish
 * the original Error.message or String(thrown).
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
