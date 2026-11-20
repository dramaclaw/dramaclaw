// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import {
  audioEffectivePrompt, audioMusicKindRepairPatch, audioMusicLengthRepairPatch, audioPromptCompileInput, audioPromptCompileMetadataPatch,
  buildAudioGenerationRequest, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, isAudioNode, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AudioNode } from '@/features/canvas/nodes/AudioNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { extractUpstreamContent } from '@/features/canvas/application/graphContentResolver';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  audioGenerationStartPatch, audioGenerationAcceptedPatch, audioGenerationOutcomePatch,
  audioGenerationActionResult, audioGenerationHookError,
  type AudioGenerationHookOutput, type AudioGenerationHookError,
} from '@/features/canvas/application/generationRequests/audioGenerationResult';

const scope = vi.hoisted(() => ({ project: '', canvas: undefined as string | undefined, blocked: false, message: null as string | null }));
const translate = (key: string) => key;
// Keep the component, hook, store, graph projection and wire transport real.
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
// Intercept transport without contacting providers.
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

const startedAt = 1234567890000;
const ISO = '2009-02-13T23:31:30.000Z';
const id = 'audio-1';
const metadata: FreezoneRecipeCompileMetadata = {
  mode: 'model', prompt: 'Narration: Safe compiled words.', recipeIds: ['general-audio'],
};
const originalUpdate = useCanvasStore.getState().updateNodeData;
function currentData() {
  const node = useCanvasStore.getState().nodes.find(node => node.id === id);
  if (!isAudioNode(node)) throw new Error('Missing audio node');
  return node.data;
}
function Target() {
  const data = useCanvasStore(state => state.nodes.find(node => node.id === id)?.data);
  if (!data) throw new Error('Missing audio node');
  return <AudioNode id={id} type={CANVAS_NODE_TYPES.audio} data={currentData()} selected={false}
    dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
function exact(actual: unknown, expected: unknown) {
  expect(actual).toStrictEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}
beforeEach(() => {
  vi.clearAllMocks(); scope.project = 'audio/project'; scope.canvas = 'canvas-7';
  scope.blocked = false; scope.message = null;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(startedAt);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup(); clearWorkflowProductOperation(id);
  useCanvasStore.setState({ updateNodeData: originalUpdate });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
interface Fixture {
  name: string; music?: boolean; upstream?: boolean; fault?: boolean;
  skip?: boolean; blocked?: boolean; missingProject?: boolean; panel?: boolean;
}
const fixtures: Fixture[] = [
  { name: 'speech with metadata upstream and operation', upstream: true },
  { name: 'music', music: true },
  { name: 'voice prerequisite submit failure', fault: true },
  { name: 'missing custom voice skip', skip: true },
  { name: 'access blocked', blocked: true },
  { name: 'missing project', missingProject: true },
  { name: 'panel generate and effective prompt', panel: true, upstream: true },
];
describe('audio generation delegation', () => {
  it.each(fixtures)('$name', async fixture => {
    scope.blocked = fixture.blocked ?? false;
    scope.message = scope.blocked ? 'Model access unavailable' : null;
    if (fixture.missingProject) scope.project = '';
    const node: CanvasNode = { id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
      audioUrl: null, text: fixture.music ? 'Gentle strings' : 'A quiet morning.',
      audioKind: fixture.music ? 'music' : 'speech',
      voicePolicyConfirmed: true, voiceAvailable: !fixture.skip,
      voiceRef: { scope: 'user_custom', voiceId: fixture.skip ? '' : 'voice-1' },
      workflowCatalog: { recipeId: 'general-audio' },
    } };
    const upstream: CanvasNode[] = fixture.upstream ? [{ id: 'text', type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 }, data: { content: 'Upstream words.' } }] : [];
    useCanvasStore.getState().setCanvasData([node, ...upstream], upstream.map(node => ({
      id: `edge-${node.id}`, source: node.id, target: id,
    })));
    const operation = fixture.upstream ? { projectId: scope.project, operationId: 'operation', generationAttemptId: 'attempt' } : null;
    if (operation) bindWorkflowProductOperation(id, operation);
    const ref = { task_key: 'audio-task', job_id: 'audio-job',
      task_type: fixture.music ? 'freezone_audio_eleven_music' : 'freezone_audio_speech' };
    const error = new Error('声线未配置'); // i18n-exempt -- backend voice prerequisite contract
    vi.mocked(apiCall).mockImplementation(async route => {
      if (route.endsWith('/freezone/audio/references')) return { available: [{ scope: 'project_narrator' }] };
      if (/\/freezone\/audio\/(speech|eleven-music)$/.test(route)) {
        if (fixture.fault) throw error;
        return ref;
      }
      if (route.endsWith('/result')) return { url: '/static/audio.mp3' };
      throw new Error(`Unexpected route: ${route}`);
    });
    vi.mocked(compileWorkflowNodePrompt).mockImplementation(async input => {
      input.onCompileMetadata?.(metadata); return metadata.prompt;
    });
    const writes: Partial<AudioNodeData>[] = [];
    useCanvasStore.setState({ updateNodeData: (nodeId, patch) => {
      if (nodeId === id) writes.push(structuredClone(patch));
      originalUpdate(nodeId, patch);
    } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      <QueryClientProvider client={client}><ReactFlowProvider>{children}</ReactFlowProvider></QueryClientProvider>;
    const ctx: AudioGenerationRequestContext = {
      nodes: structuredClone(useCanvasStore.getState().nodes), edges: useCanvasStore.getState().edges,
      nodeId: id, projectId: scope.project, canvasId: 'canvas-7', productOperation: operation, translate,
    };
    const decision = audioPromptCompileInput(ctx);
    const patches: Partial<AudioNodeData>[] = [];
    let hookOutput: AudioGenerationHookOutput = {};
    let hookError: AudioGenerationHookError | undefined;
    let requests: unknown[] = [];
    if (fixture.blocked) patches.push({ generationError: 'Model access unavailable' });
    else if (decision.kind === 'skip') { patches.push(decision.patch); hookOutput = decision.output; }
    else if (decision.kind === 'refuse') {
      if (decision.code === 'no_project') patches.push(decision.patch);
    } else {
      patches.push(audioGenerationStartPatch(startedAt), audioPromptCompileMetadataPatch(ctx, metadata, ISO));
      const build = buildAudioGenerationRequest({ ...ctx, prompt: metadata.prompt, compileMode: metadata.mode, recipeIds: metadata.recipeIds });
      if (!build.ok) throw new Error(build.message);
      requests = build.requests;
      if (!fixture.fault) patches.push(audioGenerationAcceptedPatch(ref));
      if (fixture.fault) hookError = audioGenerationHookError(error);
      const outcome = audioGenerationOutcomePatch({ outcome: hookError ? { kind: 'failed', ...hookError }
        : { kind: 'completed', url: '/static/audio.mp3' }, translate });
      patches.push(...outcome.patches);
      if ('hookOutput' in outcome) hookOutput = outcome.hookOutput;
    }
    const events: unknown[] = [];
    const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
    try {
      if (fixture.panel) {
        const hook = renderHook(() => useAudioGeneration(id, currentData()), { wrapper });
        exact(hook.result.current.effectivePrompt, audioEffectivePrompt(currentData(),
          ctx.nodes.filter(node => node.id !== id).map(extractUpstreamContent)));
        let returned: unknown;
        await act(async () => { returned = await hook.result.current.generate(); });
        exact(returned, hookOutput);
      } else {
        render(<Target />, { wrapper });
        act(() => { dispatchNodeAction({ nodeId: id, action: 'generate_audio', requestId: fixture.name }); });
        await waitFor(() => expect(events).toHaveLength(1));
        const result = audioGenerationActionResult({ ...(hookError ? { hookError } : { hookOutput }), latestNodeData: currentData() });
        exact(events, [{ requestId: fixture.name, nodeId: id, action: 'generate_audio', ...result }]);
      }
      const posted = vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST');
      exact(posted.map(([path, options]) => ({ method: options?.method, path, body: options?.json })), requests);
      for (const [, options] of posted) expect(Object.keys(options!)).toStrictEqual(['method', 'json']);
      exact(writes, patches);
      if (fixture.upstream && decision.kind === 'compile') {
        const { onCompileMetadata: _callback, ...input } = vi.mocked(compileWorkflowNodePrompt).mock.calls[0][0];
        exact(input, { nodeId: id, nodeData: ctx.nodes[0].data, ...decision.input });
      }
      expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(requests.length && !fixture.fault
        ? [[ref.task_key, scope.project, { taskType: ref.task_type }]] : []);
      if (fixture.fault) {
        expect(writes.slice(-2)).toStrictEqual(audioGenerationOutcomePatch({ outcome: { kind: 'failed', ...audioGenerationHookError(error) }, translate }).patches);
      }
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { off(); client.clear(); }
  });

  it('music intent mount writes kind and length repairs in order', () => {
    useCanvasStore.getState().setCanvasData([{ id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
      data: { audioKind: 'speech', title: 'Background music', text: 'Strings', audioUrl: null, musicLengthMs: 1 } }], []);
    const initial = structuredClone(currentData());
    const writes: Partial<AudioNodeData>[] = [];
    useCanvasStore.setState({ updateNodeData: (nodeId, patch) => {
      if (nodeId === id) writes.push(structuredClone(patch));
      originalUpdate(nodeId, patch);
    } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      render(<QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider>);
      exact(writes, [audioMusicKindRepairPatch(initial, ISO), audioMusicLengthRepairPatch(initial)]);
    } finally { client.clear(); }
  });
});
