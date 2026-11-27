// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from '@/api/client';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { fetchFreezoneJobResult, type FreezoneRecipeCompileMetadata } from '@/api/ops';
import {
  buildVideoGenerationRequest, videoPromptCompileInput, videoUpscaleWireRequest, videoEditImageOverflow,
  type VideoGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { videoGenerationActionResult, videoUpscaleActionResult, videoGenerationStartPatch,
  videoGenerationStartedRefusalOutcome } from '@/features/canvas/application/generationRequests/videoGenerationResult';
import { trimAndUploadExtendClip } from '@/features/canvas/application/videoExtendTrim';
import { toast } from 'sonner';
import i18next from 'i18next';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneVideoModelsSnapshot } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { prefetchFreezoneVideoCameraTemplates } from '@/features/canvas/hooks/useFreezoneVideoCameraTemplates';
import { VideoNode } from '@/features/canvas/nodes/VideoNode';
import { useCanvasStore } from '@/stores/canvasStore';

const scope = vi.hoisted(() => ({
  project: '', canvas: 'canvas-7', catalog: [] as ModelOption[],
  templates: [] as NonNullable<VideoGenerationRequestContext['cameraTemplates']>[number][], sequence: 0,
}));
vi.mock('@/lib/url-params', async (original) => ({
  ...(await original<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: scope.project, canvas: scope.canvas }),
}));
vi.mock('@/lib/queries/generation-credit-cost', async (original) => ({
  ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
vi.mock('@/lib/model-task-access', async (original) => ({
  ...(await original<typeof import('@/lib/model-task-access')>()),
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  apiClient: vi.fn((path: string, options: Parameters<typeof apiCall>[1]) => ({
    json: async () => ({ ok: true, data: await apiCall(path, options) }),
  })),
  apiCall: vi.fn(async (path: string) => {
    if (!/\/freezone\/video\/(gen|keyframes|i2v|video-edit|omni-gen|upscale)$/.test(path)) throw new Error(`Unexpected API call: ${path}`);
    const sequence = ++scope.sequence;
    return { task_key: `task-${sequence}`, task_type: 'freezone_video_gen', job_id: `job-${sequence}` };
  }),
}));
vi.mock('@/api/ops', async (original) => ({
  ...(await original<typeof import('@/api/ops')>()),
  fetchFreezoneVideoModels: vi.fn(async () => scope.catalog),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => scope.templates),
  fetchNodeGenerationHistory: vi.fn(async () => []),
  fetchFreezoneJobResult: vi.fn(async () => {
    throw new Error('Unexpected fetchFreezoneJobResult');
  }),
}));
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async (key: string) => ({ result: { video_url: `/static/${key}.mp4`, output_url: `/static/${key}.mp4` } })),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(async (input) => input.fallbackPrompt),
}));

const catalog: ModelOption[] = [{
  id: 'video-model', providerId: 'seedance', apiModel: 'seedance-2.0', label: 'Video', catalogId: 'catalog-video', humanReview: true,
}];
const metadata: FreezoneRecipeCompileMetadata = { mode: 'model', prompt: 'Recipe compiled video', recipeIds: ['recipe-1'] };
function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'vid-1', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: {
    prompt: 'A cat jumps', model: 'video-model', genMode: 'textToVideo', aspectRatio: '16:9',
    quality: '720p', durationSec: 5, count: 1, generateAudio: false, isGenerating: false, ...data,
  } };
}
function source(id: string, data: Record<string, unknown>, type: CanvasNode['type'] = CANVAS_NODE_TYPES.upload): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}
const imageA = source('a', { imageUrl: 'https://media.example.test/a.png?version=1' });
const imageB = source('b', { imageUrl: 'https://media.example.test/b.png?version=2' });
function sources(...nodes: CanvasNode[]): Pick<VideoGenerationRequestContext, 'nodes' | 'edges'> {
  return { nodes, edges: nodes.map((node) => ({ id: node.id, source: node.id, target: 'vid-1' })) };
}
type Fixture = VideoGenerationRequestContext & { name: string; compiled?: true };
function fixture(name: string, data: Record<string, unknown> = {}, overrides: Partial<VideoGenerationRequestContext> = {},
  extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [videoNode(data), ...(overrides.nodes ?? [])], edges: [], nodeId: 'vid-1',
    projectId: `video-parity/${name}`, canvasId: 'canvas-7', videoModels: catalog, cameraTemplates: null,
    executionSource: 'workflow', productOperation: null, ...overrides,
    // Source overrides contain only sources; retain the target.
    ...(overrides.nodes ? { nodes: [videoNode(data), ...overrides.nodes] } : {}), ...extra };
}

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('@/features/canvas/application/videoExtendTrim', () => ({
  trimAndUploadExtendClip: vi.fn(async () => ({ url: '/static/prepared.mp4', durationMs: 5000 })),
}));
const t = i18next.t.bind(i18next);
const video = source('video', { videoUrl: '/static/source.mp4', durationMs: 10000 }, CANVAS_NODE_TYPES.video);
const fixtures: Fixture[] = [
  fixture('text recipe', {}, { productOperation: { projectId: 'p', operationId: 'op-1', generationAttemptId: 'attempt-1' } }, { compiled: true }),
  fixture('image', { genMode: 'imageToVideo' }, sources(imageA)),
  fixture('frames', { genMode: 'firstLastFrame' }, { ...sources(imageB, imageA), edges: [
    { id: 'b', source: 'b', target: 'vid-1', data: { keyframeSlot: 'last' } },
    { id: 'a', source: 'a', target: 'vid-1', data: { keyframeSlot: 'first' } },
  ] }),
  fixture('edit overflow', { genMode: 'videoEdit' }, { ...sources(
    source('mixed', { videoUrl: '/static/source.mp4', imageUrl: '/static/mixed.png' }),
    ...Array.from({ length: 5 }, (_, i) => source(`image-${i}`, { imageUrl: `/static/${i}.png` }))),
    videoModels: [{ ...catalog[0], apiModel: 'happyhorse-1.0' }] }),
  fixture('extension trim and probe', { genMode: 'allReference', isExtendMode: true,
    extendStartMs: 2000, extendEndMs: 7000, extendSourceName: 'Source' }, {
    ...sources(video, source('music', { audioUrl: '/static/music.mp3' }, CANVAS_NODE_TYPES.audio)),
    translate: t, mediaDurationsMs: { '/static/music.mp3': 4000 },
    preparedExtendClip: { sourceUrl: '/static/source.mp4', startMs: 2000, endMs: 7000,
      url: '/static/prepared.mp4', durationMs: 5000 },
  }),
  fixture('refusal after start', { genMode: 'firstFrame' }, { ...sources(imageA), edges: [
    { id: 'last', source: 'a', target: 'vid-1', data: { keyframeSlot: 'last' } },
  ] }),
  fixture('upscale', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4?version=1', upscaleResolution: '2k' }),
];
function TargetNode() {
  const node = useCanvasStore((state) => state.nodes.find((candidate) => candidate.id === 'vid-1'));
  if (!isVideoNode(node)) throw new Error('Missing video node');
  return <VideoNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
beforeEach(() => {
  vi.clearAllMocks(); scope.sequence = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async input => input.fallbackPrompt);
});
afterEach(() => { cleanup(); clearWorkflowProductOperation('vid-1'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function renderDispatchCollect(ctx: Fixture) {
  scope.project = ctx.projectId; scope.canvas = ctx.canvasId; scope.catalog = ctx.videoModels;
  scope.templates = [];
  getFreezoneVideoModelsSnapshot(ctx.projectId);
  prefetchFreezoneVideoCameraTemplates(ctx.projectId);
  await waitFor(() => expect(getFreezoneVideoModelsSnapshot(ctx.projectId).isLoading).toBe(false));
  vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(
    function (this: HTMLMediaElement, url: string) {
      const ms = ctx.mediaDurationsMs?.[url];
      Object.defineProperty(this, 'duration', {
        configurable: true, value: typeof ms === 'number' ? ms / 1000 : NaN,
      });
      queueMicrotask(() => this.dispatchEvent(
        new Event(typeof ms === 'number' ? 'loadedmetadata' : 'error'),
      ));
    },
  );
  useCanvasStore.getState().setCanvasData(structuredClone(ctx.nodes), structuredClone(ctx.edges));
  const writes: Record<string, unknown>[] = [];
  const update = useCanvasStore.getState().updateNodeData;
  useCanvasStore.setState({ updateNodeData: (id, patch) => {
    if (id === 'vid-1') writes.push(patch);
    update(id, patch);
  } });
  if (ctx.productOperation) bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
  if (ctx.compiled) vi.mocked(compileWorkflowNodePrompt).mockImplementation(async input => {
    input.onCompileMetadata?.(metadata); return metadata.prompt;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let outcome: unknown;
  const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', event => {
    if (event.requestId === ctx.name) outcome = event;
  });
  try {
    render(
      <QueryClientProvider client={queryClient}>
        <ReactFlowProvider><TargetNode /></ReactFlowProvider>
      </QueryClientProvider>,
    );
    const state = useCanvasStore.getState();
    const settled = {
      ...ctx, nodes: structuredClone(state.nodes), edges: structuredClone(state.edges),
    };
    writes.length = 0;
    act(() => {
      dispatchNodeAction({
        nodeId: 'vid-1', action: 'generate_video', executionMode: 'workflow', requestId: ctx.name,
      });
    });
    await waitFor(() => expect(outcome).toBeDefined());
    const requests = vi.mocked(apiCall).mock.calls.map(([path, options]) => ({
      method: options?.method, path, body: JSON.parse(JSON.stringify(options?.json)),
    }));
    const finalData = useCanvasStore.getState().nodes.find(node => node.id === 'vid-1')?.data;
    return { outcome, requests, writes, settled, finalData };
  } finally {
    unsubscribe(); cleanup(); queryClient.clear();
    useCanvasStore.setState({ updateNodeData: update });
  }
}

describe('VideoNode delegates generation requests and outcomes', () => {
  it.each(fixtures)('$name', async ctx => {
    const { outcome, requests, writes, settled, finalData } = await renderDispatchCollect(ctx);
    const prompt = ctx.compiled ? metadata.prompt : videoPromptCompileInput(settled).fallbackPrompt;
    const built = buildVideoGenerationRequest({ ...settled, prompt });
    expect(requests).toStrictEqual(built.ok ? built.requests : []);
    expect(JSON.stringify(requests)).toBe(JSON.stringify(built.ok ? built.requests : []));
    expect(outcome).toStrictEqual({ requestId: ctx.name, nodeId: 'vid-1', action: 'generate_video',
      ...(ctx.name === 'upscale' ? videoUpscaleActionResult : videoGenerationActionResult)(
        finalData, 'workflow',
      ),
    });
    if (ctx.name === 'text recipe') expect(finalData).toMatchObject({
      workflowRecipeCompileMode: 'model', workflowRecipeCompiledPrompt: 'Recipe compiled video',
      prompt: 'Recipe compiled video', workflowRecipeIds: ['recipe-1'],
    });
    if (ctx.name === 'edit overflow') {
      expect(settled.nodes.find(node => node.id === 'vid-1')?.data.genMode).toBe('videoEdit');
      expect(videoEditImageOverflow(settled)).toStrictEqual({ limit: 5, ignored: 1 });
      expect(vi.mocked(toast.warning).mock.calls).toStrictEqual([
        [t('node.videoNode.videoEdit.imageLimit', videoEditImageOverflow(settled) ?? {})],
      ]);
    }
    if (ctx.name === 'extension trim and probe') {
      expect(vi.mocked(trimAndUploadExtendClip).mock.calls).toStrictEqual([
        [{ projectId: ctx.projectId, videoUrl: '/static/source.mp4',
          range: { startMs: 2000, endMs: 7000 } }],
      ]);
    }
    if (ctx.name === 'refusal after start') {
      expect(built.ok).toBe(false);
      if (built.ok) throw new Error('Expected refusal');
      expect(writes).toStrictEqual([videoGenerationStartPatch(1234567890000),
        ...videoGenerationStartedRefusalOutcome(built, {
          genMode: 'firstFrame', startedAtMs: 1234567890000, isHappyHorseModel: false,
        }, t).patches]);
    }
    if (ctx.name === 'upscale') expect(requests).toStrictEqual([videoUpscaleWireRequest({
      projectId: ctx.projectId, canvasId: 'canvas-7', nodeId: 'vid-1', productOperation: null,
      sourceUrl: '/static/source.mp4?version=1', resolution: '2k',
    })]);
  });
});

const upscaleData = {
  isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4?version=1', upscaleResolution: '2k',
};
describe('VideoNode reports refusals and failed upscales to the subscriber', () => {
  it.each([
    { ctx: fixture('no model refusal', {}, { videoModels: [] }),
      error: 'No video model is available.', noRequest: true, noWrite: true },
    { ctx: fixture('no prompt refusal', { prompt: '' }),
      error: 'A video prompt or upstream text is required.', noRequest: true, noWrite: true },
    { ctx: fixture('poll timeout'), error: '视频生成超时',
      reject: () => new TaskPollTimeoutError('task-1', 1000) },
    { ctx: fixture('upscale failure', upscaleData), error: 'raw upscale failure',
      reject: () => new Error('raw upscale failure') },
    { ctx: fixture('upscale poll timeout', upscaleData), error: '视频生成超时',
      reject: () => new TaskPollTimeoutError('task-1', 1000) },
    { ctx: fixture('upscale empty url', upscaleData), error: '视频增强失败', emptyUrl: true },
    { ctx: fixture('upscale no project', upscaleData, { projectId: '' }),
      error: 'A project is required.', noRequest: true },
  ])('$ctx.name', async ({ ctx, error, noRequest, noWrite, reject, emptyUrl }) => {
    if (reject) vi.mocked(awaitTaskCompletion).mockRejectedValueOnce(reject());
    if (emptyUrl) {
      vi.mocked(awaitTaskCompletion).mockResolvedValueOnce(
        { result: {} } as Awaited<ReturnType<typeof awaitTaskCompletion>>,
      );
      vi.mocked(fetchFreezoneJobResult).mockResolvedValueOnce(
        { url: '' } as Awaited<ReturnType<typeof fetchFreezoneJobResult>>,
      );
    }
    const { outcome, requests, writes } = await renderDispatchCollect(ctx);
    if (noRequest) expect(requests).toStrictEqual([]);
    if (noWrite) expect(writes).toStrictEqual([]);
    expect(outcome).toStrictEqual({
      requestId: ctx.name, nodeId: 'vid-1', action: 'generate_video', status: 'error', error,
    });
  });
});
