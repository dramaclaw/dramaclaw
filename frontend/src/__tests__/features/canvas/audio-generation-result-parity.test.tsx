// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { TaskCompletionError } from '@/features/canvas/domain/taskCompletionError';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import {
  audioPromptCompileInput, audioPromptCompileMetadataPatch, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { CANVAS_NODE_TYPES, isAudioNode, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AudioNode } from '@/features/canvas/nodes/AudioNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectImportGraph } from '../canvas-core/importGraph';

import {
  audioGenerationStartPatch, audioGenerationAcceptedPatch, audioGenerationOutcomePatch,
  audioGenerationActionResult, isAudioVoicePrerequisiteFailure,
} from '@/features/canvas/application/generationRequests/audioGenerationResult';
import {
  describeGenerationError, generationErrorFromSubmitFailure, type GenerationSubmitFailure,
} from '@/features/canvas/application/generationRequests/generationSubmitError';
import { isVoicePrerequisiteError } from '@/features/canvas/nodes/audioVoicePrerequisite';

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
  apiCall: vi.fn(),
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

/**
 * Mocks, matching audio request parity's lowest boundaries:
 * react-i18next: deterministic text; url-params: fixture project/canvas;
 * model-task-access and generation-credit-cost: avoid unrelated network queries;
 * api/client.apiCall: submit acceptance/rejection, voice discovery and job results
 *   through the real ops serializers; apiClient: reject unexpected transports;
 * api/tasks.awaitTaskCompletion: controlled completion/failure with real errors;
 * workflowRecipeRuntime.compileWorkflowNodePrompt: deterministic metadata/prompt;
 * AudioWaveformPlayer: avoid media fetching/decoding, unrelated to generation.
 * Date: fixed start/compile clocks; media.load and ResizeObserver: jsdom support;
 * fetch: fail on unmocked network. The component, hook, store and event bus run.
 */
const startedAt = 1234567890000;
const metadata: FreezoneRecipeCompileMetadata = {
  mode: 'model', prompt: 'A quiet morning.', recipeIds: ['general-audio'],
};
const voice = { voicePolicyConfirmed: true, voiceAvailable: true,
  voiceRef: { scope: 'character_default', characterName: 'Alex', identityId: 'character-1' } };
type Fault = { kind: 'submit'; failure: GenerationSubmitFailure }
  | { kind: 'task' | 'result' | 'compile'; error: unknown };
interface Fixture {
  name: string;
  data?: Record<string, unknown>;
  url?: string;
  fault?: Fault;
  voicePrerequisite?: boolean;
  latestUrl?: string | null | number;
  skip?: boolean;
}
const httpFailure = (status: number, body: unknown): GenerationSubmitFailure => ({
  kind: 'http', status, statusText: 'Rejected', method: 'POST',
  url: 'https://example.test/api/audio', body,
});
const fixtures: Fixture[] = [
  { name: 'speech success' },
  { name: 'music success', data: { audioKind: 'music', musicLengthMs: 30000 } },
  { name: 'direct voice success without compile metadata', data: { workflowCatalog: { recipeId: 'drama-shot-voice' } } },
  { name: 'empty URL', url: '' },
  { name: 'store audioUrl changed before publish', latestUrl: '/static/newer.mp3' },
  { name: 'empty store audioUrl retains hook URL', latestUrl: '' },
  { name: 'nonstring store audioUrl retains hook URL', latestUrl: 7 },
  { name: 'submit rejected insufficient credits', fault: { kind: 'submit', failure: httpFailure(402, { error: 'Balance too low', data: { request_id: 'req-1' } }) } },
  { name: 'submit rejected plain backend error', fault: { kind: 'submit', failure: httpFailure(400, { error: 'Raw backend message', data: { request_id: 'req-2' } }) } },
  { name: 'submit rejected envelope failure', fault: { kind: 'submit', failure: { kind: 'envelope', body: { ok: false, error: 'Envelope rejected' } } } },
  { name: 'task failed', fault: { kind: 'task', error: new TaskCompletionError('Task failed raw', 'failed', 'audio-task') } },
  { name: 'task cancelled', fault: { kind: 'task', error: new TaskCompletionError('Cancelled raw', 'cancelled', 'audio-task') } },
  { name: 'poll timeout', fault: { kind: 'task', error: new TaskPollTimeoutError('audio-task', 100) } },
  { name: 'job-result call rejects', fault: { kind: 'result', error: new Error('Result unavailable') } },
  { name: 'error with empty message', fault: { kind: 'result', error: new Error('') } },
  // api/client.ts:105 rethrows unclassified values unchanged; ops.ts:2103 awaits
  // apiCall unchanged. The task waiter itself constructs Error instances.
  { name: 'non-Error thrown', fault: { kind: 'result', error: 'Raw thrown value' } },
  { name: 'non-Error voice prerequisite', fault: { kind: 'result', error: '缺少可用声线' }, voicePrerequisite: true }, // i18n-exempt -- exact matcher input
  { name: 'voice prerequisite failure', fault: { kind: 'submit', failure: httpFailure(400, { error: '声线未配置' }) }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite task failure', fault: { kind: 'task', error: new TaskCompletionError('缺少可用声线', 'failed', 'audio-task') }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite envelope failure', fault: { kind: 'submit', failure: { kind: 'envelope', body: { ok: false, error: '请先配置或选择声线' } } }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite job-result failure', fault: { kind: 'result', error: new Error('上传或录制参考音频') }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'compile failure', fault: { kind: 'compile', error: new Error('Compile unavailable') } },
  { name: 'missing custom voice skip published as success', data: { voiceAvailable: false }, skip: true },
];

function audioNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
    text: 'A quiet morning.', audioUrl: '/static/previous.mp3', durationMs: 1000,
    generationError: 'Previous error', generationErrorDetails: 'Keep details', generationErrorRequestId: 'keep-request',
    workflowResultStale: true, ...voice, ...data,
  } };
}
function currentData(): AudioNodeData {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'audio-1');
  if (!isAudioNode(node)) throw new Error('Missing audio node');
  return node.data;
}
function TargetNode() {
  const node = useCanvasStore((state) => state.nodes.find((candidate) => candidate.id === 'audio-1'));
  if (!isAudioNode(node)) throw new Error('Missing audio node');
  return <AudioNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
const originalUpdate = useCanvasStore.getState().updateNodeData;
beforeEach(() => {
  vi.clearAllMocks();
  scope.blocked = false; scope.message = null;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(startedAt);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
});
afterEach(() => {
  cleanup(); useCanvasStore.setState({ updateNodeData: originalUpdate });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('audio result patches against generate_audio subscriber', () => {
  it.each(fixtures)('$name', async (fixture) => {
    scope.project = `audio-result/${fixture.name}`; scope.canvas = 'canvas-7';
    const music = fixture.data?.audioKind === 'music';
    const ref = { task_key: 'audio-task', job_id: 'audio-job',
      task_type: music ? 'freezone_audio_eleven_music' : 'freezone_audio_speech' };
    const fault = fixture.fault;
    const thrown = fault?.kind === 'submit' ? generationErrorFromSubmitFailure(fault.failure) : fault?.error;
    const url = fixture.url ?? '/static/audio.mp3';
    vi.mocked(apiCall).mockImplementation(async (route) => {
      if (route.endsWith('/freezone/audio/references')) return { available: [{ scope: 'project_narrator' }] };
      if (/\/freezone\/audio\/(speech|eleven-music)$/.test(route)) {
        if (fault?.kind === 'submit') throw thrown;
        return ref;
      }
      if (route.endsWith(`/freezone/jobs/${ref.task_type}/audio-job/result`)) {
        if (fault?.kind === 'result') throw thrown;
        return { url, size: 0 };
      }
      throw new Error(`Unexpected API call: ${route}`);
    });
    vi.mocked(awaitTaskCompletion).mockImplementation(async () => {
      if (fault?.kind === 'task') throw thrown;
      // Audio ignores task-result URLs and always fetches the job result.
      return { ...ref, username: 'test', project: scope.project, episode: 0, status: 'completed',
        result: { audio_url: '/ignored-task.mp3', url: '/also-ignored.mp3' } };
    });
    vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => {
      if (fault?.kind === 'compile') throw thrown;
      input.onCompileMetadata?.(metadata); return metadata.prompt;
    });
    useCanvasStore.getState().setCanvasData([audioNode(fixture.data)], []);
    const patches: Partial<AudioNodeData>[] = [];
    const writes: Record<string, unknown>[] = [];
    useCanvasStore.setState({ updateNodeData: (id, patch) => {
      if (id === 'audio-1') writes.push(structuredClone(patch));
      originalUpdate(id, patch);
      if (id === 'audio-1' && 'audioUrl' in patch && fixture.latestUrl !== undefined) {
        // Simulate an independent edit between the success write and publication.
        originalUpdate(id, { audioUrl: fixture.latestUrl });
      }
    } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
    const state = useCanvasStore.getState();
    const ctx: AudioGenerationRequestContext = { nodes: structuredClone(state.nodes), edges: state.edges,
      nodeId: 'audio-1', projectId: scope.project, canvasId: 'canvas-7', productOperation: null, translate };
    const initial = structuredClone(currentData());
    writes.length = 0;
    const decision = audioPromptCompileInput(ctx);
    let published: { status: string; output?: Record<string, unknown>; error?: string } | undefined;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => {
      if (event.requestId === fixture.name) published = event.status === 'error'
        ? { status: event.status, error: event.error } : { status: event.status, output: event.output };
    });
    try {
      act(() => { dispatchNodeAction({ nodeId: 'audio-1', action: 'generate_audio', executionMode: 'workflow', requestId: fixture.name }); });
      await waitFor(() => expect(published).toBeDefined());
      let expectedAction;
      if (fixture.skip) {
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip') throw new Error('Expected skip');
        patches.push(decision.patch);
        expectedAction = audioGenerationActionResult({ hookOutput: decision.output, latestNodeData: currentData() });
        expect(compileWorkflowNodePrompt).not.toHaveBeenCalled();
      } else {
        patches.push(audioGenerationStartPatch(startedAt));
        if (decision.kind !== 'compile' && decision.kind !== 'literal') throw new Error('Expected prompt');
        if (decision.kind === 'compile' && fault?.kind !== 'compile') {
          patches.push(audioPromptCompileMetadataPatch(ctx, metadata, new Date(startedAt).toISOString()));
        }
        if (fault?.kind !== 'submit' && fault?.kind !== 'compile') patches.push(audioGenerationAcceptedPatch(ref));
        const outcome = fault ? { kind: 'failed' as const, message: thrown instanceof Error ? thrown.message : String(thrown),
          isError: thrown instanceof Error, voicePrerequisite: fixture.voicePrerequisite ?? false }
          : { kind: 'completed' as const, url };
        const result = audioGenerationOutcomePatch({ outcome, translate });
        patches.push(...result.patches);
        if (fault) {
          expect(isVoicePrerequisiteError(thrown)).toBe(fixture.voicePrerequisite ?? false);
          if (thrown instanceof Error) {
            const info = describeGenerationError(thrown, translate, 'Fallback');
            expect(isAudioVoicePrerequisiteFailure(info)).toBe(fixture.voicePrerequisite ?? false);
            if (fixture.name === 'submit rejected insufficient credits') expect(info.display).not.toBe(thrown.message);
          }
        }
        expectedAction = audioGenerationActionResult({ ...('hookError' in result
          ? { hookError: result.hookError } : { hookOutput: result.hookOutput }), latestNodeData: currentData() });
        if (!fault) expect(result).toHaveProperty('hookOutput', url ? { audioUrl: url } : {});
      }
      const expected = Object.assign({}, initial, ...patches,
        fixture.latestUrl !== undefined ? { audioUrl: fixture.latestUrl } : {});
      expect(writes).toStrictEqual(patches);
      expect(currentData()).toStrictEqual(expected);
      expect(published).toStrictEqual(expectedAction);
      expect(currentData().generationErrorDetails).toBe('Keep details');
      expect(currentData().generationErrorRequestId).toBe('keep-request');
      const submitted = !fixture.skip && fault?.kind !== 'compile';
      expect(vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(submitted ? 1 : 0);
      const accepted = submitted && fault?.kind !== 'submit';
      expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(accepted
        ? [[ref.task_key, scope.project, { taskType: ref.task_type }]] : []);
      const fetched = accepted && fault?.kind !== 'task';
      expect(vi.mocked(apiCall).mock.calls.filter(([route]) => route.endsWith('/result')).map(([route]) => route))
        .toStrictEqual(fetched ? [`projects/${encodeURIComponent(scope.project)}/freezone/jobs/${ref.task_type}/audio-job/result`] : []);
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { unsubscribe(); queryClient.clear(); }
  });
});

describe('pure audio result boundaries', () => {
  it.each([
    { name: 'unconfigured substring', message: 'prefix 声线未配置 suffix', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'missing voice substring', message: '缺少默认声线', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'configure or select phrase', message: '请先配置或选择声线', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'upload or record phrase', message: '上传或录制参考音频', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'missing voice cannot cross newline', message: '缺少\n声线', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'upload audio cannot cross newline', message: '上传或录制\n音频', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'similar voice wording is not matched', message: '请选择声线', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'English wording is not matched', message: 'Voice not configured', matches: false },
    { name: 'empty message is not matched', message: '', matches: false },
  ])('$name', ({ message, matches }) => {
    // Contradictory display/diagnostics prove only the raw message participates.
    const info = { ...describeGenerationError(new Error(message), translate, 'Fallback'),
      display: '声线未配置', details: '声线未配置', requestId: 'req-test', status: 400 }; // i18n-exempt -- matcher must ignore translated display and diagnostics
    expect(isAudioVoicePrerequisiteFailure(info)).toBe(matches);
    expect(isVoicePrerequisiteError(new Error(message))).toBe(matches);
    expect(isVoicePrerequisiteError(message)).toBe(matches);
  });
  it('transitive runtime imports stay inside pure canvas modules', () => {
    const root = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(root, 'features/canvas/application/generationRequests/audioGenerationResult.ts')], root);
    expect([...graph.files].map((file) => path.relative(root, file)).filter((file) =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter((name) => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
  it('missing node with empty hook output publishes empty success', () => {
    expect(audioGenerationActionResult({ hookOutput: {}, latestNodeData: undefined }))
      .toStrictEqual({ status: 'success', output: {} });
  });
  it('does not mutate outcome, output or latest data', () => {
    const outcome = { kind: 'completed' as const, url: '/audio.mp3' };
    const before = structuredClone(outcome);
    const result = audioGenerationOutcomePatch({ outcome, translate });
    expect(outcome).toStrictEqual(before);
    if (!('hookOutput' in result)) throw new Error('Expected output');
    const latestNodeData = { audioUrl: '/latest.mp3' };
    const input = { hookOutput: result.hookOutput, latestNodeData };
    const previous = structuredClone(input);
    audioGenerationActionResult(input);
    expect(input).toStrictEqual(previous);
  });
});

