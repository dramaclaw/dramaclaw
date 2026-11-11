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
import { buildAudioTranslateRequest } from '@/features/canvas/application/generationRequests';
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
  canvas?: string;
  fault?: 'submit';
  operation?: { projectId: string; operationId: string; generationAttemptId?: string };
}
const fixtures: Fixture[] = [
  { name: 'explicit canvas and operation', canvas: 'canvas/2', operation: {
    projectId: 'audio/project', operationId: 'operation', generationAttemptId: 'attempt',
  } },
  { name: 'submit failure', fault: 'submit' },
  { name: 'empty text refusal', data: { text: '' } },
];
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
afterEach(() => { cleanup(); clearWorkflowProductOperation(id); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('audio translate subscriber delegation', () => {
  it.each(fixtures)('$name', async fixture => {
    scope.canvas = fixture.canvas;
    const initial: CanvasNode = { id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
      text: '  Hello world.  ', audioKind: 'music', model: 'suno_music', musicLengthMs: 30000,
      audioUrl: null, ...fixture.data,
    } };
    useCanvasStore.getState().setCanvasData([initial], []);
    if (fixture.operation) bindWorkflowProductOperation(id, fixture.operation);
    const translated = 'Translated words';
    const error = new Error('Translation unavailable');
    vi.mocked(apiCall).mockImplementation(async route => {
      if (route.endsWith('/freezone/text/translate')) { if (fixture.fault === 'submit') throw error; return ref; }
      if (route.endsWith('/result')) return { translated_text: translated };
      throw new Error(`Unexpected API route: ${route}`);
    });
    vi.mocked(awaitTaskCompletion).mockImplementation(async () => { return { ...ref, username: 'test', project: scope.project, episode: 0, status: 'completed', result: { translated_text: 'ignored task result' } }; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider>);
    const targetNodes = structuredClone(useCanvasStore.getState().nodes);
    const ctx = { nodes: targetNodes, nodeId: id, projectId: scope.project,
      canvasId: scope.canvas ?? 'default', productOperation: fixture.operation ?? null };
    const decision = buildAudioTranslateRequest(ctx);
    const before = structuredClone(ctx);
    const events: unknown[] = [];
    const accepted: unknown[] = [];
    const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => accepted.push(event));
    const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
    try {
      act(() => {
        dispatchNodeAction({ nodeId: id, action: 'translate_text', requestId: fixture.name });
      });
      await waitFor(() => expect(events).toHaveLength(1));
      const submitted = decision.ok;
      const posted = vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST')
        .map(([path, options]) => ({ method: options?.method, path, body: options?.json }));
      expect(posted).toStrictEqual(submitted ? [decision.request] : []);
      expect(JSON.stringify(posted)).toBe(JSON.stringify(submitted ? [decision.request] : []));
      const failure = decision.ok ? fixture.fault ? error.message : null : decision.message;
      expect(events).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'translate_text',
        ...(failure === null ? { status: 'success', output: { text: 'Translated words' } } : { status: 'error', error: fixture.fault ? 'Translation unavailable' : '音频节点没有可翻译文本' }) }]);
      expect(accepted).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'translate_text' }]);
      expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(submitted && fixture.fault !== 'submit' ? [[ref.task_key, scope.project]] : []);
      expect(vi.mocked(apiCall).mock.calls.filter(([route]) => route.endsWith('/result')).map(([route]) => route))
        .toStrictEqual(submitted && !fixture.fault ? [`projects/${encodeURIComponent(scope.project)}/freezone/jobs/freezone_text_translate/${encodeURIComponent(ref.job_id)}/result`] : []);
      expect(useCanvasStore.getState().nodes.find(node => node.id === id)?.data).toStrictEqual({
        ...before.nodes[0].data, ...(failure === null ? { text: 'Translated words' } : {}),
      });
      if (!decision.ok) expect(apiCall).not.toHaveBeenCalled();
      expect(ctx).toStrictEqual(before);
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { off(); offAccepted(); client.clear(); }
  });
});
