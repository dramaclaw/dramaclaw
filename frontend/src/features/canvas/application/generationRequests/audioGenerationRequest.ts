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
import { selectWorkflowUpstreamText, readCatalog } from '../workflowRecipeCatalog';
import { nodeContextWireFields } from './nodeContextWire';
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

export function audioEffectivePrompt(data: AudioNodeData, contents: UpstreamContent[]): string {
  return [joinUpstreamText(contents).trim(), deriveAudioText(data).trim()]
    .filter((segment) => segment.length > 0).join('\n\n');
}

function promptInputs(ctx: AudioGenerationRequestContext, data: AudioNodeData) {
  const contents = upstreamNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId).map(extractUpstreamContent);
  const joined = joinUpstreamText(contents);
  const ownText = deriveAudioText(data);
  const effectivePrompt = audioEffectivePrompt(data, contents);
  const isMusic = resolveAudioKind(data) === 'music';
  const upstreamText = isMusic ? '' : selectWorkflowUpstreamText(data, contents, joined);
  const fallbackPrompt = isMusic ? effectivePrompt
    : extractExplicitSpeakableAudioText(ownText.trim()) || extractSpeakableAudioText(ownText.trim())
      || extractExplicitSpeakableAudioText(upstreamText) || extractSpeakableAudioText(upstreamText);
  return {
    effectivePrompt, isMusic, directVoiceRecipe: !isMusic && readCatalog(data)?.recipeId === 'drama-shot-voice',
    input: { nodeKind: 'audio', nodePrompt: ownText, upstreamText,
      upstreamContents: isMusic ? [] : contents, fallbackPrompt } satisfies AudioPromptCompileInput,
  };
}

/**
 * Busy precedes caller-owned model access, custom voice, empty prompt and project guards.
 * Blocked callers write a truthy access message and return without running later guards.
 * Busy/access/empty/project return empty success; missing voice returns a successful skip.
 * Empty final speech instead fails after start. Apply render repairs before this decision;
 * voice-reference discovery stays with the caller.
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
  const context = nodeContextWireFields({
    canvasId: ctx.canvasId, nodeId: ctx.nodeId, productOperation: ctx.productOperation,
  });
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

/** Repair music intent without discarding an existing audio result. */
export function audioMusicKindRepairPatch(data: AudioNodeData, nowIso: string): Partial<AudioNodeData> | null {
  if (resolveAudioKind(data) !== 'music' || data.audioKind === 'music') return null;
  return { audioKind: 'music', model: 'suno_music', ...(data.audioUrl ? {} : {
    audioUrl: null, durationMs: null,
    generationError: '背景音乐节点已修正，请重新生成音乐', // i18n-exempt -- exact hook repair contract
    workflowResultStale: true, workflowInvalidatedAt: nowIso,
    workflowInvalidationReason: '音频类型由语音修正为背景音乐', // i18n-exempt -- exact hook repair contract
  }) };
}

export function audioMusicLengthRepairPatch(data: AudioNodeData): Partial<AudioNodeData> | null {
  if (resolveAudioKind(data) !== 'music') return null;
  const length = resolveMusicLengthMs(data);
  return length !== undefined && data.musicLengthMs !== length ? { musicLengthMs: length } : null;
}

/** Previously generated instructions are not speakable audio content. */
export function audioSpeechInstructionRepairPatch(data: AudioNodeData, nowIso: string): Partial<AudioNodeData> | null {
  if (resolveAudioKind(data) === 'music' || !isSpeechGenerationInstruction(deriveAudioText(data)) || !data.audioUrl) return null;
  return { audioUrl: null, durationMs: null,
    generationError: '旁白节点缺少实际朗读文案，请填写旁白正文后重新生成', // i18n-exempt -- exact hook repair contract
    workflowResultStale: true, workflowInvalidatedAt: nowIso,
    workflowInvalidationReason: '旁白生成说明不能作为朗读正文', // i18n-exempt -- exact hook repair contract
  };
}

/** Merge the render repairs in effect order for the server adapter. */
export function audioNodeRepairPatch(data: AudioNodeData, nowIso: string): Partial<AudioNodeData> | null {
  const patches = [audioMusicKindRepairPatch(data, nowIso), audioMusicLengthRepairPatch(data),
    audioSpeechInstructionRepairPatch(data, nowIso)].filter(patch => patch !== null);
  return patches.length ? Object.assign({}, ...patches) : null;
}
