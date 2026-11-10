// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import i18next from 'i18next';
import { trimAndUploadExtendClip } from '@/features/canvas/application/videoExtendTrim';
import {
  buildVideoGenerationRequest, videoPromptCompileInput, videoExtendTrimRequirement,
  type VideoGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { CANVAS_NODE_TYPES, isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneVideoModelsSnapshot } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { prefetchFreezoneVideoCameraTemplates } from '@/features/canvas/hooks/useFreezoneVideoCameraTemplates';
import { VideoNode } from '@/features/canvas/nodes/VideoNode';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * Boundary replacements (same harness as B1): URL parameters supply project/canvas;
 * billing/access hooks supply admission; API client records serialized HTTP; catalog,
 * templates and history reads return fixtures; task polling returns completed assets;
 * the recipe compiler returns its fallback so its real input can be compared.
 * Trim/upload replaces browser encoding. Media src/duration/load replace metadata I/O.
 * ResizeObserver supplies missing jsdom layout support; fetch is a tripwire against I/O.
 * Translation, serializers, graph traversal, VideoNode, dialogs and children stay real.
 */
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
    if (!/\/freezone\/video\/(gen|keyframes|i2v|video-edit|video-extend|omni-gen|upscale)$/.test(path)) throw new Error(`Unexpected API call: ${path}`);
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
  awaitTaskCompletion: vi.fn(async (key: string) => ({ result: { video_url: `/static/${key}.mp4`, output_url: `/static/${key}.mp4` } })),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(async (input) => input.fallbackPrompt),
}));

// Replace only browser re-encoding/upload; the caller supplies this same prepared asset.
vi.mock('@/features/canvas/application/videoExtendTrim', () => ({
  trimAndUploadExtendClip: vi.fn(async () => ({ url: '/static/prepared.mp4', durationMs: 5000 })),
}));

const catalog: ModelOption[] = [{
  id: 'video-model', providerId: 'seedance', apiModel: 'seedance-2.0', label: 'Video',
  catalogId: 'catalog-video', humanReview: true,
  supportedModes: ['text_to_video', 'first_frame', 'image_to_video', 'image_reference', 'video_edit', 'video_extend', 'all_reference'],
  referenceFileMax: 1, referenceLinkMax: 1,
}];
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
  name: string; refusal?: string; browserForwardsInline?: true; errorOutcome?: true; rejection?: { media: string; kind: string }; trim?: { url: string; durationMs: number }; expected?: Record<string, unknown>;
  requestCount?: number;
};
function fixture(name: string, data: Record<string, unknown> = {}, overrides: Partial<VideoGenerationRequestContext> = {},
  extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [videoNode(data), ...(overrides.nodes ?? [])], edges: [], nodeId: 'vid-1',
    projectId: `video-parity/${name}`, canvasId: 'canvas-7', videoModels: catalog, cameraTemplates: null, translate: (key, options) => String(i18next.t(key, options)),
    executionSource: 'workflow', productOperation: null, ...overrides,
    // Source overrides contain only sources; retain the target.
    ...(overrides.nodes ? { nodes: [videoNode(data), ...overrides.nodes] } : {}), ...extra };
}
const video = source('video', { videoUrl: '/static/source.mp4', durationMs: 10000 }, CANVAS_NODE_TYPES.video);
const uploadVideo = source('upload-video', { videoUrl: '/static/upload.mp4', durationMs: 10000 });
const audio = (id: string, data: Record<string, unknown> = {}) => source(id, { audioUrl: `/static/${id}.mp3`, durationMs: 3000, ...data }, CANVAS_NODE_TYPES.audio);
const withModel = (model: Partial<ModelOption>) => ({ videoModels: [{ ...catalog[0], ...model }] });
const editModel = withModel({ referenceAudioMax: 3 });
const durationModel = withModel({ referenceVideoMaxSeconds: 8 });
const extension = { genMode: 'allReference', isExtendMode: true, extendStartMs: 0, extendEndMs: 10000, extendSourceName: 'Source' };
const fixtures: Fixture[] = [
  fixture('edit source video', { genMode: 'videoEdit' }, sources(video)),
  fixture('edit source upload video', { genMode: 'videoEdit' }, sources(uploadVideo)),
  fixture('edit first video wins', { genMode: 'videoEdit' }, { ...sources(uploadVideo, video), ...withModel({ referenceVideoMax: 2 }) }),
  fixture('edit images within cap', { genMode: 'videoEdit' }, sources(video, imageA, imageB)),
  fixture('edit audio source filename', { genMode: 'videoEdit' }, { ...sources(video, audio('music', { sourceFileName: 'music.mp3', displayName: 'Display' })), ...editModel }),
  fixture('edit audio display name', { genMode: 'videoEdit' }, { ...sources(video, audio('music', { displayName: 'Display' })), ...editModel }),
  fixture('edit audio fallback label', { genMode: 'videoEdit' }, { ...sources(video, audio('music')), ...editModel }),
  fixture('edit audio cap zero normalizes before action', { genMode: 'videoEdit' }, sources(video, audio('music')), { expected: { gen_mode: 'allReference' } }),
  fixture('edit model params review', { genMode: 'videoEdit', modelParams: { seed: 42 }, humanReview: true }, sources(video), { expected: { human_review: true, model_params: { seed: 42 } } }),
  fixture('edit no source video', { genMode: 'videoEdit' }, sources(source('empty-video', {}, CANVAS_NODE_TYPES.video)), { refusal: 'missing_source_video' }),
  fixture('edit audio node duration wins', { genMode: 'videoEdit' }, { ...sources(video, audio('music')), ...editModel, mediaDurationsMs: { '/static/music.mp3': 99999 } }),
  fixture('edit audio probe map', { genMode: 'videoEdit' }, { ...sources(video, audio('music', { durationMs: null })), ...editModel, mediaDurationsMs: { '/static/music.mp3': 4000 } }),
  fixture('edit audio probe failure', { genMode: 'videoEdit' }, { ...sources(video, audio('music', { durationMs: 0 })), ...editModel }),
  fixture('edit audio duration rejection', { genMode: 'videoEdit' }, { ...sources(video, audio('music', { durationMs: 1000 })), ...editModel }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'audio', kind: 'tooShort' } }),
  fixture('extend source video', { genMode: 'videoExtend' }, sources(video)),
  fixture('extend clamp params review', { genMode: 'videoExtend', durationSec: 99, modelParams: { seed: 7 }, humanReview: true }, sources(video), { expected: { duration_seconds: 15, human_review: true, model_params: { seed: 7 } } }),
  fixture('extend no source video', { genMode: 'videoExtend' }, sources(source('empty-video', {}, CANVAS_NODE_TYPES.video)), { refusal: 'missing_source_video' }),
  fixture('omni mixed edge order dependency ignored', { genMode: 'allReference' }, { ...sources(imageB, uploadVideo, audio('music'), imageA), edges: [
    { id: 'a', source: 'a', target: 'vid-1' }, { id: 'music', source: 'music', target: 'vid-1' },
    { id: 'dep', source: 'b', target: 'vid-1', data: { link_type: 'dependency_for' } },
    { id: 'v', source: 'upload-video', target: 'vid-1' },
  ] }),
  fixture('omni per type caps', { genMode: 'allReference' }, { ...sources(imageA, video, audio('music')), ...withModel({ referenceImageMax: 1, referenceVideoMax: 1, referenceAudioMax: 1 }) }),
  fixture('omni over type cap silent success', { genMode: 'allReference' }, { ...sources(imageA, imageB), ...withModel({ referenceImageMax: 1 }) }, { refusal: 'reference_limit_exceeded' }),
  fixture('omni legacy total cap twelve', { genMode: 'allReference' }, sources(...Array.from({ length: 9 }, (_, i) => source(`img-${i}`, { imageUrl: `/static/${i}.png` })), video, uploadVideo, audio('music'), audio('sound')), { expected: { references: expect.any(Array) } }),
  fixture('omni configured total cap sum exceeds twelve', { genMode: 'allReference' }, { ...sources(...Array.from({ length: 9 }, (_, i) => source(`img-${i}`, { imageUrl: `/static/${i}.png` })), video, uploadVideo, source('third-video', { videoUrl: '/static/third.mp4' }), audio('one'), audio('two'), audio('three')), ...withModel({ referenceImageMax: 9, referenceVideoMax: 3, referenceAudioMax: 3 }) }),
  fixture('omni reference order', { genMode: 'allReference', referenceOrder: ['music', 'video', 'a'] }, sources(imageA, video, audio('music'))),
  fixture('omni audio wire labels', { genMode: 'allReference' }, sources(audio('file', { sourceFileName: 'track.mp3', displayName: 'Display' }), audio('display', { displayName: 'Display' }), audio('fallback'))),
  fixture('omni file with name', { genMode: 'allReference', referenceFileUrl: ' /static/notes.pdf ', referenceFileName: 'notes.pdf' }, sources(imageA)),
  fixture('omni link', { genMode: 'allReference', referenceLink: ' https://example.test/story ' }, sources(imageA)),
  fixture('omni file link conflict blocks before priority', { genMode: 'allReference', referenceFileUrl: '/static/notes.pdf', referenceLink: 'https://example.test/story' }, sources(imageA), { refusal: 'model_capability_error' }),
  fixture('omni no references', { genMode: 'allReference' }, sources(source('empty-image', {})), { refusal: 'missing_references' }),
  fixture('omni unsupported model normalizes before action', { genMode: 'allReference' }, { ...sources(imageA), ...withModel({ supportedModes: ['text_to_video', 'image_reference'] }) }, { expected: { gen_mode: 'imageReference' } }),
  fixture('omni audio rejection first', { genMode: 'allReference' }, { ...sources(audio('short', { durationMs: 1000 }), video), ...durationModel }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'audio', kind: 'tooShort' } }),
  fixture('omni video duration rejection', { genMode: 'allReference' }, { ...sources(video), ...durationModel }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'video', kind: 'tooLong' } }),
  fixture('omni video duration probe', { genMode: 'allReference' }, { ...sources(source('probe-video', { videoUrl: '/static/probe.mp4', durationMs: -1 })), ...durationModel, mediaDurationsMs: { '/static/probe.mp4': 7000 } }),
  fixture('omni video probe failure skips total minimum', { genMode: 'allReference' }, { ...sources(source('probe-video', { videoUrl: '/static/probe.mp4' })), ...withModel({ referenceVideoTotalMinSeconds: 20 }) }),
  fixture('omni audio too long', { genMode: 'allReference' }, sources(audio('long', { durationMs: 16000 })), { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'audio', kind: 'tooLong' } }),
  fixture('omni audio total too long', { genMode: 'allReference' }, sources(audio('one', { durationMs: 8000 }), audio('two', { durationMs: 8000 })), { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'audio', kind: 'totalTooLong' } }),
  fixture('omni audio total too short', { genMode: 'allReference' }, { ...sources(audio('one')), ...withModel({ referenceAudioTotalMinSeconds: 5 }) }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'audio', kind: 'totalTooShort' } }),
  fixture('omni video too short', { genMode: 'allReference' }, { ...sources(video), ...withModel({ referenceVideoMinSeconds: 11 }) }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'video', kind: 'tooShort' } }),
  fixture('omni video total too short', { genMode: 'allReference' }, { ...sources(video), ...withModel({ referenceVideoTotalMinSeconds: 11 }) }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'video', kind: 'totalTooShort' } }),
  fixture('omni video total too long', { genMode: 'allReference' }, { ...sources(video, uploadVideo), ...withModel({ referenceVideoTotalMaxSeconds: 15 }) }, { refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'video', kind: 'totalTooLong' } }),
  fixture('omni configured audio limits override family', { genMode: 'allReference' }, { ...sources(audio('long', { durationMs: 20000 })), ...withModel({ referenceAudioMaxSeconds: 30, referenceAudioTotalMaxSeconds: 30 }) }),
  fixture('omni other model has no audio fallback', { genMode: 'allReference' }, { ...sources(audio('long', { durationMs: 20000 })), ...withModel({ apiModel: 'custom-video' }) }),
  fixture('omni source classification video before audio and image', { genMode: 'allReference' }, sources(audio('mixed', { videoUrl: '/static/mixed.mp4', imageUrl: '/static/mixed.png' }))),
  fixture('omni file only', { genMode: 'allReference', referenceFileUrl: '/static/notes.pdf', referenceFileName: 'notes.pdf' }),
  fixture('omni file unsupported silent success', { genMode: 'allReference', referenceFileUrl: '/static/notes.pdf' }, { ...sources(imageA), ...withModel({ referenceFileMax: 0 }) }, { refusal: 'model_capability_error' }),
  fixture('omni file type unsupported silent success', { genMode: 'allReference', referenceFileUrl: '/static/notes.pdf' }, { ...sources(imageA), ...withModel({ referenceFileTypes: ['txt'] }) }, { refusal: 'model_capability_error' }),
  fixture('omni link unsupported silent success', { genMode: 'allReference', referenceLink: 'https://example.test/story' }, { ...sources(imageA), ...withModel({ referenceLinkMax: 0 }) }, { refusal: 'model_capability_error' }),
  fixture('omni count three', { genMode: 'allReference', count: 3 }, sources(imageA), { requestCount: 3 }),
  fixture('extension full range timecodes', extension, sources(video), { expected: { continuation: true } }),
  fixture('extension partial known duration', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, { ...sources(video), ...durationModel }, { trim: { url: '/static/prepared.mp4', durationMs: 5000 } }),
  fixture('extension partial unknown duration', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, sources(source('unknown', { videoUrl: '/static/unknown.mp4' })), { trim: { url: '/static/prepared.mp4', durationMs: 5000 } }),
  fixture('extension probe duration does not determine trim', extension, { ...sources(source('unknown', { videoUrl: '/static/unknown.mp4' })), mediaDurationsMs: { '/static/unknown.mp4': 10000 } }, { trim: { url: '/static/prepared.mp4', durationMs: 10000 } }),
  fixture('extension reference order selects trim source', { ...extension, extendStartMs: 2000, extendEndMs: 7000, referenceOrder: ['upload-video', 'video'] }, sources(video, uploadVideo), { trim: { url: '/static/prepared.mp4', durationMs: 5000 } }),
  fixture('extension prefix satisfies prompt guard', { ...extension, prompt: '' }, sources(video)),
  fixture('extension default source name', { ...extension, extendSourceName: ' ' }, sources(video)),
  fixture('extension prepared duration validated', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, { ...sources(video), ...durationModel }, { trim: { url: '/static/prepared.mp4', durationMs: 9000 }, refusal: 'reference_duration_invalid', errorOutcome: true, rejection: { media: 'video', kind: 'tooLong' } }),
  fixture('upscale valid resolution bypasses model and busy', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4', upscaleResolution: '4k', isGenerating: true }, { videoModels: [] }, { expected: { resolution: '4k' } }),
  fixture('upscale invalid resolution fallback', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4', upscaleResolution: 'invalid' }, {}, { expected: { resolution: '1080p' } }),
  fixture('upscale strips query', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4?v=1?x=2' }, {}, { expected: { source_url: '/static/source.mp4' } }),
  fixture('upscale missing source published error', { isUpscaleNode: true }, {}, { refusal: 'missing_upscale_source', errorOutcome: true }),
  fixture('upscale missing project silent success', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4' }, { projectId: '' }, { refusal: 'no_project' }),
  fixture('upscale product attempt', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4' }, { productOperation: { projectId: 'p', operationId: 'op', generationAttemptId: 'attempt' } }, { expected: { product_operation_id: 'op', generation_attempt_id: 'attempt' } }),
  fixture('upscale product without attempt', { isUpscaleNode: true, upscaleSourceUrl: '/static/source.mp4' }, { productOperation: { projectId: 'p', operationId: 'op' } }),
  ...(['image', 'video', 'audio'] as const).map((kind) => fixture(`inline omni ${kind} browser forwards`, { genMode: 'allReference' }, sources(kind === 'audio' ? audio('inline', { audioUrl: 'data:audio/wav;base64,AA==' }) : source('inline', { [kind === 'image' ? 'imageUrl' : 'videoUrl']: `data:${kind}/x;base64,AA==` })), { refusal: 'inline_media_reference', browserForwardsInline: true })),
  ...(['image', 'video', 'audio'] as const).map((kind) => fixture(`inline edit ${kind} browser forwards`, { genMode: 'videoEdit' }, { ...sources(...(kind === 'video' ? [] : [video]), kind === 'audio' ? audio('inline', { audioUrl: 'data:audio/wav;base64,AA==' }) : source('inline', { [kind === 'image' ? 'imageUrl' : 'videoUrl']: `data:${kind}/x;base64,AA==` })), ...editModel }, { refusal: 'inline_media_reference', browserForwardsInline: true })),
  fixture('inline extend video browser forwards', { genMode: 'videoExtend' }, sources(source('inline', { videoUrl: 'data:video/mp4;base64,AA==' })), { refusal: 'inline_media_reference', browserForwardsInline: true }),
  fixture('inline file browser forwards', { genMode: 'allReference', referenceFileUrl: 'data:application/pdf;base64,AA==' }, sources(imageA), { refusal: 'inline_media_reference', browserForwardsInline: true }),
  fixture('inline link browser blocks', { genMode: 'allReference', referenceLink: 'data:text/plain,story' }, sources(imageA), { refusal: 'inline_media_reference' }),
  fixture('inline upscale browser forwards', { isUpscaleNode: true, upscaleSourceUrl: 'data:video/mp4;base64,AA==' }, {}, { refusal: 'inline_media_reference', browserForwardsInline: true }),
  fixture('inline prepared clip browser forwards', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, sources(video), { trim: { url: 'data:video/mp4;base64,AA==', durationMs: 5000 }, refusal: 'inline_media_reference', browserForwardsInline: true }),
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

describe('VideoNode media agent request wire parity', () => {
  it.each(fixtures)('$name', async (ctx) => {
    scope.project = ctx.projectId; scope.canvas = ctx.canvasId; scope.catalog = ctx.videoModels;
    scope.templates = [...(ctx.cameraTemplates ?? [])];
    getFreezoneVideoModelsSnapshot(ctx.projectId); prefetchFreezoneVideoCameraTemplates(ctx.projectId);
    await waitFor(() => expect(getFreezoneVideoModelsSnapshot(ctx.projectId).isLoading).toBe(false));
    const probeUrls: string[] = [];
    // Control the real probe at the media element boundary; timers remain real.
    vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLMediaElement, url: string) {
      probeUrls.push(url);
      const ms = ctx.mediaDurationsMs?.[url];
      Object.defineProperty(this, 'duration', { configurable: true, value: typeof ms === 'number' ? ms / 1000 : NaN });
      queueMicrotask(() => this.dispatchEvent(new Event(typeof ms === 'number' ? 'loadedmetadata' : 'error')));
    });
    vi.mocked(trimAndUploadExtendClip).mockResolvedValue(ctx.trim ?? { url: '/static/prepared.mp4', durationMs: 5000 });
    useCanvasStore.getState().setCanvasData(structuredClone(ctx.nodes), structuredClone(ctx.edges));
    if (ctx.productOperation) bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
    // Audio arrival can select omni on mount. Re-select the supported edit mode
    // as a user can, after that one-time transition and before taking the snapshot.
    if (ctx.nodes[0].data.genMode === 'videoEdit' && !ctx.name.includes('normalizes before action')) {
      act(() => useCanvasStore.getState().updateNodeData(ctx.nodeId, { genMode: 'videoEdit' }));
    }
    const state = useCanvasStore.getState();
    const settled = { ...ctx, nodes: structuredClone(state.nodes), edges: structuredClone(state.edges) };
    if (!ctx.name.includes('normalizes before action')) {
      expect(settled.nodes[0].data.genMode).toBe(ctx.nodes[0].data.genMode);
    }
    const requirement = videoExtendTrimRequirement(settled);
    const preparedExtendClip = ctx.trim && requirement ? { sourceUrl: requirement.videoUrl, startMs: requirement.startMs, endMs: requirement.endMs, ...ctx.trim } : undefined;
    const compileInput = videoPromptCompileInput(settled);
    const result = buildVideoGenerationRequest({ ...settled, preparedExtendClip, prompt: compileInput.fallbackPrompt });
    let outcome: { status: string; error?: unknown } | undefined;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => { if (event.requestId === ctx.name) outcome = event; });
    try {
      act(() => { dispatchNodeAction({ nodeId: ctx.nodeId, action: 'generate_video', executionMode: 'workflow', requestId: ctx.name }); });
      await waitFor(() => expect(outcome).toBeDefined());
      const call = vi.mocked(compileWorkflowNodePrompt).mock.calls[0]?.[0];
      if (call) {
        const { nodeId, nodeData, executionSource, onCompileMetadata, ...actualInput } = call;
        expect({ nodeId, executionSource }).toStrictEqual({ nodeId: ctx.nodeId, executionSource: 'workflow' });
        expect(nodeData).toBeDefined(); expect(onCompileMetadata).toBeTypeOf('function');
        expect(actualInput).toStrictEqual(compileInput);
      }
      if (ctx.trim) {
        expect(requirement).not.toBeNull();
        expect(trimAndUploadExtendClip).toHaveBeenCalledExactlyOnceWith({ projectId: ctx.projectId, videoUrl: requirement?.videoUrl, range: { startMs: requirement?.startMs, endMs: requirement?.endMs } });
      } else expect(trimAndUploadExtendClip).not.toHaveBeenCalled();
      if (ctx.refusal) {
        expect(result).toMatchObject({ ok: false, code: ctx.refusal });
        if (ctx.rejection) expect(result).toMatchObject({ media: ctx.rejection.media, rejection: { kind: ctx.rejection.kind } });
        if (ctx.browserForwardsInline) {
          expect(wireRequests()).toHaveLength(1);
          expect(JSON.stringify(wireRequests()[0].body)).toContain('data:');
        }
        else expect(wireRequests()).toStrictEqual([]);
        expect(outcome?.status).toBe(ctx.errorOutcome ? 'error' : 'success');
        if (ctx.rejection) expect(outcome?.error).toBe(i18next.t('referenceValidation.title'));
        if (ctx.refusal === 'missing_upscale_source' && !result.ok) expect(outcome?.error).toBe(result.message);
      } else {
        expect(outcome?.status).toBe('success');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(wireRequests()).toStrictEqual(result.requests);
        expect(result.requests).toHaveLength(ctx.requestCount ?? 1);
        expect(result.requests[0].body).toMatchObject(ctx.expected ?? {});
        if (ctx.name === 'omni legacy total cap twelve') expect(result.requests[0].body.references).toHaveLength(12);
        if (ctx.name === 'omni configured total cap sum exceeds twelve') expect(result.requests[0].body.references).toHaveLength(15);
        if (!settled.nodes[0].data.isUpscaleNode) expect(call).toBeDefined();
      }
      if (ctx.name === 'edit audio probe map' || ctx.name === 'edit audio probe failure') expect(probeUrls).toContain('/static/music.mp3');
      if (ctx.name === 'edit audio node duration wins') expect(probeUrls).not.toContain('/static/music.mp3');
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { unsubscribe(); queryClient.clear(); }
  });
});

describe('pure media preparation boundaries', () => {
  const partial = () => fixture('pure partial', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, sources(video));
  it('trim clip missing', () => expect(buildVideoGenerationRequest({ ...partial(), prompt: 'Continue' })).toMatchObject({ ok: false, code: 'extend_clip_not_prepared' }));
  it.each([
    { sourceUrl: '/static/other.mp4' }, { startMs: 1000 }, { endMs: 8000 },
  ])('trim clip mismatch %j', (override) => {
    expect(buildVideoGenerationRequest({ ...partial(), prompt: 'Continue', preparedExtendClip: { sourceUrl: '/static/source.mp4', startMs: 2000, endMs: 7000, url: '/static/prepared.mp4', durationMs: 5000, ...override } })).toMatchObject({ ok: false, code: 'extend_clip_not_prepared' });
  });
  it('unsupported omni boundary', () => {
    const ctx = fixture('unsupported', { genMode: 'allReference' }, { ...sources(imageA), ...withModel({ supportedModes: ['text_to_video', 'image_reference'] }) });
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'mode_unsupported_by_model' });
  });
  it('edit zero audio cap guard', () => {
    const ctx = fixture('pure zero audio', { genMode: 'videoEdit' }, sources(video, audio('music')));
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'reference_limit_exceeded' });
  });
  it('extension requires translator', () => expect(() => videoPromptCompileInput({ ...partial(), translate: undefined })).toThrow(/translat/i));
  it('inputs not mutated and request bodies independent', () => {
    const ctx = fixture('pure count', { genMode: 'allReference', count: 3 }, sources(imageA, video, audio('music')));
    const before = structuredClone({ ...ctx, translate: undefined });
    videoPromptCompileInput(ctx);
    const result = buildVideoGenerationRequest({ ...ctx, prompt: 'Test' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.requests[0].body).not.toBe(result.requests[1].body);
    expect(result.requests[0].body.references).not.toBe(result.requests[1].body.references);
    result.requests[0].body.prompt = 'Changed';
    expect(result.requests[1].body.prompt).toBe('Test');
    expect({ ...ctx, translate: undefined }).toStrictEqual(before);
  });
});
