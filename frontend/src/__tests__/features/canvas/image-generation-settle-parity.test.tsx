// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ImageGenNode } from '@/features/canvas/nodes/ImageGenNode';
import { isImageGenNode } from '@/features/canvas/domain/canvasNodes';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { useAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { apiCall } from '@/api/client';
import { fetchFreezoneImageModels, fetchFreezoneJobResult } from '@/api/ops';
import { awaitTaskCompletion, TaskCompletionError } from '@/api/tasks';
import * as patches from '@/features/canvas/application/generationRequests';
import type { ImageGenerationOutcome, ImageGenerationEffect } from '@/features/canvas/application/generationRequests';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { errorFromBackendBody } from '@/lib/api-errors';
import { useCanvasStore } from '@/stores/canvasStore';

const mocks = vi.hoisted(() => ({
  projectId: '', sequence: 0,
  t: (key: string) => `translated:${key}`,
  effects: [] as ImageGenerationEffect[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }) }));
vi.mock('@/lib/queries/generation-credit-cost', async (original) => ({
  ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
vi.mock('@/lib/url-params', async (original) => ({
  ...(await original<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: mocks.projectId, canvas: 'canvas-7' }),
}));
vi.mock('@/lib/model-task-access', async (original) => ({
  ...(await original<typeof import('@/lib/model-task-access')>()),
  useModelTaskAccess: () => ({ blocked: false, message: null, denialReason: null }),
}));
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()), apiCall: vi.fn(),
}));
vi.mock('@/api/ops', async (original) => ({
  ...(await original<typeof import('@/api/ops')>()),
  fetchFreezoneImageModels: vi.fn(async () => catalog),
  listFreezoneStyleTemplates: vi.fn(async () => ({ templates: [], assetBase: '' })),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  fetchFreezoneJobResult: vi.fn(),
  fetchNodeGenerationHistory: vi.fn(async () => []),
}));
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn(),
}));
vi.mock('@/features/canvas/application/workflowRecipeRuntime', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/workflowRecipeRuntime')>()),
  compileWorkflowNodePrompt: vi.fn(),
}));
vi.mock('@/features/canvas/application/videoContinuity', async (original) => ({
  ...(await original<typeof import('@/features/canvas/application/videoContinuity')>()),
  attachCompletedStoryFrame: vi.fn((nodeId: string) => {
    mocks.effects.push({ kind: 'attach_story_frame', nodeId });
    return null;
  }),
  attachCompletedStoryAsset: vi.fn((nodeId: string) => {
    mocks.effects.push({ kind: 'attach_story_asset', nodeId });
    return null;
  }),
}));
const catalog: ModelOption[] = [{
  id: 'openai/test-image', providerId: 'openai', apiModel: 'test-image-api', label: 'Test image',
}];
const startedAt = Date.parse('2026-11-11T04:05:06Z');
function ref(index = 0) {
  return { task_key: `task-${index}`, task_type: 'freezone_gen' as const, job_id: `job-${index}` };
}
function completedTask(index: number, result: Record<string, unknown> | null) {
  return { ...ref(index), username: '', project: mocks.projectId, episode: 0, status: 'completed' as const, result };
}
function imageNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'img-1', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
    data: {
      displayName: 'Image', prompt: 'A cat', model: catalog[0].id, aspectRatio: '16:9',
      size: '2K', count: 1, imageUrl: null, previewImageUrl: null,
      isGenerating: false, generationStartedAt: null,
      isSizeManuallyAdjusted: false, requestAspectRatio: 'auto', styleTemplateId: null,
      focusRegion: null, cameraSelection: null, referenceImageUrl: null, marks: [],
      generationDurationMs: 60000, ...data,
    },
  };
}
function stored() { return useCanvasStore.getState().nodes[0].data; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(name: string, data: Record<string, unknown>) {
  mocks.projectId = `settle-parity/${name}`;
  const initial = imageNode(data).data;
  useCanvasStore.getState().setCanvasData([imageNode(data)], []);
  const hook = renderHook(() => useImageGenerationForm('img-1'));
  await waitFor(() => {
    expect(fetchFreezoneImageModels).toHaveBeenCalledWith(mocks.projectId);
    expect(getFreezoneImageModelsSnapshot(mocks.projectId).isLoading).toBe(false);
    expect(hook.result.current.submitDisabled).toBe(false);
  });
  return { ...hook, initial };
}
/**
 * Same lowest-layer mocks as result parity: react-i18next (stable text),
 * generation-credit-cost (no quote request), url-params (fixture URL),
 * api/client.apiCall (acceptance through real ops serialization), api/ops catalog,
 * styles, cameras, history and fallback result (external data), api/tasks waiter
 * (controlled completion order), workflowRecipeRuntime compiler (stable prompt),
 * videoContinuity attachment calls (record effects). Additional boundary:
 * model-task-access (no access query for the real node). Date fixes start time;
 * ResizeObserver supports jsdom; fetch throws on unexpected network. The node,
 * hook, subscriber, event bus, store and request serializers are real.
 */
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiCall).mockReset();
  vi.mocked(awaitTaskCompletion).mockReset();
  mocks.sequence = 0;
  mocks.effects = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startedAt);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  vi.mocked(apiCall).mockImplementation(async (path) => {
    if (!path.endsWith('/freezone/gen')) throw new Error(`Unexpected API call: ${path}`);
    return ref(mocks.sequence++);
  });
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => input.fallbackPrompt);
  vi.mocked(fetchFreezoneJobResult).mockResolvedValue({ url: '', size: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function TargetNode() {
  const node = useCanvasStore((state) => state.nodes[0]);
  if (!isImageGenNode(node)) throw new Error('Missing image node');
  return <ImageGenNode id={node.id} type={node.type} data={node.data} selected={false} dragging={false}
    draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
async function mountSubscriber(name: string, count: number, data: Record<string, unknown> = {}) {
  mocks.projectId = `settle-subscriber/${name}`;
  useCanvasStore.getState().setCanvasData([imageNode({ count, ...data })], []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ReactFlowProvider><TargetNode /></ReactFlowProvider></QueryClientProvider>);
  await waitFor(() => expect(getFreezoneImageModelsSnapshot(mocks.projectId).isLoading).toBe(false));
  // Let the real form's catalog selection settle before capturing the initial data.
  await waitFor(() => expect(fetchFreezoneImageModels).toHaveBeenCalledWith(mocks.projectId));
  return structuredClone(stored());
}
function accept(expected: Record<string, unknown>, refs: patches.ImageGenerationTaskRef[], index: number, task = ref(index)) {
  const input = { runIndex: index, acceptedRefs: refs, task };
  const before = structuredClone(input);
  const accepted = patches.imageGenerationRunAccepted(input);
  expect(input).toStrictEqual(before);
  return {
    expected: accepted.action === 'accepted' && accepted.applyPatch
      ? { ...expected, ...patches.imageGenerationAcceptedPatch(task) } : expected,
    refs: accepted.acceptedRefs,
    accepted,
  };
}
function settle(settled: patches.ImageGenerationSettledRun[], urls: string[], refs: patches.ImageGenerationTaskRef[], completionMode: 'completed' | 'submitted' = 'completed') {
  const input = { settled, completedUrls: urls, acceptedRefs: refs, completionMode, translate: mocks.t };
  const before = { ...structuredClone({ settled, completedUrls: urls, acceptedRefs: refs, completionMode }), translate: mocks.t };
  const outcome = patches.imageGenerationSettleOutcome(input);
  expect(input).toStrictEqual(before);
  return outcome;
}
function complete(expected: Record<string, unknown>, refs: patches.ImageGenerationTaskRef[], urls: string[], index: number, total: number, outcome: ImageGenerationOutcome) {
  const pure = patches.imageGenerationOutcomePatch({ nodeId: 'img-1', nodeData: expected,
    taskKey: ref(index).task_key, firstAcceptedTask: refs[0] ?? null, runIndex: index, total,
    completedUrls: urls, attachStoryFrame: false, outcome, translate: mocks.t });
  return pure.action === 'write'
    ? { expected: { ...expected, ...pure.patch }, urls: pure.completedUrls }
    : { expected, urls };
}
function returned(outcome: patches.ImageGenerationSettleOutcome) {
  if (outcome.kind === 'output') return outcome.output;
  if (outcome.kind === 'undefined') return undefined;
  throw new Error('Expected a returned settle result');
}

describe('image settle through the real generate_image subscriber', () => {
  it.each([
    { name: 'count 1 completed', count: 1, fail: false, cancelled: false },
    { name: 'workflow batch variants single submit', count: 3, fail: false, cancelled: false },
    { name: 'subscriber thrown error', count: 1, fail: true, cancelled: false },
    { name: 'subscriber ignored cancellation publishes success without output', count: 1, fail: false, cancelled: true },
  ])('$name', async ({ name, count, fail, cancelled }) => {
    const pending = deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>();
    vi.mocked(awaitTaskCompletion).mockReturnValue(pending.promise);
    const initial = await mountSubscriber(name, count, cancelled ? { imageUrl: '/static/old.png' } : {});
    let published: unknown;
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => {
      if (event.requestId !== name) return;
      published = event.status === 'error' ? { status: event.status, error: event.error }
        : { status: event.status, ...(event.output ? { output: event.output } : {}) };
    });
    try {
      act(() => { dispatchNodeAction({ nodeId: 'img-1', action: 'generate_image', requestId: name, executionMode: 'workflow' }); });
      await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(1));
      const a = accept({ ...initial, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
      let expected = a.expected;
      expect(stored()).toStrictEqual(expected);
      expect(apiCall).toHaveBeenCalledTimes(1);
      const options = vi.mocked(apiCall).mock.calls[0][1];
      expect(options?.json).toMatchObject(count > 1 ? { variant_count: count } : {});
      expect(options?.json && typeof options.json === 'object' && 'variant_count' in options.json).toStrictEqual(count > 1);
      const urls = count === 1 ? ['/static/0.png'] : ['/static/0.png', '/static/1.png', '/static/2.png'];
      const message = 'Task failed request_id=req-sub';
      const applied = complete(expected, a.refs, [], 0, count, cancelled ? { kind: 'cancelled', message } : fail
        ? { kind: 'failed', message } : { kind: 'completed', result: { output_urls: urls } });
      expected = applied.expected;
      await act(async () => {
        if (fail || cancelled) pending.reject(new TaskCompletionError(message, cancelled ? 'cancelled' : 'failed', ref().task_key));
        else pending.resolve(completedTask(0, { output_urls: urls }));
      });
      const settled: patches.ImageGenerationSettledRun[] = fail ? [{ status: 'rejected', message }]
        : [{ status: 'fulfilled', value: cancelled ? 'ignored' : 'completed' }];
      const outcome = settle(settled, applied.urls, a.refs);
      await waitFor(() => expect(published).toBeDefined());
      expect(stored()).toStrictEqual(expected);
      expect(published).toStrictEqual(patches.imageGenerationActionResult({ settleOutcome: outcome, settled }));
      if (fail) expect(published).toStrictEqual(patches.imageGenerationActionResult({ errorMessage: message }));
    } finally { unsubscribe(); }
  });
});

it('workflow batch variants forces completed despite submitted request', async () => {
  const pending = deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>();
  vi.mocked(awaitTaskCompletion).mockReturnValue(pending.promise);
  const { result, initial } = await mount('workflow forces completed', { count: 3 });
  let finished = false;
  let output: unknown;
  let submission = Promise.resolve();
  await act(async () => {
    submission = result.current.submit({ completionMode: 'submitted', executionSource: 'workflow', attachStoryFrame: false })
      .then((value) => { finished = true; output = value; });
  });
  await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(1));
  expect(finished).toStrictEqual(false);
  expect(apiCall).toHaveBeenCalledTimes(1);
  expect(vi.mocked(apiCall).mock.calls[0][1]?.json).toMatchObject({ variant_count: 3 });
  const accepted = accept({ ...initial, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
  const urls = ['/static/a.png', '/static/b.png', '/static/c.png'];
  const applied = complete(accepted.expected, accepted.refs, [], 0, 3, { kind: 'completed', result: { output_urls: urls } });
  await act(async () => { pending.resolve(completedTask(0, { output_urls: urls })); await submission; });
  expect(stored()).toStrictEqual(applied.expected);
  expect(output).toStrictEqual(returned(settle([{ status: 'fulfilled', value: 'completed' }], urls, accepted.refs)));
});

describe('manual ordered batch settlement', () => {
  it.each([
    { name: 'count 3 failure after success', stale: false, allFail: false, order: [1, 2, 0] },
    { name: 'count 3 all fail in different rejection order', stale: false, allFail: true, order: [2, 1, 0] },
    { name: 'all runs ignored after invalidation', stale: true, allFail: false, order: [2, 0, 1] },
  ])('$name', async ({ name, stale, allFail, order }) => {
    const pending = Array.from({ length: 3 }, () => deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>());
    vi.mocked(awaitTaskCompletion).mockImplementation((key) => pending[Number(key.split('-')[1])].promise);
    const { result, initial } = await mount(name, { count: 3 });
    const album = renderHook(() => useAlbumPendingTotal('img-1'));
    let output: unknown;
    let thrown: string | undefined;
    let waitingOutput: unknown;
    let submission = Promise.resolve();
    let waiter = Promise.resolve();
    await act(async () => {
      submission = result.current.submit({ attachStoryFrame: false }).then((value) => { output = value; }, (error: Error) => { thrown = error.message; });
      waiter = result.current.submit().then((value) => { waitingOutput = value; });
    });
    await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(3));
    expect(album.result.current).toStrictEqual(3);
    let expected = { ...initial, ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    for (const index of [0, 1, 2]) ({ expected, refs } = accept(expected, refs, index));
    expect(stored()).toStrictEqual(expected);
    if (stale) act(() => result.current.invalidateInFlightGeneration());
    let urls: string[] = [];
    const settled: patches.ImageGenerationSettledRun[] = [];
    for (const index of order) {
      const failed = allFail || index === 2;
      const message = `Run ${index} failed`;
      if (!stale) ({ expected, urls } = complete(expected, refs, urls, index, 3,
        failed ? { kind: 'failed', message } : { kind: 'completed', result: { url: `/static/${index}.png` } }));
      settled[index] = stale ? { status: 'fulfilled', value: 'ignored' }
        : failed && urls.length === 0 ? { status: 'rejected', message }
        : { status: 'fulfilled', value: failed ? 'handled' : 'completed' };
      await act(async () => {
        if (failed) pending[index].reject(new TaskCompletionError(message, 'failed', ref(index).task_key));
        else pending[index].resolve(completedTask(index, { url: `/static/${index}.png` }));
      });
      expect(stored()).toStrictEqual(expected);
    }
    await act(async () => { await submission; await waiter; });
    expect(album.result.current).toStrictEqual(0);
    const outcome = settle(settled, urls, refs);
    if (outcome.kind === 'rethrow') {
      expect(outcome.runIndex).toStrictEqual(0);
      const failure = settled[outcome.runIndex];
      expect(thrown).toStrictEqual(failure.status === 'rejected' ? failure.message : undefined);
      expect(waitingOutput).toStrictEqual(undefined);
    } else {
      expect(output).toStrictEqual(returned(outcome));
      expect(waitingOutput).toStrictEqual(output);
      expect(thrown).toStrictEqual(undefined);
    }
    expect(apiCall).toHaveBeenCalledTimes(3);
  });
});

const backgroundFixtures = [
  { name: 'submitted count 1 background success', count: 1, order: [0], failures: [] },
  { name: 'submitted count 2 background success', count: 2, order: [1, 0], failures: [] },
  { name: 'submitted run 0 background failure', count: 2, order: [0, 1], failures: [0] },
  { name: 'submitted run 1 background failure before success', count: 2, order: [1, 0], failures: [1] },
  { name: 'submitted run 1 background failure after success', count: 2, order: [0, 1], failures: [1] },
  { name: 'submitted background insufficient credits', count: 1, order: [0], failures: [0], credits: true },
  { name: 'submitted stale cancellation with previous media still writes', count: 1, order: [0], failures: [0], stale: true },
  { name: 'submitted reference failure still writes raw error', count: 1, order: [0], failures: [0], reference: true },
  { name: 'submitted empty Error message uses name', count: 1, order: [0], failures: [0], empty: true },
];
describe('submitted mode returns handles before background completion', () => {
  it.each(backgroundFixtures)('$name', async (fixture) => {
    const pending = Array.from({ length: fixture.count }, () => deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>());
    vi.mocked(awaitTaskCompletion).mockImplementation((key) => pending[Number(key.split('-')[1])].promise);
    const { result, initial } = await mount(fixture.name, { count: fixture.count, ...(fixture.stale ? { imageUrl: '/static/old.png' } : {}) });
    let output: unknown;
    await act(async () => { output = await result.current.submit({ completionMode: 'submitted', attachStoryFrame: false }); });
    expect(awaitTaskCompletion).toHaveBeenCalledTimes(fixture.count);
    let expected = { ...initial, ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    for (let index = 0; index < fixture.count; index++) ({ expected, refs } = accept(expected, refs, index));
    const outcome = settle(refs.map(() => ({ status: 'fulfilled', value: 'submitted' })), [], refs, 'submitted');
    expect(output).toStrictEqual(returned(outcome));
    expect(output).toStrictEqual({ submitted: true, ...ref(), taskKey: ref().task_key, taskType: ref().task_type, jobId: ref().job_id });
    expect(stored()).toStrictEqual(expected);
    if (fixture.stale) {
      act(() => { result.current.invalidateInFlightGeneration(); useCanvasStore.getState().updateNodeData('img-1', { generationTaskKey: 'replacement' }); });
      expected.generationTaskKey = 'replacement';
    }
    let urls: string[] = [];
    for (const index of fixture.order) {
      const error = fixture.credits ? errorFromBackendBody(402, { error: 'Insufficient credits request_id=req-credit' }, 'Rejected')
        : fixture.reference ? errorFromBackendBody(422, { detail: { code: 'REFERENCE_MEDIA_INVALID', message: 'Reference failed', errors: [{ media: 'image', index: 1, name: 'Reference', code: 'missing', reference_key: 'ref.png' }] } }, 'Rejected')
        : fixture.stale ? new TaskCompletionError('Stopped request_id=req-stop', 'cancelled', ref(index).task_key)
        : new Error(fixture.empty ? '' : `Background ${index} request_id=req-${index}`);
      if (!(error instanceof Error)) throw new Error('Expected mapped Error');
      if (fixture.failures.includes(index)) {
        const info = patches.describeGenerationError(error, mocks.t, 'Fallback');
        expected = { ...expected, ...patches.imageGenerationBackgroundFailurePatch({ runIndex: index, message: error.message, error: info, translate: mocks.t }) };
        if (fixture.credits) expect(info.display).toStrictEqual('translated:common.insufficientCredits');
      } else ({ expected, urls } = complete(expected, refs, urls, index, fixture.count, { kind: 'completed', result: { url: `/static/${index}.png` } }));
      await act(async () => {
        if (fixture.failures.includes(index)) pending[index].reject(error);
        else pending[index].resolve(completedTask(index, { url: `/static/${index}.png` }));
      });
      await waitFor(() => expect(stored()).toStrictEqual(expected));
      expect(output).toStrictEqual(returned(outcome));
    }
  });
});

describe('acceptance order and duplicate keys', () => {
  it('duplicate task key returned by two submits', async () => {
    vi.mocked(apiCall).mockImplementation(async () => ref());
    const pending = deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>();
    vi.mocked(awaitTaskCompletion).mockReturnValue(pending.promise);
    const { result, initial } = await mount('duplicate key', { count: 2 });
    let output: unknown;
    let submission = Promise.resolve();
    await act(async () => { submission = result.current.submit({ attachStoryFrame: false }).then((value) => { output = value; }); });
    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(2));
    const first = accept({ ...initial, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const duplicate = accept(first.expected, first.refs, 1, ref());
    expect(duplicate.accepted).toStrictEqual({ action: 'handled', acceptedRefs: [ref()] });
    expect(awaitTaskCompletion).toHaveBeenCalledTimes(1);
    const applied = complete(first.expected, first.refs, [], 0, 2, { kind: 'completed', result: { url: '/static/a.png' } });
    await act(async () => { pending.resolve(completedTask(0, { url: '/static/a.png' })); await submission; });
    expect(stored()).toStrictEqual(applied.expected);
    expect(output).toStrictEqual(returned(settle([{ status: 'fulfilled', value: 'completed' }, { status: 'fulfilled', value: 'handled' }], applied.urls, first.refs)));
  });
  it('run 1 accepted before run 0 keeps acceptance order but run 0 owns descriptor', async () => {
    const admissions = [deferred<ReturnType<typeof ref>>(), deferred<ReturnType<typeof ref>>()];
    vi.mocked(apiCall).mockImplementation(() => admissions[mocks.sequence++].promise);
    const pending = [deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>(), deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>()];
    vi.mocked(awaitTaskCompletion).mockImplementation((key) => pending[Number(key.split('-')[1])].promise);
    const { result, initial } = await mount('acceptance order', { count: 2 });
    let output: unknown;
    let submission = Promise.resolve();
    await act(async () => { submission = result.current.submit({ attachStoryFrame: false }).then((value) => { output = value; }); });
    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(2));
    let expected = { ...initial, ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    for (const index of [1, 0]) {
      ({ expected, refs } = accept(expected, refs, index));
      await act(async () => { admissions[index].resolve(ref(index)); });
      expect(stored()).toStrictEqual(expected);
    }
    let urls: string[] = [];
    for (const index of [0, 1]) {
      ({ expected, urls } = complete(expected, refs, urls, index, 2, { kind: 'completed', result: { url: `/static/${index}.png` } }));
      await act(async () => { pending[index].resolve(completedTask(index, { url: `/static/${index}.png` })); });
    }
    await submission;
    expect(stored()).toStrictEqual(expected);
    const outcome = settle([0, 1].map(() => ({ status: 'fulfilled', value: 'completed' })), urls, refs);
    expect(output).toStrictEqual(returned(outcome));
    expect(output).toStrictEqual({ ...ref(1), imageUrl: '/static/0.png', imageUrls: urls });
  });
});

describe('pure aggregate protocol edges', () => {
  it('duplicate task plus ignored cancellation reaches no_result', async () => {
    vi.mocked(apiCall).mockImplementation(async () => ref());
    const pending = deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>();
    vi.mocked(awaitTaskCompletion).mockReturnValue(pending.promise);
    const { result, initial } = await mount('no result cancellation duplicate', { count: 2, imageUrl: '/static/old.png' });
    let thrown: string | undefined;
    let submission = Promise.resolve();
    await act(async () => { submission = result.current.submit().then(() => undefined, (error: Error) => { thrown = error.message; }); });
    await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(1));
    const first = accept({ ...initial, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const duplicate = accept(first.expected, first.refs, 1, ref());
    expect(duplicate.accepted.action).toStrictEqual('handled');
    const cancelled = complete(first.expected, first.refs, [], 0, 2, { kind: 'cancelled', message: 'Stopped' });
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'fulfilled', value: 'ignored' }, { status: 'fulfilled', value: 'handled' }];
    const outcome = settle(settled, [], first.refs);
    if (outcome.kind !== 'no_result') throw new Error('Expected no_result');
    const message = '图片生成未提交任务，也没有返回图片地址'; // i18n-exempt -- exact browser fallback text
    expect(outcome).toStrictEqual({ kind: 'no_result', error: { message }, patch: {
      isGenerating: false, generationStartedAt: null, generationTaskKey: null,
      generationTaskType: null, generationTaskJobId: null, generationError: message,
      generationErrorDetails: message, generationErrorRequestId: null,
    } });
    await act(async () => { pending.reject(new TaskCompletionError('Stopped', 'cancelled', ref().task_key)); await submission; });
    expect(thrown).toStrictEqual(outcome.error.message);
    expect(stored()).toStrictEqual({ ...cancelled.expected, ...outcome.patch });
    expect(patches.imageGenerationActionResult({ settleOutcome: outcome, settled })).toStrictEqual({ status: 'error', error: message });
    expect(settle([], [], [])).toStrictEqual(outcome);
  });
  it('URLs win over rejection; rejection wins over submitted handles', () => {
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'rejected', message: 'First' }];
    const output = settle(settled, ['/a.png'], []);
    expect(output).toStrictEqual({ kind: 'output', output: { imageUrl: '/a.png', imageUrls: ['/a.png'] } });
    expect(settle(settled, [], [ref()], 'submitted')).toStrictEqual({ kind: 'rethrow', runIndex: 0 });
  });
  it('undefined publishes success without output and thrown values preserve caller text', () => {
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'fulfilled', value: 'ignored' }];
    const outcome = settle(settled, [], []);
    expect(outcome).toStrictEqual({ kind: 'undefined' });
    expect(patches.imageGenerationActionResult({ settleOutcome: outcome, settled })).toStrictEqual({ status: 'success' });
    expect(patches.imageGenerationActionResult({ errorMessage: 'raw thrown value' })).toStrictEqual({ status: 'error', error: 'raw thrown value' });
    const submitted = settle([{ status: 'fulfilled', value: 'submitted' }], [], [ref()], 'submitted');
    expect(patches.imageGenerationActionResult({ settleOutcome: submitted, settled: [] })).toStrictEqual({ status: 'success', output: returned(submitted) });
  });
  it('background fallback without error info preserves empty-message diagnostics', () => {
    expect(patches.imageGenerationBackgroundFailurePatch({ runIndex: 1, message: '', translate: mocks.t })).toStrictEqual({
      generationError: 'translated:common.error', generationErrorDetails: 'Error', generationErrorRequestId: null,
    });
  });
});
