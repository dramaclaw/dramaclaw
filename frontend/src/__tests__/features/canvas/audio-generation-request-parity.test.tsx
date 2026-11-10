// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import {
  audioNodeRepairPatch, audioPromptCompileInput, audioPromptCompileMetadataPatch,
  buildAudioGenerationRequest, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, isAudioNode, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AudioNode } from '@/features/canvas/nodes/AudioNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectImportGraph } from '../canvas-core/importGraph';

const scope = vi.hoisted(() => ({ project: '', canvas: undefined as string | undefined, blocked: false, message: null as string | null }));
const translate = (key: string) => key;
// Keep the component, hook, store, graph projection and ops serializers real.
// Translation and URL mocks make caller inputs deterministic without a browser URL.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/lib/url-params', async (original) => ({
  ...(await original<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: scope.project, canvas: scope.canvas }),
}));
// Access and credit hooks otherwise query network state unrelated to request construction.
vi.mock('@/lib/model-task-access', async (original) => ({
  ...(await original<typeof import('@/lib/model-task-access')>()),
  useModelTaskAccess: () => ({ blocked: scope.blocked, message: scope.message, denialReason: null }),
}));
vi.mock('@/lib/queries/generation-credit-cost', async (original) => ({
  ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
// Lowest transport boundary: real ops still choose paths and serialize JSON.
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  apiClient: vi.fn(() => { throw new Error('Unexpected apiClient call'); }),
  apiCall: vi.fn(async (route: string) => {
    if (/\/freezone\/audio\/references$/.test(route)) return { available: [{ scope: 'project_narrator' }] };
    if (/\/freezone\/audio\/(speech|eleven-music)$/.test(route)) return {
      task_key: 'audio-task', job_id: 'audio-job',
      task_type: route.endsWith('/speech') ? 'freezone_audio_speech' : 'freezone_audio_eleven_music',
    };
    if (/\/freezone\/jobs\/freezone_audio_(speech|eleven_music)\/audio-job\/result$/.test(route)) return { url: '/static/audio.mp3' };
    throw new Error(`Unexpected API call: ${route}`);
  }),
}));
// The real player fetches/decodes returned media on mount (observed in the first run).
// Replace only that presentation child; request generation does not depend on playback.
vi.mock('@/features/canvas/ui/AudioWaveformPlayer', () => ({ AudioWaveformPlayer: () => null }));
// Polling and compilation are external operations; metadata callbacks still run against the real store.
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn(async () => ({})),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(async (input) => input.fallbackPrompt),
}));

function audioNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
    data: { audioUrl: null, text: 'A quiet morning.', ...data } };
}
function source(id: string, content: string, stepId?: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 },
    data: { content, ...(stepId ? { workflowCatalog: { stepId } } : {}) } };
}
type Fixture = AudioGenerationRequestContext & {
  name: string; repairKeys?: string[]; runtimePatch?: Partial<AudioNodeData>; metadata?: FreezoneRecipeCompileMetadata; compiledPrompt?: string;
  refusal?: string; skip?: true; failure?: true; blocked?: true; expected?: Record<string, unknown>;
};
function fixture(name: string, data: Record<string, unknown> = {}, extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [audioNode(data)], edges: [], nodeId: 'audio-1', projectId: `audio-parity/${name}`,
    canvasId: 'canvas-7', productOperation: null, translate, ...extra };
}
const voice = { voicePolicyConfirmed: true, voiceAvailable: true,
  voiceRef: { scope: 'character_default', characterName: 'Alex', identityId: 'character-1', slot: 'dialogue' } };
const generalAudio = { recipeId: 'general-audio' };
const invalidationKeys = ['audioUrl', 'durationMs', 'generationError', 'workflowResultStale', 'workflowInvalidatedAt', 'workflowInvalidationReason'];
const musicRepairKeys = ['audioKind', 'model', ...invalidationKeys];
const fixtures: Fixture[] = [
  fixture('legacy speech default narrator', {}, { expected: { text: 'A quiet morning.', speech_mode: 'clone', preset_model: 'edge-tts', preset_voice: 'Serena', emotion_prompt: '', voice_ref: { scope: 'project_narrator', character_name: '', identity_id: '', slot: '', voice_id: '' } } }),
  fixture('legacy preset model and voice', { speechMode: 'preset', presetModel: 'preset-model', presetVoice: 'voice-2', voiceAvailable: false }, { expected: { speech_mode: 'preset', preset_model: 'preset-model', preset_voice: 'voice-2' } }),
  fixture('new policy available character voice', { ...voice, speechMode: 'preset' }, { expected: { speech_mode: 'clone', preset_model: 'edge-tts', preset_voice: 'Serena', voice_ref: { scope: 'character_default', character_name: 'Alex', identity_id: 'character-1', slot: 'dialogue', voice_id: '' } } }),
  fixture('custom voice id', { ...voice, voiceRef: { scope: 'user_custom', voiceId: 'custom-1' } }, { expected: { voice_ref: { scope: 'user_custom', character_name: '', identity_id: '', slot: '', voice_id: 'custom-1' } } }),
  fixture('same turn custom voice selection', { ...voice, voiceAvailable: false, voiceRef: { scope: 'user_custom', voiceId: '' } }, { runtimePatch: { voiceAvailable: true, voiceRef: { scope: 'user_custom', voiceId: 'new-voice' } }, expected: { voice_ref: { scope: 'user_custom', voice_id: 'new-voice' } } }),
  fixture('same turn legacy default narrator', {}, { runtimePatch: { voiceRef: null, voiceAvailable: undefined }, expected: { voice_ref: { scope: 'project_narrator', character_name: '', identity_id: '', slot: '', voice_id: '' } } }),
  fixture('missing custom voice skip', { ...voice, voiceRef: { scope: 'user_custom', voiceId: ' ' } }, { skip: true }),
  fixture('new policy unavailable voice skip', { ...voice, voiceAvailable: false }, { skip: true }),
  fixture('emotion trimmed', { emotionPrompt: '  softly  ' }, { expected: { emotion_prompt: 'softly' } }),
  fixture('emotion blank', { emotionPrompt: '  ' }, { expected: { emotion_prompt: '' } }),
  fixture('legacy text segments', { text: undefined, segments: [{ type: 'text', value: 'Hello ' }, { type: 'pause', durationSec: 0.1 }, { type: 'text', value: 'world.' }] }, { expected: { text: 'Hello world.' } }),
  fixture('upstream edge order dependency ignored', { text: '' }, {
    nodes: [audioNode({ text: '' }), source('first', 'First.'), source('second', 'Second.'), source('dep', 'Ignored.')],
    edges: [{ id: '2', source: 'second', target: 'audio-1' }, { id: 'dep', source: 'dep', target: 'audio-1', data: { link_type: 'dependency_for' } }, { id: '1', source: 'first', target: 'audio-1' }],
    expected: { text: 'Second.\n\nFirst.' },
  }),
  fixture('explicit speech label own text', { text: 'Narration: Spoken words.' }, { expected: { text: 'Spoken words.' } }),
  fixture('explicit speech label upstream', {}, {
    nodes: [audioNode({ text: '' }), source('text', 'Narration: Upstream words.')], edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { text: 'Upstream words.' },
  }),
  fixture('workflow upstream step selection', {}, {
    nodes: [audioNode({ ...voice, text: '', workflowCatalog: { recipeId: 'general-audio', inputStrategy: { step_ids: ['step-2'] } } }), source('first', 'First.', 'step-1'), source('second', 'Narration: Selected.', 'step-2')],
    edges: [{ id: '1', source: 'first', target: 'audio-1' }, { id: '2', source: 'second', target: 'audio-1' }], expected: { text: 'Selected.' },
  }),
  fixture('workflow upstream none', {}, {
    nodes: [audioNode({ ...voice, workflowCatalog: { inputStrategy: { type: 'none' } } }), source('text', 'Ignored.')],
    edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { text: 'A quiet morning.' },
  }),
  fixture('drama shot voice literal bypass', { ...voice, workflowCatalog: { recipeId: 'drama-shot-voice' }, text: 'Narration: Literal words.' }, { expected: { text: 'Literal words.' } }),
  fixture('recipe compiled speech safe metadata', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: '<speech_text>Safe compiled words.</speech_text>\nLanguage: English', recipeIds: ['general-audio'] }, expected: { text: 'Safe compiled words.' } }),
  fixture('recipe unlabelled speech falls back', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: 'Compiler instructions only', recipeIds: ['general-audio'] }, expected: { text: 'A quiet morning.' } }),
  fixture('timeout speech uses safe fallback', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'timeout_fallback', prompt: 'Narration: Do not submit this.', recipeIds: ['general-audio'] }, expected: { text: 'A quiet morning.' } }),
  fixture('compiled speech no speakable text', { text: '3 seconds' }, { compiledPrompt: '3 seconds', failure: true }),
  fixture('recipe explicit speech without receipt', {}, { compiledPrompt: 'Narration: Explicit compiled words.', expected: { text: 'Explicit compiled words.' } }),
  fixture('compiled speech empty metadata failure', { ...voice, text: '3 seconds', workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: '<speech_text></speech_text>', recipeIds: ['general-audio'] }, failure: true }),
  fixture('music explicit kind', { audioKind: 'music', text: ' Gentle strings ' }, { expected: { input: 'Gentle strings', force_instrumental: true, respect_sections_durations: true } }),
  fixture('music intent title repair', { audioKind: 'speech', title: 'Background music', text: ' Gentle strings ' }, { repairKeys: musicRepairKeys, expected: { input: 'Gentle strings' } }),
  fixture('music intent retains existing audio', { displayName: 'Background music', audioUrl: '/static/existing.mp3', musicLengthMs: 2000 }, { repairKeys: ['audioKind', 'model', 'musicLengthMs'], expected: { music_length_ms: 3000 } }),
  fixture('music explicit kind keeps stored model', { audioKind: 'music', model: 'stored-model' }),
  fixture('music explicit rounded length', { audioKind: 'music', musicLengthMs: 4321.6 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 4322 } }),
  fixture('music length lower clamp', { audioKind: 'music', musicLengthMs: 1 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 3000 } }),
  fixture('music length upper clamp', { audioKind: 'music', musicLengthMs: 999999 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 600000 } }),
  fixture('music length derived from text', { audioKind: 'music', text: 'Strings for 12 seconds' }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 13000 } }),
  fixture('music length derived from goal', { audioKind: 'music', text: 'Strings for 12 seconds', workflowCatalog: { promptBuilder: { userGoal: '2 minutes' } } }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 121000 } }),
  fixture('music flags explicit false', { audioKind: 'music', forceInstrumental: false, respectSectionsDurations: false }, { expected: { force_instrumental: false, respect_sections_durations: false } }),
  fixture('music truncation 4101 code units', { audioKind: 'music' }, { compiledPrompt: `  ${'a'.repeat(4200)}${'z'.repeat(200)}  `, expected: { input: `${'a'.repeat(3900)}\n${'z'.repeat(200)}` } }),
  fixture('music metadata stays raw', { audioKind: 'music' }, { metadata: { mode: 'model', prompt: '  Recipe strings  ', recipeIds: ['music'] }, expected: { input: 'Recipe strings' } }),
  fixture('music ignores upstream in compilation', {}, {
    nodes: [audioNode({ audioKind: 'music', text: 'Strings' }), source('text', 'Long upstream script')], edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { input: 'Long upstream script\n\nStrings' },
  }),
  fixture('product operation with attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1', generationAttemptId: 'attempt-1' }, expected: { product_operation_id: 'op-1', generation_attempt_id: 'attempt-1' } }),
  fixture('product operation without attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1' } }),
  fixture('unused model and target fields omitted', { modelParams: { seed: 4 }, targetEpisode: 2, targetBeat: 3 }),
  fixture('canvas default', {}, { canvasId: 'default' }),
  fixture('empty prompt refusal', { text: ' ' }, { refusal: 'no_effective_prompt' }),
  fixture('busy refusal before missing voice', { ...voice, voiceAvailable: false, isGenerating: true, generationJobId: 'running' }, { refusal: 'generation_in_progress' }),
  fixture('missing project refusal', { ...voice }, { projectId: '', refusal: 'no_project' }),
  fixture('access before missing voice', { ...voice, voiceAvailable: false }, { blocked: true }),
  fixture('invalid speech instruction repair', { text: '\u6839\u636e\u811a\u672c\u751f\u6210\u65c1\u767d\u914d\u97f3', audioUrl: '/static/old.mp3' }, { repairKeys: invalidationKeys, failure: true }),
];

function TargetNode() {
  const node = useCanvasStore((state) => state.nodes.find((candidate) => candidate.id === 'audio-1'));
  if (!isAudioNode(node)) throw new Error('Missing audio node');
  return <AudioNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
function currentData() {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'audio-1');
  if (!isAudioNode(node)) throw new Error('Missing audio node');
  return node.data;
}
function pickPatch(patch: Record<string, unknown>) {
  const data = currentData();
  return Object.fromEntries(Object.keys(patch).map((key) => [key, data[key]]));
}
function wireRequests() {
  return vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST').map(([route, options]) => ({
    method: options?.method, path: route, body: JSON.parse(JSON.stringify(options?.json)),
  }));
}
beforeEach(() => {
  vi.clearAllMocks(); scope.blocked = false; scope.message = null;
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => input.fallbackPrompt);
});
afterEach(() => { cleanup(); clearWorkflowProductOperation('audio-1'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AudioNode agent request wire parity', () => {
  it.each(fixtures)('$name', async (ctx) => {
    scope.project = ctx.projectId; scope.canvas = ctx.canvasId === 'default' ? undefined : ctx.canvasId;
    scope.blocked = !!ctx.blocked; scope.message = ctx.blocked ? 'Model access unavailable' : null;
    useCanvasStore.getState().setCanvasData(structuredClone(ctx.nodes), structuredClone(ctx.edges));
    const repair = audioNodeRepairPatch(currentData(), 'unused');
    expect(Object.keys(repair ?? {}).sort()).toStrictEqual([...(ctx.repairKeys ?? [])].sort());
    if (!ctx.repairKeys) expect(repair).toBeNull();
    if (ctx.productOperation) bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
    if (ctx.metadata) vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => {
      input.onCompileMetadata?.(ctx.metadata!); return ctx.metadata!.prompt;
    });
    if (ctx.compiledPrompt !== undefined) vi.mocked(compileWorkflowNodePrompt).mockResolvedValue(ctx.compiledPrompt);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
    // Wait for the real default-voice initialization; it uses the mocked HTTP boundary.
    if (scope.project && !currentData().voiceRef && currentData().audioKind !== 'music' && currentData().speechMode !== 'preset') {
      await waitFor(() => expect(currentData().voiceRef).toBeDefined());
    }
    if (repair) {
      const now = currentData().workflowInvalidatedAt ?? 'unused';
      const original = ctx.nodes.find((node) => node.id === ctx.nodeId);
      if (!isAudioNode(original)) throw new Error('Missing original audio node');
      const expected = audioNodeRepairPatch(original.data, String(now));
      expect(expected).not.toBeNull();
      expect(pickPatch(expected!)).toStrictEqual(expected);
    }
    expect(audioNodeRepairPatch(currentData(), 'unused')).toBeNull();
    // Ignore mount-time voice discovery when checking that the action submits nothing.
    vi.mocked(apiCall).mockClear();
    const state = useCanvasStore.getState();
    const settled = { ...ctx, nodes: structuredClone(state.nodes).map((node) =>
      node.id === ctx.nodeId && ctx.runtimePatch ? { ...node, data: { ...node.data, ...ctx.runtimePatch } } : node),
      edges: structuredClone(state.edges) };
    const decision = audioPromptCompileInput(settled);
    let outcome: { status: string; output?: Record<string, unknown>; error?: unknown } | undefined;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => { if (event.requestId === ctx.name) outcome = event; });
    try {
      act(() => {
        if (ctx.runtimePatch) useCanvasStore.getState().updateNodeData(ctx.nodeId, ctx.runtimePatch);
        dispatchNodeAction({ nodeId: ctx.nodeId, action: 'generate_audio', executionMode: 'workflow', requestId: ctx.name }); });
      await waitFor(() => expect(outcome).toBeDefined());
      const calls = vi.mocked(compileWorkflowNodePrompt).mock.calls;
      if (ctx.blocked) {
        expect(calls).toHaveLength(0); expect(apiCall).not.toHaveBeenCalled(); expect(wireRequests()).toStrictEqual([]);
        expect(currentData().generationError).toBe(scope.message); expect(outcome).toMatchObject({ status: 'success', output: {} });
        return;
      }
      if (decision.kind === 'compile') {
        expect(calls).toHaveLength(1);
        const { nodeId, nodeData, executionSource, onCompileMetadata, ...input } = calls[0][0];
        expect(nodeId).toBe(ctx.nodeId); expect(nodeData).toStrictEqual(settled.nodes.find((node) => node.id === ctx.nodeId)?.data);
        expect(executionSource).toBeUndefined(); expect(onCompileMetadata).toBeTypeOf('function');
        expect(input).toStrictEqual(decision.input);
      } else expect(calls).toHaveLength(0);
      if (ctx.skip) {
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip') throw new Error('Expected skip');
        expect(decision.patch).toStrictEqual({ isGenerating: false, generationStartedAt: null, generationError: translate('node.audioNode.selectVoiceFirst') });
        expect(decision.output).toStrictEqual({ skipped: true, reason: 'missing_custom_voice' });
        expect(pickPatch(decision.patch)).toStrictEqual(decision.patch);
        expect(outcome?.status).toBe('success');
        expect(outcome?.output).toStrictEqual(decision.output); expect(apiCall).not.toHaveBeenCalled(); expect(wireRequests()).toStrictEqual([]);
      } else if (ctx.refusal) {
        expect(decision).toMatchObject({ kind: 'refuse', code: ctx.refusal });
        if (decision.kind === 'refuse' && decision.code === 'no_project') {
          expect(decision.patch).toStrictEqual({ generationError: translate('canvas.generation.missingProjectParam') });
          expect(pickPatch(decision.patch)).toStrictEqual(decision.patch);
        }
        expect(outcome?.status).toBe('success'); expect(outcome?.output).toStrictEqual({});
        expect(apiCall).not.toHaveBeenCalled(); expect(wireRequests()).toStrictEqual([]);
      } else {
        if (decision.kind !== 'compile' && decision.kind !== 'literal') throw new Error('Expected prompt');
        const prompt = ctx.metadata?.prompt ?? ctx.compiledPrompt ?? (decision.kind === 'compile' ? decision.input.fallbackPrompt : decision.prompt);
        const result = buildAudioGenerationRequest({ ...settled, prompt, compileMode: ctx.metadata?.mode ?? null, recipeIds: ctx.metadata?.recipeIds ?? [] });
        if (ctx.failure) {
          expect(result).toMatchObject({ ok: false, code: 'no_speakable_text' });
          if (result.ok) throw new Error('Expected failure');
          expect(currentData().generationError).toBe(result.message); expect(outcome?.status).toBe('error'); expect(wireRequests()).toStrictEqual([]);
        } else {
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error(result.message);
          expect(wireRequests()).toStrictEqual(result.requests); expect(result.requests).toHaveLength(1);
          expect(result.requests[0].body).toMatchObject(ctx.expected ?? {});
          if (currentData().audioKind !== 'music') expect(result.requests[0].body).not.toHaveProperty('input');
          if (ctx.name === 'music truncation 4101 code units') expect(String(result.requests[0].body.input)).toHaveLength(4101);
          if (ctx.name === 'music explicit kind') expect(result.requests[0].body).not.toHaveProperty('music_length_ms');
          expect(result.requests[0].body).not.toHaveProperty('model_params');
          expect(result.requests[0].body).not.toHaveProperty('target_episode'); expect(result.requests[0].body).not.toHaveProperty('target_beat');
          if (!ctx.productOperation?.generationAttemptId) expect(result.requests[0].body).not.toHaveProperty('product_operation_id');
          expect(outcome).toMatchObject({ status: 'success', output: { audioUrl: '/static/audio.mp3' } });
        }
        if (ctx.metadata) {
          const compiledAt = currentData().workflowRecipeCompiledAt;
          expect(compiledAt).toBeTypeOf('string');
          const patch = audioPromptCompileMetadataPatch(settled, ctx.metadata, String(compiledAt));
          expect(Object.keys(patch).sort()).toStrictEqual(['workflowRecipeCompileMode', 'workflowRecipeCompiledAt', 'workflowRecipeCompiledPrompt', 'text', 'workflowRecipeIds'].sort());
          expect(pickPatch(patch)).toStrictEqual(patch);
        }
      }
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { unsubscribe(); queryClient.clear(); }
  });
});

describe('pure audio boundaries', () => {
  it('wrong node type', () => {
    const ctx = { ...fixtures[0], nodes: [source('audio-1', 'Text')] };
    expect(audioPromptCompileInput(ctx)).toMatchObject({ kind: 'refuse', code: 'not_audio_node' });
    expect(buildAudioGenerationRequest({ ...ctx, prompt: 'Text', compileMode: null, recipeIds: [] })).toMatchObject({ ok: false, code: 'not_audio_node' });
  });
  it('resolved activity refuses even without node busy flag', () => {
    expect(audioPromptCompileInput({ ...fixtures[0], isGenerating: true })).toMatchObject({ kind: 'refuse', code: 'generation_in_progress' });
  });
  it('node busy flag refuses even when resolved activity is false', () => {
    expect(audioPromptCompileInput(fixture('busy', { isGenerating: true }, { isGenerating: false }))).toMatchObject({ kind: 'refuse', code: 'generation_in_progress' });
  });
  it('missing voice precedes empty prompt and missing project', () => {
    expect(audioPromptCompileInput(fixture('skip', { ...voice, voiceAvailable: false, text: '' }, { projectId: '' }))).toMatchObject({ kind: 'skip' });
  });
  it('empty prompt precedes missing project', () => {
    expect(audioPromptCompileInput(fixture('empty', { text: '' }, { projectId: '' }))).toMatchObject({ kind: 'refuse', code: 'no_effective_prompt' });
  });
  it('string text wins over legacy segments even when empty', () => {
    expect(audioPromptCompileInput(fixture('empty', { text: '', segments: [{ type: 'text', value: 'Ignored' }] }))).toMatchObject({ kind: 'refuse', code: 'no_effective_prompt' });
  });
  it('inputs not mutated', () => {
    const ctx = fixtures.find((item) => item.name === 'workflow upstream step selection')!;
    const before = structuredClone({ nodes: ctx.nodes, edges: ctx.edges });
    audioPromptCompileInput(ctx); audioPromptCompileMetadataPatch(ctx, { mode: 'model', prompt: 'Narration: New.', recipeIds: [] }, 'now');
    buildAudioGenerationRequest({ ...ctx, prompt: 'Narration: New.', compileMode: null, recipeIds: [] });
    const node = ctx.nodes[0];
    if (!isAudioNode(node)) throw new Error('Missing audio node');
    audioNodeRepairPatch(node.data, 'now');
    expect({ nodes: ctx.nodes, edges: ctx.edges }).toStrictEqual(before);
  });
  it('no repairs for settled speech', () => {
    const node = audioNode();
    if (!isAudioNode(node)) throw new Error('Missing audio node');
    expect(audioNodeRepairPatch(node.data, 'now')).toBeNull();
  });
  it('transitive runtime imports stay inside the pure canvas modules', () => {
    const root = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(root, 'features/canvas/application/generationRequests/audioGenerationRequest.ts')], root);
    expect([...graph.files].map((file) => path.relative(root, file)).filter((file) =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter((name) => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
