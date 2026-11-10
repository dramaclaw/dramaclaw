// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from '@/api/client';
import { fetchFreezoneImageModels, fetchFreezoneJobResult } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import * as patches from '@/features/canvas/application/generationRequests';
import type { ImageGenerationOutcome, ImageGenerationEffect } from '@/features/canvas/application/generationRequests';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { attachCompletedStoryFrame, attachCompletedStoryAsset } from '@/features/canvas/application/videoContinuity';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { humanizeTaskError } from '@/lib/api-errors';
import { extractRequestId } from '@/features/canvas/domain/generationRequestId';
import { generationErrorFromSubmitFailure, describeGenerationError, type GenerationSubmitFailure } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { useCanvasStore } from '@/stores/canvasStore';

const mocks = vi.hoisted(() => ({
  projectId: '', sequence: 0,
  t: (key: string, options?: Record<string, unknown>) => JSON.stringify([key, options ?? null]),
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
async function mount(name: string, data: Record<string, unknown>) {
  mocks.projectId = `submit-error-parity/${name}`;
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

// Lowest-layer mocks copied from the result harness: translation, credit quote,
// URL context, apiCall, catalogs/history/fallback result, task wait, prompt compile,
// story attachments and commit event. Fetch blocks any accidental network use.
const fallback = 'Generation failed';
const http = (status: number, body?: unknown): GenerationSubmitFailure => ({
  kind: 'http', status, statusText: '', method: 'POST',
  url: 'https://canvas.example/api/v1/projects/demo/freezone/gen', body,
});
const fixtures: { name: string; failure: GenerationSubmitFailure }[] = [
  { name: 'insufficient credits with message', failure: http(402, { error: 'Add credits' }) },
  { name: 'insufficient credits without message', failure: http(402) },
  { name: 'billing rule', failure: http(400, { error: 'No billing rule', data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' } }) },
  { name: 'queue default', failure: http(429, { data: { queue_kind: 'default' } }) },
  { name: 'queue video project', failure: http(429, { data: { queue_kind: 'video', limit_scope: 'project' } }) },
  { name: 'queue video user', failure: http(429, { data: { queue_kind: 'video', limit_scope: 'user' } }) },
  { name: 'backend request id', failure: http(400, { error: 'Submit failed request_id=req-123' }) },
  { name: 'envelope failure', failure: { kind: 'envelope', body: { ok: false, error: 'Rejected envelope' } } },
  { name: 'envelope empty message', failure: { kind: 'envelope', body: { ok: false, error: '' } } },
  { name: 'reference invalid', failure: http(422, { detail: {
    code: 'REFERENCE_MEDIA_INVALID', message: 'Invalid reference',
    errors: [{ media: 'image', index: 1, name: 'Reference', code: 'missing', reference_key: 'ref.png' }],
  } }) },
];
describe('image submit error parity with the real hook', () => {
  it.each(fixtures)('$name', async fixture => {
    const error = generationErrorFromSubmitFailure(fixture.failure);
    const info = describeGenerationError(error, mocks.t, fallback);
    vi.mocked(apiCall).mockRejectedValueOnce(error);
    const { result, initial } = await mount(fixture.name, {});
    let caught: unknown;
    await act(async () => {
      await result.current.submit({ completionMode: 'completed', executionSource: 'workflow', attachStoryFrame: false })
        .catch((rejection: unknown) => { caught = rejection; });
    });
    expect(caught).toBe(error);
    const beforeOutcome = { ...initial, ...patches.imageGenerationStartPatch(startedAt), ...patches.imageGenerationSubmitPatch(startedAt) };
    const pure = derive(beforeOutcome, info.referenceIssues.length > 0
      ? { kind: 'reference_invalid', message: error.message }
      : { kind: 'failed', message: error.message, error: info }, { taskKey: null, firstAcceptedTask: null });
    expect(pure.action).toBe('write');
    if (pure.action !== 'write') throw new Error('Expected failure patch');
    expect(stored()).toStrictEqual({ ...beforeOutcome, ...pure.patch });
    expect(pure.error).toStrictEqual({ message: error.message });
    expect(mocks.effects).toStrictEqual(pure.effects);
    expect(awaitTaskCompletion).not.toHaveBeenCalled();
    expect(attachCompletedStoryFrame).not.toHaveBeenCalled();
    expect(attachCompletedStoryAsset).not.toHaveBeenCalled();
    if (info.referenceIssues.length === 0) {
      expect(pure.patch).toStrictEqual({
        isGenerating: false, generationStartedAt: null, generationError: info.display,
        generationErrorDetails: error.message || String(error),
        generationErrorRequestId: extractRequestId(error.message || String(error)),
      });
    }
    // The pre-existing C3a failed outcome stays byte-for-byte equivalent when
    // callers omit the new error info, even for a classified submit error.
    const previous = derive(beforeOutcome, { kind: 'failed', message: error.message }, { taskKey: null, firstAcceptedTask: null });
    expect(previous).toStrictEqual({
      action: 'write', patch: {
        isGenerating: false, generationStartedAt: null,
        generationError: humanizeTaskError(error.message, mocks.t),
        generationErrorDetails: error.message || 'Error',
        generationErrorRequestId: extractRequestId(error.message || 'Error'),
      }, completedUrls: [], effects: [], error: { message: error.message },
    });
  });
});
