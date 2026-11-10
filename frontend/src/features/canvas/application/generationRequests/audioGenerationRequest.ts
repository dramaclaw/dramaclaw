// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isAudioNode } from '../../domain/canvasNodes';
import type { AudioNodeData, CanvasNode, CanvasEdge } from '../../domain/canvasNodes';
import type { CanvasEnvironment } from '../../core/environment';
import { deriveAudioText, normalizeMusicPrompt } from '../../nodes/audioGenerationText';
import { requiresCustomVoiceSelection, usesLegacySpeechVoice } from '../../nodes/audioVoicePolicy';
import { upstreamNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import { extractUpstreamContent, joinUpstreamText } from '../graphContentResolver';
import {
  extractExplicitSpeakableAudioText, extractSpeakableAudioText, isSpeechGenerationInstruction,
  resolveAudioKind, resolveMusicLengthMs, resolveSafeSpeechSubmissionText,
} from '../audioSpeechText';
import type { UpstreamContent } from '../ports';
import type { CompileWorkflowNodePromptInput } from '../workflowRecipeRuntime';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export interface AudioGenerationRequestContext {
  /** Latest graph snapshot; upstream contents match the hook's captured render projection. */
  nodes: CanvasNode[];
  /** Incoming content edges in connection order; dependency edges do not supply content. */
  edges: CanvasEdge[];
  /** Audio node to run, using its latest data (including same-turn command edits). */
  nodeId: string;
  /** Project from readUrl().project; empty means the URL has no project. */
  projectId: string;
  /** readUrl().canvas ?? 'default', resolved by the caller. */
  canvasId: string;
  /** Store lookup used by nodeContextBody; only an operation with an attempt is serialized. */
  productOperation: WorkflowProductOperationContext | null;
  /** Resolved useNodeGenerationTaskState activity; the node's own busy flag also refuses. */
  isGenerating?: boolean;
  /** Same translator as the hook, for missing-voice and missing-project node patches. */
  translate: CanvasEnvironment['translate'];
}

export type AudioPromptCompileInput = Omit<CompileWorkflowNodePromptInput,
  'nodeId' | 'nodeData' | 'executionSource' | 'onCompileMetadata'>;
type CompileMetadata = Parameters<NonNullable<CompileWorkflowNodePromptInput['onCompileMetadata']>>[0];
type AudioRefusalCode = 'not_audio_node' | 'generation_in_progress' | 'no_effective_prompt';
export type AudioPromptCompileDecision =
  | { kind: 'compile'; input: AudioPromptCompileInput }
  | { kind: 'literal'; prompt: string }
  | { kind: 'skip'; code: 'missing_custom_voice'; patch: Partial<AudioNodeData>;
      output: { skipped: true; reason: 'missing_custom_voice' } }
  | { kind: 'refuse'; code: AudioRefusalCode; message: string }
  | { kind: 'refuse'; code: 'no_project'; message: string; patch: Partial<AudioNodeData> };
export interface AudioGenerationHttpRequest {
  method: 'POST';
  /** Relative to the API base. */
  path: string;
  /** JSON wire body: absent optional values have already been omitted. */
  body: Record<string, unknown>;
}
export type AudioGenerationRequestResult = { ok: true; requests: AudioGenerationHttpRequest[] }
  | { ok: false; code: AudioRefusalCode | 'no_project' | 'missing_custom_voice' | 'no_speakable_text'; message: string };
const NOT_AUDIO_NODE = 'The target node must be an audio node.';

function nodeData(ctx: AudioGenerationRequestContext): AudioNodeData | undefined {
  const node = ctx.nodes.find((candidate) => candidate.id === ctx.nodeId);
  return isAudioNode(node) ? node.data : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function strategyText(value: unknown): string {
  return typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
/** Match selectWorkflowUpstreamText without loading the network-backed recipe runtime. */
function selectedUpstreamText(data: AudioNodeData, contents: UpstreamContent[], fallback: string): string {
  const catalog = record(data.workflowCatalog);
  const builder = record(catalog?.promptBuilder);
  const strategy = record(catalog?.inputStrategy) ?? record(builder?.inputStrategy);
  if (!strategy) return fallback;
  const type = strategyText(strategy.type);
  if (type === 'none' || type === 'user_assets' || type === 'user_message') return '';
  const single = strategyText(strategy.stepId) || strategyText(strategy.step_id);
  const multiple = Array.isArray(strategy.stepIds) ? strategy.stepIds
    : Array.isArray(strategy.step_ids) ? strategy.step_ids : [];
  const stepIds = single ? [single] : multiple.map(strategyText).filter(Boolean);
  if (stepIds.length === 0 || !contents.some((content) => Boolean(content.workflowStepId))) return fallback;
  const wanted = new Set(stepIds);
  return joinUpstreamText(contents.filter((content) => content.workflowStepId && wanted.has(content.workflowStepId)));
}

function promptInputs(ctx: AudioGenerationRequestContext, data: AudioNodeData) {
  const contents = upstreamNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId).map(extractUpstreamContent);
  const joined = joinUpstreamText(contents);
  const ownText = deriveAudioText(data);
  const effectivePrompt = [joined.trim(), ownText.trim()].filter((segment) => segment.length > 0).join('\n\n');
  const isMusic = resolveAudioKind(data) === 'music';
  const upstreamText = isMusic ? '' : selectedUpstreamText(data, contents, joined);
  const fallbackPrompt = isMusic ? effectivePrompt
    : extractExplicitSpeakableAudioText(ownText.trim()) || extractSpeakableAudioText(ownText.trim())
      || extractExplicitSpeakableAudioText(upstreamText) || extractSpeakableAudioText(upstreamText);
  const catalog = record(data.workflowCatalog);
  return {
    effectivePrompt, isMusic, directVoiceRecipe: !isMusic && catalog?.recipeId === 'drama-shot-voice',
    input: { nodeKind: 'audio', nodePrompt: ownText, upstreamText,
      upstreamContents: isMusic ? [] : contents, fallbackPrompt } satisfies AudioPromptCompileInput,
  };
}

/**
 * generate() guard order: useAudioGeneration.ts:141 busy,
 * useAudioGeneration.ts:142 model-task access, useAudioGeneration.ts:148
 * missing custom voice, useAudioGeneration.ts:157 empty initial prompt,
 * useAudioGeneration.ts:159 missing project. Access is network state and stays with the caller: after busy, before custom voice, if
 * blocked write { generationError: modelTaskAccess.message } only when that
 * message is truthy, then return {}. Run no later guard in that case.
 * Busy/access/empty/project return {} and AudioNode.tsx:116-133 publishes SUCCESS
 * without submission (it can include a previously stored audioUrl). Missing
 * voice publishes SUCCESS with the exact skipped output below. Empty final
 * speech instead throws inside the try block (useAudioGeneration.ts:233) and
 * becomes an action failure.
 * Apply audioNodeRepairPatch before this decision; voice-reference discovery is
 * caller network preparation. Inline data: URLs cannot occur in audio requests:
 * this path submits text and voice identifiers, with no media references.
 */
export function audioPromptCompileInput(ctx: AudioGenerationRequestContext): AudioPromptCompileDecision {
  const data = nodeData(ctx);
  if (!data) return { kind: 'refuse', code: 'not_audio_node', message: NOT_AUDIO_NODE };
  if (ctx.isGenerating || data.isGenerating === true) {
    return { kind: 'refuse', code: 'generation_in_progress', message: 'Audio generation is already in progress.' };
  }
  const { effectivePrompt, isMusic, directVoiceRecipe, input } = promptInputs(ctx, data);
  if (!isMusic && requiresCustomVoiceSelection(data)) {
    return { kind: 'skip', code: 'missing_custom_voice', patch: {
      isGenerating: false, generationStartedAt: null, generationError: ctx.translate('node.audioNode.selectVoiceFirst'),
    }, output: { skipped: true, reason: 'missing_custom_voice' } };
  }
  if (effectivePrompt.length === 0) {
    return { kind: 'refuse', code: 'no_effective_prompt', message: 'An audio prompt or upstream text is required.' };
  }
  if (!ctx.projectId) {
    return { kind: 'refuse', code: 'no_project', message: 'A project is required.',
      patch: { generationError: ctx.translate('canvas.generation.missingProjectParam') } };
  }
  return directVoiceRecipe ? { kind: 'literal', prompt: input.fallbackPrompt } : { kind: 'compile', input };
}

/** Exactly the onCompileMetadata write; compiledAt is supplied by the caller's clock. */
export function audioPromptCompileMetadataPatch(ctx: AudioGenerationRequestContext, metadata: CompileMetadata, compiledAt: string) {
  const data = nodeData(ctx);
  if (!data) throw new Error(NOT_AUDIO_NODE);
  const { isMusic, input } = promptInputs(ctx, data);
  return {
    workflowRecipeCompileMode: metadata.mode,
    workflowRecipeCompiledAt: compiledAt,
    workflowRecipeCompiledPrompt: metadata.prompt,
    text: isMusic ? metadata.prompt : resolveSafeSpeechSubmissionText({ compileMode: metadata.mode,
      compiledPrompt: metadata.prompt, recipeIds: metadata.recipeIds, safeFallbackPrompt: input.fallbackPrompt }),
    workflowRecipeIds: metadata.recipeIds,
  };
}

/**
 * Build the hook's POST after external compilation (null/[] receipt when no
 * callback ran). Use the same pre-compilation graph snapshot for both phases:
 * the metadata patch can change text but generate() retains runtimeData.
 * Model-task access stays with the caller as documented above. A
 * no_speakable_text result corresponds to the hook's thrown error: the caller
 * must persist message as generationError, clear generation task/loading fields
 * and publish failure, rather than treating it as a silent refusal or skip.
 */
export function buildAudioGenerationRequest(ctx: AudioGenerationRequestContext & {
  prompt: string; compileMode: string | null; recipeIds: string[];
}): AudioGenerationRequestResult {
  const decision = audioPromptCompileInput(ctx);
  if (decision.kind === 'refuse') return { ok: false, code: decision.code, message: decision.message };
  if (decision.kind === 'skip') return { ok: false, code: decision.code, message: 'Select an available custom voice.' };
  const data = nodeData(ctx);
  if (!data) return { ok: false, code: 'not_audio_node', message: NOT_AUDIO_NODE };
  const isMusic = resolveAudioKind(data) === 'music';
  const prompt = decision.kind === 'literal' ? decision.prompt
    : isMusic ? normalizeMusicPrompt(ctx.prompt)
    : resolveSafeSpeechSubmissionText({ compileMode: ctx.compileMode, compiledPrompt: ctx.prompt,
        recipeIds: ctx.recipeIds, safeFallbackPrompt: decision.input.fallbackPrompt });
  if (!prompt) {
    return { ok: false, code: 'no_speakable_text', message: '没有可朗读的旁白或对白' }; // i18n-exempt -- exact hook failure contract
  }
  const context = {
    ...(ctx.canvasId ? { canvas_id: ctx.canvasId } : {}),
    ...(ctx.nodeId ? { node_id: ctx.nodeId } : {}),
    ...(ctx.productOperation?.generationAttemptId ? { product_operation_id: ctx.productOperation.operationId,
      generation_attempt_id: ctx.productOperation.generationAttemptId } : {}),
  };
  let body: AudioGenerationHttpRequest['body'];
  if (isMusic) {
    const length = resolveMusicLengthMs(data);
    body = { ...context, input: prompt, ...(length !== undefined ? { music_length_ms: length } : {}),
      force_instrumental: data.forceInstrumental ?? true, respect_sections_durations: data.respectSectionsDurations ?? true };
  } else {
    const legacy = usesLegacySpeechVoice(data);
    const preset = legacy && data.speechMode === 'preset';
    const voice = data.voiceRef ?? (legacy ? { scope: 'project_narrator' as const } : undefined);
    body = { ...context, text: prompt, speech_mode: preset ? 'preset' : 'clone',
      preset_model: (preset ? data.presetModel : undefined) ?? 'edge-tts',
      preset_voice: (preset ? data.presetVoice : undefined) ?? 'Serena',
      emotion_prompt: (data.emotionPrompt ?? '').trim() || '',
      voice_ref: voice ? { scope: voice.scope, character_name: voice.characterName ?? '', identity_id: voice.identityId ?? '',
        slot: voice.slot ?? '', voice_id: voice.voiceId ?? '' } : null };
  }
  return { ok: true, requests: [{ method: 'POST',
    path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/audio/${isMusic ? 'eleven-music' : 'speech'}`, body }] };
}

/** Merge of the hook's three render-effect writes, in effect order; apply before generate(). */
export function audioNodeRepairPatch(data: AudioNodeData, nowIso: string): Partial<AudioNodeData> | null {
  const isMusic = resolveAudioKind(data) === 'music';
  const patch: Partial<AudioNodeData> = {};
  if (isMusic && data.audioKind !== 'music') {
    Object.assign(patch, { audioKind: 'music', model: 'suno_music', ...(data.audioUrl ? {} : {
      audioUrl: null, durationMs: null,
      generationError: '背景音乐节点已修正，请重新生成音乐', // i18n-exempt -- exact hook repair contract
      workflowResultStale: true, workflowInvalidatedAt: nowIso,
      workflowInvalidationReason: '音频类型由语音修正为背景音乐', // i18n-exempt -- exact hook repair contract
    }) });
  }
  const length = isMusic ? resolveMusicLengthMs(data) : undefined;
  if (isMusic && length !== undefined && data.musicLengthMs !== length) patch.musicLengthMs = length;
  if (!isMusic && isSpeechGenerationInstruction(deriveAudioText(data)) && data.audioUrl) {
    Object.assign(patch, { audioUrl: null, durationMs: null,
      generationError: '旁白节点缺少实际朗读文案，请填写旁白正文后重新生成', // i18n-exempt -- exact hook repair contract
      workflowResultStale: true, workflowInvalidatedAt: nowIso,
      workflowInvalidationReason: '旁白生成说明不能作为朗读正文', // i18n-exempt -- exact hook repair contract
    });
  }
  return Object.keys(patch).length ? patch : null;
}
