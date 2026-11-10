// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiClient } from '@/api/client';
import { fetchFreezoneJobResult } from '@/api/ops';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { TaskCompletionError } from '@/features/canvas/domain/taskCompletionError';
import { subscribeOpenGlobalErrorDialog, type GlobalErrorDialogDetail } from '@/features/app/errorDialogEvents';
import { toast } from 'sonner';
import { buildVideoGenerationRequest, type VideoGenerationRequestContext, type VideoGenerationRequestResult } from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import {
  videoGenerationStartPatch, videoGenerationSubmitPatch, videoGenerationAcceptedPatch,
  videoGenerationRefusalOutcome, videoGenerationFailurePatch, videoGenerationRunOutcome,
  videoGenerationSettleOutcome, videoGenerationActionResult, videoUpscaleStartPatch,
  videoUpscaleAcceptedPatch, videoUpscaleOutcomePatch, videoUpscaleActionResult,
  type VideoGenerationRunError, type VideoGenerationNotice,
} from '@/features/canvas/application/generationRequests/videoGenerationResult';
import { describeGenerationError, describeGenerationSubmitFailure, generationErrorFromSubmitFailure, type GenerationSubmitFailure } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { CANVAS_NODE_TYPES, isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneVideoModelsSnapshot } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { prefetchFreezoneVideoCameraTemplates } from '@/features/canvas/hooks/useFreezoneVideoCameraTemplates';
import { VideoNode } from '@/features/canvas/nodes/VideoNode';
import { useCanvasStore } from '@/stores/canvasStore';

const scope = vi.hoisted(() => ({
  project: '', canvas: 'canvas-7', catalog: [] as ModelOption[],
  templates: [] as NonNullable<VideoGenerationRequestContext['cameraTemplates']>[number][],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : fallback ? `${key}:${JSON.stringify(fallback)}` : key,
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
  apiCall: vi.fn(),
}));
vi.mock('@/api/ops', async (original) => ({
  ...(await original<typeof import('@/api/ops')>()),
  fetchFreezoneVideoModels: vi.fn(async () => scope.catalog),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => scope.templates),
  fetchNodeGenerationHistory: vi.fn(async () => []),
  fetchFreezoneJobResult: vi.fn(),
}));
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(async (input) => input.fallbackPrompt),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/**
 * Same lowest-layer harness as request parity:
 * react-i18next: deterministic display text; url-params: fixture project/canvas;
 * credit-cost and model-task-access: allow submission without unrelated queries;
 * api/client: accept/reject each actual submit, retaining request serialization;
 * ops: catalog/templates/history offline and controlled job-result fallback;
 * tasks: deferred completion per key, retaining real terminal/timeout classes;
 * workflowRecipeRuntime: deterministic compile or compile rejection;
 * sonner: record imported toast calls. Dialogs use the real window event path.
 * fetch throws, media.load/ResizeObserver supply jsdom's missing platform support.
 */
const t = (key: string, options?: Record<string, unknown>) => options
  ? `${key}:${JSON.stringify(options)}` : key;
const startedAt = 1234567890000;
const catalog: ModelOption[] = [{ id: 'video-model', catalogId: 'catalog-video',
  providerId: 'seedance', apiModel: 'seedance-2.0', label: 'Video', humanReview: true }];
function deferred<T = Awaited<ReturnType<typeof awaitTaskCompletion>>>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ref(index: number) { return { task_key: `task-${index}`, task_type: 'freezone_video_gen', job_id: `job-${index}` }; }
function source(id: string, data: Record<string, unknown>, type: CanvasNode['type'] = CANVAS_NODE_TYPES.upload): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}
function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return source('vid-1', { prompt: 'A cat jumps', model: 'video-model', genMode: 'textToVideo',
    aspectRatio: '16:9', quality: '720p', durationSec: 5, count: 1, generateAudio: false,
    isGenerating: false, videoUrl: '/static/previous.mp4', generationBatch: ['old'],
    generationError: null, generationErrorDetails: 'old details', generationErrorRequestId: 'old-id',
    sourceFileName: 'previous.mp4', ...data }, CANVAS_NODE_TYPES.video);
}
function TargetNode() {
  const node = useCanvasStore((state) => state.nodes.find((candidate) => candidate.id === 'vid-1'));
  if (!isVideoNode(node)) throw new Error('Missing video node');
  return <VideoNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
type Run = { kind: 'completed'; result: Record<string, unknown>; fallback?: string | 'throws' }
  | { kind: 'failed'; message: string } | { kind: 'cancelled' } | { kind: 'poll_timeout' }
  | { kind: 'submit_failed'; failure: GenerationSubmitFailure };
type Refusal = Extract<VideoGenerationRequestResult, { ok: false }>;
type Fixture = { name: string; runs?: Run[]; order?: number[]; data?: Record<string, unknown>;
  models?: ModelOption[]; sources?: CanvasNode[]; lastSlot?: boolean; noProject?: boolean;
  compileFailure?: boolean; refusal?: Refusal['code']; phase?: 'guard' | 'keyframes' | 'images' | 'duration' | 'references';
  executionMode?: 'single' | 'workflow'; upscale?: boolean };
const done = (result: Record<string, unknown>, fallback?: string | 'throws'): Run => ({ kind: 'completed', result, fallback });
const failed = (message: string): Run => ({ kind: 'failed', message });
const timeout: Run = { kind: 'poll_timeout' };
const cancelled: Run = { kind: 'cancelled' };
const face = 'InputImageSensitiveContentDetected.PrivateInformation';
const image = source('image', { imageUrl: '/static/ref.png' });
const image2 = source('image2', { imageUrl: '/static/ref2.png' });
const submitFailure = (status: number, body: unknown): Run => ({ kind: 'submit_failed', failure: {
  kind: 'http', status, statusText: 'Rejected', method: 'POST', url: 'https://canvas.example.test/api/video', body,
} });
const referenceFailure = submitFailure(422, { detail: { code: 'REFERENCE_MEDIA_INVALID', errors: [
  { media: 'image', index: 1, name: 'Reference', reference_key: 'ref.png', code: 'missing' },
] } });
const fixtures: Fixture[] = [
  { name: 'single success output_url', runs: [done({ output_url: '/a.mp4' })] },
  { name: 'success video_url wins over output_url', runs: [done({ video_url: '/v.mp4', output_url: '/other.mp4' })] },
  { name: 'success url key', runs: [done({ url: '/u.mp4' })] },
  { name: 'job-result fallback', runs: [done({}, '/fallback.mp4')] },
  { name: 'fallback fetch fails', runs: [done({}, 'throws')] },
  { name: 'completed without URL run 0', runs: [done({})] },
  { name: 'completed without URL run 1', runs: [done({ output_url: '/a.mp4' }), done({})], order: [1, 0] },
  { name: 'run 0 no URL after sibling success', runs: [done({}), done({ url: '/b.mp4' })], order: [1, 0] },
  { name: 'three completion order 2,0,1', runs: [done({ url: '/0' }), done({ url: '/1' }), done({ url: '/2' })], order: [2, 0, 1] },
  { name: 'three completion order 0,1,2', runs: [done({ url: '/0' }), done({ url: '/1' }), done({ url: '/2' })], order: [0, 1, 2] },
  { name: 'duplicate URLs retained', runs: [done({ url: '/same' }), done({ url: '/same' })] },
  { name: 'failure after success partial toast', runs: [done({ url: '/a' }), failed('late failure')] },
  { name: 'failure before success banner cleared', runs: [done({ url: '/a' }), failed('early failure')], order: [1, 0] },
  { name: 'all fail first error by push order', runs: [failed('run zero'), failed('run one')], order: [1, 0] },
  { name: 'face blocked without human review', data: { genMode: 'imageReference', humanReview: false }, sources: [image], runs: [failed(face)] },
  { name: 'face blocked with human review', data: { genMode: 'imageReference', humanReview: true }, sources: [image], runs: [failed(face)] },
  { name: 'face blocked model without review', models: [{ ...catalog[0], humanReview: false }], runs: [failed(face)] },
  { name: 'reference invalid first error', runs: [referenceFailure, failed('second failure')] },
  { name: 'reference invalid later error ordinary dialog', runs: [failed('first failure'), referenceFailure] },
  { name: 'all runs poll timeout previous URL published', runs: [timeout, timeout] },
  { name: 'poll timeout then failure', runs: [timeout, failed('failure')] },
  { name: 'failure then poll timeout', runs: [failed('failure'), timeout] },
  { name: 'timeout after success partial toast', runs: [done({ url: '/a' }), timeout] },
  { name: 'cancelled run 0 alone', runs: [cancelled] },
  { name: 'cancelled run 0 before success', runs: [cancelled, done({ url: '/b' })] },
  { name: 'cancelled run 0 after success', runs: [cancelled, done({ url: '/b' })], order: [1, 0] },
  { name: 'cancelled run 1', runs: [done({ url: '/a' }), cancelled], order: [1, 0] },
  { name: 'submit insufficient credits', runs: [submitFailure(402, { error: 'Balance too low' })] },
  { name: 'submit billing rule', runs: [submitFailure(400, { error: 'No billing rule', data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' } })] },
  { name: 'submit queue limit', runs: [submitFailure(429, { error: 'Queue rejected', data: { queue_kind: 'video' } })] },
  { name: 'compile failure preserves album', compileFailure: true },
  { name: 'empty result URL falls back', runs: [done({ output_url: '' }, '/fallback')] },
  { name: 'nonstring result URLs ignored', runs: [done({ video_url: 7, output_url: false, url: null }, '/fallback')] },
  { name: 'whitespace result URL preserved', runs: [done({ output_url: ' ' })] },
  { name: 'no URL run zero then success', runs: [done({}), done({ url: '/b' })] },
  { name: 'all completed without URLs', runs: [done({}), done({})], order: [1, 0] },
  { name: 'execution single', executionMode: 'single', runs: [done({ url: '/single' })] },
  { name: 'no model refusal', models: [], refusal: 'no_model' },
  { name: 'unsupported omni guard refusal', data: { genMode: 'allReference' }, sources: [image], models: [{ ...catalog[0], apiModel: 'custom-video' }], refusal: 'mode_unsupported_by_model' },
  { name: 'missing omni references guard refusal', data: { genMode: 'allReference' }, sources: [source('empty', {})], refusal: 'missing_references' },
  { name: 'silent refusal retains previous error', data: { prompt: ' ', generationError: 'previous error' }, refusal: 'no_effective_prompt' },
  { name: 'generation in progress refusal', data: { isGenerating: true, generationJobId: 'running' }, refusal: 'generation_in_progress' },
  { name: 'no effective prompt refusal', data: { prompt: ' ' }, refusal: 'no_effective_prompt' },
  { name: 'no project refusal', noProject: true, refusal: 'no_project' },
  { name: 'missing media guard refusal', data: { genMode: 'firstFrame' }, sources: [source('empty', {})], refusal: 'missing_media', phase: 'guard' },
  { name: 'missing keyframe after start refusal', data: { genMode: 'firstFrame' }, sources: [image], lastSlot: true, refusal: 'missing_media', phase: 'keyframes' },
  { name: 'preview without source refusal', data: { genMode: 'imageReference' }, sources: [source('preview', { previewImageUrl: '/preview.png' })], refusal: 'missing_media', phase: 'images' },
  { name: 'reference limit refusal', data: { genMode: 'imageReference' }, sources: [image, image2], models: [{ ...catalog[0], referenceImageMax: 1 }], refusal: 'reference_limit_exceeded' },
  { name: 'model capability refusal', data: { genMode: 'imageReference' }, sources: [image, image2], models: [{ ...catalog[0], apiModel: 'seedance-1.5-pro' }], refusal: 'model_capability_error' },
  { name: 'inline preview missing keyframe', data: { genMode: 'firstFrame' }, sources: [source('inline', { previewImageUrl: 'data:image/png;base64,AA==' })], refusal: 'inline_media_reference', phase: 'keyframes' },
  { name: 'inline preview refusal', data: { genMode: 'imageReference' }, sources: [source('inline', { previewImageUrl: 'data:image/png;base64,AA==' })], refusal: 'inline_media_reference', phase: 'images' },
  { name: 'missing edit source refusal', data: { genMode: 'videoEdit' }, sources: [source('empty', {}, CANVAS_NODE_TYPES.video)], refusal: 'missing_source_video' },
  { name: 'missing extend source refusal', data: { genMode: 'videoExtend' }, sources: [source('empty', {}, CANVAS_NODE_TYPES.video)], refusal: 'missing_source_video' },
  { name: 'missing omni references after start', data: { genMode: 'allReference', referenceFileUrl: ' ' }, sources: [source('empty', {})], refusal: 'missing_references', phase: 'references' },
  { name: 'document file unsupported guard', data: { genMode: 'allReference', referenceFileUrl: '/notes.pdf' }, sources: [image], refusal: 'model_capability_error' },
  { name: 'document link unsupported guard', data: { genMode: 'allReference', referenceLink: 'https://example.test/story' }, sources: [image], refusal: 'model_capability_error' },
  { name: 'document file link conflict guard', data: { genMode: 'allReference', referenceFileUrl: '/notes.pdf', referenceLink: 'https://example.test/story' }, sources: [image], refusal: 'model_capability_error' },
  { name: 'document file type unsupported guard', data: { genMode: 'allReference', referenceFileUrl: '/notes.pdf' }, sources: [image], models: [{ ...catalog[0], referenceFileMax: 1, referenceFileTypes: ['txt'] }], refusal: 'model_capability_error' },
  { name: 'inline link blocked guard', data: { genMode: 'allReference', referenceLink: 'data:text/plain,story' }, sources: [image], models: [{ ...catalog[0], referenceLinkMax: 1 }], refusal: 'inline_media_reference' },
  { name: 'reference duration invalid', data: { genMode: 'allReference' }, sources: [source('music', { audioUrl: '/music.mp3', durationMs: 1000 }, CANVAS_NODE_TYPES.audio)], refusal: 'reference_duration_invalid', phase: 'duration' },
  ...[
    { name: 'upscale output_url', runs: [done({ output_url: '/hd.mp4' })] },
    { name: 'upscale fallback ignores video_url', runs: [done({ video_url: '/ignored' }, '/fallback-hd.mp4')] },
    { name: 'upscale fallback empty URL', runs: [done({})] },
    { name: 'upscale submit insufficient credits raw message', runs: [submitFailure(402, { error: 'Raw balance message' })] },
    { name: 'upscale failure publishes success', runs: [failed('raw upscale failure')] },
    { name: 'upscale fallback throws', runs: [done({}, 'throws')] },
    { name: 'upscale poll timeout', runs: [timeout] },
    { name: 'upscale no source', data: { upscaleSourceUrl: '' }, refusal: 'missing_upscale_source' as const },
    { name: 'upscale no project', noProject: true, refusal: 'no_project' as const },
    { name: 'upscale single execution', executionMode: 'single' as const, runs: [done({ output_url: '/single-hd' })] },
  ].map((item) => ({ ...item, upscale: true })),
];
const originalUpdate = useCanvasStore.getState().updateNodeData;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(startedAt);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => input.fallbackPrompt);
});
afterEach(() => { cleanup(); useCanvasStore.setState({ updateNodeData: originalUpdate }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function errorFor(run: Run, index: number): Error {
  if (run.kind === 'submit_failed') return generationErrorFromSubmitFailure(run.failure);
  if (run.kind === 'poll_timeout') return new TaskPollTimeoutError(ref(index).task_key, 100);
  return new TaskCompletionError(run.kind === 'failed' ? run.message : 'Cancelled',
    run.kind === 'cancelled' ? 'cancelled' : 'failed', ref(index).task_key);
}
function expectedDialog(notice: VideoGenerationNotice): GlobalErrorDialogDetail[] {
  if (!notice) return [];
  if (notice.kind === 'error_dialog') return [{ message: notice.message.trim(), title: notice.title,
    details: notice.details?.trim() || undefined, copyText: undefined, variant: 'error' }];
  if (notice.kind === 'still_running') return [{ title: t('errorDialog.stillRunningTitle'),
    message: t('errorDialog.stillRunningMessage'), details: undefined, variant: 'pending' }];
  return [];
}

describe('video result patches against generate_video subscriber', () => {
  it.each(fixtures)('$name', async (fixture) => {
    scope.project = fixture.noProject ? '' : `result-parity/${fixture.name}`;
    scope.catalog = fixture.models ?? catalog; scope.templates = [];
    getFreezoneVideoModelsSnapshot(scope.project); prefetchFreezoneVideoCameraTemplates(scope.project);
    await waitFor(() => expect(getFreezoneVideoModelsSnapshot(scope.project).isLoading).toBe(false));
    const target = videoNode({ ...(fixture.upscale ? { isUpscaleNode: true, upscaleSourceUrl: '/source.mp4' } : {}),
      count: fixture.runs?.length ?? 1, ...fixture.data });
    const sources = fixture.sources ?? [];
    useCanvasStore.getState().setCanvasData([target, ...structuredClone(sources)], sources.map((node) => ({
      id: node.id, source: node.id, target: 'vid-1', ...(fixture.lastSlot ? { data: { keyframeSlot: 'last' } } : {}),
    })));
    const patches: Record<string, unknown>[] = [];
    const writes: Record<string, unknown>[] = [];
    useCanvasStore.setState({ updateNodeData: (id, patch) => { if (id === 'vid-1') writes.push(structuredClone(patch)); originalUpdate(id, patch); } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
    const state = useCanvasStore.getState();
    const initial = structuredClone(state.nodes.find((node) => node.id === 'vid-1')!.data);
    writes.length = 0;
    const dialogs: GlobalErrorDialogDetail[] = [];
    const stopDialogs = subscribeOpenGlobalErrorDialog((detail) => dialogs.push(detail));
    let published: { status: string; output?: Record<string, unknown>; error?: string } | undefined;
    const stopResult = canvasEventBus.subscribe('freezone/node-action-result', ({ status, output, error }) => {
      published = status === 'error' ? { status, error } : { status, output };
    });
    const runs = fixture.runs ?? [];
    const waits = runs.map(() => deferred());
    const submits = runs.map(() => deferred<ReturnType<typeof ref>>());
    let submitIndex = 0;
    vi.mocked(apiCall).mockImplementation(async () => {
      const index = submitIndex++;
      const run = runs[index];
      if (run?.kind === 'submit_failed') return submits[index].promise;
      return ref(index);
    });
    vi.mocked(awaitTaskCompletion).mockImplementation((key) => waits[Number(key.split('-')[1])].promise);
    vi.mocked(fetchFreezoneJobResult).mockImplementation(async (_project, _type, job) => {
      const run = runs[Number(job.split('-')[1])];
      if (run?.kind === 'completed' && run.fallback === 'throws') throw new Error('fallback failed');
      return { url: run?.kind === 'completed' ? run.fallback ?? '' : '', size: 0 };
    });
    if (fixture.compileFailure) vi.mocked(compileWorkflowNodePrompt).mockRejectedValue(new Error('compile failed'));
    let notice: VideoGenerationNotice = null;
    try {
      act(() => { dispatchNodeAction({ nodeId: 'vid-1', action: 'generate_video', requestId: fixture.name,
        executionMode: fixture.executionMode ?? 'workflow' }); });
      if (fixture.refusal) {
        const refusal = buildVideoGenerationRequest({ nodes: state.nodes, edges: state.edges, nodeId: 'vid-1',
          projectId: scope.project, canvasId: scope.canvas, videoModels: scope.catalog, cameraTemplates: null,
          executionSource: 'workflow', productOperation: null, prompt: 'Compiled', translate: t });
        expect(refusal).toMatchObject({ ok: false, code: fixture.refusal });
        if (refusal.ok) throw new Error('Expected refusal');
        const result = refusal.code === 'reference_duration_invalid'
          ? (() => {
            if (!refusal.media || !refusal.rejection) throw new Error('Missing duration refusal data');
            return videoGenerationRefusalOutcome({ ...refusal, code: 'reference_duration_invalid',
              media: refusal.media, rejection: refusal.rejection, phase: 'duration', startedAtMs: startedAt,
              durationLimits: { minMs: 1800, maxMs: 15200 } }, t);
          })()
          : videoGenerationRefusalOutcome({ ...refusal, code: refusal.code,
            phase: fixture.phase === 'duration' ? 'guard' : fixture.phase ?? 'guard', startedAtMs: startedAt }, t);
        patches.push(...result.patches); notice = result.notice;
      } else if (fixture.compileFailure) {
        patches.push(videoGenerationStartPatch(startedAt), videoGenerationFailurePatch(describeGenerationError(new Error('compile failed'), t, t('node.videoNode.generation.failed'))));
      } else {
        patches.push(fixture.upscale ? videoUpscaleStartPatch(startedAt) : videoGenerationStartPatch(startedAt));
        if (!fixture.upscale) patches.push(videoGenerationSubmitPatch());
        await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(runs.length));
        await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(runs.filter((run) => run.kind !== 'submit_failed').length));
        expect(published).toBeUndefined();
        if (runs[0]?.kind !== 'submit_failed') patches.push(fixture.upscale ? videoUpscaleAcceptedPatch(ref(0)) : videoGenerationAcceptedPatch(ref(0)));
        let completedUrls: string[] = [];
        const runErrors: VideoGenerationRunError[] = [];
        for (const index of fixture.order ?? runs.map((_, index) => index)) {
          const run = runs[index];
          await act(async () => {
            if (run.kind === 'submit_failed') { submits[index].reject(errorFor(run, index)); return; }
            if (run.kind === 'completed') waits[index].resolve({ ...ref(index), username: 'test', project: scope.project, episode: 0, status: 'completed', result: run.result });
            else waits[index].reject(errorFor(run, index));
          });
          if (fixture.upscale) {
            const outcome = run.kind === 'completed'
              ? run.fallback === 'throws' ? { kind: 'failed' as const, message: 'fallback failed' }
                : { kind: 'completed' as const, result: run.result, fallbackUrl: run.fallback ?? '' }
              : run.kind === 'poll_timeout' ? { kind: 'poll_timeout' as const }
                : { kind: 'failed' as const, message: errorFor(run, index).message };
            const patch = videoUpscaleOutcomePatch(outcome);
            if (patch) patches.push(patch);
            if (run.kind === 'poll_timeout') {
              // Upscale calls notifyTaskStillRunning without the component translator.
              notice = { kind: 'still_running' };
            }
          } else {
            const outcome = run.kind === 'completed'
              ? { kind: 'completed' as const, result: run.result, fallbackUrl: run.fallback === 'throws' ? null : run.fallback ?? null }
              : run.kind === 'cancelled' || run.kind === 'poll_timeout' ? run
                : { kind: 'failed' as const, error: run.kind === 'submit_failed'
                  ? describeGenerationSubmitFailure(run.failure, t, t('node.videoNode.generation.failed'))
                  : describeGenerationError(errorFor(run, index), t, t('node.videoNode.generation.failed')) };
            const result = videoGenerationRunOutcome({ runIndex: index, total: runs.length, completedUrls, outcome }, t);
            completedUrls = result.completedUrls;
            if (result.patch) patches.push(result.patch);
            if (result.runError) runErrors.push(result.runError);
          }
        }
        if (!fixture.upscale) {
          const result = videoGenerationSettleOutcome({ completedUrls, runErrors, total: runs.length,
            supportsHumanReview: initial.genMode !== 'textToVideo' && scope.catalog[0]?.humanReview === true,
            humanReview: initial.humanReview === true }, t);
          if (result.patch) patches.push(result.patch);
          notice = result.notice;
        }
      }
      await waitFor(() => expect(published).toBeDefined());
      const expected = Object.assign({}, initial, ...patches);
      expect(useCanvasStore.getState().nodes.find((node) => node.id === 'vid-1')?.data).toStrictEqual(expected);
      expect(writes).toStrictEqual(patches);
      expect(published).toStrictEqual(fixture.upscale
        ? videoUpscaleActionResult(expected, fixture.executionMode ?? 'workflow')
        : videoGenerationActionResult(expected, fixture.executionMode ?? 'workflow'));
      if (fixture.upscale && notice?.kind === 'still_running') {
        expect(dialogs).toStrictEqual([{ title: 'Still generating', message: 'This generation is taking longer than expected. The page has stopped waiting, but the task is still running in the background. Refresh later or check the task centre for progress.', details: undefined, variant: 'pending' }]);
      } else expect(dialogs).toStrictEqual(expectedDialog(notice));
      expect(vi.mocked(toast.error).mock.calls).toStrictEqual(notice?.kind === 'partial_failure'
        ? [[t('node.videoNode.partialBatchFailed', { ok: notice.ok, total: notice.total })]] : []);
      expect(toast.warning).not.toHaveBeenCalled();
      if (notice?.kind === 'reference_issues') {
        expect(document.body.textContent).toContain(t('referenceValidation.title'));
        expect([...document.querySelectorAll('[role=dialog] li .break-all')].map((node) => node.textContent))
          .toStrictEqual(notice.issues.map((issue) => issue.name));
        const display = (value: unknown) => Array.isArray(value) ? value.join(', ') : String(value ?? '—');
        expect([...document.querySelectorAll('[role=dialog] li p')].map((node) => node.textContent))
          .toStrictEqual(notice.issues.map((issue) => t(`referenceValidation.${issue.code}`, { actual: display(issue.actual), expected: display(issue.expected) })));
      }
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { stopResult(); stopDialogs(); queryClient.clear(); }
  });
});

describe('pure result boundaries without a browser submission counterpart', () => {
  it.each(['not_video_node', 'extend_clip_not_prepared', 'inline_media_reference'] as const)('%s creates no synthetic writes', (code) => {
    expect(videoGenerationRefusalOutcome({ ok: false, code, message: 'Boundary refusal', startedAtMs: startedAt }, t))
      .toStrictEqual({ patches: [], notice: null });
  });
  it('missing node action result', () => {
    expect(videoGenerationActionResult(undefined, 'workflow')).toStrictEqual({ status: 'success', output: {} });
  });
  it('nonstring URL omitted and empty error ignored', () => {
    expect(videoGenerationActionResult({ videoUrl: 12, generationError: '' }, 'single'))
      .toStrictEqual({ status: 'success', output: { submitted: true } });
  });
  it('run and settle do not mutate caller arrays or errors', () => {
    const input = { runIndex: 1, total: 2, completedUrls: ['/a'], outcome: { kind: 'completed' as const, result: { url: '/a' }, fallbackUrl: null } };
    const before = structuredClone(input);
    const result = videoGenerationRunOutcome(input, t);
    expect(input).toStrictEqual(before);
    expect(result.completedUrls).toStrictEqual(['/a', '/a']);
    const settle = { completedUrls: result.completedUrls, runErrors: [{ kind: 'failed' as const, error: describeGenerationError(new Error('failed'), t, 'fallback') }], total: 2, supportsHumanReview: false, humanReview: false };
    const prior = structuredClone(settle);
    videoGenerationSettleOutcome(settle, t);
    expect(settle).toStrictEqual(prior);
  });
});
