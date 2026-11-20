// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import * as pure from '@/features/canvas/application/generationRequests';
import { serveImageGenerationRequest, serveImageGenerationPatch } from '@/features/canvas/server/imageGeneration';
import { compileMetadata, outcomeInput, outcomePayload, outcomes, rawCatalog, requestContext, requestPayload, task } from './imageGenerationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('server image generation requests', () => {
  it.each([false, true])('matches pure requests with upstream image = %s', async (withReference) => {
    const input = requestPayload(withReference);
    const before = structuredClone(input);
    const context = requestContext(input);
    const compile_input = pure.imagePromptCompileInput(context);
    const request = pure.buildImageGenerationRequest({ ...context, prompt: compile_input.fallbackPrompt });
    const actual = await serveImageGenerationRequest(input);
    expect(actual).toStrictEqual({ compile_input, request });
    expect(actual.request).toStrictEqual({ ok: true, requests: [{
      method: 'POST', path: 'projects/test%2Fproject/freezone/gen', body: {
        prompt: 'A cat', aspect_ratio: '16:9', image_size: '2K',
        reference_urls: withReference ? ['/static/reference.png'] : [], camera: null, style: null,
        provider: 'openai', model: 'test-image', model_id: 'image-catalog',
        gen_mode: withReference ? 'image_to_image' : 'text_to_image', quality: 'medium',
        canvas_id: 'canvas-1', node_id: 'image',
      },
    }] });
    expect(input).toStrictEqual(before);
  });

  it.each(['Compiled recipe\n', ''])('uses the supplied prompt verbatim (%j)', async (prompt) => {
    const input = requestPayload();
    const payload = { ...input, env: { ...input.env, prompt } };
    const context = requestContext(payload);
    expect(await serveImageGenerationRequest(payload)).toStrictEqual({
      compile_input: pure.imagePromptCompileInput(context),
      request: pure.buildImageGenerationRequest({ ...context, prompt }),
    });
  });

  it.each(['missing', 'source'])('serializes the pure refusal for %s', async (node_id) => {
    const input = { ...requestPayload(true), node_id };
    const context = requestContext(input);
    expect(() => pure.imagePromptCompileInput(context)).toThrow('The target node must be an image generation node.');
    const refusal = pure.buildImageGenerationRequest({ ...context, prompt: '' });
    expect(await serveImageGenerationRequest(input)).toStrictEqual({ compile_input: refusal, request: refusal });
  });

  it.each([undefined, {}, { image: undefined }, { image: [] }, { image: { data: rawCatalog.models } }, { image: { openai: rawCatalog.models } }])('normalizes catalog %j or uses shared defaults', async (catalogs) => {
    const input = requestPayload();
    const payload = { ...input, env: { ...input.env, catalogs } };
    const context = requestContext(payload);
    expect(await serveImageGenerationRequest(payload)).toStrictEqual({
      compile_input: pure.imagePromptCompileInput(context),
      request: pure.buildImageGenerationRequest({ ...context, prompt: 'A cat' }),
    });
  });

  it('passes manual execution and product operation context to the pure builder', async () => {
    const input = requestPayload();
    input.canvas.nodes[0].data.count = 3;
    const payload = { ...input, env: { ...input.env, executionSource: 'manual', productOperation: {
      projectId: 'test/project', operationId: 'operation-1', generationAttemptId: 'attempt-1',
    } } };
    const context = requestContext({ ...payload, env: { ...payload.env, executionSource: 'manual' } });
    expect(await serveImageGenerationRequest(payload)).toStrictEqual({
      compile_input: pure.imagePromptCompileInput(context),
      request: pure.buildImageGenerationRequest({ ...context, prompt: 'A cat' }),
    });
  });
});

describe('server image generation patches', () => {
  it.each([0, 123.5])('uses caller timestamps (%s) for loading patches', async (started_at_ms) => {
    expect(await serveImageGenerationPatch({ phase: 'start', started_at_ms })).toStrictEqual(pure.imageGenerationStartPatch(started_at_ms));
    expect(await serveImageGenerationPatch({ phase: 'submit', started_at_ms })).toStrictEqual(pure.imageGenerationSubmitPatch(started_at_ms));
  });
  it('returns task and compilation patches', async () => {
    expect(await serveImageGenerationPatch({ phase: 'accepted', task })).toStrictEqual(pure.imageGenerationAcceptedPatch(task));
    expect(await serveImageGenerationPatch({ phase: 'compile_metadata', metadata: compileMetadata, compiled_at: 'caller-time' }))
      .toStrictEqual(pure.imagePromptCompileMetadataPatch(compileMetadata, 'caller-time'));
  });
  it.each(outcomes.flatMap(outcome => ['en', 'zh'].map(locale => ({ outcome, locale }))))('matches $outcome.kind in $locale', async ({ outcome, locale }) => {
    const input = outcomePayload(outcome, locale);
    const before = structuredClone(input);
    expect(await serveImageGenerationPatch(input)).toStrictEqual(pure.imageGenerationOutcomePatch(await outcomeInput(input)));
    expect(input).toStrictEqual(before);
  });
  it('returns literal success fields and attachment effects', async () => {
    expect(await serveImageGenerationPatch(outcomePayload(outcomes[0]))).toStrictEqual({
      action: 'write', patch: {
        imageUrl: '/static/cat.png', previewImageUrl: '/static/cat.png', isGenerating: false,
        generationStartedAt: null, generationTaskKey: null, generationTaskType: null,
        generationTaskJobId: null, generationError: null, generationErrorDetails: null, generationErrorRequestId: null,
      }, completedUrls: ['/static/cat.png'], effects: [
        { kind: 'attach_story_frame', nodeId: 'image' }, { kind: 'attach_story_asset', nodeId: 'image' },
      ], output: { ...task, imageUrl: '/static/cat.png', imageUrls: ['/static/cat.png'] },
    });
  });
  it.each([
    ['en', 'Reference media does not meet model requirements'], ['zh', '参考素材不符合模型要求'],
  ])('translates reference errors in %s', async (locale, message) => {
    const result = await serveImageGenerationPatch(outcomePayload({ kind: 'reference_invalid', message: 'Bad ref' }, locale));
    expect(result).toMatchObject({ action: 'write', patch: { generationError: message } });
  });
  it('preserves null task references and ignores duplicate results', async () => {
    const input = outcomePayload(outcomes[0]);
    expect(await serveImageGenerationPatch({ ...input, task_key: null, first_accepted_task: null, completed_urls: ['/static/cat.png'] }))
      .toStrictEqual({ action: 'ignore' });
  });
});

describe('image generation payload validation', () => {
  const invalidRequestFields = [
    { node_id: 1 }, { canvas: {} }, { canvas: { nodes: [{}], edges: [] } },
    { canvas: { nodes: [], edges: [{}] } }, { env: null },
  ];
  it.each(invalidRequestFields)('rejects request fields %j', async (fields) => {
    await expect(serveImageGenerationRequest({ ...requestPayload(), ...fields })).rejects.toBeInstanceOf(InvalidRequest);
  });
  it.each([
    { locale: 1 }, { project: null }, { canvasId: 2 }, { executionSource: 'other' },
    { catalogs: [] }, { prompt: null }, { productOperation: {} },
    { productOperation: { projectId: 'p', operationId: 1 } },
    { productOperation: { projectId: 'p', operationId: 'o', generationAttemptId: null } },
  ])('rejects environment fields %j', async (fields) => {
    const input = requestPayload();
    await expect(serveImageGenerationRequest({ ...input, env: { ...input.env, ...fields } })).rejects.toBeInstanceOf(InvalidRequest);
  });
  it.each([
    {}, { phase: 'other' }, { phase: 'start', started_at_ms: '123' }, { phase: 'submit', started_at_ms: null },
    { phase: 'start', started_at_ms: Infinity }, { phase: 'accepted', task: { ...task, task_type: 1 } },
    { phase: 'accepted', task: { ...task, task_key: null } }, { phase: 'accepted', task: { ...task, job_id: [] } },
    { phase: 'compile_metadata', metadata: { ...compileMetadata, mode: 'other' }, compiled_at: 'time' },
    { phase: 'compile_metadata', metadata: { ...compileMetadata, prompt: null }, compiled_at: 'time' },
    { phase: 'compile_metadata', metadata: { ...compileMetadata, recipeIds: [1] }, compiled_at: 'time' },
    { phase: 'compile_metadata', metadata: compileMetadata, compiled_at: 1 },
  ])('rejects patch %j', async (input) => {
    await expect(serveImageGenerationPatch(input)).rejects.toBeInstanceOf(InvalidRequest);
  });
  it.each([
    { locale: 1 }, { node_id: null }, { node_data: [] }, { task_key: 1 },
    { first_accepted_task: { ...task, job_id: 1 } }, { run_index: '0' }, { total: null },
    { completed_urls: [1] }, { attach_story_frame: 'true' },
    { outcome: { kind: 'other', message: '' } }, { outcome: { kind: 'completed', result: [] } },
    { outcome: { kind: 'completed' } }, { outcome: { kind: 'completed', result: null, fallbackUrl: 1 } },
    ...['failed', 'cancelled', 'reference_invalid', 'compile_failed'].map(kind => ({ outcome: { kind, message: 1 } })),
  ])('rejects outcome fields %j', async (fields) => {
    await expect(serveImageGenerationPatch({ ...outcomePayload(outcomes[0]), ...fields })).rejects.toBeInstanceOf(InvalidRequest);
  });
});
