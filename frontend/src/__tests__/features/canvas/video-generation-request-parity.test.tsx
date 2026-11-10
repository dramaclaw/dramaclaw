// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import { type FreezoneRecipeCompileMetadata } from '@/api/ops';
import {
  buildVideoGenerationRequest, videoPromptCompileInput, videoPromptCompileMetadataPatch,
  type VideoGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CAMERA_MOVEMENT_PRESETS } from '@/features/canvas/domain/cameraMovementPresets';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneVideoModelsSnapshot } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { prefetchFreezoneVideoCameraTemplates } from '@/features/canvas/hooks/useFreezoneVideoCameraTemplates';
import { VideoNode } from '@/features/canvas/nodes/VideoNode';
import { useCanvasStore } from '@/stores/canvasStore';

const scope = vi.hoisted(() => ({
  project: '', canvas: 'canvas-7', catalog: [] as ModelOption[],
  templates: [] as NonNullable<VideoGenerationRequestContext['cameraTemplates']>[number][], sequence: 0,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key,
  i18n: { language: 'en' },
}) }));
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
    if (!/\/freezone\/video\/(gen|keyframes|i2v)$/.test(path)) throw new Error(`Unexpected API call: ${path}`);
    const sequence = ++scope.sequence;
    return { task_key: `task-${sequence}`, task_type: 'freezone_video_gen', job_id: `job-${sequence}` };
  }),
}));
vi.mock('@/api/ops', async (original) => ({
  ...(await original<typeof import('@/api/ops')>()),
  fetchFreezoneVideoModels: vi.fn(async () => scope.catalog),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => scope.templates),
  fetchNodeGenerationHistory: vi.fn(async () => []),
}));
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async (key: string) => ({ result: { video_url: `/static/${key}.mp4` } })),
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
type Fixture = VideoGenerationRequestContext & {
  name: string; refusal?: string; browserForwardsInline?: true; errorOutcome?: true; compiled?: true; compiledPrompt?: string; expected?: Record<string, unknown>;
  requestCount?: number; executionMode?: 'single' | 'workflow';
};
function fixture(name: string, data: Record<string, unknown> = {}, overrides: Partial<VideoGenerationRequestContext> = {},
  extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [videoNode(data), ...(overrides.nodes ?? [])], edges: [], nodeId: 'vid-1',
    projectId: `video-parity/${name}`, canvasId: 'canvas-7', videoModels: catalog, cameraTemplates: null,
    executionSource: 'workflow', productOperation: null, ...overrides,
    // Source overrides contain only sources; retain the target.
    ...(overrides.nodes ? { nodes: [videoNode(data), ...overrides.nodes] } : {}), ...extra };
}
const fixtures: Fixture[] = [
  fixture('fresh text-to-video default', { model: 'newapi_seedance-2.0', quality: '720P', generateAudio: undefined }, {}, { expected: {
    prompt: 'A cat jumps', camera_template_id: null, character_ids: [], marks: [],
    aspect_ratio: '16:9', resolution: '720p', duration_seconds: 5, generate_audio: true,
    model: 'catalog-video', model_id: 'catalog-video', gen_mode: 'textToVideo', human_review: false,
    scene_optimize: null, canvas_id: 'canvas-7', node_id: 'vid-1',
  } }),
  fixture('unknown model fallback', { model: 'removed' }),
  fixture('missing model fallback', { model: undefined }),
  fixture('catalog identity selection', { model: 'catalog-second' }, { videoModels: [...catalog, {
    ...catalog[0], id: 'second', catalogId: 'catalog-second',
  }] }, { expected: { model: 'catalog-second', model_id: 'catalog-second' } }),
  fixture('catalog ratio resolution duration clamp', { aspectRatio: '43:24', quality: '1080p', durationSec: 99 }, {
    videoModels: [{ ...catalog[0], ratioOptions: [' 1:1 ', '16:9'], resolutionOptions: [' 1080P ', '720p'], minDuration: 3, maxDuration: 8 }],
  }, { expected: { aspect_ratio: '1:1', resolution: '1080P', duration_seconds: 8 } }),
  fixture('fallback ratio snapping duration rounding', { aspectRatio: '43:24', durationSec: 6.6 }, {}, {
    expected: { aspect_ratio: '16:9', duration_seconds: 7 },
  }),
  fixture('duration lower clamp quality fallback', { durationSec: -2, quality: 'invalid' }, {}, { expected: { duration_seconds: 5, resolution: '720p' } }),
  fixture('auto ratio from dimensions', { aspectRatio: 'auto', widthPx: 900, heightPx: 1600 }, {}, { expected: { aspect_ratio: '9:16' } }),
  fixture('auto ratio without dimensions', { aspectRatio: 'auto' }, {}, { expected: { aspect_ratio: '16:9' } }),
  fixture('catalog auto ratio', { aspectRatio: 'auto' }, { videoModels: [{ ...catalog[0], ratioOptions: ['auto', '1:1'] }] }, { expected: { aspect_ratio: 'auto' } }),
  fixture('generate audio on', { generateAudio: true }, {}, { expected: { generate_audio: true } }),
  fixture('generate audio off', { generateAudio: false }, {}, { expected: { generate_audio: false } }),
  fixture('generate audio missing defaults on', { generateAudio: undefined }, {}, { expected: { generate_audio: true } }),
  fixture('generate audio unsupported', { generateAudio: true }, { videoModels: [{ ...catalog[0], supportsGenerateAudio: false }] }, { expected: { generate_audio: false } }),
  fixture('human review ignored for text', { humanReview: true }, {}, { expected: { human_review: false } }),
  fixture('scene optimize catalog', { sceneOptimize: 'realistic' }, { videoModels: [{ ...catalog[0], sceneOptimizeOptions: ['anime', 'realistic'] }] }, { expected: { scene_optimize: 'realistic' } }),
  fixture('scene optimize fallback preset', {}, { videoModels: [{ ...catalog[0], apiModel: 'newapi_seedance-2.0-fast-value' }] }, { expected: { scene_optimize: 'realistic' } }),
  fixture('scene optimize unsupported omitted', { sceneOptimize: 'anime' }, {}, { expected: { scene_optimize: null } }),
  fixture('camera catalog template', { cameraMovement: 'custom' }, { cameraTemplates: [{ id: 'custom', label: 'Custom', promptFragment: 'Slow pan', videoUrl: null }] }, { expected: { prompt: 'Slow pan，A cat jumps', camera_template_id: 'custom' } }),
  fixture('camera fallback preset', { cameraMovement: 'fixed' }, {}, { expected: { prompt: `${CAMERA_MOVEMENT_PRESETS[0].promptFragment}，A cat jumps`, camera_template_id: 'fixed' } }),
  fixture('camera fragment precedes ordered upstream text', { cameraMovement: 'custom' }, {
    ...sources(source('text1', { content: ' First ' }, CANVAS_NODE_TYPES.textAnnotation), source('text2', { content: ' Second ' }, CANVAS_NODE_TYPES.textAnnotation)),
    cameraTemplates: [{ id: 'custom', label: 'Custom', promptFragment: 'Slow pan', videoUrl: null }],
  }, { expected: { prompt: 'Slow pan，First\n\nSecond\n\nA cat jumps' } }),
  fixture('unknown camera id retained', { cameraMovement: 'removed' }, {}, { expected: { prompt: 'A cat jumps', camera_template_id: 'removed' } }),
  fixture('model params', { modelParams: { seed: 42, extra: { steps: 8 } } }, {}, { expected: { model_params: { seed: 42, extra: { steps: 8 } } } }),
  fixture('product operation with attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1', generationAttemptId: 'attempt-1' } }, { expected: { product_operation_id: 'op-1', generation_attempt_id: 'attempt-1' } }),
  fixture('product operation without attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1' } }),
  fixture('count three', { count: 3 }, {}, { requestCount: 3 }),
  fixture('count upper clamp', { count: 8 }, {}, { requestCount: 4 }),
  fixture('count lower clamp', { count: 0 }, {}, { requestCount: 1 }),
  fixture('single action still completes', {}, {}, { executionMode: 'single' }),
  fixture('upstream text edge order dependency ignored', {}, {
    nodes: [source('t1', { content: ' First ' }, CANVAS_NODE_TYPES.textAnnotation), source('t2', { content: ' Second ' }, CANVAS_NODE_TYPES.textAnnotation), source('dep', { content: 'Ignored' }, CANVAS_NODE_TYPES.textAnnotation)],
    edges: [{ id: 't2', source: 't2', target: 'vid-1' }, { id: 'dep', source: 'dep', target: 'vid-1', data: { link_type: 'dependency_for' } }, { id: 't1', source: 't1', target: 'vid-1' }],
  }, { expected: { prompt: 'Second\n\nFirst\n\nA cat jumps' } }),
  fixture('first frame query preserved', { genMode: 'firstFrame', prompt: '' }, sources(imageA), { expected: { first_frame_url: imageA.data.imageUrl, last_frame_url: null, aspect_ratio: 'auto', prompt: '' } }),
  fixture('first last keyframe slots', { genMode: 'firstLastFrame' }, { ...sources(imageB, imageA), edges: [
    { id: 'b', source: 'b', target: 'vid-1', data: { keyframeSlot: 'last' } },
    { id: 'a', source: 'a', target: 'vid-1', data: { keyframeSlot: 'first' } },
  ] }, { expected: { first_frame_url: imageA.data.imageUrl, last_frame_url: imageB.data.imageUrl, aspect_ratio: 'auto' } }),
  fixture('image to video reference cap slicing', { genMode: 'imageToVideo' }, { ...sources(imageA), videoModels: [{ ...catalog[0], referenceImageMax: 9 }] }, { expected: { image_urls: [imageA.data.imageUrl] } }),
  fixture('image reference manual order', { genMode: 'imageReference', referenceOrder: ['b', 'a'] }, sources(imageA, imageB), { expected: { image_urls: [imageB.data.imageUrl, imageA.data.imageUrl] } }),
  fixture('human review supported', { genMode: 'imageReference', humanReview: true }, sources(imageA), { expected: { human_review: true } }),
  fixture('human review unsupported', { genMode: 'imageReference', humanReview: true }, { ...sources(imageA), videoModels: [{ ...catalog[0], humanReview: false }] }, { expected: { human_review: false } }),
  fixture('legacy model alias selection', { model: 'seedance-2.0' }),
  fixture('model without catalog id uses id', {}, { videoModels: [{ ...catalog[0], catalogId: undefined }] }, { expected: { model: 'video-model', model_id: 'video-model' } }),
  fixture('scene optimize invalid uses catalog default', { sceneOptimize: 'invalid' }, { videoModels: [{ ...catalog[0], sceneOptimizeOptions: ['anime'], defaultSceneOptimize: 'realistic' }] }, { expected: { scene_optimize: 'realistic' } }),
  fixture('scene optimize value default anime', {}, { videoModels: [{ ...catalog[0], apiModel: 'huimeng_seedance-2.0-value' }] }, { expected: { scene_optimize: 'anime' } }),
  fixture('quality first option fallback invalid bounds', { quality: 'unknown', durationSec: 99 }, { videoModels: [{ ...catalog[0], resolutionOptions: [' 4K ', '2K'], minDuration: -1, maxDuration: -2 }] }, { expected: { resolution: '4K', duration_seconds: 15 } }),
  fixture('blank catalog options use defaults', {}, { videoModels: [{ ...catalog[0], ratioOptions: [' '], resolutionOptions: [' '] }] }, { expected: { aspect_ratio: '16:9', resolution: '720p' } }),
  fixture('dependency image ignored', {}, { ...sources(imageA), edges: [{ id: 'dep-image', source: 'a', target: 'vid-1', data: { link_type: 'dependency_for' } }] }, { expected: { gen_mode: 'textToVideo' } }),
  fixture('story choice image ignored', {}, { ...sources(imageA), edges: [{ id: 'choice', source: 'a', target: 'vid-1', type: 'storyChoiceEdge' }] }, { expected: { gen_mode: 'textToVideo' } }),
  fixture('first last edge order fallback', { genMode: 'firstLastFrame' }, sources(imageB, imageA), { expected: { first_frame_url: imageB.data.imageUrl, last_frame_url: imageA.data.imageUrl } }),
  fixture('last keyframe only', { genMode: 'firstLastFrame' }, { ...sources(imageA), edges: [{ id: 'last', source: 'a', target: 'vid-1', data: { keyframeSlot: 'last' } }] }, { expected: { first_frame_url: null, last_frame_url: imageA.data.imageUrl } }),
  fixture('image references retain duplicates', { genMode: 'imageReference' }, sources(imageA, source('same', { imageUrl: imageA.data.imageUrl })), { expected: { image_urls: [imageA.data.imageUrl, imageA.data.imageUrl] } }),
  fixture('image submission prefers source over preview', { genMode: 'imageReference' }, sources(source('preview', { imageUrl: imageA.data.imageUrl, previewImageUrl: imageB.data.imageUrl })), { expected: { image_urls: [imageA.data.imageUrl] } }),
  fixture('image generation reference fallback', { genMode: 'imageReference' }, sources(source('generated', { referenceImageUrl: imageB.data.imageUrl }, CANVAS_NODE_TYPES.imageGen)), { expected: { image_urls: [imageB.data.imageUrl] } }),
  fixture('text upstream satisfies required prompt', { prompt: '' }, sources(source('text', { content: 'Upstream only' }, CANVAS_NODE_TYPES.textAnnotation)), { expected: { prompt: 'Upstream only' } }),
  fixture('no model refusal', {}, { videoModels: [] }, { refusal: 'no_model' }),
  fixture('ambiguous model alias refusal', { model: 'seedance-2.0' }, { videoModels: [catalog[0], { ...catalog[0], id: 'other', catalogId: 'other' }] }, { refusal: 'no_model' }),
  fixture('camera only does not satisfy prompt guard', { prompt: '', cameraMovement: 'fixed' }, {}, { refusal: 'no_effective_prompt' }),
  fixture('model capability refusal', { genMode: 'imageReference' }, { ...sources(imageA, imageB), videoModels: [{ ...catalog[0], apiModel: 'seedance-1.5-pro' }] }, { refusal: 'model_capability_error' }),
  fixture('video reference capability refusal', { genMode: 'imageReference' }, { ...sources(imageA, source('video', { videoUrl: 'https://media.example.test/v.mp4' })), videoModels: [{ ...catalog[0], apiModel: 'custom', supportedModes: ['image_reference', 'text_to_video'] }] }, { refusal: 'model_capability_error' }),
  fixture('generation in progress refusal', { isGenerating: true, generationJobId: 'running' }, {}, { refusal: 'generation_in_progress' }),
  fixture('compiled empty prompt preserved', {}, {}, { compiledPrompt: '', expected: { prompt: '' } }),
  fixture('compiled recipe with metadata', {}, {}, { compiled: true, expected: { prompt: metadata.prompt } }),
  fixture('no prompt refusal', { prompt: ' ' }, {}, { refusal: 'no_effective_prompt' }),
  fixture('no media refusal', { genMode: 'firstFrame' }, sources(source('empty', {})), { refusal: 'missing_media' }),
  fixture('over cap refusal', { genMode: 'imageReference' }, { ...sources(imageA, imageB), videoModels: [{ ...catalog[0], referenceImageMax: 1 }] }, { refusal: 'reference_limit_exceeded' }),
  fixture('inline preview reference refusal', { genMode: 'imageReference' }, sources(source('inline', { previewImageUrl: 'data:image/png;base64,AA==' })), { refusal: 'inline_media_reference' }),
  fixture('inline source forwarded by browser', { genMode: 'imageReference' }, sources(source('inline-source', { imageUrl: 'data:image/png;base64,AA==' })), { refusal: 'inline_media_reference', browserForwardsInline: true }),
  fixture('first frame last slot refusal', { genMode: 'firstFrame' }, { ...sources(imageA), edges: [{ id: 'last', source: 'a', target: 'vid-1', data: { keyframeSlot: 'last' } }] }, { refusal: 'missing_media', errorOutcome: true }),
  fixture('preview without source refusal', { genMode: 'imageReference' }, sources(source('preview', { previewImageUrl: 'https://media.example.test/preview.png' })), { refusal: 'missing_media' }),
];

function TargetNode() {
  const node = useCanvasStore((state) => state.nodes.find((candidate) => candidate.id === 'vid-1'));
  if (!isVideoNode(node)) throw new Error('Missing video node');
  return <VideoNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
function wireRequests() {
  return vi.mocked(apiCall).mock.calls.map(([path, options]) => ({
    method: options?.method, path, body: JSON.parse(JSON.stringify(options?.json)),
  }));
}
beforeEach(() => {
  vi.clearAllMocks(); scope.sequence = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => input.fallbackPrompt);
});
afterEach(() => { cleanup(); clearWorkflowProductOperation('vid-1'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('VideoNode agent request wire parity', () => {
  it.each(fixtures)('$name', async (ctx) => {
    scope.project = ctx.projectId; scope.canvas = ctx.canvasId; scope.catalog = ctx.videoModels;
    scope.templates = [...(ctx.cameraTemplates ?? [])];
    getFreezoneVideoModelsSnapshot(ctx.projectId); prefetchFreezoneVideoCameraTemplates(ctx.projectId);
    await waitFor(() => expect(getFreezoneVideoModelsSnapshot(ctx.projectId).isLoading).toBe(false));
    useCanvasStore.getState().setCanvasData(structuredClone(ctx.nodes), structuredClone(ctx.edges));
    if (ctx.productOperation) bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
    if (ctx.compiled) vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => {
      input.onCompileMetadata?.(metadata); return metadata.prompt;
    });
    if (ctx.compiledPrompt !== undefined) vi.mocked(compileWorkflowNodePrompt).mockResolvedValue(ctx.compiledPrompt);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
    // Capture the settled graph: the real component may normalize stored selections on mount.
    const state = useCanvasStore.getState();
    const settled = { ...ctx, nodes: structuredClone(state.nodes), edges: structuredClone(state.edges) };
    expect(settled.nodes.find((node) => node.id === ctx.nodeId)?.data.genMode)
      .toBe(ctx.nodes.find((node) => node.id === ctx.nodeId)?.data.genMode);
    const compileInput = videoPromptCompileInput(settled);
    const compiled = ctx.compiled ? metadata.prompt : ctx.compiledPrompt ?? compileInput.fallbackPrompt;
    const result = buildVideoGenerationRequest({ ...settled, prompt: compiled });
    let outcome: { status: string; output?: Record<string, unknown> } | undefined;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => { if (event.requestId === ctx.name) outcome = event; });
    try {
      act(() => { dispatchNodeAction({ nodeId: ctx.nodeId, action: 'generate_video', executionMode: ctx.executionMode ?? 'workflow', requestId: ctx.name }); });
      await waitFor(() => expect(outcome).toBeDefined());
      const call = vi.mocked(compileWorkflowNodePrompt).mock.calls[0]?.[0];
      if (call) {
        const { nodeId, nodeData, executionSource, onCompileMetadata, ...actualInput } = call;
        expect({ nodeId, executionSource }).toStrictEqual({ nodeId: ctx.nodeId, executionSource: 'workflow' });
        expect(nodeData).toBeDefined(); expect(onCompileMetadata).toBeTypeOf('function');
        expect(actualInput).toStrictEqual(compileInput);
      }
      if (ctx.refusal) {
        expect(result).toMatchObject({ ok: false, code: ctx.refusal });
        if (ctx.browserForwardsInline) {
          // The pure boundary requires uploaded URLs; the current browser sends inline sources unchanged.
          expect(wireRequests()).toHaveLength(1);
          expect(wireRequests()[0].body.image_urls).toStrictEqual(['data:image/png;base64,AA==']);
        } else {
          expect(wireRequests()).toStrictEqual([]);
        }
        expect(outcome?.status).toBe(ctx.errorOutcome ? 'error' : 'success');
      } else {
        expect(outcome?.status).toBe('success');
        expect(call).toBeDefined();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(wireRequests()).toStrictEqual(result.requests);
        expect(result.requests).toHaveLength(ctx.requestCount ?? 1);
        expect(result.requests[0].body).toMatchObject(ctx.expected ?? {});
        if (ctx.name === 'fresh text-to-video default') expect(result.requests[0].body).toStrictEqual(ctx.expected);
        if (ctx.executionMode === 'single') expect(outcome?.output).toMatchObject({ submitted: true, videoUrl: '/static/task-1.mp4' });
        if (ctx.compiled) {
          const data = useCanvasStore.getState().nodes.find((node) => node.id === ctx.nodeId)?.data;
          expect(data?.workflowRecipeCompiledAt).toBeTypeOf('string');
          const patch = videoPromptCompileMetadataPatch(metadata, String(data?.workflowRecipeCompiledAt));
          expect(Object.fromEntries(Object.keys(patch).map((key) => [key, data?.[key]]))).toStrictEqual(patch);
        }
      }
      expect(apiClient).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { unsubscribe(); queryClient.clear(); }
  });
});

describe('pure video request boundaries', () => {
  it('wrong node type', () => {
    const ctx = { ...fixtures[0], nodes: [imageA], nodeId: imageA.id };
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'not_video_node' });
    expect(() => videoPromptCompileInput(ctx)).toThrow();
  });
  it('no model', () => expect(buildVideoGenerationRequest({ ...fixtures[0], videoModels: [], prompt: 'Test' })).toMatchObject({ ok: false, code: 'no_model' }));
  it.each([
    ['videoEdit', 'missing_source_video'], ['videoExtend', 'missing_source_video'], ['allReference', 'missing_references'],
  ])('%s without media references', (genMode, code) => {
    expect(buildVideoGenerationRequest({ ...fixture('no media', { genMode }), prompt: 'Test' })).toMatchObject({ ok: false, code });
  });
  it('upscale without source', () => expect(buildVideoGenerationRequest({ ...fixture('upscale', { isUpscaleNode: true }), prompt: 'Test' })).toMatchObject({ ok: false, code: 'missing_upscale_source' }));
  it('inline source reference requires upload', () => expect(buildVideoGenerationRequest({ ...fixture('inline', { genMode: 'imageReference' }, sources(source('inline', { imageUrl: 'data:image/png;base64,AA==' }))), prompt: 'Test' })).toMatchObject({ ok: false, code: 'inline_media_reference' }));
  it('resolved task activity overrides node flag', () => {
    expect(buildVideoGenerationRequest({ ...fixtures[0], isGenerating: true, prompt: 'Test' })).toMatchObject({ ok: false, code: 'generation_in_progress' });
    expect(buildVideoGenerationRequest({ ...fixture('stale flag', { isGenerating: true }), isGenerating: false, prompt: 'Test' }).ok).toBe(true);
  });
  it('missing project', () => expect(buildVideoGenerationRequest({ ...fixtures[0], projectId: '', prompt: 'Test' })).toMatchObject({ ok: false, code: 'no_project' }));
  it('single image cap cannot be overridden by catalog', () => expect(buildVideoGenerationRequest({
    ...fixture('structural cap', { genMode: 'imageToVideo' }, { ...sources(imageA, imageB), videoModels: [{ ...catalog[0], referenceImageMax: 9 }] }), prompt: 'Test',
  })).toMatchObject({ ok: false, code: 'reference_limit_exceeded' }));
  it('manual execution still makes separate count submissions', () => {
    const ctx = { ...fixture('manual', { count: 3 }), executionSource: 'manual' as const, prompt: 'Test' };
    const result = buildVideoGenerationRequest(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0].body).not.toHaveProperty('variant_count');
  });
  it('inputs not mutated', () => {
    const ctx = structuredClone(fixtures.find((item) => item.name === 'image reference manual order')!);
    const before = structuredClone(ctx);
    videoPromptCompileInput(ctx); buildVideoGenerationRequest({ ...ctx, prompt: 'Test' });
    expect(ctx).toStrictEqual(before);
  });
});
