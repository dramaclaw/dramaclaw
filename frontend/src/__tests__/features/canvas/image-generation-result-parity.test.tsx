// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from '@/api/client';
import { fetchFreezoneImageModels, fetchFreezoneJobResult } from '@/api/ops';
import { awaitTaskCompletion, TaskCompletionError } from '@/api/tasks';
import * as patches from '@/features/canvas/application/generationRequests';
import type { ImageGenerationOutcome, ImageGenerationEffect } from '@/features/canvas/application/generationRequests';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { attachCompletedStoryFrame, attachCompletedStoryAsset } from '@/features/canvas/application/videoContinuity';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { BackendStatusError, errorFromBackendBody } from '@/lib/api-errors';
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
  mocks.projectId = `result-parity/${name}`;
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
function derive(nodeData: Record<string, unknown>, outcome: ImageGenerationOutcome, overrides: Partial<patches.ImageGenerationOutcomeInput> = {}) {
  return patches.imageGenerationOutcomePatch({
    nodeId: 'img-1', nodeData, taskKey: ref().task_key, firstAcceptedTask: ref(),
    runIndex: 0, total: 1, completedUrls: [], attachStoryFrame: false,
    outcome, translate: mocks.t, ...overrides,
  });
}
const singleSuccess = {
  imageUrl: '/static/a.png', previewImageUrl: '/static/a.png', isGenerating: false,
  generationStartedAt: null, generationTaskKey: null, generationTaskType: null,
  generationTaskJobId: null, generationError: null, generationErrorDetails: null,
  generationErrorRequestId: null,
};
type Fixture = {
  name: string; outcome: ImageGenerationOutcome; data?: Record<string, unknown>;
  attach?: boolean; stale?: boolean; rejectSubmit?: boolean; rejectFallback?: boolean; literal?: Record<string, unknown>;
};
const fixtures: Fixture[] = [
  { name: 'success single workflow', outcome: { kind: 'completed', result: { output_url: '/static/a.png' } }, literal: singleSuccess },
  { name: 'workflow count three', data: { count: 3 }, outcome: { kind: 'completed', result: { output_urls: ['/static/a.png', '/static/b.png', '/static/c.png'] } } },
  { name: 'fallback URL', outcome: { kind: 'completed', result: null, fallbackUrl: '/static/fallback.png' } },
  { name: 'no URL or fallback', outcome: { kind: 'completed', result: {} } },
  { name: 'fallback fetch fails', rejectFallback: true, outcome: { kind: 'completed', result: null } },
  { name: 'submit rejected', rejectSubmit: true, outcome: { kind: 'failed', message: 'Submit rejected' } },
  { name: 'empty task failure', outcome: { kind: 'failed', message: '' } },
  { name: 'empty compile failure', outcome: { kind: 'compile_failed', message: '' } },
  { name: 'stale success still writes', stale: true, outcome: { kind: 'completed', result: { url: '/static/a.png' } } },
  { name: 'stale missing URL resets loading before catch', stale: true, outcome: { kind: 'completed', result: null } },
  { name: 'stale cancellation with media resets loading first', stale: true, data: { previewImageUrl: '/static/old.png' }, outcome: { kind: 'cancelled', message: 'Stopped' } },
  { name: 'plain failure', outcome: { kind: 'failed', message: 'Rendering failed' } },
  { name: 'failure with request id', outcome: { kind: 'failed', message: 'Rendering failed request_id=req-123' }, literal: {
    isGenerating: false, generationStartedAt: null,
    generationError: 'Rendering failed request_id=req-123',
    generationErrorDetails: 'Rendering failed request_id=req-123', generationErrorRequestId: 'req-123',
  } },
  { name: 'content policy failure', outcome: { kind: 'failed', message: 'content_policy_violation' } },
  { name: 'cancelled with media', data: { imageUrl: '/static/old.png' }, outcome: { kind: 'cancelled', message: 'Stopped' },
    literal: { isGenerating: false, generationStartedAt: null } },
  { name: 'cancelled without media', outcome: { kind: 'cancelled', message: 'Stopped' } },
  { name: 'stale task failure', stale: true, outcome: { kind: 'failed', message: 'Late failure' } },
  { name: 'reference issues on submit', outcome: { kind: 'reference_invalid', message: 'Invalid reference' } },
  { name: 'compile failure preserves previous album', data: { generationBatch: ['/static/old.png'] }, outcome: { kind: 'compile_failed', message: 'Compile failed request_id=compile-1' } },
  { name: 'auto commit success', data: { autoCommitOnGenerate: true, preset_managed: true, count: 3 }, outcome: { kind: 'completed', result: { output_url: '/static/a.png' } } },
  { name: 'story frame success', attach: true, data: { storyFrameTarget: { nodeId: 'video-1', role: 'first_frame' } }, outcome: { kind: 'completed', result: { output_url: '/static/a.png' } } },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiCall).mockReset();
  vi.mocked(awaitTaskCompletion).mockReset();
  vi.mocked(compileWorkflowNodePrompt).mockReset();
  vi.mocked(fetchFreezoneJobResult).mockReset();
  mocks.sequence = 0;
  mocks.effects = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startedAt);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in result parity tests'); }));
  vi.mocked(apiCall).mockImplementation(async (path) => {
    if (!path.endsWith('/freezone/gen')) throw new Error(`Unexpected API call: ${path}`);
    return ref(mocks.sequence++);
  });
  vi.mocked(compileWorkflowNodePrompt).mockImplementation(async (input) => input.fallbackPrompt);
  vi.mocked(fetchFreezoneJobResult).mockResolvedValue({ url: '', size: 0 });
  vi.spyOn(canvasEventBus, 'publish').mockImplementation((event, payload) => {
    if (event === 'freezone/commit-node' && payload && 'nodeId' in payload) {
      mocks.effects.push({ kind: 'commit_node', nodeId: String(payload.nodeId), auto: true });
    }
    return 0;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('image generation result parity', () => {
  it.each(fixtures)('$name', async (fixture) => {
    const { outcome } = fixture;
    const pending = deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>();
    vi.mocked(awaitTaskCompletion).mockReturnValue(pending.promise);
    // Real error mapping used by api/client for structured 4xx responses.
    if (outcome.kind === 'reference_invalid') {
      const error = errorFromBackendBody(422, { detail: {
        code: 'REFERENCE_MEDIA_INVALID', message: outcome.message,
        errors: [{ media: 'image', index: 1, name: 'Reference', code: 'missing', reference_key: 'ref.png' }],
      } }, 'Rejected');
      expect(error).toBeInstanceOf(BackendStatusError);
      vi.mocked(apiCall).mockRejectedValueOnce(error);
    }
    if (fixture.rejectSubmit && outcome.kind === 'failed') {
      vi.mocked(apiCall).mockRejectedValueOnce(new Error(outcome.message));
    }
    if (fixture.rejectFallback) {
      vi.mocked(fetchFreezoneJobResult).mockRejectedValueOnce(new Error('Fallback failed'));
    }
    if (outcome.kind === 'compile_failed') {
      vi.mocked(compileWorkflowNodePrompt).mockRejectedValueOnce(new Error(outcome.message));
    }
    if (outcome.kind === 'completed' && !fixture.rejectFallback) {
      vi.mocked(fetchFreezoneJobResult).mockResolvedValueOnce({ url: outcome.fallbackUrl ?? '', size: 0 });
    }
    const { result, initial } = await mount(fixture.name, fixture.data ?? {});
    const compileFailed = outcome.kind === 'compile_failed';
    let expected = { ...initial, ...(compileFailed
      ? patches.imageGenerationStartPatch(startedAt) : patches.imageGenerationSubmitPatch(startedAt)) };
    let output: unknown;
    let errorMessage: string | undefined;
    let submission = Promise.resolve();
    await act(async () => {
      submission = result.current.submit({ completionMode: 'completed', executionSource: 'workflow', attachStoryFrame: fixture.attach ?? false })
        .then((value) => { output = value; }, (error: Error) => { errorMessage = error.message; });
    });
    const accepted = !compileFailed && outcome.kind !== 'reference_invalid' && !fixture.rejectSubmit;
    if (accepted) {
      await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(1));
      expected = { ...expected, ...patches.imageGenerationAcceptedPatch(ref()) };
      if (fixture.stale) {
        act(() => useCanvasStore.getState().updateNodeData('img-1', { generationTaskKey: 'replacement' }));
        expected.generationTaskKey = 'replacement';
      }
      await act(async () => {
        if (outcome.kind === 'completed') pending.resolve(completedTask(0, outcome.result));
        else if (outcome.kind === 'failed' || outcome.kind === 'cancelled') pending.reject(new TaskCompletionError(outcome.message, outcome.kind, ref().task_key));
        await submission;
      });
    } else await act(async () => { await submission; });
    const before = structuredClone(expected);
    const pure = derive(expected, outcome, {
      taskKey: accepted ? ref().task_key : null, firstAcceptedTask: accepted ? ref() : null,
      total: fixture.data?.count === 3 && !fixture.data?.autoCommitOnGenerate ? 3 : 1,
      attachStoryFrame: fixture.attach ?? false,
    });
    expect(expected).toStrictEqual(before);
    if (pure.action === 'write') {
      expected = { ...expected, ...pure.patch };
      expect(mocks.effects).toStrictEqual(pure.effects);
      expect(output).toStrictEqual(pure.output);
      expect(errorMessage).toBe(pure.error?.message);
      if (fixture.literal) expect(pure.patch).toStrictEqual(fixture.literal);
    } else {
      expect(mocks.effects).toStrictEqual([]);
      expect(output).toBeUndefined();
      expect(errorMessage).toBeUndefined();
    }
    expect(stored()).toStrictEqual(expected);
    expect(attachCompletedStoryFrame).toHaveBeenCalledTimes(fixture.attach ? 1 : 0);
    expect(attachCompletedStoryAsset).toHaveBeenCalledTimes(fixture.attach ? 1 : 0);
    if (outcome.kind === 'completed') expect(fetchFreezoneJobResult).toHaveBeenCalledTimes(outcome.result && ['output_url', 'image_url', 'url', 'output_urls'].some((key) => outcome.result && key in outcome.result) ? 0 : 1);
  });

  it.each([
    { name: 'run 1 completes, run 0 completes, run 2 fails', order: [1, 0, 2], kinds: ['completed', 'completed', 'failed'], urls: ['/static/1.png', '/static/0.png'] },
    { name: 'secondary failure before success', order: [1, 0, 2], kinds: ['completed', 'failed', 'completed'], urls: ['/static/0.png', '/static/2.png'] },
    { name: 'secondary missing URL before success', order: [1, 0, 2], kinds: ['completed', 'missing', 'completed'], urls: ['/static/0.png', '/static/2.png'] },
    { name: 'run 1 accepted before run 0', secondaryAcceptedFirst: true, order: [1, 0, 2], kinds: ['completed', 'completed', 'failed'], urls: ['/static/1.png', '/static/0.png'] },
    { name: 'duplicate completion URLs', order: [1, 0, 2], kinds: ['duplicate', 'completed', 'failed'], urls: ['/static/1.png'] },
  ])('manual count three: $name', async ({ name, order, kinds, urls, secondaryAcceptedFirst }) => {
    const pending = Array.from({ length: 3 }, () => deferred<Awaited<ReturnType<typeof awaitTaskCompletion>>>());
    vi.mocked(awaitTaskCompletion).mockImplementation((key) => pending[Number(key.split('-')[1])].promise);
    const accepted = Array.from({ length: 3 }, () => deferred<ReturnType<typeof ref>>());
    if (secondaryAcceptedFirst) {
      vi.mocked(apiCall).mockImplementation(() => accepted[mocks.sequence++].promise);
    }
    const { result, initial } = await mount(`manual batch ${name}`, { count: 3 });
    let output: unknown;
    let submission = Promise.resolve();
    await act(async () => {
      submission = result.current.submit({ completionMode: 'completed', executionSource: 'manual', attachStoryFrame: true })
        .then((value) => { output = value; });
    });
    if (secondaryAcceptedFirst) {
      await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(3));
      for (const index of [1, 0, 2]) {
        await act(async () => { accepted[index].resolve(ref(index)); });
        await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledWith(ref(index).task_key, mocks.projectId, { taskType: 'freezone_gen' }));
      }
    }
    await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledTimes(3));
    let expected = { ...initial, ...patches.imageGenerationSubmitPatch(startedAt),
      ...(secondaryAcceptedFirst ? patches.imageGenerationAcceptedPatch(ref(1)) : {}),
      ...patches.imageGenerationAcceptedPatch(ref()),
    };
    let completedUrls: string[] = [];
    const effects: ImageGenerationEffect[] = [];
    let expectedOutput: unknown;
    for (const index of order) {
      const outcome: ImageGenerationOutcome = kinds[index] === 'failed' ? { kind: 'failed', message: 'Run failed' }
        : { kind: 'completed', result: kinds[index] === 'missing' ? {} : { output_url: `/static/${kinds[index] === 'duplicate' ? 1 : index}.png` } };
      const before = structuredClone({ expected, completedUrls });
      const pure = derive(expected, outcome, {
        runIndex: index, total: 3, taskKey: ref(index).task_key,
        firstAcceptedTask: ref(secondaryAcceptedFirst ? 1 : 0), completedUrls, attachStoryFrame: true,
      });
      expect({ expected, completedUrls }).toStrictEqual(before);
      if (pure.action === 'write') {
        expected = { ...expected, ...pure.patch };
        completedUrls = pure.completedUrls;
        effects.push(...pure.effects);
        expectedOutput = pure.output;
      }
      await act(async () => {
        if (outcome.kind === 'completed') pending[index].resolve(completedTask(index, outcome.result));
        else pending[index].reject(new TaskCompletionError('Run failed', 'failed', ref(index).task_key));
        if (index === 2) await submission;
      });
      await waitFor(() => expect(stored()).toStrictEqual(expected));
    }
    expect(completedUrls).toStrictEqual(urls);
    expect(mocks.effects).toStrictEqual(effects);
    expect(output).toStrictEqual(expectedOutput);
  });
});

describe('pure lifecycle literal values', () => {
  it('writes submit fields and the accepted descriptor', () => {
    expect(patches.imageGenerationSubmitPatch(123)).toStrictEqual({
      isGenerating: true, generationStartedAt: 123, generationError: null,
      generationErrorDetails: null, generationErrorRequestId: null, generationBatch: null,
    });
    expect(patches.imageGenerationAcceptedPatch(ref())).toStrictEqual({
      generationTaskKey: 'task-0', generationTaskType: 'freezone_gen', generationTaskJobId: 'job-0',
    });
  });
  it('retains a handled batch before reference and stale checks', () => {
    const input = {
      nodeId: 'img-1', nodeData: { generationTaskKey: 'replacement' }, taskKey: 'old',
      firstAcceptedTask: ref(), runIndex: 0, total: 3, completedUrls: ['/static/first.png'],
      attachStoryFrame: true, outcome: { kind: 'reference_invalid', message: 'Invalid reference' },
      translate: mocks.t,
    } satisfies patches.ImageGenerationOutcomeInput;
    const before = { ...input, completedUrls: [...input.completedUrls] };
    expect(patches.imageGenerationOutcomePatch(input)).toStrictEqual({
      action: 'write', patch: {}, completedUrls: ['/static/first.png'], effects: [],
      output: { ...ref(), imageUrl: '/static/first.png', imageUrls: ['/static/first.png'] },
    });
    expect(input).toStrictEqual(before);
  });
  it('does not apply run-0 arbitration or loading reset to a secondary failure', () => {
    expect(derive({ generationTaskKey: 'task-0' }, { kind: 'failed', message: 'Secondary failed' }, {
      taskKey: 'task-1', runIndex: 1,
    })).toStrictEqual({
      action: 'write', patch: { generationError: 'Secondary failed', generationErrorDetails: 'Secondary failed', generationErrorRequestId: null },
      completedUrls: [], effects: [], error: { message: 'Secondary failed' },
    });
  });
  it('ignores stale run 0, cancelled secondary run with media, and duplicate URLs', () => {
    expect(derive({ generationTaskKey: 'new' }, { kind: 'failed', message: 'Old' })).toStrictEqual({ action: 'ignore' });
    expect(derive({ imageUrl: '/old.png' }, { kind: 'cancelled', message: 'Stopped' }, { runIndex: 1 })).toStrictEqual({ action: 'ignore' });
    expect(derive({}, { kind: 'completed', result: { url: '/a.png' } }, { completedUrls: ['/a.png'] })).toStrictEqual({ action: 'ignore' });
  });
});
