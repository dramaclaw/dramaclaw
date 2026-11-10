// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import { awaitTaskCompletion } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { buildAudioTranslateRequest, audioTranslateResultPatch, audioTranslateActionResult } from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, isAudioNode, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AudioNode } from '@/features/canvas/nodes/AudioNode';
import { useCanvasStore } from '@/stores/canvasStore';

const scope = vi.hoisted(() => ({ project: 'audio/project', canvas: undefined as string | undefined }));
vi.mock('@/lib/url-params', async original => ({ ...(await original<typeof import('@/lib/url-params')>()), readUrl: () => scope }));
vi.mock('@/lib/model-task-access', async original => ({ ...(await original<typeof import('@/lib/model-task-access')>()), useModelTaskAccess: () => ({ blocked: false }) }));
vi.mock('@/lib/queries/generation-credit-cost', async original => ({ ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()), useGenerationCreditCost: () => ({}) }));
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), apiCall: vi.fn(), apiClient: vi.fn(() => { throw new Error('Unexpected transport'); }) }));
vi.mock('@/api/tasks', async original => ({ ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn() }));

const id = 'audio-translate';
const ref = { task_key: 'translate-task', task_type: 'freezone_text_translate', job_id: 'translate/job' };
interface Fixture {
  name: string;
  data?: Partial<AudioNodeData>;
  project?: string;
  canvas?: string;
  target?: 'missing' | 'wrong_type';
  fault?: 'submit' | 'wait' | 'result';
  translated?: string;
  operation?: { projectId: string; operationId: string; generationAttemptId?: string };
}
const fixtures: Fixture[] = [
  { name: 'trimmed text and default canvas' },
  { name: 'explicit canvas', canvas: 'canvas/2' },
  { name: 'empty canvas remains empty', canvas: '' },
  { name: 'legacy segments', data: { text: undefined, segments: [{ type: 'text', value: ' first ' }, { type: 'text', value: 'second ' }] } },
  { name: 'empty string shadows legacy segments', data: { text: '', segments: [{ type: 'text', value: 'ignored' }] } },
  { name: 'whitespace text', data: { text: ' \n ' } },
  { name: 'no text or segments', data: { text: undefined } },
  { name: 'missing project wins before missing node', project: '', target: 'missing' },
  { name: 'missing node', target: 'missing' },
  { name: 'wrong node type', target: 'wrong_type' },
  { name: 'busy audio still translates', data: { isGenerating: true } },
  { name: 'empty translation is written', translated: '' },
  { name: 'translation remains untrimmed', translated: ' translated \n' },
  { name: 'operation with attempt', operation: { projectId: 'audio/project', operationId: 'operation', generationAttemptId: 'attempt' } },
  { name: 'operation without attempt omitted', operation: { projectId: 'audio/project', operationId: 'operation' } },
  { name: 'submit failure', fault: 'submit' },
  { name: 'wait failure', fault: 'wait' },
  { name: 'result failure', fault: 'result' },
];
const originalUpdate = useCanvasStore.getState().updateNodeData;
function Target() {
  const node = useCanvasStore(state => state.nodes.find(candidate => candidate.id === id));
  if (!isAudioNode(node)) return null;
  return <AudioNode id={id} type={node.type} data={node.data} selected={false} dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); clearWorkflowProductOperation(id); useCanvasStore.setState({ updateNodeData: originalUpdate }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('audio translate subscriber parity', () => {
  it.each(fixtures)('$name', async fixture => {
    scope.project = fixture.project ?? 'audio/project'; scope.canvas = fixture.canvas;
    const initial: CanvasNode = { id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
      text: '  Hello world.  ', audioKind: 'music', model: 'suno_music', musicLengthMs: 30000,
      audioUrl: null, ...fixture.data,
    } };
    useCanvasStore.getState().setCanvasData([initial], []);
    if (fixture.operation) bindWorkflowProductOperation(id, fixture.operation);
    const translated = fixture.translated ?? 'Translated words';
    const error = new Error('Translation unavailable');
    vi.mocked(apiCall).mockImplementation(async route => {
      if (route.endsWith('/freezone/text/translate')) { if (fixture.fault === 'submit') throw error; return ref; }
      if (route.endsWith('/result')) { if (fixture.fault === 'result') throw error; return { translated_text: translated }; }
      throw new Error(`Unexpected API route: ${route}`);
    });
    vi.mocked(awaitTaskCompletion).mockImplementation(async () => { if (fixture.fault === 'wait') throw error; return { ...ref, username: 'test', project: scope.project, episode: 0, status: 'completed', result: { translated_text: 'ignored task result' } }; });
    const writes: Record<string, unknown>[] = [];
    useCanvasStore.setState({ updateNodeData: (nodeId, patch) => { writes.push(structuredClone(patch)); originalUpdate(nodeId, patch); } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider>);
    const targetNodes: CanvasNode[] = fixture.target === 'missing' ? [] : fixture.target === 'wrong_type'
      ? [{ id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'wrong' } }]
      : structuredClone(useCanvasStore.getState().nodes);
    const ctx = { nodes: targetNodes, nodeId: id, projectId: scope.project,
      canvasId: scope.canvas ?? 'default', productOperation: fixture.operation ?? null };
    const decision = buildAudioTranslateRequest(ctx);
    const before = structuredClone(ctx);
    writes.length = 0;
    const events: unknown[] = [];
    const accepted: unknown[] = [];
    const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => accepted.push(event));
    const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
    try {
      act(() => {
        // Replace the graph and dispatch in one turn, retaining the mounted subscriber.
        if (fixture.target) useCanvasStore.setState({ nodes: targetNodes });
        dispatchNodeAction({ nodeId: id, action: 'translate_text', requestId: fixture.name });
      });
      await waitFor(() => expect(events).toHaveLength(1));
      const submitted = decision.ok;
      const posted = vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST')
        .map(([path, options]) => ({ method: options?.method, path, body: options?.json }));
      expect(posted).toStrictEqual(submitted ? [decision.request] : []);
      const failure = decision.ok ? fixture.fault ? error.message : null : decision.message;
      expect(writes).toStrictEqual(failure === null ? [audioTranslateResultPatch(translated)] : []);
      expect(events).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'translate_text',
        ...audioTranslateActionResult(failure === null ? { text: translated } : { error: failure }) }]);
      expect(accepted).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'translate_text' }]);
      expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(submitted && fixture.fault !== 'submit' ? [[ref.task_key, scope.project]] : []);
      expect(vi.mocked(apiCall).mock.calls.filter(([route]) => route.endsWith('/result')).map(([route]) => route))
        .toStrictEqual(submitted && !['submit', 'wait'].includes(fixture.fault ?? '') ? [`projects/${encodeURIComponent(scope.project)}/freezone/jobs/freezone_text_translate/${encodeURIComponent(ref.job_id)}/result`] : []);
      expect(ctx).toStrictEqual(before);
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { off(); offAccepted(); client.clear(); }
  });
});
