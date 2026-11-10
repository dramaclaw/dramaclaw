// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiCall } from '@/api/client';
import { fetchFreezoneImageModels } from '@/api/ops';
import {
  buildImageGenerationRequest,
  imagePromptCompileInput,
  type ImageGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
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
  apiCall: vi.fn(async (path: string) => {
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

const catalog: ModelOption[] = [{
  id: 'openai/test-image', providerId: 'openai', apiModel: 'test-image-api', label: 'Test image',
  qualityOptions: ['low', 'medium', 'high'],
}];
const constrainedCatalog: ModelOption[] = [{
  ...catalog[0], catalogId: 'catalog-image-7',
  resolutionOptions: [' 4K ', '', '1K'], ratioOptions: ['1:1', ' 16:9 ', ''],
  qualityOptions: [' High ', ' Medium ', ''],
}];

// Fresh-node fields mirror nodeRegistry; a prompt is filled in before submitting.
function imageNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'img-1', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
    data: {
      displayName: 'Image', imageUrl: null, previewImageUrl: null, aspectRatio: '16:9',
      isSizeManuallyAdjusted: false, requestAspectRatio: 'auto', prompt: 'A cat on a windowsill',
      model: 'newapi_gpt_image2', size: '2K', count: 1, styleTemplateId: null,
      focusRegion: null, cameraSelection: null, referenceImageUrl: null, marks: [],
      isGenerating: false, generationStartedAt: null, generationDurationMs: 60000,
      ...data,
    },
  };
}
function textNode(id: string, content: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content, displayName: 'Text' } };
}

type Fixture = ImageGenerationRequestContext & {
  name: string;
  expectedBody: Record<string, unknown>;
  expectedRequestCount: number;
  expectedPrompt: string;
};
function fixture(
  name: string,
  data: Record<string, unknown> = {},
  overrides: Partial<ImageGenerationRequestContext> = {},
  expectedBody: Record<string, unknown> = {},
  expectedRequestCount = 1,
  expectedPrompt = 'A cat on a windowsill',
): Fixture {
  return {
    name, nodes: [imageNode(data)], edges: [], nodeId: 'img-1', projectId: `parity/${name}`,
    canvasId: 'canvas-7', imageModels: catalog, executionSource: 'workflow', productOperation: null,
    expectedBody, expectedRequestCount, expectedPrompt, ...overrides,
  };
}
const upstreamNodes = [
  textNode('text-1', '  Morning light  '), imageNode(), textNode('text-2', 'Warm colors'),
  textNode('ignored', 'Do not include'), textNode('blank', '  '),
];
const upstreamEdges = [
  { id: 'e2', source: 'text-2', target: 'img-1' },
  { id: 'e1', source: 'text-1', target: 'img-1' },
  { id: 'dep', source: 'ignored', target: 'img-1', data: { link_type: 'dependency_for' } },
  { id: 'blank', source: 'blank', target: 'img-1' },
];
const fixtures: Fixture[] = [
  fixture('default fresh node'),
  fixture('unknown model', { model: 'removed/model' }, {}, { model: 'test-image-api', model_id: 'openai/test-image' }),
  fixture('missing model', { model: undefined }, {}, { model_id: 'openai/test-image' }),
  fixture('selected second catalog model', { model: 'openai/second' }, {
    imageModels: [...catalog, { ...catalog[0], id: 'openai/second', apiModel: 'second-api' }],
  }, { model: 'second-api', model_id: 'openai/second' }),
  fixture('catalog snapping', { aspectRatio: '43:24', size: '2K', quality: 'hIGH' }, {
    imageModels: constrainedCatalog,
  }, { aspect_ratio: '16:9', image_size: '4K', quality: 'High', model_id: 'catalog-image-7' }),
  fixture('catalog auto ratio', { aspectRatio: 'auto' }, { imageModels: constrainedCatalog }, { aspect_ratio: '1:1' }),
  fixture('fallback auto ratio', { aspectRatio: 'auto' }, {}, { aspect_ratio: 'auto' }),
  fixture('quality medium fallback', { quality: 'unknown' }, { imageModels: constrainedCatalog }, { quality: 'Medium' }),
  fixture('quality first fallback', { quality: 'unknown' }, {
    imageModels: [{ ...catalog[0], qualityOptions: [' ultra '] }],
  }, { quality: 'ultra' }),
  fixture('no quality options', { quality: 'high' }, {
    imageModels: [{ ...catalog[0], qualityOptions: undefined }],
  }, { quality: null }),
  fixture('blank catalog options', {}, {
    imageModels: [{ ...catalog[0], qualityOptions: [' '], resolutionOptions: [' '], ratioOptions: [' '] }],
  }, { aspect_ratio: '16:9', image_size: '2K', quality: null }),
  fixture('partial camera', { cameraSelection: { lensId: 'lens-50' } }, {}, {
    camera: { camera_body: '', lens: 'lens-50', focal_length_mm: 0, aperture: '' },
  }),
  fixture('full camera', { cameraSelection: {
    cameraBodyId: 'body-1', lensId: 'lens-2', focalLengthMm: 35, aperture: 'f/2.8',
  } }, {}, { camera: { camera_body: 'body-1', lens: 'lens-2', focal_length_mm: 35, aperture: 'f/2.8' } }),
  fixture('empty camera', { cameraSelection: { focalLengthMm: 0 } }, {}, { camera: null }),
  fixture('style template', { styleTemplateId: 'style-1' }, {}, { style: { template_id: 'style-1' } }),
  fixture('model params', { modelParams: { seed: 42, transparent: true, extra: { steps: 8 } } }, {}, {
    model_params: { seed: 42, transparent: true, extra: { steps: 8 } },
  }),
  fixture('workflow count three', { count: 3 }, {}, { variant_count: 3 }),
  fixture('manual count three', { count: 3 }, { executionSource: 'manual' }, {}, 3),
  fixture('manual attempt count three', { count: 3 }, {
    executionSource: 'manual', productOperation: {
      projectId: 'parity-project', operationId: 'operation-1', generationAttemptId: 'attempt-1',
    },
  }, { variant_count: 3, product_operation_id: 'operation-1', generation_attempt_id: 'attempt-1' }),
  fixture('manual operation without attempt', { count: 3 }, {
    executionSource: 'manual', productOperation: { projectId: 'parity-project', operationId: 'operation-1' },
  }, {}, 3),
  fixture('system auto commit', { count: 3, autoCommitOnGenerate: true, preset_managed: true }),
  fixture('user spawned auto commit', { count: 3, autoCommitOnGenerate: true, preset_managed: true, user_spawned: true }, {}, { variant_count: 3 }),
  fixture('count upper clamp', { count: 8 }, {}, { variant_count: 4 }),
  fixture('count lower clamp', { count: 0 }),
  fixture('upstream text edge order', {}, { nodes: upstreamNodes, edges: upstreamEdges }, {
    prompt: 'Warm colors\n\nMorning light\n\nA cat on a windowsill',
  }, 1, 'Warm colors\n\nMorning light\n\nA cat on a windowsill'),
  fixture('empty own prompt with upstream', {}, {
    nodes: upstreamNodes.map((node) => node.id === 'img-1' ? imageNode({ prompt: '  ' }) : node),
    edges: upstreamEdges,
  }, { prompt: 'Warm colors\n\nMorning light' }, 1, 'Warm colors\n\nMorning light'),
  fixture('scene master own prompt', { __freezone_source: { role: 'scene_master' } }, {
    nodes: [textNode('text-1', 'Morning light'), imageNode({ __freezone_source: { role: 'scene_master' } })],
    edges: [{ id: 'e1', source: 'text-1', target: 'img-1' }],
  }),
  fixture('scene reverse master upstream prompt', {}, {
    nodes: [textNode('text-1', 'Morning light'), imageNode({ prompt: '', __freezone_source: { role: 'scene_reverse_master' } })],
    edges: [{ id: 'e1', source: 'text-1', target: 'img-1' }],
  }, { prompt: 'Morning light' }, 1, 'Morning light'),
];

function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
function recordedRequests() {
  return vi.mocked(apiCall).mock.calls.map(([path, options]) => ({
    method: options?.method, path, body: wire(options?.json),
  }));
}

beforeEach(() => {
  clearWorkflowProductOperation('img-1');
  mocks.taskSequence = 0;
  vi.mocked(apiCall).mockClear();
  vi.mocked(fetchFreezoneImageModels).mockClear();
  vi.mocked(compileWorkflowNodePrompt).mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in request parity tests'); }));
});
afterEach(() => {
  cleanup();
  clearWorkflowProductOperation('img-1');
  vi.unstubAllGlobals();
});

describe('image generation request parity', () => {
  it.each(fixtures)('$name', async (input) => {
    mocks.projectId = input.projectId;
    mocks.catalog = input.imageModels;
    mocks.canvasId = input.canvasId;
    useCanvasStore.getState().setCanvasData(structuredClone(input.nodes), structuredClone(input.edges));
    if (input.productOperation) bindWorkflowProductOperation(input.nodeId, input.productOperation);
    const { result } = renderHook(() => useImageGenerationForm('img-1'));
    await waitFor(() => {
      expect(fetchFreezoneImageModels).toHaveBeenCalledWith(input.projectId);
      const snapshot = getFreezoneImageModelsSnapshot(input.projectId);
      expect(snapshot.isLoading).toBe(false);
      expect(snapshot.isFallback).toBe(false);
      expect(snapshot.models).toStrictEqual(input.imageModels);
      expect(result.current.formProps.modelId).toBe(
        input.imageModels.find((model) => model.id === input.nodes.find((node) => node.id === 'img-1')?.data.model)?.id
        ?? input.imageModels[0].id,
      );
      expect(result.current.submitDisabled).toBe(false);
    });
    await act(async () => {
      await result.current.submit({
        completionMode: 'completed', executionSource: input.executionSource, attachStoryFrame: false,
      });
    });
    expect(result.current.isGenerating).toBe(false);
    expect(compileWorkflowNodePrompt).toHaveBeenCalledTimes(1);
    const [compileInput] = vi.mocked(compileWorkflowNodePrompt).mock.calls[0];
    const { nodeId, nodeData, executionSource, onCompileMetadata, ...promptInput } = compileInput;
    expect(nodeId).toBe(input.nodeId);
    expect(nodeData).toStrictEqual(input.nodes.find((node) => node.id === input.nodeId)?.data);
    expect(executionSource).toBe(input.executionSource);
    expect(onCompileMetadata).toBeTypeOf('function');
    expect(promptInput).toStrictEqual(imagePromptCompileInput(input));
    const prompt = await vi.mocked(compileWorkflowNodePrompt).mock.results[0].value;
    expect(prompt).toBe(input.expectedPrompt);
    const built = buildImageGenerationRequest({ ...input, prompt });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const actual = recordedRequests();
    expect(actual).toStrictEqual(wire(built.requests));
    expect(actual).toHaveLength(input.expectedRequestCount);
    for (const request of actual) {
      expect(request.body).toMatchObject({ ...input.expectedBody, prompt: input.expectedPrompt });
    }
    if (input.name === 'default fresh node') {
      expect(promptInput).toStrictEqual({
        nodeKind: 'image', nodePrompt: 'A cat on a windowsill', upstreamText: '',
        upstreamContents: [], fallbackPrompt: 'A cat on a windowsill', referenceMedia: [],
      });
      expect(actual).toStrictEqual([{
        method: 'POST', path: 'projects/parity%2Fdefault%20fresh%20node/freezone/gen',
        body: {
          prompt: 'A cat on a windowsill', aspect_ratio: '16:9', image_size: '2K',
          reference_urls: [], camera: null, style: null, provider: 'openai', model: 'test-image-api',
          model_id: 'openai/test-image', gen_mode: 'text_to_image', quality: 'medium',
          canvas_id: 'canvas-7', node_id: 'img-1',
        },
      }]);
    }
    if (!('variant_count' in input.expectedBody)) {
      for (const request of actual) expect(request.body).not.toHaveProperty('variant_count');
    }
    if (!input.productOperation?.generationAttemptId) {
      for (const request of actual) {
        expect(request.body).not.toHaveProperty('product_operation_id');
        expect(request.body).not.toHaveProperty('generation_attempt_id');
      }
    }
  });
});

describe('pure request validation', () => {
  it.each([
    { name: 'no model', input: fixture('no model', {}, { imageModels: [] }), prompt: 'Cat',
      expected: { ok: false, code: 'no_model', message: 'No image model is available.' } },
    { name: 'no effective prompt', input: fixture('no prompt', { prompt: '  ' }), prompt: 'Cat',
      expected: { ok: false, code: 'no_effective_prompt', message: 'An image prompt or upstream text is required.' } },
    { name: 'reference limit', input: fixture('limit', { referenceImageUrl: '/static/ref.png' }, {
      imageModels: [{ ...catalog[0], referenceImageMax: 0 }],
    }), prompt: 'Cat', expected: { ok: false, code: 'reference_limit_exceeded', message: 'The selected model supports at most 0 reference images.' } },
    { name: 'inline reference', input: fixture('inline', { referenceImageUrl: 'data:image/png;base64,AA==' }), prompt: 'Cat',
      expected: { ok: false, code: 'inline_media_reference', message: 'Upload inline media before building an image request.' } },
  ])('$name', ({ input, prompt, expected }) => {
    expect(buildImageGenerationRequest({ ...input, prompt })).toStrictEqual(expected);
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('uses the compiled prompt verbatim and leaves its inputs unchanged', () => {
    const input = fixture('compiled');
    const before = structuredClone(input);
    const built = buildImageGenerationRequest({ ...input, prompt: 'Compiled recipe\n' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.requests[0].body).toHaveProperty('prompt', 'Compiled recipe\n');
    expect(input).toStrictEqual(before);
  });

  it('drops blank references and strips queries after ordering and deduplication', () => {
    const input = fixture('reference cleanup', { referenceImageUrl: '/static/a.png?own=1' }, {
      nodes: [imageNode({ referenceImageUrl: '/static/a.png?own=1' }), ...[
        ['ref-1', '/static/b.png?cache=1'], ['ref-2', '/static/a.png?own=1'],
        ['ref-3', '/static/a.png?cache=2'],
      ].map(([id, imageUrl]): CanvasNode => ({
        id, type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl },
      }))],
      edges: ['ref-1', 'ref-2', 'ref-3'].map((source) => ({ id: source, source, target: 'img-1' })),
    });
    const built = buildImageGenerationRequest({ ...input, prompt: 'Cat' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.requests[0].body).toMatchObject({
      gen_mode: 'image_to_image', reference_urls: ['/static/a.png', '/static/b.png', '/static/a.png'],
    });
    const blank = buildImageGenerationRequest({
      ...fixture('blank reference', { referenceImageUrl: '  ' }), prompt: 'Cat',
    });
    expect(blank.ok).toBe(true);
    if (!blank.ok) throw new Error(blank.message);
    expect(blank.requests[0].body).toMatchObject({ gen_mode: 'image_to_image', reference_urls: [] });
  });

  it('preserves the truly fresh empty prompt as a blocked request', () => {
    expect(buildImageGenerationRequest({ ...fixture('fresh empty', { prompt: '' }), prompt: '' }))
      .toStrictEqual({ ok: false, code: 'no_effective_prompt', message: 'An image prompt or upstream text is required.' });
  });
});
