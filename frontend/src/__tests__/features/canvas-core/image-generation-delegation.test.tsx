// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiCall } from '@/api/client';
import {
  buildImageGenerationRequest,
  imagePromptCompileInput,
  type ImageGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import {
  bindWorkflowProductOperation,
  clearWorkflowProductOperation,
} from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { useCanvasStore } from '@/stores/canvasStore';

const mocks = vi.hoisted(() => ({
  projectId: '',
  canvasId: 'canvas-7',
  catalog: [] as ModelOption[],
  taskSequence: 0,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/queries/generation-credit-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries/generation-credit-cost')>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: mocks.projectId, canvas: mocks.canvasId }),
}));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiClient: vi.fn((path: string, options: Parameters<typeof apiCall>[1]) => ({
    json: async () => ({ ok: true, data: await apiCall(path, options) }),
  })),
  apiCall: vi.fn(async (path: string) => {
    if (path.endsWith('/freezone/upload')) return { url: uploadedReference };
    if (!path.endsWith('/freezone/gen')) throw new Error(`Unexpected API call: ${path}`);
    const sequence = ++mocks.taskSequence;
    return { task_key: `task-${sequence}`, task_type: 'freezone_gen', job_id: `job-${sequence}` };
  }),
}));
vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneImageModels: vi.fn(async () => mocks.catalog),
  listFreezoneStyleTemplates: vi.fn(async () => ({ templates: [], assetBase: '' })),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  fetchNodeGenerationHistory: vi.fn(async () => []),
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async (taskKey: string) => ({
    result: { output_url: `/static/${taskKey}.png` },
  })),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(async (input) => input.fallbackPrompt),
}));

import * as requests from '@/features/canvas/application/generationRequests/imageGenerationRequest';
import { imageGenerationOutcomePatch, imageGenerationActionResult, describeGenerationError } from '@/features/canvas/application/generationRequests';
import { awaitTaskCompletion } from '@/api/tasks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ImageGenNode } from '@/features/canvas/nodes/ImageGenNode';
import { isImageGenNode } from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
vi.mock('@/lib/model-task-access', async original => ({
  ...(await original<typeof import('@/lib/model-task-access')>()),
  useModelTaskAccess: () => ({ blocked: false, message: null, denialReason: null }),
}));
const uploadedReference = 'https://media.example.test/uploads/ref.png?sig=1';
const catalog: ModelOption[] = [{ id: 'image-model', providerId: 'openai', apiModel: 'image-api', label: 'Image' }];
const t = (key: string) => key;
function completedTask(taskKey: string, url: string): Awaited<ReturnType<typeof awaitTaskCompletion>> {
  return { task_key: taskKey, task_type: 'freezone_gen', username: '', project: mocks.projectId,
    episode: 0, status: 'completed', result: { output_url: url } };
}
function node(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'img-1', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
    data: { prompt: 'A cat', model: 'image-model', count: 1, ...data } };
}
const source: CanvasNode = { id: 'source', type: CANVAS_NODE_TYPES.upload,
  position: { x: 0, y: 0 }, data: { imageUrl: '/static/upstream.png?version=2' } };
const text: CanvasNode = { ...source, type: CANVAS_NODE_TYPES.textAnnotation, data: { content: 'Morning light' } };
const cases = [
  { name: 'plain', data: {} },
  { name: 'references', data: { referenceImageUrl: '/static/own.png?version=1' }, source },
  { name: 'scene master', data: { prompt: '', __freezone_source: { role: 'scene_master' } }, source: text },
  { name: 'manual count two', data: { count: 2 } },
  { name: 'product count two', data: { count: 2 }, operation: true },
  { name: 'inline count two', data: { count: 2, referenceImageUrl: 'data:image/png;base64,AA==' }, inline: true },
  { name: 'reference limit', data: { referenceImageUrl: '/static/own.png' }, source, blocked: true },
];
beforeEach(() => {
  vi.clearAllMocks(); mocks.taskSequence = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.mocked(awaitTaskCompletion).mockImplementation(async (taskKey) => completedTask(taskKey, `/static/${taskKey}.png`));
});
afterEach(() => { cleanup(); clearWorkflowProductOperation('img-1'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function prepare(name: string, nodes: CanvasNode[], blocked = false): Promise<ImageGenerationRequestContext> {
  mocks.projectId = `delegation/${name}`;
  mocks.catalog = blocked ? [{ ...catalog[0], referenceImageMax: 1 }] : catalog;
  const edges = nodes.slice(1).map(n => ({ id: n.id, source: n.id, target: 'img-1' }));
  useCanvasStore.getState().setCanvasData(nodes, edges);
  getFreezoneImageModelsSnapshot(mocks.projectId);
  await waitFor(() => expect(getFreezoneImageModelsSnapshot(mocks.projectId).isLoading).toBe(false));
  return { nodes, edges, nodeId: 'img-1', projectId: mocks.projectId, canvasId: 'canvas-7',
    imageModels: mocks.catalog, executionSource: 'manual', productOperation: null };
}
describe('shared image generation delegation', () => {
  it.each(cases)('$name', async fixture => {
    const ctx = await prepare(fixture.name, [node(fixture.data), ...(fixture.source ? [fixture.source] : [])], fixture.blocked);
    if (fixture.operation) {
      ctx.productOperation = { projectId: ctx.projectId, operationId: 'operation-1', generationAttemptId: 'attempt-1' };
      bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
    }
    const { result } = renderHook(() => useImageGenerationForm('img-1'));
    expect(result.current.submitDisabled).toBe(Boolean(fixture.blocked));
    const builder = vi.spyOn(requests, 'buildImageGenerationRequest');
    let output: unknown;
    await act(async () => { output = await result.current.submit({ attachStoryFrame: false }); });
    if (fixture.blocked) {
      expect(output).toBeUndefined(); expect(apiCall).not.toHaveBeenCalled(); return;
    }
    const calls = vi.mocked(apiCall).mock.calls;
    if (fixture.inline) {
      expect(calls.map(([path]) => path.split('/').slice(-1)[0])).toStrictEqual(['upload', 'upload', 'gen', 'gen']);
      for (const [path, options] of calls.filter(([path]) => path.endsWith('/upload'))) {
        expect(path).toBe(`projects/${encodeURIComponent(ctx.projectId)}/freezone/upload`);
        expect(Object.keys(options ?? {})).toStrictEqual(['method', 'body', 'timeout', 'signal']);
        expect(options?.body).toBeInstanceOf(FormData);
        if (!(options?.body instanceof FormData)) throw new Error('Expected multipart');
        const file = options.body.get('file');
        expect(file).toBeInstanceOf(Blob);
        if (!(file instanceof Blob)) throw new Error('Expected blob');
        expect([file.type, file.size]).toStrictEqual(['image/png', 1]);
      }
    }
    const buildCtx = fixture.inline ? { ...ctx, nodes: [node({ ...fixture.data, referenceImageUrl: uploadedReference })] } : ctx;
    const built = buildImageGenerationRequest({ ...buildCtx, prompt: imagePromptCompileInput(buildCtx).fallbackPrompt });
    if (!built.ok) throw new Error(built.message);
    const actual = calls.filter(([path]) => path.endsWith('/gen')).map(([path, options]) => ({
      method: options?.method, path, body: options?.json,
    }));
    expect(JSON.stringify(actual)).toBe(JSON.stringify(built.requests));
    // Equality alone also passes with the old inline derivation.
    expect(builder).toHaveBeenCalled();
    for (const [, options] of calls.filter(([path]) => path.endsWith('/gen'))) {
      expect(Object.keys(options ?? {})).toStrictEqual(['method', 'json']);
    }
  });
  it.each([false, true])('outcome patch, failed=%s', async failed => {
    await prepare(`outcome-${failed}`, [node()]);
    const error = new Error('Rendering failed request_id=req-1');
    if (failed) vi.mocked(awaitTaskCompletion).mockRejectedValueOnce(error);
    const writes: Record<string, unknown>[] = [];
    const update = useCanvasStore.getState().updateNodeData;
    useCanvasStore.setState({ updateNodeData: (id, patch) => { writes.push(patch); update(id, patch); } });
    try {
      const { result } = renderHook(() => useImageGenerationForm('img-1'));
      await act(async () => {
        if (failed) await expect(result.current.submit({ attachStoryFrame: false })).rejects.toBe(error);
        else await result.current.submit({ attachStoryFrame: false });
      });
      const expected = imageGenerationOutcomePatch({ nodeId: 'img-1', nodeData: { generationTaskKey: 'task-1' },
        taskKey: 'task-1', firstAcceptedTask: { task_key: 'task-1', task_type: 'freezone_gen', job_id: 'job-1' },
        runIndex: 0, total: 1, completedUrls: [], attachStoryFrame: false, translate: t,
        outcome: failed ? { kind: 'failed', message: error.message, error: describeGenerationError(error, t, 'common.error') }
          : { kind: 'completed', result: { output_url: '/static/task-1.png' } },
      });
      if (expected.action !== 'write') throw new Error('Expected write');
      expect(writes[writes.length - 1]).toStrictEqual(expected.patch);
      expect(writes[writes.length - 1]).toMatchObject(failed ? { generationError: error.message, generationErrorRequestId: 'req-1' }
        : { imageUrl: '/static/task-1.png', generationError: null });
    } finally { useCanvasStore.setState({ updateNodeData: update }); }
  });
  it('submits the IME draft while the stored prompt is unchanged', async () => {
    const ctx = await prepare('draft', [node()]);
    const { result } = renderHook(() => useImageGenerationForm('img-1'));
    act(() => { result.current.formProps.onCompositionStart(); });
    act(() => { result.current.formProps.onPromptChange('Draft cat'); });
    expect(useCanvasStore.getState().nodes[0].data.prompt).toBe('A cat');
    await act(async () => { await result.current.submit({ attachStoryFrame: false }); });
    const built = buildImageGenerationRequest({ ...ctx, nodes: [node({ prompt: 'Draft cat' })], prompt: 'Draft cat' });
    if (!built.ok) throw new Error(built.message);
    expect(JSON.stringify(vi.mocked(apiCall).mock.calls[0][1]?.json)).toBe(JSON.stringify(built.requests[0].body));
    expect(built.requests[0].body.prompt).toBe('Draft cat');
  });
  it.each([false, true])('retains the render-time auto-commit decision: %s', async autoCommit => {
    await prepare(`auto-${autoCommit}`, [node({ autoCommitOnGenerate: autoCommit, preset_managed: true })]);
    vi.mocked(awaitTaskCompletion).mockImplementationOnce(async () => {
      useCanvasStore.getState().updateNodeData('img-1', { autoCommitOnGenerate: !autoCommit });
      return completedTask('task-1', '/static/completed.png');
    });
    const commits: unknown[] = [];
    const unsubscribe = canvasEventBus.subscribe('freezone/commit-node', event => { commits.push(event); });
    try {
      const { result } = renderHook(() => useImageGenerationForm('img-1'));
      await act(async () => { await result.current.submit({ attachStoryFrame: false }); });
      expect(commits).toStrictEqual(autoCommit ? [{ nodeId: 'img-1', auto: true }] : []);
    } finally { unsubscribe(); }
  });
  it('generate_image publishes the pure action result', async () => {
    await prepare('subscriber', [node()]);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Target() {
      const target = useCanvasStore(state => state.nodes[0]);
      if (!isImageGenNode(target)) throw new Error('Expected image node');
      return <ImageGenNode id={target.id} type={target.type} data={target.data} selected={false} dragging={false}
        draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
    }
    let published: unknown;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', event => { published = event; });
    try {
      render(<QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider>);
      act(() => { dispatchNodeAction({ nodeId: 'img-1', action: 'generate_image', requestId: 'action-1', executionMode: 'workflow' }); });
      await waitFor(() => expect(published).toBeDefined());
      expect(published).toStrictEqual({ requestId: 'action-1', nodeId: 'img-1', action: 'generate_image',
        ...imageGenerationActionResult({ settleOutcome: { kind: 'output', output: {
          task_key: 'task-1', task_type: 'freezone_gen', job_id: 'job-1', imageUrl: '/static/task-1.png', imageUrls: ['/static/task-1.png'],
        } }, settled: [{ status: 'fulfilled', value: 'completed' }] }),
      });
    } finally { unsubscribe(); cleanup(); client.clear(); }
  });
});
